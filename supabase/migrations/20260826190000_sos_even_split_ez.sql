-- ─────────────────────────────────────────────────────────────────────────────
-- Even-split customer attribution — the EZ rule (owner, 2026-08-26)
--
--   "The EZ is CNS line only. It will be distributed on all medical reps in Giza
--    and Cairo in CNS only, and its sales will be distributed evenly."
--
--   "Once a month is uploaded, it's not changed. For example in July there would
--    be six reps, so the EZ would be distributed on the six reps. In September, if
--    one of these reps resigned, then August sales will be as it is — what will
--    change is the distribution of EZ in September."
--
-- EZ (client 1011654, «مخزن شركه اى زد») is a warehouse in the Katameya–Sokhna
-- industrial zone that buys through a distributor. It is the largest CNS customer
-- in the country and it sits in ONE place, so ordinary geography credits all of it
-- to a single area. The owner's rule is about REP CREDIT, not about where the goods
-- physically went: the credit spreads evenly across the CNS reps active in Cairo and
-- Giza that month.
--
-- ── WHY THE ROSTER IS FROZEN, NOT COMPUTED ───────────────────────────────────
-- The divisor belongs to the MONTH, not to today's roster. Deriving it live from
-- hire/resignation dates happens to be point-in-time stable — until somebody edits a
-- historical date or an employee row is deleted, at which point every past month
-- silently re-splits and published closings move underneath the business. So the
-- resolved roster is written ONCE per period into `sos_even_split_roster` and read
-- back forever after. `phx_freeze_even_split_roster` never overwrites an existing
-- period; re-running it is a no-op. That is what makes "once uploaded, it's not
-- changed" an enforced property rather than a convention.
--
-- ── WHY THE RAW IMPORT IS LEFT ALONE ─────────────────────────────────────────
-- `source_of_sales_import_rows` stays a true record of what the distributor actually
-- invoiced. The split is applied on READ by `phx_sos_rows_attributed(period)`, which
-- both consumers below now go through. That means the rule survives a rollup rebuild
-- (the previous approach — writing the split straight into `source_of_sales_fact_rollup`
-- — was silently erased by `phx_refresh_sos_fact_rollup`, which deletes and re-inserts
-- from the import rows) and it applies to future months automatically.
--
-- ── WHY EACH AREA GETS ITS OWN LANDING BRICK ─────────────────────────────────
-- The rows and the rollup key on brick_id, so each area's slice has to land on a
-- brick. It must be a brick belonging to THAT area and it must not be shared: in the
-- locked Office golden rule (`src/lib/sales/office-allocation.ts`), `brickUnits` is
-- keyed on brick_id alone and keeps the FIRST area it sees, so one brick appearing in
-- several areas collapses into a single entry carrying every area's units — which can
-- push a within-area brick share above 1.0 and distort the AREA totals the rule exists
-- to produce. Each roster row therefore carries its own `landing_brick_id`, frozen
-- alongside the rep. This mirrors what the Office allocation already does for the same
-- reason: its rule stops at the area, and the brick step exists only because the
-- storage keys on it.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. The rule config ───────────────────────────────────────────────────────
-- Declarative on purpose. A client code buried in a WHERE clause inside a function is
-- unfindable a year from now; a row in a named table is not.
create table if not exists public.sos_even_split_customers (
  client_code    text        not null,
  official_line  text        not null,
  area_prefixes  text[]      not null,
  label          text        not null,
  active         boolean     not null default true,
  notes          text,
  created_at     timestamptz not null default now(),
  constraint sos_even_split_customers_pkey primary key (client_code, official_line)
);

comment on table public.sos_even_split_customers is
  'Customers whose sales are credited evenly across the reps active that month, instead of to the area they physically sit in. Owner rule, 2026-08-26.';
comment on column public.sos_even_split_customers.area_prefixes is
  'Area-code prefixes the split covers, e.g. {CA,GZ} for Cairo + Giza. Reps are the ones seated in areas matching these prefixes on that line.';

insert into public.sos_even_split_customers
  (client_code, official_line, area_prefixes, label, notes)
