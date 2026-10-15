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

### The standing route when the MCP refuses a migration

**The account of the owner's decision of 15 October 2026.** The rule itself is
`.claude/rules/database.md`, "The migration ledger", and the grant it widened is AGENTS.md §8. This
section is the evidence behind both.

**His words, in session:** *"make apply-sql-file.mjs the standing route when the MCP refuses a
migration"*, then *"edit AGENTS.md §8 to add apply-sql-file.mjs and commit the rule"*. It reverses
the correction made on 2026-10-08, which had required his explicit word for each individual
migration, and it settles a question two sessions had escalated to him on the same day.

#### What the refusal actually is

Both doors §8 pre-authorizes — `mcp__supabase-production__apply_migration` and the account connector
`mcp__b345e47e-…` — put the file's whole text through a destructive-SQL classifier that reads the
string, not the statements it would execute. So a plain `create or replace function` is refused
whenever the function **body** happens to contain a `delete from …` or a `drop table if exists
pg_temp.…`, which a refresh function legitimately does. The refusal is therefore about the shape of
the text, not about the change being dangerous, and it recurs for a whole class of migration.

Measured twice on 15 October 2026:

| migration | what the doors answered |
| --- | --- |
| `20261015132445_contact_refresh_reads_the_customer_table_once.sql` | `{"status":"declined"}` from the production MCP; `MCP error -32600: You do not have permission to perform this action` from the connector that had just applied the same SQL to staging |
| `20261015164459_marketing_resubmit_audit_id_uses_stored_requester.sql` | the same, used by another session hours earlier and already recorded in `ACKNOWLEDGED_EXCEPTIONS` |

**The cost of the old per-migration rule, measured.** PR #5923 merged while its migration was still
unapplied, because the session that wrote it correctly read the route as needing his word and stopped
there. For roughly four hours production served `main`'s code — which documents a one-read fix — over
the **old two-read body**, so the hourly doctor-list refresh stayed able to abort for the whole
company whenever a rep added a doctor mid-run (`23503` on `crm_contact_assignments`, eight
`scheduled_job_stranded` alerts since 25 September). The gap closed only when the file was applied by
hand at 20:14 Cairo.

#### The route

Production is on aws-1, and the script's default aws-0 answers `Tenant or user not found`, which
reads like a bad password rather than a wrong region:

```
PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com node scripts/apply-sql-file.mjs <file.sql> production
```

#### It writes no ledger row, so the apply is not finished until it is proven and recorded

`apply-sql-file.mjs` prints `{"applied":true}` and never touches
`supabase_migrations.schema_migrations`. Finish with a digest and an evidenced entry in
`ACKNOWLEDGED_EXCEPTIONS` (`scripts/lib/migration-inventory.ts`), carrying `md5(pg_proc.prosrc)` read
off the target project against md5 of the file's own dollar-quoted body, plus the pre-image digest —
because `create or replace` means object **presence** proves nothing: an older generation satisfies a
catalog probe exactly as well as the current one. **Never answer the missing row with a ledger
write,** and never with a presence probe. `tests/migration-exception-staleness.test.ts` holds the
list in the required `validate` job.

Worked example, the 15 October apply:

| | reading on `ozucdzovmcqvepbozvqf` |
| --- | --- |
| `md5(pg_proc.prosrc)` for `public.crm_contact_master_refresh` after the apply | `7194a3929cef15051f541d5bab6ee875` |
| md5 of that migration file's own body | `7194a3929cef15051f541d5bab6ee875` |
| pre-image, equal to `20261012184500`'s own body — hence the one-command rollback | `34220e8603660375d75fb06bb58d116e` |
| `prosecdef` / `proconfig` | `false` / `{search_path=public}`, unchanged |
| ledger rows carrying that version or name | 0 |

#### What the decision does not change

§8's one standing condition stands: **announce a destructive or bulk production change in plain words
first and give the owner a chance to stop it.** Staging was always pre-approved. Creating or deleting
a project, and reading secrets, remain outside the grant. And the route is for a migration the MCP
**refuses** — the MCP remains the first door, because a row it records is itself evidence the SQL ran.

### The 15 October production sweep — eight findings, zero unapplied

**The owner's words, in session:** *"sweep production for merged migrations never applied"*, sent the
same evening he made `apply-sql-file.mjs` the standing route, then *"sweep staging too and widen the
held branch"*.

The repository already implements the sweep —
`node --experimental-strip-types scripts/check-migrations-applied.ts`, pointed at whichever project
`NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` name, which is what
`.github/workflows/migration-drift-check.yml` drives daily at 07:00 UTC against both databases. Run
against production (`ozucdzovmcqvepbozvqf`) it read **884 local migrations, 1,334 ledger rows** and
named four files merged to `main` and absent from `supabase_migrations.schema_migrations` by both
version and name:

| file | what the catalog actually held |
| --- | --- |
| `20261012090000_phoenix_crm_door_name_fold_and_place_cap.sql` | applied — `phoenix_crm_rename_customer` md5-equal, this file its last definer |
| `20261012132430_daily_deductions_per_line_release.sql` | applied — four new columns present, three functions equal once CRLF and stripped comments are allowed for |
| `20261012200000_phoenix_crm_a_doctor_is_on_a_seat_once.sql` | applied — three functions md5-equal as-is, trigger present and enabled |
| `20261013010000_drop_v_active_organogram.sql` | applied — zero relations named `v_active_organogram` at any relkind |

