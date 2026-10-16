-- The List's doctor-pharmacy cards read only the visits that can change them, not a territory's whole history.
--
-- WHY (2026-10-16 Phoenix CRM performance audit). `loadCustomerPharmacies` (src/lib/phoenix-crm/server/list.ts)
-- read EVERY visit of the seat that ever named a pharmacy — its whole history, a page of 1,000 at a time —
-- on every open of the List, to show each doctor's pharmacies: the newest spelling, the newest Has/Doesn't-have
-- answer per product, the last feedback date and a visit count. A territory's history only grows, so the
-- List got slower every week, and almost every row it carried changed nothing on the screen: once a
-- pharmacy has been named fifty times, only its first and newest mentions, and the first and newest answer
-- per product, decide what the card says. Bounding the read by date is NOT an option: a pharmacy last named
-- seven months ago still shows, with its true count.
--
-- WHAT IT ADDS: one read function, phoenix_crm_customer_pharmacy_feedback(seat, is_test, product_max). It
-- reads the same visits (`seat_id`, `is_test`, `pharmacy_name is not null`) and returns, ordered by id —
-- the order the old keyset read delivered them in — only the rows that can change the grouping:
--   (a) per (customer, pharmacy_name as stored): every row in that name's EARLIEST and LATEST second;
--   (b) per (customer, pharmacy_name, product key whose value is "has" or "missing"), over the rows with at
--       most `product_max` keys: every row in that answer's earliest and latest second;
--   (c) every row with more than `product_max` keys (the parser keeps only the first `product_max` answers
--       of such a row, so which of its keys count is decided in TypeScript, as before);
-- and on exactly one row per (customer, pharmacy_name) — its newest — `visits` carries that name's whole
-- count, 0 on the others. The TypeScript grouping adds `visits` where it used to add 1.
--
-- WHY THE CARDS ARE IDENTICAL. The grouping (groupCustomerPharmacies) sorts by the captured_at STRING with
-- localeCompare, stable, so ties keep id order; two instants in DIFFERENT seconds always compare as time
-- does, while two inside one second may not ('.' sorts before '+'). Hence whole seconds, never single rows:
--   * a card's name and last feedback come from the group's last row in that order, which lies in its
--     latest second — kept by (a) (a TypeScript group is a union of stored spellings, each kept whole);
--   * a product's answer comes from the last row naming it, which lies in the latest second of its
--     (spelling, key) among rows the parser reads in full — kept by (b) — or is an over-cap row, kept by (c);
--   * the card order breaks ties on lastFeedbackAt by each pharmacy's FIRST appearance, and products tie
--     the same way: both first rows lie in an earliest second, kept by (a) and (b);
--   * the kept rows are a subsequence of the full list in the same order, so every "last" and "first"
--     above is the same row it was; and the count is the sum of the weights.
-- tests/phoenix-crm-doctor-pharmacies.test.ts replays this rule against the full grouping on generated
-- histories.
--
-- Read-only; SECURITY DEFINER with search_path 'public', executable by the service role only. Until it is
-- applied the List falls back to the old read (PGRST202), so the order of deploy and apply does not matter.
--
-- ROLLBACK: drop function if exists public.phoenix_crm_customer_pharmacy_feedback(text, boolean, integer);

begin;

set local lock_timeout = '5s';

create or replace function public.phoenix_crm_customer_pharmacy_feedback(
  p_seat_id text,
  p_is_test boolean,
  p_product_max integer
)
returns table (
  id uuid,
  customer_id uuid,
  pharmacy_name text,
  product_availability jsonb,
  captured_at timestamptz,
  visits integer
)
language sql
stable
security definer
set search_path to 'public'
as $$
  with feedback as (
    select
      v.id,
      v.customer_id,
      v.pharmacy_name,
      v.product_availability,
      v.captured_at,
      date_trunc('second', v.captured_at) as at_second,
      -- The parser reads a non-object as no answers at all, so it has no keys here either.
      case
        when jsonb_typeof(v.product_availability) = 'object'
          then (select count(*) from jsonb_object_keys(v.product_availability))
        else 0
      end as key_count
    from public.phoenix_crm_visits v
    where v.seat_id = p_seat_id
      and v.is_test = p_is_test
      and v.pharmacy_name is not null
  ),
  names as (
    select
      f.customer_id,
      f.pharmacy_name,
      min(f.at_second) as first_second,
      max(f.at_second) as last_second,
      count(*)::integer as visits
    from feedback f
    group by f.customer_id, f.pharmacy_name
  ),
  answers as (
    select f.id, f.customer_id, f.pharmacy_name, e.key, f.at_second
    from feedback f
    cross join lateral jsonb_each(
      case when jsonb_typeof(f.product_availability) = 'object' then f.product_availability else '{}'::jsonb end
    ) as e (key, value)
    where f.key_count <= p_product_max
      and e.value in ('"has"'::jsonb, '"missing"'::jsonb)
  ),
  answer_bounds as (
    select a.customer_id, a.pharmacy_name, a.key, min(a.at_second) as first_second, max(a.at_second) as last_second
    from answers a
    group by a.customer_id, a.pharmacy_name, a.key
  ),
  kept as (
    select f.id
    from feedback f
    join names n on n.customer_id = f.customer_id and n.pharmacy_name = f.pharmacy_name
    where f.at_second = n.first_second or f.at_second = n.last_second
    union
    select a.id
    from answers a
    join answer_bounds b on b.customer_id = a.customer_id and b.pharmacy_name = a.pharmacy_name and b.key = a.key
    where a.at_second = b.first_second or a.at_second = b.last_second
    union
    select f.id
    from feedback f
    where f.key_count > p_product_max
  ),
  -- The whole count rides on the newest row of each stored spelling, which (a) always keeps.
  counted as (
    select distinct on (f.customer_id, f.pharmacy_name) f.id, n.visits
    from feedback f
    join names n on n.customer_id = f.customer_id and n.pharmacy_name = f.pharmacy_name
    order by f.customer_id, f.pharmacy_name, f.captured_at desc, f.id desc
  )
  select f.id, f.customer_id, f.pharmacy_name, f.product_availability, f.captured_at, coalesce(c.visits, 0)
  from feedback f
  join kept k on k.id = f.id
  left join counted c on c.id = f.id
  order by f.id;
$$;

comment on function public.phoenix_crm_customer_pharmacy_feedback(text, boolean, integer) is
  'The visits of a seat that can change its doctors'' pharmacy cards: per stored pharmacy name and per '
  'answered product, the rows of the earliest and latest second, plus every row over the answer cap; '
  '`visits` carries each name''s whole count on its newest row. Read by loadCustomerPharmacies. See '
  'supabase/migrations/20261016180201_phoenix_crm_customer_pharmacy_feedback.sql.';

revoke execute on function public.phoenix_crm_customer_pharmacy_feedback(text, boolean, integer) from public, anon, authenticated;
grant execute on function public.phoenix_crm_customer_pharmacy_feedback(text, boolean, integer) to service_role;

notify pgrst, 'reload schema';

commit;
