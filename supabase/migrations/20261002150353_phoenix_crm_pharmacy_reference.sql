-- Phoenix CRM — each rep's iReports360 PHARMACIES arrive as his pharmacies.
--
-- Owner, 2026-10-02: *"bring each rep's iReports360 pharmacies into Phoenix"*, and later the same
-- day *"He can add any pharmacy, any time … He don't plan it. We don't want extra."* A pharmacy is a
-- THIRD list beside AM and PM — never planned, never approved, and in no KPI
-- (`src/lib/phoenix-crm/pharmacy-call-rules.ts`, `AGENTS.md` §4).
--
-- ── WHY THIS FILE IS ONE PREDICATE ──────────────────────────────────────────────────────────────
-- The import already exists. `phoenix_crm_seat_reference` reads a seat's live iReports360
-- assignments and `phoenix_crm_ensure_reference_customers` mints a PENDING `phoenix_crm_customers`
-- row for every one it has not minted yet — carrying `list_type` straight through, with no list of
-- its own to widen. So the whole import is the reference function's own
-- `a.list_type in ('AM', 'PM')` becoming `('AM', 'PM', 'Pharmacy')`, and the pharmacies arrive the
-- way the doctors did: pending, validated at the door, each on the rep's own seat.
--
-- Measured on production before writing this (2026-10-02):
--   · 1,992 live Pharmacy assignments, 1,930 distinct pharmacies, across 47 of the 75 agents.
--   · `Pharmacy` is the vendor's own spelling (`LIST_TYPES` in src/lib/crm/contacts-web-client.ts).
--   · The contact 100000 catch-all is already excluded by the predicate this file widens.
--
-- ── THE ONE CLAUSE DELIBERATELY NOT WIDENED ─────────────────────────────────────────────────────
-- `with_list` carries a SECOND copy of the same predicate, and it is doing a different job: it
-- decides WHICH occupant of a seat owns the list, by asking which of them has one at all, and
-- `chosen` then takes one per seat. Widening that one lets a FORMER occupant who happens to hold
-- only pharmacy assignments win `distinct on` over the person actually sitting there — the list
-- would silently become somebody else's.
--
-- What it costs to leave it: measured on production, exactly ONE agent holds pharmacy assignments
-- and no AM/PM list at all. He has no doctor list either, so he has no Phoenix list today, and his
-- pharmacies arrive the moment he is given a single AM or PM contact. One seat, against every seat's
-- list being attributable to the wrong rep. It is a decision, not an oversight — do not "finish the
-- job" by widening it without re-measuring that number.
--
-- ── WHAT THIS FILE DOES NOT DO ──────────────────────────────────────────────────────────────────
-- It does not block a wholesaler. A makhzan is never shown as a candidate nor validated as a venue
-- (`AGENTS.md` §4.1, owner 2026-09-22, "never never never"), but that test lives in TypeScript —
-- `src/lib/venues/wholesaler-venue-guard.ts`, which reuses the monthly closing's own name
-- primitives so the two can never disagree. Re-implementing those rules in SQL would be a second
-- answer that drifts, so the guard runs where the list is READ (`loadReference`) and nothing here
-- tries to repeat it. Measured on the same 1,930: **0 are hard-blocked** and 6 carry the ambiguous
-- فارما word, all six of them plainly distributor branches (موزع = distributor) which the guard
-- FLAGS for a human rather than refusing — the owner's standing rule that a false positive must
-- never silently refuse a real shop.
--
-- ROLLBACK
--   Re-run the body below with `a.list_type in ('AM', 'PM')` in the final join. Pharmacy customers
--   already minted stay; they simply stop being offered as reference rows.
--   To remove them as well (ONLY if none has been validated or visited):
--     -- SAFE: pending pharmacy rows this file's widening minted, none of them validated
--     -- delete from public.phoenix_crm_customers
--     --  where list_type = 'Pharmacy' and origin = 'reference' and status = 'pending';

-- One transaction, a 5s lock ceiling, and PostgREST told to re-read the schema (the module contract).
begin;
set local lock_timeout = '5s';

create or replace function public.phoenix_crm_seat_reference(p_seat_ids text[], p_is_test boolean default false)
returns table(
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
  left join public.crm_contacts contact on contact.contact_crm_id = a.contact_crm_id
  left join public.phoenix_crm_customers customer
    on customer.seat_id = ch.seat_id
   and customer.reference_contact_crm_id = a.contact_crm_id
   and customer.is_test = p_is_test;
$$;

comment on function public.phoenix_crm_seat_reference(text[], boolean) is
  'A seat''s live iReports360 list — AM, PM and (since 2026-10-02) Pharmacy. The pharmacies are a '
  'reference the rep calls on, never planned and in no KPI; a wholesaler is filtered in TypeScript '
  'by wholesaler-venue-guard, which this function deliberately does not try to repeat.';

revoke execute on function public.phoenix_crm_seat_reference(text[], boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_seat_reference(text[], boolean) to service_role;

-- Without this PostgREST keeps its old schema cache, and the app reads the new shape as missing.
notify pgrst, 'reload schema';

commit;
