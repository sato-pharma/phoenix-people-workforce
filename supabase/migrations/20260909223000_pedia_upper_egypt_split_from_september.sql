-- Pedia: Upper Egypt splits into Upper Egypt 1 and Upper Egypt 2, effective 2026-09-01.
--
-- Owner-approved 2026-09-09, in his words: "August closing will be normally. The changes in sales
-- will be starting from September", and then, asked again, "starting from September everything will
-- be based on this distribution ... but you will pause August, August as it is."
--
--   Upper Egypt 1  Fayoum, Beni Suef, Minia 1, Minia 2, Assuit 1, Assuit 2
--   Upper Egypt 2  Sohag 1, Sohag 2, Qena 1, Qena 2, and Luxor
--   Others         Aswan stays exactly where it is, untouched by this migration
--
-- PEDIA ONLY - owner, three times in one breath. CNS keeps a single Upper Egypt district and Anti
-- Infective keeps the UE-1 / UE-2 split it already has, whose MEMBERSHIP is deliberately different
-- from Pedia's (Assuit sits in UE-2 there and in UE-1 here). au.line_area_map is per line, so the
-- same two region codes legitimately hold different areas on different lines. Do not "align" them.
--
-- WHY A DATED PAIR AND NOT AN IN-PLACE UPDATE. This is the Delta (3) shape - see
-- 20260829113500_anti_infective_delta_3_from_september.sql, which this deliberately mirrors.
-- Achievement and the Monthly Closing both resolve region through au.f_line_area_map_asof at the
-- END of the month being closed, not on the day the closing is run. Closing the open rows at
-- 2026-09-01 (effective_to is EXCLUSIVE) and opening the new ones on the same date is what makes
-- August unreachable by this change, whenever August is finally run. That IS the snapshot the owner
-- asked for, held as a date rather than as a copy, so nothing has to be remembered on the 1st.
--
-- WHAT THIS MOVES BESIDES THE ORG CHART. El Qema's priority ladder (#3583) spreads that
-- distributor's whole Pedia book over every area the line has except those parked in Others, and
-- the exclusion keys on operational_region_code = 'OT' alone. Qena 2 and Luxor leave Others here,
-- so the ladder's divisor goes from 37 areas to 39 from September. August still divides by 37.
--
-- LUXOR IS NOT A SEPARATE AREA - owner, asked directly: "Luxor is with Qena 2 ... not a separate
-- area." It moves into Upper Egypt 2 but stays other_permanent with no rep seat, so it carries no
-- target of its own and its sales answer to the Upper Egypt 2 district. This is exactly how OT9
-- Ismailia was carried into Delta (3). It still takes a ladder share, because the ladder counts
-- areas and not reps, and no area_state can change that.
--
-- carries_target is a STORED GENERATED column (area_state in ('occupied','vacant_will_hire')), so
-- it is never inserted. Setting area_state is what turns a target on.
--
-- au.seats has seat_id alone as its primary key, so a seat CANNOT be forward-dated the way a map
-- row can. The four new seats carry effective_from 2026-09-01, but re-pointing the existing Upper
-- Egypt rep seats to their new district happens the moment this is applied. That is chart metadata
-- only - every number the closing produces comes from au.line_area_map, which IS dated.
--
-- Idempotent: re-running after it has taken effect is a no-op, not a second split.
do $do$
declare
  v_move_date constant date := date '2026-09-01';
  v_existing  int;
  v_open      int;
  v_closed    int;
  v_inserted  int;
