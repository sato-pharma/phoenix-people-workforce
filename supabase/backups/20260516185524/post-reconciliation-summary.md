# Post-reconciliation summary

- Date: `2026-05-16`
- Active baseline migration: `20260517000000_remote_app_baseline.sql`
- Archived legacy migration directory: `supabase/migrations_legacy_prebaseline/20260516185524/`

## Remote migration ledger

- Archived pre-baseline versions were marked `reverted`.
- Baseline version `20260517000000` was marked `applied`.
- `npm run db:remote -- migration list` result:
  - local `20260517000000`
  - remote `20260517000000`

## Remote schema parity

- `npm run db:supabase -- remote db push --yes`
  - result: `Remote database is up to date.`

## Local bootstrap parity

- `npm run db:local -- start`
  - result: success
- `npm run db:supabase -- local db push --yes`
  - result: `Remote database is up to date.`
- `npm run db:local -- migration list`
  - result: local and remote baseline both `20260517000000`

## Critical row-count comparison

Pre- and post-reconciliation counts matched exactly:

| table_name | row_count |
| --- | ---: |
| app_auth_users | 129 |
| employee_resignations | 8 |
| employees | 149 |
| leave_notification_attempts | 0 |
| leave_request_events | 0 |
| leave_requests | 7 |
| payroll_resignation_candidates | 12 |
| user_access_profiles | 129 |
