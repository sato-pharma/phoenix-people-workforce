-- The seat reference finds each entry's customer and pending drop with ONE join each, not one lookup per entry.
--
-- WHY (2026-10-16 Phoenix CRM performance audit). `phoenix_crm_seat_reference` is the read under the List,
-- the planners, the reference mint (`phoenix_crm_ensure_reference_customers`, which runs on every open of
-- the List, the planner and the visit form) and the readiness counts — a seat's whole iReports360 list,
-- several hundred entries, and the company-wide boards ask it for every seat at once. Since
-- 20261012200000 it found each entry's customer with a LATERAL subquery whose OR condition
-- (`reference_contact_crm_id = X or (reference_contact_crm_id is null and own_contact_crm_id = X)`) no
-- single index answers, so every entry re-read and re-sorted its seat's customers: rows x customers per
-- seat. The `drop_pending` state did the same with a correlated EXISTS per entry.
--
-- WHAT CHANGES: the two per-entry lookups become two set-at-a-time joins. Nothing else in the body moves.
--   1. `seat_customer` picks, ONCE per (seat, coalesce(reference_contact_crm_id, own_contact_crm_id)),
--      the very row the lateral picked — DISTINCT ON over the same four ordering keys, in the same order
--      ((status <> 'dropped') desc, (status = 'active') desc, created_at asc, id asc) — and each entry is
--      hash-joined to it on its contact id.
--   2. `pending_drop_customer` and `pending_drop_contact` are the two arms of the old EXISTS as DISTINCT
--      key sets, left-joined; the CASE reads them in the same order as before.
--
-- WHY THE ROWS ARE IDENTICAL, by construction rather than by sample:
--   * The entry's contact id is never NULL (`a.contact_crm_id <> 100000` already excludes it), and
--     `own_contact_crm_id` is NOT NULL (20261007193000). For a non-null X,
--     `ref = X or (ref is null and own = X)` holds exactly when `coalesce(ref, own) = X`: a row with a
--     reference id matches on it alone, and a row without one matches on its own id. So the lateral's
--     candidate set for an entry IS the `seat_customer` group with that key, and DISTINCT ON keeps the
--     first row of the group under the lateral's own ORDER BY — the row `limit 1` returned. `id` is
--     unique, so the order has no ties to break differently.
--   * DISTINCT ON leaves at most one customer per (seat, key), so the left join can neither drop an entry
--     nor double one — the lateral's one row per entry, or NULLs where it found none.
--   * The EXISTS was true exactly when a pending drop on the seat named the entry's customer
--     (`q.customer_id = customer.id`, never true for a NULL customer) or named no customer and the
--     entry's contact. Each arm is now a DISTINCT set on those same keys and filters, so a match is found
--     exactly when the EXISTS found one, and never more than once.
--   * The columns, their order and their types are unchanged, and the function stays LANGUAGE sql,
--     STABLE, SECURITY DEFINER, `search_path` 'public', service_role only.
--
-- VERIFY BEFORE APPLYING ON PRODUCTION (it was written without database access): inside a transaction
-- that rolls back, create this body under a scratch name and compare it with the live function for the
-- whole company, both directions, `except all` on every column — e.g.
--   select * from public.phoenix_crm_seat_reference(<every REP seat>, false)
--   except all select * from <scratch>(<the same seats>, false)
-- and the reverse, each returning 0 rows (and the same with p_is_test true); then EXPLAIN (ANALYZE,
-- BUFFERS) both for one seat and for all seats.
--
-- ROLLBACK: re-apply the definition in 20261012200000_phoenix_crm_a_doctor_is_on_a_seat_once.sql.

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
    on customer.seat_id = ch.seat_id
   and customer.contact_crm_id = a.contact_crm_id
  left join pending_drop_customer drop_by_customer
    on drop_by_customer.seat_id = ch.seat_id
   and drop_by_customer.customer_id = customer.id
  left join pending_drop_contact drop_by_contact
    on drop_by_contact.seat_id = ch.seat_id
   and drop_by_contact.reference_contact_crm_id = a.contact_crm_id;
$$;

-- Replaced with `create or replace`, which keeps the live ACL (service_role only) and the function's
-- comment (20261002150353's, unchanged and deliberately not restated). The ACL is restated so this file
-- is true on its own and `check:migrations` sees the revoke.
revoke execute on function public.phoenix_crm_seat_reference(text[], boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_seat_reference(text[], boolean) to service_role;

notify pgrst, 'reload schema';

commit;
