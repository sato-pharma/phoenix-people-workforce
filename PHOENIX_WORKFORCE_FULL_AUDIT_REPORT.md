# Phoenix Workforce - Full System Audit Report

**Date:** 2026-05-10
**Auditor:** Senior Enterprise System Auditor & Principal Full-Stack Engineer
**Scope:** End-to-end system audit across architecture, identity, workflows, database, API, frontend, security, email, business logic, and completion readiness
**Branch:** claude/gracious-curran-3d5cc6

---

## Executive Summary

Phoenix Workforce is a comprehensive Next.js 16 / React 19 HR management platform backed by Supabase (PostgreSQL with RLS). The system covers employee management, payroll processing, expense tracking, sales analytics, probation/contract lifecycle, job offers, geo-intelligence, and outstation expense management.

**Overall System Health Score: 6.5 / 10**

The platform has strong architectural foundations, excellent domain organization, and comprehensive feature coverage. However, it suffers from **critical security gaps** (11 tables without RLS, unauthenticated import endpoint, pervasive service-role bypassing RLS), **dead email notification code** (payroll/password-reset emails silently fail), and **significant code duplication** across 13 patterns affecting 60+ files. TypeScript compilation now passes cleanly after fixes applied during this audit.

### Key Metrics
- **Total files:** ~200+ source files across app/ and src/
- **API routes:** 70+ endpoints
- **Database tables:** 40+ tables
- **TypeScript errors:** 11 found, 11 fixed (now 0)
- **Lint errors:** 14 (pre-existing, documented)
- **Lint warnings:** 45 (unused imports/vars)
- **Critical security issues:** 4
- **High-priority issues:** 12
- **Medium-priority issues:** 15+

---

## 1. Architecture Findings

### Strengths
- **Domain-driven organization** with clear separation in both `src/lib/` (18 domain modules) and `src/components/` (20 domain folders)
- **Next.js 16 App Router** with server-side business logic properly separated
- **Tailwind CSS 4** with CSS custom property design tokens for consistent theming
- **CI/CD pipeline** configured (GitHub Actions: lint, typecheck, test, build)
- **Strict TypeScript** configuration enabled

### Issues Found

| Issue | Severity | Details |
|-------|----------|---------|
| 36 PNG screenshots at repo root | Medium | Design reference images cluttering the repository root. Should be in `docs/screenshots/` or removed |
| Dead code files at root | Low | `check-query.js`, `no-data-check.js` (hardcoded legacy scripts), `tree_with_file_sizes.csv` (temp analysis artifact) |
| CSRF middleware misplaced | High | `proxy.ts` at root contains CSRF protection but is not registered as Next.js middleware. Should be `middleware.ts` |
| Dual Excel libraries | Low | Both `exceljs` (4.4.0) and `xlsx` (0.18.5) are dependencies; consider consolidating |
| Missing `.env.example` | Medium | No environment variable template exists; 20+ env vars are required but undocumented |
| Custom test runner | Low | Uses raw Node.js test runner instead of Jest/Vitest; limits test tooling ecosystem |
| `tsconfig.json` path alias ambiguity | Low | `@/*` maps to both `./*` and `./src/*` |

### Root-Level Files That Should Be Cleaned Up
- 36 PNG files (design screenshots)
- `check-query.js`, `no-data-check.js` (dead code)
- `tree_with_file_sizes.csv` (temp artifact)
- `Phoneix system template.xlsx` (typo in name, should be in `docs/`)
- `start-dev.ps1` (should be in `scripts/`)

---

## 2. HR_ID Source of Trust Findings

### Overall Grade: A- (Strong Foundation)

### Strengths
- `hr_id text primary key` on the `employees` table -- canonical identifier
- All FK references cascade updates correctly (`ON UPDATE CASCADE`)
- Session tokens carry HR_ID for access control
- Manager relationships properly reference `manager_hr_id`
- Import validation detects HR_ID duplicates
- Auto-generation with line-based prefixes (`AI-`, `PD-`, `CN-`, `OF-`, `PH-`)
- HR_ID stored in Supabase auth metadata

### Weaknesses

