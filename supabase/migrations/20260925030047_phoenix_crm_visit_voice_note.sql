-- phoenix_crm_visit_voice_note
--
-- WHAT THIS CHANGES:
--   * A new table public.phoenix_crm_voice_uploads — the upload-slot ledger for voice notes, the same
--     shape as phoenix_crm_photo_uploads MINUS its 'purpose' column.
--   * A new private bucket 'phoenix-crm-voice', 2 MB, the four containers a browser actually records.
--   * A new function public.phoenix_crm_take_voice(...), returning VOID.
--   * Three additive columns on public.phoenix_crm_visits: voice_note_path / _seconds / _bytes, with
--     checks, and a unique index so one recording cannot be attached to two visits.
--   * A create-or-replace of public.phoenix_crm_save_visit(jsonb) that persists them. Its body is
--     carried over from 20260925021140_phoenix_crm_save_visit_allow_pending.sql MECHANICALLY, by a
--     script that throws unless each of its three anchors is found exactly once, so every line other
--     than those insertions is byte-identical to what production runs today.
-- WHY:
--   Owner, 2026-09-25: a rep standing outside a clinic can say in twenty seconds what he will not type
--   in two minutes, and in Egyptian Arabic the keyboard is the slow part. This keeps the AUDIO — no
--   speech service sees it and nothing transcribes it, which is the whole difference from the dictation
--   shipped the same night, where the audio goes to Google or Apple and what saves is text.
--
--   TWO RULES ARE HIS, AND BOTH ARE STRUCTURAL RATHER THAN WRITTEN DOWN:
--
--   1. ITS OWN TABLE. Widening phoenix_crm_photo_uploads.purpose to a third value costs one line and is
--      exactly what must not happen. Every reader of that table treats a row as evidence of PRESENCE,
--      and the strongest of them dates a visit by its issued_at. An audio row sitting in it is one
--      forgotten "where purpose =" away from being read as a photo.
--   2. NO DATING AUTHORITY. A photo is taken where the camera is; a recording can be made in a car an
--      hour later and nothing in the audio says otherwise. phoenix_crm_take_photo RETURNS the issue
--      time that becomes captured_at; phoenix_crm_take_voice returns VOID. There is no value to assign,
--      so the rule cannot be broken by a later edit that simply was not thinking about it.
--
--   The note is a convenience and never evidence: the columns are nullable, nothing requires one, and a
--   visit with no note is the normal case.
--
--   It does NOT restate save_visit's own revoke/grant, which its two predecessors both do. Replacing a
--   function keeps its ACL, so the pair is decoration — and the module's boundary test counts a function
--   as introduced once, so restating it here reads as granting the same function twice.
-- ROLLBACK:
--   drop index if exists phoenix_crm_visits_voice_uidx;
--   alter table public.phoenix_crm_visits
--     drop column if exists voice_note_bytes, drop column if exists voice_note_seconds,
--     drop column if exists voice_note_path;
--   drop function if exists public.phoenix_crm_take_voice(text, text, text, boolean);
--   drop table if exists public.phoenix_crm_voice_uploads;
--   then re-apply 20260925021140's body of phoenix_crm_save_visit(jsonb). Dropping the columns discards
--   any notes recorded meanwhile; the storage objects would survive in the bucket.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: one new table, one new bucket, one new function, three ADD COLUMN and one replace.
--
-- READBACK (reads only; run separately, since this module's migrations end at commit):
--   select
--     (select count(*) from information_schema.columns where table_schema = 'public'
--       and table_name = 'phoenix_crm_visits'
--       and column_name in ('voice_note_path','voice_note_seconds','voice_note_bytes')) as visit_columns,
--     (select pg_get_function_result(oid) from pg_proc
--       where proname = 'phoenix_crm_take_voice' and pronamespace = 'public'::regnamespace) as voice_returns,
--     (select pg_get_function_result(oid) from pg_proc
--       where proname = 'phoenix_crm_take_photo' and pronamespace = 'public'::regnamespace) as photo_returns,
--     (select allowed_mime_types from storage.buckets where id = 'phoenix-crm-voice') as voice_mime;
--   voice_returns must read "void" beside photo_returns' "timestamp with time zone" — that difference IS
--   rule 2 above, and it is the one line of the readback worth reading twice.

begin;
set local lock_timeout = '5s';

-- === 1. The slot ledger ==========================================================================
-- Deliberately without photo_uploads' 'purpose' column. A voice note only ever belongs to a visit, and
-- a purpose column is the seam that made widening the photo table look reasonable in the first place.

create table if not exists public.phoenix_crm_voice_uploads (
  path text primary key,
  issued_to_hr_id text not null,
  seat_id text not null,
  is_test boolean not null default false,
  issued_at timestamptz not null default now(),
  used_at timestamptz,
  constraint phoenix_crm_voice_uploads_path check (char_length(path) between 10 and 200)
);

create index if not exists phoenix_crm_voice_uploads_person_idx
  on public.phoenix_crm_voice_uploads (issued_to_hr_id, issued_at desc);

-- The same four statements, in the same order, as the lock loop every other table in this module goes
-- through. The order matters: revoking from public also strips service_role, which is a member of it,
-- so the grant that follows is mandatory rather than decorative.
alter table public.phoenix_crm_voice_uploads enable row level security;
drop policy if exists phoenix_crm_voice_uploads_service_role on public.phoenix_crm_voice_uploads;
create policy phoenix_crm_voice_uploads_service_role
  on public.phoenix_crm_voice_uploads for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_voice_uploads from public, anon, authenticated;
grant all on table public.phoenix_crm_voice_uploads to service_role;

-- === 2. The audio columns on the visit ===========================================================
-- Nullable, because the note is optional and a visit saves without one. The unique index is the same
-- guarantee the photo has: one recording, one visit. It is PARTIAL because almost every row is null,
-- and two nulls are not duplicates anyway.

alter table public.phoenix_crm_visits
  add column if not exists voice_note_path text,
  add column if not exists voice_note_seconds integer,
  add column if not exists voice_note_bytes integer;

do $checks$
begin
  if not exists (select 1 from pg_constraint where conname = 'phoenix_crm_visits_voice_note_path') then
    alter table public.phoenix_crm_visits
      add constraint phoenix_crm_visits_voice_note_path
      check (voice_note_path is null or char_length(voice_note_path) between 10 and 200);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'phoenix_crm_visits_voice_note_seconds') then
    alter table public.phoenix_crm_visits
      add constraint phoenix_crm_visits_voice_note_seconds
      check (voice_note_seconds is null or voice_note_seconds between 1 and 120);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'phoenix_crm_visits_voice_note_bytes') then
    alter table public.phoenix_crm_visits
      add constraint phoenix_crm_visits_voice_note_bytes
      check (voice_note_bytes is null or voice_note_bytes between 1 and 2097152);
  end if;
