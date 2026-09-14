-- WhatsApp senders who use a USERNAME: keep their videos and submission ids under their business-scoped
-- user id when Meta sends no phone number.
--
-- 14 Sep 2026: a Future Talents intern with a WhatsApp username sent his closing videos and his
-- submission id to the HR line, and production held nothing from him. A user who enables a username
-- is identified by a business-scoped user id (BSUID, e.g. "EG.13491208655302741918"), sent as
-- `from_user_id` on the message and `user_id` on the contact; Meta OMITS `from` and `wa_id` unless the
-- business exchanged messages with that phone in the last 30 days or holds it as a contact. The parser
-- dropped every such message before anything was written. It now carries both identities, and these
-- two tables must accept a row with the BSUID and no phone.
--
-- WHAT CHANGES, PER TABLE.
--   * user_id  — the BSUID. Stored for EVERY sender Meta gives one for, phone or not, so a later
--                message that arrives without the phone still lands in the same chat for the portal.
--   * username — the sender's WhatsApp handle, as they set it. A hint for a human, never an identity.
--   * wa_id    — no longer NOT NULL. A row naming NOBODY is still refused: the new CHECK requires a
--                phone number or a BSUID. Every existing row has a wa_id, so it validates at once.
--
-- Additive and backward-compatible: the code already live writes wa_id on every row and never
-- mentions the new columns. Apply BEFORE the code that writes user_id is deployed.

alter table public.whatsapp_inbound_video add column if not exists user_id text;
alter table public.whatsapp_inbound_video add column if not exists username text;
alter table public.whatsapp_inbound_video
  alter column wa_id drop not null;
alter table public.whatsapp_inbound_video drop constraint if exists whatsapp_inbound_video_has_sender;
alter table public.whatsapp_inbound_video
  add constraint whatsapp_inbound_video_has_sender check (wa_id is not null or user_id is not null);

comment on column public.whatsapp_inbound_video.user_id is
  'The sender''s WhatsApp business-scoped user id (BSUID). The only identity of a sender who uses a username and whose phone number Meta did not send.';
comment on column public.whatsapp_inbound_video.username is
  'The sender''s WhatsApp username, as they set it. A hint for the person matching videos, never an identity.';

create index if not exists whatsapp_inbound_video_user_idx
  on public.whatsapp_inbound_video (user_id, sent_at desc)
  where user_id is not null;

alter table public.whatsapp_inbound_submission_id add column if not exists user_id text;
alter table public.whatsapp_inbound_submission_id add column if not exists username text;
alter table public.whatsapp_inbound_submission_id
  alter column wa_id drop not null;
alter table public.whatsapp_inbound_submission_id drop constraint if exists whatsapp_inbound_submission_id_has_sender;
alter table public.whatsapp_inbound_submission_id
  add constraint whatsapp_inbound_submission_id_has_sender check (wa_id is not null or user_id is not null);

comment on column public.whatsapp_inbound_submission_id.user_id is
  'The sender''s WhatsApp business-scoped user id (BSUID) — how the portal puts an id typed with no phone number next to the same sender''s videos.';
comment on column public.whatsapp_inbound_submission_id.username is
  'The sender''s WhatsApp username, as they set it. A hint, never an identity.';

create index if not exists whatsapp_inbound_submission_id_user_idx
  on public.whatsapp_inbound_submission_id (user_id, sent_at desc)
  where user_id is not null;

notify pgrst, 'reload schema';

-- Verification — run after applying. Expected, for both tables:
--   wa_id is_nullable = YES, user_id and username present, has_sender constraint present,
--   rows_without_sender = 0.

-- select table_name, column_name, is_nullable from information_schema.columns
--  where table_schema = 'public'
--    and table_name in ('whatsapp_inbound_video', 'whatsapp_inbound_submission_id')
--    and column_name in ('wa_id', 'user_id', 'username')
--  order by 1, 2;
-- select conrelid::regclass, conname, pg_get_constraintdef(oid) from pg_constraint
--  where conname in ('whatsapp_inbound_video_has_sender', 'whatsapp_inbound_submission_id_has_sender');
-- select
--   (select count(*) from public.whatsapp_inbound_video where wa_id is null and user_id is null) +
--   (select count(*) from public.whatsapp_inbound_submission_id where wa_id is null and user_id is null)
--   as rows_without_sender;
