-- Public wrapper so the app can read au.regions via PostgREST — needed because au.regions'
-- region_code vocabulary is sometimes MORE granular than source_of_sales_regions: e.g. Anti
-- Infective operationally splits Upper Egypt into "UE-1"/"UE-2" DM territories (au_v_line_area_map
-- reflects that split via operational_region_code), while source_of_sales_regions only has one
-- plain "UE" row. Without this, a nationwide (National Sales Manager) or multi-region (Regional
-- Manager) viewer whose subtree touches such a split region would have real areas/sales data
-- (reachable via the API) with no matching region name to display them under in the tree.
--
-- Mirrors the existing au_v_canonical_areas/au_v_line_area_map wrapper-view pattern exactly, but
-- with the final, already-hardened privilege state applied immediately (service_role-only) rather
-- than needing the follow-up hardening migrations those views originally required.
create or replace view public.au_v_regions as
  select region_code, region_name, is_other, carries_target, is_active
  from au.regions;

revoke all on public.au_v_regions from anon, authenticated, public;
grant select on public.au_v_regions to service_role;
