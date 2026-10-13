// The migration inventory that both the drift CHECK and the staging APPLIER read.
//
// It exists so those two can never disagree. check-migrations-applied.ts decides what counts as
// "not applied"; apply-migrations-to-staging.ts has to apply exactly that set and nothing else.
// Two copies of a three-way match rule drift apart the first time either is edited, and the
// failure is silent in the worst direction: the applier skips a file the check keeps flagging, so
// the nightly stays red and the fix reads as broken rather than as missing.
//
// The ACKNOWLEDGED_EXCEPTIONS list below is the sharpest reason for sharing rather than copying.
// It is not cosmetic: re-running 20260717030000_crm_effective_visit_type_view.sql would strip
// `security_invoker = true` back off a live view — a real security regression, not a no-op. An
// applier with its own idea of what is missing would do exactly that, automatically, nightly.
//
// Everything here is PURE — no database, no network, no process.env — so the decision can be
// exercised end to end in tests/staging-migration-applier.test.ts without a connection.
//
// Moved out of check-migrations-applied.ts on 2026-09-04 with sed, not by retyping: the exception
// list and loadLocalMigrations() below are that file's originals, byte for byte.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "supabase", "migrations");
export const FILENAME_RE = /^(\d{14})_(.+)\.sql$/;

// A migration merged less than this long ago might still be mid-rollout (staging
// verification in progress, production apply pending explicit approval per
// AGENTS.md) — only flag genuinely stale drift, not the normal review window.
export const GRACE_WINDOW_MS = 48 * 60 * 60 * 1000;

