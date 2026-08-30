-- C11 · Retire the stale 2026-08-19 area/region rollback snapshot tables.
--
-- Background
--   Seven zz_*_2026_08_19 tables are the rollback pre-images captured for the
--   2026-08-19 area / region / code-resolution work. That work shipped and is
--   the current, confirmed-correct production state ("do NOT undo"), so 11 days
--   on these snapshots are a stale safety net cluttering the PostgREST-exposed
--   public surface. Verified against production 2026-08-30:
--     * tiny (1-39 rows each), owned by postgres;
--     * NOT exposed — neither anon nor authenticated can SELECT them
--       (RLS enabled, deny-all, grants revoked);
--     * self-contained — 0 inbound/outbound FKs, 0 triggers, 0 dependent
--       views/matviews;
--     * no reader/writer anywhere in src/ or app/, and no test pins them
--       (scoped greps: no match).
--
-- What this does
--   RENAMES the seven tables into an archive schema via ALTER ... SET SCHEMA
--   (each moves WITH its indexes, constraints and grants intact, and off the
--   public surface). This does NOT undo the 2026-08-19 data changes — it only
--   relocates the leftover rollback pre-images, which stay fully intact and
--   reversible. Direct twin of C7..C10 (...140000 / 150000 / 160000 / 181500).
--
-- Deliberately NOT included (too recent — fresh rollback nets, revisit later):
--   zz_backup_crm_*_20260828 (2 days old) and *_20260829_pre (1 day old).

create schema if not exists zz_rollback_archive_20260830;

comment on schema zz_rollback_archive_20260830 is
  'Retired 2026-08-30 (C11): the stale 2026-08-19 area/region rollback snapshot '
  'tables (7), pre-images for shipped-and-stable work, not exposed and referenced '
  'by no application code. Reversible via ALTER ... SET SCHEMA public.';

alter table public.zz_area_assign_2026_08_19            set schema zz_rollback_archive_20260830;
alter table public.zz_area_options_2026_08_19           set schema zz_rollback_archive_20260830;
alter table public.zz_rollback_ambiguous_codes_2026_08_19 set schema zz_rollback_archive_20260830;
alter table public.zz_rollback_flagged_areas_2026_08_19 set schema zz_rollback_archive_20260830;
alter table public.zz_rollback_region_areas_2026_08_19  set schema zz_rollback_archive_20260830;
alter table public.zz_rollback_resolver_2026_08_19      set schema zz_rollback_archive_20260830;
alter table public.zz_rollback_unowned_areas_2026_08_19 set schema zz_rollback_archive_20260830;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (run by hand if ever needed — moves everything back to public):
--
--   alter table zz_rollback_archive_20260830.zz_area_assign_2026_08_19            set schema public;
--   alter table zz_rollback_archive_20260830.zz_area_options_2026_08_19           set schema public;
--   alter table zz_rollback_archive_20260830.zz_rollback_ambiguous_codes_2026_08_19 set schema public;
--   alter table zz_rollback_archive_20260830.zz_rollback_flagged_areas_2026_08_19 set schema public;
--   alter table zz_rollback_archive_20260830.zz_rollback_region_areas_2026_08_19  set schema public;
--   alter table zz_rollback_archive_20260830.zz_rollback_resolver_2026_08_19      set schema public;
--   alter table zz_rollback_archive_20260830.zz_rollback_unowned_areas_2026_08_19 set schema public;
--   drop schema zz_rollback_archive_20260830;  -- only after the objects are moved back
-- ─────────────────────────────────────────────────────────────────────────────
