-- Reparent the CNS "Downtown" open MR vacancy from the National Sales Manager to the
-- CNS Giza District Sales Manager (B-117), so it groups under the Giza district in the
-- organogram exactly as the owner-confirmed structure specifies (Downtown is a Giza-
-- district seat). It was auto-opened pointing at the NSM, which made it render loose at
-- the top of the CNS chart instead of inside Giza.
--
-- Idempotent: keyed by the stable vacancy_code and only fires while still mis-parented.
update position_vacancies
   set manager_hr_id = 'B-117',
       region_name = 'Giza',
       note = coalesce(note || E'\n', '') ||
              'Structure reconciliation 2026-07-06: reparented CNS Downtown from NSM to Giza DSM (B-117) per structure.'
 where vacancy_code = 'vacancy_16_sales_cns_downtown_medical_representative'
   and status = 'open'
   and manager_hr_id = 'B-122';
