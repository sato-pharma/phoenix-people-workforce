-- A VERSION STAMP FOR THE CLOSING STORE-SPLIT CACHE.
--
-- WHY. src/lib/sales/closing-store-split-net.ts caches the whole city split / EPDA-BULK / Office
-- respread computation per (line, period), with a 1h TTL and a tag busted after a validated import
-- and after publish/unpublish. Its own header has named the gap as a still-open defect since the
-- module was written: fifteen modules write source_of_sales_customer_map, and a geography re-stamp
-- is a direct SQL UPDATE on source_of_sales_import_rows, which has no updated_at column and no
-- trigger. Neither path busts the tag, so the Monthly Closing screen and the workbook can serve an
-- hour-old Office spread while every database surface already reads the new one.
--
-- Measured on 2026-10-10: after four re-uploads at 14:30-14:38 Cairo and a reconcile that finished
-- at 14:45:18, the closing engine, au.f_sales_vs_target_range, phx_monthly_achievement and the
-- materialised au.monthly_attribution_rollup all read Sohag 1 CNS September at 173.4%, while the
-- owner's screen still read ~290% -- the TTL from the 14:38 entry had not expired.
--
-- WHAT. A sequence bumped by a STATEMENT-level trigger on every table the split reads for geography,
-- and one reader function the cache keys on. Deliberately a sequence and not a counter row: nextval
-- takes no row lock, so a 43,000-row import pays nothing for it and two parallel writers never wait
-- on each other, and nothing accumulates to clean up. The value only has to CHANGE, never to be
-- exact, so the sequence cache is irrelevant -- but it is set to 1 anyway, because a per-session
-- cache would let a backend hand out a value it had already reserved before another backend's bump,
-- and a version that can go BACKWARDS would resurrect a stale entry.
--
-- The header of closing-store-split-net.ts says not to "fix" this by adding invalidate calls to
-- write paths -- the hand-maintained list is what let this class of bug through twice. This is the
-- trigger-stamped version row that header asks for instead.

create sequence if not exists public.sos_geography_version_seq cache 1;

-- Bumps the stamp. Returns null because a statement-level AFTER trigger's return value is ignored.
create or replace function public.sos_bump_geography_version()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  perform nextval('public.sos_geography_version_seq');
  return null;
end;
$$;

-- The tables the split's geography comes from. source_of_sales_import_rows carries the rows and the
-- brick/area/region a reconcile re-stamps on them; the customer map decides where a customer sits;
-- bricks, areas and regions carry the brick -> area -> region tree and the city an area belongs to;
-- the batch table decides which files count as validated at all.
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'source_of_sales_import_rows',
    'source_of_sales_import_batches',
    'source_of_sales_customer_map',
    'source_of_sales_bricks',
    'source_of_sales_areas',
    'source_of_sales_regions'
  ]
  loop
    execute format('drop trigger if exists trg_%s_geography_version on public.%I', v_table, v_table);
    execute format(
      'create trigger trg_%s_geography_version'
      || ' after insert or update or delete on public.%I'
      || ' for each statement execute function public.sos_bump_geography_version()',
      v_table, v_table);
    -- TRUNCATE needs its own trigger: a statement trigger declared for insert/update/delete does
    -- not fire on it, and a truncate is exactly the shape that would leave a stale split cached.
    execute format('drop trigger if exists trg_%s_geography_version_trunc on public.%I', v_table, v_table);
    execute format(
      'create trigger trg_%s_geography_version_trunc'
      || ' after truncate on public.%I'
      || ' for each statement execute function public.sos_bump_geography_version()',
      v_table, v_table);
  end loop;
end;
$$;

-- The reader. SECURITY DEFINER because pg_sequences hides last_value from a role with no privilege
-- on the sequence, and the app calls as service_role. Null until the first bump, hence the coalesce:
-- a fresh database must answer 0, not null, or the cache key would read "undefined" for every call
-- until the first write of the month.
create or replace function public.phx_sos_geography_version()
returns bigint
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(
    (select last_value from pg_sequences
      where schemaname = 'public' and sequencename = 'sos_geography_version_seq'),
    0)::bigint;
$$;

-- Both halves of the grant, every time: revoking only anon and authenticated is a no-op because they
-- inherit through PUBLIC, and revoking PUBLIC alone would strip service_role -- the only role the app
-- ever calls as.
revoke execute on function public.phx_sos_geography_version() from public, anon, authenticated;
revoke execute on function public.sos_bump_geography_version() from public, anon, authenticated;
grant execute on function public.phx_sos_geography_version() to service_role;
grant usage, select on sequence public.sos_geography_version_seq to service_role;

comment on function public.phx_sos_geography_version() is
  'Monotonic stamp bumped by a statement-level trigger on every table the closing store-split reads for geography. src/lib/sales/closing-store-split-net.ts keys its cache on it, so a direct SQL geography re-stamp can no longer leave the Monthly Closing screen serving an hour-old Office spread.';
