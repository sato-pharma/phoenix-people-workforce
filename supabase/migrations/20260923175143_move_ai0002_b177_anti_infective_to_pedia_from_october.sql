-- Move AI-0002 (Ahmed Nabil, Alex East) and B-177 (Mostafa Saied, Behira 2)
-- from Anti Infective to Pedia under DM Mohamed Alaa Eleiwa (PD-0012).
-- Org-visible NOW; sales credit switches to Pedia on 2026-10-01.
-- September + all locked prior months untouched (dated pair @ 2026-10-01).

create table if not exists au.bak_move_ai0002_b177_occ_20260923 as
  select * from au.occupancy_history
  where seat_id in ('SEAT-AIF-REP-AB1','SEAT-AIF-REP-AB5','SEAT-PED-REP-AB1','SEAT-PED-REP-AB5');

create table if not exists au.bak_move_ai0002_b177_lam_20260923 as
  select * from au.line_area_map
  where area_code in ('AB1','AB5') and line_code in ('anti_infective','pedia');

create table if not exists au.bak_move_ai0002_b177_emp_20260923 as
  select * from public.employees where hr_id in ('AI-0002','B-177');

do $mig$
declare
  v_eff  date := date '2026-10-01';
  v_prev_ai_aif bigint;
  v_prev_b_aif  bigint;
  v_prev_ai_ped bigint;
  v_prev_b_ped  bigint;
