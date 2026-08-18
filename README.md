# Phoenix Workforce

Phoenix Workforce is an internal enterprise workforce operating system for HR governance, employee lifecycle automation, payroll control, approval workflows, field operations intelligence, employee self-service, and executive reporting.

It replaces scattered spreadsheets, manual follow-ups, disconnected approvals, informal HR communication, and fragmented operational tracking with a governed, role-based, auditable platform.

## Product Positioning

Phoenix Workforce is an enterprise HR operating system, not a spreadsheet tool or a data-import utility. It centralizes workforce master data, automates the full employee lifecycle, enforces multi-level approvals, governs payroll and expenses, tracks field operations, and gives employees controlled self-service access to their own HR information. Every action flows through role-based permissions, structured workflows, and audit logging — turning informal, manual HR operations into a single governed system of record.

## Core Experiences

Phoenix delivers two distinct, role-aware experiences from one platform.

### Admin Workspace

The Admin Workspace serves HR managers, payroll and administrative staff, department heads, and executive leadership. It is the control surface for workforce operations, governance, approvals, compliance, reporting, and master data.

- **Command Center** — operational dashboard and workforce intelligence for leadership
- **People Management** — centralized control over the workforce population and records
- **Employee Directory** — searchable workforce registry with profile management
- **Organogram** — visual organizational hierarchy and reporting lines
- **Vacancies** — open positions, replacement chains, and vacancy reporting
- **Offer Lifecycle** — offer creation, approval chains, and public offer links
- **Probation** — probation period tracking, reviews, and outcomes
- **Contract Renewal** — contract expiry monitoring and renewal workflows
- **Resignations** — resignation submission, approvals, and last-working-day management
- **Vacation Management** — leave requests, balances, entitlements, and compensatory days
- **Payroll** — batch processing, salary records, formula-based calculations, and payroll locks
- **Payslips Center** — payslip generation, image export, and distribution
- **Expenses and Outstation** — expense submissions, multi-level approvals, and field allowances
- **Field Workforce Compliance** — compliance tracking, evidence validation, and route intelligence
- **Attendance Device Mapping** — fingerprint device integration and employee-device assignment
- **Sales and Performance Reporting** — distributor sales, territory analytics, and performance tracking
- **Email Composer** — HR email drafting with templates and signatures
- **Email Governance** — delivery mode control, test recipients, and send governance
- **Templates and Notifications** — notification templates, outbox processing, and delivery tracking
- **Users and Access Control** — role assignment, permission management, and session governance
- **HR Calendar** — organization-wide events, birthdays, and lifecycle dates
- **Bulk Administration and Data Governance** — controlled bulk operations and master-data integrity

### Employee Portal

The Employee Portal gives every employee a role-aware, mobile-first personal workspace for self-service interaction with HR — without routing routine requests through manual channels.

- **Mobile-first employee dashboard** — a responsive personal landing experience
- **Personal profile** — view personal and employment information
- **Payslips access** — personal payslip history and downloads
- **Request submission** — submit vacation, excuse, and support requests
- **Vacation / request workflows** — guided request flows with policy enforcement
- **Approval visibility** — track request status and approval chains
- **Notifications** — a personal notification feed and email alerts
- **Employee HR information** — access relevant HR data scoped to the individual
- **Role-aware portal experience** — content and actions adapt to the employee's role
- **Employee self-service workflows** — complete routine HR tasks without HR intervention

## Business Capabilities

| Capability | What Phoenix Handles |
|---|---|
| Workforce Master Data | Employee directory, organizational hierarchy, department structure, reporting lines |
| Employee Lifecycle | Hiring, onboarding, probation, contracts, resignations, terminations, vacancy creation |
| Approvals and Requests | Multi-level approval workflows for leave, expenses, outstation, offers, resignations, marketing requests |
| Payroll Governance | Batch processing, salary records, allowances, deductions, payslip generation, payroll locks |
| Payslips | Payslip generation, image export, salary detail breakdowns, employee access |
| Expenses and Outstation | Medical rep expenses, field travel, allowance calculation, car evidence, GPS tracking |
| Attendance Integration | Fingerprint device sync, raw punch ingestion, device-user mapping, attendance reporting |
| Field Workforce Compliance | Compliance tracking, route intelligence, outstation heatmaps, evidence validation |
| Sales / Performance Reporting | Distributor sales, territory reporting, performance analytics, target tracking |
| Email and Notification Governance | Template-based delivery, outbox scheduling, reminders, delivery control |
| Access Control | 15 enterprise roles, hierarchical scope, runtime permission matrix, session management |
| Executive Reporting | Dashboard analytics, workforce metrics, vacancy reports, performance summaries |

