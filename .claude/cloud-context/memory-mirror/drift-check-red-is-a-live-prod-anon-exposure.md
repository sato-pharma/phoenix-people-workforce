---
name: drift-check-red-is-a-live-prod-anon-exposure
description: "Migration Drift Check has been RED since 2026-08-01 for a schema-shape reason, NOT migration drift — 3 ad-hoc backup tables on PRODUCTION are readable AND deletable by the public anon key. FIXED 2026-08-04. A LATER red, 2026-08-11 to 08-23, looked identical but was NOT an exposure — see the 2026-08-23 note at the end."
metadata: 
  node_type: memory
  type: project
  originSessionId: 37238f2a-82ac-4aa6-a1e5-0e5f997e911c
  modified: 2026-08-04T16:23:04.960Z
---

**Do not read a red Migration Drift Check as "a migration is missing."** Since PR #1490 the
workflow also runs a **schema-shape** leg, and that is what is failing — on **production**
(`ozucdzovmcqvepbozvqf`), not staging.

## The finding (verified live 2026-08-02, not taken from the log)

Three ad-hoc backup tables created out-of-band on 2026-08-01 have **RLS disabled, zero policies,
and `anon` + `authenticated` holding SELECT / INSERT / UPDATE / DELETE**:

| table | rows |
| --- | --- |
| `email_templates_backup_20260801` | 1 (`password_setup` template, no static recipient emails) |
| `pv_bak_ai0005_20260801` | 2 |
| `pv_bak_reopen_misfills_20260801` | 5 |

Proved by assuming the role, not by reading grants: `begin; set local role anon;` returns **all 8
rows**. The anon key ships in the browser bundle, so this is internet-readable *and* internet
-writable/deletable. The 7 `pv_*` rows each carry `manager_name`, `manager_hr_id` and
`filled_by_hr_id` — real employee names and HR IDs, plus job title and region. **No salary, no
credentials, no payroll.** Blast radius is small but the tables are also destroyable by anyone.

## The contrast that proves it's an accident

Four other backup tables carry the same anon grant but have **RLS enabled with no policy**
(deny-all) and return **0 rows to anon** — `crm_restamp_backup_20260801`,
`crm_restamp_checkins_backup_20260801`, `geo_locations_brick_centroid_backup_20260728`,
`geo_locations_brick_centroid_backup2_20260728`. The safe pattern is already the norm; these three
missed it. This is also why the check's separate `rls_enabled_without_policy: 63 tables` line is a
WARN, not an error — deny-all is fine.

## Origin and timeline

None of the three names appear **anywhere in the repo** — no migration creates them. Drift check was
green 2026-08-01 01:48 UTC, first failed 11:37 UTC the same day, and has failed every scheduled run
since. Names match manual vacancy-repair work (AI-0005, "reopen misfills") — see
[[new-hire-account-is-empty-until-three-links-are-set]].

**How to apply:** re-running the workflow will NOT clear it. The minimal reversible fix is
`ALTER TABLE ... ENABLE ROW LEVEL SECURITY` on the three (deny-all, matching the other four
backups); dropping them is a separate decision for whoever created them — never drop work you did
not create. **FIXED 2026-08-04:** owner approved; migration `secure_adhoc_backup_tables_enable_rls_20260804`
(via `supabase-production`) enabled RLS with no policy = deny-all on all three. Verified live:
`rls_enabled=true`, and the public anon key now reads **0 rows** on all three (was 8). Tables were
NOT dropped — still someone's backup work; dropping is a separate decision. Reversible via
`ALTER TABLE ... DISABLE ROW LEVEL SECURITY`. The Migration Drift Check's schema-shape leg may now
clear too (not re-run yet).

Related: [[migration-drift-check-was-staging-only]] (the staging-only blindness — a *different*
fault in the same workflow), [[list-migrations-reports-ledger-not-reality]],
[[app-visibility-is-application-scoped-not-rls]].

---

## 2026-08-23 — the check went red again, and it is NOT this. Do not re-panic.

Red every scheduled run **2026-08-11 → 08-23** (13 nights, last green 08-10). Same workflow, same
schema-shape leg, **completely different and non-exposing cause.** Resolved in PR #2328.

**The schema-shape ERROR is `missing_primary_key` on 8 `zz_*` scratch/backup tables on production**
— `zz_area_assign_2026_08_19` (31 rows), `zz_area_options_2026_08_19` (39),
`zz_backup_weekly_ignore_rows_20260815` (470, RLS on), `zz_rollback_ambiguous_codes_2026_08_19` (17),
`zz_rollback_flagged_areas_2026_08_19` (2), `zz_rollback_region_areas_2026_08_19` (18),
`zz_rollback_resolver_2026_08_19` (1), `zz_rollback_unowned_areas_2026_08_19` (31).

