# Supabase Advisor Baseline — Accepted / By-Design Items

**Project:** Phoenix HR production (`ozucdzovmcqvepbozvqf`)
**Last reviewed:** 2026-10-23 *(previously 2026-10-13, 2026-10-09, 2026-09-30, 2026-09-29, and 2026-07-19 before that)*

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
| `extension_in_public` | *absent from this page* | 1 (`pg_trgm`) - **fixed 2026-10-23, now 0** |
| `authenticated_security_definer_function_executable` | WARN x14 | **11** as of 2026-10-08 - correctly accepted, baseline lowered |

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

### ACCEPTED — `authenticated_security_definer_function_executable` (WARN ×11 since 2026-10-08)
The `current_access_*` / `current_phoenix_role` helper functions are `SECURITY DEFINER`
and callable by the `authenticated` role **by design**: they are the primitives RLS
policies call to resolve the caller's identity/scope, so `authenticated` *must* be able
to execute them. Revoking execute or switching to `SECURITY INVOKER` would break RLS.

**Audited per function on 2026-10-08** against live production (`ozucdzovmcqvepbozvqf`).
All 11 are `STABLE`, `sql`, `search_path=public` pinned, owned by `postgres`, with no write
and no dynamic SQL; every one resolves the caller through `auth.uid()` and none reads a row
for a target it was handed. `anon` holds EXECUTE on **none** of them. So the warning is a
statement about who may ask "who am I?", not an exposure of anybody else's data.

**Load-bearing in live RLS — revoking any of these breaks payroll (5):**

| Function (all `public.`) | Live policies | Tables |
| --- | --- | --- |
| `current_access_can_manage_employees()` | 81 | 23 — `automated_payroll_*`, `payroll_copilot_*`, `deductions_*`, `daily_deductions_*`, `sales_records` |
| `current_access_is_hr()` | 4 | 1 |
| `current_access_is_super_admin()` | 4 | 1 |
| `current_access_hr_id()` | 1 | 1 |
| `current_access_is_company_reader()` | 1 | 1 |

**No live production policy references these (6):** `current_access_can_manage_payroll()`,
`current_access_can_see_employee(text,text)`, `current_access_is_finance()`,
`current_access_role()`, `current_access_scope()`, `current_phoenix_role()`. Three of them are
reached only as *nested* callees (`scope` and `current_phoenix_role` from siblings, and the
whole chain bottoms out in `private.phx_current_role()`), and a `SECURITY DEFINER` function
runs its own body as the **owner** — so a nested callee never needs the caller's grant and
these grants are spare rather than load-bearing. 🔴 **That is not on its own a reason to
revoke them.** `current_access_can_see_employee` is called by policies that
`scripts/phase25-staging-rls-mutation-smoke.ts` and `scripts/phase26-*` create `to
authenticated` at smoke time, which is exactly why a `pg_policy` scan reads 0 for it — the
policy DDL lives in a script, not in a migration.

🔴 **RE-EXAMINED 2026-10-13 — 11 IS THE FLOOR, AND THE "SPARE" SIX ARE NOT SPARE.** The question
was put again ("fix the 11 security definer functions authenticated can execute") and answered
against live production: **no revoke ships, for any of the eleven.** Five of the six above are
called **by RPC, as a signed-in `authenticated` user**, by
`scripts/phase24-real-auth-rls-api-smoke.ts` — `current_phoenix_role`, `current_access_role`,
`current_access_scope`, `current_access_is_finance` and `current_access_can_manage_payroll`, each
asserted against that role's expected answer. They are invisible to the obvious search because the
script calls them through a local `rpcValue(client, name)` helper, so **a grep for
`rpc('current_…')` returns nothing and reads as proof of no caller.** The sixth,
`current_access_can_see_employee`, is the one phase25/26 reach through the policies they create.
So a revoke turns the real-auth smokes red, and it closes nothing: all 11 are already
`search_path=public` pinned, `anon` holds EXECUTE on none, and the five load-bearing ones carry 91
live policies between them. The advisor WARN stays **accepted at 11** — the fix for this category
is the audit, written down, not a migration.

