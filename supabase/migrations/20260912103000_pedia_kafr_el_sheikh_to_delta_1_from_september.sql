-- Pedia: Kafr El-Sheikh 1 moves from Alex-BHR to Delta (1), effective 2026-09-01.
--
-- Owner-approved 2026-09-12, in his words: "in Pedia line Kafr El sheiykh starting from september
-- will move under delta 1 region", and then, asked what travels with it: "kafr el sheikh 2 stays in
-- others, pedia only".
--
--   Kafr El-Sheikh 1 (D16)  Alex-BHR -> Delta (1). Occupied, keeps its target and its rep seat.
--   Kafr El-Sheikh 2 (D17)  stays in Others, untouched by this migration. His words, verbatim.
--   CNS and Anti Infective  untouched. PEDIA ONLY, his words.
--
-- WHAT THIS IS, STRUCTURALLY. The area CODE has always been a Delta (1) code -- au.canonical_areas
-- has D16 and D17 on code_region_code 'D1' -- and Anti Infective already files Kafr El-Sheikh 1
-- under its Delta (1) DM. Pedia and CNS were the two lines overriding that operationally to
-- Alex-BHR. This retires the override on Pedia alone, so from September the operational region and
-- the code region finally agree there. CNS keeps its override, deliberately; a half-migrated state
-- across lines is the normal shape here (AGENTS.md section 4, Delta (3) is ANTI-INFECTIVE ONLY).
--
-- WHY A DATED PAIR AND NOT AN IN-PLACE UPDATE. This is the Delta (3) / Upper Egypt shape -- see
-- 20260829113500_anti_infective_delta_3_from_september.sql and
-- 20260909223000_pedia_upper_egypt_split_from_september.sql, which this deliberately mirrors.
-- Achievement and the Monthly Closing both resolve region through au.f_line_area_map_asof at the
-- END of the month being closed, not on the day the closing is run. Closing the open row at
-- 2026-09-01 (effective_to is EXCLUSIVE) and opening the new one on the same date is what makes
-- August unreachable by this change, whenever August is finally run.
--
-- EL QEMA IS NOT AFFECTED, AND THAT IS WHY D17 MATTERED. The ladder's divisor is every Pedia area
-- the organogram does NOT park in Others. Kafr El-Sheikh 1 is not in Others today and is not in
-- Others after this, so it was already in play both months and the divisor stays 39. Kafr
-- El-Sheikh 2 IS in Others, and pulling it out would have taken the divisor to 40 and moved every
-- El Qema Pedia number from September -- which is the question that was put to the owner, and he
-- answered that it stays. The lead guarantee keys on Qalubeya, Tanta and Mahalla BY AREA CODE
-- (QEMA_LEAD_TIERS), never by region, so gaining a sixth area in Delta (1) does not touch it.
--
-- carries_target is a STORED GENERATED column (area_state in ('occupied','vacant_will_hire')), so
-- it is never inserted. The area is occupied by Ebtissam Alaa ElDin Anwar and stays occupied.
--
-- au.seats has seat_id alone as its primary key, so a seat CANNOT be forward-dated the way a map
-- row can. Re-pointing the Kafr El-Sheikh 1 rep seat from the Alex-BHR DM to the Delta (1) DM
-- therefore happens the moment this is applied. That is chart metadata only -- every number the
-- closing produces comes from au.line_area_map, which IS dated. It is also moot in practice: the
-- move date has already passed, so the chart and the numbers agree from the first day this runs.
--
-- Idempotent: re-running after it has taken effect is a no-op, not a second move.
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
     and area_code = 'D16'
     and operational_region_code = 'D1'
     and effective_from = v_move_date;

  if v_existing = 1 then
    raise notice 'Kafr El-Sheikh 1 move already applied - the Delta (1) row is present from %. Nothing to do.', v_move_date;
    return;
  elsif v_existing <> 0 then
    raise exception 'Kafr El-Sheikh 1 move: % Delta (1) rows exist from % where 1 was expected. Refusing to guess - inspect au.line_area_map by hand.', v_existing, v_move_date;
  end if;

  -- The pre-move row must be open and on exactly the region we expect it to be leaving. Anything
  -- else means the org chart moved under us since this migration was written.
  select count(*) into v_open
    from au.line_area_map
   where line_code = 'pedia'
     and effective_to is null
     and area_code = 'D16'
     and operational_region_code = 'AB';

  if v_open <> 1 then
    raise exception 'Kafr El-Sheikh 1 move: expected 1 open pre-move row (D16 on AB, pedia), found %. Refusing to apply.', v_open;
  end if;

  -- Pre-image, before anything is touched.
  create table if not exists au.bak_20260912_pedia_kfs_d1_line_area_map as
    select * from au.line_area_map where line_code = 'pedia';
  create table if not exists au.bak_20260912_pedia_kfs_d1_seats as
    select * from au.seats where line_code = 'pedia';
  alter table au.bak_20260912_pedia_kfs_d1_line_area_map enable row level security;
  alter table au.bak_20260912_pedia_kfs_d1_seats enable row level security;
  revoke all on au.bak_20260912_pedia_kfs_d1_line_area_map from anon, authenticated;
  revoke all on au.bak_20260912_pedia_kfs_d1_seats from anon, authenticated;

  -- Close the Alex-BHR row.
  update au.line_area_map
     set effective_to = v_move_date
   where line_code = 'pedia'
     and area_code = 'D16'
     and effective_to is null;
  get diagnostics v_closed = row_count;

  if v_closed <> 1 then
    raise exception 'Kafr El-Sheikh 1 move: expected to close 1 row, closed %.', v_closed;
  end if;

  -- Open the Delta (1) row.
  insert into au.line_area_map
    (line_code, area_code, operational_region_code, area_state, dm_seat_id, rep_seat_id,
     other_type, staffed_in_line_code, effective_from, effective_to, notes)
  values
    ('pedia','D16','D1','occupied','SEAT-PED-DM-D1','SEAT-PED-REP-D16',
     null, null, v_move_date, null,
     'Kafr El-Sheikh 1 moves from Alex-BHR to Delta (1), owner-approved 2026-09-12. Pedia only - CNS keeps it under Alex-BHR and Anti Infective already had it in Delta (1). Kafr El-Sheikh 2 stays in Others.');
  get diagnostics v_inserted = row_count;

  if v_inserted <> 1 then
    raise exception 'Kafr El-Sheikh 1 move: expected to insert 1 row, inserted %.', v_inserted;
  end if;

  -- Re-point the rep seat to the Delta (1) DM. Chart metadata only - see the header.
  update au.seats
     set region_code = 'D1', parent_seat_id = 'SEAT-PED-DM-D1'
   where seat_id = 'SEAT-PED-REP-D16'
     and line_code = 'pedia';

  -- August must still resolve to Alex-BHR, September to Delta (1). This is the whole point of the
  -- change, so it is asserted here rather than left to a later eyeball.
  if (select count(*) from au.f_line_area_map_asof(date '2026-08-31')
       where line_code = 'pedia' and area_code = 'D16'
         and operational_region_code = 'AB') <> 1 then
    raise exception 'Kafr El-Sheikh 1 move: August 2026 no longer resolves Kafr El-Sheikh 1 to Alex-BHR - the move leaked backwards. Rolled back.';
  end if;

  if (select count(*) from au.f_line_area_map_asof(date '2026-09-30')
       where line_code = 'pedia' and area_code = 'D16'
         and operational_region_code = 'D1') <> 1 then
    raise exception 'Kafr El-Sheikh 1 move: September 2026 does not resolve Kafr El-Sheikh 1 to Delta (1). Rolled back.';
  end if;

  -- NAME THE AREA, NEVER COUNT THE REGION. au.f_line_area_map_asof has no where clause, so it
  -- returns one row per (line, area) whether or not any row covers the date - a retired area is
  -- reported in its last region forever. Counting Others would pin that quirk instead of the rule.
  -- Kafr El-Sheikh 2 stays in Others in BOTH months (owner, 2026-09-12), which is what holds the
  -- El Qema divisor at 39.
  if (select count(*) from au.f_line_area_map_asof(date '2026-08-31')
       where line_code = 'pedia' and area_code = 'D17' and operational_region_code = 'OT') <> 1
     or (select count(*) from au.f_line_area_map_asof(date '2026-09-30')
          where line_code = 'pedia' and area_code = 'D17' and operational_region_code = 'OT') <> 1 then
    raise exception 'Kafr El-Sheikh 1 move: Kafr El-Sheikh 2 left Others - the El Qema divisor moved. Rolled back.';
  end if;

  -- PEDIA ONLY. CNS keeps Kafr El-Sheikh 1 under Alex-BHR; Anti Infective keeps it in Delta (1).
  if (select count(*) from au.f_line_area_map_asof(date '2026-09-30')
       where line_code = 'cns' and area_code = 'D16'
         and operational_region_code = 'AB') <> 1 then
    raise exception 'Kafr El-Sheikh 1 move: CNS moved too - this is Pedia only. Rolled back.';
  end if;

  if (select count(*) from au.f_line_area_map_asof(date '2026-09-30')
       where line_code = 'anti_infective' and area_code = 'D16'
         and operational_region_code = 'D1') <> 1 then
    raise exception 'Kafr El-Sheikh 1 move: Anti Infective no longer has Kafr El-Sheikh 1 in Delta (1). Rolled back.';
  end if;

  raise notice 'Kafr El-Sheikh 1 move applied: 1 row closed at %, 1 Delta (1) row opened. August keeps it in Alex-BHR, September moves it to Delta (1); Kafr El-Sheikh 2 stays in Others and CNS is untouched.', v_move_date;
end
$do$;
