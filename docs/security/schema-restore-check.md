# The schema restore check

Every Monday a GitHub Actions job rebuilds production's database structure from nothing, using only
`supabase/schema/production.sql`. It then checks that what it built is production, object for object.
This is the rebuild half of REC-041 (enterprise audit 2026-11-13). The other half, the nightly comparison of
the file with production, is in [docs/schema-baseline.md](../schema-baseline.md).

## Why it exists

**Production has no point-in-time recovery.** Seven daily backups are the whole recovery story (AGENTS.md
§2.3). On the day they are not enough, the baseline file is how the database's structure comes back. The
nightly check proves the file still **describes** production. Nothing proved that it **loads**. A file
that describes everything but cannot be loaded would only be found out on the worst possible day.

## What it does

`.github/workflows/schema-restore-check.yml`, job **restore**, runs
`node scripts/schema-baseline.mjs --restore-check` against a throwaway `supabase/postgres` service
container:

1. **It refuses any target that is not a throwaway database on the runner itself.** `assertScratchUrl`
   allows only `127.0.0.1`, `localhost` or `::1`, and refuses any URL that names the production project.
   It also refuses a database that already holds one of the baseline's schemas, or anything in `public`.
   The restore job reads no secret and has no database URL except its own container's.
2. **It runs production's own Postgres major.** Production is 17.6.1.141 (`list_projects`, 19 Nov 2026),
   and the image is `supabase/postgres:17.6.1.141`. The script checks the server's major against
   `RESTORE_PG_MAJOR`, and the test pins the image to the same major. When Supabase upgrades production,
   move both.
3. **It adds what `pg_dump -n` never carries.** This is the prelude, `restorePrelude`, and it is part of
   the rebuild procedure, not a test convenience:
   - **Roles.** Roles belong to the cluster, not the database, so a dump never creates them. The script
     reads every role the file makes an owner, grants to, or names in a policy (`rolesNamedIn`). It
     creates the ones the image lacks as `NOLOGIN`, with no password. Production's own roles
     (`analytics_readonly`, `analytics_privileged`, `metabase`, `release_gate_writer`) are the ones
     created this way.
   - **Extensions.** The file uses `pg_trgm` (`extensions.gin_trgm_ops`, `extensions.similarity`) and
     `pg_stat_statements`. `PRODUCTION_EXTENSIONS` lists production's six, in production's schemas. A
     migration that starts using a new extension turns this check red until it is added there.
   - **Empty default privileges.** `pg_dump` writes each object's grants on the assumption that the
     object was created with the built-in privileges and nothing more. It never revokes what a default
     privilege added. A Supabase database is born with default privileges that grant ALL on every new
     table, sequence and function in `public` to `anon` and `authenticated`, and production itself still
     carries `supabase_admin`'s (see the baseline's DEFAULT ACL objects). Restored over them, every table
     would come back writable by the browser roles that PR 562 took away. The prelude therefore clears
     them first (`CLEAR_DEFAULT_PRIVILEGES`). The file's own DEFAULT ACL objects, which `pg_dump` writes
     last, then put back exactly production's once every object exists.
4. **It restores the file with `psql`.** The only change to the file is that `CREATE SCHEMA public;`
   becomes `CREATE SCHEMA IF NOT EXISTS public;`, because every Supabase database already has `public`.
   The line count stays the same, so a psql error's line number is the file's own. Every error is
   collected, not just the first, so one run names everything a rebuild would trip on.
5. **It dumps the restored database and compares.** The dump uses the same pinned `pg_dump` image
   (`postgres:18.4-alpine`), the same `normalizeDump` and the same `compareDumps` as the nightly check. It
   is one set of rules, never a second copy. For each object that differs, the run log prints the lines
   only one side has.
6. **It recognises one change that is not a difference: Postgres's own brackets.** Postgres builds some
   expressions nested: `x BETWEEN 1 AND 10` becomes an AND, and a row-wise `IS DISTINCT FROM` becomes a
   chain of ORs. `pg_dump` writes them with their brackets, for example `((a AND b) AND c)`. When the
   restore parses that text again, the parser folds a left operand that is the same kind of chain into
   one, giving `(a AND b AND c)`. It is the same expression in different text. `flattenBooleanChains`
   folds exactly that, outside quotes and only on the leftmost operand, as the parser does. A right-nested
   chain or a mixed AND/OR is never folded, so a change of meaning cannot be hidden. Such objects are
   listed on the run's page and are not counted as differences.

| What it finds | Verdict |
| --- | --- |
| No restore error, and the restored database dumps to the file's objects | green |
| Objects that come back with only Postgres's own brackets folded (the same expression) | green, listed |
| Any restore error | **red** |
| Any object missing, added or different after the restore | **red** |
| The check could not run (wrong major, a database that is not fresh, the prelude failed, a timeout) | **red**: nothing measured is never a pass |

