-- ─────────────────────────────────────────────────────────────────────────────
-- The Phoenix actions add-on's two tables, on the HEADWIND server's own Postgres.
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
--
-- 🔴 AND `consumed_at` IS ALSO THE SECURITY CONDITION, not only a report. The
--    confirmation URLs are unauthenticated — the agent's design, not a choice made
--    here — so `confirm` requires `consumed_at is not null`: a row can only be
--    closed once the sync hook has actually written the instruction into a response
--    for that device. Without it, anyone who knows a device number could mark a
--    freshly queued wipe as done before the tablet ever heard about it.
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
  confirmed_at  timestamp,
  -- Where the confirmation came from: getRemoteAddr(), never X-Forwarded-For, which the
  -- caller sets. A NOTE beside the row, never an identity — behind Railway's edge every
  -- public request shares one address. NULL means the SERVER closed the row (an unlock),
  -- not a tablet.
  confirmed_from varchar(64)
);

-- 🔴 AND THE SAME COLUMN AS AN ALTER, BECAUSE THE LIVE TABLE ALREADY EXISTS (2026-09-25).
--    `create table if not exists` skips the statement WHOLE — it does not reconcile columns —
--    so a column added to the block above never reaches a box that already ran once. The
--    add-on issues this at start-up for exactly that reason; it is repeated here so the two
--    files cannot drift.
alter table phoenix_pending_actions add column if not exists confirmed_from varchar(64);

-- The hook runs on EVERY device check-in, for every tablet, forever. Without this
-- index that is a sequential scan of a growing table on the fleet's hottest path.
create index if not exists phoenix_pending_actions_open_idx
  on phoenix_pending_actions (device_number)
  where confirmed_at is null;

-- ─────────────────────────────────────────────────────────────────────────────
-- The second table (26 Nov 2026): the positions each tablet uploads itself.
--
-- The launcher PUTs the fixes it took to /rest/plugins/devicelocations/public/update/{number}
-- — a premium plugin's path the free server answered 404 on, so every fix was thrown away on the
-- tablet after a day. DeviceLocationsResource receives it now; Phoenix reads the rows through
-- /rest/plugins/phoenix-actions/private/locations/{number}. Created by PhoenixLocationStore at
-- start-up; repeated here so the two cannot drift.
--
-- 🔴 recorded_at_ms IS THE TABLET'S OWN EPOCH MILLISECONDS, NOT A timestamp — a timestamp without
--    time zone would take the session's zone silently and shift a rep's trail by hours.
-- 🔴 The unique index is the retry guard: the launcher re-sends what it saw no 2xx for.
-- Rows older than 90 days are deleted for a tablet whenever it uploads.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists phoenix_device_locations (
  id             bigserial        primary key,
  device_number  varchar(128)     not null,
  recorded_at_ms bigint           not null,
  lat            double precision not null,
  lon            double precision not null,
  received_at    timestamp        not null default now()
);

create unique index if not exists phoenix_device_locations_fix_uq
  on phoenix_device_locations (device_number, recorded_at_ms, lat, lon);

create index if not exists phoenix_device_locations_recent_idx
  on phoenix_device_locations (device_number, recorded_at_ms desc);
