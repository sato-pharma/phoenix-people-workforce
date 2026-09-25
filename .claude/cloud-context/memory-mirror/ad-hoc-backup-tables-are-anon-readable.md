---
name: ad-hoc-backup-tables-are-anon-readable
description: "A `create table zz_backup_... as select` leaked production data via the anon key in Aug 2026 — but re-measured 2026-08-28 the default grants no longer include anon: verify, do not assume either way."
metadata: 
  node_type: memory
  type: project
  originSessionId: 41cba3ce-4ee1-42f7-a697-0c8c1cc79936
  modified: 2026-08-28T09:10:00.000Z
---

**RE-MEASURED 2026-08-28 — the causal claim below no longer holds in this project, and believing
it costs you a false alarm.** A fresh `create table public.zz_backup_egpt_merge_20260828 as select`
came out with ACL `postgres=arwdDxtm/postgres | service_role=arwdDxtm/postgres` — **no `anon`, no
`authenticated`, no PUBLIC.** The follow-up `revoke ... from anon, authenticated` was a no-op; there
was nothing to revoke. Checked two independent ways, both agreeing: the raw `pg_class.relacl` for
**all 12** surviving `zz_backup_*` tables shows the same owner+service_role-only ACL, and
`get_advisors(security)` returned **0 ERROR items**, with the seven `zz_backup_*` mentions all
INFO-level `rls_enabled_no_policy`. Five of the twelve have `relrowsecurity = false` and are still
NOT flagged — because with no anon grant, RLS-off is not an exposure. So Supabase's default
privileges for this project's `public` schema no longer grant `anon`/`authenticated` on a new table,
whether that changed during the 2026-08-09 remediation or on the platform side.

**What survives unchanged is the method, not the verdict.** Do not now assume the opposite either —
measure. `select relacl, relrowsecurity from pg_class` on the table you just made, and run
`get_advisors(type: "security")` after any bulk repair. The 2026-08-09 account below is a dated
record of what was true then; it is left exactly as written.

Found 2026-08-09 in a full leak audit; **resolved the same day** — owner said "drop them", all six
dropped from production after a 529-row JSON snapshot was written to
`C:\Users\satoh\Documents\phoenix-db-snapshots\zz_backup_tables_pre_drop_20260809.json` (the only
copy of the pre-repair state). Post-drop: 0 `zz_backup_%` tables, 0 anon-readable unprotected
tables, and `get_advisors(security)` went from 6 ERROR items to 0. The trap below is the durable
part — the exposure itself is closed.

Six `zz_backup_*_20260806` tables (left behind by the
2026-08-06 SoS repair session) sat in production `public` with `relrowsecurity = false` and SELECT
granted to `anon` **and** `authenticated`. Proven by `set local role anon; select count(*)` — 529
rows, incl. **412 distinct pharmacy client names, 254 addresses**, distributor codes, qty and
invoice value. Supabase's `get_advisors(security)` independently flagged exactly these six as its
only ERROR-level items.

**Why:** Supabase's default privileges grant `anon`/`authenticated` SELECT on new public tables, and
`create table ... as select` creates a *new* table — it copies rows, never the source table's RLS or
its policies. The public schema is what PostgREST serves, and `NEXT_PUBLIC_SUPABASE_ANON_KEY` ships
in the browser bundle, so "internal backup" becomes an unauthenticated HTTPS endpoint. The app never
reads these tables, so nothing breaks and nothing alerts — see
[[app-visibility-is-application-scoped-not-rls]] for why app-layer scoping does not cover this.

**How to apply:** Never leave a `create table as select` backup in `public`. Put throwaway backups in
a non-exposed schema, or immediately `revoke select ... from anon, authenticated` +
`alter table ... enable row level security`. After ANY bulk data repair, run
`get_advisors(type: "security")` and treat ERROR-level "RLS Disabled in Public" as a live leak, not a
lint. Do not trust [[list-migrations-reports-ledger-not-reality]] here either — these tables were
created by hand and appear in no migration at all.
