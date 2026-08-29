-- Anti Infective: five areas move to the new Delta (3) district, effective 2026-09-01.
--
-- Owner-approved 2026-08-28, in his words: the August closing is not distributed on the new
-- structure - "starting from September, everything will be changed and divided".
--
-- HISTORY OF THIS CHANGE, because it has been applied and rolled back once already:
--   2026-08-28  Applied by hand, directly against production. No migration file, no ledger row -
--               so it existed in the database and nowhere in version control.
--   2026-08-29  Rolled back by hand, after an audit found the Monthly Closing could not see the
--               dated pair at all (au_v_line_area_map filters `effective_to is null`, so the
--               closed row is hidden and the future row has not started) and would therefore have
--               filed all five areas under their GEOGRAPHIC region for August. The pre-image was
--               kept in delta3_defer_backup_20260829.line_area_map_pre.
--   2026-08-29  #2608 taught the closing to resolve at the month being closed rather than the day
--               it is run, and 20260829113000 exposes the history it needs to do that. With both
--               in place the pair resolves correctly in BOTH directions, so the move is safe to
--               stand from now until September and needs nobody to remember it on the 1st.
--
-- WHY A PAIR AND NOT AN IN-PLACE UPDATE. Achievement resolves region through
-- au.f_line_area_map_asof(period_end), which is period-aware. Overwriting the open rows would
-- retroactively re-file July's and August's achievement under D3 as well. The pair keeps every
-- closed month on the structure that was actually in force for it.
--
-- carries_target is a STORED GENERATED column (area_state in ('occupied','vacant_will_hire')), so
-- it is never inserted - setting area_state is what turns targets on for D11/D24/D25/OT2, which
-- the owner approved on 2026-08-28. OT9 stays other_permanent and carries no target.
--
-- rep_seat_id is set on the four areas that will be staffed so au.sync_area_state_for_seat can
-- flip the area to occupied when a rep is actually hired - it matches on rep_seat_id, so leaving
-- it null would strand the area in vacant_will_hire forever.
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
   where line_code = 'anti_infective'
     and area_code in ('D11','D24','D25','OT2','OT9')
     and operational_region_code = 'D3'
     and effective_from = v_move_date;

  if v_existing = 5 then
    raise notice 'Delta (3) move already applied - 5 D3 rows present from %. Nothing to do.', v_move_date;
    return;
  elsif v_existing <> 0 then
    raise exception 'Delta (3) move is HALF applied: % of 5 D3 rows exist from %. Refusing to guess - inspect au.line_area_map by hand.', v_existing, v_move_date;
  end if;

  -- The five pre-split rows must be open and on exactly the regions we expect to be leaving.
  -- Anything else means the org chart moved under us since this migration was written.
  select count(*) into v_open
    from au.line_area_map
   where line_code = 'anti_infective'
     and effective_to is null
     and (area_code, operational_region_code) in
         (('D11','OT'), ('D24','D2'), ('D25','OT'), ('OT2','OT'), ('OT9','OT'));

  if v_open <> 5 then
    raise exception 'Delta (3) move: expected 5 open pre-split rows (D11/OT, D24/D2, D25/OT, OT2/OT, OT9/OT), found %. Refusing to apply.', v_open;
  end if;

  update au.line_area_map
     set effective_to = v_move_date
   where line_code = 'anti_infective'
     and area_code in ('D11','D24','D25','OT2','OT9')
     and effective_to is null;
  get diagnostics v_closed = row_count;

  if v_closed <> 5 then
    raise exception 'Delta (3) move: expected to close 5 rows, closed %.', v_closed;
  end if;

  insert into au.line_area_map
    (line_code, area_code, operational_region_code, area_state, dm_seat_id, rep_seat_id,
     other_type, staffed_in_line_code, effective_from, effective_to, notes)
  values
    ('anti_infective','D11','D3','vacant_will_hire','SEAT-AIF-DM-D3','SEAT-AIF-REP-D11',
     'line_specific','cns, pedia', v_move_date, null,
     'Delta (3) split, owner-approved 2026-08-28; re-applied as a migration 2026-08-29.'),
    ('anti_infective','D24','D3','vacant_will_hire','SEAT-AIF-DM-D3','SEAT-AIF-REP-D24',
     null, null, v_move_date, null,
     'Delta (3) split, owner-approved 2026-08-28; re-applied as a migration 2026-08-29.'),
    ('anti_infective','D25','D3','vacant_will_hire','SEAT-AIF-DM-D3','SEAT-AIF-REP-D25',
     'line_specific','cns, pedia', v_move_date, null,
     'Delta (3) split, owner-approved 2026-08-28; re-applied as a migration 2026-08-29.'),
    ('anti_infective','OT2','D3','vacant_will_hire','SEAT-AIF-DM-D3','SEAT-AIF-REP-OT2',
     'permanent', null, v_move_date, null,
     'Delta (3) split, owner-approved 2026-08-28; re-applied as a migration 2026-08-29.'),
    ('anti_infective','OT9','D3','other_permanent','SEAT-AIF-DM-D3', null,
     'permanent', null, v_move_date, null,
     'Delta (3) split, owner-approved 2026-08-28; re-applied as a migration 2026-08-29. Stays other_permanent, so it carries no target.');
  get diagnostics v_inserted = row_count;

  if v_inserted <> 5 then
    raise exception 'Delta (3) move: expected to insert 5 rows, inserted %.', v_inserted;
  end if;

  -- August must still resolve to the PRE-split structure, and September to D3. This is the whole
  -- point of the change, so it is asserted here rather than left to a later eyeball.
  if exists (
    select 1 from au.f_line_area_map_asof(date '2026-08-31')
     where line_code = 'anti_infective'
       and area_code in ('D11','D24','D25','OT2','OT9')
       and operational_region_code = 'D3'
  ) then
    raise exception 'Delta (3) move: August 2026 resolves to D3 - the move leaked backwards. Rolled back.';
  end if;

  if (select count(*) from au.f_line_area_map_asof(date '2026-09-30')
       where line_code = 'anti_infective'
         and area_code in ('D11','D24','D25','OT2','OT9')
         and operational_region_code = 'D3') <> 5 then
    raise exception 'Delta (3) move: September 2026 does not resolve all five areas to D3. Rolled back.';
  end if;

  raise notice 'Delta (3) move applied: 5 rows closed at %, 5 D3 rows opened. August resolves pre-split, September resolves D3.', v_move_date;
end
$do$;
