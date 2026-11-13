import { NextResponse } from "next/server";

import { runDepartedAccessSweep } from "@/lib/auth/departed-access-sweep";
import { answerNowThenFinish } from "@/lib/http/answer-now";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { runMailboxOffboardingSweep } from "@/lib/mailbox-offboarding/sweep";
import { runRobotSweepPass } from "@/lib/mailbox-offboarding/robot/sweep-hook";
import { runJoinerSweepPass } from "@/lib/new-hire-mailbox/robot/sweep-hook";
import { defaultJoinerSweepDeps } from "@/lib/new-hire-mailbox/robot/sweep-deps";
import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { pingDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { purgeDepartedPersonalMailboxes } from "@/lib/personal-mailbox/service";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The daily mailbox-offboarding sweep.
 *
 * Opens a revocation task for any leaver holding a mailbox that the exit workflow missed — that
 * call is deliberately best-effort and swallowed, so this is what notices — and then alerts on the
 * three states that mean a leaver can still read company mail: overdue, forwarding lapsed, and the
 * one that matters most, a mailbox whose password was reset while its app passwords were left
 * alive. Nothing but this sweep will ever surface that third case: it looks finished in the
 * Turbify control panel and there is no API to ask.
 *
 * Watched by the dead-man's switch as `phoenix-mailbox-offboarding-sweep`, wired 2026-08-29 once
 * the job actually had a schedule (cron-job.org `8350624`, daily 08:15 Cairo). The switch is the
 * only thing that can report this sweep STOPPING: a cron that dies, or starts 401ing after a
 * CRON_SECRET rotation, goes quiet rather than red — and quiet here is indistinguishable from
 * "no leavers left to chase", which is the reassuring reading. Its schedule, timezone and channels
 * come from the table in docs/observability.md via scripts/healthchecks-sync.mjs; the defaults a
 * check auto-provisions with are 1-day/1-hour and ZERO channels, which notifies nobody.
 *
 * The ping is sent directly rather than through withDeadMansSwitch, for the reason that helper's
 * own docstring gives: this sweep never throws on a partial failure, so throw/no-throw does not
 * mean what the switch would read into it. See the call site.
 *
 * Deliberately runs on GET. A POST to any /api/** path returns 403 even when the route exists, so
 * a POST-only cron endpoint is indistinguishable from a missing one when it is probed.
 *
 * IT ALSO RUNS THE DEPARTED-ACCESS SWEEP, because this is the daily leaver job and that sweep wants
 * exactly this cadence. Hanging it here rather than giving it its own schedule is deliberate: a new
 * job means a new cron-job.org registration, and that REST API allows 100 requests a DAY with no
 * Retry-After. Its result is reported separately in the response and it drives NO alarm of its own
 * — see runDepartedAccessSweep for why a lagging flag is not an open door, and why its failure must
 * not turn the mailbox switch red, which answers a different question.
 *
 * AND IT FORGETS LEAVERS' "MY EMAIL" CONNECTIONS, right after the departed-access sweep has turned
 * their logins off: a sealed app password must not outlive its owner's access to Phoenix. Same
 * reasoning as above — best-effort, never throws, reported in the response, drives no alarm.
 *
 * AND, LAST, IT RUNS THE TURBIFY REVOCATION ROBOT over the tasks it just alerted on. This is where
 * the register stops being a to-do list a human works and starts closing itself. The robot is OFF
 * by default (`PHOENIX_TURBIFY_ROBOT_ENABLED`), reports its plan without touching a mailbox until a
 * live run is asked for explicitly (`PHOENIX_TURBIFY_ROBOT_DRY_RUN=false`), and refuses to act at
 * all until its console driver is calibrated. See sweep-hook.ts for the three locks. Best-effort,
 * never throws, reported in the response under `robot`, and — like its neighbours — it drives no
 * alarm of its own: a robot that could not sign in must not turn the mailbox switch red.
 *
 * IT ANSWERS 202 AT ONCE AND FINISHES AFTER THE RESPONSE (13 Nov 2026): the scheduler hangs up at 30
 * seconds and this pass was cut at 30,172 ms, so it recorded a failure for a sweep that had finished.
 * `?wait=1` waits for the report as before. The verdict is the switch's ping, never this route's
 * status. See answer-now.ts.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/mailbox-offboarding-sweep");
  if (denied) return denied;
  return answerNowThenFinish(request, "phoenix-mailbox-offboarding-sweep", () => runSweep());
}

async function runSweep(): Promise<Response> {
  try {
    // First, because it is the cheap one and it never throws — a leaver whose last working day has
    // arrived should not keep a live login for the length of the mailbox sweep.
    const access = await runDepartedAccessSweep();
    const personalMailboxes = await purgeDepartedPersonalMailboxes();
    const result = await runMailboxOffboardingSweep();
    // Last, and only after the register is up to date: run the robot over what the sweep found. It
    // never throws (sweep-hook.ts) and its outcome does not feed the switch below — a robot that
    // could not sign in is a different question from "is a leaver holding a live mailbox?".
    const robot = await runRobotSweepPass();
    // The joiner robot rides the same pass, for the same reason the revocation robot does: a new
    // schedule means a new cron-job.org registration against an API that allows 100 requests a day.
    // It is OFF by default and dry-run by default once enabled, never throws, and like its neighbour
    // it does not feed the switch below — provisioning a new hire is a different question from "is a
    // leaver holding a live mailbox?".
    const joiner = await runJoinerSweepPass(defaultJoinerSweepDeps());
    // Keyed on the error COUNT, not on whether this threw. The sweep catches its own failures and
    // carries on (sweep.ts) — including the worst case, where it could not read the register at all
    // and returns errors: 1. A switch driven by throw/no-throw would call that run green, and green
    // here reads as "no leaver is holding a live mailbox", which is precisely the false comfort the
    // whole register exists to remove.
    await pingDeadMansSwitch(
      "phoenix-mailbox-offboarding-sweep",
      result.errors > 0 ? "fail" : "success",
      result.errors > 0 ? `${result.errors} error(s) during the sweep` : undefined,
    );
    return NextResponse.json({ success: true, ...result, departedAccess: access, joiner, personalMailboxes, robot });
  } catch (error) {
    await pingDeadMansSwitch(
      "phoenix-mailbox-offboarding-sweep",
      "fail",
      describeThrown(error),
    );
    logError("Mailbox offboarding sweep failed", {
      labels: { event: "cron_failed", job: "mailbox-offboarding-sweep" },
      error,
    });
    const message = clientSafeErrorMessage(error, "Mailbox offboarding sweep failed.");
    return NextResponse.json({ error: "mailbox_offboarding_sweep_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