// Migrations already investigated and confirmed as a one-off, accepted exception —
// add an entry here ONLY after manually verifying the migration's content is truly
// unnecessary to apply (e.g. superseded by a later migration). Do not use this to
// silence a genuine unapplied migration.
//
// All entries below were confirmed 2026-07-20 by direct schema inspection (not just
// schema_migrations bookkeeping) against staging (cifwmndunmlxjhyjugxa): each file's
// intended effect is already live, achieved by a later, differently-named migration
// (mostly from the still-unmerged codex/supabase-deep-audit-fixes branch, PR #1191).
//
// IMPORTANT — do not "fix" the drift below by re-running these files:
//   - 20260717030000_crm_effective_visit_type_view.sql creates
//     public.ireports360_visits_effective WITHOUT `security_invoker = true`. The live
//     view already has security_invoker=true (added by the later migration that
//     superseded this one). Re-applying this file's bare `create or replace view`
//     would silently strip that setting back off — a real security regression, not a
//     no-op. Confirmed via `pg_class.reloptions` on both staging and production.
export const ACKNOWLEDGED_EXCEPTIONS = new Set<string>([
  // Verified: 0 of the 17 named "authenticated read" policies exist on staging or
  // production — closed by 20260719230000_apply_backlogged_m3_sales_ops_rls_closure.
  "20260712010000_revoke_blanket_authenticated_read_sales_reference.sql",
  // Verified: both partial indexes exist on staging and production — created by
  // 20260719240000_apply_backlogged_ireports360_fixes.
  "20260714000000_ireports360_visits_unmapped_partial_indexes.sql",
  // Verified: public.ireports360_visits_effective exists WITH security_invoker=true
  // on staging and production — see the do-not-reapply warning above.
  "20260717030000_crm_effective_visit_type_view.sql",
  // Verified: all 4 core tables (direct_order_pharmacies/_requests/_approval_steps/
  // _events) exist on staging; production's schema_migrations records this under a
  // drifted name (the full timestamped filename recorded as the `name` field).
  "20260718140000_direct_orders_module_foundation.sql",
  // Verified via schema_migrations presence under a drifted name on both projects
  // (recorded by Supabase MCP apply_migration, which executes before recording, so a
  // recorded row is strong evidence the SQL genuinely ran).
  "20260719120000_direct_orders_caps_discount_distcodes.sql",
  "20260719140000_au_direct_area_attribution.sql",
  "20260719141000_direct_orders_sos_injection.sql",
  "20260719150000_marketing_track_direct_sales_column.sql",
  "20260719151000_marketing_roi_actuals_v2_direct_branch.sql",
  "20260719152000_marketing_roi_refresh_facts_direct_branch.sql",
  "20260719163000_direct_sales_reconciliation.sql",
  // Verified: staging's au.regions/au.lines/au.canonical_areas/au.seats/au.line_area_map
  // row counts (9/3/42/132/126) exactly match this file's seed content — the data was
  // already loaded via the ad-hoc tooling this file's own header describes, before this
  // migration formalized it for production.
  "20260713040000_au_seed_reference_data.sql",
  // Owner decision 2026-07-20 (not a "superseded" case like the rest of this list):
  // these two GATED, one-time PRODUCTION cutover scripts deliberately were not run
  // against staging. Staging's public.areas already shows an equivalent end state (50
  // active areas) via the ad-hoc tooling referenced above, but staging's employee data
  // isn't production's real lifecycle data, so the occupancy-reconcile step (backdating
  // effective_from to each occupant's real hire date) was judged not meaningful there.
  // Revisit only if staging's employee dataset is ever made production-representative.
  "20260718120000_au_public_areas_cutover_phase9.sql",
  "20260718130000_au_occupancy_reconcile_from_master_phase9.sql",
  // ── Added 2026-07-30, when this check was first pointed at PRODUCTION (see the
  // production leg in .github/workflows/migration-drift-check.yml). Each was verified
  // against production by direct schema inspection, not schema_migrations bookkeeping.
  //
  // Superseded by 20260724080655_ats_replatform_phase1, which renamed the whole domain
  // recruitment_* -> ats_*. Verified on production: public.ats_candidate_cv_extractions
  // exists, ats_candidates.position_specific_fields and
  // ats_candidate_cv_extractions.position_key both exist, and 71 candidates were created
  // in the 14 days to 2026-07-30. Re-running these files would recreate the pre-rename
  // recruitment_* tables as dead duplicates.
  "20260723175328_recruitment_candidate_cv_extraction.sql",
  "20260723201106_recruitment_position_schema_framework.sql",
  // Verified: the `recruitment-files` storage bucket exists on production.
  "20260723181334_recruitment_files_storage_bucket_staging_parity.sql",
  // Verified: production's public.ireports360_visits_effective already has the
  // effective_visit_type/reclassified_no_checkin columns AND security_invoker=true. This
  // file's own header says so — it was applied 2026-07-27 under the name
  // reconcile_visits_effective_view_vstar and exists only to make the definition
  // reproducible on a fresh reset.
  "20260728000000_refresh_visits_effective_view.sql",
  // ── Added 2026-08-05, after this check had been failing on every scheduled run for days and
  // nobody was reading it. Each was verified by direct schema inspection on the target project,
  // never from schema_migrations. Five SIBLING files flagged in the same run were NOT listed —
  // they were genuinely missing and have been applied to staging instead (revoke_anon_on_crm_
  // visits_effective, outstation_expenses_approved_amount, app_auth_biometric_credentials,
  // automated_payroll_part2_non_employees_and_manual_expenses).
  //
  // Applied on BOTH projects, recorded under a drifted version (the MCP apply_migration clock,
  // not the filename). Verified live on production AND staging: au.f_monthly_achievement carries
  // the Direct fix — two `is not distinct from k.area_code` joins, with the lam join deliberately
  // left as strict `=` exactly as this file specifies, and anon/authenticated revoked with
  // service_role granted.
  "20260801150100_au_direct_counts_toward_achievement.sql",
  // Applied 2026-08-12 to production AND staging via MCP apply_migration, which stamps its own
  // clock — production recorded it as version 20260812130058, so the filename below will never
  // match the ledger. Verified live on production by direct inspection of pg_proc, not by
  // schema_migrations: `where a.channel` is gone from au.f_monthly_achievement's body, both
  // line_code rejoins read `is not distinct from`, has_actual comes off coalesce(ac.matched,
  // false), SECURITY DEFINER and search_path=au,public survive, and service_role has execute
  // while anon/authenticated do not. phx_sales_vs_target_range then reconciled to
  // phx_monthly_attribution at 0.00 variance on all three lines for 2026-07.
  "20260812150000_au_achievement_counts_unmapped_sales.sql",
  // ── Direct Orders family basket, applied to PRODUCTION 2026-08-12 via scripts/apply-sql-file.mjs,
  // which does not write to schema_migrations at all — so neither file will ever match the ledger.
  //
  // Verified live on production by direct inspection, never from schema_migrations. Before the
  // apply: direct_order_request_items absent, direct_order_requests.family_code absent,
  // phx_direct_order_item_family_guard absent. After: 32 requests, 32 items, 0 requests without a
  // line, 0 requests whose lines fail to sum to their own sales_value, 0 with a null family_code,
  // 0 turned into multi-line requests by the backfill, the guard trigger present, RLS on, and
  // pg_get_functiondef(phx_rebuild_direct_order_sos_batch) containing direct_order_request_items —
  // which is the only proof that the PER-ITEM injection is what is actually live.
  //
  // Both files were renamed TWICE on the day, chasing the expense_claims phases as they landed on
  // main: written as 20260812160000/160100 and applied to STAGING under those names, moved to
  // 20260812170000/170100 and applied to PRODUCTION under THOSE, then moved to the minute-precise
  // slots below, off the round-hour cadence that sequence walks.
  //
  // The SQL never changed through any of it, and that is checked rather than asserted: on
  // 2026-08-12 the live objects were fingerprinted on both projects and the rebuild RPC, the family
  // guard and the items table's column shape all md5-match between staging and production.
  //
  // NEITHER ledger has a row for these under any name — apply-sql-file.mjs does not write
  // schema_migrations at all. An earlier version of this comment claimed staging recorded the old
  // timestamps; it does not, and staging was surveyed to establish that rather than reasoned about.
  // This set is global, so listing them here covers both legs of the drift check, which is the
  // whole reason it is the right home for a script-applied migration.
  "20260812184500_direct_orders_request_items.sql",
  "20260812184600_direct_orders_sos_injection_per_item.sql",
  // ── Applied to STAGING 2026-08-12 to close a real gap, again via apply-sql-file.mjs, so again no
  // ledger row. Production already had both — checked before applying, which is what made it safe:
  // hold_release_ground, duplicate_of_request_id and merged_into_pharmacy_id all present there, with
  // the direct_orders registry row intact.
  //
  // WHAT THIS UNCOVERED, and it is the more important half. duplicate_cleanup refused to commit on
  // staging with "action cancel_duplicate -> undeclared target 'cancelled'" — its own guard against
  // the 2026-08-05 outage shape, where an action pointing at an undeclared status makes the loader
  // skip the WHOLE module. The cause: staging's ledger CLAIMS 20260805150000_direct_orders_cancel_held
  // is applied while its effect is absent — no `cancelled` status, no `cancel_held` action. A row
  // that says "applied" for a migration that did not take is worse than a missing row, because this
  // very check reads it as green and never lists the file. It has been quietly green on it for a
  // week. Consistent with the pre-data-only restore described in migration-drift-check.yml's header:
  // registry rows are DATA, so a schema-only restore keeps the ledger and loses the content.
  //
  // Re-applied 20260805150000 (both its registry updates are `not exists`-guarded, so idempotent),
  // then duplicate_cleanup committed. Staging's direct_orders registry now matches production
  // exactly: the same 9 statuses and the same 16 actions, no undeclared targets on either.
  "20260808214500_direct_orders_release_held.sql",
  "20260809031500_direct_orders_duplicate_cleanup.sql",
  // ── Applied to STAGING and PRODUCTION 2026-08-12/13 via apply-sql-file.mjs, so no ledger row on
  // either. This is the migration that makes PHOENIX_EXPENSE_CLAIMS_READ safe to turn on: before it,
  // expense_claims had RLS with one policy (service_role) and no grant to `authenticated`, and
  // turning the flag on took /api/admin/outstation/expenses down for ~3.5 hours with a 42501.
  //
  // Verified on production by direct inspection AND by exercising the real RLS machinery, which
  // staging cannot do (it lacks USAGE on schema `private`, so helper calls raise 42501 before any
  // policy is reached — a separate gap, and the reason every staging RLS test is currently vacuous).
  // Before: rls on, authenticated select/insert/update/delete all false, one policy. After: the same
  // 375 rows, select true, insert/update/delete still false, two policies.
  //
  // Then, as `authenticated` for 15 real users: all 15 see rows through the new policy (1 to 62
  // claims each), and for every one of them every legacy row they can see is still reachable as a
  // claim they can see. The lower per-user counts against the raw legacy union are the dedup —
  // 375 claims vs 360+39 legacy rows, a difference of exactly the 24 rows carrying both legacy ids.
  //
  // The flag remains false. Applying this does not enable anything; it only removes the reason the
  // flag was unsafe.
  "20260812213000_expense_claims_select_rls.sql",
  // Applied: verified 0 tables matching `email_backfill_backup%` remain on staging, which is this
  // file's own end state.
  "20260801100000_drop_email_backfill_backup.sql",
  // Not applicable: this hardens the very table that 20260801100000 (above) DROPS. With the table
  // gone from staging there is nothing to enable RLS on, and re-running it would fail rather than
  // protect anything.
  "20260801090000_secure_email_backfill_backup_rls.sql",
  // Not applicable: self-guarding by design — it loops over crm_restamp_backup_20260801 /
  // crm_restamp_checkins_backup_20260801 and no-ops via to_regclass when absent. Verified 0 of
  // those tables exist on staging, so the file is already a no-op there.
  "20260801110000_secure_crm_restamp_backups_rls.sql",
  // Not applicable: production-only guarded data remediation for 5 named vacancy ids whose exact
  // phantom-filled state existed only on production. The file's own header states it is "a safe
  // no-op on staging / any environment where the state differs" — the UPDATE matches on both id
  // and the specific wrong filler, so nothing on staging can match.
  "20260801160000_reopen_cross_area_misfill_vacancies.sql",
  // ── The two below are blocked by a STRUCTURAL gap, not a missed apply: staging has NO
  // deductions module at all. Verified: 0 tables matching `deductions_%` on staging, against a
  // production module that is fully present. Revisit both if staging ever gains the module.
  //
  // Pins search_path on three deductions trigger functions. Verified 0 of the 3 exist on staging
  // (deductions_candidates_guard_locked, deductions_decisions_touch_updated_at,
  // deductions_publication_lines_guard_day_overlap), so there is nothing to pin.
  "20260801140000_deductions_module_pin_trigger_search_path.sql",
  // Adds a column to public.deductions_decisions. Confirmed by attempting the apply on staging
  // 2026-08-05: Postgres refused with 42P01 relation "public.deductions_decisions" does not exist.
  "20260802094500_deductions_decisions_applied_dates.sql",
  // RESOLVED 2026-08-05 — 20260725180000_analytics_dim_products_exclude_head_office.sql is
  // APPLIED. It needs no entry in this list: it is genuinely applied AND recorded in
  // schema_migrations under its own version, so the check matches it and passes.
  //
  // Kept as a record rather than deleted, because the history is the point. This was the one
  // REAL production drift this check ever found — caught by its first production run on
  // 2026-07-30, 110h after merge, applied to staging and never to production. It was
  // deliberately left FAILING here for six days rather than silenced, because failing was the
  // only thing that would keep it visible until an owner approved the apply.
  //
  // Verified live on production 2026-08-05, by reading the view rather than the ledger:
  // pg_get_viewdef('analytics.dim_products') now carries the line exclusion character-for-
  // character as this migration writes it, and the boundary holds — 0 Head-Office-line rows and
  // 0 restricted product codes visible through dim_products (22 products), against 26 in the
  // CEO/Super-Admin dim_products_all. The four-row gap is exactly the confidential set.
  //
  // A caution for whoever checks this next: `position('head office' in viewdef) > 0` is NOT a
  // sufficient test — it answered "excluded" while a second query still counted a product that
  // would disappear, because that one read the SOURCE table. Only reading the full view
  // definition settled it. Do not re-open this on the strength of a substring match.

  // ── Added 2026-08-23, after this workflow had been red on EVERY scheduled run since
  // 2026-08-11 — 13 consecutive days, last green 2026-08-10. Run 32626124071 flagged 15 files on
  // production and 14 on staging (29 flag-instances, 24 distinct files).
  //
  // Every one was judged by querying pg_catalog directly — pg_class, pg_proc, pg_index,
  // pg_policy, pg_attribute, pg_default_acl, pg_namespace — never from schema_migrations. For a
  // `create or replace` file, EXISTENCE IS NOT ENOUGH: the function's pg_proc.prosrc was matched
  // against a string only the new body contains. That is the single check that separated the 19
  // files below from the 6 that turned out to be genuinely missing on staging (applied 2026-08-23
  // and now recorded, so they need no entry here) and the 1 then still missing on production
  // (applied the same day once the owner approved it — see RESOLVED below).
  //
  // RESOLVED 2026-08-23 — 20260813120000_ci_schema_shape_private_usage.sql is APPLIED ON
  // PRODUCTION, and needs no entry in this list. apply_migration recorded it as
  // 20260823122837/20260813120000_ci_schema_shape_private_usage; that name contains the file's
  // version, so the substring rule above matches it and the check passes on its own merits.
  //
  // Kept as a record, because the six hours it spent failing are the point. It is the DETECTOR
  // for the `private`-schema USAGE gap that made every staging RLS test vacuous for three weeks,
  // so an entry here would have been the exact mistake this list must never make. It was left
  // red rather than silenced until an owner approved the production apply (AGENTS.md §6).
  //
  // Verified on production by prosrc, not by the ledger: length 4351 -> 5470, md5 589516e2... ->
  // b1092463..., BYTE-FOR-BYTE IDENTICAL to the staging copy applied from the same file, with
  // both `private_schema_usage` and `policies_using_private_schema` present. Calling it returns
  // private_schema_usage {anon:false, authenticated:true, service_role:true} and
  // policies_using_private_schema: 67 — the alarm now measures the gap it was written for.
  // proacl unchanged at {postgres=X/postgres, service_role=X/postgres}; still stable, still
  // security invoker.
  //
  // A caution for whoever reads this next: the SCHEMA-SHAPE leg of the same workflow is still
  // red on production, and nothing in THIS file can clear it. That is missing_primary_key
  // (severity "error" in check-schema-shape.ts) on 8 zz_* ad-hoc backup tables. All 8 hold
  // relacl {postgres, service_role} — no anon, no authenticated — so it is not a repeat of the
  // 2026-08-01 anon-exposure incident; they are someone's pre-surgery state and dropping them is
  // an owner decision. Do not read "drift check red" as "a migration is missing".
  //
  // TWO MECHANISMS produced all 19, and neither is a fault in this check:
  //   1. Applied via MCP apply_migration under a slug that is not the filename's slug. The
  //      matcher tries version, slug, and version-as-substring; all three miss when the recorded
  //      name is `early_birds_module_tables` and the file's slug is `early_birds_module`.
  //   2. Run outside the ledger entirely, through execute_sql or a script — objects in
  //      pg_catalog, no schema_migrations row at all, not even a drifted one. This is the larger
  //      group. Established by searching every recorded statement body for each migration's
  //      distinctive text; reliable here because only 3 of the 85 ledger rows in the window have
  //      an empty `statements` array, and all three are unrelated files.
  //
  // The durable fix for (2) is to stop hand-running DDL and use apply_migration with the repo
  // filename as the name — then version drift still happens but the substring match catches it.

  // Applied on PRODUCTION, recorded as TWO drifted rows: 20260808212342/early_birds_module_tables
  // and 20260808212424/early_birds_module_rpcs, neither equal to this file's slug
  // `early_birds_module`. Verified: all 6 tables present (early_birds_period_snapshots,
  // _candidates, _decisions, _winners, _national_winners, _audit), function
  // early_birds_candidates_guard_frozen() present, and its trigger
  // early_birds_candidates_guard_frozen_trg live on early_birds_candidates.
  "20260808234500_early_birds_module.sql",
  // Applied on PRODUCTION. This file's ENTIRE effect is an ACL revoke, so pg_proc.proacl is the
  // whole proof: phx_unlock_monthly_closing(text,text,text,text) and
  // phx_reject_write_to_locked_closing() both read {postgres=X/postgres, service_role=X/postgres}
  // — no `=X` PUBLIC entry, no anon, no authenticated. Ledger row 20260809231535 /
  // monthly_closing_lock carries the statements.
  "20260810150000_monthly_closing_lock_revoke_anon_execute.sql",
  // Applied on PRODUCTION outside the ledger. Verified: table pg_stat_statements_snapshots
  // present, views v_slow_query_deltas and v_db_health both present (pg_class.relkind='v'), and
  // function phx_capture_query_stats(p_top integer) present with proacl
  // {postgres=X, service_role=X} exactly as the file writes it.
  "20260811000500_pg_health_query_observability.sql",
  // Applied on PRODUCTION outside the ledger. Verified: phx_ci_stale_snapshot_schemas(
  // p_max_age_days integer) present with proacl {postgres=X, service_role=X}.
  "20260811000600_pg_health_snapshot_expiry_gate.sql",
  // Applied on PRODUCTION outside the ledger. Both halves verified on pg_class:
  // relrowsecurity = true on direct_order_pharmacy_validations, and relacl =
  // {postgres=arwdDxtm, service_role=arwdDxtm} — anon and authenticated already revoked, which
  // is this file's other statement.
  "20260812090000_direct_order_pharmacy_validations_rls.sql",
  // Applied on PRODUCTION outside the ledger. Both of the file's two targets carry
  // service_role=arwdDxtm in pg_class.relacl: direct_order_pharmacy_validations and
  // monthly_closing_locks.
  "20260812100000_service_role_table_grants_parity.sql",
  // Applied on PRODUCTION outside the ledger. Verified on pg_default_acl: grantor postgres,
  // schema public, defaclobjtype 'r' reads {postgres=arwdDxtm, service_role=arwdDxtm}.
  "20260812100100_public_default_privileges_grant_service_role.sql",
  // Applied on BOTH projects outside the ledger. A data migration, so the proof is the data:
  // workflow_registry_modules for module_key='direct_orders' contains both declared statuses,
  // `held` and `expired`. Confirmed separately on production and on staging.
  "20260812135000_direct_orders_declare_held_expired_statuses.sql",
  // Applied on BOTH projects outside the ledger. Same registry row contains the action
  // `repair_approval_rung`. Confirmed separately on production and on staging.
  "20260812140000_direct_orders_repair_approval_rung.sql",
  // Applied on PRODUCTION outside the ledger — the ledger has expense_claims phases 0, 2, 3 and
  // 4 but no phase 1. Verified by the data this file exists to produce: 375 rows in
  // expense_claims, ZERO of them lacking both legacy_request_id and legacy_expense_id, and 2 rows
  // in expense_imports. An unrun backfill leaves the table empty.
  //
  // DO NOT RE-RUN THIS FILE ANYWHERE. It opens by deleting expense_claim_events,
  // expense_payroll_links, expense_claims and expense_imports, then rebuilds them. Its own guard
  // ("Refusing to backfill: % claim(s) have no legacy link") only trips once writes have cut over
  // and native claims exist — with zero native claims it does NOT stop, so the guard is no
  // protection against a well-meaning catch-up apply. Listing it here is what keeps that apply
  // from ever looking necessary.
  "20260812160100_expense_claims_phase1_backfill.sql",
  // NOT APPLICABLE on production, by the file's own design — its header states "SELF-NO-OP ON
  // PRODUCTION AND ON A REBUILD. Everything is gated on GZ8/GZ9 existing and UE9 not." Verified
  // that gate is false: au.canonical_areas holds no GZ8 and no GZ9, and source_of_sales_areas
  // already reads GZ6 = Fayoum, UE9 = Beni Suef. There is nothing for it to do and it was never
  // going to record.
  "20260813090000_converge_staging_gz8_gz9_to_gz6_ue9.sql",
  // NOT APPLICABLE now: the effect landed first, by hand. weekly_sales_branch_region_map holds
  // exactly the counts this file writes — 11 rows on GZ6, 18 on UE9 — but stamped
  // updated_by='claude-brick-fill-2026-08-12' / 'chatgpt_branch_area_import_2026-08-12', never
  // 'weekly_fayoum_beni_suef_area_seed'. Both special-cased rows (PS/الفيوم/sales and
  // PS/بني سويف/sales) already carry region_code='GZ', region_name='Giza' — the corrected values
  // this file would set, not the stale 'UE'/'AB' its header describes. Its UPDATEs are gated
  // `where area_code is null`, so re-running now touches 0 rows.
  "20260813130000_weekly_fayoum_beni_suef_area_seed.sql",
  // Applied on PRODUCTION outside the ledger; applied to STAGING 2026-08-23 (it was genuinely
  // absent there — no function of that name in ANY schema — and is now recorded, so this entry
  // covers the production leg). Verified on production:
  // phx_direct_order_pharmacy_normalized_names(p_ids uuid[]) present with proacl
  // {postgres=X, service_role=X}.
  "20260813180000_direct_order_pharmacy_normalized_names.sql",
  // Applied on BOTH projects outside the ledger. Verified on each: index
  // sos_customer_directory_rollup_area_period_idx present on
  // source_of_sales_customer_directory_rollup. It was never going to appear in the ledger on
  // production — the file's own header says production receives this as a hand-run CREATE INDEX
  // CONCURRENTLY, to avoid the write lock a plain build would take.
  "20260816070000_territory_area_pharmacies_area_index.sql",

  // ── The five below were flagged on STAGING only; production already matched them by name.
  // Applied on staging, verified by pg_catalog there.
  //
  // Applied under a drifted name. phx_decide_marketing_request_step(...)'s prosrc contains the
  // guard string `marketing_self_approval_refused`, so the refusal is live. Carried by ledger row
  // 20260813030305 / marketing_reject_terminalises_chain — a later migration that replaced the
  // same function and preserved the guard.
  "20260813170000_marketing_refuse_self_approval.sql",
  // Applied under a drifted name (ledger row 20260814024026 /
  // closing_channel_breakdown_reuse_rollup). Verified: table
  // source_of_sales_channel_customer_rollup present with its
  // source_of_sales_channel_customer_rollup_service_role_all policy in pg_policy, plus functions
  // phx_refresh_sos_channel_rollup(uuid) and phx_closing_channel_totals(7 args).
  "20260814130000_closing_channel_customer_rollup.sql",
  // Applied under drifted names — three ledger rows carry it, including 20260815140406 /
  // proto_dp_rollup_table_and_refresh. Verified: table
  // source_of_sales_distributor_product_rollup present with its service-role policy, plus
  // phx_refresh_sos_distributor_product_rollup(uuid) and
  // phx_closing_distributor_product(text,text), both parallel safe.
  "20260815160000_closing_distributor_product_rollup.sql",
  // Applied outside the ledger. All three of the file's effects verified independently:
  // marketing_pharmacy_code_references.source_row is `bigint` in pg_attribute (the whole point of
  // section 1 — the map id passed 736,844 and integer would overflow), view
  // phx_v_sales_pharmacy_code_candidates exists, and function
  // phx_sync_sales_pharmacy_codes_into_marketing() exists.
  "20260819210000_marketing_sales_code_sync_is_additive.sql",
  // Applied outside the ledger. This one replaces the function the file above creates, so
  // existence proves nothing and the BODY is the evidence: prosrc contains
  // `references_retained_linked`, the variable introduced by this file's third retirement
  // condition — the condition that stops the sync deleting the 2,671 codes the owner's EPDA and
  // Ibn Sina vendor merges produced.
  "20260819220000_sync_retirement_must_not_undo_a_vendor_merge.sql",
  // ── Applied to PRODUCTION and STAGING 2026-08-28 via MCP apply_migration, which stamps its own
  // UTC clock rather than the filename — production recorded them as versions 20260828040959 and
  // 20260828041322, so neither filename below will ever match either ledger.
  //
  // Applied BEFORE the code that writes them, deliberately and in this order: the sync-run
  // `.update()` is what marks a run "success", so shipping code that writes
  // blocked_pre_hire_attributions to a database without the column would make every sync report
  // FAILED while having written its rows perfectly correctly.
  //
  // Verified live on production by direct catalog inspection, never from schema_migrations.
  // The column: pg_attribute shows blocked_pre_hire_attributions as integer, attnotnull true,
  // default 0, comment attached, sitting beside its blocked_post_exit_attributions counterpart —
  // and 3 sync runs in the following 15 minutes all succeeded with it defaulting cleanly, proving
  // the then-deployed code (which does not know the column exists) was unaffected.
  // The table: pg_class shows ireports360_parity_windows with relrowsecurity true, 9 columns,
  // primary key window_from, 1 policy, 2 indexes, service_role INSERT true, and both anon and
  // authenticated SELECT false. PostgREST's schema cache was then confirmed to have picked it up,
  // because a table the app still cannot see would leave the nightly sweep silently inert.
  "20260828100000_crm_pre_hire_attribution_counter.sql",
  "20260828101000_crm_parity_windows.sql",
  // ── Added 2026-08-30, after this check had been red on every scheduled run since 2026-08-24.
  // Run 33312264542 flagged these two files, and ONLY these two, on BOTH projects. Each was
  // judged by querying pg_catalog directly — pg_proc and the au/public tables themselves — never
  // from schema_migrations, and each is applied on production AND staging.
  //
  // Both are mechanism 1 from the note above: applied via MCP apply_migration under a slug that
  // is not the filename's slug, so version, name and version-as-substring all miss.
  //
  // Recorded on production as TWO rows, 20260826181406
  // direct_orders_carry_area_and_brick_part1_direct_feed and 20260826181449
  // ..._part2_channel_breakdown — the file was applied in its two halves, and neither recorded
  // name equals the file's slug, which is why the exact-match on `name` does not save it.
  //
  // For a `create or replace` file EXISTENCE IS NOT ENOUGH, so the evidence is the shape and the
  // body, on both projects: phx_monthly_closing_direct's return type reads
  // TABLE(region_code text, area_code text, product_code text, sales_units numeric, sales_value
  // numeric) — area_code is the column this migration adds, and it cannot appear without the
  // drop-and-recreate this file performs, because CREATE OR REPLACE cannot alter a return type.
  // phx_closing_channel_breakdown's prosrc carries the '2026-08' period floor, which is the
  // load-bearing half: without it July's manually-placed areas would shrink the '__DIRECT__'
  // bucket and break a published, LOCKED closing.
  "20260826213000_direct_orders_carry_area_and_brick.sql",
  // Applied to production 2026-08-28 outside the ledger — the file's own header says so and calls
  // itself "the record of what was run", which is why every statement in it is idempotent. The
  // nearest ledger row, 20260829084033 anti_infective_delta_3_from_september, is the SEPARATE
  // later migration that dates the territory move; it is not this file under another name.
  //
  // Verified live on production AND staging by counting the objects this file creates, not by the
  // ledger: au.regions has 1 row for 'D3', public.source_of_sales_regions 1, public.areas 1 for
  // 'delta_3', and au.seats holds 5 anti_infective seats on region D3 — the DM chair plus its
  // four rep chairs, exactly the vacant placeholder this file opens.
  //
  // DO NOT "fix" this by re-applying or re-dating anything. The Delta (3) move is live and dated
  // 2026-09-01, the August closing must never contain Delta (3) whenever it is published, and
  // that date is the mechanism rather than a problem to solve (AGENTS.md §4).
  "20260828064500_anti_infective_delta_3_district.sql",
  // ── Added 2026-08-31, after SIX consecutive nightly failures on the staging leg (2026-08-26
  // through 08-31). Both files are the Delta (3) siblings of the entry directly above.
  //
  // Production's ledger records both under the MCP apply_migration clock — 20260829083742
  // au_line_area_map_history_view and 20260829084033 anti_infective_delta_3_from_september — so
  // the production leg matches by NAME and is green. Staging's ledger records NEITHER, under any
  // version or name, while both effects are fully live there. Verified 2026-08-31 by direct
  // inspection on BOTH projects, never from schema_migrations:
  //   - public.au_v_line_area_map_all exists with all 13 columns on staging AND production, and
  //     carries this file's exact grants — anon and authenticated SELECT both false,
  //     service_role true. (Checked explicitly because re-applying a bare `create or replace
  //     view` is precisely what silently stripped a security setting earlier in this list.)
  //   - All 5 Delta (3) rows exist on anti_infective from 2026-09-01 with dm_seat_id
  //     SEAT-AIF-DM-D3, and the 5 pre-split rows are closed at that same date, on both projects.
  //   - The August golden rule holds on both: au.f_line_area_map_asof('2026-08-31') resolves 0 of
  //     the five areas to D3, and '2026-09-30' resolves all 5. On production, cns and pedia still
  //     resolve 0 to D3 — the move is anti-infective only (AGENTS.md §4).
  //
  // Nothing is left to apply. The delta_3 file is idempotent and self-guarding — it returns early
  // when the 5 rows are already present and RAISES rather than guess if it finds a half-applied
  // state — so this is a bookkeeping gap in staging's ledger, not missing schema. Do not "repair"
  // it by re-running either file, and do not re-date anything.
  "20260829113000_au_line_area_map_history_view.sql",
  "20260829113500_anti_infective_delta_3_from_september.sql",
  // ── Added 2026-09-05, after this file's staging leg failed with "function
  // ...already exists with same argument types". Applied via MCP apply_migration to BOTH
  // projects ahead of the app-code deploy (drop+recreate of phx_weekly_plan_next_status and
  // phx_weekly_plan_decide with a new bypassCeo parameter needed to land before the new 9-arg
  // RPC call could work at all), then again for the follow-up revoke-PUBLIC-execute fix
  // (commit 07464cfd) — both recorded under the MCP apply_migration clock, not this file's own
  // version, so this file reads as "missing" from both ledgers though its effect is fully live
  // on both. Verified 2026-09-05 by direct inspection, never from schema_migrations: on BOTH
  // staging (cifwmndunmlxjhyjugxa) and production (ozucdzovmcqvepbozvqf),
  // phx_weekly_plan_next_status(text,text,boolean,boolean) and
  // phx_weekly_plan_decide(uuid,integer,text,text,text,text,text,jsonb,boolean) exist with
  // EXECUTE granted to exactly {postgres, service_role} — no anon, no authenticated. Do not
  // re-run this file; on a project where the 8/3-arg originals are already gone, `create
  // function` would then fail the OPPOSITE way ("already exists").
  "20260905183000_district_manager_plans_never_write_a_ceo_row.sql",
  // ── Added 2026-09-26. These three read as "missing" on PRODUCTION only. Production's ledger has
  // no row for any of them under any version OR name — each was applied to production by direct SQL
  // / an MCP apply_migration clock that writes no matching schema_migrations row — but the EFFECT
  // of all three is fully live on production. (The first two are also in staging's ledger under
  // their own name and match once the paged fetch in check-migrations-applied.ts sees the whole
  // ledger.) Verified 2026-09-26 by direct inspection on ozucdzovmcqvepbozvqf, never from
  // schema_migrations:
  //   - notification_role_policies_notification_key_check includes 'new_hire_mailbox_alert'.
  //   - phoenix_crm_plan_items.place_id is nullable (this file dropped its NOT NULL), and the
  //     new-signature phoenix_crm_ensure_reference_customers(p_seat_id text, p_line_c…) exists.
  //   - pg_get_functiondef(phx_territory_area_pharmacies) carries the effective_units fix (units
  //     counted as sum(effective_units), not sum(total_qty)).
  // Do not re-apply any of the three — each is a "create or replace" / idempotent alter, and the
  // gap is production bookkeeping, not missing schema.
  "20260918120027_notification_role_policies_new_hire_mailbox_key.sql",
  "20260922180258_phoenix_crm_pending_customers.sql",
  "20260922220000_territory_area_pharmacies_effective_units.sql",
  // ── Added 2026-10-08, on the owner's instruction to reconcile the ten PRODUCTION misses. Same
  // shape as the 2026-09-26 block above: a 2026-10-02/10-04/10-06 batch went onto production
  // through a path that writes no schema_migrations row, so the ledger has nothing for any of
  // these under any version OR name, while the effect of each is live.
  //
  // 🔴 NOT taken on trust, and NOT from existence either — a `create or replace` is satisfied by
  // an OLDER body, which is the trap this whole list exists for. Each function below was verified
  // by comparing md5(pg_proc.prosrc) on ozucdzovmcqvepbozvqf against the md5 of the file's own
  // dollar-quoted body, and each table/constraint/view against pg_catalog. Reproduce it with
  // `select md5(prosrc) from pg_proc …`; the digests are in the PR that added this block.
  //
  // 🔴 Note on length: prosrc_len can differ from the file body's JS .length by a few characters
  // with the md5 IDENTICAL. That is not drift — JS counts UTF-16 units and Postgres counts
  // characters, so every emoji in a comment costs one extra. Trust the digest, not the length.
  //
  // Proven applied, body-for-body:
  //   - 20261002123958: public.phoenix_crm_team_starts (10 cols) + its one-running unique index,
  //     and phoenix_crm_set_team_start / _started_team_seats / _started_team_reps all md5-equal.
  //   - 20261002135638: public.phoenix_crm_visit_asks (19 cols, 6 indexes, the service_role
  //     policy), and raise_ / answer_ / cancel_visit_ask all md5-equal.
  //   - 20261002142118: phoenix_crm_plan_day_status md5-equal, and both views exist with
  //     crm_plan_entries_unified's definition calling it.
  //   - 20261002142625: phoenix_crm_save_plan md5-equal.
  //   - 20261002205435: both widened CHECKs carry 'Pharmacy', and plan_items' CHECK deliberately
  //     does NOT — that asymmetry IS the owner's rule, so a "tidy-up" that widens it is a defect.
  //   - 20261004141055: au.monthly_targets_dropped (14 cols) + its period index, and
  //     phx_drop_monthly_targets md5-equal.
  //   - 20261006002000: phoenix_crm_fold_name and phoenix_crm_load_list_customers md5-equal.
  //
  // 🔴 SUPERSEDED — re-applying either of these two would REVERT production to an older function:
  //   - 20261002150353 (phoenix_crm_seat_reference): production's body is code-identical to the
  //     LATER 20261002224250_phoenix_crm_seat_reference_and_place_removal.sql once `--` comments
  //     and whitespace are stripped (6b12054c9d9b1cf0e323b0e442d7dabe, 2,830 chars both). The raw
  //     bodies differ by 669 bytes of COMMENT ONLY, because that file kept being annotated after
  //     it was applied — its ledger row is 20261002205554, stamped BEFORE the filename's own
  //     timestamp. This file's own change is live inside it: list_type in ('AM','PM','Pharmacy').
  //   - 20261002205436 (phoenix_crm_save_visit): its column product_manager_hr_id and all three
  //     rewritten CHECKs are live, and the function has since been replaced by
  //     20261006234611_phoenix_crm_visit_company_and_admin_edit.sql, whose body md5 IS what
  //     production carries (3e9032ede88b89857d22ffb61ddac52c).
  //
  // The tenth of the ten is NOT here: 20261002184148_luxor_separate_from_qena2_no_rep_seat.sql was
  // genuinely unapplied and was applied on 2026-10-08 (ledger 20261008115526) rather than excused.
  // See docs/security/migration-ledger-reconciliation-2026-10-08.md for why that one was different.
  "20261002123958_phoenix_crm_visits_everywhere.sql",
  "20261002135638_phoenix_crm_visit_asks.sql",
  "20261002142118_phoenix_crm_plans_everywhere.sql",
  "20261002142625_phoenix_crm_saved_event_keeps_the_returned_day.sql",
  "20261002150353_phoenix_crm_pharmacy_reference.sql",
  "20261002205435_phoenix_crm_pharmacy_list_type.sql",
  "20261002205436_phoenix_crm_visit_product_manager.sql",
  "20261004141055_drop_line_month_targets_with_archive.sql",
  "20261006002000_phoenix_crm_customer_name_fold.sql",
  // ── Added 2026-10-08 (evening). An ELEVENTH file of the same CRM family, flagged after the ten
  // above had been reconciled and so not covered by that pass. Same shape as the two superseded
  // ones, and judged the same way — digests, never a catalog probe.
  //
  // 🔴 SUPERSEDED — re-applying this would REVERT production to a SHORTER, older function.
  // This file redefines public.crm_contact_list_change_apply with a 6,498-character body
  // (md5 50644d369fc29cfd0134683670861fc3). The LATER
  // 20261007200000_started_reps_doctor_list_is_phoenix_own.sql redefines that same function with a
  // 9,516-character body, and THAT is byte-for-byte what both projects run: pg_proc.prosrc reads
  // md5 b5a5a2ab9ec3a9ef14f6bff322c0f445 at 9,516 characters on production AND staging. The RAW
  // digests match, so no comment-stripping was needed to reach the verdict.
  //
  // Its own change is live inside that newer body, which is what makes this superseded rather than
  // reverted — and that was checked separately from the digest. All SEVEN neutral refusal strings
  // this file introduces were matched one at a time in production's prosrc with position(), from
  // 'That change was not found.' through 'That doctor already has this grade.'
  //
  // Why it can never match production's ledger: there is NO row for it there under any name
  // (searched version like '20261006%' and '20261007%', plus name ilike '%refusal_neutral%'). The
  // superseding file IS recorded, as 20261007200000/started_reps_doctor_list_is_phoenix_own, so
  // that one passes on its own merits and this file is the only one left flagged.
  //
  // It masks nothing on staging: staging's ledger holds it by version AND name
  // (20261006185533 / crm_contact_list_refusal_neutral), read live on cifwmndunmlxjhyjugxa.
  "20261006185533_crm_contact_list_refusal_neutral.sql",
]);