begin
  select count(*) into v_existing
    from au.line_area_map
   where line_code = 'pedia'
     and operational_region_code in ('UE-1','UE-2')
     and effective_from = v_move_date;

  if v_existing = 11 then
    raise notice 'Pedia Upper Egypt split already applied - 11 rows present from %. Nothing to do.', v_move_date;
    return;
  elsif v_existing <> 0 then
    raise exception 'Pedia Upper Egypt split is HALF applied: % of 11 rows exist from %. Refusing to guess - inspect au.line_area_map by hand.', v_existing, v_move_date;
  end if;

  -- Every pre-split row must be open and on exactly the region we expect it to be leaving.
  -- Anything else means the org chart moved under us since this migration was written.
  select count(*) into v_open
    from au.line_area_map
   where line_code = 'pedia'
     and effective_to is null
     and (area_code, operational_region_code) in
         (('GZ6','GZ'), ('UE9','GZ'),
          ('UE1','UE'), ('UE2','UE'), ('UE3','UE'), ('UE4','UE'),
          ('UE5','UE'), ('UE6','UE'), ('UE7','UE'),
          ('UE8','OT'), ('OT6','OT'));

  if v_open <> 11 then
    raise exception 'Pedia Upper Egypt split: expected 11 open pre-split rows, found %. Refusing to apply.', v_open;
  end if;

  -- Pre-image, before anything is touched.
  create table if not exists au.bak_20260909_pedia_ue_split_line_area_map as
    select * from au.line_area_map where line_code = 'pedia';
  create table if not exists au.bak_20260909_pedia_ue_split_seats as
    select * from au.seats where line_code = 'pedia';
  alter table au.bak_20260909_pedia_ue_split_line_area_map enable row level security;
  alter table au.bak_20260909_pedia_ue_split_seats enable row level security;
  revoke all on au.bak_20260909_pedia_ue_split_line_area_map from anon, authenticated;
  revoke all on au.bak_20260909_pedia_ue_split_seats from anon, authenticated;

  -- The four new seats, dated to the move.
  insert into au.seats
    (seat_id, seat_tier, line_code, region_code, area_code, parent_seat_id, seat_label,
     is_active, effective_from)
  values
    ('SEAT-PED-DM-UE-1','DM','pedia','UE-1',null,'SEAT-PED-NSM',
     'PEDIA Upper Egypt 1 DM', true, v_move_date),
    ('SEAT-PED-DM-UE-2','DM','pedia','UE-2',null,'SEAT-PED-NSM',
     'PEDIA Upper Egypt 2 DM', true, v_move_date),
    ('SEAT-PED-REP-UE9','REP','pedia','UE-1','UE9','SEAT-PED-DM-UE-1',
     'PED UE9 rep', true, v_move_date),
    ('SEAT-PED-REP-UE8','REP','pedia','UE-2','UE8','SEAT-PED-DM-UE-2',
     'PED UE8 rep', true, v_move_date)
  on conflict (seat_id) do nothing;

  -- Close the eleven open rows.
  update au.line_area_map
     set effective_to = v_move_date
   where line_code = 'pedia'
     and area_code in ('GZ6','UE9','UE1','UE2','UE3','UE4','UE5','UE6','UE7','UE8','OT6')
     and effective_to is null;
  get diagnostics v_closed = row_count;

  if v_closed <> 11 then
    raise exception 'Pedia Upper Egypt split: expected to close 11 rows, closed %.', v_closed;
  end if;

  -- Open the eleven September rows.
  insert into au.line_area_map
    (line_code, area_code, operational_region_code, area_state, dm_seat_id, rep_seat_id,
     other_type, staffed_in_line_code, effective_from, effective_to, notes)
  values
    ('pedia','GZ6','UE-1','vacant_will_hire','SEAT-PED-DM-UE-1','SEAT-PED-REP-GZ6',
     null, null, v_move_date, null,
     'Upper Egypt split, owner-approved 2026-09-09. Fayoum leaves Giza and keeps its own rep seat; Beni Suef shared it until now.'),
    ('pedia','UE9','UE-1','vacant_will_hire','SEAT-PED-DM-UE-1','SEAT-PED-REP-UE9',
     null, null, v_move_date, null,
     'Upper Egypt split, owner-approved 2026-09-09. Beni Suef leaves Giza and gets a rep seat of its own.'),
    ('pedia','UE1','UE-1','vacant_will_hire','SEAT-PED-DM-UE-1','SEAT-PED-REP-UE1',
     null, null, v_move_date, null,
     'Upper Egypt split, owner-approved 2026-09-09.'),
    ('pedia','UE2','UE-1','occupied','SEAT-PED-DM-UE-1','SEAT-PED-REP-UE2',
     null, null, v_move_date, null,
     'Upper Egypt split, owner-approved 2026-09-09.'),
    ('pedia','UE3','UE-1','vacant_will_hire','SEAT-PED-DM-UE-1','SEAT-PED-REP-UE3',
     null, null, v_move_date, null,
     'Upper Egypt split, owner-approved 2026-09-09. Assuit sits in UE-1 on Pedia and in UE-2 on Anti Infective, deliberately.'),
    ('pedia','UE4','UE-1','vacant_will_hire','SEAT-PED-DM-UE-1','SEAT-PED-REP-UE4',
     null, null, v_move_date, null,
     'Upper Egypt split, owner-approved 2026-09-09.'),
    ('pedia','UE5','UE-2','vacant_will_hire','SEAT-PED-DM-UE-2','SEAT-PED-REP-UE5',
     null, null, v_move_date, null,
     'Upper Egypt split, owner-approved 2026-09-09.'),
    ('pedia','UE6','UE-2','occupied','SEAT-PED-DM-UE-2','SEAT-PED-REP-UE6',
     null, null, v_move_date, null,
     'Upper Egypt split, owner-approved 2026-09-09.'),
    ('pedia','UE7','UE-2','vacant_will_hire','SEAT-PED-DM-UE-2','SEAT-PED-REP-UE7',
     null, null, v_move_date, null,
     'Upper Egypt split, owner-approved 2026-09-09.'),
    ('pedia','UE8','UE-2','vacant_will_hire','SEAT-PED-DM-UE-2','SEAT-PED-REP-UE8',
     null, null, v_move_date, null,
     'Upper Egypt split, owner-approved 2026-09-09. Qena 2 leaves Others and becomes a staffed area carrying a target.'),
    ('pedia','OT6','UE-2','other_permanent','SEAT-PED-DM-UE-2',null,
     'permanent', null, v_move_date, null,
     'Upper Egypt split, owner-approved 2026-09-09. Luxor is with Qena 2 and is NOT a separate area: it joins Upper Egypt 2 but carries no target and has no rep of its own.');
  get diagnostics v_inserted = row_count;

  if v_inserted <> 11 then
    raise exception 'Pedia Upper Egypt split: expected to insert 11 rows, inserted %.', v_inserted;
  end if;

  -- Re-point the existing rep seats, and retire the single Upper Egypt DM seat.
  update au.seats set region_code = 'UE-1', parent_seat_id = 'SEAT-PED-DM-UE-1'
   where seat_id in ('SEAT-PED-REP-GZ6','SEAT-PED-REP-UE1','SEAT-PED-REP-UE2',
                     'SEAT-PED-REP-UE3','SEAT-PED-REP-UE4');
  update au.seats set region_code = 'UE-2', parent_seat_id = 'SEAT-PED-DM-UE-2'
   where seat_id in ('SEAT-PED-REP-UE5','SEAT-PED-REP-UE6','SEAT-PED-REP-UE7');
  update au.seats set effective_to = v_move_date, is_active = false
   where seat_id = 'SEAT-PED-DM-UE';

  -- August must still resolve to the PRE-split structure, September to the new one. This is the
  -- whole point of the change, so it is asserted here rather than left to a later eyeball.
  if exists (
    select 1 from au.f_line_area_map_asof(date '2026-08-31')
     where line_code = 'pedia' and operational_region_code in ('UE-1','UE-2')
  ) then
    raise exception 'Pedia Upper Egypt split: August 2026 resolves to the new districts - the move leaked backwards. Rolled back.';
  end if;

  if (select count(*) from au.f_line_area_map_asof(date '2026-08-31')
       where line_code = 'pedia' and operational_region_code = 'OT') <> 12 then
    raise exception 'Pedia Upper Egypt split: August 2026 no longer has 12 areas in Others - the El Qema divisor for August moved. Rolled back.';
  end if;

  if (select count(*) from au.f_line_area_map_asof(date '2026-09-30')
       where line_code = 'pedia' and operational_region_code = 'UE-1') <> 6
     or (select count(*) from au.f_line_area_map_asof(date '2026-09-30')
          where line_code = 'pedia' and operational_region_code = 'UE-2') <> 5 then
    raise exception 'Pedia Upper Egypt split: September 2026 does not resolve 6 areas to UE-1 and 5 to UE-2. Rolled back.';
  end if;

  if (select count(*) from au.f_line_area_map_asof(date '2026-09-30')
       where line_code = 'pedia' and operational_region_code = 'OT') <> 10 then
    raise exception 'Pedia Upper Egypt split: September 2026 does not leave 10 areas in Others. Rolled back.';
  end if;

  raise notice 'Pedia Upper Egypt split applied: 11 rows closed at %, 6 opened on UE-1 and 5 on UE-2. August resolves pre-split with 12 in Others; September resolves the new districts with 10.', v_move_date;
end
$do$;
