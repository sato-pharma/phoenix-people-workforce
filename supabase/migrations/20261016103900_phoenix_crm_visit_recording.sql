-- phoenix_crm_visit_recording
--
-- WHAT THIS CHANGES:
--   * A new table public.phoenix_crm_recording_required — the reps the Super Admin has switched on. A row
--     present means that rep must record each visit before he can log it; no row means nothing changes.
--   * A new table public.phoenix_crm_visit_recordings — the upload-slot ledger for visit recordings, the
--     visit each one belongs to once claimed, its length and size, and who deleted it and when.
--   * A new private bucket 'phoenix-crm-recordings', 16 MB, the four containers a browser records.
--   * A new function public.phoenix_crm_claim_visit_recording(...), returning the stored size in bytes.
-- WHY:
--   Owner, 2026-10-16: some reps — the ones he chooses, never everyone — must open a voice recorder before
--   they log a visit, so the conversation with the doctor or the pharmacist is recorded; only then can
--   the visit be logged. His answers the same day: no consent tick in the app, doctor AND pharmacy
--   visits, at most 15 minutes, at least 30 seconds, a blocked microphone blocks the visit, he and the
--   SFE managers and the rep's own managers above him may listen, and the Super Admin downloads and
--   deletes any recording at any time — nothing is deleted automatically.
--
--   It is NOT the voice note (20260925030047). That is the rep's own spoken comment, optional, a minute
--   long, in its own table and bucket. This is the conversation itself, required for the reps on the
--   list, and it lives in its own table and bucket for the same reason the voice note does not share
--   the photo's: every reader of a table reads it as ONE kind of evidence.
--
--   NO DATING AUTHORITY, AS WITH THE VOICE NOTE. The claim returns the object's size, never a time, and
--   it runs BEFORE phoenix_crm_save_visit — so nothing it does can reach the visit's date, which the
--   save still takes from its own clock.
--
--   The claim is idempotent for one visit id: a save sent again after a dropped connection claims the
--   same recording for the same visit and changes nothing. A claim left behind by a save that then
--   failed (the visit row never written) gives way to the next attempt, so a rep is never refused his
--   own recording because a first press did not land.
-- ROLLBACK:
--   drop function if exists public.phoenix_crm_claim_visit_recording(text, text, text, boolean, uuid, integer);
--   drop table if exists public.phoenix_crm_visit_recordings;
--   drop table if exists public.phoenix_crm_recording_required;
--   The bucket and its objects survive a rollback and are removed through the Storage API, never by a
--   delete on storage.objects (storage.protect_delete refuses it). Dropping the tables discards which
--   recording belongs to which visit and who must record.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: two new tables, one new bucket and one new function. Nothing existing is altered.
--
-- READBACK (reads only):
--   select
--     (select count(*) from pg_class where relname in ('phoenix_crm_recording_required', 'phoenix_crm_visit_recordings')
--       and relrowsecurity) as locked_tables,
--     (select pg_get_function_result(oid) from pg_proc
--       where proname = 'phoenix_crm_claim_visit_recording' and pronamespace = 'public'::regnamespace) as claim_returns,
--     (select file_size_limit from storage.buckets where id = 'phoenix-crm-recordings') as bucket_limit;
--   locked_tables 2, claim_returns "bigint", bucket_limit 16777216.

begin;
set local lock_timeout = '5s';

-- === 1. Who must record ==========================================================================
-- Keyed by the PERSON, upper-cased as every Phoenix CRM hr id is stored: the owner switches a rep, not
-- a territory, and a rep who moves seat keeps his switch.

create table if not exists public.phoenix_crm_recording_required (
  hr_id text primary key,
  set_by_hr_id text not null,
  set_at timestamptz not null default now(),
  constraint phoenix_crm_recording_required_hr_id check (char_length(hr_id) between 1 and 40)
);

alter table public.phoenix_crm_recording_required enable row level security;
drop policy if exists phoenix_crm_recording_required_service_role on public.phoenix_crm_recording_required;
create policy phoenix_crm_recording_required_service_role
  on public.phoenix_crm_recording_required for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_recording_required from public, anon, authenticated;
grant all on table public.phoenix_crm_recording_required to service_role;

-- === 2. The recordings ===========================================================================
-- One row per slot issued. `visit_id` is set by the claim and is unique, so one recording belongs to one
-- visit and one visit carries one recording. There is no foreign key to the visits on purpose: the claim
-- runs BEFORE the save writes the visit, under the same client-made id.

create table if not exists public.phoenix_crm_visit_recordings (
  path text primary key,
  issued_to_hr_id text not null,
  seat_id text not null,
  is_test boolean not null default false,
  issued_at timestamptz not null default now(),
  visit_id uuid,
  claimed_at timestamptz,
  seconds integer,
  bytes bigint,
  deleted_at timestamptz,
  deleted_by_hr_id text,
  constraint phoenix_crm_visit_recordings_path check (char_length(path) between 10 and 200),
  constraint phoenix_crm_visit_recordings_seconds check (seconds is null or seconds between 1 and 960),
  constraint phoenix_crm_visit_recordings_bytes check (bytes is null or bytes between 1 and 16777216),
  constraint phoenix_crm_visit_recordings_deleted check ((deleted_at is null) = (deleted_by_hr_id is null))
);

