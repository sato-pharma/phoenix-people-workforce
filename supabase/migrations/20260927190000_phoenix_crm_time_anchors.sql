-- phoenix_crm_time_anchors
--
-- WHAT THIS CHANGES:
--   One new table, public.phoenix_crm_time_anchors — a row the SERVER writes, carrying the server's
--   own timestamp, that a phone can later measure elapsed monotonic time against in order to date a
--   visit it captured with no signal.
--
-- WHY (owner, 2026-09-27, his own words when offered the phone's clock or the sync time and
-- refusing both):
--
--   "I want the Cairo time, but I don't want the time on the phone because they may install an app
--    that changes the time in the phone. I need what protects the system from fraud, but at the same
--    time I need it to be accurate Cairo time."
--
--   Both halves hold because two clocks live on a phone and only one is settable. The WALL clock is
--   what a "change my time" app moves. The MONOTONIC clock — elapsed-realtime-since-boot — counts
--   forward at one second per second and has no setter. So the phone never sends a time: it sends
--   the id of one of these rows plus the elapsed monotonic milliseconds since it took it, and the
--   server computes issued_at + elapsed itself. The rules are in
--   src/lib/phoenix-crm/offline-clock.ts and pinned by tests/phoenix-crm-offline-clock.test.ts.
--
-- 🔴 WHY A TABLE AND NOT A SIGNED TOKEN:
--   A signed anchor would need a new secret, which then needs creating, distributing to Railway and
--   GitHub, and rotating — and this repository has already lost a day to a half-rotated CRON_SECRET.
--   A row needs none of that: the server looks the anchor up and knows first-hand whether it issued
--   it, to whom, for which territory and when. The row IS the evidence, and it can be read back long
--   afterwards by a human asking how a visit came to be dated as it was.
--
-- 🔴 NOTHING HERE IS SINGLE-USE. One anchor dates every visit a rep captures during one offline
--   stretch, so there is deliberately no `used_at` and no consumption. What bounds it instead is
--   AGE — see ANCHOR_MAX_AGE_SECONDS in the rules module, and `phoenix_crm_time_anchors_age` below.
--
-- ROLLBACK:
--   drop table if exists public.phoenix_crm_time_anchors;
--
-- Verification after apply:
--   select count(*) from public.phoenix_crm_time_anchors;                        -- 0
--   select relrowsecurity from pg_class where relname = 'phoenix_crm_time_anchors';  -- t

begin;
set local lock_timeout = '5s';

create table if not exists public.phoenix_crm_time_anchors (
  id uuid primary key default gen_random_uuid(),
  hr_id text not null,
  seat_id text not null,
  -- Android's boot identity when the anchor was taken. A reboot resets the monotonic clock, so a
  -- delta measured across one is meaningless — this column is how the server can tell. Null where
  -- the build cannot report it; null is "unknown", never "the same".
  boot_id text,
  -- 🔴 THE SERVER'S OWN CLOCK. The starting point of every offline capture time, and the one value
  -- in this design the phone cannot influence. Never accept this from a request body.
  issued_at timestamptz not null default now(),
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  constraint phoenix_crm_time_anchors_boot check (boot_id is null or char_length(boot_id) between 1 and 120),
  constraint phoenix_crm_time_anchors_hr check (char_length(hr_id) between 1 and 40),
  constraint phoenix_crm_time_anchors_seat check (char_length(seat_id) between 1 and 80)
);

comment on table public.phoenix_crm_time_anchors is
  'A server-minted time anchor. A phone measures elapsed MONOTONIC time against issued_at to date a visit captured with no signal, so it never has to send a timestamp its own clock could have moved (owner, 2026-09-27). See src/lib/phoenix-crm/offline-clock.ts.';
comment on column public.phoenix_crm_time_anchors.issued_at is
  'The server''s own clock. Never supplied by a request. Every offline capture time is this plus an elapsed duration.';

-- The two reads: one anchor by id at save time, and a person's recent anchors for the issue-rate cap.
create index if not exists phoenix_crm_time_anchors_person_idx
  on public.phoenix_crm_time_anchors (hr_id, issued_at desc);

-- The same four statements, in the same order, as every other table in this module. Revoking from
-- public also strips service_role, which is a member of it, so the grant that follows is mandatory
-- rather than decorative; the `drop policy if exists` is what lets this file be REPLAYED against a
-- database whose schema already has it but whose ledger does not.
alter table public.phoenix_crm_time_anchors enable row level security;
drop policy if exists phoenix_crm_time_anchors_service_role on public.phoenix_crm_time_anchors;
create policy phoenix_crm_time_anchors_service_role
  on public.phoenix_crm_time_anchors for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_time_anchors from public, anon, authenticated;
grant all on table public.phoenix_crm_time_anchors to service_role;

notify pgrst, 'reload schema';

commit;
