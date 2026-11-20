-- phoenix_crm_admin_photo_validations
--
-- WHAT THIS CHANGES:
--   * a new table, public.phoenix_crm_admin_photo_validations: the Super Admin's photo-upload validation
--     for a rep — his uploaded photo, the watch he switches on, and the rep's live location reading
--     taken while the watch is on;
--   * a new column, public.phoenix_crm_places.admin_photo_by_hr_id: who uploaded the photo of a place the
--     Super Admin validated for a rep (null on every other place);
--   * the phoenix_crm_places_timings CHECK also admits an empty timings list on such a place (the rep adds
--     the days and hours as usual, exactly as on a trusted-point place);
--   * a new function, public.phoenix_crm_validate_with_admin_photo(jsonb): writes the place and validates
--     the customer in one transaction, under the seat's lock.
-- WHY: owner, 20 Nov 2026 — "must have a photo except i tell u", then "the system administrator can
--   validate for someone and upload a photo manually instead of the live", then "make a button for me to
--   press on watch the rep while capturing location ... while this button is on, the rep will capture the
--   location. You will capture his location and put it here." The place is the uploaded photo plus the
--   rep's own live GPS reading; nothing is validated without both.
-- ROLLBACK:
--   drop function if exists public.phoenix_crm_validate_with_admin_photo(jsonb);
--   alter table public.phoenix_crm_places drop constraint phoenix_crm_places_timings;
--   alter table public.phoenix_crm_places add constraint phoenix_crm_places_timings check (jsonb_typeof(timings) = 'array'
--     and jsonb_array_length(timings) <= 60 and (jsonb_array_length(timings) >= 1 or trusted_basis is not null));
--     (fails while a validated admin-photo place still has no timings — retire or fill those first)
--   alter table public.phoenix_crm_places drop column admin_photo_by_hr_id;
--   drop table public.phoenix_crm_admin_photo_validations;  -- loses the watch history
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: one new table, one nullable column, one widened CHECK, one function.

begin;
set local lock_timeout = '5s';

create table if not exists public.phoenix_crm_admin_photo_validations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.phoenix_crm_customers (id),
  seat_id text not null,
  is_test boolean not null default false,
  photo_path text not null,
  status text not null default 'watching',
  armed_by_hr_id text not null,
  armed_at timestamptz not null default now(),
  watch_until timestamptz not null,
  rep_hr_id text,
  rep_lat double precision,
  rep_lon double precision,
  rep_accuracy_meters numeric,
  rep_captured_at timestamptz,
  place_id uuid references public.phoenix_crm_places (id),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint phoenix_crm_admin_photo_validations_status check (status in ('watching', 'captured', 'validated', 'cancelled')),
  constraint phoenix_crm_admin_photo_validations_reading check (
    (rep_captured_at is null) = (rep_lat is null)
    and (rep_lat is null) = (rep_lon is null)
    and (rep_lat is null) = (rep_hr_id is null)
  ),
  constraint phoenix_crm_admin_photo_validations_captured check (status not in ('captured', 'validated') or rep_lat is not null),
  constraint phoenix_crm_admin_photo_validations_validated check ((status = 'validated') = (place_id is not null)),
  constraint phoenix_crm_admin_photo_validations_closed check ((status in ('validated', 'cancelled')) = (closed_at is not null))
);

comment on table public.phoenix_crm_admin_photo_validations is
  'The Super Admin validates a customer for a rep with a photo he uploads; the location is the rep''s own live reading taken while the watch is on (owner, 2026-11-20).';

-- One open watch per customer: a second press reuses or cancels the first, never runs beside it.
create unique index if not exists phoenix_crm_admin_photo_validations_open_idx
  on public.phoenix_crm_admin_photo_validations (customer_id)
  where status in ('watching', 'captured');

create index if not exists phoenix_crm_admin_photo_validations_seat_idx
  on public.phoenix_crm_admin_photo_validations (seat_id, is_test)
  where status in ('watching', 'captured');

alter table public.phoenix_crm_admin_photo_validations enable row level security;
create policy phoenix_crm_admin_photo_validations_service_role
  on public.phoenix_crm_admin_photo_validations for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_admin_photo_validations from public, anon, authenticated;
grant all on table public.phoenix_crm_admin_photo_validations to service_role;

alter table public.phoenix_crm_places add column if not exists admin_photo_by_hr_id text;

comment on column public.phoenix_crm_places.admin_photo_by_hr_id is
  'Who uploaded the photo of a place the Super Admin validated for a rep (phoenix_crm_admin_photo_validations); null on every other place.';

alter table public.phoenix_crm_places drop constraint if exists phoenix_crm_places_timings;
alter table public.phoenix_crm_places add constraint phoenix_crm_places_timings check (
  jsonb_typeof(timings) = 'array'
  and jsonb_array_length(timings) <= 60
  and (jsonb_array_length(timings) >= 1 or trusted_basis is not null or admin_photo_by_hr_id is not null)
);

