-- The organogram stops showing a RETIRED seat.
--
-- Reported by the owner 2026-09-09, trying to add the two new Upper Egypt district managers: "I
-- noted that Upper Egypt in line Pedia is still non-splitted." The split itself was applied and
-- correct — au_v_line_area_map showed Upper Egypt 1 with six areas and Upper Egypt 2 with five, and
-- no plain UE at all. What he was looking at was the old single district STILL DRAWN on the chart:
-- SEAT-PED-DM-UE, retired that evening with is_active = false and effective_to = 2026-09-01.
--
-- au.v_org_tree walks au.seats recursively and filters on NEITHER column, so a retired seat stays
-- on the organogram forever, as an empty vacant district beside the real ones. That is pre-existing
-- and had simply never been reachable before: retiring a seat is rare, and this is the first one.
-- Measured before writing this: of 141 seats, exactly ONE is retired, so this changes exactly the
-- node he is looking at and nothing else in the company.
--
-- 🔴 RETIRE A SEAT ONLY AFTER RE-POINTING ITS CHILDREN. The walk is recursive, so a filtered-out
-- parent takes its whole subtree with it — the children do not re-parent, they VANISH. This is safe
-- here because the Upper Egypt split moved all seven rep seats onto the two new district seats
-- first, leaving the retired one with zero children, which was checked before this was written.
--
-- The seat ROW must survive: seven historical au.line_area_map rows still carry it as their
-- dm_seat_id, which is how August and every earlier month know who ran Upper Egypt. The FK is
-- ON DELETE RESTRICT and is doing its job — this is a display filter, never a delete.
--
-- Deliberately NOT filtering on effective_from. A seat dated to start in the future would still be
-- drawn, which is the behaviour every existing seat already relies on, and no seat carries a future
-- effective_from today. Hiding one is a separate change nobody has asked for.
create or replace view au.v_org_tree as
with recursive tree as (
  select
    s.seat_id,
    s.parent_seat_id,
    s.seat_tier,
    s.line_code,
    s.region_code,
    s.area_code,
    s.is_other_pseudo_dm,
    s.seat_label,
    0 as depth,
    array[s.seat_id] as path
  from au.seats s
  where s.parent_seat_id is null
    and s.is_active
    and (s.effective_to is null or s.effective_to > current_date)
  union all
  select
    c.seat_id,
    c.parent_seat_id,
    c.seat_tier,
    c.line_code,
    c.region_code,
    c.area_code,
    c.is_other_pseudo_dm,
    c.seat_label,
    t_1.depth + 1,
    t_1.path || c.seat_id
  from au.seats c
  join tree t_1 on c.parent_seat_id = t_1.seat_id
  where c.is_active
    and (c.effective_to is null or c.effective_to > current_date)
)
select
  t.seat_id,
  t.parent_seat_id,
  t.seat_tier,
  t.line_code,
  t.region_code,
  t.area_code,
  t.is_other_pseudo_dm,
  t.seat_label,
  t.depth,
  t.path,
  o.occupant_hr_id,
  o.node_type,
  o.occupant_hr_id is null as is_vacant,
  ca.area_name,
  rg.region_name,
  ln.line_name,
  ln.line_id,
  case
    when o.occupant_hr_id is null then t.seat_label || ' (VACANT)'::text
    else t.seat_label
  end as seat_display_label
from tree t
  left join au.occupancy_history o on o.seat_id = t.seat_id and o.effective_to is null
  left join au.canonical_areas ca on ca.area_code = t.area_code
  left join au.regions rg on rg.region_code = t.region_code
  left join au.lines ln on ln.line_code = t.line_code;

-- Prove it: the retired Upper Egypt district is gone, both new ones are present, and the company's
-- seat count drops by exactly the one seat that was retired.
do $do$
declare
  v_retired int;
  v_new     int;
  v_total   int;
begin
  select count(*) into v_retired from au_v_org_tree where seat_id = 'SEAT-PED-DM-UE';
  if v_retired <> 0 then
    raise exception 'org tree still draws the retired Upper Egypt district seat.';
  end if;

  select count(*) into v_new from au_v_org_tree
   where seat_id in ('SEAT-PED-DM-UE-1','SEAT-PED-DM-UE-2');
  if v_new <> 2 then
    raise exception 'org tree does not draw both new Upper Egypt district seats: found %.', v_new;
  end if;

  select count(*) into v_total from au_v_org_tree;
  if v_total <> (select count(*) from au.seats
                  where is_active and (effective_to is null or effective_to > current_date)) then
    raise exception 'org tree row count does not match the live seat count - the recursive walk dropped a subtree.';
  end if;

  raise notice 'org tree now hides retired seats: the old Upper Egypt district is gone, both new ones present, % seats drawn.', v_total;
end
$do$;
