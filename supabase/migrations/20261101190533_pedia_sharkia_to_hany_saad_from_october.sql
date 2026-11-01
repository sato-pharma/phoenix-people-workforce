-- WHAT: Pedia only. From 2026-10-01 Sharkia 1 (D24) and Sharkia 2 (D25) stop counting to Sahar El
-- Gallad's Delta (2) district and count to Hany Saad, the Regional Sales Manager above her, as a new
-- district of their own, Sharkia.
--
-- WHY: owner, 2026-11-01: "in pedia organogram hide sharkia 1 and 2 we wiull potpond hiring now in
-- them so hide from organogram and in salaes for sahar el galad count what should be countet to her
-- and move the sharkia 1 and 2 to be counted in hany saad totales". Start month chosen by him the same
-- day: October 2026. July, August and September stay as published.
--
-- HOW, AND WHY IT IS A NEW SEAT. Who an area counts to is au.line_area_map.dm_seat_id and nothing else,
-- and the closing groups by operational_region_code, so Delta (2)'s subtotal only drops Sharkia if
-- Sharkia gets a region of its own. au.enforce_lam_region requires the seat's region to equal the map
-- row's, and Hany's regional seat has no region, so the map row cannot point at that seat directly.
-- So: a new region SH, and a new district seat under his regional seat, occupied by him.
--
-- WHY THAT SEAT IS is_active = false AND sales_only = true. au.v_org_tree filters is_active, so every
-- reader of the tree -- the organogram, recruitment folders, Phoenix CRM, field absence, seat transfer
-- -- goes on seeing Hany exactly as he is today, one regional seat, and no reader has to remember to
-- leave this one out. The few sales reads that must follow the money read public.au_v_org_tree_sales,
-- which is au.v_org_tree plus the sales_only seats. A vacant seat was rejected: every regional roll-up
-- and Employee 360 skip a row with no district manager on it, so nothing would reach his totals.
--
-- WHAT DOES NOT MOVE. The area stays vacant_will_hire with its rep seat, so carries_target stays true
-- and the targets stay. No target row and no sales row is written. The rep seats' parent stays
-- SEAT-PED-DM-D2: au.seats.parent_seat_id is not dated, so repointing it would redraw the past
-- organogram pictures and move recruitment and Phoenix CRM, which he did not ask for. SH is not an
-- Upper Egypt code and not Others, so the Upper Egypt city split and El Qema's divisor do not read it.
-- CNS and Anti Infective keep Sharkia exactly where it is.
--
-- PUBLISHED MONTHS. A dated pair, never an in-place edit: au.f_line_area_map_asof picks the interval
-- that contains the date, so July, August and September still resolve to Delta (2). The old row stays
-- the earliest, so the fallback for anything before 2026-07-13 stays Delta (2) as well.
--
-- ORDER, AND IT IS THE POINT. Apply this file only AFTER production serves the code that reads
-- public.au_v_org_tree_sales (read /api/healthz revision). The code before that reads au_v_org_tree, which
-- does not hold the new seat, so Hany and Sahar would both lose Sharkia in every month until it serves.
-- 20261101190532_au_v_org_tree_sales.sql, which this file needs, goes on BEFORE the merge.
--
-- ROLLBACK: restore the two rows from au.bak_20261101_pedia_sharkia_line_area_map (delete the two rows
-- from 2026-10-01, set effective_to back to null on the old ones), delete the occupancy row and the
-- seat, delete the region from au.regions and public.source_of_sales_regions. Nothing here deletes or
-- overwrites data. The single block is atomic: a failed check leaves nothing behind.
--
-- Idempotent: re-running after it has taken effect is a no-op.
do $do$
declare
  v_move_date constant date := date '2026-10-01';
  v_seat      constant text := 'SEAT-PED-DM-SH';
  v_hany      constant text := 'PD-0001';
  v_note      constant text := 'Owner, 2026-11-01: "move the sharkia 1 and 2 to be counted in hany saad totales", from October 2026. Hiring here is postponed; the area keeps its rep seat and its target. Pre-image in au.bak_20261101_pedia_sharkia_line_area_map.';
  v_touched   int;
