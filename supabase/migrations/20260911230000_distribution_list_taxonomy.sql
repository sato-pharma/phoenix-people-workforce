-- The full distribution-list taxonomy the owner asked for on 2026-09-11: 54 named audiences.
--
-- THE `all_employees` FLAG IS THE ONLY WAY TO ADDRESS THE WHOLE COMPANY. A list with no rule
-- resolves to NOBODY by design, so a half-finished list can never quietly mail everyone; that
-- guard would also make a legitimate all-company list impossible, which is what this flag is for.
-- Reaching all ~109 people has to be something somebody switched on.
--
-- REGIONS ARE MATCHED ON NAME **AND** CODE. Measured in production the day these were built: 13
-- field employees carry a region_name with no region_code, and every one of them is a District
-- Manager. Keying the region rules on the code alone would have produced 20 silently EMPTY
-- district-manager lists while the rep lists beside them looked perfectly correct.
--
-- What the taxonomy deliberately does NOT contain, because production says so:
--   * no Pedia/Cairo list - Pedia has no Cairo region
--   * CNS keeps ONE "Upper Egypt"; only Anti Infective and Pedia are split into UE-1/UE-2, and
--     the Pedia split is the owner's golden rule of 2026-09-09. They are not aligned.
--   * Delta (3) appears on Anti Infective only, as ruled.
--
-- Every list is seeded ENABLED except sato_pharma_family - see its own note.
begin;

alter table public.distribution_lists
  add column if not exists all_employees boolean not null default false;

comment on column public.distribution_lists.all_employees is
  'Addresses every active employee. The only way to reach the whole company - a list with no rule resolves to nobody, deliberately.';

