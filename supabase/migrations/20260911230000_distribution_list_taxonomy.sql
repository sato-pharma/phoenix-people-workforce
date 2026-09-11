-- The full distribution-list taxonomy the owner asked for on 2026-09-11.
--
-- THE `all_employees` FLAG IS THE ONLY WAY TO ADDRESS THE WHOLE COMPANY. A list with no rule
-- resolves to NOBODY by design, so a half-finished list can never quietly mail everyone; that
-- guard also made a legitimate all-company list impossible, which is what this flag is for.
--
-- REGIONS ARE MATCHED ON NAME **AND** CODE. Measured on production: 13 field employees carry a
-- region_name with no region_code, and every one of them is a District Manager. Keying the region
-- rules on the code alone would have produced 20 silently EMPTY district-manager lists while the
-- rep lists beside them looked perfectly correct.
--
-- HEAD OFFICE IS KEYED ON DEPARTMENT, NOT ON LINE 4. `line_id = 4` was the obvious rule and is the
-- one the ORGANOGRAM abandoned: three head-office people (a GPM and two PMs) sit on lines 1 and 2
-- because they own those lines' brands, and reports/organogram-head-office.ts records that their
-- line_id is "not a mistake to be corrected". Measured: department Sales holds 91 people, all of
-- them field force; every other department is head office. So the department test captures all 18
-- including the three brand managers, and sweeps in no rep.
--
-- PEDIA DOES HAVE A CAIRO REGION. An earlier draft of this file omitted the two Pedia/Cairo lists
-- and said Pedia had no Cairo region. That was wrong: the areas exist and the REP SEATS ARE VACANT,
-- which is why a head-count query finds nobody. The lists are here and will read empty until
-- somebody is hired into them - which is the honest state, and better than the first Pedia Cairo
-- hire landing in an audience no list covers.
--
-- What this taxonomy deliberately does NOT do:
--   * CNS keeps ONE "Upper Egypt"; only Anti Infective and Pedia are split into UE-1/UE-2, and the
--     Pedia split is the owner's golden rule of 2026-09-09. They are NOT aligned.
--   * Delta (3) appears on Anti Infective only, as ruled.
--
-- Every list is seeded ENABLED except sato_pharma_family - see its own note.
begin;

alter table public.distribution_lists
  add column if not exists all_employees boolean not null default false;

comment on column public.distribution_lists.all_employees is
  'Addresses every active employee. The only way to reach the whole company - a list with no rule resolves to nobody, deliberately.';