| Issue | Severity | Location |
|-------|----------|----------|
| Login ID used as fallback HR_ID | Medium | `src/lib/auth/credentials.ts:96` -- if `hr_id` is NULL in `app_auth_users`, `login_id` becomes the session HR_ID |
| CEO hardcoded as HR_ID "AA" | Low | `src/components/reports/organogram-report.tsx:142` -- should be config-driven |
| Payroll dual-searches HR_ID + employee_code | Low | `src/lib/payroll/service.ts:73-91` -- intentional for backward compat but could return duplicates |
| Manager HR_ID not pre-validated | Medium | `src/lib/employees/employee-directory.ts` -- FK constraint catches invalid values, but user gets cryptic error |
| Inconsistent column naming | Medium | Some tables use `hr_id`, others use `employee_hr_id` -- makes joins error-prone |

### Recommendations
1. Enforce HR_ID during user provisioning (reject NULL)
2. Replace hardcoded CEO check with role-based flag
3. Add pre-insert manager HR_ID validation with helpful error messages
4. Standardize column naming to `employee_hr_id` across all tables

---

## 3. Workflow Findings

### Login & Session (Working)
- Credential validation via `bcryptjs` with rate limiting
- Session tokens using HMAC-SHA256
- Session version tracking prevents concurrent session abuse
- Role-based landing path routing
- Idle timeout (45 minutes) with heartbeat monitoring

### Employee Import (Working, 1 Critical Bug)
- Three-step flow: upload, dry-run validation, confirm import
- HR_ID duplicate detection
- Organization structure auto-creation (departments, lines, areas, positions)
- **CRITICAL: `/api/imports/employees/confirm` has NO authentication check** -- any unauthenticated user can confirm imports

### Payroll Upload (Working)
- CSV upload with validation
- Salary batch creation with anomaly flagging
- Batch approval workflow
- Payslip generation and download

### Payslip Access (Working)
- Employee-scoped visibility via HR_ID
- Admin/Finance/HR get full access via scope check
- **Missing: Payslip email notification is dead code** (no registered `notificationType`)

### Expenses (Partially Working)
- Expense upload and dashboard functional
- Expense reports with filtering
- **Employee portal expenses page is a stub** -- just redirects to home

### Sales (Working)
- Import workflow with queue
- Employee-HR_ID matching with confidence scores
- Dashboard with filtering

### Probation & Contracts (Working)
- Tracker with traffic light status
- Workflow actions (extend, confirm, terminate)
- Notification sending on status changes
- **Missing FK on `employee_probation.employee_hr_id`** -- no referential integrity

### Resignations (Working, Missing UI)
- API route exists
- **No admin UI page** for managing resignations

### Offers (Working)
- Full lifecycle: create, approve, send, accept/reject
- Token-based candidate access
- Email templates with compensation tables
- Audit logging

### Organogram (Bug)
- **Uses `getVacancyReport()` instead of organogram-specific service** (`app/organogram/page.tsx:42`)
- Displays vacancy data instead of organizational hierarchy

### Notifications (Partially Broken)
- 5 typed notification types work (probation, contract_renewal, birthday, offer, resignation)
- **Payroll, import, and password-setup emails are dead code** -- they call `safeSendNotificationEmail` without a valid `notificationType`, causing silent rejection
- No cron scheduler configured for birthday notifications
- No outbox retry mechanism

---

## 4. Database / RLS Findings

### Tables Inventory
40+ tables across core, payroll, sales, RBAC/auth, offers, contracts/probation/resignations, geo-intelligence, outstation, brick reference, and notifications.

### Critical Database Issues

