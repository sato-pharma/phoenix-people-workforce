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

### The `-- SAFE:` annotation, and where it goes

`scripts/check-migrations.mjs` warns when a file contains `DROP TABLE` or `TRUNCATE` and no
`-- SAFE:` anywhere in it. Two things about that rule decide how to answer it:

- **It matches the STATEMENT, not the schema.** `drop table if exists pg_temp.<scratch>` inside a
  function body reads exactly like dropping a production table. Measured 13 Oct 2026: of the 7 files
  warning at the time, **6 were only that** — session-local scratch tables that
  `public.crm_contact_master_refresh` creates and drops inside its own call — and **1**
  (`20260925150000_drop_crm_native_pilot_tables.sql`) dropped eight real `public` tables, which was
  the migration's whole purpose and already carried its evidence in its header.
- **It is matched file-wide**, so the annotation belongs in the file's **header**, not beside the
  statement. 🔴 **A comment inside a function body changes `pg_proc.prosrc`**, which breaks the
  `md5(prosrc)` correspondence that migration-ledger reconciliation depends on — and
  `20261012184500_contact_refresh_survives_a_doctor_added_twice.sql` records that md5 in its own
  header, read off production.

🔴 **The suppression is the whole file, permanently.** A destructive statement added later to an
annotated migration will not warn. That is survivable only because an **applied migration never
gains statements** — a new change is a new file — so never add one to an annotated migration to
"keep it together".

## Migration Pipeline

**Reconciled 2026-08-04.** There is currently **no scripted gate** for taking a new
migration to production. The `phase25`-`phase27` staging mutation-smoke scripts and the
`phase28`-`phase37` production approval/reconciliation scripts **still exist in
`package.json`** — but no automated gate invokes them: neither the `ci` script nor
`.github/workflows/ci.yml` runs any `phase*` script. The `phase28`+ production-gate scripts
were **retired as a gate on 2026-07-11** (retired, not deleted): they hardcode checks
against one specific pre-baseline migration (now archived under
`supabase/_migrations_archive/pre-baseline-2026-07-11/`) and cannot validate any migration
written since the baseline. They are kept for reference only — do not treat a green
`phase*` run as production sign-off. Note also (AGENTS.md §3) that there is **no staging
application** any more, only the staging Supabase *database* (`cifwmndunmlxjhyjugxa`), so
the browser-auth smoke (`phase26`) has nothing to run against.

**Since 2026-09-04 the staging half is automatic.** `.github/workflows/staging-migrate.yml`
applies whatever staging is missing on every push to `main` that touches
`supabase/migrations/**`, and records each one under the file's own version and name. So do
not hand-apply a merged migration to staging: it is already done, or the workflow failed and
that is the thing to look at. It cannot reach production — the script refuses any project ref
but `cifwmndunmlxjhyjugxa` before it opens a connection, and has no override flag.

To take a new migration to production, apply to staging first — before merge that still means
the Supabase MCP `apply_migration` tool (or `supabase db push`), after merge the workflow above
has done it — verify with `get_advisors` plus a targeted
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
