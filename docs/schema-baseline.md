# The production schema baseline

`supabase/schema/production.sql` is what production's database structure **is**, written down: a
schema-only `pg_dump` of production's application schemas, committed. Before it existed, nothing in the
repository could answer that question. The migration folder records the changes that were made through a
file, but not the ones made by hand, and it cannot rebuild production from nothing (enterprise audit
2026-11-13, REC-041 / F-DB-010).

## What is in it

- The six schemas the application owns: `public`, `au`, `private`, `analytics`, `recovery`, `internal`.
  Supabase's own schemas (`auth`, `storage`, `realtime`, `vault`, `cron`, `extensions`, `graphql`) are
  left out because Supabase builds them itself. The dated snapshot schemas are left out because they are
  data, not structure, and they are being dropped (REC-040).
- Structure only: tables, columns, constraints, indexes, functions, views, triggers, policies, grants,
  comments. **Never a row of data**: `--schema-only`, and the test refuses a `COPY` or `INSERT`.
- First written 13 Nov 2026: 4.59 MB, 7,944 objects.

## Normalised so that "no change" means byte-identical

Two dumps of an unchanged database differ in three ways that are not schema, and
`scripts/lib/schema-baseline.mjs` removes exactly those:

- pg_dump 18 writes a `\restrict <key>` / `\unrestrict <key>` pair with a **random key on every run**;
- it stamps the server and client versions (`-- Dumped from` / `-- Dumped by`);
- on Windows, a pg_dump piped through stdout writes CRLF line endings, which is why the script always
  writes with `-f`.

Measured: a dump compared with itself after normalising shows 0 differences, and a second dump of
production minutes later showed 0 of 7,944 objects different.

**pg_dump's major version is pinned to 18** (`PG_DUMP_MAJOR`). A different major prints a different
preamble and the whole file would read as drift. The laptop's pg_dump is 18.4, and the nightly runner uses
the `postgres:18.4-alpine` image.

## Refresh it after every migration applied to production

```bash
node scripts/schema-baseline.mjs --write
```

Commit the refreshed file in the same pull request as the migration. It needs a production database URL:
`DATABASE_URL`, else `PHOENIX_PRODUCTION_DATABASE_URL`, else `SUPABASE_DB_URL` in `.env.local` (the
primary checkout and every worktree already have that). The script refuses any URL that does not name the
production project. On the home network a dump can hang while connecting; the script gives up after 240
seconds, so run it again rather than diagnosing.

## The nightly check

`migration-drift-check.yml` runs `pnpm run check:schema-baseline` in its leg **Check schema baseline
(production)**. It dumps production again and compares it with the committed file, object by object,
using the table-of-contents comment pg_dump writes above every object (`-- Name: …; Type: …; Schema: …`).

| What it finds | Verdict |
| --- | --- |
| No difference | green |
| Differences, every one named by a migration added to `main` since the baseline was last written | green, with a `::warning::` saying the baseline is behind. Refresh it. |
| A difference that no such migration names | **red**: a change made by hand, or a migration applied to production whose pull request has not merged |
| The dump could not run (no URL, wrong pg_dump, a timeout) | **red**: nothing measured is never a pass |

"Named" is a plain text match: the object's own name (a function without its argument list, a constraint
without its table) must appear in one of those migration files. A name of two letters or fewer never
counts, because it appears in every file.

The leg runs on production only, like the advisor leg, and only when the repository has the
`PHOENIX_PRODUCTION_DATABASE_URL` secret; without it the run prints a warning that production was not
compared. A red leg reaches the run's report, the Telegram alarm and the run's own verdict.

**The runner has no IPv6, and production's direct host `db.<ref>.supabase.co` has only an IPv6 address.**
The first run from GitHub on 13 Nov 2026 failed with `Network unreachable`. The script therefore
rewrites a direct URL to production's IPv4 session pooler, `aws-1-eu-central-1.pooler.supabase.com:5432`
(aws-1, not the aws-0 the staging tools assume), before pg_dump runs. `SCHEMA_BASELINE_POOLER_HOST`
overrides it if production ever moves.

## What it does not do yet

- **It does not prove that a fresh database built from this file matches production.** That needs a
  scratch Postgres with Supabase's roles and extensions (the `supabase/postgres` image), and it is the next
  step for REC-041.
- The 63 SQL files that live outside the migration folder (F-ENG-016) and the `summarize-thread` edge
  function's missing source (F-DB-013) are separate findings.

## Files

- `scripts/lib/schema-baseline.mjs`: the pure half (normalising, splitting into objects, comparing,
  explaining).
- `scripts/schema-baseline.mjs`: the command (`--write`, `--check`).
- `tests/schema-baseline.test.ts`: pins the normalising, the comparison, the committed file and the
  nightly wiring.
