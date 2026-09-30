-- phoenix_crm_customer_phone
--
-- WHAT THIS CHANGES (owner, 2026-09-30, asked after the Daily Plan report was rebuilt without the old
-- report's phone column, and answering each question himself):
--   1. phoenix_crm_customers.phone — the customer's phone, as the REP typed it. Optional. Digits only,
--      7 to 15 of them, with an optional leading "+", checked here as well as in entry-rules.ts.
--      "Only what the rep types": the old iReports360 list's phones (3,322 of its 19,121 contacts) are
--      never copied in and never shown.
--   2. phoenix_crm_validate_customer takes an optional `phone` and writes it in the SAME save as the
--      validation — "Add a phone to validation", never a second step that could fail after the first
--      one landed. A validation that sends no phone never blanks one already on file.
--   3. phoenix_crm_rename_customer ("Change the details") takes an optional `phone`: the rep corrects
--      it later beside the name and speciality ("Yes, in Change the details"). The key's ABSENCE leaves
--      the phone as it is, so a caller one release behind — which never sends it — changes nothing;
--      sent empty, it clears the phone. The change is in the customer_renamed event's from/to.
--
-- WHY: the Daily Plan report prints each planned customer's phone, as iReports360's did, and Phoenix
-- CRM kept none.
--
-- EXPAND-ONLY: one nullable column with its own check, and two functions replaced with the same
-- signatures and every existing behaviour kept — a body with no `phone` key does exactly what it did.
--
-- ROLLBACK:
--   re-apply phoenix_crm_validate_customer from 20260929235106_phoenix_crm_list_admission.sql and
--   phoenix_crm_rename_customer from 20260922180258_phoenix_crm_pending_customers.sql (both copied here
--   from the LIVE definitions, read from production on 2026-09-30, with only the phone added), then
--   alter table public.phoenix_crm_customers drop column phone;  -- SAFE: drops only the rep-typed phones
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;
set local lock_timeout = '5s';

-- 1. The column. `add column if not exists` carries its check with it, so a second run adds neither.
alter table public.phoenix_crm_customers
  add column if not exists phone text
  constraint phoenix_crm_customers_phone check (phone is null or phone ~ '^\+?[0-9]{7,15}$');

comment on column public.phoenix_crm_customers.phone is
  'The customer''s phone as the rep typed it at validation or corrected it since (owner, 2026-09-30). Optional; digits with an optional leading +. Never copied from iReports360.';

-- 2. Validating a customer, now with his phone. Unchanged but for `v_phone`: read, checked, and
--    written in each branch that writes the customer row.
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
  -- Optional. Spaces are dropped here too, so the check below reads what the rep meant.
  v_phone text := nullif(regexp_replace(coalesce(p ->> 'phone', ''), '\s+', '', 'g'), '');
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

    if v_ref.customer_id is not null then
      perform 1 from public.phoenix_crm_customers c where c.id = v_ref.customer_id for update;

      update public.phoenix_crm_customers c
      set status = 'active',
          validated_at = now(),
          validated_by_hr_id = v_actor,
          dropped_reason = null,
          dropped_note = null,
          status_changed_at = now(),
          -- A validation that sends no phone never blanks one already on file.
          phone = coalesce(v_phone, c.phone),
          updated_at = now()
      where c.id = v_ref.customer_id
      returning c.* into v_customer;
    else
      insert into public.phoenix_crm_customers (
        seat_id, line_code, list_type, name, speciality, grade, origin, reference_contact_crm_id,
        status, validated_at, validated_by_hr_id, created_by_hr_id, is_test, phone
      )
      values (
        v_seat, v_line, v_ref.list_type, left(v_ref.name, 200), left(v_ref.speciality, 120), v_ref.grade, 'reference', v_ref.contact_crm_id,
        'active', now(), v_actor, v_actor, v_is_test, v_phone
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
    'request_kind', v_request_kind,
    'phone', v_customer.phone
  );
end;
$$;

-- 3. "Change the details": the name, the speciality, and now the phone. The phone moves only when the
--    caller sends the key — a caller one release behind never does, and changes nothing.
create or replace function public.phoenix_crm_rename_customer(p jsonb)
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
  v_name text := nullif(regexp_replace(trim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'), '');
  v_speciality text := nullif(regexp_replace(trim(coalesce(p ->> 'speciality', '')), '\s+', ' ', 'g'), '');
  -- Present, even as null or empty, means "set it"; absent means "leave it".
  v_sets_phone boolean := (p -> 'phone') is not null;
  v_phone text := nullif(regexp_replace(coalesce(p ->> 'phone', ''), '\s+', '', 'g'), '');
  v_customer public.phoenix_crm_customers%rowtype;
  v_before jsonb;
begin
  if v_seat is null or v_actor is null or v_customer_id is null or v_name is null then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9]{7,15}$' then
    raise exception 'phoenix_crm:bad_phone';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select c.* into v_customer
  from public.phoenix_crm_customers c
  where c.id = v_customer_id
    and c.seat_id = v_seat
    and c.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:customer_not_found';
  end if;
  if v_customer.status = 'dropped' then
    raise exception 'phoenix_crm:customer_dropped';
  end if;

  if not coalesce((p ->> 'allow_same_name')::boolean, false) and exists (
    select 1
    from public.phoenix_crm_customers c
    where c.seat_id = v_seat
      and c.is_test = v_is_test
      and c.id <> v_customer.id
      and c.status in ('active', 'pending')
      and c.list_type = v_customer.list_type
      and lower(c.name) = lower(v_name)
  ) then
    raise exception 'phoenix_crm:same_name';
  end if;

  v_before := jsonb_build_object('name', v_customer.name, 'speciality', v_customer.speciality, 'phone', v_customer.phone);

  update public.phoenix_crm_customers c
  set name = left(v_name, 200),
      speciality = left(v_speciality, 120),
      phone = case when v_sets_phone then v_phone else c.phone end,
      updated_at = now()
  where c.id = v_customer.id
  returning c.* into v_customer;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, v_customer.id, 'customer_renamed', v_actor,
    jsonb_build_object(
      'from', v_before,
      'to', jsonb_build_object('name', v_customer.name, 'speciality', v_customer.speciality, 'phone', v_customer.phone)
    ),
    v_is_test
  );

  return jsonb_build_object(
    'customer_id', v_customer.id,
    'customer_name', v_customer.name,
    'speciality', v_customer.speciality,
    'phone', v_customer.phone
  );
end;
$$;

revoke execute on function public.phoenix_crm_validate_customer(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_validate_customer(jsonb) to service_role;
revoke execute on function public.phoenix_crm_rename_customer(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_rename_customer(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
