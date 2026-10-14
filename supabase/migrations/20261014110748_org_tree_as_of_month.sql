-- org_tree_as_of_month
--
-- WHAT THIS CHANGES: adds ONE read-only function, public.au_f_org_tree_as_of(p_date date). It
-- returns the organogram's seat tree as it stood on a given day, in the same column shape as
-- public.au_v_org_tree. It creates no table, changes no row, and drops nothing.
--
-- WHY: the organogram can only draw today. au_v_org_tree carries who sits in a seat now and has no
-- date, so "who held this area in September" had no answer on the chart even though every seat and
-- every move is already recorded: au.seats dates each seat (effective_from / effective_to) and
-- au.occupancy_history dates each occupant AND stamps, per span, the line, region, area and manager
-- seat the seat answered to at that time. This function reads exactly those two, nothing else.
--
-- HOW IT ANSWERS A DAY (half-open spans [effective_from, effective_to), as everywhere in the seat
-- model — a move closes and reopens on the same day, so exactly one span covers any date):
--   * a seat is on the chart if its own dates cover the day. is_active is NOT consulted: it only
--     says whether the seat is live NOW, and the one retired seat (the old single Upper Egypt
--     district, retired 2026-09-01) must still be drawn for July and August.
--   * its occupant is the span covering the day; a vacant placeholder span, or no span at all,
--     is a vacant seat.
--   * its manager is the SPAN's manager seat, falling back to the seat's own parent when no span
--     covers the day OR when the span's manager seat is not itself on the chart that day (a span
--     left pointing at a seat that has since been retired — staging carries four such spans —
--     would otherwise make its rep vanish rather than hang off the live district).
--     That is what reproduces the Upper Egypt split: in July and August the
--     reps report to the old district seat, from September to the two new ones. Measured on
--     production 2026-10-14: using the span's manager leaves 0 orphan seats at 2026-07-31,
--     2026-08-31 and 2026-09-30, and the manager differs from the seat's parent for 12, 10 and 0
--     seats respectively.
--   * region and area likewise come from the span first (18 spans carry a region different from
--     their seat's today, all of them re-parented seats), line from the span too.
--   * reachability is a recursive walk from the root, as the live tree does, so a seat whose
--     manager chain does not reach the root on that day is not drawn rather than drawn floating.
--
-- 🔴 DO NOT replace the span reads with au.f_seat_occupant_asof. Its first arm credits TODAY's
-- holder with the seat's whole history (an attribution rule for sales, not a record of who sat
-- where), which is the wrong answer for a picture of the org.
--
-- LIMIT, stated plainly: a seat with no span covering the day (vacant before it was ever filled)
-- takes today's parent, region and area. The chart says so; it never invents a person.
--
-- GRANTS MATCH ITS SIBLINGS — service_role only, never anon or authenticated. Seat history names
-- people and the dates they moved. The app reads it server-side with the service-role client.
--
-- ROLLBACK: drop function public.au_f_org_tree_as_of(date);  (nothing else depends on it)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration is additive and read-only, so there is nothing to pre-image.

