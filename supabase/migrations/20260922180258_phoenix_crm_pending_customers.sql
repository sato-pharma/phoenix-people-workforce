-- Phoenix CRM — the rep keeps his whole iReports360 list from day one, as PENDING customers.
--
-- Owner, 2026-09-22: "everyone appears to him his list in the old CRM, as a reference, but it is not
-- validated … he can normally do his plan, never blocked … but also never counted — counted only when
-- this customer is validated." And: validation is the three captures (the location, the live photo and
-- at least one timing), once per customer forever — never per visit.
--
-- What changes, in one sentence: a carried-over customer stops being a row that does not exist yet and
-- becomes a real customer row with status 'pending' and validated_at still null. Planning him and
-- visiting him then need no special case at all, and "does this count?" is one predicate everywhere —
-- validated_at is not null. Because nothing is stamped on the visit, the single UPDATE that validates
-- a customer makes every visit already logged against him start counting, with no backfill anywhere.
--
--   * phoenix_crm_customers.status gains 'pending'. The existing _active_is_validated check
--     (status <> 'active' or validated_at is not null) is deliberately KEPT: a pending row passes it,
--     and it goes on proving that an active customer is a validated one.
--   * phoenix_crm_plan_items.place_id becomes nullable — a pending customer has no place, because a
--     place IS the validation (a live photo, the location captured on the spot, and its timings).
--   * phoenix_crm_ensure_reference_customers mints the missing pending rows for a territory. It is
--     idempotent on the existing phoenix_crm_customers_reference_uidx, so the service calls it on every
--     list, planner and visit-form read and the list self-reconciles as iReports360 changes — no cron,
--     no drift, and a customer iReports360 drops simply stops being minted.
--   * The four report functions gain one join each: a visit or a plan item counts only when its
--     customer's validated_at is not null. Both sides of plan-against-actual move together, so a rep is
--     never scored down for planning a customer he has not validated yet.
--   * phoenix_crm_seat_reference keeps every state it had — a 'pending' row matches neither 'dropped'
--     nor 'active', so it falls through its CASE to 'open' exactly as an unminted customer did. Its one
--     edit is that a waiting drop is now recognised whether the request names the pending row or, as
--     before this migration, only the iReports360 contact.
--
-- Rollback (nothing here drops data; a pending row is a real customer row and would have to be decided
-- on by hand before the status check could be narrowed again):
--   begin;
--   -- delete from public.phoenix_crm_customers where status = 'pending';   -- ONLY if none were validated
--   -- alter table public.phoenix_crm_customers drop constraint phoenix_crm_customers_status;
--   -- alter table public.phoenix_crm_customers
--   --   add constraint phoenix_crm_customers_status check (status in ('active', 'dropped'));
--   -- alter table public.phoenix_crm_plan_items alter column place_id set not null;
--   -- drop function if exists public.phoenix_crm_ensure_reference_customers(text, text, boolean);
--   -- then re-apply 20260916150000_phoenix_crm.sql's bodies for the nine functions replaced below.
--   commit;
-- SAFE: the lines above are the commented rollback only; this migration drops no table and no column.
--
-- Verification after apply:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.phoenix_crm_customers'::regclass and conname like '%status%';   -- 3 values
--   select attnotnull from pg_attribute
--    where attrelid = 'public.phoenix_crm_plan_items'::regclass and attname = 'place_id';     -- f
--   select proname, prosecdef from pg_proc where proname = 'phoenix_crm_ensure_reference_customers';
--   select count(*) from pg_proc where proname like 'phoenix_crm_%';                          -- 19
--   select grantee, privilege_type from information_schema.role_routine_grants
--    where routine_name like 'phoenix_crm_%' and grantee in ('anon','authenticated','PUBLIC');  -- 0 rows

begin;

set local lock_timeout = '5s';

-- ── 1. A carried-over customer is real, and pending ──────────────────────────────────────────────

-- SAFE: widening a CHECK to admit one more value; every existing row already satisfies the new form.
alter table public.phoenix_crm_customers drop constraint if exists phoenix_crm_customers_status;
alter table public.phoenix_crm_customers
  add constraint phoenix_crm_customers_status check (status in ('active', 'pending', 'dropped'));

-- A pending customer has no place: the place IS the validation.
alter table public.phoenix_crm_plan_items alter column place_id drop not null;

-- ── 2. Minting the pending rows (idempotent, called on every read of a territory's list) ─────────

-- Every customer on the seat's iReports360 reference list that has no Phoenix row yet becomes a
-- pending one. The unique index (seat_id, reference_contact_crm_id, is_test) makes this safe to call
-- from anywhere, as often as it likes: a second call inserts nothing. The rep whose list it is — not
-- whoever happens to be reading the screen — is recorded as having created the row.
create or replace function public.phoenix_crm_ensure_reference_customers(
  p_seat_id text,
  p_line_code text,
  p_is_test boolean default false
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p_seat_id, '')), '');
  v_line text := nullif(trim(coalesce(p_line_code, '')), '');
  v_count integer := 0;