insert into public.distribution_lists
  (list_key, label, description, roles, line_ids, region_codes, all_employees, enabled) values
  ('all_medical_reps', 'All Medical Reps', 'Every medical rep in the company, on any line.',
   array['Medical Rep']::text[], '{}'::integer[], '{}'::text[], false, true),
  ('all_district_managers', 'All District Managers', 'Every district manager in the company, on any line.',
   array['District Manager']::text[], '{}'::integer[], '{}'::text[], false, true),
  ('all_national_sales_managers', 'All National Sales Managers', 'The national sales manager of every line.',
   array['National Sales Manager']::text[], '{}'::integer[], '{}'::text[], false, true),
  ('sato_pharma_family', 'Sato Pharma Family', 'Everyone in the company. Seeded DISABLED: it is the only list that can address all ~109 employees at once, and the standing rule is never to fire a bulk email. Switch it on when there is a specific use for it.',
   '{}'::text[], '{}'::integer[], '{}'::text[], true, false),
  ('line_anti_infective', 'Anti Infective — everyone', 'Everyone on the Anti Infective line, at any rank.',
   '{}'::text[], array[1]::integer[], '{}'::text[], false, true),
  ('line_anti_infective_medical_reps', 'Anti Infective — Medical Reps', 'Medical Reps on the Anti Infective line, in every region.',
   array['Medical Rep']::text[], array[1]::integer[], '{}'::text[], false, true),
  ('line_anti_infective_district_managers', 'Anti Infective — District Managers', 'District Managers on the Anti Infective line, in every region.',
   array['District Manager']::text[], array[1]::integer[], '{}'::text[], false, true),
  ('line_pedia', 'Pedia — everyone', 'Everyone on the Pedia line, at any rank.',
   '{}'::text[], array[2]::integer[], '{}'::text[], false, true),
  ('line_pedia_medical_reps', 'Pedia — Medical Reps', 'Medical Reps on the Pedia line, in every region.',
   array['Medical Rep']::text[], array[2]::integer[], '{}'::text[], false, true),
  ('line_pedia_district_managers', 'Pedia — District Managers', 'District Managers on the Pedia line, in every region.',
   array['District Manager']::text[], array[2]::integer[], '{}'::text[], false, true),
  ('line_cns', 'CNS — everyone', 'Everyone on the CNS line, at any rank.',
   '{}'::text[], array[3]::integer[], '{}'::text[], false, true),
  ('line_cns_medical_reps', 'CNS — Medical Reps', 'Medical Reps on the CNS line, in every region.',
   array['Medical Rep']::text[], array[3]::integer[], '{}'::text[], false, true),
  ('line_cns_district_managers', 'CNS — District Managers', 'District Managers on the CNS line, in every region.',
   array['District Manager']::text[], array[3]::integer[], '{}'::text[], false, true),
  ('anti_infective_alex_bhr_medical_reps', 'Anti Infective · Alex-BHR — Medical Reps', 'Medical Reps on the Anti Infective line in Alex-BHR. Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['Medical Rep']::text[], array[1]::integer[], array['Alex-BHR', 'AB']::text[], false, true),
  ('anti_infective_alex_bhr_district_managers', 'Anti Infective · Alex-BHR — District Managers', 'District Managers on the Anti Infective line in Alex-BHR. Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['District Manager']::text[], array[1]::integer[], array['Alex-BHR', 'AB']::text[], false, true),
  ('anti_infective_cairo_medical_reps', 'Anti Infective · Cairo — Medical Reps', 'Medical Reps on the Anti Infective line in Cairo. Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['Medical Rep']::text[], array[1]::integer[], array['Cairo', 'CA']::text[], false, true),
  ('anti_infective_cairo_district_managers', 'Anti Infective · Cairo — District Managers', 'District Managers on the Anti Infective line in Cairo. Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['District Manager']::text[], array[1]::integer[], array['Cairo', 'CA']::text[], false, true),
  ('anti_infective_delta_1_medical_reps', 'Anti Infective · Delta (1) — Medical Reps', 'Medical Reps on the Anti Infective line in Delta (1). Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['Medical Rep']::text[], array[1]::integer[], array['Delta (1)', 'D1']::text[], false, true),
  ('anti_infective_delta_1_district_managers', 'Anti Infective · Delta (1) — District Managers', 'District Managers on the Anti Infective line in Delta (1). Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['District Manager']::text[], array[1]::integer[], array['Delta (1)', 'D1']::text[], false, true),
  ('anti_infective_delta_2_medical_reps', 'Anti Infective · Delta (2) — Medical Reps', 'Medical Reps on the Anti Infective line in Delta (2). Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['Medical Rep']::text[], array[1]::integer[], array['Delta (2)', 'D2']::text[], false, true),
  ('anti_infective_delta_2_district_managers', 'Anti Infective · Delta (2) — District Managers', 'District Managers on the Anti Infective line in Delta (2). Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['District Manager']::text[], array[1]::integer[], array['Delta (2)', 'D2']::text[], false, true),
  ('anti_infective_delta_3_medical_reps', 'Anti Infective · Delta (3) — Medical Reps', 'Medical Reps on the Anti Infective line in Delta (3). Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['Medical Rep']::text[], array[1]::integer[], array['Delta (3)', 'D3']::text[], false, true),
  ('anti_infective_delta_3_district_managers', 'Anti Infective · Delta (3) — District Managers', 'District Managers on the Anti Infective line in Delta (3). Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['District Manager']::text[], array[1]::integer[], array['Delta (3)', 'D3']::text[], false, true),
  ('anti_infective_giza_medical_reps', 'Anti Infective · Giza — Medical Reps', 'Medical Reps on the Anti Infective line in Giza. Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['Medical Rep']::text[], array[1]::integer[], array['Giza', 'GZ']::text[], false, true),
  ('anti_infective_giza_district_managers', 'Anti Infective · Giza — District Managers', 'District Managers on the Anti Infective line in Giza. Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['District Manager']::text[], array[1]::integer[], array['Giza', 'GZ']::text[], false, true),
  ('anti_infective_upper_egypt_1_medical_reps', 'Anti Infective · Upper Egypt 1 — Medical Reps', 'Medical Reps on the Anti Infective line in Upper Egypt 1. Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['Medical Rep']::text[], array[1]::integer[], array['Upper Egypt 1', 'UE-1']::text[], false, true),
  ('anti_infective_upper_egypt_1_district_managers', 'Anti Infective · Upper Egypt 1 — District Managers', 'District Managers on the Anti Infective line in Upper Egypt 1. Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['District Manager']::text[], array[1]::integer[], array['Upper Egypt 1', 'UE-1']::text[], false, true),
  ('anti_infective_upper_egypt_2_medical_reps', 'Anti Infective · Upper Egypt 2 — Medical Reps', 'Medical Reps on the Anti Infective line in Upper Egypt 2. Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['Medical Rep']::text[], array[1]::integer[], array['Upper Egypt 2', 'UE-2']::text[], false, true),
  ('anti_infective_upper_egypt_2_district_managers', 'Anti Infective · Upper Egypt 2 — District Managers', 'District Managers on the Anti Infective line in Upper Egypt 2. Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['District Manager']::text[], array[1]::integer[], array['Upper Egypt 2', 'UE-2']::text[], false, true),
  ('pedia_alex_bhr_medical_reps', 'Pedia · Alex-BHR — Medical Reps', 'Medical Reps on the Pedia line in Alex-BHR. Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['Medical Rep']::text[], array[2]::integer[], array['Alex-BHR', 'AB']::text[], false, true),
  ('pedia_alex_bhr_district_managers', 'Pedia · Alex-BHR — District Managers', 'District Managers on the Pedia line in Alex-BHR. Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['District Manager']::text[], array[2]::integer[], array['Alex-BHR', 'AB']::text[], false, true),
  ('pedia_delta_1_medical_reps', 'Pedia · Delta (1) — Medical Reps', 'Medical Reps on the Pedia line in Delta (1). Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['Medical Rep']::text[], array[2]::integer[], array['Delta (1)', 'D1']::text[], false, true),
  ('pedia_delta_1_district_managers', 'Pedia · Delta (1) — District Managers', 'District Managers on the Pedia line in Delta (1). Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['District Manager']::text[], array[2]::integer[], array['Delta (1)', 'D1']::text[], false, true),
  ('pedia_delta_2_medical_reps', 'Pedia · Delta (2) — Medical Reps', 'Medical Reps on the Pedia line in Delta (2). Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['Medical Rep']::text[], array[2]::integer[], array['Delta (2)', 'D2']::text[], false, true),
  ('pedia_delta_2_district_managers', 'Pedia · Delta (2) — District Managers', 'District Managers on the Pedia line in Delta (2). Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['District Manager']::text[], array[2]::integer[], array['Delta (2)', 'D2']::text[], false, true),
  ('pedia_giza_medical_reps', 'Pedia · Giza — Medical Reps', 'Medical Reps on the Pedia line in Giza. Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['Medical Rep']::text[], array[2]::integer[], array['Giza', 'GZ']::text[], false, true),
  ('pedia_giza_district_managers', 'Pedia · Giza — District Managers', 'District Managers on the Pedia line in Giza. Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['District Manager']::text[], array[2]::integer[], array['Giza', 'GZ']::text[], false, true),
  ('pedia_upper_egypt_1_medical_reps', 'Pedia · Upper Egypt 1 — Medical Reps', 'Medical Reps on the Pedia line in Upper Egypt 1. Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['Medical Rep']::text[], array[2]::integer[], array['Upper Egypt 1', 'UE-1']::text[], false, true),
  ('pedia_upper_egypt_1_district_managers', 'Pedia · Upper Egypt 1 — District Managers', 'District Managers on the Pedia line in Upper Egypt 1. Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['District Manager']::text[], array[2]::integer[], array['Upper Egypt 1', 'UE-1']::text[], false, true),
  ('pedia_upper_egypt_2_medical_reps', 'Pedia · Upper Egypt 2 — Medical Reps', 'Medical Reps on the Pedia line in Upper Egypt 2. Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['Medical Rep']::text[], array[2]::integer[], array['Upper Egypt 2', 'UE-2']::text[], false, true),
  ('pedia_upper_egypt_2_district_managers', 'Pedia · Upper Egypt 2 — District Managers', 'District Managers on the Pedia line in Upper Egypt 2. Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['District Manager']::text[], array[2]::integer[], array['Upper Egypt 2', 'UE-2']::text[], false, true),
  ('cns_alex_bhr_medical_reps', 'CNS · Alex-BHR — Medical Reps', 'Medical Reps on the CNS line in Alex-BHR. Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['Medical Rep']::text[], array[3]::integer[], array['Alex-BHR', 'AB']::text[], false, true),
  ('cns_alex_bhr_district_managers', 'CNS · Alex-BHR — District Managers', 'District Managers on the CNS line in Alex-BHR. Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['District Manager']::text[], array[3]::integer[], array['Alex-BHR', 'AB']::text[], false, true),
  ('cns_cairo_medical_reps', 'CNS · Cairo — Medical Reps', 'Medical Reps on the CNS line in Cairo. Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['Medical Rep']::text[], array[3]::integer[], array['Cairo', 'CA']::text[], false, true),
  ('cns_cairo_district_managers', 'CNS · Cairo — District Managers', 'District Managers on the CNS line in Cairo. Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['District Manager']::text[], array[3]::integer[], array['Cairo', 'CA']::text[], false, true),
  ('cns_delta_1_medical_reps', 'CNS · Delta (1) — Medical Reps', 'Medical Reps on the CNS line in Delta (1). Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['Medical Rep']::text[], array[3]::integer[], array['Delta (1)', 'D1']::text[], false, true),
  ('cns_delta_1_district_managers', 'CNS · Delta (1) — District Managers', 'District Managers on the CNS line in Delta (1). Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['District Manager']::text[], array[3]::integer[], array['Delta (1)', 'D1']::text[], false, true),
  ('cns_delta_2_medical_reps', 'CNS · Delta (2) — Medical Reps', 'Medical Reps on the CNS line in Delta (2). Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['Medical Rep']::text[], array[3]::integer[], array['Delta (2)', 'D2']::text[], false, true),
  ('cns_delta_2_district_managers', 'CNS · Delta (2) — District Managers', 'District Managers on the CNS line in Delta (2). Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['District Manager']::text[], array[3]::integer[], array['Delta (2)', 'D2']::text[], false, true),
  ('cns_giza_medical_reps', 'CNS · Giza — Medical Reps', 'Medical Reps on the CNS line in Giza. Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['Medical Rep']::text[], array[3]::integer[], array['Giza', 'GZ']::text[], false, true),
  ('cns_giza_district_managers', 'CNS · Giza — District Managers', 'District Managers on the CNS line in Giza. Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['District Manager']::text[], array[3]::integer[], array['Giza', 'GZ']::text[], false, true),
  ('cns_upper_egypt_medical_reps', 'CNS · Upper Egypt — Medical Reps', 'Medical Reps on the CNS line in Upper Egypt. Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['Medical Rep']::text[], array[3]::integer[], array['Upper Egypt', 'UE']::text[], false, true),
  ('cns_upper_egypt_district_managers', 'CNS · Upper Egypt — District Managers', 'District Managers on the CNS line in Upper Egypt. Matched on the region NAME and CODE together: 13 district managers carry a name and no code, so a code-only rule would leave every DM list empty.',
   array['District Manager']::text[], array[3]::integer[], array['Upper Egypt', 'UE']::text[], false, true),
  ('head_office', 'Head Office', 'Everyone on the Head Office line — the non-field seats.',
   '{}'::text[], array[4]::integer[], '{}'::text[], false, true)
on conflict (list_key) do nothing;

commit;
