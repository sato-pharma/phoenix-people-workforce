---
name: workflow-registry-allornothing-loader-bug
description: "One bad workflow_registry_modules row could crash ALL modules' transitions app-wide; fixed prod 2026-07-24, PR #1297"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6d93b697-0796-4fee-878b-bf088750f4ef
  modified: 2026-07-24T05:29:40.946Z
---

`src/lib/workflow-registry/service.ts`'s `listWorkflowRegistryModules()` used to validate
every row via a single unguarded `.map(toModule)` — one malformed row (any module) threw
synchronously and killed the load for ALL modules, since every workflow-registry-governed
domain (payroll, resignations, probation, contracts, outstation, offers, marketing-requests)
shares this one loader via `assertWorkflowRegistryRuntimeTransition`.

Found 2026-07-24: `private_calendar_data_disputes`' "submit" action had `from: []` (no
predecessor status — a dispute row is inserted directly at `pending_review`, there's no real
"draft" status). This silently blocked resignation submission (and likely other modules) in
production. Root cause was a validator gap, not random data corruption — the migration author
correctly modeled "no real prior status" but the shared `normalizeStringList` validator
requires non-empty `from` unconditionally.

**Established, working convention for create/submit actions with no real predecessor status**:
give them a *virtual* status that exists only in the registry's own JSONB, never persisted in
the real table — e.g. `resignation_submit.from = ["resignation_new"]`,
`probation_create.from = ["probation_new"]`, `contract_create.from = ["contract_new"]` (see
`src/lib/employee-lifecycle/workflow.ts`). Confirmed `"resignation_new"` isn't in the real
`ResignationStatus` enum — purely registry bookkeeping. Applied the same pattern to disputes
(added virtual `"new"` status, `submit.from = ["new"]`) rather than inventing an unrelated
"draft"/"open" status that doesn't exist anywhere else in the codebase.

**Why:** production incident blocking employee resignations; owner approved both an immediate
direct-to-production data migration (fastest fix) and a follow-up code hardening +
commit/push/PR in the same session.

**How to apply:** [[incentive-policy-lock]]-adjacent — if a future workflow_registry_modules
row needs a create/submit action with no real predecessor status, always add a virtual
`_new`/`_draft`-style status scoped to that module's own registry row, never leave `from: []`.
Also: `listWorkflowRegistryModules()` now isolates per-row validation failures (skip + log via
`logError`) instead of failing the whole load — so this failure class can't recur app-wide even
if a future row is malformed again. Migration:
`supabase/migrations/20260724110000_fix_private_calendar_dispute_submit_from.sql`. PR:
https://github.com/Phoenix-HR/phoenix-people-workforce/pull/1297 — MERGED to main 2026-07-24
(squash, commit c323b64e) after CI passed (lint-typecheck/validate/preview-smoke/Seer all
green). Production data fix was already applied directly (project `ozucdzovmcqvepbozvqf`) ahead
of the PR merging, since the data fix and the code-hardening fix are independent — either alone
would have resolved the incident. Merge triggers the normal no-traffic/smoke-test/promote
~~Cloud Run deploy pipeline~~ **[RETARGETED 2026-08-27: Railway auto-deploy on push to `main`; confirm what is serving by reading `revision` from `/api/healthz`]** — worth a quick post-deploy smoke check of resignation submission if
following up.
