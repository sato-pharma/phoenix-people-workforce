-- phoenix_crm_list_admission
--
-- WHAT THIS CHANGES (owner rulings, 2026-09-29 — the rep's flow rebuilt):
--   1. phoenix_crm_customers gains the status `outside` — a customer the rep validated at the door
--      who is NOT on his list yet — and `potential_grade` (AA|AB|AC|BA|BB|BC), which the district
--      manager sets when he approves an add. The potential grade is stored and shown; it drives
--      nothing. The A/B/C grade stays the one frequency and targets read.
--   2. phoenix_crm_places keeps BOTH readings of a validation: the *Capture location* pin
--      (pin_*) and the photo's own reading at the shutter (photo_*). lat/lon stay the fixed point
--      every reader already uses; they now hold the PHOTO's reading, falling back to the pin, and
--      point_source says which ("the photo + the location of photo is the more trustable" — his
--      ruling for marketing and direct orders the same day). A place can be MOVED only by the Super
--      Admin or the SFE Manager, with a written reason, and every move is an audited event.
--   3. phoenix_crm_list_requests gains the kinds `add` and `restore`, and a `stage` (manager|sfe).
--      drop, add and restore now go district manager → SFE; grade stays the district manager's
--      alone. The status words are unchanged, so every reader of status = 'pending' still works.
--   4. The functions that write those: insert_place, add_place, validate_customer (new `outside`
--      mode; `new` now files an add; `restore` now files a request; `reference` refuses an archived
--      customer), create_request, decide_request (stage-aware), withdraw_request (clears the stage),
--      and three new ones: archive_outside, move_place, restamp_visit_locations.
--
-- WHY: the owner, 2026-09-29. A rep never adds a customer to his own list: he validates him (photo,
--   location, days and hours) and his district manager, then SFE, admit him. Dropping and bringing
--   back take the same two steps. A drop no longer retires the customer's places — the clinic is
--   still where it was, and bringing him back must not demand a new photo.
--
-- Also fixed: validating a carried-over customer withdrew only the drop requests filed against his
--   CONTACT, never one filed against his customer row, while the screen promised it withdrew it.
--
-- EXPAND ONLY: nothing is dropped except CHECK constraints re-added wider. Every function keeps its
--   signature and accepts every input it accepted before; a decide call with no stage decides the
--   row's own stage.
--
-- ROLLBACK:
--   re-apply 20260922233000 (validate_customer, create_request), 20260922210000 (decide_request),
--   20260923020000 (insert_place) and the add_place / withdraw_request bodies from 20260916150000;
--   drop function public.phoenix_crm_archive_outside(jsonb), public.phoenix_crm_move_place(jsonb),
--   public.phoenix_crm_restamp_visit_locations(jsonb); the added columns can stay (all nullable or
--   defaulted). Re-narrowing the status and kind CHECKs needs every outside/add/restore row gone first.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;
set local lock_timeout = '5s';

-- ── 1. Customers: outside the list, and the potential grade ──────────────────────────────────────

-- SAFE: widening a CHECK to admit one more value; every existing row already satisfies the new form.
alter table public.phoenix_crm_customers drop constraint if exists phoenix_crm_customers_status;
alter table public.phoenix_crm_customers
  add constraint phoenix_crm_customers_status check (status in ('active', 'pending', 'dropped', 'outside'));

alter table public.phoenix_crm_customers
  add column if not exists potential_grade text;

alter table public.phoenix_crm_customers drop constraint if exists phoenix_crm_customers_potential_grade;
alter table public.phoenix_crm_customers
  add constraint phoenix_crm_customers_potential_grade
  check (potential_grade is null or potential_grade in ('AA', 'AB', 'AC', 'BA', 'BB', 'BC'));

comment on column public.phoenix_crm_customers.potential_grade is
  'The district manager''s read of the customer''s potential, set when he approves an add (owner, 2026-09-29). Stored and shown only: frequency, targets and every KPI read the A/B/C grade.';

-- ── 2. Places: both readings, and who moved it ───────────────────────────────────────────────────

alter table public.phoenix_crm_places
  add column if not exists pin_lat double precision,
  add column if not exists pin_lon double precision,
  add column if not exists pin_accuracy_meters numeric,
  add column if not exists photo_lat double precision,
  add column if not exists photo_lon double precision,
  add column if not exists photo_accuracy_meters numeric,
  add column if not exists photo_captured_at timestamptz,
  add column if not exists point_source text not null default 'pin',
  add column if not exists moved_at timestamptz,
  add column if not exists moved_by_hr_id text,
  add column if not exists move_reason text;

alter table public.phoenix_crm_places drop constraint if exists phoenix_crm_places_point_source;
alter table public.phoenix_crm_places
  add constraint phoenix_crm_places_point_source check (point_source in ('photo', 'pin', 'moved'));
alter table public.phoenix_crm_places drop constraint if exists phoenix_crm_places_move_reason;
alter table public.phoenix_crm_places
  add constraint phoenix_crm_places_move_reason
  check (move_reason is null or char_length(move_reason) between 10 and 500);
alter table public.phoenix_crm_places drop constraint if exists phoenix_crm_places_moved;
alter table public.phoenix_crm_places
  add constraint phoenix_crm_places_moved
  check ((point_source = 'moved') = (moved_at is not null and moved_by_hr_id is not null and move_reason is not null));

-- Every place written before today holds ONE reading, the pin, in lat/lon. Said so explicitly.
update public.phoenix_crm_places pl
set pin_lat = pl.lat, pin_lon = pl.lon, pin_accuracy_meters = pl.accuracy_meters
where pl.pin_lat is null;

comment on column public.phoenix_crm_places.pin_lat is
  'The Capture location pin, as the rep took it. Evidence; the fixed point is lat/lon.';
comment on column public.phoenix_crm_places.photo_lat is
  'The PHOTO''s own reading, taken fresh when the shutter fired — never a copy of the pin. NULL means not measured, never "same place".';
comment on column public.phoenix_crm_places.point_source is
  'Which reading lat/lon hold: photo (the shutter''s own fix — preferred), pin (no photo reading was taken), or moved (the Super Admin or the SFE Manager set it, with a reason).';

-- ── 3. Requests: add, restore, and two steps ─────────────────────────────────────────────────────

-- SAFE: widening a CHECK to admit two more kinds; every existing row already satisfies the new form.
alter table public.phoenix_crm_list_requests drop constraint if exists phoenix_crm_list_requests_kind;
alter table public.phoenix_crm_list_requests
  add constraint phoenix_crm_list_requests_kind check (kind in ('grade', 'drop', 'add', 'restore'));

-- SAFE: an add carries the rep's proposed grade exactly as a grade request does; a restore carries
-- neither a grade nor a reason. Every existing row (grade or drop) satisfies the new form.
alter table public.phoenix_crm_list_requests drop constraint if exists phoenix_crm_list_requests_kind_fields;
alter table public.phoenix_crm_list_requests
  add constraint phoenix_crm_list_requests_kind_fields check (
    (kind in ('grade', 'add')) = (proposed_grade is not null) and (kind = 'drop') = (drop_reason is not null)
  );

alter table public.phoenix_crm_list_requests
  add column if not exists stage text,
  add column if not exists manager_decided_by_hr_id text,
  add column if not exists manager_decided_at timestamptz,
  add column if not exists manager_note text,
  add column if not exists sfe_decided_by_hr_id text,
  add column if not exists sfe_decided_at timestamptz,
  add column if not exists sfe_note text,
  add column if not exists approved_grade text,
  add column if not exists potential_grade text;

-- A drop waiting today is waiting on its district manager: that is the first of its two steps now.
update public.phoenix_crm_list_requests q
set stage = 'manager'
where q.status = 'pending'
  and q.kind <> 'grade'
  and q.stage is null;

alter table public.phoenix_crm_list_requests drop constraint if exists phoenix_crm_list_requests_stage;
alter table public.phoenix_crm_list_requests
  add constraint phoenix_crm_list_requests_stage check (stage is null or stage in ('manager', 'sfe'));
alter table public.phoenix_crm_list_requests drop constraint if exists phoenix_crm_list_requests_stage_when_waiting;
alter table public.phoenix_crm_list_requests
  add constraint phoenix_crm_list_requests_stage_when_waiting
  check ((status = 'pending' and kind <> 'grade') = (stage is not null));
alter table public.phoenix_crm_list_requests drop constraint if exists phoenix_crm_list_requests_approved_grade;
alter table public.phoenix_crm_list_requests
  add constraint phoenix_crm_list_requests_approved_grade check (approved_grade is null or approved_grade in ('A', 'B', 'C'));
alter table public.phoenix_crm_list_requests drop constraint if exists phoenix_crm_list_requests_potential_grade;
alter table public.phoenix_crm_list_requests
  add constraint phoenix_crm_list_requests_potential_grade
  check (potential_grade is null or potential_grade in ('AA', 'AB', 'AC', 'BA', 'BB', 'BC'));
alter table public.phoenix_crm_list_requests drop constraint if exists phoenix_crm_list_requests_stage_notes;
alter table public.phoenix_crm_list_requests
  add constraint phoenix_crm_list_requests_stage_notes check (
    (manager_note is null or char_length(manager_note) <= 500) and (sfe_note is null or char_length(sfe_note) <= 500)
  );

comment on column public.phoenix_crm_list_requests.stage is
  'Who decides next while the request waits: manager (the territory''s district manager) then sfe. Null once decided, and always null for a grade request, which is one step.';

-- ── 4. A place is written with both readings ─────────────────────────────────────────────────────

create or replace function public.phoenix_crm_insert_place(
  p_customer_id uuid,
  p_seat_id text,
  p_actor_hr_id text,
  p_is_test boolean,
  p_place jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_captured_at timestamptz;
  v_place_id uuid;
  v_source text := coalesce(p_place ->> 'point_source', 'pin');
begin
  if jsonb_typeof(p_place) is distinct from 'object'
    or jsonb_typeof(p_place -> 'timings') is distinct from 'array'
    or nullif(trim(coalesce(p_place ->> 'photo_path', '')), '') is null then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- A caller that names no source sent one reading, the pin, in lat/lon — exactly as before today.
  if v_source not in ('photo', 'pin') then
    v_source := 'pin';
  end if;

  v_captured_at := public.phoenix_crm_take_photo(p_place ->> 'photo_path', p_actor_hr_id, p_seat_id, 'place', p_is_test);

  -- Every location column here is the SERVER's own resolution of the fixed point (server/list.ts
  -- placePayload), not anything the phone typed. The two raw readings are kept beside it as evidence.
  insert into public.phoenix_crm_places (
    customer_id, seat_id, label, address, brick_id, brick_name, brick_distance_km,
    area_code, area_name, region_code, region_name, zone, lat, lon, accuracy_meters,
    timings, photo_path, captured_at, device_skew_minutes, created_by_hr_id, is_test,
    pin_lat, pin_lon, pin_accuracy_meters, photo_lat, photo_lon, photo_accuracy_meters, photo_captured_at, point_source
  )
  values (
    p_customer_id,
    p_seat_id,
    nullif(trim(coalesce(p_place ->> 'label', '')), ''),
    nullif(trim(coalesce(p_place ->> 'address', '')), ''),
    nullif(trim(coalesce(p_place ->> 'brick_id', '')), ''),
    nullif(trim(coalesce(p_place ->> 'brick_name', '')), ''),
    (p_place ->> 'brick_distance_km')::numeric,
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
    v_source
  )
  returning id into v_place_id;

  return jsonb_build_object('place_id', v_place_id, 'captured_at', v_captured_at);
end;
$$;

-- Another clinic for a customer already validated — on the list, or waiting outside it.
create or replace function public.phoenix_crm_add_place(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_customer public.phoenix_crm_customers%rowtype;
  v_place jsonb;
begin
  if v_seat is null or v_actor is null or nullif(p ->> 'customer_id', '') is null then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select c.* into v_customer
  from public.phoenix_crm_customers c
  where c.id = (p ->> 'customer_id')::uuid
    and c.seat_id = v_seat
    and c.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:customer_not_found';
  end if;
  if v_customer.status not in ('active', 'outside') then
    raise exception 'phoenix_crm:customer_dropped';
  end if;
  if (select count(*) from public.phoenix_crm_places pl where pl.customer_id = v_customer.id and pl.status = 'active') >= 5 then
    raise exception 'phoenix_crm:too_many_places';
  end if;

  v_place := public.phoenix_crm_insert_place(v_customer.id, v_seat, v_actor, v_is_test, p -> 'place');

  insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
  values (v_seat, v_customer.id, (v_place ->> 'place_id')::uuid, 'place_added', v_actor, '{}'::jsonb, v_is_test);

  return v_place || jsonb_build_object('customer_id', v_customer.id, 'customer_name', v_customer.name);
end;
$$;

-- ── 5. Validating: a carried-over customer, an added one, one met outside the list ───────────────

create or replace function public.phoenix_crm_validate_customer(p jsonb)
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
  v_mode text := coalesce(p ->> 'mode', '');
  v_first_stage text := coalesce(nullif(p ->> 'first_stage', ''), 'manager');
  v_customer public.phoenix_crm_customers%rowtype;
  v_ref record;
  v_name text;
  v_list_type text;
  v_grade text;
  v_place jsonb;
  v_request_id uuid;
  v_request_kind text;
  v_event text := 'customer_validated';
begin
  if v_seat is null or v_line is null or v_actor is null or jsonb_typeof(p -> 'place') is distinct from 'object'
    or v_first_stage not in ('manager', 'sfe') then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  if v_mode = 'reference' then
    select r.* into v_ref
    from public.phoenix_crm_reference_entry(v_seat, (p ->> 'reference_contact_crm_id')::bigint, v_is_test) r;
    if not found then
      raise exception 'phoenix_crm:not_on_reference_list';
    end if;
    if v_ref.state = 'validated' then
      raise exception 'phoenix_crm:already_validated';
    end if;
    -- A customer in the Archive comes back only through "Ask to bring back" — the district manager,
    -- then SFE (owner, 2026-09-29). Re-validating him was a door around that decision.
    if v_ref.state = 'dropped' then
      raise exception 'phoenix_crm:archived';
    end if;

    if v_ref.customer_id is not null then
      perform 1 from public.phoenix_crm_customers c where c.id = v_ref.customer_id for update;

      update public.phoenix_crm_customers c
      set status = 'active',
          validated_at = now(),
          validated_by_hr_id = v_actor,
          dropped_reason = null,
          dropped_note = null,
          status_changed_at = now(),
          updated_at = now()
      where c.id = v_ref.customer_id
      returning c.* into v_customer;
    else
      insert into public.phoenix_crm_customers (
        seat_id, line_code, list_type, name, speciality, grade, origin, reference_contact_crm_id,
        status, validated_at, validated_by_hr_id, created_by_hr_id, is_test
      )
      values (
        v_seat, v_line, v_ref.list_type, left(v_ref.name, 200), left(v_ref.speciality, 120), v_ref.grade, 'reference', v_ref.contact_crm_id,
        'active', now(), v_actor, v_actor, v_is_test
      )
      returning * into v_customer;
    end if;

    -- Validating a customer whose drop was waiting is the rep's answer: the drop is withdrawn —
    -- whether it was filed against his contact or against his customer row.
    with withdrawn as (
      update public.phoenix_crm_list_requests q
      set status = 'withdrawn',
          stage = null,
          decided_at = now(),
          decided_by_hr_id = v_actor,
          decision_note = 'Validated instead of dropped'
      where q.seat_id = v_seat
        and q.is_test = v_is_test
        and q.kind = 'drop'
        and q.status = 'pending'
        and (
          q.customer_id = v_customer.id
          or (q.customer_id is null and q.reference_contact_crm_id = v_ref.contact_crm_id)
        )
      returning q.id
    )
    insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
    select v_seat, v_customer.id, w.id, 'request_withdrawn', v_actor, jsonb_build_object('why', 'validated'), v_is_test
    from withdrawn w;

  elsif v_mode in ('new', 'outside') then
    -- Both are a customer the rep met who is not on his list. `new` is "Add new customer" and files
    -- the add at once, with the grade he proposes. `outside` is the out-of-list visit: the customer
    -- waits on his list for him to choose "Request to add" or "Drop".
    v_name := nullif(regexp_replace(trim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'), '');
    v_list_type := coalesce(p ->> 'list_type', '');
    v_grade := nullif(p ->> 'proposed_grade', '');
    if v_name is null or v_list_type not in ('AM', 'PM')
      or (v_mode = 'new' and coalesce(v_grade, '') not in ('A', 'B', 'C'))
      or (v_grade is not null and v_grade not in ('A', 'B', 'C')) then
      raise exception 'phoenix_crm:bad_input';
    end if;
    if not coalesce((p ->> 'allow_same_name')::boolean, false) and exists (
      select 1
      from public.phoenix_crm_customers c
      where c.seat_id = v_seat
        and c.is_test = v_is_test
        and c.status in ('active', 'pending', 'outside')
        and c.list_type = v_list_type
        and lower(c.name) = lower(v_name)
    ) then
      raise exception 'phoenix_crm:same_name';
    end if;

    -- Outside the list: validated at the door, but validated_at stays NULL until the district manager
    -- and SFE admit him. Every report counts a customer's visits only once validated_at is set, so
    -- his visits start counting on admission, in the month they happened, and never if he is dropped.
    insert into public.phoenix_crm_customers (
      seat_id, line_code, list_type, name, speciality, grade, origin, status, validated_at,
      validated_by_hr_id, created_by_hr_id, is_test
    )
    values (
      v_seat, v_line, v_list_type, v_name, nullif(trim(coalesce(p ->> 'speciality', '')), ''), null, 'new', 'outside', null,
      null, v_actor, v_is_test
    )
    returning * into v_customer;
    v_event := 'customer_met_outside';

    if v_mode = 'new' then
      insert into public.phoenix_crm_list_requests (
        seat_id, line_code, kind, customer_id, list_type, customer_name, current_grade, proposed_grade,
        requested_by_hr_id, is_test, stage
      )
      values (v_seat, v_line, 'add', v_customer.id, v_list_type, v_name, null, v_grade, v_actor, v_is_test, v_first_stage)
      returning id into v_request_id;
      v_request_kind := 'add';
    end if;

  elsif v_mode = 'restore' then
    -- Kept for callers that still send a fresh place with "Bring back": the place is kept as
    -- evidence, and the customer stays in the Archive until the district manager and SFE decide.
    select c.* into v_customer
    from public.phoenix_crm_customers c
    where c.id = (p ->> 'customer_id')::uuid
      and c.seat_id = v_seat
      and c.is_test = v_is_test
    for update;
    if not found then
      raise exception 'phoenix_crm:customer_not_found';
    end if;
    if v_customer.status <> 'dropped' then
      raise exception 'phoenix_crm:already_validated';
    end if;
    -- Never admitted (met outside the list, then dropped): he comes back through "Request to add",
    -- which is where his grade and potential grade are set — never through a bring-back.
    if v_customer.origin = 'new' and v_customer.validated_at is null then
      raise exception 'phoenix_crm:not_archived';
    end if;
    if exists (
      select 1 from public.phoenix_crm_list_requests q
      where q.customer_id = v_customer.id and q.status = 'pending' and q.kind = 'restore'
    ) then
      raise exception 'phoenix_crm:already_pending';
    end if;
    v_request_kind := 'restore';
    insert into public.phoenix_crm_list_requests (
      seat_id, line_code, kind, customer_id, reference_contact_crm_id, list_type, customer_name, current_grade,
      requested_by_hr_id, is_test, stage
    )
    values (
      v_seat, v_customer.line_code, 'restore', v_customer.id, v_customer.reference_contact_crm_id, v_customer.list_type,
      v_customer.name, v_customer.grade, v_actor, v_is_test, v_first_stage
    )
    returning id into v_request_id;
    v_event := 'place_added';

  else
    raise exception 'phoenix_crm:bad_input';
  end if;

  v_place := public.phoenix_crm_insert_place(v_customer.id, v_seat, v_actor, v_is_test, p -> 'place');

  insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, v_customer.id, (v_place ->> 'place_id')::uuid, v_event, v_actor,
    jsonb_build_object('mode', v_mode, 'reference_contact_crm_id', v_customer.reference_contact_crm_id),
    v_is_test
  );
  if v_request_id is not null then
    insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
    values (
      v_seat, v_customer.id, v_request_id, 'request_created', v_actor,
      jsonb_build_object('kind', v_request_kind, 'proposed_grade', v_grade, 'stage', v_first_stage), v_is_test
    );
  end if;

  return jsonb_build_object(
    'customer_id', v_customer.id,
    'customer_name', v_customer.name,
    'list_type', v_customer.list_type,
    'status', v_customer.status,
    'place_id', v_place ->> 'place_id',
    'captured_at', v_place ->> 'captured_at',
    'restored', false,
    'grade_request_id', v_request_id,
    'request_id', v_request_id,
    'request_kind', v_request_kind
  );
end;
$$;

-- ── 6. Asking: a grade, a drop, an add, a bring-back ─────────────────────────────────────────────

create or replace function public.phoenix_crm_create_request(p jsonb)
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
  v_kind text := coalesce(p ->> 'kind', '');
  v_customer_id uuid := nullif(p ->> 'customer_id', '')::uuid;
  v_contact bigint := nullif(p ->> 'reference_contact_crm_id', '')::bigint;
  v_grade text := nullif(p ->> 'proposed_grade', '');
  v_reason text := nullif(p ->> 'drop_reason', '');
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_first_stage text := coalesce(nullif(p ->> 'first_stage', ''), 'manager');
  v_customer public.phoenix_crm_customers%rowtype;
  v_ref record;
  v_name text;
  v_list_type text;
  v_current_grade text;
  v_never_admitted boolean;
  v_id uuid;
begin
  if v_seat is null or v_line is null or v_actor is null or v_kind not in ('grade', 'drop', 'add', 'restore')
    or (v_customer_id is null and v_contact is null)
    or v_first_stage not in ('manager', 'sfe') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_kind in ('grade', 'add') and coalesce(v_grade, '') not in ('A', 'B', 'C') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_kind = 'drop' and coalesce(v_reason, '') not in ('moved', 'retired', 'closed', 'not_target', 'duplicate', 'other') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_kind = 'drop' and v_reason = 'other' and v_note is null then
    raise exception 'phoenix_crm:note_required';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  if v_customer_id is null then
    select r.* into v_ref
    from public.phoenix_crm_reference_entry(v_seat, v_contact, v_is_test) r;
    if not found then
      raise exception 'phoenix_crm:not_on_reference_list';
    end if;
    if v_ref.customer_id is not null then
      v_customer_id := v_ref.customer_id;
    elsif v_kind <> 'drop' then
      raise exception 'phoenix_crm:not_validated';
    else
      v_name := v_ref.name;
      v_list_type := v_ref.list_type;
      v_current_grade := v_ref.grade;
    end if;
  end if;

  if v_customer_id is not null then
    select c.* into v_customer
    from public.phoenix_crm_customers c
    where c.id = v_customer_id
      and c.seat_id = v_seat
      and c.is_test = v_is_test
    for update;
    if not found then
      raise exception 'phoenix_crm:customer_not_found';
    end if;
    -- Never admitted: met outside the list, or added and then dropped before anyone approved him.
    v_never_admitted := v_customer.origin = 'new' and v_customer.validated_at is null;

    if v_kind in ('grade', 'drop') then
      if v_customer.status = 'dropped' then
        raise exception 'phoenix_crm:customer_dropped';
      end if;
      -- A customer outside the list is dropped by the rep himself, straight to the Archive
      -- (phoenix_crm_archive_outside) — nothing of his is on the list to take off.
      if v_customer.status = 'outside' then
        raise exception 'phoenix_crm:not_on_list';
      end if;
    end if;
    -- A customer who is not validated yet can be dropped off the list, but his grade decides his visit
    -- target, so it is only proposed once he is real.
    if v_kind = 'grade' and v_customer.status <> 'active' then
      raise exception 'phoenix_crm:not_validated';
    end if;
    if v_kind = 'grade' and v_customer.grade is not distinct from v_grade then
      raise exception 'phoenix_crm:same_grade';
    end if;
    if v_kind = 'add' and not (v_customer.status = 'outside' or (v_customer.status = 'dropped' and v_never_admitted)) then
      raise exception 'phoenix_crm:not_outside';
    end if;
    if v_kind = 'restore' and not (v_customer.status = 'dropped' and not v_never_admitted) then
      raise exception 'phoenix_crm:not_archived';
    end if;
    v_name := v_customer.name;
    v_list_type := v_customer.list_type;
    v_current_grade := v_customer.grade;
    v_contact := v_customer.reference_contact_crm_id;
  end if;

  if exists (
    select 1
    from public.phoenix_crm_list_requests q
    where q.seat_id = v_seat
      and q.is_test = v_is_test
      and q.kind = v_kind
      and q.status = 'pending'
      and (
        (v_customer_id is not null and q.customer_id = v_customer_id)
        or (v_customer_id is null and q.customer_id is null and q.reference_contact_crm_id = v_contact)
      )
  ) then
    raise exception 'phoenix_crm:already_pending';
  end if;

  insert into public.phoenix_crm_list_requests (
    seat_id, line_code, kind, customer_id, reference_contact_crm_id, list_type, customer_name,
    current_grade, proposed_grade, drop_reason, note, requested_by_hr_id, is_test, stage
  )
  values (
    v_seat, v_line, v_kind, v_customer_id, v_contact, v_list_type, v_name,
    v_current_grade,
    case when v_kind in ('grade', 'add') then v_grade end,
    case when v_kind = 'drop' then v_reason end,
    v_note, v_actor, v_is_test,
    case when v_kind = 'grade' then null else v_first_stage end
  )
  returning id into v_id;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, v_customer_id, v_id, 'request_created', v_actor,
    jsonb_build_object(
      'kind', v_kind, 'proposed_grade', v_grade, 'drop_reason', v_reason, 'reference_contact_crm_id', v_contact,
      'stage', case when v_kind = 'grade' then null else v_first_stage end
    ),
    v_is_test
  );

  return jsonb_build_object(
    'request_id', v_id,
    'kind', v_kind,
    'stage', case when v_kind = 'grade' then null else v_first_stage end,
    'customer_id', v_customer_id,
    'customer_name', v_name,
    'list_type', v_list_type
  );
end;
$$;

-- ── 7. Deciding: one step for a grade, two for everything else ───────────────────────────────────
--
--   p: request_id, actor_hr_id, is_test, decision ('approve' | 'refuse'), note,
--      stage (optional: the step the caller believes it is deciding — refused if it is not the row's),
--      approved_grade (an add, at the manager's step: the A/B/C he confirms; defaults to the proposal),
--      potential_grade (an add, at the manager's step: AA..BC, required there).

create or replace function public.phoenix_crm_decide_request(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_request_id uuid := nullif(p ->> 'request_id', '')::uuid;
  v_decision text := coalesce(p ->> 'decision', '');
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_stage_in text := nullif(p ->> 'stage', '');
  v_approved_in text := nullif(p ->> 'approved_grade', '');
  v_potential_in text := nullif(p ->> 'potential_grade', '');
  v_request public.phoenix_crm_list_requests%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_status text;
  v_final boolean := true;
begin
  if v_actor is null or v_request_id is null or v_decision not in ('approve', 'refuse') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if (v_approved_in is not null and v_approved_in not in ('A', 'B', 'C'))
    or (v_potential_in is not null and v_potential_in not in ('AA', 'AB', 'AC', 'BA', 'BB', 'BC')) then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select q.* into v_request
  from public.phoenix_crm_list_requests q
  where q.id = v_request_id
    and q.is_test = v_is_test;
  if not found then
    raise exception 'phoenix_crm:request_not_found';
  end if;
  v_seat := v_request.seat_id;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select q.* into v_request
  from public.phoenix_crm_list_requests q
  where q.id = v_request_id
  for update;
  if v_request.status <> 'pending' then
    raise exception 'phoenix_crm:request_decided';
  end if;
  -- Two people deciding at once: the second one's step has already moved on.
  if v_stage_in is not null and v_stage_in is distinct from v_request.stage then
    raise exception 'phoenix_crm:request_wrong_stage';
  end if;

  -- ── The district manager's step of a two-step request: approving hands it to SFE ──────────────
  if v_decision = 'approve' and v_request.stage = 'manager' then
    if v_request.kind = 'add' then
      if v_potential_in is null then
        raise exception 'phoenix_crm:potential_grade_required';
      end if;
      v_approved_in := coalesce(v_approved_in, v_request.proposed_grade);
    else
      v_approved_in := null;
      v_potential_in := null;
    end if;

    update public.phoenix_crm_list_requests q
    set stage = 'sfe',
        manager_decided_by_hr_id = v_actor,
        manager_decided_at = now(),
        manager_note = v_note,
        approved_grade = v_approved_in,
        potential_grade = v_potential_in
    where q.id = v_request.id
    returning q.* into v_request;

    insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
    values (
      v_seat, v_request.customer_id, v_request.id, 'request_moved_on', v_actor,
      jsonb_build_object('kind', v_request.kind, 'to_stage', 'sfe', 'approved_grade', v_approved_in, 'potential_grade', v_potential_in),
      v_is_test
    );

    return jsonb_build_object(
      'request_id', v_request.id,
      'seat_id', v_seat,
      'kind', v_request.kind,
      'status', 'pending',
      'stage', 'sfe',
      'final', false,
      'customer_id', v_request.customer_id,
      'customer_name', v_request.customer_name,
      'list_type', v_request.list_type,
      'proposed_grade', v_request.proposed_grade,
      'drop_reason', v_request.drop_reason,
      'requested_by_hr_id', v_request.requested_by_hr_id
    );
  end if;

  if v_decision = 'approve' then
    v_status := 'approved';

    if v_request.kind = 'grade' then
      select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_request.customer_id for update;
      if not found or v_customer.status <> 'active' then
        raise exception 'phoenix_crm:customer_dropped';
      end if;
      update public.phoenix_crm_customers c
      set grade = v_request.proposed_grade, updated_at = now()
      where c.id = v_customer.id;

      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      values (
        v_seat, v_customer.id, v_request.id, 'grade_changed', v_actor,
        jsonb_build_object('from', v_customer.grade, 'to', v_request.proposed_grade), v_is_test
      );

    elsif v_request.kind = 'add' then
      select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_request.customer_id for update;
      if not found or not (
        v_customer.status = 'outside'
        or (v_customer.status = 'dropped' and v_customer.origin = 'new' and v_customer.validated_at is null)
      ) then
        raise exception 'phoenix_crm:not_outside';
      end if;
      -- Admitted. validated_at is set NOW: the customer was validated at the door, and every visit
      -- logged against him since starts counting, in the month it happened (owner, 2026-09-29).
      update public.phoenix_crm_customers c
      set status = 'active',
          validated_at = now(),
          validated_by_hr_id = v_request.requested_by_hr_id,
          grade = coalesce(v_request.approved_grade, v_approved_in, v_request.proposed_grade),
          potential_grade = coalesce(v_request.potential_grade, v_potential_in),
          dropped_reason = null,
          dropped_note = null,
          status_changed_at = now(),
          updated_at = now()
      where c.id = v_customer.id
      returning c.* into v_customer;

      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      values (
        v_seat, v_customer.id, v_request.id, 'customer_admitted', v_actor,
        jsonb_build_object('grade', v_customer.grade, 'potential_grade', v_customer.potential_grade), v_is_test
      );

    elsif v_request.kind = 'restore' then
      select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_request.customer_id for update;
      if not found or v_customer.status <> 'dropped' then
        raise exception 'phoenix_crm:not_archived';
      end if;
      -- Back where he was: on the list if he had been validated, waiting to be validated if not.
      update public.phoenix_crm_customers c
      set status = case when c.validated_at is not null then 'active' else 'pending' end,
          dropped_reason = null,
          dropped_note = null,
          status_changed_at = now(),
          updated_at = now()
      where c.id = v_customer.id
      returning c.* into v_customer;

      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      values (v_seat, v_customer.id, v_request.id, 'customer_restored', v_actor, jsonb_build_object('to', v_customer.status), v_is_test);

    elsif v_request.customer_id is not null then
      select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_request.customer_id for update;
      -- Active or pending: both leave the list. A pending one keeps validated_at null, so the visits
      -- logged against him never start counting — he was never validated. His places are KEPT
      -- (owner, 2026-09-29): the clinic is still where it was, and a bring-back needs no new photo.
      if not found or v_customer.status = 'dropped' then
        raise exception 'phoenix_crm:customer_dropped';
      end if;
      update public.phoenix_crm_customers c
      set status = 'dropped',
          dropped_reason = v_request.drop_reason,
          dropped_note = v_request.note,
          status_changed_at = now(),
          updated_at = now()
      where c.id = v_customer.id;

      with withdrawn as (
        update public.phoenix_crm_list_requests q
        set status = 'withdrawn',
            stage = null,
            decided_at = now(),
            decided_by_hr_id = v_actor,
            decision_note = 'The customer left the list'
        where q.customer_id = v_customer.id
          and q.status = 'pending'
          and q.id <> v_request.id
        returning q.id
      )
      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      select v_seat, v_customer.id, w.id, 'request_withdrawn', v_actor, jsonb_build_object('why', 'dropped'), v_is_test
      from withdrawn w;

      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      values (
        v_seat, v_customer.id, v_request.id, 'customer_dropped', v_actor,
        jsonb_build_object('reason', v_request.drop_reason), v_is_test
      );

    else
      select c.* into v_customer
      from public.phoenix_crm_customers c
      where c.seat_id = v_seat
        and c.reference_contact_crm_id = v_request.reference_contact_crm_id
        and c.is_test = v_is_test
      for update;
      if found then
        if v_customer.status = 'active' then
          raise exception 'phoenix_crm:already_validated';
        end if;
        if v_customer.status = 'dropped' then
          raise exception 'phoenix_crm:customer_dropped';
        end if;
        -- Pending: the customer was carried over from iReports360 and never validated.
        update public.phoenix_crm_customers c
        set status = 'dropped',
            dropped_reason = v_request.drop_reason,
            dropped_note = v_request.note,
            status_changed_at = now(),
            updated_at = now()
        where c.id = v_customer.id
        returning c.* into v_customer;
      else
        insert into public.phoenix_crm_customers (
          seat_id, line_code, list_type, name, grade, origin, reference_contact_crm_id, status, validated_at,
          dropped_reason, dropped_note, status_changed_at, created_by_hr_id, is_test
        )
        values (
          v_seat, v_request.line_code, v_request.list_type, left(v_request.customer_name, 200), v_request.current_grade, 'reference',
          v_request.reference_contact_crm_id, 'dropped', null, v_request.drop_reason, v_request.note, now(),
          v_request.requested_by_hr_id, v_is_test
        )
        returning * into v_customer;
      end if;

      update public.phoenix_crm_list_requests q set customer_id = v_customer.id where q.id = v_request.id;

      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      values (
        v_seat, v_customer.id, v_request.id, 'customer_dropped', v_actor,
        jsonb_build_object('reason', v_request.drop_reason, 'reference_contact_crm_id', v_request.reference_contact_crm_id),
        v_is_test
      );
    end if;
  else
    v_status := 'refused';

    -- A refused add sends the customer to the Archive: he was never admitted, and the rep can still
    -- ask again from there.
    if v_request.kind = 'add' then
      select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_request.customer_id for update;
      if found and v_customer.status = 'outside' then
        update public.phoenix_crm_customers c
        set status = 'dropped',
            dropped_reason = 'not_admitted',
            dropped_note = v_note,
            status_changed_at = now(),
            updated_at = now()
        where c.id = v_customer.id
        returning c.* into v_customer;

        insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
        values (v_seat, v_customer.id, v_request.id, 'customer_archived', v_actor, jsonb_build_object('why', 'add_refused'), v_is_test);
      end if;
    end if;
  end if;

  update public.phoenix_crm_list_requests q
  set status = v_status,
      stage = null,
      decided_at = now(),
      decided_by_hr_id = v_actor,
      decision_note = v_note,
      manager_decided_by_hr_id = case when v_request.stage = 'manager' then v_actor else q.manager_decided_by_hr_id end,
      manager_decided_at = case when v_request.stage = 'manager' then now() else q.manager_decided_at end,
      manager_note = case when v_request.stage = 'manager' then v_note else q.manager_note end,
      sfe_decided_by_hr_id = case when v_request.stage = 'sfe' then v_actor else q.sfe_decided_by_hr_id end,
      sfe_decided_at = case when v_request.stage = 'sfe' then now() else q.sfe_decided_at end,
      sfe_note = case when v_request.stage = 'sfe' then v_note else q.sfe_note end,
      potential_grade = coalesce(q.potential_grade, case when v_request.kind = 'add' and v_status = 'approved' then v_potential_in end)
  where q.id = v_request.id;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, coalesce(v_customer.id, v_request.customer_id), v_request.id, 'request_decided', v_actor,
    jsonb_build_object('kind', v_request.kind, 'decision', v_status, 'stage', v_request.stage), v_is_test
  );

  return jsonb_build_object(
    'request_id', v_request.id,
    'seat_id', v_seat,
    'kind', v_request.kind,
    'status', v_status,
    'stage', null,
    'final', v_final,
    'customer_id', coalesce(v_customer.id, v_request.customer_id),
    'customer_name', v_request.customer_name,
    'list_type', v_request.list_type,
    'proposed_grade', v_request.proposed_grade,
    'drop_reason', v_request.drop_reason,
    'requested_by_hr_id', v_request.requested_by_hr_id
  );
end;
$$;

-- ── 8. Withdrawing a request clears its step too ─────────────────────────────────────────────────

create or replace function public.phoenix_crm_withdraw_request(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_request public.phoenix_crm_list_requests%rowtype;
begin
  if v_seat is null or v_actor is null or nullif(p ->> 'request_id', '') is null then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select q.* into v_request
  from public.phoenix_crm_list_requests q
  where q.id = (p ->> 'request_id')::uuid
    and q.seat_id = v_seat
    and q.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:request_not_found';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'phoenix_crm:request_decided';
  end if;

  update public.phoenix_crm_list_requests q
  set status = 'withdrawn', stage = null, decided_at = now(), decided_by_hr_id = v_actor
  where q.id = v_request.id;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
  values (v_seat, v_request.customer_id, v_request.id, 'request_withdrawn', v_actor, jsonb_build_object('kind', v_request.kind), v_is_test);

  return jsonb_build_object('request_id', v_request.id, 'kind', v_request.kind, 'customer_name', v_request.customer_name);
end;
$$;

-- ── 9. The rep drops a customer he met outside his list: straight to the Archive ─────────────────

create or replace function public.phoenix_crm_archive_outside(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_customer public.phoenix_crm_customers%rowtype;
begin
  if v_seat is null or v_actor is null or nullif(p ->> 'customer_id', '') is null
    or (v_note is not null and char_length(v_note) > 500) then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select c.* into v_customer
  from public.phoenix_crm_customers c
  where c.id = (p ->> 'customer_id')::uuid
    and c.seat_id = v_seat
    and c.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:customer_not_found';
  end if;
  if v_customer.status <> 'outside' then
    raise exception 'phoenix_crm:not_outside';
  end if;

  update public.phoenix_crm_customers c
  set status = 'dropped',
      dropped_reason = 'not_added',
      dropped_note = v_note,
      status_changed_at = now(),
      updated_at = now()
  where c.id = v_customer.id
  returning c.* into v_customer;

  with withdrawn as (
    update public.phoenix_crm_list_requests q
    set status = 'withdrawn',
        stage = null,
        decided_at = now(),
        decided_by_hr_id = v_actor,
        decision_note = 'Dropped by the rep'
    where q.customer_id = v_customer.id
      and q.status = 'pending'
    returning q.id
  )
  insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
  select v_seat, v_customer.id, w.id, 'request_withdrawn', v_actor, jsonb_build_object('why', 'archived'), v_is_test
  from withdrawn w;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, event_type, actor_hr_id, details, is_test)
  values (v_seat, v_customer.id, 'customer_archived', v_actor, jsonb_build_object('why', 'rep_dropped'), v_is_test);

  return jsonb_build_object('customer_id', v_customer.id, 'customer_name', v_customer.name, 'status', v_customer.status);
end;
$$;

-- ── 10. Moving a place: the Super Admin or the SFE Manager, with a reason, audited ───────────────
--
-- The caller (server/place-move.ts) has already checked WHO may move it and resolved the new point
-- into address, brick, area and region, exactly as a capture is resolved. This writes it, keeps both
-- original readings untouched, and records before and after.

create or replace function public.phoenix_crm_move_place(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_reason text := nullif(regexp_replace(trim(coalesce(p ->> 'reason', '')), '\s+', ' ', 'g'), '');
  v_to jsonb := p -> 'location';
  v_place public.phoenix_crm_places%rowtype;
  v_after public.phoenix_crm_places%rowtype;
begin
  if v_seat is null or v_actor is null or nullif(p ->> 'place_id', '') is null
    or jsonb_typeof(v_to) is distinct from 'object'
    or (v_to ->> 'lat') is null or (v_to ->> 'lon') is null then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_reason is null or char_length(v_reason) < 10 or char_length(v_reason) > 500 then
    raise exception 'phoenix_crm:move_reason_required';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select pl.* into v_place
  from public.phoenix_crm_places pl
  where pl.id = (p ->> 'place_id')::uuid
    and pl.seat_id = v_seat
    and pl.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:place_not_found';
  end if;
  if v_place.status <> 'active' then
    raise exception 'phoenix_crm:place_retired';
  end if;

  update public.phoenix_crm_places pl
  set lat = (v_to ->> 'lat')::double precision,
      lon = (v_to ->> 'lon')::double precision,
      accuracy_meters = (v_to ->> 'accuracy_meters')::numeric,
      address = nullif(trim(coalesce(v_to ->> 'address', '')), ''),
      zone = nullif(trim(coalesce(v_to ->> 'zone', '')), ''),
      brick_id = nullif(trim(coalesce(v_to ->> 'brick_id', '')), ''),
      brick_name = nullif(trim(coalesce(v_to ->> 'brick_name', '')), ''),
      brick_distance_km = (v_to ->> 'brick_distance_km')::numeric,
      area_code = nullif(trim(coalesce(v_to ->> 'area_code', '')), ''),
      area_name = nullif(trim(coalesce(v_to ->> 'area_name', '')), ''),
      region_code = nullif(trim(coalesce(v_to ->> 'region_code', '')), ''),
      region_name = nullif(trim(coalesce(v_to ->> 'region_name', '')), ''),
      point_source = 'moved',
      moved_at = now(),
      moved_by_hr_id = v_actor,
      move_reason = v_reason,
      updated_at = now()
  where pl.id = v_place.id
  returning pl.* into v_after;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, v_place.customer_id, v_place.id, 'place_moved', v_actor,
    jsonb_build_object(
      'reason', v_reason,
      'before', jsonb_build_object(
        'lat', v_place.lat, 'lon', v_place.lon, 'point_source', v_place.point_source,
        'address', v_place.address, 'brick_id', v_place.brick_id, 'area_code', v_place.area_code
      ),
      'after', jsonb_build_object(
        'lat', v_after.lat, 'lon', v_after.lon,
        'address', v_after.address, 'brick_id', v_after.brick_id, 'area_code', v_after.area_code
      )
    ),
    v_is_test
  );

  return jsonb_build_object('place_id', v_after.id, 'customer_id', v_after.customer_id, 'moved_at', v_after.moved_at);
end;
$$;

-- ── 11. A customer's earlier visits measured against his place ───────────────────────────────────
--
-- A visit logged before the customer was validated (or before his place was moved) was saved with
-- no place to measure against. The distance is computed ONCE, in TypeScript (geo.ts
-- checkVisitLocation), and written here, scoped to one customer of one territory.

create or replace function public.phoenix_crm_restamp_visit_locations(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_customer_id uuid := nullif(p ->> 'customer_id', '')::uuid;
  v_items jsonb := coalesce(p -> 'items', '[]'::jsonb);
  v_count integer;
begin
  if v_seat is null or v_actor is null or v_customer_id is null or jsonb_typeof(v_items) is distinct from 'array' then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(v_items) as x (visit_id uuid, place_id uuid, distance_meters integer, location_flag text)
    where x.visit_id is null or x.location_flag not in ('ok', 'far', 'weak_gps', 'no_place')
      or (x.distance_meters is not null and x.distance_meters < 0)
  ) then
    raise exception 'phoenix_crm:bad_input';
  end if;

  with changed as (
    update public.phoenix_crm_visits v
    set place_id = x.place_id,
        distance_meters = x.distance_meters,
        location_flag = x.location_flag
    from jsonb_to_recordset(v_items) as x (visit_id uuid, place_id uuid, distance_meters integer, location_flag text)
    where v.id = x.visit_id
      and v.customer_id = v_customer_id
      and v.seat_id = v_seat
      and v.is_test = v_is_test
      and (x.place_id is null or exists (
        select 1 from public.phoenix_crm_places pl where pl.id = x.place_id and pl.customer_id = v_customer_id
      ))
    returning v.id
  )
  select count(*)::integer into v_count from changed;

  if v_count > 0 then
    insert into public.phoenix_crm_list_events (seat_id, customer_id, event_type, actor_hr_id, details, is_test)
    values (v_seat, v_customer_id, 'visit_locations_restamped', v_actor, jsonb_build_object('visits', v_count), v_is_test);
  end if;

  return jsonb_build_object('customer_id', v_customer_id, 'visits', v_count);
end;
$$;

-- `create or replace` keeps each existing ACL; restated for the replaced functions so the file reads
-- on its own and `check:migrations` sees the revoke from PUBLIC. The three new functions are taken
-- from everyone and given to the service role alone.
revoke execute on function public.phoenix_crm_insert_place(uuid, text, text, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_insert_place(uuid, text, text, boolean, jsonb) to service_role;
revoke execute on function public.phoenix_crm_add_place(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_add_place(jsonb) to service_role;
revoke execute on function public.phoenix_crm_validate_customer(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_validate_customer(jsonb) to service_role;
revoke execute on function public.phoenix_crm_create_request(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_create_request(jsonb) to service_role;
revoke execute on function public.phoenix_crm_decide_request(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_decide_request(jsonb) to service_role;
revoke execute on function public.phoenix_crm_withdraw_request(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_withdraw_request(jsonb) to service_role;
revoke execute on function public.phoenix_crm_archive_outside(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_archive_outside(jsonb) to service_role;
revoke execute on function public.phoenix_crm_move_place(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_move_place(jsonb) to service_role;
revoke execute on function public.phoenix_crm_restamp_visit_locations(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_restamp_visit_locations(jsonb) to service_role;

notify pgrst, 'reload schema';
commit;
