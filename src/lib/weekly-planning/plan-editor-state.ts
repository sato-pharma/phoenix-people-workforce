import { hrIdsMatch } from "@/lib/hr-id";
import {
  buildEmployeePlanPeriod,
  type EmployeePlanKind,
  type PlanWorkweek,
} from "@/lib/weekly-planning/plan-v1";

/**
 * Small, pure pieces of the plans workspace's client state, kept out of the component so each can be
 * unit-tested. Nothing here touches React, the network or the clock.
 */

// ---------------------------------------------------------------------------
// Review comments - one draft per plan
// ---------------------------------------------------------------------------

/** The comment typed for each plan under review, keyed by plan id. */
export type PlanCommentDrafts = Readonly<Record<string, string>>;

/** What is typed for ONE plan; a plan nobody has typed on yet reads as empty. */
export function planCommentFor(drafts: PlanCommentDrafts, planId: string): string {
  return drafts[planId] ?? "";
}

/**
 * Records what is typed for one plan and leaves every other plan's draft alone. A single string
 * shared by every review card sent the text typed for plan A on plan B when B was approved or
 * returned - the comment goes to the plan's employee and into its decision history.
 */
export function withPlanComment(drafts: PlanCommentDrafts, planId: string, value: string): PlanCommentDrafts {
  return { ...drafts, [planId]: value };
}

/** Forgets one plan's draft after a decision on THAT plan went through. */
export function withoutPlanComment(drafts: PlanCommentDrafts, planId: string): PlanCommentDrafts {
  if (!(planId in drafts)) return drafts;
  const next: Record<string, string> = { ...drafts };
  delete next[planId];
  return next;
}

// ---------------------------------------------------------------------------
// Bulk-approve selection
// ---------------------------------------------------------------------------

/**
 * The selection narrowed to plans still in the queue. A plan decided one by one leaves the queue but
 * stayed in the selection, so "Approve selected (N)" counted it and sent its id to a plan that was no
 * longer waiting. Returns the same set when nothing was dropped so state does not churn.
 */
export function pruneSelectedPlanIds(selected: Set<string>, livePlanIds: Iterable<string>): Set<string> {
  const live = new Set(livePlanIds);
  let dropped = false;
  const next = new Set<string>();
  for (const id of selected) {
    if (live.has(id)) next.add(id);
    else dropped = true;
  }
  return dropped ? next : selected;
}

// ---------------------------------------------------------------------------
// Who may edit a plan
// ---------------------------------------------------------------------------

/**
 * Whether the viewer may save, submit or revise this plan: its owner, or a Super Admin. This is the
 * server's rule verbatim (assertPlanOwner in service.ts calls this very function), so the editor
 * cannot offer Save / Submit / Add day to someone the server answers with 403. A manager who opens a
 * report's plan reads it; he does not edit it.
 */
export function viewerMayEditPlan(input: {
  planOwnerHrId: string | null | undefined;
  viewerHrId: string | null | undefined;
  viewerRole: string | null | undefined;
}): boolean {
  return hrIdsMatch(input.viewerHrId, input.planOwnerHrId) || input.viewerRole === "Super Admin";
}

// ---------------------------------------------------------------------------
// Plan period pick
// ---------------------------------------------------------------------------

/**
 * Whether the period a person just picked is the one already on screen. Picking it again only
 * confirms the choice; resetting the rows would drop what they filled in and the approved-leave and
 * holiday rows with it.
 */
export function pickedPeriodIsShown(input: {
  kind: EmployeePlanKind;
  pickedAnchorDate: string;
  shownPeriodStartDate: string;
  workweek: PlanWorkweek;
}): boolean {
  return (
    buildEmployeePlanPeriod(input.kind, input.pickedAnchorDate, input.workweek).periodStartDate ===
    input.shownPeriodStartDate
  );
}

// ---------------------------------------------------------------------------
// Incomplete-days banner
// ---------------------------------------------------------------------------

/**
 * The banner's heading over the list of days that still block submit. A half-day planner (the Group
 * Product Manager) needs only the morning OR the afternoon of a working day, so telling him to
 * "finish every working day" asks for more than the server does.
 */
export function incompleteDaysHeading(allowHalfDays: boolean): string {
  return allowHalfDays
    ? "Plan at least the morning or the afternoon of every working day before submitting"
    : "Finish every working day before submitting";
}
