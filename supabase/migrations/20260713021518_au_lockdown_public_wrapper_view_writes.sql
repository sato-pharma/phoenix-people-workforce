-- SEC-1/SEC-2 fix: the public.au_v_* wrapper views are owner-run (SECURITY DEFINER) and were
-- created with the Supabase default write grants to anon/authenticated. au_v_canonical_areas is
-- auto-updatable, so anon could INSERT/UPDATE/DELETE the 42-row canonical reference table the
-- attribution engine joins on. Revoke all write/DDL privileges from anon, authenticated, PUBLIC.
-- SELECT was already revoked; service_role + owner retain full access (the app reads via service_role),
-- so the read path is unchanged. security_invoker is intentionally left OFF (service_role lacks au USAGE).
revoke insert, update, delete, truncate, references, trigger
  on public.au_v_canonical_areas, public.au_v_line_area_map,
     public.au_v_org_structure_kpis, public.au_v_org_tree
  from anon, authenticated, public;
