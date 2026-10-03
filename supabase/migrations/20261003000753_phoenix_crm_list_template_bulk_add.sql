-- phoenix_crm_list_template_bulk_add
--
-- WHAT THIS CHANGES:
--   1. `phoenix_crm_customers` gains `intake_where` and `intake_note` — what the SFE wrote for the rep
--      when he loaded the list from a sheet: where to find the customer, and anything else worth saying.
--   2. `phoenix_crm_load_list_customers(p jsonb)` — the SFE Manager's and Super Admin's bulk load. One
--      call, one audited event per customer plus one for the load itself, and a per-row answer for the
--      rows it would not take.
--   3. `phoenix_crm_validate_customer` gains the mode `listed`: validating a customer who is already on
--      the list and has NO iReports360 contact, which is every customer loaded from a sheet.
--
-- WHY:
--   The owner's ask of 2026-10-02, asked who grades an add on a territory whose manager chain is vacant:
--   *"make a third option for SFE and system administrator … with the download and upload template of
--   the list … the SFE will send him an Excel sheet and he will populate it with the list, then he
--   [sends it back to] the SFE and SFE uploads this sheet so his list appears."*
--
--   🔴 A LOADED CUSTOMER LANDS AS `pending`, NOT `active`, AND THAT IS THE WHOLE DESIGN. A place is
--   validated once, at the door, from a live signboard photo and a GPS read taken on the spot, and its
--   address, brick, area and region are resolved server-side from that point — the owner's locked rule.
--   A spreadsheet cannot carry any of it, so the sheet carries the CUSTOMER and the rep still validates
--   him at his clinic, exactly as he validates one carried over from iReports360. "his list appears" is
--   satisfied: the customers appear under To validate.
--
--   🔴 AND HE ARRIVES AS `origin = 'new'` BECAUSE THE TABLE'S OWN CHECK SAYS SO:
--   `(origin = 'reference') = (reference_contact_crm_id is not null)`. He came from a sheet, not from
--   iReports360, and claiming otherwise would need a contact id that does not exist.
--
--   The grade is the SFE's here. A rep never sets one; on the ordinary path the district manager confirms
--   the A/B/C and sets the potential and then SFE admits, and this route exists for the case that path
--   cannot serve — so the SFE who uploads the sheet is the one who graded it, in the sheet, and the load
--   event records him as the actor.
--
--   Mode `listed` is what the retired `restore` mode was structurally — validate a customer already on
--   the list, by id — minus the hole it carried: `restore` reached a customer in the ARCHIVE and inserted
--   an active place onto him. This one takes `pending` and nothing else.
--
-- ROLLBACK:
--   `drop function if exists public.phoenix_crm_load_list_customers(jsonb);` and re-apply
--   `phoenix_crm_validate_customer` from 20261002224250. The two columns are additive and nullable —
--   `alter table public.phoenix_crm_customers drop column intake_where, drop column intake_note;` drops
--   them with whatever notes the SFE wrote, so take them out only if nothing has been loaded.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration is additive: it creates and replaces, and deletes nothing.

begin;
-- `phoenix_crm_customers` is written on every validation and every visit save, and ALTER TABLE takes an
-- ACCESS EXCLUSIVE lock: without this the migration would queue behind a rep at a door, and every rep
-- behind it. Five seconds, then it gives up and is run again.
set local lock_timeout = '5s';

-- ── 1. What the SFE wrote for the rep ─────────────────────────────────────────────────────────────

alter table public.phoenix_crm_customers
  add column if not exists intake_where text,
  add column if not exists intake_note text;

alter table public.phoenix_crm_customers drop constraint if exists phoenix_crm_customers_intake_where;
alter table public.phoenix_crm_customers
  add constraint phoenix_crm_customers_intake_where
  check (intake_where is null or char_length(intake_where) <= 200);
alter table public.phoenix_crm_customers drop constraint if exists phoenix_crm_customers_intake_note;
alter table public.phoenix_crm_customers
  add constraint phoenix_crm_customers_intake_note
  check (intake_note is null or char_length(intake_note) <= 300);

comment on column public.phoenix_crm_customers.intake_where is
  'Where to find this customer, as the SFE wrote it when he loaded the list from a sheet. A NOTE FOR THE REP, never a location the system reads — the place is captured at the door and resolved server-side (owner, 2026-09-23).';
comment on column public.phoenix_crm_customers.intake_note is
  'Anything else the SFE wrote for the rep when he loaded the list from a sheet.';

-- ── 2. The bulk load ──────────────────────────────────────────────────────────────────────────────

create or replace function public.phoenix_crm_load_list_customers(p jsonb)
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
  v_source text := nullif(trim(coalesce(p ->> 'source', '')), '');
  v_row jsonb;
  v_name text;
  v_list_type text;
  v_grade text;
  v_potential text;
  v_phone text;
  v_customer public.phoenix_crm_customers%rowtype;
  v_loaded jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_load_id uuid := gen_random_uuid();
