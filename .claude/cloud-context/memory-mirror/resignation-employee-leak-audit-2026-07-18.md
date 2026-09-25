---
name: resignation-employee-leak-audit-2026-07-18
description: "Full-codebase sweep (7 parallel agents) for resigned/terminated employees leaking as active; ALL items now shipped+merged to main 2026-07-18: 6 original fix PRs, sales/payroll resolver follow-up (#1151), CRM live-exclusion follow-up (#1153), and WP-6 flag flip (#1157) — audit fully closed"
metadata: 
  node_type: memory
  type: project
  originSessionId: c3945a37-3327-478c-b27f-8237f412463d
---

Owner asked for a "deep audit of all system modules confirming no resignation employee
appearing in functional modules." Ran 7 parallel general-purpose agents across every
domain in the architecture doc (payroll/expenses/outstation, sales/CRM/SoS,
vacation/excuse/probation/contracts/offers, coaching/attendance/double-visit/weekly-plan,
organogram/workforce, notifications/cron/workflow-registry/action-center, employee
portal/analytics/marketing-requests), then personally re-verified the top 3 findings by
direct code read.

**DELIVERED + MERGED 2026-07-18 (6 independent PRs off main, each `pnpm run check:harden`-green,
each built in its own isolated worktree; owner approved merge same day — each triggers the
prod auto-deploy pipeline). Merge order #1143→#1144→#1145→#1146→#1147→#1149; #1149 hit a real
conflict in `approvals-hub/service.ts` against the just-merged #1145 (both added imports/functions
there — #1145's `reportsToManagerSeat`/`computeApprovalScopePeople` vs #1149's drift-check listers
+ `getStuckApprovalsForReassignment`), resolved by keeping both sides' functions, re-validated
green post-merge, then merged. The 6 worktrees are still on disk awaiting the owner's
delete-on-merge "CLEAN?" ritual.**
- #1143 `codex/fix-marketing-resigned-approver` — marketing `resolveStoredHrId` dormant bug: added
  `isActiveEmployeeHrId` gate in `marketing-requests/service.ts` (left `hr-id.ts` untouched — other
  display-only callers need the fallback).
- #1144 `codex/status-correctness-hygiene` — converged 7 hand-rolled status checks onto canonical
  `session-lifecycle.ts` (new `ACTIVE_EMPLOYMENT_STATUSES_IN_LIST`): birthday eligibility, 5 denylist
  filters → null-safe positive allow-list (also fixed latent NULL-status drop + missing `not_renewed`),
  roster.ts dup Set, coaching `includeInactive:true`, outstation lookup `isActive`, sales fallback query.
- #1145 `codex/hierarchy-resolver-adoption` — approvals-hub + outstation/expenses now use the
  seat-continuity resolver (retired hand-rolled `buildManagerMap`). No behavior change today.
- #1146 `codex/probation-dashboard-desync` — legacy probation decisions now mirror into
  `probation_cases` (idempotent + `side_effects_applied_at`) + shared `filterResolvedProbationCases`
  cross-check in dashboard & milestone-email sweep (self-heals existing desync; locked test line intact).
- #1147 `codex/payroll-resignation-banner` — additive resignation-candidate banner on the payroll batch
  dashboard (service-role query; `salary_flags` stripping + its locked test untouched).
- #1149 `codex/stuck-approval-reassignment` — HR/Super-Admin reassign capability for stuck
  weekly-plan/excuse approvers + vacation pending_manager gap + drift-check row-listings + Approvals Hub
  `/admin/approvals/stuck` panel. Reassignment-only, never deciding-in-place (honors [[project-leave-excuse-approver-model]]).

**Deferred — needs its own explicit approval (NOT shipped): Group 6, the WP-6 flag flip.** Group 0
read-only dry-run against prod (`ozucdzovmcqvepbozvqf`) found `contract_renewal_requests` has ZERO rows
and no `employee_resignations` row ever used the WP-6 path — the feature has never been used in prod, so
flipping `WP6_CONTRACT_NON_RENEWAL_TERMINAL_ENABLED` is purely forward-looking with no historical
backlog to correct. The migration is already live in the prod baseline and the app path doesn't call the
SQL RPC (pure TS boolean → `resignEmployeeAndOpenVacancy`, same as every other termination). Owner chose
"dry-run first, then decide" — decision still pending.

