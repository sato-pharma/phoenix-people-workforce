# Phoenix Workforce Production Blocker Remediation Plan

> **Reconciled 2026-08-04.** Sandbox ref `oaifhavixhdtwmseshff` — referenced below only as an
> explicitly *rejected* target and inside "confirm the URL does not contain this ref" guards —
> is now **dead** (it resolves to nothing; the only live projects are production
> `ozucdzovmcqvepbozvqf` and staging `cifwmndunmlxjhyjugxa`, see AGENTS.md §3). Those
> reject-guards still hold. The admin-HR identity remediation is already marked complete; the
> `employee_probation` RLS item remains a reviewed tracked exception.

This plan is documentation only. Do not apply the role-alignment migration or either remediation until the production change window, backup, and final preflight are approved.

Production target:

- Project: Phoenix HR
- Ref: `ozucdzovmcqvepbozvqf`

Explicitly rejected target:

- Sandbox ref: `oaifhavixhdtwmseshff`

## Current Status

1. `admin-HR` identity remediation is complete.
2. `public.employee_probation` has RLS disabled and is now a reviewed tracked exception.

These items are independent:

- Admin identity remediation fixed the primary Super Admin source-of-trust record.
- Probation security remediation remains a separate security workstream and is not a blocker for controlled role-alignment rollout.

## Admin-HR Identity Remediation

### Objective

Link `admin-HR` to a stable HR_ID before role-alignment production migration. The recommended HR_ID is `admin-HR` because current legacy helper logic already falls back to `login_id` when `hr_id` is null, so this preserves the existing effective identity while making it explicit.

Status: **Complete in production**.

Post-remediation production preflight confirmed:

- `admin-HR` has stable HR_ID linkage.
- Matching `employees` linkage exists.
- Supabase Auth metadata is aligned.
- No active app users are missing HR_ID linkage.

### Production-Safe Execution Checklist

1. Confirm target database is Phoenix HR production ref `ozucdzovmcqvepbozvqf`.
2. Confirm database URL does not contain sandbox ref `oaifhavixhdtwmseshff`.
3. Export backups for:
   - `public.app_auth_users` row `login_id = 'admin-HR'`
   - `public.user_access_profiles` rows for `login_id = 'admin-HR'` or matching `auth_user_id`
   - `public.employees` row `hr_id = 'admin-HR'`, if it exists
   - `auth.users` row matching `app_auth_users.auth_user_id`
4. Verify `admin-HR` exists, is active, and has role `Super Admin`.
5. Verify whether an `employees.hr_id = 'admin-HR'` row already exists.
6. If no employee row exists, create only the minimal dedicated system employee row.
7. Update only `admin-HR` where `hr_id is null`.
8. Upsert only the matching `user_access_profiles` row by `auth_user_id`.
9. Update only the matching Supabase Auth metadata row by `auth_user_id`.
10. Re-run production preflight in read-only mode.

### Verification Queries

```sql
-- Confirm target project before any write is attempted.
select current_database(), current_user, inet_server_addr(), inet_server_port();

-- Confirm admin-HR state.
select
  login_id,
  role,
  hr_id,
  is_active,
  auth_user_id,
  auth_email,
  updated_at
from public.app_auth_users
where login_id = 'admin-HR';

-- Confirm employee row status.
select
  hr_id,
  full_name,
  job_title,
  employment_status,
  created_at,
  updated_at
from public.employees
where hr_id = 'admin-HR';

-- Confirm access profile linkage.
select
  auth_user_id,
  login_id,
  hr_id,
  role,
  phoenix_role,
  scope_type,
  is_active,
  updated_at
from public.user_access_profiles
where login_id = 'admin-HR'
   or auth_user_id = (
     select auth_user_id
     from public.app_auth_users
     where login_id = 'admin-HR'
   );

-- Confirm Supabase Auth metadata linkage.
select
  id,
  email,
  raw_app_meta_data ->> 'login_id' as login_id,
  raw_app_meta_data ->> 'hr_id' as app_hr_id,
  raw_app_meta_data ->> 'phoenix_role' as app_phoenix_role,
  raw_user_meta_data ->> 'hr_id' as user_hr_id,
  raw_user_meta_data ->> 'phoenix_role' as user_phoenix_role,
  updated_at
from auth.users
where id = (
  select auth_user_id
  from public.app_auth_users
  where login_id = 'admin-HR'
);
```

### Execution SQL Draft

