-- vacation_decider_hr_id_upper_case
--
-- WHAT THIS CHANGES: data only. On v2_vacation_requests, upper-cases the two columns that name who DECIDED a
--   leave request — manager_decision_by_hr_id and hr_decision_by_hr_id — where they were stored lower case
--   ("b-118" instead of "B-118"). Production on 2026-10-26: 91 requests touched (85 manager cells, 77 HR cells,
--   71 requests carry both). No schema change, no other column, no other table.
--
-- WHY: the decision flow persisted the lowercase comparison key (resolveEmployeeIdentityId) instead of the
--   stored form (hrIdForStorage), so name lookups and "decided by me" filters that compare the stored text
--   missed those rows. The writer is fixed in the same change (src/lib/vacation/service.ts,
--   resolveStoredDeciderHrId); this repairs the rows already written.
--
-- SAFE: idempotent — the WHERE clause matches only rows that still hold a lower-case value, so a re-run (or a
--   run after the writer fix has landed) changes nothing. upper() is exact for these values: every one is a
--   plain HR number ("a-12", "aa", "ai-0008", "b-10", "b-122", "pd-0001" …) whose stored form is its upper-case
--   twin.

update public.v2_vacation_requests
   set manager_decision_by_hr_id = upper(manager_decision_by_hr_id)
 where manager_decision_by_hr_id is not null
   and manager_decision_by_hr_id <> upper(manager_decision_by_hr_id);

update public.v2_vacation_requests
   set hr_decision_by_hr_id = upper(hr_decision_by_hr_id)
 where hr_decision_by_hr_id is not null
   and hr_decision_by_hr_id <> upper(hr_decision_by_hr_id);
