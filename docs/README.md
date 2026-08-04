# Phoenix Workforce Documentation

## Getting Started

| Document | Description |
|---|---|
| [Setup Guide](setup.md) | Clone to running: prerequisites, install, env config, local dev |
| [Environment Variables](environment.md) | All environment variables explained with categories |
| [Editing Guide](editing-guide.md) | Where to make common edits, quality gate workflow |

## Architecture & Design

| Document | Description |
|---|---|
| [Architecture](architecture.md) | System overview, domains, data access model |
| [Workflow & Route Architecture](workflow-and-route-architecture.md) | Registry- vs code-governed workflows, the `leave_requests` alias, route/app-shell ownership |
| [Current Operating State](current-operating-state.md) | Branch strategy, deployment URLs, Cloud Scheduler cron model |

## Database & Migrations

| Document | Description |
|---|---|
| [Database](database.md) | Supabase setup, schema overview, RLS model |
| [Migrations](migrations.md) | Migration policy, safety procedures, approval workflow |

## Security

| Document | Description |
|---|---|
| [Backup Table Placement](security/backup-table-placement.md) | Where ad-hoc snapshots go, and why never `public` |
| [RLS Prerequisites](security/local-supabase-rls-prerequisites.md) | Local RLS validation setup |
| [Role Alignment](security/role-alignment-staging-validation.md) | Staging role validation |
| [Production Readiness](security/role-alignment-production-readiness.md) | Production security checklist |
| [Blocker Remediation](security/production-blocker-remediation-plan.md) | Security blocker fixes |

## Development

| Document | Description |
|---|---|
| [Testing](testing.md) | Test strategy, running tests, adding new tests |
| [Scripts Reference](scripts.md) | All npm scripts with safety classifications |
| [Deployment](deployment.md) | Railway deployment (auto-deploy on push to `main`), branch model, production verification |
| [Troubleshooting](troubleshooting.md) | Common issues and solutions |

## Operations

| Document | Description |
|---|---|
| [Attendance Agent](attendance-agent.md) | Local ZKTeco attendance integration |
| [Observability](observability.md) | Error capture, monitoring, alerting |
| [Development Workflow](development-workflow.md) | Engineering operating rules and contributor governance |

## Planning & Audits

| Document | Description |
|---|---|
| [Repository Cleanup Plan](repository-cleanup-plan.md) | Full repo hygiene plan with phased actions |
| [Repo Hygiene Audit](repo-hygiene-audit.md) | Binary files, clutter, cleanup recommendations |
| [Security Audit (2026-05-09)](audit-2026-05-09.md) | Application security audit findings |
| [Payroll & Payslips Guide](payroll-payslips-detailed.md) | Detailed payroll system technical guide |
| [System Overview](system-overview.md) | High-level system overview |
| [TODO](todo.md) | Active task tracking |
| [I18n Plan](i18n-plan.md) | Internationalization roadmap |
| [Marketing Requests MVP](marketing-requests-mvp.md) | Marketing request module plan |
| [Workforce Lifecycle Phase 1](workforce-lifecycle-phase-1-plan.md) | Workforce lifecycle plan |
| [Production Build Scorecard](system-production-build-scorecard.md) | Build quality tracking |
| [Workflow Linkage Audit](system-workflow-linkage-audit.md) | Workflow linkage integrity audit |
| [Image Evidence Storage](image-evidence-storage-report.md) | Image/evidence storage analysis |
| [Production Readiness Closure](production-readiness-closure-system.md) | Readiness closure tracking |

## Archive

Completed, point-in-time planning and verification records. Retained for reference; not current operating documents.

| Document | Description |
|---|---|
| [Employee Portal Remediation](archive/employee-portal-launch-remediation-plan.md) | Historical portal launch-readiness verification (2026-05-28) |