begin
  -- A territory with no line yet cannot hold customers; it also cannot plan, so there is nothing to do.
  if v_seat is null or v_line is null then
    return 0;
  end if;

  with missing as (
    select r.*
    from public.phoenix_crm_seat_reference(array[v_seat], p_is_test) r
    where r.customer_id is null
      -- Both columns are NOT NULL on their tables. seat_reference cannot return a null rep or a blank
      -- name today, and if that ever changes this skips the one row rather than failing the whole
      -- read — the rep's list must never fail to open.
      and r.source_hr_id is not null
      and nullif(trim(coalesce(r.name, '')), '') is not null
  ),
  minted as (
    insert into public.phoenix_crm_customers (
      seat_id, line_code, list_type, name, speciality, grade, origin, reference_contact_crm_id,
      status, created_by_hr_id, is_test
    )
    select
      v_seat, v_line, m.list_type, left(m.name, 200), left(m.speciality, 120), m.grade, 'reference',
      m.contact_crm_id, 'pending', m.source_hr_id, p_is_test
    from missing m
    on conflict (seat_id, reference_contact_crm_id, is_test) where reference_contact_crm_id is not null
      do nothing
    returning id, reference_contact_crm_id, created_by_hr_id
  )
  insert into public.phoenix_crm_list_events (seat_id, customer_id, event_type, actor_hr_id, details, is_test)
  select
    v_seat, mi.id, 'customer_pending', mi.created_by_hr_id,
    jsonb_build_object('reference_contact_crm_id', mi.reference_contact_crm_id), p_is_test
  from minted mi;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ── 3. The reference list reads a pending row exactly as it read an unminted one ─────────────────

-- Identical to 20260916150000 but for the drop-waiting test: a drop request for a customer who was
-- never validated may now name the pending row (the rep drops him from his own customer card), or
-- carry only the iReports360 contact, as every such request did before this migration.
create or replace function public.phoenix_crm_seat_reference(p_seat_ids text[], p_is_test boolean default false)
returns table (
  seat_id text,
  source_hr_id text,
  source_is_current boolean,
  contact_crm_id bigint,
  list_type text,
  grade text,
  name text,
  speciality text,
  address text,
  city text,
  zone text,
  brick_id text,
  last_visited_on date,
  customer_id uuid,
  state text
)
language sql
stable
security definer
set search_path to 'public'
as $$
  with seats as (
    select distinct s.seat_id
    from unnest(p_seat_ids) as s (seat_id)
    where s.seat_id is not null
  ),
  candidates as (
    select
      o.seat_id,
      upper(trim(o.occupant_hr_id)) as hr_id,
      o.effective_to is null as is_current,
      o.effective_from,
      o.effective_to
    from au.occupancy_history o
    join seats s on s.seat_id = o.seat_id
    where o.node_type = 'person'
      and nullif(trim(o.occupant_hr_id), '') is not null
  ),
  with_list as (
    select c.*
    from candidates c
    where exists (
        select 1
        from public.crm_contact_assignments a
        where a.effective_to is null
          and a.agent_hr_id = c.hr_id
          and a.list_type in ('AM', 'PM')
          and a.contact_crm_id <> 100000
      )
      and (
        c.is_current
        or not exists (
          select 1
          from au.occupancy_history other
          join au.seats other_seat on other_seat.seat_id = other.seat_id
          where other.node_type = 'person'
            and upper(trim(other.occupant_hr_id)) = c.hr_id
            and other.seat_id <> c.seat_id
            and other_seat.seat_tier = 'REP'
            and (other.effective_to is null or other.effective_from > c.effective_from)
        )
      )
  ),
  chosen as (
    select distinct on (w.seat_id) w.seat_id, w.hr_id, w.is_current
    from with_list w
    order by w.seat_id, w.is_current desc, w.effective_to desc nulls first, w.effective_from desc
  )
  select
    ch.seat_id,
    ch.hr_id,
    ch.is_current,
    a.contact_crm_id,
    a.list_type,
    case
      when upper(trim(a.grade)) in ('A', 'B', 'C') then upper(trim(a.grade))
      when upper(trim(a.grade)) = 'A+' then 'A'
      else null
    end,
    coalesce(nullif(trim(contact.name), ''), 'Unnamed customer'),
    nullif(trim(contact.speciality), ''),
    nullif(trim(contact.address), ''),
    nullif(trim(contact.city), ''),
    nullif(trim(contact.zone), ''),
    contact.brick_id,
    contact.last_visited_on,
    customer.id,
    case
      when customer.status = 'dropped' then 'dropped'
      when customer.status = 'active' then 'validated'
      when exists (
        select 1
        from public.phoenix_crm_list_requests q
        where q.seat_id = ch.seat_id
          and q.kind = 'drop'
          and q.status = 'pending'
          and q.is_test = p_is_test
          and (
            q.customer_id = customer.id
            or (q.customer_id is null and q.reference_contact_crm_id = a.contact_crm_id)
          )
      ) then 'drop_pending'
      else 'open'
    end
  from chosen ch
  join public.crm_contact_assignments a
    on a.effective_to is null
   and a.agent_hr_id = ch.hr_id
   and a.list_type in ('AM', 'PM')
   and a.contact_crm_id <> 100000
  left join public.crm_contacts contact on contact.contact_crm_id = a.contact_crm_id
  left join public.phoenix_crm_customers customer
    on customer.seat_id = ch.seat_id
   and customer.reference_contact_crm_id = a.contact_crm_id
   and customer.is_test = p_is_test;
