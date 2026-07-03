-- Add the missing unique(digest_line_id) constraint on attendance_settlements.
--
-- This is the hard database-enforced guarantee the settlement service relies
-- on: at most one settlement outcome can ever exist per digest line, which is
-- what makes "either HR Manager or System Admin reviews a dispute, first to
-- act wins" (and the confirm/auto-confirm double-settlement guard) a real
-- database invariant rather than just an application-level check. Table is
-- confirmed empty at the time of this migration, so this is a safe add.
--
-- Standalone/additive because attendance_settlements was already created by
-- an earlier migration on this environment without this constraint — see
-- src/lib/attendance/settlement-service.ts for the code that depends on it.

begin;

alter table public.attendance_settlements
  add constraint attendance_settlements_digest_line_id_key unique (digest_line_id);

notify pgrst, 'reload schema';

commit;
