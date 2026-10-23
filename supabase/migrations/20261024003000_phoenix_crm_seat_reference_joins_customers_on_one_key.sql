-- phoenix_crm_seat_reference_joins_customers_on_one_key
--
-- WHAT:     phoenix_crm_seat_reference finds each list entry's customer through ONE text key
--           (seat id + '|' + contact id) instead of two separate equalities. Its columns, types, order,
--           rows, security and ACL are unchanged; no row is written and no figure changes.
-- WHY:      The read under the List, the planners, the reference mint and phoenix_crm_seat_readiness (the
--           company-wide boards ask it for every started seat at once: 3,705 calls, mean 35 ms, worst 2.1 s
--           on production, 129 s in total). With all 111 started seats its body took ~540 ms, and its plan
--           showed why: the entries were left-joined to the seat_customer set on seat_id ALONE, with the
--           contact id as a join filter - 1,783,701 pairs built and thrown away to keep 11,658 rows.
-- HOW:      seat_customer carries seat_key = seat_id || '|' || contact id, and the entry joins on
--           ch.seat_id || '|' || a.contact_crm_id::text, one key the planner can sort or hash on. The
--           contact id is a bigint, so it has no '|' and the key splits uniquely from the right: two
--           (seat, contact) pairs share a key only when both parts are equal. The DISTINCT ON that picks
--           the customer, the pending-drop key sets and every other line are 20261016180200, word for word.
-- PROVEN:   on production (23 Oct 2026), inside a transaction that rolled back, the new body under a
--           scratch name against the live function for EVERY seat (11,683 rows), both directions with
--           `except all` on every column, for is_test false and true: 0 rows each way. Body timing,
--           111 started seats: 803 ms -> 504 ms in the same session (join filter gone).
-- ROLLBACK: re-apply 20261016180200_phoenix_crm_seat_reference_joins_once.sql.
--
-- Production has NO point-in-time recovery - 7 daily backups are the whole recovery story. This file
-- writes no row: it replaces one function's definition.

begin;

set local lock_timeout = '5s';

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
  ),
  -- 🔴 THE CUSTOMER BEHIND AN ENTRY IS FOUND BY THE ID THE ASSIGNMENT CARRIES, which for a doctor the rep
  -- added himself is his OWN id (the refresh keys on coalesce(reference_contact_crm_id, own_contact_crm_id)).
  -- Matching the vendor id alone returned NULL for him, and a NULL customer is what
  -- phoenix_crm_ensure_reference_customers mints a pending copy for -- a second live row for one doctor.
  -- One row per entry: when a seat already holds a pair (an original and its copy), the live one wins,
  -- then the active one, then the earliest. Picked ONCE per seat and id, not once per entry.
  seat_customer as (
    select distinct on (c.seat_id, coalesce(c.reference_contact_crm_id, c.own_contact_crm_id))
      c.seat_id,
      coalesce(c.reference_contact_crm_id, c.own_contact_crm_id) as contact_crm_id,
      c.seat_id || '|' || coalesce(c.reference_contact_crm_id, c.own_contact_crm_id)::text as seat_key,
      c.id,
      c.status
    from public.phoenix_crm_customers c
    join seats s on s.seat_id = c.seat_id
    where c.is_test = p_is_test
    order by
      c.seat_id,
      coalesce(c.reference_contact_crm_id, c.own_contact_crm_id),
      (c.status <> 'dropped') desc,
      (c.status = 'active') desc,
      c.created_at asc,
      c.id asc
  ),
  -- A pending drop names either the customer, or -- for an entry never minted -- only the contact.
  pending_drop_customer as (
    select distinct q.seat_id, q.customer_id
    from public.phoenix_crm_list_requests q
    join seats s on s.seat_id = q.seat_id
    where q.kind = 'drop'
      and q.status = 'pending'
      and q.is_test = p_is_test
      and q.customer_id is not null
  ),
  pending_drop_contact as (
    select distinct q.seat_id, q.reference_contact_crm_id
    from public.phoenix_crm_list_requests q
    join seats s on s.seat_id = q.seat_id
    where q.kind = 'drop'
      and q.status = 'pending'
      and q.is_test = p_is_test
      and q.customer_id is null
      and q.reference_contact_crm_id is not null
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
      when drop_by_customer.seat_id is not null or drop_by_contact.seat_id is not null then 'drop_pending'
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
  left join seat_customer customer
    on customer.seat_key = ch.seat_id || '|' || a.contact_crm_id::text
  left join pending_drop_customer drop_by_customer
    on drop_by_customer.seat_id = ch.seat_id
   and drop_by_customer.customer_id = customer.id
  left join pending_drop_contact drop_by_contact
    on drop_by_contact.seat_id = ch.seat_id
   and drop_by_contact.reference_contact_crm_id = a.contact_crm_id;
$$;

revoke execute on function public.phoenix_crm_seat_reference(text[], boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_seat_reference(text[], boolean) to service_role;

notify pgrst, 'reload schema';

commit;
