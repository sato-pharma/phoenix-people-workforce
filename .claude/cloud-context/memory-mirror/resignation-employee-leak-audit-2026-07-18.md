---
name: resignation-employee-leak-audit-2026-07-18
description: "Full-codebase sweep for resigned/terminated employees leaking as active — FULLY CLOSED 2026-07-18, all items shipped. Kept for the reusable patterns it established: the canonical active-status model (session-lifecycle.ts, never a hand-rolled denylist), the seat-continuity resolver vs the buildManagerMap regression trap, the resolveStoredHrId approver-deadlock, WP-6 now flipped terminal, the probation dual-table mirror, and the confirmed-clean list (spot-check, don't re-audit)."
metadata: 
  node_type: memory
  type: project
  originSessionId: c3945a37-3327-478c-b27f-8237f412463d
  modified: 2026-09-26T11:17:53.628Z
---

A deep audit (7 parallel agents across every domain) for resigned/terminated employees leaking as active in
functional modules — **FULLY CLOSED 2026-07-18, every item shipped and merged.** Do NOT re-run the sweep from
scratch; spot-check instead. What survives is the reusable patterns the fixes established.

## The durable patterns (apply these going forward)

- **The canonical active-employment model is `session-lifecycle.ts`** (`ACTIVE_EMPLOYMENT_STATUSES_IN_LIST`,
  `isTerminalEmploymentStatus`). Hand-rolled status checks and denylists drift — they miss `not_renewed` and
  silently drop NULL-status rows. Use the canonical helper as a null-safe positive ALLOW-list, never an ad-hoc
  denylist. Authority = `is_active` + `employment_status`, not `banned_until`.
- **The seat-continuity resolver (`hierarchy-resolver.ts` — `reportsToManagerSeat` /
  `isWithinManagerHierarchy`) is the canonical way to resolve manager scope** ([[seat-continuity-resolver]]).
  A hand-rolled `buildManagerMap` BFS over raw `manager_hr_id` is a **regression trap** — it matches the
  resolver TODAY only because the DB trigger writes the upward reassignment and the vacancy marker atomically,
  so it silently diverges the moment a seat goes vacant. (Sales/payroll TEAM/HIERARCHY scope and
  approvals-hub/outstation were migrated onto the resolver; keep the collect-helpers private-per-module —
  don't import outstation into sales/payroll.)
- 🔴 **`resolveStoredHrId` (`hr-id.ts`) returns the raw uppercased HR_ID, NOT null, when the id isn't in the
  active-only directory** (`(stored ? … : null) ?? canonicalHrIdForDisplay(value)` falls through exactly when
  the person resigned). So a resigned manager silently becomes an approver — and since resigned employees
  can't log in ([[auth-terminated-login-block]]), the request **deadlocks forever with no error**. Gate any
  APPROVER resolution on active-employee (`isActiveEmployeeHrId`); `hr-id.ts` itself is left untouched because
  display-only callers need the fallback — the fix belongs at the authority call site.
- 🔴 **`WP6_CONTRACT_NON_RENEWAL_TERMINAL_ENABLED` is now flipped TRUE** (was a deliberate kill switch): a
  contract resolving `not_renew` now flips `employment_status` terminal via
  `maybeRunNonRenewalTerminalLifecycle`. Before the flip, a non-renewed employee read as fully active to every
  downstream consumer (birthday notices, next-cycle renewal reminders). **De-risking fact: WP-6 adds ZERO new
  DB mechanism** — every resignation in the system runs through `resignEmployeeWithFallback`, and
  `phx_resign_employee_and_open_vacancy` does not exist in either environment; the WP-6 migration is folded
  into the 2026-07-11 baseline (the archived file's "DRAFT — DO NOT APPLY" header was stale).
- **Probation runs two systems in parallel** — the legacy Probation Tracker workflow flips
  `employment_status` and calls the resign cascade but must ALSO mirror into `probation_cases` (idempotent,
  `side_effects_applied_at`), or the CEO Probation Dashboard (filters `status='active'`) shows a departed
  employee as a live red/amber case forever. Both tables are provisioned for every current hire.
- **CRM's resigned-agent exclusion is now a live `employment_status` join** (was a static hand-maintained
  `CRM_RESIGNED_AGENT_CRM_IDS` array that needed a manual update+deploy) — [[crm-live-departed-agent-exclusion]].
- **Stuck-approver reassignment:** HR/Super-Admin can reassign a stuck weekly-plan/excuse approver via
  `/admin/approvals/stuck` — reassignment-only, never deciding-in-place ([[project-leave-excuse-approver-model]]).
  Note `assertManagerReviewer`'s "reject a resigned manager" branch is DEAD code — `getEmployeeDirectory()` is
  active-only, so a resigned manager is never found and the guard never fires (harmless only because the
  session gate rejects a resigned manager's request first).
- **Inverse leaks (over-restriction) exist too:** coaching `getCoachingReportById`/`getCoachingReportsByIds`
  once THREW for any historical report touching a since-resigned rep, even for Super Admin/CEO — a resolved-history
  read must tolerate an inactive subject.

## Confirmed clean (spot-check, don't re-audit from scratch)

Payroll roster generation (template + Copilot), outstation/expense creation, all sales/CRM rep-attribution
reads (CI-guarded — [[crm-single-source-door-guardrail]]), vacation/excuse eligibility + SLA escalation,
contracts dashboard/creation, the resignation cascade itself (`resignEmployeeWithFallback`), offers
approval-chain, organogram + the seat-continuity trigger/resolver (wired into far more consumers than older
memories reflected — vacation, coaching, employee-portal, team-calendar, weekly-planning calendar, sales SoS
dashboard, organogram-view-model), double-visit analytics + the DV Planner, employee portal nav/layout,
CEO/SFE command centers, the notification-recipient governance engine (`notifications/policy.ts`), probation
reminders, action-center.

Sibling sweeps this complements: [[directory-active-filter-gate]] (the inverse-leak / over-restriction
pattern) and [[resignation-contract-scope-check-audit-2026-07]].
