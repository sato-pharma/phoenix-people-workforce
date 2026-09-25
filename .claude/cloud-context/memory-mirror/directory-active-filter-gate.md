---
name: directory-active-filter-gate
description: "The canonical active/terminal employee filter is isActiveDirectoryEmployee, defined at src/lib/employees/employee-directory.ts:404 and applied as the default gate at :1580 - modules bypassing the directory miss it. Line numbers re-verified 2026-09-04 (the old :1437 pointer was stale). A SECOND, WEAKER copy exists at src/lib/employee-portal/service.ts:2535 that checks only employmentStatus."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 3c6c9b6e-ddda-45a2-b4a9-d36fe935379b
---

`getEmployeeDirectoryRows()` and `getEmployeeDirectory()` BOTH filter to active
employees by default via `.filter(e => options.includeInactive || isActiveDirectoryEmployee(e))`
(defined at src/lib/employees/employee-directory.ts:404; the default gate is applied at :1580 - line
numbers re-verified 2026-09-04, the old :1437 pointer was stale). `isActiveDirectoryEmployee` requires
employment_status in active/on_leave + organogram_visible + headcount-eligible.

So any module that sources employees from the directory ALREADY excludes
resigned/terminal employees — claims that "resigned employees leak into
report X" are usually FALSE for directory-backed modules.

**Updated 2026-07-18** after a full 7-agent re-audit ([[resignation-employee-leak-audit-2026-07-18]]):
most of the 2026-05-29 bypass list below is now STALE/RESOLVED — don't cite it as current
without re-checking:
- ~~Payroll: queries salary_records/salary_batches directly (no lifecycle join)~~ — RESOLVED
  for the read/dashboard/export path (`buildPayrollIneligibleHrIdSet` off the directory,
  tested). Residual gap is narrower: batch *creation* via manual spreadsheet upload only
  soft-warns, see the 2026-07-18 audit memory.
- ~~Auth/session: app_auth_users.is_active only~~ — RESOLVED, and was already stale when
  this file was written: the login gate closing this exact gap shipped 2026-06-20 (PR #359,
  see [[auth-terminated-login-block]]). This 2026-05-29 bullet predated that fix.
- ~~Outstation/expenses approval + admin-create: act on hr_id without re-checking active~~ —
  RESOLVED. Admin-create and self-submit both resolve via the active-only directory and
  reject unknown/inactive HR_IDs.
- ~~Marketing (beta): own findRequester / hierarchy traversal~~ — RESOLVED (now correctly
  active-only). The real remaining marketing gap is narrower and different:
  `resolveStoredHrId` (src/lib/hr-id.ts) falls back to returning the raw HR_ID instead of
  null when unfound, which defeats the `direct_manager` approval-scope step's "must be
  current employee" check — confirmed dormant in production as of 2026-07-18, see the audit
  memory for details.

**Still open/confirmed true:** the inverse leak — contract NON-RENEWAL never sets
employment_status (WP-6 kill switch `WP6_CONTRACT_NON_RENEWAL_TERMINAL_ENABLED` is off by
design pending a migration + staging smoke test) — so that employee stays "active" and
passes this gate everywhere, including notifications. This is now the single highest-impact
open item; see [[resignation-employee-leak-audit-2026-07-18]] for the full current picture
and several other narrower gaps found in that sweep.

Original bypass list verified 2026-05-29 during the pre-push audit; superseded as above.