$$;

-- ── 4. Validating a pending customer ─────────────────────────────────────────────────────────────

-- Unchanged except that the reference branch now knows a row it finds may be PENDING rather than
-- dropped: it reads the status before flipping it, so the event and the 'restored' answer stay honest.
-- The already_validated guard is untouched — it is what makes validation once per customer, forever.
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
  v_customer public.phoenix_crm_customers%rowtype;
  v_ref record;
  v_prev_status text;
  v_name text;
  v_list_type text;
  v_grade text;
  v_place jsonb;
  v_request_id uuid;
  v_event text := 'customer_validated';
begin
  if v_seat is null or v_line is null or v_actor is null or jsonb_typeof(p -> 'place') is distinct from 'object' then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  if v_mode = 'reference' then
    select r.* into v_ref
    from public.phoenix_crm_seat_reference(array[v_seat], v_is_test) r
    where r.contact_crm_id = (p ->> 'reference_contact_crm_id')::bigint;
    if not found then
      raise exception 'phoenix_crm:not_on_reference_list';
    end if;
    if v_ref.state = 'validated' then
      raise exception 'phoenix_crm:already_validated';
    end if;

    if v_ref.customer_id is not null then
      select c.status into v_prev_status
      from public.phoenix_crm_customers c
      where c.id = v_ref.customer_id
      for update;

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
      -- A pending customer is being validated for the first time; only a dropped one is coming back.
      if v_prev_status = 'dropped' then
        v_event := 'customer_restored';
      end if;
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

    -- Validating a reference customer whose drop was waiting is the rep's answer: the drop is withdrawn.
    with withdrawn as (
      update public.phoenix_crm_list_requests q
      set status = 'withdrawn',
          decided_at = now(),
          decided_by_hr_id = v_actor,
          decision_note = 'Validated instead of dropped'
      where q.seat_id = v_seat
        and q.is_test = v_is_test
        and q.kind = 'drop'
        and q.status = 'pending'
        and q.customer_id is null
        and q.reference_contact_crm_id = v_ref.contact_crm_id
      returning q.id
    )
    insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
    select v_seat, v_customer.id, w.id, 'request_withdrawn', v_actor, jsonb_build_object('why', 'validated'), v_is_test
    from withdrawn w;

  elsif v_mode = 'new' then
    v_name := nullif(regexp_replace(trim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'), '');
    v_list_type := coalesce(p ->> 'list_type', '');
    v_grade := coalesce(p ->> 'proposed_grade', '');
    if v_name is null or v_list_type not in ('AM', 'PM') or v_grade not in ('A', 'B', 'C') then
      raise exception 'phoenix_crm:bad_input';
    end if;
    if not coalesce((p ->> 'allow_same_name')::boolean, false) and exists (
      select 1
      from public.phoenix_crm_customers c
      where c.seat_id = v_seat
        and c.is_test = v_is_test
        and c.status = 'active'
        and c.list_type = v_list_type
        and lower(c.name) = lower(v_name)
    ) then
      raise exception 'phoenix_crm:same_name';
    end if;

    insert into public.phoenix_crm_customers (
      seat_id, line_code, list_type, name, speciality, grade, origin, status, validated_at,
      validated_by_hr_id, created_by_hr_id, is_test
    )
    values (
      v_seat, v_line, v_list_type, v_name, nullif(trim(coalesce(p ->> 'speciality', '')), ''), null, 'new', 'active', now(),
      v_actor, v_actor, v_is_test
    )
    returning * into v_customer;

    insert into public.phoenix_crm_list_requests (
      seat_id, line_code, kind, customer_id, list_type, customer_name, current_grade, proposed_grade,
      requested_by_hr_id, is_test
    )
    values (v_seat, v_line, 'grade', v_customer.id, v_list_type, v_name, null, v_grade, v_actor, v_is_test)
    returning id into v_request_id;

  elsif v_mode = 'restore' then
    select c.* into v_customer
    from public.phoenix_crm_customers c
    where c.id = (p ->> 'customer_id')::uuid
      and c.seat_id = v_seat
      and c.is_test = v_is_test
    for update;
    if not found then
      raise exception 'phoenix_crm:customer_not_found';
    end if;
    if v_customer.status = 'active' then
      raise exception 'phoenix_crm:already_validated';
    end if;
    update public.phoenix_crm_customers c
    set status = 'active',
        validated_at = now(),
        validated_by_hr_id = v_actor,
        dropped_reason = null,
        dropped_note = null,
        status_changed_at = now(),
        updated_at = now()
    where c.id = v_customer.id
    returning c.* into v_customer;
    v_event := 'customer_restored';

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
      jsonb_build_object('kind', 'grade', 'proposed_grade', v_grade), v_is_test
    );
  end if;

  return jsonb_build_object(
    'customer_id', v_customer.id,
    'customer_name', v_customer.name,
    'list_type', v_customer.list_type,
    'place_id', v_place ->> 'place_id',
    'captured_at', v_place ->> 'captured_at',
    'restored', v_event = 'customer_restored',
    'grade_request_id', v_request_id
  );
end;
$$;

-- ── 4. Changing a customer's name and speciality, after validation ───────────────────────────────

-- Owner, 2026-09-22: the three captures are what validate a customer, "and after validated never
-- change it. But later can change his name, can change his grade." The proof is already immutable —
-- no path rewrites a place's photo, its coordinates or its capture time. This is the "later": the
-- territory's own rep corrects the name and the speciality iReports360 gave the customer. The grade
-- keeps its own route, because it sets the visit target: the rep proposes, the manager decides.
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
  v_customer public.phoenix_crm_customers%rowtype;
  v_before jsonb;
begin
  if v_seat is null or v_actor is null or v_customer_id is null or v_name is null then
    raise exception 'phoenix_crm:bad_input';
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

  v_before := jsonb_build_object('name', v_customer.name, 'speciality', v_customer.speciality);

  update public.phoenix_crm_customers c
  set name = left(v_name, 200),
      speciality = left(v_speciality, 120),
      updated_at = now()
  where c.id = v_customer.id
  returning c.* into v_customer;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, v_customer.id, 'customer_renamed', v_actor,
    jsonb_build_object('from', v_before, 'to', jsonb_build_object('name', v_customer.name, 'speciality', v_customer.speciality)),
    v_is_test
  );

  return jsonb_build_object(
    'customer_id', v_customer.id,
    'customer_name', v_customer.name,
    'speciality', v_customer.speciality
  );
