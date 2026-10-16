// The one District Manager plan chain that has a real stage after the manager — policy data shared by
// the legacy Weekly Plans and the district manager's Phoenix CRM week (owner, 2026-10-16: "Hany's DMs
// then go to Ali"). It lives outside both modules so each reads it without importing the other;
// `src/lib/weekly-planning/second-approver.ts` re-exports it unchanged.
//
// Every other District Manager plan is submit → manager (NSM/RSM) → HR acknowledge, with no stage
// in between (AGENTS.md §4, owner 2026-09-05). Owner instruction 2026-09-20: the District Managers
// who report to Hany Saad take a longer road — submit → Hany's approval → Ali Mohamed Ali's
// approval → HR acknowledge (automatic). It is a rule about WHO the manager is, not about the
// title, so it lives here as data and every reader asks these helpers instead of comparing ids.
//
// The stage rides the existing manager_approved → final_approved transition (the decide RPC's
// `ceo_approve` / `ceo_return` / `ceo_reject` actions): the RPC never checks WHO decides, the
// application does, so the second approver decides that slot in place of the CEO and no migration
// is needed. What the header's `ceo_decision_*` columns then hold for such a plan is HIS real
// decision — see resolvePlanCeoDecision, which is why it takes the manager as a parameter.
//
// Pure — no I/O, safe to import from a client component or a test.

import { normalizeHrIdForAccess } from "@/lib/hr-id";

export type DmPlanSecondApproval = {
  /** The District Managers' manager: the FIRST approver, whose plans' stage two this adds. */
  managerHrId: string;
  /** Who decides the stage after that manager — never the CEO for these plans. */
  approverHrId: string;
  managerLabel: string;
  approverLabel: string;
  /** How the approver's step reads in the approval tracker ("<title> Approval"). */
  approverTitle: string;
};

export const DM_PLAN_SECOND_APPROVALS: readonly DmPlanSecondApproval[] = [
  {
    managerHrId: "PD-0001",
    approverHrId: "A-12",
    managerLabel: "Hany Saad Mohamed Omar",
    approverLabel: "Ali Mohamed Ali Elsayed",
    approverTitle: "National Sales Manager",
  },
];

function key(value: string | null | undefined): string {
  return normalizeHrIdForAccess(value) ?? "";
}

function entryForManager(managerHrId: string | null | undefined): DmPlanSecondApproval | null {
  const managerKey = key(managerHrId);
  if (!managerKey) return null;
  return DM_PLAN_SECOND_APPROVALS.find((entry) => key(entry.managerHrId) === managerKey) ?? null;
}

/** The second approver of a plan whose first approver is `managerHrId`, or null for every other plan. */
export function secondApproverHrIdForManager(managerHrId: string | null | undefined): string | null {
  return entryForManager(managerHrId)?.approverHrId ?? null;
}

/** Display name of that second approver — for notification and tracker copy. */
export function secondApproverLabelForManager(managerHrId: string | null | undefined): string | null {
  return entryForManager(managerHrId)?.approverLabel ?? null;
}

/** The tracker title of that second approver's step. */
export function secondApproverTitleForManager(managerHrId: string | null | undefined): string | null {
  return entryForManager(managerHrId)?.approverTitle ?? null;
}

/** True when `viewerHrId` is the second approver for plans whose manager is `managerHrId`. */
export function isSecondApproverForManager(
  viewerHrId: string | null | undefined,
  managerHrId: string | null | undefined,
): boolean {
  const entry = entryForManager(managerHrId);
  const viewerKey = key(viewerHrId);
  return Boolean(entry && viewerKey && key(entry.approverHrId) === viewerKey);
}

/** Every manager whose plans this viewer decides the second stage for (empty for nearly everyone). */
export function managerHrIdsForSecondApprover(viewerHrId: string | null | undefined): string[] {
  const viewerKey = key(viewerHrId);
  if (!viewerKey) return [];
  return DM_PLAN_SECOND_APPROVALS.filter((entry) => key(entry.approverHrId) === viewerKey).map(
    (entry) => entry.managerHrId,
  );
}

/**
 * Whether a plan takes the second stage: it is a District Manager plan AND its manager has a
 * configured second approver. Callers compute `isDistrictManagerPlan` the way they already do
 * (title OR app role — isDistrictManagerPlanSubmitter).
 */
export function planHasSecondApprover(
  managerHrId: string | null | undefined,
  isDistrictManagerPlan: boolean,
): boolean {
  return isDistrictManagerPlan && entryForManager(managerHrId) !== null;
}