## Main Modules

### Command & Governance

- Command Center, Users and Access Control, Email Governance, HR Calendar, Bulk Administration and Data Governance

### People Operations

- Employee Directory, Organogram, Vacancies, Offer Lifecycle, Probation, Contract Renewal, Resignations, Vacation Management

### Payroll & Financial Operations

- Payroll, Payslips Center, Expenses and Outstation

### Field Operations

- Field Workforce Compliance, Attendance Device Mapping, Outstation Intelligence

### Communication & Access

- Email Composer, Templates and Notifications, Internal Messages

### Employee Self-Service

- Personal Profile, Mobile-First Dashboard, Payslips Access, Request Submission, Approval Visibility, Notifications

### Reporting & Intelligence

- Sales and Performance Reporting, Workforce Analytics, Vacancy Reports, Coaching and Performance

## Automation & Workflow Engines

Phoenix is driven by core engines that enforce business rules and eliminate manual coordination:

- **Approval Workflow Engine** — centralized state-machine registry governing all approval flows (payroll, resignations, probation, contracts, outstation, offers, marketing requests) with role guards, required reasons, side effects, and audit logging
- **Notification / Email Engine** — outbox-based delivery with idempotency, retry logic, template rendering, and delivery mode control
- **Payroll Validation and Governance Logic** — formula-based salary calculations, batch locking, duplicate detection, and payroll-expense integration
- **Field Workforce Compliance Logic** — evidence validation, GPS verification, route analysis, and compliance scoring
- **Role and Permission Engine** — 15 roles with hierarchical scope (self / team / hierarchy / line / company / system) and a runtime-overridable permission matrix
- **Import Validation and Normalization** — schema validation, normalization, duplicate detection, and audit logging for all bulk data entering the platform
- **Audit and Monitoring Logic** — audit trail on all state transitions, sensitive-operation logging, and observability integration
- **Lifecycle Reminder Logic** — automated reminders for probation reviews, contract renewals, resignation follow-ups, and employee action deadlines

## Data Ingestion & Bulk Administration

Phoenix supports controlled Excel-based uploads for initial database loading, payroll imports, sales imports, and bulk administration. These uploads are validation channels and operational bridges, not the core architecture or product identity.

Each upload flows through the Import Validation and Normalization engine — schema checks, normalization, duplicate detection, and audit logging — before structured data enters the governed model. This lets the platform absorb data from existing operational processes and bring it under platform governance, while the system of record, business rules, and workflows remain owned by Phoenix.

## Technical Architecture

| Component | Technology |
|---|---|
| Framework | Next.js 16 (App Router) with React 19 |
| Language | TypeScript (strict mode) |
| Database | Supabase (PostgreSQL) with Row-Level Security |
| Styling | Tailwind CSS v4 + shadcn/ui (Radix primitives, Lucide icons) |
| Hosting | Railway (deploys on push to `main`) |
| Email | Resend |
| Observability | Self-hosted (`app_error_events`) |
| E2E Testing | Playwright |
| Runtime | Node.js 22+ |

Phoenix is a monolithic Next.js application following a **domain-first architecture**:

- **API routes** (`app/api/**/route.ts`) handle all server interactions
- **Server-side business logic** lives in `src/lib/<domain>/`; UI components call domain services rather than re-implementing rules
- **Modular UI components** are organized by domain under `src/components/`
- **Validation scripts** under `scripts/` and `tests/scripts/` guard database, RLS, and migration safety
- **CI quality gates** run lint, typecheck, tests, and the production build on every change

Authentication is application-managed using HR_ID + password with HMAC-SHA256 signed session tokens. See [docs/architecture.md](docs/architecture.md) for the full narrative.

## Security & Governance

Phoenix handles sensitive enterprise data including employee PII, payroll records, salary details, and HR workflow approvals. Security is enforced at multiple layers:

