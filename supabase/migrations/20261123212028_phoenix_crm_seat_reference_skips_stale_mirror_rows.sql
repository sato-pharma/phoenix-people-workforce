-- phoenix_crm_seat_reference_skips_stale_mirror_rows
--
-- WHAT:     phoenix_crm_seat_reference no longer returns an entry whose assignment came from Phoenix CRM
--           itself (crm_contact_assignments.source = 'phoenix_crm') when no customer on the seat carries
--           that contact. Every other line is 20261024003000, word for word; columns, types, order,
--           security and ACL are unchanged. No row is written.
-- WHY:      23 Nov 2026: a vacant area's list (Down town) was moved to three reps and moved back two hours
--           later. While the customers sat on the receiving seats, the hourly refresh (pass 5b) opened a
--           phoenix_crm assignment for each one; the move back did not close them. A minute later
--           phoenix_crm_ensure_reference_customers read them through this function, found no customer,
--           and minted a pending "To validate" copy of each - Ali Hassan (Cairo East 1) got 73 doctors and
--           24 pharmacies of Down town, 818 copies on 12 seats in all. A phoenix_crm row is only a mirror
--           of a customer, so with no customer on the seat it is always a leftover, never a list entry.
-- HOW:      seat_mirror holds every seat + contact key any customer of the asked seats carries - live,
--           test or dropped, so the test reading (whose seat_customer holds only test rows) keeps every
--           mirror row a real customer stands behind. One left join on that one key, then one WHERE:
--           keep the row when its source is anything but phoenix_crm, or when the key is found.
-- PROVEN:   on production (23 Nov 2026, after the leftovers were cleared), inside a block that rolled
--           back, the new body and the 20261024003000 body under scratch names against the live function
--           for all 142 seats, both directions with `except all` on every column, is_test false and true:
--           the old body equals live 0/0 both times, and the new body removes 0 and adds 0 both times.
--           With one Down town customer put back as a leftover on Ali Hassan's seat, live returns it with
--           no customer (what the mint copies) and the new body does not.
-- ROLLBACK: re-apply 20261024003000_phoenix_crm_seat_reference_joins_customers_on_one_key.sql.
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
  -- 🔴 A PHOENIX_CRM ASSIGNMENT IS ONLY A MIRROR OF A CUSTOMER ON THE SEAT: the hourly refresh (pass 5b)
  -- opens one for every customer it finds there. Every key a customer of the seat carries, live, test or
  -- dropped, so a mirror row with none behind it can be told apart from the vendor list.
  seat_mirror as (
    select distinct c.seat_id || '|' || coalesce(c.reference_contact_crm_id, c.own_contact_crm_id)::text as seat_key
    from public.phoenix_crm_customers c
    join seats s on s.seat_id = c.seat_id
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
   and drop_by_contact.reference_contact_crm_id = a.contact_crm_id
  left join seat_mirror mirror
    on mirror.seat_key = ch.seat_id || '|' || a.contact_crm_id::text
  -- A mirror row with no customer of the seat behind it is a leftover of a customer who has since moved
  -- away; read as a list entry, phoenix_crm_ensure_reference_customers would mint a pending copy of him
  -- back onto this list. Every other source (the vendor list) reads exactly as before.
  where a.source is distinct from 'phoenix_crm'
     or mirror.seat_key is not null;
$$;

revoke execute on function public.phoenix_crm_seat_reference(text[], boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_seat_reference(text[], boolean) to service_role;

notify pgrst, 'reload schema';

commit;
