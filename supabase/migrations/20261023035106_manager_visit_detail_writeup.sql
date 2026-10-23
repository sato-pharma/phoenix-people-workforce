-- manager_visit_detail_writeup
--
-- WHAT THIS CHANGES: two nullable columns on phoenix_crm_manager_visits —
--   detail_comment   the longer account a manager writes up AFTER logging the visit
--   detail_edited_at when he last wrote it up, so the card can say "Edited · <date time>"
-- Nothing is backfilled and no existing column moves, so every logged visit reads exactly as it did.
--
-- WHY: logging a single visit is one tap at the door and its comment is optional, so a manager who had
-- no time to write one had no way back in — the words he typed afterwards were lost, and a comment
-- missing from a visit on 19 Oct 2026 had to be written into the row by hand. The door comment stays as
-- recorded and is never edited; this is the SECOND, longer account, the same shape the rep already has
-- (`detail_comment` / `detail_edited_at` on phoenix_crm_visits, owner 2026-10-15).
--
-- ROLLBACK:
--   alter table public.phoenix_crm_manager_visits
--     drop column if exists detail_comment,
--     drop column if exists detail_edited_at;
-- That drop loses every write-up typed in the meantime, so it is a last resort, not an undo.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.phoenix_crm_manager_visits
  add column if not exists detail_comment text,
  add column if not exists detail_edited_at timestamptz;

comment on column public.phoenix_crm_manager_visits.detail_comment is
  'The longer account the manager writes up after logging the visit. The door comment stays in `comment` and is never edited here.';
comment on column public.phoenix_crm_manager_visits.detail_edited_at is
  'When the write-up was last saved, for the "Edited" line on his own card. Null until he writes one.';

commit;
