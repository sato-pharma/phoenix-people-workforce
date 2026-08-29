-- The org chart's area -> region map INCLUDING superseded rows, so an effective-dated territory
-- move can be resolved at the month being closed rather than only as it stands today.
--
-- WHY THIS EXISTS. au_v_line_area_map filters `where effective_to is null`, so the app only ever
-- sees rows that are open RIGHT NOW. That is correct for the ~20 callers that ask "who owns this
-- area today", and they are deliberately left on it. It is wrong for exactly one caller: the
-- Monthly Closing, which must ask "who owned this area in the month I am closing".
--
-- The gap is not theoretical. A territory move is written as a PAIR - the old row closed on the
-- move date, a new row opened on the same date. Through the current-only view the closing sees
-- NEITHER half while the move is still in the future: the old row has an effective_to so it is
-- filtered out, and the new row has not started yet. applyOperationalRegions() then finds no entry
-- for the area and silently falls back to its GEOGRAPHIC region - so closing August would file
-- Qalubeya under Delta (1) instead of the Others district it actually reported to. Nothing errors;
-- the number just moves. That is what made the 2026-08-28 Anti Infective Delta (3) move unsafe to
-- leave standing and forced it to be rolled back by hand on 2026-08-29.
--
-- MEASURED NO-OP ON TODAY'S DATA. au.line_area_map holds 150 rows, of which 3 are closed (OT3 on
-- each of the three lines, effective 2026-07-13 -> 2026-07-27) and NO (line_code, area_code) pair
-- has more than one row. Resolving every month-end of 2026 against this view versus the current-
-- only one returns zero differing rows, because OT3's window opens and closes inside July and so
-- contains no month-end at all. This view therefore changes no closing number that exists today;
-- it only makes the NEXT dated move resolvable.
--
-- Additive on purpose. au_v_line_area_map is untouched, so every other caller keeps exactly the
-- behaviour it has now and the owner's standing rule - that sales attribute to today's geography,
-- never as-was - still governs them.
--
-- Privileges mirror au_v_line_area_map and au_v_regions: service_role only. This is the seat model,
-- not public data, and nothing in the app reads it with a user's own session.
create or replace view public.au_v_line_area_map_all as
  select
    m.line_code,
    m.area_code,
    m.operational_region_code,
    m.area_state,
    m.dm_seat_id,
    m.rep_seat_id,
    m.other_type,
    m.staffed_in_line_code,
    m.carries_target,
    m.effective_from,
    m.effective_to,
    m.notes,
    ca.area_name
  from au.line_area_map m
  join au.canonical_areas ca on ca.area_code = m.area_code;

revoke all on public.au_v_line_area_map_all from anon, authenticated, public;
grant select on public.au_v_line_area_map_all to service_role;

comment on view public.au_v_line_area_map_all is
  'au.line_area_map with history: identical to au_v_line_area_map but WITHOUT the effective_to is null filter. Read only by the Monthly Closing, which resolves the org chart at the month being closed. Every other caller stays on au_v_line_area_map. The effective_to bound is EXCLUSIVE: a row closed on 2026-09-01 covers 2026-08-31 and not 2026-09-01.';
