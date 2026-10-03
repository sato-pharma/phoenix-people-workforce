-- phoenix_crm_google_place_check
--
-- WHAT THIS CHANGES:
--   1. `phoenix_crm_validation_reviews` — a place the system could not check against Google Maps, held
--      for the Super Admin. One row per held place; RLS on, no policy, service role only.
--   2. `phoenix_crm_validate_customer` takes an optional `hold_review` object. With it, the place is
--      saved but the customer is NOT validated: a carried-over or listed customer stays `pending`, and
--      a review row is opened. Without it, every mode behaves exactly as before. It also takes an
--      optional `google` object (the listing the place matched) and keeps it on the audit event, and it
--      refuses to validate a customer whose location is already being checked.
--   3. `phoenix_crm_add_place` takes the same `hold_review` / `google`: a held second clinic is saved
--      and a review row opened (the customer is already validated, so nothing else moves).
--   4. `phoenix_crm_decide_validation_review(p)` — the Super Admin's approve or reject. Approve
--      validates a held customer; reject retires the place and, when it was his only one, puts a
--      validated customer back to `pending` so the rep validates him again.
--
-- WHY:
--   Owner, 2026-10-03, after one phone on approximate location fixed four Benha hospitals on one point:
--   a place is checked against the account's own Google Maps listing before it is accepted — first that
--   the listing IS the account, then that the rep stood within 150 m of it. A mismatch is refused at the
--   door (in the app, before this function is called); an account Google has no listing for is "held
--   for review and only system admin can approve or reject … show him that it's automated from
--   system". This migration is the held half.
--
--   🔴 HOLD IS AN OPTIONAL KEY, SO THIS IS BACKWARDS COMPATIBLE BY CONSTRUCTION. The code running before
--   the app ships never sends `hold_review`, and gets byte-for-byte the old behaviour; that is why this
--   can be applied ahead of the merge.
--
-- ROLLBACK: re-apply the two functions from 20261003000753_phoenix_crm_list_template_bulk_add.sql
--   (validate) and the live definition of phoenix_crm_add_place recorded in this file's history, then
--   `drop function public.phoenix_crm_decide_validation_review(jsonb)` and
--   `drop table public.phoenix_crm_validation_reviews` (SAFE only once no row is pending).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This one is neither: a new empty table and three function bodies.

begin;

set local lock_timeout = '5s';

create table if not exists public.phoenix_crm_validation_reviews (
  id uuid primary key default gen_random_uuid(),
  seat_id text not null,
  customer_id uuid not null references public.phoenix_crm_customers(id),
  place_id uuid not null references public.phoenix_crm_places(id),
  is_test boolean not null default false,
  -- `validation`: the customer's first place, so he is not validated until this is decided.
  -- `added_place`: a further clinic of a customer already validated.
  kind text not null check (kind in ('validation', 'added_place')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  -- What the system asked Google and what came back, so the Super Admin reads the same evidence.
  google jsonb not null default '{}'::jsonb,
  created_by_hr_id text not null,
  created_at timestamptz not null default now(),
  decided_by_hr_id text,
  decided_at timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) <= 500),
  constraint phoenix_crm_validation_reviews_decided check ((status = 'pending') = (decided_at is null))
);

create unique index if not exists phoenix_crm_validation_reviews_place_idx
  on public.phoenix_crm_validation_reviews (place_id);
create index if not exists phoenix_crm_validation_reviews_pending_idx
  on public.phoenix_crm_validation_reviews (customer_id) where status = 'pending';
create index if not exists phoenix_crm_validation_reviews_seat_idx
  on public.phoenix_crm_validation_reviews (seat_id, created_at desc);

alter table public.phoenix_crm_validation_reviews enable row level security;

create policy phoenix_crm_validation_reviews_service_role
  on public.phoenix_crm_validation_reviews for all to service_role using (true) with check (true);

revoke all on table public.phoenix_crm_validation_reviews from public, anon, authenticated;
grant all on table public.phoenix_crm_validation_reviews to service_role;