🔴 **2026-10-26 — the grant on `current_access_can_see_employee` stays; its BODY was wrong.** The
2026-07-11 body compared `lower(coalesce(employee_hr_id, ''))` with
`lower(coalesce(current_access_hr_id(), ''))`, so a caller with no HR id (no session, or an account
linked to no employee) matched every row with no HR id: called as `authenticated` on staging,
`(null, null)` and `('', '')` both answered **true**. `20261026120400` reads the caller's id once,
treats a blank one as null, requires it on the own-row and manager branches, and wraps the answer
in `coalesce(..., false)`. Staging then answered false for every blank shape and kept own-row and
manager matches for real users; the function's ACL is unchanged, so the count stays 11.
`tests/can-see-employee-blank-id.test.ts` pins the latest definition.

**Why the count fell 14 → 11.** PR
[#5489](https://github.com/Gawish-1997/phoenix-people-workforce/pull/5489), merged **2026-10-08
at 10:14:50 Cairo**. Its migration
`20261008032000_revoke_authenticated_execute_on_unreferenced_access_helpers.sql` takes
`authenticated`'s EXECUTE off three of the fourteen — `current_access_is_admin()`,
`current_access_line()`, `current_access_manager_hr_id()` — keeps `service_role`, and **guards
itself**: it re-asks `has_function_privilege` for each one afterwards and raises if the revoke
did not take, or if `service_role` lost EXECUTE, *"because every server-side read uses that
role"*. No live policy references any of the three, so nothing broke.

🔴 **CORRECTED 2026-10-08, the same day.** The first version of this section credited the
hand-run script `supabase/phoenix-security-definer-execute-lockdown.sql`, which revokes the
same three from `public, anon, authenticated` and was the only thing in the repository that
appeared to explain the fall — and, being a script rather than a migration, it carried the
tidy conclusion that *"the database cannot date the revoke"*. That conclusion was wrong, and
wrong in the direction that stops you looking: a dated, reviewed, guarded migration existed,
in another worktree's branch, merged three hours before the audit ran. **A revoke with no
migration you can find is a reason to look harder at `git log` and the open branches, never a
reason to conclude the change is undateable.** The end state is identical either way; the
provenance is not.

**Related, and NOT what this advisor counts.** 15 of the 20 `private.*` functions still carry
a PUBLIC EXECUTE grant (`=X/postgres` in `proacl`), including `private.phx_current_role()`.
The advisor does not see them because it only looks at `public`. They are not reachable by a
browser role — `anon` has no `USAGE` on schema `private` — and PUBLIC's only extra reach there
is `supabase_etl_admin` / `supabase_read_only_user`, which bypass RLS and can read the tables
directly anyway. PR #5482 narrowed two of them (`phx_visible_hr_ids`, `phx_resigned_hr_ids`)
to named callers; the remaining 15 are consistency, not a hole.

### ACCEPTED (N/A) — `auth_leaked_password_protection` disabled (WARN ×1)
Not applicable. Phoenix uses **application-managed auth** (HR_ID + `bcryptjs` + an
app-signed session cookie verified against `app_auth_users`), **not** Supabase Auth, so
the HaveIBeenPwned check on Supabase Auth passwords governs no real login path.

### ACCEPTED - `rls_enabled_no_policy` (272 as of 2026-10-26; 260 on 2026-10-23; 212 on 2026-10-13; 210 on 2026-10-09; 176 on 2026-09-29)

**Raised 260 to 272 on 2026-10-26 — 7 that joined, and 5 added on purpose by the audit fixes.**
Production read **267** that day. The 7 that joined since 2026-10-23 are all new server-only tables
in `public` with no browser grant: `notification_write_outbox`, `audit_log_outbox`,
`crm_agent_crm_ids_cache`, `phoenix_crm_removed_plans`, `crm_person_by_hr_key_cache`,
`crm_contact_phoenix_truth_cache`, `phoenix_crm_rep_entry_days_cache` (its creating migration never
revoked the browser roles; `20261026120200` now does so explicitly — it held none live). The audit change set then adds 5, each a table moving INTO the
deny-all shape:

| Migration | Count | What |
| --- | --- | --- |
| `20261026120000` | 1 | the automated-payroll resync outbox, a new server-only table |
| `20261026120100` | 3 | the tables of `notification_backup_20261023`: row security switched on, every browser grant revoked, schema revoked |
| `20261026120500` | 1 | `public.deductions_categories`: its `using (true)` read policy dropped and its grants revoked — closed instead of open to every signed-in user |

`20261026120600` refuses to apply if any table with row security on and no policy, any table with
row security off, or any backup-named schema still grants `anon` or `authenticated` anything. The
same three counts read **0 / 0 / 0** on production (read-only) that day, and the guard ran clean on
staging. `scripts/check-migrations.mjs` rule 6 now
refuses a migration that creates a schema without revoking it from both browser roles.

**Raised 212 to 260 on 2026-10-23 — 48 tables, triaged by oid against live production.** The nightly
drift check read 260 against an accepted 212 from mid-October, and it now goes red on that. Of the 48
that joined after `public.database_restarts` (oid 258977):

| Where | Count | What |
| --- | --- | --- |
| `phx_backup_20261017` | 42 | the `testrest_*` and `testwork_*` pre-images of the Phoenix CRM test-data clean-up on 17 October |
| `au` | 3 | `bak_20261015_aif_kfs2_d1_line_area_map`, `bak_20261015b_aif_kfs2_july_line_area_map`, `bak_20261015c_aif_rollup_jul_sep` |
| `public` | 3 | `marketing_pharmacy_direct_order_venues`, `customer_360_pharmacy_matches`, `direct_order_marketing_offsets` — new modules on the server-only pattern |

**Not one of all 260 grants `anon` or `authenticated` anything** (read live the same day), so every one
is deny-all. The 45 in dated schemas leave the count on their own when `audit-backup-schemas.mjs`
retires those schemas at the 90-day line.

**Raised 210 to 212 on 2026-10-13 — two tables, both triaged by name.** The check was failing
`advisor_baseline_exceeded` at 212 against an accepted 210. Asked live, newest by oid, the two that
joined are `public.database_restarts` (oid **258977**) — the restart log written on 12 October, after
the production database instance was hard-restarted three days running — and
`public.address_brick_moves_20261013`
(**258416**), the pre-image of that day's Qena brick moves. Both are this month's live work on the
same server-only pattern.

🔴 **Neither of those two was going to leave by itself, and that is a correction to the 2026-10-09
paragraph below.** The 90-day retention in `scripts/audit-backup-schemas.mjs` swept non-standard
**schemas**, and `public` and `au` are both on its excluded list — so a dated pre-image table
created beside the live data had no schema of its own to age out and could never expire. The 21
snapshots in dated backup schemas do age out; these did not.

**Fixed the same day:** the sweep now has a second pass over dated snapshot **tables** in `public`
and `au`, with the same verdict ladder, the same dependency checks and the same 90 days. It found
**58** of them, 5.5 MB — `public` 34, `au` 24, oldest 47 days, every one a genuine snapshot by name
— a population nothing had ever reported. The 2026-10-09 triage's "2 backup-named tables in
`public`" is not in conflict with that 34: it was splitting the 210 tables *inside this advisor
category*, so it counted only the snapshots that have RLS enabled with no policy, while the sweep
counts every dated snapshot table whether RLS is on it or not. Account:
[`backup-schema-retention.md`](./backup-schema-retention.md), "The snapshot that has no schema at
all". The real fix for one of these is still to put it where
[`backup-table-placement.md`](./backup-table-placement.md) says a snapshot goes.

🔴 **The part worth re-reading is the one that was re-proved, not the two names.** Of the entire
live reading, the only tables that grant a browser role anything are **6 Supabase-managed
`storage.*` platform tables** — and the advisor's set does not contain them: its **212** is the
live **235** minus the **23** `auth`/`storage` tables Supabase manages. So **zero of the 212 grant
`anon` or `authenticated` anything**, and RLS-enabled-with-no-policy is deny-all. Each of these is
a closed table, not an open one — which is why the count is gated and membership is not.

**Raised 176 to 210 on 2026-10-09, after the daily check had been breaching it since 1 October.**
The run list stayed green throughout, **by design**: the advisor step is `continue-on-error` and
the reporting step always exits 0, because a failed suite on `main` HEAD makes Railway withhold
that commit's production deploy (three were lost on 2026-09-30; the account is in
`.github/workflows/migration-drift-check.yml`). **The breach was NOT unseen:** the Telegram alert
fired and was delivered (HTTP 200, checked on the 1, 3 and 8 Oct runs) with the failure streak.
What was missing was the *triage* - nobody updated this page - not the signal (181 on 1 Oct, 185
on 3 Oct, 206 on 8 Oct, 210 on 9 Oct). An earlier version of this paragraph called the breach
"visible only in a run annotation"; that was wrong and is corrected here. This is a triage, not a
padding: the 210 splits as 92 other
`public` tables, 22 `ats_*`, 21 in dated backup schemas, 20 marketing / direct-order, 18 in `au`,
16 `prodplan_*`, 12 CRM / iReports360, 7 `customer_identity_*` / `rep_rank_*`, and 2 backup-named
tables in `public`. All are RLS-on with no policy, none grants anything to `anon` or
`authenticated`, and they follow the same server-only pattern as the rest. **The 23 backup
snapshots leave the count by themselves** as their schemas pass the 90-day retention in
`scripts/audit-backup-schemas.mjs` (the first on 24 November), so the durable part of the raise is
about 187. Group counts are from a live query on 2026-10-09 and are approximate by module prefix;
the **count** is what is gated.

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

