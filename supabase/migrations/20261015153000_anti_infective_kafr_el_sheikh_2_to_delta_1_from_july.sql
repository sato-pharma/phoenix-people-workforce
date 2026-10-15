-- Anti Infective: Kafr El-Sheikh 2's move into Dina Fadel's Delta (1) district is re-dated from
-- 2026-10-01 back to 2026-07-01.
--
-- Owner ruling 2026-10-15, after reading the October shape: "i want this change to be starting from
-- july 2026 counted to her". It re-dates the boundary 20261015145000 wrote; the ruling itself --
-- Kafr El-Sheikh 2 counts to the manager, never to the rep -- is unchanged, and so is every other
-- part of that migration (the 50/50 city split, no rep seat, no target, Anti Infective only).
--
-- WHAT MOVES, AND WHAT DOES NOT. Only the date. D17 still joins operational region D1 under
-- SEAT-AIF-DM-D1 with rep_seat_id NULL and area_state other_line_specific, so carries_target still
-- generates FALSE. Ragaa Mosaad keeps Kafr El-Sheikh 1 and its own half of every city split; no rep
-- is credited with D17's half in any month.
--
-- WHY THE OTHERS ROW'S START GOES BACK TO 2026-01-01, WHICH IS NOT COSMETIC. au.f_line_area_map_asof
-- prefers the row whose interval contains the date and otherwise FALLS BACK to the row with the
-- smallest effective_from. The Others row begins 2026-07-13 (the map's own floor), so once the
-- Delta (1) row starts 2026-07-01 it becomes the earliest row for this area -- and January to June
-- 2026, which match no interval at all, would fall back to IT and silently count to her too. Those
-- six months carry real Anti Infective sales in D17 (EGP 788.30, 1,758.70, 1,505.65, 1,788.65,
-- 1,667.25, 1,031.10) and they carry NO publication row, so the nightly stale-attribution sweep
-- would restate every one of them. Dating the Others row from 2026-01-01 keeps it the earliest row
-- and keeps those months, and anything before them, exactly where they are: Others.
--
-- WHAT THIS DOES *NOT* DO BY ITSELF -- the published months. July, August and September 2026 are
-- published on Anti Infective (2026-08-08, 2026-09-07, 2026-10-05, all by B-10) and
-- au.f_refresh_monthly_attribution refuses to rebuild a published period -- "leaving its attribution
-- rollup frozen". So this migration changes how those three months RESOLVE but moves no figure in
-- them. Their stored rollups keep Kafr El-Sheikh 2 in Others (EGP 2,729.10 / 3,630.15 / 27,261.38)
-- until the owner unlocks and unpublishes each month on the Monthly Closing screen himself, which
-- is his decision and his click, not this file's and not a session's.
--
-- ANTI INFECTIVE ONLY, unchanged: pulling D17 out of Others on Pedia would take El Qema's divisor
-- from 39 to 40 and move every El Qema number. CNS and Pedia keep it in Others in every month.
--
-- Idempotent: re-running after it has taken effect is a no-op.
do $do$
declare
  v_move_date   constant date := date '2026-07-01';
  v_old_date    constant date := date '2026-10-01';
  v_others_from constant date := date '2026-01-01';
  v_already     int;
  v_d1          int;
  v_ot          int;
  v_touched     int;
begin
  select count(*) into v_already
    from au.line_area_map
   where line_code = 'anti_infective'
     and area_code = 'D17'
     and operational_region_code = 'D1'
     and effective_from = v_move_date
     and effective_to is null;

  if v_already = 1 then
    raise notice 'Kafr El-Sheikh 2 July re-dating already applied - the Delta (1) row runs from %. Nothing to do.', v_move_date;
    return;
  end if;

  -- The two rows 20261015145000 left behind must both be present and on the shape it wrote, or the
  -- org chart has moved under this file since it was written.
  select count(*) into v_d1
    from au.line_area_map
   where line_code = 'anti_infective'
     and area_code = 'D17'
     and operational_region_code = 'D1'
     and dm_seat_id = 'SEAT-AIF-DM-D1'
     and rep_seat_id is null
     and effective_from = v_old_date
     and effective_to is null;

  select count(*) into v_ot
    from au.line_area_map
   where line_code = 'anti_infective'
     and area_code = 'D17'
     and operational_region_code = 'OT'
     and dm_seat_id = 'SEAT-AIF-OTHERS'
     and effective_to = v_old_date;

  if v_d1 <> 1 or v_ot <> 1 then
    raise exception 'Kafr El-Sheikh 2 July re-dating: expected 1 open Delta (1) row from % and 1 Others row closed at %, found % and %. Refusing to guess - inspect au.line_area_map by hand.', v_old_date, v_old_date, v_d1, v_ot;
  end if;

  -- Pre-image, before anything is touched. Its own table, so 20261015145000's survives untouched.
  create table if not exists au.bak_20261015b_aif_kfs2_july_line_area_map as
    select * from au.line_area_map where line_code = 'anti_infective';
  alter table au.bak_20261015b_aif_kfs2_july_line_area_map enable row level security;
  revoke all on au.bak_20261015b_aif_kfs2_july_line_area_map from anon, authenticated;

  -- Others: from the start of the sales history to the day she takes it over.
  update au.line_area_map
     set effective_from = v_others_from,
         effective_to = v_move_date,
         notes = 'token=KFS2-AIF-OT-PRE-JULY. Kafr El-Sheikh 2 sat in Anti Infective Others until Dina Fadel took it over on 2026-07-01 (owner, 2026-10-15: "i want this change to be starting from july 2026 counted to her"). Dated from 2026-01-01 deliberately: au.f_line_area_map_asof falls back to the EARLIEST row, so this row must stay earlier than the Delta (1) one or January-June 2026 would count to her as well. Pre-image in au.bak_20261015b_aif_kfs2_july_line_area_map.'
   where line_code = 'anti_infective'
     and area_code = 'D17'
     and operational_region_code = 'OT'
     and effective_to = v_old_date;
  get diagnostics v_touched = row_count;

  if v_touched <> 1 then
    raise exception 'Kafr El-Sheikh 2 July re-dating: expected to re-date 1 Others row, re-dated %.', v_touched;
  end if;

  -- Delta (1): hers from July instead of from October.
  update au.line_area_map
     set effective_from = v_move_date,
         notes = 'token=KFS2-AIF-D1. Kafr El-Sheikh 2 counts to Dina Fadel''s Delta (1) district from 2026-07-01 (owner, 2026-10-15: "doinot count kafr el sheikh 2 store splitting to ragaa the rep count it to din a fadel the manager only", re-dated from October the same day: "i want this change to be starting from july 2026 counted to her"). Anti Infective only - CNS and Pedia keep it in Others. No rep seat and no target, deliberately: the city split''s half reaches her district and no rep. The published July, August and September rollups stay frozen until he unpublishes each month himself. Pre-image in au.bak_20261015b_aif_kfs2_july_line_area_map.'
   where line_code = 'anti_infective'
     and area_code = 'D17'
     and operational_region_code = 'D1'
     and effective_from = v_old_date;
  get diagnostics v_touched = row_count;

  if v_touched <> 1 then
    raise exception 'Kafr El-Sheikh 2 July re-dating: expected to re-date 1 Delta (1) row, re-dated %.', v_touched;
  end if;

  -- June must still answer Others, and so must every month before it. This is the half of the
  -- change that is easy to get wrong and expensive: it reaches six unpublished months.
  if (select count(*) from au.f_line_area_map_asof(date '2026-06-30')
       where line_code = 'anti_infective' and area_code = 'D17'
         and operational_region_code = 'OT') <> 1
     or (select count(*) from au.f_line_area_map_asof(date '2026-01-31')
          where line_code = 'anti_infective' and area_code = 'D17'
            and operational_region_code = 'OT') <> 1
     or (select count(*) from au.f_line_area_map_asof(date '2025-12-31')
          where line_code = 'anti_infective' and area_code = 'D17'
            and operational_region_code = 'OT') <> 1 then
    raise exception 'Kafr El-Sheikh 2 July re-dating: a month before July 2026 now resolves out of Others - the re-dating leaked backwards. Rolled back.';
  end if;

  -- July onwards is hers, with no rep and no target, in every month from the boundary on.
  if (select count(*) from au.f_line_area_map_asof(date '2026-07-31')
       where line_code = 'anti_infective' and area_code = 'D17'
         and operational_region_code = 'D1'
         and dm_seat_id = 'SEAT-AIF-DM-D1'
         and rep_seat_id is null
         and carries_target = false) <> 1
     or (select count(*) from au.f_line_area_map_asof(date '2026-09-30')
          where line_code = 'anti_infective' and area_code = 'D17'
            and operational_region_code = 'D1') <> 1
     or (select count(*) from au.f_line_area_map_asof(date '2026-10-31')
          where line_code = 'anti_infective' and area_code = 'D17'
            and operational_region_code = 'D1') <> 1 then
    raise exception 'Kafr El-Sheikh 2 July re-dating: July, September or October does not resolve Kafr El-Sheikh 2 to Delta (1) under SEAT-AIF-DM-D1 with no rep and no target. Rolled back.';
  end if;

  -- Ragaa's own area is untouched: Kafr El-Sheikh 1 keeps Delta (1) and its rep seat, in July too.
  if (select count(*) from au.f_line_area_map_asof(date '2026-07-31')
       where line_code = 'anti_infective' and area_code = 'D16'
         and operational_region_code = 'D1'
         and rep_seat_id = 'SEAT-AIF-REP-D16') <> 1 then
    raise exception 'Kafr El-Sheikh 2 July re-dating: Kafr El-Sheikh 1 lost its Delta (1) district or its rep seat. Rolled back.';
  end if;

  -- ANTI INFECTIVE ONLY. Name the area, never count the region - au.f_line_area_map_asof has no
  -- where clause and reports a retired area in its last region for ever.
  if (select count(*) from au.f_line_area_map_asof(date '2026-07-31')
       where line_code = 'pedia' and area_code = 'D17' and operational_region_code = 'OT') <> 1
     or (select count(*) from au.f_line_area_map_asof(date '2026-07-31')
          where line_code = 'cns' and area_code = 'D17' and operational_region_code = 'OT') <> 1
     or (select count(*) from au.f_line_area_map_asof(date '2026-10-31')
          where line_code = 'pedia' and area_code = 'D17' and operational_region_code = 'OT') <> 1
     or (select count(*) from au.f_line_area_map_asof(date '2026-10-31')
          where line_code = 'cns' and area_code = 'D17' and operational_region_code = 'OT') <> 1 then
    raise exception 'Kafr El-Sheikh 2 July re-dating: Pedia or CNS moved too - this is Anti Infective only, and Pedia carries El Qema. Rolled back.';
  end if;

  raise notice 'Kafr El-Sheikh 2 re-dated: Others 2026-01-01 to %, Dina Fadel''s Delta (1) from % with no rep seat and no target. June and every month before it keep it in Others; July onwards counts to her once each published month is unpublished by the owner.', v_move_date, v_move_date;
end
$do$;
