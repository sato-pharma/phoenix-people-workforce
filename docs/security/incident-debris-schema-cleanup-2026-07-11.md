# Incident-Debris Schema Cleanup Plan (Production)

**Status: executed 2026-07-11**, after explicit owner approval. A full backup of all five
schemas' data was captured immediately beforehand (JSON export via a temporary SQL function,
retained locally). All five schemas confirmed dropped; `get_advisors` (security) re-checked
post-cleanup with no new findings — everything it reported was pre-existing and unrelated.

## Why this exists

While cloning production into a fresh staging project on 2026-07-11, five schemas were found on
production that aren't part of the live application (`src/lib/**` only ever reads `public.*`) and
appear to be leftover snapshots from past incident-response/cleanup work. None of this is
referenced by any migration, RPC, or application code.

## Inventory (captured 2026-07-11)

| Schema | Tables | Live rows (total) | Size (total) | Origin |
|---|---|---|---|---|
| `_cleanup_backup_20260621` | 8 | 2,231 | ~2.0 MB | 2026-06-21 notification/leave cleanup incident |
| `backup` | 1 | 13 | 32 kB | `leave_domain_backup_manifest` |
| `cleanup_backup` | 15 | 3,540 | ~1.5 MB | 2026-06-21 cleanup (job offers, marketing, probation, outstation, report-it) |
| `maintenance_backups` | 3 | 22 | ~40 kB | 2026-06-27 payroll test-fixture backups (`payroll_fixture_2099_*`) |
| `weekly_sales_backup_20260615` | 3 | 8,062 | ~3.7 MB | Pre-rebuild weekly-sales snapshot |

**Notable / worth the owner's own eyes:** `cleanup_backup.auth_users_pw_backup_20260705` (143 rows)
is a backup of password hashes. It duplicates data that already exists (in current form) in
`public.app_auth_users`; keeping an untouched historical copy around has no operational purpose and
is a real — if small — extra exposure surface.

Total footprint across all five schemas: ~7.3 MB, ~13,850 rows. Small; this is not a
storage-pressure cleanup, it's a housekeeping/exposure-reduction one.

## Mutation executed

A full JSON backup of all five schemas' data was taken immediately beforehand (via a temporary
`pg_temp` SQL function aggregating every table's rows), retained locally alongside this repo's
scratch files. Then:

```sql
DROP SCHEMA IF EXISTS _cleanup_backup_20260621 CASCADE;
DROP SCHEMA IF EXISTS backup CASCADE;
DROP SCHEMA IF EXISTS cleanup_backup CASCADE;
DROP SCHEMA IF EXISTS maintenance_backups CASCADE;
DROP SCHEMA IF EXISTS weekly_sales_backup_20260615 CASCADE;
```

## Verification

- Row counts on all five schemas are zero / schemas absent — confirmed: `select nspname from
  pg_namespace where nspname in (...)` returns no rows post-execution.
- Application smoke test unaffected — nothing read from these schemas before removal, so this is a
  no-visible-change verification by design.
- `get_advisors` (security) re-checked post-cleanup: all findings pre-existing and unrelated to
  this change (RLS-enabled-no-policy notices and function search-path warnings on live `public.*`
  objects, plus the standing leaked-password-protection notice). No new findings.

## Approval

Executed 2026-07-11 with the owner's explicit approval naming this document, per `AGENTS.md`.
