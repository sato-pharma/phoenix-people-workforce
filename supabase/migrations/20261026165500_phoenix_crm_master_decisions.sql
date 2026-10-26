-- phoenix_crm_master_decisions
--
-- WHAT THIS CHANGES:
--   One new, empty table, phoenix_crm_master_decisions: the owner's own word on one profile of the CRM
--   Master List — the places that several reps hold for the same customer, folded into one profile. Each row
--   names the place whose photo and point the profile wears (anchor_place_id, the "best photo" he picked),
--   the places it covers, and whether he confirmed it or said it is not the same place.
--
-- WHY (owner, 2026-10-26):
--   "build a master page for only the admin, and the CEO ... the list source of trust ... separate regions and
--   areas ... and bricks, and put in each brick per speciality the doctor validated". Asked who confirms, he
--   chose "my click and automatic"; asked what the best-photo pick changes, "Master profile only" — the reps'
--   own places are never moved. So a profile is confirmed automatically when its photos agree, and his click
--   overrides it either way; nothing here writes to phoenix_crm_places.
--
--   Only the Super Admin writes, through the application's service-role client (saveMasterDecision); the
--   browser roles get nothing.
--
-- ROLLBACK:
--   drop table if exists public.phoenix_crm_master_decisions;  -- SAFE only while it holds no decision
--   DATA COST: every confirm, "not the same place" and best-photo pick he made; each profile falls back to
--   its automatic status.
--
-- Verification after apply:
--   select relname, relrowsecurity from pg_class where relname = 'phoenix_crm_master_decisions';  -- 1 row, t
--   select grantee, privilege_type from information_schema.role_table_grants
--     where table_name = 'phoenix_crm_master_decisions';  -- service_role only (plus the owner role)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration creates one empty table; no existing row is touched.

begin;
set local lock_timeout = '5s';

create table if not exists public.phoenix_crm_master_decisions (
  id uuid primary key default gen_random_uuid(),
  anchor_place_id uuid not null references public.phoenix_crm_places(id) on delete cascade,
  member_place_ids uuid[] not null default '{}',
  verdict text not null,
  note text,
  decided_by_hr_id text not null,
  decided_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phoenix_crm_master_decisions_anchor_unique unique (anchor_place_id),
  constraint phoenix_crm_master_decisions_verdict check (verdict in ('confirmed', 'rejected')),
  constraint phoenix_crm_master_decisions_note check (note is null or char_length(note) <= 500)
);

comment on table public.phoenix_crm_master_decisions is
  'The owner''s confirm / not-the-same-place decision and best-photo pick per CRM Master List profile. '
  'Never moves a rep''s place. Written only by the application (service role) for the Super Admin.';

-- RLS on with no browser policy; the revoke covers PUBLIC, which also strips service_role (a member of
-- it), so the grant that follows is mandatory.
alter table public.phoenix_crm_master_decisions enable row level security;
drop policy if exists phoenix_crm_master_decisions_service_role on public.phoenix_crm_master_decisions;
create policy phoenix_crm_master_decisions_service_role
  on public.phoenix_crm_master_decisions for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_master_decisions from public, anon, authenticated;
grant all on table public.phoenix_crm_master_decisions to service_role;

notify pgrst, 'reload schema';

commit;
