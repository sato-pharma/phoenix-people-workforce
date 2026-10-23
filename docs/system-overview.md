# Phoenix Workforce - System Overview

Current operating state: see [Current Operating State](current-operating-state.md).

## Architecture

- **Runtime**: Next.js 16 App Router with React 19 and TypeScript.
- **Data platform**: Supabase/Postgres through server-side helpers in `src/lib/supabase`.
- **Authentication**: Custom Phoenix session cookies backed by `app_auth_users`; dev preview auth is available only in local development.
- **Authorization**: Role/action permission matrix in `src/lib/auth/permissions.ts`, optionally overlaid by `role_permission_overrides`.
- **UI shell**: Admin and employee-portal navigation are handled by `AppShell`, `Sidebar`, and employee portal layout components.
- **Imports/exports**: Excel workflows use `exceljs`; employee import validation is centralized in `src/lib/imports`.
- **Maps and routing**: Outstation uses neutral Google Maps server helpers in `src/lib/google-maps/server.ts`.

## Current Git And Deployment Workflow

- `main` is production-only and should stay aligned with the live production deployment.
- Feature work happens on a `codex/<task>` branch/worktree, PR'd against `main`.
- Production is served at `https://phoenix-hr.satopharma.com` (**Railway** — hosting moved off GCP Cloud Run on 2026-08-01 and 🔴 **GCP is DEAD, not standby**: never deploy to or verify against it, see `AGENTS.md` §3).
- Railway auto-deploys production from `main` **after that commit's CI passes** (Wait for CI, enabled 2026-09-27) — there is no per-branch preview deployment (that was a retired Vercel-era model). 🔴 The gate fails by not shipping, silently: read `/api/healthz` `revision`, never the merge. See [deployment.md](deployment.md), "The deploy gate".
- Deployment mapping and the Cloud Scheduler cron model are documented in [current-operating-state.md](current-operating-state.md).
- `.vercel/` may still exist locally as inert, gitignored Vercel CLI leftovers from before the Cloud Run migration.

## Roles And Permissions

Phoenix roles currently defined in code:

- Employee
- Medical Rep
- District Manager
- Regional Manager
- National Sales Manager
- Product Manager
- Group Product Manager
- SFE Manager
- Training Manager
- Marketing Manager
- Finance Manager
- HR Specialist
- Manager
- CEO
- Super Admin

Permission resources currently defined in code:

- `admin`, `overview`, `admin_access`, `imports`, `sales`, `payroll`, `expenses`
- `employees`, `team`, `offers`, `probation`, `resignations`, `contracts`, `coaching`
- `user_admin`, `permission_admin`, `employee_documents`, `employee_profile`
- `vacancies`, `organogram`, `hr_calendar`, `payslips`, `outstation`, `leave`

Permission actions are `read`, `create`, `update`, `delete`, `approve`, `export`, and `import`.

## Admin Routes

Current admin pages:

- `/admin`
- `/admin/access`
- `/admin/email-notifications`
- `/admin/email-reply-composer`
- `/admin/logs`
- `/admin/system-audit` (replaced `/admin/data-health`, `/admin/monitoring`, `/admin/system-issues` and `/admin/error-monitor` on 2026-10-23; those addresses redirect here)
- `/admin/outstation/expenses`, `/admin/outstation/expenses/dashboard`
- `/admin/outstation/heatmaps`
- `/admin/outstation/policy`
- `/admin/outstation/requests`
- `/admin/payslips-center`
- `/admin/profile`

## Application Pages

Top-level admin/workforce pages:

- `/`
- `/coaching`, `/coaching/new`, `/coaching/[id]`, `/coaching/analytics`
- `/contracts`
- `/employees`
- `/hr-calendar`
- `/login`
- `/offers`, `/offers/[token]/accept`, `/offers/[token]/reject`
- `/organogram`
- `/overview`
- `/password-setup/[token]`
- `/payroll`
- `/payslips`
- `/probation`
- `/reports/vacancies`
- `/resignations`
- `/sales`
- `/sales/import?tab=approvals`

