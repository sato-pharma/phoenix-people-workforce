-- Owner instruction: fully revert the area/region/line unification (done in
-- 20260707170000), EXCEPT keep Sales/Source-of-Sales region scoping (access-scope.ts,
-- portal-sos-dashboard.ts) working exactly as it did under the unification. Those two
-- files read employees.region_code, which the prior migration dropped. This migration
-- restores ONLY that column and its data -- it deliberately does NOT recreate
-- line_area_region_map, line_zones, line_zone_regions, or the areas.code/lines.code
-- short-code scheme; those remain fully reverted (organogram/areas stay exactly as
-- they were pre-unification).
--
-- The (area_code, line_code) -> region_code and (hr_id) -> region_code mappings below
-- are reproduced verbatim from 20260702190000_area_region_line_unification_backfill.sql
-- (the original backfill this whole chain already reverted once) via inline CTEs rather
-- than the now-removed line_area_region_map table, so the exact same 104 employees end
-- up with the exact same region_code values as before, with no other unification schema
-- coming back.

begin;

alter table public.employees
  add column if not exists region_code text null
    references public.source_of_sales_regions(region_code) on update cascade on delete set null;

create index if not exists employees_region_code_idx on public.employees (region_code);

-- Medical Reps: region_code derived from (line, area) exactly as the original backfill did,
-- just via an inline lookup instead of the (now removed) line_area_region_map table.
with area_line_region(area_code, line_code, region_code) as (
  values
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
),
mr_line_area(hr_id, line_code, area_code) as (
  values
  ('AI-0002','AF','AB1'), ('B-162','AF','AB2'), ('B-178','AF','AB3'), ('B-176','AF','AB4'), ('B-177','AF','AB5'),
  ('AI-0003','AF','CA3'), ('B-161','AF','CA4'), ('AI-0004','AF','CA2'),
  ('B-105','AF','GZ1'), ('B-65','AF','GZ3'), ('B-104','AF','GZ5'),
  ('B-40','AF','D21'), ('B-108','AF','D22'), ('B-96','AF','D23'),
  ('B-15','AF','D26'), ('B-107','AF','D16'), ('B-179','AF','D15'), ('B-97','AF','D14'), ('B-55','AF','D12'), ('B-7','AF','D13'),
  ('B-1','AF','UE1'), ('B-79','AF','UE2'), ('B-187','AF','UE3'), ('B-13','AF','UE4'), ('B-152','AF','UE7'), ('B-189','AF','UE7'), ('B-151','AF','UE5'),
  ('B-135','CS','AB1'), ('B-132','CS','AB2'), ('B-143','CS','AB3'), ('B-125','CS','AB4'), ('B-171','CS','AB5'),
  ('B-146','CS','CA3'), ('CN-0004','CS','CA4'), ('B-182','CS','CA1'), ('CN-0001','CS','CA2'),
  ('B-147','CS','GZ2'), ('B-138','CS','GZ1'), ('B-137','CS','GZ4'), ('B-136','CS','GZ5'), ('B-127','CS','CA6'),
  ('CN-0002','CS','D21'), ('B-172','CS','D22'), ('CN-0003','CS','D26'), ('B-186','CS','D24'), ('B-148','CS','D25'),
  ('B-130','CS','D11'), ('B-145','CS','D14'), ('B-128','CS','D15'), ('B-144','CS','D16'), ('B-129','CS','D12'), ('B-126','CS','D13'),
  ('B-133','CS','UE1'), ('B-139','CS','UE2'), ('B-140','CS','UE3'), ('B-141','CS','UE4'), ('B-131','CS','UE7'), ('B-142','CS','UE5'), ('B-124','CS','UE6'),
  ('PD-0005','PD','AB2'), ('B-82','PD','AB1'), ('B-188','PD','AB3'), ('B-167','PD','AB4'), ('B-14','PD','AB5'),
  ('PD-0003','PD','GZ2'), ('B-59','PD','GZ1'), ('B-110','PD','GZ4'), ('B-95','PD','GZ7'), ('B-52','PD','GZ6'),
  ('B-100','PD','D11'), ('B-58','PD','D21'), ('B-115','PD','D23'), ('B-43','PD','D22'), ('B-3','PD','D26'),
  ('B-169','PD','D16'), ('B-158','PD','D15'), ('B-170','PD','D14'), ('B-113','PD','D12'), ('B-91','PD','D13'),
  ('B-34','PD','UE1'), ('B-166','PD','UE2'), ('B-111','PD','UE3'), ('B-181','PD','UE4'), ('B-25','PD','UE7'), ('B-112','PD','UE5'), ('PD-0004','PD','UE6'),
  ('B-164','PD','CA2')
)
update public.employees e
set region_code = alr.region_code,
    updated_at = now()
from mr_line_area mla
join area_line_region alr on alr.area_code = mla.area_code and alr.line_code = mla.line_code
where e.hr_id = mla.hr_id;

-- District Sales Managers: region_code is a direct attribute (not area-derived), same
-- values as the original backfill.
update public.employees e
set region_code = v.region_code,
    updated_at = now()
from (values
  ('B-119','AB'), ('B-156','AB'), ('B-74','AB'),
  ('AI-0001','CA'), ('B-116','CA'),
  ('B-12','D1'), ('B-120','D1'), ('B-154','D1'),
  ('B-184','D2'), ('B-5','D2'), ('B-76','D2'),
  ('B-117','GZ'), ('B-28','GZ'), ('B-94','GZ'),
  ('B-118','UE'), ('B-175','UE'), ('B-23','UE')
) as v(hr_id, region_code)
where e.hr_id = v.hr_id;

commit;
