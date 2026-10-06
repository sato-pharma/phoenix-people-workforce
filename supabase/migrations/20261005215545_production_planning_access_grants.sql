-- production_planning_access_grants
--
-- WHAT THIS CHANGES:
--   One table, `public.prodplan_access_grants`: one row per person granted the Production Planner by
--   name, with the level they hold (`read` or `full`), who granted it and why.
--
-- WHY:
--   The Production Planner's access is a NAMED LIST, not a role grant, and the reason is in
--   src/lib/production-planning/access.ts: its main user, Dr. Sahar Khalil, holds the app role
--   `Manager`, which has two holders, and Reham Elwiy holds `Employee`, which is the whole company.
--   Granting either role would put raw-material prices and order costs in front of everybody.
--
--   The five people the owner named on 2026-10-05 are in the code, because they are the design. This
--   table is for the sixth — and specifically for the one upgrade he has already said is coming:
--   "let her get access but read only and later on like I said authority on her" (Reham). Without
--   this table that upgrade is a branch, a pull request, a CI run and a deploy; with it, it is a row
--   on the Settings tab.
--
--   It grants ONE resource and nothing else, and only this module's own helper reads it. It is
--   deliberately NOT a general permission override: `role_permission_overrides` already exists for
--   that, and a second general one would be a second place to look.
--
-- ROLLBACK:
--   drop table public.prodplan_access_grants;   -- SAFE: additive, and empty on arrival.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This migration is additive only: one new, empty table. It touches no existing row.

begin;

create table if not exists public.prodplan_access_grants (
  id uuid primary key default gen_random_uuid(),
  hr_id text not null,
  level text not null,
  note text,
  granted_by_hr_id text,
  granted_by_login text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Stored UPPER so the row reads as the HR id the owner knows. The application still compares with
  -- hrIdsMatch rather than `=`, because production holds these in mixed case and an `=` that matches
  -- nobody fails silently — it looks exactly like the grant never having shipped.
  constraint prodplan_access_grants_hr_id_key unique (hr_id),
  constraint prodplan_access_grants_hr_id_check check (hr_id = upper(btrim(hr_id)) and char_length(hr_id) between 1 and 40),
  constraint prodplan_access_grants_level_check check (level = any (array['read'::text, 'full'::text])),
  constraint prodplan_access_grants_note_check check (note is null or char_length(btrim(note)) between 1 and 400)
);

comment on table public.prodplan_access_grants is
  'People granted the Production Planner BY NAME, beyond the five in src/lib/production-planning/access.ts. Grants this one module only; it is not a general permission override.';
comment on column public.prodplan_access_grants.level is
  'read = see everything, change nothing. full = draft and commit a plan, record a run, edit materials, prices and settings.';
comment on column public.prodplan_access_grants.hr_id is
  'Stored upper-case for readability. Compared with hrIdsMatch, never with =, because production stores HR ids in mixed case.';

alter table public.prodplan_access_grants enable row level security;
revoke all on table public.prodplan_access_grants from public, anon, authenticated;
grant all on table public.prodplan_access_grants to service_role;

commit;

-- Verify (catalog, not the ledger):
--   select relname, relrowsecurity from pg_class where relname = 'prodplan_access_grants';
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_name = 'prodplan_access_grants';
--   select count(*) from public.prodplan_access_grants;   -- 0 on arrival: the five named people are in code