Employee-facing pages:

- `/employee/outstation/new`
- `/employee-portals`
- `/employee-portals/coaching`, `/employee-portals/coaching/[id]`
- `/employee-portals/contact-hr-support`
- `/employee-portals/dsms-performance`
- `/employee-portals/expense-dashboard`
- `/employee-portals/expenses`
- `/employee-portals/incentive`
- `/employee-portals/med-reps-performance`
- `/employee-portals/organogram`
- `/employee-portals/payroll`
- `/employee-portals/payslips`
- `/employee-portals/probation`
- `/employee-portals/profile`
- `/employee-portals/sales`
- `/employee-portals/team-expenses`
- `/employee-portals/team-performance`
- `/employee-portals/training-manager`
- `/employee-portals/training-manager/create-coaching-report`
- `/employee-portals/training-manager/field-coaching`
- `/employee-portals/training-manager/field-coaching/[id]`
- `/employee-portals/vacancies`

Development-only preview page:

- `/dev/employee-portals`

## API Routes

Shared export:

- `GET /api/exports?report=probation&format=xlsx`
- `GET /api/exports?report=probation&format=pdf`

Authentication:

- `POST /api/auth/login`
- `POST /api/auth/logout`
- `POST /api/auth/heartbeat`
- `POST /api/auth/password-setup/[token]`
- `/api/dev-auth`

Admin:

- `/api/admin/email-notifications`
- `/api/admin/email-reply/send`
- `/api/admin/logs`
- `/api/admin/outstation/[id]`
- `/api/admin/outstation/heatmaps`
- `/api/admin/outstation/requests`
- `/api/admin/permissions`
- `/api/admin/profile`
- `/api/admin/salary-flags`
- `/api/admin/users`
- `/api/admin/users/bulk`
- `/api/admin/users/bulk-action`
- `/api/admin/users/setup-link`

Employees and imports:

- `/api/employees`
- `/api/employees/[hrId]/resign`
- `/api/employees/template`
- `/api/imports/employees/dry-run`
- `/api/imports/employees/confirm`

Sales:

- `/api/sales/imports`
- `/api/sales/imports/upload`
- `/api/sales/imports/[id]/[action]`

Payroll and expenses:

- `/api/payroll/upload`
- `/api/payroll/validate`
- `/api/payroll/template`
- `/api/payroll/[id]`
- `/api/payroll/[id]/download`
- `/api/payroll/[id]/payslips`
- `/api/payroll/[id]/replace`
- `/api/payroll/[id]/workflow`

Outstation:

- `/api/admin/outstation/expenses`
- `/api/admin/outstation/expenses/analyze`
- `/api/admin/outstation/expenses/import`
- `/api/admin/outstation/expenses/reports/[id]`
- `/api/outstation/calculate`
- `/api/outstation/capture-location`
- `/api/outstation/policy`
- `/api/outstation/submit`
- `/api/outstation/sync-offline`

Lifecycle and HR workflows:

- `/api/contracts`
- `/api/contracts/[id]/workflow`
- `/api/offers`
- `/api/offers/[offerRef]/accept`
- `/api/offers/[offerRef]/approve`
- `/api/offers/[offerRef]/reject`
- `/api/probation`
- `/api/probation/[id]/workflow`
- `/api/resignations`
- `/api/resignations/[id]/workflow`
- `/api/reports/vacancies`

Coaching:

- `/api/coaching/analytics`
- `/api/coaching/reports`
- `/api/coaching/reports/export`
- `/api/coaching/reports/[id]`
- `/api/coaching/reports/[id]/acknowledge`
- `/api/coaching/reports/[id]/submit`

Notifications:

- `/api/notifications/birthdays`
- `/api/notifications/contract-renewals`
- `/api/notifications/in-app`
- `/api/notifications/process`
- `/api/notifications/test`

## Core Modules

