-- iReports360 added a contactGrade field to its /visits and /checkins responses (observed
-- 2026-07-24 via a live API audit, not present as of 2026-07-22's region/speciality audit) --
-- the visited contact's (doctor/hospital/pharmacy) commercial potential grade (A+/A/B/C, A being
-- highest potential). Populated on 100% of regular customer visits/check-ins, null on
-- non-customer visit types (campaign/meeting/leave), same pattern as crm_region_id/speciality.

alter table public.ireports360_visits
  add column if not exists crm_contact_grade text;

comment on column public.ireports360_visits.crm_contact_grade is
  'The visited contact''s commercial potential grade from iReports360 (vendor field: contactGrade), normalized to uppercase/trimmed (A+, A, B, C -- A is highest potential, C lowest). The vendor sends inconsistent casing/whitespace ("b", " A", "B   "); the sync engine normalizes before storing, so this column is always clean. Null for non-customer visit types (campaign/meeting/leave), which carry no real contact.';
