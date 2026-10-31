---
name: opening-an-empty-plan-day-as-a-rep-writes-production
description: "Merely OPENING an empty day on the rep's Phoenix CRM weekly planner fills it and saves a draft plan to production, under the rep's own HR id — a browser look signed in as a rep is a write"
metadata:
  node_type: memory
  type: project
  originSessionId: bd4997f0-537f-4b99-8af8-b9b349d2a257
  modified: 2026-10-31T02:47:04.063Z
---

On the rep's planner (`/employee-portals/field-crm/plan`, `plan-day-panel.tsx`), opening a day that has no
customers places them by itself ("Placed 2 on Saturday morning and 10 in the afternoon … They save by
themselves") and saves at once. If the week has no plan yet, that creates one: a `phoenix_crm_plans` draft,
its `phoenix_crm_plan_items` and two `phoenix_crm_plan_events` (created, saved) — all with the rep as
`created_by_hr_id` / `actor_hr_id`. Nothing goes to the manager (draft, not submitted).

2026-10-31 04:43 Cairo: a driver look at PR 6698, signed in through dev-auth as Mahmoud Abdelreheem
(Cairo West · Anti Infective), opened his empty Sat 7 Nov and created a draft for the week of 7 Nov
(12 customers). The owner chose to remove it; it was deleted (1 plan, 12 items, 2 events) the same morning.

**Why:** `.env.local` is production, and the run-phoenix-workforce skill treats `go`/`shot`/`eval` as
read-only — on this page they are not, and the audit trail then says the real rep made the plan.

**How to apply:** never drive the planner's day screen as a real rep on an EMPTY day. Look at a day that
already has a saved plan, or prove the component outside Next. If it happens: report it, ask, and on a
yes delete only that plan's items, events and plan row, guarded on `status='draft'` and its version.
Related: [[verify-the-emitted-artifact-never-the-source]].