create or replace function public.au_f_org_tree_as_of(p_date date)
returns table (
  seat_id text,
  parent_seat_id text,
  seat_tier text,
  line_code text,
  region_code text,
  area_code text,
  is_other_pseudo_dm boolean,
  occupant_hr_id text,
  is_vacant boolean,
  area_name text,
  region_name text,
  line_name text,
  line_id bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with recursive alive as (
    select s.*
    from au.seats s
    where s.effective_from <= p_date
      and (s.effective_to is null or s.effective_to > p_date)
  ),
  dated as (
    select
      s.seat_id,
      case
        when o.manager_seat_id is not null
         and exists (select 1 from alive m where m.seat_id = o.manager_seat_id)
        then o.manager_seat_id
        else s.parent_seat_id
      end as eff_parent,
      s.seat_tier,
      coalesce(o.line_code, s.line_code) as line_code,
      coalesce(o.region_code, s.region_code) as region_code,
      coalesce(o.area_code, s.area_code) as area_code,
      s.is_other_pseudo_dm,
      nullif(btrim(o.occupant_hr_id), '') as occupant_hr_id
    from alive s
    left join lateral (
      select oh.occupant_hr_id, oh.manager_seat_id, oh.line_code, oh.region_code, oh.area_code
      from au.occupancy_history oh
      where oh.seat_id = s.seat_id
        and oh.effective_from <= p_date
        and (oh.effective_to is null or oh.effective_to > p_date)
      order by oh.effective_from desc
      limit 1
    ) o on true
  ),
  tree as (
    select d.*, array[d.seat_id] as path
    from dated d
    where d.eff_parent is null
    union all
    select c.*, t.path || c.seat_id
    from dated c
    join tree t on c.eff_parent = t.seat_id
    where not (c.seat_id = any (t.path))
  )
  select
    t.seat_id,
    t.eff_parent as parent_seat_id,
    t.seat_tier,
    t.line_code,
    t.region_code,
    t.area_code,
    t.is_other_pseudo_dm,
    t.occupant_hr_id,
    t.occupant_hr_id is null as is_vacant,
    ca.area_name,
    rg.region_name,
    ln.line_name,
    ln.line_id
  from tree t
  left join au.canonical_areas ca on ca.area_code = t.area_code
  left join au.regions rg on rg.region_code = t.region_code
  left join au.lines ln on ln.line_code = t.line_code;
$$;

comment on function public.au_f_org_tree_as_of(date) is
  'The organogram seat tree as it stood on p_date, same columns as au_v_org_tree. Seats by their own effective dates (is_active ignored so a retired seat still draws for the months it was live); occupant, manager, region, area and line from the au.occupancy_history span covering the day, else the seat itself. Half-open spans [effective_from, effective_to). Read-only; service_role only.';

revoke execute on function public.au_f_org_tree_as_of(date) from public, anon, authenticated;
grant execute on function public.au_f_org_tree_as_of(date) to service_role;

-- Prove it. Asked for TODAY (Cairo's, never the server's UTC date) it must draw the same seats with
-- the same occupants as the live tree. If it does not, the reconstruction rule above is wrong and the
-- migration fails here instead of drawing a plausible-looking wrong past.
--
-- Parent / region / area are compared too but only REPORTED: a clone whose spans were not kept in step
-- with its seats (staging's are not — one rep's open span names a different district than the seat's
-- own parent) differs here through its data, not through this function, and failing the migration on
-- it would only block staging. Production is checked for zero differences by hand after applying.
do $do$
declare
  v_today    date := (now() at time zone 'Africa/Cairo')::date;
  v_live     int;
  v_asof     int;
  v_occupant int;
  v_shape    int;
begin
  select count(*) into v_live from public.au_v_org_tree;
  select count(*) into v_asof from public.au_f_org_tree_as_of(v_today);
  if v_live <> v_asof then
    raise exception 'au_f_org_tree_as_of(today) draws % seats but the live org tree draws %.', v_asof, v_live;
  end if;

  select count(*) into v_occupant
  from public.au_v_org_tree l
  join public.au_f_org_tree_as_of(v_today) a on a.seat_id = l.seat_id
  where a.occupant_hr_id is distinct from l.occupant_hr_id;
  if v_occupant <> 0 then
    raise exception 'au_f_org_tree_as_of(today) names a different occupant from the live org tree on % seat(s).', v_occupant;
  end if;

  select count(*) into v_shape
  from public.au_v_org_tree l
  join public.au_f_org_tree_as_of(v_today) a on a.seat_id = l.seat_id
  where a.parent_seat_id is distinct from l.parent_seat_id
     or a.region_code    is distinct from l.region_code
     or a.area_code      is distinct from l.area_code;

  raise notice 'au_f_org_tree_as_of(today) matches the live org tree on seats (%) and occupants; % seat(s) differ in parent, region or area.', v_asof, v_shape;
end
$do$;
