# Leave E2E Staging Test Users

This runbook prepares staging-only users and data for `npm run test:e2e:leave`.
Do not use production URLs, production credentials, production databases, or production employees.
Do not modify payroll setup for this flow.

## Required E2E accounts

Create or verify these three Phoenix accounts in staging:

| Purpose | Recommended role | Required relationship |
| --- | --- | --- |
| Employee submitter | `Employee` or `Medical Rep` | `employees.manager_hr_id` points to the manager test user's HR_ID |
| Manager approver | `Manager` or `District Manager` | Can approve the employee through the reporting hierarchy |
| HR approver | `HR Specialist` or `Super Admin` | Can access `/admin/leave` and approve HR decisions |

Each account must be active in both Phoenix auth and employee data:

- `public.app_auth_users.login_id`
- `public.app_auth_users.hr_id`
- `public.app_auth_users.role`
- `public.app_auth_users.is_active = true`
- `public.employees.hr_id`
- `public.employees.employment_status = 'active'`
- `public.employees.manager_hr_id` for the employee test user
- `public.user_access_profiles` linked to the same HR_ID/login where the staging access-control setup uses it

Use the existing Phoenix admin user-management flow or the established staging RLS test-user tooling to create users. Passwords must be generated and stored outside git.

## Read-only verification SQL

Run against staging only:

```sql
select
  u.login_id,
  u.hr_id,
  u.role,
  u.is_active as auth_active,
  e.full_name,
  e.manager_hr_id,
  e.employment_status
from public.app_auth_users u
left join public.employees e on e.hr_id = u.hr_id
where u.login_id in (
  '<employee-login>',
  '<manager-login>',
  '<hr-login>'
)
order by u.login_id;
```

Verify the employee reports to the manager:

```sql
select
  e.hr_id as employee_hr_id,
  e.full_name as employee_name,
  e.manager_hr_id,
  m.full_name as manager_name
from public.employees e
left join public.employees m on m.hr_id = e.manager_hr_id
where e.hr_id = '<employee-hr-id>';
```

Verify the required leave permissions by role:

```sql
select login_id, role, hr_id, is_active
from public.app_auth_users
where login_id in ('<employee-login>', '<manager-login>', '<hr-login>');
```

Expected roles:

- Employee account: `Employee` or `Medical Rep`
- Manager account: `Manager`, `District Manager`, or another manager role with leave approval permission
- HR account: `HR Specialist` or `Super Admin`

## Predictable leave workflow data

Before running the full E2E suite, staging should have predictable data for the selected dates:

1. Employee has enough annual leave balance for the requested working days.
2. At least one existing `pending_manager` request exists for the employee, so the manager rejection path has a target after the employee submit test creates another request.
3. At least one existing `pending_hr` request exists for the employee, so the HR rejection path has a target after the manager approval creates another HR-pending request.
4. A same-team or same-area overlapping leave request exists for `E2E_LEAVE_CONFLICT_START_DATE` to `E2E_LEAVE_CONFLICT_END_DATE`, so the conflict warning appears.

Recommended default dates:

```powershell
$env:E2E_LEAVE_START_DATE="2026-12-13"
$env:E2E_LEAVE_END_DATE="2026-12-14"
$env:E2E_LEAVE_CONFLICT_START_DATE="2026-12-13"
$env:E2E_LEAVE_CONFLICT_END_DATE="2026-12-14"
```

If staging already has leave records on those dates, choose a future date range and seed matching pending/overlapping rows through the UI.

## Required environment variables

Set these only for staging:

```powershell
$env:E2E_LEAVE_BASE_URL="https://staging.example.com"
$env:E2E_LEAVE_EMPLOYEE_LOGIN="leave-e2e-employee"
$env:E2E_LEAVE_EMPLOYEE_PASSWORD="<stored-outside-git>"
$env:E2E_LEAVE_MANAGER_LOGIN="leave-e2e-manager"
$env:E2E_LEAVE_MANAGER_PASSWORD="<stored-outside-git>"
$env:E2E_LEAVE_HR_LOGIN="leave-e2e-hr"
$env:E2E_LEAVE_HR_PASSWORD="<stored-outside-git>"
```

Optional date overrides:

```powershell
$env:E2E_LEAVE_START_DATE="2026-12-13"
$env:E2E_LEAVE_END_DATE="2026-12-14"
$env:E2E_LEAVE_CONFLICT_START_DATE="2026-12-13"
$env:E2E_LEAVE_CONFLICT_END_DATE="2026-12-14"
```

## Execution

Confirm all variables are present, then run:

```powershell
npm run test:e2e:leave
```

Failure artifacts are written under:

- `output/playwright`
- `output/playwright-report`

Do not run this suite against production.
