# Where ad-hoc backup tables go

**Rule: a point-in-time snapshot never goes in `public`. It goes in its own dated schema.**

```sql
create schema if not exists <domain>_backup_YYYYMMDD;
revoke all on schema <domain>_backup_YYYYMMDD from anon, authenticated;

create table <domain>_backup_YYYYMMDD.<name> as
select ... from public.<source> where ...;
```

Enforced by `pnpm run check:sql-backups`, which runs as its own step in `ci.yml` and inside the
`ci` script. (CI invokes the individual checks, not the `ci` script — a check added only to that
script would never run in CI. `tests/ci-gate-parity.test.ts` pins that.)

## Why

`public` is the only schema PostgREST exposes, and Supabase's default privileges grant
`anon` SELECT on new tables created there. A table created in `public` is therefore
readable by anyone holding the **public anon key** — which ships in the browser bundle —
from the moment it exists until someone remembers to enable RLS on it.

Nothing about the word "backup" changes that. These tables are usually the *most* sensitive
thing in the database at that moment, because they are a raw pre-change copy taken without
the column filtering the live table has grown.

## What actually happened

Three of these shipped in three days, all readable with the anon key:

| Created | Table | Rows | Contents |
| --- | --- | --- | --- |
| 2026-07-30 | `public.email_backfill_backup_20260730` | 107 | `login_id`, `hr_id`, old + new email |
| 2026-08-01 | `public.crm_restamp_backup_20260801` | 1,542 | `agent_name`, `agent_hr_id`, `visit_date` |
| 2026-08-01 | `public.crm_restamp_checkins_backup_20260801` | 1,258 | `agent_hr_id`, `check_date` |

All three were closed by enabling RLS; the first was later dropped after export. The
schema-shape monitor found them — but only after they were live in production, on the next
scheduled drift-check run. **That is detection, not prevention**, and the allowlist in
`scripts/check-schema-shape.ts` grew from 2 entries to 4 in a single day keeping up with it.

## Why a dated schema and not "just enable RLS"

RLS is a second line, not the first one:

- **Placement is structural.** A schema `anon` has no `USAGE` on is unreachable through
  PostgREST regardless of table grants, RLS, or what anyone remembers to run afterwards.
- **RLS is a step you can forget** — and it was forgotten three times in three days. It is
  also easy to get *almost* right: RLS enabled with zero policies is deny-all for `anon`,
  but that same shape on a live table is a silent outage, so the monitor can only warn on
  it, never error.
- **The date is the expiry note.** `crm_restamp_backup_20260801` says when it was taken and
  therefore when it stopped being needed. `public.crm_restamp_backup` does not.

## Precedent

This is already the house pattern — the SoS work used it on 2026-07-28 and none of those
41 tables were ever exposed:

```
sos_backup_20260728          11 tables
sos_merge_undo_20260728      20 tables
sos_master_backup_20260728    6 tables
sos_mapping_backup_20260728   4 tables
```

Verified 2026-08-01: every one of these has `anon` USAGE = false and `authenticated`
USAGE = false, as do `au`, `_au_rollback`, and `internal`. Creating a schema grants nothing
to those roles by default — the explicit `revoke` above is belt-and-braces, and documents
the intent for whoever reads it next.

## Cleaning up

Dropping the snapshot is the real end state; a sealed schema is safe storage, not a reason
to keep it forever. Export first if the data has any audit value, then:

```sql
drop schema <domain>_backup_YYYYMMDD cascade;
```

## What the check does and does not catch

`scripts/check-sql-backup-placement.ts` scans `supabase/**/*.sql` for `CREATE TABLE`
targeting `public` with a snapshot-shaped name. It uses two tiers, because one word list
cannot separate a snapshot from a live table:

- **Always flagged:** `backup`, `backups`, `bak`, `undo`, `rollback`.
- **Flagged only with a date:** `snapshot`, `old`, `copy`, `tmp`, `temp`, `orig`, `prev`,
  `pre` — because `public.sales_ops_dashboard_snapshot` is a real application table with a
  policy, and `early_birds_period_snapshots`, `sos_import_coverage_snapshots` and
  `field_workforce_compliance_live_snapshots` are live tables today whose content happens to
  be snapshots. None carries a date, so none matches.

`pre` joined the weak tier on 2026-08-30, and the reason is worth keeping: of the five
snapshots found in production `public` that day, the two named `zz_backup_…` matched on the
strong tier and the three named `…_20260829_pre` matched nothing at all. A rule that caught
two fifths of the real cases had been reading as a rule that worked.

The two tiers are defined once, in `scripts/lib/snapshot-name.ts`, and imported by both
checks below. `tests/schema-shape-snapshot-in-public.test.ts` asserts the SQL and TypeScript
forms still agree, because a divergence is invisible in every other way — each side would go
on passing its own tests while enforcing a different definition of "snapshot".

It does **not** see SQL run straight against a database through the Supabase MCP, `psql`, or
the dashboard SQL editor — and that path is how every exposure on this page was created.
`supabase/_migrations_archive/` is skipped as immutable history.

So since 2026-08-30 the database is asked directly as well. `phx_ci_snapshot_tables_in_public()`
applies the same two tiers to `pg_class`, and `scripts/check-schema-shape.ts` reads it on every
run of the daily Migration Drift Check, against staging and production independently. A snapshot
in `public` is now named the day it appears, however it got there, and the finding says which
browser-facing role can read it — the difference between "tidy this up" and "act now".

That replaces a backstop that only worked by accident. `missing_primary_key` did surface these
tables, but for a reason unrelated to being a snapshot: a `create table ... as select` happens
to carry no primary key. It therefore arrived late, said the wrong thing — "this table has no
primary key" invites adding one — and was silenceable by the wrong fix. Two migrations on
2026-08-27 did exactly that, clearing the error while leaving every table in `public`, reported
by nothing at all.

A target that predates the migration returns an error the script reads as "gate not deployed
yet" and stays quiet, so the two databases can be migrated independently.
