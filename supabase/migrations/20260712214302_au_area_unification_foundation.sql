-- au area-unification foundation: schema + reference/seat model tables.
-- Packaged from the staging-applied migration (project cifwmndunmlxjhyjugxa) for Phase 9 production apply.
create schema if not exists au;

create table au.regions (
  region_code text primary key,
  region_name text not null,
  is_other boolean not null default false,
  carries_target boolean generated always as (not is_other) stored,
  is_active boolean not null default true
);

create table au.lines (
  line_code text primary key,
  line_id bigint,
  line_name text not null,
  has_rsm_layer boolean not null default false,
  is_closing_line boolean not null default true,
  is_active boolean not null default true
);

create table au.canonical_areas (
  area_code text primary key,
  area_name text not null,
  code_region_code text not null references au.regions(region_code) on delete restrict,
  is_permanent_other boolean not null default false,
  sort_order int,
  is_active boolean not null default true
);

create table au.sos_official_line_map (
  official_line text primary key,
  line_code text not null references au.lines(line_code) on delete restrict
);

create table au.sos_area_crosswalk (
  sos_area_code text primary key,
  canonical_area_code text not null references au.canonical_areas(area_code) on delete restrict,
  brick_scope text not null default 'all' check (brick_scope in ('all','specific')),
  effective_from date,
  effective_to date
);

create table au.seats (
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

create table au.line_area_map (
  line_code text not null references au.lines(line_code) on delete restrict,
  area_code text not null references au.canonical_areas(area_code) on delete restrict,
  operational_region_code text not null references au.regions(region_code) on delete restrict,
  area_state text not null check (area_state in ('occupied','vacant_will_hire','other_line_specific','other_permanent')),
  dm_seat_id text references au.seats(seat_id) on delete restrict,
  rep_seat_id text references au.seats(seat_id) on delete restrict,
  other_type text,
  staffed_in_line_code text, -- comma-separated line_code(s); can hold multiple (e.g. 'cns, pedia'), so intentionally NOT an FK (matches staging reality + the documented design in au_area_unification_schema.sql).
  carries_target boolean generated always as (area_state in ('occupied','vacant_will_hire')) stored,
  effective_from date not null default '2026-07-13',
  effective_to date,
  notes text
);
create unique index line_area_map_current on au.line_area_map(line_code, area_code) where effective_to is null;

create table au.occupancy_history (
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
create unique index occupancy_open_span on au.occupancy_history(seat_id) where effective_to is null;