Original read-only findings below (unchanged; the fixes above address them):

**Root cause with the widest blast radius (owner decision needed):**
`WP6_CONTRACT_NON_RENEWAL_TERMINAL_ENABLED = false` in `src/lib/contracts/feature-flags.ts:7`
is a deliberate, documented kill switch (not an oversight — comment says only flip after
the WP-6 migration `20260531120000_contract_non_renewal_terminal_lifecycle.sql` is applied
and staging smoke is green). While off, `maybeRunNonRenewalTerminalLifecycle` in
`src/lib/contracts/service.ts` is a strict no-op when a contract renewal resolves as
`not_renew`: `employees.employment_status` is never flipped to terminal. That employee then
reads as fully active to EVERY downstream consumer gated on `employment_status` —
confirmed live consequences: birthday notifications (`app/api/notifications/birthdays/route.ts:59-62`,
which also has its own bug — ad hoc filter excludes `on_leave`, doesn't use the canonical
`isTerminalEmploymentStatus`) and next-cycle contract-renewal reminders re-firing a year
later. This is the same "inverse leak" [[directory-active-filter-gate]] flagged 14 days ago
under 2026-05-29-dated evidence — still open today, confirmed by direct read, not just
memory. **How to apply:** don't silently flip this flag — it's marked owner/staging-gated
for a reason; surface it explicitly next time contract non-renewal or notification-leak
work comes up.

