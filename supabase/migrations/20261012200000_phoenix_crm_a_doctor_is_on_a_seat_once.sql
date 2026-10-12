-- =============================================================================
-- A DOCTOR A REP ADDED HIMSELF IS NEVER MINTED A SECOND TIME
-- =============================================================================
-- WHAT: three changes, no row touched.
--   1. phoenix_crm_seat_reference matches a seat's customer to a reference entry by
--      coalesce(reference_contact_crm_id, own_contact_crm_id) -- the same id the fifth pass of the doctor-list
--      refresh gives the doctor -- and no longer by the vendor id alone.
--   2. phoenix_crm_ensure_reference_customers also skips a contact that is the own id of a customer already
--      on the seat. It cannot reach one now (1 above), and says so in the code.
--   3. A BEFORE INSERT trigger on phoenix_crm_customers refuses a customer whose reference_contact_crm_id is
--      the own id of a customer already on the same seat and test flag.
--
-- WHY: the owner, 2026-10-12: "stop a rep adding a doctor who is already on his list". A rep added a doctor on
--      10 Oct (own id 1000038395, origin 'new') and the next morning the seat held a second live row for him,
--      created BY THE SYSTEM, not by the rep: reference 1000038395, own id 1000038463, origin 'reference',
--      status 'pending'. The chain, read from the live definitions:
--        a. the hourly refresh gives the rep's Phoenix list as assignments keyed on
--           coalesce(reference_contact_crm_id, own_contact_crm_id), so the doctor he added is an assignment
--           whose contact id is his OWN id;
--        b. phoenix_crm_seat_reference joined the seat's customers on reference_contact_crm_id = that contact
--           id only, so that doctor came back with customer_id NULL -- "carried over and not minted yet";
--        c. phoenix_crm_ensure_reference_customers, which runs on every read of the list, planner and visit
--           form, minted a pending reference row for every entry with a null customer_id.
--      The unique index (seat_id, reference_contact_crm_id, is_test) could not stop it: the original row's
--      reference id is NULL, and the copy's reference id is the original's OWN id, a different column.
--      Measured on production 2026-10-12: 158 doctor/list keys hold more than one live customer row.
--
-- NOT HERE: the rows that already exist. Nothing is merged, dropped or deleted, and there is still no unique
--      index over the doctor, because existing pairs could not satisfy one. A cleanup is a decision about
--      which row keeps the visits, and is the owner's.
--
-- RECREATED FROM THE LIVE BODIES read on production ozucdzovmcqvepbozvqf on 2026-10-12; each is
--      SECURITY DEFINER with search_path 'public', unchanged.
-- ROLLBACK: re-apply the definitions in 20261002224250_phoenix_crm_seat_reference_and_place_removal.sql
--      (phoenix_crm_seat_reference) and 20260922180258_phoenix_crm_pending_customers.sql
--      (phoenix_crm_ensure_reference_customers), then
--      drop trigger phoenix_crm_customers_no_double_add on public.phoenix_crm_customers;
--      drop function public.phoenix_crm_customers_no_double_add();
-- =============================================================================

begin;

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
  ),
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
   and a.list_type in ('AM', 'PM', 'Pharmacy')
   and a.contact_crm_id <> 100000
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
  -- 🔴 THE CUSTOMER BEHIND AN ENTRY IS FOUND BY THE ID THE ASSIGNMENT CARRIES, which for a doctor the rep
  -- added himself is his OWN id (the refresh keys on coalesce(reference_contact_crm_id, own_contact_crm_id)).
  -- Matching the vendor id alone returned NULL for him, and a NULL customer is what
  -- phoenix_crm_ensure_reference_customers mints a pending copy for -- a second live row for one doctor.
  -- One row per entry: when a seat already holds a pair (an original and its copy), the live one wins,
  -- then the active one, then the earliest.
  left join lateral (
    select c.id, c.status
    from public.phoenix_crm_customers c
    where c.seat_id = ch.seat_id
      and c.is_test = p_is_test
      and (
        c.reference_contact_crm_id = a.contact_crm_id
        or (c.reference_contact_crm_id is null and c.own_contact_crm_id = a.contact_crm_id)
      )
    order by (c.status <> 'dropped') desc, (c.status = 'active') desc, c.created_at asc, c.id asc
    limit 1
  ) customer on true;
$$;

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
      -- A doctor the rep added himself already IS a customer under his own id. seat_reference finds him
      -- now; this stays so that a later change to it can never mint his copy (and so that the insert
      -- trigger below is never what a read of the list runs into).
      and not exists (
        select 1
        from public.phoenix_crm_customers own
        where own.seat_id = v_seat
          and own.is_test = p_is_test
          and own.own_contact_crm_id = r.contact_crm_id
      )
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

-- The backstop: whatever door a row arrives by, a doctor already on the seat under his own id is not
-- inserted a second time as a reference to himself.
create or replace function public.phoenix_crm_customers_no_double_add()
returns trigger
language plpgsql
as $$
begin
  if new.reference_contact_crm_id is not null and exists (
    select 1
    from public.phoenix_crm_customers c
    where c.seat_id = new.seat_id
      and c.is_test = new.is_test
      and c.own_contact_crm_id = new.reference_contact_crm_id
      and c.id <> new.id
  ) then
    raise exception 'phoenix_crm:doctor_already_on_list'
      using hint = 'A customer on this seat already answers to ' || new.reference_contact_crm_id
                || ' as his own id. That is this doctor; he is not added a second time.';
  end if;
  return new;
end $$;

comment on function public.phoenix_crm_customers_no_double_add() is
  'Refuses a customer row whose reference_contact_crm_id is the own_contact_crm_id of a customer already on '
  'the same seat: that is a doctor the rep added himself, pointed at again (owner, 2026-10-12: "stop a rep '
  'adding a doctor who is already on his list"). Insert only; existing pairs are untouched.';

drop trigger if exists phoenix_crm_customers_no_double_add on public.phoenix_crm_customers;
create trigger phoenix_crm_customers_no_double_add
  before insert on public.phoenix_crm_customers
  for each row execute function public.phoenix_crm_customers_no_double_add();

-- Both functions are replaced with `create or replace`, which keeps the live ACL (service_role only).
-- Restated so this file is true on its own and `check:migrations` sees the revoke.
revoke execute on function public.phoenix_crm_seat_reference(text[], boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_seat_reference(text[], boolean) to service_role;
revoke execute on function public.phoenix_crm_ensure_reference_customers(text, text, boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_ensure_reference_customers(text, text, boolean) to service_role;

commit;
