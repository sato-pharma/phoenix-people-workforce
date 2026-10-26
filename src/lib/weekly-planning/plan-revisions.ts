// Weekly / Monthly Plan — amending an APPROVED plan. The pure half: no database, no I/O.
//
// An approved plan (final_approved, hr_acknowledged) is the plan of record for its period: the
// calendars, the attendance expectations and the adherence score all read it. The employee amends
// it by filing a REVISION — a new header whose parent_plan_id points at the approved plan. The
// approved plan stays the plan of record while the revision waits for its decisions; when the
// revision reaches final_approved, phx_weekly_plan_decide cancels the parent in the same
// transaction (migration 20261018233000), so the period never holds two plans of record.
//
// Three rules live here so the service, the readers and the tests all read ONE statement of them.

import type { EmployeePlanStatus } from "@/lib/weekly-planning/plan-v1";

/** The two statuses in which a plan IS the plan of record for its period. */
export const PLAN_OF_RECORD_STATUSES = ["final_approved", "hr_acknowledged"] as const satisfies readonly EmployeePlanStatus[];

export function isPlanOfRecordStatus(status: string | null | undefined): boolean {
  return (PLAN_OF_RECORD_STATUSES as readonly string[]).includes(String(status ?? ""));
}

// Statuses that claim nothing — the same four employee_plan_headers_active_period_uidx leaves out
// (draft is private scratch space), minus draft, which is handled as "editable" below.
const DEAD_REVISION_STATUSES = new Set<string>(["cancelled", "manager_rejected", "ceo_rejected"]);
// A returned revision is still LIVE (it holds the one-live-revision slot) but the employee may edit
// and resubmit it, so it is the revision to reuse; a draft is reused only when nothing returned exists.
const RETURNED_REVISION_STATUSES = new Set<string>(["manager_returned", "ceo_returned"]);

export type RevisionSibling = {
  createdAt: string;
  id: string;
  revision: number;
  status: EmployeePlanStatus;
};

export type RevisionTarget =
  /** Edit this existing revision instead of spawning another. */
  | { kind: "reuse"; revision: number; revisionId: string }
  /** Spawn a new draft. linkToParent is false when the closed plan is a dead one (see below). */
  | { kind: "create"; linkToParent: boolean }
  /** A revision of this plan is already awaiting a decision — spawning another would collide. */
  | { kind: "blocked" };

/**
 * What updateEmployeePlan does when its target plan is closed.
 *
 *   · An APPROVED plan: look at the revisions already hanging off it. A pending one blocks (one live
 *     revision per parent — employee_plan_headers_one_live_revision_uidx). A returned one, else the
 *     newest draft, is reused, so a retry never leaves a second empty draft behind (23 of them did).
 *     Otherwise a new revision is created and linked to its parent.
 *   · A DEAD plan (rejected or cancelled): it never was, or no longer is, the plan of record, so the
 *     new draft is a fresh claim on the period and is NOT linked — the unique index exempts only
 *     revisions of an approved plan, and a linked revision of a dead one would slip past it and sit
 *     beside whatever live plan the period holds.
 */
export function chooseRevisionTarget(
  closedPlanStatus: EmployeePlanStatus,
  siblings: readonly RevisionSibling[],
): RevisionTarget {
  if (!isPlanOfRecordStatus(closedPlanStatus)) return { kind: "create", linkToParent: false };

  const live = siblings.filter((sibling) => !DEAD_REVISION_STATUSES.has(sibling.status));
  const pending = live.filter((sibling) => sibling.status !== "draft" && !RETURNED_REVISION_STATUSES.has(sibling.status));
  if (pending.length > 0) return { kind: "blocked" };

  const newestFirst = (left: RevisionSibling, right: RevisionSibling) =>
    right.createdAt.localeCompare(left.createdAt) || right.revision - left.revision;
  const returned = live.filter((sibling) => RETURNED_REVISION_STATUSES.has(sibling.status)).sort(newestFirst);
  const drafts = live.filter((sibling) => sibling.status === "draft").sort(newestFirst);
  const reusable = returned[0] ?? drafts[0];
  if (reusable) return { kind: "reuse", revision: reusable.revision, revisionId: reusable.id };
  return { kind: "create", linkToParent: true };
}