| Issue | Severity | Tables Affected |
|-------|----------|-----------------|
| **11 tables have NO RLS enabled** | CRITICAL | `geo_locations`, `geo_trip_routes`, `geo_bricks`, `employee_locations`, `outstation_policy_rules`, `outstation_expense_requests`, `outstation_location_audit_logs`, `brick_reference_imports`, `brick_reference_rows`, `auth_login_attempts`, `password_setup_tokens` |
| **Missing FK constraints** | CRITICAL | `employee_probation.employee_hr_id`, `employee_resignations.employee_hr_id`, `payroll_expenses.hr_id`, all geo/outstation `employee_hr_id` columns |
| **95% of app code bypasses RLS** | HIGH | Nearly all services use `getSupabaseAdmin()` (service_role). Employee portal uses admin client for employee-facing queries |
| **5 duplicate `supabaseRest()` helpers** | HIGH | `employee-directory.ts`, `hr-id-helper.ts`, `overview/service.ts`, `offers/service.ts`, `vacancies.ts` -- each builds raw `fetch()` with service-role key |
| **7 tables with no DDL in repo** | HIGH | `employee_documents`, `notification_events`, `notification_event_types`, `notification_delivery_logs`, `platform_settings`, `system_audit_logs`, `messages` -- referenced in hardening but never created in migrations |
| **No unique constraint on salary batches period** | HIGH | `salary_batches` allows multiple batches for same `(year, month)` |
| **Views lack `security_barrier`** | Medium | `v_employee_portal_salary_history`, `v_employee_portal_sales` etc. could leak info |
| **Overlapping RLS policies from migration churn** | Medium | Policies created, dropped, recreated across multiple migration files -- final state hard to determine |

### Naming Inconsistencies
- `salary_records` uses `hr_id`; `employee_compensation` uses `employee_hr_id`
- `payroll_expenses` uses `hr_id`; `outstation_expense_requests` uses `employee_hr_id`

---

## 5. API Findings

### Route Coverage
70+ API routes covering auth, admin, employees, imports, payroll, expenses, sales, offers, probation, resignations, contracts, geo-intelligence, outstation, and notifications.

### Critical API Security Issues

| Issue | Severity | Path | Impact |
|-------|----------|------|--------|
| **Unauthenticated import confirm** | CRITICAL | `/api/imports/employees/confirm` | No `resolveAccessContext()` or `assertPermission()` -- any user can create/update employees |
| **Weak CRON secret fallback** | HIGH | `/api/notifications/birthdays` | Falls back to `process.env.NODE_ENV === "development"` if `CRON_SECRET` unset |
| **Service key in error messages** | HIGH | `app/reports/vacancies/page.tsx`, `app/organogram/page.tsx` | Error messages mention `SUPABASE_SERVICE_ROLE_KEY` |
| **Missing CSRF enforcement** | MEDIUM | All mutation endpoints | CSRF protection exists in `proxy.ts` but is not registered as middleware |
| **No pagination limits** | MEDIUM | `/api/admin/logs`, `/api/employees` | Could allow bulk data extraction |
| **Coordinate validation gaps** | MEDIUM | `/api/outstation/submit` | `Number()` without `isFinite()` check or range validation |

### Auth Pattern
- Most routes properly check `resolveAccessContext()` + `assertPermission()`
- Role-based permission matrix with default + database-driven overrides
- Session version tracking
- Proper cookie attributes (httpOnly, sameSite=lax, secure in production)

---

## 6. Frontend Integration Findings

### Page Status Summary

| Category | Total | Working | Issues |
|----------|-------|---------|--------|
| Admin pages | 14 | 14 | None |
| Employee portal pages | 16 | 14 | 2 (expenses stub, missing error prop) |
| Payroll pages | 4 | 4 | None |
| Sales pages | 3 | 3 | None |
| Report pages | 4 | 3 | 1 (organogram uses wrong data) |
| Workflow pages (offers, contracts, etc.) | 8 | 8 | None |
| Auth pages | 3 | 3 | None |
| **Total** | **58** | **54** | **4** |

### Key Issues

1. **Organogram page uses wrong data service** -- `app/organogram/page.tsx:42` calls `getVacancyReport()` instead of organogram data
2. **Employee portal expenses page is a stub** -- `app/employee-portals/expenses/page.tsx` just redirects to home
3. **Employee portal sales page missing error prop** -- `app/employee-portals/sales/page.tsx:73` doesn't pass `initialError`
4. **Resignations report page doesn't exist** -- API route exists but no admin UI

### Strengths
- **Zero mock data found** -- all pages use real database connections
- **Consistent error handling** -- try-catch on all server pages with specific error detection
- **Permission integration** -- all pages check `canAccess()` or `assertPermission()`
- **Loading states** -- admin and payroll pages have dedicated loading skeletons
- **Force-dynamic** properly set on dashboard pages

