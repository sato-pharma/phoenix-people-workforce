-- Full revert of the area/region/line unification effort (2026-07-02 through 2026-07-07),
-- at the owner's explicit request: areas are to return to exactly how they were before, and
-- the unification is not wanted. This undoes, in reverse chronological order, every migration
-- built on top of 20260702180000_area_region_line_unification_schema.sql:
--   20260706230000 (RLS enable)                  -- moot: tables are dropped below anyway
--   20260706130000 (cancel ghost filled-MR vacancies)
--   20260706120000 (CNS Downtown vacancy reparent)
--   20260706110000 (vacancy layer reconciliation)
--   20260706100000 (Anti Infective/Pedia/CNS area reconciliation)
--   20260702190000 (employee backfill)
--   20260702180000 (schema: lines.code/areas.code repoint, line_area_region_map,
--                    line_zones/line_zone_regions, employees.region_code)
--
-- Notes are treated as an append-only audit trail (matching the established convention in
-- this codebase) and are NOT stripped -- each reverted row gets a new note appended recording
-- the revert, rather than surgically removing the prior reconciliation note.
--
-- areas.code / lines.code pre-unification values are regenerated via createOrgCode(name) --
-- the same deterministic slugify function the import pipeline (src/lib/imports/org-rule-engine.ts)
-- already uses to derive a code from a name. Since `name` was never touched by the unification
-- for these rows (only `code` was), and the function is a pure transform, this reconstructs the
-- exact original values rather than approximating them.
--
-- Not reverted: the two organogram/positioning bug fixes that are independent of the code-scheme
-- question are left in place implicitly (this migration only touches what the unification chain
-- itself introduced or changed).

begin;

-- ============================================================================
-- STEP 1 -- undo 20260706130000_cancel_ghost_filled_mr_vacancies.sql
-- Restore the 2 cancelled ghost vacancies back to 'filled'.
-- ============================================================================
update position_vacancies
   set status = 'filled',
       note = coalesce(note || E'\n', '') ||
              'Area/region/line unification revert 2026-07-07: restored to filled (owner requested full rollback of the unification).'
 where vacancy_code = 'vacancy_11_sales_pedia_alex_center_2_medical_representative'
   and status = 'cancelled';

update position_vacancies
   set status = 'filled',
       note = coalesce(note || E'\n', '') ||
              'Area/region/line unification revert 2026-07-07: restored to filled (owner requested full rollback of the unification).'
 where vacancy_code = 'vacancy_19_cns_port_said_domiat_medical_representative'
   and status = 'cancelled';

-- ============================================================================
-- STEP 2 -- undo 20260706120000_cns_downtown_vacancy_reparent.sql
-- manager_hr_id back to the NSM (B-122). region_name is left at 'Giza' -- the
-- pre-reparent value was never captured by the up-migration, and 'Giza' is the
-- geographically correct label for this seat regardless of which manager it
-- reports to (region_name is a display label, not what caused the mis-grouping).
-- ============================================================================
update position_vacancies
   set manager_hr_id = 'B-122',
       note = coalesce(note || E'\n', '') ||
              'Area/region/line unification revert 2026-07-07: reparented back to NSM (owner requested full rollback of the unification).'
 where vacancy_code = 'vacancy_16_sales_cns_downtown_medical_representative'
   and status = 'open'
   and manager_hr_id = 'B-117';

-- ============================================================================
-- STEP 3 -- undo 20260706110000_sales_vacancy_layer_reconciliation.sql
-- ============================================================================
-- 3a. Delete the 4 new vacancy rows opened for previously-empty structure seats.
delete from position_vacancies where vacancy_code in
  ('VAC-STRUCT-AI-HELIOPOLIS-MR','VAC-STRUCT-AI-SOHAG2-MR','VAC-STRUCT-AI-DAKAHLIA4-MR','VAC-STRUCT-PD-DAKAHLIA4-MR');

-- 3b. Re-open the 3 stale-duplicate vacancies + 1 phantom vacancy that were cancelled.
update position_vacancies
   set status = 'open',
       note = coalesce(note || E'\n', '') ||
              'Area/region/line unification revert 2026-07-07: reopened (owner requested full rollback of the unification).'
 where vacancy_code = 'VAC-B153-DJW' and status = 'cancelled';

