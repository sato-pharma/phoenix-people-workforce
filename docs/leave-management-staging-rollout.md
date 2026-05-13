# Leave Management Staging Rollout

This rollout is for staging only. Do not run these steps against production.

Supabase notes: tables created through SQL in `public` must have Row Level Security enabled and explicit least-privilege grants for Data API roles. The leave rebuild migration enables RLS and grants only the needed access for `authenticated` plus full server-side `service_role` access.

## Files

- Source backup SQL: `supabase/20260512_backup_leave_domain_before_rebuild.sql`
- Source leave rebuild SQL: `supabase/20260512_leave_management_engine.sql`
- Official Supabase backup migration: `supabase/migrations/20260512235939_backup_leave_domain_before_rebuild.sql`
- Official Supabase leave rebuild migration: `supabase/migrations/20260512235948_leave_management_engine.sql`

## Preconditions

- Confirm the target database is staging, dev, test, or local. Never use production values.
- Confirm the linked Supabase project ref is the staging project.
- Confirm the current app build passes locally.
- Confirm staging can be restored from a full database backup if the leave-domain backup is not enough.
- Confirm the Supabase CLI is authenticated and linked with `supabase link --project-ref <staging-project-ref>`.
- Do not use dbmate, psql, the Supabase SQL editor, or manual SQL for this rollout.

## Rollout Checklist

1. Backup old leave/vacation tables.
2. Check old leave/vacation tables before and after the backup.
3. Check backup tables and manifest.
4. Verify required private functions exist.
5. Dry-run the official Supabase migrations.
6. Apply the official Supabase migrations only after the dry run and migration list are reviewed.
7. Verify new leave tables exist.
8. Verify seed leave policy.
9. Verify seed leave types.
10. Verify public holidays.
11. Verify permissions and RLS.
12. Run app validation commands.
13. Run the app against staging.
14. Test `/employee-portals/leave`.
15. Test `/employee-portals/leave-approvals`.
16. Test `/admin/leave`.
17. Confirm old `/api/vacation` routes are gone.
18. Run the manual workflow checklist.
19. Record backup manifest table names in the rollout notes.

## Official Supabase CLI Rollout

This project now uses the official Supabase CLI migration flow only. The previous dbmate/psql rollout path is superseded for this leave rebuild.

Remote migration history was reconciled locally with `supabase migration fetch`. `supabase migration list` should show the 12 previously remote-only migrations matched locally, followed by these two local-only pending migrations:

- `20260512235939_backup_leave_domain_before_rebuild`
- `20260512235948_leave_management_engine`

Do not run `supabase migration repair` for the current state. The remote history was missing locally, so fetching the remote history into `supabase/migrations` is safer than changing remote migration history.

Do not run `supabase db pull` unless you intentionally want an additional schema-drift snapshot before rollout. It is not required for the current migration-history mismatch after `supabase migration fetch`.

### Preflight

```powershell
supabase migration list
npm run test
npm run typecheck
npm run lint
npm run build
```

### Dry Run

Run this before any real push:

```powershell
supabase db push --dry-run
```

The dry run must list only these local pending migrations:

- `20260512235939_backup_leave_domain_before_rebuild.sql`
- `20260512235948_leave_management_engine.sql`

### Apply To Staging

Apply only after the dry run is reviewed and the linked project is confirmed as staging:

```powershell
supabase db push
```

## SQL Verification Snippets

### Check Old Tables

```sql
select table_schema, table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'vacation_attachments',
    'vacation_approvals',
    'vacation_balances',
    'vacation_requests',
    'vacation_settings',
    'vacation_types',
    'leave_approvals',
    'leave_transactions',
    'leave_requests',
    'employee_leave_balances',
    'public_holidays',
    'leave_policies',
    'leave_types'
  )
order by table_name;
```

### Check Backup Tables

```sql
select source_table, backup_schema, backup_table, row_count, status, detail, backed_up_at
from backup.leave_domain_backup_manifest
where backed_up_at >= now() - interval '1 day'
order by id desc;
```

```sql
select table_schema, table_name
from information_schema.tables
where table_schema = 'backup'
  and table_name like 'lm_bak_%'
order by table_name;
```

### Check Required Functions

```sql
select
  to_regprocedure('private.phx_current_hr_id()') as current_hr_id,
  to_regprocedure('private.phx_current_role()') as current_role,
  to_regprocedure('private.phx_current_scope()') as current_scope,
  to_regprocedure('private.phx_can_access_employee(text)') as can_access_employee;
```

All columns must be non-null before applying the rebuild migration.

### Check New Leave Tables

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'leave_types',
    'leave_policies',
    'employee_leave_balances',
    'leave_requests',
    'leave_transactions',
    'leave_approvals',
    'public_holidays'
  )
