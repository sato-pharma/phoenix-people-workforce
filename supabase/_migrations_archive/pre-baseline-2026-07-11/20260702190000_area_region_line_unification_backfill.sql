-- Area / Region / Zone / Line unification — employee backfill (Phase 1, data patch).
--
-- Per-hr_id area_id / region_code correction for the ~87 active Medical Reps and 18 District
-- Sales Managers reconciled by hand in Area_Region_Line_Unification_Template_v2.xlsx
-- (Medical Reps + Manager Assignments sheets), plus two verbal corrections given after that sheet
-- was generated that are not yet reflected in the file itself: the AF and PD "Dakahlia" reps were
-- renumbered (b-40/b-108/b-96 -> Dakahlia 1/2/3 for AF; b-43 folds into the Dakahlia 2 seat that
-- looked vacant, for PD) so no line has a duplicate or a fictitious "Dakahlia 4".
--
-- Scope: only the specific hr_ids below are touched. Every other employee (managers, other job
-- titles, Head Office staff, resigned/removed reps already stripped from the sheet) is left exactly
-- as-is — this is a targeted correction, not a blanket re-import.
--
-- Medical Reps: area_id resolved via the official area code; region_code derived from
-- (line, area_code) through line_area_region_map — never typed in directly, so it can never drift
-- from the area/line combination again.
-- District Sales Managers: region_code is a direct attribute of their own record (a DM doesn't map
-- to one specific area the way a rep does), taken straight from the reconciled roster. area_id/
-- line_id are left untouched (already correct).
-- The one Regional Manager (PD-0001) and the 3 National Sales Managers get no region_code — RM/NSM
-- visibility is resolved dynamically (RM from their reporting subtree, NSM from line scope), not
-- from a stored region.
--
-- Re-runnable / idempotent: plain UPDATE keyed by hr_id, no inserts. Wrapped in a transaction.

begin;

-- Medical Reps: area_id + region_code.
update public.employees e
set area_id = a.id,
    region_code = m.region_code,
    updated_at = now()
from (values
  -- Anti-Infective (AF)
  ('AI-0002','AF','AB1'), ('B-162','AF','AB2'), ('B-178','AF','AB3'), ('B-176','AF','AB4'), ('B-177','AF','AB5'),
  ('AI-0003','AF','CA3'), ('B-161','AF','CA4'), ('AI-0004','AF','CA2'),
  ('B-105','AF','GZ1'), ('B-65','AF','GZ3'), ('B-104','AF','GZ5'),
  ('B-40','AF','D21'), ('B-108','AF','D22'), ('B-96','AF','D23'),
  ('B-15','AF','D26'), ('B-107','AF','D16'), ('B-179','AF','D15'), ('B-97','AF','D14'), ('B-55','AF','D12'), ('B-7','AF','D13'),
  ('B-1','AF','UE1'), ('B-79','AF','UE2'), ('B-187','AF','UE3'), ('B-13','AF','UE4'), ('B-152','AF','UE7'), ('B-189','AF','UE7'), ('B-151','AF','UE5'),
  -- CNS (CS)
  ('B-135','CS','AB1'), ('B-132','CS','AB2'), ('B-143','CS','AB3'), ('B-125','CS','AB4'), ('B-171','CS','AB5'),
  ('B-146','CS','CA3'), ('CN-0004','CS','CA4'), ('B-182','CS','CA1'), ('CN-0001','CS','CA2'),
  ('B-147','CS','GZ2'), ('B-138','CS','GZ1'), ('B-137','CS','GZ4'), ('B-136','CS','GZ5'), ('B-127','CS','CA6'),
  ('CN-0002','CS','D21'), ('B-172','CS','D22'), ('CN-0003','CS','D26'), ('B-186','CS','D24'), ('B-148','CS','D25'),
  ('B-130','CS','D11'), ('B-145','CS','D14'), ('B-128','CS','D15'), ('B-144','CS','D16'), ('B-129','CS','D12'), ('B-126','CS','D13'),
  ('B-133','CS','UE1'), ('B-139','CS','UE2'), ('B-140','CS','UE3'), ('B-141','CS','UE4'), ('B-131','CS','UE7'), ('B-142','CS','UE5'), ('B-124','CS','UE6'),
  -- Pedia (PD)
  ('PD-0005','PD','AB2'), ('B-82','PD','AB1'), ('B-188','PD','AB3'), ('B-167','PD','AB4'), ('B-14','PD','AB5'),
  ('PD-0003','PD','GZ2'), ('B-59','PD','GZ1'), ('B-110','PD','GZ4'), ('B-95','PD','GZ7'), ('B-52','PD','GZ6'),
  ('B-100','PD','D11'), ('B-58','PD','D21'), ('B-115','PD','D23'), ('B-43','PD','D22'), ('B-3','PD','D26'),
  ('B-169','PD','D16'), ('B-158','PD','D15'), ('B-170','PD','D14'), ('B-113','PD','D12'), ('B-91','PD','D13'),
  ('B-34','PD','UE1'), ('B-166','PD','UE2'), ('B-111','PD','UE3'), ('B-181','PD','UE4'), ('B-25','PD','UE7'), ('B-112','PD','UE5'), ('PD-0004','PD','UE6'),
  ('B-164','PD','CA2')
) as v(hr_id, line_code, area_code)
join public.lines l on l.code = v.line_code
join public.areas a on a.code = v.area_code
join public.line_area_region_map m on m.line_id = l.id and m.area_code = v.area_code
where e.hr_id = v.hr_id;

-- District Sales Managers: region_code only (own attribute, not area-derived).
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
