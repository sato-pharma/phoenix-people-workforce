# Phoenix Workforce

Phoenix Workforce is an internal enterprise workforce operating system for HR governance, employee lifecycle automation, payroll control, approval workflows, field operations intelligence, employee self-service, and executive reporting. It is designed to replace scattered spreadsheets, manual follow-ups, disconnected approvals, and informal HR communication loops with a governed, role-based, auditable platform.

## Product Positioning

Phoenix Workforce is not a data import tool or a spreadsheet viewer. It is an enterprise HR operating system that centralizes workforce master data, automates lifecycle events, enforces multi-level approvals, governs payroll and expenses, tracks field operations, and gives employees controlled self-service access to their own HR information. Every action flows through role-based permissions, audit logging, and structured workflows.

## Core Experiences

### Admin Workspace

The admin workspace serves HR managers, payroll administrators, department heads, and executive leadership. It provides a command center for workforce operations, employee master data management, organizational hierarchy visualization, vacancy and hiring pipelines, payroll governance, expense approvals, field compliance monitoring, attendance integration, sales and performance reporting, notification management, and access control administration.

### Employee Portal

The employee portal gives each employee a role-aware, mobile-friendly personal workspace. Employees can view their profile and HR information, access payslips, submit vacation and leave requests, track request status and approvals, receive notifications, and interact with HR services through controlled self-service workflows without requiring direct HR intervention for routine operations.

## Business Capabilities

| Capability | What Phoenix Handles |
|---|---|
| Workforce Master Data | Employee directory, organizational hierarchy, department structure, reporting lines |
| Employee Lifecycle | Hiring, onboarding, probation tracking, contract management, resignations, terminations, vacancy creation |
| Approvals & Requests | Multi-level approval workflows for leave, expenses, outstation, offers, resignations, marketing requests |
| Payroll Governance | Batch payroll processing, salary records, allowances, deductions, payslip generation, payroll locks |
| Payslips | Employee payslip access, payslip image export, salary detail breakdowns |
| Expenses & Outstation | Medical rep expenses, field travel requests, allowance calculations, car evidence, GPS tracking |
| Attendance Integration | ZKTeco fingerprint device sync, raw punch ingestion, device-user mapping, attendance reporting |
| Field Compliance | Field workforce compliance tracking, route intelligence, outstation heatmaps, evidence validation |
| Sales & Performance | Distributor sales imports, territory reporting, performance analytics, target tracking |
| Email & Notification Governance | Template-based email delivery, outbox scheduling, birthday reminders, contract renewal alerts |
| Access Control | 15 enterprise roles, hierarchical scope, runtime permission matrix, session management |
| Executive Reporting | Dashboard analytics, workforce metrics, vacancy reports, performance summaries |

## Main Modules

### Command & Governance

- **Command Center** -- operational dashboard for HR leadership
- **Users & Access Control** -- role assignment, permission management, session governance
- **Email Governance** -- delivery mode control, test recipients, template management
- **HR Calendar** -- organization-wide event tracking

### People Operations

- **Employee Directory** -- searchable workforce registry with profile management
- **Organogram** -- visual organizational hierarchy
- **Vacancies** -- position tracking, replacement chains, vacancy reporting
- **Offer Lifecycle** -- offer creation, approval workflows, public offer links
- **Probation** -- probation period tracking, review scheduling, outcome recording
- **Contract Renewal** -- contract expiry monitoring, renewal workflows, automated reminders
- **Resignations** -- resignation submission, approval chains, last-working-day management
- **Vacation Management** -- leave requests, balance tracking, entitlement policies, compensatory days

### Payroll & Financial Operations

- **Payroll** -- batch processing, salary record management, formula-based calculations, payroll locks
- **Payslips Center** -- payslip generation, image export, employee self-service access
- **Expenses & Outstation** -- expense submissions, multi-level approvals, outstation allowances, payroll integration

### Field Operations

- **Field Workforce Compliance** -- compliance tracking, evidence collection, route monitoring
- **Attendance Device Mapping** -- ZKTeco device integration, employee-device assignment, sync management
- **Outstation Intelligence** -- GPS-tracked field visits, route optimization, expense heatmaps