end;
$$;

-- ── 5. Requests: a pending customer can be dropped, but not re-graded ────────────────────────────

-- The only change: a reference customer now HAS a row before it is validated, so finding one is no
-- longer proof that it was validated. A drop of a pending customer deliberately keeps customer_id null
-- on the request, which is what phoenix_crm_seat_reference reads to show 'drop_pending'.
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
  v_customer public.phoenix_crm_customers%rowtype;
  v_ref record;
  v_name text;
  v_list_type text;
  v_current_grade text;
  v_id uuid;
begin
  if v_seat is null or v_line is null or v_actor is null or v_kind not in ('grade', 'drop')
    or (v_customer_id is null and v_contact is null) then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_kind = 'grade' and coalesce(v_grade, '') not in ('A', 'B', 'C') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_kind = 'drop' and coalesce(v_reason, '') not in ('moved', 'retired', 'closed', 'not_target', 'duplicate', 'other') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_kind = 'drop' and v_reason = 'other' and v_note is null then
    raise exception 'phoenix_crm:note_required';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  if v_customer_id is null then
    select r.* into v_ref
    from public.phoenix_crm_seat_reference(array[v_seat], v_is_test) r
    where r.contact_crm_id = v_contact;
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
    if v_customer.status = 'dropped' then
      raise exception 'phoenix_crm:customer_dropped';
    end if;
    -- A customer who is not validated yet can be dropped off the list, but his grade decides his visit
    -- target, so it is only proposed once he is real.
    if v_kind = 'grade' and v_customer.status <> 'active' then
      raise exception 'phoenix_crm:not_validated';
    end if;
    if v_kind = 'grade' and v_customer.grade is not distinct from v_grade then
      raise exception 'phoenix_crm:same_grade';
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
    current_grade, proposed_grade, drop_reason, note, requested_by_hr_id, is_test
  )
  values (
    v_seat, v_line, v_kind, v_customer_id, v_contact, v_list_type, v_name,
    v_current_grade,
    case when v_kind = 'grade' then v_grade end,
    case when v_kind = 'drop' then v_reason end,
    v_note, v_actor, v_is_test
  )
  returning id into v_id;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, v_customer_id, v_id, 'request_created', v_actor,
    jsonb_build_object('kind', v_kind, 'proposed_grade', v_grade, 'drop_reason', v_reason, 'reference_contact_crm_id', v_contact),
    v_is_test
  );

  return jsonb_build_object(
    'request_id', v_id,
    'kind', v_kind,
    'customer_id', v_customer_id,
    'customer_name', v_name,
    'list_type', v_list_type
  );
