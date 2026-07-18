create or replace view au.v_org_tree as
with recursive tree as (
  select s.seat_id, s.parent_seat_id, s.seat_tier, s.line_code, s.region_code, s.area_code,
         s.is_other_pseudo_dm, s.seat_label, 0 as depth, array[s.seat_id] as path
  from au.seats s where s.parent_seat_id is null
  union all
  select c.seat_id, c.parent_seat_id, c.seat_tier, c.line_code, c.region_code, c.area_code,
         c.is_other_pseudo_dm, c.seat_label, t.depth + 1, t.path || c.seat_id
  from au.seats c join tree t on c.parent_seat_id = t.seat_id
)
select t.seat_id, t.parent_seat_id, t.seat_tier, t.line_code, t.region_code, t.area_code,
       t.is_other_pseudo_dm, t.seat_label, t.depth, t.path,
       o.occupant_hr_id, o.node_type, (o.occupant_hr_id is null) as is_vacant,
       ca.area_name, rg.region_name, ln.line_name, ln.line_id
from tree t
left join au.occupancy_history o on o.seat_id = t.seat_id and o.effective_to is null
left join au.canonical_areas ca on ca.area_code = t.area_code
left join au.regions rg on rg.region_code = t.region_code
left join au.lines ln on ln.line_code = t.line_code;

-- recreate the public wrapper so it picks up the new columns (select * is expanded at create time)
create or replace view public.au_v_org_tree as select * from au.v_org_tree;
grant select on public.au_v_org_tree to anon, authenticated, service_role;
