-- phoenix_crm_photo_fingerprints
--
-- WHAT THIS CHANGES:
--   1. One new table, public.phoenix_crm_photo_fingerprints — one row per photo, forever: the sha256
--      of the file and a 64-bit difference hash of the picture, computed once by the nightly sweep.
--   2. One new function, public.phoenix_crm_photos_to_fingerprint(p jsonb) — the photos on record
--      that have no fingerprint yet, oldest first, so the backlog drains in a fixed order and nothing
--      is stranded behind newer work.
--   3. public.phoenix_crm_location_integrity gains a `source` column, and its one-verdict-per-capture
--      unique key widens from (subject_kind, subject_id) to (subject_kind, subject_id, source).
--
-- WHY (owner, 2026-09-25, and Golden Rule #1):
--   The live photo is the one part of a visit a spoofed coordinate cannot fake — the upload slot is
--   single-use and the server times it. What that does not stop is a rep photographing one door and
--   sending the same picture again, for the next customer or for a day he never left the house. The
--   slot is honest about WHEN; only the pixels answer whether it is a new photograph.
--
--   THE REP IS NEVER TOLD. Nothing here refuses a save, changes a message or adds a field to a screen
--   a rep can open. The evidence lands in phoenix_crm_location_integrity, which his app never reads
--   and which the Super Admin and the SFE Manager alone can open.
--
-- 🔴 WHY THE UNIQUE KEY HAD TO WIDEN, WHICH IS A LATENT BUG AND NOT A TIDY-UP:
--   judgeCapture upserts on (subject_kind, subject_id). A second detector filing evidence about the
--   SAME visit would therefore not add a second row — it would overwrite the first, and the GPS
--   verdict on that visit would silently disappear the moment the photo sweep reached it. Nothing
--   would have gone red: the write succeeds, the row is there, and the flags are simply someone
--   else's. Splitting the key by `source` is what lets two detectors judge one visit and both be
--   kept. Existing rows backfill to 'gps' from the column default, which is what every one of them
--   is.
--
-- ROLLBACK:
--   drop function if exists public.phoenix_crm_photos_to_fingerprint(jsonb);
--   drop table if exists public.phoenix_crm_photo_fingerprints;
--   alter table public.phoenix_crm_location_integrity
--     drop constraint if exists phoenix_crm_location_integrity_subject_source_key,
--     drop constraint if exists phoenix_crm_location_integrity_source,
--     drop column if exists source;
--   alter table public.phoenix_crm_location_integrity
--     add constraint phoenix_crm_location_integrity_subject_kind_subject_id_key unique (subject_kind, subject_id);
--
-- Verification after apply:
--   select count(*) from public.phoenix_crm_photo_fingerprints;                        -- 0
--   select relrowsecurity from pg_class where relname = 'phoenix_crm_photo_fingerprints';  -- t
--   select prosecdef from pg_proc where proname = 'phoenix_crm_photos_to_fingerprint';     -- t
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--     where conrelid = 'public.phoenix_crm_location_integrity'::regclass and contype = 'u';
--     -- exactly one unique: (subject_kind, subject_id, source)

begin;
set local lock_timeout = '5s';

create table if not exists public.phoenix_crm_photo_fingerprints (
  id uuid primary key default gen_random_uuid(),
  -- The storage path IS the identity: one photo, one fingerprint, computed once and never again.
  photo_path text not null,
  subject_kind text not null check (subject_kind in ('visit', 'place')),
  subject_id uuid not null,
  seat_id text,
  rep_hr_id text,
  customer_id uuid,
  captured_at timestamptz not null,
  -- 64 hex characters. Null when the photo could not be read — see `failure`.
  sha256 text,
  -- 16 hex characters: a difference hash of a 9x8 greyscale thumbnail.
  dhash text,
  size_bytes integer,
  -- Why it could not be hashed. Present so a broken object is recorded as NOT CHECKED rather than
  -- retried every night forever, and so the board can tell "compared and clean" from "never read".
  failure text,
  computed_at timestamptz not null default now(),
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  constraint phoenix_crm_photo_fingerprints_photo unique (photo_path),
  constraint phoenix_crm_photo_fingerprints_sha check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  constraint phoenix_crm_photo_fingerprints_dhash check (dhash is null or dhash ~ '^[0-9a-f]{16}$'),
  constraint phoenix_crm_photo_fingerprints_failure check (failure is null or char_length(failure) <= 200)
);

comment on table public.phoenix_crm_photo_fingerprints is
  'One fingerprint per Phoenix CRM photo, computed once by the nightly sweep. Service role only; no rep-facing screen reads it. See src/lib/phoenix-crm/duplicate-photos.ts.';
comment on column public.phoenix_crm_photo_fingerprints.failure is
  'Why the photo could not be hashed. A row with a failure is NOT CHECKED, which is not the same as clean.';

-- The sweep's two reads: the exact-match lookup, and the recent corpus the fuzzy hash is compared
-- against. Both are bounded by time, so neither grows without end.
create index if not exists phoenix_crm_photo_fingerprints_sha_idx
  on public.phoenix_crm_photo_fingerprints (sha256) where sha256 is not null;
create index if not exists phoenix_crm_photo_fingerprints_captured_idx
  on public.phoenix_crm_photo_fingerprints (captured_at desc);

-- The same four statements, in the same order, as every other table in this module. Revoking from
-- public also strips service_role, which is a member of it, so the grant that follows is mandatory
-- rather than decorative; the `drop policy if exists` is what lets this file be REPLAYED against a
-- database whose schema already has it but whose ledger does not.
alter table public.phoenix_crm_photo_fingerprints enable row level security;
drop policy if exists phoenix_crm_photo_fingerprints_service_role on public.phoenix_crm_photo_fingerprints;
create policy phoenix_crm_photo_fingerprints_service_role
  on public.phoenix_crm_photo_fingerprints for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_photo_fingerprints from public, anon, authenticated;
grant all on table public.phoenix_crm_photo_fingerprints to service_role;

-- ── The verdict table learns who is speaking ────────────────────────────────────────────────────
--
-- See the header: without this, the photo sweep's verdict would REPLACE the GPS verdict on the same
-- visit rather than sit beside it, and nothing anywhere would have gone red.
alter table public.phoenix_crm_location_integrity
  add column if not exists source text not null default 'gps';

comment on column public.phoenix_crm_location_integrity.source is
  'Which detector filed this row: gps (the position), photo (the picture), behaviour (the pattern). Part of the unique key, so two detectors can each keep a verdict on one capture.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.phoenix_crm_location_integrity'::regclass and conname = 'phoenix_crm_location_integrity_source'
  ) then
    alter table public.phoenix_crm_location_integrity
      add constraint phoenix_crm_location_integrity_source check (source in ('gps', 'photo', 'behaviour'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.phoenix_crm_location_integrity'::regclass and conname = 'phoenix_crm_location_integrity_subject_source_key'
  ) then
    alter table public.phoenix_crm_location_integrity
      add constraint phoenix_crm_location_integrity_subject_source_key unique (subject_kind, subject_id, source);
  end if;
end;
$$;

alter table public.phoenix_crm_location_integrity
  drop constraint if exists phoenix_crm_location_integrity_subject_kind_subject_id_key;

-- ── What still needs a fingerprint ──────────────────────────────────────────────────────────────
--
-- OLDEST FIRST, deliberately. A newest-first sweep with a nightly cap can leave an old backlog
-- permanently behind fresher work, and a photo that is never hashed is a photo that can be re-used
-- for ever. Draining from the oldest end means every photo is reached in a fixed number of nights.
--
-- The anti-join lives here rather than in the service because Supabase's client cannot express
-- "rows with no matching row over there" without pulling both sides into memory, which is fine at
-- today's volume and is exactly the kind of thing that stops being fine without anybody noticing.
--
-- A visit's person is the rep; a manager visiting alone has no rep_hr_id, so the person falls back
-- to whoever the visit is attributed to. A place records its creator.
create or replace function public.phoenix_crm_photos_to_fingerprint(p jsonb)
returns jsonb
language sql
security definer
set search_path to 'public'
as $$
  with candidates as (
    select
      'visit'::text as subject_kind,
      v.id as subject_id,
      v.photo_path,
      v.seat_id,
      coalesce(v.rep_hr_id, v.manager_hr_id, v.entered_by_hr_id) as rep_hr_id,
      v.customer_id,
      v.captured_at,
      v.is_test
    from public.phoenix_crm_visits v
    where (coalesce((p ->> 'include_test')::boolean, false) or v.is_test = false)
    union all
    select
      'place'::text,
      pl.id,
      pl.photo_path,
      pl.seat_id,
      pl.created_by_hr_id,
      pl.customer_id,
      pl.captured_at,
      pl.is_test
    from public.phoenix_crm_places pl
    where (coalesce((p ->> 'include_test')::boolean, false) or pl.is_test = false)
  )
  select coalesce(jsonb_agg(to_jsonb(picked) order by picked.captured_at), '[]'::jsonb)
  from (
    select c.*
    from candidates c
    left join public.phoenix_crm_photo_fingerprints f on f.photo_path = c.photo_path
    where f.photo_path is null
    order by c.captured_at
    limit greatest(1, least(2000, coalesce((p ->> 'limit')::int, 200)))
  ) picked;
$$;

revoke execute on function public.phoenix_crm_photos_to_fingerprint(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_photos_to_fingerprint(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