order by table_name;
```

### Check RLS And Grants

```sql
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  count(p.polname) as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_policy p on p.polrelid = c.oid
where n.nspname = 'public'
  and c.relname in (
    'leave_types',
    'leave_policies',
    'employee_leave_balances',
    'leave_requests',
    'leave_transactions',
    'leave_approvals',
    'public_holidays'
  )
group by c.relname, c.relrowsecurity
order by c.relname;
```

```sql
select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in (
    'leave_types',
    'leave_policies',
    'employee_leave_balances',
    'leave_requests',
    'leave_transactions',
    'leave_approvals',
    'public_holidays'
  )
  and grantee in ('anon', 'authenticated', 'service_role')
order by table_name, grantee, privilege_type;
```

Expected:

- `authenticated` has `SELECT` on leave-domain tables.
- `authenticated` has `INSERT` only on `leave_requests`.
- `service_role` has full access.
- `anon` has no direct leave-domain grants.

### Check Seed Leave Policy

```sql
select
  name,
  country,
  annual_days_first_year,
  annual_days_after_first_year,
  annual_days_senior,
  annual_days_disability,
  senior_after_years,
  senior_after_age,
  accrual_method,
  accrual_frequency,
  weekend_days,
  is_default,
  is_active
from public.leave_policies
where name = 'Egypt Annual Leave Policy';
```

Expected values: `15`, `21`, `30`, `45`, senior years `10`, senior age `50`, `monthly` accrual frequency, weekend days `{5,6}`.

### Check Seed Leave Types

```sql
select code, name, is_paid, affects_payroll, requires_attachment, requires_manager_approval, requires_hr_approval, is_active
from public.leave_types
order by code;
```

Expected codes:

- `annual_leave`
- `sick_leave`
- `casual_leave`
- `unpaid_leave`
- `emergency_leave`
- `other`

### Check Public Holidays

```sql
select name, date, year, country, is_active
from public.public_holidays
where country = 'EG'
order by date;
```

### Check Permissions

```sql
select resource, action
from public.permissions
where resource = 'leave'
order by action;
```

Expected actions:

- `approve`
- `create`
- `delete`
- `export`
- `import`
- `read`
- `update`

### Confirm Old Vacation Routes Are Gone

Run locally after build:

```powershell
rg "/api/vacation|admin/vacation|@/lib/vacation|@/components/vacation" app src supabase tests
```

Only test assertions that mention removed routes should appear.

## App Validation Commands

```powershell
npm run test
npm run typecheck
npm run lint
npm run build
```

## Manual Workflow Checklist

### Employee Portal

- Open `/employee-portals/leave`.
- Confirm wallet cards render: annual entitlement, accrued, used, pending, available.
- Submit annual leave for a future weekday range.
- Confirm same-day weekday request calculates `1` working day.
- Confirm Friday/Saturday are excluded.
- Confirm a seeded public holiday is excluded.
- Confirm invalid date range is blocked.
- Confirm past leave is blocked for an employee.
- Confirm insufficient annual balance is blocked.
- Confirm request appears in Vacation / Leave Report.
- Open request details and verify approval history area.
- Upload a small attachment and confirm the link is saved.

### Manager Portal

- Open `/employee-portals/leave-approvals` as a manager.
- Confirm only hierarchy/team requests appear.
- Approve a pending manager request.
- Reject another request and confirm comment is mandatory.
- Confirm manager cannot approve a request outside the reporting hierarchy.

### Admin / HR

- Open `/admin/leave`.
- Confirm dashboard KPI cards render.
- Filter by status, HR_ID, line, area, month, and year.
- HR approve a manager-approved request.
- Confirm exactly one `pending_reversal` and one `consumed` transaction were created.
- Double-click/retry HR approval and confirm no duplicate `consumed` transaction is created.
- HR reject a request and confirm pending balance is released.
- Add a manual adjustment and confirm a mandatory reason is required.
- Add a public holiday and confirm it appears in the holiday list.
- Export Excel and open the file.

### Finance / Payroll Impact

- Submit unpaid leave.
- Confirm `payroll_status = 'pending'`.
- Confirm Finance can see payroll-impact leave and does not see unrelated paid leave through the service view.

## Rollback Notes

The backup script creates copies in the `backup` schema and records them in `backup.leave_domain_backup_manifest`.

Rollback options:

1. Prefer restoring the full staging database backup if the migration caused broad issues.
2. For leave-domain-only rollback, use the manifest to identify the backup table names, then recreate the old tables from `backup.lm_bak_*` copies. This is a manual rollback because table names are timestamped.
3. Do not roll back production from staging artifacts.

Example inspection query:

```sql
select source_table, backup_table, row_count, backed_up_at
from backup.leave_domain_backup_manifest
where status = 'backed_up'
order by id desc;
```

Example manual restore pattern:

```sql
begin;
drop table if exists public.leave_requests cascade;
create table public.leave_requests as table backup.lm_bak_leave_requests_YYYYMMDD_HHMMSS_MS;
commit;
```

Adjust the table name from the manifest and restore related tables in dependency order if needed.
