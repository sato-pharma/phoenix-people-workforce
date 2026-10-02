---
name: mcp-apply-migration-version-drift
description: "The Supabase MCP apply_migration records its OWN timestamp version, not the repo filename's — that mismatch is the NORM, not drift. Pass the filename's snake_case tail as name, verify the object (pg_class/pg_proc), and NEVER hand-insert or delete schema_migrations rows to 'reconcile' it."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 8b92369c-079a-446b-8e92-91d55e8823c2
  modified: 2026-10-02T16:36:06.296Z
---

The Supabase MCP `apply_migration` tool records its OWN timestamp version (e.g. `20260705041727`) + the `name` you pass, NOT the repo file's version prefix (e.g. `20260705170000`). So applying a repo migration via MCP leaves `supabase_migrations.schema_migrations` with a version string that doesn't match the repo filename — **and that is the expected state, not drift.** Every migration here is applied through `apply_migration`, the names match, and `migration-drift-check.yml` stays green across such rows because it does not compare versions. See [[migration-ledger-version-never-matches-the-filename]] and [[a-ledger-version-never-matches-the-file]].
**Superseded 2026-10-02:** previously "the reconciliation scripts flag this as drift" — measured 2026-08-21 and 2026-10-01: the mismatch is the norm and the drift check is green on it.

**Rule (current): do NOT reconcile the ledger.** Pass `apply_migration` a `name` that is the repo filename's snake_case tail, let the version fall where it falls, and verify the *object* (`pg_class` / `pg_proc` / `pg_constraint`), never the ledger. Never hand-insert a ledger row carrying the filename's version (a lie about when the schema changed) and never rename the file to match the ledger. When checking whether a migration is applied or duplicated, match on `name`, not `version`, and count files in `supabase/migrations/` only.
**Superseded 2026-10-02:** previously "Fix (repair-style): INSERT the canonical repo `version` + `name` into `schema_migrations` and DELETE the MCP placeholder rows" — replaced by the rule in [[migration-ledger-version-never-matches-the-filename]] (2026-08-21) and [[a-ledger-version-never-matches-the-file]] (2026-10-01). Table cols, for reference only: `version` (PK), `statements text[]`, `name`, `created_by`, `idempotency_key`, `rollback`.

History (done under the superseded advice — do not repeat): on prod (`ozucdzovmcqvepbozvqf`) 2026-07-05 for the ROI line-scoping rollout, MCP versions `20260705041514/041727/041938` were re-keyed by hand to repo `20260704103325` (all_statuses, column-only apply) + `20260705170000` (#847). Deferred `20260705180000` (#851, open PR) — an unmerged version left unrecorded self-heals when its pipeline run applies it (idempotent).

Done again on BOTH staging (`cifwmndunmlxjhyjugxa`) and production (`ozucdzovmcqvepbozvqf`) 2026-07-19, same turn as notification-role-recipients's migration apply: 7 migrations applied together (6 pre-existing security/correctness fixes already merged to `main` but never applied to either DB, plus `notification_role_policies`). All 14 rows (7 per environment) were re-keyed by hand right after applying — INSERT canonical repo version+name / DELETE MCP placeholder, wrapped in begin/commit, via `execute_sql`. So those ledger rows carry filename versions rather than apply times — an artefact of that old practice, not a model to copy.

MCP `apply_migration` is the normal path here (AGENTS.md §8 pre-authorizes it on staging and production); there is no history to reconcile afterwards. Related: [[supabase-dual-project-schema]], [[one-prod-deploy-per-task]].
**Superseded 2026-10-02:** previously "prefer the repo's `db:*` pipeline for prod; use MCP apply only when you'll also reconcile the history" — the ledger rule above.
