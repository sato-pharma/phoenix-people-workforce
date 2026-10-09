-- phoenix_crm_shared_places
--
-- WHAT THIS CHANGES:
--   A SHARED PLACE — a polyclinic, a medical centre, a medical tower, a hospital outpatient suite —
--   is captured ONCE at its door, and the customers who receive behind that door are SEATED in it:
--     1. a new table, public.phoenix_crm_shared_places: the venue itself, with the same frozen-point
--        discipline a place has (two readings, the photo's own fix preferred, the whole location
--        resolved on the server) and its own Super Admin decision columns;
--     2. phoenix_crm_places gains `shared_place_id` and `schedule_check`, and `point_source` gains
--        'shared_place' — a seated customer is an ORDINARY place row whose point is the venue's and
--        whose photo is the clinic's TIMETABLE, not a signboard;
--     3. phoenix_crm_validation_reviews.refusal_reason gains the two timetable reasons the owner
--        approved on 2026-10-09 ('schedule_other_name', 'schedule_missing') — the seventh and eighth
--        in a list that has been closed at six since 2026-10-08;
--     4. phoenix_crm_settings gains `shared_place_daily_cap` (3), beside pm_daily_cap and
--        am_daily_cap — the cap is a SETTING, never a constant, exactly as those two are;
--     5. phoenix_crm_insert_place learns the two new columns and the new point source. Body taken
--        from pg_proc.prosrc, live on production 2026-10-09 (3,284 bytes);
--     6. two new functions — phoenix_crm_create_shared_place (the one insert door for a venue) and
--        phoenix_crm_decide_shared_place (approve it, or reject it and send every customer seated in
--        it back to To validate);
--     7. a BEFORE INSERT trigger on phoenix_crm_visits that refuses the fourth visit of one day
--        inside one shared place.
--
-- WHY:
--   A place is validated at the door by a live signboard photo that must CARRY THE CUSTOMER'S OWN
--   NAME (owner, 2026-10-08). That works for a doctor with his own clinic and cannot work for a
--   polyclinic: the signboard names the BUILDING, five customers receive behind one door, and each of
--   them needed his own capture at the same spot where the sign could never name him. They stayed
--   unvalidated, and an unvalidated customer's visits are saved and score nothing.
--
--   Owner, 2026-10-09, in his own words (Arabic, in chat): validate the polyclinic itself once, then
--   register each customer's times inside it, "from X to Y and from X to Y", at most THREE a day; he
--   must upload a photo of the timetable showing the names of the people he wants to add, at each one;
--   the polyclinic's location is taken once, so seating needs no location — the location is taken on
--   the normal visit; and the administrator has the right to review the timetable afterwards.
--
--   🔴 WHY THE TIMETABLE PHOTO IS PER CUSTOMER AND NOT ONE SHARED IMAGE: `phoenix_crm_places_photo_uidx`
--   is UNIQUE on photo_path, and — more usefully — the camera burns the evidence stamp with THAT
--   customer's name into each capture, which the schedule read then crops off before the model reads
--   the timetable. One shared image would lose both.
--
--   🔴 WHY A SEATED CUSTOMER IS AN ORDINARY PLACE ROW: everything downstream already works off a place
--   — the visit's distance check, placesFor and the re-measure, the plan item's optional place_id, the
--   move and retire audit, brick_*/area_*/region_*. Nothing in the module has to learn a new shape.
--
--   🔴 WHY THE VENUE'S DECISION IS NOT A `phoenix_crm_validation_reviews` ROW: that table's place_id
--   and customer_id are NOT NULL and its place index is UNIQUE on place_id, and a venue has neither a
--   place nor a customer. Widening all three would have made every reader of that table — the review
--   board, the held-place set, the restore path, the reopened list — carry a row it cannot render. The
--   venue therefore keeps its own four decision columns and its own decide function, and the SEATED
--   place keeps the one review path it already had: it is an active place, so it is on the Super
--   Admin's Place checks page from the moment it is saved, and `refuseValidatedPlace` already retires
--   it and sends its customer back to To validate. That is the administrator's right to review, with
--   no second audit shape.
--
-- ROLLBACK:
--   drop trigger if exists phoenix_crm_visits_shared_place_cap on public.phoenix_crm_visits;
--   drop function if exists public.phoenix_crm_shared_place_day_cap();
--   drop function if exists public.phoenix_crm_decide_shared_place(jsonb);
--   drop function if exists public.phoenix_crm_create_shared_place(jsonb);
--   alter table public.phoenix_crm_places drop column if exists shared_place_id, drop column if exists schedule_check;
--   alter table public.phoenix_crm_settings drop column if exists shared_place_daily_cap;
--   drop table if exists public.phoenix_crm_shared_places;
--   Then restore phoenix_crm_insert_place and the two CHECKs from the definitions quoted above. Every
--   step is additive: no existing row is rewritten by this migration, and dropping the table loses
--   only the venues captured since it was applied.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. This
-- migration rewrites not one existing row.

