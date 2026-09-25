---
name: workflow-registry-drifts-from-the-typescript-chain
description: "Approval chains have TWO sources of truth — TypeScript and the workflow_registry_modules table — and changing a chain in code without a registry migration silently wedges the module"
metadata: 
  node_type: memory
  type: project
  originSessionId: e32f401d-1870-40e6-a9d2-426a717c7488
  modified: 2026-08-04T10:13:05.604Z
---

A workflow-governed module's approval rules live in **two** places that nothing automatically
compares: the domain code under `src/lib/<domain>/`, and the `workflow_registry_modules` row in
Postgres (`allowedRoles` / `from` / `to` per action). `assertWorkflowRegistryTransition` reads the
DB row, so **the registry can veto a transition the TypeScript happily allows.**

Proven 2026-08-04 on `direct_orders`. #1666 added an SFE Manager rung to the FRONT of every chain
and correctly updated both code-side gates — but the registry row was seeded 2026-07-18 (chain
opened at District Manager) and no migration ever touched it. Result: `SFE Manager` was missing
from `approve_intermediate`, `return` AND `reject`, so the rung that opens *every* direct order was
actionable by nobody. All 3 production orders sat frozen on step 1 with **zero decided steps ever**,
from the day the rung shipped until the fix. Fixed by migration `20260804093000` / PR #1701.

**Why it hid for a day:** Super Admin is in every `allowedRoles` list *and* bypasses the fine
per-step check, so the owner could still push orders through. It read as "the SFE has a permission
problem", not "the module is down".

**Why to apply:**
- The registry gate is the **LAST** check before the write (status → active step → fine approver
  auth → route permission → comment → sequencing → **registry** → write). So `Forbidden: Workflow
  Registry does not allow X to run m.a from "s"` means everything upstream already passed — the
  registry alone is the blocker. Do not go hunting the permission matrix.
- The fix is **pure production data and needs no deploy** — the registry is read from the DB at
  runtime. Applying the SQL unblocks users immediately; the PR is only the repo record.
- Same shape exists for `payroll_batches`, `outstation_expenses`, recruitment, resignations,
  probation, contracts, offers, marketing requests. **Any of them may already be drifted — this
  has never been swept.**

**How to apply:** whenever you change an approval chain's rungs or roles in TypeScript, pair it
with a `workflow_registry_modules` migration in the SAME PR. Prefer a targeted jsonb append over
replacing the whole `actions` array, so it can't revert a Workflow Control UI edit
(see `20260804093000_fix_direct_orders_registry_sfe_rung.sql`). `tests/direct-orders-registry-chain-grants.test.ts`
now pins this for direct orders only.

## It bites in BOTH directions — a migration alone is just as dangerous

Proven the same day on `outstation_expenses`. A migration retargeted the `submit` action from
`to: "pending"` to `to: "pending_departure_photo"` for a two-photo feature. But
`assertOutstationExpenseWorkflowTransition` is called with an **exact** `expectedNextStatus`
literal, and it THROWS on a mismatch:

```ts
if (input.expectedNextStatus && transition.nextStatus !== input.expectedNextStatus) throw ...
```

`submitOutstationRequest` passes `expectedNextStatus: "pending"` at **three** call sites. Applying
the migration therefore wedged EVERY outstation submission the moment it landed on production.
Caught and reverted in ~2 minutes; blast radius zero only because nobody was submitting.

**Two lessons the first incident did not cover:**
- **Changing `to` is a BREAKING change to the deployed code**, not an additive one. Adding a
  *status* or a whole new *action* is inert (nothing references it). Moving an existing action's
  target is not.
- **"Ship the code and it resolves" can be false.** Check the feature branch actually passes the
  new literal before assuming a merge fixes it — in this case the branch still passed `"pending"`
  too, so merging would have reproduced the outage.

~~**Staging cannot catch this.** There is no staging *application*, so applying a registry migration
there proves the SQL ran, never that the app still works.~~
**CORRECTED 2026-08-27: there IS a live staging application** — `https://phoenix-people-workforce-staging.up.railway.app`, confirmed 2026-08-13 and kept by owner decision, wired to the **staging** Supabase project `cifwmndunmlxjhyjugxa` (not production). It answers `/api/healthz`, so a registry migration applied there CAN now be exercised against a running app. Verified live 2026-08-27. The grep advice below is still the cheaper pre-flight, but staging is no longer a dead end. The only pre-flight that would have
caught it is grepping `expectedNextStatus` for the action you are retargeting.

Related: [[list-migrations-reports-ledger-not-reality]] · [[app-visibility-is-application-scoped-not-rls]]
