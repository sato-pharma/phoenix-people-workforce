# Phoenix Workforce - System Overview

Current workspace snapshot: 460 TypeScript/TSX files, 85 `app/api` route handlers, and the Next.js App Router under `app/`.

## Architecture

- **Runtime**: Next.js 16 App Router with React 19 and TypeScript.
- **Data platform**: Supabase/Postgres through server-side helpers in `src/lib/supabase`.
- **Authentication**: Custom Phoenix session cookies backed by `app_auth_users`; dev preview auth is available only in local development.
- **Authorization**: Role/action permission matrix in `src/lib/auth/permissions.ts`, optionally overlaid by `role_permission_overrides`.
- **UI shell**: Admin and employee-portal navigation are handled by `AppShell`, `Sidebar`, and employee portal layout components.
- **Imports/exports**: Excel workflows use `exceljs` or `xlsx`; file validation is centralized where practical in upload helpers and feature import services.

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
- `vacancies`, `organogram`, `hr_calendar`, `payslips`, `geo_intelligence`, `outstation`, `leave`

Permission actions are `read`, `create`, `update`, `delete`, `approve`, `export`, and `import`.

## Admin Routes

Current admin pages:

- `/admin`
- `/admin/access`
- `/admin/data-health`
- `/admin/email-notifications`
- `/admin/email-reply-composer`
- `/admin/geo-intelligence`
- `/admin/geo-intelligence/anomalies`
- `/admin/geo-intelligence/expense-routes`
- `/admin/geo-intelligence/territory-map`
- `/admin/leave`
- `/admin/logs`
- `/admin/monitoring`
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
- `/imports/bricks`
- `/imports/employees`
- `/login`
- `/offers`, `/offers/[token]/accept`, `/offers/[token]/reject`
- `/organogram`
- `/overview`
- `/password-setup/[token]`
- `/payroll`, `/payroll/expenses`, `/payroll/expenses/dashboard`
- `/payslips`
- `/probation`
- `/reports/vacancies`
- `/resignations`
- `/sales`
- `/sales/queue`

Employee-facing pages:

- `/employee/outstation/new`
- `/employee-portals`
- `/employee-portals/brick-coverage`
- `/employee-portals/coaching`, `/employee-portals/coaching/[id]`
- `/employee-portals/contact-hr-support`
- `/employee-portals/dsms-performance`
- `/employee-portals/expense-dashboard`
- `/employee-portals/expenses`
- `/employee-portals/incentive`
- `/employee-portals/leave`
- `/employee-portals/leave-approvals`
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
- `/api/imports/bricks/dry-run`
- `/api/imports/bricks/confirm`
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
- `/api/payroll/expenses`
- `/api/payroll/expenses/analyze`
- `/api/payroll/expenses/import`
- `/api/payroll/expenses/reports/[id]`

Leave:

- `/api/leave/accrual/run`
- `/api/leave/adjustments`
- `/api/leave/conflicts`
- `/api/leave/export`
- `/api/leave/requests`
- `/api/leave/requests/[id]`
- `/api/leave/requests/[id]/attachment`
- `/api/leave/requests/[id]/hr-decision`
- `/api/leave/requests/[id]/manager-decision`
- `/api/leave/settings/holidays`
- `/api/leave/settings/policies`
- `/api/leave/settings/types`

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

Geo, outstation, notifications, and employee portal helpers:

- `/api/geo/dashboard`
- `/api/geo/geocode`
- `/api/geo/import-bricks`
- `/api/geo/import-expenses`
- `/api/geo/validate-trip`
- `/api/outstation/calculate`
- `/api/outstation/capture-location`
- `/api/outstation/policy`
- `/api/outstation/submit`
- `/api/outstation/sync-offline`
- `/api/employee-portals/brick-coverage/geocode`
- `/api/notifications/birthdays`
- `/api/notifications/in-app`
- `/api/notifications/process`
- `/api/notifications/test`

## Core Modules

- `src/lib/auth`: sessions, access contexts, role permissions, audit helpers.
- `src/lib/admin`: admin dashboard, monitoring, audit, and access-control services.
- `src/lib/employees`: employee directory and HR ID helpers.
- `src/lib/imports`: employee import validation, normalization, column mapping, and org rules.
- `src/lib/sales`: monthly closing sheet parsing, validation, role mapping, import workflow, queue, and sales dashboard logic.
- `src/lib/payroll`: salary import, payroll workflow, payslips, payroll expenses, salary source mapping, and policy logic.
- `src/lib/leave`: leave requests, accruals, settings, conflicts, exports, attachments, audit, and notifications.
- `src/lib/probation`: probation row loading, workflow actions, notifications, and export generation.
- `src/lib/contracts`, `src/lib/resignations`, `src/lib/offers`: employee lifecycle workflows.
- `src/lib/coaching`: coaching reports, scoring, analytics, portal access, and Excel export.
- `src/lib/geo-intelligence`, `src/lib/outstation`, `src/lib/bricks`: geography, brick coverage, trip validation, and outstation flows.
- `src/lib/employee-portal`: employee portal data, navigation, sales scope, and period helpers.

## Current Business Workflows

Payroll:

1. Upload or validate salary workbook.
2. Create or replace a salary batch.
3. Review validation flags and payroll readiness.
4. Run workflow actions on a batch.
5. Download payroll/payslip outputs through batch-scoped API routes.

Sales:

1. Open `/sales/queue`.
2. Upload a monthly closing workbook through `/api/sales/imports/upload`.
3. Review validation, linkage, warning, and failure summaries.
4. Approve, reject, replace, or delete queued imports through `/api/sales/imports/[id]/[action]`.
5. View approved sales data on `/sales` or scoped employee portal sales pages.

Imports:

1. Upload employee or brick workbooks from `/imports/employees` or `/imports/bricks`.
2. Run dry-run validation.
3. Confirm validated imports through the matching confirm API route.

Leave:

1. Employees submit leave requests from employee portal routes.
2. Managers and HR review through leave workspaces.
3. Admins manage policies, holidays, accruals, adjustments, and exports from `/admin/leave`.

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
- Leave: leave types, policies, balances, requests, approvals, transactions, holidays, audit logs
- Lifecycle: contracts, resignations, job offers, vacancies, employee probation, probation evaluations/history
- Notifications and audit: notification events, notification delivery logs, audit logs
- Geo/outstation/bricks: brick references, geo route/expense data, outstation requests and policy data

## Validation And Tests

Current test coverage includes auth sessions, coaching, employee portal behavior, email notifications, Google routes, i18n, incentives, leave, payroll, role mapping, sales parsing/period logic, salary policy, and workforce classification.

Safe local checks:

- `npm run typecheck`
- `npm run test`
- Targeted Playwright checks where a UI flow needs browser verification
