# Local Development Setup

## Prerequisites

- Node.js 22 or newer (required for --experimental-strip-types in tests)
- npm
- A Supabase project (or access to the team's shared project credentials)
- Git

## Clone and Install

```bash
git clone <repo-url>
cd phoenix-workforce
npm ci
```

## Environment Configuration

1. Copy the template:

   ```bash
   cp .env.example .env.local
   ```

2. Fill in required variables (minimum for local dev):

   - `NEXT_PUBLIC_SUPABASE_URL` — your Supabase project URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase anon/public key
   - `SUPABASE_SERVICE_ROLE_KEY` — Supabase service role key (server-only)
   - `PHOENIX_AUTH_SECRET` — a random 64-character hex string for session signing

3. See `docs/environment.md` for all variables and what they do.

## Start the Dev Server

```bash
npm run dev
```

Opens at http://localhost:3000 with Turbopack.

## Dev Auth (Local Testing)

In development mode, you can browse as any role without real credentials:

```
GET http://localhost:3000/api/dev-auth?role=Super%20Admin
```

This sets a dev session cookie. Available roles match the `PhoenixRole` enum in `src/lib/auth/permissions.ts`. Dev-auth is disabled in production.

To also enable dev auth headers (`x-phoenix-role`, `x-phoenix-hr-id`), set `PHOENIX_ENABLE_DEV_AUTH_HEADERS=true` in `.env.local`.

## Quality Gates

Fast inner loop (typecheck only):

```bash
npm run check:edit
```

Full pre-commit validation (lint + typecheck + test + build):

```bash
npm run check:harden
```

Always run `check:harden` before committing, pushing, or creating PRs.

## Running Tests

Unit/integration tests:

```bash
npm run test
```

Playwright E2E smoke:

```bash
npm run test:e2e:smoke
```

Full E2E suite:

```bash
npm run test:e2e
```

See `docs/testing.md` for details.

## Supabase Setup

The app connects to a remote Supabase project via the environment variables above. For local Supabase setup with the CLI, see the Supabase CLI docs and `docs/database.md`.

## Attendance Agent (Optional)

The local attendance agent is a separate .NET application in `local-attendance-agent/`. See `docs/attendance-agent.md` for setup instructions. It is not required for general development.

## Troubleshooting

See `docs/troubleshooting.md` for common issues.
