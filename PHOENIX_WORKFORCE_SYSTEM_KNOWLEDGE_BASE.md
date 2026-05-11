# Phoenix Workforce - Complete System Knowledge Base

**Last Updated:** 2026-05-11
**System:** Next.js 16 / React 19 / Supabase (PostgreSQL with RLS)
**Status:** Comprehensive reference document for any AI tool

---

## Table of Contents
1. [System Overview](#system-overview)
2. [Architecture](#architecture)
3. [Technology Stack](#technology-stack)
4. [Project Structure](#project-structure)
5. [Core Conventions](#core-conventions)
6. [Authentication & Authorization](#authentication--authorization)
7. [Database Schema](#database-schema)
8. [All Services (src/lib/)](#all-services-srclib)
9. [All Components (src/components/)](#all-components-srccomponents)
10. [All API Routes (app/api/)](#all-api-routes-appapi)
11. [All Pages & Routing (app/)](#all-pages--routing-app)
12. [Types & Business Rules](#types--business-rules)
13. [Environment Variables](#environment-variables)
14. [Key Business Logic](#key-business-logic)
15. [Critical Issues Found](#critical-issues-found)
16. [Safe Fixes Applied](#safe-fixes-applied)

---

## System Overview

Phoenix Workforce is a comprehensive HR management platform covering:
- **Employee Management:** Directory, profiles, import, history
- **Payroll:** Salary batches, payslips, deductions, additions
- **Expenses:** Trip tracking, expense reports, approval workflow
- **Sales Analytics:** Sales performance, territory management, sales queue
- **Probation & Contracts:** Tracking, renewals, evaluations
- **Job Offers:** Lifecycle management, acceptance, onboarding
- **Geo-Intelligence:** Brick coverage, trip routes, heatmaps
- **Outstation:** Location capture, allowance calculation, fraud detection
- **Notifications:** Email templates, delivery, approval workflows
- **Reports:** Vacancies, organogram, resignations, HR calendar

**Overall Health:** 6.5/10 (Strong architecture, critical security gaps, code duplication)

---

## Architecture

### Frontend
- **Framework:** Next.js 16 (App Router)
- **UI Library:** React 19
- **Styling:** Tailwind CSS 4 with CSS custom property tokens
- **State:** Server-side rendering preferred, some client-side with React hooks
- **Theme:** Premium light mode (white/light gray), Phoenix orange (#f97316) accent

### Backend
- **Runtime:** Node.js (Deno for Edge Functions if used)
- **Database:** Supabase (PostgreSQL 15+)
- **Authentication:** Supabase Auth + Custom session tokens (JWT HMAC-SHA256)
- **Authorization:** Role-based permission matrix + RLS policies
- **Business Logic:** Server-side in `src/lib/` services
- **API:** REST routes in `app/api/`

### Infrastructure
- **Deployment:** Vercel (inferred from Next.js + env vars)
- **Email:** Resend API
- **Maps:** Google Maps (browser + server)
- **File Storage:** Supabase Storage (inferred)
- **Cron:** Vercel Cron (configured but not active)

---

## Technology Stack

### Core Dependencies
- `next`: 16.2.4
- `react`: 19.2.4
- `@supabase/supabase-js`: 2.105.1
- `tailwindcss`: 4.0.0
- `framer-motion`: 12.38.0 (animations)
- `recharts`: 3.8.1 (charts)
- `exceljs`: 4.4.0 (spreadsheets)
- `xlsx`: 0.18.5 (spreadsheets)
- `lucide-react`: 1.11.0 (icons)
- `bcryptjs`: 3.0.3 (password hashing)

### Key Patterns
- **Server Actions:** Minimal use; prefer API routes
- **Streaming:** No visible streaming usage
- **Middleware:** CSRF protection in `proxy.ts` (NOT ACTIVE - needs registration)
- **Hooks:** Custom hooks in `src/lib/employee-portal/`

---

## Project Structure

```
phoenix-workforce/
├── app/                          # Next.js App Router
│   ├── api/                      # API routes (70+ endpoints)
│   │   ├── admin/                # Admin operations
│   │   ├── auth/                 # Authentication (login, logout, password-setup)
│   │   ├── employees/            # Employee directory management
│   │   ├── imports/              # Employee & brick imports
│   │   ├── payroll/              # Payroll operations
│   │   ├── contracts/            # Contract workflows
│   │   ├── probation/            # Probation workflows
│   │   ├── offers/               # Job offer lifecycle
│   │   ├── sales/                # Sales management
│   │   ├── outstation/           # Outstation expense
│   │   ├── geo/                  # Geo-intelligence
│   │   ├── notifications/        # Email notifications
│   │   ├── resignations/         # Resignation workflow
│   │   └── reports/              # Report generation
│   ├── admin/                    # Admin pages (dashboard, data health, monitoring)
│   ├── employee-portals/         # Employee-facing pages
│   ├── payroll/                  # Payroll pages
│   ├── sales/                    # Sales pages
│   ├── contracts/                # Contract pages
│   ├── probation/                # Probation pages
│   ├── offers/                   # Offer pages (public + authenticated)
│   ├── imports/                  # Data import pages
│   ├── organogram/               # Organization chart
│   ├── reports/                  # Report pages
│   ├── resignations/             # Resignation pages
│   ├── employees/                # Employee directory page
│   ├── login/                    # Login page
│   ├── password-setup/           # Password setup page
│   ├── overview/                 # Dashboard landing
│   ├── layout.tsx                # Root layout
│   └── page.tsx                  # Root page (redirects to role landing)
│
├── src/
│   ├── lib/                      # All business logic (18 modules)
│   │   ├── admin/                # Admin service
│   │   ├── auth/                 # Auth, session, permissions, credentials
│   │   ├── bricks/               # Brick reference data
│   │   ├── contracts/            # Contract service & types
│   │   ├── email/                # Email templates
│   │   ├── employee-portal/      # Portal data service & navigation
│   │   ├── employees/            # Employee directory & HR ID generation
│   │   ├── env.ts                # Environment helpers
│   │   ├── geo-intelligence/     # Geo service, Google Maps integration
│   │   ├── google-maps/          # Maps API wrapper
│   │   ├── hr-calendar/          # HR calendar types
│   │   ├── i18n/                 # Localization (en, ar)
│   │   ├── imports/              # Employee import pipeline
│   │   ├── incentives/           # Sales incentive scheme 2026
│   │   ├── notifications/        # Email notification system
│   │   ├── offers/               # Job offer service & templates
│   │   ├── outstation/           # Outstation service & calculation
│   │   ├── overview/             # Dashboard service
│   │   ├── payroll/              # Payroll service, expenses, salary import
│   │   ├── probation/            # Probation service & types
│   │   ├── reports/              # Vacancy & organogram reports
│   │   ├── resignations/         # Resignation service & types
│   │   ├── sales/                # Sales import, validation, service
│   │   ├── security/             # CSRF protection
│   │   ├── supabase/             # DB client wrappers (admin, rls)
│   │   ├── uploads/              # Spreadsheet validation
│   │   ├── utils.ts              # Shared utilities (cn)
│   │   └── db.ts                 # DB client shortcuts
│   │
│   ├── components/               # React components (20 modules)
│   │   ├── admin/                # Admin dashboard components
│   │   ├── auth/                 # Login, password setup, session guard
│   │   ├── brand/                # Phoenix logo
│   │   ├── cards/                # KPI, insight, status cards
│   │   ├── charts/               # Chart types & implementations
│   │   ├── contracts/            # Contract renewal UI
│   │   ├── employee-portal/      # Portal dashboards & dashlets
│   │   ├── employees/            # Employee management UI
│   │   ├── geo/                  # Maps, heatmaps, filters
│   │   ├── hr-calendar/          # Calendar UI
│   │   ├── imports/              # Upload forms
│   │   ├── layout/               # Sidebar, topbar, app-shell, theme
│   │   ├── offers/               # Offer lifecycle UI
│   │   ├── outstation/           # Location capture, forms, maps
│   │   ├── overview/             # Dashboard
│   │   ├── payroll/              # Payroll & expense dashboards
│   │   ├── probation/            # Probation tracker
│   │   ├── reports/              # Report visualizations
│   │   ├── sales/                # Sales dashboard & queue
│   │   └── ui/                   # Primitive UI components
│   │
│   └── styles/
│       ├── tokens.css            # CSS custom properties
│       └── globals.css           # Global styles, animations
│
├── supabase/
│   ├── migrations/               # 42+ PostgreSQL DDL migrations
│   ├── seed/                     # Seed data (if any)
│   └── config/                   # Supabase config
│
├── tests/
│   ├── *.test.ts                 # 6 unit test files
│   └── run-tests.ts              # Custom Node test runner
│
├── public/                       # Static assets
├── package.json                  # Dependencies + scripts
├── tsconfig.json                 # TypeScript config (strict mode)
├── next.config.ts                # Next.js config (minimal)
├── tailwind.config.ts            # Tailwind config (token-based)
├── eslint.config.mjs             # ESLint 9 flat config
├── postcss.config.mjs            # PostCSS with Tailwind plugin
├── CLAUDE.md                     # Claude Code integration
├── AGENTS.md                     # Agent configuration
├── README.md                     # Project overview
└── TODO.md                       # Task tracking
```

---

## Core Conventions

### Naming Conventions
- **HR_ID:** Canonical employee identifier (text, e.g., `PH-0001`, `AI-0234`)
- **Manager_HR_ID:** Manager's HR_ID in hierarchy
- **loginId:** User login identifier (lowercase, trimmed)
- **role:** Phoenix role name (normalized)
- **scope:** Access scope (self, team, hierarchy, line, company)

### Imports
- Use `@/*` path alias for all imports
- Prefer named imports from `src/lib/`
- Server components use `async` functions
- Client components use `"use client"` at top

### API Routes
- File: `app/api/[path]/route.ts`
- Exports: `async function GET/POST/PUT/PATCH/DELETE(request: NextRequest)`
- Pattern: `resolveAccessContext()` → `assertPermission()` → `callService()` → `return Response`
- Use `getSupabaseAdmin()` for service-role queries (should migrate to RLS)

### Pages
- File: `app/[path]/page.tsx`
- Use `export const dynamic = "force-dynamic"` on dashboards
- Fetch data in server component, pass to client components
- Use `redirect()` for permission failures

### Components
- Props passed via destructuring: `function Name({ prop1, prop2 }: Props)`
- Client components use `'use client'` directive
- Loading states via `{isLoading ? <Spinner /> : <Content />}`
- Error handling with try-catch on page level

### Services
- File: `src/lib/[module]/service.ts`
- Exports: `async function name(...): Promise<Type>`
- Error detection: `is[Module]SchemaMissing()`, `is[Module]Timeout()`, `[module]ErrorMessage()`
- Logging: Use console.debug in development only

### Types
- File: `src/lib/[module]/types.ts`
- Exports: `export type Name = ...` (not `interface`)
- Database rows: `export type [Entity]Row = { ... }`
- API payloads: `export type [Entity]Input = { ... }`

### Database
- Tables: snake_case (e.g., `salary_records`, `employee_compensation`)
- Columns: snake_case (e.g., `employee_hr_id`, `created_at`)
- Constraints: FK `ON UPDATE CASCADE ON DELETE SET NULL` (cascading)
- RLS: `ENABLE ROW LEVEL SECURITY` on all tables
- Policies: `USING (condition)` for SELECT, `WITH CHECK (condition)` for INSERT/UPDATE

### Styling
- Use Tailwind CSS utilities
- Design tokens in `src/styles/tokens.css` (CSS custom properties)
- Brand color: Phoenix orange `#f97316` (primary), `#ea580c` (hover), `#fb923c` (lighter)
- Light mode preferred; dark mode via `@media (prefers-color-scheme: dark)`
- Spacing: 4px base unit (Tailwind default)
- Border radius: 8px-20px (rounded card style)

---

## Authentication & Authorization

### Session Management
- **Cookie:** `phoenix_session` (secure, httpOnly, sameSite=lax)
- **Token:** JWT with HMAC-SHA256
- **Payload:** `{ hrId, loginId, role, isActive, sessionVersion, createdAt, idleExpiresAt }`
- **Idle Timeout:** 45 minutes (configurable per role)
- **Session Version:** Incremented on password change; detects concurrent sessions

### Login Flow
1. POST `/api/auth/login` with `loginId` + `password`
2. Validate against `app_auth_users` table (password hashed with bcryptjs)
3. Create Phoenix session token + Supabase auth session
4. Set cookies, redirect to landing page based on role

### Permission Matrix
- **Resources:** employees, payroll, contracts, probation, offers, sales, expenses, notifications, access_control, data_health, geo_intelligence, etc.
- **Actions:** read, create, update, delete, approve, import, export, manage
- **Roles:** Super Admin, HR Admin, Finance Admin, HR, Finance, Manager, Sales Manager, Medical Rep, etc.
- **Scopes:** SELF, TEAM, HIERARCHY, LINE, COMPANY, NONE, SYSTEM
- **Default:** Defined in `src/lib/auth/permissions.ts`
- **Override:** Database table `role_permission_overrides`

### RLS Policies
- **Dynamic:** Use `current_access_*()` helper functions (SECURITY DEFINER)
- **Scope:** Policies respect user's scope (HR_ID matching, manager chain traversal)
- **Caching:** Permission matrix cached for 30 seconds
- **Bypass:** `getSupabaseAdmin()` uses service-role key (bypasses RLS)

---

## Database Schema

### Core Employee Tables
```sql
employees (hr_id text PK)
  - full_name, crm_id, employment_status, job_title
  - manager_hr_id FK (employees)
  - department_id FK (departments), line_id FK (lines), area_id FK (areas)
  - team_id FK (teams), position_id FK (positions)
  - created_at, updated_at
  - RLS: enabled
  - Indexes: manager_hr_id, line_id, area_id, status

employee_compensation (id uuid PK)
  - employee_hr_id FK (employees)
  - net_salary, gross_salary, basic_salary, all_deductions, all_allowances
  - payment_mode (one_part|two_parts)
  - created_at, updated_at
  - RLS: enabled
  - Indexes: employee_hr_id

employee_history (id uuid PK)
  - employee_hr_id FK (employees)
  - change_type, change_details
  - changed_by_user_id
  - created_at
  - RLS: enabled
  - Indexes: (hr_id, change_type), (hr_id, created_at desc)
```

### Payroll Tables
```sql
salary_batches (id uuid PK)
  - file_name, month, year, status, total_gross, row_count
  - uploaded_by, approved_by
  - created_at, updated_at
  - RLS: enabled
  - Indexes: (year, month), status
  - **ISSUE:** No unique constraint on (year, month)

salary_records (id bigint PK)
  - batch_id FK (salary_batches), hr_id FK (employees)
  - full_name, line, area, job_title
  - all salary fields (basic, allowances, deductions, gross, net)
  - unique (batch_id, hr_id)
  - created_at
  - RLS: enabled
  - Indexes: batch_id, hr_id, (batch_id, hr_id), line, area

salary_flags (id bigint PK)
  - batch_id FK (salary_batches)
  - flag_type (duplicate|missing|mismatch), severity (warning|error)
  - message, hr_id
  - created_at
  - RLS: enabled
  - Indexes: batch_id, hr_id, severity
```

### Expense Tables
```sql
payroll_expense_reports (id uuid PK)
  - file_name, row_count, total_expenses
  - status (draft|approved|rejected)
  - created_at, updated_at
  - RLS: enabled

payroll_expenses (id uuid PK)
  - trip_id (unique), report_id FK (payroll_expense_reports)
  - employee_hr_id, specialist, line, area
  - all expense fields (miles, cost, dates, etc.)
  - status, validation_result
  - created_at, updated_at
  - RLS: enabled
  - Indexes: (payout_year, payout_month), hr_id, report_id
  - **ISSUE:** No FK on employee_hr_id
```

### Auth Tables
```sql
app_auth_users (login_id text PK)
  - login_id (lowercase, unique), password_hash
  - hr_id FK (employees), role, is_active
  - locked_until, failed_login_attempts
  - created_at, updated_at
  - RLS: enabled
  - Indexes: lower(login_id), hr_id, role, line, (login_id, locked_until)
  - **ISSUE:** No RLS on auth_login_attempts table

auth_login_attempts (id uuid PK)
  - login_id, ip, attempted_at
  - success (bool)
  - created_at
  - **CRITICAL ISSUE:** NO RLS enabled

password_setup_tokens (id uuid PK)
  - token_hash (unique), login_id FK (app_auth_users)
  - purpose, expires_at
  - created_at, updated_at
  - **CRITICAL ISSUE:** NO RLS enabled
```

### Job Offers
```sql
job_offers (id uuid PK)
  - offer_code (unique), secure_token_hash (unique)
  - candidate_name, candidate_email, job_title
  - area_id FK (areas), department_id FK (departments)
  - line_id FK (lines), manager_hr_id FK (employees)
  - position_id FK (positions)
  - employee_hr_id FK (employees) (nullable)
  - status (draft|sent|accepted|rejected|expired)
  - expires_at, created_by_hr_id FK (employees)
  - created_at, updated_at
  - RLS: enabled (service_role only)
  - Indexes: status, expires_at, lower(candidate_email)
```

### Geo-Intelligence Tables
```sql
geo_locations (id bigint PK)
  - source_type, source_key (unique)
  - label, address_text, latitude, longitude
  - created_at, updated_at
  - **CRITICAL ISSUE:** NO RLS enabled

geo_trip_routes (id bigint PK)
  - employee_hr_id
  - from_text, to_text, from_coordinates, to_coordinates
  - distance_km, duration_minutes, cost_amount
  - source_file_month, status
  - created_at, updated_at
  - **CRITICAL ISSUE:** NO RLS enabled

geo_bricks (id bigint PK)
  - line, area
  - brick_code (unique), brick_name
  - coverage_status
  - created_at, updated_at
  - **CRITICAL ISSUE:** NO RLS enabled

outstation_expense_requests (id bigint PK)
  - employee_hr_id
  - from_city, from_area, to_city, to_area
  - departure_date, return_date
  - status, eligibility_status
  - all allowance fields, total_allowance
  - fraud_flags_json, validation_result
  - created_at, updated_at
  - **CRITICAL ISSUES:** NO RLS enabled, No FK on employee_hr_id
```

### Probation & Contracts
```sql
employee_probation (id uuid PK)
  - employee_hr_id (no FK constraint!)
  - status, probation_end_date
  - created_at, updated_at
  - **ISSUE:** No FK constraint on employee_hr_id

probation_evaluations (id uuid PK)
  - employee_hr_id FK (employees)
  - status, probation_end_date
  - created_at, updated_at

employee_contracts (id uuid PK)
  - employee_hr_id FK (employees)
  - status, contract_renewal_date
  - created_at, updated_at

contract_renewal_requests (id uuid PK)
  - employee_hr_id FK (employees)
  - requested_renewal_date, status
  - created_at, updated_at
```

### Notifications
```sql
notification_outbox (id uuid PK)
  - dedupe_key (unique), payload (jsonb)
  - status (pending|sent|failed), attempts
  - max_attempts, next_attempt_at
  - last_error, last_attempt_at
  - created_at, updated_at
  - RLS: enabled
  - Indexes: (status, next_attempt_at, created_at)

notification_events (table exists but no DDL in repo)
notification_event_types (table exists but no DDL in repo)
notification_delivery_logs (table exists but no DDL in repo)
email_notification_policies (notification_type text PK)
  - notification_type, recipient_mode, enabled
  - all flags for different notification types
```

### Org Reference
```sql
departments (id bigint PK)
  - name (unique), code (unique)
  - created_at, updated_at
  - RLS: enabled

lines (id bigint PK)
  - name (unique), code (unique)
  - created_at, updated_at
  - RLS: enabled

areas (id bigint PK)
  - name (unique), code (unique)
  - created_at, updated_at
  - RLS: enabled

teams (id bigint PK)
  - name (unique)
  - created_at, updated_at
  - RLS: enabled

positions (id bigint PK)
  - title (unique), code (unique)
  - area_id FK (areas), line_id FK (lines), team_id FK (teams)
  - created_at, updated_at
  - RLS: enabled
```

### Sales Tables
```sql
sales_import_batches (id uuid PK)
  - file_name, line, month, year, period, status
  - employee_match_confidence, reconciliation_status
  - duplicate_hash
  - created_at, updated_at
  - RLS: enabled (service_role only)
  - Indexes: (status, year, month), duplicate_hash

sales_records (id bigserial PK)
  - batch_id FK (sales_import_batches)
  - row_number, line, territory, sales_type, family, product
  - month, year
  - employee_hr_id, manager_hr_id
  - all sales amount fields
  - link_status, created_at
  - RLS: enabled
  - Indexes: batch_id, manager_hr_id, employee_hr_id, (year, month)

sales_role_overrides (hr_id text PK)
  - role (MR|DSM|NSM override)
  - created_at, updated_at
  - RLS: enabled (service_role only)
```

---

## All Services (src/lib/)

### Authentication Module (src/lib/auth/)
```
audit.ts
  - getRequestIp(request)
  - writeAuthAudit(input)
  - recordLoginAttempt(input)
  - registerFailedLoginAttempt(input)
  - clearFailedLoginState(input)
  - isLoginRateLimited(loginId, ip)

credentials.ts
  - type AppAuthUser = { loginId, hrId, role, isActive, ... }
  - normalizeLoginId(value)
  - resolveStoredLoginId(identifierInput)
  - authenticateLoginId(loginIdInput, password)

landing.ts
  - resolveLandingPathForRole(role) → "/admin" | "/employee-portals"

password-setup.ts
  - type PasswordSetupPreview = { loginId, displayName, ... }
  - createTemporaryAuthPassword()
  - sendPasswordSetupLink(input)
  - getPasswordSetupPreview(token)
  - completePasswordSetup(input)

permissions.ts
  - type PhoenixRole = "Super Admin" | "HR Admin" | ... (20+ roles)
  - type PermissionResource = "employees" | "payroll" | ... (25+ resources)
  - type PermissionAction = "read" | "create" | "update" | "delete" | ... (10+ actions)
  - type AccessScope = "self" | "team" | "hierarchy" | "line" | "company" | "none" | "system"
  - type AccessContext = { hrId, loginId, role, isActive, scope, ... }
  - type NavigationMode = "admin" | "employee-portal"
  - const phoenixRoles: PhoenixRole[] (array of all roles)
  - const permissionMatrix: PermissionMap (default permissions)
  - const systemAccessContext: AccessContext
  - normalizeRole(value) → PhoenixRole (with fallback)
  - parseRoleStrict(value) → PhoenixRole (strict)
  - scopeForRole(role) → AccessScope
  - createAccessContext(input) → AccessContext
  - getPermissionMatrix() → PermissionMatrix (with database overrides)
  - canAccess(context, resource, action) → boolean
  - getSalesScope(context, override) → BusinessScope
  - getPayrollScope(context) → BusinessScope
  - getExpensesScope(context) → BusinessScope
  - canAccessPayroll(context, target) → boolean
  - canAccessSales(context, target) → boolean
  - canSeeEmployee(context, employee) → boolean
  - filterEmployeesForAccess<T>(employees, context) → T[]
  - filterEmployeeDirectoryForAccess(employees, context) → EmployeeDirectoryRow[]
  - async assertPermission(context, resource, action) → void | throws

server.ts
  - type ViewerIdentity = { hrId, displayName, role, loginId, ... }
  - async resolveAccessContext(request) → AccessContext
  - async resolveAccessContextFromPage() → AccessContext
  - async resolveViewerIdentityFromPage(context) → ViewerIdentity
  - async resolveCurrentUserDisplay(context) → string (display name)
  - isForbiddenError(error) → boolean

session.ts
  - const phoenixSessionCookieName = "phoenix_session"
  - type SessionPayload = { hrId, loginId, role, isActive, sessionVersion, ... }
  - createSessionToken(input) → string (JWT)
  - sessionIdleTimeoutSecondsForRole(role) → number
  - verifySessionToken(token) → SessionPayload | null
  - accessContextFromSessionToken(token) → AccessContext | null
  - getCookieValue(cookieHeader, name) → string | null

supabase-identity.ts
  - const phoenixSupabaseAccessTokenCookieName = "phoenix_supabase_access_token"
  - type SupabaseAuthIdentity = { user, accessToken, ... }
  - type SupabaseAuthProvisionInput = { hrId, loginId, role, password, email, ... }
  - type SupabaseAuthSession = { accessToken, refreshToken, user, ... }
  - buildPhoenixAuthEmail(loginId) → string
  - async provisionSupabaseAuthIdentity(input) → SupabaseAuthIdentity
  - async createSupabaseAuthSession(...) → SupabaseAuthSession
```

### Admin Module (src/lib/admin/)
```
access-control.ts
  - const phoenixLines = ["CNS", "Pedia", "Anti-Infective", "Office", "Other"]
  - type AccessUserRow = { userId, loginId, role, ... }
  - type AuditLogRow = { id, entityType, summary, ... }
  - type AccessUserMutation = { loginId, role, line, ... }
  - async getAccessControlDashboard() → AccessControlData
  - async upsertRolePermissionOverride(input) → void
  - async upsertAccessUser(input, actor) → void
  - async updateAccessUserStatus(...) → void

audit.ts
  - type AuditEntityType = "auth_session" | "permission_override" | "salary_flag" | "user"
  - type AuditLogInput = { entityType, summary, actor, ... }
  - type FullAuditLogRow = { ... }
  - type AuditLogPage = { data[], count, limit, offset }
  - async getAuditLogs(filter) → AuditLogPage
  - async writeAuditLog(input) → void

command-center.ts
  - type DataHealthMetrics = { employeeCount, payrollBatchCount, ... }
  - type AdminCommandCenterData = { userCount, activeRoles, metrics, ... }
  - async getAdminCommandCenterData(context) → AdminCommandCenterData

service.ts
  - type PhoenixAdminStats = { systemHealth, lastUpdate, ... }
  - type AdminMonitoringStats = { apiLatency, errorRate, ... }
  - type DataHealthStats = { employeeDirectory, payroll, sales, ... }
  - type SalaryFlag = { id, flagType, message, ... }
  - async getPhoenixAdminStats() → PhoenixAdminStats
  - async getAdminMonitoringStats() → AdminMonitoringStats
  - async getSalaryFlags(showResolved) → SalaryFlagsResult
  - async resolveSalaryFlag(id, resolvedBy) → void
  - async getDataHealthStats() → DataHealthStats
```

### Employee Module (src/lib/employees/)
```
employee-directory.ts
  - type EmployeeDirectoryRow = { hrId, fullName, managerHrId, line, area, ... }
  - type EmployeeMutationInput = { hrId, fullName, email, line, area, ... }
  - async getEmployeeDirectory() → EmployeeDirectoryData
  - async getEmployeeDirectoryRows() → EmployeeDirectoryRow[]
  - async upsertEmployee(input) → void
  - async bulkUpdateEmployees(...) → void

hr-id-helper.ts
  - async generateNextHrIdForLine(line, retries) → string (e.g., "PH-0001")
```

### Payroll Module (src/lib/payroll/)
```
service.ts
  - async listSalaryBatches() → SalaryBatch[]
  - async getLatestSalaryRecordsBefore(...) → SalaryRecord[]
  - async getPayrollDashboard(context, month, year) → PayrollDashboardData
  - async getSalaryBatchExport(batchId) → ExcelJS.Workbook
  - async createSalaryBatch(input) → SalaryBatch
  - async deleteSalaryBatch(batchId) → void
  - async replaceSalaryBatch(input) → SalaryBatch
  - async runPayrollWorkflow(input, actor) → void

policy.ts
  - type PayrollPaymentMode = "one_part" | "two_parts"
  - calculatePayrollParts(input) → PayrollParts

expenses.ts
  - async listPayrollExpenseReports(context) → PayrollExpenseReport[]
  - async listPayrollExpenses(context, filters) → PayrollExpense[]
  - async deletePayrollExpenseReport(reportId) → void
  - async getApprovedExpenseTotalsForPayroll(batchId) → ExpenseTotals
  - async savePayrollExpenseApprovals(input) → void
  - async importApprovedExpensesToPayroll(input) → ImportResult

expense-import.ts
  - async analyzeExpenseWorkbook(file) → ExpenseAnalysisResult

salary-import.ts
  - async validateSalaryWorkbook(file) → SalaryValidationResult

payslip-center.ts
  - async getPayslipCenterEmployeeOptions() → PayslipCenterEmployeeOption[]
  - async searchPayslipCenter(search) → PayslipCenterRow[]

types.ts
  - type PayrollWorkflowAction = "approve" | "reject" | "batch" | ...
  - type SalaryBatch = { id, fileName, month, year, status, ... }
  - type SalaryRecord = { id, batchId, hrId, fullName, allSalaryFields... }
  - type SalaryFlag = { id, batchId, flagType, severity, message, ... }
```

### Employee Portal Module (src/lib/employee-portal/)
```
service.ts
  - type MedicalRepPortalData = { employee, salesData, payrollData, ... }
  - type DsmTeamPerformanceData = { dsm, teamMembers[], metrics, ... }
  - type NsmTeamExpensesData = { nsm, dsmSummaries[], filters, ... }
  - type NsmBrickCoverageData = { nsm, brickMetrics[], map, ... }
  - async getEmployeePortalData(context) → EmployeePortalData
  - async getMedicalRepPortalData(context, filters) → MedicalRepPortalData
  - async getDsmTeamPerformance(context, filters) → DsmTeamPerformanceData
  - async getNsmTeamExpenses(context, filters) → NsmTeamExpensesData
  - async getNsmBrickCoverage(context, filters) → NsmBrickCoverageData

navigation.ts
  - type EmployeePortalNavVisibility = { earnings, payroll, ... (boolean flags) }
  - resolveEmployeePortalNavVisibility(context) → EmployeePortalNavVisibility

period.ts
  - toPeriodLabel(value: "YYYY-MM") → "Month Year"
```

### Contracts Module (src/lib/contracts/)
```
service.ts
  - async getContractRenewalDashboardData() → ContractRenewalDashboardData
  - async createContractRenewalRequest(input, actor) → void
  - async runContractRenewalWorkflow(input, actor) → void

types.ts
  - type ContractRenewalStatus = "pending" | "approved" | "rejected" | ...
  - type ContractRenewalRecord = { id, employeeHrId, status, ... }
```

### Probation Module (src/lib/probation/)
```
service.ts
  - async getProbationRows() → ProbationRow[]
  - async createProbationEvaluation(input, actor) → void
  - async runProbationWorkflow(input, actor) → void

types.ts
  - type TrafficStatus = "critical" | "warning" | "safe"
  - type ProbationRow = { id, employeeHrId, status, ... }
  - type ProbationWorkflowAction = "pass" | "extend" | "terminate"
```

### Resignations Module (src/lib/resignations/)
```
service.ts
  - async getResignationsDashboardData() → ResignationDashboardData
  - async createResignation(input, actor) → void
  - async resignEmployeeAndOpenVacancy(input, actor) → void
  - async runResignationWorkflow(input, actor) → void

types.ts
  - type ResignationStatus = "submitted" | "approved" | "completed" | ...
```

### Offers Module (src/lib/offers/)
```
service.ts
  - async getOfferDashboard() → OfferDashboardData
  - async getOfferLookups() → OfferLookupData
  - async createOffer(input) → Offer
  - async decideOffer(token, decision) → OfferActionResult
  - async approveAcceptedOffer(...) → void
  - async expireOutstandingOffers() → void

email.ts
  - async sendJobOfferEmail(input) → SendEmailResult
  - buildOfferEmailHtml(input) → string (HTML)
  - buildOfferEmailText(input) → string (plain text)

templates.ts
  - const offerTemplates: OfferTemplate[] (4 templates for RSM, DSM, MR, Senior MR)
  - getOfferTemplate(value) → OfferTemplate

types.ts
  - type OfferStatus = "draft" | "sent" | "accepted" | "rejected" | "expired"
  - type OfferLifecycleRow = { offerId, offerCode, candidateEmail, status, ... }
```

### Sales Module (src/lib/sales/)
```
service.ts
  - async listSalesHistory(context) → SalesHistoryRow[]
  - async listSalesQueue(context) → SalesQueueRow[]
  - async getSalesBatchDetail(batchId, context) → SalesBatchDetail
  - async getSalesDashboard(context, filters) → SalesDashboardData
  - async createSalesImport(payload) → SalesBatch
  - async updateSalesBatchStatus(batchId, status, actor) → void
  - async deleteSalesBatch(batchId, actor) → void
  - async replaceSalesBatch(input, actor) → SalesBatch

import-workflow.ts
  - async runSalesImportWorkflow(input) → WorkflowResult

parser.ts
  - async readUploadRows(file) → ParsedUploadRows
  - async parseSalesUpload(file, line, uploadedBy) → SalesImportPayload
  - extractClosingSheetRows(sheet) → RowData[]

employees.ts
  - async linkSalesRecords(records) → LinkageResult
  - linkSalesRecordAgainstDirectory(record, directory) → LinkedRecord

validation.ts
  - parseSalesRow(row, fallbackLine, rowNumber) → ValidatedRow
  - buildValidationState(messages) → ValidationState

format.ts
  - toNumber(value) → number | null
  - formatCurrency(value) → string
  - formatNumber(value) → string
  - formatUnits(value) → string
  - formatPercent(value, options) → string
  - periodLabel(year, month) → string

role-mapping.ts
  - type SalesOrgRole = "MR" | "DSM" | "NSM"
  - salesRoleOverrideForHrId(hrId) → SalesOrgRole | null

types.ts
  - type SalesRecordInput = Record<string, any> (raw row data)
  - type SalesRecordValidationState = "valid" | "warning" | "failed"
  - type SalesLinkStatus = "linked" | "unlinked" | "ambiguous"
```

### Notifications Module (src/lib/notifications/)
```
email.ts
  - const emailNotificationTypes = ["probation", "contract_renewal", "birthday", "offer", "resignation"]
  - type EmailNotificationType = (typeof emailNotificationTypes)[number]
  - type NotificationEmailInput = { type, notificationType, recipients, subject, htmlBody, ... }
  - const defaultEmailNotificationPolicies: EmailNotificationPolicy[]
  - async getEmailNotificationPolicies() → EmailNotificationPolicy[]
  - async saveEmailNotificationPolicy(input) → void
  - async resolveNotificationDelivery(input) → NotificationDelivery
  - async sendNotificationEmail(input) → SendEmailResult
  - async safeSendNotificationEmail(input) → SafeSendResult
  - async processNotificationOutbox(limit) → NotificationOutboxProcessResult
  - buildEmailNotificationPreview(type) → PreviewEmail
  - emailNotificationsEnabled() → boolean
```

### Email Template Module (src/lib/email/)
```
phoenix-hr-reply-template.ts
  - type PhoenixHrEmailTone = "professional" | "warm" | "firm" | "concise"
  - type PhoenixHrReplyTemplateInput = { senderName, senderRole, tone, subject, body, ... }
  - buildPhoenixHrReplyEmail(input) → { html, text, subject }
```

### Imports Module (src/lib/imports/)
```
employee-import-plan.ts
  - createEmployeeImportPlan(rows, options) → EmployeeImportValidationResult

employee-column-map.ts
  - const employeeColumnDefinitions: EmployeeImportColumnDefinition[]
  - createEmployeeColumnLookup() → Map<headerName, definition>

employee-normalizers.ts
  - normalizeHeaderName(value) → string
  - normalizeTextValue(value) → string | null
  - normalizeOrganizationName(value) → string | null
  - normalizeEmail(value) → string | null
  - normalizeHrId(value) → string | null
  - normalizeNumberValue(value) → number | null
  - normalizeDateValue(value) → string | null (ISO format)

employee-validator.ts
  - validateEmployeeImportRows(...) → ValidationIssue[]

org-rules.ts
  - const departmentRules: Record<string, string>
  - const lineRules: Record<string, string>
  - const positionRules: Record<string, string>

org-rule-engine.ts
  - type OrgValue = { name, code, line, area, ... }
  - classifyOrganizationRow(...) → OrgClassification
  - createOrgCode(value) → string

employee-import-types.ts
  - type EmployeeImportField = "hrId" | "name" | "email" | "line" | ...
  - type EmployeeImportRecord = { hrId, fullName, email, line, area, ... }
  - type OrganizationEntitiesToCreate = { departments[], lines[], areas[], ... }
```

### Geo-Intelligence Module (src/lib/geo-intelligence/)
```
service.ts
  - async parseBrickWorkbook(file, lineOverride) → BrickReferenceRow[]
  - async parseExpenseWorkbook(file) → GeoExpenseImportRow[]
  - async validateTripRoute(input) → TripValidationResult
  - async importBricksWorkbook(params) → GeoImportSummary
  - async importExpensesWorkbook(params) → GeoImportSummary
  - async getGeoDashboardData(context, filters) → GeoDashboardData
  - async geocodeAddressForApi(input) → LatLng | null

google.ts
  - getBrowserKey() → string
  - hasGoogleServerKey() → boolean
  - async googleGeocodeAddress(address) → LatLng | null
  - async googleReverseGeocode(latLng) → Address | null
  - async googleDistanceMatrix(...) → DistanceMatrix
  - async googleDirectionsRoute(...) → Route

types.ts
  - type GeoSourceType = "brick" | "trip_route" | "location"
  - type GeoBrickCoverageStatus = "fully_covered" | "partially_covered" | "not_covered"
  - type GeoTripStatus = "normal" | "review_required" | "high_risk"
```

### Outstation Module (src/lib/outstation/)
```
service.ts
  - async getOutstationEmployeeContext(context) → OutstationContext
  - async getResidenceLocationForEmployee(hrId) → EmployeeResidenceLocation
  - async getOutstationPolicies() → OutstationPolicyRule[]
  - async captureOutstationLocation(...) → OutstationCaptureResult
  - async calculateOutstationExpense(input) → OutstationCalculationResult
  - async submitOutstationRequest(input) → OutstationExpenseRequest
  - async syncOfflineOutstationRequest(...) → SyncResult
  - async updateOutstationPolicies(...) → void
  - async listOutstationRequests() → OutstationExpenseRequest[]
  - async getOutstationHeatmapData() → OutstationHeatmapData

types.ts
  - type OutstationEligibilityStatus = "eligible" | "ineligible" | "pending_review"
  - type OutstationApprovalRecommendation = "approve" | "flag_for_review" | "reject"
  - type OutstationFraudFlag = "high_cost" | "duplicate_location" | "invalid_coordinates" | ...
  - type OutstationPolicyRule = { roleHrId, dailyAllowance, mealAllowance, ... }
```

### Reports Module (src/lib/reports/)
```
vacancies.ts
  - async getVacancyReport() → VacancyReportData
```

### Overview Module (src/lib/overview/)
```
service.ts
  - async getOverviewDashboard(context) → OverviewDashboardData
```

### Bricks Module (src/lib/bricks/)
```
service.ts
  - async listBrickReferenceRows(line) → BrickReferenceRow[]
  - async previewBrickReferenceWorkbook(file, line) → PreviewResult
  - async saveBrickReferenceWorkbook(input) → ImportSummary

reference-seed.ts
  - const BUNDLED_BRICK_REFERENCE_LINE = "Pedia"
  - const BUNDLED_BRICK_REFERENCE_AREAS: BundledBrickReferenceArea[]
```

### Supabase Module (src/lib/supabase/)
```
server.ts
  - getSupabaseAdmin() → SupabaseClient (service-role)
  - getSupabaseUserClient() → SupabaseClient (anon key)

rls-server.ts
  - async getSupabaseRlsClient() → SupabaseClient (user-scoped with RLS)
  - async getSupabaseRlsClientIfAvailable() → SupabaseClient | null
```

### Security Module (src/lib/security/)
```
csrf.ts
  - requiresCsrfProtection(request) → boolean
  - isSameOriginMutationRequest(request) → boolean
```

### I18N Module (src/lib/i18n/)
```
config.ts
  - const SUPPORTED_LOCALES = ["en", "ar"]
  - type AppLocale = "en" | "ar"
  - resolveLocale(input) → AppLocale
  - localeDirection(locale) → "ltr" | "rtl"

format.ts
  - formatCurrencyValue(...) → string (EGP)
  - formatNumberValue(...) → string
  - formatCompactNumber(...) → string
  - formatDateValue(...) → string
  - formatDateTimeValue(...) → string
```

### Uploads Module (src/lib/uploads/)
```
spreadsheets.ts
  - const MAX_SPREADSHEET_UPLOAD_BYTES = 10 * 1024 * 1024
  - validateSpreadsheetFile(file) → ValidationResult
```

### Incentives Module (src/lib/incentives/)
```
scheme-2026.ts
  - type IncentiveCalculation = { hrId, salesAmount, incentiveAmount, ... }
  - calculateIncentive2026(params) → IncentiveCalculation
```

### Utilities
```
db.ts
  - const adminDb = getSupabaseAdmin

env.ts
  - const isDevelopment = process.env.NODE_ENV === "development"
  - const isProduction = process.env.NODE_ENV === "production"
  - const isTest = process.env.NODE_ENV === "test"

utils.ts
  - cn(...inputs) → string (classnames utility)
```

---

## All Components (src/components/)

### Admin Components (src/components/admin/)
- `AdminCommandCenter` - Command center dashboard
- `AdminDesignSystem` - Design system components
- `AdminProfileForm` - Admin profile editor
- `AccessControlManager` - Access control UI
- `AuditLogViewer` - Audit log table
- `DataHealthDashboard` - Data health metrics
- `EmailNotificationCenter` - Email policy management
- `EmailReplyComposer` - Email reply UI
- `MonitoringDashboard` - System monitoring
- `PhoenixAdminDashboard` - Legacy admin dashboard

### Auth Components (src/components/auth/)
- `PremiumLoginPage` - Login form with branding
- `PasswordSetupForm` - Password reset form
- `SessionSecurityGuard` - Idle timeout handler

### Layout Components (src/components/layout/)
- `AppShell` - Main layout wrapper with sidebar + topbar
- `Sidebar` - Navigation menu
- `Topbar` - Header with user menu
- `PageContainer` - Page content wrapper
- `ThemeProvider` - Theme context
- `ThemeToggle` - Dark/light mode toggle

### Employee Portal Components (src/components/employee-portal/)
- `EmployeePortalDashboard` - Main portal dashboard
- `EmployeePortalLayout` - Portal layout wrapper
- `EmployeePortalLoadingProgress` - Loading indicator
- `EnterpriseShell` - Portal shell with header
- `BrickCoverageDashboard` - Brick coverage map
- `BrickCoverageMap` - Interactive map
- `NsmTeamExpensesDashboard` - Team expenses dashboard
- `PersonalExpenseWorkloadDashboard` - Personal expenses
- `TeamExpensesFilters` - Filter controls

### Sales Components (src/components/sales/)
- `SalesDashboard` - Sales analytics dashboard
- `SalesPerformancePage` - Performance charts
- `SalesQueue` - Sales queue UI
- `SalesUpload` - File upload form

### Payroll Components (src/components/payroll/)
- `PayrollDashboard` - Payroll management
- `ExpensesDashboard` - Expense tracking

### Probation Components (src/components/probation/)
- `ProbationTracker` - Probation status tracking

### Contracts Components (src/components/contracts/)
- `ContractRenewal` - Contract renewal UI

### Offers Components (src/components/offers/)
- `OfferLifecycleDashboard` - Offer management
- `OfferActionConfirmation` - Confirmation dialog

### Outstation Components (src/components/outstation/)
- `MobileOutstationWizard` - Mobile form wizard
- `OutstationRequestForm` - Request form
- `OutstationRequestsAdmin` - Admin view
- `OutstationPolicyAdmin` - Policy editor
- `OutstationReviewMap` - Map with requests
- `ExpenseHeatmap` - Heatmap visualization
- `CaptureLocationCard` - Location capture UI
- `OfflineSyncBanner` - Offline sync status
- `EligibilityResultCard` - Eligibility display
- `OutstationCostBreakdown` - Cost breakdown
- `FraudFlagsPanel` - Fraud detection display
- `TerritoryValidationPanel` - Territory validation
- `RouteMapPreview` - Route preview

### Geo Components (src/components/geo/)
- `GeoIntelligenceDashboard` - Geo analytics dashboard
- `GeoFilters` - Filter controls
- `TerritoryMap` - Territory visualization
- `ExpenseRouteMap` - Expense routes
- `BrickCoverageTable` - Brick coverage table
- `TripAnomalyTable` - Anomaly detection table
- `GeoKpiCard` - KPI cards

### Reports Components (src/components/reports/)
- `VacanciesReport` - Vacancy management
- `ResignationsReport` - Resignation tracking
- `OrganogramReport` - Organizational chart

### Charts Components (src/components/charts/)
- `TrendChart` - Time series chart
- `StachedChart` - Stacked bar/area chart
- `HorizontalBars` - Horizontal bar chart
- `RadarChart` - Radar/spider chart
- `WaterfallChart` - Waterfall chart
- `ExecutiveScore` - Score visualization
- `FinancialMix` - Mix/composition chart
- `MultiLayerChart` - Layered chart

### Card Components (src/components/cards/)
- `KpiCard` - KPI metric card
- `KpiBulletCard` - Bullet chart card
- `InsightCard` - Insight/stat card
- `StatusCard` - Status display card
- `ChartCard` - Chart wrapper card

### UI Components (src/components/ui/)
- `Badge` - Status badge
- `Button` - CTA button
- `Card` - Card container
- `FilterChip` - Filter toggle
- `Input` - Text input
- `LoadingState` - Loading spinner
- `PageTransition` - Page animation
- `PremiumTooltip` - Styled tooltip
- `SectionHeader` - Section title
- `StatusBadge` - Status indicator
- `Switch` - Toggle switch

### Imports Components (src/components/imports/)
- `EmployeeImportUpload` - CSV upload form
- `BrickReferenceUpload` - Brick reference upload

### Other Components
- `EmployeeManagement` - Employee CRUD
- `HrCalendar` - Calendar UI
- `PhoenixLogo` - Logo component
- `BrandLogo` - Brand elements

---

## All API Routes (app/api/)

### Authentication Routes
```
POST /api/auth/login
  - Body: { loginId, password }
  - Response: { success: boolean }
  - Auth: none
  - Rate limited: yes

POST /api/auth/logout
  - Auth: required
  - Response: { success: boolean }

POST /api/auth/heartbeat
  - Auth: required (session refresh)
  - Response: { refreshed: boolean, expiresAt: timestamp }

POST /api/auth/password-setup/:token
  - Body: { password }
  - Response: { success: boolean }
  - Auth: none
```

### Admin Routes
```
GET /api/admin/users
  - Query: search?, line?, page?, limit?
  - Auth: required (Admin, User Admin)
  - Response: { data: UserRow[], total: number }

POST /api/admin/users
  - Body: { loginId, role, line, ... }
  - Auth: required (User Admin)
  - Response: { id, loginId, ... }

PATCH /api/admin/users
  - Body: { userId, role, line, ... }
  - Auth: required (User Admin)
  - Response: { success: boolean }

POST /api/admin/users/bulk
  - Body: { users: { loginId, role, ... }[] }
  - Auth: required (User Admin)
  - Response: { imported, skipped, errors }

POST /api/admin/users/setup-link
  - Body: { loginId }
  - Auth: required (User Admin)
  - Response: { setupUrl: string }

GET /api/admin/permissions
  - Auth: required (Super Admin)
  - Response: { overrides: RolePermissionOverride[] }

PATCH /api/admin/permissions
  - Body: { roleName, resource, action, isAllowed }
  - Auth: required (Super Admin)
  - Response: { success: boolean }

GET /api/admin/salary-flags
  - Auth: required (Admin)
  - Response: { flags: SalaryFlag[], counts }

PATCH /api/admin/salary-flags
  - Body: { flagId, resolved: boolean }
  - Auth: required (Admin)
  - Response: { success: boolean }

GET /api/admin/logs
  - Query: entityType?, page?, limit?
  - Auth: required (Admin)
  - Response: { logs: AuditLogRow[], total }

GET /api/admin/email-notifications
  - Auth: required (Admin)
  - Response: { policies: EmailNotificationPolicy[] }

PATCH /api/admin/email-notifications
  - Body: { notificationType, enabled, ... }
  - Auth: required (Admin)
  - Response: { success: boolean }

POST /api/admin/email-reply/send
  - Body: { recipients, subject, body, tone }
  - Auth: required (Admin)
  - Response: { sentCount, failedCount }

GET /api/admin/profile
  - Auth: required
  - Response: { adminUser: UserRow }

GET /api/admin/outstation/heatmaps
  - Auth: required (Admin)
  - Response: { heatmapData: OutstationHeatmapData }

POST /api/admin/outstation/requests
  - Body: { filters... }
  - Auth: required (Admin)
  - Response: { requests: OutstationExpenseRequest[] }

PATCH /api/admin/outstation/:id
  - Body: { status, approvalRecommendation }
  - Auth: required (Admin)
  - Response: { success: boolean }
```

### Employee Routes
```
GET /api/employees
  - Query: search?, line?, manager?, page?, limit?
  - Auth: required
  - Response: { employees: EmployeeDirectoryRow[], total }

POST /api/employees
  - Body: { hrId, fullName, email, line, area, ... }
  - Auth: required (HR)
  - Response: { employee: EmployeeDirectoryRow }

GET /api/employees/template
  - Auth: required (HR)
  - Response: { columns: ColumnDefinition[] }

POST /api/employees/:hrId/resign
  - Body: { effectiveDate, reason }
  - Auth: required (HR)
  - Response: { resignation: ResignationRecord }
```

### Import Routes
```
POST /api/imports/employees/dry-run
  - Body: FormData with file
  - Auth: required (HR, User Admin)
  - Response: { preview: EmployeeImportValidationResult }

POST /api/imports/employees/confirm
  - Body: { importRows: EmployeeImportRecord[] }
  - **CRITICAL:** NO AUTH CHECK
  - Response: { imported: number, created: number, updated: number }

POST /api/imports/bricks/dry-run
  - Body: FormData with file
  - Auth: required
  - Response: { preview: BrickImportResult }

POST /api/imports/bricks/confirm
  - Body: { rows: BrickReferenceRow[] }
  - Auth: required
  - Response: { imported: number }
```

### Payroll Routes
```
GET /api/payroll/[id]
  - Auth: required (Payroll)
  - Response: { batch: SalaryBatch }

POST /api/payroll/[id]
  - Body: { salaryRecords: SalaryRecord[] }
  - Auth: required (Payroll)
  - Response: { created: number }

DELETE /api/payroll/[id]
  - Auth: required (Payroll)
  - Response: { success: boolean }

GET /api/payroll/[id]/download
  - Auth: required (Payroll)
  - Response: Excel file

GET /api/payroll/[id]/payslips
  - Query: month?, year?, hrId?
  - Auth: required
  - Response: { payslips: PayslipRow[] }

POST /api/payroll/[id]/replace
  - Body: { newSalaryRecords }
  - Auth: required (Payroll)
  - Response: { success: boolean }

POST /api/payroll/[id]/workflow
  - Body: { action, approver }
  - Auth: required (Payroll, Finance)
  - Response: { success: boolean }

POST /api/payroll/upload
  - Body: FormData with file
  - Auth: required (Payroll)
  - Response: { batch: SalaryBatch, flags: SalaryFlag[] }

POST /api/payroll/validate
  - Body: FormData with file
  - Auth: required (Payroll)
  - Response: { validation: SalaryValidationResult }

GET /api/payroll/template
  - Auth: required (Payroll)
  - Response: Excel file with template

GET /api/payroll/expenses/[id]
  - Auth: required
  - Response: { report: PayrollExpenseReport }

POST /api/payroll/expenses
  - Body: FormData with file
  - Auth: required (Finance)
  - Response: { report: PayrollExpenseReport, analysis }

POST /api/payroll/expenses/analyze
  - Body: FormData with file
  - Auth: required (Finance)
  - Response: { analysis: ExpenseAnalysisResult }

POST /api/payroll/expenses/import
  - Body: { approvals: ExpenseApprovalInput[] }
  - Auth: required (Finance)
  - Response: { imported: number, failed: number }

GET /api/payroll/expenses/dashboard
  - Auth: required
  - Response: { dashboard: ExpensesDashboardData }
```

### Sales Routes
```
GET /api/sales
  - Query: filters...
  - Auth: required
  - Response: { dashboard: SalesDashboardData }

GET /api/sales/queue
  - Auth: required
  - Response: { queue: SalesQueueRow[] }

POST /api/sales/imports
  - Body: FormData with file
  - Auth: required (Sales)
  - Response: { batch: SalesBatch }

POST /api/sales/imports/upload
  - Body: FormData with file
  - Auth: required (Sales)
  - Response: { preview: ParsedUploadRows }

GET /api/sales/imports/[id]
  - Auth: required (Sales)
  - Response: { batch: SalesBatchDetail }

POST /api/sales/imports/[id]/[action]
  - Body: depends on action
  - Auth: required (Sales)
  - Response: { success: boolean }
```

### Contracts Routes
```
POST /api/contracts
  - Body: { employeeHrId, renewalDate }
  - Auth: required (HR)
  - Response: { contract: ContractRenewalRequest }

POST /api/contracts/[id]/workflow
  - Body: { action, actor }
  - Auth: required (HR)
  - Response: { success: boolean }
```

### Probation Routes
```
POST /api/probation
  - Body: { employeeHrId, startDate, endDate }
  - Auth: required (HR)
  - Response: { evaluation: ProbationEvaluation }

POST /api/probation/[id]/workflow
  - Body: { action, decision }
  - Auth: required (HR)
  - Response: { success: boolean }
```

### Resignations Routes
```
GET /api/resignations
  - Auth: required (HR)
  - Response: { resignations: ResignationRecord[] }

POST /api/resignations
  - Body: { employeeHrId, effectiveDate }
  - Auth: required (HR)
  - Response: { resignation: ResignationRecord }

POST /api/resignations/[id]/workflow
  - Body: { action, actor }
  - Auth: required (HR)
  - Response: { success: boolean }
```

### Offers Routes
```
GET /api/offers
  - Auth: required (Offers)
  - Response: { offers: OfferLifecycleRow[] }

POST /api/offers
  - Body: { candidateName, candidateEmail, jobTitle, ... }
  - Auth: required (Offers)
  - Response: { offer: OfferLifecycleRow, secureUrl }

POST /api/offers/[offerRef]/accept
  - Body: { token }
  - Auth: none (token-based)
  - Response: { success: boolean }

POST /api/offers/[offerRef]/reject
  - Body: { token, reason }
  - Auth: none (token-based)
  - Response: { success: boolean }

POST /api/offers/[offerRef]/approve
  - Body: { approvalReason }
  - Auth: required (Offers Approve)
  - Response: { success: boolean }
```

### Outstation Routes
```
POST /api/outstation/submit
  - Body: { fromCity, toCity, dates, expenses, location }
  - Auth: required (Outstation Create)
  - Response: { request: OutstationExpenseRequest }

POST /api/outstation/capture-location
  - Body: { latitude, longitude, accuracy, timestamp }
  - Auth: required (Outstation Create)
  - Response: { success: boolean }

POST /api/outstation/calculate
  - Body: { fromCity, toCity, dates, role }
  - Auth: required (Outstation)
  - Response: { calculation: OutstationCalculationResult }

GET /api/outstation/policy
  - Auth: required (Outstation)
  - Response: { policies: OutstationPolicyRule[] }

POST /api/outstation/sync-offline
  - Body: { requests: OutstationExpenseRequest[] }
  - Auth: required (Outstation)
  - Response: { synced: number }
```

### Geo Routes
```
GET /api/geo/dashboard
  - Query: filters...
  - Auth: required (Geo Intelligence)
  - Response: { dashboard: GeoDashboardData }

POST /api/geo/geocode
  - Body: { address }
  - Auth: required (Geo Intelligence)
  - Response: { latLng: { lat, lng } }

POST /api/geo/import-bricks
  - Body: FormData with file
  - Auth: required (Geo Intelligence)
  - Response: { summary: GeoImportSummary }

POST /api/geo/import-expenses
  - Body: FormData with file
  - Auth: required (Geo Intelligence)
  - Response: { summary: GeoImportSummary }

POST /api/geo/validate-trip
  - Body: { fromCoords, toCoords, dates, distance }
  - Auth: required (Geo Intelligence)
  - Response: { validation: TripValidationResult }
```

### Notification Routes
```
GET /api/notifications/birthdays
  - Auth: CRON secret required (Bearer token)
  - Response: { processed: number }

POST /api/notifications/test
  - Body: { type, recipients }
  - Auth: required (Admin)
  - Response: { success: boolean }

POST /api/notifications/process
  - Auth: required (Admin)
  - Response: { processed: number, failed: number }
```

### Reports Routes
```
GET /api/reports/vacancies
  - Auth: required (Vacancies Read)
  - Response: { report: VacancyReportData }
```

---

## All Pages & Routing (app/)

### Root Pages
```
/ (root page)
  - Redirects to role-specific landing page
  - Auth: required
  - Redirect logic: resolveLandingPathForRole(role)

/login
  - Public login page
  - No auth required
  - POST: authenticate and create session

/password-setup/[token]
  - Password reset with token
  - No auth required (token-based)
  - POST: complete password setup
```

### Admin Pages
```
/admin (dashboard)
  - Command center dashboard
  - Auth: Admin, Overview Read
  - Data: getAdminCommandCenterData()

/admin/profile
  - Admin profile editor
  - Auth: Admin
  - Data: getAdminProfile()

/admin/access (access control)
  - User management and permissions
  - Auth: Super Admin
  - Data: getAccessControlDashboard()

/admin/data-health
  - Data integrity metrics
  - Auth: Admin
  - Data: getDataHealthStats()

/admin/logs
  - Audit log viewer
  - Auth: Admin
  - Data: getAuditLogs()

/admin/monitoring
  - System monitoring metrics
  - Auth: Admin
  - Data: getAdminMonitoringStats()

/admin/email-notifications
  - Email notification policies
  - Auth: Admin
  - Data: getEmailNotificationPolicies()

/admin/email-reply-composer
  - Email reply template composer
  - Auth: Admin
  - Data: none

/admin/payslips-center
  - Payslip search and download
  - Auth: Payroll (COMPANY scope)
  - Data: getPayslipCenterEmployeeOptions()

/admin/geo-intelligence (dashboard)
  - Geo analytics dashboard
  - Auth: Geo Intelligence
  - Data: getGeoDashboardData()

/admin/geo-intelligence/anomalies
  - Trip anomaly detection
  - Auth: Geo Intelligence
  - Data: getGeoDashboardData()

/admin/geo-intelligence/expense-routes
  - Expense route visualization
  - Auth: Geo Intelligence
  - Data: getGeoDashboardData()

/admin/geo-intelligence/territory-map
  - Territory map visualization
  - Auth: Geo Intelligence
  - Data: getGeoDashboardData()

/admin/outstation/requests
  - Outstation request management
  - Auth: Admin
  - Data: listOutstationRequests()

/admin/outstation/policy
  - Outstation policy editor
  - Auth: Admin
  - Data: getOutstationPolicies()

/admin/outstation/heatmaps
  - Outstation heatmap visualization
  - Auth: Admin
  - Data: getOutstationHeatmapData()
```

### Payroll Pages
```
/payroll (dashboard)
  - Payroll management dashboard
  - Auth: Payroll (COMPANY scope)
  - Data: getPayrollDashboard()
  - Redirect: employee portal users to /employee-portals/payroll

/payroll/expenses (expenses)
  - Expense dashboard
  - Auth: Payroll
  - Data: getPayrollDashboard() with expenses tab

/payroll/expenses/dashboard (analytics)
  - Expense analytics dashboard
  - Auth: Expenses
  - Data: multiple sources (employees, expenses, reports)
```

### Sales Pages
```
/sales (dashboard)
  - Sales analytics dashboard
  - Auth: Sales Read
  - Data: getSalesDashboard()
  - Redirect: non-admin users to /employee-portals/sales

/sales/queue
  - Sales queue UI
  - Auth: Sales
  - Data: listSalesQueue()

/sales/upload
  - Sales data upload
  - Auth: Sales
  - Data: none
```

### Employees & Imports
```
/employees (directory)
  - Employee directory
  - Auth: Employees Read
  - Data: getEmployeeDirectory()

/imports/employees
  - Employee import workflow
  - Auth: Imports
  - Multi-step: upload → dry-run → confirm

/imports/bricks
  - Brick reference import
  - Auth: Imports
  - Multi-step: upload → confirm
```

### HR Workflows
```
/contracts
  - Contract renewal tracker
  - Auth: Contracts
  - Data: getContractRenewalDashboardData()

/probation
  - Probation tracker
  - Auth: Probation
  - Data: getProbationRows()

/resignations
  - Resignation management
  - Auth: Resignations
  - Data: getResignationsDashboardData()

/offers
  - Job offer management
  - Auth: Offers
  - Data: getOfferDashboard()

/offers/[token]/accept
  - Public offer acceptance (no auth)
  - Data: getOfferDecisionPreview()

/offers/[token]/reject
  - Public offer rejection (no auth)
  - Data: getOfferDecisionPreview()

/reports/vacancies
  - Vacancy report
  - Auth: Vacancies Read
  - Data: getVacancyReport()

/organogram
  - Organizational chart
  - Auth: Organogram Read
  - **BUG:** Uses getVacancyReport() instead of organogram data

/hr-calendar
  - HR calendar (placeholder)
  - Auth: HR Calendar Read
  - Data: minimal
```

### Employee Portal Pages
```
/employee-portals (landing)
  - Portal home with dashboard
  - Auth: Employee Portal Read
  - Data: getMedicalRepPortalData()

/employee-portals/payroll
  - Payroll view (employee perspective)
  - Auth: Payroll Read
  - Data: getMedicalRepPortalData()

/employee-portals/payslips
  - Payslip download
  - Auth: Payroll Read
  - Data: getPayslipCenterEmployeeOptions()

/employee-portals/sales
  - Sales performance (rep view)
  - Auth: Sales Read
  - Data: getSalesDashboard() with filters

/employee-portals/earnings
  - Earnings summary
  - Auth: Employee Portal Read
  - Data: getMedicalRepPortalData()

/employee-portals/incentive
  - Incentive calculation
  - Auth: Employee Portal Read
  - Data: calculateIncentive2026()

/employee-portals/expenses
  - Personal expenses
  - **INCOMPLETE:** Redirects to home
  - Auth: Expenses Read

/employee-portals/expense-dashboard
  - Personal expense dashboard
  - Auth: Expenses Read
  - Data: getPayrollExpenses()

/employee-portals/team-expenses
  - Team expenses (manager view)
  - Auth: Employee Portal Read + NSM role
  - Data: getNsmTeamExpenses()

/employee-portals/team-performance
  - Team performance (manager view)
  - Auth: Employee Portal Read + role
  - Data: getDsmTeamPerformance() or getNsmDsmPerformance()

/employee-portals/med-reps-performance
  - Medical rep performance (director view)
  - Auth: Employee Portal Read
  - Data: getMedicalRepPortalData()

/employee-portals/dsms-performance
  - DSM performance
  - Auth: Employee Portal Read
  - Data: getDsmTeamPerformance()

/employee-portals/brick-coverage
  - Brick coverage map (NSM view)
  - Auth: Employee Portal Read + NSM role
  - Data: getNsmBrickCoverage()

/employee-portals/organogram
  - Organizational view
  - Auth: Employee Portal Read
  - Data: getVacancyReport() (same as admin)

/employee-portals/vacancies
  - Vacancy browse
  - Auth: Employee Portal Read
  - Data: getEmployeePortalVacancies()

/employee-portals/profile
  - Personal profile
  - Auth: Employee Portal Read
  - Data: getEmployeePortalProfile()

/employee-portals/contact-hr-support
  - HR support contact form
  - Auth: Employee Portal Read
  - Data: none

/employee-portals/probation
  - Personal probation status
  - Auth: Employee Portal Read
  - Data: getMedicalRepPortalData()
```

### Overview Page
```
/overview
  - Dashboard landing
  - Auth: required
  - Redirects to /admin or /employee-portals based on role
```

---

## Types & Business Rules

### Employee Identity
```typescript
// HR_ID is the canonical identifier
type EmployeeDirectoryRow = {
  hrId: string;                  // Primary key, unique
  fullName: string;
  managerHrId: string | null;   // FK to employees(hr_id)
  crm_id?: string | null;        // May differ from HR_ID
  employment_status: string;     // "active" | "resigned" | "terminated"
  job_title: string;
  line: string;
  area: string;
  department_id: string;
  team_id?: string;
  position_id: string;
  created_at: timestamp;
  updated_at: timestamp;
}

// Manager hierarchy uses HR_ID
type ManagerHierarchy = {
  employeeHrId: string;
  managerHrId: string | null;
  managerChain: string[];  // [direct_manager, skip_level, ...]
}
```

### Payroll
```typescript
type SalaryBatch = {
  id: uuid;
  month: number;           // 1-12
  year: number;            // YYYY
  status: "draft" | "approved" | "rejected" | "published";
  total_gross: number;
  row_count: number;
  // NO UNIQUE CONSTRAINT on (year, month) - BUG
}

type SalaryRecord = {
  id: bigint;
  batch_id: uuid;          // FK to salary_batches
  hr_id: string;           // FK to employees(hr_id)
  full_name: string;
  line: string;
  area: string;
  job_title: string;
  basic_salary: number;
  // Allowances
  housing: number;
  transportation: number;
  // Deductions
  social_insurance: number;
  income_tax: number;
  // Totals
  gross_salary: number;
  total_deductions: number;
  net_salary: number;
}

type PayrollPaymentMode = "one_part" | "two_parts";
// Payment: net_salary / (2 or 1) = payment_amount
```

### Expenses
```typescript
type PayrollExpense = {
  trip_id: string;         // Unique identifier
  report_id: uuid;         // FK to reports
  employee_hr_id: string;  // Should have FK constraint (missing!)
  specialist: string;      // Medical rep name
  line: string;
  area: string;
  // Trip details
  from_city: string;
  to_city: string;
  departure_date: date;
  return_date: date;
  // Cost breakdown
  miles: number;
  daily_allowance: number;
  meal_allowance: number;
  total_expense: number;
  status: "pending" | "approved" | "rejected";
  validation_result: string;
}
```

### Probation
```typescript
type ProbationRow = {
  id: uuid;
  employee_hr_id: string;  // Should have FK constraint (missing!)
  status: "on_probation" | "passed" | "extended" | "terminated";
  probation_end_date: date;
  decision: "pass" | "extend" | "terminate";
  created_at: timestamp;
}

// Probation rules by role (from payroll/policy.ts)
// Probation period: typically 3-6 months
// Review date: probation_end_date
```

### Contracts & Renewals
```typescript
type ContractRenewalRequest = {
  id: uuid;
  employee_hr_id: string;  // Has FK constraint
  requested_renewal_date: date;
  status: "pending" | "approved" | "rejected" | "completed";
  created_at: timestamp;
}

// Renewal triggers: 30/60/90 days before contract end
```

### Org Structure
```typescript
type OrganizationEntity = {
  departments: { id, name, code }[];  // Unique name and code
  lines: { id, name, code }[];        // Lines (CNS, Pedia, etc.)
  areas: { id, name, code }[];        // Geographic areas
  teams: { id, name }[];              // Teams within org
  positions: { id, title, code }[];   // Job positions
}

// Import creates/updates these automatically
// Business rules in src/lib/imports/org-rules.ts
```

### Sales
```typescript
type SalesRecord = {
  id: bigint;
  batch_id: uuid;
  employee_hr_id: string;  // Matched during import
  manager_hr_id: string;   // For hierarchy
  sales_type: string;      // "retail" | "wholesale" | ...
  family: string;          // Product family
  product: string;         // Product name
  month: number;
  year: number;
  amount: number;
  quantity: number;
  link_status: "linked" | "unlinked" | "ambiguous";
}

type SalesOrgRole = "MR" | "DSM" | "NSM";
// Medical Reps report to DSMs who report to NSMs
```

### Offers
```typescript
type OfferStatus = "draft" | "sent" | "accepted" | "rejected" | "expired";
type OnboardingStatus = "pending" | "started" | "completed";

type JobOffer = {
  id: uuid;
  offer_code: string;           // Unique offer ID
  secure_token_hash: string;    // For public link
  candidate_name: string;
  candidate_email: string;
  job_title: string;
  basic_salary: number;
  housing: number;
  transportation: number;
  status: OfferStatus;
  expires_at: date;
  // Role-specific templates in src/lib/offers/templates.ts
}

// 4 offer templates: RSM, DSM, MR, Senior MR
// Compensation breakdown shown in email
```

### Outstation
```typescript
type OutstationEligibilityStatus = 
  | "eligible"
  | "ineligible"
  | "pending_review"
  | "requires_approval";

type OutstationExpenseRequest = {
  id: bigint;
  employee_hr_id: string;
  from_city: string;
  from_area: string;
  to_city: string;
  to_area: string;
  // Dates
  departure_date: date;
  return_date: date;
  // Allowances (policy-based calculation)
  daily_allowance: number;
  meal_allowance: number;
  transport_allowance: number;
  total_allowance: number;
  // Validation
  status: "draft" | "pending_approval" | "approved" | "rejected";
  eligibility_status: OutstationEligibilityStatus;
  fraud_flags: string[];  // List of detected fraud flags
  validation_result: "valid" | "warning" | "failed";
}

// Fraud flags: high_cost, duplicate_location, invalid_coordinates, ...
// Policy rules stored in src/lib/outstation/types.ts
```

### Notifications
```typescript
const emailNotificationTypes = [
  "probation",           // Probation start/end/decision
  "contract_renewal",    // Contract renewal request
  "birthday",            // Employee birthday
  "offer",              // Offer creation/acceptance/rejection
  "resignation",        // Resignation submission/approval
  "payroll",            // **DEAD CODE** - not registered
  "password_setup",     // **DEAD CODE** - causes silent failure
  "employee_import",    // **DEAD CODE** - not registered
];

type NotificationOutbox = {
  id: uuid;
  dedupe_key: string;   // SHA256 hash of payload
  payload: object;      // Full notification payload
  status: "pending" | "sent" | "failed" | "archived";
  attempts: number;
  max_attempts: number; // Default: 5
  next_attempt_at: timestamp;
  last_error: string;
  created_at: timestamp;
  updated_at: timestamp;
}

// Retry delays: [5, 15, 60, 240] minutes
// **BUG:** No cron scheduler configured
```

### Incentives (2026 Scheme)
```typescript
type IncentiveCalculation = {
  hrId: string;
  salesAmount: number;
  incentivePercentage: number;
  incentiveAmount: number;
  totalCompensation: number;
}

// Calculation rules in src/lib/incentives/scheme-2026.ts
// Depends on role, line, sales targets, performance
```

---

## Environment Variables

### Required
```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://[project].supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGc...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...  # Service role (SENSITIVE)
SUPABASE_JWT_SECRET=...                 # For token verification

# Authentication
PHOENIX_SESSION_SECRET=...              # HMAC-SHA256 secret
CRON_SECRET=...                         # For CRON jobs (birthdays, etc.)

# Email (Resend)
RESEND_API_KEY=...
NOTIFICATION_EMAIL_FROM=notifications@...
NOTIFICATION_REPLY_TO=hr@...
HR_REPLY_EMAIL_FROM=Phoenix HR <hr@...>
HR_NOTIFICATION_EMAILS=hr1@...,hr2@...
HR_EMAIL_SIGNATURE_URL=https://...

# Google Maps
NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY=...
GOOGLE_MAPS_SERVER_KEY=...

# URLs
NEXT_PUBLIC_APP_URL=https://phxworkforce.com
NEXT_PUBLIC_OFFERS_PUBLIC_URL=https://offers.phxworkforce.com

# Locale
DEFAULT_LOCALE=en
SUPPORTED_LOCALES=en,ar

# Company Config
COMPANY_NAME=Sato Pharmaceuticals
COMPANY_HR_EMAIL=hr@satopharma.com

# Other
NODE_ENV=production|development|test
LOG_LEVEL=info|debug|error
```

### Optional
```bash
# Monitoring
SENTRY_DSN=...
AXIOM_DATASET=...

# Cache
REDIS_URL=...

# File Storage
STORAGE_BUCKET_NAME=phoenix-uploads

# Analytics
POSTHOG_KEY=...
GOOGLE_ANALYTICS_ID=...
```

---

## Key Business Logic

### Access Control Logic
1. User logs in with `loginId` + password
2. Session token created with `role` and `hrId`
3. For each request, `canAccess(context, resource, action)` checks:
   - Does the role have permission for (resource, action)?
   - If override exists in `role_permission_overrides`, use that
   - Return boolean result
4. If denied, return 403 Forbidden
5. Additional scope checks for sensitive data:
   - Employee can see only their own payslip
   - Manager can see their direct reports' data
   - HR/Finance can see full company data

### Payroll Processing
1. Admin uploads salary batch (CSV/Excel)
2. System validates: HR_IDs exist, salary fields present, no duplicates
3. Dry-run shows preview, flags issues
4. Admin confirms to import
5. Creates `salary_batches` + `salary_records` entries
6. Generates `salary_flags` for anomalies
7. Finance approves batch
8. Payslips generated and emailed to employees
9. Employees can download/view payslips in portal

### Expense Approval
1. Employee submits expense request with:
   - Trip dates, cities, transportation, meals
   - Location coordinates, route
2. System calculates allowance based on policy
3. Detects fraud flags (high cost, duplicate location, invalid coords)
4. Manager approves or rejects
5. Finance imports approved expenses into payroll
6. Affects next salary batch

### Offer Lifecycle
1. HR creates offer with candidate details + compensation
2. Offer sent via email with acceptance link (token-based)
3. Candidate clicks link, accepts/rejects (no auth required)
4. Status updated: accepted → approved by HR → onboarding
5. Once approved, vacancy can be closed
6. New employee created in system

### Probation Tracking
1. On employee hire, probation period created (e.g., 3-6 months)
2. Notifications sent at defined intervals (day 30, 60, 90)
3. Manager evaluates: pass, extend, or terminate
4. System sends notification of decision
5. If terminated, resignation workflow triggered

### Sales Queue Processing
1. Sales uploads closing sheet (Excel)
2. System extracts rows, validates format
3. Matches against employee directory (CRM ID, lookup key, HR_ID)
4. Assigns confidence scores (1.0 for exact match, 0.9-0.98 for fuzzy)
5. Flags unmatched or ambiguous records
6. Admin reviews and confirms
7. Sales dashboard updated with real-time data

---

## Critical Issues Found

### CRITICAL SECURITY
- **Unauthenticated import confirm** (`/api/imports/employees/confirm`)
- **11 tables without RLS** (geo, outstation, auth_login_attempts, password_setup_tokens)
- **CSRF middleware not active** (proxy.ts exists but not registered)
- **Employee portal bypasses RLS** (uses service-role key)
- **5 duplicate service-role utilities** (no centralized key management)

### CRITICAL FUNCTIONALITY
- **Password-setup emails fail silently** (notification type not registered)
- **Payroll import emails never sent** (notification type not registered)
- **Organogram uses wrong data service** (uses getVacancyReport)
- **Cron scheduler not configured** (birthday emails won't trigger)
- **Notification outbox retry never runs** (no background processor)

### DATABASE
- **No FK on employee_probation.employee_hr_id** (orphaned records possible)
- **No FK on employee_resignations.employee_hr_id**
- **No FK on payroll_expenses.hr_id**
- **No unique constraint on salary_batches(year, month)** (duplicate batches possible)
- **7 missing table DDL** (employee_documents, notification_events, etc.)

### CODE QUALITY
- **13 duplication patterns** (60+ files affected)
- **14 lint errors** (Google Maps types, React patterns)
- **45 unused imports**
- **36 PNG screenshot files** at root level

---

## Safe Fixes Applied

✅ **TypeScript (11 errors → 0)**
- Fixed `PageProps` type errors in 7 page files
- Added explicit `string` type to `period` map callbacks

✅ **Build Status**
- Passes TypeScript compilation cleanly
- ESLint: 14 pre-existing errors (Google Maps, React), 45 warnings (unused imports)

✅ **Git Status**
- 7 source files modified (type fixes only)
- 1 new file created (audit report)
- No behavior changes

---

## How to Use This Document

For any AI tool:
1. When working on a feature, reference the **Services** section for available functions
2. For database schema, refer to the **Database Schema** section
3. For page routing, check the **All Pages & Routing** section
4. For permission rules, consult **Authentication & Authorization**
5. For component structure, see **All Components**
6. For API endpoints, check **All API Routes**

This document contains the complete system specification needed to understand and modify Phoenix Workforce without leaving the context window.

**Last Updated: 2026-05-11 | TypeScript: 0 errors | Build: clean | Status: Production-ready with critical fixes needed**
