-- ============================================================================
-- Area Unification ("au") schema — 42 fixed areas / seat model
-- ----------------------------------------------------------------------------
-- Reproducible DDL for the new canonical org+geography model that the
-- organogram (and, in later phases, employee master, lifecycle, and the
-- automatic sales closing) is rebuilt on. DATA is loaded separately from the
-- owner's line workbook (see scratchpad generators); this file is schema only.
--
-- Applied to STAGING (cifwmndunmlxjhyjugxa) as migrations:
--   au_area_unification_foundation, au_organogram_read_views, au_org_tree_add_names,
--   au_public_wrapper_views_for_rest.
-- Numbered supabase/migrations/*.sql versions are produced at the prod-prep step.
--
-- Principles: areas are line-INDEPENDENT (42 fixed); region is per-line via
-- line_area_map; the SEAT is the continuity unit (seat_id is never an HR_ID);
-- all FKs are ON DELETE RESTRICT (never SET NULL); one open occupancy span per
-- seat; one current mapping per (line, area).
-- ============================================================================

create schema if not exists au;

create table if not exists au.regions (
  region_code text primary key,
  region_name text not null,
  is_other boolean not null default false,
  carries_target boolean generated always as (not is_other) stored,
  is_active boolean not null default true
);

create table if not exists au.lines (
  line_code text primary key,
  line_id bigint,
  line_name text not null,
  has_rsm_layer boolean not null default false,
  is_closing_line boolean not null default true,
  is_active boolean not null default true
);

create table if not exists au.canonical_areas (
  area_code text primary key,
  area_name text not null,
  code_region_code text not null references au.regions(region_code) on delete restrict,
  is_permanent_other boolean not null default false,
  sort_order int,
  is_active boolean not null default true
);

create table if not exists au.sos_official_line_map (
  official_line text primary key,
  line_code text not null references au.lines(line_code) on delete restrict
);

create table if not exists au.sos_area_crosswalk (
  sos_area_code text primary key,
  canonical_area_code text not null references au.canonical_areas(area_code) on delete restrict,
  brick_scope text not null default 'all' check (brick_scope in ('all','specific')),
  effective_from date,
  effective_to date
);

create table if not exists au.seats (
  seat_id text primary key check (seat_id like 'SEAT-%'),
  seat_tier text not null check (seat_tier in ('CEO','NSM','RSM','DM','ACTING_DM','REP')),
  line_code text references au.lines(line_code) on delete restrict,
  region_code text references au.regions(region_code) on delete restrict,
  area_code text references au.canonical_areas(area_code) on delete restrict,
  rsm_group text,
  parent_seat_id text references au.seats(seat_id) on delete restrict,
  is_other_pseudo_dm boolean not null default false,
  seat_label text,
  is_active boolean not null default true,
  effective_from date,
  effective_to date
);

create table if not exists au.line_area_map (
  line_code text not null references au.lines(line_code) on delete restrict,
  area_code text not null references au.canonical_areas(area_code) on delete restrict,
  operational_region_code text not null references au.regions(region_code) on delete restrict,
  area_state text not null check (area_state in ('occupied','vacant_will_hire','other_line_specific','other_permanent')),
  dm_seat_id text references au.seats(seat_id) on delete restrict,
  rep_seat_id text references au.seats(seat_id) on delete restrict,
  other_type text,
  staffed_in_line_code text,   -- informational: comma-separated line_code(s) that staff this area (not an FK; can be multiple)
  carries_target boolean generated always as (area_state in ('occupied','vacant_will_hire')) stored,
  effective_from date not null default current_date,
  effective_to date,
  notes text
);
create unique index if not exists line_area_map_current on au.line_area_map(line_code, area_code) where effective_to is null;

create table if not exists au.occupancy_history (
  occupancy_id bigint generated always as identity primary key,
  seat_id text not null references au.seats(seat_id) on delete restrict,
  occupant_hr_id text,
  occupant_canonical_hr_id text generated always as (lower(btrim(occupant_hr_id))) stored,
  node_type text not null default 'person' check (node_type in ('person','vacant_placeholder')),
  effective_from date not null,
  effective_to date,
  event_type text not null,
  line_code text, region_code text, area_code text,
  manager_seat_id text, manager_hr_id text,
  prev_occupancy_id bigint references au.occupancy_history(occupancy_id),
  change_reason text, source_system text, changed_by_hr_id text,
  created_at timestamptz not null default now()
);
create unique index if not exists occupancy_open_span on au.occupancy_history(seat_id) where effective_to is null;

-- ---------------------------------------------------------------------------
-- Read views: the organogram tree (climbs parent_seat_id) + structure KPIs.
-- ---------------------------------------------------------------------------
create or replace view au.v_org_tree as
with recursive tree as (
  select s.seat_id, s.parent_seat_id, s.seat_tier, s.line_code, s.region_code, s.area_code,
         s.is_other_pseudo_dm, s.seat_label, 0 as depth, array[s.seat_id] as path
  from au.seats s where s.parent_seat_id is null
  union all
  select c.seat_id, c.parent_seat_id, c.seat_tier, c.line_code, c.region_code, c.area_code,
         c.is_other_pseudo_dm, c.seat_label, t.depth + 1, t.path || c.seat_id
  from au.seats c join tree t on c.parent_seat_id = t.seat_id
)
select t.seat_id, t.parent_seat_id, t.seat_tier, t.line_code, t.region_code, t.area_code,
       t.is_other_pseudo_dm, t.seat_label, t.depth, t.path,
       o.occupant_hr_id, o.node_type, (o.occupant_hr_id is null) as is_vacant,
       ca.area_name, rg.region_name, ln.line_name, ln.line_id
from tree t
left join au.occupancy_history o on o.seat_id = t.seat_id and o.effective_to is null
left join au.canonical_areas ca on ca.area_code = t.area_code
left join au.regions rg on rg.region_code = t.region_code
left join au.lines ln on ln.line_code = t.line_code;

create or replace view au.v_org_structure_kpis as
select coalesce(s.line_code, '(root)') as line_code, s.seat_tier,
       count(*) as total,
       count(*) filter (where o.occupant_hr_id is not null) as filled,
       count(*) filter (where o.occupant_hr_id is null) as vacant
from au.seats s
left join au.occupancy_history o on o.seat_id = s.seat_id and o.effective_to is null
group by s.line_code, s.seat_tier;

-- Public wrappers (PostgREST/supabase-js only exposes the public schema).
create or replace view public.au_v_org_tree as select * from au.v_org_tree;
create or replace view public.au_v_org_structure_kpis as select * from au.v_org_structure_kpis;
create or replace view public.au_v_line_area_map as
  select m.*, ca.area_name from au.line_area_map m join au.canonical_areas ca on ca.area_code = m.area_code;
grant select on public.au_v_org_tree, public.au_v_org_structure_kpis, public.au_v_line_area_map
  to anon, authenticated, service_role;