---

## 7. Duplicate Logic Map

| # | Duplication | Files | Risk | Recommended Action | Auto-fix Safe? |
|---|-----------|-------|------|--------------------|---------------|
| 1 | `buildManagerMap` + hierarchy traversal | `payroll/service.ts`, `payroll/expenses.ts`, `sales/service.ts` | HIGH | Merge to `src/lib/auth/hierarchy.ts` | Yes |
| 2 | `resolve*AccessFilter` scope resolution | `payroll/service.ts`, `payroll/expenses.ts`, `sales/service.ts` | HIGH | Merge to generic in `src/lib/auth/permissions.ts` | Moderate |
| 3 | `escapeHtml` | `offers/email.ts`, `notifications/email.ts`, `phoenix-hr-reply-template.ts` | Medium | Merge to `src/lib/email/html-utils.ts` | Yes |
| 4 | `formatCurrency*` (EGP) | 5 files across employee-portal, offers, sales, outstation | Medium | Use `formatCurrencyValue` from `src/lib/i18n/format.ts` | Yes |
| 5 | `employeeNameKeys` + name-to-ID map | `expense-import.ts`, `expenses.ts` | Medium | Merge to `src/lib/employees/employee-name-lookup.ts` | Yes |
| 6 | `cleanText` / `text` whitespace normalization | 8 files | Low | Merge to `src/lib/utils/text.ts` | Yes |
| 7 | `normalizeName` | 3 files | Low | Merge to `src/lib/utils/text.ts` | Yes |
| 8 | `getRequiredEnv` | 6 files | Low | Merge to `src/lib/env.ts` | Yes |
| 9 | `*ErrorMessage` extraction | 8 files | Low | Merge to `src/lib/utils/error.ts` | Yes |
| 10 | `is*SchemaMissing` detection | 9 files | Medium | Merge to `src/lib/supabase/errors.ts` | Yes |
| 11 | `toNumber` / `numberValue` | 6 files | Low | Merge to `src/lib/utils/number.ts` | Yes |
| 12 | Resend API dual send paths | `offers/email.ts`, `notifications/email.ts` | Medium | Merge offer sending into notification infra | Moderate |
| 13 | `formatDate` (email vs UI) | 2 files | Low | Keep (intentional differences) | N/A |

**Total: 13 duplication patterns across 60+ files**

---

## 8. Error / Build Findings

### TypeScript
- **Before audit:** 11 errors
- **After safe fixes:** 0 errors
- **Errors fixed:** `PageProps` type undefined in 7 pages (replaced with proper Next.js 16 type), implicit `any` on 4 `period` parameters (added explicit `string` type annotations)

### ESLint
- **Errors:** 14 (pre-existing, not safe to auto-fix)
  - 1 try/catch JSX issue in `password-setup/[token]/page.tsx`
  - 6 `any` types in `brick-coverage-map.tsx` (Google Maps typings)
  - 6 `any` types in `expense-route-map.tsx` (Google Maps typings)
  - 1 setState-in-effect in `mobile-outstation-wizard.tsx`
- **Warnings:** 45 (unused imports/variables across ~15 files)

### Build
- TypeScript compilation passes cleanly
- No broken imports detected
- No missing module errors

---

## 9. Security Findings

### Critical Vulnerabilities

| ID | Issue | Severity | Impact | Remediation |
|----|-------|----------|--------|-------------|
| S-1 | Unauthenticated employee import confirmation | CRITICAL | Data breach, arbitrary employee creation | Add auth check to `/api/imports/employees/confirm` |
| S-2 | 11 database tables without RLS | CRITICAL | Unauthenticated data access to geo, outstation, login attempts, password tokens | Enable RLS + add service_role policies |
| S-3 | CSRF middleware not registered | HIGH | Cross-site request forgery on all mutation endpoints | Move `proxy.ts` to `middleware.ts` |
| S-4 | Employee portal uses service-role key | HIGH | RLS policies on salary/compensation tables are bypassed | Migrate to RLS-scoped client |
| S-5 | 5 duplicate `supabaseRest()` with service-role key | HIGH | Key scattered across 5 files, unauditable | Consolidate to single utility |
| S-6 | Service key mentioned in client-facing error messages | HIGH | Information disclosure | Use generic error messages |
| S-7 | CRON secret dev fallback | HIGH | Birthday endpoint open without secret in dev | Remove fallback |
| S-8 | No pagination limits on sensitive endpoints | MEDIUM | Bulk data extraction | Enforce max page size |
| S-9 | Coordinate validation gaps | MEDIUM | Invalid geodata storage | Add `isFinite()` and range checks |
| S-10 | `password_setup_tokens` has no RLS | HIGH | Token hash exposure | Enable RLS immediately |

