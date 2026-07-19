# Supabase Advisor Baseline — Accepted / By-Design Items

**Project:** Phoenix HR production (`ozucdzovmcqvepbozvqf`)
**Last reviewed:** 2026-07-19

This is the single triage reference for `get_advisors` output. Items listed here are
**reviewed and accepted as by-design** (or explicitly deferred). A health check should
compare new advisor output against this list and only escalate items **not** captured
here. Related context: [`role-alignment-production-readiness.md`](./role-alignment-production-readiness.md),
[`production-blocker-remediation-plan.md`](./production-blocker-remediation-plan.md).

> Anything **not** on this list is a genuine new finding and must be triaged, not assumed benign.

---

## Security advisors

### ACCEPTED — `authenticated_security_definer_function_executable` (WARN ×14)
The `current_access_*` / `current_phoenix_role` helper functions are `SECURITY DEFINER`
and callable by the `authenticated` role **by design**: they are the primitives RLS
policies call to resolve the caller's identity/scope, so `authenticated` *must* be able
to execute them. Revoking execute or switching to `SECURITY INVOKER` would break RLS.

Functions (all `public.`): `current_access_can_manage_employees()`,
`current_access_can_manage_payroll()`, `current_access_can_see_employee(text,text)`,
`current_access_hr_id()`, `current_access_is_admin()`, `current_access_is_company_reader()`,
`current_access_is_finance()`, `current_access_is_hr()`, `current_access_is_super_admin()`,
`current_access_line()`, `current_access_manager_hr_id()`, `current_access_role()`,
`current_access_scope()`, `current_phoenix_role()`.

### ACCEPTED (N/A) — `auth_leaked_password_protection` disabled (WARN ×1)
Not applicable. Phoenix uses **application-managed auth** (HR_ID + `bcryptjs` + an
app-signed session cookie verified against `app_auth_users`), **not** Supabase Auth, so
the HaveIBeenPwned check on Supabase Auth passwords governs no real login path.

### ACCEPTED — `rls_enabled_no_policy` (INFO ×23) — service-role-only tables
RLS is enabled with no policy, so the browser (`anon`/`authenticated`) is denied all
access **by design**; these tables are written/read only by the service role on the
server. Deny-by-default is the intended posture.

Tables (all `public.`): `email_suppressions`, `marketing_customer_contacts`,
`marketing_customer_pharmacies`, `marketing_customers`, `marketing_evidence_files`,
`marketing_pharmacies`, `marketing_pharmacy_distributor_codes`,
`marketing_request_approval_steps`, `marketing_request_finance_requirements`,
`marketing_request_pharmacies`, `marketing_request_products`, `marketing_requests`,
`monthly_closing_publications`, `report_it_audit_logs`, `report_it_reports`,
`source_of_sales_customer_map`, `v2_vacation_approval_steps`, `weekly_distributor_mapping`,
`weekly_missing_mappings`, `weekly_sales_batches`, `weekly_sales_pos_region_mappings`,
`weekly_sales_product_scope`, `weekly_sales_rows`, `background_jobs` (added 2026-07-20,
same pattern: service-role-only async job queue, accessed via `getSupabaseAdmin()` and
the `claim_next_background_job()` RPC, never a browser client).

> If any table here ever needs RLS-respecting *browser* reads, that is a real change —
> add a scoped policy rather than treating the INFO as noise.

### REMEDIATED (not accepted) — `function_search_path_mutable`
`public.phx_insert_attendance_raw_punch` was flagged for a mutable `search_path`.
Fixed by pinning `SET search_path = public, pg_temp` (migration
`pin_attendance_punch_search_path`). Should not reappear; if it does, it's a regression.

