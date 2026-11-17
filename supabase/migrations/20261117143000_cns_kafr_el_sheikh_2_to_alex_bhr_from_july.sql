-- CNS: Kafr El-Sheikh 2 counts to Saad Mohamed Saad Salama's Alex-BHR district from 2026-07-01,
-- under no rep -- exactly as Anti Infective's Kafr El-Sheikh 2 counts to Dina Fadel.
--
-- Owner ruling 2026-11-17: "KAFR EL SHEIKH 2 IN CNS LINE SHOULD BE COUNTED TO SAAD TOTAL UNDER NO
-- REP EXACTLY AS DINA IN ANTI INFECTIVE", with July 2026 chosen as the start, like Dina's.
--
-- WHAT MOVES. D17 joins operational region AB under SEAT-CNS-DM-AB with rep_seat_id NULL and
-- area_state other_line_specific, so carries_target still generates FALSE: no rep is credited and no
-- target is added. Kafr El-Sheikh is one city with two areas in the split map (D16 + D17), so every
-- wholesaler there still divides 50/50; Kafr El-Sheikh 1 (D16) keeps its rep seat SEAT-CNS-REP-D16
-- and its own half, and the second half now reaches his district instead of Others.
--
-- WHY THE OTHERS ROW'S START GOES BACK TO 2026-01-01, WHICH IS NOT COSMETIC. au.f_line_area_map_asof
-- prefers the row whose interval contains the date and otherwise FALLS BACK to the row with the
-- smallest effective_from. The Others row begins 2026-07-13 (the map's own floor), so once the
-- Alex-BHR row starts 2026-07-01 it would become the earliest row for this area -- and January to
-- June 2026 would fall back to IT and count to him too. Dating the Others row from 2026-01-01 keeps
-- those months, and everything before them, in Others.
--
-- THE PUBLISHED MONTHS. CNS July-October 2026 are published, and au.f_refresh_monthly_attribution
-- refuses to rebuild a published period, so their stored closing rollups stay exactly as published.
-- The live boards that resolve the organogram as of each month read the new shape.
--
-- CNS ONLY: Anti Infective's D17 stays in Delta (1) and Pedia's stays in Others (El Qema's divisor).
--
-- Idempotent: re-running after it has taken effect is a no-op.
do $do$
declare
  v_move_date   constant date := date '2026-07-01';
  v_others_from constant date := date '2026-01-01';
  v_already     int;
  v_ot          int;
  v_touched     int;
begin
  select count(*) into v_already
    from au.line_area_map
   where line_code = 'cns'
     and area_code = 'D17'
     and operational_region_code = 'AB'
     and effective_from = v_move_date
     and effective_to is null;

  if v_already = 1 then
    raise notice 'CNS Kafr El-Sheikh 2 already counts to Alex-BHR from %. Nothing to do.', v_move_date;
    return;
  end if;

  -- The row this file replaces must be exactly the one it was written against.
  select count(*) into v_ot
    from au.line_area_map
   where line_code = 'cns'
     and area_code = 'D17'
     and operational_region_code = 'OT'
     and dm_seat_id = 'SEAT-CNS-OTHERS'
     and rep_seat_id is null
     and area_state = 'other_line_specific'
     and effective_from = date '2026-07-13'
     and effective_to is null;

  if v_ot <> 1 or (select count(*) from au.line_area_map where line_code = 'cns' and area_code = 'D17') <> 1 then
    raise exception 'CNS Kafr El-Sheikh 2: expected exactly 1 row, open on Others from 2026-07-13; found % matching. Refusing to guess - inspect au.line_area_map by hand.', v_ot;
  end if;

  -- Pre-image, before anything is touched.
  create table if not exists au.bak_20261117_cns_kfs2_line_area_map as
    select * from au.line_area_map where line_code = 'cns';
  alter table au.bak_20261117_cns_kfs2_line_area_map enable row level security;
  revoke all on au.bak_20261117_cns_kfs2_line_area_map from anon, authenticated;

  -- Others: from the start of the sales history to the day his district takes it over.
  update au.line_area_map
     set effective_from = v_others_from,
         effective_to = v_move_date,
         notes = 'token=KFS2-CNS-OT-PRE-JULY. Kafr El-Sheikh 2 sat in CNS Others until Saad Mohamed Saad Salama''s Alex-BHR district took it over on 2026-07-01 (owner, 2026-11-17: "KAFR EL SHEIKH 2 IN CNS LINE SHOULD BE COUNTED TO SAAD TOTAL UNDER NO REP EXACTLY AS DINA IN ANTI INFECTIVE", from July). Dated from 2026-01-01 deliberately: au.f_line_area_map_asof falls back to the EARLIEST row, so this row must stay earlier than the Alex-BHR one or January-June 2026 would count to him as well. Pre-image in au.bak_20261117_cns_kfs2_line_area_map.'
   where line_code = 'cns'
     and area_code = 'D17'
     and operational_region_code = 'OT'
     and effective_to is null;
  get diagnostics v_touched = row_count;

  if v_touched <> 1 then
    raise exception 'CNS Kafr El-Sheikh 2: expected to close 1 Others row, closed %.', v_touched;
  end if;

  -- Alex-BHR: his from July, no rep seat, no target.
  insert into au.line_area_map (
    line_code, area_code, operational_region_code, dm_seat_id, rep_seat_id,
    area_state, other_type, staffed_in_line_code, effective_from, effective_to, notes
  )
  select line_code, area_code, 'AB', 'SEAT-CNS-DM-AB', null,
         'other_line_specific', other_type, staffed_in_line_code, v_move_date, null,
         'token=KFS2-CNS-AB. Kafr El-Sheikh 2 counts to Saad Mohamed Saad Salama''s Alex-BHR district from 2026-07-01 (owner, 2026-11-17: "KAFR EL SHEIKH 2 IN CNS LINE SHOULD BE COUNTED TO SAAD TOTAL UNDER NO REP EXACTLY AS DINA IN ANTI INFECTIVE", from July like Dina). CNS only - Anti Infective keeps it in Delta (1), Pedia in Others. No rep seat and no target, deliberately: the city split''s half reaches his district and no rep. Published months keep their stored rollups. Pre-image in au.bak_20261117_cns_kfs2_line_area_map.'
    from au.line_area_map
   where line_code = 'cns'
     and area_code = 'D17'
     and operational_region_code = 'OT'
     and effective_to = v_move_date;
  get diagnostics v_touched = row_count;

  if v_touched <> 1 then
    raise exception 'CNS Kafr El-Sheikh 2: expected to insert 1 Alex-BHR row, inserted %.', v_touched;
  end if;

  -- June and every month before it must still answer Others.
  if (select count(*) from au.f_line_area_map_asof(date '2026-06-30')
       where line_code = 'cns' and area_code = 'D17' and operational_region_code = 'OT') <> 1
     or (select count(*) from au.f_line_area_map_asof(date '2026-01-31')
          where line_code = 'cns' and area_code = 'D17' and operational_region_code = 'OT') <> 1
     or (select count(*) from au.f_line_area_map_asof(date '2025-12-31')
          where line_code = 'cns' and area_code = 'D17' and operational_region_code = 'OT') <> 1 then
    raise exception 'CNS Kafr El-Sheikh 2: a month before July 2026 now resolves out of Others - the move leaked backwards. Rolled back.';
  end if;

  -- July onwards is his, with no rep and no target.
  if (select count(*) from au.f_line_area_map_asof(date '2026-07-31')
       where line_code = 'cns' and area_code = 'D17'
         and operational_region_code = 'AB'
         and dm_seat_id = 'SEAT-CNS-DM-AB'
         and rep_seat_id is null
         and carries_target = false) <> 1
     or (select count(*) from au.f_line_area_map_asof(date '2026-10-31')
          where line_code = 'cns' and area_code = 'D17'
            and operational_region_code = 'AB' and rep_seat_id is null and carries_target = false) <> 1
     or (select count(*) from au.f_line_area_map_asof(date '2026-11-30')
          where line_code = 'cns' and area_code = 'D17'
            and operational_region_code = 'AB' and rep_seat_id is null and carries_target = false) <> 1 then
    raise exception 'CNS Kafr El-Sheikh 2: July, October or November does not resolve it to Alex-BHR under SEAT-CNS-DM-AB with no rep and no target. Rolled back.';
  end if;

  -- Kafr El-Sheikh 1 keeps Alex-BHR and its rep seat.
  if (select count(*) from au.f_line_area_map_asof(date '2026-07-31')
       where line_code = 'cns' and area_code = 'D16'
         and operational_region_code = 'AB'
         and rep_seat_id = 'SEAT-CNS-REP-D16') <> 1 then
    raise exception 'CNS Kafr El-Sheikh 2: Kafr El-Sheikh 1 lost its Alex-BHR district or its rep seat. Rolled back.';
  end if;

  -- CNS ONLY. Name the area, never count the region.
  if (select count(*) from au.f_line_area_map_asof(date '2026-10-31')
       where line_code = 'anti_infective' and area_code = 'D17' and operational_region_code = 'D1') <> 1
     or (select count(*) from au.f_line_area_map_asof(date '2026-10-31')
          where line_code = 'pedia' and area_code = 'D17' and operational_region_code = 'OT') <> 1 then
    raise exception 'CNS Kafr El-Sheikh 2: Anti Infective or Pedia moved too - this is CNS only. Rolled back.';
  end if;

  raise notice 'CNS Kafr El-Sheikh 2: Others 2026-01-01 to %, Alex-BHR (SEAT-CNS-DM-AB) from % with no rep seat and no target.', v_move_date, v_move_date;
end
$do$;