update position_vacancies
   set status = 'open',
       note = coalesce(note || E'\n', '') ||
              'Area/region/line unification revert 2026-07-07: reopened (owner requested full rollback of the unification).'
 where vacancy_code = 'VAC-B168-JPR' and status = 'cancelled';

update position_vacancies
   set status = 'open',
       note = coalesce(note || E'\n', '') ||
              'Area/region/line unification revert 2026-07-07: reopened (owner requested full rollback of the unification).'
 where vacancy_code = 'VAC-B114-0B2' and status = 'cancelled';

update position_vacancies
   set status = 'open',
       note = coalesce(note || E'\n', '') ||
              'Area/region/line unification revert 2026-07-07: reopened (owner requested full rollback of the unification).'
 where vacancy_code = 'vacancy_18_sales_cns_sharkia_2_medical_representative' and status = 'cancelled';

-- 3c. Drop the 'ai_heliopolis' area row (its only referencing vacancy was deleted in 3a).
delete from areas where code = 'ai_heliopolis' and line_id = 1;

-- ============================================================================
-- STEP 4 -- undo 20260706100000_sales_line_area_reconciliation.sql
-- ============================================================================
-- 4a. Reverse all 26 employee area_id repoints back to their pre-reconciliation (borrowed) area.
update employees e set area_id = src.id from areas dst, areas src where dst.code='ai_cairo_east_2' and src.code='CA4' and e.hr_id='B-161' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='cairo_east' and src.code='CA3' and e.hr_id='AI-0003' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='ai_assuit_2' and src.code='UE4' and e.hr_id='B-13' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='sohag_1' and src.code='UE5' and e.hr_id='B-151' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='alex_east_2' and src.code='AB1' and e.hr_id='AI-0002' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='ai_dakahlia_1' and src.code='D21' and e.hr_id='B-40' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='ai_dakahlia_2' and src.code='D22' and e.hr_id='B-108' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='giza_centers' and src.code='GZ1' and e.hr_id='B-105' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='monofia_2' and src.code='D13' and e.hr_id='B-7' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='domiat' and src.code='D26' and e.hr_id='B-15' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='ai_dakahlia_3' and src.code='D23' and e.hr_id='B-96' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='mahalla' and src.code='D14' and e.hr_id='B-97' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='ai_tanta' and src.code='D15' and e.hr_id='B-179' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='kfs' and src.code='D16' and e.hr_id='B-107' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='helwan' and src.code='GZ5' and e.hr_id='B-104' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='monofia_1' and src.code='D12' and e.hr_id='B-55' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='qena_1' and src.code='UE7' and e.hr_id='B-152' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='qena_2' and src.code='UE7' and e.hr_id='B-189' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='alex_center_1' and src.code='AB2' and e.hr_id='PD-0005' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='kafr_el_sheikh_1' and src.code='D16' and e.hr_id='B-169' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='banha' and src.code='D11' and e.hr_id='B-100' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='pd_mahalla' and src.code='D14' and e.hr_id='B-170' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='tanta' and src.code='D15' and e.hr_id='B-158' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='alex_center_2' and src.code='AB2' and e.hr_id='B-132' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='alex_west_center1' and src.code='AB3' and e.hr_id='B-143' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='cairo_east_1_2_abbasia_and_kobbah_east_2' and src.code='CA3' and e.hr_id='B-146' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='cairo_east_3_4_5_east1' and src.code='CA4' and e.hr_id='CN-0004' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='shoubra_and_shoubra_el_kheima' and src.code='CA6' and e.hr_id='B-127' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='nasr_city_5th_settlement' and src.code='CA2' and e.hr_id='CN-0001' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='sharkia_3' and src.code='D25' and e.hr_id='B-148' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='dokki_mohandsen_imbaba' and src.code='GZ2' and e.hr_id='B-147' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='haram_giza_midan_giza_centers' and src.code='GZ1' and e.hr_id='B-138' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='faisal_and_october' and src.code='GZ4' and e.hr_id='B-137' and e.area_id=dst.id;
update employees e set area_id = src.id from areas dst, areas src where dst.code='qena_and_nagaa_hammady' and src.code='UE7' and e.hr_id='B-131' and e.area_id=dst.id;