### REMEDIATED (not accepted) — `anon_security_definer_function_executable` (2026-07-19)
Found via `get_advisors` while auditing the Sales Analytics module: 7 orphaned
`analytics_*` RPC overloads (plural `p_periods text[]` params, no committed migration
defines them) were `SECURITY DEFINER` with **no auth guard**, live on both staging
(`cifwmndunmlxjhyjugxa`) and production (`ozucdzovmcqvepbozvqf`) — a real,
unauthenticated, company-wide sales-data leak: anyone holding the public anon key
could POST `/rest/v1/rpc/analytics_sos_by_period` (etc.) and pull the whole company's
SoS/Weekly/Closing data, with `p_exclude_head_office=false` also revealing the
confidential Head Office line. Root vector: the built-in Postgres default grants
`EXECUTE` to `PUBLIC` on new functions, and `anon`/`authenticated` inherit it via
PUBLIC membership — so `REVOKE ... FROM anon, authenticated` alone is a **no-op**;
the fix must `REVOKE ... FROM PUBLIC`. A follow-up scan then found two more
anon-executable `SECURITY DEFINER` functions carrying the same PUBLIC grant —
`probation_provision_case_on_hire()` and
`phx_employee_insert_reconcile_stale_vacancies_trigger()` — both INSERT-trigger
functions (low practical exploitability: PostgREST doesn't expose `trigger`-returning
functions as RPCs, and triggers don't need an EXECUTE grant to fire), revoked in the
same pass.

Fixed by (all applied + verified live on staging AND production —
`has_function_privilege('anon', ..., 'EXECUTE')` false for every `public` `SECURITY
DEFINER` function on both DBs as of 2026-07-19; also confirmed black-box via an
actual unauthenticated `POST /rest/v1/rpc/analytics_sos_by_period` against staging,
which now returns `401` / Postgres `42501 permission denied for function`):
- `20260719160500_phx_revoke_analytics_rpc_overloads_anon_authenticated.sql` — explicit
  `REVOKE ... FROM PUBLIC, anon, authenticated` on the 7 overloads + an idempotent
  sweep over any other anon/authenticated-executable `analytics_*` `SECURITY DEFINER`
  function.
- `20260719170000_phx_harden_public_function_default_execute.sql` — `ALTER DEFAULT
  PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated`,
  intended as root-cause, forward-looking hardening. **Verified only partially
  effective**: a live probe (creating a throwaway function post-hardening) showed a
  newly created function on this project can still inherit the PUBLIC grant depending
  on which role creates it — the DB-level default is role-dependent / best-effort, not
  a hard guarantee. The **reliable** backstop is the CI test
  `tests/migrations-secdef-revoke-guard.test.ts`, which fails the build if a future
  migration creates a `public` `SECURITY DEFINER` function without also revoking
  `PUBLIC` EXECUTE on it.
- `20260719190000_phx_revoke_anon_executable_secdef_triggers.sql` — explicit revokes
  for the two trigger functions + a scoped sweep over any anon/authenticated-executable
  `SECURITY DEFINER` **trigger** function (provably safe to revoke — a trigger never
  needs an EXECUTE grant to fire).

Confirmed via a live schema-exposure probe (unauthenticated `Accept-Profile: <schema>`
requests against the REST endpoint) that PostgREST on this project only exposes
`public` and `graphql_public` — so the `public`-schema sweep above is a complete scan
of the actually-reachable surface for this class of issue; `analytics`/`au`/`internal`/
`private` are confirmed unreachable directly (PostgREST returns `PGRST106 Invalid
schema` for all three).

**Follow-up RESOLVED (2026-07-20):** the concern below (that these five migrations,
applied via direct SQL execution rather than the Supabase `apply_migration` tool,
would have no `supabase_migrations.schema_migrations` rows) was re-checked live
against both staging and production — all five are correctly recorded (matched by
name, where the apply-time version drifted from the filename timestamp, per the
version-drift note further below). The reconciliation path originally cited here
(`supabase migration repair` gated by `scripts/phase33-migration-history-reconciliation-gate.ts`)
does not actually apply to this class of drift: phase33, and the rest of the
phase28-36 pipeline, were retired 2026-07-11 and are hardcoded to a single,
unrelated pre-baseline migration — see docs/migrations.md and docs/scripts.md. The
mechanism actually used was a direct `schema_migrations` query via the Supabase MCP,
comparing by version with a name-based fallback. A permanent, general-purpose
version of this check now runs daily
(`.github/workflows/migration-drift-check.yml`, via the new
`public.phx_ci_migration_versions()` RPC and `scripts/check-migrations-applied.ts`),
so a migration merged to `main` but never actually applied is now caught
automatically instead of depending on a manual audit like this one.

Should not reappear; if a new `anon_security_definer_function_executable` finding
appears for a function NOT covered by the CI guard test (i.e. an existing function
whose grant was manually changed, not a newly created one), it's a regression — the
guard only covers migrations that CREATE a new function, not ALTERs to an existing
one's grants outside a migration.

---

## Performance advisors

### IN PROGRESS — `multiple_permissive_policies` (WARN)
- **`payroll_expenses`, `salary_batches`** — already remediated (stale `{public}` SELECT
  policies dropped 2026-06-15; advisor count fell 7 → 5).
- **`brick_reference_imports`, `brick_reference_rows`, `geo_bricks`, `geo_locations`,
  `geo_trip_routes`** — scheduled for behavior-preserving consolidation (collapse the
  overlapping `authenticated` SELECT policies into one; writes unchanged). Perf-only, not
  a security gap.

### DEFERRED — `unused_index` (INFO ×326)
Reviewed and **deferred** to a dedicated project — not bulk-dropped. `pg_stat_user_indexes`
counters reset on restart and don't observe low-frequency paths (e.g. the daily
birthday / contract-renewal crons scan `idx_employees_birth_date` /
`idx_employees_contract_renewal_date`), so "unused" is not proof of safe-to-drop. When
tackled: confirm true non-use over a longer window, drop in small reversible batches,
keep `CREATE INDEX` rollback SQL.

---

## Operational note — migration-history version drift (not an advisor, tracked here)

Migrations applied via the Supabase **MCP `apply_migration`** tool record their `version`
as the server clock at apply time (`to_char(now(),'YYYYMMDDHH24MISS')`), which differs
from the repo migration **filename** timestamps. As of 2026-06-15, ~11 of the day's
migrations have repo filenames that do not match their recorded
`supabase_migrations.schema_migrations` versions (e.g. repo
`20260615098000_drop_permissive_sales_rls_policies` was recorded as `20260615081252`).

**Do not hand-rename committed migration files to fix this** — the repo has a deliberate,
PITR/approval-gated reconciliation pipeline for exactly this: `supabase migration repair
<version> --status applied`, gated by `scripts/phase33-migration-history-reconciliation-gate.ts`
and the `db:staging:*` / `staging-safe-rebuild` flows. Route any reconciliation through
that pipeline with owner approval and a confirmed backup/PITR window.
