---
name: no-activity-days-module-retired
description: "/admin/no-activity-days retired end-to-end (owner call 2026-08-01). getCompanyNoActivityDays SURVIVES — the unified Deductions connector depends on it. Branch codex/retire-no-activity-days"
metadata: 
  node_type: memory
  type: project
  originSessionId: e0491122-d75a-469e-8531-3c35cc29cb82
  modified: 2026-08-01T09:55:44.615Z
---

Owner retired the No Activity Days module on 2026-08-01, right after
[[no-activity-report-cross-employee-suppression-bug]] showed it had false-flagged 10 employees who
had physically punched in.

## 🔴 The trap that nearly broke a live module

`getCompanyNoActivityDays` (src/lib/private-calendar/service.ts) **looks like part of this module
and is NOT**. It is the engine behind the unified Deductions module's No Records Activity connector
(`src/lib/deductions/connectors/no-records-activity.ts`, live at `/admin/deductions`), whose own
header says it "reuses the existing Private Calendar No Activity Recorded engine". Deleting it
breaks that module. **It must stay.** The scoped greps that mapped this module missed it — only a
repo-wide grep after the deletions caught it.

Same shape: `src/lib/automated-payroll/recommend.ts:~1297` reads
`private_calendar_no_activity_clarifications` directly (defensive, non-fatal) so HR sees an
employee's existing explanation next to the money. Kept — historical rows stay valid.

## Removed (branch `codex/retire-no-activity-days`, worktree `_wt-retire-no-activity`)

18 files, **-1283 / +63**. Admin page + 3 API routes (`/api/private-calendar/no-activity{,/report,/decide}`)
+ workspace component + `no-activity-clarifications.ts` (501 lines) + nav entry + 3 access-registry
entries + the employee-portal "Clarify this day" form/handler/state + the clarification-status
overlay in the private calendar + the `no_activity_weekly_reminder` email template, its token,
render-core field and sample builder + the `private_calendar_no_activity_clarification` audit
entity.

## Deliberately KEPT

- `getCompanyNoActivityDays` + `CompanyNoActivityDay` + `monthsTouchedByRange` (Deductions connector).
- `derivePrivateCalendarExceptions`'s `no_activity_recorded` exception — the private calendar's own
  honest display of an uncovered workday, not the retired module.
- The FWC `no_activity` deduction type and its 84 prod candidates — a **different** module.
- **DB untouched**: `private_calendar_no_activity_clarifications` (92 rows incl. the false flags for
  2026-07-22) and all `deduction_candidates`. Dropping data needs separate owner approval.

## Traps this cost

- A python block-cut from "comment X" to "function Y" swallowed the **adjacent**
  `buildSampleDvPlannerDigestTable` — caught only by typecheck. Verify what sits between your two
  markers before cutting a range.
- After restoring `getCompanyNoActivityDays`, the shared-helper call count went back to 2, so the
  guard test asserting 1 failed. The count is legitimately 2 (workspace + company engine).

Validation: typecheck, lint, **513 test files**, build all clean. Not committed at time of writing.