-- ── 2. validate, with the hold ───────────────────────────────────────────────────────────────────

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
  v_phone text := nullif(regexp_replace(coalesce(p ->> 'phone', ''), '\s+', '', 'g'), '');
  -- 2026-10-03: the Google check. `hold_review` holds the place for the Super Admin; `google` is the
  -- listing a matched place stood at. Both optional: a caller that sends neither gets the old function.
  v_hold jsonb := case when jsonb_typeof(p -> 'hold_review') = 'object' then p -> 'hold_review' end;
  v_google jsonb := case when jsonb_typeof(p -> 'google') = 'object' then p -> 'google' end;
  v_review_id uuid;
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
  if v_phone is not null and v_phone !~ '^\+?[0-9]{7,15}$' then
    raise exception 'phoenix_crm:bad_phone';
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
    -- His location is already with the Super Admin: a second validation would add a second place
    -- beside the one being checked.
    if v_ref.customer_id is not null and exists (
      select 1 from public.phoenix_crm_validation_reviews r
      where r.customer_id = v_ref.customer_id and r.status = 'pending'
    ) then
      raise exception 'phoenix_crm:location_in_review';
    end if;

    if v_ref.customer_id is not null then
      perform 1 from public.phoenix_crm_customers c where c.id = v_ref.customer_id for update;

      if v_hold is null then
        update public.phoenix_crm_customers c
        set status = 'active',
            validated_at = now(),
            validated_by_hr_id = v_actor,
            dropped_reason = null,
            dropped_note = null,
            status_changed_at = now(),
            phone = coalesce(v_phone, c.phone),
            updated_at = now()
        where c.id = v_ref.customer_id
        returning c.* into v_customer;
      else
        -- Held: the place is saved, the customer is not validated until the Super Admin decides.
        update public.phoenix_crm_customers c
        set phone = coalesce(v_phone, c.phone),
            updated_at = now()
        where c.id = v_ref.customer_id
        returning c.* into v_customer;
      end if;
    else
      insert into public.phoenix_crm_customers (
        seat_id, line_code, list_type, name, speciality, grade, origin, reference_contact_crm_id,
        status, validated_at, validated_by_hr_id, created_by_hr_id, is_test, phone
      )
      values (
        v_seat, v_line, v_ref.list_type, left(v_ref.name, 200), left(v_ref.speciality, 120), v_ref.grade, 'reference', v_ref.contact_crm_id,
        case when v_hold is null then 'active' else 'pending' end,
        case when v_hold is null then now() end,
        case when v_hold is null then v_actor end,
        v_actor, v_is_test, v_phone
      )
      returning * into v_customer;
    end if;

    if v_hold is null then
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
    end if;

  elsif v_mode = 'listed' then
    -- A customer the SFE loaded from a sheet: already on the list, already graded by him, and carrying
    -- no iReports360 contact at all — so `phoenix_crm_reference_entry` can never find him and the
    -- reference branch above cannot serve him. He is validated at the door like any other.
    select c.* into v_customer
    from public.phoenix_crm_customers c
    where c.id = (p ->> 'customer_id')::uuid
      and c.seat_id = v_seat
      and c.is_test = v_is_test
    for update;
    if not found then
      raise exception 'phoenix_crm:customer_not_found';
    end if;
    if v_customer.status = 'dropped' then
      -- The Archive is frozen. He comes back through "Ask to bring back", never through a validation.
      raise exception 'phoenix_crm:archived';
    end if;
    if v_customer.status <> 'pending' then
      raise exception 'phoenix_crm:already_validated';
    end if;
    if exists (
      select 1 from public.phoenix_crm_validation_reviews r
      where r.customer_id = v_customer.id and r.status = 'pending'
    ) then
      raise exception 'phoenix_crm:location_in_review';
    end if;

    if v_hold is null then
      update public.phoenix_crm_customers c
      set status = 'active',
          validated_at = now(),
          validated_by_hr_id = v_actor,
          status_changed_at = now(),
          phone = coalesce(v_phone, c.phone),
          updated_at = now()
      where c.id = v_customer.id
      returning c.* into v_customer;

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
          and q.customer_id = v_customer.id
        returning q.id
      )
      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      select v_seat, v_customer.id, w.id, 'request_withdrawn', v_actor, jsonb_build_object('why', 'validated'), v_is_test
      from withdrawn w;
    else
      update public.phoenix_crm_customers c
      set phone = coalesce(v_phone, c.phone),
          updated_at = now()
      where c.id = v_customer.id
      returning c.* into v_customer;
    end if;

  elsif v_mode in ('new', 'outside') then
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

    insert into public.phoenix_crm_customers (
      seat_id, line_code, list_type, name, speciality, grade, origin, status, validated_at,
      validated_by_hr_id, created_by_hr_id, is_test, phone
    )
    values (
      v_seat, v_line, v_list_type, v_name, nullif(trim(coalesce(p ->> 'speciality', '')), ''), null, 'new', 'outside', null,
      null, v_actor, v_is_test, v_phone
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

  -- The `restore` mode was retired on 2026-10-02: it inserted an ACTIVE place onto a customer sitting in
  -- the Archive, with no status check and outside the five-clinic cap. `listed` above is the shape it
  -- should always have had — a customer on the list, by id, `pending` only.
  else
    raise exception 'phoenix_crm:bad_input';
  end if;

  v_place := public.phoenix_crm_insert_place(v_customer.id, v_seat, v_actor, v_is_test, p -> 'place');

  if v_hold is not null and v_event = 'customer_validated' then
    v_event := 'validation_held';
  end if;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, v_customer.id, (v_place ->> 'place_id')::uuid, v_event, v_actor,
    jsonb_build_object('mode', v_mode, 'reference_contact_crm_id', v_customer.reference_contact_crm_id)
      || case when v_google is not null then jsonb_build_object('google', v_google) else '{}'::jsonb end,
    v_is_test
  );

  if v_hold is not null then
    insert into public.phoenix_crm_validation_reviews (seat_id, customer_id, place_id, is_test, kind, google, created_by_hr_id)
    values (v_seat, v_customer.id, (v_place ->> 'place_id')::uuid, v_is_test, 'validation', v_hold, v_actor)
    returning id into v_review_id;
    -- An outside customer's own event names his arrival; the hold gets its line beside it.
    if v_event <> 'validation_held' then
      insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
      values (v_seat, v_customer.id, (v_place ->> 'place_id')::uuid, 'validation_held', v_actor, jsonb_build_object('mode', v_mode), v_is_test);
    end if;
  end if;

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
    'request_kind', v_request_kind,
    'phone', v_customer.phone,
    'held', v_hold is not null,
    'review_id', v_review_id
  );
