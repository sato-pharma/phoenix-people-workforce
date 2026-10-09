-- sos_unmapped_customers(): every customer with no ACTIVE mapping, for the SoS Magic "Unmapped customers" tab.
--
-- WHAT THIS CHANGES: adds one read-only SQL function. It lists each (distributor, customer code) that either
-- has a customer-map row switched off with no active twin ("switched off") or appears in imported sales rows
-- with no customer-map row at all ("never mapped"), with the last brick it held, when it was switched off, how
-- many sales rows and months it carries and on which lines. Counts only: no money, so no Head Office figure can
-- be quoted from it.
-- WHY: owner instruction 2026-10-10 ("show every single thing" in SoS Magic). The tab used to list only what an
-- analyzed FILE did not know, so customers switched off in the database never appeared unless a file carrying
-- their codes was open.
-- ROLLBACK: drop function public.sos_unmapped_customers();
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. Nothing here writes a
-- row. Callable by service_role only (the app's server), never by a browser role. Idempotent.

begin;

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

revoke execute on function public.sos_unmapped_customers() from public, anon, authenticated;
grant execute on function public.sos_unmapped_customers() to service_role;

commit;