export type LocalMigration = { fileName: string; version: string; name: string; commitTimeMs: number | null };

/** The repository root — the only directory the bulk `git log` below may run in. See its header. */
const REPO_ROOT = path.join(__dirname, "..", "..");

/**
 * Every committed migration file's newest commit time, keyed by BASENAME, in ONE git process.
 *
 * 🔴 THIS USED TO BE ONE `git log` PROCESS PER FILE, AND THAT IS WHAT CANCELLED THE NIGHTLY DRIFT
 * CHECK. The cost grows with the migration count and nothing capped it: at 410 files the original
 * comment here called it "minutes rather than seconds" and left it, at 855 files it measured 4m34s
 * per leg on a GitHub runner, and migration-drift-check.yml drives it TWICE (staging, then
 * production) inside a 10-minute job. The job hit 10m07s on 2026-10-10 and again on 2026-10-12,
 * GitHub cancelled it at the wall, and a CANCELLED check suite on `main` HEAD makes Railway withhold
 * that commit's production deploy permanently — the exact failure the whole `continue-on-error`
 * design in that workflow exists to prevent, except a job timeout is not a step failure, so
 * `continue-on-error` cannot absorb it. Every check leg had already run and reported; only the run's
 * conclusion was lost. Measured after this change: 855 files in ONE process, well under a second.
 *
 * Equivalence to the per-file `git log -1 --format=%ct -- <path>` it replaces is exact, and pinned
 * by tests/github-workflow-validity.test.ts over a spread sample plus a coverage floor — a sample
 * rather than all 855 because the comparison has to run the slow path it is checking, and paying
 * 855 processes inside the required `validate` job would reintroduce the cost in the one place that
 * gates every merge. `--follow` was a no-op in the old call: it only extends history BACKWARDS
 * through renames, and `-1` already asks for the most recent commit touching the path, which no
 * amount of rename-following changes.
 *
 * Keyed by basename, and run with cwd = REPO_ROOT, deliberately. The old call built its pathspec
 * with `path.relative(process.cwd(), …)`, so running the drift check from anywhere but the repo
 * root produced `../..` paths that git matched nothing against — silently giving EVERY file
 * "age unknown", which switches the 48h grace window off and flags migrations merged minutes ago.
 */
