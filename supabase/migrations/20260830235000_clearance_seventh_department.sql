-- The employee clearance gained a seventh signing desk — correct the checklist description.
--
-- WHAT CHANGED. The owner's clearance paper listed six departments. Phoenix's Clearance module
-- tracks SEVEN against a departure, and the desk the module had and the paper did not was `fleet`
-- (`hr_clearance_stations`, sort_order 30) — company car, keys, fuel card, toll tag, traffic fines.
-- On 2026-08-30 he asked for it to be added to the form. A leaver still holding a company car could
-- otherwise be signed clear by every desk the paper listed.
--
-- WHY A SECOND MIGRATION AND NOT AN EDIT TO THE FIRST. 20260830183000 has already been applied to
-- production — verified by reading the row back, not by trusting the ledger. Editing an applied
-- migration changes the file and nothing else: the insert there is guarded by `where not exists`,
-- so it would never re-run, and the repository would then disagree with the database while looking
-- correct. The applied file stays exactly as it ran; the correction moves forward.
--
-- WHY THE NEW WORDING CARRIES NO NUMBER. "Signed by six departments" was true when it was written
-- and false the moment a row was added, which is the failure worth designing out rather than
-- re-fixing: how many desks sign is decided by `hr_clearance_stations`, a table somebody can add to.
-- The description now describes the rule instead of counting it, so the next desk costs nothing.
-- The same correction was made to the printed Arabic certification, which read
-- «توقيعات الإدارات الست» and now reads «جميع الإدارات» — pinned by
-- `testTheCertificationNeverCountsTheDepartments` in tests/hr-forms-clearance.test.ts.

update public.hiring_document_definitions
   set description = 'إخلاء طرف موظف — the company certifies the employee is clear, signed by every department on the form (including Fleet & Transport) and stamped. The employee keeps the original; this is the file copy. Complement of the company clearance, not an alternative to it.'
 where name = 'Signed employee clearance'
   and description like '%six departments%';

-- ── Rollback ──────────────────────────────────────────────────────────────────────────────────
--   update public.hiring_document_definitions
--      set description = 'إخلاء طرف موظف — the company certifies the employee is clear, signed by six departments and stamped. The employee keeps the original; this is the file copy. Complement of the company clearance, not an alternative to it.'
--    where name = 'Signed employee clearance';
