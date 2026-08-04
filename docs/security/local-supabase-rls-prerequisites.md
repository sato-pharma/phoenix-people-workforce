# Local Supabase RLS Prerequisites

This guide prepares a Windows machine for Phoenix Workforce role-alignment RLS validation using local Supabase only.

It does not touch production, create Supabase cloud branches, create Supabase projects, or use paid Supabase features. Local Supabase runs in Docker containers on your machine.

## Required Tools

1. Install Docker Desktop for Windows.
2. Open Docker Desktop and wait until it says the engine is running.
3. Enable the WSL2 backend if Docker Desktop or Windows prompts for it.
4. Use Node.js 24 or later (the repo's `engines.node` floor).
5. Use the Supabase CLI through this repo:

```powershell
pnpm add --save-dev supabase
```

Do not use:

```powershell
pnpm add -g supabase
```

You can also run Supabase CLI commands through `pnpm exec supabase`, but the repo-local dev dependency is preferred because it is repeatable for this project.

## Why This Is Free

The local Supabase stack runs on your machine through Docker. It does not create a Supabase cloud project, cloud branch, paid preview branch, or hosted database.

Phoenix validation scripts also enforce:

```powershell
$env:PHOENIX_RLS_FREE_ONLY="1"
$env:PHOENIX_RLS_ALLOW_PAID_BRANCH="0"
```

## Why This Does Not Touch Production

The local validation flow uses:

- `PHOENIX_STAGING_ENVIRONMENT=local`
- local Supabase URL, usually `http://127.0.0.1:54321`
- local database URL, usually `postgresql://postgres:postgres@127.0.0.1:54322/postgres`
- generated local-only test users

Do not paste production Supabase values into `.env.staging.rls.local`.

## Commands

After installing Docker Desktop and starting it, run:

```powershell
pnpm run db:rls:check-local-prereqs
pnpm run db:rls:discover-free-target
pnpm run db:validate:role-alignment:local:dry-run
```

If the preflight reports that Supabase CLI is missing, install it locally:

```powershell
pnpm add --save-dev supabase
```

Then re-run:

```powershell
pnpm run db:rls:check-local-prereqs
```

## Expected Preflight Behavior

`pnpm run db:rls:check-local-prereqs` checks:

- Node.js version. The preflight's own check only requires Node 20+, but the repo's
  `engines.node` floor is Node 24 — install Node 24 or later.
- npm availability.
- Docker command availability.
- Docker daemon status.
- Supabase CLI availability from `node_modules/.bin/supabase` or `npx --no-install supabase --help (works with pnpm-installed bins)`.
- `supabase/config.toml` presence.
- `.env.staging.rls.local` presence.
- `PHOENIX_RLS_FREE_ONLY=1`.
- paid branch creation disabled.

If Docker is missing, the script stops and tells you to install Docker Desktop for Windows and start it.

If Supabase CLI is missing, the script stops and tells you to run:

```powershell
pnpm add --save-dev supabase
```

No migration or validation runs from the prerequisite checker.
