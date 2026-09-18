-- outstation_captured_accuracy_nullable
--
-- WHAT THIS CHANGES: public.outstation_expense_requests.captured_accuracy_meters may now be null.
--   No row is written. The column keeps its type (double precision) and has no default, as before.
--
-- WHY: the four outstation routes read the accuracy as `Number(body.capturedAccuracyMeters)`.
--   `Number(null)`, `Number("")` and `Number(" ")` are all 0, so a claim whose device reported no
--   accuracy was stored as a perfect 0 m fix and passed the policy's GPS accuracy limit, which only
--   holds a claim when the accuracy is ABOVE the limit. The routes now read it with
--   readAccuracyInput (src/lib/geo/coordinate-input.ts), so a missing accuracy is null, and the
--   owner decided on 2026-09-18 that such a claim is saved as "not reported" and held for Super
--   Admin review. Storing that null needs the NOT NULL constraint gone.
--
--   0 keeps its existing meaning: it is the marker the admin-entered and medical-rep manual paths
--   write (src/lib/outstation/service.ts), which expense-command.ts reads to tell a manual entry
--   from a live one. Null never matches that marker.
--
--   Production before this change (2026-09-18): 115 rows, none null (the constraint forbade it);
--   23 at 0 m, every one an admin-entered manual claim; the 92 live claims carry 2 to 1,427 m.
--
-- ROLLBACK: alter table public.outstation_expense_requests
--             alter column captured_accuracy_meters set not null;
--   That fails once any live claim has stored a null accuracy. Such a row would first need an
--   accuracy chosen for it, and 0 must not be that choice: 0 marks a manual entry.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.outstation_expense_requests
  alter column captured_accuracy_meters drop not null;

comment on column public.outstation_expense_requests.captured_accuracy_meters is
  'GPS accuracy radius in metres as the device reported it. Null: the device reported none (the claim is held for Super Admin review). 0: written by the admin-entered and medical-rep manual paths as their marker, never by a live capture.';

commit;