**Historical (2026-09-30), now absorbed by the 2026-10-09 triage above:** production then read **177**, one
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

### FIXED - `extension_in_public` (0 since 2026-10-23, held at a floor of zero)

**Moved on 2026-10-23**, by starting from the function as the paragraphs below asked:
`20261023043536_move_pg_trgm_to_extensions_and_pin_scratch_search_path.sql` moves `pg_trgm` to
`extensions` and rewrites `public.phx_suggest_direct_order_pharmacies` from `public.similarity` to
`extensions.similarity` **in the same transaction**, then refuses to commit if either half did not
take. Before writing it, every function body and view on production was scanned for a pg_trgm
function or operator: the suggester was the only one.

Proved on production after applying, not from the migration's success: both trigram indexes on
`source_of_sales_customer_map` read `indisvalid`; the suggester returned **byte-identical** results
(md5 of every row) for two probes measured before the move, one returning 20 rows and one returning 1;
`phx_search_direct_order_customers`, which leans on the code index, still answers; and
`phx_ci_advisor_counts()` reads `extension_in_public` 0. Staging was moved first and checked the
same way.

The same migration pinned `zz_search_proof.run_phase`, a scratch function from a search-speed
proof that the advisor counted as `function_search_path_mutable` (our own count excludes that
schema, which is why the baseline above still read 0). Its body is fully schema-qualified, so the
pin changes nothing it resolves.