```sql
begin;

do $$
declare
  v_auth_user_id uuid;
begin
  if not exists (
    select 1
    from public.app_auth_users
    where login_id = 'admin-HR'
      and role = 'Super Admin'
      and coalesce(is_active, true) = true
  ) then
    raise exception 'Expected active Super Admin app_auth_users row admin-HR was not found.';
  end if;

  insert into public.employees (
    hr_id,
    full_name,
    job_title,
    employment_status,
    created_at,
    updated_at
  )
  values (
    'admin-HR',
    'Phoenix System Administrator',
    'System Administrator',
    'active',
    now(),
    now()
  )
  on conflict (hr_id) do nothing;

  update public.app_auth_users
  set
    hr_id = 'admin-HR',
    updated_at = now()
  where login_id = 'admin-HR'
    and role = 'Super Admin'
    and hr_id is null;

  select auth_user_id
    into v_auth_user_id
  from public.app_auth_users
  where login_id = 'admin-HR'
  limit 1;

  if v_auth_user_id is null then
    raise exception 'admin-HR has no auth_user_id. Run/review auth bridge repair before role-alignment production migration.';
  end if;

  insert into public.user_access_profiles (
    auth_user_id,
    hr_id,
    role,
    is_active,
    created_at,
    updated_at,
    login_id,
    phoenix_role,
    manager_hr_id
  )
  values (
    v_auth_user_id,
    'admin-HR',
    'admin',
    true,
    now(),
    now(),
    'admin-HR',
    'Super Admin',
    null
  )
  on conflict (auth_user_id) do update
  set
    hr_id = excluded.hr_id,
    role = excluded.role,
    is_active = excluded.is_active,
    updated_at = now(),
    login_id = excluded.login_id,
    phoenix_role = excluded.phoenix_role,
    manager_hr_id = excluded.manager_hr_id;

  update auth.users
  set
    raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
      || jsonb_build_object(
        'hr_id', 'admin-HR',
        'login_id', 'admin-HR',
        'phoenix_role', 'Super Admin',
        'coarse_access_role', 'admin',
        'is_active', true
      ),
    raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
      || jsonb_build_object(
        'hr_id', 'admin-HR',
        'login_id', 'admin-HR',
        'phoenix_role', 'Super Admin',
        'manager_hr_id', null,
        'name', 'Phoenix System Administrator'
      ),
    updated_at = now()
  where id = v_auth_user_id;
end $$;

notify pgrst, 'reload schema';

commit;
```

### Rollback SQL Draft

Use this only if the change must be reversed and the backup confirms `admin-HR.hr_id` was originally null.

```sql
begin;

update auth.users u
set
  raw_app_meta_data = raw_app_meta_data - 'hr_id',
  raw_user_meta_data = raw_user_meta_data - 'hr_id',
  updated_at = now()
where u.id = (
  select auth_user_id
  from public.app_auth_users
  where login_id = 'admin-HR'
);

update public.user_access_profiles
set
  hr_id = null,
  updated_at = now()
where login_id = 'admin-HR'
  and hr_id = 'admin-HR';

update public.app_auth_users
set
  hr_id = null,
  updated_at = now()
where login_id = 'admin-HR'
  and role = 'Super Admin'
  and hr_id = 'admin-HR';

-- Only delete the employee row if it was created by this remediation and no dependent records exist.
delete from public.employees
where hr_id = 'admin-HR'
  and full_name = 'Phoenix System Administrator'
  and job_title = 'System Administrator'
  and not exists (
    select 1 from public.employee_history h where h.employee_hr_id = 'admin-HR'
  )
  and not exists (
    select 1 from public.employee_compensation c where c.employee_hr_id = 'admin-HR'
  )
  and not exists (
    select 1 from public.salary_records s where s.hr_id = 'admin-HR'
  );

notify pgrst, 'reload schema';

commit;
```

### Safety Notes

- Employee row creation is idempotent through `on conflict (hr_id) do nothing`.
- Existing production employee data is not overwritten.
- `app_auth_users` updates only the exact `admin-HR` Super Admin row and only when `hr_id is null`.
- `user_access_profiles` is upserted only by the existing `auth_user_id`.
- Auth metadata is updated only for the same `auth_user_id`.
- This should not change the account password or auth email.

## Employee Probation Security Remediation

### Objective

Enable RLS on `public.employee_probation` with reviewed policies that match current app access paths.

Status: **Reviewed tracked exception**.

This remediation is separate from the role-alignment rollout and should not be applied as part of the role-alignment migration.

Justification:

- Current probation workflow access is service-role controlled through server-side app paths.
- No direct authenticated client writes to `employee_probation` are currently required by the app.
- The service-role-only remediation SQL is reviewed and documented below.
- Scheduling this separately keeps role-alignment rollback simple and avoids mixing independent security changes.

### Current App Access Paths

The app currently uses server-controlled access for probation workflows:

- `src/lib/probation/service.ts` uses `getSupabaseAdmin()` to read and update `employee_probation`, `probation_evaluations`, and `probation_history`.
- Page/API access is controlled through app permission checks such as `assertPermission(access, "probation", ...)`.
- `src/lib/admin/command-center.ts` counts upcoming probation endings from `employee_probation`.
- `src/lib/overview/service.ts` reads `v_probation_tracker` with service-role REST access when the overview user has app-level probation permission.

