-- The last two public functions with a role-mutable search_path get it pinned.
--
-- WHAT THIS CHANGES: re-creates two functions with `set search_path to 'public'` added and NOTHING
-- else changed — bodies verbatim from the live definitions read on production (ozucdzovmcqvepbozvqf)
-- on 2026-10-13, which are byte-identical in logic to the files that last defined them:
--   public.sos_unmapped_customers()            — 20261010040000_sos_unmapped_customers_list.sql
--   public.phoenix_crm_customers_no_double_add() — 20261012200000_phoenix_crm_a_doctor_is_on_a_seat_once.sql
-- `sos_unmapped_customers` keeps its `set statement_timeout to '60s'`. Neither is SECURITY DEFINER,
-- and neither changes behaviour: no row is read differently, no row is written at all.
--
-- WHY: production's own linter reported `function_search_path_mutable` at 2 against a floor of 0,
-- and these were the two. A function with no pinned search_path resolves its unqualified names
-- through whatever the CALLER's search_path happens to be, so the same function can read a
-- different table depending on who calls it. Both bodies schema-qualify every table they touch,
-- which is why nothing is broken today — the pin is what keeps that true after any future edit.
--
-- The trigger function is the more interesting of the two: its own file pins search_path on BOTH of
-- its siblings (`phoenix_crm_seat_reference` and `phoenix_crm_ensure_reference_customers`, both
-- SECURITY DEFINER) and simply missed the third, which is a trigger function and SECURITY INVOKER.
-- `scripts/check-migrations.mjs` rule 4b, added with this migration, is what makes that miss
-- impossible to repeat — and it is per-FUNCTION rather than per-file precisely because this file
-- would have passed a per-file check.
--
-- ROLLBACK (the setting only; both bodies stay as they are):
--   alter function public.sos_unmapped_customers() reset search_path;
--   alter function public.phoenix_crm_customers_no_double_add() reset search_path;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. Nothing
-- here writes a row, drops anything or changes a result. Idempotent.

begin;

-- 1. The SoS Magic "Unmapped customers" list. Counts only, no money — no Head Office figure can be
--    quoted from it, and that is unchanged here.
create or replace function public.sos_unmapped_customers()
returns table (
  distributor_code text,
  customer_code text,
  customer_name text,
  address text,
  why text,
  last_brick_id text,
  last_area_code text,
  last_source text,
  switched_off_at timestamptz,
  sales_rows bigint,
  first_period text,
  last_period text,
  lines text
)
language sql
stable
set search_path to 'public'
set statement_timeout to '60s'
as $$
  with sales as (
    select r.distributor_code, r.client_code as customer_code, count(*) as sales_rows,
           min(r.invoice_period) as first_period, max(r.invoice_period) as last_period,
           string_agg(distinct r.official_line, ', ' order by r.official_line) as lines,
           (array_agg(r.client_name order by r.id desc))[1] as client_name,
           (array_agg(r.client_address order by r.id desc))[1] as client_address
      from public.source_of_sales_import_rows r
     where r.client_code is not null and btrim(r.client_code) <> ''
     group by r.distributor_code, r.client_code
  ), off_rows as (
    select distinct on (m.distributor_code, m.customer_code)
           m.distributor_code, m.customer_code, m.customer_name, m.address, m.brick_id, m.area_code, m.source, m.updated_at
      from public.source_of_sales_customer_map m
     where not m.active
     order by m.distributor_code, m.customer_code, m.updated_at desc
  )
  select coalesce(o.distributor_code, s.distributor_code),
         coalesce(o.customer_code, s.customer_code),
         coalesce(nullif(o.customer_name, ''), s.client_name),
         coalesce(nullif(o.address, ''), s.client_address),
         case when o.customer_code is not null then 'switched off' else 'never mapped' end,
         o.brick_id, o.area_code, o.source, o.updated_at,
         coalesce(s.sales_rows, 0), s.first_period, s.last_period, s.lines
    from sales s
    full join off_rows o on o.distributor_code = s.distributor_code and o.customer_code = s.customer_code
   where not exists (
     select 1 from public.source_of_sales_customer_map a
      where a.active
        and a.distributor_code = coalesce(o.distributor_code, s.distributor_code)
        and a.customer_code = coalesce(o.customer_code, s.customer_code)
   )
   order by 1, 2
$$;

-- 2. The backstop that refuses a doctor the rep already has on his list (owner, 2026-10-12).
create or replace function public.phoenix_crm_customers_no_double_add()
returns trigger
language plpgsql
set search_path to 'public'
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

-- The trigger already points at this function by name and is NOT recreated — `create or replace`
-- keeps the existing trigger wired to the new body, and re-creating it would drop and re-add a
-- BEFORE INSERT trigger on a live table for no reason.

-- Both are replaced with `create or replace`, which keeps the live ACL (service_role only).
-- Restated so this file is true on its own.
revoke execute on function public.sos_unmapped_customers() from public, anon, authenticated;
grant execute on function public.sos_unmapped_customers() to service_role;

commit;