### Strengths
- Session tokens use HMAC-SHA256
- Session version tracking prevents replay attacks
- Password hashing with bcryptjs
- Dev-header auth restricted to localhost only
- Proper cookie attributes (httpOnly, sameSite, secure)

---

## 10. Business Logic Findings

### HR_ID as Employee Identity
- **Status:** Properly implemented as primary key and FK reference across the system
- **Gap:** Login ID fallback when HR_ID is NULL in auth table

### Manager_HR_ID Hierarchy
- **Status:** FK with CASCADE UPDATE/SET NULL on delete -- correct design
- **Gap:** No pre-validation with helpful error messages

### Payroll Month/Year Selection
- **Status:** Working with month/year filters
- **Gap:** No unique constraint on `salary_batches(year, month)` -- allows duplicate batches

### Payslip Employee-Only Visibility
- **Status:** Properly scoped via `canAccessPayroll()` and HR_ID matching
- **Working correctly**

### Admin/Finance/HR Full Payroll Access
- **Status:** Implemented via `getPayrollScope() === "COMPANY"` check
- **Working correctly**

### Expenses Validation
- **Status:** Upload, import, and dashboard working
- **Gap:** Employee portal expenses page is a stub

### Probation & Contract Reminders
- **Status:** Notification types registered and functional
- **Gap:** No cron scheduler configured for automated reminders

### Role-Based Access & Visibility
- **Status:** Comprehensive permission matrix with resource/action/scope model
- **Gap:** Loose role normalization could allow edge-case escalation

### Regular Deductions vs Government Deductions
- **Status:** Salary records separate all deduction types in dedicated columns
- **Working correctly**

---

## 11. Email / Notification Findings

### Template Inventory
| Template | Status | Brand Consistency |
|----------|--------|-------------------|
| Generic notification | Complete | Good -- Phoenix orange, dark nav header |
| Job offer letter | Complete | Good -- full compensation table, accept/decline buttons |
| HR reply | Complete | Excellent -- dark-mode overrides, signature, animations |
| Offer salary data (4 role templates) | Complete | N/A (data only) |

### Critical Issues

1. **Payroll, import, and password-setup emails are dead code** -- `safeSendNotificationEmail` rejects them because they lack a registered `notificationType`. Password reset emails silently fail to send.

2. **No cron scheduler configured** -- birthday endpoint supports CRON auth but no `vercel.json` cron exists. No background retry for failed outbox items.

3. **Three independent Resend API implementations** -- `notifications/email.ts`, `offers/email.ts`, `email-reply/send/route.ts` each have their own `fetch()` to `api.resend.com`. Should be consolidated.

4. **Hardcoded client-specific content** -- "Sato Pharmaceuticals", "hr@satopharma.com", "Sato Pharma" throughout offer templates. Should be environment-driven.

### Deduplication
- Notification outbox uses SHA-256 hash-based deduplication (robust)
- Offer emails use offer-code-based idempotency key (adequate)
- HR reply emails use timestamp-based key (no actual deduplication)

---

## 12. Missing Features / Completion Gap

### Critical Missing
- [ ] Authentication on employee import confirmation endpoint
- [ ] RLS on 11 unprotected database tables
- [ ] CSRF middleware registration
- [ ] Working password-setup email delivery

### Partially Implemented
- [ ] Employee portal expenses page (stub -- redirects to home)
- [ ] Resignations admin UI (API exists, no page)
- [ ] Organogram page (uses wrong data service)
- [ ] Notification outbox retry mechanism (delays defined but no scheduler)
- [ ] Birthday notification cron scheduling

