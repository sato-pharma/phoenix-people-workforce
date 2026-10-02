-- phoenix_crm_seat_reference_and_place_removal
--
-- WHAT THIS CHANGES:
--   1. `phoenix_crm_seat_reference` attributes each iReports360 assignment to the SEAT its rep held
--      when the assignment was made, instead of to whatever seat he holds today.
--   2. `phoenix_crm_update_place` refuses a place belonging to a customer in the Archive, and a
--      removal now needs the same written reason a move does and keeps it on the audited event.
--   3. `phoenix_crm_validate_customer` loses its `restore` mode, which inserted an ACTIVE place onto an
--      archived customer with no five-clinic cap.
--   4. A one-time, tightly guarded delete of the pending customers the old resolution in (1) minted
--      into the wrong seat — 229 rows on production, pre-imaged first into
--      `phoenix_crm_backup_20261002.misminted_reference_customers`.
--
-- WHY:
--   (1) Owner's ruling, 2026-10-02, asked directly: a rep's carried-over list belongs to the SEAT, not
--       to the person. Measured on production the same day: AI-0002 moved from SEAT-AIF-REP-AB1 to
--       SEAT-PED-REP-AB1 and B-177 from SEAT-AIF-REP-AB5 to SEAT-PED-REP-AB5 on 2026-10-01 — same area,
--       different LINE, different district manager. Because the function picks the seat's occupant and
--       then reads HIS live `crm_contact_assignments`, the two PEDIA seats inherited their reps'
--       ANTI-INFECTIVE lists: 154 and 189 reference rows, of which 105 and 124 had already been minted
--       as pending `phoenix_crm_customers` with `line_code = 'pedia'`. Every one of those assignments
--       was made (effective_from 2026-08-28 … 2026-09-29) while the rep held his OLD seat, whose
--       occupancy ran to 2026-10-01, so the window test below places them where they belong. Measured
--       against every REP seat in the company: those are the ONLY two seats whose reference changes;
--       8,568 of 8,597 live AM/PM assignments fall inside one of their own agent's rep-seat windows, and
--       the 29 that fall inside none keep today's behaviour through the fallback, so no other seat loses
--       a single row.
--   (2) `place_retired` was written with `'{}'` for details: the one question anybody would ask of a
--       removal — why — had no answer on the record. And the visits already stamped against the removed
--       clinic kept their "ok", measured against a door the movers had just decided was not the
--       customer's — which is exactly how a far visit reads as near on the place-vs-actual report. The
--       re-measure is the application's (`retirePlace` → `restampVisitLocationsQuietly`, scope "all").
--       The Archive is frozen, so editing an archived customer's place was a hole through it.
--   (3) No caller sends `mode = 'restore'` — the web, the out-of-list entry and the phone all send
--       `reference`, `new` or `outside`, and a bring-back is a REQUEST decided by the district manager
--       then SFE. What the mode did for anyone posting the shape by hand was add an active place to a
--       customer in the Archive, outside the cap `phoenix_crm_add_place` enforces.
--   (4) Those 229 rows are not a record of anything that happened: all are `pending`, `origin =
--       'reference'`, with NO place, NO visit, NO plan item, NO list request, NO unplanned visit and NO
--       visit ask — only the `customer_minted` event each, which is KEPT (nothing references
--       `phoenix_crm_list_events.customer_id`, so the audit trail survives the delete). Leaving them
--       would put 229 anti-infective doctors in a pedia rep's "To validate" for ever, reachable by
--       nothing but one drop request each.
--
-- ROLLBACK:
--   1–3 are `create or replace function`: re-apply the previous definitions from
--      20261002150353_phoenix_crm_pharmacy_reference.sql (seat_reference),
--      20260923020000_phoenix_crm_place_location_is_frozen.sql (update_place) and
--      20260930235705_phoenix_crm_customer_phone.sql (validate_customer).
--   4 is NOT reversible by re-running anything: the rows are restored only from the pre-image —
--      `insert into public.phoenix_crm_customers select * from
--       phoenix_crm_backup_20261002.misminted_reference_customers;` — which is why it is taken and
--      counted in the same transaction, before the delete.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

