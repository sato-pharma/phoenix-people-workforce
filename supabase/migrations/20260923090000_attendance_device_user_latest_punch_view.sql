-- The newest punch per (device, device user), computed by the database.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHY THIS EXISTS. The fingerprint device-mapping dashboard needs ONE number per device user — the
-- time of their most recent punch. It was getting it by pulling the newest 5,000 raw punches into
-- Node and folding them down to a max per pair. On 2026-09-23 production held 4,808 punches for 19
-- distinct pairs: 4,808 rows shipped to derive 19 values, and 192 rows short of the cap biting.
--
-- THE CAP DOES NOT FAIL LOUDLY, WHICH IS THE PROBLEM. The read is ordered newest-first, so the rows
-- that fall off the end are the OLDEST. A device user who stopped punching months ago is exactly the
-- one whose punches drop out of the window first — and that is exactly the row HR is looking for on
-- this screen. The page would not show them as stale; it would fall back to the stored
-- `attendance_device_user_map.last_seen_punch_at` column, which is NULL for 15 of the 19 pairs that
-- have punches, so the row would read as if the user had never punched at all.
--
-- THE STORED COLUMN IS NOT A SUBSTITUTE, measured on production the same day:
--   * 15 pairs have punches but a NULL `last_seen_punch_at` (several punched that morning);
--   *  3 pairs disagree with reality — device user 14 stored 2026-05-18, actual 2026-09-21;
--   *  1 pair agrees;
--   *  9 map rows carry a stored timestamp but have no surviving punches at all.
-- So the dashboard is right to recompute, and wrong to do it by dragging the whole table across.
--
-- ADDITIVE AND READ-ONLY. It creates no table, changes no row, and drops nothing. This view can be
-- applied before the code that reads it and breaks nothing in the meantime.
--
-- GRANTS MATCH ITS SIBLINGS EXACTLY — service_role only, never `authenticated`. Punch times say when
-- a named employee was at the door; the application reads this with the service-role client,
-- server-side, as it does the rest of the attendance model.
--
-- INDEXES ALREADY SERVE IT. `attendance_raw_punches` carries two unique indexes leading with
-- (device_id, device_user_id, punch_time), so the grouped max needs no new index.

create or replace view public.attendance_device_user_latest_punch as
  select
    p.device_id,
    p.device_user_id,
    max(p.punch_time) as latest_punch_at
  from public.attendance_raw_punches p
  group by p.device_id, p.device_user_id;

comment on view public.attendance_device_user_latest_punch is
  'Newest punch per (device_id, device_user_id). Exists so the device-mapping dashboard reads one row per device user instead of capping a raw-punch scan at 5,000 rows, where the OLDEST punches — the stale users the screen is for — silently fell off the end.';

revoke all on public.attendance_device_user_latest_punch from anon, authenticated, public;
grant select on public.attendance_device_user_latest_punch to service_role;
