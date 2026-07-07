-- Incident recovery: an "area unification" cleanup (consolidating duplicate per-line
-- area rows that shared a name into a single canonical row) ran against production and
-- deleted the old duplicate rows WITHOUT first repointing the employees/vacancies that
-- referenced them. Because areas.line_id has ON DELETE SET NULL, every employee/vacancy
-- pointing at a deleted duplicate had its area_id silently nulled — ~70 active reps and
-- several vacancies across all three sales lines, including rows this migration series
-- (20260706100000 / 110000 / 120000 / 130000) had already fixed.
--
-- This migration restores every affected row from the last known-correct snapshot
-- (captured and cross-verified against the live /api/reports/organogram payload
-- immediately before shipping), re-creates 4 structural vacancy rows that were fully
-- deleted (not just orphaned) by the same event, and re-applies the vacancy dedup/
-- reparent fixes from the prior three migrations that were reverted by the same event.
--
-- All statements are idempotent (guarded by "is distinct from" / status checks / ON
-- CONFLICT DO NOTHING) and safe to re-run.

-- 1) Ensure area rows exist with correct names (idempotent).
insert into areas (line_id, code, name, is_active) values
  (1, 'ai_cairo_east_2', 'Cairo East 2', true),
  (1, 'ai_assuit_2', 'Assuit 2', true),
  (1, 'ai_dakahlia_1', 'Dakahlia 1', true),
  (1, 'ai_dakahlia_2', 'Dakahlia 2', true),
  (1, 'ai_dakahlia_3', 'Dakahlia 3', true),
  (1, 'ai_dakahlia_4', 'Dakahlia 4', true),
  (1, 'ai_tanta', 'Tanta', true),
  (1, 'ai_heliopolis', 'Heliopolis', true),
  (2, 'pd_mahalla', 'Mahalla', true)
on conflict do nothing;

update areas set name = 'Alex East' where code = 'alex_east_2' and line_id = 1 and name <> 'Alex East';
update areas set name = 'Alex Center' where code = 'alex_center_1' and line_id = 2 and name <> 'Alex Center';

-- 2) Restore area_id for every active medical rep from the last verified snapshot.
-- First pass: match on (area name, line) for rows whose per-line duplicate still exists.
with snapshot(hr_id, area_name, line_id) as (
  values
  ('AI-0004','NASR CITY',1),('B-161','Cairo East 2',1),('AI-0003','Cairo East',1),
  ('B-162','Alex Center',1),('AI-0002','Alex East',1),('B-178','Alex West',1),
  ('B-176','Behira 1',1),('B-177','Behira 2',1),('B-107','KFS',1),
  ('B-55','Monofia 1',1),('B-7','Monofia 2',1),('B-40','Dakahlia 1',1),
  ('B-108','Dakahlia 2',1),('B-96','Dakahlia 3',1),('B-15','Domiat',1),
  ('B-97','Mahalla',1),('B-179','Tanta',1),('B-105','Giza centers',1),
  ('B-104','Helwan',1),('B-65','Imbaba',1),('B-187','Assuit 1',1),
  ('B-13','Assuit 2',1),('B-1','Minia 1',1),('B-79','Minia 2',1),
  ('B-151','Sohag 1',1),('B-152','Qena 1',1),('B-189','Qena 2',1),
  ('PD-0005','Alex Center',2),('B-82','Alex East',2),('B-188','Alex West',2),
  ('B-167','Behira 1',2),('B-14','Behira 2',2),('B-164','NASR CITY',2),
  ('B-100','Banha',2),('B-169','Kafr El-Sheikh (1)',2),('B-113','Menoufia 1',2),
  ('B-91','Menoufia 2',2),('B-58','Dakahlia 1',2),('B-3','Port said - Domiat',2),
  ('B-170','Mahalla',2),('B-43','Dakahlia 2',2),('B-115','Dakahlia 3',2),
  ('B-158','Tanta',2),('B-52','Fayoum',2),('B-59','Giza - Giza Centers',2),
  ('B-110','Haram - Faisal',2),('B-95','October - Zayed',2),('B-111','Assuit 1',2),
  ('B-34','Minia 1',2),('B-166','Minia 2',2),('B-25','Qena',2),
  ('B-112','Sohag1',2),('PD-0004','Sohag2',2),
  ('B-132','Alex Center 2',3),('B-135','Alex East',3),('B-143','Alex West - Center1',3),
  ('B-125','Behira 1',3),('B-171','Behira 2',3),
  ('B-146','Cairo East 1,2 - Abbasia & Kobbah (East-2)',3),('CN-0004','Cairo East 3,4,5 (East1)',3),
  ('B-182','Heliopolis',3),('CN-0001','Nasr City - 5th Settlement',3),
  ('B-127','Shoubra & Shoubra El Kheima',3),('B-144','Kafr El-Sheikh',3),
  ('B-129','Menoufia 1',3),('B-126','Menoufia 2',3),('B-130','Qaluibia',3),
  ('CN-0002','Dakahlia 1',3),('B-172','Dakahlia 2',3),('CN-0003','Port said - Domiat',3),
  ('B-186','Sharkia 1',3),('B-148','Sharkia 3',3),('B-145','Gharbia (1)',3),
  ('B-128','Gharbia (2)',3),('B-147','Dokki - Mohandsen-Imbaba',3),
  ('B-137','Faisal & October',3),('B-138','Haram, Giza midan, Giza Centers',3),
  ('B-136','Maadi-Helwan',3),('B-140','Assuit 1',3),('B-141','Assuit 2',3),
  ('B-133','Minia 1',3),('B-139','Minia 2',3),('B-131','Qena & Nagaa Hammady',3),
  ('B-142','Sohag1',3),('B-124','Sohag2',3)
)
update employees e
set area_id = a.id
from snapshot s
join areas a on a.name = s.area_name and a.line_id = s.line_id
where e.hr_id = s.hr_id and e.employment_status = 'active' and e.area_id is distinct from a.id;