- `src/lib/auth`: sessions, access contexts, role permissions, audit helpers.
- `src/lib/admin`: admin dashboard, monitoring, audit, and access-control services.
- `src/lib/employees`: employee directory, HR ID helpers, and residence location maintenance.
- `src/lib/google-maps`: shared Google Maps server/browser helpers.
- `src/lib/imports`: employee import validation, normalization, column mapping, and org rules.
- `src/lib/sales`: monthly closing sheet parsing, validation, role mapping, import workflow, queue, and sales dashboard logic.
- `src/lib/payroll`: salary import, payroll workflow, payslips, payroll expenses, salary source mapping, and policy logic.
- `src/lib/outstation`: standalone outstation request capture, Google route validation, policy calculation, request storage, review data, and heatmap aggregation.
- `src/lib/probation`: probation row loading, workflow actions, notifications, and export generation.
- `src/lib/contracts`, `src/lib/resignations`, `src/lib/offers`: employee lifecycle workflows.
- `src/lib/coaching`: coaching reports, scoring, analytics, portal access, and Excel export.
- `src/lib/employee-portal`: employee portal data, navigation, sales scope, expense dashboards, and period helpers.

## Current Business Workflows

Payroll:

1. Upload or validate salary workbook.
2. Create or replace a salary batch.
3. Review validation flags and payroll readiness.
4. Run workflow actions on a batch.
5. Download payroll/payslip outputs through batch-scoped API routes.

Outstation Expenses:

1. Upload/import expense data through outstation expense routes.
2. Review expenses in `/admin/outstation/expenses`.
3. Inspect aggregated dashboard data in `/admin/outstation/expenses/dashboard`.
4. Employee portal managers review personal/team expense dashboards from employee portal routes.

Outstation:

1. Employee opens `/employee/outstation/new`.
2. The system loads employee identity and residence location.
3. Employee captures GPS location and enters trip details.
4. Outstation APIs calculate route distance, eligibility, expected cost, variance, and approval recommendation.
5. Employee submits or syncs an offline request.
6. Admin users review requests, policy rules, and heatmaps from `/admin/outstation/*`.

Sales:

1. Open `/sales/import?tab=approvals`.
2. Upload a monthly closing workbook through `/api/sales/imports/upload`.
3. Review validation, linkage, warning, and failure summaries.
4. Approve, reject, replace, or delete queued imports through `/api/sales/imports/[id]/[action]`.
5. View approved sales data on `/sales` or scoped employee portal sales pages.

Employee Master imports:

1. Upload employee workbooks from `/employees`.
2. Run dry-run validation.
3. Confirm validated imports through the matching confirm API route.

Probation:

1. `/probation` loads current probation rows from employee directory and probation workflow tables.
2. HR/Admin users create evaluations and run manager, HR, approval, letter, completion, cancel, and reopen workflow actions.
3. Export buttons use `/api/exports?report=probation&format=xlsx` and `/api/exports?report=probation&format=pdf`.

## Database Areas

The codebase currently references these major table groups:

- Authentication and access: `app_auth_users`, `auth_login_attempts`, `user_access_profiles`, `role_permission_overrides`
- People and org data: `employees`, `organogram`, employee linkage and directory-related data
- Payroll: salary batches, salary records, salary flags, payslip outputs, payroll expenses
- Sales: sales import batches and imported sales records
- Lifecycle: contracts, resignations, job offers, vacancies, employee probation, probation evaluations/history
- Notifications and audit: notification events, notification delivery logs, audit logs
- Outstation: employee residence locations, outstation policy rules, submitted outstation requests, and outstation location audit logs

## Validation And Tests

Current test coverage includes auth sessions, coaching, employee portal behavior, email notifications, Google routes, i18n, incentives, payroll, role mapping, sales parsing/period logic, salary policy, and workforce classification.

Safe local checks:

- `pnpm run typecheck`
- `pnpm run test`
- `pnpm run build`
- `pnpm audit --audit-level=low`
- Targeted Playwright checks where a UI flow needs browser verification
