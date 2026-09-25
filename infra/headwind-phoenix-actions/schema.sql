-- ─────────────────────────────────────────────────────────────────────────────
-- The Phoenix actions add-on's one table, on the HEADWIND server's own Postgres.
--
-- 🔴 THIS IS NOT THE PHOENIX DATABASE. It lives inside the Headwind box, beside
--    Headwind's own tables, and nothing in Supabase knows about it. It is applied
--    by the add-on at start-up, not by supabase/migrations/.
--
-- One row per action waiting for a tablet. The sync hook reads it when the tablet
-- checks in; the confirmation endpoints close it when the tablet says it acted.
--
-- 🔴 WHY `consumed_at` AND `confirmed_at` ARE TWO COLUMNS AND NOT ONE. Consumed
--    means the instruction was put into a sync response — the tablet was told.
--    Confirmed means the tablet came back and said it did it. A custody console
--    that collapses those two reports a wipe as done when the tablet was merely
--    asked, which is the single most expensive lie this system could tell.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists phoenix_pending_actions (
  id            bigserial   primary key,
  device_number varchar(128) not null,
  -- lock | unlock | lost_mode_on | lost_mode_off | factory_reset | password_reset | reboot
  action        varchar(32)  not null,
  message       text,
  -- A temporary screen-lock password for a reset. CLEARED on confirmation; never logged.
  password      text,
  requested_by  varchar(128),
  created_at    timestamp    not null default now(),
  consumed_at   timestamp,
  confirmed_at  timestamp
);

-- The hook runs on EVERY device check-in, for every tablet, forever. Without this
-- index that is a sequential scan of a growing table on the fleet's hottest path.
create index if not exists phoenix_pending_actions_open_idx
  on phoenix_pending_actions (device_number)
  where confirmed_at is null;
