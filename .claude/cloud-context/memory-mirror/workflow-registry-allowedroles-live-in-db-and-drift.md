---
name: workflow-registry-allowedroles-live-in-db-and-drift
description: "Workflow-registry allowedRoles are DB rows, not code — they silently drift from permissions.ts grants; full 13-module audit done 2026-08-02"
metadata: 
  node_type: memory
  type: project
  originSessionId: 281f4a6a-00a3-41f1-8658-a5380d1970d3
  modified: 2026-10-01T00:00:00.000Z
---

`workflow_registry_modules.actions[].allowedRoles` is **live database data**, editable from the
Super Admin Workflow Registry screen. It is NOT in the repo — the only committed copy is the
May-2026 seed in `supabase/_migrations_archive/pre-baseline-2026-07-11/20260527091104_workflow_registry_live_modules.sql`,
which is stale. `grep` will never show you the live rule. Query the table.

A role can hold a permission in `src/lib/auth/permissions.ts` and still be blocked at runtime,
because the registry is a **second, independent gate** applied right after `assertPermission` (the
route asserts the permission, the service then consults the registry). The two drift silently and
the drift is invisible to typecheck, lint, and the whole test suite.

## Full audit, 2026-08-02 — all 13 modules

**Fixed (prod + staging).** Talent Acquisition (Youmna, A-16 — the only account) held the
permission in code but appeared in **zero** registry actions:

| Module | Was | Now |
| --- | --- | --- |
| `leave_requests.submit` | 14 of 16 roles (no TA, no Financial Advisor) | 16 |
| `contracts` | TA in 0 of 7 actions, vs `contracts: allActions` | 7 of 7 |
| `resignations` | TA in 0 of 7 actions, vs `resignations: allActions` | 7 of 7 |

Cause: the seed granted these to `HR Specialist`; when that role was retired and replaced by
`Talent Acquisition`, the approve paths were updated and the rest never were. The
2026-07-24 portal-parity grant ("employee directory, contract renewal, resignations, org chart")
had therefore never worked.

**Verified clean — do not re-audit:** `coaching_reports`, `payroll_batches`, `direct_orders`,
`outstation_expenses`, `probation`, `offers`, `recruitment`, `private_calendar_data_disputes`.
Also: every role string in every module is a canonical `phoenixRoles` value (no `HR Specialist`
left, nothing unparseable), and production carries exactly **one** `role_permission_overrides`
row (`Employee / expenses / create / false`) — so the static matrix really is the live policy.

## Still open

- **Nobody can self-submit a resignation, and the feature was never built.** `resignation_submit`
  lists Employee, Medical Rep, DM, RM, NSM, Manager — none of whom hold *any* `resignations`
  permission, so they are stopped at the route before the registry runs. There is also no
  self-service UI: `app/employee-portals/resignations/page.tsx` is the HR admin dashboard
  ("available to Talent Acquisition and Super Admin only"). Resignations are effectively
  Super Admin + TA only. Whether ordinary staff *should* self-resign is an open product question.
- 🔴 **Before widening `resignations:create`, know that the create path was unscoped.**
  `POST /api/resignations` → `createResignation` → `createResignationForEmployee` takes the target
  from `input.employeeHrId` in the **request body**, and had no `canSeeEmployee` check — it could
  not do one, because `access` was `Pick<AccessContext,"role">` with no hrId. Only the *narrow
  grant* stopped this being "any account can resign the CEO". **Fixed and shipped 2026-08-02 —
  PR #1637, squash `07f76787`, live on prod 75s after merge.** The guard now sits at
  `src/lib/resignations/service.ts`, mirroring `resignEmployeeAndOpenVacancy`. Covered by
  `tests/resignation-scope-check.test.ts` (break-verified). Lesson: a missing authorization check
  can be masked by a narrow grant rather than by any real scoping — check the guard, not the
  grant list.
- The resignations dashboard read path filters workflow records through `canSeeEmployee` but
  appends **legacy/historical** resigned employees unscoped (`service.ts` ~L575), so anyone with
  `resignations:read` sees every past leaver. Still open.
- **Possible CEO gap, unconfirmed.** CEO holds `hiring_interviews: [read, update]` and
  `hiringManagerInterviewType` (`src/lib/recruitment/access.ts:29`) mints a `ceo_interview` type,
  but CEO is absent from `recruitment.app_record_hm_interview`. Never traced whether a CEO
  actually triggers that stage transition.
- **`employee_lifecycle` is dead weight** — `is_active=false`, 24 actions duplicating
  contracts/offers/probation/resignations, and no code references it.

## Traps when editing these rows

- **`"draft"` is not a saved draft.** `toLeaveWorkflowStatus` (`src/lib/vacation/workflow.ts:26`)
  returns `"draft"` for any empty/null status, so `submit` from `"draft"` is the everyday
  "employee creates a new request" path. Lifecycle modules hardcode `resignation_new` /
  `contract_new` / `probation_new` for their create actions
  (`src/lib/employee-lifecycle/workflow.ts:34`), ignoring the status the caller passes.
- **A role string the app cannot parse takes down the entire module, not one action.**
  `normalizeActions` runs `parseRoleStrict` on every entry; `listWorkflowRegistryModules` catches
  per-module and *skips* the bad module, surfacing to every user as `workflow_module_not_found`.
- **`version` auto-bumps** on update (there is a trigger) — leave went 6 → 7.

**Why:** the registry governs leave, payroll, resignations, probation, contracts, outstation,
offers and marketing requests, so this drift class can silently disable a workflow for one role
while the code looks correct.

**How to apply:** on "Forbidden: Workflow Registry does not allow X to run Y.Z", do not read code
first — query `workflow_registry_modules` for the live `allowedRoles`, then compare against the
role's grant in `permissions.ts` **and** `role_permission_overrides`. Fix with a targeted
order-preserving, idempotent `jsonb_set` on the affected actions rather than rewriting `actions`,
since the row is also user-editable from the UI, and write a matching `audit_logs` row
(`entity_type='workflow_registry'`) because raw SQL bypasses the app's own audit write. No deploy
is needed — nothing caches this table.
Related: [[app-visibility-is-application-scoped-not-rls]], [[module-audit-2026-08-01-status]].
