-- Market Awareness geography — the region -> area cascade, with the rep and the district managers.
--
-- WHY A PUBLIC FUNCTION AND NOT `.schema("au")`. PostgREST exposes only `public`, `graphql_public`
-- and `analytics`; `.schema("au").from(...)` answers PGRST106 "Invalid schema: au". Every seat,
-- region and area-state fact this module needs lives in `au`, so it is reached through a public
-- SECURITY DEFINER wrapper — which runs inside Postgres and is not subject to that restriction.
--
-- WHY IT IS KEYED ON ONE LINE. The region map is per line: Anti-Infective spans 9 regions, CNS and
-- Pedia 7 each, over the same 49 areas. So an area sits in a DIFFERENT region depending on the line,
-- and there is no line-agnostic cascade to offer. The activity's primary line is what orders this.
--
-- WHAT `selectable` MEANS. Of 147 area-and-line rows on production: 69 `occupied`, 41
-- `vacant_will_hire`, 26 `other_permanent`, 11 `other_line_specific`. The last two are Office, Main
-- Store and similar buckets rather than places — you cannot hold a round table in Office. The owner
-- chose to SHOW them greyed rather than hide them (answer 30), so they are returned with
-- `selectable = false` and a reason, instead of being filtered out where the screen cannot explain
-- their absence.
--
-- A VACANT AREA IS SELECTABLE. 41 rows have a rep seat with nobody in it, and the owner's answer 31
-- is that they stay pickable and read "Vacant — will hire". An empty rep box would read as a bug.

create or replace function public.phx_market_awareness_areas(p_line_code text)
returns table(
  region_code text,
  region_name text,
  area_code text,
  area_name text,
  area_state text,
  selectable boolean,
  unselectable_reason text,
  rep_seat_id text,
  rep_hr_id text,
  rep_name text,
  dm_seat_id text,
  dm_hr_id text,
  dm_name text
)
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '30s'
as $function$
  with live_map as (
    select m.*
    from au.line_area_map m
    where lower(btrim(m.line_code)) = lower(btrim(p_line_code))
      and m.effective_to is null
  ),
  -- Current occupancy only. A seat's history is a series; the open row is who holds it now.
  current_occupancy as (
    select distinct on (o.seat_id)
      o.seat_id,
      o.occupant_hr_id
    from au.occupancy_history o
    where o.effective_to is null
    order by o.seat_id, o.effective_from desc
  )
  select
    m.operational_region_code as region_code,
    coalesce(r.region_name, m.operational_region_code) as region_name,
    m.area_code,
    coalesce(ca.area_name, m.area_code) as area_name,
    m.area_state,
    (m.area_state in ('occupied', 'vacant_will_hire')) as selectable,
    case
      when m.area_state in ('occupied', 'vacant_will_hire') then null
      else 'Not a territory — this is a reporting bucket, not a place an activity can be held in'
    end as unselectable_reason,
    m.rep_seat_id,
    rep_occ.occupant_hr_id as rep_hr_id,
    rep_emp.full_name as rep_name,
    m.dm_seat_id,
    dm_occ.occupant_hr_id as dm_hr_id,
    dm_emp.full_name as dm_name
  from live_map m
  left join au.regions r
    on lower(btrim(r.region_code)) = lower(btrim(m.operational_region_code))
  left join au.canonical_areas ca
    on lower(btrim(ca.area_code)) = lower(btrim(m.area_code))
  left join current_occupancy rep_occ on rep_occ.seat_id = m.rep_seat_id
  left join current_occupancy dm_occ  on dm_occ.seat_id  = m.dm_seat_id
  -- HR ids are MIXED CASE on this database. A plain equality join silently under-returns — one such
  -- join hid 28% of reps' own orders, and on au.occupancy_history the loss was total (0 of 120), a
  -- row matching nobody reading as a vacant seat rather than as a bug. Both sides are lowered.
  left join public.employees rep_emp
    on lower(btrim(rep_emp.hr_id)) = lower(btrim(rep_occ.occupant_hr_id))
  left join public.employees dm_emp
    on lower(btrim(dm_emp.hr_id)) = lower(btrim(dm_occ.occupant_hr_id))
  order by m.operational_region_code, m.area_code;
$function$;

comment on function public.phx_market_awareness_areas(text) is
  'Region -> area cascade for one line, with the current rep and district manager resolved from '
  'au.occupancy_history. Non-territory areas are returned with selectable = false and a reason '
  'rather than filtered out, because the owner chose to show them greyed (2026-09-06).';

-- ONE statement, naming public FIRST. anon and authenticated inherit EXECUTE through
-- PUBLIC membership, so revoking only those two is a no-op — and revoking PUBLIC on a
-- default ACL also strips service_role, which is why the grant below is not optional.
revoke execute on function public.phx_market_awareness_areas(text) from public, anon, authenticated;
grant execute on function public.phx_market_awareness_areas(text) to service_role;