### Missing Integrations
- [ ] Payslip email notifications (no notification type registered)
- [ ] Welcome/onboarding email after offer acceptance
- [ ] Document expiry notifications
- [ ] Leave/absence notifications

### Missing Database Relations
- [ ] FK on `employee_probation.employee_hr_id`
- [ ] FK on `employee_resignations.employee_hr_id`
- [ ] FK on `payroll_expenses.hr_id`
- [ ] FK on all geo/outstation `employee_hr_id` columns

### Missing Validation
- [ ] Manager HR_ID pre-validation with helpful errors
- [ ] Coordinate range validation for outstation
- [ ] Pagination limits on sensitive API endpoints

### Missing Tests
- [ ] No E2E tests
- [ ] No component tests
- [ ] Only 5 unit test files covering business logic
- [ ] No API route tests

### Missing Admin Controls
- [ ] Resignations management UI
- [ ] Notification outbox retry UI/trigger
- [ ] System health monitoring dashboard (exists but limited)

### Missing Monitoring
- [ ] No structured logging framework
- [ ] No APM integration
- [ ] No error tracking (Sentry etc.)

---

## 13. P0/P1/P2/P3 Priority Roadmap

### P0 - Critical (Must Fix Before Production)

| # | Issue | Module | Risk | Fix | Complexity | Files | Auto-fix? |
|---|-------|--------|------|-----|-----------|-------|-----------|
| P0-1 | Unauthenticated import confirm | Imports | Data breach | Add auth + permission check | Low | `app/api/imports/employees/confirm/route.ts` | Yes |
| P0-2 | 11 tables without RLS | Database | Data exposure | Enable RLS + service_role policies | Medium | `supabase/` (new migration) | Review first |
| P0-3 | Password-setup emails silently fail | Email | Users can't reset passwords | Register `password_setup` as notification type OR bypass delivery resolver | Low | `src/lib/auth/password-setup.ts`, `src/lib/notifications/email.ts` | Review first |
| P0-4 | `password_setup_tokens` has no RLS | Security | Token hash exposure | Enable RLS | Low | `supabase/` (new migration) | Review first |
| P0-5 | CSRF middleware not active | Security | CSRF attacks | Move `proxy.ts` to `middleware.ts` | Low | `proxy.ts` -> `middleware.ts` | Review first |
| P0-6 | Missing FK constraints (probation, resignations) | Database | Orphaned records | Add FK constraints | Low | `supabase/` (new migration) | Review first |

### P1 - High (Important Before Pilot Launch)

| # | Issue | Module | Risk | Fix | Complexity | Files | Auto-fix? |
|---|-------|--------|------|-----|-----------|-------|-----------|
| P1-1 | Employee portal uses service-role key | Security | RLS bypassed | Migrate to RLS-scoped client | High | `src/lib/employee-portal/service.ts` | Review first |
| P1-2 | Consolidate 5 `supabaseRest()` helpers | Security/Architecture | Key scatter | Single centralized utility | Medium | 5 files in `src/lib/` | Review first |
| P1-3 | Payroll/import email notifications dead | Email | Missing notifications | Register notification types | Low | `src/lib/notifications/email.ts` | Review first |
| P1-4 | CRON secret dev fallback | Security | Open birthday endpoint | Remove fallback | Low | `app/api/notifications/birthdays/route.ts` | Yes |
| P1-5 | Service key in error messages | Security | Info disclosure | Generic error messages | Low | `app/reports/vacancies/page.tsx`, `app/organogram/page.tsx` | Yes |
| P1-6 | Organogram uses wrong data service | Frontend | Wrong data displayed | Fix data service call | Low | `app/organogram/page.tsx` | Review first |
| P1-7 | Add `.env.example` | DevOps | New dev onboarding | Document all env vars | Low | New file | Yes |
| P1-8 | Merge access filter duplication | Architecture | Security divergence | Generic `resolveAccessFilter` | Medium | 3 files in `src/lib/` | Review first |
| P1-9 | Merge hierarchy traversal duplication | Architecture | Bug propagation | Shared `buildManagerMap` | Medium | 3 files in `src/lib/` | Yes |
| P1-10 | Add pagination limits | Security | Data extraction | Max page size enforcement | Low | Multiple API routes | Yes |
| P1-11 | Unique constraint on salary batches period | Database | Duplicate batches | Add `UNIQUE(year, month)` or business rule | Low | `supabase/` (new migration) | Review first |
| P1-12 | Create `.env.example` file | DevOps | Onboarding | Document 20+ required env vars | Low | New file | Yes |