end
$checks$;

create unique index if not exists phoenix_crm_visits_voice_uidx
  on public.phoenix_crm_visits (voice_note_path)
  where voice_note_path is not null;

-- === 3. The bucket (private, audio only, 2 MB) ===================================================
-- Four containers because browsers disagree: Chrome and Firefox record webm/opus, Safari mp4/aac. An
-- allow-list rather than whatsapp-inbox-media's deliberate null, because that bucket holds whatever a
-- stranger sent and this one holds what one of four recorders in our own form produced.

do $bucket$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'phoenix-crm-voice',
      'phoenix-crm-voice',
      false,
      2097152,
      array['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg']
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists phoenix_crm_voice_service_role on storage.objects';
    execute $policy$
      create policy phoenix_crm_voice_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'phoenix-crm-voice')
      with check (bucket_id = 'phoenix-crm-voice')
    $policy$;
  end if;
end
$bucket$;

-- === 4. Spending a slot ==========================================================================
-- The same five refusals phoenix_crm_take_photo makes, and ONE difference that is the point of this
-- whole migration: it returns void. Its sibling returns the issue time, and that return value is what
-- becomes phoenix_crm_visits.captured_at and therefore the visit's date. Returning nothing is how
-- "audio dates nothing" stops being a rule somebody has to remember.

