-- Add employees.region_code — the au operational region id (e.g. 'CA', 'D1') — and backfill it from
-- the au sales-geography crosswalk. An employee's region is fully determined by their (line, area):
-- au_v_line_area_map maps (line_code, area_code) -> operational_region_code. The SAME area can map to
-- DIFFERENT regions across lines by design (e.g. the Anti Infective line splits Upper Egypt into
-- "Upper Egypt 1/2" DM territories while other lines keep it unified), which is exactly why this
-- keys on BOTH line and area.
--
-- Additive + idempotent: adds a nullable column and backfills only rows that resolve to a sales seat
-- (Head Office / non-sales rows stay NULL). region_name (the free-text display label) is intentionally
-- left untouched here; deriving region_name from the au region is handled in the application layer.

alter table public.employees
  add column if not exists region_code text;

comment on column public.employees.region_code is
  'au operational region code (e.g. CA, D1), derived from (line, area) via au_v_line_area_map. Authoritative sales-region id; region_name is the display label. NULL for non-sales (Head Office) rows.';

update public.employees e
set region_code = m.operational_region_code
from public.areas a, public.lines l, public.au_v_line_area_map m
where e.area_id = a.id
  and e.line_id = l.id
  and m.area_code = a.code
  and m.line_code = l.code
  and m.effective_to is null
  and e.region_code is null;
