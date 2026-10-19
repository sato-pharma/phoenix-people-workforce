-- phoenix_crm_place_note_advice
--
-- WHAT THIS CHANGES: public.phoenix_crm_place_notes gains `advice` — the verdict a System Administrator's
--   by-eye note closes on: approve · your_call · new_photo · reject. Nullable; a CHECK allows it only on a
--   `system_admin` note, so a district manager's comment never carries one (his own word is the separate
--   recommendation table). Then the by-eye notes already written are given the advice their own closing
--   sentence states ("Recommend approve." → approve, "Recommend reject" → reject, "Approve if" →
--   your_call, anything else → new_photo).
-- WHY: owner, 2026-10-19 — in the one-by-one review, show the by-eye advice as a coloured tag beside
--   Approve and Reject, and put the "approve" ones first in every tab, so he can go through them fast.
--   A column, not a reading of the note's words on every render: the order and the tag must not move
--   because a sentence was worded differently.
-- BACKFILL: only rows with author_source = 'system_admin', a body starting "By eye:" and advice still
--   null — 63 on production when written (39 approve, 21 new_photo, 2 reject, 1 your_call). Staging holds
--   none, so there it writes nothing. Re-running it changes nothing.
-- ROLLBACK:
--   alter table public.phoenix_crm_place_notes drop constraint if exists phoenix_crm_place_notes_advice_check;
--   alter table public.phoenix_crm_place_notes drop column if exists advice;
--   Additive only: no existing column changes, the note bodies are untouched, and the rep never reads it
--   (`loadRepVisiblePlaceNotes` names its columns, and these notes are rep_visible = false).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.phoenix_crm_place_notes
  add column if not exists advice text;

alter table public.phoenix_crm_place_notes
  drop constraint if exists phoenix_crm_place_notes_advice_check;

alter table public.phoenix_crm_place_notes
  add constraint phoenix_crm_place_notes_advice_check
  check (
    advice is null
    or (author_source = 'system_admin' and advice in ('approve', 'your_call', 'new_photo', 'reject'))
  );

comment on column public.phoenix_crm_place_notes.advice is
  'The verdict a System Administrator''s by-eye note closes on (approve, your_call, new_photo, reject). Shown as a tag beside the decision buttons in the one-by-one review; decides nothing.';

update public.phoenix_crm_place_notes
set advice = case
  when body ~* 'Recommend approve(\.|,)' then 'approve'
  when body ~* 'Recommend reject' then 'reject'
  when body ~* 'Approve if' then 'your_call'
  else 'new_photo'
end
where author_source = 'system_admin'
  and body like 'By eye:%'
  and advice is null;

commit;
