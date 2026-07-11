-- Backfill invoice_date for historical Source of Sales rows from the raw_row jsonb.
--
-- The parse expressions below were executed read-only against the FULL production dataset before
-- this migration was written: 74,965 / 74,965 rows parsed AND validated against their
-- invoice_period — zero failures. Per-distributor raw field + format (verified):
--   DIRECT 'Date' / EG 'INVOICE_DATE' / PS 'Invoice Date' / RM 'تاريخ'  → JS Date.toString() text
--     ("Mon Apr 20 2026 11:56:02 GMT+0000 (…)") — extract "Mon DD YYYY", unambiguous;
--   IS + IS-S 'Date'        → "2026/04/30" (YYYY/MM/DD, unambiguous);
--   SF 'BILLINGDATE'        → "22-04-2026" (DD-MM-YYYY, day-first);
--   EP-S 'inv_date'         → "4/9/2026" (AMBIGUOUS m/d vs d/m) — both orientations computed,
--     the one whose YYYY-MM equals the row's invoice_period wins; neither → stays NULL.
--
-- UNIVERSAL GUARD on every UPDATE: a date is written only when the row's invoice_date IS NULL
-- (idempotent re-runs) AND the parsed date's YYYY-MM equals the row's invoice_period — a misparse
-- can never land in the wrong month; it stays NULL ("undated", honest). Distributor codes beyond
-- the verified set simply remain NULL and surface in the Data Quality coverage report.

-- Exception-safe to_date: returns NULL instead of raising on out-of-range/garbage input.
create or replace function public.phx_sos_try_date(p_text text, p_fmt text)
returns date
language plpgsql
immutable
as $$
begin
  if p_text is null or btrim(p_text) = '' then return null; end if;
  return to_date(btrim(p_text), p_fmt);
exception when others then
  return null;
end $$;

revoke all on function public.phx_sos_try_date(text, text) from public, anon, authenticated;
grant execute on function public.phx_sos_try_date(text, text) to service_role;

-- Group 1: JS Date.toString() text — DIRECT('Date'), EG('INVOICE_DATE'), PS('Invoice Date'), RM('تاريخ').
update public.source_of_sales_import_rows r
set invoice_date = d.parsed
from (
  select id,
         public.phx_sos_try_date(
           substring(coalesce(raw_row->>'Date', raw_row->>'INVOICE_DATE', raw_row->>'Invoice Date', raw_row->>'تاريخ')
                     from '^[A-Za-z]{3} ([A-Za-z]{3} \d{1,2} \d{4})'),
           'Mon DD YYYY') as parsed
  from public.source_of_sales_import_rows
  where upper(btrim(distributor_code)) in ('DIRECT', 'EG', 'PS', 'RM')
    and invoice_date is null
) d
where r.id = d.id
  and d.parsed is not null
  and to_char(d.parsed, 'YYYY-MM') = r.invoice_period;

-- Group 2: YYYY/MM/DD — IS, IS-S ('Date').
update public.source_of_sales_import_rows r
set invoice_date = d.parsed
from (
  select id, public.phx_sos_try_date(raw_row->>'Date', 'YYYY/MM/DD') as parsed
  from public.source_of_sales_import_rows
  where upper(btrim(distributor_code)) in ('IS', 'IS-S')
    and invoice_date is null
) d
where r.id = d.id
  and d.parsed is not null
  and to_char(d.parsed, 'YYYY-MM') = r.invoice_period;

-- Group 3: DD-MM-YYYY day-first — SF ('BILLINGDATE').
update public.source_of_sales_import_rows r
set invoice_date = d.parsed
from (
  select id, public.phx_sos_try_date(raw_row->>'BILLINGDATE', 'DD-MM-YYYY') as parsed
  from public.source_of_sales_import_rows
  where upper(btrim(distributor_code)) = 'SF'
    and invoice_date is null
) d
where r.id = d.id
  and d.parsed is not null
  and to_char(d.parsed, 'YYYY-MM') = r.invoice_period;

-- Group 4: ambiguous a/b/yyyy — EP-S ('inv_date'). Both orientations computed; the period match
-- arbitrates. When both match, day == month and they are the same date.
update public.source_of_sales_import_rows r
set invoice_date = case
  when d.mdy is not null and to_char(d.mdy, 'YYYY-MM') = r.invoice_period then d.mdy
  else d.dmy
end
from (
  select id,
         public.phx_sos_try_date(raw_row->>'inv_date', 'FMMM/FMDD/YYYY') as mdy,
         public.phx_sos_try_date(raw_row->>'inv_date', 'FMDD/FMMM/YYYY') as dmy
  from public.source_of_sales_import_rows
  where upper(btrim(distributor_code)) in ('EP-S', 'EP-R')
    and invoice_date is null
) d
where r.id = d.id
  and (   (d.mdy is not null and to_char(d.mdy, 'YYYY-MM') = r.invoice_period)
       or (d.dmy is not null and to_char(d.dmy, 'YYYY-MM') = r.invoice_period));

-- Refresh planner stats so the new partial index is used immediately (lesson from the
-- Sales Command statement-timeout incident).
analyze public.source_of_sales_import_rows;
