---
name: dr-02-phoenix-crm-is-the-one-plan-store
description: "Owner decision DR-02 (14 Nov 2026): Phoenix CRM plans are the field force's one plan store; the older weekly Plans tab (employee_plan_*) becomes read-only history — no new plans, approvals or edits."
metadata:
  node_type: memory
  type: project
  originSessionId: d6cd0e8b-e41c-4195-bfe9-3759a7718c37
  modified: 2026-11-14T02:53:01.062Z
---

On 14 Nov 2026 (~05:00 Cairo) the owner chose "Phoenix CRM (Recommended)" for decision record DR-02 (enterprise audit REC-007, F-CRM-008, session S06).

Measured that day on production: `phoenix_crm_plans` 333 new plans in 30 days (newest 13 Nov 15:13); the older weekly Plans tab (`employee_plan_headers`, `/admin/weekly-plans`, `/api/weekly-plans/*`) 25 in 30 days, newest 24 Oct, 280 in all.

**Why:** two plan stores let a rep's plan exist in one and not the other, so coverage, approvals and compliance read different sources.

**How to apply:** every plan reader goes through Phoenix CRM plans via one read function; the older tab stays visible as history but refuses new plans, approvals, edits, moves and reassigns server-side. Never re-open the older tab for writing, and never delete its rows. See [[sos-monthly-closing-is-the-only-sales-truth]] for the sibling "one source" rule on sales.
