# Supabase Advisor Baseline — Accepted / By-Design Items

**Project:** Phoenix HR production (`ozucdzovmcqvepbozvqf`)
**Last reviewed:** 2026-09-30 *(previously 2026-09-29, and 2026-07-19 before that)*

This is the single triage reference for `get_advisors` output. Items listed here are
**reviewed and accepted as by-design** (or explicitly deferred). Related context:
[`browser-reachability.md`](./browser-reachability.md),
[`role-alignment-production-readiness.md`](./role-alignment-production-readiness.md),
[`production-blocker-remediation-plan.md`](./production-blocker-remediation-plan.md).

> Anything **not** on this list is a genuine new finding and must be triaged, not assumed benign.

## The page used to say a health check *should* compare against it. Nothing did.

It was last reviewed **2026-07-19**. Re-measured against production on **2026-09-29**:

| Category | This page said | Production actually read |
| --- | --- | --- |
| `rls_enabled_no_policy` | INFO x23 | **176** |
| `unused_index` | INFO x326 | **615** |
| `function_search_path_mutable` | REMEDIATED | **10 functions** |
| `extension_in_public` | *absent from this page* | 1 (`pg_trgm`) |
| `authenticated_security_definer_function_executable` | WARN x14 | 14 - unchanged, correctly accepted |

The third row is the one that matters. This page states below, in its own words, that if
`function_search_path_mutable` reappears **"it's a regression"**. It had reappeared - for ten
functions, none of them the one named - and nobody found out, because the comparison was a
recommendation rather than a job anything ran. **153 tables joined an "accepted" list with
nobody accepting them.**

**That is now mechanical.** `scripts/check-advisor-baseline.ts` reads
`public.phx_ci_advisor_counts()` and fails when a category exceeds the number recorded in
`scripts/advisor-baseline.json`. It runs in the existing daily `migration-drift-check.yml` job,
so it costs no new Actions minutes, and that workflow already posts to the owner's Telegram on
failure.

Three things to know before trusting it:

- **The counts are recomputed in SQL, not read from the advisor** - `get_advisors` is an MCP tool
  and CI has no MCP. The four security categories were validated against a live advisor run on
  2026-09-29 until they matched **exactly**. Two needed a real exclusion to get there: 31 of the
  41 unpinned functions belong to `pg_trgm` and are the extension's, not ours; and the 24-table
  gap on `rls_enabled_no_policy` is exactly `auth` (16) + `storage` (7) + `realtime` (1), which
  are Supabase's to manage. `unused_index` is the one category on **our own** definition - the
  advisor's own output for it runs to ~615 findings, too large to pull routinely - and that
  definition is written out in the migration and repeated below.
- **Production only, deliberately.** These numbers record decisions about *this* database.
  Staging reads `unused_index` **624** and `rls_enabled_no_policy` **161**; gating it there would
  fail nightly on differences nobody acts on, and a check that cries wolf is the one people learn
  to skip. The script refuses to compare when the target ref is not the one the baseline names.
- **Raising a number is a decision, not a fix.** Editing `advisor-baseline.json` to go green
  reproduces exactly the drift above. Change the database, or write down here why the new number
  is right, with the date.

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

### ACCEPTED - `rls_enabled_no_policy` (176 as of 2026-09-29)

RLS is enabled with no policy, so a browser role (`anon` / `authenticated`) is denied all access.
Deny-by-default is the intended posture: these tables are read and written only by the service
role on the server.

**This is the owner's standing decision, not an oversight.** Visibility in this app is
application-scoped - `assertPermission(ctx, resource, action)` on the server is the boundary, and
most code paths use the service-role client. Writing policies for 176 tables on a live payroll
system is not the fix; proving the tables are unreachable is, and that is done separately and
empirically in [`browser-reachability.md`](./browser-reachability.md) (429 tables, `anon` can
SELECT **0** of them, verified over HTTP with the live anon key).

**The table-by-table list that used to live here has been removed on purpose.** It named 24
tables when the count was 23; by 2026-09-29 the count was 176 and the list was worse than
nothing - it looked like an inventory while covering an eighth of the cases, and at least two
names in it (`weekly_distributor_mapping`, `weekly_missing_mappings`) no longer exist. An
allowlist that cannot keep up is one that quietly stops being a guard. The **count** is what is
gated; membership is answered live by `phx_ci_advisor_counts()` and, for the question that
actually matters, by `phx_ci_browser_reachability()`.

> If a table here ever needs RLS-respecting *browser* reads, that is a real change - add a
> scoped policy rather than treating the INFO as noise.