begin;
set local lock_timeout = '5s';

-- 1 ─ The venue itself ───────────────────────────────────────────────────────────────────────────

create table if not exists public.phoenix_crm_shared_places (
  id uuid primary key default gen_random_uuid(),
  seat_id text not null,
  line_code text not null,
  -- What is written on the building. A venue NAME, never a person's: `judgeSignboard` reads it in its
  -- place-name mode, which is the mode that never looks for a person on a sign.
  name text not null check (char_length(name) between 1 and 200),
  kind text not null check (kind in ('polyclinic', 'medical_centre', 'medical_tower', 'hospital_outpatient')),
  -- The FIXED point, chosen on the server from the two readings exactly as a place's is.
  lat double precision not null check (lat >= 21.5 and lat <= 32),
  lon double precision not null check (lon >= 24 and lon <= 37.5),
  accuracy_meters numeric(8, 1) check (accuracy_meters is null or accuracy_meters >= 0),
  pin_lat double precision,
  pin_lon double precision,
  pin_accuracy_meters numeric,
  photo_lat double precision,
  photo_lon double precision,
  photo_accuracy_meters numeric,
  photo_captured_at timestamptz,
  point_source text not null default 'pin' check (point_source in ('photo', 'pin', 'moved')),
  photo_path text not null,
  captured_at timestamptz not null,
  device_skew_minutes integer,
  address text check (address is null or char_length(address) <= 200),
  zone text check (zone is null or char_length(zone) <= 80),
  brick_id text,
  brick_name text,
  brick_distance_km numeric,
  brick_lookup text not null default 'could_not_look' check (brick_lookup in ('matched', 'none_nearby', 'could_not_look')),
  area_code text,
  area_name text,
  region_code text,
  region_name text,
  -- What the model read on the building's sign, kept for every venue and not only the held ones.
  signboard_check jsonb,
  -- 'held' is a venue whose sign did not confirm its own name: it is saved, nobody can be seated in
  -- it, and the Super Admin decides it. 'retired' is a rejected or removed venue.
  status text not null default 'active' check (status in ('active', 'held', 'retired')),
  decided_at timestamptz,
  decided_by_hr_id text,
  decision_note text check (decision_note is null or char_length(decision_note) <= 500),
  -- The same closed list a place's refusal is chosen from (src/lib/phoenix-crm/validation-feedback.ts),
  -- including the two timetable reasons added in step 3 below.
  refusal_reason text check (
    refusal_reason is null
    or refusal_reason in (
      'no_signboard', 'wrong_name', 'too_dark', 'not_at_door', 'photo_of_paper', 'point_off',
      'schedule_other_name', 'schedule_missing'
    )
  ),
  retired_at timestamptz,
  retired_by_hr_id text,
  moved_at timestamptz,
  moved_by_hr_id text,
  move_reason text check (move_reason is null or char_length(move_reason) between 10 and 500),
  -- The same shape a place's move carries: a moved point names who moved it and why, and nothing else
  -- may claim to have been moved.
  constraint phoenix_crm_shared_places_moved
    check ((point_source = 'moved') = (moved_at is not null and moved_by_hr_id is not null and move_reason is not null)),
  created_by_hr_id text not null,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.phoenix_crm_shared_places is
  'Phoenix CRM shared places — a polyclinic, medical centre, medical tower or hospital outpatient suite, captured once at its door. A venue only: it is on nobody''s list, takes no visit and counts in no call rate. See src/lib/phoenix-crm/shared-place-rules.ts.';

-- The one question the rep's picker asks: which venues may I seat somebody in, in this territory.
create index if not exists phoenix_crm_shared_places_seat_idx
  on public.phoenix_crm_shared_places (seat_id, is_test, status);
-- A photo is evidence of ONE capture, here as on a place.
create unique index if not exists phoenix_crm_shared_places_photo_uidx
  on public.phoenix_crm_shared_places (photo_path);

-- The same four statements every table in this module states; `tests/phoenix-crm-boundary.test.ts`
-- holds each one of them to exactly these lines, so that no table is ever locked by accident.
alter table public.phoenix_crm_shared_places enable row level security;
create policy phoenix_crm_shared_places_service_role
  on public.phoenix_crm_shared_places for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_shared_places from public, anon, authenticated;
grant all on table public.phoenix_crm_shared_places to service_role;

-- 2 ─ A place can be SEATED in a venue ───────────────────────────────────────────────────────────

alter table public.phoenix_crm_places
  add column if not exists shared_place_id uuid references public.phoenix_crm_shared_places (id),
  -- What the model read on the TIMETABLE. A different question from `signboard_check`, which stays
  -- exactly as it is: one asks whose building this is, the other asks whether the timetable hanging
  -- in it names this customer.
  add column if not exists schedule_check jsonb;

-- 'shared_place': the point was copied from the venue, so no reading of this place's own was taken.
alter table public.phoenix_crm_places drop constraint if exists phoenix_crm_places_point_source;
alter table public.phoenix_crm_places
  add constraint phoenix_crm_places_point_source
  check (point_source in ('photo', 'pin', 'moved', 'shared_place'));

-- One-directional on purpose: a seated place MUST name its venue, and the Super Admin moving one
-- later turns its source into 'moved' without having to unseat it first.
alter table public.phoenix_crm_places drop constraint if exists phoenix_crm_places_shared_place;
alter table public.phoenix_crm_places
  add constraint phoenix_crm_places_shared_place
  check (point_source <> 'shared_place' or shared_place_id is not null);

create index if not exists phoenix_crm_places_shared_place_idx
  on public.phoenix_crm_places (shared_place_id, status);

-- 3 ─ The two timetable refusal reasons (owner, 2026-10-09) ──────────────────────────────────────
--
-- 🔴 'photo_of_paper' — "The photo shows paper or a screen rather than the clinic itself" — is never
-- OFFERED on a timetable refusal: a timetable IS paper, so that reason would be wrong by
-- construction. `reasonsFor` (validation-feedback.ts) is what keeps them apart; the CHECK below holds
-- every key, because one table stores both kinds of refusal.
alter table public.phoenix_crm_validation_reviews drop constraint if exists phoenix_crm_validation_reviews_refusal_reason;
alter table public.phoenix_crm_validation_reviews
  add constraint phoenix_crm_validation_reviews_refusal_reason
  check (
    refusal_reason is null
    or refusal_reason in (
      'no_signboard', 'wrong_name', 'too_dark', 'not_at_door', 'photo_of_paper', 'point_off',
      'schedule_other_name', 'schedule_missing'
    )
  );

-- 4 ─ The cap, as a setting ──────────────────────────────────────────────────────────────────────

alter table public.phoenix_crm_settings
  add column if not exists shared_place_daily_cap integer not null default 3;
alter table public.phoenix_crm_settings drop constraint if exists phoenix_crm_settings_shared_place_cap;
alter table public.phoenix_crm_settings
  add constraint phoenix_crm_settings_shared_place_cap
  check (shared_place_daily_cap >= 1 and shared_place_daily_cap <= 20);

comment on column public.phoenix_crm_settings.shared_place_daily_cap is
  'Visits one shared place holds in one visit day, whatever the number of customers seated in it (owner, 2026-10-09: three). Read from here by the plan save, the plan send and the visit trigger — never a constant.';

-- 5 ─ The place insert carries the venue, the timetable read and the new point source ────────────

create or replace function public.phoenix_crm_insert_place(p_customer_id uuid, p_seat_id text, p_actor_hr_id text, p_is_test boolean, p_place jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_captured_at timestamptz;
  v_place_id uuid;
  v_source text := coalesce(p_place ->> 'point_source', 'pin');
  v_shared uuid := nullif(p_place ->> 'shared_place_id', '')::uuid;
begin
  if jsonb_typeof(p_place) is distinct from 'object'
    or jsonb_typeof(p_place -> 'timings') is distinct from 'array'
    or nullif(trim(coalesce(p_place ->> 'photo_path', '')), '') is null then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- A caller that names no source sent one reading, the pin, in lat/lon — exactly as before today.
  -- 'shared_place' joins the three: the point was copied from a venue this place must name.
  if v_source not in ('photo', 'pin', 'shared_place') then
    v_source := 'pin';
  end if;
  if v_source = 'shared_place' and v_shared is null then
    raise exception 'phoenix_crm:bad_input';
  end if;

  v_captured_at := public.phoenix_crm_take_photo(p_place ->> 'photo_path', p_actor_hr_id, p_seat_id, 'place', p_is_test);

  -- Every location column here is the SERVER's own resolution of the fixed point (server/list.ts
  -- placePayload), not anything the phone typed. The two raw readings are kept beside it as evidence.
  insert into public.phoenix_crm_places (
    customer_id, seat_id, label, address, brick_id, brick_name, brick_distance_km, brick_lookup,
    area_code, area_name, region_code, region_name, zone, lat, lon, accuracy_meters,
    timings, photo_path, captured_at, device_skew_minutes, created_by_hr_id, is_test,
    pin_lat, pin_lon, pin_accuracy_meters, photo_lat, photo_lon, photo_accuracy_meters, photo_captured_at, point_source,
    shared_place_id, schedule_check
  )
  values (
    p_customer_id,
    p_seat_id,
    nullif(trim(coalesce(p_place ->> 'label', '')), ''),
    nullif(trim(coalesce(p_place ->> 'address', '')), ''),
    nullif(trim(coalesce(p_place ->> 'brick_id', '')), ''),
    nullif(trim(coalesce(p_place ->> 'brick_name', '')), ''),
    (p_place ->> 'brick_distance_km')::numeric,
    -- 2026-10-08. 🔴 The fallback is the UNKNOWN value, never 'matched': a caller that sends no key —
    -- an older build, a replayed body — must land on "nobody looked", which is both true of it and the
    -- safe direction. The column's CHECK rejects anything that is not one of the three.
    coalesce(nullif(trim(coalesce(p_place ->> 'brick_lookup', '')), ''), 'could_not_look'),
    nullif(trim(coalesce(p_place ->> 'area_code', '')), ''),
    nullif(trim(coalesce(p_place ->> 'area_name', '')), ''),
    nullif(trim(coalesce(p_place ->> 'region_code', '')), ''),
    nullif(trim(coalesce(p_place ->> 'region_name', '')), ''),
    nullif(trim(coalesce(p_place ->> 'zone', '')), ''),
    (p_place ->> 'lat')::double precision,
    (p_place ->> 'lon')::double precision,
    (p_place ->> 'accuracy_meters')::numeric,
    p_place -> 'timings',
    p_place ->> 'photo_path',
    v_captured_at,
    (p_place ->> 'device_skew_minutes')::integer,
    upper(trim(p_actor_hr_id)),
    p_is_test,
    coalesce((p_place ->> 'pin_lat')::double precision, (p_place ->> 'lat')::double precision),
    coalesce((p_place ->> 'pin_lon')::double precision, (p_place ->> 'lon')::double precision),
    coalesce((p_place ->> 'pin_accuracy_meters')::numeric, (p_place ->> 'accuracy_meters')::numeric),
    (p_place ->> 'photo_lat')::double precision,
    (p_place ->> 'photo_lon')::double precision,
    (p_place ->> 'photo_accuracy_meters')::numeric,
    nullif(p_place ->> 'photo_captured_at', '')::timestamptz,
    v_source,
    v_shared,
    case when jsonb_typeof(p_place -> 'schedule_check') = 'object' then p_place -> 'schedule_check' end
  )
  returning id into v_place_id;

  return jsonb_build_object('place_id', v_place_id, 'captured_at', v_captured_at);
end;
$$;

revoke execute on function public.phoenix_crm_insert_place(uuid, text, text, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_insert_place(uuid, text, text, boolean, jsonb) to service_role;

-- 6 ─ Capturing a venue, and deciding one ────────────────────────────────────────────────────────

create or replace function public.phoenix_crm_create_shared_place(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_line text := nullif(trim(coalesce(p ->> 'line_code', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_name text := nullif(regexp_replace(trim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'), '');
  v_kind text := coalesce(p ->> 'kind', '');
  v_place jsonb := case when jsonb_typeof(p -> 'place') = 'object' then p -> 'place' end;
  v_hold jsonb := case when jsonb_typeof(p -> 'hold_review') = 'object' then p -> 'hold_review' end;
  v_sign jsonb := case when jsonb_typeof(p -> 'signboard_check') = 'object' then p -> 'signboard_check' end;
  v_source text;
  v_captured_at timestamptz;
  v_id uuid;
begin
  if v_seat is null or v_line is null or v_actor is null or v_name is null or v_place is null
    or v_kind not in ('polyclinic', 'medical_centre', 'medical_tower', 'hospital_outpatient')
    or nullif(trim(coalesce(v_place ->> 'photo_path', '')), '') is null then
    raise exception 'phoenix_crm:bad_input';
  end if;
  v_source := coalesce(v_place ->> 'point_source', 'pin');
  if v_source not in ('photo', 'pin') then
    v_source := 'pin';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  -- The same slot discipline a place's photo goes through: the photo must be one this server issued
  -- to this person for this territory, and it dates the capture.
  v_captured_at := public.phoenix_crm_take_photo(v_place ->> 'photo_path', v_actor, v_seat, 'place', v_is_test);

  insert into public.phoenix_crm_shared_places (
    seat_id, line_code, name, kind, lat, lon, accuracy_meters,
    pin_lat, pin_lon, pin_accuracy_meters, photo_lat, photo_lon, photo_accuracy_meters, photo_captured_at,
    point_source, photo_path, captured_at, device_skew_minutes, address, zone,
    brick_id, brick_name, brick_distance_km, brick_lookup, area_code, area_name, region_code, region_name,
    signboard_check, status, created_by_hr_id, is_test
  )
  values (
    v_seat,
    v_line,
    left(v_name, 200),
    v_kind,
    (v_place ->> 'lat')::double precision,
    (v_place ->> 'lon')::double precision,
    (v_place ->> 'accuracy_meters')::numeric,
    coalesce((v_place ->> 'pin_lat')::double precision, (v_place ->> 'lat')::double precision),
    coalesce((v_place ->> 'pin_lon')::double precision, (v_place ->> 'lon')::double precision),
    coalesce((v_place ->> 'pin_accuracy_meters')::numeric, (v_place ->> 'accuracy_meters')::numeric),
    (v_place ->> 'photo_lat')::double precision,
    (v_place ->> 'photo_lon')::double precision,
    (v_place ->> 'photo_accuracy_meters')::numeric,
    nullif(v_place ->> 'photo_captured_at', '')::timestamptz,
    v_source,
    v_place ->> 'photo_path',
    v_captured_at,
    (v_place ->> 'device_skew_minutes')::integer,
    nullif(trim(coalesce(v_place ->> 'address', '')), ''),
    nullif(trim(coalesce(v_place ->> 'zone', '')), ''),
    nullif(trim(coalesce(v_place ->> 'brick_id', '')), ''),
    nullif(trim(coalesce(v_place ->> 'brick_name', '')), ''),
    (v_place ->> 'brick_distance_km')::numeric,
    -- As on a place: the unknown value is the fallback, never a confident match.
    coalesce(nullif(trim(coalesce(v_place ->> 'brick_lookup', '')), ''), 'could_not_look'),
    nullif(trim(coalesce(v_place ->> 'area_code', '')), ''),
    nullif(trim(coalesce(v_place ->> 'area_name', '')), ''),
    nullif(trim(coalesce(v_place ->> 'region_code', '')), ''),
    nullif(trim(coalesce(v_place ->> 'region_name', '')), ''),
    coalesce(v_sign, v_hold),
    -- A sign that did not confirm the venue's own name holds it: it is saved, and nobody is seated in
    -- it until the Super Admin says so.
    case when v_hold is null then 'active' else 'held' end,
    v_actor,
    v_is_test
  )
  returning id into v_id;

  return jsonb_build_object(
    'shared_place_id', v_id,
    'captured_at', v_captured_at,
    'held', v_hold is not null
  );
end;
$$;

revoke execute on function public.phoenix_crm_create_shared_place(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_create_shared_place(jsonb) to service_role;

create or replace function public.phoenix_crm_decide_shared_place(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(p ->> 'shared_place_id', '')::uuid;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_decision text := coalesce(p ->> 'decision', '');
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_reason text := nullif(trim(coalesce(p ->> 'refusal_reason', '')), '');
  v_venue public.phoenix_crm_shared_places%rowtype;
  v_seated record;
  v_reopened jsonb := '[]'::jsonb;
  v_places integer := 0;
begin
  if v_id is null or v_actor is null or v_decision not in ('approve', 'reject')
    or (v_note is not null and char_length(v_note) > 500) then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select s.* into v_venue from public.phoenix_crm_shared_places s where s.id = v_id;
  if not found then
    raise exception 'phoenix_crm:shared_place_not_found';
  end if;
  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_venue.seat_id));
  select s.* into v_venue from public.phoenix_crm_shared_places s where s.id = v_id for update;
  if v_venue.status = 'retired' then
    raise exception 'phoenix_crm:shared_place_retired';
  end if;

  if v_decision = 'approve' then
    update public.phoenix_crm_shared_places
    set status = 'active', decided_at = now(), decided_by_hr_id = v_actor, decision_note = v_note,
        refusal_reason = null, updated_at = now()
    where id = v_id;
  else
    update public.phoenix_crm_shared_places
    set status = 'retired', decided_at = now(), decided_by_hr_id = v_actor, decision_note = v_note,
        refusal_reason = v_reason, retired_at = now(), retired_by_hr_id = v_actor, updated_at = now()
    where id = v_id;

    -- Every customer seated in a rejected venue goes back to To validate, exactly as a rejected place
    -- of his own would send him — place retired, customer pending when he has no other active place,
    -- `reopened_at` stamped so he is first in the rep's To validate order.
    for v_seated in
      select pl.id as place_id, pl.customer_id, pl.label, pl.lat, pl.lon, pl.is_test, pl.created_by_hr_id, c.name as customer_name
      from public.phoenix_crm_places pl
      join public.phoenix_crm_customers c on c.id = pl.customer_id
      where pl.shared_place_id = v_id and pl.status = 'active'
      order by pl.created_at
      -- NO `for update` row lock on the cursor, by choice: each row is locked by the `update` that
      -- retires it two lines below, the whole function runs in one transaction behind an advisory
      -- `lock_timeout`, and a venue is decided by one administrator at a time. (It also keeps the
      -- migration-hygiene sweep honest — it reads `for update of pl, c` and `for update\nloop` as
      -- writes to tables called `of` and `loop`.)
    loop
      update public.phoenix_crm_places pl
      set status = 'retired', retired_at = now(), retired_by_hr_id = v_actor, updated_at = now()
      where pl.id = v_seated.place_id;
      v_places := v_places + 1;

      insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
      values (
        v_venue.seat_id, v_seated.customer_id, v_seated.place_id, 'place_retired', v_actor,
        jsonb_build_object(
          'reason', coalesce(v_note, 'This place could not be confirmed.'),
          'label', v_seated.label, 'lat', v_seated.lat, 'lon', v_seated.lon,
          'why', 'shared_place_rejected', 'shared_place_id', v_id
        ),
        v_seated.is_test
      );

      if not exists (
        select 1 from public.phoenix_crm_places pl where pl.customer_id = v_seated.customer_id and pl.status = 'active'
      ) then
        update public.phoenix_crm_customers c
        set status = 'pending', validated_at = null, validated_by_hr_id = null, status_changed_at = now(), updated_at = now()
        where c.id = v_seated.customer_id and c.status = 'active';
        insert into public.phoenix_crm_list_events (seat_id, customer_id, event_type, actor_hr_id, details, is_test)
        values (
          v_venue.seat_id, v_seated.customer_id, 'customer_pending', v_actor,
          jsonb_build_object('why', 'shared_place_rejected', 'shared_place_id', v_id), v_seated.is_test
        );
      end if;

      -- 🔴 Read from the TABLE, deliberately, so it sees the reopen above — and it fires for a
      -- customer who was already pending, which the branch above never does.
      update public.phoenix_crm_customers c
      set reopened_at = now(), updated_at = now()
      where c.id = v_seated.customer_id and c.status = 'pending';

      -- Who the service tells, and about whom. The rep is the one who captured the TIMETABLE, never
      -- the person deciding: it is his photo.
      if exists (select 1 from public.phoenix_crm_customers c where c.id = v_seated.customer_id and c.status = 'pending') then
        v_reopened := v_reopened || jsonb_build_array(jsonb_build_object(
          'customer_id', v_seated.customer_id,
          'customer_name', v_seated.customer_name,
          'rep_hr_id', v_seated.created_by_hr_id,
          'is_test', v_seated.is_test
        ));
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'shared_place_id', v_id,
    'status', case when v_decision = 'approve' then 'active' else 'retired' end,
    'seat_id', v_venue.seat_id,
    'is_test', v_venue.is_test,
    'name', v_venue.name,
    'places_retired', v_places,
    'reopened', v_reopened,
    'refusal_reason', case when v_decision = 'reject' then v_reason else null end
  );
end;
$$;

revoke execute on function public.phoenix_crm_decide_shared_place(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_decide_shared_place(jsonb) to service_role;

-- 7 ─ Three visits a day inside one venue, at the door ───────────────────────────────────────────
--
-- 🔴 A TRIGGER AND NOT A LINE IN `phoenix_crm_save_visit` (27,663 bytes, live): the cap must hold at
-- EVERY door that writes a visit — the rep's save, the manager's entry for him and the administrator's
-- own entry all insert into this table — and a trigger is the only place that is true of. The module
-- already enforces a rule this way (`phoenix_crm_visits_pharmacy_name`), so it is the house pattern
-- rather than a new one.
--
-- It costs an ordinary visit ONE indexed lookup and nothing else: a place with no venue returns at the
-- second statement. The count is serialised by the advisory seat lock `phoenix_crm_save_visit` already
-- takes, and a venue belongs to exactly one seat, so two saves cannot both pass it.
create or replace function public.phoenix_crm_shared_place_day_cap()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_shared uuid;
  v_cap integer;
  v_placed integer;
begin
  if new.place_id is null then
    return new;
  end if;
  select pl.shared_place_id into v_shared from public.phoenix_crm_places pl where pl.id = new.place_id;
  if v_shared is null then
    return new;
  end if;

  -- The cap is the SETTING, never a constant (as pm_daily_cap and am_daily_cap are). A settings row
  -- that could not be read falls back to the owner's own number rather than to no cap at all.
  select s.shared_place_daily_cap into v_cap from public.phoenix_crm_settings s where s.id = 1;
  v_cap := coalesce(v_cap, 3);

  select count(*) into v_placed
  from public.phoenix_crm_visits v
  join public.phoenix_crm_places pl on pl.id = v.place_id
  where pl.shared_place_id = v_shared
    and v.visit_date = new.visit_date
    and v.is_test = new.is_test;

  if v_placed >= v_cap then
    raise exception 'phoenix_crm:shared_place_day_full';
  end if;
  return new;
end;
$$;

revoke execute on function public.phoenix_crm_shared_place_day_cap() from public, anon, authenticated;
grant execute on function public.phoenix_crm_shared_place_day_cap() to service_role;

create or replace trigger phoenix_crm_visits_shared_place_cap
  before insert on public.phoenix_crm_visits
  for each row
  execute function public.phoenix_crm_shared_place_day_cap();

notify pgrst, 'reload schema';

commit;
