import { NextResponse } from "next/server";

import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { pingDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError, logInfo, logWarning } from "@/lib/observability/log";
import {
  assessUnsettledBrickMoveNet,
  notifyBrickMoveNetUnsettled,
  type BrickMoveNetAlertResult,
} from "@/lib/sales/master-data/brick-move-net-alert";
import { settleBrickMoveNet, type BrickMoveNetSettleResult } from "@/lib/sales/master-data/brick-move-net-settle";
import {
  assessStuckBrickMoveFiles,
  notifyBrickMoveFilesStuck,
  readPendingBrickMoveFiles,
  type BrickMoveStuckAlertResult,
} from "@/lib/sales/master-data/brick-move-stuck-alert";
import { countBrickMoveFilesPending, refreshMovedBrickFiles } from "@/lib/sales/master-data/brick-moves";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Healthchecks slug, `phoenix-<route>` like every other watched cron route. */
const JOB_SLUG = "phoenix-brick-move-drain";

/**
 * How long one fire keeps rebuilding. Four minutes against a twenty-minute cadence, so two fires
 * can never overlap even at the budget's limit — and the five-minute file claim covers the case
 * anyway. See the 30-second note below on why this is allowed to exceed the scheduler's cut.
 */
const DRAIN_BUDGET_MS = 240_000;