insert into public.distribution_lists
  (list_key, label, description, roles, line_ids, region_codes, department_ids, all_employees, enabled) values
  ('all_medical_reps', 'All Medical Reps', 'Every medical rep in the company, on any line.',
   array['Medical Rep']::text[], '{}'::integer[], '{}'::text[], '{}'::integer[], false, true),
  ('all_district_managers', 'All District Managers', 'Every district manager in the company, on any line.',
   array['District Manager']::text[], '{}'::integer[], '{}'::text[], '{}'::integer[], false, true),
  ('all_national_sales_managers', 'All National Sales Managers', 'The national sales manager of every line.',
   array['National Sales Manager']::text[], '{}'::integer[], '{}'::text[], '{}'::integer[], false, true),
  ('sato_pharma_family', 'Sato Pharma Family', 'Everyone in the company. Seeded DISABLED: it is the only list that can address every employee at once, and the standing rule is never to fire a bulk email. Switch it on when there is a specific use for it.',
   '{}'::text[], '{}'::integer[], '{}'::text[], '{}'::integer[], true, false),
  ('line_anti_infective', 'Anti Infective - everyone', 'Everyone on the Anti Infective line, at any rank.',
   '{}'::text[], array[1]::integer[], '{}'::text[], '{}'::integer[], false, true),
  ('line_anti_infective_medical_reps', 'Anti Infective - Medical Reps', 'Medical Reps on the Anti Infective line, in every region.',
   array['Medical Rep']::text[], array[1]::integer[], '{}'::text[], '{}'::integer[], false, true),
  ('line_anti_infective_district_managers', 'Anti Infective - District Managers', 'District Managers on the Anti Infective line, in every region.',
   array['District Manager']::text[], array[1]::integer[], '{}'::text[], '{}'::integer[], false, true),
  ('line_pedia', 'Pedia - everyone', 'Everyone on the Pedia line, at any rank.',
   '{}'::text[], array[2]::integer[], '{}'::text[], '{}'::integer[], false, true),
  ('line_pedia_medical_reps', 'Pedia - Medical Reps', 'Medical Reps on the Pedia line, in every region.',
   array['Medical Rep']::text[], array[2]::integer[], '{}'::text[], '{}'::integer[], false, true),
  ('line_pedia_district_managers', 'Pedia - District Managers', 'District Managers on the Pedia line, in every region.',
   array['District Manager']::text[], array[2]::integer[], '{}'::text[], '{}'::integer[], false, true),
  ('line_cns', 'CNS - everyone', 'Everyone on the CNS line, at any rank.',
   '{}'::text[], array[3]::integer[], '{}'::text[], '{}'::integer[], false, true),
  ('line_cns_medical_reps', 'CNS - Medical Reps', 'Medical Reps on the CNS line, in every region.',
   array['Medical Rep']::text[], array[3]::integer[], '{}'::text[], '{}'::integer[], false, true),
  ('line_cns_district_managers', 'CNS - District Managers', 'District Managers on the CNS line, in every region.',
   array['District Manager']::text[], array[3]::integer[], '{}'::text[], '{}'::integer[], false, true),
  ('anti_infective_alex_bhr_medical_reps', 'Anti Infective - Alex-BHR - Medical Reps', 'Medical Reps on the Anti Infective line in Alex-BHR. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['Medical Rep']::text[], array[1]::integer[], array['Alex-BHR', 'AB']::text[], '{}'::integer[], false, true),
  ('anti_infective_alex_bhr_district_managers', 'Anti Infective - Alex-BHR - District Managers', 'District Managers on the Anti Infective line in Alex-BHR. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['District Manager']::text[], array[1]::integer[], array['Alex-BHR', 'AB']::text[], '{}'::integer[], false, true),
  ('anti_infective_cairo_medical_reps', 'Anti Infective - Cairo - Medical Reps', 'Medical Reps on the Anti Infective line in Cairo. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['Medical Rep']::text[], array[1]::integer[], array['Cairo', 'CA']::text[], '{}'::integer[], false, true),
  ('anti_infective_cairo_district_managers', 'Anti Infective - Cairo - District Managers', 'District Managers on the Anti Infective line in Cairo. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['District Manager']::text[], array[1]::integer[], array['Cairo', 'CA']::text[], '{}'::integer[], false, true),
  ('anti_infective_delta_1_medical_reps', 'Anti Infective - Delta (1) - Medical Reps', 'Medical Reps on the Anti Infective line in Delta (1). Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['Medical Rep']::text[], array[1]::integer[], array['Delta (1)', 'D1']::text[], '{}'::integer[], false, true),
  ('anti_infective_delta_1_district_managers', 'Anti Infective - Delta (1) - District Managers', 'District Managers on the Anti Infective line in Delta (1). Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['District Manager']::text[], array[1]::integer[], array['Delta (1)', 'D1']::text[], '{}'::integer[], false, true),
  ('anti_infective_delta_2_medical_reps', 'Anti Infective - Delta (2) - Medical Reps', 'Medical Reps on the Anti Infective line in Delta (2). Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['Medical Rep']::text[], array[1]::integer[], array['Delta (2)', 'D2']::text[], '{}'::integer[], false, true),
  ('anti_infective_delta_2_district_managers', 'Anti Infective - Delta (2) - District Managers', 'District Managers on the Anti Infective line in Delta (2). Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['District Manager']::text[], array[1]::integer[], array['Delta (2)', 'D2']::text[], '{}'::integer[], false, true),
  ('anti_infective_delta_3_medical_reps', 'Anti Infective - Delta (3) - Medical Reps', 'Medical Reps on the Anti Infective line in Delta (3). Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['Medical Rep']::text[], array[1]::integer[], array['Delta (3)', 'D3']::text[], '{}'::integer[], false, true),
  ('anti_infective_delta_3_district_managers', 'Anti Infective - Delta (3) - District Managers', 'District Managers on the Anti Infective line in Delta (3). Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['District Manager']::text[], array[1]::integer[], array['Delta (3)', 'D3']::text[], '{}'::integer[], false, true),
  ('anti_infective_giza_medical_reps', 'Anti Infective - Giza - Medical Reps', 'Medical Reps on the Anti Infective line in Giza. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['Medical Rep']::text[], array[1]::integer[], array['Giza', 'GZ']::text[], '{}'::integer[], false, true),
  ('anti_infective_giza_district_managers', 'Anti Infective - Giza - District Managers', 'District Managers on the Anti Infective line in Giza. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['District Manager']::text[], array[1]::integer[], array['Giza', 'GZ']::text[], '{}'::integer[], false, true),
  ('anti_infective_upper_egypt_1_medical_reps', 'Anti Infective - Upper Egypt 1 - Medical Reps', 'Medical Reps on the Anti Infective line in Upper Egypt 1. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['Medical Rep']::text[], array[1]::integer[], array['Upper Egypt 1', 'UE-1']::text[], '{}'::integer[], false, true),
  ('anti_infective_upper_egypt_1_district_managers', 'Anti Infective - Upper Egypt 1 - District Managers', 'District Managers on the Anti Infective line in Upper Egypt 1. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['District Manager']::text[], array[1]::integer[], array['Upper Egypt 1', 'UE-1']::text[], '{}'::integer[], false, true),
  ('anti_infective_upper_egypt_2_medical_reps', 'Anti Infective - Upper Egypt 2 - Medical Reps', 'Medical Reps on the Anti Infective line in Upper Egypt 2. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['Medical Rep']::text[], array[1]::integer[], array['Upper Egypt 2', 'UE-2']::text[], '{}'::integer[], false, true),
  ('anti_infective_upper_egypt_2_district_managers', 'Anti Infective - Upper Egypt 2 - District Managers', 'District Managers on the Anti Infective line in Upper Egypt 2. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['District Manager']::text[], array[1]::integer[], array['Upper Egypt 2', 'UE-2']::text[], '{}'::integer[], false, true),
  ('pedia_alex_bhr_medical_reps', 'Pedia - Alex-BHR - Medical Reps', 'Medical Reps on the Pedia line in Alex-BHR. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['Medical Rep']::text[], array[2]::integer[], array['Alex-BHR', 'AB']::text[], '{}'::integer[], false, true),
  ('pedia_alex_bhr_district_managers', 'Pedia - Alex-BHR - District Managers', 'District Managers on the Pedia line in Alex-BHR. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['District Manager']::text[], array[2]::integer[], array['Alex-BHR', 'AB']::text[], '{}'::integer[], false, true),
  ('pedia_cairo_medical_reps', 'Pedia - Cairo - Medical Reps', 'Medical Reps on the Pedia line in Cairo. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['Medical Rep']::text[], array[2]::integer[], array['Cairo', 'CA']::text[], '{}'::integer[], false, true),
  ('pedia_cairo_district_managers', 'Pedia - Cairo - District Managers', 'District Managers on the Pedia line in Cairo. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['District Manager']::text[], array[2]::integer[], array['Cairo', 'CA']::text[], '{}'::integer[], false, true),
  ('pedia_delta_1_medical_reps', 'Pedia - Delta (1) - Medical Reps', 'Medical Reps on the Pedia line in Delta (1). Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['Medical Rep']::text[], array[2]::integer[], array['Delta (1)', 'D1']::text[], '{}'::integer[], false, true),
  ('pedia_delta_1_district_managers', 'Pedia - Delta (1) - District Managers', 'District Managers on the Pedia line in Delta (1). Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['District Manager']::text[], array[2]::integer[], array['Delta (1)', 'D1']::text[], '{}'::integer[], false, true),
  ('pedia_delta_2_medical_reps', 'Pedia - Delta (2) - Medical Reps', 'Medical Reps on the Pedia line in Delta (2). Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['Medical Rep']::text[], array[2]::integer[], array['Delta (2)', 'D2']::text[], '{}'::integer[], false, true),
  ('pedia_delta_2_district_managers', 'Pedia - Delta (2) - District Managers', 'District Managers on the Pedia line in Delta (2). Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['District Manager']::text[], array[2]::integer[], array['Delta (2)', 'D2']::text[], '{}'::integer[], false, true),
  ('pedia_giza_medical_reps', 'Pedia - Giza - Medical Reps', 'Medical Reps on the Pedia line in Giza. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['Medical Rep']::text[], array[2]::integer[], array['Giza', 'GZ']::text[], '{}'::integer[], false, true),
  ('pedia_giza_district_managers', 'Pedia - Giza - District Managers', 'District Managers on the Pedia line in Giza. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['District Manager']::text[], array[2]::integer[], array['Giza', 'GZ']::text[], '{}'::integer[], false, true),
  ('pedia_upper_egypt_1_medical_reps', 'Pedia - Upper Egypt 1 - Medical Reps', 'Medical Reps on the Pedia line in Upper Egypt 1. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['Medical Rep']::text[], array[2]::integer[], array['Upper Egypt 1', 'UE-1']::text[], '{}'::integer[], false, true),
  ('pedia_upper_egypt_1_district_managers', 'Pedia - Upper Egypt 1 - District Managers', 'District Managers on the Pedia line in Upper Egypt 1. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['District Manager']::text[], array[2]::integer[], array['Upper Egypt 1', 'UE-1']::text[], '{}'::integer[], false, true),
  ('pedia_upper_egypt_2_medical_reps', 'Pedia - Upper Egypt 2 - Medical Reps', 'Medical Reps on the Pedia line in Upper Egypt 2. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['Medical Rep']::text[], array[2]::integer[], array['Upper Egypt 2', 'UE-2']::text[], '{}'::integer[], false, true),
  ('pedia_upper_egypt_2_district_managers', 'Pedia - Upper Egypt 2 - District Managers', 'District Managers on the Pedia line in Upper Egypt 2. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['District Manager']::text[], array[2]::integer[], array['Upper Egypt 2', 'UE-2']::text[], '{}'::integer[], false, true),
  ('cns_alex_bhr_medical_reps', 'CNS - Alex-BHR - Medical Reps', 'Medical Reps on the CNS line in Alex-BHR. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['Medical Rep']::text[], array[3]::integer[], array['Alex-BHR', 'AB']::text[], '{}'::integer[], false, true),
  ('cns_alex_bhr_district_managers', 'CNS - Alex-BHR - District Managers', 'District Managers on the CNS line in Alex-BHR. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['District Manager']::text[], array[3]::integer[], array['Alex-BHR', 'AB']::text[], '{}'::integer[], false, true),
  ('cns_cairo_medical_reps', 'CNS - Cairo - Medical Reps', 'Medical Reps on the CNS line in Cairo. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['Medical Rep']::text[], array[3]::integer[], array['Cairo', 'CA']::text[], '{}'::integer[], false, true),
  ('cns_cairo_district_managers', 'CNS - Cairo - District Managers', 'District Managers on the CNS line in Cairo. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['District Manager']::text[], array[3]::integer[], array['Cairo', 'CA']::text[], '{}'::integer[], false, true),
  ('cns_delta_1_medical_reps', 'CNS - Delta (1) - Medical Reps', 'Medical Reps on the CNS line in Delta (1). Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['Medical Rep']::text[], array[3]::integer[], array['Delta (1)', 'D1']::text[], '{}'::integer[], false, true),
  ('cns_delta_1_district_managers', 'CNS - Delta (1) - District Managers', 'District Managers on the CNS line in Delta (1). Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['District Manager']::text[], array[3]::integer[], array['Delta (1)', 'D1']::text[], '{}'::integer[], false, true),
  ('cns_delta_2_medical_reps', 'CNS - Delta (2) - Medical Reps', 'Medical Reps on the CNS line in Delta (2). Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['Medical Rep']::text[], array[3]::integer[], array['Delta (2)', 'D2']::text[], '{}'::integer[], false, true),
  ('cns_delta_2_district_managers', 'CNS - Delta (2) - District Managers', 'District Managers on the CNS line in Delta (2). Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['District Manager']::text[], array[3]::integer[], array['Delta (2)', 'D2']::text[], '{}'::integer[], false, true),
  ('cns_giza_medical_reps', 'CNS - Giza - Medical Reps', 'Medical Reps on the CNS line in Giza. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['Medical Rep']::text[], array[3]::integer[], array['Giza', 'GZ']::text[], '{}'::integer[], false, true),
  ('cns_giza_district_managers', 'CNS - Giza - District Managers', 'District Managers on the CNS line in Giza. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['District Manager']::text[], array[3]::integer[], array['Giza', 'GZ']::text[], '{}'::integer[], false, true),
  ('cns_upper_egypt_medical_reps', 'CNS - Upper Egypt - Medical Reps', 'Medical Reps on the CNS line in Upper Egypt. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['Medical Rep']::text[], array[3]::integer[], array['Upper Egypt', 'UE']::text[], '{}'::integer[], false, true),
  ('cns_upper_egypt_district_managers', 'CNS - Upper Egypt - District Managers', 'District Managers on the CNS line in Upper Egypt. Matched on region NAME and CODE together, because 13 district managers carry a name and no code.',
   array['District Manager']::text[], array[3]::integer[], array['Upper Egypt', 'UE']::text[], '{}'::integer[], false, true),
  ('head_office', 'Head Office', 'Everyone outside the field force - Marketing, Finance, HR, Admins, Executive, QPPV, R&D and SFE. Keyed on DEPARTMENT, not on the Head Office line: three head-office people sit on a sales line because they own that line''s brands, and their line_id is deliberate rather than a mistake to correct.',
   '{}'::text[], '{}'::integer[], '{}'::text[], array[2, 40, 41, 42, 43, 44, 45, 46]::integer[], false, true)
on conflict (list_key) do nothing;

commit;
