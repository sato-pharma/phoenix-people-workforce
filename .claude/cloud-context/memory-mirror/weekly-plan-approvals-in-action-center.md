---
name: weekly-plan-approvals-in-action-center
description: "Weekly/monthly plan approvals now live in the Action Center inbox (+ planner Super Admin unlock); shipped PR #389"
metadata: 
  node_type: memory
  type: project
  originSessionId: 1c3cd3e2-26bc-42cd-9f4f-4f42f4e41f2c
---

SHIPPED to prod 2026-06-20 (PR #389, squash→main `78bc6832`, deploy success, prod routes 200). Weekly/monthly plan approvals were NOT in the Action Center before — a submitted plan only had the dedicated planner (`/admin/weekly-plans` PlansWorkspace) as a review surface, and the manager-review notification deep-linked to `/employee-portals/plans` which BOUNCES admin-shell managers (Marketing Manager etc.) to `/overview`.

Now: `getPlansAwaitingAction()` in [[sales-territory-scope-build]]'s weekly-planning service surfaces submitted plans to the assigned manager (and `manager_approved` plans to CEO/Super Admin) in `getAwaitingMyActionItems` (both audiences). The Action Center detail renders an inline day-by-day calendar (week grid / monthly agenda) with Approve→CEO / Return / Reject wired to `/api/weekly-plans/[id]/decision`. New `weekly_plan` module added across action-center `types.ts` / `service.ts` / `action-center-hub.tsx` + hub-data view-as route. Manager notification deep-link is now reviewer-shell-aware. Whole Action Center got a premium restyle + a nested-`<button>` hydration fix.

Planner fix: PlansWorkspace gated `managerQueue` on raw `p.managerHrId === access.hrId` with NO Super Admin override → Super Admin couldn't approve submitted plans ("locked to the direct manager"). Fixed: Super Admin god-mode at manager+CEO stages + canonical `canonicalHrIdKey` compare. GOTCHA: `access.hrId` is the RAW `app_auth_users.hr_id` (server.ts:326, uppercase, NOT normalized) — always compare HR_IDs via `canonicalHrIdKey`/`hrIdsMatch`, never `===`.

Process note: shipped from an isolated worktree off `origin/main` (branch had unrelated WIP: a PM/GPM Sales Intelligence commit + a broken monthly-sales page) so only my 10 files were committed. Turbopack rejects a junctioned `node_modules` (build fails "Symlink points out of filesystem root") — tsc/eslint/test work over a junction, `next build` does not.
