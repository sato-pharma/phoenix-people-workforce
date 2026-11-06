// The timer that closes Early Birds fortnights.
//
// The close used to run from the iReports360 live poller's tick (close.ts's header still explains why
// it is in-process at all: the external scheduler caps a request at 30s). But the poller only started
// when iReports360 credentials were present, and the close never talks to the vendor — it reads the
// stored CRM record. So a missing or rotated vendor credential silently stopped every fortnight from
// closing. It moved to this timer, and the poller was removed with the vendor on 6 November 2026.
//
// This timer keeps the in-process HOST guards (resolveInProcessHostRefusal — the Railway production
// opt-in, a production build, the Railway production environment, not the page server) and needs no
// vendor credential. runDueEarlyBirdsClose throttles itself to one database check every 15 minutes
// and caps closes per call, so asking it once a minute produces the same closes the poller's
// 20-120s ticks did.

import { isEarlyBirdsCloseCheckDue, runDueEarlyBirdsClose } from "@/lib/early-birds/close";
import { logError } from "@/lib/observability/log";
import { trackJob } from "@/lib/observability/running-jobs";
import { resolveInProcessHostRefusal, unrefTimer } from "@/lib/platform/in-process-host";

/** How often the self-throttled close is asked. Far below its own 15-minute gate on purpose. */
export const EARLY_BIRDS_CLOSE_SCHEDULER_TICK_MS = 60_000;

let started = false;
/** A close can outlast one tick on a cold start; never run two at once. */
let inFlight = false;

async function runOnce(): Promise<void> {
  if (inFlight) return;
  // A throttled minute does nothing; registering it would name this job in every stall line
  // (PHOENIX-WORKFORCE-3 blamed "early-birds:close" for a freeze it took no part in).
  if (!isEarlyBirdsCloseCheckDue()) return;
  inFlight = true;
  try {
    await trackJob("early-birds:close", runDueEarlyBirdsClose);
  } catch (error) {
    // runDueEarlyBirdsClose already catches its own failures; this is the net under an unexpected
    // throw, so a broken close can never take down the timer or the process.
    logError("Early Birds close scheduler tick threw", {
      error,
      labels: { event: "early_birds_sweep_threw", job: "early-birds-close" },
    });
  } finally {
    inFlight = false;
  }
}

export type EarlyBirdsCloseSchedulerStartResult = { reason?: string; started: boolean };

/** Starts the singleton timer. Safe to call repeatedly — the second call is refused. */
export function startEarlyBirdsCloseScheduler(): EarlyBirdsCloseSchedulerStartResult {
  if (started) return { reason: "already running", started: false };
  const hostRefusal = resolveInProcessHostRefusal();
  if (hostRefusal) return { reason: hostRefusal, started: false };

  started = true;
  const timer = setInterval(() => {
    void runOnce();
  }, EARLY_BIRDS_CLOSE_SCHEDULER_TICK_MS);
  unrefTimer(timer);
  console.log(
    `[early-birds:close] started — asks every ${EARLY_BIRDS_CLOSE_SCHEDULER_TICK_MS / 1000}s; the close itself checks the database at most every 15 minutes`,
  );
  return { started: true };
}
