---
name: account-creation-defaults-role-to-employee
description: "New accounts land as role 'Employee' regardless of job title — six accounts were silently crippled this way before being fixed 2026-08-10"
metadata: 
  node_type: memory
  type: project
  originSessionId: 422f0419-f7bf-4727-b203-de3401c5cb27
  modified: 2026-08-14T18:41:04.247Z
---

Accounts created under the newer `PD-`/`CN-` numbering were all landing with
`app_auth_users.role = 'Employee'` no matter the person's real job title. Nobody was setting the
real role afterwards, so the account silently came up with `access_scope = SELF`.

**Fixed 2026-08-10** (owner-approved) for all six affected accounts: PD-0006 Ahmed Mohamed Nagy and
PD-0010 Ahmed Elsayed Ahmed → `District Manager`; PD-0004 Aya Mohamed Abdelhamid Abdullah,
PD-0008 Gannatallah Amer, PD-0009 Mohamed Raffat, CN-0005 Amira Samy → `Medical Rep`.

**Why:** a District Sales Manager on the `Employee` role loses 11 modules — Team, Organogram,
Early Birds, Weekly Plans, Direct Orders, Double Visit Analytics, Weekly Sales, Vacancies,
My Candidates, attendance management, and crucially **leave approval** — so he cannot approve his own
reps' vacations. That presents to the owner as "his account is almost empty". A Medical Rep on
`Employee` loses less: only Early Birds and Weekly Sales.

**How to apply:** the underlying creation-flow defect WAS fixed 2026-08-14 (PR #2139 —
`resolveEmployeeAccessRole` now maps the DSM / Medical Rep titles; see
[[field-force-provisioning-live-and-guard-relaxed-2026-08-14]]), so a NEW hire with either title no
longer strands. But rows created BEFORE that fix can still be wrong — **AI-0009 Omayma Wael** (created
2026-08-10, Medical Representative, hire_date 2026-08-20) was found on Employee and corrected
2026-08-14; the original six were re-checked the same day and were already correct. Re-run this check
after any pre-fix account or new hire:

```sql
select e.hr_id, e.full_name, e.job_title, u.role
from employees e join app_auth_users u on u.hr_id = e.hr_id
where e.employment_status='active' and u.is_active
  and ((e.job_title ilike '%District Sales Manager%' and u.role <> 'District Manager')
    or (e.job_title ilike '%Medical Representative%' and u.role <> 'Medical Rep'));
```

Do not "fix" a legitimate `Employee`: office/admin staff (Admin Assistant, Office Coordinator,
Buffet, Financial Advisor) belong on that role.

Applying a correction takes four writes — see [[changing-a-user-role-needs-four-writes]].
Attendance is unaffected by this bug: `src/lib/attendance/eligibility.ts` keys off JOB TITLE, not
the account role, so fingerprint tracking and deductions stayed correct throughout.
