-- Area / Region / Zone / Line unification — schema + reference data (Phase 1).
--
-- BUSINESS CHANGE
-- The employee/HR side of the org (public.lines, public.areas, public.employees) never adopted
-- the Sales geography master (public.source_of_sales_regions / source_of_sales_areas). The same
-- physical area can legitimately belong to a DIFFERENT region depending on which of the 3 sales
-- lines you're looking at (e.g. Kafr El-Sheikh = region AB under Pedia, region D1 under
-- Anti-Infective) — something the old single "area -> region" model on employees.region_name
-- could never express. This migration:
--   1. Repoints public.lines.code / public.areas.code from their old auto-generated import-
--      matching slugs (anti_inf/pedia/cns/office; cairo/heliopolis/...) to the new short business
--      codes (PD/CS/AF/HO; AB1/CA1/D16/...) reconciled by hand against
--      Area_Region_Line_Unification_Template_v2.xlsx. The employee import pipeline
--      (src/lib/imports/*) is updated in the same delivery to match on these new codes instead of
--      the old slugs — see the accompanying code changes; do not apply this migration without them.
--   2. Adds public.line_area_region_map: the authoritative (line, area) -> region lookup, keyed off
--      source_of_sales_areas.area_code (NOT public.areas — several official areas, e.g. the OT
--      "Others" areas, have no staff and therefore no public.areas row at all).
--   3. Adds public.line_zones / line_zone_regions: DISPLAY-ONLY labels for a Regional Manager's
--      territory (e.g. PD-Z1 = {AB, D1, D2} for Hany Saad / PD-0001). These do NOT drive access
--      control — Sales visibility for RM continues to be computed dynamically from the org
--      hierarchy (see the Phase 2 code changes); a zone is just a friendly code to show in reports.
--   4. Adds employees.region_code, which replaces the free-text employees.region_name as the value
--      Sales scope resolution reads. region_name is left in place (deprecated) for now.
--
-- Employee-specific backfill (which hr_id gets which area_id/region_code) is a SEPARATE migration
-- (20260702190000_area_region_line_unification_backfill.sql) so the structural change here can be
-- reviewed independently of the per-employee data patch.
--
-- Re-runnable / idempotent: guarded updates + on-conflict inserts. Wrapped in a transaction.

begin;

-- 1) Line codes. Matched by id AND name so this only ever touches the 4 rows we reconciled;
--    if a name has since changed, the row is left alone rather than silently recoding the wrong line.
update public.lines set code = 'AF', updated_at = now() where id = 1 and name = 'Anti infective';
update public.lines set code = 'PD', updated_at = now() where id = 2 and name = 'Pedia';
update public.lines set code = 'CS', updated_at = now() where id = 3 and name = 'CNS';
update public.lines set code = 'HO', updated_at = now() where id = 4 and name = 'Head Office';

-- 2) Area codes. One canonical public.areas row per official Sales-geography area_code, chosen by
--    matching the existing (messy, duplicate-heavy) area names against the reconciled official
--    area list. Rows not picked here (roughly 41 of the 81 current areas — old duplicates like
--    "Cairo East 2" vs "Cairo East 3,4,5 (East1)") are left untouched; see Task decision to leave
--    orphaned rows alone for now.
update public.areas set code = v.area_code, updated_at = now()
from (values
  (55,'AB1'),(27,'AB2'),(28,'AB3'),(24,'AB4'),(25,'AB5'),
  (2,'CA1'),(3,'CA2'),(43,'CA3'),(4,'CA4'),(69,'CA5'),(6,'CA6'),
  (78,'D11'),(59,'D12'),(60,'D13'),(76,'D14'),(77,'D15'),(75,'D16'),
  (36,'D21'),(37,'D22'),(38,'D23'),(79,'D24'),(63,'D25'),(62,'D26'),
  (49,'GZ1'),(47,'GZ2'),(10,'GZ3'),(46,'GZ4'),(48,'GZ5'),(50,'GZ6'),(45,'GZ7'),
  (13,'UE1'),(15,'UE2'),(18,'UE3'),(17,'UE4'),(52,'UE5'),(53,'UE6'),(51,'UE7')
) as v(area_id, area_code)
where public.areas.id = v.area_id;

-- 3) Authoritative per-line region for every official area, reconciled from the "Areas & Regions"
--    sheet. Keyed off source_of_sales_areas.area_code (always complete, incl. the 3 unstaffed
--    "Others" areas) rather than public.areas.id.
create table if not exists public.line_area_region_map (
  line_id bigint not null references public.lines(id) on update cascade on delete cascade,
  area_code text not null references public.source_of_sales_areas(area_code) on update cascade on delete restrict,
  region_code text not null references public.source_of_sales_regions(region_code) on update cascade on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (line_id, area_code)
);

insert into public.line_area_region_map (line_id, area_code, region_code)
select l.id, v.area_code, v.region_code
from (values
  ('AB1','PD','AB'),('AB1','CS','AB'),('AB1','AF','AB'),
  ('AB2','PD','AB'),('AB2','CS','AB'),('AB2','AF','AB'),
  ('AB3','PD','AB'),('AB3','CS','AB'),('AB3','AF','AB'),
  ('AB4','PD','AB'),('AB4','CS','AB'),('AB4','AF','AB'),
  ('AB5','PD','AB'),('AB5','CS','AB'),('AB5','AF','AB'),
  ('CA1','PD','CA'),('CA1','CS','CA'),('CA1','AF','CA'),
  ('CA2','PD','CA'),('CA2','CS','CA'),('CA2','AF','CA'),
  ('CA3','PD','CA'),('CA3','CS','CA'),('CA3','AF','CA'),
  ('CA4','PD','CA'),('CA4','CS','CA'),('CA4','AF','CA'),
  ('CA5','PD','CA'),('CA5','CS','GZ'),('CA5','AF','OT'),
  ('CA6','PD','CA'),('CA6','CS','CA'),('CA6','AF','CA'),
  ('D11','PD','D1'),('D11','CS','D1'),('D11','AF','D1'),
  ('D12','PD','D1'),('D12','CS','D1'),('D12','AF','D1'),
  ('D13','PD','D1'),('D13','CS','D1'),('D13','AF','D1'),
  ('D14','PD','D1'),('D14','CS','D1'),('D14','AF','D1'),
  ('D15','PD','D1'),('D15','CS','D1'),('D15','AF','D1'),
  ('D16','PD','AB'),('D16','CS','AB'),('D16','AF','D1'),
  ('D21','PD','D2'),('D21','CS','D2'),('D21','AF','D2'),
  ('D22','PD','D2'),('D22','CS','D2'),('D22','AF','D2'),
  ('D23','PD','D2'),('D23','CS','D2'),('D23','AF','D2'),
  ('D24','PD','D2'),('D24','CS','D2'),('D24','AF','D2'),
  ('D25','PD','D2'),('D25','CS','D2'),('D25','AF','OT'),
  ('D26','PD','D2'),('D26','CS','D2'),('D26','AF','D2'),
  ('GZ1','PD','GZ'),('GZ1','CS','GZ'),('GZ1','AF','GZ'),
  ('GZ2','PD','GZ'),('GZ2','CS','GZ'),('GZ2','AF','GZ'),
  ('GZ3','PD','GZ'),('GZ3','CS','OT'),('GZ3','AF','GZ'),
  ('GZ4','PD','GZ'),('GZ4','CS','GZ'),('GZ4','AF','GZ'),
  ('GZ5','PD','GZ'),('GZ5','CS','GZ'),('GZ5','AF','GZ'),
  ('GZ6','PD','GZ'),('GZ6','CS','OT'),('GZ6','AF','UE'),
  ('GZ7','PD','GZ'),('GZ7','CS','OT'),('GZ7','AF','OT'),
  ('OT1','PD','OT'),('OT1','CS','OT'),('OT1','AF','OT'),
  ('OT2','PD','OT'),('OT2','CS','OT'),('OT2','AF','OT'),
  ('OT3','PD','OT'),('OT3','CS','OT'),('OT3','AF','OT'),
  ('UE1','PD','UE'),('UE1','CS','UE'),('UE1','AF','UE'),
  ('UE2','PD','UE'),('UE2','CS','UE'),('UE2','AF','UE'),
  ('UE3','PD','UE'),('UE3','CS','UE'),('UE3','AF','UE'),
  ('UE4','PD','UE'),('UE4','CS','UE'),('UE4','AF','UE'),
  ('UE5','PD','UE'),('UE5','CS','UE'),('UE5','AF','UE'),
  ('UE6','PD','UE'),('UE6','CS','UE'),('UE6','AF','UE'),
  ('UE7','PD','UE'),('UE7','CS','UE'),('UE7','AF','UE')
) as v(area_code, line_code, region_code)
join public.lines l on l.code = v.line_code
on conflict (line_id, area_code) do update set
  region_code = excluded.region_code,
  updated_at = now();

-- 4) Zones — display-only RM territory labels. Not read by any access-control code path.
create table if not exists public.line_zones (
  zone_code text primary key,
  line_id bigint not null references public.lines(id) on update cascade on delete cascade,
  rm_hr_id text null references public.employees(hr_id) on update cascade on delete set null,
  label text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.line_zone_regions (
  zone_code text not null references public.line_zones(zone_code) on update cascade on delete cascade,
  region_code text not null references public.source_of_sales_regions(region_code) on update cascade on delete restrict,
  primary key (zone_code, region_code)
);

insert into public.line_zones (zone_code, line_id, rm_hr_id, label)
select 'PD-Z1', l.id, 'PD-0001', 'Regional Sales Manager territory'
from public.lines l where l.code = 'PD'
on conflict (zone_code) do update set
  line_id = excluded.line_id, rm_hr_id = excluded.rm_hr_id, label = excluded.label, updated_at = now();

-- Joined against line_zones (not a bare VALUES insert) so this no-ops instead of throwing an FK
-- violation if the PD line/zone didn't get created above (e.g. reconciled line names differ).
insert into public.line_zone_regions (zone_code, region_code)
select z.zone_code, v.region_code
from public.line_zones z
join (values ('PD-Z1', 'AB'), ('PD-Z1', 'D1'), ('PD-Z1', 'D2')) as v(zone_code, region_code)
  on v.zone_code = z.zone_code
on conflict (zone_code, region_code) do nothing;

-- 5) employees.region_code replaces employees.region_name as the value Sales scope resolution
--    reads (see Phase 2 code changes). region_name is left in place, deprecated, for now.
alter table public.employees
  add column if not exists region_code text null
    references public.source_of_sales_regions(region_code) on update cascade on delete set null;

create index if not exists employees_region_code_idx on public.employees (region_code);

commit;