Based on local code, direct authenticated client table writes to `employee_probation` are not required.

### Required Actors

Read actors:

- Service role for server workflows and dashboard aggregation.
- Optional future authenticated read for employee self, manager scoped access, and HR/Super Admin only if direct client access is introduced.

Write actors:

- Service role for current app workflow writes.
- HR/Super Admin only if direct authenticated writes are intentionally introduced later.
- Managers should not directly update `employee_probation`; manager feedback currently belongs in `probation_evaluations`.

### Security Remediation Checklist

1. Confirm target database is Phoenix HR production ref `ozucdzovmcqvepbozvqf`.
2. Confirm database URL does not contain sandbox ref `oaifhavixhdtwmseshff`.
3. Export current table privileges and policies for `employee_probation`.
4. Confirm whether any production code path uses direct authenticated Supabase access to `employee_probation`.
5. If current service-role-only assumption holds, apply service-role-only RLS remediation.
6. Re-run production preflight.
7. Verify probation pages and admin dashboard continue loading.
8. Defer authenticated read/write policies until direct-client access is explicitly required.

### Service-Role-Only Execution SQL Draft

```sql
begin;

alter table public.employee_probation enable row level security;
alter table public.employee_probation force row level security;

revoke all on table public.employee_probation from anon;
revoke all on table public.employee_probation from authenticated;

grant all on table public.employee_probation to service_role;

drop policy if exists phx_employee_probation_service_role on public.employee_probation;

create policy phx_employee_probation_service_role
on public.employee_probation
for all
to service_role
using (true)
with check (true);

notify pgrst, 'reload schema';

commit;
```

### Optional Future Authenticated Read SQL Draft

Only use this if a reviewed requirement confirms direct authenticated client reads are needed.

```sql
begin;

grant select on table public.employee_probation to authenticated;

drop policy if exists employee_probation_select_access on public.employee_probation;

create policy employee_probation_select_access
on public.employee_probation
for select
to authenticated
using (
  public.current_access_can_manage_employees()
  or lower(coalesce(employee_hr_id, '')) = lower(coalesce(public.current_access_hr_id(), ''))
  or exists (
    select 1
    from public.employees e
    where lower(coalesce(e.hr_id, '')) = lower(coalesce(public.employee_probation.employee_hr_id, ''))
      and public.current_access_can_see_employee(e.hr_id, e.manager_hr_id)
  )
);

notify pgrst, 'reload schema';

commit;
```

### Rollback SQL Draft

Rollback should be used only if production probation access breaks and the break cannot be corrected by grants/policies.

```sql
begin;

drop policy if exists phx_employee_probation_service_role on public.employee_probation;
drop policy if exists employee_probation_select_access on public.employee_probation;

revoke all on table public.employee_probation from anon;
revoke all on table public.employee_probation from authenticated;
grant all on table public.employee_probation to service_role;

alter table public.employee_probation disable row level security;

notify pgrst, 'reload schema';

commit;
```

### Staged Rollout Recommendation

1. Apply service-role-only RLS remediation first.
2. Verify app probation dashboard, overview risk counts, and probation workflow actions.
3. Add authenticated policies only if a confirmed direct-authenticated client path requires them.
4. Keep probation remediation separate from role-alignment migration for cleaner rollback and auditability.

## Recommended Execution Order

1. Admin-HR identity remediation. **Complete.**
2. Re-run production preflight. **Complete for admin-HR identity; probation remains tracked separately.**
3. Take production backup for role-alignment change window.
4. Apply `supabase/scripts/20260511_phoenix_role_alignment.sql`.
5. Run read-only production validation.
6. Monitor auth, RLS-denied requests, payroll, employees, and admin access.
7. Schedule reviewed `employee_probation` remediation as a separate security workstream.
8. Re-run production preflight after probation remediation when that workstream is executed.

## Deferred Security Remediations

The following remediation is deferred from role-alignment:

- `public.employee_probation` RLS remediation.

Tracking status:

- Reviewed tracked exception.
- Separate security remediation workstream.
- Not a blocker for controlled role-alignment rollout.
- Reviewed service-role-only SQL draft is documented in this file.

## Final Status

Admin-HR identity remediation is resolved.

The remaining `public.employee_probation` RLS item is a reviewed tracked exception and no longer blocks controlled role-alignment rollout.

The role-alignment production migration may proceed in a controlled change window after:

- Production backup is complete.
- Production target ref `ozucdzovmcqvepbozvqf` is explicitly confirmed.
- Sandbox ref `oaifhavixhdtwmseshff` is explicitly rejected.
- The final SQL is reviewed against the sandbox-passed migration.
- The probation RLS exception remains tracked separately.
