---
name: no-activity-report-cross-employee-suppression-bug
description: "No Activity Days report suppressed attendance by DATE only — one rep's double visit erased 10 colleagues' punches and falsely flagged them; fixed on codex/no-activity-employee-scoped-suppression"
metadata: 
  node_type: memory
  type: project
  originSessionId: e0491122-d75a-469e-8531-3c35cc29cb82
  modified: 2026-08-22T22:23:50.419Z
---

**The bug FIRED IN PRODUCTION on 2026-07-22 and the evidence is still in the DB.**

`getCompanyNoActivityDays` (src/lib/private-calendar/service.ts) built `fieldVisitDates` as a
Set of **dates with no employee key**, then dropped EVERY attendance item on those dates —
including `status = "Complete"`. The sibling workspace path kept Complete but was also date-keyed
(same defect, display-only, team view).

Chain: no attendance item → day not `isCovered` in `derivePrivateCalendarExceptions` →
"No Activity Recorded" → `decideNoActivityDay` writes `deduction_candidates`
(`source_module='MANUAL_HR'`, `deduction_type='no_activity'`) with "Approved for Payroll".

## Live production evidence (read-only, 2026-08-01)

2026-07-22: **121 double visits by 15 people**, **25 punches by 10 people**,
**92 employees flagged "No Activity Recorded"** and sent clarification requests.
All 10 punchers were among the flagged — including **A-4 who punched 7 times from 05:39 to 16:35**.
Confirmed causal: **0** of those 10 had their own double visit that day, so fingerprint attendance
was their only coverage and the date-only filter deleted it.

✅ **No wrongful deduction was ever executed** — all 92 clarifications are `pending_review` with
`resolution = null`, and `deduction_candidates` has **0 MANUAL_HR rows ever**. The damage was
wrongful accusation, not wrongful pay. (The 84 `FIELD_WORKFORCE/no_activity` rows are a different
module.) **The 92 rows for 2026-07-22 should be reviewed/voided** — the report that produced them
was wrong; nothing in the fix retracts them.

## Fix — ✅ **MERGED 2026-08-01T09:16Z as `0dcca58b`** (PR #1575, was `e6b1181b`)

Verified on `origin/main`: helper present, both call sites wired, `fieldVisitDates` gone.
Remote branch auto-deleted (`delete_branch_on_merge`); local branch
`codex/no-activity-employee-scoped-suppression` + worktree `_wt-no-activity-scope` still exist and
need owner approval to remove. ~~**Ships on the 2-hourly prod deploy cron, NOT on merge.**~~
🔴 **That last sentence is now exactly backwards — corrected 2026-08-23.** It was true in the GCP
Cloud Run era; since 2026-08-01 production is Railway and **a merge to `main` IS the deploy**, live
in minutes at full traffic. There is no cron and no window in which to catch a mistake. See
[[railway-merge-is-the-production-deploy]].

🔴 **STILL OWED: the 92 `private_calendar_no_activity_clarifications` rows for 2026-07-22 are
untouched by this merge** — at least 10 are provably false. They sit at `pending_review`,
`resolution = null`. Voiding them is a live-data write needing separate owner approval.

One exported pure helper `suppressFieldVisitAttendanceProblems(items)` in
`src/lib/private-calendar/logic.ts`, used by BOTH call sites: keys on
`` `${privateCalendarHrIdKey(employeeHrId)}|${startDate}` ``, never suppresses `Complete`, and an
unattributable double visit (no HR ID) suppresses nothing — fail-safe direction is "show more
attendance", because a missed Late flag is cheaper than a manufactured no-activity day.

Validation: typecheck clean, lint clean, build clean, **507 test files pass**.

## Traps this cost

- **Attendance item ids are `attendance-<hrkey>-<date>`** — a test giving one employee two
  attendance rows on the same date silently collides into one id. Real data has one row per
  employee per day; build multi-status scenarios across different dates.
- The old source-regex test pinned the inline filter string, so moving the guard into a helper
  broke it. Replaced with: both call sites must call the helper (count === 2) + `fieldVisitDates`
  must not reappear anywhere in service.ts + real behavioral assertions. This is the repo-wide
  [[test-seams-for-supabase-backed-code]] pattern and a concrete instance of the audit's
  "source-regex tests verify a guard is CALLED, never that its result is USED" theme.
- Proving the test catches the defect required reproducing the *exact* old semantics
  (date-only key AND drop-Complete). A first attempt broke the key differently and failed on a
  DIFFERENT assertion — see [[prove-it-fails-verify-which-assertion-fired]].

Found by [[module-audit-2026-08-01-status]] (finding #2).
