-- Enable deny-all RLS on the 6 zz_backup_* ad-hoc backup tables added 2026-08-27.
--
-- WHY. Companion to 20260827190000_zz_backup_tables_primary_keys_20260827.sql, which clears the
-- `missing_primary_key` ERROR. This clears the `rls_disabled` WARNING the same 6 tables carry.
-- Same pairing the owner instructed on 2026-08-23 for the previous batch of 8 -- see
-- 20260823140000_zz_backup_tables_enable_rls.sql -- applied here to the new batch.
--
-- A warning, not a breach, and the check says so itself: nothing browser-facing can reach these
-- tables today. All 6 carry relacl {postgres, service_role} -- no anon, no authenticated, verified
-- directly against production both by reading pg_class.relacl and by testing
-- `set local role anon` / `set local role authenticated`, each returning `permission denied` on
-- every one of the 6. The reason to do it anyway is the same one the 2026-08-23 file gives: it
-- "removes the safety net if a grant is ever added" -- see 20260804..._secure_adhoc_backup_tables
-- _enable_rls for what that costs when the safety net is missing.
--
-- NO POLICY IS CREATED, AND THAT IS THE POINT. RLS enabled with zero policies denies everything to
-- every non-bypassing role -- it is the strictest possible state, not an unfinished migration. It
-- will show up in check-schema-shape.ts as `rls_enabled_without_policy` (a WARNING, alongside the
-- other tables already in that state), which is the correct classification.
--
-- VERIFIED SAFE FOR RESTORES BEFORE WRITING THIS, same roles as the 2026-08-23 file (unchanged
-- since):
--
--   postgres        rolbypassrls = true      <- migration runner and table owner
--   service_role    rolbypassrls = true      <- what every app code path actually uses
--   authenticated   rolbypassrls = false
--   anon            rolbypassrls = false
--
-- So this blocks precisely the two browser roles and changes nothing for a restore
-- (`insert into <target> select * from zz_backup_...` runs as a bypassing role). FORCE ROW LEVEL
-- SECURITY is deliberately NOT set: without it, the table owner is exempt too.
--
-- GUARDED and IDEMPOTENT for the same reasons as the primary-key file. None of these 6 tables were
-- created by a committed migration, so they exist on PRODUCTION ONLY -- an unconditional ALTER
-- TABLE would fail elsewhere with 42P01. A table that already has RLS enabled is skipped.
--
-- ROLLBACK: alter table public.<name> disable row level security;  (per table, no data effect.)

do $$
declare
  target text;
  rel    regclass;
begin
  foreach target in array array[
    'zz_backup_ats_candidate_cv_extractions_20260824',
    'zz_backup_ats_candidates_20260824',
    'zz_backup_ats_cv_intake_events_20260824',
    'zz_backup_ats_files_20260824',
    'zz_backup_sos_dpr_ez_20260826',
    'zz_backup_is_stock_branch_map_20260827'
  ]
  loop
    rel := to_regclass('public.' || quote_ident(target));

    -- Absent: every environment except production. Nothing to secure.
    if rel is null then
      raise notice 'zz-rls: public.% absent, skipped', target;
      continue;
    end if;

    -- Already on: leave it exactly as it is.
    if (select c.relrowsecurity from pg_class c where c.oid = rel) then
      raise notice 'zz-rls: public.% already has RLS enabled, skipped', target;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', target);
    raise notice 'zz-rls: public.% now deny-all (RLS on, no policy)', target;
  end loop;
end
$$;
