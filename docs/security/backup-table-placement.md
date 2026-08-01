# Where ad-hoc backup tables go

**Rule: a point-in-time snapshot never goes in `public`. It goes in its own dated schema.**

```sql
create schema if not exists <domain>_backup_YYYYMMDD;
revoke all on schema <domain>_backup_YYYYMMDD from anon, authenticated;

create table <domain>_backup_YYYYMMDD.<name> as
select ... from public.<source> where ...;
```

Enforced by `pnpm run check:sql-backups`, which runs as its own step in `ci.yml` and inside
`check:harden` locally. (CI invokes the individual checks, not `check:harden` — a check added
only to that script would never run in CI.)

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

- **Always flagged:** `backup`, `bak`, `undo`, `rollback`.
- **Flagged only with a date:** `snapshot`, `old`, `copy`, `tmp`, `temp`, `orig`, `prev` —
  because `public.sales_ops_dashboard_snapshot` is a real application table with a policy.

It does **not** see SQL run straight against a database through the Supabase MCP, `psql`, or
the dashboard SQL editor. That path is exactly how all three exposures above were created,
so the rule still has to be followed by hand there. The schema-shape monitor remains the
backstop for it, and `supabase/_migrations_archive/` is skipped as immutable history.