end;
$$;

-- Approving the drop of a customer who was never validated now UPDATES the pending row instead of
-- refusing because a row exists. validated_at stays null, so his visits never count — which is right:
-- he was never validated.
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
  v_approve boolean := coalesce((p ->> 'approve')::boolean, false);
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_request public.phoenix_crm_list_requests%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_status text;
begin
  if v_actor is null or v_request_id is null then
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
    raise exception 'phoenix_crm:already_decided';
  end if;

  if v_approve then
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

    elsif v_request.customer_id is not null then
      select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_request.customer_id for update;
      -- Active or pending: both leave the list. A pending one keeps validated_at null, so the visits
      -- logged against him never start counting — he was never validated.
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

      update public.phoenix_crm_places pl
      set status = 'retired', retired_at = now(), retired_by_hr_id = v_actor, updated_at = now()
      where pl.customer_id = v_customer.id
        and pl.status = 'active';

      with withdrawn as (
        update public.phoenix_crm_list_requests q
        set status = 'withdrawn',
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
  end if;

  update public.phoenix_crm_list_requests q
  set status = v_status, decided_at = now(), decided_by_hr_id = v_actor, decision_note = v_note
  where q.id = v_request.id;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, coalesce(v_customer.id, v_request.customer_id), v_request.id, 'request_decided', v_actor,
    jsonb_build_object('kind', v_request.kind, 'decision', v_status), v_is_test
  );

  return jsonb_build_object(
    'request_id', v_request.id,
    'seat_id', v_seat,
    'kind', v_request.kind,
    'status', v_status,
    'customer_id', coalesce(v_customer.id, v_request.customer_id),
    'customer_name', v_request.customer_name,
    'list_type', v_request.list_type,
    'proposed_grade', v_request.proposed_grade,
    'drop_reason', v_request.drop_reason,
    'requested_by_hr_id', v_request.requested_by_hr_id
  );
end;
$$;

-- ── 6. Planning and visiting a pending customer ──────────────────────────────────────────────────

-- Two changes: a plan item may name a pending customer, and an item with no place (a pending customer
-- has none) skips the place check instead of failing it.
create or replace function public.phoenix_crm_save_plan(p jsonb)
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
  v_week date := nullif(p ->> 'week_start', '')::date;
  v_expected integer := nullif(p ->> 'expected_version', '')::integer;
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_days date[];
  v_plan public.phoenix_crm_plans%rowtype;
  v_items jsonb := p -> 'items';
  v_count integer;
