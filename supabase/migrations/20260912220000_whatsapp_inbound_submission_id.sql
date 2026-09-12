-- The submission ids Future Talents interns send next to their closing videos.
--
-- Owner 2026-09-12: every intern who sends a closing video to the HR handset sends their submission
-- id ("FTP-" and eight digits) as a message after it. The portal matches a chat to an intern by the
-- phone number first; an intern who sent from a second phone is on nobody's profile, and the id they
-- typed is the one thing that says who they are. So it is kept, next to the videos, for the portal.
--
-- 🔴 WHAT HAPPENED TO THAT MESSAGE BEFORE THIS FILE. A text with no document is a text-only message
-- to the recruitment webhook: buffered, then handleTextOnlyMessage — which, for a sender with no CV on
-- file, replies "please send your CV as a file" and tells Talent Acquisition an applicant wrote in.
-- The webhook now takes a message carrying an id out of that path before any of it runs.
--
-- NOT RECRUITMENT DATA, for the same reasons as whatsapp_inbound_video: no row here is a candidate,
-- no ATS screen reads it, and its one consumer is the FTP Portal through /api/integrations/ftp-videos.

create table if not exists public.whatsapp_inbound_submission_id (
  id uuid primary key default gen_random_uuid(),
  -- Meta's message id; UNIQUE makes a redelivery capture once.
  wamid text not null unique,
  -- The sender, digits only, exactly as whatsapp_inbound_video.wa_id records it — that equality is
  -- how the portal puts an id next to a chat's videos.
  wa_id text not null,
  contact_name text,
  delivered_to_phone_number_id text,
  delivered_to_display_number text,
  -- Every distinct id in the message, canonical "FTP-12345678". An array because a message can name
  -- two, and choosing one of them here would be a guess the portal is better placed to refuse.
  submission_ids text[] not null
    constraint whatsapp_inbound_submission_id_shape
    check (
      cardinality(submission_ids) between 1 and 10
      and array_to_string(submission_ids, ',') ~ '^FTP-[0-9]{8}(,FTP-[0-9]{8})*$'
    ),
  sent_at timestamptz,
  received_at timestamptz not null default now(),
  historical boolean not null default false
);

comment on table public.whatsapp_inbound_submission_id is
  'Future Talents submission ids sent on WhatsApp, held for the FTP Portal to match a chat''s videos to an intern. Not recruitment data: no row here is a candidate, and no ATS screen reads it.';

-- The portal's query: the ids a set of senders has sent.
create index if not exists whatsapp_inbound_submission_id_sender_idx
  on public.whatsapp_inbound_submission_id (wa_id, sent_at desc);

alter table public.whatsapp_inbound_submission_id enable row level security;

-- Server-side only. Supabase's default privileges hand every new relation to anon and authenticated;
-- neither has any business reading a phone number here.
revoke all on table public.whatsapp_inbound_submission_id from anon, authenticated;

create policy phx_whatsapp_inbound_submission_id_service_role on public.whatsapp_inbound_submission_id
  for all
  to service_role
  using (true)
  with check (true);

grant all on table public.whatsapp_inbound_submission_id to service_role;

notify pgrst, 'reload schema';

-- Verification — run after applying. Expected:
--   whatsapp_inbound_submission_id  rls_enabled = true, policies = 1
--   anon_select = false, authenticated_select = false

-- select c.relname, c.relrowsecurity as rls_enabled,
--        (select count(*) from pg_policy p where p.polrelid = c.oid) as policies,
--        has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
--        has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_select
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace
--  where n.nspname = 'public' and c.relname = 'whatsapp_inbound_submission_id';
