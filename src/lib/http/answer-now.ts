import { after, NextResponse } from "next/server";

import { logError, logInfo } from "@/lib/observability/log";

/**
 * A scheduled route that runs longer than its scheduler waits answers 202 AT ONCE and finishes the
 * run after the response has gone.
 *
 * WHY (integration audit, 13 Nov 2026, finding ISS-002). cron-job.org hangs up after 30 seconds and
 * that cap cannot be raised. Read on production that day: the daily notification run was cut at
 * 30,141 ms, the reconciliation check at 30,155 ms and the mailbox sweep at 30,172 ms, and the weekly
 * Private Calendar notice finished at 28,987 ms. The work itself was never lost, because the
 * long-lived server finishes a request whose caller has gone, and each job's heartbeat still arrived.
 * But the scheduler recorded a failure every single day for work that had succeeded, which hides a
 * real failure among the false ones, and its terms switch a job off after more than 25 failures in a
 * row. That would stop the daily notification run with nothing red anywhere.
 *
 * WHERE THE VERDICT LIVES. Never in this route's HTTP status: 202 says "started" and nothing more.
 * Every route that uses this already reports its real outcome to the job heartbeat on every path
 * out, success and failure alike, and the fifteen-minute heartbeat sweep alarms on a job that never
 * reported. So the caller hanging up early loses nothing that was being read.
 *
 * `?wait=1` KEEPS THE OLD BEHAVIOUR: the run is awaited and its own response is returned, body and
 * status. The stranded-job re-fire calls it that way, over loopback where no thirty-second cap
 * applies, because it reads the status to decide whether the re-fire worked. So does a person
 * running one by hand who wants the report back.
 *
 * Outside a request scope (a script, the unit suite) `after()` throws, and the run is simply awaited.
 *
 * 🔴 Only for a route that reports its own outcome to the heartbeat on EVERY path. One that does not
 * would turn a failure into silence.
 */

/** The query parameter that makes the caller wait for the run, as every caller did before. */
export const WAIT_FOR_THE_RUN_PARAM = "wait";

type AfterTheResponse = (task: () => Promise<void>) => void;

export function callerWaitsForTheRun(request: Request): boolean {
  try {
    return new URL(request.url).searchParams.get(WAIT_FOR_THE_RUN_PARAM) === "1";
  } catch {
    return false;
  }
}

export async function answerNowThenFinish(
  request: Request,
  job: string,
  run: () => Promise<Response>,
  afterTheResponse: AfterTheResponse = after,
): Promise<Response> {
  if (callerWaitsForTheRun(request)) return run();

  const finish = async (): Promise<void> => {
    const startedAt = Date.now();
    try {
      const response = await run();
      logInfo("A scheduled run finished after its caller was answered", {
        labels: {
          durationMs: Date.now() - startedAt,
          event: "cron_finished_after_answer",
          job,
          status: response.status,
        },
      });
    } catch (error) {
      // The routes catch their own failures and report them to the heartbeat; this is the throw
      // none of them expected, and it must not vanish with the response that already left.
      logError("A scheduled run threw after its caller was answered", {
        error,
        labels: { event: "cron_failed", job },
      });
    }
  };

  try {
    afterTheResponse(finish);
  } catch {
    // Outside a request scope: run it now and hand back its own response, as before.
    return run();
  }

  return NextResponse.json(
    {
      accepted: true,
      job,
      note: `The run continues after this answer. Its outcome is on the job heartbeat; add ?${WAIT_FOR_THE_RUN_PARAM}=1 to wait for the report.`,
    },
    { status: 202 },
  );
}