**Known, and deliberately not absorbed (2026-09-30):** production currently reads **177**, one
above this baseline. The extra is `public.hiring_document_definitions_pre_20260930`, a pre-image
table another session created while Phase 4 was in flight. It is not reachable by any browser
role, and it is not this session's to move (`AGENTS.md` section 5: changes you did not create).
**The baseline was NOT raised to 177 to make the check green** - that is precisely the drift this
mechanism exists to stop. The daily check is knowingly red on this one finding until the table's
owner retires it or moves it out of `public`.

### FIXED - `function_search_path_mutable` (0, held at a hard floor)

This section used to read: `public.phx_insert_attendance_raw_punch` was flagged, fixed by pinning
`SET search_path = public, pg_temp`, *"Should not reappear; if it does, it's a regression."*

**It reappeared** - ten functions, none of them the one that was fixed - and went unnoticed for
72 days because nothing compared this page to the database.

**All ten are now pinned** to `public, pg_temp`
(`20260929215727_phase4_schema_hygiene.sql`): `phx_fold_customer_name`,
`phx_squash_customer_name`, `phx_customer_channel`, `phx_custody_item_values_valid`,
`phx_refuse_audit_trail_change`, `ats_whatsapp_screening_questions_immutable_key`,
`hiring_pack_document_field_history_is_append_only`, `market_awareness_touch_updated_at`,
`market_awareness_clear_hold_on_exit`, `v2_freeze_request_code`.

**The baseline is now a hard floor of ZERO, severity `error`** - not "however many exist today".
A single new unpinned function fails the daily check.

Gating the **live count** at zero is deliberately stronger than a check over migration text: it
also catches a function created through `execute_sql`, which is how most of this schema actually
arrived, and is the exact blind spot that let `check:sql-backups` stay green while five pre-image
tables sat in `public`.

*(Severity of what was fixed, recorded honestly: all ten were `SECURITY INVOKER`, so a hijacked
`search_path` ran with the caller's own rights; **zero** `SECURITY DEFINER` functions in `public`
were ever unpinned, and six of the ten returned `trigger`, which PostgREST does not expose as an
RPC. It was a warn, not a breach - and worth closing precisely because the last one was declared
closed and wasn't.)*

*(`pg_trgm` contributes 31 more unpinned functions. Those are the extension's, are excluded from
the count, and are not this project's to fix - see below.)*

### OPEN - `extension_in_public` (1) - and why moving it was REFUSED on 2026-09-30

`pg_trgm` is installed in `public`. Absent from this page before 2026-09-29; never triaged
either way.

The plan for Phase 4 said this was a safe one-liner - `ALTER EXTENSION pg_trgm SET SCHEMA
extensions` - on the grounds that indexes bind to the opclass OID and survive. **The indexes do
survive.** Both trigram indexes on `source_of_sales_customer_map` are present and `indisvalid`.

Measuring the rest is what stopped it. **`public.phx_suggest_direct_order_pharmacies` - the
direct-order pharmacy suggester - carries `search_path=""` and calls `public.similarity(...)`,
schema-qualified.** Move the extension and that call resolves to nothing the next time the
function runs: a live desk flow, failing at call time, in production.

Doing it properly means moving the extension **and** rewriting every qualified reference in that
function in one migration, then calling the function to prove it - `CREATE OR REPLACE` reporting
success proves nothing about a body, as this repo learned twice on 2026-09-29. That is a change
with its own blast radius and it is not a tidying.

**So it stays open, with the coupling written down.** The next session to attempt it starts from
the function, not from the extension.

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

### DEFERRED - `unused_index` (615 as of 2026-09-29, recorded here as 326 until then)

Reviewed and **deferred** - not bulk-dropped. The reasoning has not changed, only the number.

**Our definition, not the advisor's:** an index never scanned since the last stats reset
(`idx_scan = 0`), that is not unique, not a primary key, and does not back a constraint.

**It is not a drop list.** `pg_stat_user_indexes` counters do not observe a low-frequency path -
the daily birthday and contract-renewal crons scan `idx_employees_birth_date` and
`idx_employees_contract_renewal_date`, which both read as unused - so "unused" is not proof of
safe-to-drop.

**And the obvious sanity check does not say what it appears to say.**
`pg_stat_database.stats_reset` on this project is **NULL**. Since PostgreSQL 15 the statistics
file survives a clean shutdown, so NULL means *no reset has ever been recorded* - **not** "reset
just now", and not "the counters are fresh". There is therefore no known window over which these
615 have gone unused, which is exactly why the number is recorded for **growth** rather than
acted on. `phx_ci_advisor_counts()` reports `stats_age_hours` alongside it (`-1` for unknown) so
the figure is never read without that caveat.

When tackled: confirm true non-use over a measured window, drop in small reversible batches, keep
`CREATE INDEX` rollback SQL.

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