### P2 - Medium (Improves Stability and Operations)

| # | Issue | Module | Risk | Fix | Complexity | Files | Auto-fix? |
|---|-------|--------|------|-----|-----------|-------|-----------|
| P2-1 | Employee portal expenses page stub | Frontend | Broken nav | Implement or remove from nav | Medium | `app/employee-portals/expenses/page.tsx` | Review first |
| P2-2 | Resignations admin UI missing | Frontend | No management | Create page | Medium | New page file | Review first |
| P2-3 | Configure cron for birthday notifications | Email | Missing automated reminders | Add cron config | Low | `vercel.json` or equivalent | Review first |
| P2-4 | Notification outbox retry scheduler | Email | Failed emails stuck | Add background processor | Medium | New cron/worker | Review first |
| P2-5 | Consolidate Resend API calls | Architecture | 3 copies | Shared `sendViaResend()` utility | Medium | 3 files | Yes |
| P2-6 | Merge `escapeHtml` copies | Architecture | DRY violation | Shared utility | Low | 3 files | Yes |
| P2-7 | Merge `formatCurrency` copies | Architecture | DRY violation | Use `formatCurrencyValue` | Low | 5 files | Yes |
| P2-8 | Merge `cleanText` / `text` copies | Architecture | DRY violation | Shared `src/lib/utils/text.ts` | Low | 8 files | Yes |
| P2-9 | Merge `getRequiredEnv` copies | Architecture | DRY violation | Add to `src/lib/env.ts` | Low | 6 files | Yes |
| P2-10 | Merge `*ErrorMessage` copies | Architecture | DRY violation | Shared `src/lib/utils/error.ts` | Low | 8 files | Yes |
| P2-11 | Merge `is*SchemaMissing` copies | Architecture | DRY violation | Generic `isTableMissing()` | Low | 9 files | Yes |
| P2-12 | Fix lint errors (Google Maps `any` types) | Code Quality | Type safety | Add proper Google Maps types | Medium | 2 component files | Review first |
| P2-13 | Clean up 45 unused import warnings | Code Quality | Code cleanliness | Remove unused imports | Low | ~15 files | Yes |
| P2-14 | Remove root-level screenshot PNGs | Repository | Repo bloat | Move to `docs/` or delete | Low | 36 files | Yes |
| P2-15 | Add `security_barrier` to views | Database | Info leakage | ALTER VIEW | Low | `supabase/` (new migration) | Review first |

### P3 - Enhancement (Future Polish and Scale)

| # | Issue | Module | Risk | Fix | Complexity | Files | Auto-fix? |
|---|-------|--------|------|-----|-----------|-------|-----------|
| P3-1 | Add Jest/Vitest test framework | Testing | No proper test infra | Install and configure | Medium | Config files | Review first |
| P3-2 | Add E2E tests (Playwright) | Testing | No E2E coverage | Add test suite | High | New test files | Review first |
| P3-3 | Add API route tests | Testing | No API test coverage | Add test files | High | New test files | Review first |
| P3-4 | Client-specific content in offer templates | Architecture | Non-portable | Move to env vars / config | Low | `src/lib/offers/email.ts` | Yes |
| P3-5 | Payslip email notifications | Feature | Missing notification | Register notification type | Medium | Multiple files | Review first |
| P3-6 | Welcome/onboarding email | Feature | Missing flow | Create template + trigger | Medium | Multiple files | Review first |
| P3-7 | Error tracking (Sentry) | Monitoring | No error visibility | Install + configure | Medium | Config + wrapper | Review first |
| P3-8 | Structured logging | Monitoring | Limited observability | Add logging framework | Medium | Multiple files | Review first |
| P3-9 | Manager HR_ID pre-validation | UX | Cryptic FK errors | Add validation helper | Low | `src/lib/employees/employee-directory.ts` | Yes |
| P3-10 | Remove CEO HR_ID hardcode | Code Quality | Code smell | Config-driven | Low | `src/components/reports/organogram-report.tsx` | Yes |
| P3-11 | Delete dead code files | Code Quality | Confusion | Remove check-query.js, no-data-check.js | Low | Root files | Yes |
| P3-12 | Standardize hr_id column naming | Database | Join errors | Migration to rename columns | High | `supabase/` + multiple service files | Review first |