begin
  if exists (
    select 1 from au.line_area_map
     where line_code = 'pedia' and area_code = 'D24' and operational_region_code = 'SH'
       and effective_from = v_move_date and effective_to is null
  ) then
    raise notice 'Pedia Sharkia move already applied. Nothing to do.';
    return;
  end if;

  -- The org chart must still be the shape this file was written against.
  if (select count(*) from au.line_area_map
       where line_code = 'pedia' and area_code in ('D24','D25')
         and operational_region_code = 'D2' and dm_seat_id = 'SEAT-PED-DM-D2'
         and area_state = 'vacant_will_hire' and effective_to is null) <> 2 then
    raise exception 'Pedia Sharkia move: expected 2 open vacant Delta (2) rows for Sharkia 1 and 2. Refusing to guess.';
  end if;
  if (select count(*) from au.occupancy_history
       where seat_id = 'SEAT-PED-RSM' and occupant_hr_id = v_hany and effective_to is null) <> 1 then
    raise exception 'Pedia Sharkia move: Hany Saad no longer holds the Pedia regional seat. Refusing to guess.';
  end if;
  if exists (select 1 from au.occupancy_history
              where seat_id in ('SEAT-PED-REP-D24','SEAT-PED-REP-D25')
                and effective_to is null and occupant_hr_id is not null) then
    raise exception 'Pedia Sharkia move: a Sharkia rep seat has been filled since this file was written.';
  end if;

  -- Pre-image, before anything is touched.
  create table if not exists au.bak_20261101_pedia_sharkia_line_area_map as
    select * from au.line_area_map where line_code = 'pedia' and area_code in ('D24','D25');
  alter table au.bak_20261101_pedia_sharkia_line_area_map enable row level security;
  revoke all on au.bak_20261101_pedia_sharkia_line_area_map from anon, authenticated;

  -- The region, in both name masters. The organogram-only codes UE-1 and UE-2 are in both too.
  insert into au.regions (region_code, region_name, is_other, is_active)
  values ('SH', 'Sharkia', false, true)
  on conflict (region_code) do nothing;

  insert into public.source_of_sales_regions
    (region_code, region_name, normalized_region_name, description, active, source_file, source_sheet)
  values
    ('SH', 'Sharkia', 'sharkia', 'Operational territory opened 2026-10-01 for Pedia; mirrors au_v_regions.',
     true, 'organogram/au_v_regions', 'au_v_regions')
  on conflict (region_code) do nothing;

  -- The seat.
  insert into au.seats
    (seat_id, seat_tier, line_code, region_code, area_code, parent_seat_id, seat_label,
     is_active, effective_from, sales_only)
  values
    (v_seat, 'DM', 'pedia', 'SH', null, 'SEAT-PED-RSM', 'PEDIA Sharkia (counted to the Regional Sales Manager)',
     false, v_move_date, true)
  on conflict (seat_id) do nothing;

  insert into au.occupancy_history
    (seat_id, occupant_hr_id, node_type, effective_from, event_type, line_code, region_code,
     manager_seat_id, manager_hr_id, change_reason, source_system)
  values
    (v_seat, v_hany, 'person', v_move_date, 'transfer_in', 'pedia', 'SH',
     'SEAT-PED-RSM', v_hany, v_note, 'org_move_pedia_sharkia_20261001');

  -- Close the two open rows on the day the new ones start.
  update au.line_area_map
     set effective_to = v_move_date,
         notes = 'token=SHARKIA-PED-D2. Sat in Delta (2) until 2026-10-01. ' || v_note
   where line_code = 'pedia' and area_code in ('D24','D25')
     and operational_region_code = 'D2' and effective_to is null;
  get diagnostics v_touched = row_count;
  if v_touched <> 2 then
    raise exception 'Pedia Sharkia move: expected to close 2 rows, closed %.', v_touched;
  end if;

  insert into au.line_area_map
    (line_code, area_code, operational_region_code, area_state, dm_seat_id, rep_seat_id,
     other_type, staffed_in_line_code, effective_from, effective_to, notes)
  values
    ('pedia', 'D24', 'SH', 'vacant_will_hire', v_seat, 'SEAT-PED-REP-D24', null, null, v_move_date, null,
     'token=SHARKIA-PED-SH. ' || v_note),
    ('pedia', 'D25', 'SH', 'vacant_will_hire', v_seat, 'SEAT-PED-REP-D25', null, null, v_move_date, null,
     'token=SHARKIA-PED-SH. ' || v_note);
  get diagnostics v_touched = row_count;
  if v_touched <> 2 then
    raise exception 'Pedia Sharkia move: expected to insert 2 rows, inserted %.', v_touched;
  end if;

  -- September and everything before it still answer Delta (2), under Sahar's seat.
  if (select count(*) from au.f_line_area_map_asof(date '2026-09-30')
       where line_code = 'pedia' and area_code in ('D24','D25')
         and operational_region_code = 'D2' and dm_seat_id = 'SEAT-PED-DM-D2') <> 2
     or (select count(*) from au.f_line_area_map_asof(date '2026-07-31')
          where line_code = 'pedia' and area_code in ('D24','D25')
            and operational_region_code = 'D2') <> 2
     or (select count(*) from au.f_line_area_map_asof(date '2026-01-31')
          where line_code = 'pedia' and area_code in ('D24','D25')
            and operational_region_code = 'D2') <> 2 then
    raise exception 'Pedia Sharkia move: a month before October no longer resolves to Delta (2). Rolled back.';
  end if;

  -- October onwards is the new district, with the rep seat and the target intact.
  if (select count(*) from au.f_line_area_map_asof(date '2026-10-31')
       where line_code = 'pedia' and area_code in ('D24','D25')
         and operational_region_code = 'SH' and dm_seat_id = v_seat
         and carries_target = true and rep_seat_id is not null) <> 2 then
    raise exception 'Pedia Sharkia move: October does not resolve Sharkia to the new district with its target. Rolled back.';
  end if;

  -- Who it counts to in October, by the function the engine itself calls.
  if au.f_seat_occupant_asof(v_seat, date '2026-10-31') is distinct from v_hany then
    raise exception 'Pedia Sharkia move: the new district does not resolve to Hany Saad. Rolled back.';
  end if;

  -- PEDIA ONLY. Name the area, never count the region.
  if (select count(*) from au.f_line_area_map_asof(date '2026-10-31')
       where line_code <> 'pedia' and operational_region_code = 'SH') <> 0 then
    raise exception 'Pedia Sharkia move: another line moved too. Rolled back.';
  end if;

  -- Sahar keeps the other four areas of her district.
  if (select count(*) from au.f_line_area_map_asof(date '2026-10-31')
       where line_code = 'pedia' and area_code in ('D21','D22','D23','D26')
         and operational_region_code = 'D2' and dm_seat_id = 'SEAT-PED-DM-D2') <> 4 then
    raise exception 'Pedia Sharkia move: Delta (2) lost an area it keeps. Rolled back.';
  end if;

  -- The tree every other reader uses must not show the new seat.
  if exists (select 1 from au.v_org_tree where seat_id = v_seat) then
    raise exception 'Pedia Sharkia move: the sales-only seat is visible on the org tree. Rolled back.';
  end if;

  raise notice 'Pedia Sharkia 1 and 2 count to Hany Saad from %; July to September stay on Delta (2).', v_move_date;
end
$do$;