create or replace function public.phoenix_crm_take_voice(
  p_path text,
  p_hr_id text,
  p_seat_id text,
  p_is_test boolean
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_slot public.phoenix_crm_voice_uploads%rowtype;
begin
  select u.* into v_slot
  from public.phoenix_crm_voice_uploads u
  where u.path = p_path
  for update;

  if not found
    or v_slot.issued_to_hr_id <> upper(trim(p_hr_id))
    or v_slot.seat_id <> p_seat_id
    or v_slot.is_test <> p_is_test then
    raise exception 'phoenix_crm:voice_not_issued';
  end if;
  if v_slot.used_at is not null then
    raise exception 'phoenix_crm:voice_used';
  end if;
  -- The same two hours the photo slot allows. Here it bounds nothing about dating, because nothing
  -- here dates anything — it bounds how long a signed upload URL is worth stealing.
  if v_slot.issued_at < now() - interval '2 hours' then
    raise exception 'phoenix_crm:voice_expired';
  end if;
  if not exists (
    select 1 from storage.objects o where o.bucket_id = 'phoenix-crm-voice' and o.name = p_path
  ) then
    raise exception 'phoenix_crm:voice_missing';
  end if;

  update public.phoenix_crm_voice_uploads u set used_at = now() where u.path = p_path;
end;
$$;

revoke execute on function public.phoenix_crm_take_voice(text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_take_voice(text, text, text, boolean) to service_role;

-- === 5. The save =================================================================================
-- Carried over from 20260925021140 mechanically. Three insertions: the locals, the take_voice call
-- after the date is settled, and the three columns on the insert. Its grants are not restated — see
-- the header.

create or replace function public.phoenix_crm_save_visit(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_line text := nullif(trim(coalesce(p ->> 'line_code', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_customer_id uuid := nullif(p ->> 'customer_id', '')::uuid;
  v_kind text := coalesce(p ->> 'kind', '');
  v_rep text := upper(nullif(trim(coalesce(p ->> 'rep_hr_id', '')), ''));
  v_manager text := upper(nullif(trim(coalesce(p ->> 'manager_hr_id', '')), ''));
  v_senior text := upper(nullif(trim(coalesce(p ->> 'senior_hr_id', '')), ''));
  v_photo text := nullif(trim(coalesce(p ->> 'photo_path', '')), '');
  v_reuse boolean := coalesce((p ->> 'reuse_place_photo')::boolean, false);
  v_place_id uuid := nullif(p ->> 'place_id', '')::uuid;
  v_flag text := coalesce(p ->> 'location_flag', '');
  v_comment text := nullif(trim(coalesce(p ->> 'comment', '')), '');
  v_pharmacy text := nullif(trim(coalesce(p ->> 'pharmacy_name', '')), '');
  v_availability jsonb := coalesce(p -> 'product_availability', '{}'::jsonb);
  v_voice text := nullif(trim(coalesce(p ->> 'voice_note_path', '')), '');
  v_voice_seconds integer := nullif(p ->> 'voice_note_seconds', '')::integer;
  v_voice_bytes integer := nullif(p ->> 'voice_note_bytes', '')::integer;
  v_products text[];
  v_existing public.phoenix_crm_visits%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_captured_at timestamptz;
  v_date date;
begin
  if v_id is null or v_seat is null or v_line is null or v_actor is null or v_customer_id is null or v_photo is null
    or v_kind not in ('single', 'double', 'chain')
    or v_flag not in ('ok', 'far', 'weak_gps', 'no_place')
    or (v_pharmacy is not null and char_length(v_pharmacy) > 120) then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if jsonb_typeof(v_availability) <> 'object' then
    v_availability := '{}'::jsonb;
  end if;
  if not (
    (v_kind = 'single' and v_senior is null and ((v_rep is null) <> (v_manager is null)))
    or (v_kind = 'double' and v_rep is not null and v_manager is not null and v_senior is null)
    or (v_kind = 'chain' and v_rep is not null and v_manager is not null and v_senior is not null)
  ) then
    raise exception 'phoenix_crm:bad_participants';
  end if;

  select array_agg(trim(e.value) order by e.ordinality)
  into v_products
  from jsonb_array_elements_text(coalesce(p -> 'products', '[]'::jsonb)) with ordinality as e (value, ordinality)
  where nullif(trim(e.value), '') is not null;
  if v_products is null or cardinality(v_products) > 12 then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select v.* into v_existing from public.phoenix_crm_visits v where v.id = v_id;
  if not found then
    perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));
    -- A retry racing its own first attempt waits on the lock, then finds it here.
    select v.* into v_existing from public.phoenix_crm_visits v where v.id = v_id;
  end if;
  if found then
    if v_existing.seat_id <> v_seat or v_existing.entered_by_hr_id <> v_actor then
      raise exception 'phoenix_crm:id_conflict';
    end if;
    return jsonb_build_object(
      'id', v_existing.id,
      'visit_date', v_existing.visit_date,
      'captured_at', v_existing.captured_at,
      'customer_id', v_existing.customer_id,
      'duplicate', true
    );
  end if;

  select c.* into v_customer
  from public.phoenix_crm_customers c
  where c.id = v_customer_id
    and c.seat_id = v_seat
    and c.is_test = v_is_test;
  if not found then
    raise exception 'phoenix_crm:customer_not_found';
  end if;
  -- A pending customer (carried over from iReports360, not validated yet) is a real, visitable
  -- customer, exactly as the list and the visit form treat him. Only a genuinely dropped customer
  -- is refused here, and 'phoenix_crm:customer_dropped' — "This customer has left the list." — is
  -- correct for that case.
  if v_customer.status not in ('active', 'pending') then
    raise exception 'phoenix_crm:customer_dropped';
  end if;
  if v_place_id is not null and not exists (
    select 1 from public.phoenix_crm_places pl where pl.id = v_place_id and pl.customer_id = v_customer.id
  ) then
    raise exception 'phoenix_crm:place_changed';
  end if;

  if v_reuse then
    select pl.captured_at into v_captured_at
    from public.phoenix_crm_places pl
    where pl.photo_path = v_photo
      and pl.customer_id = v_customer.id
      and pl.created_by_hr_id = v_actor
      and pl.is_test = v_is_test
      and pl.created_at > now() - interval '30 minutes';
    if not found then
      raise exception 'phoenix_crm:photo_not_issued';
    end if;
    if exists (select 1 from public.phoenix_crm_visits v where v.photo_path = v_photo) then
      raise exception 'phoenix_crm:photo_used';
    end if;
  else
    v_captured_at := public.phoenix_crm_take_photo(v_photo, v_actor, v_seat, 'visit', v_is_test);
  end if;

  v_date := (v_captured_at at time zone 'Africa/Cairo')::date;

  if exists (
    select 1
    from public.phoenix_crm_visits v
    where v.seat_id = v_seat
      and v.customer_id = v_customer.id
      and v.visit_date = v_date
      and v.is_test = v_is_test
  ) then
    raise exception 'phoenix_crm:already_visited';
  end if;

  -- The voice note, when there is one. Two things about this call are the point of the whole
  -- migration. It happens AFTER v_date is settled, so nothing it does can reach the date. And
  -- phoenix_crm_take_voice returns VOID, where phoenix_crm_take_photo returns the issue time that
  -- becomes captured_at -- so there is no value here to assign to v_captured_at even by mistake. The
  -- rule "a recording dates nothing" is therefore not a convention this file is keeping; it is the
  -- only thing the signature permits. It still refuses a path not issued to this person for this
  -- territory, one already spent, one older than two hours, and one whose object never arrived.
  if v_voice is not null then
    perform public.phoenix_crm_take_voice(v_voice, v_actor, v_seat, v_is_test);
  end if;

  insert into public.phoenix_crm_visits (
    id, seat_id, line_code, customer_id, list_type, visit_date, captured_at, kind, rep_hr_id, manager_hr_id,
    senior_hr_id, entered_by_hr_id, products, comment, pharmacy_name, product_availability, photo_path, lat, lon,
    accuracy_meters, place_id, distance_meters, location_flag, device_skew_minutes, is_test,
    voice_note_path, voice_note_seconds, voice_note_bytes
  )
  values (
    v_id, v_seat, v_line, v_customer.id, v_customer.list_type, v_date, v_captured_at, v_kind, v_rep, v_manager,
    v_senior, v_actor, v_products, v_comment, v_pharmacy, v_availability, v_photo,
    (p ->> 'lat')::double precision,
    (p ->> 'lon')::double precision,
    (p ->> 'accuracy_meters')::numeric,
    v_place_id,
    (p ->> 'distance_meters')::integer,
    v_flag,
    (p ->> 'device_skew_minutes')::integer,
    v_is_test,
    v_voice, v_voice_seconds, v_voice_bytes
  );

  return jsonb_build_object(
    'id', v_id,
    'visit_date', v_date,
    'captured_at', v_captured_at,
    'customer_id', v_customer.id,
    'customer_name', v_customer.name,
    'list_type', v_customer.list_type,
    'duplicate', false
  );
end;
$$;
notify pgrst, 'reload schema';

commit;
