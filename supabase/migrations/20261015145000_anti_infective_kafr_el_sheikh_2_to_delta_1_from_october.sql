-- Anti Infective: Kafr El-Sheikh 2 joins Dina Fadel's Delta (1) district, effective 2026-10-01.
--
-- Owner ruling 2026-10-15, in his words: "doinot count kafr el sheikh 2 store splitting to ragaa
-- the rep count it to din a fadel the manager only".
--
-- WHAT HE IS CORRECTING. Kafr El-Sheikh is ONE city with two areas in the store-split map, so every
-- wholesaler there divides 50/50 between Kafr El-Sheikh 1 (D16) and Kafr El-Sheikh 2 (D17). D16 is
-- Dina Fadel's -- she holds SEAT-AIF-DM-D1 and her rep there is Ragaa Mosaad (B-107, SEAT-AIF-REP-D16).
-- D17 sat in the line's Others bucket under the SEAT-AIF-OTHERS pseudo-DM, so half of her own city's
-- wholesaler money reached no manager at all. #5926 answered that by refusing D17 a share, which put
-- the WHOLE city on D16 -- and therefore all of it on Ragaa's rep number. That is the opposite of
-- this ruling and is reverted in the same pull request as this migration.
--
-- WHAT THIS DOES INSTEAD. The 50/50 split stays exactly as it was; only the district reading D17's
-- half changes. D17 moves to operational region D1 under SEAT-AIF-DM-D1, keeps rep_seat_id NULL and
-- stays other_line_specific, so:
--
--   * Dina Fadel's district total carries both halves -- "count it to Dina Fadel the manager".
--   * No rep is credited with D17's half, because the area has no rep seat -- "not to Ragaa the rep".
--   * Ragaa keeps D16's own half and nothing more. His number does not move at all.
--
-- This is the Luxor shape, not a new kind of row: au.line_area_map already holds OT6 on
-- operational_region_code 'UE-2' under SEAT-PED-DM-UE-2 with no rep seat and no target (owner,
-- 2026-09-09). An area can sit in a real district, carry sales and carry no target.
--
-- carries_target is a STORED GENERATED column -- area_state in ('occupied','vacant_will_hire') -- so
-- it is never inserted and stays FALSE here. He was asked whether the money should count inside her
-- achievement percentage and chose that it should: the sales join her district total while no target
-- joins the divisor, so her percentage rises. That is how every Others area behaves once it joins a
-- real district, and it is his decision, not a side effect.
--
-- HE WAS ALSO ASKED what travels with the split share, because the area map is the only thing that
-- can reach a manager: moving the area brings مخزن كابيتال's own sales in D17 (EGP 277.88 in
-- September terms) to her as well, not just the split's half. He chose to move the area.
--
-- WHY A DATED PAIR AND NOT AN IN-PLACE UPDATE. Achievement and the Monthly Closing resolve region
-- through au.f_line_area_map_asof at the END of the month being closed, never on the day it is run.
-- July, August and September 2026 are PUBLISHED on all three lines, and a published month is never
-- changed (owner, 2026-10-09). Closing the open row at 2026-10-01 (effective_to is EXCLUSIVE) and
-- opening the new one on the same date is what makes those three months unreachable by this change,
-- whenever they are next recomputed. Same mechanism as
-- 20260912103000_pedia_kafr_el_sheikh_to_delta_1_from_september.sql, which this mirrors.
--
-- ANTI INFECTIVE ONLY. CNS and Pedia keep Kafr El-Sheikh 2 in Others, deliberately -- a
-- half-migrated state across lines is the normal shape here (AGENTS.md section 4). It also matters
-- for money: El Qema's divisor is every PEDIA area the organogram does not park in Others, so
-- pulling D17 out on Pedia would take it from 39 to 40 and move every El Qema number. On Anti
-- Infective nothing is divided by the Others set -- OTHERS_EXCLUDED_LINES holds pedia alone -- so
-- this move shifts no split, only the district that reads one.
--
-- NO SEAT ROW CHANGES. D17 has no seat of its own on any line; its DM came from the map's
-- dm_seat_id, which is dated. So unlike the Pedia move there is nothing in au.seats to re-point.
--
-- Idempotent: re-running after it has taken effect is a no-op, not a second move.
do $do$
declare
  v_move_date constant date := date '2026-10-01';
  v_existing  int;
  v_open      int;
  v_closed    int;
  v_inserted  int;
