-- PostgREST/supabase-js only exposes the public schema; thin wrappers let the app read the au views.
-- (SELECT grants to anon/authenticated here are tightened later: au_hardening_rls_indexes_trigger
--  revokes anon/authenticated SELECT, and au_lockdown_public_wrapper_view_writes/_maintain strip writes.)
create or replace view public.au_v_org_tree as select * from au.v_org_tree;
create or replace view public.au_v_org_structure_kpis as select * from au.v_org_structure_kpis;
create or replace view public.au_v_line_area_map as
  select m.*, ca.area_name from au.line_area_map m join au.canonical_areas ca on ca.area_code = m.area_code;
grant select on public.au_v_org_tree, public.au_v_org_structure_kpis, public.au_v_line_area_map to anon, authenticated, service_role;