-- The tracked lines, from au.lines rather than derived from a display name. `is_closing_line` is the
-- database's own answer to "is this a line we track", which is what excludes Head Office — a name
-- match would be a second, drifting definition of the same thing. Ids match public.lines (1 Anti
-- Infective, 2 Pedia, 3 CNS), so the activity's line_id foreign key stays valid either way.
create or replace function public.phx_market_awareness_lines()
returns table(line_id bigint, line_code text, line_name text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select l.line_id::bigint, l.line_code, l.line_name
  from au.lines l
  where l.is_closing_line and l.is_active
  order by l.line_id;
$function$;

-- ONE statement, naming public FIRST. anon and authenticated inherit EXECUTE through
-- PUBLIC membership, so revoking only those two is a no-op — and revoking PUBLIC on a
-- default ACL also strips service_role, which is why the grant below is not optional.
revoke execute on function public.phx_market_awareness_lines() from public, anon, authenticated;
grant execute on function public.phx_market_awareness_lines() to service_role;

-- The products a Market Awareness activity may target, for one line.
--
-- Resolved through `au.sos_official_line_map` for the same reason the tracking function is: the map
-- holds FOUR official_line spellings for three lines, so matching a display name would silently
-- offer a short list. `source_of_sales_products.line` uses the official spelling.
--
-- HEAD OFFICE AND `IGNORE` CAN NEVER APPEAR. Head Office is absent from monthly closing tracking by
-- golden rule, so one of its products could only ever render a permanent zero on the Tracking tab —
-- which reads as a broken report rather than as a rule. Owner answer 29: "donot show head office
-- products in the products droplist". `IGNORE` is a bucket, not a line. Neither is a closing line in
-- `au.lines`, so joining through the map excludes both by construction rather than by a name list
-- that would have to be maintained.
create or replace function public.phx_market_awareness_products(p_line_code text)
returns table(product_code text, product_name text, line_name text, factory_price numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select
    p.product_code,
    p.product_name,
    p.line as line_name,
    p.factory_price
  from public.source_of_sales_products p
  where p.active
    and lower(btrim(p.line)) in (
      select lower(btrim(m.official_line))
      from au.sos_official_line_map m
      join au.lines l on lower(btrim(l.line_code)) = lower(btrim(m.line_code))
      where lower(btrim(m.line_code)) = lower(btrim(p_line_code))
        and l.is_closing_line
        and l.is_active
    )
  order by p.product_name;
$function$;

-- ONE statement, naming public FIRST. anon and authenticated inherit EXECUTE through
-- PUBLIC membership, so revoking only those two is a no-op — and revoking PUBLIC on a
-- default ACL also strips service_role, which is why the grant below is not optional.
revoke execute on function public.phx_market_awareness_products(text) from public, anon, authenticated;
grant execute on function public.phx_market_awareness_products(text) to service_role;

-- Every district manager in one region, for one line. The owner's answer 32: on CEO approval it is
-- every DM in the region who is informed, for the chosen line — not the single DM of the area.
create or replace function public.phx_market_awareness_region_managers(
  p_line_code text,
  p_region_code text
)
returns table(dm_seat_id text, dm_hr_id text, dm_name text, area_count integer)
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '30s'
as $function$
  with current_occupancy as (
    select distinct on (o.seat_id) o.seat_id, o.occupant_hr_id
    from au.occupancy_history o
    where o.effective_to is null
    order by o.seat_id, o.effective_from desc
  )
  select
    m.dm_seat_id,
    occ.occupant_hr_id as dm_hr_id,
    emp.full_name as dm_name,
    count(*)::integer as area_count
  from au.line_area_map m
  left join current_occupancy occ on occ.seat_id = m.dm_seat_id
  left join public.employees emp
    on lower(btrim(emp.hr_id)) = lower(btrim(occ.occupant_hr_id))
  where lower(btrim(m.line_code)) = lower(btrim(p_line_code))
    and lower(btrim(m.operational_region_code)) = lower(btrim(p_region_code))
    and m.effective_to is null
    and m.dm_seat_id is not null
  group by m.dm_seat_id, occ.occupant_hr_id, emp.full_name;
$function$;

comment on function public.phx_market_awareness_region_managers(text, text) is
  'Every district manager seat in one region for one line, with its current occupant. A seat with a '
  'null dm_hr_id is a real vacancy, not a missing join — return it and let the caller say so.';

-- ONE statement, naming public FIRST. anon and authenticated inherit EXECUTE through
-- PUBLIC membership, so revoking only those two is a no-op — and revoking PUBLIC on a
-- default ACL also strips service_role, which is why the grant below is not optional.
revoke execute on function public.phx_market_awareness_region_managers(text, text) from public, anon, authenticated;
grant execute on function public.phx_market_awareness_region_managers(text, text) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Prove it, with a positive control
-- ─────────────────────────────────────────────────────────────────────────────

do $verify$
declare
  probe_line text;
  total integer;
  selectable_count integer;
  with_dm integer;
  with_rep integer;
begin
  select line_code into probe_line
    from au.lines where is_closing_line and is_active order by line_id limit 1;

  if probe_line is null then
    raise notice 'market awareness geography: no closing line in this database — check skipped';
    return;
  end if;

  select count(*),
         count(*) filter (where selectable),
         count(*) filter (where dm_hr_id is not null),
         count(*) filter (where rep_hr_id is not null)
    into total, selectable_count, with_dm, with_rep
    from public.phx_market_awareness_areas(probe_line);

  -- POSITIVE CONTROL. An empty cascade and a broken join look identical, and "this line has no
  -- areas" is never true for a closing line.
  if total = 0 then
    raise exception 'market awareness geography: positive control failed — line % returned no '
      'areas at all, which cannot be right for a closing line', probe_line;
  end if;

  -- The DM join is the one that has failed silently here before, through HR id casing. Every area
  -- on production carries a DM seat, so zero resolved occupants means the join broke, not that the
  -- company has no district managers.
  if with_dm = 0 then
    raise exception 'market awareness geography: positive control failed — % areas on line % and '
      'not one resolved a district manager, which is the shape of a broken HR id join', total, probe_line;
  end if;

  raise notice 'market awareness geography: line % — % areas, % selectable, % with a DM, % with a rep',
    probe_line, total, selectable_count, with_dm, with_rep;
end;
$verify$;
