-- Heal `attendance_device_user_map.last_seen_punch_at` for the rows the ingest never wrote.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHY THIS EXISTS. The punch ingest maintained this column only for UNMAPPED device users: the
-- writer was handed `unmappedPunches` alone, and carried a `row.is_active && row.employee_hr_id`
-- guard on top. So the moment HR mapped a device user and activated them, the column stopped being
-- written — forever. It froze at whatever it held that day, or stayed NULL if they were mapped
-- before they ever punched unmapped.
--
-- Measured on production 2026-09-23, across the 28 map rows, and the correlation is total:
--   * 15 rows have punches but a NULL stored value — ALL 15 mapped and active;
--   *  3 rows are stale (device user 14 held 2026-05-18 against an actual 2026-09-21) — ALL 3
--      mapped and active;
--   *  1 row agrees — mapped and active, and its last punch simply predates being mapped;
--   *  9 rows hold a timestamp with no surviving punches — ALL 9 unmapped or inactive, which is
--      exactly the population the writer did still maintain.
--
-- The writer is fixed in the same change. This migration repairs the 18 rows already wrong, which
-- would otherwise only heal when that person next punches — and never at all for anyone who has
-- stopped.
--
-- MONOTONIC, AND THAT IS DELIBERATE. It only ever moves the column FORWARD, mirroring the rule the
-- runtime now applies. The 9 rows holding a timestamp with no surviving punches are left exactly as
-- they are: their punches have been cleared, so the stored value is the better record of when that
-- finger was last seen, and the view has no row to join against them anyway.
--
-- IDEMPOTENT. Re-running it updates zero rows.

update public.attendance_device_user_map as m
   set last_seen_punch_at = v.latest_punch_at,
       updated_at = now()
  from public.attendance_device_user_latest_punch as v
 where v.device_id = m.device_id
   and v.device_user_id = m.device_user_id
   and v.latest_punch_at is not null
   and (m.last_seen_punch_at is null or m.last_seen_punch_at < v.latest_punch_at);