---

## 14. Safe Fixes Applied

### TypeScript Error Fixes (11 errors resolved)

| File | Fix Applied |
|------|------------|
| `app/admin/geo-intelligence/page.tsx` | Replaced `PageProps<...>` with `{ searchParams: Promise<Record<string, string \| string[] \| undefined>> }` |
| `app/admin/geo-intelligence/anomalies/page.tsx` | Same PageProps fix |
| `app/admin/geo-intelligence/expense-routes/page.tsx` | Same PageProps fix |
| `app/admin/geo-intelligence/territory-map/page.tsx` | Same PageProps fix |
| `app/admin/payslips-center/page.tsx` | Same PageProps fix |
| `app/employee-portals/brick-coverage/page.tsx` | PageProps fix + added explicit `string` type to `period` parameter in `.map()` callbacks |
| `app/employee-portals/team-expenses/page.tsx` | PageProps fix + added explicit `string` type to `period` parameter in `.map()` callbacks |

**Total: 7 files modified, 11 TypeScript errors resolved, 0 behavior changes**

---

## 15. Items Not Changed Because They Need Human Review

| Item | Reason |
|------|--------|
| Employee import confirm auth check | Needs confirmation on which permission resource/action to use |
| RLS enablement on 11 tables | Destructive migration -- needs DBA review |
| CSRF middleware registration | Could affect existing form flows |
| Organogram data service fix | Need to understand intended behavior vs current |
| Employee portal RLS migration | Major architectural change requiring full regression testing |
| Notification type registration for payroll/password | Could have unintended email delivery side effects |
| Access filter consolidation | Security-critical code -- needs careful review |
| Column naming standardization | Requires coordinated migration across schema + app code |
| Birthday cron configuration | Deployment-environment specific |
| Salary batch unique constraint | Could reject existing duplicate data |
| Resignation page creation | Needs product/design input |
| Employee expenses page | Needs product/design input |
| Google Maps `any` type fixes | Requires proper Google Maps type definitions |
| setState-in-effect fix | Could alter component lifecycle behavior |

---

## 16. Recommended Next Implementation Plan

### Week 1 (Emergency Fixes)
1. Add auth check to `/api/imports/employees/confirm`
2. Enable RLS on `password_setup_tokens` and `auth_login_attempts`
3. Fix password-setup email delivery (register notification type or use direct send)
4. Move `proxy.ts` to `middleware.ts`
5. Remove CRON secret dev fallback
6. Remove service key from error messages

### Week 2 (Security Hardening)
1. Enable RLS on remaining 9 unprotected tables
2. Add FK constraints on probation, resignations, payroll_expenses
3. Consolidate `supabaseRest()` helpers
4. Add pagination limits to sensitive endpoints
5. Add coordinate validation

### Week 3 (Architecture Cleanup)
1. Merge `buildManagerMap` + hierarchy traversal (3 files)
2. Merge `resolveAccessFilter` (3 files)
3. Consolidate Resend API calls
4. Merge utility duplications (`cleanText`, `getRequiredEnv`, `*ErrorMessage`, `is*SchemaMissing`, `toNumber`)

### Week 4 (Feature Completion)
1. Fix organogram data service
2. Implement employee expenses page or remove from nav
3. Create resignations admin UI
4. Configure cron for birthday notifications
5. Implement outbox retry scheduler
6. Create `.env.example`

---

*Report generated: 2026-05-10*
*System under audit: Phoenix Workforce (Next.js 16 / React 19 / Supabase)*
*Audit methodology: Automated static analysis + manual code review + TypeScript/ESLint verification*
