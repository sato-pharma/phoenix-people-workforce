-- tablet_screen_recordings
--
-- WHAT THIS CHANGES:
--   * A new table public.device_screen_recordings — the upload-slot ledger for on-demand screen
--     recordings of a rep tablet: which tablet, who asked for it, the length asked for, the length and
--     size that actually arrived, where the file sits, and a single-use upload token's hash.
--   * A new private bucket 'device-screen-recordings', 256 MB, mp4/webm only — a short screen capture.
-- WHY:
--   Owner, 2026-10-22: the Tablet Dashboard protects the company tablets, and after live view/control
--   he asked for screen RECORDING too, on-demand into Phoenix — the Super Admin presses Record on one
--   tablet, its launcher captures the screen for a set length and uploads it here, and he plays it back
--   in the dashboard any time, with nobody watching live. Calls and messages are never recorded (they
--   never existed in this stack).
--
--   WHY A NEW TABLE AND BUCKET OF ITS OWN, like the CRM visit recording (20261016103900): every reader
--   of a table reads it as ONE kind of evidence, and a tablet screen capture is not a CRM visit's
--   voice, a dispute photo or a direct-order invoice. It lives apart so no reader blends them.
--
--   THE UPLOAD IS AUTHENTICATED BY A PER-RECORDING TOKEN, NOT A SHARED SECRET. Each request mints a
--   random token, stores only its SHA-256 here, and sends the plaintext to the one tablet in the push
--   payload. The upload endpoint matches the token against this hash, once (the hash is cleared when
--   the file lands), inside a short window. No long-lived secret ever travels to a device, whose
--   Headwind configuration is world-readable; the worst a leaked token buys is one capture slot, for
--   minutes. The ingest re-reads the stored object's real size rather than trusting the tablet's.
-- ROLLBACK:
--   drop table if exists public.device_screen_recordings;
--   The bucket and its objects survive a rollback and are removed through the Storage API, never by a
--   delete on storage.objects (storage.protect_delete refuses it). Dropping the table discards which
--   capture belongs to which tablet.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: one new table and one new bucket. Nothing existing is altered.
--
-- READBACK (reads only):
--   select
--     (select count(*) from pg_class where relname = 'device_screen_recordings' and relrowsecurity) as locked_table,
--     (select file_size_limit from storage.buckets where id = 'device-screen-recordings') as bucket_limit;
--   locked_table 1, bucket_limit 268435456.

begin;
set local lock_timeout = '5s';

-- === The recordings =============================================================================
-- One row per capture slot issued. The id is minted by Phoenix before the push, because the storage
-- path and the push payload both name it, so it is NOT defaulted here. `upload_token_hash` is null
-- once the file lands (single use) or when the slot is refused.

create table if not exists public.device_screen_recordings (
  id uuid primary key,
  device_number text not null,
  asset_tag text,
  requested_by_hr_id text not null,
  status text not null default 'requested',
  requested_at timestamptz not null default now(),
  duration_requested_s integer not null,
  captured_seconds integer,
  size_bytes bigint,
  storage_path text not null,
  upload_token_hash text,
  uploaded_at timestamptz,
  error text,
  constraint device_screen_recordings_status check (status in ('requested', 'ready', 'failed', 'expired')),
  constraint device_screen_recordings_device check (char_length(device_number) between 1 and 80),
  constraint device_screen_recordings_duration check (duration_requested_s between 5 and 300),
  constraint device_screen_recordings_captured check (captured_seconds is null or captured_seconds between 1 and 600),
  constraint device_screen_recordings_bytes check (size_bytes is null or size_bytes between 1 and 268435456),
  constraint device_screen_recordings_path check (char_length(storage_path) between 10 and 200)
);

create index if not exists device_screen_recordings_device_idx
  on public.device_screen_recordings (device_number, requested_at desc);
create index if not exists device_screen_recordings_requested_idx
  on public.device_screen_recordings (requested_at desc);

alter table public.device_screen_recordings enable row level security;
drop policy if exists device_screen_recordings_service_role on public.device_screen_recordings;
create policy device_screen_recordings_service_role
  on public.device_screen_recordings for all to service_role using (true) with check (true);
revoke all on table public.device_screen_recordings from public, anon, authenticated;
grant all on table public.device_screen_recordings to service_role;

-- === The bucket (private, video only, 256 MB) ==================================================
-- A short MediaProjection capture of a tablet screen. H.264 mp4 at a tablet's resolution is a few MB
-- per minute; 256 MB holds the 5-minute cap with room, and the ingest re-reads the stored size.

do $bucket$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'device-screen-recordings',
      'device-screen-recordings',
      false,
      268435456,
      array['video/mp4', 'video/webm']
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists device_screen_recordings_service_role on storage.objects';
    execute $policy$
      create policy device_screen_recordings_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'device-screen-recordings')
      with check (bucket_id = 'device-screen-recordings')
    $policy$;
  end if;
end
$bucket$;

notify pgrst, 'reload schema';

commit;
