# Scripts Reference

All scripts are defined in `package.json`. This document classifies them by purpose and safety level.

## Safety Levels

| Level | Meaning |
|---|---|
| **Safe** | Runs locally, no external side effects |
| **Caution** | Connects to staging or development database |
| **Danger** | Can connect to or affect production database |

## Developer Scripts

| Script | Purpose | Safety |
|---|---|---|
| `npm run dev` | Start dev server (Turbopack) | Safe |
| `npm run build` | Production build | Safe |
| `npm run start` | Start production server locally | Safe |
| `npm run lint` | Run ESLint | Safe |
| `npm run typecheck` | TypeScript type checking | Safe |
| `npm run test` | Run unit/integration tests | Safe |
| `npm run test:e2e` | Full Playwright E2E suite | Safe |
| `npm run test:e2e:smoke` | Playwright login smoke test | Safe |

## Quality Gates

| Script | Purpose | Safety | Notes |
|---|---|---|---|
| `npm run check:edit` | Fast editing gate (typecheck only) | Safe | Inner loop during development |
| `npm run check:harden` | Full validation gate | Safe | lint + typecheck + test + build |
| `npm run ci` | CI pipeline gate | Safe | Same as check:harden |

## Database / RLS Validation Scripts

These scripts validate database state and RLS policies. They connect to Supabase.

| Script | Purpose | Safety | Target |
|---|---|---|---|
| `db:rls:create-staging-env` | Create staging RLS environment file | Caution | Staging |
| `db:rls:check-local-prereqs` | Check local RLS validation prerequisites | Caution | Local |
| `db:rls:bootstrap-sandbox` | Bootstrap Phoenix sandbox database | Caution | Staging |
| `db:rls:bootstrap-sandbox-auth` | Bootstrap sandbox auth users | Caution | Staging |
| `db:rls:discover-free-target` | Discover available RLS test target | Caution | Staging |
| `db:rls:prepare-test-users` | Prepare staging RLS test users | Caution | Staging |
| `db:validate:role-alignment:staging` | Validate role alignment on staging | Caution | Staging |
| `db:validate:role-alignment:staging:mutations` | Staging role alignment with mutations | Caution | Staging |
| `db:validate:role-alignment:staging:dry-run` | Staging role alignment (dry run) | Caution | Staging |
| `db:validate:role-alignment:local` | Validate role alignment locally | Caution | Local |
| `db:validate:role-alignment:local:dry-run` | Local role alignment (dry run) | Caution | Local |
| `db:validate:role-alignment:local:mutations` | Local role alignment with mutations | Caution | Local |
| `db:preflight:role-alignment:production` | Production role alignment preflight | **Danger** | Production |

## Migration Pipeline Scripts (Phase 25-36)

These scripts form a staged pipeline for validating and applying production database migrations. They must be run in sequence. Gaps in numbering (31, 35) are intentional -- those phases were consolidated.

| Script | Purpose | Safety | Phase |
|---|---|---|---|
| `phase25:staging-rls-mutation-smoke` | Staging RLS mutation smoke test | Caution | 25 |
| `phase26:staging-browser-auth-mutation-smoke` | Staging browser auth mutation test | Caution | 26 |
| `phase27:staging-app-service-mutation-smoke` | Staging app service mutation test | Caution | 27 |
| `phase28:production-migration-readiness-smoke` | Production migration readiness check | **Danger** | 28 |
| `phase29:production-migration-preapply-review` | Pre-apply review for production migration | **Danger** | 29 |
| `phase30:production-migration-approval-gate` | Production migration approval gate | **Danger** | 30 |
| `phase32:production-migration-queue-review` | Production migration queue review | **Danger** | 32 |
| `phase33:migration-history-reconciliation-gate` | Migration history reconciliation | **Danger** | 33 |
| `phase34:post-repair-pending-migrations` | Post-repair pending migration check | **Danger** | 34 |
| `phase36:post-apply-no-pending-migrations` | Verify no pending migrations remain | **Danger** | 36 |

## Standalone Scripts (in scripts/ directory)

| Script | Purpose | Safety | Notes |
|---|---|---|---|
| `scripts/seed-marketing-reference-data.ts` | Seed marketing reference data from xlsx | Caution | Needs MARKETING_PRODUCTS_XLSX env |
| `scripts/export-supabase-to-xlsx.js` | Export Supabase tables to Excel | Caution | Needs DATABASE_URL |
| `scripts/audit-image-evidence-storage.ts` | Audit image evidence in database | Caution | Read-only |
| `scripts/build_sales_database_foundation.py` | Build sales database foundation xlsx | Safe | Python, standalone |
| `scripts/employee-portal-launch-smoke.mjs` | Employee portal smoke test | Safe | Browser test |
| `scripts/phase13-phase24` (various) | Legacy staging validation scripts | Caution | Historical |

## Important Notes

1. Scripts marked **Danger** can connect to the production database. Do not run them without understanding what they do and obtaining approval.
2. The phase pipeline (25-36) must be run in sequence. Each phase validates the output of the previous phase.
3. Scripts use Node `--experimental-strip-types` for TypeScript execution (requires Node 22+).
4. Some scripts require environment variables from `.env.local` or `.env.staging.rls.local`.