/**
 * Finish what a brick move started, without a human holding a tab open.
 *
 * WHY THIS EXISTS — the fault it ends, measured on production 2026-10-13.
 * `sos_relocate_brick` moves a brick's sales inside the database and queues every sales file it
 * re-stamped in `source_of_sales_brick_move_files`. It does NOT rebuild the totals those files
 * feed: rebuilding them all is far too slow for the request that made the move, so the move
 * returns `pendingFiles` and something else is expected to drain the queue. Until now that
 * something was one poller on one screen — `src/components/sales/brick-move-refresh.tsx`, the only
 * caller of `POST /api/sales/brick-moves/refresh`. Close the Database Mapping tab and the rebuild
 * simply stops, with the move already applied to the brick master, the customer map and the import
 * rows.
 *
 * So the queue had no drain at all when nobody was watching, and nothing anywhere said so. The
 * قوص and أبنود moves of 2026-10-12 left 71 files with `refreshed_at is null` from 13:27 Cairo;
 * for a full day every Qena figure on every screen was still pre-move while the mapping underneath
 * it had changed. No error, no badge, no log line, no alert — the move reported success, because it
 * had succeeded. This clock is the drain the queue never had.
 *
 * NOTIFIES NOBODY, BY DESIGN, like the nightly territory re-stamp it sits beside. It does work; it
 * sends no mail, in-app, Telegram or push. Its trace is this route's log line on any fire that
 * actually rebuilt something, plus the heartbeat below.
 *
 * WHY THE PING IS EXPLICIT, AND WHY IT FIRES AT THE FIRST REBUILT FILE.
 * The same lesson as `/api/cron/territory-restamp`, for the same reason: `withDeadMansSwitch`
 * reports at the very END of the run, and production deploys on every merge, so a four-minute drain
 * has a four-minute window in which a routine deploy replaces the container and nothing reports a
 * run that was doing its job. The register would then alert "stranded" every fifteen minutes about
 * a healthy clock, which is the most expensive kind of monitoring bug — it teaches the owner to
 * ignore the one alert that says a job has stopped. So success is reported the moment the FIRST
 * file's totals commit, and immediately on the empty-queue path, which commits nothing and is the
 * healthy steady state.
 *
 * THE 30-SECOND CUT, and why a red execution here is not a failure. cron-job.org kills every
 * request at 30s — a platform cap `requestTimeout` cannot raise — and the server finishes the work
 * regardless. At rest this route is one indexed count and answers in milliseconds, so an ordinary
 * fire is green. A fire that finds a real backlog will run past 30s and cron-job.org will log
 * `Failed (timeout)` while the drain carries on and the heartbeat reads success. That is the
 * expected shape while a move drains, and it is why liveness is read from the heartbeat, never
 * from the scheduler's execution list.
 *
 * THE HALF A HEARTBEAT CANNOT SEE, and why this route carries an alert of its own. The register
 * answers one question — is this clock still firing? — so the failure it cannot describe is the one
 * where every fire succeeds and the queue still never empties. `notifyBrickMoveFilesStuck` is that
 * second watch: any queued file still waiting an hour after its move pages a human in-app, Telegram
 * and push, once a Cairo day per set of stuck bricks. It never throws and never fails this run —
 * reading the queue to complain about it must not become the complaint.
 *
 * THE FILES ARE NOT THE NUMBERS, which is the third thing this route does. Rebuilding a file
 * rebuilds its rollups; the store-split net that Sales vs Target divides by is computed per PERIOD
 * from the closing's own detail rows, and a file completed any way OTHER than through this app — a
 * timed-out file finished over a direct SQL connection, as happened on 2026-10-13 — skips that step
 * entirely. The queue then reads zero with the stored net still pre-move: 74,741.23 EGP on the wrong
 * area in September, every screen reading it. `settleBrickMoveNet` closes that, only for periods
 * whose net actually predates the move, never for a published month, and only on a fire that
 * rebuilt something. What it deliberately refuses to write — a published month, or a period whose
 * settle failed — is residue nothing will ever retry, so `notifyBrickMoveNetUnsettled` pages a human
 * for it on the same channels as the stuck-queue alert. A period the per-fire cap merely deferred is
 * NOT residue and stays silent: the next fire takes it.
 *
 * A FILE THIS CANNOT FINISH. `refreshMovedBrickFiles` keeps the claim on a file that failed and
 * tries it again once the claim lapses, so one unfinishable file never blocks the files behind it
 * — but it is retried for ever and the queue never reaches zero. That was a live hole until
 * `20261013130000_sos_fact_rollup_statement_timeout.sql`: `phx_refresh_sos_fact_rollup` was the one
 * rollup refresh with no `statement_timeout` of its own and so ran under the PostgREST role's 8
 * seconds, which the largest files exceed. A fire that still ends with files pending and a failure
 * to report says so in the log, under `brick_move_drain_incomplete`.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/brick-move-drain");
  if (denied) return denied;

  let reportedSuccess = false;
  const reportSuccessOnce = async () => {
    if (reportedSuccess) return;
    reportedSuccess = true;
    // A broken reporter must never turn a committed rebuild into a failed run.
    try {
      await pingDeadMansSwitch(JOB_SLUG, "success");
    } catch (error) {
      logWarning("The brick-move drain rebuilt a file but could not report that it ran.", { error });
    }
  };

  try {
    const pendingAtStart = await countBrickMoveFilesPending();

    // The steady state: no move is waiting. One indexed count, nothing to commit, and still a
    // healthy run that must report — otherwise a quiet week reads exactly like a stopped clock.
    if (pendingAtStart === 0) {
      await reportSuccessOnce();
      return NextResponse.json({ failure: null, pendingAtStart: 0, refreshed: 0, remaining: 0, success: true });
    }

    const result = await refreshMovedBrickFiles({ budgetMs: DRAIN_BUDGET_MS, onFileRebuilt: reportSuccessOnce });
    await reportSuccessOnce();

    if (result.refreshed > 0) {
      logInfo("The brick-move drain rebuilt a moved brick's sales files.", {
        context: { pendingAtStart, refreshed: result.refreshed, remaining: result.remaining },
        labels: { event: "brick_move_drain_applied", job: "brick-move-drain" },
      });
    }

    // Still pending AND something failed: the files behind it still got their turn, but this one
    // will come back every fire until a human looks. Said once per fire, in the log the owner reads.
    if (result.remaining > 0 && result.failure) {
      logWarning("The brick-move drain could not finish every waiting file.", {
        context: { failure: result.failure, pendingAtStart, refreshed: result.refreshed, remaining: result.remaining },
        labels: { event: "brick_move_drain_incomplete", job: "brick-move-drain" },
      });
    }

    // The second watch. Only read the queue when something is actually left, and never let that
    // read — or the alert it feeds — fail a drain that has already done its work.
    let alert: BrickMoveStuckAlertResult | null = null;
    let stuckFiles = 0;
    if (result.remaining > 0) {
      try {
        const verdict = assessStuckBrickMoveFiles({ now: new Date(), rows: await readPendingBrickMoveFiles() });
        stuckFiles = verdict.stuck.length;
        if (!verdict.healthy) alert = await notifyBrickMoveFilesStuck(verdict);
      } catch (error) {
        logWarning("The brick-move drain could not check whether its queue is stuck.", { error });
      }
    }

    // The numbers, after the files. Only when something was actually rebuilt — a standing sweep
    // would recompute a published month, or a legitimately empty net, on every fire for ever.
    let settle: BrickMoveNetSettleResult | null = null;
    let netAlert: BrickMoveNetAlertResult | null = null;
    if (result.refreshed > 0) {
      try {
        settle = await settleBrickMoveNet({ batchIds: result.rebuiltBatchIds });
        if (settle.settled.length > 0) {
          logInfo("The brick-move drain settled a period's split net.", {
            context: { settled: settle.settled, touched: settle.touched },
            labels: { event: "brick_move_net_settled", job: "brick-move-drain" },
          });
        }
        // Residue that nothing will retry leaves a real figure wrong on a real screen, so it is
        // logged AND paged. A period the per-fire cap merely deferred is neither — the next fire
        // takes it. `assessUnsettledBrickMoveNet` is what draws that line.
        const residue = assessUnsettledBrickMoveNet(settle);
        if (!residue.healthy) {
          logWarning("A brick move's split net could not be settled for every period it touched.", {
            context: {
              deferred: settle.deferred,
              failure: settle.failure,
              owedPeriods: residue.owedPeriods,
              skippedPublished: settle.skippedPublished,
            },
            labels: { event: "brick_move_net_unsettled", job: "brick-move-drain" },
          });
          netAlert = await notifyBrickMoveNetUnsettled(residue);
        }
      } catch (error) {
        logWarning("The brick-move drain could not assess whether its periods need settling.", { error });
      }
    }

    return NextResponse.json({ ...result, alert, netAlert, pendingAtStart, settle, stuckFiles, success: true });
  } catch (error) {
    logError("The brick-move drain failed", {
      error,
      labels: { event: "cron_failed", job: "brick-move-drain" },
    });
    await pingDeadMansSwitch(JOB_SLUG, "fail", describeThrown(error));
    const message = clientSafeErrorMessage(error, "The brick-move drain failed.");
    return NextResponse.json({ error: "brick_move_drain_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