values
  ('1011654', 'CNS', array['CA','GZ'],
   'EZ warehouse — مخزن شركه اى زد',
   'Owner ruling 2026-08-26: CNS only, spread evenly across the CNS reps active in Cairo and Giza in that month. Backfilled Feb–Jul 2026.')
on conflict (client_code, official_line) do nothing;

-- ── 2. The frozen roster ─────────────────────────────────────────────────────
create table if not exists public.sos_even_split_roster (
  period            text        not null,
  client_code       text        not null,
  official_line     text        not null,
  area_code         text        not null,
  region_code       text        not null,
  rep_hr_id         text,
  rep_name          text,
  landing_brick_id  text        not null,
  frozen_at         timestamptz not null default now(),
  frozen_by         text        not null default 'system',
  constraint sos_even_split_roster_pkey
    primary key (period, client_code, official_line, area_code)
);

comment on table public.sos_even_split_roster is
  'FROZEN per-period roster for even-split customers. Written once when a period is first frozen and never recomputed — this is what makes a published month immutable when a rep later resigns.';

create index if not exists sos_even_split_roster_period_idx
  on public.sos_even_split_roster (period, client_code, official_line);

alter table public.sos_even_split_customers enable row level security;
alter table public.sos_even_split_roster    enable row level security;
revoke all on public.sos_even_split_customers from anon, authenticated;
revoke all on public.sos_even_split_roster    from anon, authenticated;