function loadCommitTimesByFileName(): Map<string, number> {
  try {
    return parseGitLogCommitTimes(
      execSync('git log --format=%ct --name-only -- "supabase/migrations"', {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  } catch {
    // Not fatal — if git history is unavailable (a shallow checkout, no git on PATH) every file
    // reports "age unknown", which `isWithinGraceWindow` already treats as "do not shelter it".
    return new Map<string, number>();
  }
}

/**
 * The parse, split out from the git call so it can be pinned without a git history.
 *
 * 🔴 SPLIT OUT BECAUSE THE LIVE COMPARISON CANNOT RUN IN CI. `validate` checks out at the default
 * `fetch-depth: 1`, so there is exactly one commit, no file has a second one, and the only test
 * that can catch a wrong newest-wins is one fed a fixture. The first version of that test asked
 * git on the runner and tripped its own anti-vacuous floor — correctly, which is how this was found.
 *
 * `--format=%ct --name-only` prints the commit seconds, a blank line, then that commit's paths.
 * Newest commit first, so the FIRST time a path appears is the newest commit that touched it, which
 * is exactly what `git log -1` means — hence `if (!out.has(...))`, never an unconditional set.
 * Keyed by basename: a migration filename is unique in the directory, and that also carries a
 * renamed file's history onto its current name.
 */
export function parseGitLogCommitTimes(stdout: string): Map<string, number> {
  const out = new Map<string, number>();
  let commitTimeMs: number | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\d{9,12}$/.test(trimmed)) {
      commitTimeMs = Number(trimmed) * 1000;
      continue;
    }
    if (commitTimeMs === null) continue;
    const fileName = path.posix.basename(trimmed);
    if (!fileName.endsWith(".sql")) continue;
    if (!out.has(fileName)) out.set(fileName, commitTimeMs);
  }
  return out;
}

/**
 * Every migration file on disk, in readdir order.
 *
 * `withCommitTimes` decides whether commit times are looked up. Since the lookup became a single
 * git process (see loadCommitTimesByFileName) it is no longer the minutes-long cost that named this
 * flag, but it is still a process and still only the grace window needs the answer — so the drift
 * check pays for it and the staging applier, which ignores the grace window by design, does not. A
 * caller that skips it gets `commitTimeMs: null`, which `isWithinGraceWindow` already treats as
 * "age unknown, do not shelter it".
 */
export function loadLocalMigrations(
  options: { withCommitTimes?: boolean } = {},
): LocalMigration[] {
  const withCommitTimes = options.withCommitTimes !== false;
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(`migrations directory not found: ${MIGRATIONS_DIR}`);
  }
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
  const commitTimes = withCommitTimes ? loadCommitTimesByFileName() : new Map<string, number>();
  const out: LocalMigration[] = [];
  for (const fileName of files) {
    const m = FILENAME_RE.exec(fileName);
    if (!m) continue; // check-migrations.mjs already fails malformed filenames separately
    const [, version, name] = m;
    out.push({ fileName, version, name, commitTimeMs: commitTimes.get(fileName) ?? null });
  }
  return out;
}

