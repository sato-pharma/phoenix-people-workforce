---
name: employee-portal-mobile-audit
description: "Employee-portal responsive-table pattern + audit false-positive traps (nowrap, calendar UTC, month-year locale)"
metadata: 
  node_type: memory
  type: project
  originSessionId: adf41b43-8ce4-4d4b-a1fd-c084a1f4068a
---

Full employee-portal audit + first fix pass shipped 2026-07-05 (commit `f939c5f1` on `codex/agents-policy-v2`; NOT yet pushed/PR'd).

**Design direction (owner-chosen 2026-07-05):** portal standardizes on the **portal-primitive** look — `rounded` (small radius) + `border-slate-*` + orange accent + portal shadow (from portal-primitives.tsx), NOT soft-card (`rounded-lg`+gray) and NOT full-square. Alignment sweep landed in PR #856 (commits `ef98e5bf` + `c7000b39`): mechanical `rounded-lg/md`→`rounded`, `-gray-`→`-slate-` across all live drifters (probation/organogram/nsm-team-expenses/med-rep dashboards, calendars, team-expenses-filters, bottom-nav-customizer, skeletons). NOTE: `employee-portal-dashboard.tsx` is NOT legacy — its `MedicalRepPayrollPage`/`EmployeePortalIncentivePage`/`ContactHRSupportPage`/`MedicalRepOverviewPage` exports are lazy-loaded (via employee-portal-dashboard-dynamic.tsx) onto the payslips/incentive/contact-HR/overview pages.

**Responsive table pattern (the target):** `src/components/employee-portal/portal-primitives.tsx` provides `PortalDesktopTable` (`<table>` inside `hidden overflow-x-auto md:block` = tables are DESKTOP-ONLY), `PortalResponsiveDataList` (mobile cards + desktop table), `PortalRecordCard`/`PortalRecordFields`. The shell wraps content in `overflow-x-hidden`. Rule the owner wants: **no horizontal scroll on mobile; big tables desktop-only; premium card fallback below `md`.** Fixed this pass: payroll-payslips-section, attendance-overview, fingerprint-analytics, marketing-request-decision-confirmation, sales/weekly portal-weekly-dashboard completeness matrix (each got `md:hidden` card list + table hidden below md).

**Audit false-positive traps (the 20-agent Haiku audit over-flagged these — verify before acting):**
- **Do NOT convert `whitespace-nowrap` → `break-words`** — that violates the owner's [[no-text-truncation-or-wrapping]] rule. Fix genuine overflow with layout (min-w-0, stacking), not wrapping.
- **Calendars deliberately use `timeZone: "UTC"`** for date-only values (company-calendar, planning-calendar, private-calendar, plans-workspace) — switching to Africa/Cairo causes off-by-one day-shifts. Do NOT "fix" these.
- **Month-year formatters** built from `new Date(y, m-1)` are timezone-independent — locale swaps (en-US→en-EG) are no-ops.
- Coaching date-only formatters (shared `src/components/coaching/*`) parsed local-midnight but formatted UTC → off-by-one (Cairo browsers showed prior day). FIXED (commit `e93ded6d`, in PR #856): all 5 route through shared `formatDateOnly` (parse+format same local zone); regression test `tests/coaching-date-formatting.test.ts` wired in. The canonical date-only pattern = `formatDateOnly`/`formatDateValue` (parse local + format local, NO timeZone option). See [[feedback-report-times-in-cairo]].
- `marketing-validation-workspace` tables and `org-chart` scroll were flagged but are already correct (gated / contained internal scroll).

**Still real / deferred:** encodeURIComponent + hrIdsMatch + skeleton dynamic-grid + Fragment-key bugs were FIXED. Full "god-mode polish of every one of ~48 components" is an ongoing batched effort needing visual iteration (local dev-auth synthetic users get redirected off data-gated pages like /attendance, so browser verify only reliably reached the landing at 375px). Locked/untouchable: [[incentive-policy-lock]], identity-card.tsx, nsm-command-center DoubleVisitFocusSection ([[feedback-dv-focus-section-locked]]).
