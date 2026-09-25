---
name: mcp-apply-migration-version-drift
description: "Applying migrations to prod/staging via the Supabase MCP records MCP-generated version strings, not the repo's — reconcile schema_migrations afterward."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 8b92369c-079a-446b-8e92-91d55e8823c2
  modified: 2026-07-19T18:31:27.283Z
---

The Supabase MCP `apply_migration` tool records its OWN timestamp version (e.g. `20260705041727`) + the `name` you pass, NOT the repo file's version prefix (e.g. `20260705170000`). So applying a repo migration via MCP leaves `supabase_migrations.schema_migrations` with a version string that doesn't match the repo filename — the team's migration-reconciliation scripts flag this as drift (repo file "unapplied" + an "orphan" version in the DB).

**Fix (repair-style, matches `supabase migration repair --status applied`):** in `supabase_migrations.schema_migrations`, INSERT the canonical repo `version` + `name` (statements may be null), and DELETE the MCP placeholder rows. Table cols: `version` (PK), `statements text[]`, `name`, `created_by`, `idempotency_key`, `rollback`. The "is-applied" check is by `version` only, so name/statements exactness isn't required. Low-risk bookkeeping table — no schema/data impact, reversible.

Done on prod (`ozucdzovmcqvepbozvqf`) 2026-07-05 for the ROI line-scoping rollout: mapped MCP versions `20260705041514/041727/041938` back to repo `20260704103325` (all_statuses, column-only apply) + `20260705170000` (#847). Deferred `20260705180000` (#851, open PR) — an unmerged version left unrecorded self-heals when its pipeline run applies it (idempotent).

Done again on BOTH staging (`cifwmndunmlxjhyjugxa`) and production (`ozucdzovmcqvepbozvqf`) 2026-07-19, same turn as notification-role-recipients's migration apply: 7 migrations applied together (6 pre-existing security/correctness fixes already merged to `main` but never applied to either DB, plus `notification_role_policies`). Repaired all 14 rows (7 per environment) in one pass right after applying — INSERT canonical repo version+name / DELETE MCP placeholder, wrapped in begin/commit, via `execute_sql` (not `apply_migration`, which is what creates the drift in the first place). Confirmed via SELECT afterward that all 7 canonical versions exist and the MCP placeholders are gone, both environments.

Prefer the repo's own `db:*` migration pipeline for prod when possible; use MCP apply only when you'll also reconcile the history. Related: [[supabase-dual-project-schema]], [[one-prod-deploy-per-task]].
