---
name: a-ledger-version-never-matches-the-file
description: "The Supabase MCP's apply_migration stamps its OWN UTC version on supabase_migrations.schema_migrations, so the ledger version NEVER matches the repo filename for anything applied through it. 'The repo's version is absent from the ledger' is therefore the EXPECTED state, not evidence of a duplicate, an unapplied migration or drift \u2014 and reading it as drift led to advice that would have created real drift. MEASURED 2026-10-08, the consequence that 'expected, not drift' does NOT cover: because the file's own version is absent, a later `supabase db push` WOULD replay that file - harmless when the migration is idempotent, not when it is not - so for a non-idempotent one insert the FILE's 14 digits as well, and expect TWO ledger rows for one migration. Nothing in this repo treats the extra row as a finding: `db push` matches by version, `selectMissingMigrations` matches by version OR name and only reports MISSING ones, and `check-migrations.mjs` reads files rather than ledger rows - so never delete the stamped row to tidy it."
metadata:
  node_type: memory
  type: project
  originSessionId: 73e57dfd-59e9-4e08-8d24-cfbcccf853cf
  modified: 2026-10-01T04:47:29.937Z
---

🔴 **`apply_migration` THROUGH THE SUPABASE MCP STAMPS ITS OWN UTC VERSION, NOT THE FILE'S.** So for
every migration applied that way, `supabase_migrations.schema_migrations.version` and the
`supabase/migrations/<version>_<name>.sql` filename **disagree by construction**, while the `name`
matches. Asking the ledger for the repo file's exact version and getting nothing back is the normal
answer, not a finding.

**Measured 2026-10-01, the control case that shows it cleanly:**

```
ledger 20261001023021  phoenix_crm_admin_entry
repo   supabase/migrations/20261001044221_phoenix_crm_admin_entry.sql
```

Same change, same name, two versions, applied that day through the MCP. The same shape held for
`vacation_settlements_allow_holiday_bridge_excluded` (ledger `20261001024530`, repo
`20261001054326`).

🔴 **WHAT THIS COST, AND WHY THE WRONG READ IS CONVINCING.** On that date this session found two
ledger rows named `vacation_settlements_allow_holiday_bridge_excluded` plus one repo file whose
version was in neither, concluded there were **three copies of one change**, and advised the owning
session to **drop its migration file**. That advice was wrong in the dangerous direction: the
constraint was already live on staging and production, so deleting the file would have left the
live fifth branch with **nothing in `supabase/migrations/` describing it** — and a `db reset`
rebuild would then recreate the four-branch constraint that the shipped code immediately violates.
The peer refused it and was right.

**Two separate errors fed that conclusion, and each has its own rule:**

1. **Version mismatch is not duplication.** Count FILES in `supabase/migrations/`, never ledger rows
   against filenames. There was exactly ONE live file.
2. **A pre-baseline migration is not in `supabase/migrations/` at all.** The July original lives in
   `supabase/_migrations_archive/pre-baseline-2026-07-11/`, so `git ls-tree` across the whole repo
   returns it and makes one live file look like two. Scope the listing to `supabase/migrations/`.

🔴 **AND THE ATTRIBUTION HALF: THE DATABASE CANNOT TELL YOU WHICH SESSION RAN A STATEMENT.** Because
the stamped version is the apply's wall-clock minute, a ledger row looks like evidence of *when* and
therefore invites a guess about *who*. This session read a row stamped 02:45:30Z and told the owner
"another session applied it", when it was the owning session's own apply, minutes earlier, reported
in its own words. Nearness in time is not evidence — the §2.1 probing cluster says exactly this, and
it was quoted to three other sessions the same night by the session that then broke it. **Attribute
from a session's own report or a PR, never from a timestamp.**

**So before calling any migration a duplicate or unapplied:** list `supabase/migrations/` only;
match on `name`, not `version`; read `pg_constraint` / `pg_proc` / `pg_class` for whether the change
is actually live (the ledger is not reality); and say "applied, and the file is the repo's record of
it" rather than "adds an unapplied migration".

Related: [[verify-the-emitted-artifact-never-the-source]] ·
[[the-four-shapes-a-stale-citation-sweep-misreads]]

🔴 **AND THE PART "EXPECTED, NOT DRIFT" DOES NOT COVER — measured 2026-10-08 on PR #5482.**
The stamped version satisfies nobody but the ledger's own uniqueness: the FILE's version is still
absent, so a later `supabase db push` (which is what `staging-migrate.yml` runs on the merge) WOULD
apply that file again. Harmless for an idempotent migration — a `revoke`/`grant` pair, an
`if not exists` — and NOT harmless for one that is not. So when the migration is not idempotent,
insert the FILE's own 14 digits as well, and expect **two rows for one migration**:

```
20261008013000  private_phx_hr_id_helpers_explicit_execute   <- the file's version, inserted by hand
20261008011936  private_phx_hr_id_helpers_explicit_execute   <- apply_migration's own stamp
```

**That duplicate is inert, and tidying it would be a destructive production write for nothing.**
Checked, rather than assumed: `db push` matches by VERSION, so the file is skipped;
`selectMissingMigrations(local, remote)` in `scripts/check-migrations-applied.ts` matches by version
OR name and reports only migrations MISSING from the ledger, never extra ones; `check-migrations.mjs`
inspects repo FILES for duplicate timestamps and never reads the ledger; and every leg of
`migration-drift-check.yml` carries `continue-on-error` so a finding there cannot withhold a Railway
deploy anyway.

**Re-verified independently against `origin/main` the same day, and one structural reason the four
checks above are not merely tolerant but cannot break:** `selectMissingMigrations` resolves through
`migration-inventory.ts` as `remote.versions.has(v) || remote.names.has(n)`, both plain `Set`s, each
short-circuiting to *accounted for*. Nothing anywhere keys remote rows in a `Map` by name, so a
second row carrying the same name can only make a migration look **more** accounted for, never less
— `check-migrations.mjs` even documents the fallback in its own header ("`schema_migrations` is
matched by `name`"). And `migration-drift-check.yml`'s reporting step is titled, verbatim, *"Report
the database posture finding without withholding the deploy"*.
