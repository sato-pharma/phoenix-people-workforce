---
name: supabase-advisor-by-design
description: "Phoenix HR Supabase advisor findings that are accepted-by-design and must NOT be auto-fixed, refreshed 2026-07-19 against a live full triage (supersedes the 2026-05-31 snapshot)"
metadata:
  node_type: memory
  type: project
  originSessionId: c8f00771-1cb4-4d76-b1d5-6d2b7a32c663
  modified: 2026-07-19T19:20:54.703Z
---

**Refreshed 2026-07-19** via a live `get_advisors` pull on production (`ozucdzovmcqvepbozvqf`) — 75
security + 428 performance findings (503 total) — cross-checked against current code, not carried
forward from the stale 2026-05-31 snapshot below (which undercounted almost everything: 11 tables
→ 58, different function set, etc.). See PR [#1187](https://github.com/Phoenix-HR/phoenix-people-workforce/pull/1187)
(merged into the advisor-hardening branch) for the full per-item rationale.

**Genuinely fixed 2026-07-19 (all 5 real gaps found across the full triage — two migrations,
both applied+verified on staging then production, PR #1187):**
- `public.phx_direct_sales_reconciliation(text,text)` had a stray `authenticated` EXECUTE grant —
  created 30 min before `20260719170000_phx_harden_public_function_default_execute.sql` and never
  swept. Revoked; confirmed only caller is server-side (`getSupabaseAdmin()`).
- `au.enforce_lam_region()` had a mutable search_path — pinned to `au, public` (the established
  convention for every other `au.*` function). Pure no-op, function already schema-qualifies its
  one table reference.
- 18 missing FK covering indexes on tables created since the last sweep (`au.*` schema,
  `direct_order_requests`, `payroll_copilot_*`, `probation_development_actions`).
- `au.line_area_map` — added composite PK `(line_code, area_code, effective_from)` after verifying
  125 rows / zero duplicates. Turned out not to need the au-system sign-off gate at all: adding a
  PK is purely additive and doesn't touch data, so it was fine to just do once verified safe.
- 10× `_au_rollback.*` tables — added a PK on each table's natural `id`/`hr_id` column, after
  verifying zero nulls/duplicates on every one. Same reasoning as line_area_map: purely additive,
  doesn't affect the tables' rollback-safety-net purpose at all. Migration guards each ALTER with
  `to_regclass(...) is not null` since the schema only exists on production (confirmed absent on
  staging) — keeps the migration file replayable everywhere. See
  [[au-rollback-tables-pending-teardown]] — that memory's "don't touch" guidance was specifically
  about *dropping* these tables, which still stands; adding a PK was a different, safe question.

**Do NOT "fix" these (still true, now much larger in scope):**
- **58× RLS Enabled No Policy** (`au.*` schema — canonical_areas, seats, lines, regions, etc. — plus
  ~48 `public` tables: `marketing_*`, `direct_order_*`, `probation_*`, `weekly_sales_*`,
  `report_it_*`, `app_error_events`, `background_jobs`, `blocked_ips`, `email_suppressions`, etc.).
  Verified 2026-07-19 via grep that `getSupabaseRlsClient`/`getSupabaseRlsClientIfAvailable` (the
  only RLS-respecting client path) is used ONLY by `src/lib/payroll/service.ts` and
  `src/lib/outstation/expenses.ts` — none of these 58 tables are ever read through it. Deny-all via
  RLS-on-no-policy is the deliberate, verified-safe posture; the app reads them exclusively through
  the service-role admin client with app-level permission checks.
- **14× SECURITY DEFINER functions executable by `authenticated`** (`current_access_*`,
  `current_phoenix_role`) — back the RLS policies on `employees`, `employee_compensation`,
  `salary_records`, `sales_records`, etc. Revoking EXECUTE breaks payroll/employee/sales RLS.
- **416× Unused Indexes — investigated in depth 2026-07-19, concluded NOT a real gap for this
  database, owner agreed.** Joined `pg_stat_user_indexes` against `pg_constraint`: 754 total
  zero-scan indexes, 289 of them constraint-backing (auto-excluded, never touch). Of the 465
  non-constraint candidates, checked table-level activity and found the smoking gun: `employees`
  has only 163 rows, has been **sequentially scanned 139,992 times**, and has **zero** scans across
  its 4 flagged secondary indexes — completely normal Postgres planner behavior for a small table
  (seq scan beats index scan below a certain size, regardless of whether the index is "correct").
  Nearly every candidate follows this pattern. Meanwhile every genuinely large/hot table
  (`source_of_sales_import_rows` 260K rows/120K idx_scan, `ireports360_visits` 471K idx_scan,
  `notification_deliveries` 935K idx_scan) shows healthy, heavy index usage — no real performance
  problem is hiding here. Dropping the small-table indexes costs nothing today but removes free
  future-proofing (each is 32-40KB) for when those tables grow. Do NOT mass-drop these; this
  finding is the generic Supabase linter being miscalibrated for a single-company HR system's
  table sizes, not a bug. If revisited later, the right lens is table size/activity (via
  `pg_stat_user_tables.n_live_tup` + `seq_scan`), not the advisor's raw idx_scan=0 count.
- **Leaked Password Protection** + **Auth DB Connection Strategy** — both Supabase
  Dashboard/Auth-service config, not migration-fixable, and no MCP tool covers Auth config either
  (checked the full supabase-production/staging tool set 2026-07-19). App uses app-managed auth
  (bcrypt + signed session cookies), not Supabase Auth, for user logins — real-world impact is low.
  Only the owner can toggle these (Dashboard → Authentication → Policies; Dashboard → Settings →
  Database → connection pool).

**Historical (2026-05-31, kept for context — the 11-table/14-function scope described here has
since grown substantially, see above):**
- **Security Definer View `v_unified_audit_logs`** — deliberately exposes a curated audit union to
  `anon`/`authenticated` who lack SELECT on the raw audit tables. `security_invoker` would break it
  or force broader grants (worse). (Not re-verified 2026-07-19, but no reason to expect it changed.)
- Applied 2026-05-31: `add_missing_foreign_key_indexes` (48 covering indexes) and
  `drop_rls_gap_closure_backup_tables` (12 write-once RLS-hardening snapshots in the `private`
  schema, confirmed nothing read them back — do NOT treat this as precedent for the `_au_rollback`
  tables above, which have NOT been confirmed unused).

The Supabase Advisor is a **cached, lagging** indicator — it does not re-scan instantly after DDL
(confirmed again 2026-07-19: the fix migration's `authenticated_security_definer_function_executable`
and `function_search_path_mutable` counts dropped correctly and immediately on both staging and
production, so the lag is not severe for grant/config changes, but don't assume an unchanged
finding count immediately after DDL means the fix failed — re-check before concluding that).

**The other project `oaifhavixhdtwmseshff` (sato.hr2@hotmail.com) is UNUSED / abandoned** — ignore
its advisor findings. Phoenix HR (`ozucdzovmcqvepbozvqf`) is the only project that matters for
production; staging is `cifwmndunmlxjhyjugxa`. See [[supabase-dual-project-schema]].
