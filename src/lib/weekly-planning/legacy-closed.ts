// ─────────────────────────────────────────────────────────────────────────────
// THE WEEKLY PLANS TAB IS HISTORY — ONE PLAN STORE, PHOENIX CRM (owner, 14 Nov 2026, decision DR-02:
// "Phoenix CRM").
//
// Two plan stores let a person's week exist in one and not the other, so coverage, approvals and the
// no-weekly-plan deduction could each read a different answer. Phoenix CRM is the one store: a rep plans
// there, and so does every manager kind — district, regional, national, the product managers and the
// Training Manager (`phoenix_crm_plans`, `phoenix_crm_manager_plans`). Measured on production on 14 Nov
// 2026: every person who filed on the legacy form since 10 Oct had filed in Phoenix CRM within the last
// three days, and no legacy plan was waiting on an approver.
//
// So the legacy form (`employee_plan_*`, /admin/weekly-plans, /employee-portals/plans, /api/weekly-plans)
// refuses every write — no new plan, edit, submit, approval, acknowledgement, move, reassign, visit-detail
// or comment — and keeps every plan anyone filed there visible, to read and export. Its rows are never
// deleted. Re-opening it is a decision for the owner, never a fix.
// ─────────────────────────────────────────────────────────────────────────────

/** True since DR-02. Every legacy write function checks it first (`assertLegacyPlansOpen`, service.ts). */
export const LEGACY_PLANS_CLOSED = true;

/** The day the legacy form closed (Cairo). */
export const LEGACY_PLANS_CLOSED_ON = "2026-11-14";

/** What a refused write says. Plain words, and where to go instead. */
export const LEGACY_PLANS_CLOSED_MESSAGE =
  "This Plans tab is history now. Weekly plans are made, sent and approved in Phoenix CRM: open Phoenix CRM, then Plan.";
