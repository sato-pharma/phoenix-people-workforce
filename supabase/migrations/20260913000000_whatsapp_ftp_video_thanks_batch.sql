-- One thank-you per Future Talents video BATCH, sent after the videos.
--
-- Owner 2026-09-13: thank an intern after their videos, not before. whatsapp_ftp_video_thanks
-- (20260912230000) allowed one reply per sender per Cairo day and the webhook sent it on the first
-- message — usually the intern's submission ID — so the reply came before any video. The inbound-intake
-- cron now waits until a sender with an unanswered video has been quiet for three minutes, and claims
-- that batch here, keyed by its last message, before sending. The per-day table is kept as history and
-- is still read as "already thanked".
--
-- NOT RECRUITMENT DATA, like whatsapp_inbound_video and whatsapp_inbound_submission_id beside it.

create table if not exists public.whatsapp_ftp_video_thanks_batch (
  -- The sender, digits only, as whatsapp_inbound_video.wa_id records it.
  wa_id text not null,
  -- The batch's last video or submission-id message. One batch, one row, one thank-you.
  triggered_by_wamid text not null,
  -- The Egyptian calendar day the claim was made on, for reading the table by eye.
  cairo_day date not null,
  -- Whether Meta accepted the send. Null in the moment between claim and send, and on the backfill.
  sent_ok boolean,
  created_at timestamptz not null default now(),
  primary key (wa_id, triggered_by_wamid)
);

comment on table public.whatsapp_ftp_video_thanks_batch is
  'One "Thanks, well received. Good luck!" per Future Talents video batch, sent after the sender goes quiet; the primary key is the once-only guard. Not recruitment data.';

alter table public.whatsapp_ftp_video_thanks_batch enable row level security;

-- Server-side only. Supabase's default privileges hand every new relation to anon and authenticated;
-- neither has any business reading a phone number here.
revoke all on table public.whatsapp_ftp_video_thanks_batch from anon, authenticated;

create policy phx_whatsapp_ftp_video_thanks_batch_service_role on public.whatsapp_ftp_video_thanks_batch
  for all
  to service_role
  using (true)
  with check (true);

grant all on table public.whatsapp_ftp_video_thanks_batch to service_role;

-- Everything received before this file is answered already: on 13 Sep 2026 every sender was thanked
-- by the webhook, and the twelve whose thank-you came before their videos were thanked again by the
-- owner's one-off send. Without this row the cron would read their earlier videos as a fresh batch and
-- thank them a third time. On a database with no inbound rows it inserts nothing.
insert into public.whatsapp_ftp_video_thanks_batch (wa_id, triggered_by_wamid, cairo_day, sent_ok)
select distinct on (m.wa_id) m.wa_id, m.wamid, (now() at time zone 'Africa/Cairo')::date, null
  from (
    select wa_id, wamid, received_at from public.whatsapp_inbound_video where received_at > now() - interval '23 hours'
    union all
    select wa_id, wamid, received_at from public.whatsapp_inbound_submission_id where received_at > now() - interval '23 hours'
  ) m
 order by m.wa_id, m.received_at desc
on conflict do nothing;

notify pgrst, 'reload schema';

-- Verification — run after applying. Expected:
--   whatsapp_ftp_video_thanks_batch  rls_enabled = true, policies = 1
--   anon_select = false, authenticated_select = false

-- select c.relname, c.relrowsecurity as rls_enabled,
--        (select count(*) from pg_policy p where p.polrelid = c.oid) as policies,
--        has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
--        has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_select
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace
--  where n.nspname = 'public' and c.relname = 'whatsapp_ftp_video_thanks_batch';