-- Second pass: for names whose per-line duplicates were merged into one shared row,
-- match on name alone (the join above finds nothing for these, so this is additive).
with snapshot2(hr_id, area_name) as (
  values
  ('B-111','Assuit 1'),('B-113','Menoufia 1'),('B-115','Dakahlia 3'),
  ('B-14','Behira 2'),('B-164','NASR CITY'),('B-166','Minia 2'),
  ('B-167','Behira 1'),('B-188','Alex West'),('B-34','Minia 1'),
  ('B-124','Sohag2'),('B-125','Behira 1'),('B-126','Menoufia 2'),
  ('B-133','Minia 1'),('B-135','Alex East'),('B-139','Minia 2'),
  ('B-140','Assuit 1'),('B-141','Assuit 2'),('B-142','Sohag1'),
  ('B-171','Behira 2'),('B-172','Dakahlia 2'),('CN-0002','Dakahlia 1'),
  ('CN-0003','Port said - Domiat')
)
update employees e
set area_id = a.id
from snapshot2 s
join areas a on a.name = s.area_name
where e.hr_id = s.hr_id and e.employment_status = 'active' and e.area_id is null;

-- 3) Re-create 4 structural vacancy rows the same event fully deleted.
insert into position_vacancies
  (vacancy_code, department_id, line_id, area_id, position_id, job_title, status, manager_hr_id, region_name, note)
select v.vacancy_code, 1, v.line_id, a.id, 2, 'Medical Representative', 'open', v.manager_hr_id, v.region_name,
       'Structure reconciliation: opened missing empty structure seat.'
from (values
    ('VAC-STRUCT-AI-HELIOPOLIS-MR', 1, 'ai_heliopolis', 'AI-0001', 'Cairo'),
    ('VAC-STRUCT-AI-SOHAG2-MR',     1, 'sohag_2',       'B-175',   'Upper Egypt'),
    ('VAC-STRUCT-AI-DAKAHLIA4-MR',  1, 'ai_dakahlia_4', 'B-76',    'Delta (2)'),
    ('VAC-STRUCT-PD-DAKAHLIA4-MR',  2, 'dakahlia_4',    'B-5',     'Delta (2)')
  ) as v(vacancy_code, line_id, area_code, manager_hr_id, region_name)
join areas a on a.code = v.area_code and a.line_id = v.line_id
on conflict (vacancy_code) do nothing;

-- 4) Re-apply vacancy dedup/reparent fixes from the prior 3 migrations (reverted by the
-- same event): stale duplicates where the seat is already filled, a phantom CNS seat,
-- and the CNS Downtown -> Giza DSM reparent.
update position_vacancies set status='cancelled', note=coalesce(note||E'\n','')||'Re-applied: stale duplicate, filled by B-40.' where vacancy_code='VAC-B153-DJW' and status='open';
update position_vacancies set status='cancelled', note=coalesce(note||E'\n','')||'Re-applied: phantom, not part of CNS structure.' where vacancy_code='vacancy_18_sales_cns_sharkia_2_medical_representative' and status<>'cancelled';
update position_vacancies set status='cancelled', note=coalesce(note||E'\n','')||'Re-applied: ghost, filled by PD-0005.' where vacancy_code='vacancy_11_sales_pedia_alex_center_2_medical_representative' and status<>'cancelled';
update position_vacancies set status='cancelled', note=coalesce(note||E'\n','')||'Re-applied: ghost, filled by CN-0003.' where vacancy_code='vacancy_19_cns_port_said_domiat_medical_representative' and status<>'cancelled';
update position_vacancies set status='cancelled', note=coalesce(note||E'\n','')||'Re-applied: ghost, filled by B-43.' where vacancy_code='VAC-B114-0B2' and status<>'cancelled';
update position_vacancies set status='cancelled', note=coalesce(note||E'\n','')||'Re-applied: stale resignation vacancy for prior occupant, seat filled by PD-0005.' where vacancy_code='VAC-B168-JPR' and status='open';
update position_vacancies set manager_hr_id='B-117', region_name='Giza', note=coalesce(note||E'\n','')||'Re-applied: Downtown groups under Giza DSM.' where vacancy_code='vacancy_16_sales_cns_downtown_medical_representative' and status='open' and manager_hr_id is distinct from 'B-117';

-- 5) Relink the 5 resignation-vacancy rows this event nulled area_id on.
update position_vacancies e set area_id=a.id from areas a where a.code='helwan' and e.vacancy_code='VAC-B104-XG3' and e.status='open' and e.area_id is null;
update position_vacancies e set area_id=a.id from areas a where a.code='behira_1' and e.vacancy_code='VAC-B176-SPK' and e.status='open' and e.area_id is null;
update position_vacancies e set area_id=a.id from areas a where a.code='mahalla' and e.vacancy_code='VAC-B97-I6S' and e.status='open' and e.area_id is null;
update position_vacancies e set area_id=a.id from areas a where a.code='GZ2' and e.vacancy_code='VAC-PD0003-K8W' and e.status='open' and e.area_id is null;
update position_vacancies e set area_id=a.id from areas a where a.code='assuit_2' and e.vacancy_code='VAC-B181-P6L' and e.status='open' and e.area_id is null;