create unique index if not exists phoenix_crm_visit_recordings_visit_uidx
  on public.phoenix_crm_visit_recordings (visit_id)
  where visit_id is not null;
create index if not exists phoenix_crm_visit_recordings_person_idx
  on public.phoenix_crm_visit_recordings (issued_to_hr_id, issued_at desc);
create index if not exists phoenix_crm_visit_recordings_issued_idx
  on public.phoenix_crm_visit_recordings (issued_at desc);

alter table public.phoenix_crm_visit_recordings enable row level security;
drop policy if exists phoenix_crm_visit_recordings_service_role on public.phoenix_crm_visit_recordings;
create policy phoenix_crm_visit_recordings_service_role
  on public.phoenix_crm_visit_recordings for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_visit_recordings from public, anon, authenticated;
grant all on table public.phoenix_crm_visit_recordings to service_role;

-- === 3. The bucket (private, audio only, 16 MB) ==================================================
-- Fifteen minutes of mono Opus at 24 kbps is about 2.7 MB; Safari records AAC and may ignore the asked
-- bitrate, which at 64 kbps is about 7.2 MB. 16 MB holds both with room, and the claim re-reads the
-- stored size rather than trusting the phone's.

do $bucket$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'phoenix-crm-recordings',
      'phoenix-crm-recordings',
      false,
      16777216,
      array['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg']
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists phoenix_crm_recordings_service_role on storage.objects';
    execute $policy$
      create policy phoenix_crm_recordings_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'phoenix-crm-recordings')
      with check (bucket_id = 'phoenix-crm-recordings')
    $policy$;
  end if;
end
$bucket$;

-- === 4. Claiming a recording for a visit =========================================================
-- Refuses a path not issued to this person for this territory and world, one deleted, one already on
-- ANOTHER saved visit, one older than six hours, a length outside 30 seconds to 16 minutes, and one
-- whose object never arrived. Returns the size the bucket actually holds.

create or replace function public.phoenix_crm_claim_visit_recording(
  p_path text,
  p_hr_id text,
  p_seat_id text,
  p_is_test boolean,
  p_visit_id uuid,
  p_seconds integer
)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_slot public.phoenix_crm_visit_recordings%rowtype;
  v_bytes bigint;
  v_visit_saved boolean;
begin
  if p_visit_id is null then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select r.* into v_slot
  from public.phoenix_crm_visit_recordings r
  where r.path = p_path
  for update;

  if not found
    or v_slot.issued_to_hr_id <> upper(trim(p_hr_id))
    or v_slot.seat_id <> p_seat_id
    or v_slot.is_test <> p_is_test then
    raise exception 'phoenix_crm:recording_not_issued';
  end if;
  if v_slot.deleted_at is not null then
    raise exception 'phoenix_crm:recording_missing';
  end if;
  if v_slot.visit_id is not null and v_slot.visit_id <> p_visit_id
    and exists (select 1 from public.phoenix_crm_visits v where v.id = v_slot.visit_id) then
    raise exception 'phoenix_crm:recording_used';
  end if;
  if v_slot.issued_at < now() - interval '6 hours' then
    raise exception 'phoenix_crm:recording_expired';
  end if;
  if p_seconds is null or p_seconds < 30 then
    raise exception 'phoenix_crm:recording_too_short';
  end if;
  if p_seconds > 960 then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select coalesce((o.metadata ->> 'size')::bigint, 0) into v_bytes
  from storage.objects o
  where o.bucket_id = 'phoenix-crm-recordings' and o.name = p_path;
  if not found or v_bytes < 1 then
    raise exception 'phoenix_crm:recording_missing';
  end if;

  v_visit_saved := exists (select 1 from public.phoenix_crm_visits v where v.id = p_visit_id);
  if v_visit_saved then
    -- The visit is already written: this is a save sent again. Only its own recording may stand on it.
    if exists (
      select 1 from public.phoenix_crm_visit_recordings r where r.visit_id = p_visit_id and r.path <> p_path
    ) then
      raise exception 'phoenix_crm:recording_used';
    end if;
  else
    -- A claim left by an earlier press whose visit was never written gives way.
    update public.phoenix_crm_visit_recordings r
    set visit_id = null, claimed_at = null
    where r.visit_id = p_visit_id and r.path <> p_path;
  end if;

  update public.phoenix_crm_visit_recordings r
  set visit_id = p_visit_id,
      claimed_at = coalesce(r.claimed_at, now()),
      seconds = p_seconds,
      bytes = least(v_bytes, 16777216)
  where r.path = p_path;

  return v_bytes;
end;
$$;

revoke execute on function public.phoenix_crm_claim_visit_recording(text, text, text, boolean, uuid, integer) from public, anon, authenticated;
grant execute on function public.phoenix_crm_claim_visit_recording(text, text, text, boolean, uuid, integer) to service_role;

notify pgrst, 'reload schema';

commit;
