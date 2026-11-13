# Phoenix Role Alignment Staging Validation

> **Reconciled 2026-08-04 — this runbook targets a DEAD project.** The sandbox it uses,
> ref `oaifhavixhdtwmseshff` (`sato.hr2@hotmail.com`), **no longer exists** — `list_projects`
> returns only production `ozucdzovmcqvepbozvqf` and staging `cifwmndunmlxjhyjugxa`
> (see AGENTS.md §3). Every `oaifhavixhdtwmseshff` reference below is stale, and the runbook
> **cannot be run as written** until a fresh free/staging RLS target is provisioned. Do
> **not** substitute the production project.

This runbook validates `supabase/scripts/20260511_phoenix_role_alignment.sql` against a staging or branch Supabase database only.

Do not run this against production. The runner applies the migration to the target database after safety checks pass.

For Windows local Supabase prerequisites, see [Local Supabase RLS Prerequisites](./local-supabase-rls-prerequisites.md).

For the sandbox completion summary and production planning status, see [Phoenix Role Alignment Production Readiness](./role-alignment-production-readiness.md).

## Approved Testing Sandbox

> **Dead ref (2026-08-04):** `oaifhavixhdtwmseshff` below resolves to nothing — see the banner
> at the top of this file. Provision and substitute a live free/staging target before running.

Use only this existing free Supabase project for Phoenix RLS staging validation:

- Name: `sato.hr2@hotmail.com`
- Ref: `oaifhavixhdtwmseshff`
- URL: `https://oaifhavixhdtwmseshff.supabase.co`
- Database host: `db.oaifhavixhdtwmseshff.supabase.co`

Do not use the Phoenix HR production project for RLS testing:

- Name: `Phoenix HR`
- Ref: `ozucdzovmcqvepbozvqf`

The production project must not be used for dry-runs, migrations, test-user preparation, read validation, mutation validation, or any RLS setup activity.

## Free-Only Targets

Phoenix RLS validation is free-only. Do not create paid Supabase branches, paid Supabase projects, or any resource that may add cost.

Set:

```powershell
$env:PHOENIX_RLS_FREE_ONLY="1"
$env:PHOENIX_RLS_ALLOW_PAID_BRANCH="0"
```

Allowed targets:

- Existing free Supabase project clearly marked staging, dev, test, preview, or branch.
- Local Supabase database if available.
- Static/dry-run validation only if no safe free live target exists.

Disabled in free-only mode:

- Supabase branch creation.
- Supabase project creation.
- Paid branch/project commands.
- Production targets.

Discover a free target:

```powershell
pnpm run db:rls:discover-free-target
```

The discovery script only inspects existing environment/local config. It does not create branches, create projects, apply migrations, connect to production, or print secrets.

For local Supabase, provide local values through `.env.staging.rls.local` or shell env if the local config cannot expose them automatically:

```powershell
$env:PHOENIX_STAGING_ENVIRONMENT="local"
$env:PHOENIX_LOCAL_SUPABASE_URL="http://127.0.0.1:54321"
$env:PHOENIX_LOCAL_SUPABASE_ANON_KEY="LOCAL_ANON_KEY"
$env:PHOENIX_LOCAL_SUPABASE_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
```

## Validation Levels

The runner currently has two validation levels:

- Critical smoke matrix: the automated harness currently requires these minimum roles: Employee, Medical Rep, District Manager, Regional Manager, National Sales Manager, Finance Manager, HR Specialist, CEO, and Super Admin.
- Full enterprise matrix: the preferred pre-production standard is all 15 Phoenix roles: Employee, Medical Rep, District Manager, Regional Manager, National Sales Manager, Product Manager, Group Product Manager, SFE Manager, Training Manager, Marketing Manager, Finance Manager, HR Specialist, Manager, CEO, and Super Admin.

Before production, use the full 15-role matrix in `PHOENIX_RLS_TEST_USERS_JSON`. The current runner consumes the critical smoke roles and safely ignores extra role entries until the harness is expanded to require all 15 roles.

## Access Separation

Service/admin database access is used only for:

- Backups.
- Migration application.
- Metadata validation.

RLS assertions must always use:

- Supabase anon key.
- Real authenticated staging user sessions.

Do not use service-role access to prove user-visible RLS behavior.

## What The Runner Does

The automated runner:

1. Verifies staging-only environment variables.
2. Refuses production-looking environment names and Supabase URLs.
3. Creates backup tables for role/profile state, RLS policies, and helper functions.
4. Applies `supabase/scripts/20260511_phoenix_role_alignment.sql`.
5. Validates schema, helper functions, grants, role mappings, and dangerous policy patterns.
6. Runs `tests/scripts/phoenix-staging-rls-harness.ts` with real authenticated staging users.
7. Prints a PASS/FAIL report.

## Environment Template

Start from `.env.staging.rls.example`. It contains placeholders only and must not contain real production secrets.

Create a private local file for your staging values:

```powershell
pnpm run db:rls:create-staging-env
```