-- 4b. Revert the 2 area renames done by that migration.
update areas set name = 'Alex East 2', updated_at = now() where code = 'alex_east_2' and line_id = 1 and name = 'Alex East';
update areas set name = 'Alex Center 1', updated_at = now() where code = 'alex_center_1' and line_id = 2 and name = 'Alex Center';

-- 4c. Drop the 8 area rows this migration created (nothing references them after 4a).
delete from areas where code in
  ('ai_cairo_east_2','ai_assuit_2','ai_dakahlia_1','ai_dakahlia_2','ai_dakahlia_3','ai_dakahlia_4','ai_tanta','pd_mahalla');

-- ============================================================================
-- STEP 5 -- undo 20260702190000_area_region_line_unification_backfill.sql
-- ============================================================================
-- 5a. Null out area_id/region_code for the 87 Medical Reps this migration touched.
update employees set area_id = null, region_code = null where hr_id in (
  'AI-0002','B-162','B-178','B-176','B-177','AI-0003','B-161','AI-0004','B-105','B-65','B-104',
  'B-40','B-108','B-96','B-15','B-107','B-179','B-97','B-55','B-7','B-1','B-79','B-187','B-13',
  'B-152','B-189','B-151','B-135','B-132','B-143','B-125','B-171','B-146','CN-0004','B-182','CN-0001',
  'B-147','B-138','B-137','B-136','B-127','CN-0002','B-172','CN-0003','B-186','B-148','B-130','B-145',
  'B-128','B-144','B-129','B-126','B-133','B-139','B-140','B-141','B-131','B-142','B-124','PD-0005',
  'B-82','B-188','B-167','B-14','PD-0003','B-59','B-110','B-95','B-52','B-100','B-58','B-115','B-43',
  'B-3','B-169','B-158','B-170','B-113','B-91','B-34','B-166','B-111','B-181','B-25','B-112','PD-0004','B-164'
);

-- 5b. Null out region_code for the 17 District Sales Managers this migration touched.
update employees set region_code = null where hr_id in (
  'B-119','B-156','B-74','AI-0001','B-116','B-12','B-120','B-154','B-184','B-5','B-76','B-117','B-28','B-94','B-118','B-175','B-23'
);

-- ============================================================================
-- STEP 6 -- undo 20260702180000_area_region_line_unification_schema.sql
-- ============================================================================
-- 6a. Drop the new tables outright (this also removes the RLS lockdown from
--     20260706230000 -- moot once the tables no longer exist).
-- SAFE: these 3 tables were created by 20260702180000 in this same revert chain, only
-- hold data reconciled by that migration and its dependents, and are being fully undone
-- at the owner's explicit request (full rollback, no area/region/line unification kept).
drop table if exists line_zone_regions;
drop table if exists line_zones;
drop table if exists line_area_region_map;

-- 6b. Drop employees.region_code (and its index) -- fully nulled out above already.
drop index if exists employees_region_code_idx;
alter table employees drop column if exists region_code;

-- 6c. Restore lines.code to its pre-unification auto-generated slug (createOrgCode(name)).
update lines set code = 'anti_infective', updated_at = now() where id = 1 and name = 'Anti infective' and code = 'AF';
update lines set code = 'pedia', updated_at = now() where id = 2 and name = 'Pedia' and code = 'PD';
update lines set code = 'cns', updated_at = now() where id = 3 and name = 'CNS' and code = 'CS';
update lines set code = 'head_office', updated_at = now() where id = 4 and name = 'Head Office' and code = 'HO';

