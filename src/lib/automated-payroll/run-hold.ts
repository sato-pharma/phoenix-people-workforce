import { logError } from "@/lib/observability/log";

import { claimRunTransition, getRunById, releaseRunTransition } from "./draft-store.ts";
import { describeTransitionRefusal } from "./transition-claim.ts";
import type { MonthlySalaryRun, RunPhase } from "./types.ts";

/**
 * A WRITE THAT IS NOT A TRANSITION STILL TAKES THE RUN'S CLAIM (audit 2026-10-23, F-08a / S-PAY-06).
 *
 * Transitions (confirm, reopen, cancel, publish) claim the run before their first write; see
 * claimTransition in run-service.ts. A step save, a step confirm, an exclusion and a Deductions or
 * expense resync did not. They checked `assertNoTransitionInProgress` once, against a run read
 * seconds earlier, and then wrote with no condition — so a save that passed its check while Part 2
 * was being confirmed landed inside the confirm, after the figures had been stamped, and a resync
 * cleared figures on a run that reached `ready` a moment later.
 *
 * So these writes take the same claim, through the same single-statement function, for exactly as
 * long as they write. The claim re-checks the phase, so a write that would land after the run moved
 * on is refused instead of written. Two holds never overlap: one waits briefly for the other, which
 * is what serialises two quick saves of the same grid rather than refusing the second.
 *
 * A hold does not change the phase and always lets go when its work ends, whether the work succeeded
 * or threw. A hold left by a request that died lapses after the claim's own 15 minutes.
 */

/** How long a hold waits for another hold or transition before refusing. */
export const RUN_HOLD_WAIT_MS = 15_000;
const RUN_HOLD_POLL_MS = 250;

export type RunHoldDeps = {
  claim: (runId: string, expected: RunPhase[], action: string) => Promise<string | null>;
  release: (runId: string, token: string) => Promise<void>;
  readRun: (runId: string) => Promise<MonthlySalaryRun | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

const defaultDeps: RunHoldDeps = {
  claim: claimRunTransition,
  release: releaseRunTransition,
  readRun: getRunById,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * Run `work` while holding the run's claim. `expected` is every phase the write is allowed in; a run
 * that has moved out of them is refused with the same words a refused transition gets.
 */
export async function holdRun<T>(
  input: {
    runId: string;
    expected: RunPhase[];
    action: string;
    waitMs?: number;
    /**
     * "refuse" (the default) throws when the wait runs out. "proceed" runs the work WITHOUT the hold
     * instead, exactly as it ran before holds existed — for a resync, whose decision has already been
     * saved and must still reach payroll. A claim that outlasts the wait is almost always one a dead
     * request left behind, and a live confirm it might overlap is caught by the Part 2 stamp anyway.
     */
    whenWaitRunsOut?: "refuse" | "proceed";
  },
  work: () => Promise<T>,
  deps: RunHoldDeps = defaultDeps,
): Promise<T> {
  const deadline = deps.now() + (input.waitMs ?? RUN_HOLD_WAIT_MS);
  let token: string | null = null;
  for (;;) {
    token = await deps.claim(input.runId, input.expected, input.action);
    if (token) break;
    const current = await deps.readRun(input.runId);
    const stillAllowed = Boolean(current && input.expected.includes(current.phase));
    // Wait only for something that will end: another holder on a run still in an allowed phase. A
    // run that has MOVED is refused at once — waiting cannot bring it back.
    if (stillAllowed && deps.now() >= deadline && input.whenWaitRunsOut === "proceed") {
      logError("Automated payroll: a write went ahead without the run's hold after waiting for it", {
        labels: {
          event: "automated_payroll_run_hold_wait_expired",
          runId: input.runId,
          action: input.action,
          heldBy: current?.transitionAction ?? null,
        },
      });
      return work();
    }
    if (!stillAllowed || deps.now() >= deadline) {
      throw new Error(describeTransitionRefusal(current, input.expected));
    }
    // Always pause before the next try: the app's clock and the database's can disagree about whether
    // a claim has lapsed, and a retry with no pause would hammer the run for the whole wait.
    await deps.sleep(RUN_HOLD_POLL_MS);
  }

  try {
    return await work();
  } finally {
    await deps.release(input.runId, token).catch((error: unknown) => {
      logError("Automated payroll: could not release a run hold", {
        labels: { event: "automated_payroll_run_hold_release_failed", runId: input.runId, action: input.action },
        error,
      });
    });
  }
}