**Confirmed dormant bug, production-verified (not yet live but one config change away):**
`resolveStoredHrId` in `src/lib/hr-id.ts:53-62` returns the raw uppercased HR_ID instead of
`null` when the ID isn't in the (active-only) directory map — `(stored ? String(stored) :
null) ?? canonicalHrIdForDisplay(value)` falls through on the `??` exactly when the person
is resigned. `src/lib/marketing-requests/service.ts`'s `direct_manager` approval-scope path
(any workflow step, not just the built-in one — configurable live in Marketing Control,
`marketing-control-workspace.tsx`) uses this to resolve the gating approver from
`managerHrId` with no active-employee check. If a customer/request's stored manager has
since resigned, they'd be silently inserted as the approver — and since resigned employees
can't log in ([[auth-terminated-login-block]]), the request would deadlock forever with no
error to anyone. Verified read-only against prod (`ozucdzovmcqvepbozvqf`): the one
`direct_manager`/`role`-kind workflow step with this exact shape is currently `active=false`,
and no live `manager_hr_id` reference is currently resigned — so **dormant, not firing
today**. Also supersedes the 14-day-old memory claim that marketing has "its own
findRequester/hierarchy traversal" bypassing the directory — that part is now fixed/correct;
this narrower `resolveStoredHrId` fallback is the real remaining gap.

**Other confirmed gaps (narrower, ranked roughly by severity), none fixed yet:**
- Probation dual-system desync: the still-live legacy Probation Tracker workflow
  (`src/lib/probation/service.ts:1157-1195`) correctly flips `employment_status` and calls
  `resignEmployeeAndOpenVacancy`, but never writes to the newer `probation_cases` table, so
  the CEO Probation Decision Dashboard (`src/lib/probation/intelligence/dashboard.ts:93-100`,
  filters only `.eq("status","active")`) keeps showing an already-departed employee as a
  live red/amber probation case indefinitely. Both tables are provisioned in parallel for
  every current hire, so this is live-relevant, not legacy-only.
- Payroll batch upload/replace (`src/lib/payroll/salary-import.ts:662-685`,
  `app/api/payroll/upload/route.ts`, `.../[id]/replace/route.ts`) treats an HR_ID missing
  from the active directory as a soft warning only, and strips that specific warning code
  before persisting the batch's governance trail — reachable only via manual/off-template
  spreadsheet edits (the real roster-generation paths — template + Copilot — are correctly
  hard-gated).
- Sales-import employee linker (`src/lib/sales/employees.ts`) falls back to a raw,
  completely unfiltered `employees` query (cached 5 min) if the primary active-only
  directory fetch throws, and can attribute a new sales row to a resigned employee with only
  a non-blocking warning string; its local `isInactiveEmploymentStatus()` denylist also
  disagrees with the canonical model and misses `not_renewed` entirely.
- Attendance hand-rolled filters (`src/lib/attendance/device-user-mapping.ts:119`,
  `policies.ts:199`) omit `not_renewed` from their exclusion list, unlike the canonical
  helper — lets a non-renewed employee still appear in device-mapping/policy pickers.
  `fingerprint-report.ts:381-398`'s base employee query has no status filter at all
  (gated only on device-mapping/job-title).
- CRM's resigned-agent exclusion (`CRM_RESIGNED_AGENT_CRM_IDS` in `src/lib/crm/reads.ts:51-60`)
  is a static hand-maintained array, not a live `employment_status` join — fails safe
  (over-hides) but depends on a manual update+deploy to stay current.
- `src/lib/approvals-hub/service.ts:825-830` ("Who I Approve") and
  `src/lib/outstation/expenses.ts:212-244` (hierarchy-scoped expense visibility) bypass the
  canonical [[seat-continuity-resolver]] with their own naive `manager_hr_id` joins —
  currently produce identical results only because the DB trigger writes the upward
  reassignment and the vacancy marker atomically; a regression trap, not a live defect.
- Inverse-direction bugs (over-restriction, opposite of the audited pattern, flagged as
  found): Coaching report view/export throws for any historical report touching a
  since-resigned rep (`src/lib/coaching/service.ts` `getCoachingReportById`/`~692`,
  `getCoachingReportsByIds`/`~737`), including for Super Admin/CEO. Weekly-plan
  (`src/lib/weekly-planning/service.ts:720-735` `assertManagerReviewer`) and Excuse
  decisions have no re-route/escalation when the assigned manager resigns mid-flight — the
  record just gets stuck forever (weekly-plan has an existing daily drift-check cron, D4,
  that only counts these with no auto-fix). `assertManagerReviewer`'s own "reject a resigned
  manager" branch is dead code (`getEmployeeDirectory()` is active-only, so a resigned
  manager is never found, so `managerEmployee && !isActiveEmployee(...)` never fires) —
  harmless today only because the session gate should already reject a resigned manager's
  request before it gets here.

**Confirmed clean / solid** (don't re-audit from scratch next time, spot-check instead):
payroll roster generation (template + Copilot), outstation/expense creation (self-submit +
admin-create), all sales/CRM rep-attribution reads (`crm/reads.ts`, `crm/master.ts`,
`crm-integrity/*` — enforced by a CI guardrail test, [[crm-single-source-door-guardrail]]),
vacation/excuse eligibility+creation+SLA-escalation, contracts dashboard/creation, the
resignation cascade itself (`resignEmployeeAndOpenVacancy`), offers approval-chain Super
Admin override, organogram/org-chart rendering + the seat-continuity trigger/resolver (now
verified wired into far more consumers than the 50-day-old memory reflected — vacation,
coaching, employee-portal, team-calendar, weekly-planning calendar, sales portal SoS
dashboard, organogram-view-model), double-visit analytics + the new DV Planner workspace,
employee portal nav/layout, CEO/SFE command centers, the central notification-recipient
governance engine (`src/lib/notifications/policy.ts`), probation reminders (new module),
Telegram/holiday-confirmation notifications, action-center.

**How to apply:** all findings except WP-6 are now fixed and LIVE on main (2026-07-18).
Remaining open items: (1) the WP-6 flag decision (deferred — prod has 0 contract-renewal
rows so no backlog, but flipping still changes employee-lifecycle behavior and needs owner
sign-off); (2) two follow-ups spun off as background-task chips same day — sales/payroll
still carry the same naive-manager-BFS regression-trap pattern Group 2 fixed for
approvals-hub/outstation (chip task_d1fc5499), and CRM's static `CRM_RESIGNED_AGENT_CRM_IDS`
list could become a live join via crm/identity.ts but needs a coverage-verification query
first to avoid under-hiding (chip task_8e538e3f) — both running in separate local sessions,
started by owner.

**UPDATE 2026-07-18 (WP-6 flag flip DONE): PR [#1157](https://github.com/Phoenix-HR/phoenix-people-workforce/pull/1157)**
`codex/wp6-contract-non-renewal-terminal` — flipped `WP6_CONTRACT_NON_RENEWAL_TERMINAL_ENABLED` false→true.
Verified live (not just re-stated the memory claim): direct schema inspection on staging
(`cifwmndunmlxjhyjugxa`) AND production confirmed the WP-6 column/index/RPC are genuinely live
(folded into the 2026-07-11 baseline reset — the archived migration file's "DRAFT — DO NOT APPLY
YET" header was stale/never updated after that fold; corrected in this PR). Zero backlog re-confirmed
on both envs. Ran a REAL staging-only disposable-fixture smoke test (`PHASE99_WP6TERM`, cleaned up
after, zero rows left) proving the exact WP-6 reason/notes shape writes correctly end-to-end
(terminate + vacancy + organogram/payroll exclusion). Key de-risking finding:
`phx_resign_employee_and_open_vacancy` doesn't exist in EITHER environment — every resignation in
the whole system already runs through the documented `resignEmployeeWithFallback` path, so WP-6 adds
zero new DB mechanism, just a new call site. Updated the 2 CI guard tests that previously
hard-blocked this exact flip (`flag must be false` / `migration header must say DRAFT`) plus added
string-shape lock-in assertions. `check:harden` green.
**MERGED to main 2026-07-18 (merge commit 12b6ba49, owner-reviewed + merge-approved same session →
prod auto-deploy triggered)**, built in isolated worktree `.claude/worktrees/wp6-contract-non-renewal`
(CLEANED same session). This was the highest-risk item in the whole audit — a live employee-termination
path is now enabled going forward.

**FINAL CLOSURE 2026-07-18:** the CRM chip (task_8e538e3f, "make CRM_RESIGNED_AGENT_CRM_IDS a live
join") turned out to already be resolved — PR #1153 (merged same day, see
[[crm-live-departed-agent-exclusion]]) did exactly this work independently. Re-confirmed on pickup,
no new work needed. **Every item from this audit — original 6 fixes, both follow-up chips, and the
WP-6 flag flip — is now shipped and merged to main. Audit fully closed.**

**UPDATE 2026-07-18 (follow-up #1 DONE): PR [#1151](https://github.com/Phoenix-HR/phoenix-people-workforce/pull/1151)**
`codex/sales-payroll-hierarchy-resolver` — migrated `src/lib/sales/service.ts` and
`src/lib/payroll/service.ts` TEAM/HIERARCHY scope off their private naive `buildManagerMap`
BFS onto the canonical resolver (`reportsToManagerSeat` / `isWithinManagerHierarchy`),
mirroring #1145 exactly (local `collectDirectReports`/`collectHierarchy`/`buildCanonicalHrIdIndex`
per file — kept private-per-module, NOT importing outstation into sales/payroll). LINE scope +
`includeManagerOwnedHrId` + `normalizePayrollAllowedIds` semantics preserved verbatim — no-op for
today's data, correct-on-vacancy. New `tests/sales-payroll-hierarchy-scope.test.ts` (behavioral
vacant-seat fixtures over both exported wrappers + source-text wiring guards). `check:harden` green,
**MERGED to main 2026-07-18 (merge commit d45c3014, owner-approved → prod auto-deploy triggered)**,
built in isolated worktree `.claude/worktrees/sales-payroll-hierarchy` (awaits delete-on-merge CLEAN).
NOTE: by the time this ran, #1145 had already MERGED to main (correcting the earlier "6 worktrees
awaiting CLEAN" note — #1143–#1147,#1149 are on origin/main; base for #1151 was aee65c9f).

**UPDATE (follow-up #2 DONE): PR #1153 also MERGED to main 2026-07-18** (right after #1151) —
see [[crm-live-departed-agent-exclusion]] for full detail (static∪live CRM exclusion, 18 newly-hidden
departed reps, 1 corrected mis-exclusion). Both follow-ups are now closed — the ONLY open item
left from this entire audit is the WP-6 flag decision (Group 6, still owner-gated). Delivery ran
as 8 sequential isolated worktrees total, one `next build` at a time (16GB machine — never run two
concurrently). See [[directory-active-filter-gate]] and [[resignation-contract-scope-check-audit-2026-07]]
for sibling sweeps this complements.
