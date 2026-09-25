---
name: weekly-plan-duplicate-period-submission-fix
description: "Weekly-plan duplicate-period bug (B-122/Amr Naguib) — root cause, fix, and PR #1353 status"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4f02fbbd-5df5-40ec-a28b-9da9a09dc874
  modified: 2026-07-25T20:21:51.476Z
---

Bug: `createEmployeePlan` (src/lib/weekly-planning/service.ts) let an employee
create a brand-new, unlinked plan header for a period that already had an
active/acknowledged one — the officially-supported way to amend a closed plan
is the "revise" flow in `updateEmployeePlan` (chains via `parent_plan_id`), but
nothing stopped a completely separate submission instead. B-122 (Amr Naguib,
NSM) hit this for week 2026-07-05..2026-07-09: got a plan fully approved +
hr_acknowledged same day, then next day wanted to add one note and instead
created a second independent plan that was also fully approved — both
rendered as duplicates on the shared Planning Calendar. Company-wide scan
found this was the **only** occurrence in production.

Root cause (precise): `employee_plan_headers_active_period_uidx` (a partial
unique index, not a `pg_constraint` — easy to miss if you only check
`pg_constraint`) already existed to prevent exactly this, but its `WHERE`
clause only covered pre-approval statuses (submitted, edit_requested,
manager_approved, manager_returned, ceo_returned) — never widened to include
`final_approved`/`hr_acknowledged` as the workflow evolved.

Fix (PR [#1353](https://github.com/Phoenix-HR/phoenix-people-workforce/pull/1353),
branch `claude/wonderful-matsumoto-66837d`):
- App-level check `assertNoActivePlanForSamePeriod` in service.ts, called from
  `createEmployeePlan`, throws a new `duplicate_period` `WeeklyPlanRpcError`
  (auto-maps to HTTP 409 via existing error plumbing — no route change
  needed). The frontend's `friendlyError()` in `plans-workspace.tsx` already
  had a matching message for this exact class of error, previously dead code.
- Migration `20260725183742_weekly_plan_active_period_uidx_close_gap.sql`
  widens the index's `WHERE` to block every status except
  `draft`/`cancelled`/`manager_rejected`/`ceo_rejected`.
- **`draft` must stay excluded** — the original index deliberately excluded it
  (an unsubmitted draft is a private scratchpad, not a claim on the period).
  First version of this migration forgot that exclusion and broke staging
  (a stray abandoned draft for employee A-7 conflicted). Don't re-widen to
  include draft without expecting this.

Data correction: header `eaf7977c-7217-4c5a-872b-1de75c68f989` (the older,
note-less duplicate) cancelled on **both** production and staging, keeping
`2594e9f5-1711-41b3-9f0c-f6e1789ac72f` (has the added visit note) as the plan
of record. Matching `employee_plan_decisions` audit rows written on both.

Gotcha: staging (`cifwmndunmlxjhyjugxa`) is a clone of production from
2026-07-11 and independently carried the *same* pre-fix B-122 duplicate —
don't assume staging is clean just because production was fixed first;
re-check and re-fix data on staging separately before it can validate a
migration that depends on that data being clean.

Status as of 2026-07-25: migration applied + regression-verified (rollback-only
duplicate-insert correctly rejected) on **both staging and production**.
Code committed/pushed (2 commits) and PR #1353 open — **not yet merged/deployed
to prod app code**; only the DB-side index change is live so far.

See also [[migration-timestamp-collision-hazard]], [[agents-md-stale-staging-ref]].
