-- drop_175_decided_snapshots
--
-- WHAT THIS CHANGES: drops every snapshot the owner has decided "export, then drop" for, in one go:
--   147 snapshot schemas (`drop schema … cascade`) and 28 snapshot tables in `au` / `public`
--   (`drop table`, no cascade), 744 tables and 1083832 rows in all.
-- WHY: on 20 Nov 2026 the owner chose to drop all of the decided snapshots at once, now, instead of one
--   dated drop per snapshot as each reached 90 days (docs/security/backup-schema-retention.md). Each one's
--   decision is in scripts/backup-schema-decisions.json. Copies younger than that, or with no decision,
--   are untouched.
-- BEFORE IT RAN, read live the same day:
--   * scripts/audit-backup-schemas.mjs listed exactly these 175 as decided, with nothing depending on
--     any of them (no foreign key, view, trigger, policy, function or cron job);
--   * every one has an export in snapshot-exports/<name>/ whose files were re-hashed against their
--     manifest: 0 mismatches.
-- ROLLBACK: none in SQL. The data comes back only from those CSV exports, or for seven days from a daily
--   backup restored into a SEPARATE project. Production has NO point-in-time recovery.
--
-- Re-running is safe: every statement is `if exists`. Staging holds only the few that a migration made,
-- and the same statements clear them there.

begin;

