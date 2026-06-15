# Supabase Advisor Baseline — Accepted / By-Design Items

**Project:** Phoenix HR production (`ozucdzovmcqvepbozvqf`)
**Last reviewed:** 2026-06-15

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
`weekly_sales_product_scope`, `weekly_sales_rows`.

> If any table here ever needs RLS-respecting *browser* reads, that is a real change —
> add a scoped policy rather than treating the INFO as noise.

### REMEDIATED (not accepted) — `function_search_path_mutable`
`public.phx_insert_attendance_raw_punch` was flagged for a mutable `search_path`.
Fixed by pinning `SET search_path = public, pg_temp` (migration
`pin_attendance_punch_search_path`). Should not reappear; if it does, it's a regression.

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
