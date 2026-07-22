-- iReports360 added region/regionID/speciality fields to its /visits response (observed
-- 2026-07-22 via a live API audit) that the sync engine did not previously capture. This adds
-- them as first-class columns (prefixed crm_region_* to avoid colliding with Phoenix's own
-- "region" concept in au.regions, which is a different, coarser geography) and introduces an
-- admin-resolvable mapping from a CRM region to a real Phoenix brick (source_of_sales_bricks),
-- mirroring the existing ireports360_crm_identity_resolutions "Unmapped Agents" pattern.

alter table public.ireports360_visits
  add column if not exists crm_region_id integer,
  add column if not exists crm_region_name text,
  add column if not exists speciality text;

comment on column public.ireports360_visits.crm_region_id is
  'iReports360''s own numeric region/locality id for the visited contact (vendor field: regionID). Finer-grained than Phoenix''s au.regions/canonical areas -- one Phoenix brick or area typically covers several distinct crm_region_id values. Null for non-customer visit types (campaign/meeting/leave), which carry no real contact.';
comment on column public.ireports360_visits.crm_region_name is
  'iReports360''s display name for crm_region_id (vendor field: region), e.g. "Dokki", "Nasr City".';
comment on column public.ireports360_visits.speciality is
  'The visited contact''s medical specialty/type from iReports360 (e.g. "Internal Medicine", "Pediatrics", "Hospital"). Null for non-customer visit types.';

create index if not exists ireports360_visits_crm_region_id_idx
  on public.ireports360_visits (crm_region_id)
  where crm_region_id is not null;

-- Admin resolution: which real Phoenix brick (source_of_sales_bricks) a given CRM region maps
-- to. status=pending (default, shows on the "Region Mapping" admin tab) / mapped (brick_id set,
-- resolved) / ignored (an admin decided this CRM region is not worth mapping -- e.g. a
-- CRM-side geography artifact or duplicate -- and it should stop appearing on the punch-list,
-- mirroring the "resigned" outcome on ireports360_crm_identity_resolutions).
create table if not exists public.ireports360_crm_region_brick_resolutions (
  crm_region_id integer primary key,
  crm_region_name text not null,
  brick_id text references public.source_of_sales_bricks(brick_id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'mapped', 'ignored')),
  resolved_by_hr_id text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ireports360_crm_region_brick_resolutions_brick_id_check
    check (status <> 'mapped' or brick_id is not null)
);

alter table public.ireports360_crm_region_brick_resolutions enable row level security;

revoke all on table public.ireports360_crm_region_brick_resolutions from anon, authenticated;

grant select, insert, update, delete on table public.ireports360_crm_region_brick_resolutions to service_role;

drop policy if exists ireports360_crm_region_brick_resolutions_service_role on public.ireports360_crm_region_brick_resolutions;
create policy ireports360_crm_region_brick_resolutions_service_role
  on public.ireports360_crm_region_brick_resolutions
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.ireports360_crm_region_brick_resolutions is
  'Admin resolution decisions mapping an iReports360 CRM region (crm_region_id) to a real Phoenix brick (source_of_sales_bricks.brick_id). status=mapped stamps the mapping for use by the CRM Master Table''s Area/Region ID columns (joined via source_of_sales_bricks.area_code/region_code); status=ignored hides a CRM region from the Region Mapping tab without ever assigning it a brick.';
