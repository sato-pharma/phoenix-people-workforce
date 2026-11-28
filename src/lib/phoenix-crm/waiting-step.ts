/**
 * Phoenix CRM — which of the two approval steps a waiting item is at, for the Team tab's filter and look.
 *
 * Owner, 2026-11-28: "I want to be able to filter by waiting for manager or waiting for SFE … and I want
 * the waiting for manager to be visually differentiated from the waiting for SFE." A list request (drop,
 * add, bring-back) and an off-plan visit both go the district manager, then SFE; a grade change is the
 * district manager's one step, so it reads as his. A request returned to the rep for a comment waits for
 * neither, and an off-plan visit recorded for the Administrator waits for him first — both are shown
 * under "Every step" only.
 *
 * One rule for both sections, so the filter can never place an item at a step its own pill does not name.
 */

import type { UnplannedVisitStatus } from "@/lib/phoenix-crm/unplanned-rules";

/** The two approval steps the filter names. */
export type WaitingStep = "manager" | "sfe";

/** The Team tab's step filter: both steps, or one. */
export type WaitingStepFilter = "all" | WaitingStep;

/**
 * The step a list request is waiting at, or null when it waits for neither (decided, or with the rep).
 * A grade change has no stage and is the district manager's one step.
 */
export function listRequestWaitingStep(request: { status: string; stage: string | null; withRep: boolean }): WaitingStep | null {
  if (request.status !== "pending" || request.withRep) return null;
  return request.stage === "sfe" ? "sfe" : "manager";
}

/** The step an off-plan visit is waiting at, or null when it waits for neither (decided, or the Administrator's recorded-visit step). */
export function offPlanWaitingStep(status: UnplannedVisitStatus): WaitingStep | null {
  if (status === "manager_pending") return "manager";
  if (status === "sfe_pending") return "sfe";
  return null;
}

/** Whether an item at `step` shows under `filter`. "Every step" shows everything, the rep's and the Administrator's included. */
export function matchesWaitingStep(step: WaitingStep | null, filter: WaitingStepFilter): boolean {
  return filter === "all" || step === filter;
}

/** How many items wait at each step — the counts the filter shows beside its two choices. */
export function waitingStepCounts<T>(items: ReadonlyArray<T>, stepOf: (item: T) => WaitingStep | null): Record<WaitingStepFilter, number> {
  const counts: Record<WaitingStepFilter, number> = { all: items.length, manager: 0, sfe: 0 };
  for (const item of items) {
    const step = stepOf(item);
    if (step) counts[step] += 1;
  }
  return counts;
}

/** The filter's choices, in the words the pills use. */
export const WAITING_STEP_FILTER_LABELS: Record<WaitingStepFilter, string> = {
  all: "Every step",
  manager: "Waiting for the manager",
  sfe: "Waiting for SFE",
};
