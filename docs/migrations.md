# Migration Policy

## Baseline Model (post 2026-07-11)

On 2026-07-11, migration history before `20260711135352` was superseded by a single
baseline-snapshot migration (`20260711135352_phoenix_production_schema_baseline.sql`) capturing
production's verified live schema. The prior 450 files live in
`supabase/_migrations_archive/pre-baseline-2026-07-11/` for historical reference only — they are
not part of the automated migration pipeline and must never be re-applied or re-timestamped. See
the `README.md` and `production-only-versions.md` in that folder for why this was necessary
(production's applied history had drifted from what was committed to the repo) and what to do if
you believe an archived file represents still-needed work.

A brand-new project now bootstraps from the baseline file (plus
`20260711134651_bootstrap_custom_infra_roles.sql`, which it depends on) plus anything committed
after them. All guidance below applies to migrations written from this point forward.

## File Location

All database migrations live in supabase/migrations/ with timestamped filenames:
YYYYMMDDHHMMSS_description.sql

The supabase/ root also contains historical hardening scripts and operational patches. These are reference material, not part of the automated migration pipeline (same principle as the pre-baseline archive above — kept for reference, never re-applied).

## Creating Migrations

1. Write SQL in a new file under supabase/migrations/ with the current timestamp prefix
2. Include both the forward migration and document any manual rollback steps
3. Test on a staging/development Supabase project first
4. Never apply directly to production without explicit approval

## Safety Rules

- All migrations require staging validation before production
- RLS-affecting changes require security review
- Destructive operations (DROP, DELETE, ALTER TABLE DROP COLUMN) require explicit approval and documented rollback
- Production migration application follows the phase pipeline (see scripts reference)
- Never use the Supabase Dashboard to make schema changes — all changes go through migration files

## Migration Pipeline

Staging validation still runs through the phase25-27 mutation smoke scripts (RLS,
browser-auth, app-service — see docs/scripts.md). The phase28-36 production
approval/reconciliation gate was **retired 2026-07-11**: those scripts hardcode
checks against one specific pre-baseline migration (now archived under
`supabase/_migrations_archive/pre-baseline-2026-07-11/`) and cannot validate any
migration written since. There is currently no scripted gate for taking a new
migration to production — apply via the Supabase MCP `apply_migration` tool (or
`supabase db push`) to staging first, verify with `get_advisors` plus a targeted
`pg_policies`/`pg_constraint`/`has_function_privilege` check, then repeat against
production after explicit approval. If the apply tool records a drifted
`schema_migrations` version (it stamps the apply-time server clock, not the repo
filename), reconcile by hand — see the "Operational note" in
docs/security/supabase-advisor-baseline.md. A daily CI job
(`.github/workflows/migration-drift-check.yml`) now catches migrations that were
merged but never actually applied to staging.

## Rollback Strategy

- Each migration should be designed to be rollback-safe where possible
- Document rollback SQL in comments or companion files
- For complex migrations, create a backup migration first (see the archived
  `20260512235939_backup_leave_domain_before_rebuild.sql` under
  `supabase/_migrations_archive/pre-baseline-2026-07-11/` as an example of the pattern)

## Loose SQL Files

The supabase/ root contains ~50 historical SQL files (phoenix-*.sql, security-*.sql, etc.). These are operational scripts that were applied during early development before the timestamped migration convention was established. They remain as documentation but are not part of the automated migration pipeline.