create or replace function public.phoenix_crm_validate_with_admin_photo(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(trim(coalesce(p ->> 'validation_id', '')), '')::uuid;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_loc jsonb := p -> 'location';
  v_watch public.phoenix_crm_admin_photo_validations%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_place_id uuid;
  v_event text;
  v_was text;
begin
  if v_id is null or v_actor is null or jsonb_typeof(v_loc) is distinct from 'object' then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select w.* into v_watch from public.phoenix_crm_admin_photo_validations w where w.id = v_id;
  if not found then
    raise exception 'phoenix_crm:admin_photo_not_found';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_watch.seat_id));

  select w.* into v_watch from public.phoenix_crm_admin_photo_validations w where w.id = v_id for update;
  if v_watch.status = 'watching' then
    raise exception 'phoenix_crm:admin_photo_no_reading';
  end if;
  if v_watch.status <> 'captured' then
    raise exception 'phoenix_crm:admin_photo_closed';
  end if;

  select c.* into v_customer
  from public.phoenix_crm_customers c
  where c.id = v_watch.customer_id
    and c.seat_id = v_watch.seat_id
    and c.is_test = v_watch.is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:customer_not_found';
  end if;
  if v_customer.status = 'dropped' then
    raise exception 'phoenix_crm:archived';
  end if;
  if v_customer.status not in ('pending', 'active') then
    raise exception 'phoenix_crm:not_on_list';
  end if;
  if v_customer.list_type not in ('AM', 'PM') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if exists (
    select 1 from public.phoenix_crm_places pl
    where pl.customer_id = v_customer.id and pl.status = 'active'
  ) then
    raise exception 'phoenix_crm:already_has_place';
  end if;
  if exists (
    select 1 from public.phoenix_crm_validation_reviews r
    where r.customer_id = v_customer.id and r.status = 'pending'
      and exists (select 1 from public.phoenix_crm_places pl where pl.id = r.place_id and pl.status = 'active')
  ) then
    raise exception 'phoenix_crm:location_in_review';
  end if;

  insert into public.phoenix_crm_places (
    customer_id, seat_id, lat, lon, accuracy_meters, timings, photo_path, captured_at, created_by_hr_id, is_test,
    point_source, pin_lat, pin_lon, pin_accuracy_meters, admin_photo_by_hr_id,
    address, zone, brick_lookup, brick_id, brick_name, brick_distance_km,
    area_code, area_name, region_code, region_name
  )
  values (
    v_customer.id,
    v_watch.seat_id,
    v_watch.rep_lat,
    v_watch.rep_lon,
    v_watch.rep_accuracy_meters,
    '[]'::jsonb,
    v_watch.photo_path,
    v_watch.rep_captured_at,
    v_watch.rep_hr_id,
    v_watch.is_test,
    'pin',
    v_watch.rep_lat,
    v_watch.rep_lon,
    v_watch.rep_accuracy_meters,
    v_actor,
    left(nullif(v_loc ->> 'address', ''), 200),
    left(nullif(v_loc ->> 'zone', ''), 80),
    coalesce(nullif(v_loc ->> 'brick_lookup', ''), 'could_not_look'),
    nullif(v_loc ->> 'brick_id', ''),
    nullif(v_loc ->> 'brick_name', ''),
    nullif(v_loc ->> 'brick_distance_km', '')::numeric,
    nullif(v_loc ->> 'area_code', ''),
    nullif(v_loc ->> 'area_name', ''),
    nullif(v_loc ->> 'region_code', ''),
    nullif(v_loc ->> 'region_name', '')
  )
  returning id into v_place_id;

  v_was := v_customer.status;
  if v_customer.status = 'pending' then
    update public.phoenix_crm_customers c
    set status = 'active',
        validated_at = now(),
        validated_by_hr_id = v_actor,
        reopened_at = null,
        status_changed_at = now(),
        updated_at = now()
    where c.id = v_customer.id;

    -- A drop request still open on him is withdrawn, exactly as every other validating door withdraws it.
    with withdrawn as (
      update public.phoenix_crm_list_requests q
      set status = 'withdrawn',
          stage = null,
          decided_at = now(),
          decided_by_hr_id = v_actor,
          decision_note = 'Validated instead of dropped'
      where q.seat_id = v_watch.seat_id
        and q.is_test = v_watch.is_test
        and q.kind = 'drop'
        and q.status = 'pending'
        and (
          q.customer_id = v_customer.id
          or (q.customer_id is null and v_customer.reference_contact_crm_id is not null and q.reference_contact_crm_id = v_customer.reference_contact_crm_id)
        )
      returning q.id
    )
    insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
    select v_watch.seat_id, v_customer.id, w.id, 'request_withdrawn', v_actor, jsonb_build_object('why', 'validated'), v_watch.is_test
    from withdrawn w;

    v_event := 'customer_validated';
  else
    v_event := 'place_added';
  end if;

  update public.phoenix_crm_admin_photo_validations w
  set status = 'validated', place_id = v_place_id, closed_at = now()
  where w.id = v_watch.id;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
  values (
    v_watch.seat_id, v_customer.id, v_place_id, v_event, v_actor,
    jsonb_build_object(
      'mode', 'admin_photo',
      'admin_photo_validation_id', v_watch.id,
      'rep_hr_id', v_watch.rep_hr_id,
      'rep_accuracy_meters', v_watch.rep_accuracy_meters,
      'was', v_was
    ),
    v_watch.is_test
  );

  return jsonb_build_object(
    'place_id', v_place_id,
    'customer_id', v_customer.id,
    'status', 'active',
    'event', v_event
  );
end;
$$;

revoke execute on function public.phoenix_crm_validate_with_admin_photo(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_validate_with_admin_photo(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
