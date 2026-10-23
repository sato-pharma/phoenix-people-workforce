import type { MonthlySalaryRun, RunPhase } from "./types.ts";

/**
 * ONE TRANSITION AT A TIME ON A PAYROLL RUN (audit finding 50): the pure half.
 *
 * A transition claims the run before its first write (phx_claim_automated_payroll_run_transition) and
 * its phase write clears the claim. These helpers answer the two questions the rest of the module asks
 * about a claim without touching the database: is one live right now, and what should a refused request
 * be told.
 */

/** How long a claim lasts before it counts as abandoned. The SQL claim function uses the same figure. */
export const TRANSITION_CLAIM_LAPSE_MINUTES = 15;

type ClaimFields = Pick<MonthlySalaryRun, "transitionAction" | "transitionStartedAt">;

/** Whether a live transition holds this run right now: claimed, and not yet lapsed. */
export function transitionInProgress(run: ClaimFields, nowMs: number = Date.now()): boolean {
  if (!run.transitionAction || !run.transitionStartedAt) return false;
  const startedAt = Date.parse(run.transitionStartedAt);
  if (!Number.isFinite(startedAt)) return false;
  return nowMs - startedAt < TRANSITION_CLAIM_LAPSE_MINUTES * 60_000;
}

/**
 * Marker on the refusal a conditioned phase write throws when its claim no longer holds the run.
 * Publish looks for it, because by then a salary batch exists and "nothing happened" would be a lie.
 */
export const TRANSITION_CLAIM_LOST = "[transition-claim-lost]";

/**
 * The names a short write takes the claim under (run-hold.ts) — a save, a step confirm, an exclusion,
 * a resync. They hold the run for the second or two their writes take, and they WAIT for one another
 * rather than refusing, so the early check below lets them past and a transition waits them out.
 */
export const RUN_HOLD_ACTIONS = {
  saveStep: "Saving a step",
  confirmStep: "Confirming a step",
  exclude: "Excluding an employee",
  include: "Putting an employee back",
  deductionResync: "Applying a deduction decision",
  expenseResync: "Applying an expense decision",
} as const;

const HOLD_ACTION_NAMES = new Set<string>(Object.values(RUN_HOLD_ACTIONS));

/** Whether the run's current claim is a short hold rather than a transition. */
export function isRunHoldAction(action: string | null | undefined): boolean {
  return Boolean(action && HOLD_ACTION_NAMES.has(action));
}

/**
 * A step save, exclusion or re-inclusion waits while a TRANSITION holds the run. Another short hold is
 * not refused here: the write itself takes the hold, and waits for it there.
 */
export function assertNoTransitionInProgress(run: ClaimFields, nowMs: number = Date.now()): void {
  if (!transitionInProgress(run, nowMs)) return;
  if (isRunHoldAction(run.transitionAction)) return;
  throw new Error(
    `Conflict: ${run.transitionAction} is in progress on this run. Nothing was saved; try again when it finishes.` +
      describeClaimLapse(run),
  );
}

function phaseWords(phase: RunPhase): string {
  if (phase === "part1") return "in Part 1";
  if (phase === "part2") return "in Part 2";
  if (phase === "ready") return "Part 2 confirmed";
  return String(phase);
}

/**
 * When a claim lapses by itself, in Cairo time — so a request that died holding the run does not leave
 * HR guessing how long saves, confirms and publish stay refused (risk review of #6289, 2026-10-23).
 */
export function describeClaimLapse(run: ClaimFields): string {
  const startedAt = Date.parse(run.transitionStartedAt ?? "");
  if (!Number.isFinite(startedAt)) return "";
  const lapse = new Date(startedAt + TRANSITION_CLAIM_LAPSE_MINUTES * 60_000);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(lapse);
  return ` If it never finishes, the run frees itself at ${time} Cairo time.`;
}

/** What a transition that could not claim the run is told, in words HR can act on. */
export function describeTransitionRefusal(
  current: (ClaimFields & Pick<MonthlySalaryRun, "phase">) | null,
  expected: RunPhase[],
  nowMs: number = Date.now(),
): string {
  if (!current) return "Not found: payroll run does not exist.";
  if (transitionInProgress(current, nowMs)) {
    return (
      `Conflict: ${current.transitionAction} is already in progress on this run, so nothing was changed. Try again when it finishes.` +
      describeClaimLapse(current)
    );
  }
  return (
    `Conflict: this run is now ${phaseWords(current.phase)}, not ${expected.map(phaseWords).join(" or ")}, ` +
    "so nothing was changed. Refresh the page to see where it stands."
  );
}