-- ── 3. Freeze a period ───────────────────────────────────────────────────────
-- Idempotent by design: if the period already has rows for that customer+line it
-- returns 0 and changes nothing. Never call this expecting a recompute.
create or replace function public.phx_freeze_even_split_roster(
  p_period text,
  p_actor  text default 'system'
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_start   date := to_date(p_period || '-01', 'YYYY-MM-DD');
  v_end     date := (date_trunc('month', to_date(p_period || '-01','YYYY-MM-DD')) + interval '1 month - 1 day')::date;
  v_written integer := 0;
  c         record;
begin
  for c in select * from public.sos_even_split_customers where active loop
    -- Already frozen → leave it exactly as it is.
    if exists (
      select 1 from public.sos_even_split_roster r
      where r.period = p_period
        and r.client_code = c.client_code
        and r.official_line = c.official_line
    ) then
      continue;
    end if;

    insert into public.sos_even_split_roster
      (period, client_code, official_line, area_code, region_code,
       rep_hr_id, rep_name, landing_brick_id, frozen_by)
    select
      p_period, c.client_code, c.official_line,
      a.code, coalesce(lb.region_code, left(a.code, 2)),
      e.hr_id, e.full_name, lb.brick_id, p_actor
    from public.employees e
    join public.areas a on a.id = e.area_id
    join public.lines l on l.id = e.line_id
    -- the area's own busiest brick on this line, across all validated history:
    -- stable month to month, and computable before the period's sales are loaded.
    left join lateral (
      select x.brick_id, x.region_code
      from (
        select r.brick_id, r.region_code, sum(r.qty) as units
        from public.source_of_sales_import_rows r
        join public.source_of_sales_import_batches b
          on b.id = r.batch_id and b.status = 'validated'
        where upper(btrim(coalesce(r.official_line,''))) = upper(c.official_line)
          and r.distributor_code <> 'Office'
          and coalesce(r.is_direct, false) = false
          and coalesce(btrim(r.brick_id), '') <> ''
          and r.area_code = a.code
        group by r.brick_id, r.region_code
      ) x
      order by x.units desc, x.brick_id
      limit 1
    ) lb on true
    where upper(btrim(l.name)) = upper(c.official_line)
      and e.job_title ilike '%rep%'
      and a.code like any (select p || '%' from unnest(c.area_prefixes) p)
      and e.hire_date is not null
      and e.hire_date <= v_end
      and (e.resignation_date is null or e.resignation_date >= v_start)
      and lb.brick_id is not null;

    get diagnostics v_written = row_count;
  end loop;

  return v_written;
end;
$function$;

comment on function public.phx_freeze_even_split_roster(text, text) is
  'Resolve and FREEZE the even-split roster for one period. No-op if already frozen — a settled month never re-splits.';

-- ── 4. Import rows with the split applied ────────────────────────────────────
-- The single place the rule is implemented. Both the Office weight base and the fact
-- rollup read through this, so they can never disagree about where EZ landed.
--
-- A configured customer whose period has NOT been frozen passes through UNCHANGED.
-- That is deliberate: an unfrozen month must look exactly like it does today rather
-- than silently lose its rows.
create or replace function public.phx_sos_rows_attributed(p_period text)
returns table (
  batch_id         uuid,
  invoice_period   text,
  distributor_code text,
  official_line    text,
  region_code      text,
  area_code        text,
  brick_id         text,
  client_code      text,
  product_code     text,
  product_name     text,
  is_direct        boolean,
  qty              numeric,
  discount         numeric,
  bonus_qty        numeric,
  value            numeric,
  validation_state text,
  split_applied    boolean
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with base as (
    select r.*
    from public.source_of_sales_import_rows r
    join public.source_of_sales_import_batches b
      on b.id = r.batch_id and b.status = 'validated' and r.invoice_period = b.period
    where r.invoice_period = p_period
  ),
  roster as (
    select
      ro.client_code, ro.official_line, ro.area_code, ro.region_code, ro.landing_brick_id,
      count(*)     over (partition by ro.client_code, ro.official_line) as n,
      row_number() over (partition by ro.client_code, ro.official_line order by ro.area_code) as rn
    from public.sos_even_split_roster ro
    where ro.period = p_period
  ),
  tagged as (
    select
      base.*,
      (
        select 1 from public.sos_even_split_customers c
        join roster ro
          on ro.client_code = c.client_code and ro.official_line = c.official_line
        where c.active
          and c.client_code = base.client_code
          and upper(c.official_line) = upper(btrim(coalesce(base.official_line, '')))
        limit 1
      ) is not null
      and coalesce(base.is_direct, false) = false   -- direct orders keep their own finance path
      as is_split
    from base
  )
  -- everything that is not split, exactly as imported
  select
    t.batch_id, t.invoice_period, t.distributor_code, t.official_line,
    t.region_code, t.area_code, t.brick_id, t.client_code,
    t.product_code, t.product_name, coalesce(t.is_direct, false),
    t.qty, t.discount, t.bonus_qty, t.value, t.validation_state,
    false
  from tagged t
  where not t.is_split

  union all

  -- split rows, exploded evenly across the frozen roster; the rounding residual is
  -- carried by the first area so Σ slices === the original row to the last unit
  select
    t.batch_id, t.invoice_period, t.distributor_code, t.official_line,
    ro.region_code, ro.area_code, ro.landing_brick_id, t.client_code,
    t.product_code, t.product_name, false,
    round(t.qty / ro.n, 6)
      + case when ro.rn = 1 then t.qty - round(t.qty / ro.n, 6) * ro.n else 0 end,
    t.discount,
    round(coalesce(t.bonus_qty, 0) / ro.n, 6)
      + case when ro.rn = 1 then coalesce(t.bonus_qty, 0) - round(coalesce(t.bonus_qty, 0) / ro.n, 6) * ro.n else 0 end,
    round(coalesce(t.value, 0) / ro.n, 6)
      + case when ro.rn = 1 then coalesce(t.value, 0) - round(coalesce(t.value, 0) / ro.n, 6) * ro.n else 0 end,
    t.validation_state,
    true
  from tagged t
  join public.sos_even_split_customers c
    on c.client_code = t.client_code
   and upper(c.official_line) = upper(btrim(coalesce(t.official_line, '')))
   and c.active
  join roster ro
    on ro.client_code = c.client_code and ro.official_line = c.official_line
  where t.is_split;
$function$;

comment on function public.phx_sos_rows_attributed(text) is
  'Import rows for a period with even-split customer attribution applied on read. The raw import is never mutated.';

-- ── 5. Office weight base now sees the split ─────────────────────────────────
-- Same shape, same filters, same semantics as before — only the source changes from
-- the raw import rows to the attributed ones. This is what makes the Office allocation
-- place units on the post-redistribution geography.
create or replace function public.phx_office_brick_share(p_period text)
returns table (product_code text, brick_id text, area_code text, region_code text, units numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select
    a.product_code,
    a.brick_id,
    a.area_code,
    a.region_code,
    sum(a.qty) as units
  from public.phx_sos_rows_attributed(p_period) a
  where a.distributor_code <> 'Office'
    and coalesce(a.is_direct, false) = false
    and coalesce(btrim(a.brick_id), '') <> ''
  group by a.product_code, a.brick_id, a.area_code, a.region_code;
$function$;

-- ── 6. Fact rollup is rebuilt from the attributed rows ───────────────────────
-- The presence rollup leg deliberately still reads the RAW rows: presence answers
-- "did this customer buy at all", and EZ is one customer in one place. Only the
-- credit spreads, not the customer.
create or replace function public.phx_refresh_sos_fact_rollup(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_period text;
begin
  select b.period into v_period
  from public.source_of_sales_import_batches b
  where b.id = p_batch_id;

  delete from public.source_of_sales_fact_rollup where batch_id = p_batch_id;
  delete from public.source_of_sales_customer_presence_rollup where batch_id = p_batch_id;

  insert into public.source_of_sales_fact_rollup
    (batch_id, period, distributor_code, official_line, region_code, area_code, brick_id,
     client_code, product_code, product_name, is_direct,
     effective_units, total_qty, total_bonus_qty, direct_value, row_count)
  select
    a.batch_id,
    v_period,
    a.distributor_code,
    a.official_line,
    a.region_code,
    a.area_code,
    a.brick_id,
    a.client_code,
    a.product_code,
    max(a.product_name),
    a.is_direct,
    sum(a.qty * (1 - coalesce(a.discount, 0))),
    sum(a.qty),
    sum(coalesce(a.bonus_qty, 0)),
    sum(case when a.is_direct then a.value else 0 end),
    count(*)
  from public.phx_sos_rows_attributed(v_period) a
  where a.batch_id = p_batch_id
    and coalesce(a.validation_state, 'valid') <> 'failed'
  group by
    a.batch_id, a.distributor_code, a.official_line, a.region_code,
    a.area_code, a.brick_id, a.client_code, a.product_code, a.is_direct;

  insert into public.source_of_sales_customer_presence_rollup
    (batch_id, period, client_code, official_line, region_code, present_any, present_nonexcluded)
  select
    r.batch_id,
    b.period,
    r.client_code,
    coalesce(r.official_line, ''),
    coalesce(r.region_code, ''),
    true,
    bool_or(coalesce(upper(btrim(r.product_code)) <> all (array['LA003','LA004','SS001']), false))
  from public.source_of_sales_import_rows r
  join public.source_of_sales_import_batches b
    on b.id = r.batch_id and b.status = 'validated' and r.invoice_period = b.period
  where r.batch_id = p_batch_id
    and r.client_code is not null
    and coalesce(r.validation_state, 'valid') <> 'failed'
  group by
    r.batch_id, b.period, r.client_code, coalesce(r.official_line, ''), coalesce(r.region_code, '');
end;
$function$;

-- ── Function privileges ──────────────────────────────────────────────────────────────────────────
-- These are SECURITY DEFINER, so they run with the owner's rights and bypass RLS. A newly created
-- function gets EXECUTE granted to PUBLIC by default, and anon/authenticated inherit it through
-- PUBLIC membership — revoking only those two roles is a no-op while the PUBLIC grant stands.
-- `phx_sos_rows_attributed` returns whole sales rows (client codes, products, quantities, values),
-- so an anonymous PostgREST RPC call would have read the sales ledger for any period.
-- Revoking PUBLIC on a default ACL also strips service_role, so it is re-granted explicitly.
revoke execute on function public.phx_sos_rows_attributed(text) from public, anon, authenticated;
grant  execute on function public.phx_sos_rows_attributed(text) to service_role;

revoke execute on function public.phx_freeze_even_split_roster(text, text) from public, anon, authenticated;
grant  execute on function public.phx_freeze_even_split_roster(text, text) to service_role;

revoke execute on function public.phx_office_brick_share(text) from public, anon, authenticated;
grant  execute on function public.phx_office_brick_share(text) to service_role;

revoke execute on function public.phx_refresh_sos_fact_rollup(uuid) from public, anon, authenticated;
grant  execute on function public.phx_refresh_sos_fact_rollup(uuid) to service_role;