## After a real rebuild

Run the prelude, then the file, exactly as the check does. Then:

1. **Put back production's global default privileges.** `pg_dump -n` writes only schema-scoped ones (the
   baseline holds 7, every one naming a schema), never a global one. Production has one: migration
   `20261113194017` makes a new function executable by its owner and `service_role` only. Every function
   in the file already carries its own grants, so nothing restored is affected, but without that
   migration a function created after the rebuild would be executable by everyone. Re-run its two
   statements (`alter default privileges for role postgres revoke execute on functions from public;` and
   `… grant execute on functions to service_role;`).
2. **Refresh the baseline** (`node scripts/schema-baseline.mjs --write`). The rebuilt database holds the folded form of the
re-bracketed expressions, while the committed file still holds production's old brackets. Without a
refresh, the nightly drift check would report them as changes that no migration explains. On 19 Nov 2026
there were 11 such objects: 10 CHECK constraints and 1 trigger `WHEN`.

A red run sends a Telegram alert from job **notify**: the same bot and chat as every scheduled alarm, read
in the main-only `main-secrets` environment. The alert quotes the counts and the first restore error, and
says how many weekly runs in a row have been red. Each run's summary page lists the errors and the
differing objects. A dispatch with `test_alert` ticked sends a self-test alert and skips the restore.

## When it runs

- **Weekly, Mondays 04:30 UTC (06:30 Cairo).** The file changes when a migration is applied and the
  baseline refreshed, a few times a week, so a weekly rebuild is enough.
- **On a push to `main` that changes the check itself** (the workflow or `scripts/schema-baseline.mjs` and
  its library). Production's workflow watch (`phoenix-github-workflow-watch`) reads each scheduled check's
  last success on `main` and alerts once a day while there is none. So merging the check also records its
  first success, instead of raising "no success on record" every morning until the first Monday.
- **By hand:** `gh workflow run schema-restore-check.yml`.
- **Never on a pull request.**

## What it costs

The repository is public, and GitHub does not bill a public repository's standard-runner minutes. The
restore job runs on GitHub's own runner (`# hosted-only:`, because it needs Docker for the service
container and the pinned `pg_dump` image), and the notify job runs only on a failure.

Measured on 19 Nov 2026 (run 44443204241): **48 seconds** a run, of which 6 seconds restoring and 1 second
dumping; the rest is starting the containers. **0 minutes billed.** On a private plan it would bill 1 minute
a week. The ceiling counts a weekly cron as one run a day, so `SCHEDULED_RUNS_CEILING` in
`tests/github-workflow-validity.test.ts` went from 62 to 63, with this measurement in its dated note.
`CI_JOBS_BY_EVENT` (`tests/ci-runner-switch.test.ts`) is not changed: it prices only `ci.yml`'s three
events, and its test reads the job list from `ci.yml` itself.

## First runs (19 Nov 2026)

| Run | Restore errors | Objects back | Differences | Note |
| --- | ---: | ---: | ---: | --- |
| 44442413703 | 0 | 8,054 of 8,054 | 11 | Every role, extension and default privilege the prelude adds was enough: nothing failed to load. |
| 44442738138 | 0 | 8,054 of 8,054 | 11 | The line diff showed all 11 were Postgres's own brackets (10 CHECK constraints, 1 trigger `WHEN`). |
| 44443204241 | 0 | 8,054 of 8,054 | 0 | Green; the 11 listed as the same expression. |
| 44443489815 | 0 | 8,054 of 8,054 | 0 | The dispatch on the pull request's head `6c7bc227b`: green in 51 seconds (restore job 46 s), notify skipped. |

## Running it locally

Only against a throwaway database. With the Supabase CLI's local stack (Postgres 17):

```powershell
$env:SCHEMA_RESTORE_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'; node scripts/schema-baseline.mjs --restore-check
```

`psql` and `pg_dump` 18 must be on PATH, or set `SCHEMA_BASELINE_DOCKER=1` to use the pinned image. A
stack that already holds the application's schemas is refused as not fresh, so reset it first.

## Files

- `scripts/lib/schema-baseline.mjs`: the pure parts (`RESTORE_PG_MAJOR`, `PRODUCTION_EXTENSIONS`,
  `rolesNamedIn`, `restorePrelude`, `CLEAR_DEFAULT_PRIVILEGES`, `restorableBaseline`, `freshnessQuery`,
  `assertScratchUrl`, `flattenBooleanChains`, `objectLineDiff`).
- `scripts/schema-baseline.mjs`: the command, `--restore-check`.
- `.github/workflows/schema-restore-check.yml`: the weekly job and its alarm.
- `tests/schema-baseline.test.ts`: pins the helpers, the committed file's roles, the image's major and the
  workflow's wiring.
