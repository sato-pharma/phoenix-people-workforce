-- Reconcile Anti Infective / Pedia / CNS area assignments against the owner-provided
-- authoritative territory structure. Areas are the fixed structure; only the employees
-- sitting on them change over time. Every statement below is idempotent and scoped by
-- area `code` (globally unique) rather than numeric id, so it is safe to re-run and safe
-- to apply across environments whose auto-generated ids differ. Employee repoints use a
-- FROM-join so they only fire when both the source and destination area rows actually
-- exist and the employee is still sitting on the old (borrowed cross-line) row — this
-- guarantees an employee's area_id is never set to NULL if a target row is missing in a
-- given environment.

-- 1) Anti Infective (line_id = 1): create the 7 area rows the line's own territory
--    master was missing (previously only Pedia/CNS owned rows with these names existed).
insert into areas (line_id, code, name, is_active) values
  (1, 'ai_cairo_east_2', 'Cairo East 2', true),
  (1, 'ai_assuit_2', 'Assuit 2', true),
  (1, 'ai_dakahlia_1', 'Dakahlia 1', true),
  (1, 'ai_dakahlia_2', 'Dakahlia 2', true),
  (1, 'ai_dakahlia_3', 'Dakahlia 3', true),
  (1, 'ai_dakahlia_4', 'Dakahlia 4', true),
  (1, 'ai_tanta', 'Tanta', true)
on conflict do nothing;

-- 2) Anti Infective's own "Alex East 2" row was an unused near-duplicate of Pedia's
--    "Alex East" (AB1). Rename it to the canonical "Alex East" so Anti Infective has
--    its own distinctly-owned row under the name the structure actually uses.
update areas set name = 'Alex East'
where code = 'alex_east_2' and line_id = 1 and name <> 'Alex East';

-- 3) Repoint Anti Infective reps off borrowed Pedia/CNS rows onto Anti Infective's own
--    (newly created or already-existing-but-unused) rows of the same territory.
update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'ai_cairo_east_2' and src.code = 'CA4'
  and e.hr_id = 'B-161' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'cairo_east' and src.code = 'CA3'
  and e.hr_id = 'AI-0003' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'ai_assuit_2' and src.code = 'UE4'
  and e.hr_id = 'B-13' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'sohag_1' and src.code = 'UE5'
  and e.hr_id = 'B-151' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'alex_east_2' and src.code = 'AB1'
  and e.hr_id = 'AI-0002' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'ai_dakahlia_1' and src.code = 'D21'
  and e.hr_id = 'B-40' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'ai_dakahlia_2' and src.code = 'D22'
  and e.hr_id = 'B-108' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'giza_centers' and src.code = 'GZ1'
  and e.hr_id = 'B-105' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'monofia_2' and src.code = 'D13'
  and e.hr_id = 'B-7' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'domiat' and src.code = 'D26'
  and e.hr_id = 'B-15' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'ai_dakahlia_3' and src.code = 'D23'
  and e.hr_id = 'B-96' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'mahalla' and src.code = 'D14'
  and e.hr_id = 'B-97' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'ai_tanta' and src.code = 'D15'
  and e.hr_id = 'B-179' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'kfs' and src.code = 'D16'
  and e.hr_id = 'B-107' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'helwan' and src.code = 'GZ5'
  and e.hr_id = 'B-104' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'monofia_1' and src.code = 'D12'
  and e.hr_id = 'B-55' and e.area_id = src.id;

-- 4) Split the Anti Infective "Qena" double-booking: two reps were both wired to a
--    single borrowed Pedia row (UE7) instead of Anti Infective's own Qena 1 / Qena 2
--    seats. Their own team_id already encoded which seat each belongs to.
update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'qena_1' and src.code = 'UE7'
  and e.hr_id = 'B-152' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'qena_2' and src.code = 'UE7'
  and e.hr_id = 'B-189' and e.area_id = src.id;

-- 5) Pedia (line_id = 2): the structure has a single "Alex Center" seat (not a 1/2
--    split). Rename Pedia's own unused "Alex Center 1" row to the canonical name and
--    add the "Mahalla" row the line was missing.
update areas set name = 'Alex Center'
where code = 'alex_center_1' and line_id = 2 and name <> 'Alex Center';

insert into areas (line_id, code, name, is_active) values
  (2, 'pd_mahalla', 'Mahalla', true)
on conflict do nothing;

-- 6) Repoint Pedia reps off borrowed Anti Infective/CNS rows onto Pedia's own rows.
update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'alex_center_1' and src.code = 'AB2'
  and e.hr_id = 'PD-0005' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'kafr_el_sheikh_1' and src.code = 'D16'
  and e.hr_id = 'B-169' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'banha' and src.code = 'D11'
  and e.hr_id = 'B-100' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'pd_mahalla' and src.code = 'D14'
  and e.hr_id = 'B-170' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'tanta' and src.code = 'D15'
  and e.hr_id = 'B-158' and e.area_id = src.id;

-- 7) CNS (line_id = 3): repoint reps off borrowed Anti Infective/Pedia rows onto CNS's
--    own already-seeded (just unused) rows.
update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'alex_center_2' and src.code = 'AB2'
  and e.hr_id = 'B-132' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'alex_west_center1' and src.code = 'AB3'
  and e.hr_id = 'B-143' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'cairo_east_1_2_abbasia_and_kobbah_east_2' and src.code = 'CA3'
  and e.hr_id = 'B-146' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'cairo_east_3_4_5_east1' and src.code = 'CA4'
  and e.hr_id = 'CN-0004' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'shoubra_and_shoubra_el_kheima' and src.code = 'CA6'
  and e.hr_id = 'B-127' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'nasr_city_5th_settlement' and src.code = 'CA2'
  and e.hr_id = 'CN-0001' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'sharkia_3' and src.code = 'D25'
  and e.hr_id = 'B-148' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'dokki_mohandsen_imbaba' and src.code = 'GZ2'
  and e.hr_id = 'B-147' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'haram_giza_midan_giza_centers' and src.code = 'GZ1'
  and e.hr_id = 'B-138' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'faisal_and_october' and src.code = 'GZ4'
  and e.hr_id = 'B-137' and e.area_id = src.id;

update employees e set area_id = dst.id
from areas dst, areas src
where dst.code = 'qena_and_nagaa_hammady' and src.code = 'UE7'
  and e.hr_id = 'B-131' and e.area_id = src.id;
