-- phoenix_crm_speciality_one_list
--
-- WHAT THIS CHANGES: data only — no table, column, function, grant or policy changes. Every
--   phoenix_crm_customers.speciality and phoenix_crm_manager_customers.speciality that spells a speciality on
--   the one Phoenix CRM list another way is set to that list's name: 88 spellings (856 rows on production
--   on 2026-11-19, every status), for example "Pedia", "pedia", "Pediatric", "اطفال", "بيديا" and a "pedia"
--   carrying an invisible right-to-left mark all become "Pediatrics". A box holding only ".." becomes null.
--   Two specialities typed in one box ("Pedia + IM", "باطنه وقلب") keep the first one named. A text that
--   spells nothing on the list ("Distributor", "Store", "Bank", "Ob & Gynecology", "النووية") is left as
--   written — it is an "Other" speciality.
-- WHY: the owner, 2026-11-19, after the specialty audit found 111 spellings for about thirty specialities
--   on the live lists: "fix specialities and fix this chaos and make the speciality not typable fixed drop
--   list", and "add other and under other make him able to type". The same change makes every screen pick
--   from src/lib/phoenix-crm/speciality-list.ts and folds whatever reaches the server through
--   normalizeSpeciality(); the pairs below are that function's own answer for every spelling production
--   held (tests/phoenix-crm-speciality-list.test.ts pins the same pairs).
-- ROLLBACK: the pre-image is phoenix_crm_backup_20261119.speciality_before (source, id, speciality), taken on
--   production before this file was applied:
--     update public.phoenix_crm_customers c set speciality = b.speciality
--       from phoenix_crm_backup_20261119.speciality_before b where b.source = 'customer' and b.id = c.id;
--     update public.phoenix_crm_manager_customers c set speciality = b.speciality
--       from phoenix_crm_backup_20261119.speciality_before b where b.source = 'manager_customer' and b.id = c.id;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Announced to the owner in plain words before it was applied (bulk: 856 rows).

begin;

create temporary table speciality_one_list (raw text primary key, clean text) on commit drop;

insert into speciality_one_list (raw, clean) values
    ('chest', 'Chest'),
    ('Chest and Ent', 'Chest'),
    ('استشاري الصدر', 'Chest'),
    ('شيست', 'Chest'),
    ('صدر', 'Chest'),
    ('Educational institute', 'Educational Institute'),
    ('ent', 'ENT'),
    ('eNt', 'ENT'),
    ('Ent', 'ENT'),
    ('ENT + GP +Pedia', 'ENT'),
    ('ent chest', 'ENT'),
    ('انف واذن', 'ENT'),
    ('انف واذن وحنجره', 'ENT'),
    (U&'\200Fgp', 'General Practitioner'),
    ('gp', 'General Practitioner'),
    (U&'\200FGp', 'General Practitioner'),
    ('Gp', 'General Practitioner'),
    ('GP', 'General Practitioner'),
    ('GP + Pedia', 'General Practitioner'),
    ('Sur', 'General Surgery'),
    ('Surgery', 'General Surgery'),
    ('استشاري الجراحه العامه', 'General Surgery'),
    ('جراحة عامة', 'General Surgery'),
    ('جراحه', 'General Surgery'),
    ('جراحه جهاز هضمي والسمنه', 'General Surgery'),
    ('جراحه عامه', 'General Surgery'),
    ('التأمين الصحي', 'Health Insurance'),
    ('Government Hospital', 'Hospital'),
    ('hospital', 'Hospital'),
    ('Diabetes specialist', 'Internal Medicine'),
    ('im', 'Internal Medicine'),
    ('Im', 'Internal Medicine'),
    ('IM', 'Internal Medicine'),
    ('im/chest باطنه وامراض صدريه', 'Internal Medicine'),
    ('Internal medecin', 'Internal Medicine'),
    ('Internal medicin', 'Internal Medicine'),
    ('Internal medicine', 'Internal Medicine'),
    ('Internal Medicine and cardio', 'Internal Medicine'),
    ('استشاري الامراض الباطنيه', 'Internal Medicine'),
    ('امراض الباطنه', 'Internal Medicine'),
    ('باطنة', 'Internal Medicine'),
    ('باطنه', 'Internal Medicine'),
    ('باطنه عامه', 'Internal Medicine'),
    ('باطنه وقلب', 'Internal Medicine'),
    ('Neurosurger', 'Neuro Surgery'),
    ('cns', 'Neurology'),
    ('Cns', 'Neurology'),
    ('CNS', 'Neurology'),
    ('cns and im and ent', 'Neurology'),
    ('Nero', 'Neurology'),
    ('neuro', 'Neurology'),
    ('Neuro', 'Neurology'),
    (U&'\200FNeuro', 'Neurology'),
    ('Neuro physicatiry', 'Neurology'),
    ('neurological', 'Neurology'),
    ('Neurologist', 'Neurology'),
    ('مخ واعصاب', 'Neurology'),
    ('مخ واعصاب والطب النفسي', 'Neurology'),
    ('..', null::text),
    ('Orthopedic', 'Orthopedic Surgery'),
    ('Ped', 'Pediatrics'),
    ('pedia', 'Pediatrics'),
    (U&'\200Fpedia', 'Pediatrics'),
    ('Pedia', 'Pediatrics'),
    ('Pedia + Im', 'Pediatrics'),
    ('Pedia and chest', 'Pediatrics'),
    ('pedia, ENT, IM', 'Pediatrics'),
    ('Pedia.', 'Pediatrics'),
    ('Pedia&Gp', 'Pediatrics'),
    ('Pediatric', 'Pediatrics'),
    ('اطفال', 'Pediatrics'),
    (U&'\200Fاطفال', 'Pediatrics'),
    ('بيديا', 'Pediatrics'),
    ('Chain Pharmacy', 'Pharmacy'),
    ('Poly Clinic', 'Polyclinics'),
    ('Tropical medicine', 'Tropical Medicine'),
    ('حميات واطفال', 'Tropical Medicine'),
    ('حميات وباطنه وحضانه', 'Tropical Medicine'),
    ('Uero', 'Urology'),
    ('Ueuro', 'Urology'),
    ('uro', 'Urology'),
    ('Uro', 'Urology'),
    ('URO', 'Urology'),
    ('urology', 'Urology'),
    ('جراحه مسالك', 'Urology'),
    ('جراحه مسالك والكلي', 'Urology'),
    ('مسالك', 'Urology'),
    ('مسالك بوليه', 'Urology');

update public.phoenix_crm_customers c
set speciality = m.clean
from speciality_one_list m
where c.speciality = m.raw
  and c.speciality is distinct from m.clean;

update public.phoenix_crm_manager_customers c
set speciality = m.clean
from speciality_one_list m
where c.speciality = m.raw
  and c.speciality is distinct from m.clean;

commit;