-- 6d. Restore areas.code to its pre-unification auto-generated slug (createOrgCode(name))
--     for the 37 canonical rows the schema migration repointed. `name` was never touched
--     by the unification for these rows, so this reconstructs the exact original value.
update areas set code = 'alex_east', updated_at = now() where id = 55 and code = 'AB1' and name = 'Alex East';
update areas set code = 'alex_center', updated_at = now() where id = 27 and code = 'AB2' and name = 'Alex Center';
update areas set code = 'alex_west', updated_at = now() where id = 28 and code = 'AB3' and name = 'Alex West';
update areas set code = 'behira_1', updated_at = now() where id = 24 and code = 'AB4' and name = 'Behira 1';
update areas set code = 'behira_2', updated_at = now() where id = 25 and code = 'AB5' and name = 'Behira 2';
update areas set code = 'heliopolis', updated_at = now() where id = 2 and code = 'CA1' and name = 'Heliopolis';
update areas set code = 'nasr_city', updated_at = now() where id = 3 and code = 'CA2' and name = 'NASR CITY';
update areas set code = 'cairo_east_1', updated_at = now() where id = 43 and code = 'CA3' and name = 'Cairo East 1';
update areas set code = 'cairo_east_2', updated_at = now() where id = 4 and code = 'CA4' and name = 'Cairo East 2';
update areas set code = 'downtown', updated_at = now() where id = 69 and code = 'CA5' and name = 'Downtown';
update areas set code = 'cairo_west', updated_at = now() where id = 6 and code = 'CA6' and name = 'Cairo west';
update areas set code = 'qaluibia', updated_at = now() where id = 78 and code = 'D11' and name = 'Qaluibia';
update areas set code = 'menoufia_1', updated_at = now() where id = 59 and code = 'D12' and name = 'Menoufia 1';
update areas set code = 'menoufia_2', updated_at = now() where id = 60 and code = 'D13' and name = 'Menoufia 2';
update areas set code = 'gharbia_1', updated_at = now() where id = 76 and code = 'D14' and name = 'Gharbia (1)';
update areas set code = 'gharbia_2', updated_at = now() where id = 77 and code = 'D15' and name = 'Gharbia (2)';
update areas set code = 'kafr_el_sheikh', updated_at = now() where id = 75 and code = 'D16' and name = 'Kafr El-Sheikh';
update areas set code = 'dakahlia_1', updated_at = now() where id = 36 and code = 'D21' and name = 'Dakahlia 1';
update areas set code = 'dakahlia_2', updated_at = now() where id = 37 and code = 'D22' and name = 'Dakahlia 2';
update areas set code = 'dakahlia_3', updated_at = now() where id = 38 and code = 'D23' and name = 'Dakahlia 3';
update areas set code = 'sharkia_1', updated_at = now() where id = 79 and code = 'D24' and name = 'Sharkia 1';
update areas set code = 'sharkia_2', updated_at = now() where id = 63 and code = 'D25' and name = 'Sharkia 2';
update areas set code = 'port_said_domiat', updated_at = now() where id = 62 and code = 'D26' and name = 'Port said - Domiat';
update areas set code = 'giza_giza_centers', updated_at = now() where id = 49 and code = 'GZ1' and name = 'Giza - Giza Centers';
update areas set code = 'dokki_mohandsen_bolak', updated_at = now() where id = 47 and code = 'GZ2' and name = 'Dokki - Mohandsen-Bolak';
update areas set code = 'imbaba', updated_at = now() where id = 10 and code = 'GZ3' and name = 'Imbaba';
update areas set code = 'haram_faisal', updated_at = now() where id = 46 and code = 'GZ4' and name = 'Haram - Faisal';
update areas set code = 'maadi_helwan', updated_at = now() where id = 48 and code = 'GZ5' and name = 'Maadi-Helwan';
update areas set code = 'fayoum', updated_at = now() where id = 50 and code = 'GZ6' and name = 'Fayoum';
update areas set code = 'october_zayed', updated_at = now() where id = 45 and code = 'GZ7' and name = 'October - Zayed';
update areas set code = 'minia_1', updated_at = now() where id = 13 and code = 'UE1' and name = 'Minia 1';
update areas set code = 'minia_2', updated_at = now() where id = 15 and code = 'UE2' and name = 'Minia 2';
update areas set code = 'assuit_1', updated_at = now() where id = 18 and code = 'UE3' and name = 'Assuit 1';
update areas set code = 'assuit_2', updated_at = now() where id = 17 and code = 'UE4' and name = 'Assuit 2';
update areas set code = 'sohag1', updated_at = now() where id = 52 and code = 'UE5' and name = 'Sohag1';
update areas set code = 'sohag2', updated_at = now() where id = 53 and code = 'UE6' and name = 'Sohag2';
update areas set code = 'qena', updated_at = now() where id = 51 and code = 'UE7' and name = 'Qena';

commit;