begin
  if v_seat is null or v_line is null or v_actor is null or jsonb_typeof(p -> 'customers') is distinct from 'array' then
    raise exception 'phoenix_crm:bad_input';
  end if;
  -- A sheet holds a territory's list, not a book. The caller caps it too; this is the floor under that.
  if jsonb_array_length(p -> 'customers') > 1000 then
    raise exception 'phoenix_crm:too_many_rows';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  for v_row in select value from jsonb_array_elements(p -> 'customers')
  loop
    v_name := nullif(regexp_replace(trim(coalesce(v_row ->> 'name', '')), '\s+', ' ', 'g'), '');
    v_list_type := coalesce(v_row ->> 'list_type', '');
    v_grade := nullif(v_row ->> 'grade', '');
    v_potential := nullif(v_row ->> 'potential_grade', '');
    v_phone := nullif(regexp_replace(coalesce(v_row ->> 'phone', ''), '\s+', '', 'g'), '');

    -- The caller has judged every one of these already (list-template-rules.ts). Checked again here
    -- because this function is the authority, and a refusal that reaches the sheet's own row number is
    -- more use to the SFE than one that aborts the whole load.
    if v_name is null or v_list_type not in ('AM', 'PM', 'Pharmacy') then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'row', v_row -> 'row', 'name', v_row -> 'name', 'reason', 'bad_input'));
      continue;
    end if;
    if v_list_type = 'Pharmacy' and (v_grade is not null or v_potential is not null) then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'row', v_row -> 'row', 'name', v_row -> 'name', 'reason', 'pharmacy_has_no_grade'));
      continue;
    end if;
    if v_list_type <> 'Pharmacy' and (v_grade not in ('A', 'B', 'C') or v_potential not in ('AA', 'AB', 'AC', 'BA', 'BB', 'BC')) then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'row', v_row -> 'row', 'name', v_row -> 'name', 'reason', 'grade_required'));
      continue;
    end if;

    -- The same guard a hand-typed customer meets, row by row rather than all or nothing: the SFE gets
    -- the ones that landed and a line naming each one that was already there.
    if exists (
      select 1
      from public.phoenix_crm_customers c
      where c.seat_id = v_seat
        and c.is_test = v_is_test
        and c.status in ('active', 'pending', 'outside')
        and c.list_type = v_list_type
        and lower(c.name) = lower(v_name)
    ) then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'row', v_row -> 'row', 'name', v_row -> 'name', 'reason', 'already_on_the_list'));
      continue;
    end if;

    insert into public.phoenix_crm_customers (
      seat_id, line_code, list_type, name, speciality, grade, potential_grade, origin, status,
      validated_at, validated_by_hr_id, created_by_hr_id, is_test, phone, intake_where, intake_note
    )
    values (
      v_seat, v_line, v_list_type, left(v_name, 200),
      left(nullif(trim(coalesce(v_row ->> 'speciality', '')), ''), 120),
      v_grade, v_potential, 'new', 'pending',
      -- NOT validated: he waits under To validate for the rep to validate him at the door.
      null, null, v_actor, v_is_test, v_phone,
      left(nullif(trim(coalesce(v_row ->> 'intake_where', '')), ''), 200),
      left(nullif(trim(coalesce(v_row ->> 'intake_note', '')), ''), 300)
    )
    returning * into v_customer;

    insert into public.phoenix_crm_list_events (seat_id, customer_id, event_type, actor_hr_id, details, is_test)
    values (
      v_seat, v_customer.id, 'customer_loaded', v_actor,
      jsonb_build_object(
        'load_id', v_load_id,
        'source', coalesce(v_source, 'sheet'),
        'list_type', v_list_type,
        'grade', v_grade,
        'potential_grade', v_potential,
        'sheet_row', v_row -> 'row'
      ),
      v_is_test
    );

    v_loaded := v_loaded || jsonb_build_array(jsonb_build_object('customer_id', v_customer.id, 'name', v_customer.name, 'row', v_row -> 'row'));
  end loop;

  -- One event for the load itself, so the act is readable without reading 300 rows.
  insert into public.phoenix_crm_list_events (seat_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, 'list_loaded', v_actor,
    jsonb_build_object(
      'load_id', v_load_id,
      'source', coalesce(v_source, 'sheet'),
      'loaded', jsonb_array_length(v_loaded),
      'skipped', jsonb_array_length(v_skipped)
    ),
    v_is_test
  );

  return jsonb_build_object(
    'load_id', v_load_id,
    'seat_id', v_seat,
    'loaded', v_loaded,
    'skipped', v_skipped
  );
end;
$$;

revoke execute on function public.phoenix_crm_load_list_customers(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_load_list_customers(jsonb) to service_role;

-- ── 3. Validating a customer who is on the list with no iReports360 contact ───────────────────────

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

revoke execute on function public.phoenix_crm_validate_customer(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_validate_customer(jsonb) to service_role;

-- PostgREST caches the schema, so the two new columns and the new function are invisible to it until it
-- is told. Without this the first read of `intake_where` answers PGRST204 and the whole list read fails —
-- a missing column takes the WHOLE select with it, not one field.
notify pgrst, 'reload schema';

commit;
