import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { runMailboxOffboardingSweep } from "@/lib/mailbox-offboarding/sweep";
import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { pingDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
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
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/mailbox-offboarding-sweep");
  if (denied) return denied;
  try {
    const result = await runMailboxOffboardingSweep();
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
    return NextResponse.json({ success: true, ...result });
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
