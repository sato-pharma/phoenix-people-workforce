-- ats_mr_area_manager_notices
--
-- WHAT THIS CHANGES: one new table, public.ats_mr_area_manager_notices — a row for each manager told
--   that a Medical Rep candidate passed HR's 1st interview for his area and line. Nothing existing
--   changes.
-- WHY: the owner, 7 Nov 2026 — when HR passes a candidate at the 1st interview and confirms the area
--   and the line, the manager of that area is told in-app, on Telegram, by email and by a banner on
--   his portal home. The row remembers WHO was told (the area's DSM, or the line's NSM where the area
--   has no real DSM) and whether he has dismissed the banner (`seen_at`).
-- ROLLBACK: drop table public.ats_mr_area_manager_notices; — it holds only these notices; the
--   notifications themselves live in the notification tables and are unaffected.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create table if not exists public.ats_mr_area_manager_notices (
  id bigint generated always as identity primary key,
  candidate_id uuid not null references public.ats_candidates (id) on delete cascade,
  result_id bigint not null references public.ats_mr_hiring_step_results (id) on delete cascade,
  manager_hr_id text not null,
  manager_seat text not null,
  area_name text not null,
  line text not null,
  created_at timestamptz not null default now(),
  seen_at timestamptz,
  constraint ats_mr_area_manager_notices_once unique (result_id, manager_hr_id),
  constraint ats_mr_area_manager_notices_hr_id_check
    check (char_length(btrim(manager_hr_id)) between 1 and 40),
  constraint ats_mr_area_manager_notices_seat_check
    check (manager_seat in ('dsm', 'nsm')),
  constraint ats_mr_area_manager_notices_area_check
    check (char_length(btrim(area_name)) between 1 and 120),
  constraint ats_mr_area_manager_notices_line_check
    check (line in ('pedia', 'anti_infective', 'cns'))
);

comment on table public.ats_mr_area_manager_notices is
  'Medical Rep hiring: each manager told that a candidate passed the HR 1st interview for his area and line (owner, 7 Nov 2026). seen_at = he dismissed the portal banner.';

-- The banner's read: one manager's notices not yet dismissed, newest first.
create index if not exists ats_mr_area_manager_notices_unseen_idx
  on public.ats_mr_area_manager_notices (manager_hr_id, created_at desc)
  where seen_at is null;
create index if not exists ats_mr_area_manager_notices_candidate_idx
  on public.ats_mr_area_manager_notices (candidate_id);

alter table public.ats_mr_area_manager_notices enable row level security;
drop policy if exists phx_ats_mr_area_manager_notices_service_role on public.ats_mr_area_manager_notices;
create policy phx_ats_mr_area_manager_notices_service_role
  on public.ats_mr_area_manager_notices for all
  to service_role using (true) with check (true);
revoke all on table public.ats_mr_area_manager_notices from anon, authenticated;
grant all on table public.ats_mr_area_manager_notices to service_role;

commit;
