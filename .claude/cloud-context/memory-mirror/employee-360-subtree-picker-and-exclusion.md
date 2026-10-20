---
name: employee-360-subtree-picker-and-exclusion
description: "Employee 360 rules — every role sees self + full reporting subtree via a picker; canViewEmployee360Subject is THE single gate; the PD-0001 exclusion (PR #1477, 2026-07-30) was REVERSED by the owner on 2026-10-20 — the Regional Sales Manager is back with a tailored report"
metadata: 
  node_type: memory
  type: project
  originSessionId: 0c89c9a5-f1c8-425b-89b2-be9cac82f4a2
  modified: 2026-07-30T02:28:13.103Z
---

🔴 **REVERSED 2026-10-20 (owner: "bring him back but do not show empty data, tailor the report on him")** — `EMPLOYEE_360_EXCLUDED_HR_IDS` is now empty and the Regional Sales Manager is an Employee 360 subject again; his report draws only the sections that hold data (`planEmployee360Sections`). The exclusion described below is history.

Owner rules for Employee 360, implemented 2026-07-30 in PR #1477 (branch
`codex/rm-region-command-center`, worktree `_wt-rm-region`).

**Rule 1 — every role sees THEMSELVES + everyone in their reporting subtree.** Example the owner
gave: RM Hany Saad (PD-0001) must reach his 3 DSMs AND the ~14 Medical Reps under those DSMs.

**The bug was NOT a permission gap.** `canViewEmployee360Subject`
(`src/lib/employee-360/access.ts`) was already subtree-correct for Regional Manager
(`isWithinManagerHierarchy`). The gap was a **missing UI path**: the portal index only rendered a
browsable list when `(!target || !roleCategory) && isCompany360Viewer(access)` — true only for
Talent Acquisition / company roles — so a field manager fell through to a self-only report with no
picker. Fix = `buildEmployee360Picker()` in `app/employee-portals/employee-360/page.tsx`, scoped by
`resolveEmployee360VisibleRows` (never a parallel rule), rendered as "Select Employee".

**`EmployeeSearchList` groups into per-role-family TABS** and defaults to `tabs[0]`, which is
`medical-rep` (first in `EMPLOYEE_360_ROLE_ORDER`). So a manager's own family looked "missing" —
they were on another tab. Added an optional `defaultTab` prop; the portal passes the viewer's own
`roleCategory`. **When debugging "X doesn't appear in the E360 list", check the active TAB before
suspecting scope** — only `e.category === activeTab` rows render, and filter options come from
`inTab`, so a person genuinely cannot leak into another family's tab.

**DSM branch switched** from `reportsToManagerSeat` (one level) to `isWithinManagerHierarchy`, so
"self + reports" holds at any depth. No-op on today's org (a DSM's reports are all leaf reps).

**Rule 2 — per-person exclusion. PD-0001 (Hany Saad) is removed from Employee 360 for EVERYONE,
including himself and the company-wide roles.** Owner-requested, and it reversed an earlier
same-session instruction to make self a selectable option — so the self-as-option code stays for
other roles while PD-0001 is excluded.

Implementation: `EMPLOYEE_360_EXCLUDED_HR_IDS` + `isEmployee360ExcludedSubject`, consulted at the
**very top** of `canViewEmployee360Subject` — ABOVE the `scope==="system" || COMPANY_360_ROLES`
short-circuit and ABOVE the `hrIdsMatch(self)` check, or either would re-admit them. Keyed by
`canonicalHrIdKey` (so "PD-0001"/"PD0001" both match), same shape as
`TALENT_ACQUISITION_SALARY_REDACTED_HR_IDS` in `src/lib/auth/permissions.ts`.

**Why one guard is enough:** `canViewEmployee360Subject` is the SINGLE gate behind all five
surfaces — admin index, admin `[hrId]`, portal index self-report, portal `[hrId]`, and
`resolveEmployee360VisibleRows`. There are **no E360 API routes** (all server components), and E360
does NOT use `canSeeEmployee`/`filterEmployeesForAccess` (the one-level `isDirectReport` helper) —
the comment in `system-navigation.ts` claiming it does is stale.

A viewer whose own record is excluded gets their **team picker** instead of a redirect out of the
module. Ordering is locked by assertions in `tests/employee-360-portal-browse.test.ts`.

Related: [[rm-dsm-portal-provisioning-gaps]], [[employee-360-godmode]], [[weekly-plan-four-gates-rm-dsm]]