The helper copies `.env.staging.rls.example` to `.env.staging.rls.local`, adds a local-only warning header, and refuses to overwrite an existing file unless you run the helper script directly with `--force`.

Then paste staging-only secrets into `.env.staging.rls.local` on your machine. Never paste production secrets into this file. Never share it. Never commit `.env.staging.rls.local`; it is ignored by `.gitignore` through the `.env.*.local` rule.

The runner automatically loads `.env.staging.rls.local` if it exists. Existing shell environment variables take priority over values from the file, so CI or a temporary PowerShell override can safely replace a local value without editing the file.

Required variables:

```powershell
$env:PHOENIX_CONFIRM_STAGING_RLS_RUN="YES_STAGING_ONLY"
$env:PHOENIX_STAGING_ENVIRONMENT="staging"
$env:PHOENIX_RLS_FREE_ONLY="1"
$env:PHOENIX_RLS_ALLOW_PAID_BRANCH="0"
$env:PHOENIX_STAGING_SUPABASE_URL="https://YOUR-STAGING-PROJECT.supabase.co"
$env:PHOENIX_STAGING_SUPABASE_ANON_KEY="YOUR_STAGING_ANON_KEY"
$env:PHOENIX_STAGING_DATABASE_URL="postgresql://postgres.YOUR_PROJECT_REF:YOUR_PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres?sslmode=require"
$env:PHOENIX_RLS_ALLOW_STAGING_MUTATIONS="0"
$env:PHOENIX_RLS_ADMIN_LOGIN_ID="admin-HR"
$env:PHOENIX_RLS_ADMIN_PASSWORD="YOUR_STAGING_ADMIN_PASSWORD"
$env:PHOENIX_RLS_AUTO_CREATE_TEST_USERS="0"
```

`PHOENIX_RLS_TEST_USERS_JSON` should contain the full 15-role enterprise matrix before production:

```powershell
$env:PHOENIX_RLS_TEST_USERS_JSON='{
  "Employee":{"loginId":"employee_login","password":"password","hrId":"EMP-HR-ID"},
  "Medical Rep":{"loginId":"medical_rep_login","password":"password","hrId":"MR-HR-ID"},
  "District Manager":{"loginId":"district_manager_login","password":"password","hrId":"DM-HR-ID"},
  "Regional Manager":{"loginId":"regional_manager_login","password":"password","hrId":"RM-HR-ID"},
  "National Sales Manager":{"loginId":"national_sales_manager_login","password":"password","hrId":"NSM-HR-ID"},
  "Product Manager":{"loginId":"product_manager_login","password":"password","hrId":"PM-HR-ID"},
  "Group Product Manager":{"loginId":"group_product_manager_login","password":"password","hrId":"GPM-HR-ID"},
  "SFE Manager":{"loginId":"sfe_manager_login","password":"password","hrId":"SFE-HR-ID"},
  "Training Manager":{"loginId":"training_manager_login","password":"password","hrId":"TRN-HR-ID"},
  "Marketing Manager":{"loginId":"marketing_manager_login","password":"password","hrId":"MKT-HR-ID"},
  "Finance Manager":{"loginId":"finance_manager_login","password":"password","hrId":"FIN-HR-ID"},
  "HR Specialist":{"loginId":"hr_specialist_login","password":"password","hrId":"HR-HR-ID"},
  "Manager":{"loginId":"manager_login","password":"password","hrId":"MGR-HR-ID"},
  "CEO":{"loginId":"ceo_login","password":"password","hrId":"CEO-HR-ID"},
  "Super Admin":{"loginId":"super_admin_login","password":"password","hrId":"SA-HR-ID"}
}'
```

## Preparing Test Users

Use the staging-only preparation script to inspect role coverage and populate `PHOENIX_RLS_TEST_USERS_JSON` in `.env.staging.rls.local`:

```powershell
pnpm run db:rls:prepare-test-users
```

The script requires:

- `PHOENIX_RLS_ADMIN_LOGIN_ID`, usually `admin-HR`.
- `PHOENIX_RLS_ADMIN_PASSWORD`, pasted only into `.env.staging.rls.local`.
- Staging Supabase URL, anon key, and staging database URL.
- `PHOENIX_CONFIRM_STAGING_RLS_RUN=YES_STAGING_ONLY`.

The script first tries to verify the admin through Supabase Auth using the normal Phoenix auth email bridge. If that is not available, it verifies the admin in `app_auth_users` through staging database metadata. The admin must be active and map to `Super Admin` or an equivalent staging setup role.

If `PHOENIX_RLS_AUTO_CREATE_TEST_USERS=0`, the script reports missing role users or passwords and stops safely.

If `PHOENIX_RLS_AUTO_CREATE_TEST_USERS=1`, the script creates deterministic staging-only `rls-test-*` users for missing roles, generates strong random passwords locally, and writes those passwords only to `.env.staging.rls.local` inside `PHOENIX_RLS_TEST_USERS_JSON`. Generated passwords are never printed.

Do not use production values. Do not share `.env.staging.rls.local`.

## Commands

Dry-run validation without database connection, migration, backups, authenticated harness, or mutations:

```powershell
pnpm run db:validate:role-alignment:staging:dry-run
```

The dry-run script loads `.env.staging.rls.local` automatically if present.

Read validation plus migration/schema/policy validation:

```powershell
pnpm run db:validate:role-alignment:staging
```

Full validation including staging mutation probes:

```powershell
pnpm run db:validate:role-alignment:staging:mutations
```

Local Supabase commands:

```powershell
pnpm run db:validate:role-alignment:local:dry-run
pnpm run db:validate:role-alignment:local
pnpm run db:validate:role-alignment:local:mutations
```

Mutation tests are staging-only. Run them only after read validation passes. They require:

```powershell
$env:PHOENIX_RLS_ALLOW_STAGING_MUTATIONS="1"
```

Mutation probes create clearly marked `PHX_RLS_STAGING_TEST...` rows and must clean them up. Cleanup is performed through the authenticated Super Admin staging user, not through service-role access.

## Dry-Run Mode

Dry-run mode is enabled by either:

- Setting `PHOENIX_RLS_DRY_RUN=1`.
- Running `pnpm run db:validate:role-alignment:staging:dry-run`.

Dry-run mode validates:

- Required environment variables.
- Staging-only safety gates.
- Confirmation phrase `YES_STAGING_ONLY`.
- Non-production environment name.
- Non-production-looking Supabase URL and detected host.
- Anon key presence.
- Database URL presence, without connecting to it.
- `PHOENIX_RLS_TEST_USERS_JSON` parsing.
- Critical 9-role smoke matrix presence.
- Optional full 15-role enterprise matrix presence.
- Migration file path, file size, and SHA-256 checksum.
- Required SQL sections in `supabase/scripts/20260511_phoenix_role_alignment.sql`.
- Backup SQL sections in the runner.
- Dangerous policy detector SQL sections in the runner.
- Authenticated harness file location.

Dry-run mode never:

- Connects to the database.
- Applies the migration.
- Creates backup tables.
- Runs metadata validation against staging.
- Runs the authenticated RLS harness.
- Runs mutation probes.

The dry-run output must end with either `Final: DRY RUN PASS` or `Final: DRY RUN FAIL`.

## Safety Checks

The runner refuses to start if:

- `PHOENIX_CONFIRM_STAGING_RLS_RUN` is not exactly `YES_STAGING_ONLY`.
- `PHOENIX_STAGING_ENVIRONMENT` is `production`, `prod`, or not clearly non-production.
- `PHOENIX_STAGING_SUPABASE_URL` looks production-like.
- `PHOENIX_STAGING_SUPABASE_ANON_KEY` is missing.
- `PHOENIX_STAGING_DATABASE_URL` is missing.
- `PHOENIX_RLS_TEST_USERS_JSON` is missing any critical smoke role.
- `PHOENIX_RLS_FREE_ONLY=1` is not set for free-only discovery.
- `PHOENIX_RLS_ALLOW_PAID_BRANCH=1` is set.

## Backup Tables

The runner creates these staging backup tables before applying the migration:

- `public._backup_20260511_runner_user_access_profiles_role_alignment`
- `public._backup_20260511_runner_app_auth_users_role_alignment`
- `public._backup_20260511_runner_rls_policies_role_alignment`
- `public._backup_20260511_runner_helper_functions_role_alignment`

## Troubleshooting

Missing env vars:

- The runner fails in Phase 0 and names the missing variable.
- Load values from a private staging env file copied from `.env.staging.rls.example`.
- Confirm the dry-run output says whether `.env.staging.rls.local` was found.

Production-looking URL refusal:

- Confirm the Supabase URL belongs to a staging, branch, preview, dev, or test project.
- Do not bypass this for production.

Missing test users:

- Add the missing role entries to `PHOENIX_RLS_TEST_USERS_JSON`.
- The runner currently requires the critical smoke roles, while the production-readiness standard is all 15 roles.

Login failure:

- Confirm the staging `loginId` maps to Phoenix auth email format.
- Confirm the password is current and the staging user is active.
- Confirm the user exists in Supabase Auth and `app_auth_users`.

RLS helper grant failure:

- Re-check that `supabase/scripts/20260511_phoenix_role_alignment.sql` ran completely.
- Verify `authenticated` has `EXECUTE` and `anon` does not for the `current_access_*` helpers.

Dangerous policy detector failure:

- Inspect the named table and policy.
- The common blockers are leftover `current_access_role() = 'admin'`, uncorrelated `EXISTS`, or TEAM/HIERARCHY/LINE write access to payroll tables.

## Go / No-Go

Staging is GO only when the final report has zero failures.

Treat staging as NO-GO if any of these fail:

- Migration application.
- Helper existence or grants.
- Role mapping mismatch detector.
- Dangerous policy detector.
- Authenticated RLS harness.
- CEO, Finance Manager, or HR Specialist write restrictions.
- Super Admin admin-action checks.

Before production, also complete the full 15-role matrix validation.

## Manual Work Remaining

The only required manual setup is provisioning the staging database connection and real staging test users. The migration application and validation flow are automated by the runner.
