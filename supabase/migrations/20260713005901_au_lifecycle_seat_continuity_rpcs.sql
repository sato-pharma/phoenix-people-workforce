-- Phase 4: seat-continuity lifecycle. A person leaving does NOT remove the seat —
-- it closes their occupancy span and opens a VACANT span on the SAME seat_id (box kept,
-- history preserved via prev_occupancy_id). Hiring fills the same seat, so the new
-- occupant inherits everything keyed to that seat/area (incl. sales history).

create or replace function au.resign_occupant(
  p_seat_id text, p_effective_date date, p_reason text default null, p_actor text default null)
returns bigint language plpgsql security definer set search_path = au, public as $$
declare v_cur au.occupancy_history; v_seat au.seats; v_mgr text; v_new bigint;
begin
  select * into v_seat from au.seats where seat_id = p_seat_id;
  if not found then raise exception 'resign: seat % not found', p_seat_id; end if;
  select * into v_cur from au.occupancy_history where seat_id = p_seat_id and effective_to is null;
  if not found then raise exception 'resign: seat % has no open span', p_seat_id; end if;
  if v_cur.occupant_hr_id is null then raise exception 'resign: seat % is already vacant', p_seat_id; end if;
  update au.occupancy_history set effective_to = p_effective_date where occupancy_id = v_cur.occupancy_id;
  select occupant_hr_id into v_mgr from au.occupancy_history where seat_id = v_seat.parent_seat_id and effective_to is null;
  insert into au.occupancy_history(seat_id,occupant_hr_id,node_type,effective_from,event_type,line_code,region_code,area_code,manager_seat_id,manager_hr_id,prev_occupancy_id,change_reason,source_system,changed_by_hr_id)
  values (p_seat_id,null,'vacant_placeholder',p_effective_date,'resign',v_seat.line_code,v_seat.region_code,v_seat.area_code,v_seat.parent_seat_id,v_mgr,v_cur.occupancy_id,p_reason,'resignation_rpc',p_actor)
  returning occupancy_id into v_new;
  return v_new;
end $$;

create or replace function au.hire_into_seat(
  p_seat_id text, p_hr_id text, p_effective_date date, p_actor text default null)
returns bigint language plpgsql security definer set search_path = au, public as $$
declare v_cur au.occupancy_history; v_seat au.seats; v_mgr text; v_new bigint;
begin
  select * into v_seat from au.seats where seat_id = p_seat_id;
  if not found then raise exception 'hire: seat % not found', p_seat_id; end if;
  select * into v_cur from au.occupancy_history where seat_id = p_seat_id and effective_to is null;
  if found then
    if v_cur.occupant_hr_id is not null then raise exception 'hire: seat % already occupied by %', p_seat_id, v_cur.occupant_hr_id; end if;
    update au.occupancy_history set effective_to = p_effective_date where occupancy_id = v_cur.occupancy_id;
  end if;
  select occupant_hr_id into v_mgr from au.occupancy_history where seat_id = v_seat.parent_seat_id and effective_to is null;
  insert into au.occupancy_history(seat_id,occupant_hr_id,node_type,effective_from,event_type,line_code,region_code,area_code,manager_seat_id,manager_hr_id,prev_occupancy_id,change_reason,source_system,changed_by_hr_id)
  values (p_seat_id,p_hr_id,'person',p_effective_date,'hire',v_seat.line_code,v_seat.region_code,v_seat.area_code,v_seat.parent_seat_id,v_mgr,v_cur.occupancy_id,null,'hire_rpc',p_actor)
  returning occupancy_id into v_new;
  return v_new;
end $$;

create or replace function au.transfer_occupant(
  p_hr_id text, p_from_seat text, p_to_seat text, p_effective_date date, p_reason text default null, p_actor text default null)
returns bigint language plpgsql security definer set search_path = au, public as $$
declare v_new bigint;
begin
  perform au.resign_occupant(p_from_seat, p_effective_date, coalesce(p_reason,'transfer'), p_actor);
  update au.occupancy_history set event_type='transfer_out' where seat_id=p_from_seat and effective_to is null;
  v_new := au.hire_into_seat(p_to_seat, p_hr_id, p_effective_date, p_actor);
  update au.occupancy_history set event_type='transfer_in' where occupancy_id=v_new;
  return v_new;
end $$;

-- security: server-only (matches the org views)
revoke execute on function au.resign_occupant(text,date,text,text) from public;
revoke execute on function au.hire_into_seat(text,text,date,text) from public;
revoke execute on function au.transfer_occupant(text,text,text,date,text,text) from public;
grant execute on function au.resign_occupant(text,date,text,text) to service_role;
grant execute on function au.hire_into_seat(text,text,date,text) to service_role;
grant execute on function au.transfer_occupant(text,text,text,date,text,text) to service_role;
