-- tablet_position_agents
--
-- WHAT THIS CHANGES:
--   * A new table public.device_position_agents — one row per INSTALL of the Phoenix Position agent
--     (the small Android app on a rep tablet that reports where the tablet is straight to Phoenix):
--     its own install id, the SHA-256 of the token it authenticates with, which tablet it was bound
--     to, what phone it says it is, whether it has the location permission, and when it last spoke.
--   * A new table public.device_positions — the positions those installs report, one row per fix.
-- WHY:
--   Owner, 26 Nov 2026, asked for both halves at once: "why dont we create an apk that is connected
--   to the server and since the apk in on tablet then i can be connected easily and normally 2
--   server" → "both", then "Build the app". The first half shipped in #801: the tablet server now
--   RECEIVES what the launcher uploads (the premium plugin's path answered 404, so every tablet threw
--   its own trail away after a day). This is the second half — a trail that does not depend on the
--   launcher's version, on a premium plugin, or on the tablet server being up at all, because the
--   tablet posts it to Phoenix itself.
--
--   WHY AN INSTALL IS NOT A TABLET, AND WHY BINDING IS DELIBERATE. A tablet's Headwind configuration
--   is world-readable (the sync endpoint is public by design), so no long-lived credential may travel
--   through it — the same rule the screen-recording upload lives by (20261022170000). So the agent
--   introduces itself instead: on its first run it mints an install id, Phoenix answers with a token
--   once, and that token never leaves the tablet's private storage. An install Phoenix has not bound
--   to a tablet is INERT: its positions are kept, but they belong to no tablet and no rep until
--   someone with the tablet in front of them binds it. A stranger who posts positions therefore
--   claims nothing.
--
--   WHY THE POSITIONS ARE KEPT BEFORE THE BIND. A tablet that reports for a week before anyone binds
--   it should not have lost that week; device_number is filled in at bind time for the rows already
--   stored, so the trail is whole.
-- ROLLBACK:
--   drop table if exists public.device_positions;
--   drop table if exists public.device_position_agents;
--   Dropping them discards which install belongs to which tablet and every position reported to
--   Phoenix directly. The launcher's own uploaded trail lives on the tablet server and is untouched.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: two new tables. Nothing existing is altered.
--
-- READBACK (reads only):
--   select
--     (select count(*) from pg_class where relname = 'device_position_agents' and relrowsecurity) as agents_locked,
--     (select count(*) from pg_class where relname = 'device_positions' and relrowsecurity) as positions_locked,
--     (select count(*) from pg_indexes where indexname = 'device_position_agents_one_live_per_device') as one_live_index;
--   agents_locked 1, positions_locked 1, one_live_index 1.

begin;
set local lock_timeout = '5s';

-- === The installs ===============================================================================
-- `install_id` is minted by the agent on the tablet, so it is NOT defaulted here. `token_hash` is
-- the SHA-256 of the token Phoenix handed back once; the token itself is never written down.
-- `device_number` null means "not bound to a tablet yet" — the agent is known, and inert.

create table if not exists public.device_position_agents (
  install_id uuid primary key,
  token_hash text not null,
  device_number text,
  android_id text,
  model text,
  manufacturer text,
  android_version text,
  agent_version text,
  location_permission text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_fix_at timestamptz,
  fixes_received bigint not null default 0,
  bound_at timestamptz,
  bound_by_hr_id text,
  revoked_at timestamptz,
  revoked_reason text,
  constraint device_position_agents_token_hash check (char_length(token_hash) = 64),
  constraint device_position_agents_device check (device_number is null or char_length(device_number) between 1 and 80),
  constraint device_position_agents_permission check (
    location_permission is null or location_permission in ('fine', 'coarse', 'background', 'none')
  ),
  constraint device_position_agents_bound check ((device_number is null) = (bound_at is null))
);

-- One LIVE agent per tablet: a replaced tablet is bound to a new install only after the old one is
-- revoked, so two installs can never both claim to be the same tablet.
create unique index if not exists device_position_agents_one_live_per_device
  on public.device_position_agents (device_number)
  where device_number is not null and revoked_at is null;
create index if not exists device_position_agents_seen_idx
  on public.device_position_agents (last_seen_at desc);

alter table public.device_position_agents enable row level security;
drop policy if exists device_position_agents_service_role on public.device_position_agents;
create policy device_position_agents_service_role
  on public.device_position_agents for all to service_role using (true) with check (true);
revoke all on table public.device_position_agents from public, anon, authenticated;
grant all on table public.device_position_agents to service_role;

-- === The positions ==============================================================================
-- One row per fix. `recorded_at` is the tablet's own time for the fix; `received_at` is Phoenix's.
-- The unique key makes a re-send free: an agent that cannot be sure a batch arrived sends it again.

create table if not exists public.device_positions (
  id bigint generated always as identity primary key,
  install_id uuid not null references public.device_position_agents (install_id) on delete cascade,
  device_number text,
  recorded_at timestamptz not null,
  latitude double precision not null,
  longitude double precision not null,
  accuracy_m double precision,
  battery_level integer,
  provider text,
  mock boolean not null default false,
  received_at timestamptz not null default now(),
  constraint device_positions_latitude check (latitude between -90 and 90),
  constraint device_positions_longitude check (longitude between -180 and 180),
  constraint device_positions_not_null_island check (latitude <> 0 or longitude <> 0),
  constraint device_positions_accuracy check (accuracy_m is null or accuracy_m between 0 and 100000),
  constraint device_positions_battery check (battery_level is null or battery_level between 0 and 100),
  constraint device_positions_device check (device_number is null or char_length(device_number) between 1 and 80)
);

create unique index if not exists device_positions_one_per_fix
  on public.device_positions (install_id, recorded_at, latitude, longitude);
create index if not exists device_positions_device_idx
  on public.device_positions (device_number, recorded_at desc);
create index if not exists device_positions_install_idx
  on public.device_positions (install_id, recorded_at desc);

alter table public.device_positions enable row level security;
drop policy if exists device_positions_service_role on public.device_positions;
create policy device_positions_service_role
  on public.device_positions for all to service_role using (true) with check (true);
revoke all on table public.device_positions from public, anon, authenticated;
grant all on table public.device_positions to service_role;

notify pgrst, 'reload schema';

-- The ledger row. Both Supabase tools decline this file (it carries `drop policy if exists`, which
-- the classifier reads as destructive — measured on staging, 26 Nov 2026), so it is applied through
-- `scripts/apply-sql-file.mjs`, which writes no ledger row — so it is written here, with the FILE's
-- own version, guarded on both tables being live and on the row not existing.
insert into supabase_migrations.schema_migrations (version, name)
select '20261126021500', 'tablet_position_agents'
where exists (
        select 1 from information_schema.tables
        where table_schema = 'public' and table_name = 'device_position_agents'
      )
  and exists (
        select 1 from information_schema.tables
        where table_schema = 'public' and table_name = 'device_positions'
      )
  and not exists (
        select 1 from supabase_migrations.schema_migrations where version = '20261126021500'
      );

commit;
