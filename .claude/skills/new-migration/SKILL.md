---
name: new-migration
description: Write and apply a Supabase migration in this repo, end to end. Use when a change needs a new table, column, index, view, function, RPC, grant, policy or a data backfill — and when a migration has been written and needs applying or verifying. Mints a collision-free timestamp, pre-flights the four content rules that fail the required validate job, applies to staging then production with the project ref printed, and verifies against pg_class/pg_proc rather than the migration ledger, which lies. CI never sees a migration, so this is the only gate it gets.
argument-hint: '[what the migration does, e.g. add a weekly_review_day column]'
---

# Ship a migration

**A migration is one of the two things CI never checks** (the other is a production deploy). The
required `validate` job reads the *files*; nothing in it touches a database. So the verification in
phases 3, 5 and 7 is not ceremony — it is the entire gate.

Run the phases in order. Phase 6 is the only one that needs the owner's word, and only when the
change is destructive or bulk.

## Phase 0 — be in the right tree

Concurrent sessions share the primary checkout and clobber each other's uncommitted edits. Never
author a migration in the primary while another session is live in it:

```bash
node scripts/new-session.mjs <task>
```

That creates `_wt-<task>` on `codex/<task>` from the latest `origin/main`, junctions
`node_modules` and copies the env files. Inside a worktree invoke node directly — **never `pnpm`**,
which purges the primary's `node_modules` that the worktree's junction points at.

## Phase 1 — mint the file

```bash
node .claude/skills/new-migration/new-migration.mjs --name add_weekly_review_day
```

Two failures this removes, only one of which CI can see:

- **A duplicate 14-digit timestamp fails `validate`.** With 535 files, two sessions authoring an
  hour apart collide more often than it sounds — and the duplicate only exists once BOTH are on
  `main`, so neither pull request could have caught it.
- **A timestamp that merely sorts EARLIER than a migration already on `main` fails nothing at
  all.** It just applies in the wrong order, against a database whose state it did not expect, for
  good. The script takes the greater of Cairo and UTC wall clock — this directory holds both,
  because the Supabase CLI stamps UTC and a hand-written file usually carries the local hour — and
  then bumps until it sorts after every file on disk.

## Phase 2 — write the SQL

Fill in WHAT / WHY / ROLLBACK at the top. Then the rules, all four of which are enforced
mechanically and two of which fail the required `validate` job:

| Rule | Level | What it costs when it goes wrong |
| --- | --- | --- |
| A public `SECURITY DEFINER` function must `revoke execute ... from public, anon, authenticated`, then re-grant to `service_role` | **fails CI** | anon and authenticated inherit EXECUTE through PUBLIC membership, so revoking only those two is a no-op and the function is callable with the key that ships in the browser bundle |
| Never `alter default privileges ... in schema public grant ... to anon` or `authenticated` | **fails CI** | the exact statement behind the 2026-08-06 exposure — 412 customer names readable with the public anon key for two days. Every table created afterwards is born readable; no existing table changes, so nothing else notices |
| A snapshot table goes in `<domain>_backup_YYYYMMDD`, never in `public` | **fails CI** | `public` is the one schema PostgREST exposes, and Supabase grants anon SELECT on new tables there |
| `DROP TABLE` / `TRUNCATE` wants `-- SAFE: <reason>` | warns | the annotation is how the next reader knows the loss was intended |

Two more that no checker can catch for you:

- **Grant on the specific table and enable RLS on it** when browser roles need to read it. Bear in
  mind that visibility in this app is application-scoped, not RLS-scoped: most code paths use the
  service-role client, so an RLS policy alone protects nothing that the app itself hands out.
- **Never patch production by hand.** Every schema change is a migration file, repeatable and
  reviewable, or it does not exist.

## Phase 3 — pre-flight, before anything is applied

```bash
node .claude/skills/new-migration/new-migration.mjs --audit supabase/migrations/<file>.sql
```

```bash
node scripts/check-migrations.mjs
```

