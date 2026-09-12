-- An inbox for VIDEOS that arrive on WhatsApp, so linking the HR handset stops throwing them away.
--
-- Owner 2026-09-12: the closing videos for the Future Talents programme were sent to the advertised
-- HR handset (01159888247) as WhatsApp messages. That handset is not linked to the Cloud API yet;
-- once it is, Meta replays its past conversations on the `history` webhook field, which this repo
-- already parses. What it does NOT do is keep a video.
--
-- 🔴 WHAT HAPPENS TODAY, AND WHY IT IS TWO SEPARATE LOSSES.
-- A CV is a `document` or an `image`. A video is neither, so `message.document` is null and the
-- webhook falls through to the text-only-applicant branch. There:
--   * a REPLAYED video hits `decideTextOnlyAction`'s `historical` rung, which returns NOTHING —
--     no record, no event, no trace. The whole backlog would be acknowledged 200 OK and vanish,
--     which is precisely the failure the `history` envelope work was written to prevent, one
--     message type over.
--   * a LIVE video hits `new_contact` instead, so the sender is answered "please send your CV as a
--     file" and Talent Acquisition is notified. The senders here are the company's own interns.
--     Asking twenty-nine of them for a CV, one message each, is a worse outcome than losing the
--     file.
-- Both stop once the webhook has somewhere to put a video, which is what this table is.
--
-- A video sent AS A DOCUMENT is the same message to a human and a different message to Meta — the
-- node is `document` with `mime_type: video/mp4` and a filename. That shape reaches the CV queue
-- today and would be extracted as a curriculum vitae. The parser now routes on the MIME type, not
-- on the node name, so both shapes land here and neither becomes a candidate.
--
-- WHY THE BYTES ARE FETCHED RATHER THAN THE MEDIA ID KEPT.
-- A media id is only redeemable while Meta still holds the file, and the replay hands out ids for
-- messages that are already weeks old. Retention is finite and not something this app controls, so
-- the id is worth exactly as long as it takes to spend it. `storage_path` filled is the only state
-- that means the video is safe; `media_id` alone is a claim with an expiry nobody can read.
--
-- WHY THIS IS NOT RECRUITMENT DATA.
-- Nothing here is a candidate, an application or an ATS row, and no recruitment screen reads this
-- table. It is a holding area with one consumer: the FTP Portal, a separate application on a
-- separate Supabase project, which claims each video and scores it. `handed_off_at` is that
-- handshake and is written by nothing in this repository yet — it exists now so the portal side
-- does not need a second migration against a live table.

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'whatsapp-videos',
      'whatsapp-videos',
      false,
      -- 100MB, which is WhatsApp's own ceiling for a DOCUMENT. A message sent as `type: video` is
      -- capped at 16MB by WhatsApp before it ever reaches us, so the headroom above that only
      -- matters for the interns who sent their video as a file to dodge the compression.
      104857600,
      -- What WhatsApp actually delivers for a video, plus the container types a phone produces when
      -- the same file is attached as a document. No image and no application/* — a row in this
      -- table is a video by definition, and a bucket that accepts a PDF is a bucket that will one
      -- day hold a CV nobody meant to put here.
      array['video/mp4', 'video/3gpp', 'video/quicktime', 'video/x-matroska', 'video/webm']
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists whatsapp_videos_service_role on storage.objects';
    execute $policy$
      create policy whatsapp_videos_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'whatsapp-videos')
      with check (bucket_id = 'whatsapp-videos')
    $policy$;
  end if;
end $$;

create table if not exists public.whatsapp_inbound_video (
  id uuid primary key default gen_random_uuid(),
  -- Meta's own message id. UNIQUE is the whole idempotency story: the webhook returns non-200 on
  -- nothing, but Meta still retries a delivery it thinks failed, and a coexistence replay can
  -- overlap a live message. Capturing twice must produce one row.
  wamid text not null unique,
  -- The sender, digits-only in Meta's convention (e.g. 201001234567). Deliberately NOT resolved to
  -- a person here: the people who sent these are interns in another application's roster, and this
  -- repository has no business holding an opinion about who they are.
  wa_id text not null,
  -- The sender's own WhatsApp profile name, as they set it. A hint for the human doing the
  -- matching, never an identity.
  contact_name text,
  -- Which business line the message was delivered TO. The point of recording it: the Cloud API
  -- number and the HR handset both feed this webhook once coexistence is live, and only this tells
  -- them apart.
  delivered_to_phone_number_id text,
  delivered_to_display_number text,
  media_id text not null,
  mime_type text not null,
  -- Present only when the video arrived as a document; a `type: video` node carries no filename.
  file_name text,
  caption text,
  -- When the sender sent it, from Meta's message timestamp — NOT when we received it. For a replay
  -- these are weeks apart, and it is the first one that says which video is which.
  sent_at timestamptz,
  received_at timestamptz not null default now(),
  -- True when this came from a coexistence history replay rather than arriving live. Kept for the
  -- same reason `historyImport` is kept on an intake event: a replay is not an arrival, and a
  -- report that counts it as one describes a channel that was shut.
  historical boolean not null default false,
  -- Filled once the bytes are safely in the bucket. Null means the file still exists only inside
  -- Meta, on a media id that will expire.
  storage_path text,
  byte_size bigint check (byte_size is null or byte_size > 0),
  fetched_at timestamptz,
  -- Why the fetch is being retried, and how often it has failed. An expired media id is terminal
  -- and will read as a permanent error here; that is information, not a bug to retry forever.
  fetch_attempts integer not null default 0 check (fetch_attempts >= 0),
  fetch_error text,
  -- Written by the consuming application when it has taken its own copy. Nothing in THIS repo sets
  -- it; see the header.
  handed_off_at timestamptz,
  constraint whatsapp_inbound_video_fetched_has_path
    check ((fetched_at is null) = (storage_path is null))
);

comment on table public.whatsapp_inbound_video is
  'Videos received on WhatsApp, held for the Future Talents Portal to claim. Not recruitment data: no row here is a candidate, and no ATS screen reads it. storage_path filled means the bytes are safe in the whatsapp-videos bucket; null means they still exist only against a media id that expires.';

-- The fetch worker's query: unfetched first, oldest first, so a backlog drains in the order it
-- arrived rather than newest-first.
create index if not exists whatsapp_inbound_video_pending_idx
  on public.whatsapp_inbound_video (received_at)
  where storage_path is null;

-- The consumer's query: everything safe and not yet taken.
create index if not exists whatsapp_inbound_video_unclaimed_idx
  on public.whatsapp_inbound_video (sent_at)
  where storage_path is not null and handed_off_at is null;

create index if not exists whatsapp_inbound_video_sender_idx
  on public.whatsapp_inbound_video (wa_id, sent_at desc);

alter table public.whatsapp_inbound_video enable row level security;

create policy phx_whatsapp_inbound_video_service_role on public.whatsapp_inbound_video
  for all
  to service_role
  using (true)
  with check (true);

grant all on table public.whatsapp_inbound_video to service_role;

notify pgrst, 'reload schema';

-- Verification — run after applying. Expected:
--   whatsapp_inbound_video  rls_enabled = true, policies = 1
--   bucket whatsapp-videos  public = false, file_size_limit = 104857600
--   rows = 0 (nothing captures until the handset is linked)

-- select c.relname, c.relrowsecurity as rls_enabled,
--        (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace
--  where n.nspname = 'public' and c.relname = 'whatsapp_inbound_video';
-- select id, public, file_size_limit from storage.buckets where id = 'whatsapp-videos';
-- select count(*) from public.whatsapp_inbound_video;
