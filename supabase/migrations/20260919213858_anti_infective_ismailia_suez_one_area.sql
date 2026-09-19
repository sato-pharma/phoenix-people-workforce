-- Anti Infective Delta (3): Ismailia (OT9) and Suez (OT2) are ONE area, "Ismailia and Suez".
--
-- WHAT: from 2026-09-01, Ismailia's Delta (3) row stops being a rep-less, target-less
-- `other_permanent` area and shares the Suez rep seat, exactly as Pedia's GZ6 + UE9 rows share
-- SEAT-PED-REP-GZ6. The rep seat is relabelled "AIF Ismailia and Suez rep".
--
-- WHY: owner, 2026-09-19 — "Ismailia and Suez, one area ... not separate areas ... considered one
-- area in line Anti Infective, Delta (3)". Delta (3) was opened with one rep for both governorates
-- (20260828064500) but only Suez (OT2) carried the seat and the target; Ismailia (OT9, the larger of
-- the two — about 1,900 units in August against Suez's 1,000) sat beside it crediting nobody.
--
-- WHAT THIS DOES NOT DO — and why: it does not merge the two SALES areas. OT2 and OT9 stay two
-- codes on every sales row, brick, customer and target (same as GZ6 / UE9), so no published month
-- moves. The one-row presentation is the dated rule in src/lib/sales/closing-area-merges.ts
-- (anti_infective, fromPeriod 2026-09). July and August still show Suez and Ismailia in Others.
--
-- DATE IS THE MECHANISM: only the OPEN Delta (3) row (effective_from 2026-09-01) is touched. The
-- closed pre-split rows in Others are not.
--
-- ROLLBACK: restore from the pre-image tables written below —
--   update au.line_area_map m set area_state = b.area_state, rep_seat_id = b.rep_seat_id
--     from au.bak_20260919_ismailia_suez_line_area_map b
--    where m.line_code = b.line_code and m.area_code = b.area_code and m.effective_from = b.effective_from;
--   update au.seats s set seat_label = b.seat_label from au.bak_20260919_ismailia_suez_seats b
--    where s.seat_id = b.seat_id;
-- then au.f_refresh_monthly_attribution('2026-09').
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This change is small (one line_area_map row, one seat label) and fully reversible from the
-- pre-image, so it is not destructive or bulk.

begin;

-- ── 0. Pre-image (au schema, like bak_20260828_d3_* and bak_20260909_pedia_ue_split_*) ──────────
create table if not exists au.bak_20260919_ismailia_suez_line_area_map as
  select * from au.line_area_map
   where line_code = 'anti_infective' and area_code in ('OT2', 'OT9');

create table if not exists au.bak_20260919_ismailia_suez_seats as
  select * from au.seats where seat_id = 'SEAT-AIF-REP-OT2';

-- ── 1. Guard: the shape this migration was written against ────────────────────────────────────
do $guard$
declare
  v_ot2 record;
  v_ot9 record;
begin
  select * into v_ot2 from au.line_area_map
   where line_code = 'anti_infective' and area_code = 'OT2' and effective_to is null;
  select * into v_ot9 from au.line_area_map
   where line_code = 'anti_infective' and area_code = 'OT9' and effective_to is null;

  if v_ot2.operational_region_code is distinct from 'D3'
     or v_ot2.rep_seat_id is distinct from 'SEAT-AIF-REP-OT2'
     or v_ot2.effective_from is distinct from date '2026-09-01' then
    raise exception 'Ismailia+Suez: expected OT2 open on D3 with SEAT-AIF-REP-OT2 from 2026-09-01, found % / % / %',
      v_ot2.operational_region_code, v_ot2.rep_seat_id, v_ot2.effective_from;
  end if;

  if v_ot9.operational_region_code is distinct from 'D3'
     or v_ot9.effective_from is distinct from date '2026-09-01' then
    raise exception 'Ismailia+Suez: expected OT9 open on D3 from 2026-09-01, found % / %',
      v_ot9.operational_region_code, v_ot9.effective_from;
  end if;
end
$guard$;

-- ── 2. Ismailia shares the Suez rep seat and state (idempotent) ───────────────────────────────
-- area_state follows the seat, as sync_area_state_for_seat expects: it flips every OPEN row that
-- shares rep_seat_id, so a hire into SEAT-AIF-REP-OT2 turns BOTH areas occupied together.
-- carries_target is generated from area_state, so OT9 now carries a target row like OT2; the target
-- grids fold the two into one line (closing-area-merges.ts).
update au.line_area_map o9
   set rep_seat_id = o2.rep_seat_id,
       area_state  = o2.area_state
  from au.line_area_map o2
 where o9.line_code = 'anti_infective' and o9.area_code = 'OT9' and o9.effective_to is null
   and o2.line_code = 'anti_infective' and o2.area_code = 'OT2' and o2.effective_to is null
   and (o9.rep_seat_id is distinct from o2.rep_seat_id or o9.area_state is distinct from o2.area_state);

-- ── 3. The seat's name says what the owner calls it ───────────────────────────────────────────
update au.seats
   set seat_label = 'AIF Ismailia and Suez rep'
 where seat_id = 'SEAT-AIF-REP-OT2'
   and seat_label is distinct from 'AIF Ismailia and Suez rep';

-- ── 4. Prove it, and prove August did not move ────────────────────────────────────────────────
do $verify$
begin
  if (select count(*) from au.line_area_map
       where line_code = 'anti_infective' and area_code in ('OT2', 'OT9') and effective_to is null
         and rep_seat_id = 'SEAT-AIF-REP-OT2' and operational_region_code = 'D3') <> 2 then
    raise exception 'Ismailia+Suez: both open Delta (3) rows must share SEAT-AIF-REP-OT2.';
  end if;

  if exists (
    select 1 from au.f_line_area_map_asof(date '2026-08-31')
     where line_code = 'anti_infective' and area_code in ('OT2', 'OT9')
       and (operational_region_code <> 'OT' or rep_seat_id is not null)
  ) then
    raise exception 'Ismailia+Suez: August resolves to Delta (3) or a rep seat - the change leaked backwards. Rolled back.';
  end if;
end
$verify$;

commit;
