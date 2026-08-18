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
| `pnpm run dev` | Start dev server (Turbopack) | Safe |
| `pnpm run build` | Production build | Safe |
| `pnpm run start` | Start production server locally | Safe |
| `pnpm run lint` | Run ESLint | Safe |
| `pnpm run typecheck` | TypeScript type checking | Safe |
| `pnpm run test` | Run unit/integration tests | Safe |
| `pnpm run test:e2e` | Full Playwright E2E suite | Safe |
| `pnpm run test:e2e:smoke` | Playwright login smoke test | Safe |

## Quality Gates

| Script | Purpose | Safety | Notes |
|---|---|---|---|
| `pnpm run check:edit` | Fast editing gate (typecheck only) | Safe | Inner loop during development |
| `pnpm run ci` | The whole gate in one command | Safe | lint + typecheck + test + build. **Not a pre-push ritual** — CI is the gate; run this only before a migration or a production deploy, which CI never sees |

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
| `db:au:reconcile-area-state` | Reconcile `au.line_area_map.area_state` against `au.occupancy_history` — read-only, exits 1 on drift (see [vacancy-models.md](area-unification/vacancy-models.md)) | Caution | Whichever project the env points at |
| `db:staging:rebuild:plan` | Print safe fresh-staging rebuild plan and git status | Safe | Local |
| `db:staging:rebuild:archive-current` | Create an archive-preserved metadata manifest while keeping old staging online | Caution | Staging |
| `db:staging:rebuild:backup-current` | Optional full dump export when Supabase CLI dumps are known to complete | Caution | Staging |
| `db:staging:rebuild:dry-run-new` | Dry-run the full migration chain against a separate new staging target | Caution | New staging |
| `db:staging:rebuild:apply-new` | Apply the full migration chain to a separate new staging target after archive/backup confirmation | Caution | New staging |
| `db:staging:rebuild:verify-new` | Verify new staging migration history and executive RPC grants | Caution | New staging |

## Migration Pipeline Scripts (Phase 25-36)

Phase 25-27 (staging mutation smoke tests) are still active and safe to run. Phase
28-36 (production migration approval/reconciliation) were **retired 2026-07-11** —
each script's own header comment says so: they hardcode checks against one specific
pre-baseline migration
(`20260518232733_phase21_security_access_governance_hardening.sql`, now archived
under `supabase/_migrations_archive/pre-baseline-2026-07-11/`) and cannot validate
any migration written since the baseline-snapshot model took over (see
docs/migrations.md, "Baseline Model"). They still run without erroring, which makes
a green result look like a real gate when it is actually re-checking a frozen,
unrelated file — do not treat a passing phase28-36 script as evidence about a
current migration.

| Script | Purpose | Safety | Phase | Status |
|---|---|---|---|---|
| `phase25:staging-rls-mutation-smoke` | Staging RLS mutation smoke test | Caution | 25 | Active |
| `phase26:staging-browser-auth-mutation-smoke` | Staging browser auth mutation test | Caution | 26 | Active |
| `phase27:staging-app-service-mutation-smoke` | Staging app service mutation test | Caution | 27 | Active |
| `phase28:production-migration-readiness-smoke` | Production migration readiness check | **Danger** | 28 | **Retired** |
| `phase29:production-migration-preapply-review` | Pre-apply review for production migration | **Danger** | 29 | **Retired** |
| `phase30:production-migration-approval-gate` | Production migration approval gate | **Danger** | 30 | **Retired** |
| `phase32:production-migration-queue-review` | Production migration queue review | **Danger** | 32 | **Retired** |
| `phase33:migration-history-reconciliation-gate` | Migration history reconciliation | **Danger** | 33 | **Retired** |
| `phase34:post-repair-pending-migrations` | Post-repair pending migration check | **Danger** | 34 | **Retired** |
| `phase36:post-apply-no-pending-migrations` | Verify no pending migrations remain | **Danger** | 36 | **Retired** |

`security:preflight:local` also transitively hits retired ground: it runs
`security-identity-health.ts`, which reads the same archived pre-baseline migration
file and regex-checks it — that check will trivially pass forever regardless of live
database state. Its other two sub-checks (`security:access-registry`,
`security:rls-static`) are still meaningful static checks.

## Standalone Scripts (in scripts/ directory)

| Script | Purpose | Safety | Notes |
|---|---|---|---|
| `scripts/seed-marketing-reference-data.ts` | Seed marketing reference data from xlsx | Caution | Needs MARKETING_PRODUCTS_XLSX env |
| `scripts/export-supabase-to-xlsx.js` | Export Supabase tables to Excel | Caution | Needs DATABASE_URL |
| `scripts/audit-image-evidence-storage.ts` | Audit image evidence in database | Caution | Read-only |
| `scripts/build_sales_database_foundation.py` | Build sales database foundation xlsx | Safe | Python, standalone. Expects the local `sato 4-2026/` workbooks to exist on disk (these are intentionally **not** tracked in Git). |
| `scripts/employee-portal-launch-smoke.mjs` | Employee portal smoke test | Safe | Browser test |
| `scripts/phase13-phase24` (various) | Legacy staging validation scripts | Caution | Historical |

## Important Notes

1. Scripts marked **Danger** can connect to the production database. Do not run them without understanding what they do and obtaining approval.
2. Phase 25-27 must be run in sequence for staging validation. Phase 28-36 are retired (see above) — there is currently no scripted production-migration approval pipeline; production applies go through the Supabase MCP/CLI directly, gated by manual `get_advisors` plus targeted SQL verification and explicit owner approval.
3. Scripts use Node `--experimental-strip-types` for TypeScript execution (requires Node 22+).
4. Some scripts require environment variables from `.env.local` or `.env.staging.rls.local`.