### Communication & Access

- **Email Composer** -- HR email drafting with templates and signature management
- **Templates & Notifications** -- notification templates, outbox processing, delivery tracking
- **Internal Messages** -- organization-wide messaging and announcements

### Employee Self-Service

- **Personal Profile** -- employee information view and limited self-management
- **Mobile-First Dashboard** -- role-aware employee landing experience
- **Payslips Access** -- personal payslip history and downloads
- **Request Submission** -- vacation, excuse, and support request workflows
- **Approval Visibility** -- request status tracking and approval chain transparency
- **Notifications** -- personal notification feed and email alerts

### Reporting & Intelligence

- **Sales Performance Reporting** -- distributor performance, territory analytics, period comparisons
- **Workforce Analytics** -- headcount metrics, lifecycle event tracking, department breakdowns
- **Vacancy Reports** -- open position tracking, replacement pipeline visibility
- **Coaching & Performance** -- coaching reports, scoring analytics, field excellence tracking

## Automation & Workflow Engines

Phoenix Workforce is driven by several core engines that enforce business rules and eliminate manual coordination:

- **Approval Workflow Engine** -- centralized state-machine registry governing all approval flows (payroll, resignations, probation, contracts, outstation, offers, marketing requests) with role guards, required reasons, side effects, and audit logging
- **Notification & Email Engine** -- outbox-based delivery with idempotency, retry logic, template rendering, and delivery mode control (live/test/log)
- **Payroll Validation & Governance Logic** -- formula-based salary calculations, batch locking, duplicate detection, payroll-expense integration, and payslip generation
- **Field Workforce Compliance Logic** -- evidence validation, GPS verification, route analysis, and compliance scoring
- **Role & Permission Engine** -- 15 roles with hierarchical scope (self/team/hierarchy/line/company/system), runtime-overridable permission matrix, and cached access resolution
- **Lifecycle Reminder Logic** -- automated reminders for probation reviews, contract renewals, resignation follow-ups, and employee action deadlines
- **Audit & Monitoring Logic** -- audit trail on all state transitions, sensitive operations logging, and observability integration

## Data Ingestion & Bulk Operations

Phoenix supports controlled file-based uploads for initial database loading, payroll imports, sales data imports, and bulk administrative operations. These uploads serve as validation channels that convert operational files into governed system data with schema validation, normalization, duplicate detection, and audit logging.

Supported upload types include employee master data, salary records, distributor sales reports, and marketing reference data. Each upload flows through domain-specific validation and normalization before entering the governed data model.

This is a bridge capability -- designed to ingest structured data from existing operational processes and bring it under platform governance, not the core system architecture.

## Technical Architecture

| Component | Technology |
|---|---|
| Framework | Next.js 16 (App Router) with React 19 |
| Language | TypeScript (strict mode) |
| Database | Supabase (PostgreSQL) with Row-Level Security |
| Styling | Tailwind CSS v4 + shadcn/ui (Radix primitives, Lucide icons) |
| Hosting | Vercel |
| Email | Resend |
| Observability | Sentry |
| E2E Testing | Playwright |
| Runtime | Node.js 22+ |

The application follows a **domain-first architecture**: all business logic lives in `src/lib/<domain>/`, and UI components call domain services rather than implementing business rules inline. Authentication is application-managed using HR_ID + password with HMAC-SHA256 signed session tokens. User-scoped data access is enforced through Supabase RLS policies. Approval flows are governed by a centralized workflow registry with defined state machines, role guards, and audit trails.

See [docs/architecture.md](docs/architecture.md) for the full architectural narrative.

## Security & Governance

Phoenix Workforce handles sensitive enterprise data including employee PII, payroll records, salary details, and HR workflow approvals. Security is enforced at multiple layers:

