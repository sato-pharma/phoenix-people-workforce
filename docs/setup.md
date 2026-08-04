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
pnpm install --frozen-lockfile
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

### Working in a Git Worktree

`git worktree add` never copies gitignored files, so every new worktree
starts with no `.env.local` (and no `PHOENIX_AUTH_SECRET`, Supabase keys,
etc.) — dev-auth and the dev server will fail until you populate it. From
inside the new worktree, run:

```bash
pnpm run worktree:sync-env
```

This copies `.env.local` and the other local-only env files (`.env.*.rls.local`,
`.env.analytics`, ...) from the primary worktree (the original clone)
into the current one. It only fills in files that don't already exist here; pass
`--force` to overwrite, or `--dry-run` to preview without changing anything. Run
it once per new worktree, right after `git worktree add`.

## Start the Dev Server

```bash
pnpm run dev
```

Opens at http://localhost:3000. On macOS/Linux this uses Turbopack for faster
refreshes. On Windows, Turbopack is automatically disabled because its SWC
worker processes are unstable on NTFS and can crash, breaking client resource
loading. To opt in to Turbopack on Windows anyway, run `pnpm run dev:turbopack`.

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
pnpm run check:edit
```

Full pre-push validation (lint + typecheck + test + build):

```bash
pnpm run check:harden
```

Run `check:harden` **once per task, before you push or open a PR** — not before every commit. A
branch commit ships nowhere, and CI re-runs the same gate on the PR before a merge is allowed.

## Running Tests

Unit/integration tests:

```bash
pnpm run test
```

Playwright E2E smoke:

```bash
pnpm run test:e2e:smoke
```

Full E2E suite:

```bash
pnpm run test:e2e
```

See `docs/testing.md` for details.

## Supabase Setup

The app connects to a remote Supabase project via the environment variables above. For local Supabase setup with the CLI, see the Supabase CLI docs and `docs/database.md`.

## Attendance Agent (Optional)

The local attendance agent is a separate .NET application in `local-attendance-agent/`. See `docs/attendance-agent.md` for setup instructions. It is not required for general development.

## Troubleshooting

See `docs/troubleshooting.md` for common issues.