-- sos_backup_20261012: 35 table(s), 468146 row(s), exported 2026-11-19
drop schema if exists sos_backup_20261012 cascade;
-- map_audit_baseline: 1 table(s), 68146 row(s), exported 2026-11-13
drop schema if exists map_audit_baseline cascade;
-- crm_parity_backup_20261003: 1 table(s), 139051 row(s), exported 2026-11-19
drop schema if exists crm_parity_backup_20261003 cascade;
-- marketing_rollback: 14 table(s), 57197 row(s), exported 2026-11-13
drop schema if exists marketing_rollback cascade;
-- ez_split_backup_20260826: 17 table(s), 40634 row(s), exported 2026-11-13
drop schema if exists ez_split_backup_20260826 cascade;
-- sos_backup_20261026_ibnsina: 3 table(s), 34891 row(s), exported 2026-11-19
drop schema if exists sos_backup_20261026_ibnsina cascade;
-- sos_backup_20260913: 19 table(s), 33042 row(s), exported 2026-11-13
drop schema if exists sos_backup_20260913 cascade;
-- ops_backup: 21 table(s), 7010 row(s), exported 2026-11-13
drop schema if exists ops_backup cascade;
-- crm_backup_20260913: 1 table(s), 40237 row(s), exported 2026-11-13
drop schema if exists crm_backup_20260913 cascade;
-- activity_events_dev_preview_backup_20260921: 2 table(s), 8171 row(s), exported 2026-11-13
drop schema if exists activity_events_dev_preview_backup_20260921 cascade;
-- is_twin_backup_20260911: 12 table(s), 2710 row(s), exported 2026-11-13
drop schema if exists is_twin_backup_20260911 cascade;
-- ruling_protect_20260910: 6 table(s), 26088 row(s), exported 2026-11-13
drop schema if exists ruling_protect_20260910 cascade;
-- ats_backup_20260912: 7 table(s), 556 row(s), exported 2026-11-13
drop schema if exists ats_backup_20260912 cascade;
-- phx_backup_20261017: 42 table(s), 7747 row(s), exported 2026-11-19
drop schema if exists phx_backup_20261017 cascade;
-- epda_backup_20261010: 2 table(s), 3573 row(s), exported 2026-11-19
drop schema if exists epda_backup_20261010 cascade;
-- sos_backup_20261027_archives: 7 table(s), 14878 row(s), exported 2026-11-19
drop schema if exists sos_backup_20261027_archives cascade;
-- qema_split_backup_20260908: 6 table(s), 21518 row(s), exported 2026-11-13
drop schema if exists qema_split_backup_20260908 cascade;
-- phoenix_crm_backup_20261026: 2 table(s), 1537 row(s), exported 2026-11-19
drop schema if exists phoenix_crm_backup_20261026 cascade;
-- fuwwah_backup_20260904: 9 table(s), 1718 row(s), exported 2026-11-13
drop schema if exists fuwwah_backup_20260904 cascade;
-- customer_map_backup_20260918: 5 table(s), 8640 row(s), exported 2026-11-13
drop schema if exists customer_map_backup_20260918 cascade;
-- attribution_split_backup_20260907: 4 table(s), 13840 row(s), exported 2026-11-13
drop schema if exists attribution_split_backup_20260907 cascade;
-- address_brick_backup_20261013: 2 table(s), 6921 row(s), exported 2026-11-19
drop schema if exists address_brick_backup_20261013 cascade;
-- sos_august_split_restate_20261002: 5 table(s), 2336 row(s), exported 2026-11-13
drop schema if exists sos_august_split_restate_20261002 cascade;
-- deductions_governance_backup_20260830: 7 table(s), 324 row(s), exported 2026-11-13
drop schema if exists deductions_governance_backup_20260830 cascade;
-- ats_backup_20260921: 28 table(s), 363 row(s), exported 2026-11-13
drop schema if exists ats_backup_20260921 cascade;
-- sos_backup_20260910: 23 table(s), 2431 row(s), exported 2026-11-13
drop schema if exists sos_backup_20260910 cascade;
-- crm_backup_20260921: 8 table(s), 7014 row(s), exported 2026-11-13
drop schema if exists crm_backup_20260921 cascade;
-- ats_dupe_merge_backup_20260904: 17 table(s), 332 row(s), exported 2026-11-13
drop schema if exists ats_dupe_merge_backup_20260904 cascade;
-- aug_cns_restamp_20260910: 8 table(s), 2597 row(s), exported 2026-11-13
drop schema if exists aug_cns_restamp_20260910 cascade;
-- phoenix_crm_backup_20261003: 22 table(s), 2380 row(s), exported 2026-11-19
drop schema if exists phoenix_crm_backup_20261003 cascade;
-- sep_map_sync_20261010: 1 table(s), 3729 row(s), exported 2026-11-19
drop schema if exists sep_map_sync_20261010 cascade;
-- expense_backup_20260921: 12 table(s), 1553 row(s), exported 2026-11-13
drop schema if exists expense_backup_20260921 cascade;
-- sos_backup_20261013: 16 table(s), 2005 row(s), exported 2026-11-19
drop schema if exists sos_backup_20261013 cascade;
-- phoenix_crm_backup_20261002: 25 table(s), 1861 row(s), exported 2026-11-13
drop schema if exists phoenix_crm_backup_20261002 cascade;
-- mkt_backup_20260924: 12 table(s), 880 row(s), exported 2026-11-13
drop schema if exists mkt_backup_20260924 cascade;
-- qema_backup_20260909: 2 table(s), 7380 row(s), exported 2026-11-13
drop schema if exists qema_backup_20260909 cascade;
-- hr_id_casing_backup_20260905: 7 table(s), 3509 row(s), exported 2026-11-13
drop schema if exists hr_id_casing_backup_20260905 cascade;
-- expenses_backup_20260925: 4 table(s), 959 row(s), exported 2026-11-13
drop schema if exists expenses_backup_20260925 cascade;
-- crm_backup_20260916: 3 table(s), 3992 row(s), exported 2026-11-13
drop schema if exists crm_backup_20260916 cascade;
-- qena_split_backup_20261004: 8 table(s), 1933 row(s), exported 2026-11-19
drop schema if exists qena_split_backup_20261004 cascade;
-- ats_backup_20261014_offerhirefix: 6 table(s), 93 row(s), exported 2026-11-19
drop schema if exists ats_backup_20261014_offerhirefix cascade;
-- sos_july_split_restate_20261002: 5 table(s), 1888 row(s), exported 2026-11-13
drop schema if exists sos_july_split_restate_20261002 cascade;
-- sos_backup_20260904: 9 table(s), 1024 row(s), exported 2026-11-13
drop schema if exists sos_backup_20260904 cascade;
-- recruitment_backup_20260909: 1 table(s), 1175 row(s), exported 2026-11-13
drop schema if exists recruitment_backup_20260909 cascade;
-- notification_backup_20261023: 3 table(s), 824 row(s), exported 2026-11-19
drop schema if exists notification_backup_20261023 cascade;
-- phoenix_crm_merge_backup_20261028: 14 table(s), 584 row(s), exported 2026-11-19
drop schema if exists phoenix_crm_merge_backup_20261028 cascade;
-- ats_backup_20260905: 7 table(s), 1120 row(s), exported 2026-11-13
drop schema if exists ats_backup_20260905 cascade;
-- phoenix_crm_merge_backup_20261012: 10 table(s), 686 row(s), exported 2026-11-19
drop schema if exists phoenix_crm_merge_backup_20261012 cascade;
-- expense_refresh_backup_20260829: 3 table(s), 752 row(s), exported 2026-11-13
drop schema if exists expense_refresh_backup_20260829 cascade;
-- pos_quarantine_backup_20260830: 2 table(s), 223 row(s), exported 2026-11-13
drop schema if exists pos_quarantine_backup_20260830 cascade;
-- outstation_backup_20260913: 1 table(s), 73 row(s), exported 2026-11-13
drop schema if exists outstation_backup_20260913 cascade;
-- sos_backup_20260909: 1 table(s), 893 row(s), exported 2026-11-13
drop schema if exists sos_backup_20260909 cascade;
-- ats_backup_20260913: 1 table(s), 1249 row(s), exported 2026-11-13
drop schema if exists ats_backup_20260913 cascade;
-- phoenix_crm_merge_backup_20261008: 8 table(s), 363 row(s), exported 2026-11-19
drop schema if exists phoenix_crm_merge_backup_20261008 cascade;
-- zz_rollback_archive_20260830: 7 table(s), 139 row(s), exported 2026-11-13
drop schema if exists zz_rollback_archive_20260830 cascade;
-- crm_backup_20261001: 3 table(s), 146 row(s), exported 2026-11-13
drop schema if exists crm_backup_20261001 cascade;
-- outstation_backup_20260908: 3 table(s), 334 row(s), exported 2026-11-13
drop schema if exists outstation_backup_20260908 cascade;
-- sos_contradiction_sweep_20260910: 6 table(s), 359 row(s), exported 2026-11-13
drop schema if exists sos_contradiction_sweep_20260910 cascade;
-- zz_search_proof: 3 table(s), 527 row(s), exported 2026-11-19
drop schema if exists zz_search_proof cascade;
-- direct_order_backup_20260906: 11 table(s), 86 row(s), exported 2026-11-13
drop schema if exists direct_order_backup_20260906 cascade;
-- ats_backup_20260928_hiredfix: 3 table(s), 35 row(s), exported 2026-11-13
drop schema if exists ats_backup_20260928_hiredfix cascade;
-- manfalut_align_20260911: 4 table(s), 942 row(s), exported 2026-11-13
drop schema if exists manfalut_align_20260911 cascade;
-- sos_backup_20261010: 2 table(s), 145 row(s), exported 2026-11-19
drop schema if exists sos_backup_20261010 cascade;
-- direct_aug_hand_backup_20260914: 3 table(s), 966 row(s), exported 2026-11-13
drop schema if exists direct_aug_hand_backup_20260914 cascade;
-- store_split_backup_20261013: 1 table(s), 1492 row(s), exported 2026-11-19
drop schema if exists store_split_backup_20261013 cascade;
-- plan_backup_20260913: 14 table(s), 18 row(s), exported 2026-11-13
drop schema if exists plan_backup_20260913 cascade;
-- july_attribution_backup_20260911: 2 table(s), 927 row(s), exported 2026-11-13
drop schema if exists july_attribution_backup_20260911 cascade;
-- qema_discount_backup_20260907: 2 table(s), 105 row(s), exported 2026-11-13
drop schema if exists qema_discount_backup_20260907 cascade;
-- ep_backup_20261009: 5 table(s), 190 row(s), exported 2026-11-19
drop schema if exists ep_backup_20261009 cascade;
-- ats_merge_backup_20260912: 6 table(s), 15 row(s), exported 2026-11-13
drop schema if exists ats_merge_backup_20260912 cascade;
-- discount_factor_backup_20260907: 1 table(s), 10 row(s), exported 2026-11-13
drop schema if exists discount_factor_backup_20260907 cascade;
-- attendance_backup_20260917: 4 table(s), 57 row(s), exported 2026-11-13
drop schema if exists attendance_backup_20260917 cascade;
-- whatsapp_backfill_20260902: 1 table(s), 31 row(s), exported 2026-11-13
drop schema if exists whatsapp_backfill_20260902 cascade;
-- attendance_wording_backup_20260917: 2 table(s), 443 row(s), exported 2026-11-13
drop schema if exists attendance_wording_backup_20260917 cascade;
-- territory_restamp_backup_20260831: 2 table(s), 288 row(s), exported 2026-11-13
drop schema if exists territory_restamp_backup_20260831 cascade;
-- dop81_brick_fix_20260910: 5 table(s), 8 row(s), exported 2026-11-13
drop schema if exists dop81_brick_fix_20260910 cascade;
-- ats_backup_20260927: 5 table(s), 7 row(s), exported 2026-11-13
drop schema if exists ats_backup_20260927 cascade;
-- sos_coverage_backup_20260906: 1 table(s), 91 row(s), exported 2026-11-13
drop schema if exists sos_coverage_backup_20260906 cascade;
-- email_backup_20260909: 5 table(s), 12 row(s), exported 2026-11-13
drop schema if exists email_backup_20260909 cascade;
-- crm_backup_20261008: 5 table(s), 16 row(s), exported 2026-11-19
drop schema if exists crm_backup_20261008 cascade;
-- direct_area_backup_20260826: 3 table(s), 122 row(s), exported 2026-11-13
drop schema if exists direct_area_backup_20260826 cascade;
-- sohag_backup_20261009: 4 table(s), 63 row(s), exported 2026-11-19
drop schema if exists sohag_backup_20261009 cascade;
-- weekly_backup_20261026: 2 table(s), 68 row(s), exported 2026-11-19
drop schema if exists weekly_backup_20261026 cascade;
-- msn_backup_20261009: 1 table(s), 492 row(s), exported 2026-11-19
drop schema if exists msn_backup_20261009 cascade;
-- msn_backup_20261010: 1 table(s), 479 row(s), exported 2026-11-19
drop schema if exists msn_backup_20261010 cascade;
-- ats_backup_20260907: 4 table(s), 58 row(s), exported 2026-11-13
drop schema if exists ats_backup_20260907 cascade;
-- hossam_revert_backup_20260907: 2 table(s), 16 row(s), exported 2026-11-13
drop schema if exists hossam_revert_backup_20260907 cascade;
-- phx_backup_20261012: 2 table(s), 29 row(s), exported 2026-11-19
drop schema if exists phx_backup_20261012 cascade;
-- market_awareness_backup_20260907: 4 table(s), 16 row(s), exported 2026-11-13
drop schema if exists market_awareness_backup_20260907 cascade;
-- closing_backup_20260907: 3 table(s), 95 row(s), exported 2026-11-13
drop schema if exists closing_backup_20260907 cascade;
-- au_backup_20261012: 2 table(s), 104 row(s), exported 2026-11-19
drop schema if exists au_backup_20261012 cascade;
-- bk_qershaya_backup_20260923: 3 table(s), 10 row(s), exported 2026-11-13
drop schema if exists bk_qershaya_backup_20260923 cascade;
-- ats_backup_20261017_manager_folders: 2 table(s), 139 row(s), exported 2026-11-19
drop schema if exists ats_backup_20261017_manager_folders cascade;
-- plan_audit_backup_20260905: 3 table(s), 58 row(s), exported 2026-11-13
drop schema if exists plan_audit_backup_20260905 cascade;
-- plan_audit_backup_20260920: 3 table(s), 15 row(s), exported 2026-11-13
drop schema if exists plan_audit_backup_20260920 cascade;
-- marketing_merge_revert_backup_20260906: 3 table(s), 4 row(s), exported 2026-11-13
drop schema if exists marketing_merge_revert_backup_20260906 cascade;
-- plan_backups: 1 table(s), 1 row(s), exported 2026-11-19
drop schema if exists plan_backups cascade;
-- preimage_backup_20260928: 3 table(s), 18 row(s), exported 2026-11-13
drop schema if exists preimage_backup_20260928 cascade;
-- qusiya_backup_20261013: 3 table(s), 20 row(s), exported 2026-11-19
drop schema if exists qusiya_backup_20261013 cascade;
-- hr_backup_20260829: 3 table(s), 9 row(s), exported 2026-11-19
drop schema if exists hr_backup_20260829 cascade;
-- sos_september_split_rebuild_20261009: 2 table(s), 140 row(s), exported 2026-11-19
drop schema if exists sos_september_split_rebuild_20261009 cascade;
-- phoenix_crm_backup_20261013: 1 table(s), 105 row(s), exported 2026-11-19
drop schema if exists phoenix_crm_backup_20261013 cascade;
-- marketing_code_apply_backup_20260906: 2 table(s), 87 row(s), exported 2026-11-13
drop schema if exists marketing_code_apply_backup_20260906 cascade;
-- weekly_plan_backup_20261002: 2 table(s), 74 row(s), exported 2026-11-13
drop schema if exists weekly_plan_backup_20261002 cascade;
-- sos_backup_20260911: 1 table(s), 111 row(s), exported 2026-11-13
drop schema if exists sos_backup_20260911 cascade;
-- dist_backup_20260912: 1 table(s), 65 row(s), exported 2026-11-13
drop schema if exists dist_backup_20260912 cascade;
-- attendance_map_backup_20260923: 2 table(s), 29 row(s), exported 2026-11-13
drop schema if exists attendance_map_backup_20260923 cascade;
-- lacto_family_backup_20260831: 2 table(s), 6 row(s), exported 2026-11-13
drop schema if exists lacto_family_backup_20260831 cascade;
-- market_awareness_backup_20260909: 2 table(s), 4 row(s), exported 2026-11-13
drop schema if exists market_awareness_backup_20260909 cascade;
-- marketing_reopen_backup_20260906: 2 table(s), 12 row(s), exported 2026-11-13
drop schema if exists marketing_reopen_backup_20260906 cascade;
-- marketing_reopen_backup_20260923: 2 table(s), 6 row(s), exported 2026-11-13
drop schema if exists marketing_reopen_backup_20260923 cascade;
-- hr_backup_20260906: 2 table(s), 14 row(s), exported 2026-11-13
drop schema if exists hr_backup_20260906 cascade;
-- ez_backup_20261010: 2 table(s), 55 row(s), exported 2026-11-19
drop schema if exists ez_backup_20261010 cascade;
-- recruitment_backup_20261008: 1 table(s), 2 row(s), exported 2026-11-19
drop schema if exists recruitment_backup_20261008 cascade;
-- bab_elsheria_backup_20260911: 2 table(s), 24 row(s), exported 2026-11-13
drop schema if exists bab_elsheria_backup_20260911 cascade;
-- tahrir_sadat_backup_20260918: 2 table(s), 17 row(s), exported 2026-11-13
drop schema if exists tahrir_sadat_backup_20260918 cascade;
-- wa_backup_20260921: 2 table(s), 12 row(s), exported 2026-11-13
drop schema if exists wa_backup_20260921 cascade;
-- crm_backup_20261003: 1 table(s), 19 row(s), exported 2026-11-19
drop schema if exists crm_backup_20261003 cascade;
-- keep_bricks_backup_20260911: 1 table(s), 57 row(s), exported 2026-11-13
drop schema if exists keep_bricks_backup_20260911 cascade;
-- direct_order_hrid_backup_20260926: 1 table(s), 152 row(s), exported 2026-11-13
drop schema if exists direct_order_hrid_backup_20260926 cascade;
-- epda_backup_20261009: 1 table(s), 18 row(s), exported 2026-11-19
drop schema if exists epda_backup_20261009 cascade;
-- sos_backup_20261002: 1 table(s), 41 row(s), exported 2026-11-13
drop schema if exists sos_backup_20261002 cascade;
-- marketing_link_backfill_20260908: 1 table(s), 81 row(s), exported 2026-11-13
drop schema if exists marketing_link_backfill_20260908 cascade;
-- payroll_backup_20260904: 1 table(s), 122 row(s), exported 2026-11-13
drop schema if exists payroll_backup_20260904 cascade;
-- crm_backup_20260828: 2 table(s), 1 row(s), exported 2026-11-19
drop schema if exists crm_backup_20260828 cascade;
-- phx_plan_delete_backup_20260926: 1 table(s), 11 row(s), exported 2026-11-13
drop schema if exists phx_plan_delete_backup_20260926 cascade;
-- phx_crm_backup_20261010: 1 table(s), 7 row(s), exported 2026-11-19
drop schema if exists phx_crm_backup_20261010 cascade;
-- epda_sep_resplit_20261010: 1 table(s), 24 row(s), exported 2026-11-19
drop schema if exists epda_sep_resplit_20261010 cascade;
-- hiring_backup_20260930: 1 table(s), 17 row(s), exported 2026-11-13
drop schema if exists hiring_backup_20260930 cascade;
-- sos_map_backup_20260907: 1 table(s), 5 row(s), exported 2026-11-13
drop schema if exists sos_map_backup_20260907 cascade;
-- outstation_backup_20260919: 1 table(s), 0 row(s), exported 2026-11-13
drop schema if exists outstation_backup_20260919 cascade;
-- tahrir_sadat_backup_20260917: 1 table(s), 14 row(s), exported 2026-11-13
drop schema if exists tahrir_sadat_backup_20260917 cascade;
-- kes_alias_backup_20260911: 1 table(s), 8 row(s), exported 2026-11-13
drop schema if exists kes_alias_backup_20260911 cascade;
-- tahrir_split_20260911: 1 table(s), 19 row(s), exported 2026-11-13
drop schema if exists tahrir_split_20260911 cascade;
-- hossam_cover_backup_20260830: 1 table(s), 6 row(s), exported 2026-11-13
drop schema if exists hossam_cover_backup_20260830 cascade;
-- vacancies_backup_20261026: 1 table(s), 1 row(s), exported 2026-11-19
drop schema if exists vacancies_backup_20261026 cascade;
-- hr_backup_20261001: 1 table(s), 3 row(s), exported 2026-11-13
drop schema if exists hr_backup_20261001 cascade;
-- railways_backup_20261010: 1 table(s), 49 row(s), exported 2026-11-19
drop schema if exists railways_backup_20261010 cascade;
-- sales_backup_20260905: 1 table(s), 30 row(s), exported 2026-11-13
drop schema if exists sales_backup_20260905 cascade;
-- qema_rollup_backup_20260907: 1 table(s), 24 row(s), exported 2026-11-13
drop schema if exists qema_rollup_backup_20260907 cascade;
-- sos_backup_20260907: 1 table(s), 3 row(s), exported 2026-11-13
drop schema if exists sos_backup_20260907 cascade;
-- customer_map_backup_20260907: 1 table(s), 4 row(s), exported 2026-11-13
drop schema if exists customer_map_backup_20260907 cascade;
-- ps_sep_remap_20261010: 1 table(s), 15 row(s), exported 2026-11-19
drop schema if exists ps_sep_remap_20261010 cascade;
-- product_price_backup_20260904: 1 table(s), 1 row(s), exported 2026-11-13
drop schema if exists product_price_backup_20260904 cascade;
-- preimage_backup_20260929: 1 table(s), 1 row(s), exported 2026-11-13
drop schema if exists preimage_backup_20260929 cascade;
-- brick_move_backup_20261026: 1 table(s), 8 row(s), exported 2026-11-19
drop schema if exists brick_move_backup_20261026 cascade;
-- recruitment_backup_20261016: 1 table(s), 9 row(s), exported 2026-11-19
drop schema if exists recruitment_backup_20261016 cascade;
-- au.zz_rollup_pre_20260909_all: 1 table(s), 6980 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists au.zz_rollup_pre_20260909_all;
-- public.address_brick_moves_20261013: 1 table(s), 1462 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists public.address_brick_moves_20261013;
-- au.zz_aug_rollup_pre_20260909: 1 table(s), 876 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists au.zz_aug_rollup_pre_20260909;
-- au.monthly_targets_pedia_oct2026_backup_20261002: 1 table(s), 144 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists au.monthly_targets_pedia_oct2026_backup_20261002;
-- au.zz_brick_backfill_snapshot_20260827: 1 table(s), 166 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists au.zz_brick_backfill_snapshot_20260827;
-- au.bak_20261015c_aif_rollup_jul_sep: 1 table(s), 306 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists au.bak_20261015c_aif_rollup_jul_sep;
-- au.bak_20261008_pd0021_decline_revert: 1 table(s), 1 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists au.bak_20261008_pd0021_decline_revert;
-- au.bak_20261008_orphaned_direct_orders: 1 table(s), 5 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists au.bak_20261008_orphaned_direct_orders;
-- au.bak_20261008_orphaned_direct_order_items: 1 table(s), 6 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists au.bak_20261008_orphaned_direct_order_items;
-- au.bak_20261008_orphaned_direct_order_steps: 1 table(s), 18 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists au.bak_20261008_orphaned_direct_order_steps;
-- au.bak_20261008_orphaned_direct_order_events: 1 table(s), 22 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists au.bak_20261008_orphaned_direct_order_events;
-- au.bak_20260919_ismailia_suez_line_area_map: 1 table(s), 4 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists au.bak_20260919_ismailia_suez_line_area_map;
-- au.bak_20260919_ismailia_suez_seats: 1 table(s), 1 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists au.bak_20260919_ismailia_suez_seats;
-- au.bak_move_ai0002_b177_emp_20260923: 1 table(s), 2 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists au.bak_move_ai0002_b177_emp_20260923;
-- au.bak_move_ai0002_b177_occ_20260923: 1 table(s), 6 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists au.bak_move_ai0002_b177_occ_20260923;
-- au.bak_move_ai0002_b177_lam_20260923: 1 table(s), 4 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists au.bak_move_ai0002_b177_lam_20260923;
-- au.bak_20261002_luxor_rep_seat_revert: 1 table(s), 1 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists au.bak_20261002_luxor_rep_seat_revert;
-- au.bak_20261002_ped_d16_occupancy: 1 table(s), 3 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists au.bak_20261002_ped_d16_occupancy;
-- au.bak_20261002_ped_ue_split_occupancy: 1 table(s), 4 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists au.bak_20261002_ped_ue_split_occupancy;
-- au.bak_20261015_aif_kfs2_d1_line_area_map: 1 table(s), 57 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists au.bak_20261015_aif_kfs2_d1_line_area_map;
-- au.bak_20261015b_aif_kfs2_july_line_area_map: 1 table(s), 58 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists au.bak_20261015b_aif_kfs2_july_line_area_map;
-- au.bak_20261008_luxor_notes_fix: 1 table(s), 1 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists au.bak_20261008_luxor_notes_fix;
-- au.bak_20260909_pedia_ue_split_line_area_map: 1 table(s), 50 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists au.bak_20260909_pedia_ue_split_line_area_map;
-- au.bak_20260909_pedia_ue_split_seats: 1 table(s), 45 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists au.bak_20260909_pedia_ue_split_seats;
-- au.bak_20260828_d3_line_area_map: 1 table(s), 5 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists au.bak_20260828_d3_line_area_map;
-- au.bak_20260828_d3_seats: 1 table(s), 1 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists au.bak_20260828_d3_seats;
-- au.bak_20260912_pedia_kfs_d1_line_area_map: 1 table(s), 61 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists au.bak_20260912_pedia_kfs_d1_line_area_map;
-- au.bak_20260912_pedia_kfs_d1_seats: 1 table(s), 49 row(s), exported 2026-11-19
-- SAFE: the owner decided export-then-drop; its manifest is verified, nothing depends on it
drop table if exists au.bak_20260912_pedia_kfs_d1_seats;

commit;
