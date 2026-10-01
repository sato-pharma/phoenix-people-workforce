---
name: directory-active-filter-gate
description: "The canonical active/terminal employee filter is isActiveDirectoryEmployee in src/lib/employees/employee-directory.ts, applied as the default gate at the end of getEmployeeDirectoryRows - a module that bypasses the directory misses it. Cite both by NAME: the definition and the gate were line-pinned on 2026-09-04 and BOTH numbers had rotted by 2026-10-01. A SECOND, WEAKER copy exists in src/lib/employee-portal/service.ts that checks only employmentStatus."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 3c6c9b6e-ddda-45a2-b4a9-d36fe935379b
---

`getEmployeeDirectoryRows()` and `getEmployeeDirectory()` BOTH filter to active
employees by default via `.filter(e => options.includeInactive || isActiveDirectoryEmployee(e))`
(defined in `src/lib/employees/employee-directory.ts`; the default gate is the
`includeInactive || isActiveDirectoryEmployee(employee)` call at the end of `getEmployeeDirectoryRows`).
🔴 **Cite both by NAME, never by line. This memory re-verified its two line numbers on 2026-09-04
and BOTH had rotted by 2026-10-01** - the definition 404 → 528, the gate 1580 → 1804, in a file that
grew to 2,759 lines - and the 2026-09-04 pass had itself replaced an earlier stale `:1437`. That is
three numbers, three rots, and one symbol name that never moved once.
`isActiveDirectoryEmployee` requires employment_status in active/on_leave + organogram_visible +
headcount-eligible.

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