begin
  select count(*) into v_existing
    from au.line_area_map
   where line_code = 'anti_infective'
     and area_code = 'D17'
     and operational_region_code = 'D1'
     and effective_from = v_move_date;

  if v_existing = 1 then
    raise notice 'Kafr El-Sheikh 2 move already applied - the Delta (1) row is present from %. Nothing to do.', v_move_date;
    return;
  elsif v_existing <> 0 then
    raise exception 'Kafr El-Sheikh 2 move: % Delta (1) rows exist from % where 1 was expected. Refusing to guess - inspect au.line_area_map by hand.', v_existing, v_move_date;
  end if;

  -- The pre-move row must be open and on exactly the bucket we expect it to be leaving. Anything
  -- else means the org chart moved under us since this migration was written.
  select count(*) into v_open
    from au.line_area_map
   where line_code = 'anti_infective'
     and effective_to is null
     and area_code = 'D17'
     and operational_region_code = 'OT'
     and dm_seat_id = 'SEAT-AIF-OTHERS';

  if v_open <> 1 then
    raise exception 'Kafr El-Sheikh 2 move: expected 1 open pre-move row (D17 on OT under SEAT-AIF-OTHERS, anti_infective), found %. Refusing to apply.', v_open;
  end if;

  -- Pre-image, before anything is touched.
  create table if not exists au.bak_20261015_aif_kfs2_d1_line_area_map as
    select * from au.line_area_map where line_code = 'anti_infective';
  alter table au.bak_20261015_aif_kfs2_d1_line_area_map enable row level security;
  revoke all on au.bak_20261015_aif_kfs2_d1_line_area_map from anon, authenticated;

  -- Close the Others row.
  update au.line_area_map
     set effective_to = v_move_date
   where line_code = 'anti_infective'
     and area_code = 'D17'
     and effective_to is null;
  get diagnostics v_closed = row_count;

  if v_closed <> 1 then
    raise exception 'Kafr El-Sheikh 2 move: expected to close 1 row, closed %.', v_closed;
  end if;

  -- Open the Delta (1) row. rep_seat_id stays NULL - that is what keeps Ragaa out of it - and
  -- area_state stays other_line_specific, so carries_target generates FALSE.
  insert into au.line_area_map
    (line_code, area_code, operational_region_code, area_state, dm_seat_id, rep_seat_id,
     other_type, staffed_in_line_code, effective_from, effective_to, notes)
  values
    ('anti_infective','D17','D1','other_line_specific','SEAT-AIF-DM-D1',NULL,
     'line_specific',NULL, v_move_date, NULL,
     'token=KFS2-AIF-D1. Kafr El-Sheikh 2 joins Dina Fadel''s Delta (1) district, owner ruling 2026-10-15: "doinot count kafr el sheikh 2 store splitting to ragaa the rep count it to din a fadel the manager only". Anti Infective only - CNS and Pedia keep it in Others. No rep seat and no target, deliberately: the store split''s half reaches her district and no rep. Pre-image in au.bak_20261015_aif_kfs2_d1_line_area_map.');
  get diagnostics v_inserted = row_count;

  if v_inserted <> 1 then
    raise exception 'Kafr El-Sheikh 2 move: expected to insert 1 row, inserted %.', v_inserted;
  end if;

  -- September must still resolve to Others, October to Delta (1). This is the whole point of the
  -- change, so it is asserted here rather than left to a later eyeball.
  if (select count(*) from au.f_line_area_map_asof(date '2026-09-30')
       where line_code = 'anti_infective' and area_code = 'D17'
         and operational_region_code = 'OT') <> 1 then
    raise exception 'Kafr El-Sheikh 2 move: September 2026 no longer resolves Kafr El-Sheikh 2 to Others - the move leaked backwards into a PUBLISHED month. Rolled back.';
  end if;

  if (select count(*) from au.f_line_area_map_asof(date '2026-10-31')
       where line_code = 'anti_infective' and area_code = 'D17'
         and operational_region_code = 'D1'
         and dm_seat_id = 'SEAT-AIF-DM-D1'
         and rep_seat_id is null
         and carries_target = false) <> 1 then
    raise exception 'Kafr El-Sheikh 2 move: October 2026 does not resolve Kafr El-Sheikh 2 to Delta (1) under SEAT-AIF-DM-D1 with no rep and no target. Rolled back.';
  end if;

  -- Ragaa's own area is untouched: D16 keeps Delta (1) AND its rep seat, in both months.
  if (select count(*) from au.f_line_area_map_asof(date '2026-10-31')
       where line_code = 'anti_infective' and area_code = 'D16'
         and operational_region_code = 'D1'
         and rep_seat_id = 'SEAT-AIF-REP-D16') <> 1 then
    raise exception 'Kafr El-Sheikh 2 move: Kafr El-Sheikh 1 lost its Delta (1) district or its rep seat. Rolled back.';
  end if;

  -- ANTI INFECTIVE ONLY. NAME THE AREA, NEVER COUNT THE REGION - au.f_line_area_map_asof has no
  -- where clause and reports a retired area in its last region forever, so counting Others would
  -- pin that quirk instead of the rule. Pulling D17 out of Others on Pedia would take El Qema's
  -- divisor from 39 to 40.
  if (select count(*) from au.f_line_area_map_asof(date '2026-10-31')
       where line_code = 'pedia' and area_code = 'D17' and operational_region_code = 'OT') <> 1
     or (select count(*) from au.f_line_area_map_asof(date '2026-10-31')
          where line_code = 'cns' and area_code = 'D17' and operational_region_code = 'OT') <> 1 then
    raise exception 'Kafr El-Sheikh 2 move: Pedia or CNS moved too - this is Anti Infective only, and Pedia carries El Qema. Rolled back.';
  end if;

  raise notice 'Kafr El-Sheikh 2 move applied: 1 row closed at %, 1 Delta (1) row opened under SEAT-AIF-DM-D1 with no rep seat. September keeps it in Others, October counts it to Dina Fadel; Ragaa keeps only Kafr El-Sheikh 1; CNS and Pedia untouched.', v_move_date;
end
$do$;
