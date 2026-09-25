---
name: excuse-module-excludes-dsm-rm
description: "Owner removed District Manager + Regional Manager from the Excuse module entirely (request AND approval) on 2026-07-30; excuse is a Head-Office/fingerprint concept, and prod data proved the field ladder never used it."
metadata: 
  node_type: memory
  type: project
  originSessionId: 6e0de13b-b588-44f7-8112-52d963323230
  modified: 2026-08-22T22:23:44.621Z
---

Owner instruction 2026-07-30: "remove excuse request or excuse approval from all dsm and rm."
Shipped as **PR #1476 — MERGED to main 2026-07-30 as squash commit `00e238b7`** (branch
`codex/remove-excuse-from-dsm-rm`, worktree `F:/Phoenix Workforce/_wt-excuse-dsm-rm`). All CI green
(lint-typecheck, validate, sast-scan, secret-scan, preview-smoke). Owner then ordered a prod deploy
and explicitly said **"skip staging"** after I flagged the two facts below.

🔴 **The "deploy-pipeline facts" below are DEAD — superseded 2026-08-01, corrected here 2026-08-23.**
Production moved off GCP Cloud Run to **Railway** on 2026-08-01 and GCP billing is closed (every API
in `phoenix-workforce-498619` returns `BILLING_DISABLED`). There is **no 2-hourly cron and no deploy
window**: a merge to `main` ships to production **immediately**, at full traffic, with no staged
rollout. `deploy-cloud-run.yml` is trigger-disabled. Confirm what is actually serving with
`GET /api/healthz` and read `revision` — not a workflow list. See
[[railway-merge-is-the-production-deploy]] and [[railway-is-prod-cloud-run-workflow-is-dead]].
The CI-conclusion gate idea below is also gone; today four **required** checks (`validate`, `lint`,
`typecheck`, `secret-scan`) block the merge itself. Kept verbatim as the 2026-07-31 record:

**~~Deploy-pipeline facts worth remembering~~ (I had this backwards at first):**
- `deploy-cloud-run.yml` (PROD) runs on a **2-hourly cron** (`0 */2 * * *`) or `workflow_dispatch`.
  Its CI gate moved from the old `workflow_run` trigger into a `gate` job that queries the CI
  conclusion of the exact commit and refuses a red/un-CI'd one — so dispatch only AFTER CI on main
  is green, or the gate burns a run. `force: true` is the emergency override.
- `deploy-cloud-run-staging.yml` runs **daily 03:40 UTC** and on its normal path **reuses the image
  PROD already built** ("build once, deploy twice") — so **staging normally deploys AFTER prod, not
  before.** To verify a commit on staging first you must dispatch it with `build_from_source: true`.
- **Staging cannot verify role-gated UI credential-free**: its Cloud Run env has no
  `PHOENIX_ENABLE_DEV_AUTH_HEADERS` and no `NODE_ENV=development`, so dev-auth is off. Env var list
  confirmed 2026-07-30. Role-level proof needs the owner to look, or localhost dev-auth.
- Staging exposes `COMMIT_SHA` as a Cloud Run env var — use it (plus the revision name) to prove a
  deploy actually landed. Baseline before this deploy: revision `phoenix-hr-staging-00883-voc`,
  `COMMIT_SHA=sha-a2e1aa1d`.

⚠️ **PR #1477 (RM Region Command Center, `_wt-rm-region`) also edits
`src/lib/employee-portal/navigation.ts`.** #1476 landed first, so #1477 must rebase onto it.

**Why it is safe — verified against PRODUCTION (`ozucdzovmcqvepbozvqf`) before changing anything:**
- Only **6 excuse requests exist in all of production history.** Submitters: GPM×2, PM×2, MM×1, TM×1.
  Approvers: Marketing Manager×3, GPM×2, CEO×1. **Zero** submitted by or routed to a DSM or RM.
