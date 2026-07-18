-- Strip the residual inert MAINTAIN privilege too, so anon/authenticated hold zero privileges
-- on the au_v_* wrapper views (defense-in-depth; MAINTAIN is a no-op on a plain view).
revoke maintain
  on public.au_v_canonical_areas, public.au_v_line_area_map,
     public.au_v_org_structure_kpis, public.au_v_org_tree
  from anon, authenticated, public;
