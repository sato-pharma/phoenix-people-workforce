-- One thank-you per Future Talents intern per Cairo day.
--
-- Owner 2026-09-12: when an intern sends their closing videos to the HR handset, answer them
-- "Thanks, well received. Good luck!". It is the one message Phoenix writes to an intern, and it must
-- go once — not once per video.
--
-- 🔴 ONCE IS A ROW, NOT A READ. Six videos arrive as six near-simultaneous webhook deliveries, so
-- "was one sent today?" asked by each of them races and thanks the intern six times. The webhook
-- claims the day by inserting here first and sends only when its insert won; the primary key is what
-- makes exactly one delivery win.
--
-- NOT RECRUITMENT DATA, like whatsapp_inbound_video and whatsapp_inbound_submission_id beside it.

create table if not exists public.whatsapp_ftp_video_thanks (
  -- The sender, digits only, as whatsapp_inbound_video.wa_id records it.
  wa_id text not null,
  -- The Egyptian calendar day the thank-you belongs to (Africa/Cairo), computed by the webhook.
  cairo_day date not null,
  -- The new video or submission-id message that claimed the day.
  triggered_by_wamid text not null,
  -- Whether Meta accepted the send. Null only in the moment between the claim and the send.
  sent_ok boolean,
  created_at timestamptz not null default now(),
  primary key (wa_id, cairo_day)
);

comment on table public.whatsapp_ftp_video_thanks is
  'One "Thanks, well received. Good luck!" per Future Talents video sender per Cairo day; the primary key is the once-only guard. Not recruitment data.';

alter table public.whatsapp_ftp_video_thanks enable row level security;

-- Server-side only. Supabase's default privileges hand every new relation to anon and authenticated;
-- neither has any business reading a phone number here.
revoke all on table public.whatsapp_ftp_video_thanks from anon, authenticated;

create policy phx_whatsapp_ftp_video_thanks_service_role on public.whatsapp_ftp_video_thanks
  for all
  to service_role
  using (true)
  with check (true);

grant all on table public.whatsapp_ftp_video_thanks to service_role;

notify pgrst, 'reload schema';

-- Verification — run after applying. Expected:
--   whatsapp_ftp_video_thanks  rls_enabled = true, policies = 1
--   anon_select = false, authenticated_select = false

-- select c.relname, c.relrowsecurity as rls_enabled,
--        (select count(*) from pg_policy p where p.polrelid = c.oid) as policies,
--        has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
--        has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_select
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace
--  where n.nspname = 'public' and c.relname = 'whatsapp_ftp_video_thanks';