begin
  if exists (select 1 from au.occupancy_history
             where seat_id='SEAT-PED-REP-AB1' and occupant_hr_id='AI-0002' and effective_to is null) then
    raise notice 'move already applied; skipping';
    return;
  end if;

  select occupancy_id into v_prev_ai_aif from au.occupancy_history
    where seat_id='SEAT-AIF-REP-AB1' and occupant_hr_id='AI-0002' and effective_to is null;
  select occupancy_id into v_prev_b_aif from au.occupancy_history
    where seat_id='SEAT-AIF-REP-AB5' and occupant_hr_id='B-177' and effective_to is null;
  select occupancy_id into v_prev_ai_ped from au.occupancy_history
    where seat_id='SEAT-PED-REP-AB1' and occupant_hr_id is null and effective_to is null;
  select occupancy_id into v_prev_b_ped from au.occupancy_history
    where seat_id='SEAT-PED-REP-AB5' and occupant_hr_id is null and effective_to is null;

  if v_prev_ai_aif is null or v_prev_b_aif is null or v_prev_ai_ped is null or v_prev_b_ped is null then
    raise exception 'precondition failed (ai_aif=%, b_aif=%, ai_ped=%, b_ped=%)',
      v_prev_ai_aif, v_prev_b_aif, v_prev_ai_ped, v_prev_b_ped;
  end if;

  -- 1) AIF: close person spans @ 2026-10-01, open vacant placeholders from 2026-10-01
  update au.occupancy_history set effective_to = v_eff
    where occupancy_id in (v_prev_ai_aif, v_prev_b_aif);

  insert into au.occupancy_history
    (seat_id, occupant_hr_id, node_type, effective_from, effective_to, event_type,
     line_code, region_code, area_code, manager_seat_id, manager_hr_id,
     prev_occupancy_id, change_reason, source_system, changed_by_hr_id)
  values
    ('SEAT-AIF-REP-AB1', null, 'vacant_placeholder', v_eff, null, 'transfer_out',
     'anti_infective','AB','AB1','SEAT-AIF-DM-AB','B-156',
     v_prev_ai_aif, 'AI-0002 moved to Pedia line effective 2026-10-01', 'org_move_ai0002_b177_pedia', 'B-10'),
    ('SEAT-AIF-REP-AB5', null, 'vacant_placeholder', v_eff, null, 'transfer_out',
     'anti_infective','AB','AB5','SEAT-AIF-DM-AB','B-156',
     v_prev_b_aif, 'B-177 moved to Pedia line effective 2026-10-01', 'org_move_ai0002_b177_pedia', 'B-10');

  -- 2) Pedia: close vacant placeholders @ 2026-10-01, open person spans from 2026-10-01
  update au.occupancy_history set effective_to = v_eff
    where occupancy_id in (v_prev_ai_ped, v_prev_b_ped);

  insert into au.occupancy_history
    (seat_id, occupant_hr_id, node_type, effective_from, effective_to, event_type,
     line_code, region_code, area_code, manager_seat_id, manager_hr_id,
     prev_occupancy_id, change_reason, source_system, changed_by_hr_id)
  values
    ('SEAT-PED-REP-AB1', 'AI-0002', 'person', v_eff, null, 'transfer_in',
     'pedia','AB','AB1','SEAT-PED-DM-AB','PD-0012',
     v_prev_ai_ped, 'AI-0002 joins Pedia under DM PD-0012 effective 2026-10-01', 'org_move_ai0002_b177_pedia', 'B-10'),
    ('SEAT-PED-REP-AB5', 'B-177', 'person', v_eff, null, 'transfer_in',
     'pedia','AB','AB5','SEAT-PED-DM-AB','PD-0012',
     v_prev_b_ped, 'B-177 joins Pedia under DM PD-0012 effective 2026-10-01', 'org_move_ai0002_b177_pedia', 'B-10');

  -- 3) LINE_AREA_MAP dated pair @ 2026-10-01 (carries_target is generated -> omitted)
  update au.line_area_map set effective_to = v_eff
    where effective_to is null and area_code in ('AB1','AB5')
      and line_code in ('anti_infective','pedia') and effective_from < v_eff;

  insert into au.line_area_map
    (line_code, area_code, operational_region_code, area_state, dm_seat_id, rep_seat_id,
     other_type, staffed_in_line_code, effective_from, effective_to, notes)
  values
    ('anti_infective','AB1','AB','vacant_will_hire','SEAT-AIF-DM-AB','SEAT-AIF-REP-AB1',
     null,null,v_eff,null,'AI-0002 moved to Pedia 2026-10-01; AIF Alex East open'),
    ('anti_infective','AB5','AB','vacant_will_hire','SEAT-AIF-DM-AB','SEAT-AIF-REP-AB5',
     null,null,v_eff,null,'B-177 moved to Pedia 2026-10-01; AIF Behira 2 open'),
    ('pedia','AB1','AB','occupied','SEAT-PED-DM-AB','SEAT-PED-REP-AB1',
     null,null,v_eff,null,'AI-0002 joined Pedia 2026-10-01'),
    ('pedia','AB5','AB','occupied','SEAT-PED-DM-AB','SEAT-PED-REP-AB5',
     null,null,v_eff,null,'B-177 joined Pedia 2026-10-01');

  -- 4) EMPLOYEES: line + manager change now (area/team/region unchanged)
  update public.employees
    set line_id = 2, manager_hr_id = 'PD-0012', updated_at = now()
    where hr_id in ('AI-0002','B-177');

  -- ===== PROVE-IT ASSERTIONS (roll back on any failure) =====
  if (select occupant_hr_id from au.occupancy_history
        where seat_id='SEAT-AIF-REP-AB1' and node_type='person'
          and effective_from <= date '2026-09-30'
          and (effective_to is null or effective_to > date '2026-09-30')) is distinct from 'AI-0002'
     then raise exception 'ASSERT Sep AIF AB1 occupant != AI-0002'; end if;
  if (select occupant_hr_id from au.occupancy_history
        where seat_id='SEAT-AIF-REP-AB5' and node_type='person'
          and effective_from <= date '2026-09-30'
          and (effective_to is null or effective_to > date '2026-09-30')) is distinct from 'B-177'
     then raise exception 'ASSERT Sep AIF AB5 occupant != B-177'; end if;
  if exists (select 1 from au.occupancy_history
        where seat_id in ('SEAT-PED-REP-AB1','SEAT-PED-REP-AB5') and node_type='person'
          and effective_from <= date '2026-09-30'
          and (effective_to is null or effective_to > date '2026-09-30'))
     then raise exception 'ASSERT Sep Pedia seat unexpectedly occupied'; end if;

  if (select area_state from au.line_area_map
        where line_code='anti_infective' and area_code='AB1'
          and effective_from <= date '2026-09-30'
          and (effective_to is null or effective_to > date '2026-09-30')) <> 'occupied'
     then raise exception 'ASSERT Sep AIF AB1 area_state != occupied'; end if;
  if (select area_state from au.line_area_map
        where line_code='pedia' and area_code='AB1'
          and effective_from <= date '2026-09-30'
          and (effective_to is null or effective_to > date '2026-09-30')) <> 'vacant_will_hire'
     then raise exception 'ASSERT Sep Pedia AB1 area_state != vacant_will_hire'; end if;

  if not exists (select 1 from au.occupancy_history
        where seat_id='SEAT-PED-REP-AB1' and occupant_hr_id='AI-0002'
          and effective_from = v_eff and effective_to is null)
     then raise exception 'ASSERT Pedia AB1 open span for AI-0002 missing'; end if;
  if not exists (select 1 from au.occupancy_history
        where seat_id='SEAT-PED-REP-AB5' and occupant_hr_id='B-177'
          and effective_from = v_eff and effective_to is null)
     then raise exception 'ASSERT Pedia AB5 open span for B-177 missing'; end if;
  if (select area_state from au.line_area_map
        where line_code='pedia' and area_code='AB1' and effective_to is null) <> 'occupied'
     then raise exception 'ASSERT current Pedia AB1 area_state != occupied'; end if;
  if (select area_state from au.line_area_map
        where line_code='anti_infective' and area_code='AB1' and effective_to is null) <> 'vacant_will_hire'
     then raise exception 'ASSERT current AIF AB1 area_state != vacant_will_hire'; end if;

  if (select count(*) from public.employees
        where hr_id in ('AI-0002','B-177') and line_id=2 and manager_hr_id='PD-0012') <> 2
     then raise exception 'ASSERT employees line/manager not updated'; end if;

  raise notice 'move applied OK';
end $mig$;