begin
  if v_seat is null or v_line is null or v_actor is null or v_week is null
    or extract(isodow from v_week) <> 6
    or jsonb_typeof(v_items) is distinct from 'array'
    or jsonb_typeof(p -> 'editable_days') is distinct from 'array' then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select coalesce(array_agg(distinct d.value::date), '{}'::date[])
  into v_days
  from jsonb_array_elements_text(p -> 'editable_days') d;

  if exists (select 1 from unnest(v_days) d where d < v_today or d < v_week or d > v_week + 5) then
    raise exception 'phoenix_crm:day_not_editable';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:plan:' || v_seat || ':' || v_week::text));

  select pl.* into v_plan
  from public.phoenix_crm_plans pl
  where pl.seat_id = v_seat
    and pl.week_start = v_week
    and pl.is_test = v_is_test
  for update;

  if not found then
    if coalesce(v_expected, 0) <> 0 then
      raise exception 'phoenix_crm:version_conflict';
    end if;
    insert into public.phoenix_crm_plans (seat_id, line_code, week_start, status, version, created_by_hr_id, is_test)
    values (v_seat, v_line, v_week, 'draft', 1, v_actor, v_is_test)
    returning * into v_plan;

    insert into public.phoenix_crm_plan_events (plan_id, event_type, actor_hr_id, to_status, version)
    values (v_plan.id, 'created', v_actor, 'draft', 1);
  else
    if v_plan.status not in ('draft', 'returned') then
      raise exception 'phoenix_crm:not_editable';
    end if;
    if v_expected is distinct from v_plan.version then
      raise exception 'phoenix_crm:version_conflict';
    end if;
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_items) as x (plan_date date)
    where x.plan_date is null or not (x.plan_date = any (v_days))
  ) then
    raise exception 'phoenix_crm:day_not_editable';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_items) as x (customer_id uuid, list_type text)
    where not exists (
      select 1
      from public.phoenix_crm_customers c
      where c.id = x.customer_id
        and c.seat_id = v_seat
        and c.is_test = v_is_test
        and c.status in ('active', 'pending')
        and c.list_type = x.list_type
    )
  ) then
    raise exception 'phoenix_crm:customer_not_on_list';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_items) as x (customer_id uuid, place_id uuid)
    where x.place_id is not null
      and not exists (
        select 1
        from public.phoenix_crm_places pl
        where pl.id = x.place_id
          and pl.customer_id = x.customer_id
          and pl.status = 'active'
      )
  ) then
    raise exception 'phoenix_crm:place_changed';
  end if;

  delete from public.phoenix_crm_plan_items i
  where i.plan_id = v_plan.id
    and i.plan_date = any (v_days)
    and not exists (
      select 1
      from jsonb_to_recordset(v_items) as x (plan_date date, customer_id uuid)
      where x.plan_date = i.plan_date
        and x.customer_id = i.customer_id
    );

  insert into public.phoenix_crm_plan_items (
    plan_id, plan_date, customer_id, place_id, list_type, receives, start_minute, exception_type, exception_note
  )
  select distinct on (x.plan_date, x.customer_id)
    v_plan.id,
    x.plan_date,
    x.customer_id,
    x.place_id,
    x.list_type,
    coalesce(x.receives, false),
    x.start_minute,
    nullif(x.exception_type, ''),
    nullif(trim(coalesce(x.exception_note, '')), '')
  from jsonb_to_recordset(v_items) as x (
    plan_date date,
    customer_id uuid,
    place_id uuid,
    list_type text,
    receives boolean,
    start_minute integer,
    exception_type text,
    exception_note text
  )
  order by x.plan_date, x.customer_id
  on conflict (plan_id, plan_date, customer_id) do update
    set place_id = excluded.place_id,
        list_type = excluded.list_type,
        receives = excluded.receives,
        start_minute = excluded.start_minute,
        exception_type = excluded.exception_type,
        exception_note = excluded.exception_note,
        updated_at = now();

  select count(*)::integer into v_count from public.phoenix_crm_plan_items i where i.plan_id = v_plan.id;

  update public.phoenix_crm_plans pl
  set version = pl.version + 1, updated_at = now()
  where pl.id = v_plan.id
  returning pl.* into v_plan;

  insert into public.phoenix_crm_plan_events (plan_id, event_type, actor_hr_id, from_status, to_status, version, details)
  values (
    v_plan.id, 'saved', v_actor, v_plan.status, v_plan.status, v_plan.version,
    jsonb_build_object('items', v_count, 'days', to_jsonb(v_days))
  );

  return jsonb_build_object('plan_id', v_plan.id, 'status', v_plan.status, 'version', v_plan.version, 'item_count', v_count);
end;
$$;

-- One change: a pending customer accepts a visit. It saves with location_flag 'no_place', because
-- there is no validated place to measure the distance against yet.
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
  v_products text[];
  v_existing public.phoenix_crm_visits%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_captured_at timestamptz;
  v_date date;