- **Role-based access** — 15 enterprise roles with a configurable resource + action + scope permission matrix
- **RLS-backed security** — Row-Level Security on Supabase tables for database-level data isolation
- **Sensitive HR/payroll data handling** — server-side permission enforcement via `assertPermission()` on every route; sidebar visibility is UX only, never the security boundary
- **Auditability** — audit logging on all state transitions and sensitive operations
- **Service role restrictions** — the service-role client (bypasses RLS) is reserved for tightly bounded server tasks; user-scoped reads use the RLS-respecting client
- **Controlled production migration policy** — staging validation required before any database change reaches production

See [SECURITY.md](SECURITY.md) and [docs/security/](docs/security/) for detailed documentation.

## Repository Layout

```
app/                          # App Router pages and API route handlers
  admin/                      # Admin Workspace
  employee-portals/           # Employee Portal (self-service)
  api/                        # API route handlers
src/
  lib/<domain>/               # Domain services and business logic
  components/<domain>/        # Domain-specific UI components
  components/ui/              # Shared primitives (shadcn/ui)
  config/                     # System settings, navigation, brand config
supabase/
  migrations/                 # Timestamped SQL migrations (production schema)
tests/                        # Unit and integration tests
tests/e2e/                    # Playwright end-to-end specs
docs/                         # Architecture, security, and operating documentation
scripts/                      # Validation, migration pipeline, and operational scripts
local-attendance-agent/       # Standalone .NET attendance agent
```

## Local Development

**Prerequisites:** Node.js 22+, npm, a Supabase project.

```bash
git clone <repository-url>
cd phoenix-workforce
pnpm install --frozen-lockfile
cp .env.example .env.local     # Fill in Supabase credentials and auth secret
pnpm run dev                    # Opens http://localhost:3000
```

For dev-mode role switching: `GET /api/dev-auth?role=<role>` (development only). See [docs/setup.md](docs/setup.md) for the full setup guide.

## Environment Variables

All variables are documented in [`.env.example`](.env.example) with comments. See [docs/environment.md](docs/environment.md) for detailed descriptions organized by category.

## Quality Gates

| Command | Purpose |
|---|---|
| `pnpm run check:edit` | Fast inner loop — TypeScript only |
| `pnpm run ci` | The whole gate in one command — only when you actually need the answer before pushing |

**CI is the gate.** Push the branch and let the PR's checks answer: `validate`, `lint`, `typecheck`
and `secret-scan` are required and block a red merge. There is no local pre-push gate — the old
`check:harden` script was retired on 2026-08-18 because it only duplicated, slowly, what CI was
about to run anyway. `check:edit` remains available as an optional fast typecheck mid-task, and
`pnpm run ci` is there for the rare case where you need the full answer before you push.

## Documentation

| Document | Description |
|---|---|
| [Setup Guide](docs/setup.md) | Clone to running: prerequisites, install, env config |
| [Environment Variables](docs/environment.md) | All variables explained with categories |
| [Architecture](docs/architecture.md) | System overview, domains, data access model |
| [Database](docs/database.md) | Supabase setup, schema overview, RLS model |
| [Migrations](docs/migrations.md) | Migration policy, safety procedures, approval workflow |
| [Deployment](docs/deployment.md) | Deploy workflow, branch model, verification — **stale, describes Cloud Run** |
| [Testing](docs/testing.md) | Test strategy, running tests, adding new tests |
| [Scripts Reference](docs/scripts.md) | All npm scripts with safety classifications |
| [Editing Guide](docs/editing-guide.md) | Where to make edits, quality gate workflow |
| [Security](docs/security/) | RLS validation, role alignment, production readiness |
| [Observability](docs/observability.md) | Error capture, monitoring, alerting |
| [Development Workflow](docs/development-workflow.md) | Engineering operating rules and contributor governance |
| [Attendance Agent](docs/attendance-agent.md) | Local attendance integration setup |
| [Troubleshooting](docs/troubleshooting.md) | Common issues and solutions |
| [Current Operating State](docs/current-operating-state.md) | Branch strategy, deployment URLs |

## Current Status

This repository is under active enterprise stabilization. Core validation gates currently pass, while repo hygiene, production-readiness work, and data-storage cleanup continue through controlled PRs.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch strategy, commit conventions, PR process, and development rules.

## License

This is a private enterprise repository. All rights reserved.
