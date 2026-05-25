# Phoenix Workforce

Phoenix Workforce is a Next.js 16 workforce operations platform for employee lifecycle management, payroll, expenses, offers, notifications, and sales-linked reporting.

## Stack

- Next.js 16 App Router
- React 19
- TypeScript
- Supabase for database, auth, and RLS-backed access control
- Excel-based operational imports for payroll, employees, sales, and admin bulk actions

## Repository Layout

- `app/`: App Router pages and API route handlers
- `src/components/`: UI components by domain
- `src/lib/`: business logic, auth, payroll, offers, sales, notifications, and shared utilities
- `supabase/`: SQL migrations, RLS hardening scripts, and operational database patches
- `docs/`: architecture and planning documents
- `tests/`: lightweight Node-based tests for shared logic

## Local Development

Requirements:

- Node.js 22 or newer recommended
- npm
- Supabase project credentials in local environment variables

Install and run:

```bash
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Quality Gates

The repository defines a CI-style pipeline with the same checks expected locally:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

Current status:

- `lint` is wired and usable
- `test` is wired with a Node test harness
- `typecheck` is expected to pass before production changes are pushed
- `build` is expected to pass before production deploys
- `npm audit --audit-level=low` is expected to report 0 vulnerabilities

## Current Operating State

The current live workflow is documented in [Current Operating State](F:/Phoenix%20Workforce/phoenix-workforce/docs/current-operating-state.md).

Short version:

- `main` is production-only and should not be edited directly.
- `codex/work-from-production` is the active local working branch for new edits and function changes.
- Production URL: [https://phoenix-workforce.vercel.app](https://phoenix-workforce.vercel.app)
- Working preview URL: [https://phoenix-workforce-git-codex-c8df8e-phoenix-workspace-s-projects.vercel.app](https://phoenix-workforce-git-codex-c8df8e-phoenix-workspace-s-projects.vercel.app)
- Vercel should keep only these two active deployments: production `main` and the `codex/work-from-production` preview.
- `.vercel/` is local Vercel CLI metadata and is intentionally ignored.

## Core Domains

- Access control and session handling
- Employee directory and lifecycle workflows
- Offers, approvals, and hiring
- Payroll batches, salary records, and expense imports
- Sales imports and performance reporting
- Notification scheduling and delivery

## Documentation

- [Current Operating State](F:/Phoenix%20Workforce/phoenix-workforce/docs/current-operating-state.md)
- [Architecture](F:/Phoenix%20Workforce/phoenix-workforce/docs/architecture.md)
- [I18n Plan](F:/Phoenix%20Workforce/phoenix-workforce/docs/i18n-plan.md)
- [Security Audit](F:/Phoenix%20Workforce/phoenix-workforce/AUDIT-2026-05-09.md)

## Fingerprint Device User Mapping

HR/Admin mapping page:

```text
/attendance/device-user-mapping
```

Manual test flow:

1. Start Phoenix and the local Windows Attendance Agent.
2. Run the agent manual sync:

```powershell
cd "F:\Phoenix Workforce\phoenix-workforce\local-attendance-agent"
$token = (Get-Content .\.env | Where-Object { $_ -match '^ATTENDANCE_AGENT_TOKEN=' }).Substring('ATTENDANCE_AGENT_TOKEN='.Length)

curl.exe -X POST http://127.0.0.1:8787/sync-now `
  -H "Authorization: Bearer $token" `
  -H "Content-Type: application/json" `
  -d "{}"
```

3. Open `/attendance/device-user-mapping`.
4. Review recent unmapped device users.
5. Assign each numeric `device_user_id` to an employee `HR_ID`.
6. Keep the mapping active and save.
7. Run `/sync-now` again. Mapped active users should insert or duplicate safely; unmapped users remain skipped.

Only active mappings with a valid `employees.hr_id` resolve during ingestion. Unmapped raw punches are not stored in `attendance_raw_punches`.

## Deployment Notes

This project depends on Supabase SQL changes stored under `supabase/`. Application deploys should not be treated as complete until the required matching database scripts have been applied.

Production deploys must verify the exact public domain, not only the workspace alias:

```text
https://phoenix-workforce.vercel.app
```

The current Vercel account is constrained by Hobby cron limits. Keep `vercel.json` to two daily cron jobs unless the account is upgraded.
