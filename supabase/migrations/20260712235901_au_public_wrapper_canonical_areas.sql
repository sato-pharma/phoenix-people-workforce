-- Public wrapper so the app (and import guard) can read the 42 canonical areas via PostgREST.
-- (anon/authenticated SELECT is revoked in au_hardening_rls_indexes_trigger; writes are removed in
--  au_lockdown_public_wrapper_view_writes/_maintain — service_role only.)
create or replace view public.au_v_canonical_areas as
  select area_code, area_name, code_region_code, is_permanent_other, sort_order, is_active
  from au.canonical_areas;
grant select on public.au_v_canonical_areas to anon, authenticated, service_role;
