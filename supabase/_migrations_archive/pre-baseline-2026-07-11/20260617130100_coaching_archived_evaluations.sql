-- Archive table for historical field coaching evaluations of reps who have
-- resigned (or otherwise cannot be matched to an active employee at import time).
--
-- Why: when importing historical coaching workbooks, some rows belong to reps who
-- have left the company and no longer exist in the active employee directory, so a
-- normal coaching_reports row cannot be created for them. Rather than discard the
-- coach's written effort (scores + development notes + remarks), each such row is
-- preserved here and surfaced in the coaching admin UI.
--
-- Server-only: writes go through getSupabaseAdmin() (service role). No anon /
-- authenticated grants. Mirrors the RLS posture of the coaching_reports tables.

begin;

create table if not exists public.coaching_archived_evaluations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by text,
  coach_hr_id text,
  -- Source identity copied verbatim from the sheet.
  source_name text not null,
  rep_name text,
  territory text,
  rep_code text,
  claimed_hr_id text,
  -- Evaluation context.
  coaching_date date,
  coaching_quarter integer,
  coaching_year integer,
  -- Scores keyed by score_item_key (1-5), plus the coach's overall + notes.
  scores jsonb not null default '{}'::jsonb,
  overall_score numeric,
  performance_band text,
  area_of_development text,
  strength_points text,
  general_remarks text,
  -- Provenance.
  import_batch_id uuid,
  source_file text,
  unmatched_reason text
);

create index if not exists coaching_archived_evaluations_period_idx
  on public.coaching_archived_evaluations (coaching_year, coaching_quarter);
create index if not exists coaching_archived_evaluations_batch_idx
  on public.coaching_archived_evaluations (import_batch_id);

alter table public.coaching_archived_evaluations enable row level security;

drop policy if exists phx_coaching_archived_service_role on public.coaching_archived_evaluations;
create policy phx_coaching_archived_service_role
  on public.coaching_archived_evaluations
  for all
  to service_role
  using (true)
  with check (true);

revoke all on table public.coaching_archived_evaluations from anon, authenticated;
grant select, insert, update, delete on table public.coaching_archived_evaluations to service_role;

commit;