*What follows is the 2026-09-30 refusal, kept because it is why the fix took this shape.*

#### Why moving it was REFUSED on 2026-09-30

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

### DEFERRED - `unused_index` (842 accepted as of 2026-10-23; 722 on 2026-10-09, 615 on 2026-09-29, 326 before that)

**Raised 722 to 842 on 2026-10-23.** The nightly reading climbed past 722 from mid-October as the
October modules shipped, and their indexes read as unused until their screens and crons are exercised.
842 is the highest reading seen (the 2026-10-23 drift run; 833 an hour later). Still not a drop list.

Reviewed and **deferred** - not bulk-dropped. The reasoning has not changed, only the number.

**Read 707 on 2026-10-13 and the baseline was deliberately LEFT at 722.** The check asks for the
improvement to be locked in; it is declined on purpose, because this number moves both ways and
every migration that ships a table pushes it back up — lowering the ceiling to the latest dip
would turn the next normal week red for a reason nobody would be able to triage.

**Raised 615 to 722 on 2026-10-09.** The daily check read 576 to 722 between 1 and 9 October (666
on 9 October): the count moves both ways, because indexes on newly shipped tables read as unused
until their screens are opened. 722 is the highest reading seen, so it is a ceiling for noise, not
a target. **A caution from the same review:** `phoenix_crm_touch_trail_session_idx` (31 MB) reads
as never scanned, but the table is only 6 days old and the index backs the Super Admin
touch-trail session view (`.eq("session_id", ...)`), so its zero scans are not evidence it is dead.

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
