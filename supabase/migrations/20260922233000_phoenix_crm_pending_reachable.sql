-- Phoenix CRM — a carried-over customer stays reachable, and a late validation reopens his month.
--
-- Two of the owner's ten rules for the pending list were reachable only while iReports360 kept the
-- rep assigned to the contact, or only within the month he happened to validate in.
--
-- 1. RULE 1 — "it leaves only by being validated or removed."
--
--    Both doors ran through phoenix_crm_seat_reference, which reads crm_contact_assignments with
--    `a.effective_to is null`. When iReports360 ends an assignment the pending phoenix_crm_customers
--    row rightly survives (there is no sweep, and that is the rule) — but the row then answers to
--    NEITHER door: phoenix_crm_validate_customer and phoenix_crm_create_request both raised
--    'phoenix_crm:not_on_reference_list' while the customer's card went on offering Validate and
--    Remove. He could not be validated, and he could not be dropped: a carried-over customer with no
--    way off the list at all, which is the exact state rule 1 forbids.
--
--    phoenix_crm_reference_entry below resolves one contact the way both functions need: the live
--    reference row when there is one, and otherwise the surviving customer row, with the same
--    'state' vocabulary seat_reference uses ('dropped' | 'validated' | 'drop_pending' | 'open').
--    A contact that is on neither still raises not_on_reference_list, so a typo is still refused.
--
-- 2. RULE 5 — "on validation his already-logged visits start counting", ruled literally by the owner
--    on 2026-09-22: a rep visited in September and validated in October has those September visits
--    counted in September.
--
--    Visits-by-day and plan-vs-actual already did this — they carry no stamp and re-read
--    `validated_at is not null` live. Coverage did not: its `listed` CTE also demanded
--    `c.validated_at < next_month`, so a month that closed before the validation never reopened and
--    those visits never started counting there. That bound is dropped. The clause beside it —
--    `status = 'active' or status_changed_at >= month_start` — stays, so a customer dropped later
--    still belongs to the month he was dropped in.
--
--    Past coverage figures may move when a rep validates an old customer. That is the ruling, not a
--    side effect.
--
-- The three function bodies below are 20260922180258's, extracted verbatim and changed only in the
-- ways described above. They were generated, not retyped: the previous migration in this area
-- introduced a live regression by restating a function by hand.

-- ── The one place a reference contact is resolved ─────────────────────────────────────────────────

create or replace function public.phoenix_crm_reference_entry(
  p_seat_id text,
  p_contact_crm_id bigint,
  p_is_test boolean default false
)
returns table (
  contact_crm_id bigint,
  list_type text,
  grade text,
  name text,
  speciality text,
  customer_id uuid,
  state text
)
language sql
stable
security definer
set search_path to 'public'
as $$
  -- The live reference list first: while iReports360 still has the rep assigned, nothing changes.
  select r.contact_crm_id, r.list_type, r.grade, r.name, r.speciality, r.customer_id, r.state
  from public.phoenix_crm_seat_reference(array[p_seat_id], p_is_test) r
  where r.contact_crm_id = p_contact_crm_id
  union all
  -- The assignment ended, but the customer the rep carried over is still on his list, because that is
  -- the rule. He is resolved from his own row, with seat_reference's own state vocabulary so that
  -- every caller reads him exactly as it would read a live one.
  select
    c.reference_contact_crm_id,
    c.list_type,
    c.grade,
    c.name,
    c.speciality,
    c.id,
    case
      when c.status = 'dropped' then 'dropped'
      when c.status = 'active' then 'validated'
      when exists (
        select 1
        from public.phoenix_crm_list_requests q
        where q.seat_id = c.seat_id
          and q.kind = 'drop'
          and q.status = 'pending'
          and q.is_test = p_is_test
          and (q.customer_id = c.id or (q.customer_id is null and q.reference_contact_crm_id = c.reference_contact_crm_id))
      ) then 'drop_pending'
      else 'open'
    end
  from public.phoenix_crm_customers c
  where c.seat_id = p_seat_id
    and c.is_test = p_is_test
    and c.reference_contact_crm_id = p_contact_crm_id
    and not exists (
      select 1
      from public.phoenix_crm_seat_reference(array[p_seat_id], p_is_test) r2
      where r2.contact_crm_id = p_contact_crm_id
    )
  limit 1;
$$;

revoke execute on function public.phoenix_crm_reference_entry(text, bigint, boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_reference_entry(text, bigint, boolean) to service_role;

-- ── Rule 1: both doors resolve through the helper ────────────────────────────────────────────────

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
    from public.phoenix_crm_reference_entry(v_seat, (p ->> 'reference_contact_crm_id')::bigint, v_is_test) r;
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

-- ── Rule 5: coverage reopens the month a late validation belongs to ──────────────────────────────
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


-- `create or replace` keeps each existing ACL. Restated so the migration reads on its own, and
-- because `revoke ... from anon, authenticated` WITHOUT `public` is the silent no-op this repo's
-- secdef guard exists to catch: both roles inherit EXECUTE through PUBLIC membership. Revoking
-- PUBLIC on a default ACL also strips service_role, so each grant below is not optional.
revoke execute on function public.phoenix_crm_validate_customer(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_validate_customer(jsonb) to service_role;
revoke execute on function public.phoenix_crm_create_request(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_create_request(jsonb) to service_role;
revoke execute on function public.phoenix_crm_report_coverage(text[], date, boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_report_coverage(text[], date, boolean) to service_role;

notify pgrst, 'reload schema';
