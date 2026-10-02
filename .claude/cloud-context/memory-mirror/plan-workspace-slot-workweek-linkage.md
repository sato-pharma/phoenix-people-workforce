---
name: plan-workspace-slot-workweek-linkage
description: "OUTDATED IN PART (contradiction sweep 2026-10-02) — current: District Manager added to WEEKLY_MONTHLY_PLAN_ELIGIBLE_JOB_TITLES, fixed 2026-07-18 (PR #1120) (see `dsm-plan-eligibility-fix-and-rm-gap`). Older text follows: Weekly/monthly plan editor — slot-bug fix, role-aware workweek, vacation/excuse + weekly→monthly linkage (PR 616, corrected in PR 617): an explicit AM/PM slot field stops the focus loss; the field workweek is Medical Rep/DSM/RM only (NSM is Head Office); plan SUBMISSION is PM/GPM/MM/TM/NSM only."
metadata: 
  node_type: memory
  type: project
  originSessionId: a2e5fcec-2299-4393-a3eb-2b6a58223136
---

Weekly/monthly employee plan workspace (`src/components/employee-portal/plans-workspace.tsx`, `src/lib/weekly-planning/`). Shipped in PR #616 (branch `feat/plan-linkage-workweek-sync`).

**Typing-bug root cause + fix (reusable gotcha):** AM/PM "slots" were *derived from* `start_time`/`end_time` via `slotKind()`. Editing any field re-ran `groupDraftRows`→`sortDraftRows` (a `useMemo` on `[rows]`), which re-sorted by slot and **reordered rows mid-keystroke → input focus stolen** (the "bouncing fields"). Fix = explicit `slot: "full"|"am"|"pm"` field on `DraftItem`; sort only by `(date, slot)`; persist slot→times only at save. Per owner: **no AM/PM clock times** — only "office full day" implies a time, kept implicit.

**Role-aware workweek** (in `plan-v1.ts`): `FIELD_WORKWEEK` (Sat–Wed full + Thu **AM only**, Sat-anchored) vs `HEAD_OFFICE_WORKWEEK` (Sun–Thu full, Sun-anchored). `resolvePlanWorkweek({role,jobTitle})`: Field = **Medical Rep / District Manager (DSM) / Regional Manager (RM) ONLY**; everyone else Head Office — including **NSM, PM, GPM, MM, TM** (owner: NSM is Head Office, not field; corrected in PR #617 after #616).

**Correction (2026-07-05):** this workweek-shape list is NOT the same as who can *submit* a weekly/monthly plan. Submission eligibility (`WEEKLY_MONTHLY_PLAN_ELIGIBLE_JOB_TITLES` in `plan-v1.ts`) is **Product Manager / Group Product Manager / Marketing Manager / Training Manager / National Sales Manager only** — Medical Rep/DSM/RM do NOT submit their own plans through this module. See [[plans-single-visit-vacant-areas-fix]]. `buildEmployeePlanPeriod(kind, anchor, workweek?)` is now workweek-aware (defaults to Head Office so legacy callers/keys are unchanged — forward-only). `planRequiredSlotsByDate()` drives both seeding and the guard.

**Submission guard** = server-authoritative `assertSubmissionComplete()` in ALL submit paths of `createEmployeePlan`/`updateEmployeePlan`. Every required slot must be filled (full = full OR am+pm; Field Thu = am only). Marking a day `Vacation`/`Excuse` requires a matching approved request or it BLOCKS.

**Cross-domain linkage:** `getPlanPrefill()` + `GET /api/weekly-plans/prefill` return locked manager-approved vacations (`v2_vacation_requests` `manager_decision='approved'`, `day_part`→slot) + approved excuses (`v2_excuse_requests` `status='approved'`, `excuse_type` morning/afternoon→am/pm) and, for monthly, submitted/approved weekly-plan items ("from weekly plan", live re-sync on open). Locked rows are read-only; merged via `mergePrefillIntoRows` (preserves user input → safe to re-run).

**Key reuse — `src/lib/private-calendar/`** already unifies all 6 sources (attendance, vacation, excuse, plan, double_visit, holiday=labeled "National vacation") with mappers `mapVacationRowToPrivateCalendarItem` etc. Use it before building new cross-domain plan↔leave↔calendar queries. See [[v2-vacation-prod-schema-drift]], [[directory-active-filter-gate]].

New activity types `National Vacation` (manual-only) + `Excuse` (auto-only, hidden from dropdown) — migration `20260629120000_plan_national_vacation_excuse_activity.sql` extends `employee_plan_items_activity_type_check`. Applied to STAGING; prod pending.