**All four were already live. Nothing on production is unapplied**, and the four entries now in
`ACKNOWLEDGED_EXCEPTIONS` carry that evidence. The daily check had been reporting them since 14
October, concluding `success` each time because every leg carries `continue-on-error` — so the
report sat unread rather than red.

🔴 **The finding class is the one the standing route above creates.** A hand-apply runs the SQL and
writes no ledger row, so this check cannot distinguish *applied by hand* from *never applied*, and
after 15 October the first is the likelier of the two. The check's own closing advice now says so
instead of telling the reader to take the files to the owner.

🔴 **Two of the four would have read as drift to a raw digest comparison.** Production's `prosrc` for
the deduction functions carries **CRLF** line endings, and two of the three arrived with every
full-line `--` comment removed. Compare the file's dollar-quoted body in four shapes — as-is LF,
as-is CRLF, comment-stripped LF, comment-stripped CRLF — and read the length delta first: 4,102
against 4,191 characters is a normalisation, not a different generation of the logic. The rule lives
in `.claude/rules/database.md`, "The migration ledger".

#### The grace window hid four more, and a sweep has to stand it down

The daily check ignores anything merged inside `GRACE_WINDOW_MS` (48 hours), which is right for a
nightly job — a PR's own migration is *supposed* to read unapplied at review time — and wrong for a
sweep. A second pass — then a hand-written one, now **`pnpm run check:migrations-swept`** (and
`check:migrations-swept-staging` for the other database), which is this script with `--no-grace`
and optionally `--staging`, added at the owner's instruction the same evening ("add a --no-grace
flag to check-migrations-applied so a sweep is one command"). An unknown flag is refused before any
connection opens, so a typo can never report the narrow run as the wide one or point it at the wrong
project. It reads its credentials from the process environment first and then from
`.env.staging.rls.local`, `.env.production.rls.local`, `.env.local` — the same order
`apply-sql-file.mjs` uses — because the first shell run of it died on `NEXT_PUBLIC_SUPABASE_URL /
SUPABASE_SERVICE_ROLE_KEY not set`: it had been written for CI, where the workflow passes each leg's
pair explicitly. 🔴 **The environment always wins over a file**, or a file in the checkout could
redirect a CI leg at the other project, and the run prints which name came from which source and
never the value. That pass named **four more
production files**, as many again as the check itself reported:

| file | what production actually held |
| --- | --- |
| `20261014140000_marketing_resubmit_atomic.sql` | **superseded.** Its body digests `ed5ab6fe…` in its **CRLF** shape — exactly the pre-image recorded for `phx_resubmit_marketing_request` before the 20261015164459 apply, so it ran, in CRLF, and was replaced that evening. Re-applying it would revert the stored-requester fix. |
| `20261015012551_direct_order_marketing_offsets.sql` | `direct_order_marketing_offsets` present with RLS on and all three indexes; both functions md5-equal as-is |
| `20261015012552_finance_command_center_offset_requests_need_no_proof.sql` | `phx_finance_command_center` md5-equal as-is at 15,028 chars |
| `20261015020803_admin_settle_service_fee_request.sql` | `phx_admin_settle_service_fee` md5-equal as-is at 7,679 chars |

Three of those four are the money path from #5918 and #5921, merged around 02:00 Cairo that morning.
All four are live. **Eight files, zero unapplied.**

#### Staging

`cifwmndunmlxjhyjugxa`: **884 local migrations, 1,350 ledger rows, nothing unaccounted** — with the
grace window on and with it off. Staging is applied automatically by
`.github/workflows/staging-migrate.yml`, and it carries real rows under each file's own version for
all eight files above.

🔴 **`ACKNOWLEDGED_EXCEPTIONS` is project-agnostic**, so an entry justified on production silences
the same file on staging. Each of the eight was therefore checked against staging's own ledger
before being added, and removing all eight again leaves staging green — proven by re-running that
leg with the entries stripped.

#### The daily workflow now runs the staging sweep too

At the owner's instruction ("add the staging ledger-gap sweep to the daily drift-check workflow")
`.github/workflows/migration-drift-check.yml` has a second staging migrations leg,
`migrations_staging_sweep`, running `check:migrations-swept` against staging with the grace window
down. It sits beside the existing grace-window leg rather than replacing it, because the pair says
something neither says alone: the old leg failing means a gap **older than 48 hours**, the new one
failing while the old one passes means a gap **younger than 48 hours** — and on staging, which
`staging-migrate.yml` applies automatically on every merge, any gap at all is a broken automation.

It is **staging only, deliberately.** Production has no automation, and a hand-apply through the
standing route writes no ledger row, so a no-grace production leg would raise a finding for every one
of those inside the hour it was applied. `tests/migration-drift-check-flags.test.ts` pins that the
leg points at staging and never at production.

🔴 **It can lie in exactly one way, a race.** A cron run that fires in the minutes between a merge and
`staging-migrate.yml` recording it reads that migration as a gap. The schedule is 07:00 UTC, ten in
the morning in Cairo, so it needs a merge just before; re-run the workflow before acting on a lone
sweep failure on a database that proves clean. And 🔴 **a new leg must join BOTH outcome gates** —
the job-summary report and the Telegram alert — because every leg is `continue-on-error`, so those
two conditions are the only thing that turns a finding into a message. The same test pins that for
every leg, which is the 2026-08-06 incident (three days, 412 exposed customer names) one edit away.

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