-- ── 1. A seat's reference list is what was assigned while its rep held THAT seat ──────────────────

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
    -- DELIBERATELY still AM/PM only — see the header. This picks the PERSON, not the rows.
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
  ),
  -- Every rep-seat spell this company has on record, which is what says WHICH seat a dated assignment
  -- was made for. Rep seats only: a manager's spell is not a doctor list.
  rep_spells as (
    select upper(trim(o.occupant_hr_id)) as hr_id, o.seat_id, o.effective_from, o.effective_to
    from au.occupancy_history o
    join au.seats s on s.seat_id = o.seat_id
    where o.node_type = 'person'
      and s.seat_tier = 'REP'
      and nullif(trim(o.occupant_hr_id), '') is not null
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
   -- THE WHOLE IMPORT: the rep's pharmacies come across beside his AM and PM contacts.
   and a.list_type in ('AM', 'PM', 'Pharmacy')
   and a.contact_crm_id <> 100000
   -- 🔴 AND THE LIST BELONGS TO THE SEAT (owner, 2026-10-02). The assignment counts for THIS seat when
   -- it was made during one of his spells in it; a rep who changes line but keeps his area therefore
   -- leaves his old list with the old seat instead of minting it into the new one. The second arm is
   -- the fallback that keeps every ordinary seat exactly as it was: where an assignment predates every
   -- rep-seat spell this company has recorded for him, nothing can say which seat it was for, so it
   -- stays with the occupant — 29 of 8,597 live rows on production, none of them on a moved rep.
   and (
     exists (
       select 1 from rep_spells mine
       where mine.hr_id = ch.hr_id
         and mine.seat_id = ch.seat_id
         and a.effective_from >= mine.effective_from
         and (mine.effective_to is null or a.effective_from < mine.effective_to)
     )
     or not exists (
       select 1 from rep_spells any_seat
       where any_seat.hr_id = ch.hr_id
         and a.effective_from >= any_seat.effective_from
         and (any_seat.effective_to is null or a.effective_from < any_seat.effective_to)
     )
   )
  left join public.crm_contacts contact on contact.contact_crm_id = a.contact_crm_id
  left join public.phoenix_crm_customers customer
    on customer.seat_id = ch.seat_id
   and customer.reference_contact_crm_id = a.contact_crm_id
   and customer.is_test = p_is_test;
$$;

-- ── 2. Removing a place: a written reason, and never into the Archive ─────────────────────────────

create or replace function public.phoenix_crm_update_place(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_action text := coalesce(p ->> 'action', '');
  -- The same bounds a move's reason has (phoenix_crm_move_place, place-move.ts).
  v_reason text := nullif(regexp_replace(trim(coalesce(p ->> 'reason', '')), '\s+', ' ', 'g'), '');
  v_status text;
  v_place public.phoenix_crm_places%rowtype;
  v_after public.phoenix_crm_places%rowtype;
begin
  if v_seat is null or v_actor is null or nullif(p ->> 'place_id', '') is null or v_action not in ('edit', 'retire') then
    raise exception 'phoenix_crm:bad_input';
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

  -- The Archive is frozen (owner, 2026-09-29). A dropped customer's clinics are the record of where he
  -- was; neither the rep's edit nor a mover's removal reaches them while he is in there. He comes back
  -- through "Ask to bring back" — the district manager, then SFE — and is editable again after that.
  select c.status into v_status from public.phoenix_crm_customers c where c.id = v_place.customer_id;
  if v_status = 'dropped' then
    raise exception 'phoenix_crm:archived';
  end if;

  if v_action = 'edit' then
    if jsonb_typeof(p -> 'timings') is distinct from 'array' or jsonb_array_length(p -> 'timings') = 0 then
      raise exception 'phoenix_crm:bad_input';
    end if;
    update public.phoenix_crm_places pl
    set timings = p -> 'timings',
        label = nullif(trim(coalesce(p ->> 'label', '')), ''),
        updated_at = now()
    where pl.id = v_place.id
    returning pl.* into v_after;

    insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
    values (
      v_seat, v_place.customer_id, v_place.id, 'place_updated', v_actor,
      jsonb_build_object(
        'before', jsonb_build_object('timings', v_place.timings, 'label', v_place.label),
        'after', jsonb_build_object('timings', v_after.timings, 'label', v_after.label)
      ),
      v_is_test
    );
  else
    -- A removal is a change of where the customer is, exactly as a move is, so it is kept on record the
    -- same way. Without this the event read `'{}'` and the reason existed nowhere at all.
    if v_reason is null or char_length(v_reason) < 10 or char_length(v_reason) > 500 then
      raise exception 'phoenix_crm:reason_required';
    end if;
    if not exists (
      select 1
      from public.phoenix_crm_places pl
      where pl.customer_id = v_place.customer_id
        and pl.status = 'active'
        and pl.id <> v_place.id
    ) then
      raise exception 'phoenix_crm:last_place';
    end if;
    update public.phoenix_crm_places pl
    set status = 'retired', retired_at = now(), retired_by_hr_id = v_actor, updated_at = now()
    where pl.id = v_place.id;

    insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
    values (
      v_seat, v_place.customer_id, v_place.id, 'place_retired', v_actor,
      jsonb_build_object('reason', v_reason, 'label', v_place.label, 'lat', v_place.lat, 'lon', v_place.lon),
      v_is_test
    );
  end if;

  return jsonb_build_object('place_id', v_place.id, 'customer_id', v_place.customer_id);
end;
$$;

-- ── 3. Validating a customer: the `restore` mode is gone ──────────────────────────────────────────

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

  -- 🔴 THERE WAS A `restore` MODE HERE AND IT IS RETIRED (2026-10-02). It filed a bring-back request
  -- and then fell through to `phoenix_crm_insert_place`, which added an ACTIVE place to a customer
  -- sitting in the Archive, with no status check and outside the five-clinic cap `phoenix_crm_add_place`
  -- enforces. No caller ever sent it: the web, the out-of-list entry and the phone send `reference`,
  -- `new` or `outside`, and a bring-back is a request decided by the district manager then SFE. The
  -- Archive is frozen, so a mode that writes into it is `bad_input` like any other unknown mode.
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

-- `create or replace` keeps each existing ACL. Restated because `revoke ... from anon, authenticated`
-- WITHOUT `public` is the silent no-op this repo's secdef guard exists to catch: both roles inherit
-- EXECUTE through PUBLIC membership. Revoking PUBLIC on a default ACL also strips service_role, so each
-- grant below is not optional.
revoke execute on function public.phoenix_crm_seat_reference(text[], boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_seat_reference(text[], boolean) to service_role;
revoke execute on function public.phoenix_crm_update_place(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_update_place(jsonb) to service_role;
revoke execute on function public.phoenix_crm_validate_customer(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_validate_customer(jsonb) to service_role;

-- ── 4. The rows the old resolution minted into the wrong seat ─────────────────────────────────────

create schema if not exists phoenix_crm_backup_20261002;
revoke all on schema phoenix_crm_backup_20261002 from public, anon, authenticated;

-- The pre-image, taken BEFORE the delete and in the same transaction, because nothing else can restore
-- these rows: production has no point-in-time recovery.
create table if not exists phoenix_crm_backup_20261002.misminted_reference_customers
  (like public.phoenix_crm_customers);
revoke all on table phoenix_crm_backup_20261002.misminted_reference_customers from public, anon, authenticated;

with rep_spells as (
  select upper(trim(o.occupant_hr_id)) as hr_id, o.seat_id, o.effective_from, o.effective_to
  from au.occupancy_history o
  join au.seats s on s.seat_id = o.seat_id
  where o.node_type = 'person'
    and s.seat_tier = 'REP'
    and nullif(trim(o.occupant_hr_id), '') is not null
),
misminted as (
  select c.*
  from public.phoenix_crm_customers c
  where c.status = 'pending'
    and c.origin = 'reference'
    and c.reference_contact_crm_id is not null
    -- The contact is assigned to somebody who occupies THIS seat, by an assignment made while he held a
    -- DIFFERENT rep seat and none of his spells in this one — i.e. a row that exists only because the
    -- old resolution read the person's list instead of the seat's.
    and exists (
      select 1
      from public.crm_contact_assignments a
      join rep_spells here on here.hr_id = upper(trim(a.agent_hr_id)) and here.seat_id = c.seat_id
      where a.contact_crm_id = c.reference_contact_crm_id
        and a.list_type in ('AM', 'PM', 'Pharmacy')
        and a.contact_crm_id <> 100000
        and exists (
          select 1 from rep_spells other
          where other.hr_id = upper(trim(a.agent_hr_id))
            and other.seat_id <> c.seat_id
            and a.effective_from >= other.effective_from
            and (other.effective_to is null or a.effective_from < other.effective_to)
        )
        and not exists (
          select 1 from rep_spells mine
          where mine.hr_id = upper(trim(a.agent_hr_id))
            and mine.seat_id = c.seat_id
            and a.effective_from >= mine.effective_from
            and (mine.effective_to is null or a.effective_from < mine.effective_to)
        )
    )
    -- Nothing has happened to him. Every child table of phoenix_crm_customers is listed, so the delete
    -- can never trip a foreign key half-way through, and a row anybody has touched is never in scope:
    -- a carried-over customer whose assignment merely ENDED stays on the list by the owner's own rule
    -- (20260922233000), and the clauses above are what keep him out of this.
    and not exists (select 1 from public.phoenix_crm_places p where p.customer_id = c.id)
    and not exists (select 1 from public.phoenix_crm_visits v where v.customer_id = c.id)
    and not exists (select 1 from public.phoenix_crm_plan_items i where i.customer_id = c.id)
    and not exists (select 1 from public.phoenix_crm_list_requests q where q.customer_id = c.id)
    and not exists (select 1 from public.phoenix_crm_unplanned_visits u where u.customer_id = c.id)
    and not exists (select 1 from public.phoenix_crm_visit_asks k where k.customer_id = c.id)
)
insert into phoenix_crm_backup_20261002.misminted_reference_customers
select * from misminted
where not exists (
  select 1 from phoenix_crm_backup_20261002.misminted_reference_customers b where b.id = misminted.id
);

-- SAFE: pre-imaged one statement above, row for row, and the delete can only reach a row that is in the
-- pre-image. The `customer_minted` events are deliberately KEPT — nothing references
-- phoenix_crm_list_events.customer_id, so the trail of what was minted survives.
delete from public.phoenix_crm_customers c
where exists (
  select 1 from phoenix_crm_backup_20261002.misminted_reference_customers b where b.id = c.id
);

commit;
