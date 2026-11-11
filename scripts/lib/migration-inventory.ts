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
//
// 🔴 ELEVEN OF THESE ENTRIES ARE NOW *ALSO* RECORDED IN PRODUCTION'S LEDGER, AND BOTH STAY — the
// owner's decision, 2026-10-13, in the same words: "keep the 11 ledger rows and leave the exceptions
// in place". A session reading either mechanism will find the other one apparently redundant; it is
// not. The rows cover `supabase db push`, which does not read this list, and for the two superseded
// functions among those files a recorded row is what stops a re-apply REVERTING production. The
// entries carry the evidence, which no ledger row can. Do not retire either side, and read
// docs/security/migration-ledger-reconciliation-2026-10-13.md before adding to this list: a missing
// row is answered by a digest and an evidenced entry here, never by a catalog-presence probe.
//
// Pinned by tests/migration-exception-staleness.test.ts: an entry naming no migration file, a
// duplicate, and an entry re-shaped out of its own parse each fail the required `validate` job.
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
  // ── Added 2026-10-13, on the owner's instruction. TEN more files production's ledger held no row
  // for, by version or by name, all past the 48h grace window (oldest 138h). Same shape as
  // 2026-10-08 and judged the same way: `md5(pg_proc.prosrc)` against the file's own dollar-quoted
  // body, never a catalog probe — and for the four files that define no function, the one-time
  // structural facts they alone produce. All ten came back APPLIED. None needed applying, and
  // nothing was written to production. Full account, with every digest:
  // docs/security/migration-ledger-reconciliation-2026-10-13.md
  //
  // All ten are in STAGING's ledger by version AND name, read live on cifwmndunmlxjhyjugxa before
  // these entries were written — so each entry masks a production-only gap and nothing on staging.
  // That is the normal staging-first direction these checks exist to catch.
  //
  // Verified: public.phoenix_crm_admin_edit_visit md5-equal at 8e9e08c70f373ab3b576a8275688494b,
  // 5,885 chars, and this file is its LAST definer in the directory. Table
  // phoenix_crm_visit_edits and phoenix_crm_visit_edits_visit_idx both present.
  // 🔴 Its OTHER function, phoenix_crm_save_visit, is SUPERSEDED by 20261010180118 — a re-apply
  // would revert production from a 28,152-character body to this file's 27,663-character one.
  "20261006234611_phoenix_crm_visit_company_and_admin_edit.sql",
  // Verified: public.phoenix_crm_decide_validation_review md5-equal at
  // 10db6f07b837ad35fd230c3e012332e3, 6,817 chars, and this file is its LAST definer. Both columns
  // it adds are live (phoenix_crm_validation_reviews.refusal_reason,
  // phoenix_crm_customers.reopened_at) along with phoenix_crm_customers_reopened_waiting_idx.
  "20261008023801_phoenix_crm_validation_refusal_reason.sql",
  // Verified: public.phoenix_crm_move_place md5-equal at d67d626e02daab6fccf529c5458f3aaa,
  // 3,501 chars, and this file is its LAST definer.
  // 🔴 Its OTHER function, phoenix_crm_insert_place, is SUPERSEDED — production runs
  // 20261010190001's body, and this file's is the 3,284-character generation FIVE revisions back.
  // A re-apply would revert four later migrations' work to that function at once.
  "20261008024500_phoenix_crm_place_brick_lookup_write.sql",
  // Verified: TWO functions md5-equal, both with this file as their LAST definer —
  // phx_attendance_balance_reversal_shape at 0b8868570ef654644a7712589b2480a8 (954 chars) and
  // phx_deductions_return_leave_balance at 19cf8fa9e9b24f1c0dcff7ee999e3a49 (2,007 chars). Table
  // attendance_annual_balance_charges is present with its candidate index and both unique indexes.
  // 🔴 Its THIRD function, phx_deductions_charge_leave_balance, is SUPERSEDED by
  // 20261009210000_deductions_leave_balance_vacation_categories — that one's body is what runs
  // (a79f9646940b18e1f8b8c9edcf55d679 comment-stripped, 3,617 chars), so a re-apply would drop the
  // vacation categories back out.
  "20261009200000_deductions_leave_balance_charges.sql",
  // Verified structurally — this file defines no function, so there is nothing to digest, and every
  // fact below is one-time and could not have arrived any other way. The
  // 'sos_mapping_guard_alert' row is GONE from public.notification_role_policies, exactly 24 policy
  // rows remain, and notification_role_policies_notification_key_check has been rebuilt without
  // that key while still carrying 'accepted_offer_alert' — which is precisely the 24-key list this
  // file writes.
  "20261010030000_notification_role_policies_retire_mapping_guard_key.sql",
  // Verified structurally, and this one is a file of DROPS, so presence-of-absence IS the proof:
  // 0 functions matching sos_map_guard% or sos_move_brick_sales_after_hold, 0 triggers matching
  // sos_map_guard%, and public.sos_map_guard_permits absent. The Mapping Guard is retired, which is
  // also a standing rule — see .claude/rules/sales-imports.md, "never rebuild it".
  "20261010030100_retire_mapping_guard.sql",
  // Verified structurally — an index SWAP, where both halves are checkable and neither is
  // reversible by accident. employees_hr_id_upper_trim_idx exists on exactly this file's
  // expression, `CREATE INDEX employees_hr_id_upper_trim_idx ON public.employees USING btree
  // (upper(btrim(hr_id)))`, and employees_hr_id_lower_trim_idx is gone.
  "20261010100000_employees_hr_key_expression_index.sql",
  // Verified: TWO functions md5-equal, both with this file as their LAST definer —
  // phoenix_crm_save_plan at daa8205f6cf06d69724f008af2d83218 (6,271 chars) and
  // phoenix_crm_save_visit at 2b2d499b83b93b2edd3574748637eeb0 (28,152 chars). Column
  // phoenix_crm_places.session is present.
  // 🔴 Its THIRD function, phoenix_crm_insert_place, is SUPERSEDED by 20261010190001.
  "20261010180118_phoenix_crm_seating_session.sql",
  // Verified structurally — its only function is superseded, so the two unique indexes it alone
  // creates are the evidence, and both are live with this file's exact definitions:
  // phoenix_crm_shared_places_timetable_uidx on phoenix_crm_shared_places(schedule_photo_path), and
  // phoenix_crm_places_photo_uidx on phoenix_crm_places(photo_path) WHERE shared_place_id IS NULL.
  // 🔴 SUPERSEDED function: phoenix_crm_insert_place, by 20261010190001, whose own name
  // (_insert_place_session_and_one_timetable) carries this file's one-timetable change forward
  // together with 20261010180118's session change. A re-apply would revert both.
  "20261010190000_phoenix_crm_one_timetable_for_a_polyclinic.sql",
  // Verified: all THREE of its functions md5-equal, and this file is the LAST definer of each —
  // phoenix_crm_seat_places_in_venue at 10811cdd02818e4bfd935a79ba397cc2 (10,241 chars),
  // phoenix_crm_set_venue_timetable at cea0bbe19f2d6a0d7de8b995408d5927 (2,441 chars) and
  // phoenix_crm_settle_venue_timetable at 412c565c0bab71b9371af07474e17931 (5,717 chars). Nothing
  // here is superseded, so this is the cleanest of the ten.
  "20261010210000_phoenix_crm_seat_places_in_venue.sql",
  // An ELEVENTH file, flagged the same night — it crossed the 48h grace window (55h old) while the
  // ten above were being judged, so it is in the account's addendum rather than its tables.
  // Verified: public.phoenix_crm_offplan_visit_cap, the ONLY definition of that function in the
  // directory, is COMMENT-STRIPPED-equal to this file at 8a4b9a20da1abcb9199ff50f17cf14ec, 1,205
  // chars both sides. Production's prosrc carries ZERO `--` comments (1,345 chars against the
  // file's 1,630) and the file has one commit, never edited after it was added — so the version
  // that ran was sent comment-free down a path that writes no ledger row, not an older generation
  // of the logic. Everything the file does besides the function is live and exact:
  // phoenix_crm_settings.offplan_daily_cap default 2 and offplan_weekly_cap default 8, both CHECKs
  // (1..20 and 1..100) as written, the BEFORE INSERT trigger phoenix_crm_visits_offplan_cap present
  // on phoenix_crm_visits, and the settings row reading 2/8 — the owner's own numbers (2026-10-10).
  "20261010214440_phoenix_crm_offplan_visit_caps.sql",
  // 2026-10-15, and the plainest entry in this list because the session that caused it wrote it.
  // The fix was applied to production with `node scripts/apply-sql-file.mjs <file> production` at
  // 16:55:40 Cairo — a plain pooler connection, which runs the SQL and writes NO ledger row at all,
  // so the absence here is the apply route and not a missed migration. 🔴 The ledger does NOT stop
  // at this file's version, and a high-water-mark claim about it rots within the hour: "nothing at
  // or after 20261015133143" was true when written and false by that evening. Re-read 15 Oct 21:27
  // Cairo — the newest row is 20261015155642, and what matters is unchanged: ZERO rows carry THIS
  // file's version. Ask for the version, never for the end of the ledger.
  // Verified by digest, not by presence: `md5(pg_proc.prosrc)` for
  // public.phx_resubmit_marketing_request on ozucdzovmcqvepbozvqf reads
  // eb27af44e76d8cb90328858775cbb183 over 6,689 chars, and md5 of this file's own dollar-quoted
  // body is the same hash at the same length. This file is the function's LAST definer — it
  // supersedes 20261014140000_marketing_resubmit_atomic.sql, whose body digested
  // ed5ab6fe6a089faf6281f4817ee5ad77 before the apply — so existence could not have answered it:
  // the older generation satisfies any catalog probe. `prosecdef` true and proacl
  // {postgres=X/postgres,service_role=X/postgres} were read in the same query, so the REVOKE landed.
  "20261015164459_marketing_resubmit_audit_id_uses_stored_requester.sql",
  // 2026-10-15, and written by the session that applied it, like the entry above. #5923 merged with
  // its migration NOT on production: both doors AGENTS.md §8 pre-authorizes refuse this file's SQL,
  // because the function BODY contains `delete from public.crm_contact_assignments` and three
  // `drop table if exists pg_temp.…` lines, which the destructive-SQL classifier reads as the
  // statement being run rather than as text inside a `create or replace function`. So production
  // served main's code with the old two-read body still live and the hourly doctor-list job still
  // able to strand. Applied with `node scripts/apply-sql-file.mjs <file> production` at 20:14 Cairo
  // (PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com — production is aws-1, and the
  // script's default aws-0 answers "Tenant or user not found"), a plain pooler connection that
  // writes NO ledger row: the absence here is the apply route, not a missed migration. Read in the
  // same minute: the ledger's newest row is 20261015155642, and ZERO rows carry version
  // 20261015132445 or this file's name.
  // Verified by digest, not by presence: `md5(pg_proc.prosrc)` for
  // public.crm_contact_master_refresh on ozucdzovmcqvepbozvqf reads
  // 7194a3929cef15051f541d5bab6ee875, and md5 of this file's own dollar-quoted body is the same
  // hash. Existence could not have answered it — the function has existed since July. This file is
  // its LAST definer, superseding 20261012184500_contact_refresh_survives_a_doctor_added_twice.sql,
  // whose body digests 34220e8603660375d75fb06bb58d116e, which is exactly what production carried
  // before the apply; that file is therefore also the one-command rollback. `prosecdef` false and
  // `proconfig` {search_path=public} were read in the same query, so the security shape is
  // unchanged, and prosrc now reads `from public.phoenix_crm_customers` exactly ONCE — the snapshot
  // build — which is the whole rule this migration exists to establish.
  "20261015132445_contact_refresh_reads_the_customer_table_once.sql",
  // ── Added 2026-10-15 21:4x Cairo by a PRODUCTION sweep the owner asked for in those words
  // ("sweep production for merged migrations never applied"). All FOUR files the daily check had
  // been reporting since 14 Oct were verified live on production (ozucdzovmcqvepbozvqf) and all
  // four are APPLIED — the sweep found NOTHING unapplied. Each is here because its apply route
  // wrote no ledger row: `supabase_migrations.schema_migrations` holds ZERO rows carrying any of
  // the four versions or names, read in the same session.
  //
  // 🔴 TWO OF THE FOUR WOULD HAVE READ AS DRIFT TO A RAW md5 COMPARISON, AND DID NOT DRIFT AT ALL.
  // The route that applied them normalised the text: production's `prosrc` carries CRLF line
  // endings, and for two functions the full-line `--` comments were stripped before the SQL was
  // sent. So compare md5 of the file's dollar-quoted body in FOUR shapes — as-is LF, as-is CRLF,
  // comment-stripped LF, comment-stripped CRLF — before calling a hand-applied body a different
  // generation. A length delta of a few dozen characters is the tell, and the same shape is already
  // recorded for 20261010214440 above.
  //
  // Verified: `phoenix_crm_rename_customer` md5-equal at 19cc502e3707fe5d5ebdb094ae760fe9 (3,385
  // chars, as-is LF) with this file as its LAST definer, so the file ran.
  // 🔴 Its OTHER function, phoenix_crm_validate_customer, is SUPERSEDED by
  // 20261014200147_phoenix_crm_held_venue_customers_wait_for_approval.sql, whose own body digests
  // 32d1dd0f968ffaca89210e2731819aa2 (15,639 chars) — which is exactly what production carries. A
  // re-apply would REVERT the held-venue change. proacl on both reads
  // {postgres=X/postgres,service_role=X/postgres}, so the REVOKE landed.
  "20261012090000_phoenix_crm_door_name_fold_and_place_cap.sql",
  // Verified on the ALTER and on all three functions, and this is the pair that needed the
  // CRLF/comment-strip shapes above. public.daily_deductions_lines carries all four columns the
  // file adds (released_at, released_by, range_start, range_end). phx_publish_daily_deductions is
  // CRLF-equal at 847ae99213985ad1c85f129b47009107 (3,182 chars against the file's 3,101 LF);
  // phx_release_daily_deduction_lines is comment-stripped-CRLF-equal at
  // 3152908611c67d7d20d709e52deedb81 (4,102 against 4,191) and phx_withdraw_daily_deduction_line at
  // 18e818eef0829a98d3735a1f5d1b39df (2,462 against 2,508). This file is the ONLY definer of
  // release and withdraw — so their mere existence already proves it ran — and the LAST definer of
  // publish, superseding 20260922103738_daily_deductions_module.sql. All three read `prosecdef`
  // true with `proconfig` {search_path=public, pg_temp} and proacl
  // {postgres=X/postgres,service_role=X/postgres}, exactly as written. Payroll money: a re-apply is
  // a no-op on the live bodies but would restore the two stripped comments, nothing more.
  "20261012132430_daily_deductions_per_line_release.sql",
  // The cleanest of the four: all three of its functions md5-equal as-is (LF, comments intact) with
  // this file as the LAST definer of each — phoenix_crm_seat_reference at
  // aff0d5a1110b32d61f050cbb93e79008 (4,717 chars), phoenix_crm_ensure_reference_customers at
  // a263a7a883ec47435bdcbf43ccb9c2d2 (2,264) and phoenix_crm_customers_no_double_add at
  // 95f5e87958a026df409acefc9c0d5634 (555). Its trigger phoenix_crm_customers_no_double_add is
  // present and enabled (tgenabled 'O') on public.phoenix_crm_customers, which is the guard the
  // file exists to install.
  // 🔴 SUPERSEDED IN PART since 2026-10-16: phoenix_crm_seat_reference's LAST definer is now
  // 20261024003000_phoenix_crm_seat_reference_joins_customers_on_one_key.sql (applied through
  // apply_migration, so it carries its own ledger row; the one before it was
  // 20261016180200_phoenix_crm_seat_reference_joins_once.sql). Re-applying THIS file would
  // revert that function to the per-entry lateral; the other two functions and the trigger are
  // still this file's.
  "20261012200000_phoenix_crm_a_doctor_is_on_a_seat_once.sql",
  // A pure DROP, so the end state is the evidence and there is nothing to digest: ZERO relations
  // named v_active_organogram exist in production's pg_class at ANY relkind, which is this file's
  // whole effect (`drop view if exists public.v_active_organogram`). Its own header records the
  // pre-drop production measurement — zero dependent views, matviews or rules, and no anon grant —
  // and quotes the owner's 2026-10-12 instruction to depend only on the EU organogram. Re-applying
  // it is a harmless no-op; the restore SQL, if the view is ever wanted back, is in that header.
  "20261013010000_drop_v_active_organogram.sql",
  // ── The SECOND pass of the same 2026-10-15 sweep, with the 48h GRACE WINDOW STOOD DOWN. The four
  // above are what the daily check reports; these four were hidden behind the window and would have
  // started being reported over the following hours. 🔴 A SWEEP IS NOT THE DAILY CHECK: run
  // selectMissingMigrations with a far-future `nowMs` so the newest files are judged too, or a sweep
  // reports "clean" about a set it never looked at. All four are APPLIED on production, verified by
  // digest; STAGING carries real ledger rows for all four under their own versions, so none of these
  // entries masks anything on that project (checked explicitly — this list is project-agnostic, and
  // an entry justified on production silences the same file on staging).
  //
  // 🔴 SUPERSEDED, and the clearest proof in this list that CRLF is a real apply shape and not a
  // theory: this file's body digests ed5ab6fe6a089faf6281f4817ee5ad77 in its CRLF shape (6,681
  // chars), which is EXACTLY the pre-image the 20261015164459 entry above records for
  // phx_resubmit_marketing_request — so this file did run, in CRLF, and was then superseded that
  // evening. Production carries eb27af44e76d8cb90328858775cbb183 (6,689), which is 20261015164459's
  // body. Re-applying this file would REVERT the stored-requester fix.
  "20261014140000_marketing_resubmit_atomic.sql",
  // Verified: public.direct_order_marketing_offsets exists with relrowsecurity TRUE and all three
  // indexes this file creates (_pkey, _request_key, _order_idx), and BOTH its functions are
  // md5-equal as-is (LF, comments intact) — phx_record_direct_order_offset at
  // 3481db501d9c623d7df38dbd2586de1b (2,909 chars) and phx_remove_direct_order_offset at
  // d857a1be5786468f19c9695d70a4adce (1,741). This file is the only definer of either. Money path
  // (#5918, settling a marketing request against a direct order's debt), so the table and the RLS
  // flag were read rather than inferred from the functions.
  "20261015012551_direct_order_marketing_offsets.sql",
  // Verified: public.phx_finance_command_center md5-equal as-is at
  // 537f0489e812b2cd2ad3808556b060ea (15,028 chars), with this file as its last definer.
  "20261015012552_finance_command_center_offset_requests_need_no_proof.sql",
  // Verified: public.phx_admin_settle_service_fee md5-equal as-is at
  // 1e43480404794f268e228f85126f9c16 (7,679 chars), this file its only definer — so its existence
  // already proves the file ran, and the digest proves it ran in THIS generation (#5921).
  "20261015020803_admin_settle_service_fee_request.sql",
  // Applied by hand to production on 2026-10-15 at 22:07 Cairo through
  // `PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com node scripts/apply-sql-file.mjs … production`
  // (the standing route — both MCP doors refuse a `create or replace function` whose body merely
  // CONTAINS a `delete` or a `drop table pg_temp.…`), which writes NO ledger row. All four of its
  // functions were read back on production, md5-equal to the file's own bodies: the two it creates,
  // phoenix_crm_list_only_reps at ce348bea5b05175d6298dc7f79417820 and
  // phoenix_crm_doctor_list_reps at 6d63cbefda825947e76dccfe6dd7a5d8 (both `prosecdef` true,
  // `proconfig` {search_path=public}, proacl {postgres=X/postgres,service_role=X/postgres} — the
  // revoke-from-PUBLIC shape the file writes), and the two it re-emits with one call site each
  // changed, crm_contact_master_refresh at f099c54bdeed10ee8b8756968a972c73 and
  // crm_contact_list_change_apply at 40d256cff9fb976d6ba1799f02bedade, against pre-images
  // 7194a3929cef15051f541d5bab6ee875 and b5a5a2ab9ec3a9ef14f6bff322c0f445. Its effect was then
  // measured rather than assumed: one `select public.crm_contact_master_refresh()` returned
  // phoenixAssignmentsOpened 1223 with assignmentsClosed 0, assignmentsDiscarded 0 and
  // phoenixVendorHandedOver 0 — the nine October hires' lists opened, nobody else's touched.
  // Re-applying it is a no-op on all four live bodies.
  "20261015215500_a_vendorless_reps_phoenix_list_opens.sql",
  // Applied on 2026-10-16 by the session that wrote it, to STAGING at 05:16 Cairo and PRODUCTION at
  // 05:16:58 Cairo, both through `node scripts/apply-sql-file.mjs <file> <env>` (production with
  // PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com) — the standing route, because BOTH
  // MCP doors answered {"status":"declined"} on this exact SQL and a live read straight after showed
  // nothing had landed on either project. That route writes NO ledger row, so ZERO rows on either
  // project carry this version or name, read in the same minute.
  // Verified by digest on BOTH projects, not by presence: public.phoenix_crm_claim_visit_recording
  // reads md5(prosrc) 2770d3ffb63c16f3a279a7f16388d93f over 2,321 chars, and md5 of this file's own
  // dollar-quoted body (as-is LF) is the same hash at the same length. This file is the function's
  // ONLY definer. `prosecdef` true, `proconfig` {search_path=public}, proacl
  // {postgres=X/postgres,service_role=X/postgres} (the REVOKE landed); both new tables carry
  // relrowsecurity TRUE with no anon or authenticated grant; storage bucket phoenix-crm-recordings
  // reads file_size_limit 16777216, public false. Re-applying it is a no-op.
  "20261016103900_phoenix_crm_visit_recording.sql",
  // 2026-10-16, applied to staging and then production with `node scripts/apply-sql-file.mjs <file>
  // <env>` (production with PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com) after the
  // staging MCP answered {"status":"declined"} on this SQL. That route writes NO ledger row, so the
  // absence here is the apply route and not a missed migration.
  // Verified by digest on production (ozucdzovmcqvepbozvqf), not by presence: md5(pg_proc.prosrc) for
  // phoenix_crm_raise_double_visit_request reads 6cc5e91484f72310193ac5ccff22e110 (4,198 chars),
  // phoenix_crm_edit_double_visit_request_days d16fbea5bb39b49bea3c274782af8c0b (3,029) and
  // phoenix_crm_answer_double_visit_request 1b39d494445e031d878e1e9bbd206dfd (2,402) — each md5-equal
  // to the dollar-quoted body in this file (as-is LF), and this file is each one's ONLY definer. All
  // three `prosecdef` true and not executable by anon; both new tables read relrowsecurity TRUE and
  // authenticated holds no select. Re-applying it is a no-op (`if not exists` / `create or replace`).
  "20261016133000_phoenix_crm_double_visit_requests.sql",
  // 2026-10-16, applied to staging and then production with `node scripts/apply-sql-file.mjs <file>
  // <env>` (production with PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com) after the
  // staging MCP answered {"status":"declined"} on this SQL. That route writes NO ledger row, so the
  // absence here is the apply route and not a missed migration.
  // Verified by digest on BOTH projects, not by presence: md5(pg_proc.prosrc) reads
  // phoenix_crm_review_visit_recording cf2c740910fc3f4f78216c36bfc74bbe,
  // phoenix_crm_unplanned_waits_for_the_administrator 12c85c1cb784432f0162a26c2e26bdca,
  // phoenix_crm_report_visits_by_day dc47db5d6c7441484d1d498dc7d767e3 and
  // phoenix_crm_report_plan_vs_actual 8dc59ac824f25781051f140a3822a1a6 — each md5-equal to the
  // dollar-quoted body in this file (as-is LF). On production: 4 review columns, the status CHECK
  // names admin_pending, 1 trigger, the review function `prosecdef` true with EXECUTE held by postgres
  // and service_role only, and phoenix_crm_countable_visits keeps security_invoker=true and read 2,334
  // rows before and after (no recording had been claimed). Re-applying it is a no-op.
  // After both applies the file's `drop trigger if exists` + `create trigger` pair became one
  // `create or replace trigger` (the Phoenix CRM boundary test allows a migration to drop only its own
  // policies and constraints). Same trigger, same table, same function: that statement was run on
  // staging and still reads trigger_count 1, so the file and both databases agree.
  "20261016161248_phoenix_crm_recorded_visit_waits_for_the_administrator.sql",
  // 2026-10-16, applied to staging and then production (18:10 Cairo) with `node
  // scripts/apply-sql-file.mjs <file> <env>` (production with
  // PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com) after the staging MCP answered
  // {"status":"declined"} on this SQL — its body contains the plan's own `delete` of dropped items. That
  // route writes NO ledger row, so ZERO rows on either project carry this version or name.
  // Verified by digest on BOTH projects, not by presence: md5(pg_proc.prosrc) for
  // phoenix_crm_save_plan reads ddd6eba3f763fabdd54d0d5af247d1c3 over 6,732 chars, md5-equal to the
  // dollar-quoted body in this file (as-is LF), and this file is the function's LAST definer (the
  // pre-image was 20261010180118's body, daa8205f6cf06d69724f008af2d83218). `prosecdef` true and
  // EXECUTE held by service_role only. Its effect was measured on staging inside a rolled-back block:
  // a second save of identical items left both rows at the same ctid, and changing one item rewrote
  // that row alone. Re-applying it is a no-op (`create or replace`).
  "20261016180100_phoenix_crm_save_plan_writes_only_changed_items.sql",
  // 2026-10-16, applied to staging and then production (about 21:50 Cairo) with `node
  // scripts/apply-sql-file.mjs <file> <env>` (production with
  // PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com) after the staging MCP answered
  // {"status":"declined"} on this SQL — the function body contains the rebuild's own `delete from
  // marketing_roi_*` statements. That route writes NO ledger row, so ZERO rows on either project carry
  // this version or name.
  // Verified by digest on BOTH projects, not by presence: md5(pg_proc.prosrc) for
  // public.phx_refresh_marketing_roi_facts reads c8d100c116c188021443fa91f0b32c90 over 30,659 chars on
  // ozucdzovmcqvepbozvqf and on cifwmndunmlxjhyjugxa, md5-equal to the dollar-quoted body in this
  // file (as-is LF), and this file is the function's LAST definer. The pre-image is
  // 20261009150000_marketing_roi_facts_awaiting_data.sql, whose body digests
  // e0219a05d76db904f1e324561b969782 LF-normalised (production carried it with CRLF, 29,721 chars,
  // bad8ea66782c00ccc6e12d1ce7755875 as stored) — which is exactly what production held before the
  // apply, and makes that file the one-command rollback. `prosecdef` true, `proconfig`
  // {search_path=public,statement_timeout=60s} and proacl {postgres=X/postgres,service_role=X/postgres}
  // were read in the same query, so the security shape is unchanged. Its effect, measured on
  // production: the same bare call went from 5,394 ms (14,106 blocks read from disk) to 368 ms (189),
  // and the eight marketing_roi_*_facts tables and the run's affected_periods are identical before
  // and after (row counts 36/17/8/30/16/64/20/3). Re-applying it is a no-op (`create or replace`).
  "20261016223000_marketing_roi_refresh_skips_through_periods.sql",
  // 2026-10-16, applied to staging and then production (about 22:40 Cairo, outside the 06:00-22:00
  // poller window) with `node scripts/apply-sql-file.mjs <file> <env>` (production with
  // PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com) — the standing route, because both MCP
  // doors refuse a `create or replace function` whose body merely CONTAINS a `drop table pg_temp.…`,
  // and this body holds five. That route writes NO ledger row, so the absence here is the apply route
  // and not a missed migration.
  // Verified by digest on BOTH projects, not by presence: md5(pg_proc.prosrc) for
  // public.crm_contact_master_refresh reads 8f343dc21428862adb1d4df1a66190b8 over 31,040 chars on
  // ozucdzovmcqvepbozvqf and on cifwmndunmlxjhyjugxa, md5-equal to the dollar-quoted body in this file
  // (as-is LF), and this file is the function's LAST definer. The pre-image is
  // 20261015215500_a_vendorless_reps_phoenix_list_opens.sql, whose body digests
  // f099c54bdeed10ee8b8756968a972c73 — exactly what production held before the apply, which makes that
  // file the one-command rollback. SECURITY INVOKER, `proconfig` {search_path=public} and proacl
  // (service_role only) were read in the same query, so the security shape is unchanged, and the
  // function comment digests 4783f46b123e6285c42489bc54d4e1a7 on both. Its effect, measured on
  // production inside rolled-back transactions: the unperturbed hourly-style call went from 3,055 ms to
  // 1,139 ms with identical returned counts and identical checksums of every column of crm_contacts
  // (d4c9c487cd207cc56d199f1ffc83b9f9) and crm_contact_assignments (c502703a849506b236a580cb25904b22);
  // on staging three perturbed scenarios were IDENTICAL too. Re-applying it is a no-op
  // (`create or replace`).
  "20261016233000_crm_contact_master_refresh_skips_idle_work.sql",
  // 2026-10-17, the district manager's weekly plan in Phoenix CRM, applied to staging (16 Oct) and
  // then production (17 Oct, about 01:14 Cairo, on the owner's own words "apply the district manager
  // plan migration to production") with `node scripts/apply-sql-file.mjs <file> <env>` (production
  // with PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com) — the standing route, because
  // the production MCP answered {"status":"declined"} on this SQL: the replaced
  // phoenix_crm_merge_duplicate_customer body contains the merge's own `delete` statements. That
  // route writes NO ledger row, so ZERO rows on either project carry this version or name (read the
  // same minute; production's newest row is 20261016211408).
  // Verified by digest on BOTH projects, not by presence: md5(pg_proc.prosrc) on ozucdzovmcqvepbozvqf
  // and on cifwmndunmlxjhyjugxa is md5-equal to this file's dollar-quoted bodies (as-is LF) for all
  // eight functions it defines — phoenix_crm_save_manager_plan_slot 8001428dc75b22ba565674c39b83029f,
  // phoenix_crm_manager_plan_transition a29033c32db8acb97e2c487e286e21a0,
  // phoenix_crm_raise_manager_plan_edit 5fe74098409889c444da205732562d7d,
  // phoenix_crm_decide_manager_plan_edit d6df37ecc29c97582d4e5e1313411033,
  // phoenix_crm_expire_manager_plan_edit_requests 908026248543d388080e58550380fdfc,
  // phoenix_crm_request_manager_customer_removal a0c3d5f7ffb29ff9142363f09f4b4bf0,
  // phoenix_crm_decide_manager_customer_removal d61b4d9cbcb31bb973d683d5283c5abb, and
  // phoenix_crm_merge_duplicate_customer 6ffc0e4b169f5b39ade188aa017f79f9 (9,205 chars). This file is
  // the merge function's LAST definer; production carried 20261008120000's body,
  // 0a599fe2300702ad19faac32b0c3ece6, in the minute before the apply, which makes that file the
  // rollback for it. All eight are SECURITY DEFINER with EXECUTE for service_role alone, and all seven
  // phoenix_crm_manager_* tables have RLS on, one service_role policy each, and no anon or
  // authenticated privilege — read in the same query. Re-applying it is a no-op (`if not exists`,
  // `create or replace`, `drop policy if exists`).
  "20261017000000_phoenix_crm_manager_plan.sql",
  // 2026-10-17, the second approval on a district manager's asks — after a regional manager agrees to
  // reopen a sent week or to take a customer off Manager's own list, the NSM above him decides too
  // (owner, about 11:20 and 11:30 Cairo: "if regional manager applicable then after the rm approve the
  // nsm also must approve never skip", scope "Week + edit asks + removals"). Applied to staging
  // (cifwmndunmlxjhyjugxa) about 11:45 Cairo with `node scripts/apply-sql-file.mjs <file> staging` —
  // the standing route, because the staging MCP answered {"status":"declined"} on this SQL: the five
  // replaced bodies contain `update` statements. Then PRODUCTION (ozucdzovmcqvepbozvqf) at 12:06 Cairo
  // the same day, on the owner's own words "apply the manager asks second-approval migration to
  // production", by the same route with PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com —
  // before the PR that reads the new columns merged. That route writes NO ledger row, so no row on
  // either project carries this version or name (production read 0 rows for 20261017% after the apply).
  // Production's pre-image, read the minute before: all five bodies at 20261017000000's digests, all
  // four phoenix_crm_manager_* tables it touches at 0 rows, and none of the ten columns present.
  // Verified on BOTH projects by digest, not by presence: md5(pg_proc.prosrc) is md5-equal to this file's
  // dollar-quoted bodies (as-is LF) for all five functions it replaces —
  // phoenix_crm_raise_manager_plan_edit d487b727a85c1b67dd7e4573837f371f,
  // phoenix_crm_decide_manager_plan_edit ed3d6b906dee579b07ea4bdbd5867428,
  // phoenix_crm_expire_manager_plan_edit_requests cabf3f0b91ade9c6e6cee87490f0399d,
  // phoenix_crm_request_manager_customer_removal 72d693e938faba908c74d8cadfa3633f, and
  // phoenix_crm_decide_manager_customer_removal baeff82b022e7b13fee4bc2c02bf5914 — and this file is
  // each one's LAST definer. All five are SECURITY DEFINER with no anon or authenticated EXECUTE and
  // search_path=public, the ten columns, the widened status CHECKs and the one-open-ask index on
  // ('pending', 'first_approved') are live — read in the same query on each project. The same fifteen
  // transitions were run on each inside a DO block raised to roll back, on is_test rows, with identical
  // outcomes, and all four tables held 0 rows afterwards on both. The rollback is 20261017000000's five
  // bodies (its digests are above). Re-applying it
  // is a no-op (`add column if not exists`, the CHECKs dropped `if exists` before they are re-added,
  // `create or replace`).
  "20261017120000_phoenix_crm_manager_asks_second_approval.sql",
  // 2026-10-17, the manager's weekly plan widened to the regional, national and product managers
  // (owner, about 18:00 Cairo: "Now do the same for the product managers and the national sales
  // managers and the regional manager"; approvers "as today, HR auto acknowledge"). Applied to staging
  // (cifwmndunmlxjhyjugxa) at 18:53 Cairo with `node scripts/apply-sql-file.mjs <file> staging` — the
  // standing route, because both replaced bodies contain `update` statements the MCP declines. Then
  // PRODUCTION (ozucdzovmcqvepbozvqf) at 19:48 Cairo the same day, announced first, by the same route
  // with PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com — before the PR that reads the new
  // columns merged; it printed {"applied":true,"count":0}. That route writes NO ledger row, so no row on
  // either project carries this version or name. Production's pre-image, read the minute before: save
  // 8001428dc75b22ba565674c39b83029f and transition a29033c32db8acb97e2c487e286e21a0 (20261017000000's
  // digests, above), 1 plan, 3 slots, 1 event, and neither planner_kind nor scope_dm_seat_id present.
  // Verified on BOTH projects by digest, not by presence: md5(pg_proc.prosrc) is md5-equal to this file's
  // dollar-quoted bodies (as-is LF) for both functions it replaces —
  // phoenix_crm_save_manager_plan_slot 15223e65b8efa70cd128bb1786f0714a and
  // phoenix_crm_manager_plan_transition ce07420c77d4953c73701817894347ee — and this file is each one's
  // LAST definer. Both are SECURITY DEFINER with no anon or authenticated EXECUTE, and the six CHECKs
  // (plans_planner_kind, plans_seat_unless_pm, plans_hr_ack, slots_kind, slots_scope, events_type) are
  // live — read in the same queries on each project. On production the one plan reads planner_kind 'dm'
  // and its 3 slots and 1 event are untouched. Staging ran the transitions inside a DO block raised to
  // roll back (a product manager with no seat, Office refused for a district manager, regional →
  // national → CEO with the HR acknowledgement, national → CEO in one step, a district manager with no
  // acknowledgement): 16 of 16 intended outcomes. The rollback is 20261017000000's two bodies (its
  // digests are above) plus the column and CHECK steps in this file's header. Re-applying it is a no-op
  // (`add column if not exists`, the CHECKs dropped `if exists` before they are re-added,
  // `create or replace`).
  "20261017213000_phoenix_crm_manager_plan_wider_writers.sql",
  // 2026-10-18, the WhatsApp CV Archive (owner, about 23:30 Cairo: the old WhatsApp CVs he keeps go in
  // an Archive "in Phoenix as well", never in the pool or Screening). The MCP DECLINED it on staging —
  // its `drop policy if exists` lines — so it was applied by the standing route: `node
  // scripts/apply-sql-file.mjs <file> staging` (cifwmndunmlxjhyjugxa) at 23:43 Cairo, then PRODUCTION
  // (ozucdzovmcqvepbozvqf) at 23:45 Cairo with PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com;
  // both printed {"applied":true,"count":0}. No ledger row on either project carries this version or
  // name. It defines NO function, so there is no prosrc digest to compare: verified on BOTH projects in
  // one query each — ats_whatsapp_cv_archive and ats_whatsapp_cv_archive_files exist with RLS on, one
  // service-role policy each, no SELECT for anon or authenticated, and the bucket recruitment-cv-archive
  // exists private with its 10,485,760-byte limit. Purely additive (two new tables, one new bucket);
  // re-applying it is a no-op (`if not exists`, policies dropped `if exists` before they are re-made,
  // the bucket `on conflict do update`).
  "20261018204000_ats_whatsapp_cv_archive.sql",
  // 2026-10-19, written by the session that applied both weekly-plan migrations of #6095 (merged
  // 00:25 Cairo, live 00:35). The MCP `apply_migration` answered `declined` on production and on
  // staging, so they went through the standing route, `node scripts/apply-sql-file.mjs <file>
  // production` (ozucdzovmcqvepbozvqf, PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com),
  // a plain pooler connection that writes NO ledger row: the absence on production is the apply
  // route, not a missed migration. STAGING (cifwmndunmlxjhyjugxa) carries real ledger rows for both
  // versions and the same digests as production, read in the same session, so neither entry masks
  // anything there — this list is project-agnostic and an entry justified on production silences
  // the same file on staging.
  // Verified by digest, not by presence: `md5(pg_proc.prosrc)` for public.phx_weekly_plan_decide on
  // production reads fe4e6df16b75a9d07e5f9a846d5ba423 (it read 767fc837179135420935b21ec1ed1c49
  // before the apply, which is also the one-command rollback), and this file is its LAST definer.
  // Both indexes the file touches are live with the new predicates —
  // employee_plan_headers_active_period_uidx (rewritten) and
  // employee_plan_headers_one_live_revision_uidx (new) — and zero draft revisions are left whose
  // parent is dead. Staging ran a rolled-back smoke test of five behaviours (a pending revision
  // beside its approved parent, a second live revision refused, an unrelated plan for the same week
  // still refused, approving the revision cancels the parent with one `cancel` decision row,
  // rejecting it leaves the parent alone). Re-applying it is a no-op (`create or replace`, the
  // indexes dropped `if exists` and re-made).
  "20261018233000_weekly_plan_revision_supersedes_approved_parent.sql",
  // The same apply route and the same day. Two functions, no table, column or row change, both
  // md5-equal to production and staging alike: phoenix_crm_manager_plan_transition reads
  // 6c5b73437cf504fac699e00954a45c8a (before the apply ce07420c77d4953c73701817894347ee, which is
  // what 20261017213000 above installed, so THIS file is now that function's last definer and that
  // entry's digest is superseded) and phoenix_crm_decide_manager_plan_edit reads
  // 01145439d9ae968ceaddc06aa63998ac (before ed3d6b906dee579b07ea4bdbd5867428). Re-applying it is a
  // no-op (`create or replace`); the rollback is the two earlier bodies.
  "20261018234000_phoenix_crm_manager_plan_ask_closes_with_its_week.sql",
  // 2026-10-19, the candidate pool's column layouts saved to each reader's account (owner — "Columns
  // follow you"). The MCP `apply_migration` answered `declined` on staging and on production — its
  // `drop policy if exists` line — so it went through the standing route, `node
  // scripts/apply-sql-file.mjs <file> staging` (cifwmndunmlxjhyjugxa) and then production
  // (ozucdzovmcqvepbozvqf, PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com) at about 11:55
  // Cairo; both printed {"applied":true,"count":0}, and neither ledger carries this version or name.
  // It defines NO function, so there is no prosrc digest to compare: verified on BOTH projects in one
  // query each — ats_pool_column_layouts exists with RLS on, one service-role policy, no SELECT for
  // anon or authenticated, INSERT for service_role, and 0 rows. Purely additive (one new table);
  // re-applying it is a no-op (`if not exists`, the policy dropped `if exists` before it is re-made).
  "20261019120000_ats_pool_column_layouts.sql",
  // 2026-10-19, a resignation stops opening a clearance checklist (owner — "Stop the trigger"). The
  // MCP `apply_migration` answered `declined` on staging and on production — its `drop function`
  // line — and production was read straight after: the trigger and its function were both still
  // there. So it went through the standing route, `node scripts/apply-sql-file.mjs <file> staging`
  // (cifwmndunmlxjhyjugxa) and then production (ozucdzovmcqvepbozvqf,
  // PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com) at 16:08 Cairo; both printed
  // {"applied":true,"count":0}, and neither ledger carries this version or name. It DROPS rather
  // than defines, so there is no prosrc digest to compare: verified on BOTH projects in one query
  // each — zero `trg_hr_clearance_on_resignation` triggers, zero `phx_hr_clearance_on_resignation`
  // functions, the other four phx_hr_clearance_* functions still present, and on production the 35
  // checklists and 245 items unchanged. The pre-image is 20260828160000's own trigger and function,
  // which is also the rollback. Re-applying it is a no-op (both drops are `if exists`).
  "20261019153000_resignation_stops_opening_a_clearance_checklist.sql",
  // 2026-10-19 (the release gate, docs/deployment.md), applied BEFORE its PR merged. The production
  // MCP `apply_migration` answered `declined`, so the owner chose the standing route and it ran that evening, 19 Oct:
  // `node scripts/apply-sql-file.mjs <file> production` (ozucdzovmcqvepbozvqf,
  // PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com) printed {"applied":true,"count":0}
  // and wrote no ledger row — zero rows in supabase_migrations.schema_migrations carry this version
  // or a name like release_gates. A NEW table has no older generation a probe could mistake for it,
  // so existence is evidence here, and it was read by shape, not by presence alone: columns
  // sha text not null, recorded_at timestamptz not null, workflow_run_id text; the CHECK
  // `sha ~ '^[0-9a-f]{40}$'`; RLS on with the one policy phx_release_gates_service_role (ALL, role
  // service_role); select and insert granted to service_role and none to anon or authenticated; 0 rows.
  "20261019171347_release_gates.sql",
  // 2026-10-20, the HR Daily & Weekly Reports tables (the HR Operations Specialist seat, PR 6194),
  // applied BEFORE its PR merged — safe with the code then serving, which never reads them. The MCP
  // `apply_migration` answered `declined` four times on staging, so both projects went through the
  // standing route: `node scripts/apply-sql-file.mjs <file> staging` (cifwmndunmlxjhyjugxa) and then
  // production (ozucdzovmcqvepbozvqf, PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com) at
  // about 09:10 Cairo; production printed {"applied":true,"count":0}, and neither ledger carries this
  // version or a name like hr_ops_report. It defines NO function, so there is no prosrc digest: two
  // NEW tables have no older generation a probe could mistake for them, and both were read by shape
  // on production — hr_ops_reports and hr_ops_report_lines, RLS on, exactly one policy each, no
  // SELECT for anon or authenticated, INSERT for service_role, 3 and 6 indexes. Purely additive.
  "20261020065354_hr_ops_reports.sql",
  // The bridge from those reports into the weekly attendance review, applied BEFORE its PR merged by
  // the same standing route: staging (cifwmndunmlxjhyjugxa) re-applied after the risk-review edits,
  // then production (ozucdzovmcqvepbozvqf, PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com)
  // at 09:31 Cairo on 2026-10-20, {"applied":true,"count":1}; neither ledger carries this version.
  // Read back on production, identical on staging, md5(prosrc): phx_hr_ops_bridge_digest_day
  // 30454fec9baac625f5ee1b7dfff31dba, phx_attendance_sync_digest_days 0afcde125da5c3e724e3ae311c4249a8,
  // phx_attendance_settle_digest_line 00fb5edc0a221712d243ab35648333df — the two rewritten bodies
  // replaced 175dafd3e3b0da7682581514af63cff6 and 7ccd499a4c55e9920f5f42591b636e15, re-read unchanged
  // just before the apply. attendance_digest_lines' status CHECK now admits field_review, its three
  // hr_ops_* columns exist, the field_review category reads "Field Day (Reviewed)" paid through crm,
  // and the 139 existing digest rows are untouched (0 field_review rows). Safe before the deploy: the
  // serving code never names the new status, columns, category or function.
  "20261020072217_hr_ops_bridge_field_review.sql",
  // A district manager's ask for a second or third day of single visits (owner, 2026-10-20). The
  // Supabase MCP's apply_migration answered `declined` on staging, so both projects went through the
  // standing route: `node scripts/apply-sql-file.mjs <file> staging` (cifwmndunmlxjhyjugxa), then
  // production (ozucdzovmcqvepbozvqf, PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com) at
  // about 21:10 Cairo on 2026-10-20, {"applied":true,"count":0} on each; neither ledger carries this
  // version. Verified by digest on production: md5(prosrc) phoenix_crm_raise_manager_single_visit_day
  // 25d102f7965b9cd41393bfa6299f6d0d (3,483 chars), phoenix_crm_decide_manager_single_visit_day
  // ac62711fc91edbb22b13d91096733c1f (4,265), phoenix_crm_expire_manager_single_visit_days
  // 0b34f85280708c74295dcaf651edb0ca (808) — each the same hash at the same length as this file's own
  // LF body. All three are new names, so no older generation could have satisfied a probe; prosecdef
  // true and anon EXECUTE false on all three, and the new table has RLS on with 0 rows. Purely additive.
  "20261020210546_phoenix_crm_manager_single_visit_day_asks.sql",
  // 20 Oct 2026, ~21:45 Cairo — the owner's "make writing why optional", applied by
  // scripts/apply-sql-file.mjs to staging and production ({"applied":true,"count":0} on each), so no
  // ledger row. Proven on production (ozucdzovmcqvepbozvqf): `reason` is_nullable YES, the check reads
  // `reason IS NULL OR char_length(reason) between 1 and 500`, the raise function keeps its 500-character
  // guard with prosecdef true and anon EXECUTE false (prosrc md5 e50de77e0a4e0b22103d92a1272c00bd); on
  // staging an ask with no reason raised inside a rolled-back block came back `pending` with a null reason.
  "20261020213000_phoenix_crm_manager_single_visit_day_reason_optional.sql",
  // Royanoxicam's toll manufacturer moves from Medizen to Egyphar (owner, 2026-10-21: "look the
  // fctory changed from medizen to egyphar"). The Supabase MCP's apply_migration answered
  // `declined` on BOTH projects, so both went through the standing route:
  // `node scripts/apply-sql-file.mjs <file> staging` (cifwmndunmlxjhyjugxa), then production
  // (ozucdzovmcqvepbozvqf, PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com) at about
  // 01:05 Cairo on 2026-10-21, {"applied":true,"count":1} on each; neither ledger carries this
  // version. This migration is three UPDATEs and creates no object, so a catalog digest has nothing
  // to hash — the ROWS are the stronger evidence, and they were read back on production after the
  // apply: prodplan_locations holds code EGYPHAR / "At the factory (Egyphar)" / "مخزن المصنع —
  // إيجيفار" and ZERO rows coded MEDIZEN, Royanoxicam's manufacturer_name is "Egyphar", zero
  // prodplan_materials notes still name Medizen and seven carry "BOM code", and the geometry it must
  // not have touched is unchanged — mg, 31,000,000 / 155 = 200,000 tablets, 10,000 boxes, 16 linked
  // materials, 13 formula lines, 0.155000 g a tablet, 31.0000 kg a batch, and the aluminium blister
  // foil still with NO composition row at all (he answered "leave empty for now"). Staging reads
  // identically. Purely corrective: no DDL, no grant, no policy.
  "20261021004800_production_planning_royanoxicam_egyphar.sql",
  // ── Reconciled 2026-10-21, ~01:10 Cairo, while clearing the --no-grace drift list ─────────────
  // Both files below were reported "merged to main but not found in schema_migrations" and both are
  // LIVE on production (ozucdzovmcqvepbozvqf); neither needed applying, only recording here.
  //
  // The ATS job-post titles table. This file is the only thing that creates the name, so presence is
  // not the weak `create or replace` case the header above warns about. Verified on production: the
  // table exists with all 15 columns in this file's order (id, title, department, headline,
  // reports_to, employment, location, duties, needs, menu_name, is_active, created_by_hr_id,
  // updated_by_hr_id, created_at, updated_at), RLS on, the one policy
  // phx_ats_job_post_titles_service_role, and the FUNCTIONAL unique index this file declares —
  // `CREATE UNIQUE INDEX ats_job_post_titles_title_key ON public.ats_job_post_titles USING btree
  // (lower(btrim(title)))` — which a different generation of the file could not have produced. It
  // already holds 6 rows, so the feature is in use.
  "20261015223405_ats_job_post_titles.sql",
  // The HR Operations Specialist seat (role key 'HR Administration'). 🔴 A SESSION ALMOST APPLIED
  // THIS A SECOND TIME ON A PROBE THAT ASKED THE WRONG QUESTION: it searched the three CHECK
  // constraints and public.roles for the DISPLAY TITLE "hr_operations_specialist" and got nothing,
  // because the stored key is 'hr_administration' and the phoenixRole string is 'HR Administration'.
  // The file is explicitly re-runnable ("a re-run changes nothing") and the re-run was indeed a
  // no-op, but the reading was wrong and the next session should not repeat it. The ONE decisive
  // check is that an account already holds the role: `select count(*) from app_auth_users where role
  // = 'HR Administration'` returned 1, and that row could not exist unless app_auth_users_role_check
  // already admitted the value. Verified after: all three CHECKs (app_auth_users_role_check,
  // user_access_profiles_phoenix_role_check, notification_role_policies_roles_check) admit it, the
  // public.roles lookup row is present, resignation_workflow_alert names the seat exactly ONCE in
  // its roles array, and the four workflow registry modules name it with no duplication (contracts
  // twice, which is its two actions, and leave_requests, resignations and
  // private_calendar_data_disputes once each).
  "20261020064831_hr_operations_specialist_seat.sql",
  // 2026-10-22, Phoenix is the source of trust over the old CRM (owner, about 04:00 Cairo: "phoenix is
  // the source of trust and its data override old crm data"). Applied to staging (04:4x Cairo) and then
  // production (04:53 Cairo, on his MCQ pick "Apply staging then prod") with
  // `node scripts/apply-sql-file.mjs <file> <env>` (production with
  // PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com) — the standing route, because the
  // staging MCP answered {"status":"declined"} twice on this SQL, whose body holds six
  // `drop table if exists pg_temp.…` lines. That route writes NO ledger row, so the absence here is the
  // apply route and not a missed migration; its two siblings, 20261022163000 and 20261022163200, went
  // through apply_migration and are in both ledgers by name.
  // Verified by digest on BOTH projects, not by presence: md5(pg_proc.prosrc) for
  // public.crm_contact_master_refresh reads a99ddecb38b6332a972a787e52443806 over 33,564 chars on
  // ozucdzovmcqvepbozvqf and on cifwmndunmlxjhyjugxa, md5-equal to the dollar-quoted body in this file
  // (as-is LF), and this file is the function's LAST definer. Production held
  // 8f343dc21428862adb1d4df1a66190b8 (20261016233000) immediately before, which makes that file the
  // one-command rollback. SECURITY INVOKER, proconfig {search_path=public} and proacl (postgres and
  // service_role only) were read in the same query, and the function comment digests
  // 8801832df34402819bef3dd76951a853 on both. Effect on production: the first call changed 64 vendor
  // contacts (the 62 a pre-image saved before the apply had named, plus the two below) and the four
  // Phoenix-born ones; afterwards 0 contacts differ from what Phoenix holds. A second call 15 s later
  // changed 2 — Peter Alphonse (95487) and Mahmoud Khalafa (105208), whose phone exists only on a
  // PENDING Phoenix copy: the vendor pass blanks it and the name-row pass fills it back on every run, with
  // the same end state. That loop is the blank-fill rule the previous body had too; 20261022163300 below
  // removes it. Re-applying it is a no-op (`create or replace`).
  "20261022163100_phoenix_wins_the_contact_refresh.sql",
  // 2026-10-22, the loop above, fixed (owner, 05:1x Cairo: "fix the phone loop on Peter Alphonse and Mahmoud
  // Khalafa"). Applied to staging and then production (05:13 Cairo) with
  // `node scripts/apply-sql-file.mjs <file> <env>` (production with
  // PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com) — the standing route, for the same reason as
  // the entry above: the body holds six `drop table if exists pg_temp.…` lines, which both MCP doors refuse.
  // That route writes NO ledger row, so the absence here is the apply route and not a missed migration.
  // Verified by digest on BOTH projects, not by presence: md5(pg_proc.prosrc) for
  // public.crm_contact_master_refresh reads 0e5d0165b9ca43d1fb4a18f4ef2015e1 (length(prosrc) 34,105 — two
  // emoji fewer than the file body's JS length, md5 identical) on ozucdzovmcqvepbozvqf and on
  // cifwmndunmlxjhyjugxa, md5-equal to the dollar-quoted body in this file (as-is LF), and this file is the
  // function's LAST definer. Production held a99ddecb38b6332a972a787e52443806 (20261022163100) immediately
  // before — the one-command rollback. SECURITY INVOKER, proconfig {search_path=public} and proacl
  // (postgres and service_role only) read in the same query; the function comment digests
  // 1bcf6cb93ee611cdca0bfa7b6fafcd88 on both. Effect, proved before the apply by a read-only replay of the
  // new vendor pass on production: 0 contacts would change and exactly 2 blanks are filled from a pending
  // copy (the two doctors above). After it, two production refreshes each reported listContactsChanged = 0
  // and wrote 0 crm_contacts rows, and both doctors kept their phones; staging's two runs also changed 0.
  "20261022163300_a_pending_copy_fills_the_vendor_blank_in_one_pass.sql",
  // 2026-10-23, written by the session that applied it. The owner chose "Apply it now" in session; both MCP doors
  // answered {"status":"declined"} (staging twice, production once — production read UNCHANGED right after), so it was
  // applied by the standing route, `node scripts/apply-sql-file.mjs <file> staging|production` (production with
  // PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com), which writes NO ledger row: zero rows carry
  // 20261023065727 or this file's name on production. Verified by digest, not presence: md5(pg_proc.prosrc) for
  // public.phoenix_crm_unplanned_a_reviewer_on_the_visit_skips_himself reads e0b917a8cfdbc6fa695fcf8a6a8f320e on
  // ozucdzovmcqvepbozvqf AND cifwmndunmlxjhyjugxa, md5-equal to this file's dollar-quoted body (as-is LF); the
  // function is new, so there is no pre-image body. prosecdef true, proconfig {search_path=public}, proacl
  // {postgres=X/postgres,service_role=X/postgres} on both, so the REVOKE landed; the trigger is enabled and sorts
  // before phoenix_crm_unplanned_waits_for_the_administrator. The data half moved exactly 3 production rows
  // ("applied":true,"count":3) — visits 6cdaac80…, 6955cded… and 722dfe84…, each manager_pending v1 before and
  // sfe_pending v2 after — with 0 still stuck and the 17 correctly routed manager_pending rows untouched. Behaviour
  // proved on staging in rolled-back blocks: a reviewer on the visit (typed ' probe-77 ' against PROBE-77) was born
  // sfe_pending, a reviewer not on it stayed manager_pending.
  "20261023065727_unplanned_reviewer_on_the_visit_goes_to_sfe.sql",
  // ── 2026-10-23, written by the session that applied them: the three per-batch Closing rollup
  // rebuilds take a transaction lock on (their own name, the batch) before their first delete
  // (technical audit P4-04). Both pre-authorized doors refuse a `create or replace function` whose
  // body contains `delete from`: `mcp__supabase-staging__apply_migration` answered {"status":"declined"}
  // twice. So each file was applied with `node scripts/apply-sql-file.mjs <file> staging`, then
  // `PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com node scripts/apply-sql-file.mjs <file>
  // production`, the standing route (.claude/rules/database.md), which writes NO ledger row: ZERO rows
  // carry version 2026102307% on either project, read in the same query as the digests below.
  // Verified by digest, not by presence, on BOTH ozucdzovmcqvepbozvqf and cifwmndunmlxjhyjugxa —
  // md5(pg_proc.prosrc) equals md5 of each file's own dollar-quoted body (as-is LF), each file is the
  // function's LAST definer, and the pre-image (read on both projects before the apply) equals md5 of
  // that same body with the lock line removed, so the lock is the ONLY change:
  //   phx_refresh_sos_fact_rollup                 b5fd564f39865cd41461ddbc59b4f96a, pre-image
  //     ebb17ddca10f481d2bbd27f791990757 (production's prosrc carried CRLF: 070154c9587916e4652fb4e49f742323
  //     as stored, ebb17ddc… with CR removed); rollback body 20260907190000.
  //   phx_refresh_sos_channel_rollup              f6d6dcdc70364bd47244c714e954ec74, pre-image
  //     f1f3a78f24933ed31ebef32f94e13ef4; rollback body 20260928190024.
  //   phx_refresh_sos_distributor_product_rollup  b8721984073f1ec249abb23c387d6045, pre-image
  //     6f6fdd0ec54b1a409673dd205d92f2a0, which is 20260815160000's body without its one in-body
  //     comment line — the file drops that line too, so the body is the live one plus the lock.
  // proconfig {search_path=public,statement_timeout=120s} and prosecdef true unchanged on all three;
  // execute held by service_role only (anon and authenticated false). Effect proved on staging: with
  // the lock held on one connection each function hit lock_timeout (55P03) on another, and two
  // concurrent rebuilds of one batch ran one after the other and left its rows unchanged.
  // Pinned by tests/sos-rollup-refresh-batch-lock.test.ts.
  "20261023070000_phx_refresh_sos_fact_rollup_takes_a_batch_lock.sql",
  "20261023070100_phx_refresh_sos_channel_rollup_takes_a_batch_lock.sql",
  "20261023070200_phx_refresh_sos_distributor_product_rollup_takes_a_batch_lock.sql",
  // 2026-10-23. The Phoenix entry-days cache. The Supabase MCP declined apply_migration — the file
  // carries `drop trigger if exists` and a `delete` inside a function body, which the classifier
  // reads as the statement being run — so it went through scripts/apply-sql-file.mjs, the standing
  // route (AGENTS.md §8), which writes NO schema_migrations row on either project. Neither ledger
  // has anything for this file under any version or name, while all of it is live.
  //
  // 🔴 NOT taken on existence: a `create or replace` is satisfied by an older body. All NINE
  // functions were digested on both projects after applying and are BYTE-FOR-BYTE IDENTICAL — same
  // file, same bodies, same lengths:
  //   phoenix_crm_rep_entry_days                  868452bd59f81869c4eb3c9d6bb7caac, len 99
  //     (pre-image of the live computation it replaced: e1dd0c8255019f15149563b28bf6b68f)
  //   phoenix_crm_rep_entry_days_calc             7d092868286ec525c79dcf92c78d684e, len 1800
  //   phoenix_crm_rep_entry_days_rebuild          f6a5bbdbf965d72d726f6ac58316f68f, len 492
  //   phoenix_crm_rep_entry_days_touch            360cdd934567016c485016c949997649, len 653
  //   phoenix_crm_rep_entry_days_reconcile        2a6ab8c7009c7bec29c34d21dabdef44, len 850
  //   phoenix_crm_rep_entry_days_on_visit         9c9b19c5285cb6bd1676401218ab650b, len 294
  //   phoenix_crm_rep_entry_days_on_day_activity  ef88ee5646ad3e54aadb24a66a71db74, len 300
  //   phoenix_crm_rep_entry_days_on_visit_child   529e772f044395a258af9e53789b7a24, len 563
  //   phoenix_crm_rep_entry_days_on_team_start    dd705dd69ece629fd410489d0658b73f, len 81
  // prosecdef true on all nine, execute held by service_role only (postgres=X service_role=X, so
  // PUBLIC, anon and authenticated hold none). Table phoenix_crm_rep_entry_days_cache exists with
  // relrowsecurity true and both indexes; all five triggers exist and point at the right function;
  // the cron job phoenix-crm-rep-entry-days-reconcile is active on `*/5 * * * *` on both projects.
  //
  // Effect proved on production, not asserted: the backfill wrote 542 rows and the migration's own
  // guard found 0 differences against phoenix_crm_rep_entry_days_calc() before committing — 542 is
  // exactly what the live computation returned beforehand. The trigger was then proved by breaking
  // the cache on purpose: one row deleted for b-124/2026-10-22, a no-op update on that day activity
  // restored it (1 back), and the reconcile then found 0 differences.
  // Pinned by tests/phoenix-crm-rep-entry-days-cache.test.ts.
  "20261023091035_phoenix_crm_rep_entry_days_cache.sql",
  // ── PRODUCTION leg only, 2026-10-23, same shape as the three above. STAGING is NOT drifted and
  // needs no exception: it carries an exact ledger row, version 20261023140000 / name job_leases,
  // recorded by `mcp__supabase-staging__apply_migration`. PRODUCTION has ZERO rows matching either
  // `20261023140%` or name `%job_lease%` — the MCP answered {"status":"declined"} for this file, so
  // it was applied with `PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com node
  // scripts/apply-sql-file.mjs <file> production`, the standing route (.claude/rules/database.md),
  // which writes NO ledger row. This set is global, so one entry covers both legs of the check.
  //
  // Verified by digest and by catalog, never from schema_migrations. md5(pg_proc.prosrc) for
  // public.claim_job_lease is 74aee73622004b3e59c564a10b1e5a70, length 782, IDENTICAL on
  // ozucdzovmcqvepbozvqf and cifwmndunmlxjhyjugxa — the production copy is byte-for-byte the
  // staging copy applied from the same file. proconfig {search_path=pg_catalog, public} and
  // prosecdef false (security invoker, as the file specifies) on both.
  //
  // Production catalog after the apply: public.job_leases present (pg_class.relkind='r'),
  // relrowsecurity true, exactly 1 policy (phx_job_leases_service_role), claim_job_lease present;
  // execute held by service_role only — anon execute false, anon select on the table false. The
  // pre-image is the apply's own NOTICE: `policy "phx_job_leases_service_role" ... does not exist,
  // skipping`, so production genuinely had nothing of this file before it ran. The migration adds
  // one table and one function and changes no existing data.
  //
  // Safe in both orders by design, per the file's own header: the shipping code treats a missing
  // claim_job_lease() as "held", which is the behaviour that was already live.
  "20261023140000_job_leases.sql",
  // ── 2026-10-23, written by the session that applied it: CI's narrow release-gate login (audit P6-02,
  // owner's choice "Narrow login"). `mcp__supabase-staging__apply_migration` answered {"status":"declined"}
  // (the file holds a `drop policy if exists`), so it went the standing route: `node scripts/apply-sql-file.mjs
  // <file> staging`, then production with PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com. That
  // route writes NO ledger row — zero rows named release_gate_writer_login on production, read in the same
  // query as below. A NEW role has no older generation a probe could mistake for it, so it was read by shape
  // on ozucdzovmcqvepbozvqf: role release_gate_writer exists, noinherit, not superuser, no createrole or
  // createdb, no bypassrls, connection limit 5, member of no role; its ONLY table grants are INSERT and
  // SELECT on public.release_gates (0 grants on any other table); policies on release_gates are
  // phx_release_gates_service_role and phx_release_gates_writer. Its login and SCRAM verifier were then set on
  // production only, never in git, and the URL went straight into the repository secret
  // RELEASE_GATE_DATABASE_URL. Proved through the pooler as that login: current_user release_gate_writer, the
  // newest gate row reads, a duplicate insert is a no-op, and reading employees or updating or deleting a gate
  // row is refused 42501. On cifwmndunmlxjhyjugxa the role exists with NO login. Staging had been missing
  // public.release_gates itself (20261019171347 is in this list for its production apply, and an entry here
  // silences every project), so that file was applied to staging first, the same morning.
  "20261023093100_release_gate_writer_login.sql",

  // ── The three findings of the 2026-10-23 09:50 Cairo PRODUCTION sweep (`--no-grace`, so the 48h
  // grace window was stood down and every migration was judged, including the newest). All three
  // were merged to main and absent from ozucdzovmcqvepbozvqf's schema_migrations by version AND by
  // name. Each was established as applied-or-missing FIRST, per the sweep's own instruction, and
  // never from object presence alone.
  //
  // (1) APPLIED, proven by the CHECK it rewrites — not by presence. The file drops and re-adds
  // phoenix_crm_plan_activities_type, and production's live definition is the file's NEW form
  // exactly: activity_type = ANY (ARRAY['meeting','training','conference','admin_work','travel',
  // 'health_day','sales_day','rtd','group_meeting']) — both added values present. The companion
  // phoenix_crm_manager_plan_slots_kind carries 'rtd' and 'group_meeting' too. A CHECK cannot be
  // satisfied by an older generation the way `create or replace` can, so this is positive evidence
  // the file itself ran. Its two functions are security definer with search_path=public on
  // production, as the file specifies.
  "20261021130000_phoenix_crm_plan_activities_rtd_and_group_meeting.sql",

  // (2) APPLIED, proven by the view body. public.crm_visits_unified on production contains both
  // 'group_meeting' and 'rtd' — the worked-day codes this file exists to add; the pre-image view
  // had neither.
  //
  // 🔴 ITS FUNCTION DIGEST DELIBERATELY DOES NOT MATCH, AND THAT IS NOT DRIFT. md5(prosrc) for
  // public.phoenix_crm_rep_entry_days is 868452bd59f81869c4eb3c9d6bb7caac at length 99 — a thin
  // read of public.phoenix_crm_rep_entry_days_cache — because a LATER migration (the entry-days
  // speed work, PR #6274) replaced the body this file installed. A digest comparison against this
  // file therefore CANNOT prove or disprove its apply, and chasing it is wasted work: judge this
  // file by the view, which nothing since has touched.
  "20261021140000_crm_visits_unified_group_meeting_and_rtd_worked_day_codes.sql",

  // (3) WAS GENUINELY MISSING, AND THIS SESSION APPLIED IT — the one of the three that was not a
  // bookkeeping gap. Staging had it complete (table, bucket and an exact ledger row); production
  // had NO table at all (to_regclass('public.device_screen_recordings') was null) while
  // src/lib/devices/headwind/recordings.ts on main already reads it, so the production leg had
  // simply never been run after the 2026-10-22 merge. Applied with
  // `PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com node scripts/apply-sql-file.mjs
  // supabase/migrations/20261022170000_tablet_screen_recordings.sql production`, the standing route
  // (AGENTS.md §8, .claude/rules/database.md), which writes NO ledger row — hence this entry, never
  // a ledger write. Additive only: one new table and one new bucket, nothing existing altered.
  //
  // The pre-image is the apply's own two NOTICEs — `policy "device_screen_recordings_service_role"
  // ... does not exist, skipping` for BOTH public.device_screen_recordings and storage.objects — so
  // production held nothing of this file before it ran.
  //
  // Readback, the file's own, all nine figures as its header specifies: RLS-locked table 1,
  // bucket_limit 268435456, bucket public false, mime video/mp4,video/webm, 1 table policy,
  // 13 columns, 3 indexes, anon SELECT false, and 0 ledger rows matching `20261022170%` or
  // name `%screen_recording%`.
  "20261022170000_tablet_screen_recordings.sql",

  // (4) THE SYSTEM AUDIT LEDGER PAIR — applied to production by the session that built PR #6302
  // (merged 2026-10-23 10:41 Cairo as 37a4b4c82) through `scripts/apply-sql-file.mjs`, the standing
  // route of AGENTS.md §8, which writes NO ledger row. Hence these two entries, never a ledger
  // write. Both files are additive: `create table if not exists`, `create index if not exists`,
  // `create or replace function`, and two `drop trigger if exists` guards that immediately recreate
  // the same triggers — nothing existing is altered or dropped.
  //
  // VERIFIED BY DIGEST, NOT BY OBJECT PRESENCE, on 2026-10-23 ~10:50 Cairo. Presence proves nothing
  // here: every statement in both files is `if not exists` or `create or replace`, so an older
  // generation would satisfy a presence probe just as well. The comparison used is production
  // against STAGING (cifwmndunmlxjhyjugxa), where supabase_migrations.schema_migrations holds exact
  // rows for BOTH versions 20261023051847 and 20261023051848 — so staging's generation IS this
  // file's, and production matching staging byte for byte puts this file's generation on production:
  //   - all 9 functions identical md5(prosrc) AND identical length on both projects, among them
  //     system_audit_page ececec5a027b6a880a6567771453c94f / 10,267 bytes,
  //     system_audit_upsert_occurrences 806fd2a4f56255d8f2f819e126eef67e / 6,655 bytes,
  //     system_audit_transition_status 7723f66b6064e97508d4b2e14cdfa687 / 3,976 bytes;
  //   - all 6 tables identical shape digest — md5 over `attname:format_type:attnotnull` ordered by
  //     attnum — at 16, 11, 39, 9, 17 and 5 columns for system_audit_issues, _issue_fixes,
  //     _occurrences, _status_history, _detector_runs and _watermarks respectively, the same counts
  //     the two files declare;
  //   - RLS on all 6 with exactly 1 service_role policy each, and the two no-update/no-truncate
  //     triggers present on system_audit_status_history.
  // Production's ledger holds 0 rows for either version, which is the expected consequence of that
  // route and the whole reason these entries exist.
  "20261023051847_system_audit_ledger.sql",
  "20261023051848_system_audit_functions.sql",
  // 2026-10-23. The Phoenix contact-truth cache, the sibling of 20261023091035. The Supabase MCP
  // declines this shape (`drop trigger if exists`, and a `delete` inside a function body, which the
  // classifier reads as the statement being run), so it went the standing route — scripts/apply-sql-file.mjs
  // (AGENTS.md §8), staging then production with PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com.
  // That route writes NO schema_migrations row on either project, while all of it is live.
  //
  // 🔴 NOT taken on existence — a `create or replace` is satisfied by an older body. All SIX functions
  // were digested on production after applying:
  //   phoenix_crm_contact_truth_calc         d17fb92d3410fde039f21faf927afc9b, len 608
  //   phoenix_crm_contact_truth_rebuild      ec256cc04f8b6706ffd1538bf70e88bd, len 559
  //   phoenix_crm_contact_truth_touch        90277acd02f8577968476f6fbbc004d1, len 541
  //   phoenix_crm_contact_truth_on_customer  f8d79ad2b3d559f261115b232f9ec4de, len 293
  //   phoenix_crm_contact_truth_on_truncate  1fd94103b72565e42305b8478d8cc5a9, len 81
  //   phoenix_crm_contact_truth_reconcile    92c7b4e4346709e182cc1264214b9846, len 738
  // prosecdef true on all six and 0 of them reachable with a browser key (each ACL is exactly
  // postgres=X/postgres service_role=X/postgres, so PUBLIC, anon and authenticated hold none).
  // crm_contact_phoenix_truth_cache exists with relrowsecurity true and its primary key; the view
  // crm_contact_phoenix_truth still carries security_invoker=true and now reads the cache; both
  // triggers are on phoenix_crm_customers beside its three pre-existing ones; the cron job
  // phoenix-crm-contact-truth-reconcile is scheduled `*/15 * * * *`.
  //
  // Effect proved, not asserted. The backfill wrote 2,285 rows with 0 differences against
  // phoenix_crm_contact_truth_calc() before committing — 2,285 is exactly the number of winners the
  // old hash built (`actual rows=2285` in the pre-change plan) out of 2,287 qualifying customer rows.
  // Measured by delta over two calls of one pg_stat_statements entry each: an ordered first page over
  // an 83-day window went 2,948.2 ms -> 121.1 ms, and a dense single-day page 11.5 ms -> 2.3 ms.
  // The trigger was proved on STAGING, not production, because phoenix_crm_customers carries an AFTER
  // trigger that writes a contact-name row and a no-op update on production would have written one:
  // one cache row deleted for contact 103614, a no-op update (`set speciality = speciality`) put it
  // back, and the reconcile then found 0 differences.
  // Pinned by tests/crm-contact-phoenix-truth-cache.test.ts.
  "20261023140001_crm_contact_phoenix_truth_cache.sql",

  // 2026-10-23. The person-by-HR-id cache, the third of the day's siblings (20261023091035 and
  // 20261023140001 are the other two). Same reason for being here: the file is one `begin; ... commit;`
  // with `drop trigger if exists` and a `delete` inside a function body, which the Supabase MCP's
  // classifier declines, so it went the standing route — scripts/apply-sql-file.mjs (AGENTS.md §8),
  // STAGING FIRST and then production, with PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com.
  // That route writes NO schema_migrations row on either project, while all of it is live.
  //
  // 🔴 NOT taken on existence — a `create or replace` is satisfied by an older body. All FOUR functions
  // were digested on production after applying:
  //   crm_person_by_hr_key_calc         1fc7bdfa3168667f21135e4c7346e454, len 336
  //   crm_person_by_hr_key_rebuild      9cdf3a76ec2d06023e6b4f48e3bb8419, len 351
  //   crm_person_by_hr_key_on_employee  7af97b6efe46e281240d3e50bdc8aff5, len 75
  //   crm_person_by_hr_key_reconcile    42207a80f24115a360a145feeef993bf, len 573
  // prosecdef true on all four and none reachable with a browser key (each ACL is exactly
  // `postgres=X/postgres | service_role=X/postgres`). The table carries 220 rows with RLS on and
  // service_role as its only grantee; the trigger reads
  // `AFTER INSERT OR DELETE OR UPDATE OF hr_id, crm_id, full_name ON public.employees FOR EACH STATEMENT`
  // and is enabled; the cron job crm-person-by-hr-key-reconcile is active on `*/15 * * * *`.
  //
  // Effect proved on production, not asserted. The doors are BYTE-IDENTICAL across the swap: the md5 of
  // every row of crm_visits_unified since 2026-09-01 (25,038 rows) and of crm_checkins_unified over the
  // same window (30,449 rows) is unchanged from the reading taken immediately before applying. Speed, by
  // nine interleaved runs of the old shape and the new against the same day on production: planning
  // 8.76 -> 7.97 ms, execution 16.73 -> 11.09 ms, 1,227 -> 283 buffers. The trigger was then proved by
  // breaking the cache on purpose: one row deleted for hr_key B-10 (220 -> 219), a no-op update on that
  // employee restored it (220), and the reconcile then found 0 differences.
  // Pinned by tests/crm-person-by-hr-key-cache.test.ts.
  "20261023153000_crm_person_by_hr_key_cache.sql",

  // 2026-10-23. phx_refresh_sos_channel_rollup asks for each product's period price ONCE per
  // (product, period) instead of twice per fact row. The file is one `begin; ... commit;` holding a
  // function body with `delete from` in it, which the Supabase MCP's classifier declines (it was
  // declined on production before this was written), so it went the standing route —
  // scripts/apply-sql-file.mjs (AGENTS.md §8), with
  // PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com. That route writes NO
  // schema_migrations row, while the body is live.
  //
  // 🔴 NOT taken on existence — a `create or replace` is satisfied by an older body. Digested on
  // production after applying: md5(prosrc) bb821585b3d85b661f020a3d5a8ab243, length 6,065, prosecdef
  // true, proconfig {search_path=public, statement_timeout=120s}, ACL exactly
  // `postgres=X/postgres | service_role=X/postgres` — so no browser key reaches it. The body
  // contains `period_price` and no longer contains a per-row `phx_factory_price(f.product_code…`
  // call. The advisory batch lock 20261023070100 added is still the first statement, before the
  // delete, as tests/sos-rollup-refresh-batch-lock.test.ts requires.
  //
  // SPEED ONLY, and the answer was proven unchanged BEFORE the file was written. The function is
  // never called to test it (it deletes and re-inserts), so the proof was taken one level in, at the
  // `retail` CTE — the only CTE this migration changes: its whole output computed both ways and
  // compared as TEXT, `(row)::text` through `EXCEPT ALL` in BOTH directions, over the ten largest
  // validated batches, 144,163 fact rows, 0 differences either way. Every statement downstream of
  // `retail` is identical text in the two bodies. The hoisting rule itself was proven over the whole
  // relation: all 295,418 rows of source_of_sales_fact_rollup, 225 distinct (product_code, period)
  // keys, 0 mismatches — the Saginko override (SA001, 111.15 through 2026-09, 170.52 from 2026-10)
  // included, on both sides of its boundary.
  // Pinned by tests/sales-reads-price-each-pair-once.test.ts.
  //
  // STAGING, 2026-11-01. This entry is project-agnostic, so it had silenced the same file missing on
  // cifwmndunmlxjhyjugxa for nine days: pre-image md5(prosrc) f6d6dcdc70364bd47244c714e954ec74, length
  // 5,748, equal to 20261023070100's own body. The staging MCP declined the file too, so it went the
  // same route. After: bb821585b3d85b661f020a3d5a8ab243, length 6,065, equal to this file's body and to
  // production, with prosecdef, proconfig and the ACL as above. No schema_migrations row on either
  // project. Run on staging inside a transaction that always rolled back: batches
  // d8c7bcd2-e4a2-4a31-a88a-3360330bfce8 (17,223 rows) and 17ef39fa-aee8-4662-908d-5420c7e9836a (15,913)
  // gave every number identical to the stored rows; 20 rows each differ in folded_name alone, older
  // rows holding the ﻻ ligature (135 on staging, 0 on production) that phx_fold_customer_name now folds.
  // Staging holds no SA001 sales from 2026-10, so the Saginko boundary rests on production's proof.
  "20261023171200_phx_refresh_sos_channel_rollup_prices_each_product_once.sql",

  // 2026-10-23. phx_marketing_roi_customer_dashboard resolves p_exclude_codes ONCE per call instead
  // of once per candidate row — `<> all (select …)` wrapped as `<> all (array(select …))`, which the
  // planner lifts from a SubPlan to an InitPlan. Its eight siblings in the same change each carry a
  // schema_migrations row (versions 20261023120808–20261023121004, applied through the Supabase MCP);
  // this one does NOT. The file is 44 KB and hand-transcribing a body that size into a tool call is
  // itself a corruption hazard, so it went the standing route — scripts/apply-sql-file.mjs
  // (AGENTS.md §8), which writes NO schema_migrations row while the body is live.
  //
  // 🔴 NOT taken on existence — a `create or replace` is satisfied by an older body. Digested on
  // production after applying: md5(prosrc) c8daa831ed0ee35ffcc10310de2dc4ae, length 42,979 — EQUAL to
  // the md5 of this file's own dollar-quoted body, so the live body is reproducible from the committed
  // text — and `pg_get_functiondef` is byte-identical to this file's `CREATE OR REPLACE … $function$;`
  // block. prosecdef true, proconfig {search_path=public, statement_timeout=45s}, ACL exactly
  // `postgres=X/postgres | service_role=X/postgres`, so no browser key reaches it. The body carries
  // exactly 1 wrapped site and 0 bare ones.
  //
  // The `revoke execute … from public, anon, authenticated` / `grant execute … to service_role` pair
  // at the foot of the file was NOT run on production and deliberately so: it is the whole-repo
  // SECURITY DEFINER rule that `check:migrations` enforces, and it is a provable NO-OP against the ACL
  // read above — PUBLIC, anon and authenticated hold no entry to revoke, and service_role already
  // holds EXECUTE. It makes the file state its own ACL instead of relying on this note; a replay
  // reaches the same two-entry ACL either way.
  //
  // 🔴 APPLIED TWICE, on purpose. The first apply carried CRLF into prosrc: this was the one file of
  // the nine written with CRLF line endings (895 of them), while .gitattributes (`* text=auto eol=lf`)
  // commits LF — so the committed text and the live body would have differed by 895 bytes and digested
  // unequal, and the digest above is the whole point of this entry. Normalized to LF (46,660 → 45,765
  // bytes, exactly 895 CR removed) and re-applied; prosrc now holds no CR at all.
  //
  // SPEED ONLY, and proven so BEFORE the migration was written. The change is SEVEN BYTES — a
  // normalized diff against the pre-change `pg_get_functiondef` dump shows one line gaining `array(`
  // and one gaining `)`, and nothing else. The verdicts the dashboard returns are token-for-token
  // identical across the swap: awaiting_data 1/1, no_data 27/27, on_track 22/22, behind 29/29,
  // roi_duration_months 6/6, latest_validated_period 1/1 — so the `awaiting_data` arm that the
  // marketing-roi module memory protects is untouched. This read is the one of the nine with NO
  // short-circuit guard, which is correct and must not be "fixed": unnest(NULL) yields no rows,
  // ARRAY() over no rows yields an EMPTY array rather than NULL, and `v <> all ('{}')` is TRUE.
  // Pinned by tests/sales-reads-exclude-codes-once.test.ts.
  "20261023180800_phx_marketing_roi_customer_dashboard_resolves_the_excluded_codes_once.sql",

  // 2026-10-23. `drop index concurrently if exists public.ireports360_visits_agent_idx` — a btree on
  // (agent_hr_id) that was a strict prefix of perf_ireports360_visits_agent_hr_id_visit_date_crm, so
  // every insert into the 1.6-million-row visits mirror maintained both. It went the standing route,
  // scripts/apply-sql-file.mjs (AGENTS.md §8), which writes NO schema_migrations row: `drop index
  // concurrently` cannot run inside a transaction block, so the Supabase MCP's apply_migration — which
  // wraps its body — could not carry it.
  //
  // 🔴 NOT taken on the script's own exit code. Read back on PRODUCTION afterwards from
  // pg_stat_user_indexes: public.ireports360_visits lists 12 indexes and ireports360_visits_agent_idx
  // is not among them, while the surviving perf_ireports360_visits_agent_hr_id_visit_date_crm carries
  // 67,874 scans — so the planner moved to it rather than losing the access path. Reproducing the
  // departed-agent scan on the live-shaped input confirmed the new plan: `Index Scan using
  // perf_ireports360_visits_agent_hr_id_visit_date_crm`, same row count, same answer.
  //
  // SPEED ONLY, and it bought less than was predicted — 189 ms before the drop against 220 ms after,
  // the same shape either way. That measurement is the reason 20261023190000 caches the pairs instead:
  // the cost is the ~136,000-row scan the `distinct` forces, not the index it uses. What the drop did
  // buy is real and small: 2.8 MB back and one less index written on every insert.
  //
  // STAGING NEVER HAD IT — and the earlier wording of this entry, which said staging still carried
  // the index and the two projects therefore differed, was an ASSUMPTION written without reading
  // staging. Read back on 2026-10-23 after 20261023190000 merged: public.ireports360_visits on
  // STAGING lists 12 indexes, exactly as production does after the drop, and none of them is named
  // ireports360_visits_agent_idx. Staging also RECORDS this migration (schema_migrations carries
  // 20261023181000) because .github/workflows/staging-migrate.yml applies every merged migration
  // there on the push to main — staging is automatic, production is the deliberate hand step. No
  // staging run is owed, and this file's absence from PRODUCTION's ledger is the whole exception.
  "20261023181000_crm_drop_duplicate_visits_agent_index.sql",
  // 2026-10-23. The admin "Reset module data" button, which had never deleted a row. The file is one
  // `begin; ... commit;` opening with
  // `drop function if exists public.phx_admin_reset_module_data(text)`, which the Supabase MCP's
  // classifier declines (it was declined on production before this was written), so it went the
  // standing route — scripts/apply-sql-file.mjs (AGENTS.md §8), STAGING AND PRODUCTION, with
  // PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com. That route writes NO
  // schema_migrations row on either project (production's ledger holds 20261023180700 and nothing
  // for 20261023181500), while the body is live on both. It was applied as 20261023181000 and
  // renamed here: #6354 landed 20261023181000_crm_drop_duplicate_visits_agent_index.sql on main
  // with the same stamp. The rename is free precisely BECAUSE this route writes no ledger row —
  // nothing in either database names the file, only the body, whose md5 is below.
  //
  // 🔴 NOT taken on existence — a `create or replace` is satisfied by an older body. Digested after
  // applying, and IDENTICAL on the two projects: md5(prosrc) 326aaf9fcdfaf0c4671d81c979e5bdc7,
  // length 12,425 — the same md5 as this file's own body between its $function$ tags with LF
  // endings, so the running function is this file byte for byte, not a near-miss. prosecdef true,
  // proconfig {search_path=public}, ACL exactly `postgres=EXECUTE | service_role=EXECUTE`, so no
  // browser key reaches it. Exactly ONE signature survives the apply —
  // `phx_admin_reset_module_data(text, integer)`; the one-argument form is gone, which is what
  // stops PostgREST refusing the call as ambiguous once the return shape changed.
  //
  // THE DEFECT IT REPAIRS WAS PROVEN OVER PostgREST, not asserted from the two earlier incidents.
  // PostgREST connects as `authenticator`, which preloads safeupdate; a direct SQL session does not,
  // which is why nineteen bare `delete from <table>` statements worked in every editor and had never
  // once run from the app. Measured on staging the same day with two throwaway SECURITY DEFINER
  // functions over a scratch table, called with the service-role key through
  // cifwmndunmlxjhyjugxa.supabase.co/rest/v1/rpc: the bare delete answered HTTP 400, SQLSTATE 21000,
  // "DELETE requires a WHERE clause"; the WHERE-scoped one answered HTTP 200 having deleted 1 row.
  // SECURITY DEFINER does not exempt it — the hook is session-level. Both probes and the scratch
  // table were dropped afterwards.
  //
  // DELIBERATELY NOT EXERCISED AGAINST REAL DATA on either project: the function's whole job is to
  // delete, production has no PITR, and staging's 317,806 Source of Sales rows and 42,085 weekly
  // rows are a test corpus nobody asked to clear (both counts re-read unchanged after the probes).
  // Its shape is pinned instead — nine batch-scoped deletes, the `l.unlocked_at is null` lock join,
  // marketing_request_events never a target, direct_order_marketing_offsets ahead of
  // marketing_requests, and all 27 tables declared in RESET_GROUPS in FK order.
  // Pinned by tests/admin-reset-module-data.test.ts.
  "20261023181500_admin_reset_module_data_deletes_actually_run.sql",
  // ── 2026-10-23 ~19:10 Cairo, written by the session that applied them (PR #6359, owner's merge word
  // "merge 6359 when green"). mcp__supabase-production__apply_migration answered {"status":"declined"}
  // for the screens file, so both went through scripts/apply-sql-file.mjs, the standing route
  // (.claude/rules/database.md), which writes NO schema_migrations row: zero rows carry either
  // version or name on ozucdzovmcqvepbozvqf or cifwmndunmlxjhyjugxa, read after the apply.
  // The screens file: readback on BOTH projects — relrowsecurity true, bucket user-error-screens
  // public false with file_size_limit 1572864, system_audit_issues_family_check allows 'user_screen',
  // grants to service_role (and the owner) only, zero to anon or authenticated, both service_role
  // policies present. New table and bucket, no existing row changed.
  // The index file: production got `CREATE INDEX CONCURRENTLY IF NOT EXISTS
  // phoenix_crm_touch_trail_day_id_idx ON public.phoenix_crm_touch_trail (visit_day, id)` run on its
  // own (no transaction) so the 425 MB table every tablet writes to never waited on a lock; pg_index
  // reads indisvalid true, indisready true, 55 MB. Staging got the file as written; indisvalid true.
  "20261023203000_user_error_screens.sql",
  "20261023210000_phoenix_crm_touch_trail_day_id_index.sql",
  // 2026-10-23, the Super Admin's delete tool (PR 6396), applied BEFORE its PR merged — safe with the code
  // then serving, which never calls it. mcp__supabase-staging__apply_migration answered {"status":"declined"}
  // four times (the server's own guardrail on a function body that contains a delete), so both projects
  // went through the standing route: `node scripts/apply-sql-file.mjs <file> staging` (cifwmndunmlxjhyjugxa),
  // then production (ozucdzovmcqvepbozvqf, PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com);
  // each printed {"applied":true,"count":0} and wrote no ledger row. A NEW table and a NEW function have no
  // older generation a probe could mistake for them. Read after the apply on BOTH projects: md5(prosrc) of
  // public.phoenix_crm_admin_delete is eed119d96050fa4bad83c41caa7538cf; prosecdef true; EXECUTE for
  // postgres and service_role only; phoenix_crm_admin_deletions has RLS on, 0 rows, and no grant to anon,
  // authenticated or PUBLIC. On staging a rep plan and a visit were deleted inside a transaction that was
  // rolled back on purpose: one copy row each, the missing-id case answered phoenix_crm:visit_not_found,
  // and the copy table read 0 rows afterwards.
  "20261023223001_phoenix_crm_admin_delete_anything.sql",
  // 2026-10-23, the same tool taught two more kinds (a month's plan with its weeks, a district manager's own
  // single visit), applied BEFORE its PR merged and safe with the code then serving, which never passes either
  // kind. Both projects through the standing route (`node scripts/apply-sql-file.mjs <file> staging`, then
  // production with PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com), each printing
  // {"applied":true,"count":0} and writing no ledger row. It REPLACES the function and widens one CHECK, so the
  // proof is the new body, not the name: md5(prosrc) of public.phoenix_crm_admin_delete is
  // 40ad26edf53e3f341aa845afdc093e64 on BOTH staging and production; prosecdef true; EXECUTE for service_role
  // only (anon and authenticated false); phoenix_crm_admin_deletions_kind_check lists all six kinds; 0 copy rows.
  // On staging a month (its week, header and event) and a manager visit were deleted inside a transaction rolled
  // back on purpose: one copy row each for the month, its week and the visit, and nothing left behind.
  "20261023232001_phoenix_crm_admin_delete_month_and_manager_visit.sql",

  // Applied 2026-10-23 through scripts/apply-sql-file.mjs (the supabase-staging MCP declined the call), to
  // staging cifwmndunmlxjhyjugxa and then production ozucdzovmcqvepbozvqf (PHOENIX_POOLER_HOST=aws-1), so
  // neither ledger has a row for it. Proven by DIGEST, not presence: md5(pg_proc.prosrc) for
  // public.phoenix_crm_save_manager_plan_slot is 0737f463f34b0b6438bd0121c1a7b4dc on BOTH projects, equal to
  // the md5 of this file's own function body (the pre-image on production was aa335a2dbe2e91aed813f778feb76e1c,
  // 20261021130000's body). The CHECK phoenix_crm_manager_plan_slots_kind carries 'with_dm', the column
  // dm_visit is jsonb and phoenix_crm_manager_plan_slots_dm_visit exists on both; EXECUTE is postgres and
  // service_role only. Staging behaviour proven in a rolled-back block: a with_dm half-day saved with two
  // areas; a district manager's refused (manager_plan_bad_kind); no areas, and dm_visit on an admin
  // half-day, refused (bad_input).
  "20261023233000_phoenix_crm_manager_plan_with_dm.sql",


  // Applied 2026-10-23 through scripts/apply-sql-file.mjs, to staging cifwmndunmlxjhyjugxa and then production
  // ozucdzovmcqvepbozvqf (PHOENIX_POOLER_HOST=aws-1); each printed {"applied":true,"count":0} and wrote no
  // ledger row. Proven by DIGEST: md5(pg_proc.prosrc) for public.phoenix_crm_save_manager_plan_slot is
  // 1aab131d78c5b6f86c04f7002a4d7bda on BOTH projects, equal to this file's own function body (the pre-image on
  // both was 0737f463f34b0b6438bd0121c1a7b4dc, 20261023233000's body); EXECUTE for postgres and service_role
  // only; phoenix_crm_manager_plan_slots_kind carries 'with_senior' and phoenix_crm_manager_plan_slots_senior_visit
  // exists on both; production's 239 slot rows unchanged, none with senior_visit. Staging behaviour proven in a
  // block that raised to roll back: a district manager's with_senior half-day saved; the same from a national
  // manager refused (manager_plan_bad_kind); no areas, naming himself, and senior_visit on an admin half-day
  // refused (bad_input).
  "20261023233002_phoenix_crm_manager_plan_with_senior.sql",

  // (5) THE VISITS DOOR'S ONE SCAN — applied 2026-10-23, staging first then production, through
  // `scripts/apply-sql-file.mjs`, the standing route of AGENTS.md §8 for a shape the Supabase MCP
  // declines. That route writes NO ledger row, hence this entry rather than a ledger write. The file
  // holds ONE statement, `create or replace view public.crm_visits_unified` — it adds nothing, drops
  // nothing and alters no table, and Postgres itself refuses a replace that would change a column's
  // name, type or position, so the 63 columns cannot have moved.
  //
  // VERIFIED BY DIGEST ON BOTH PROJECTS, not by the view merely existing. `md5(pg_get_viewdef(...))`
  // is d2c30e87b6e678076a86859594ec0323 at 13,373 bytes on production (ozucdzovmcqvepbozvqf) AND on
  // staging (cifwmndunmlxjhyjugxa) — the same generation on both, which is this file's. The door still
  // reads `security_invoker=true` with postgres and service_role as its only grantees, names
  // ireports360_visits ONCE (it was twice) and phoenix_crm_rep_entry_days() not at all (it was once).
  // Production's ledger holds 0 rows matching `20261023170%`, the expected consequence of that route. The file was applied
  // under the stamp 20261023170000 and renamed to 20261024005000 before merging, because the closing matrix
  // migration took 20261023170000 on main first; the SQL is byte-identical and idempotent (create or replace).
  //
  // Effect proved on production, not asserted. OUTPUT: the md5 of every row of the door over the whole
  // of its history is unchanged from the pre-apply reading — 87,709 rows before 2026-07-01
  // (7d9f712a27c26501bd8785cec0e66b4b) and 35,736 rows in July–August
  // (dd3d6aaf643c0828a8e6e3217d046053), both re-read after applying and both identical, with the
  // 25,039-row window from September on proved identical against a probe copy of the new body before
  // the swap. SPEED, nine interleaved runs of each shape against the same moment: one day 17.0 -> 7.8 ms,
  // a month straddling the first team start 563.1 -> 320.5 ms, a month entirely before it unchanged.
  // Pinned by tests/phoenix-crm-visits-everywhere.test.ts. Account: docs/crm-visits-door-one-scan.md.
  "20261024005000_crm_visits_unified_one_scan.sql",

  // (6) THE CONTACT REFRESH'S HASHED HAND-OVER AND ITS ONE REP-DOOR READ — applied 2026-10-24, staging
  // first then production, through `scripts/apply-sql-file.mjs`, the standing route of AGENTS.md §8 for a
  // body the Supabase MCP declines (this one carries a `delete from` and seven `drop table if exists
  // pg_temp.…`). That route writes NO ledger row, hence this entry rather than a ledger write: production
  // (ozucdzovmcqvepbozvqf) and staging (cifwmndunmlxjhyjugxa) each hold 0 rows matching `20261024160%` in
  // supabase_migrations.schema_migrations, read after the apply. The file holds ONE statement,
  // `create or replace function public.crm_contact_master_refresh(boolean)` — no table, view, grant or
  // policy is touched, and every `drop table` in it is a `pg_temp.` scratch table the body itself creates
  // and drops inside its own call.
  //
  // VERIFIED BY DIGEST ON BOTH PROJECTS, not by the function merely existing — `create or replace` makes
  // presence worthless as evidence. `md5(prosrc)` is a6dc9541576a7a474ad6a49c60013f34 at 36,805 chars on
  // production AND on staging, equal to this file's own dollar-quoted body; the pre-image on both was
  // 0e5d0165b9ca43d1fb4a18f4ef2015e1, 20261022163300's body. `prosecdef` is still false and `proconfig`
  // still {search_path=public}. `public.crm_contact_fold_grade` is deliberately NOT dropped even though
  // its five call sites are now inlined: its other callers keep it, and removing the SET clause that
  // blocks inlining would raise the `function_search_path_mutable` advisor finding that
  // `scripts/check-advisor-baseline.ts` fails on.
  //
  // Effect proved on production, not asserted. OUTPUT: from the same committed state, each body run once
  // in its own rolled-back transaction, twice each — both wrote exactly one assignment row and the SAME
  // one (agent PD-0018, contact 1000049049, Pharmacy, no grade, open from 2026-10-24), and the full-row
  // checksum of `crm_contacts` was e3044c1025dc165bef1258ad931c4af4 on all four runs; the returned jsonb
  // was equal field for field, the per-statement `ms` map aside. SPEED, old and new alternating four
  // times each with the pending row settled first so every timed run is the quiet tick the cron pays:
  // 1,320 · 1,300 · 1,357 · 1,435 ms against 770 · 769 · 831 · 818 ms — median 1,338 -> 794 ms, 41% off a
  // job that runs about 96 times a day, roughly 52 seconds of database time. Pinned by
  // tests/crm-contact-master-refresh-speed.test.ts (section 3c) and tests/doctor-lists-everywhere.test.ts.
  // Account: docs/crm-contact-master-refresh-speed.md.
  "20261024160000_the_contact_refresh_hashes_its_handover_and_reads_the_rep_door_once.sql",

  // (7) THE VISITS DOOR STOPS JOINING A TABLE MOST READS NEVER READ — applied 2026-10-24, staging first
  // then production, through `scripts/apply-sql-file.mjs`, the standing route of AGENTS.md §8 for a body the
  // Supabase MCP declines. That route writes NO ledger row, hence this entry rather than a ledger write:
  // production (ozucdzovmcqvepbozvqf) and staging (cifwmndunmlxjhyjugxa) each returned
  // {"applied":true,"count":0} and hold 0 rows matching `20261024180%` in
  // supabase_migrations.schema_migrations, read after the apply. The file holds ONE statement, `create or
  // replace view public.crm_visits_unified with (security_invoker = true)`, and ONE word of it differs from
  // 20261024005000's: the Phoenix branch's `join public.phoenix_crm_customers` is now a `left join`. No
  // table, column, grant or policy is touched.
  //
  // 🔴 VERIFIED BY DIGEST ON BOTH PROJECTS, AND READ IN THE RIGHT FORM. `create or replace view` makes the
  // view merely existing worthless as evidence, so the proof is
  // md5(pg_get_viewdef('public.crm_visits_unified'::regclass)) = 7265552a2f2a4b977e806418a561bd43 at 13,574
  // bytes, equal on production AND staging. 🔴 `pg_get_viewdef` HAS TWO FORMS AND THEY HASH DIFFERENTLY —
  // the regclass form above, and the text form `pg_get_viewdef('public.crm_visits_unified')`, which read
  // 6f7ac3a1e7cfa19b0c03d9fe51b88bd6 on the same body. A reading in one form compared against a reading in
  // the other looks exactly like drift between the two projects and is not; the pre-change digest
  // d2c30e87b6e678076a86859594ec0323 at 13,373 bytes was taken in the text form, so it may only be compared
  // with another text-form reading. `security_invoker` is still on and the view still carries its 14 grant
  // rows, read after the apply.
  //
  // WHY: the inner join could never drop a row — phoenix_crm_visits.customer_id is NOT NULL and its FK to
  // phoenix_crm_customers(id) is VALIDATED — but Postgres only removes a join it can prove optional, and
  // that proof is a LEFT join to a unique key whose columns nothing selects. It will not use a foreign key
  // to reach the same conclusion about an INNER one. So a read wanting none of the four columns `customer`
  // feeds (contact_crm_id, contact_name, speciality, crm_contact_grade) now gets no join at all, and a read
  // wanting any of them gets the same join and the same rows as before.
  //
  // IDENTITY, proved not asserted, and twice. Both bodies as temp views in ONE production session returned
  // all 148,814 rows of the door — all time, every column, ordered and hashed whole — with the SAME md5
  // 5a6976bcf91c994b338516e4d8c690ca, the customers node appearing in the old plan once and in the new one
  // not at all. Across the apply: 1-23 Oct on production, 10,111 rows, md5
  // 77c08f610a785e59b806b9f78ba5dc3e before and after; the whole view on staging, 126,330 rows, md5
  // 7f3ba1fef909960a9008ecb7ca8abc63 before and after.
  //
  // EFFECT, measured as a true A/B on the 8-column month read the field-activity pages page through, both
  // bodies alternating in one session, six runs each with the first of each discarded: buffers 22,508 ->
  // 8,808 (-13,700, -61%), server-side 182.712 -> 150.160 ms, round trip 358.336 -> 284.688 ms. 🔴 THE
  // BUFFERS ARE THE WIN, NOT THE MILLISECONDS: the 13,700 match what the branch shed in isolation and are
  // stable, while an earlier alternating pass of the same A/B put the round trip at 227.527 -> 213.059 ms
  // (-6.4%) — so the branch's -59% in isolation does not reach the whole door. Pinned by
  // tests/phoenix-crm-visits-everywhere.test.ts, which asserts the left join whole because
  // "join public.phoenix_crm_customers" is a substring of it and the single includes() it replaced went
  // green on either word. Account: docs/crm-visits-door-one-scan.md.
  "20261024180000_the_visits_door_stops_joining_customers_it_never_reads.sql",

  // (8) THE TRAINING MANAGER PLANS A WEEK — applied 2026-10-24, staging first then production, through
  // `scripts/apply-sql-file.mjs`, the standing route of AGENTS.md §8: the staging Supabase MCP answered
  // {"status":"declined"} three times on the file's body (the replaced function CONTAINS a `delete from` and
  // the file a `revoke`). Production (ozucdzovmcqvepbozvqf) returned {"applied":true,"count":0} and holds NO
  // ledger row for 20261024233000, hence this entry rather than a ledger write; staging
  // (cifwmndunmlxjhyjugxa) carries one, inserted inside the same transaction as the body.
  //
  // VERIFIED BY DIGEST ON BOTH PROJECTS: md5(pg_proc.prosrc) of phoenix_crm_save_manager_plan_slot =
  // fb531b177a38cfbdc9bebc95e9204de3 on production AND staging (production read 1aab131d78c5b6f86c04f7002a4d7bda
  // before), prosecdef true, proacl {postgres=X/postgres,service_role=X/postgres}. The five checks read back
  // in their new form — planner_kind admits tm, seat_unless_pm is planner_kind in (pm, tm), slots_kind holds
  // with_area, dm_visit is kind in (with_dm, with_area), and slots_region exists — and scope_region_code is a
  // nullable text column. No row is written: production held 30 plans and 262 half-days before and after.
  // Pinned by tests/phoenix-crm-training-manager-plan.test.ts. Account: docs/phoenix-crm-manager-plan.md,
  // "The Training Manager".
  "20261024233000_phoenix_crm_manager_plan_training_manager.sql",

  // Applied 24 Oct 2026 through scripts/apply-sql-file.mjs (the standing route) on STAGING and PRODUCTION,
  // after the Supabase MCP's apply_migration came back {status: declined} on both, three times, the third
  // right after the owner chose "apply via MCP again". The route writes no ledger row, hence this entry.
  // The file is additive and defines no function, so there is no prosrc digest to compare; the evidence is
  // the three objects it creates, read live on BOTH projects after the apply, identical on each:
  // notification_send_reviews.held_attachments = jsonb, nullable YES; storage.buckets
  // 'notification-held-attachments' = public false, file_size_limit 41943040, allowed_mime_types null;
  // pg_policy notification_held_attachments_service_role = roles {service_role}, cmd * (ALL).
  "20261025003000_held_notifications_keep_their_attachments.sql",

  // THE DOUBLE-VISIT PARTNERS — applied 25 Oct 2026, staging first then production (the owner's choice),
  // through scripts/apply-sql-file.mjs, the standing route of AGENTS.md §8: the staging Supabase MCP's
  // apply_migration answered {"status":"declined"} twice. Production (ozucdzovmcqvepbozvqf) returned
  // {"applied":true} and holds NO ledger row for 20261025020000, hence this entry rather than a ledger write.
  //
  // VERIFIED BY DIGEST ON BOTH PROJECTS: md5(pg_proc.prosrc) of phoenix_crm_save_manager_plan_slot =
  // 21565d063301074025b3b321fe13d610 on production AND staging, equal to the file's body (production read
  // fb531b177a38cfbdc9bebc95e9204de3 before — the body of 20261024233000), prosecdef true, proacl
  // {postgres=X/postgres,service_role=X/postgres}. The check phoenix_crm_manager_plan_slots_kind reads back
  // widened: with_senior holds its district scope both-or-neither. No row is written: production held 0
  // with_senior half-days before. A rolled-back staging test answered nsm=t, tm=manager_plan_bad_kind and a
  // product manager without a district bad_input. Pinned by tests/phoenix-crm-manager-plan.test.ts.
  "20261025020000_phoenix_crm_manager_plan_double_visit_partners.sql",

  // DEDUCTIONS CATEGORIES IS SERVER-ONLY (audit 2026-10-26, point 12) — applied 26 Oct 2026 ~10:28 Cairo on
  // PRODUCTION through scripts/apply-sql-file.mjs, the standing route of AGENTS.md §8: the production
  // Supabase MCP's apply_migration answered {"status":"declined"} twice, the second right after the owner
  // chose "Apply it now". Production (ozucdzovmcqvepbozvqf) returned {"applied":true,"count":0} and holds NO
  // ledger row for 20261026120500, hence this entry rather than a ledger write; staging (cifwmndunmlxjhyjugxa)
  // carries its own row, 20261026120500 deductions_categories_is_server_only, recorded by the MCP.
  //
  // The file defines no function, so there is no prosrc digest to compare; the evidence is the end state it
  // asserts, read live on BOTH projects after the apply, identical on each: anon and authenticated hold none
  // of SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER on public.deductions_categories;
  // pg_policies for the table = 0 (production read 1 — the using(true) deductions_categories_authenticated_
  // select — and authenticated SELECT = true just before); relrowsecurity true; service_role holds all seven.
  // No row is written: production holds 10 categories after. Pinned by tests/schema-shape-browser-
  // reachability.test.ts (the open-policy allowlist in scripts/check-schema-shape.ts is empty).
  "20261026120500_deductions_categories_is_server_only.sql",

  // WEEKLY DIRECT ORDERS COUNT AT THE PHARMACY'S OWN AREA — applied 26 Oct 2026 on STAGING then PRODUCTION
  // through scripts/apply-sql-file.mjs, the standing route of AGENTS.md §8: the Supabase MCP's apply_migration
  // answered {"status":"declined"} on both projects for this body (it contains a `delete` and a `revoke`).
  // The route writes no ledger row on either project, hence this entry rather than a ledger write.
  //
  // VERIFIED BY DIGEST ON BOTH PROJECTS: md5(pg_proc.prosrc) of phx_rebuild_direct_order_weekly_batches =
  // 9b245448a8a4febbba047e2949fd60da on production AND staging, equal to the file's own body; prosecdef true,
  // proacl {postgres=X/postgres,service_role=X/postgres}. Each month from 2026-08 was then rebuilt once:
  // production 56 region-only rows (backup schema weekly_backup_20261026) became 81 rows, every one carrying
  // its pharmacy's area, with every month's value and units unchanged (EGP 1,506,624.57 in all). Pinned by
  // tests/weekly-direct-orders-injection.test.ts.
  "20261026160001_weekly_direct_orders_count_at_the_pharmacys_area.sql",

  // THE CRM MASTER LIST'S DECISIONS TABLE — applied 26 Oct 2026 on STAGING then PRODUCTION through
  // scripts/apply-sql-file.mjs, the standing route of AGENTS.md §8, on the owner's word in chat: the Supabase
  // MCP's apply_migration answered {"status":"declined"} on staging three times (both servers). The route
  // writes no ledger row on either project, hence this entry rather than a ledger write.
  //
  // The file defines no function, so there is no prosrc digest; the evidence is the end state, read live on
  // BOTH projects after the apply and identical on each: public.phoenix_crm_master_decisions present,
  // relrowsecurity true, 0 rows, table grants held by postgres and service_role only (anon and authenticated
  // none), one policy (phoenix_crm_master_decisions_service_role, to service_role). The pre-image is the
  // apply's own NOTICE — the policy "does not exist, skipping" — so neither project had the table before.
  // Purely additive: production's phoenix_crm_places still holds its 3,817 rows. Pinned by
  // tests/phoenix-crm-master-list.test.ts (the migration's grants).
  "20261026165500_phoenix_crm_master_decisions.sql",

  // THE HELD SALARY RELEASE LEDGER — applied 26 Oct 2026 on STAGING then PRODUCTION through
  // scripts/apply-sql-file.mjs, the standing route of AGENTS.md §8, on the owner's word in chat ("Table first,
  // then merge"): the Supabase MCP's apply_migration answered {"status":"declined"} on staging four times, the
  // last right after the owner chose "Retry Supabase prompt". The route writes no ledger row on either
  // project, hence this entry rather than a ledger write.
  //
  // The file defines no function, so there is no prosrc digest; the evidence is the end state, read live on
  // BOTH projects after the apply and identical on each: public.automated_payroll_held_releases present,
  // relrowsecurity true, 4 policies, 3 indexes, anon SELECT false, 0 rows on production. Production's
  // to_regclass read null just before, so the table is new. Purely additive. Pinned by
  // tests/automated-payroll-held-release.test.ts.
  "20261026190000_automated_payroll_held_release_ledger.sql",

  // PART 1 WITHHELD, DEFER PAY AND "PART 1 NOT PAID" — applied 26 Oct 2026 on STAGING then PRODUCTION through
  // scripts/apply-sql-file.mjs (production with PHOENIX_POOLER_HOST=aws-1-eu-central-1), the standing route of
  // AGENTS.md §8: the Supabase MCP's apply_migration answered {"status":"declined"} on staging, as it did for
  // the held-release ledger above. The route writes no ledger row on either project, hence this entry.
  //
  // No function, so no prosrc digest; the evidence is the end state, read live on BOTH projects after the apply
  // and identical on each: 3 new automated_payroll_draft_rows columns, the pay-deferral check constraint,
  // public.automated_payroll_held_part1_unpaid present, relrowsecurity true, 4 policies, 2 indexes, anon SELECT
  // false, 0 rows. Purely additive. Pinned by tests/automated-payroll-pay-deferral.test.ts.
  "20261026210000_automated_payroll_part1_withheld_and_pay_deferral.sql",

  // THE MANAGER PLAN'S WITH-SENIOR CUSTOMERS — applied 27 Oct 2026 on STAGING then PRODUCTION through
  // scripts/apply-sql-file.mjs (production with PHOENIX_POOLER_HOST=aws-1-eu-central-1), the standing route of
  // AGENTS.md §8, on the owner's word in chat ("apply the 6591 migration with the repo SQL script"): the
  // Supabase MCP's apply_migration answered {"status":"declined"} three times, the last right after the owner
  // chose to allow the prompt. The route writes no ledger row on either project, hence this entry.
  //
  // The file replaces one function. Read live on BOTH projects after the apply and identical on each:
  // md5(pg_proc.prosrc) of public.phoenix_crm_save_manager_plan_slot = 321180ab68a49933e9c95016f3a728c4,
  // prosecdef true; both read 21565d063301074025b3b321fe13d610 (the old body) just before. No table, grant or
  // row changes. Pinned by tests/phoenix-crm-manager-plan.test.ts.
  "20261027140000_phoenix_crm_manager_plan_with_senior_doctors.sql",

  // A VISIT CARRIES ANY MIX OF COMPANIONS — applied 27 Oct 2026 on STAGING then PRODUCTION (about 19:40 Cairo)
  // through scripts/apply-sql-file.mjs (production with PHOENIX_POOLER_HOST=aws-1-eu-central-1), the standing
  // route of AGENTS.md §8, chosen over the MCP because the file is 75 KB. The route writes no ledger row on
  // either project, hence this entry.
  //
  // Read live on BOTH projects after the apply and identical on each: md5(pg_proc.prosrc) of
  // phoenix_crm_save_visit d7312d2b84a1bc488066e73acd974e39, phoenix_crm_admin_edit_visit
  // 508d3bc707d2e512f9e4547d64c2a30d, phoenix_crm_admin_enter_visit c7e22eef4dd9d207cc14625e0e573121,
  // phoenix_crm_set_visit_companions 14bccd0bea28b098b3a7397fd1c63c0f, phoenix_crm_visit_companion_ids
  // 87f8defdc5291cf081bc7a7ab5d3ec87 — each md5-equal to its dollar-quoted body in this file (LF); all five
  // prosecdef true, EXECUTE held by postgres and service_role only. Production also: the reviewer trigger
  // function 0524b2ac1f760a247156d4632f75f24c (equal to the file), phoenix_crm_visit_companions
  // relrowsecurity true with grants to postgres and service_role only and 0 rows, the participants check
  // without the senior-XOR-product-manager arm, crm_visits_unified carrying companion_hr_ids (151,086 rows,
  // a PostgREST read answering 200). No backfill, no row changed. Pinned by
  // tests/phoenix-crm-visit-any-companions.test.ts.
  "20261027185332_phoenix_crm_visit_any_companions.sql",

  // INTERVIEWS, A DAY KIND BESIDE ADMIN WORK — applied 29 Oct 2026 on STAGING then PRODUCTION (about 23:10 Cairo)
  // through scripts/apply-sql-file.mjs (production with PHOENIX_POOLER_HOST=aws-1-eu-central-1), the standing
  // route of AGENTS.md §8, on the owner's word in chat ("Use the repo's SQL script"): the Supabase MCP's
  // apply_migration answered {"status":"declined"} three times on staging, the last right after the owner chose to
  // allow the prompt. The route writes no ledger row on either project, hence this entry.
  //
  // Read live on BOTH projects after the apply and identical on each, each md5-equal to its dollar-quoted body in
  // this file (LF), all four prosecdef true: md5(pg_proc.prosrc) of phoenix_crm_save_day_activity
  // f87d74c06342162f3a3045c03e081631, phoenix_crm_save_plan_activities 85196f4e3383491a0544e6a12ccdf6e3,
  // phoenix_crm_save_manager_plan_slot 12517968b9e92d3dd440aa6caab49bee, phoenix_crm_rep_entry_days_calc
  // 2db9c21d0d79b49e8520946f69c3ae42. The three checks and crm_visits_unified's definition name 'interviews'.
  // Production's crm_visits_unified for 1–29 Oct read identical before and after (ireports360 5,927 rows, phoenix
  // 7,757 — the one row more after it is a Sales day recorded at 23:06, outside the hash it was compared on).
  // No row changed. Pinned by tests/phoenix-crm-day-activities.test.ts.
  "20261029195520_phoenix_crm_interviews_day_activity.sql",

  // THE IREPORTS360 HISTORY IMPORT'S SCHEMA, AND THE CONTACT REFRESH THAT SKIPS ITS CUSTOMERS — both applied
  // 29 Oct 2026 on STAGING, then on PRODUCTION at about 00:00 Cairo on 30 Oct, through scripts/apply-sql-file.mjs
  // (production with PHOENIX_POOLER_HOST=aws-1-eu-central-1), the standing route of AGENTS.md §8. The route
  // writes no ledger row on either project, hence these two entries.
  //
  // Read live on BOTH projects after the apply and identical on each, each md5-equal to its dollar-quoted body in
  // these files (LF): md5(pg_proc.prosrc) of phoenix_crm_import_ireports360_history e80f79bd027e8d2e6e51fbf88005e4a9
  // (prosecdef true; EXECUTE held by service_role only, read with has_function_privilege),
  // phoenix_crm_seats_with_activity b567ed2210d11cbb58cead5e20f74e5a, phx_crm_contact_visit_history
  // 9a734e3ef6d43ea7e82cc7ef83adc040, phoenix_crm_customers_clear_import_mark 89ee85e868bc47fba88a3df1c4a2994d,
  // crm_contact_master_refresh 1df2710a169d6cbea1a19ef2d0f693eb. phoenix_crm_countable_visits carries
  // imported_from_ireports360_at, phoenix_crm_imported_visit_sources has row level security on, and both
  // triggers on phoenix_crm_customers are enabled. The file's `revoke all on function` was reworded to
  // `revoke execute` after the apply, for scripts/check-migrations.mjs — on a function the two are one grant.
  // No row changed: 0 marked visits and 0 source-map rows on production right after. Pinned by
  // tests/phoenix-crm-imported-history.test.ts.
  "20261029212200_phoenix_crm_imports_ireports360_history.sql",
  "20261029212300_the_contact_refresh_skips_imported_customers.sql",
  // THE INTERVIEWS ON AN INTERVIEWS DAY, WITH THEIR CVs — applied 29 Oct 2026 on STAGING (about 23:20 Cairo) then
  // PRODUCTION (about 23:55 Cairo, once PR 6675's validate and checks were green on 916ac891b) through
  // scripts/apply-sql-file.mjs (production with PHOENIX_POOLER_HOST=aws-1-eu-central-1), the standing route of
  // AGENTS.md §8: the Supabase MCP's apply_migration answered {"status":"declined"} three times on staging. The
  // route writes no ledger row on either project, hence this entry.
  //
  // Read live on BOTH projects after the apply and identical on each: public.phoenix_crm_day_interviews with
  // relrowsecurity true, its two service-role policies (the table's and the bucket's) present, anon unable to
  // select, and the bucket phoenix-crm-interview-cvs private. Production held 0 rows after it. Additive only: a new
  // table, a new private bucket and two policies; no existing row changed. Pinned by
  // tests/phoenix-crm-day-interviews.test.ts.
  "20261029235000_phoenix_crm_day_interviews.sql",
  // THE TOUCH TRAIL ARCHIVE BUCKET — applied to PRODUCTION on 27 Oct 2026 (the bucket's created_at reads 18:09:15
  // UTC, 21:09 Cairo) by a route that wrote no ledger row: production's ledger carries neither the version nor the
  // name. STAGING's ledger holds it, so this entry masks nothing there. The 30 Oct drift run 41023158255 was the
  // first to see it past the 48h grace window.
  //
  // Read live on production (ozucdzovmcqvepbozvqf) on 30 Oct 2026, every value equal to this file: bucket
  // phoenix-crm-touch-trail-archive public false, file_size_limit 52428800, allowed_mime_types {application/gzip};
  // policy phoenix_crm_touch_trail_archive_service_role on storage.objects, cmd ALL, roles {service_role}, using and
  // with check (bucket_id = 'phoenix-crm-touch-trail-archive'). 0 objects in the bucket at the read. The file
  // defines no function, so there is no prosrc digest; the readback above is the evidence.
  "20261027175121_phoenix_crm_touch_trail_archive.sql",
  // THE 46 REDUNDANT INDEXES — applied 30 Oct 2026 on STAGING then PRODUCTION (about 23:45 Cairo) through
  // scripts/apply-sql-file.mjs (production with PHOENIX_POOLER_HOST=aws-1-eu-central-1), the standing route of
  // AGENTS.md §8: the Supabase MCP's apply_migration answered {"status":"declined"} twice on staging. The route
  // writes no ledger row on either project, hence this entry.
  //
  // Read live after the apply: production's run noticed "dropped: 46, skipped: 0"; 0 of the 46 names remain as an
  // index on EITHER project; all 46 covering indexes are valid on production, and the four deliberate exclusions
  // (the two iReports360 agent indexes, the two salary_structure indexes) are still there and valid.
  // phx_ci_advisor_counts() on production read unused_index 726 (772 before), under the 755 baseline. The file
  // defines no function, so there is no prosrc digest; the readback above is the evidence.
  "20261030215000_drop_redundant_unused_indexes.sql",
  // THE TEAM COACHING SKILLS SURVEY — applied to PRODUCTION on 31 Oct 2026 at about 21:55 Cairo, on the owner's
  // answer "Production now", through scripts/apply-sql-file.mjs (PHOENIX_POOLER_HOST=aws-1-eu-central-1), the
  // standing route of AGENTS.md §8: the Supabase MCP's apply_migration answered {"status":"declined"}. The route
  // writes no ledger row, hence this entry. Additive only; nothing existing was changed.
  //
  // Read live on ozucdzovmcqvepbozvqf right after the apply: the three tables exist with RLS on and three
  // service-role policies, anon and authenticated hold no grant on any of them; the 10 skills read back in the
  // workbook's order; the settings row reads 4.0 / 0.800 / 5.0 / 4 bands; 0 surveys; employees carries
  // total_experience_years numeric(4,1) and total_experience_as_of date, both empty. Verified by digest, not by
  // presence: md5(pg_proc.prosrc) for public.phx_stamp_total_experience_as_of reads b0ea9116d402db6e5ee9d98a085aec0b,
  // the md5 of this file's own dollar-quoted body; prosecdef false, proconfig {search_path=public}, proacl
  // {postgres=X/postgres,service_role=X/postgres}. No earlier file defines the function, so there is no pre-image.
  // The ledger's newest row was 20261031195143, and ZERO rows carry this version or name.
  "20261031210456_coaching_skills_survey.sql",
  // THE IREPORTS360 HISTORY COPY'S REVIEW FIXES — applied to PRODUCTION on 1 Nov 2026 at about 10:25 Cairo, through
  // scripts/apply-sql-file.mjs (PHOENIX_POOLER_HOST=aws-1-eu-central-1), the standing route of AGENTS.md §8: the
  // Supabase MCP's apply_migration answered {"status":"declined"}, the import's body holding `drop table pg_temp.…`.
  // The route writes no ledger row, hence this entry. It replaces three functions and changes no row.
  //
  // Read live on ozucdzovmcqvepbozvqf right after the apply. Verified by digest, not by presence: md5(pg_proc.prosrc)
  // equals the md5 of this file's own dollar-quoted body for all three — phoenix_crm_import_ireports360_history
  // ec18318767a6bde56ed1ed4bd1ea22ea (was e80f79bd027e8d2e6e51fbf88005e4a9), phoenix_crm_rep_entry_days_on_visit
  // b43e2c6328eca662c5c5ede6ec3c09f6 (was 9c9b19c5285cb6bd1676401218ab650b), phoenix_crm_edit_visit_detail
  // b1d012f2948d4d3eb2ed44d88d8cb35a (was 0d1f0ab13e759d9ec0448c302b733681). Each is prosecdef true, proconfig
  // {search_path=public}, proacl {postgres=X/postgres,service_role=X/postgres}. A one-seat dry run answered 2 in scope,
  // 2 already imported, 0 to write; the edit refused a copied visit with phoenix_crm:visit_is_history; 69,046 imported
  // visits and 3,520 imported customers read unchanged. The ledger's newest row was 20261031195143, and ZERO rows
  // carry this version or name.
  "20261101101900_phoenix_crm_import_history_review_fixes.sql",
  // THE IREPORTS360 HISTORY COPY'S SECOND REVIEW FIXES — applied to PRODUCTION on 1 Nov 2026 at about 11:15 Cairo,
  // through scripts/apply-sql-file.mjs (PHOENIX_POOLER_HOST=aws-1-eu-central-1), the standing route of AGENTS.md §8:
  // the Supabase MCP's apply_migration declined this body's sibling an hour earlier, it holding the same
  // `drop table pg_temp.…`. The route writes no ledger row, hence this entry. It replaces one function and changes no row.
  //
  // Read live on ozucdzovmcqvepbozvqf right after the apply. Verified by digest, not by presence:
  // md5(pg_proc.prosrc) for phoenix_crm_import_ireports360_history is 50db0b5f985784e0d2764716ff324f91 (was
  // ec18318767a6bde56ed1ed4bd1ea22ea), the md5 of this file's own dollar-quoted body. prosecdef true, proconfig
  // {search_path=public}, proacl {postgres=X/postgres,service_role=X/postgres}. 69,046 imported visits, 3,520 imported
  // customers and 69,127 source rows read unchanged. The ledger's newest row was 20261031195143, and ZERO rows carry
  // this version or name.
  "20261101111500_phoenix_crm_import_history_second_review_fixes.sql",

  // Applied 1 Nov 2026 to staging and then production through scripts/apply-sql-file.mjs, the standing route, because
  // the save's body holds a `delete`, which the MCP declines. The route writes no ledger row, hence this entry. It
  // replaces one function and changes no row.
  //
  // Read live on cifwmndunmlxjhyjugxa and ozucdzovmcqvepbozvqf right after each apply. Verified by digest, not by
  // presence: md5(pg_proc.prosrc) for phoenix_crm_save_manager_plan_slot is 191b87d3f7859f20a1d49cacd375d43e on both
  // (was 12517968b9e92d3dd440aa6caab49bee on both), the md5 of this file's own dollar-quoted body. prosecdef true,
  // proacl {postgres=X/postgres,service_role=X/postgres}. A rolled-back probe on staging saved an empty half-day as
  // nsm and pm, and read manager_plan_slot_empty as rsm and dm.
  "20261101132835_phoenix_crm_manager_plan_optional_customers.sql",

  // THE TOUCH TRAIL IS RETIRED (owner, 1 Nov 2026: "retire and delete all its traces"; "drop the touch trail table") —
  // applied to PRODUCTION at 22:27 Cairo and to staging at 22:28 Cairo, 1 Nov 2026, through scripts/apply-sql-file.mjs
  // (production with PHOENIX_POOLER_HOST=aws-1-eu-central-1), the standing route of AGENTS.md §8: apply_migration
  // declined the drop, and staging-migrate run 41345379965 had failed the file's first version on Supabase's
  // STATEMENT-level trigger storage.protect_delete() ("Direct deletion from storage tables is not allowed"), so the
  // bucket delete left the file and the empty bucket was deleted through the Storage API instead (HTTP 200 on both
  // projects, 22:25 Cairo). The route writes no ledger row, hence this entry. This is a DROP, so presence IS the proof:
  //
  // Read live right after each apply — ozucdzovmcqvepbozvqf: to_regclass('public.phoenix_crm_touch_trail') null, 0
  // indexes, 0 archive policies, 0 bucket rows, pg_database_size 3,636,833,427 bytes (was 4,925,787,283 — the trail
  // held 1,289,035,776); the last row had been written at 20:18:56Z, before #6760 went live at 20:19Z, and no session
  // touched the table. cifwmndunmlxjhyjugxa: to_regclass null, 0 policies, 0 bucket rows. ZERO ledger rows on either
  // project carry this version or name.
  "20261101203000_retire_phoenix_crm_touch_trail.sql",
  // WHAT HR AGREED WITH A JOINER (owner, 2 Nov 2026: "Contact the joiner, confirm papers and attendance time") —
  // applied to staging and then PRODUCTION at about 13:10 Cairo, 2 Nov 2026, through scripts/apply-sql-file.mjs
  // (production with PHOENIX_POOLER_HOST=aws-1-eu-central-1), the standing route of AGENTS.md §8: apply_migration
  // declined the file on staging, over its `drop policy if exists` and `revoke` lines. The route writes no ledger row,
  // hence this entry. Read live right after: on ozucdzovmcqvepbozvqf and on cifwmndunmlxjhyjugxa alike,
  // public.hiring_joiner_contacts has row security on, 8 columns, 1 policy, select for service_role only (anon false,
  // authenticated false), 0 rows, and ZERO ledger rows carry this version or name.
  "20261102120000_hiring_joiner_contacts.sql",
  // Verified: phoenix_crm_visit_comment_readings, its queue and its trigger were applied to staging and then
  // PRODUCTION on 3 Nov 2026 through scripts/apply-sql-file.mjs (production with
  // PHOENIX_POOLER_HOST=aws-1-eu-central-1), the standing route of AGENTS.md §8: apply_migration declined the file.
  // The route writes no ledger row, hence this entry. Read live right after, on ozucdzovmcqvepbozvqf and on
  // cifwmndunmlxjhyjugxa alike: md5(pg_proc.prosrc) of phoenix_crm_comment_reading_queue is
  // b54befe30d1fe9e1368811b16230dca5 and of phoenix_crm_comment_changed is f9a0ccb9233270a55b73e5df55c8e2f1, each equal
  // to md5 of the file's own dollar-quoted body; both functions are new, so there is no pre-image. Trigger enabled,
  // row security on, 1 policy (service_role, all), 0 rows, and ZERO ledger rows carry this version or name. On production, 9 columns,
  // anon and authenticated false on the table and the queue, service_role true on the queue.
  // Applied under the version 20261103090000 and renamed before merge, because another open PR held that version. The
  // two revoke lines were also reworded from "all" to "execute", the same privilege on a function, after applying. The
  // module's hygiene test then asked for begin, a lock timeout, a schema reload and commit around it, and create or
  // replace on the trigger in place of drop and create: none of these changes what the applied file left behind.
  // The two functions were first named phx_crm_*; the same test asks for phoenix_crm_*, so both were renamed live with
  // alter function on staging and then production before anything called them, and the digests above were read again
  // after: unchanged, service_role still holds both, and the trigger still fires the renamed function. The same test
  // asks for a service-role policy on the table, so that one statement was also run live on both projects.
  "20261103091500_phoenix_crm_visit_comment_readings.sql",
  // 2026-11-03, applied to production about 11:14 Cairo with `node scripts/apply-sql-file.mjs <file>
  // production` (PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com), straight after #38 merged,
  // and to staging with the same script before the pull request opened. It is the standing route: both
  // MCP doors refuse a body holding the rebuild's own `delete from marketing_roi_*` statements. That route
  // writes NO ledger row, so production holds none for this version or name; staging holds one, from the
  // staging applier on merge.
  // Verified by digest on BOTH projects, not by presence: md5(pg_proc.prosrc) for
  // public.phx_refresh_marketing_roi_facts reads f370c4ba115c8a677e10a0feece86a1c over 31,497 chars on
  // ozucdzovmcqvepbozvqf and on cifwmndunmlxjhyjugxa, md5-equal to the dollar-quoted body in this file
  // (as-is LF), and this file is the function's LAST definer. The pre-image is
  // 20261016223000_marketing_roi_refresh_skips_through_periods.sql, c8d100c116c188021443fa91f0b32c90 on
  // both projects before the apply, which makes that file the one-command rollback. `prosecdef` true,
  // `proconfig` {search_path=public,statement_timeout=60s} and proacl
  // {postgres=X/postgres,service_role=X/postgres} were read in the same query. Its effect, measured on
  // production by a full rebuild on each body: customer total 88,051.558415 and 864 units on 36 rows both
  // ways, 0 customers differ, and exact_sales_rows 72 before and 40 after. Re-applying it is a no-op
  // (`create or replace`).
  "20261103120201_marketing_roi_customer_counts_each_sale_once.sql",
  // 2026-11-03, applied to staging and then production (about 11:35 Cairo) with `node
  // scripts/apply-sql-file.mjs <file> <env>` (production with
  // PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com), the standing route: both MCP doors refuse
  // a body holding the rebuild's own `delete from marketing_roi_*` statements. That route writes NO ledger
  // row, so production holds none for this version or name.
  // Verified by digest on BOTH projects, not by presence: md5(pg_proc.prosrc) for
  // public.phx_refresh_marketing_roi_facts reads bddeae52ff73e414f6528f8633463b7e over 31,344 chars on
  // ozucdzovmcqvepbozvqf and on cifwmndunmlxjhyjugxa, md5-equal to the dollar-quoted body in this file
  // (as-is LF), and this file is the function's LAST definer. The pre-image is
  // 20261103120201_marketing_roi_customer_counts_each_sale_once.sql, f370c4ba115c8a677e10a0feece86a1c on
  // both projects before the apply, which makes that file the one-command rollback. `prosecdef` true,
  // `proconfig` {search_path=public,statement_timeout=60s} and proacl
  // {postgres=X/postgres,service_role=X/postgres} were read in the same query. Its effect, measured on
  // production by replaying the 10:54 Cairo import in a rolled-back transaction: 61 requests and EGP
  // 79,951.56 on the six summary tables before, 81 requests and EGP 88,051.56 after, identical to a full
  // rebuild. Re-applying it is a no-op (`create or replace`).
  "20261103120202_marketing_roi_import_rebuilds_every_request.sql",
  // 2026-11-03, applied to staging about 12:44 Cairo and to production at 13:04 Cairo, on the owner's merge
  // word for pull request 48, with `node scripts/apply-sql-file.mjs <file> <env>` (production with
  // PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com), the standing route: both MCP doors refuse a
  // body holding the rebuild's own `delete from marketing_roi_*` statements. That route writes NO ledger
  // row, so production holds none for this version or name.
  // Verified by digest on BOTH projects, not by presence: md5(pg_proc.prosrc) for
  // public.phx_refresh_marketing_roi_facts reads 8c13b0e8a7cf7a066a73408a10e654bf over 31,689 chars on
  // ozucdzovmcqvepbozvqf and on cifwmndunmlxjhyjugxa, md5-equal to the dollar-quoted body in this file. The
  // definer it replaces is 20261103120202_marketing_roi_import_rebuilds_every_request.sql,
  // bddeae52ff73e414f6528f8633463b7e on production before the apply, which makes that file the one-command
  // rollback. `prosecdef` true and proacl {postgres=X/postgres,service_role=X/postgres} were read in the same
  // query. Its effect, read on production after a full rebuild at 13:04:23 Cairo: all six summary tables EGP
  // 109,930.71, which is 88,051.56 at 12:20, plus 3,138.75 from five requests that went active at 12:29 to
  // 12:33, plus 18,740.40 from 5 direct orders; verdicts unchanged at 78, 1 and 2; 0 of 81 requests differ
  // from View Sales. Re-applying it is a no-op (`create or replace`).
  "20261103124320_marketing_roi_direct_orders_reach_the_facts.sql",
  // 2026-11-03, applied to staging and production about 13:15 Cairo with `node scripts/apply-sql-file.mjs <file>
  // <env>` (production with PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com), the standing route:
  // supabase-production answered {"status":"declined"} and a read straight after showed nothing had landed.
  // That route writes NO ledger row, so production holds none for this version or name.
  // Verified by digest on BOTH projects, not by presence: md5(pg_proc.prosrc) reads the same on
  // ozucdzovmcqvepbozvqf and cifwmndunmlxjhyjugxa and equals the dollar-quoted bodies in this file:
  // public.phx_hire_into_seat_on_vacancy_filled 8334ef5d206efee08c69eb93e53315ec, au.hire_into_seat
  // 60d867c2a802bc5ad6b08fda6a16f595, au.resign_occupant 5dd62ed3989c7b2214e1a91f0c04d812,
  // public.phx_seat_start_follows_hire_date fe30482ac8b2666435955b6a7c556444. Trigger
  // trg_employees_seat_start_follows_hire_date is present and `authenticated` cannot execute the new function,
  // both read in the same query. Re-applying it is a no-op (`create or replace`, `drop trigger if exists`).
  "20261103133000_seat_start_follows_the_job_offer.sql",

  // Applied 2026-11-03 through scripts/apply-sql-file.mjs on staging and production, because the
  // Supabase MCP's apply_migration returned {"status":"declined"} on staging and nothing had landed.
  // That route writes NO ledger row. Verified by digest, not presence: on BOTH projects
  // md5(pg_proc.prosrc) for public.crm_person_by_hr_key_calc is 1df4dc7c013a1518fb4d75ae5f6a471b, equal
  // to this file's dollar-quoted body. The trigger crm_person_by_hr_key_sync names nickname, the function
  // stays service_role only and crm_person_by_hr_key_reconcile() returned 0, read back the same evening.
  // Re-applying it is a no-op (`create or replace`, `drop trigger if exists`, a rebuild).
  "20261103213631_crm_doors_name_people_by_their_display_name.sql",

  // Applied 2026-11-04 about 15:20 Cairo through scripts/apply-sql-file.mjs on staging and production
  // (production with PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com), the standing route:
  // supabase-staging's apply_migration answered {"status":"declined"} twice and a read straight after showed
  // nothing had landed. That route writes NO ledger row. The file creates tables and no function, so the
  // digest is of the catalog's own structure, read in one query on BOTH ozucdzovmcqvepbozvqf and
  // cifwmndunmlxjhyjugxa and equal on both: 6 public medical_insurance_* tables, md5 of every column as
  // name:type:notnull a78312877ad467637398239bad731b99, of every constraint definition
  // d128355e28639c11c9b0c13510376b06, of every index definition 725fe382b60445355394fc31b982c728; RLS on all
  // six, 0 grants to anon, authenticated or PUBLIC, 1 policy row 6489200000, bucket medical-insurance private
  // at 26214400 bytes, storage policy medical_insurance_service_role present. Re-applying it is a no-op
  // (`if not exists`, `on conflict do nothing`, the bucket upsert, `drop policy if exists`).
  "20261104092817_medical_insurance.sql",
  // 2026-11-06, written by the session that applied it. A first draft (one-argument
  // phx_make_it_happen_brick_units plus sales_forecast_plans.brick_units) went in through apply_migration,
  // which stamped ledger rows NAMED make_it_happen_brick_forecast — version 20261106142014 on
  // ozucdzovmcqvepbozvqf, 20261106141955 on cifwmndunmlxjhyjugxa. Minutes later the file gained the two
  // scope arrays, which means dropping the draft, and supabase-staging's apply_migration answered
  // {"status":"declined"} to that `drop function`. So THIS body went in by the standing route,
  // `node scripts/apply-sql-file.mjs <file> staging|production` (production with
  // PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com), which writes no ledger row: the ledger
  // row's NAME matches this file but it records the draft. Proven by digest on BOTH databases, read
  // straight after: md5(pg_proc.prosrc) of public.phx_make_it_happen_brick_units = d2e0f379359ce08fc9a53ebd15e0c2f4,
  // equal to the md5 of this file's own body between the $function$ markers; one overload only, identity
  // arguments (p_period text, p_line_codes text[], p_area_codes text[]); prosecdef true; EXECUTE false for
  // anon and authenticated, true for service_role; brick_units present with default '{}'::jsonb.
  // Re-applying is a no-op (`drop function if exists` of the draft, `create or replace`, `add column if not exists`).
  "20261106161841_make_it_happen_brick_forecast.sql",
  // 2026-11-06/07, written by the session that applied both. supabase-staging's apply_migration answered
  // {"status":"declined"} (both files drop and recreate), so both went in by the standing route,
  // `node scripts/apply-sql-file.mjs <file> staging|production` (production with
  // PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com), which writes no ledger row: neither version
  // has one on ozucdzovmcqvepbozvqf or cifwmndunmlxjhyjugxa. Proven by digest on BOTH databases, read straight
  // after and equal on both. The doors file: md5(pg_proc.prosrc) of phoenix_crm_counted_seat_windows =
  // a1157ace25ba69b58055b74c263a4e75 and of phoenix_crm_counted_day_activity_windows =
  // 05b22a7e5b06761d8bfd89d209c746eb, each equal to the md5 of this file's own LF body between the $function$
  // markers; both prosecdef, EXECUTE for postgres and service_role
  // only; md5(pg_get_viewdef) of crm_visits_unified = a37a62cc39b0a7f7f88904cee1e19bc0 and of
  // crm_checkins_unified = ea6310341189f6c75e4697e480135569, both security_invoker=true. Every month's rows on
  // both views hashed the same before and after on production (0 rows moved). Re-applying is a no-op
  // (`create or replace`, the views dropped and recreated with the same body).
  "20261106235920_crm_doors_count_every_seat_from_vendor_retirement.sql",
  // The import file: one overload only, phoenix_crm_import_ireports360_history(text, boolean, boolean);
  // md5(pg_proc.prosrc) = b4ea4ab633c5a663bb2c95dd1e49e2a0, equal to the md5 of this file's own LF body between
  // the $function$ markers; prosecdef true; EXECUTE for postgres and service_role only. The file writes no row
  // (the copy is the runner's --apply). Re-applying is a no-op (`drop function if exists` of the two-argument
  // one, `create or replace`).
  "20261107001714_phoenix_crm_import_history_after_the_start.sql",
  // Applied 7 Nov 2026 by scripts/apply-sql-file.mjs (staging, then production with the aws-1 pooler) — the MCP
  // refuses a body holding `delete` / `drop table pg_temp`. md5(pg_proc.prosrc) on production equals the md5 of
  // this file's own LF body between the dollar markers for all six: phoenix_crm_visits_old_system_kpi
  // fe59ed9b96c12bfc8f7f5b90bb3aeac9, phoenix_crm_visits_old_system_far_archive 7e3d44d7a6a03db3f3525ae05c5a1d31,
  // phoenix_crm_prepare_ireports360_conversion fdd914ee2c61a1f5cef7c56be13fe716,
  // phoenix_crm_ireports360_conversion_page 3eca80908c9f5b0fa121cc0596bb0fc7,
  // phoenix_crm_apply_ireports360_conversion 294ca6923fe0d2eef59d62bc5533acc4,
  // phoenix_crm_import_ireports360_history 11d473ef1b53772c1b97d9cada2542a2; EXECUTE for postgres and
  // service_role only. phoenix_crm_visit_archive has RLS on, granted to service_role only; crm_visits_unified has
  // counts_in_kpi. Every month Jan–Nov of crm_visits_unified hashed the same before and after (0 rows moved).
  "20261107044059_phoenix_crm_old_visits_convert_and_archive.sql",
  // Applied 7 Nov 2026 by scripts/apply-sql-file.mjs (staging, then production with the aws-1 pooler), after the
  // runner and the leavers step as its header requires. md5(pg_proc.prosrc) on staging and production equals the
  // md5 of this file's own LF body between the dollar markers: phoenix_crm_rep_entry_days_calc
  // 58b4b1ab46288ee6a3fd1bea9062a318, phoenix_crm_seat_visit_firsts d58174ef98d7b9c74bf4bd9f0a4ae895. Read back on
  // production: phoenix_crm_countable_visits admits 27,939 copied visits (= ireports360_kpi_counted); October of
  // crm_visits_unified hashed cd17b12ca95aa7ade06e4cb79428aba2 before and after; crm_checkins_unified 149,620 and
  // the entry-days cache 1,241 rows, both unchanged. Re-applying is a no-op (`create or replace`).
  "20261107044742_phoenix_crm_countable_admits_converted_visits.sql",
  // Applied 7 Nov 2026 by scripts/apply-sql-file.mjs (staging 0 rows, then production 1,800 rows). md5(pg_proc.prosrc)
  // of phoenix_crm_visits_old_system_kpi on staging and production = 568427fb918d769f31faeecc9410f762, the md5 of
  // this file's own LF body between the dollar markers. Read back on production: 0 converted visits archived far
  // within 500 m, 1,800 far and counted, 3,802 archived far (= the archive's far rows). Every month Jan–Nov of
  // crm_visits_unified hashed the same as before the conversion. Re-applying touches no row (none is left to lift).
  "20261107064148_phoenix_crm_far_old_visits_within_500m_count.sql",
  // Applied 7 Nov 2026 by scripts/apply-sql-file.mjs (staging, then production with the aws-1 pooler) — both MCP
  // doors decline a file holding `drop constraint/policy/trigger if exists`. md5(pg_proc.prosrc) of
  // phx_ats_mr_hiring_append_only on staging and production = 01fcf91551552a7a2aabbba5a1966b45, the md5 of this
  // file's own LF body between the $$ markers; prosecdef true; EXECUTE for postgres and service_role only. Read
  // back on production: ats_mr_hiring_step_results and ats_mr_hiring_recommendations with RLS on and grants for
  // postgres and service_role only, the four triggers, both booking constraints, 0 of 104 bookings carrying a
  // round. Probed on staging inside a rolled-back transaction: an UPDATE and a direct DELETE refused, a
  // make_offer with no salary refused, a booking's deletion leaving the result with booking_id null. Re-applying
  // is a no-op (`if not exists`, `drop … if exists` then create, `create or replace`).
  "20261107123708_ats_mr_hiring_workflow.sql",
  // Applied 7 Nov 2026 by scripts/apply-sql-file.mjs (staging, then production with the aws-1 pooler), for the
  // same reason as the file above (`drop constraint if exists`). Read back on both with pg_get_constraintdef:
  // ats_interview_bookings_round_known and ats_mr_hiring_step_results_step_known each list 'rsm' beside every
  // value they held before; production had 0 bookings carrying a round and 0 step results, so no row was
  // re-checked against anything new. Re-applying is a no-op (`drop … if exists`, then the same constraint).
  "20261107132746_ats_mr_hiring_rsm_round.sql",
  // Applied 7 Nov 2026 by scripts/apply-sql-file.mjs (staging, then production with the aws-1 pooler) after both
  // MCP doors declined it, staging included (the file holds `drop policy if exists` and a `revoke`). One new
  // table, no function. Read back on both: public.ats_mr_area_manager_notices with relrowsecurity true, one
  // policy, grants for service_role only (none for anon or authenticated); production held 0 rows. Re-applying
  // is a no-op (`if not exists`, `drop policy if exists` then create, the same revoke and grant).
  "20261107202920_ats_mr_area_manager_notices.sql",
  // Applied 9 Nov 2026 by scripts/apply-sql-file.mjs (production with the aws-1 pooler, then staging) while the
  // Supabase MCP servers were disconnected from the session. One new table, no function. Read back on production
  // through PostgREST with the service role: public.automated_payroll_held_entered answers a count of 0 rows.
  // Re-applying is a no-op (`if not exists`, `drop policy if exists` then create, the same revoke and grant).
  "20261109085429_automated_payroll_held_entered.sql",
  // Applied 10 Nov 2026 by scripts/apply-sql-file.mjs (staging, then production with the aws-1 pooler), the standing
  // route: supabase-staging's apply_migration answered {"status":"declined"} twice and supabase-production's once,
  // and a read straight after each showed nothing had landed. That route writes NO ledger row. Three new tables, no
  // function, so the digest is of the catalog's own structure, read in one query on BOTH ozucdzovmcqvepbozvqf and
  // cifwmndunmlxjhyjugxa and equal on both: public.marketing_function_months, marketing_function_items and
  // marketing_field_feedback; md5 of every column as table.name:type:notnull ef9bf22c6843b74aeeefb8bbbfd81341, of
  // every constraint definition ccbae806c7ff37b32ad3d31b00c75ced, of every index definition
  // edf5a7e96d7f9bccf543a6a83fb7195c; RLS on all three, one service_role policy each, 0 grants to anon,
  // authenticated or PUBLIC, 0 rows held. Re-applying is a no-op (`if not exists`, `drop policy if exists` then
  // create, the same revoke and grant).
  "20261110025541_marketing_functions_and_field_feedback.sql",
  // Applied 10 Nov 2026 by scripts/apply-sql-file.mjs (staging, then production with the aws-1 pooler), the standing
  // route, which writes NO ledger row; both answered applied:true. Three function bodies replaced, no table. Read back
  // on ozucdzovmcqvepbozvqf from pg_proc: SECURITY DEFINER on all three, ACL {postgres=X,service_role=X}, md5(prosrc)
  // of public.phx_write_monthly_store_split_net b0986163ff34a226c79139fbc7eefc99, au.f_refresh_monthly_attribution
  // 3973db659991b7d34840f66f9677ff98, au.f_refresh_stale_attribution_periods f7498c9fe749cd6835fb5f20a5b27f03. Re-applying
  // is a no-op (`create or replace`, the same revoke and grant).
  "20261110103127_freeze_only_the_published_line.sql",
  // Applied 10 Nov 2026 to production only by scripts/apply-sql-file.mjs with the aws-1 pooler (the standing route,
  // NO ledger row) after supabase-production's apply_migration answered declined and left nothing behind. Answered
  // applied:true. Read back on ozucdzovmcqvepbozvqf: md5(pg_get_viewdef) of phoenix_crm_countable_visits
  // f35c6fb8d4f1923f4c374e0d29b13448 (pre-image ecfc39e99695fe7f56226af5ea4750a5) and of
  // phoenix_crm_countable_visits_with_history c408348d961dcda819b8761e8ba6bb04 (pre-image
  // 2b1338eeb1e0b7e707f44b40d346288b), both security_invoker=true, grants postgres and service_role only; in one
  // read the views and their pre-image bodies counted the same rows (44,569 and 96,100). phoenix_crm_far_visit_holds:
  // column md5 4f2aff30d766c7873cc79b25688e7687, constraint md5 6fcb93d8f2af5d3b553023c14da6fe66, RLS on, one
  // service_role policy, 0 grants to anon or authenticated, 0 rows. Reason check md5 affa6c87c5746dd2ef76f611086e6eaf,
  // far check c0a60faacd98baa3c7163d998a262cda. Re-applying is a no-op (`if not exists`, `drop ... if exists` then add,
  // `create or replace view` with the same body).
  "20261110170000_phoenix_crm_far_visit_safeguards.sql",
  // Applied 10 Nov 2026 by scripts/apply-sql-file.mjs (staging, then production with the aws-1 pooler), the standing
  // route, which writes NO ledger row: the session's Supabase connector reaches a different account and lists neither
  // Phoenix project. Both answered applied:true. Five columns added to public.offers, no table, no function, no grant.
  // Read back on BOTH cifwmndunmlxjhyjugxa and ozucdzovmcqvepbozvqf and equal on both: md5 of the five columns as
  // name:type:nullable:default 054f23555528ba9357ae600b4bb908c6, of the two CHECK definitions
  // be60ae8291e3e6884e95bb1b4eb9152e; production's 86 offers all read revision 0. Re-applying is a no-op
  // (`add column if not exists`, `drop constraint if exists` then add).
  "20261110195450_offer_email_message_and_revisions.sql",
  // Applied 11 Nov 2026 by scripts/apply-sql-file.mjs (staging, then production with the aws-1 pooler), the standing
  // route, which writes NO ledger row: apply_migration answered {"status":"declined"} on staging for this file (a
  // function body that revokes, and four `drop constraint`/`drop trigger` statements). Staging did not hold
  // 20261110170000's phoenix_crm_far_visit_holds table, so that file was applied to staging first, the same way.
  // Read back on BOTH cifwmndunmlxjhyjugxa and ozucdzovmcqvepbozvqf and equal on both, and equal to this file's own
  // bodies as LF text: md5(prosrc) of phoenix_crm_decide_request e4d52e35d0eb34c18c5eae34e226207d (before:
  // 19ccb2eb1c3cbaddfedd57bf9ce30c7a on both), of phoenix_crm_customers_validated_has_place
  // ee30466883ef80da935d1f536023ceb6; both SECURITY DEFINER with ACL {postgres=X, service_role=X} and nothing else.
  // Two constraint triggers on phoenix_crm_customers, deferrable and initially deferred, enabled. The four CHECK
  // definitions (holds basis, holds tries, refused-readings reason, refused-readings far_from_place) as
  // name:definition md5 9088c814322e964b77ff88ff3f82852e; phoenix_crm_far_visit_holds.basis is text not null default
  // 'stuck', over 0 rows on production. Rehearsed on staging inside one rolled-back transaction: a doctor made
  // validated with no place raised phoenix_crm:validated_without_place, one with a place and a pharmacy did not, and
  // an approved add landed on status pending without a place and on active with one. Re-applying is a no-op
  // (`create or replace`, `drop trigger if exists` then create, `drop constraint` then add, `add column if not exists`).
  "20261111004733_phoenix_crm_validation_gap_fixes.sql",
  // Applied 11 Nov 2026 by scripts/apply-sql-file.mjs (staging, then production with the aws-1 pooler), the standing
  // route, which writes NO ledger row. Two `create or replace function` statements and their revokes, no table, no
  // row. Read back on BOTH cifwmndunmlxjhyjugxa and ozucdzovmcqvepbozvqf and equal on both, and equal to this file's
  // own bodies as LF text: md5(prosrc) of phoenix_crm_decide_request 9ff9cd6c9194cbc65c6a49f29d624374 (before:
  // e4d52e35d0eb34c18c5eae34e226207d, the file above), of phoenix_crm_reverse_list_request
  // 421a3d7e05190bee1c2bb7f5779870b4 (before: 8393e50aa8e2febe367119bfd3d482b9 on production, which is
  // 20261008190000's body with its comment lines removed); both SECURITY DEFINER, search_path=public, ACL
  // {postgres=X, service_role=X} and nothing else. Rehearsed on staging inside rolled-back blocks, 6 of 6: a
  // bring-back and an undone drop of a validated customer whose place was retired landed on pending with the stamp
  // cleared; with a place, and for a pharmacy, on active as before; an undone add that had admitted to pending
  // landed on dropped, not_admitted. Re-applying is a no-op (`create or replace`).
  "20261111013233_phoenix_crm_bring_back_never_validates_without_place.sql",
  // Applied 11 Nov 2026 by scripts/apply-sql-file.mjs (staging, then production with the aws-1 pooler), the standing
  // route, which writes NO ledger row. Three `create or replace function` statements with their revokes and one
  // trigger, no table, no row. Read back on BOTH cifwmndunmlxjhyjugxa and ozucdzovmcqvepbozvqf and equal on both, and
  // equal to this file's own bodies as LF text: md5(prosrc) of phoenix_crm_validate_customer
  // 9afe35c9423006f25758c15b2132b850 (before: fccb330da6e66940b950cc1c553bad14 on both, 20261107195700's body), of
  // phoenix_crm_customer_merged_away 17496bb2008754ea7ee9da4c38710043, of phoenix_crm_customers_no_merged_return
  // 31fba21360ba5905c4ac4333724d4bc8; all SECURITY DEFINER with ACL {postgres=X, service_role=X} and nothing else; the
  // trigger phoenix_crm_customers_no_merged_return enabled. Rehearsed on staging inside one rolled-back block, 4 of 4:
  // a plain restore went through, a merged-away row's restore raised phoenix_crm:merged_duplicate, the owner's
  // reversal with phoenix_crm.allow_merge_reversal = on went through, and after a recorded merge_reversed event a
  // restore went through. Re-applying is a no-op (`create or replace` function and trigger).
  "20261111030456_phoenix_crm_sweep_fixes.sql",
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
 * `check-migrations-applied.ts`'s only command line, parsed HERE so a test can assert it without
 * importing that script — its `main()` runs on import and would open a database connection.
 *
 * 🔴 AN UNKNOWN FLAG IS REFUSED, NEVER IGNORED. A dropped flag makes the narrow run read as the
 * wide one, which is the exact shape of the `sync-cloud-context.mjs --check` trap, and here it
 * would answer "production is clean" about a set the run never looked at.
 *
 * `--no-grace` exists because the grace window is right for the nightly job and wrong for a sweep:
 * on 2026-10-15 it sheltered FOUR of the eight production files whose ledger rows were missing,
 * three of them money migrations merged that morning (see docs/migrations.md, "The 15 October
 * production sweep"). The owner's question — "sweep production for merged migrations never
 * applied" — is this flag.
 */
export function parseDriftCheckFlags(argv: string[]): { ignoreGraceWindow: boolean; staging: boolean } {
  let ignoreGraceWindow = false;
  let staging = false;
  for (const arg of argv) {
    if (arg === "--no-grace") {
      ignoreGraceWindow = true;
      continue;
    }
    if (arg === "--staging") {
      staging = true;
      continue;
    }
    throw new Error(
      `unknown flag ${JSON.stringify(arg)} — the flags are --no-grace (judge the newest migrations `
        + `too, what a sweep wants) and --staging (read the staging project's credentials instead of `
        + `production's). Refusing rather than ignoring it: a silently dropped flag makes a narrower `
        + `run read as the wider one, or points a run at the wrong database.`,
    );
  }
  return { ignoreGraceWindow, staging };
}

/**
 * The same env files, in the same order, that `scripts/apply-sql-file.mjs` reads — so one command
 * works in a shell and not only in CI.
 *
 * 🔴 THE PROCESS ENVIRONMENT ALWAYS WINS. The drift-check workflow passes each project's URL and
 * service key explicitly, once per leg, and a file must never be able to redirect a CI run at the
 * other database. This is a FALLBACK for a human, nothing more.
 *
 * `.env.local` points at PRODUCTION (AGENTS.md §3), which is what a sweep wants by default;
 * `.env.staging.rls.local` holds the staging pair under `PHOENIX_STAGING_*` names, which is why
 * `--staging` asks for different keys rather than a different file.
 */
export const DRIFT_CHECK_ENV_FILES = [
  ".env.staging.rls.local",
  ".env.production.rls.local",
  ".env.local",
] as const;

/**
 * `name` from the process environment, else from the first of DRIFT_CHECK_ENV_FILES that sets it.
 * Returns the source alongside the value so the run can SAY where its credentials came from —
 * never the value itself, which is a service-role key.
 */
export function resolveEnvValue(
  name: string,
  files: readonly string[] = DRIFT_CHECK_ENV_FILES,
): { value: string; source: string } | null {
  const fromProcess = process.env[name];
  if (fromProcess) return { value: fromProcess, source: "the process environment" };
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    for (const raw of fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0 || line.slice(0, eq).trim() !== name) continue;
      const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (value) return { value, source: file };
    }
  }
  return null;
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
