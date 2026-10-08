-- luxor_notes_match_the_separated_state
--
-- WHAT THIS CHANGES:
--   The `notes` text on the current Pedia Luxor (OT6) area-map row, and nothing else. One field,
--   one row. `rep_seat_id` is ALREADY null and correct on production — this migration does not
--   touch it, does not touch any other column, and does not touch any other row.
-- WHY:
--   Production is in a half-applied state that 20261002184148_luxor_separate_from_qena2_no_rep_seat
--   cannot produce. That migration's single `update` sets `rep_seat_id` AND `notes` together, so a
--   run of it leaves both changed. Production carries the NEW seat value (null) beside the OLD
--   notes — the pre-image's own text, digest bfd00aaca87a01e8de0252a7ece6f186 — which means the
--   seat was nulled by something that never wrote the notes, and the revert migration's `update`
--   never ran as written. Reconciled and evidenced on 2026-10-08 in
--   docs/security/migration-ledger-reconciliation-2026-10-08.md.
--
--   STAGING IS THE CONTROL, and it proves the original works as designed: staging's row carries
--   that migration's own notes text (bf6f192ed0baf57e79ed6182cf9b0768) with a null seat. So the
--   target text here is not newly invented — it is the exact string 20261002184148 would have
--   written, which is what staging already holds and what the repo already says.
--
--   Re-applying 20261002184148 can NEVER fix this: its `update` is guarded on
--   `rep_seat_id = 'SEAT-PED-REP-UE8'`, and production's seat is null, so it matches zero rows
--   (verified 2026-10-08 — it was applied as ledger 20261008115526 and was a confirmed no-op).
--   The business state was always right; only the row's own documentation was wrong, telling any
--   reader that Qena 2's rep is credited for Luxor's sales when he is not.
-- NOT DOUBLE-RUN:
--   Guarded on BOTH halves of the half-applied state — the stale notes digest and a null seat. So
--   it is a no-op on a database already carrying the correct text (staging), AND a no-op on one
--   still drifted on the seat, where 20261002184148 is the migration that should run instead.
-- ROLLBACK:
--   update au.line_area_map set notes = (select notes from au.bak_20261008_luxor_notes_fix)
--     where line_code='pedia' and area_code='OT6' and effective_to is null;
--   (pre-image preserved in au.bak_20261008_luxor_notes_fix.) Data only — no schema change.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This is neither destructive nor bulk: one documentation field on one row, fully reversible,
-- pre-image kept, and no application code reads this column (every `au_v_line_area_map` select in
-- src/ enumerates its columns and none of them name `notes`).

begin;
set local lock_timeout = '5s';

-- Pre-image snapshot (au schema, never public). Idempotent: created once, never overwritten.
create table if not exists au.bak_20261008_luxor_notes_fix as
  select * from au.line_area_map
  where line_code='pedia' and area_code='OT6' and effective_to is null;

update au.line_area_map
set notes = 'Upper Egypt split, owner-approved 2026-09-09. Luxor is with Qena 2 and is NOT a separate area: it joins Upper Egypt 2 but carries no target and has no rep of its own. 2026-10-02: owner reverted the 2026-09-11 shared-rep-seat union — Qena 2 and Luxor are separated again; Luxor has no rep seat (restores the 2026-09-09 migration state). Pre-image in au.bak_20261002_luxor_rep_seat_revert.'
where line_code='pedia' and area_code='OT6' and effective_to is null
  and rep_seat_id is null
  and md5(notes) = 'bfd00aaca87a01e8de0252a7ece6f186';

do $do$
declare
  v_row record;
begin
  select rep_seat_id, md5(notes) as notes_md5
    into v_row
    from au.line_area_map
   where line_code='pedia' and area_code='OT6' and effective_to is null;

  if v_row is null then
    raise exception 'no current pedia/OT6 area-map row — refusing to report success';
  end if;

  if v_row.notes_md5 = 'bf6f192ed0baf57e79ed6182cf9b0768' then
    raise notice 'Luxor notes now match the separated state (seat=%)', coalesce(v_row.rep_seat_id, 'null');
  elsif v_row.rep_seat_id = 'SEAT-PED-REP-UE8' then
    raise notice 'Luxor still carries the shared rep seat — declined on purpose; 20261002184148 is the migration for that state';
  else
    raise exception 'Luxor notes are neither the separated text nor the drifted-seat state: seat=% notes_md5=%',
      coalesce(v_row.rep_seat_id, 'null'), v_row.notes_md5;
  end if;
end;
$do$;

commit;