- **Application-managed authentication** -- HR_ID + bcrypt password hashing, HMAC-SHA256 session tokens, timing-safe comparison
- **15 enterprise roles** with a configurable permission matrix (resource + action + scope)
- **Row-Level Security** on all Supabase tables for database-level data isolation
- **Server-side permission enforcement** via `assertPermission()` on every API route -- sidebar visibility is UX only, never the security boundary
- **Audit logging** on all state transitions and sensitive operations
- **Security headers** -- CSP, HSTS with preload, X-Frame-Options DENY, CORP, strict referrer policy
- **Controlled production migration policy** -- staging validation required before any database changes reach production

See [SECURITY.md](SECURITY.md) and [docs/security/](docs/security/) for detailed security documentation.

## Repository Layout

```
app/                          # App Router pages and API route handlers
  admin/                      # Admin workspace
  employee-portals/           # Employee self-service portal
  api/                        # API route handlers
src/
  lib/<domain>/               # Domain services and business logic
  components/<domain>/        # Domain-specific UI components
  components/ui/              # Shared primitives (shadcn/ui)
  config/                     # System settings, navigation, brand config
supabase/
  migrations/                 # Timestamped SQL migrations (production schema)
tests/                        # Unit and integration tests (90+)
tests/e2e/                    # Playwright end-to-end specs (18+)
docs/                         # Architecture, security, and operating documentation
scripts/                      # Validation, migration pipeline, and operational scripts
local-attendance-agent/       # Standalone .NET ZKTeco attendance agent
```

## Local Development

**Prerequisites:** Node.js 22+, npm, a Supabase project.

```bash
git clone <repository-url>
cd phoenix-workforce
npm ci
cp .env.example .env.local     # Fill in Supabase credentials and auth secret
npm run dev                    # Opens http://localhost:3000
```

For dev-mode role switching: `GET /api/dev-auth?role=<role>` (development only). See [docs/setup.md](docs/setup.md) for the full setup guide.

## Environment Variables

All variables are documented in [`.env.example`](.env.example) with comments. See [docs/environment.md](docs/environment.md) for detailed descriptions organized by category.

## Quality Gates

| Command | Purpose |
|---|---|
| `npm run check:edit` | Fast inner loop -- TypeScript only |
| `npm run check:harden` | Full pre-commit gate: lint + typecheck + test + build |
| `npm run ci` | Same as `check:harden` (CI pipeline) |

Run `check:edit` during active development and `check:harden` before every commit, push, or deploy.

## Documentation

| Document | Description |
|---|---|
| [Setup Guide](docs/setup.md) | Clone to running: prerequisites, install, env config |
| [Environment Variables](docs/environment.md) | All variables explained with categories |
| [Architecture](docs/architecture.md) | System overview, domains, data access model |
| [Database](docs/database.md) | Supabase setup, schema overview, RLS model |
| [Migrations](docs/migrations.md) | Migration policy, safety procedures, approval workflow |
| [Deployment](docs/deployment.md) | Vercel workflow, branch model, verification |
| [Testing](docs/testing.md) | Test strategy, running tests, adding new tests |
| [Scripts Reference](docs/scripts.md) | All npm scripts with safety classifications |
| [Editing Guide](docs/editing-guide.md) | Where to make edits, quality gate workflow |
| [Security](docs/security/) | RLS validation, role alignment, production readiness |
| [Observability](docs/observability.md) | Sentry setup, monitoring, alerting |
| [Development Workflow](docs/development-workflow.md) | Engineering operating rules and contributor governance |
| [Attendance Agent](docs/attendance-agent.md) | Local ZKTeco integration setup |
| [Troubleshooting](docs/troubleshooting.md) | Common issues and solutions |
| [Current Operating State](docs/current-operating-state.md) | Branch strategy, deployment URLs |
| [Repo Hygiene Audit](docs/repo-hygiene-audit.md) | Tracked binary files, cleanup plan |

## Current Status

This repository is under active enterprise stabilization. Core validation gates currently pass (lint, typecheck, test, build), but repository hygiene and production-readiness work continue through controlled PRs. See [docs/repo-hygiene-audit.md](docs/repo-hygiene-audit.md) for tracked cleanup items.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, commit conventions, PR process, and development rules.

## License

This is a private enterprise repository. All rights reserved.
