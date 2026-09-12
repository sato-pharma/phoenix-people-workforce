-- Attachments and body pictures for the Sato Email Composer.
--
-- Owner 2026-09-12: "make an option to attach pic or file and to put pic in message body".
--
-- 🔴 WHY A BODY PICTURE NEEDS A PUBLICLY FETCHABLE ADDRESS, AND AN ATTACHMENT DOES NOT.
-- An attachment travels inside the message: the bytes are read once, at send time, with the
-- service-role client, and nothing outside this system ever asks for them again. A picture in the
-- body does not travel — the recipient's mail app fetches it over plain HTTP when they open the
-- mail, which can be days later, from a machine with no Phoenix session. A signed URL is therefore
-- the wrong tool: it expires, and the picture turns into a broken box in an email the company
-- already sent. So a body picture gets a permanent, unguessable, token-addressed URL, and the
-- sender is told that anyone holding that link can see the picture. That is not a new exposure
-- shape for this screen — the Sato masthead and band in every one of these emails are already
-- fetched from this app without authentication.
--
-- The bucket stays PRIVATE all the same. Nothing is reachable by naming a storage path; the only
-- door is the token route, which resolves bucket and path from the row and refuses any row that is
-- not an inline picture. That is the rule the marketing share-file route states in its own header,
-- and it is the reason an attachment row carries no token at all: an attached payslip or contract
-- has no public address to guess.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'sato-email-media',
      'sato-email-media',
      false,
      -- 10MB per object. Not a guess: Brevo, the backup provider, rejects a message over 10MB
      -- outright, so a file above this would send through Resend and then fail the moment mail
      -- fails over — a bug that only appears on the bad day. One ceiling, both providers.
      10485760,
      -- No SVG and no HTML, deliberately. Both can carry script, and both would be served from
      -- this app's own origin by the token route below. The list is what a company announcement
      -- actually carries: pictures, a PDF, an Office document, a plain sheet.
      array[
        'image/jpeg', 'image/png', 'image/gif', 'image/webp',
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
        'text/csv', 'text/plain'
      ]
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists sato_email_media_service_role on storage.objects';
    execute $policy$
      create policy sato_email_media_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'sato-email-media')
      with check (bucket_id = 'sato-email-media')
    $policy$;
  end if;
end $$;

create table if not exists public.sato_email_media (
  id uuid primary key default gen_random_uuid(),
  -- 'inline' is a picture placed in the message body; 'attachment' rides along with the mail.
  kind text not null check (kind in ('inline', 'attachment')),
  -- Only an inline picture has one, and it is the ONLY way that object can ever be read from
  -- outside. An attachment row is null here, which is what makes it unreachable by guessing.
  public_token text unique,
  storage_bucket text not null default 'sato-email-media',
  storage_path text not null,
  content_type text not null,
  original_file_name text not null,
  byte_size integer not null check (byte_size > 0),
  uploaded_by_login_id text,
  uploaded_by_hr_id text,
  created_at timestamptz not null default now(),
  constraint sato_email_media_inline_has_token
    check ((kind = 'inline') = (public_token is not null))
);

comment on table public.sato_email_media is
  'Files uploaded in the Sato Email Composer. kind=''attachment'' rides inside the message and has no public address; kind=''inline'' is a body picture served by /api/sato-email/media/:token, which is the only door into the private sato-email-media bucket.';

create index if not exists sato_email_media_created_at_idx on public.sato_email_media (created_at desc);

alter table public.sato_email_media enable row level security;

create policy phx_sato_email_media_service_role on public.sato_email_media
  for all
  to service_role
  using (true)
  with check (true);

grant all on table public.sato_email_media to service_role;

notify pgrst, 'reload schema';
