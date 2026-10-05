-- phoenix_crm_refused_reading_off_listing
--
-- WHAT THIS CHANGES:
--   phoenix_crm_refused_readings.reason accepts a third value, 'off_listing', beside 'no_fix' and
--   'rough'. Nothing else: no column, no index, no policy, no row.
--
-- WHY:
--   A validation Google refused as a MISMATCH (the listing IS the account, but the rep's point is
--   150 m - 1 km from its pin) was refused at the door and recorded NOWHERE — the table only ever
--   held a refusal about the position's own quality. So a rep standing at an account that moved
--   could be turned away for ever with nothing on any board to show it, and the next attempt could
--   not know there had been a previous one. Aya Ibrahim Mohamed Salam was refused twice on
--   مستوصف صدر باجور at 11:03 and 11:04 Cairo on 2026-10-05, gave up, and logged the call
--   out-of-list where it scores in nothing; her touch trail is the only record that it happened.
--
--   With the refusal recorded, the second attempt at the same account is HELD for the Super Admin
--   instead of refused (src/lib/phoenix-crm/server/list.ts), which is the owner's own rule for a
--   pin over 1 km away — "hold it for me", because a refusal there could never be passed by
--   standing anywhere.
--
-- ROLLBACK:
--   delete from public.phoenix_crm_refused_readings where reason = 'off_listing';
--   alter table public.phoenix_crm_refused_readings drop constraint phoenix_crm_refused_readings_reason_check;
--   alter table public.phoenix_crm_refused_readings
--     add constraint phoenix_crm_refused_readings_reason_check
--     check (reason = any (array['no_fix'::text, 'rough'::text]));
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This widens one CHECK constraint and writes no rows.

begin;
set local lock_timeout = '5s';

alter table public.phoenix_crm_refused_readings
  drop constraint if exists phoenix_crm_refused_readings_reason_check;

alter table public.phoenix_crm_refused_readings
  add constraint phoenix_crm_refused_readings_reason_check
  check (reason = any (array['no_fix'::text, 'rough'::text, 'off_listing'::text]));

commit;
