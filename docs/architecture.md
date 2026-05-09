# Architecture

## Overview

Phoenix Workforce is a monolithic Next.js application that combines UI, route handlers, and domain services in one repository. The product centers on workforce operations: employee data, payroll, expenses, offers, approvals, notifications, and sales-linked reporting.

## Runtime Shape

- `app/` contains App Router pages and `app/api/*` route handlers
- `src/lib/` holds domain services and integration logic
- `src/components/` contains UI composition for dashboards, tables, forms, and workflows
- `supabase/` contains SQL used to evolve schema, enforce RLS, and harden operational behavior

## Main Domains

### Auth and Access

- Request access is resolved in server-side auth helpers
- Session signing is application-managed and now fail-closed on missing secrets
- Access control combines application permission checks with Supabase RLS for user-scoped reads

### Employees and Lifecycle

- Employee data powers directory, lifecycle events, resignation handling, and vacancy creation
- Imports and bulk actions bring operational data into the platform
- Arabic name fields already exist in the model and affect future localization requirements

### Offers and Hiring

- Public offer links render confirmation pages
- State mutation is performed through explicit `POST` handlers
- Final approval and employee-creation flows are moving into transactional database RPC paths

### Payroll and Expenses

- Payroll batches, salary records, flags, and expense imports are core financial workflows
- Recent hardening moved high-risk reads away from broad service-role defaults
- Transactional handling is required for imports and approval chains to avoid partial financial state

### Sales and Reporting

- Sales imports feed dashboards and period reporting
- Reporting now uses real datasets instead of placeholder randomization in overview calculations

### Notifications

- Notifications are shifting to an outbox-based model with idempotency and retries
- Test and processor endpoints require tighter access control because they can create operational side effects

## Data Access Model

- Supabase remains the system of record
- User-scoped reads should prefer authenticated request-scoped clients with RLS
- Service-role access should be reserved for tightly bounded server-only tasks
- SQL hardening scripts in `supabase/` are part of the application delivery surface, not optional extras

## Delivery and Validation

- CI now runs lint, typecheck, test, and build in sequence
- The current repository still contains pre-existing TypeScript issues outside the i18n baseline added in this change
- Production readiness depends on both application deployment and coordinated Supabase SQL rollout

## Current Gaps

- Type safety is not yet clean across all domains
- Localization is not centralized even though Arabic data already exists
- Some workflows still depend on disciplined server-side access boundaries rather than uniformly mature database policy coverage
