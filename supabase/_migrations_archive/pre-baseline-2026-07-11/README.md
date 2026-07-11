# Pre-Baseline Migration Archive (2026-07-11)

## Why this exists

By 2026-07-11, `supabase/migrations/` had drifted from what was actually running on production:

- **74 local migration files were never applied to production** — mostly a dense run of files
  dated 2026-06-27 through 2026-07-08 tracking a feature (area/region/line unification) that was
  shipped to production, then fully reverted there, but whose local files were never cleaned up to
  match.
- **67 versions applied to production have no corresponding local file at all** — see
  `production-only-versions.md` in this folder for the full list. These are the migrations that
  actually shipped and reverted the same feature, plus assorted iReports360/attendance-digest/
  marketing-ROI work, applied to production without a matching commit ever landing on `main`.
- Two very early versions (`20260501000000`, `20260503120000`) exist under the same timestamp
  locally and on production but with different content — `legacy_preview_compat` locally vs.
  `phoenix_core_schema_bootstrap`/`bootstrap_app_auth_users_and_profiles` on production. These
  predate and are unrelated to the drift above — they're an older "fast preview/staging bootstrap"
  pattern used for quickly standing up a fresh non-production environment, not part of this
  incident.

The practical effect: replaying `supabase/migrations/` from scratch on a fresh project no longer
reproduced production's actual schema. Verified directly by diffing local filenames' version stamps
against a live query of `supabase_migrations.schema_migrations` on production.

## What superseded it

A single new migration,
`supabase/migrations/20260711135352_phoenix_production_schema_baseline.sql`, captures production's
verified live schema directly (`pg_dump --schema-only` against production, patched for portability —
see the comment header in that file) rather than attempting to replay this history. It supersedes
everything in this folder as the new starting point for any fresh environment.

## Why this wasn't reconciled file-by-file instead

A prior session already attempted exhaustive file-by-file reconciliation of this exact class of
drift — see `_junk/migration-reconciliation-main-20260624*` (untracked, local-only working files) —
and got a smaller, older version of this problem down to 4 unresolved names across three separate
attempts spanning weeks, without ever landing a finished, committed result. By the time this archive
was created, even those 4 "unresolved" entries had become moot: production's migration bookkeeping
had been hand-edited again in the interim, and today's drift (this folder) is a different, larger
set than what that prior work was chasing. Given that track record, a baseline snapshot was judged
the more reliable path forward — see the owner's explicit sign-off referenced in the fixation plan
this archive was created under.

## Rules

- **Every file in this folder (and its `pre-baseline-2026-07-11/` siblings, if more are added later)
  is historical reference only.** None of it is part of the automated migration pipeline anymore.
- **Never re-timestamp or resurrect a file from this archive.** If you believe one of the 74
  never-applied files represents real, still-needed work, compare today's true schema (via the live
  databases, not this archive) against what you believe is missing, and author a brand-new
  post-baseline migration for it. Do not copy/rename an old file back into `supabase/migrations/`.
- Production's own `supabase_migrations.schema_migrations` table remains the permanent record of
  the 67 production-only versions — this archive does not attempt to recreate or replace that
  record, only to document it for anyone reading the repo.
- See `docs/migrations.md` for the current baseline model and how new migrations should be authored
  going forward.
