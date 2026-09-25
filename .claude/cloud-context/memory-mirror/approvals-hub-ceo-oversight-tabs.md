---
name: approvals-hub-ceo-oversight-tabs
description: "CEO/Super-Admin oversight tabs (Who I Approve + Company Requests) on Vacation & Excuse Approval hubs — PR #1091 MERGED + LIVE 2026-07-17."
metadata: 
  node_type: memory
  type: project
  originSessionId: e8302aa8-ab9d-4762-9506-eb3035d15b60
---

Built 2026-07-17 on branch `codex/approvals-hub-ceo-tabs` in worktree
`F:/Phoenix Workforce/_wt-approvals-ceo-tabs` (off origin/main ce51bc64). **PR #1091 MERGED** to main
2026-07-17 (merge commit df31bba2); CI green (lint-typecheck/validate/preview-smoke). Cloud Run
deploy 29564443796 SUCCESS (build→no-traffic→smoke→promote 100%); prod https://phoenix-hr.satopharma.com
HTTP 200 — LIVE. Per-hub confirmed (vacation hub→vacation, excuse hub→excuse; NOT combined).
Post-merge cleanup DONE: worktree `_wt-approvals-ceo-tabs` removed + branch codex/approvals-hub-ceo-tabs
deleted (local + remote already auto-deleted on merge). Feature code lives in origin/main.

FOLLOW-UP 2026-07-17 (owner correction): "Who I Approve" must show DIRECT reports ONLY — the people
the CEO personally approves — NOT the downstream manager-of-manager (2nd-level) chain (a DSM is
approved by their own NSM, not surfaced under the CEO). Applies identically to leave + excuse. PR
**#1095** (branch codex/approval-scope-direct-only): buildApprovalScope dropped the 2nd-level branch /
includeSecondLevel param / ApprovalScopePerson.relation; scope list dropped Direct/2nd-level badge.
Verified prod (CEO AA): vacation 36→10, excuse 10, identical direct-report set, no DM/MedRep. Company
Requests tab unchanged. PR #1095 MERGED+LIVE 2026-07-17 (merge 8822bdd4; deploy success; prod HTTP 200).

Two new tabs on the Vacation + Excuse Approval hubs (`/employee-portals/approvals/{vacation,excuse}`
+ their `/admin/approvals/...` mirrors — the shared `ApprovalsWorkspace` shell), gated to CEO +
Super Admin via `canSeeCeoApprovalTabs` (`role === "CEO" || isAllVacationVisibility`) in
`src/lib/approvals-hub/service.ts`:
- **"Who I Approve"** — live org-scope from `getEmployeeDirectory`: **DIRECT reports only**, identical
  for vacation + excuse (owner corrected away from the original 2nd-level/manager-of-manager idea — see
  follow-up above). NO static role→role approver map exists anywhere; authority is org-position driven,
  so it's computed. CEO AA verified against prod: 10 direct reports for both.
- **"Company Requests"** — every request (pending AND decided) company-wide, excluding submitters
  whose `resolveJobFunctionRole(jobTitle)` is District Manager or Medical Rep. Vacation reuses
  `getVacationReportData` (CEO already has COMPANY leave scope → no new leave exposure); excuse reads
  `v2_excuse_requests` via admin client — a NEW company-wide excuse read for the CEO, owner-approved.
  CEO AA verified: vacation 24 rows, excuse 6, zero field-force leakage.

New components `src/components/approvals-hub/{approval-scope-list,company-requests-list}.tsx`. Full
harden gate green (typecheck/lint/test 388/build). Visual render NOT screenshotted — in-app Browser
can't reach the local worktree dev server here; verified instead by executing the service functions
against prod data via the test alias-loader. See [[project-leave-excuse-approver-model]].

**Extended to Plans 2026-07-18 (PR #1120):** added the same "Company Requests"-shaped tab to the
Weekly/Monthly Plan Approvals hub (`getCompanyPlanRequests` in the same service.ts, same
`canSeeCeoApprovalTabs` gate), labeled **"Company Plans"** — unlike vacation/excuse, this one
deliberately does NOT exclude the field force (District Manager plans belong in it once DSMs can
submit; see [[dsm-plan-eligibility-fix-and-rm-gap]]). Since the generic tab label was hardcoded
"Company Requests" in `ApprovalsWorkspace`, added an optional `companyRequestsTabLabel` prop
(defaults to the old hardcoded string, so vacation/excuse are unaffected) — reuse this prop for any
future module that wants the same oversight-tab shape under a different name. Also confirmed
Super Admin gets BOTH "Company Plans" and the older "All Decisions" tab simultaneously (same
asymmetric-gate pattern as vacation/excuse: `canSeeCeoApprovalTabs` is CEO+SA, the older
"All Decisions"/`isPlanHrActor` gate is SA-only) — this is intentional, not a bug, if it recurs
elsewhere.

**Browser verification DID work this time** (contra the "can't reach the local worktree dev server"
note above) — the trick: don't use `preview_start`/`preview_*` at all (they bind to the primary
worktree, see [[preview-start-ignores-worktree-cwd]]); instead launch `pnpm exec next dev --webpack
-p <port>` directly via Bash from inside the worktree (backgrounded), THEN call the Browser pane's
`preview_start` with an explicit `{url: "http://localhost:<port>/..."}` — it opens a real browser tab
against that already-running server rather than trying to launch its own. Real screenshots + DOM
reads worked fine from there (confirmed real prod data: CEO/SA saw 17 live company-wide plans).