```bash
node --experimental-strip-types --experimental-specifier-resolution=node scripts/check-sql-backup-placement.ts
```

The first is a fast read of the one new file; the other two are the checkers CI itself runs, over
the whole directory, and they are the authority. **Where the pre-flight and a checker disagree, the
checker is right and the pre-flight is the bug** — say so and fix it rather than reasoning past it.

## Phase 4 — staging first

Print the project ref before every database call and resolve it with `list_projects`, never from a
ref pasted in a prompt:

- staging `cifwmndunmlxjhyjugxa` — Phoenix-HR-Staging
- production `ozucdzovmcqvepbozvqf` — Phoenix HR, real payroll data

Apply with `apply_migration` on the **staging** ref, passing the same SQL as the file. Supabase
writes are pre-authorized end to end here, so no approval prompt is coming and none is needed —
but that is exactly why the ref is printed and read back before the call. The server's name
guarantees nothing; the `project_id` argument is the only thing separating the two.

Staging is a real clone with real auth accounts and real payroll, so it is not demo-safe, and
**storage files do not clone** — objects 404 there. It also cannot rehearse a production shape.

## Phase 5 — verify on staging, against the catalog

**`list_migrations` reports the ledger, not reality.** A row there proves a version string was
stamped, not that your table exists. Ask the catalog:

```sql
select relname, relrowsecurity from pg_class where relname = '<table>';
select proname, prosecdef from pg_proc where proname = '<function>';
select grantee, privilege_type from information_schema.role_table_grants where table_name = '<table>';
```

For a function, read `prosecdef` and the ACL — proving the REVOKE landed is the point of phase 2's
first rule. For a backfill, count the rows the migration claims to have written.

## Phase 6 — production

Supabase writes on production are pre-authorized too, with one standing condition:

> **Announce any destructive or bulk production change in plain words before you run it, and give
> the owner a chance to stop it.**

Say what it touches, how many rows, and what cannot be undone. **Production has no point-in-time
recovery — 7 daily backups are the whole recovery story**, and a daily backup is never restored in
place. For anything destructive or bulk, take the pre-image FIRST, into its own dated schema
(`<domain>_backup_YYYYMMDD`, never `public`), and prove it landed by counting it before you
proceed.

Then `apply_migration` on `ozucdzovmcqvepbozvqf`.

## Phase 7 — verify production the same way

Re-run phase 5's catalog queries against the production ref. A deploy applies no migrations and a
merged pull request is not an applied migration: the only proof is the row, the relation or the
function in `pg_class` / `pg_proc`.

If the change is read by the app, also confirm the app sees it — a missing table answers PGRST205
through PostgREST, not 42P01.

Then refresh the production schema baseline and commit it with the migration:

```bash
node scripts/schema-baseline.mjs --write
```

The nightly Migration Drift Check compares production with `supabase/schema/production.sql`; a
change no migration on `main` names turns it red. Account: `docs/schema-baseline.md`.

## Phase 8 — commit, push, open the pull request

Automatic, no approval needed: branch first, stage only the migration and the files that belong to
it, conventional message (`feat(db): …` / `fix(db): …`). The required checks are `validate` and
`checks` — read them live from branch protection rather than from this line, which has been wrong
three times. `secret-scan` is not among them and does not run on a pull request at all (off
`pull_request` since 2026-09-29), so do not wait for it.
**Merging needs the owner's separate approval** — never `gh pr merge --auto`.

Remember that CI is grading the file, not the database. A green pull request on a migration that
was never applied is green about nothing.

## Phase 9 — what to report

- the file, and the timestamp it was given
- the pre-flight and both checkers' verdicts
- for each environment: the project ref, that `apply_migration` returned, and the **catalog** line
  that proves the object exists
- the pre-image, if one was taken, with its row count
- what cannot be undone

## Rollback

Write the rollback statement into the file's header before applying, not after. If the change
cannot be undone — a dropped column, a coerced type, a deleted row — say that in the header and in
the announcement, and take the pre-image. Reverting the pull request does not reverse an applied
migration: only another migration does.