**Checked directly, because the 2026-08-01 incident above is exactly what this looks like:** all
eight carry `relacl = {postgres, service_role}` — **no `anon`, no `authenticated`.** The safe
pattern held this time. 7 of the 8 also WARN `rls_disabled`, which is noise given the grants.
**None were dropped or altered** — they are ad-hoc backups and may be the only copy of pre-surgery
state; that decision is the owner's, and was still open when this note was written.

**The migration-drift leg was 29 flags across both refs, and 22 were bookkeeping noise.** Verdicts
came from `pg_class`/`pg_proc`/`pg_index`/`pg_policy`/`pg_attribute`/`pg_default_acl`/`pg_namespace`,
never the ledger. Two drift mechanisms: MCP `apply_migration` recording its own slug, and SQL run
via `execute_sql` leaving objects with **no ledger row at all** (the larger group). 7 were real, all
on staging, all applied 2026-08-23 — staging now reports OK.

**APPLIED TO PRODUCTION 2026-08-23, owner-approved.**
`20260813120000_ci_schema_shape_private_usage.sql` was the one flag deliberately left red rather
than silenced (it is the *detector* for the `private`-schema USAGE gap that made staging RLS tests
vacuous for three weeks — **never** add it to `ACKNOWLEDGED_EXCEPTIONS`). Applied via
`apply_migration` on `ozucdzovmcqvepbozvqf`, recorded as
`20260823122837/20260813120000_ci_schema_shape_private_usage` — the name carries the file version,
so the drift matcher's substring rule finds it.

Verified by `prosrc`, never the ledger: length **4351 to 5470**, md5 **589516e2 to b1092463**,
**byte-for-byte identical to the staging copy** applied from the same file. Calling it returns
`private_schema_usage {anon:false, authenticated:true, service_role:true}` and
`policies_using_private_schema: 67`. ACL unchanged `{postgres=X/postgres, service_role=X/postgres}`,
still `stable` / `security invoker`.

**SCHEMA-SHAPE LEG ALSO CLEARED, same day (PR #2332).** Owner decision: **keep all eight zz_
tables, add the primary keys.** Every column in all 8 is nullable (built by CREATE TABLE AS
SELECT), but each already carried a unique, fully-populated column — verified rows = non-null =
distinct BEFORE any DDL. **Natural keys, never a surrogate identity column:** these tables exist to
be restored via `insert into <target> select * from zz_...`, and an extra leading column silently
breaks that.

Applied to staging first as a rehearsal (clean no-op — staging has ZERO zz_ tables, so the migration
is guarded with `to_regclass` and skips), then production. Result: `tables_without_primary_key`
**8 to 0**, `primary_keys_total` 330 = `tables_total` 330, row counts unchanged
(31/39/470/17/2/18/1/31), ACLs still `{postgres, service_role}`. The check itself now prints
**"OK — schema shape is sound on ozucdzovmcqvepbozvqf (3 warning(s))"**, exit 0.

**Both legs clean.** Of the 3 remaining warnings, one was then closed too: **deny-all RLS enabled
on the 7 zz_ tables that lacked it** (PR #2333) — `zz_backup_weekly_ignore_rows_20260815` already
had it, which is the same tell as 2026-08-01: the safe pattern was the norm and these 7 missed it.
Production now reads **330 tables / 330 with RLS**, and the check prints
"OK ... (2 warning(s))".

**Before enabling it I verified restores would still work, because that is the failure this could
have caused** — these tables exist to be read back. `pg_roles`: `postgres` and `service_role` both
`rolbypassrls = true`; `authenticated` and `anon` both false. `FORCE ROW LEVEL SECURITY` deliberately
NOT set, so the owner stays exempt. Proved by ASSUMING THE ROLES, not by reading grants:
`service_role` read all 8 (31/39/470/17/2/18/1/31); `anon` got `ERROR 42501 permission denied`.

The last warning, `default_acl_supabase_admin_residual` (6 entries), is **not fixable from the
migration runner** — it needs membership in `supabase_admin`. Do not keep re-attempting it.

**Existence was never enough.** For a `create or replace` migration the verdict has to come from
matching `pg_proc.prosrc` against a string only the NEW body contains — that one distinction is what
separated the 22 from the 7. See [[migration-file-written-is-not-migration-applied]].

Related: [[a-cron-that-fails-nightly-can-do-so-forever-unwatched]] (its Telegram alert fired all 13
nights, HTTP 200, and was ignored), [[ad-hoc-backup-tables-are-anon-readable]].