begin
  if v_id is null or v_seat is null or v_line is null or v_actor is null or v_customer_id is null or v_photo is null
    or v_kind not in ('single', 'double', 'chain')
    or v_flag not in ('ok', 'far', 'weak_gps', 'no_place') then
    raise exception 'phoenix_crm:bad_input';
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

  insert into public.phoenix_crm_visits (
    id, seat_id, line_code, customer_id, list_type, visit_date, captured_at, kind, rep_hr_id, manager_hr_id,
    senior_hr_id, entered_by_hr_id, products, comment, photo_path, lat, lon, accuracy_meters, place_id,
    distance_meters, location_flag, device_skew_minutes, is_test
  )
  values (
    v_id, v_seat, v_line, v_customer.id, v_customer.list_type, v_date, v_captured_at, v_kind, v_rep, v_manager,
    v_senior, v_actor, v_products, v_comment, v_photo,
    (p ->> 'lat')::double precision,
    (p ->> 'lon')::double precision,
    (p ->> 'accuracy_meters')::numeric,
    v_place_id,
    (p ->> 'distance_meters')::integer,
    v_flag,
    (p ->> 'device_skew_minutes')::integer,
    v_is_test
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

-- ── 7. Reports: a pending customer counts in nothing, on either side ─────────────────────────────

-- Owner, 2026-09-22: a visit to a customer who is not validated yet "never counts in any metric", and
-- the moment he is validated the visits already logged against him start counting. Both halves are one
-- filter: validated_at is not null, read live at query time. Nothing is stamped on the visit row.

create or replace function public.phoenix_crm_report_visits_by_day(
  p_seat_ids text[],
  p_from date,
  p_to date,
  p_include_test boolean default false
)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.seat_id, t.visit_date, t.list_type, t.rep_hr_id), '[]'::jsonb)
  from (
    select
      v.seat_id,
      v.rep_hr_id,
      v.visit_date,
      v.list_type,
      count(*)::integer as visits,
      (count(*) filter (where v.kind = 'double'))::integer as double_visits,
      (count(*) filter (where v.kind = 'chain'))::integer as chain_visits,
      (count(*) filter (where v.location_flag = 'far'))::integer as far_visits,
      (count(*) filter (where v.is_test))::integer as test_visits
    from public.phoenix_crm_visits v
    -- A visit counts only once its customer is validated; then every earlier one counts too.
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    where v.seat_id = any (p_seat_ids)
      and v.visit_date between p_from and p_to
      and (p_include_test or not v.is_test)
    group by v.seat_id, v.rep_hr_id, v.visit_date, v.list_type
  ) t;
$$;

create or replace function public.phoenix_crm_report_plan_vs_actual(
  p_seat_ids text[],
  p_from date,
  p_to date,
  p_include_test boolean default false
)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  with plan_days as (
    select distinct pl.id as plan_id, i.plan_date
    from public.phoenix_crm_plans pl
    join public.phoenix_crm_plan_items i on i.plan_id = pl.id
    where pl.seat_id = any (p_seat_ids)
      and pl.week_start between p_from - 6 and p_to
      and i.plan_date between p_from and p_to
      and (p_include_test or not pl.is_test)
  ),
  sent_days as (
    select d.plan_id, d.plan_date
    from plan_days d
    where (
        select e.to_status
        from public.phoenix_crm_plan_events e
        where e.plan_id = d.plan_id
          and e.to_status is not null
          and e.created_at < ((d.plan_date + 1)::timestamp at time zone 'Africa/Cairo')
        order by e.created_at desc, e.id desc
        limit 1
      ) in ('submitted', 'approved', 'returned')
  ),
  planned as (
    select pl.seat_id, pl.is_test, i.plan_date, i.customer_id, i.list_type
    from sent_days s
    join public.phoenix_crm_plans pl on pl.id = s.plan_id
    join public.phoenix_crm_plan_items i on i.plan_id = s.plan_id and i.plan_date = s.plan_date
    -- The DENOMINATOR: planning a customer who is not validated yet is never held against the rep.
    join public.phoenix_crm_customers c on c.id = i.customer_id and c.validated_at is not null
  ),
  visited as (
    select v.seat_id, v.is_test, v.visit_date, v.customer_id, v.list_type
    from public.phoenix_crm_visits v
    -- The NUMERATOR: the same filter, so both sides move together.
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    where v.seat_id = any (p_seat_ids)
      and v.visit_date between p_from and p_to
      and (p_include_test or not v.is_test)
  ),
  joined as (
    select
      coalesce(pd.seat_id, vd.seat_id) as seat_id,
      coalesce(pd.plan_date, vd.visit_date) as day,
      coalesce(pd.list_type, vd.list_type) as list_type,
      pd.customer_id is not null as is_planned,
      vd.customer_id is not null as is_visited
    from planned pd
    full join visited vd
      on vd.seat_id = pd.seat_id
     and vd.is_test = pd.is_test
     and vd.visit_date = pd.plan_date
     and vd.customer_id = pd.customer_id
  )
  select coalesce(jsonb_agg(to_jsonb(t) order by t.seat_id, t.day, t.list_type), '[]'::jsonb)
  from (
    select
      j.seat_id,
      j.day,
      j.list_type,
      (count(*) filter (where j.is_planned))::integer as planned,
      (count(*) filter (where j.is_planned and j.is_visited))::integer as visited_planned,
      (count(*) filter (where j.is_planned and not j.is_visited))::integer as missed,
      (count(*) filter (where j.is_visited and not j.is_planned))::integer as unplanned
    from joined j
    group by j.seat_id, j.day, j.list_type
  ) t;
$$;

