-- offer_email_message_and_revisions
--
-- WHAT THIS CHANGES:
--   public.offers gains five columns:
--     email_message    — HR's own words for the candidate, printed at the top of the offer EMAIL body
--                        (never on the PDF letter). Null = no message, which is every offer before this.
--     revision         — 0 for the offer as first issued; 1, 2, ... once HR issues an updated offer.
--     revision_history — every earlier version that went out, frozen when an update starts: its terms,
--                        its letter snapshot, who sent and approved it, and when. Newest last.
--     revised_at / revised_by — when the current update was started, and who started it.
-- WHY:
--   Owner, 2026-11-10: "add a field for the HR to write whatever he wants and this goes in the job
--   offer email body ... also make an option for the updated job offer, i may need to update a job
--   offer". An updated offer is the SAME row (same reference, same seat, same candidate link), sent
--   again through the same approval gate; the version it replaces is kept here, never overwritten.
-- ROLLBACK:
--   alter table public.offers drop column email_message, drop column revision,
--     drop column revision_history, drop column revised_at, drop column revised_by;
--   Additive only: no existing row changes (revision defaults to 0, history to an empty list).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.offers
  add column if not exists email_message text,
  add column if not exists revision integer not null default 0,
  add column if not exists revision_history jsonb not null default '[]'::jsonb,
  add column if not exists revised_at timestamptz,
  add column if not exists revised_by text;

alter table public.offers drop constraint if exists offers_revision_not_negative;
alter table public.offers
  add constraint offers_revision_not_negative check (revision >= 0);

alter table public.offers drop constraint if exists offers_email_message_length;
alter table public.offers
  add constraint offers_email_message_length check (email_message is null or char_length(email_message) <= 4000);

commit;
