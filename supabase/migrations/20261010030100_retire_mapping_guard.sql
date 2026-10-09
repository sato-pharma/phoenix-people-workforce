-- Retire the Mapping Guard: drop its triggers, its functions and its permits table.
--
-- WHAT THIS CHANGES: removes the three guard triggers (customer map, bricks, areas), the six
-- sos_map_guard_* functions, sos_move_brick_sales_after_hold (called only by the decide wrapper) and the
-- empty sos_map_guard_permits table. After this a write to source_of_sales_customer_map,
-- source_of_sales_bricks or source_of_sales_areas applies directly: nothing is held, dropped or logged
-- by a trigger any more.
-- WHY: owner instruction 2026-10-10, "drop this module it have many mismatches drop it 100% ... retire
-- and kill it". The same PR removes the /sales/mapping-guard screen, its API routes and the held-changes
-- spreadsheet, so no code calls any of these. APPLY AT MERGE TIME, not before: until the new code is
-- live, the old screen still calls the decide wrapper.
-- KEPT ON PURPOSE: sos_map_change_holds (3,468 rows) and sos_map_change_log (24,292 rows) stay as history,
-- because production has no point-in-time recovery.
-- VERIFIED LIVE (production, 2026-10-10 before writing): no other public or au function's source mentions
-- map_guard; sos_map_guard_permits holds 0 rows; sos_move_brick_sales_after_hold is mentioned by one
-- function only, the decide wrapper dropped here.
-- ROLLBACK: re-create from 20260913020000, 20260918150200 and 20261009234500 (the last definitions of the
-- functions) and the three triggers from 20260911*; the table from its create migration. Not needed for
-- data — nothing but triggers, functions and an empty table is removed.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Idempotent — every statement is "if exists".

begin;

drop trigger if exists sos_map_guard_customer_trg on public.source_of_sales_customer_map;
drop trigger if exists sos_map_guard_brick_trg on public.source_of_sales_bricks;
drop trigger if exists sos_map_guard_area_trg on public.source_of_sales_areas;

drop function if exists public.sos_map_guard_decide_and_move_sales(bigint, text, text, boolean);
drop function if exists public.sos_map_guard_decide(bigint, text, text);
drop function if exists public.sos_move_brick_sales_after_hold(bigint);
drop function if exists public.sos_map_guard_customer();
drop function if exists public.sos_map_guard_brick();
drop function if exists public.sos_map_guard_area();
drop function if exists public.sos_map_guard_permit_for(text, text);

-- SAFE: the table is empty (0 rows, checked on production 2026-10-10) and held one-transaction permits only.
drop table if exists public.sos_map_guard_permits;

commit;