-- Coverage already counted only validated customers in `listed`. The same filter now also guards the
-- visits, so the rule is stated where it is read rather than inferred from the join.
create or replace function public.phoenix_crm_report_coverage(
  p_seat_ids text[],
  p_month_start date,
  p_include_test boolean default false
)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  with bounds as (
    select
      date_trunc('month', p_month_start::timestamp)::date as month_start,
      (date_trunc('month', p_month_start::timestamp) + interval '1 month')::date as next_month
  ),
  targets as (
    select s.grade_targets from public.phoenix_crm_settings s where s.id = 1
  ),
  listed as (
    select c.id, c.seat_id, c.list_type, c.grade
    from public.phoenix_crm_customers c
    cross join bounds b
    where c.seat_id = any (p_seat_ids)
      and (p_include_test or not c.is_test)
      and c.validated_at is not null
      and c.validated_at < (b.next_month::timestamp at time zone 'Africa/Cairo')
      and (c.status = 'active' or c.status_changed_at >= (b.month_start::timestamp at time zone 'Africa/Cairo'))
  ),
  month_visits as (
    select v.customer_id, count(*)::integer as visits
    from public.phoenix_crm_visits v
    cross join bounds b
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    where v.seat_id = any (p_seat_ids)
      and v.visit_date >= b.month_start
      and v.visit_date < b.next_month
      and (p_include_test or not v.is_test)
    group by v.customer_id
  ),
  scored as (
    select
      l.seat_id,
      l.list_type,
      coalesce(mv.visits, 0) as visits,
      case when l.grade is null then null else nullif(t.grade_targets -> l.list_type ->> l.grade, '')::integer end as target
    from listed l
    left join targets t on true
    left join month_visits mv on mv.customer_id = l.id
  )
  select coalesce(jsonb_agg(to_jsonb(r) order by r.seat_id, r.list_type), '[]'::jsonb)
  from (
    select
      s.seat_id,
      s.list_type,
      count(*)::integer as customers,
      (count(*) filter (where s.visits > 0))::integer as covered,
      (count(*) filter (where s.target is not null))::integer as with_target,
      (count(*) filter (where s.target is not null and s.visits = s.target))::integer as on_target,
      (count(*) filter (where s.target is not null and s.visits < s.target))::integer as under,
      (count(*) filter (where s.target is not null and s.visits > s.target))::integer as over,
      coalesce(sum(s.visits), 0)::integer as visits
    from scored s
    group by s.seat_id, s.list_type
  ) r;
$$;

create or replace function public.phoenix_crm_report_manager_visits(
  p_hr_ids text[],
  p_from date,
  p_to date,
  p_include_test boolean default false
)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  with people as (
    select distinct upper(trim(x.hr_id)) as hr_id
    from unnest(p_hr_ids) as x (hr_id)
    where nullif(trim(x.hr_id), '') is not null
  ),
  joined as (
    select pe.hr_id, 'manager'::text as role_on_visit, v.visit_date, v.seat_id, v.rep_hr_id, v.kind, v.list_type
    from people pe
    join public.phoenix_crm_visits v on v.manager_hr_id = pe.hr_id
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    where v.visit_date between p_from and p_to
      and v.kind in ('double', 'chain')
      and (p_include_test or not v.is_test)
    union all
    select pe.hr_id, 'senior'::text, v.visit_date, v.seat_id, v.rep_hr_id, v.kind, v.list_type
    from people pe
    join public.phoenix_crm_visits v on v.senior_hr_id = pe.hr_id
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    where v.visit_date between p_from and p_to
      and (p_include_test or not v.is_test)
  )
  select coalesce(jsonb_agg(to_jsonb(t) order by t.hr_id, t.visit_date, t.seat_id), '[]'::jsonb)
  from (
    select
      j.hr_id,
      j.role_on_visit,
      j.visit_date,
      j.seat_id,
      j.rep_hr_id,
      (count(*) filter (where j.kind = 'double'))::integer as double_visits,
      (count(*) filter (where j.kind = 'chain'))::integer as chain_visits,
      (count(*) filter (where j.list_type = 'AM'))::integer as am_visits,
      (count(*) filter (where j.list_type = 'PM'))::integer as pm_visits
    from joined j
    group by j.hr_id, j.role_on_visit, j.visit_date, j.seat_id, j.rep_hr_id
  ) t;
$$;

-- ── 8. Service role only, for the two new functions ──────────────────────────────────────────────
-- Every other function here keeps its argument list, so CREATE OR REPLACE keeps its existing grants.

revoke execute on function public.phoenix_crm_ensure_reference_customers(text, text, boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_ensure_reference_customers(text, text, boolean) to service_role;

revoke execute on function public.phoenix_crm_rename_customer(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_rename_customer(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