/**
 * Drop every revision that is still waiting for its decisions while the plan it revises is in the
 * same list as the plan of record.
 *
 * While a revision is pending BOTH headers exist, and a reader whose status list includes the
 * pre-approval statuses (the shared planning calendar, the private calendar, the weekly/monthly
 * prefill sources, the adherence history) would show the period twice — the B-122 symptom. The
 * approved parent is the plan of record until the revision itself is approved, so the revision is
 * the one to leave out. A revision whose parent is NOT in the list (a dead parent, or a parent the
 * reader's own filter excluded) is kept: it is then the only plan the reader can see.
 */
export function dropPendingRevisionsOfPlansOfRecord<T extends { id: string; parent_plan_id?: string | null; status: string | null }>(
  rows: readonly T[],
): T[] {
  const ofRecord = new Set(rows.filter((row) => isPlanOfRecordStatus(row.status)).map((row) => row.id));
  if (ofRecord.size === 0) return [...rows];
  return rows.filter((row) => !(row.parent_plan_id && ofRecord.has(row.parent_plan_id) && !isPlanOfRecordStatus(row.status)));
}

/**
 * Split off every DRAFT whose period already holds a live plan of the same kind — a plan that went
 * forward (submitted, in approval or approved). Such a draft can never be sent: the period's unique
 * index refuses a second live plan. The plan history listed one beside the plan that replaced it
 * (NSM audit, 2026-10-26: 2026-W32 as rev 4 "Draft" and rev 5 "HR acknowledged", neither linked by
 * parent_plan_id), so the reader saw one week twice. A draft is kept when it is the only plan of its
 * period, or when every other plan of the period is dead (rejected or cancelled).
 */
export function splitDraftsReplacedByALaterPlan<T extends { periodKey: string; planKind: string; status: string | null }>(
  plans: readonly T[],
): { kept: T[]; replaced: T[] } {
  const periodOf = (plan: T) => `${plan.planKind}:${plan.periodKey}`;
  const wentForward = new Set(
    plans
      .filter((plan) => plan.status !== "draft" && !DEAD_REVISION_STATUSES.has(String(plan.status ?? "")))
      .map(periodOf),
  );
  const kept: T[] = [];
  const replaced: T[] = [];
  for (const plan of plans) (plan.status === "draft" && wentForward.has(periodOf(plan)) ? replaced : kept).push(plan);
  return { kept, replaced };
}

/** Shown when a revision of the same approved plan is already waiting for its decisions. */
export const REVISION_PENDING_MESSAGE =
  "A revised version of this plan is already waiting for approval. Wait for the decision on it before sending another revision.";

/** Shown when another plan already holds the period. Worded to stay true at submit AND at approval. */
export const PERIOD_CLAIMED_MESSAGE =
  "Another plan for this period is already in the approval flow or approved, so this plan cannot move forward. Check the plans listed for this period.";

/**
 * Turn a unique-violation on one of the two plan-header indexes into a sentence that is TRUE.
 *
 * Until 2026-10-18 every 23505 on employee_plan_headers_active_period_uidx reached the form as
 * "You already have an active plan for this period." — and for an employee amending an approved
 * plan that was false: the approved plan itself tripped the index. Returns null for anything that
 * is not a unique violation on these indexes, so the caller keeps the original error. None of the
 * messages contains "duplicate key" or "already exists", the words the form still translates.
 */
export function translatePlanUniqueViolation(message: string, code?: unknown): string | null {
  const text = String(message ?? "");
  const isUniqueViolation = String(code ?? "") === "23505" || /duplicate key value|violates unique constraint/i.test(text);
  if (!isUniqueViolation) return null;
  if (/employee_plan_headers_one_live_revision_uidx/i.test(text)) return REVISION_PENDING_MESSAGE;
  if (/employee_plan_headers_active_period_uidx/i.test(text)) return PERIOD_CLAIMED_MESSAGE;
  return null;
}