- **Zero** excuse-eligible employees (Head-Office line/dept, or NSM/PM/GPM/TM/MM role) report to a
  DSM or RM. So removing their approval authority orphans nothing — not one pending row, not one
  future-eligible employee. This is the query to re-run if the rule is ever questioned.

**The key insight:** Excuse is a Head-Office / fingerprint-attendance concept (a 2-hour morning or
afternoon excuse against a punch clock). Field reps don't punch in, so the whole field sales ladder
was never in this module. `showExcuseApprovalsTab` for DSM/RM was a **permanently-empty link**.

**Excuse authority is RELATIONSHIP-based, not role-based** — `decideExcuseRequestAsManager` matches
purely on `manager_hr_id == actor` with no role gate at all (see
[[project-leave-excuse-approver-model]]). So hiding the nav link was NOT sufficient; the role
exclusion had to be added as a real gate.

**Where the enforcement lives** — `EXCUSE_EXCLUDED_ROLES` + `isExcuseExcludedRole()` in
`src/lib/excuses/service.ts` is the single source of truth, read by 6 gates:
1. `canUseExcuses` — checked BEFORE the head-office branch, because `isHeadOfficeExcuseEmployee` is
   line/department-based and an Office-line DSM/RM would otherwise slip through.
2. `loadEligibleEmployee` — own Forbidden message (the generic one says "Head Office employees…
   only", which reads as wrong to an Office-line DSM/RM).
3. `getManagerPendingExcuses` — returns `[]`, which also empties their Action Center excuse cards
   and the `excuse-approvals-pending` nav badge for free.
4. `decideExcuseRequestAsManager` — throws `Forbidden:` (→ 403 via `isForbiddenError`).
5. `createExcuseRequest` + `resubmitExcuseRequest` — refuse UP FRONT if the resolved direct manager
   holds an excluded role, so no row (and no emailed token) is ever minted that nobody can decide.
6. `decideExcuseRequestByToken` — the emailed approve/reject link carries NO session, so it resolves
   the manager's role from `app_auth_users` itself via `hrIdHoldsExcuseExcludedRole`. Tokens live 14
   days, so a pre-existing link had to be closed too. Compare HR_IDs with `normalizeHrId` in JS, not
   a case-sensitive `.in("hr_id", …)`.

**"Manager" is deliberately NOT excluded** — that is the generic Head-Office people-manager rung
that HO staff actually report to, a different role from "District Manager".

**Nav trap found:** `src/config/system-navigation.ts` had ONE shared
`leaveExcuseApproverPortalNavigationRoles` list driving BOTH the Vacation and Excuse portal links,
even though `src/lib/employee-portal/navigation.ts` already had separate flags. Split into
`vacationApproverPortalNavigationRoles` (unchanged, keeps DSM/RM) and
`excuseApproverPortalNavigationRoles`. The config list was also broader than the flag — it still
granted NSM, whom the flag already excluded; now consistent. **Vacation approvals for DSM/RM are
untouched.**

Three existing tests asserted the OLD behavior and were updated, not deleted:
`navigation-active-path.test.ts`, `approvals-hub.test.ts`, `employee-portal-navigation.test.ts`.

**LIVE IN PRODUCTION 2026-07-30** — deploy run 30506915948 (workflow_dispatch on main), revision
`phoenix-hr-00661-yuw` at 100% traffic, `COMMIT_SHA=sha-00e238b7` (exact match; baseline was
`phoenix-hr-00658-rij`/`sha-c931d6ee`). gate+deploy both success; no-traffic smoke passed before
promotion. Public domain `https://phoenix-hr.satopharma.com` returns 200 on /, /login,
/employee-portals/{excuses, approvals/excuse, approvals/vacation}. Zero unexpected errors on the new
revision.

`pnpm run check:harden` green: lint + typecheck + 477 test files + production build compiled.
NOT browser-verified — see [[preview-start-ignores-worktree-cwd]] and
[[local-env-already-points-at-production]].