/**
 * The per-file `git log -1` the bulk pass replaced, kept ONLY so the test can prove the two agree.
 *
 * Not exported for production use and not called by any check: it is one process per file, which is
 * the cost that cancelled the nightly. The test calls it for every file in the directory and asserts
 * the bulk map matches — break the bulk parse and that comparison is what fires.
 */
export function commitTimeMsForOneFileSlowly(fileName: string): number | null {
  try {
    const epochSeconds = execSync(`git log -1 --format=%ct -- "supabase/migrations/${fileName}"`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return epochSeconds ? Number(epochSeconds) * 1000 : null;
  } catch {
    return null;
  }
}

/** The bulk commit-time map, exposed for the equivalence test above. */
export function commitTimesByFileNameForTests(): Map<string, number> {
  return loadCommitTimesByFileName();
}

/** `https://<ref>.supabase.co` -> `<ref>`, so every run states which project it judged. */
export function projectRefFromUrl(url: string): string {
  return /^https?:\/\/([a-z0-9]+)\./i.exec(url)?.[1] ?? url;
}

/** A project's supabase_migrations.schema_migrations, once read, in the two shapes we match on. */
export type RemoteLedger = { versions: Set<string>; names: Set<string> };

/**
 * Is this local migration accounted for on the target project?
 *
 * THREE ways, and every one is load-bearing — this ledger is not a clean mirror of the filenames
 * and never has been:
 *
 *   1. VERSION — the ordinary case, a file applied by `supabase db push`.
 *   2. NAME — the MCP apply_migration pattern. That tool stamps the version from the SERVER's
 *      clock at apply time, not from the filename, so a hand-applied migration lands under a
 *      version that matches nothing at all. Its name still matches. On staging this is the COMMON
 *      case rather than the exception, because staging is applied by hand.
 *   3. SUBSTRING — a handful of historical rows put a whole alternate filename, timestamp and all,
 *      in the `name` column, so the version appears inside a name instead of as one.
 *
 * All three were learned in check-migrations-applied.ts; this is that logic, unchanged.
 */
export function isRecorded(migration: LocalMigration, remote: RemoteLedger): boolean {
  if (remote.versions.has(migration.version)) return true;
  if (remote.names.has(migration.name)) return true;
  return [...remote.names].some((name) => name.includes(migration.version));
}

/**
 * Too new to complain about. A migration merged minutes ago is SUPPOSED to read as unapplied:
 * staging verification is still in progress and production needs the owner's explicit approval
 * (AGENTS.md §6).
 *
 * `commitTimeMs === null` means git history was unavailable — a shallow checkout — and is
 * deliberately NOT treated as young. An unknown age must never silence a real gap.
 */
export function isWithinGraceWindow(migration: LocalMigration, nowMs: number): boolean {
  return migration.commitTimeMs !== null && nowMs - migration.commitTimeMs < GRACE_WINDOW_MS;
}

/**
 * The migrations genuinely missing from a project, OLDEST FIRST.
 *
 * Order is part of the answer, not presentation: the applier runs them in exactly this order, and
 * a migration that adds a column the next one backfills cannot be allowed to run second.
 *
 * `ignoreGraceWindow` is the one place the two callers legitimately differ, and the difference is
 * the whole point of each:
 *   - the CHECK leaves it off. It runs nightly and must not shout about a migration merged an hour
 *     ago that nobody has had a chance to apply yet.
 *   - the APPLIER turns it on. It runs ON the merge, so every file it cares about is seconds old.
 *     A grace window there would mean it applied nothing for two days and then applied everything
 *     at once, which is the behaviour it exists to prevent.
 *
 * What they must NEVER differ on is the exception list or the match rule, and neither is
 * parameterised here.
 */
export function selectMissingMigrations(
  local: LocalMigration[],
  remote: RemoteLedger,
  options: { nowMs: number; ignoreGraceWindow?: boolean },
): LocalMigration[] {
  return local
    .filter((migration) => !ACKNOWLEDGED_EXCEPTIONS.has(migration.fileName))
    .filter(
      (migration) =>
        options.ignoreGraceWindow === true || !isWithinGraceWindow(migration, options.nowMs),
    )
    .filter((migration) => !isRecorded(migration, remote))
    .sort((a, b) => a.version.localeCompare(b.version));
}