end;
$$;

revoke execute on function public.phoenix_crm_validate_customer(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_validate_customer(jsonb) to service_role;

-- ── 3. another clinic, with the hold ─────────────────────────────────────────────────────────────

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
  v_hold jsonb := case when jsonb_typeof(p -> 'hold_review') = 'object' then p -> 'hold_review' end;
  v_google jsonb := case when jsonb_typeof(p -> 'google') = 'object' then p -> 'google' end;
  v_review_id uuid;
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
  values (
    v_seat, v_customer.id, (v_place ->> 'place_id')::uuid, 'place_added', v_actor,
    case when v_google is not null then jsonb_build_object('google', v_google) else '{}'::jsonb end,
    v_is_test
  );

  if v_hold is not null then
    insert into public.phoenix_crm_validation_reviews (seat_id, customer_id, place_id, is_test, kind, google, created_by_hr_id)
    values (v_seat, v_customer.id, (v_place ->> 'place_id')::uuid, v_is_test, 'added_place', v_hold, v_actor)
    returning id into v_review_id;
    insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
    values (v_seat, v_customer.id, (v_place ->> 'place_id')::uuid, 'validation_held', v_actor, jsonb_build_object('kind', 'added_place'), v_is_test);
  end if;

  return v_place || jsonb_build_object(
    'customer_id', v_customer.id,
    'customer_name', v_customer.name,
    'held', v_hold is not null,
    'review_id', v_review_id
  );
end;
$$;

revoke execute on function public.phoenix_crm_add_place(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_add_place(jsonb) to service_role;

-- ── 4. the Super Admin's decision ────────────────────────────────────────────────────────────────

create or replace function public.phoenix_crm_decide_validation_review(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(p ->> 'review_id', '')::uuid;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_decision text := coalesce(p ->> 'decision', '');
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_review public.phoenix_crm_validation_reviews%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_place public.phoenix_crm_places%rowtype;
  v_validated boolean := false;
  v_reopened boolean := false;
begin
  if v_id is null or v_actor is null or v_decision not in ('approve', 'reject')
    or (v_note is not null and char_length(v_note) > 500) then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select r.* into v_review from public.phoenix_crm_validation_reviews r where r.id = v_id;
  if not found then
    raise exception 'phoenix_crm:review_not_found';
  end if;
  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_review.seat_id));
  -- Read again under the seat lock: two decisions landing together must not both pass the status check.
  select r.* into v_review from public.phoenix_crm_validation_reviews r where r.id = v_id for update;
  if v_review.status <> 'pending' then
    raise exception 'phoenix_crm:review_decided';
  end if;

  select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_review.customer_id for update;
  select pl.* into v_place from public.phoenix_crm_places pl where pl.id = v_review.place_id for update;

  if v_decision = 'approve' then
    update public.phoenix_crm_validation_reviews
    set status = 'approved', decided_by_hr_id = v_actor, decided_at = now(), decision_note = v_note
    where id = v_id;

    -- A held FIRST place: the customer is validated now, as the rep's own validation would have done,
    -- in his name — he did the work at the door; the Super Admin only confirmed the place.
    if v_review.kind = 'validation' and v_customer.status = 'pending' and v_place.status = 'active' then
      update public.phoenix_crm_customers c
      set status = 'active',
          validated_at = now(),
          validated_by_hr_id = v_review.created_by_hr_id,
          dropped_reason = null,
          dropped_note = null,
          status_changed_at = now(),
          updated_at = now()
      where c.id = v_customer.id;
      v_validated := true;

      with withdrawn as (
        update public.phoenix_crm_list_requests q
        set status = 'withdrawn',
            stage = null,
            decided_at = now(),
            decided_by_hr_id = v_actor,
            decision_note = 'Validated instead of dropped'
        where q.seat_id = v_review.seat_id
          and q.is_test = v_review.is_test
          and q.kind = 'drop'
          and q.status = 'pending'
          and (
            q.customer_id = v_customer.id
            or (q.customer_id is null and v_customer.reference_contact_crm_id is not null and q.reference_contact_crm_id = v_customer.reference_contact_crm_id)
          )
        returning q.id
      )
      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      select v_review.seat_id, v_customer.id, w.id, 'request_withdrawn', v_actor, jsonb_build_object('why', 'validated'), v_review.is_test
      from withdrawn w;
    end if;

    insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
    values (
      v_review.seat_id, v_customer.id, v_review.place_id, 'validation_review_approved', v_actor,
      jsonb_build_object('review_id', v_id, 'note', v_note, 'validated', v_validated), v_review.is_test
    );
  else
    update public.phoenix_crm_validation_reviews
    set status = 'rejected', decided_by_hr_id = v_actor, decided_at = now(), decision_note = v_note
    where id = v_id;

    if v_place.status = 'active' then
      update public.phoenix_crm_places pl
      set status = 'retired', retired_at = now(), retired_by_hr_id = v_actor, updated_at = now()
      where pl.id = v_place.id;
      insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
      values (
        v_review.seat_id, v_customer.id, v_place.id, 'place_retired', v_actor,
        jsonb_build_object('reason', coalesce(v_note, 'The location could not be confirmed against Google Maps.'), 'label', v_place.label,
          'lat', v_place.lat, 'lon', v_place.lon, 'why', 'validation_rejected'),
        v_review.is_test
      );
    end if;

    -- A validated customer left with no place is not validated any more: back to To validate.
    if v_customer.status = 'active' and not exists (
      select 1 from public.phoenix_crm_places pl where pl.customer_id = v_customer.id and pl.status = 'active'
    ) then
      update public.phoenix_crm_customers c
      set status = 'pending', validated_at = null, validated_by_hr_id = null, status_changed_at = now(), updated_at = now()
      where c.id = v_customer.id;
      v_reopened := true;
      insert into public.phoenix_crm_list_events (seat_id, customer_id, event_type, actor_hr_id, details, is_test)
      values (v_review.seat_id, v_customer.id, 'customer_pending', v_actor,
        jsonb_build_object('reference_contact_crm_id', v_customer.reference_contact_crm_id, 'why', 'validation_rejected'), v_review.is_test);
    end if;

    insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
    values (
      v_review.seat_id, v_customer.id, v_review.place_id, 'validation_review_rejected', v_actor,
      jsonb_build_object('review_id', v_id, 'note', v_note, 'reopened', v_reopened), v_review.is_test
    );
  end if;

  return jsonb_build_object(
    'review_id', v_id,
    'status', case when v_decision = 'approve' then 'approved' else 'rejected' end,
    'seat_id', v_review.seat_id,
    'customer_id', v_customer.id,
    'is_test', v_review.is_test,
    'validated', v_validated,
    'reopened', v_reopened
  );
end;
$$;

revoke execute on function public.phoenix_crm_decide_validation_review(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_decide_validation_review(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
