-- Probation Decision Intelligence System — Phase 1 domain model.
--
-- Introduces the central Probation Case as the single source of truth, plus CRM-derived
-- Double-Visit-Day capture, structured versioned feedback, SFE/HR assessments, development
-- actions, and an admin-editable config singleton. Absorbs the DV-checkbox concept from
-- employee_probation (which is retained until backfill is verified) — DV completion is now
-- DERIVED from probation_dv_days rather than stored as per-role booleans.
--
-- Safety by design:
--   * Purely ADDITIVE. No existing table is dropped or altered destructively. employee_probation,
--     probation_evaluations, probation_feedback_submissions/comments, and probation_history stay
--     intact so the current module keeps working until the new one is cut over.
--   * All new tables are service-role only (RLS enabled, NO policies). The probation domain layer
--     reads/writes exclusively via getSupabaseAdmin() (service role bypasses RLS); browser roles
--     never touch these tables directly. Mirrors the blocked_ips / existing probation posture.
--   * Idempotent: create table if not exists, add column if not exists, create index if not exists.
--   * probation_config is a singleton (id boolean primary key check(id)) mirroring
--     v2_vacation_sla_settings; a TS-const fallback covers the pre-seed / schema-missing window.

begin;

-- ===========================================================================
-- 1. probation_cases — one row per employee probation (single source of truth)
-- ===========================================================================
create table if not exists public.probation_cases (
  id uuid primary key default gen_random_uuid(),
  employee_hr_id text not null unique,
  employee_name text,
  job_title text,
  line_name text,
  area_name text,
  manager_hr_id text,
  hire_date date,
  probation_start_date date,
  -- Canonical end date = hire_date + 90 days (owner-locked formula). Stored for query/index;
  -- the TS helper probationEndDate() is the single writer. Not DB-enforced so corrected hire
  -- dates can be re-derived by the service without a constraint fight.
  probation_end_date date,
  -- Lifecycle status of the CASE (not the final decision). active = within window, no decision.
  status text not null default 'active'
    check (status in ('active','decided','cancelled')),
  -- Final human decision (null until decided). 'extend' intentionally excluded — removed by policy.
  decision text
    check (decision is null or decision in ('pass','terminate')),
  decision_reason text,
  decision_by text,
  decision_at timestamptz,
  evidence_acknowledged boolean not null default false,
  -- Idempotency guard: pass/terminate side effects run exactly once (Phase 10).
  side_effects_applied_at timestamptz,
  -- Traceability back to the pre-rebuild rows linked at backfill (Phase 2).
  legacy_probation_id bigint,
  source text not null default 'system',
  last_crm_sync_at timestamptz,
  last_report_update_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_probation_cases_status on public.probation_cases (status);
create index if not exists idx_probation_cases_end_date on public.probation_cases (probation_end_date);
create index if not exists idx_probation_cases_manager on public.probation_cases (manager_hr_id);

alter table public.probation_cases enable row level security;

-- ===========================================================================
-- 2. probation_dv_days — CRM-derived, validated Double-Visit Days
-- ===========================================================================
create table if not exists public.probation_dv_days (
  id uuid primary key default gen_random_uuid(),
  case_id uuid references public.probation_cases (id) on delete cascade,
  employee_hr_id text not null,
  evaluator_hr_id text,
  -- Required role this DV-Day counts toward: dm | tm | pm_gpm | nsm (null until resolved).
  evaluator_role text
    check (evaluator_role is null or evaluator_role in ('dm','tm','pm_gpm','nsm')),
  dv_date date not null,
  ampm text check (ampm is null or ampm in ('AM','PM')),
  area_name text,
  visit_count integer not null default 0,
  -- Validation lifecycle (spec-mandated statuses).
  dv_status text not null default 'detected'
    check (dv_status in (
      'detected','validation_pending','validated','feedback_pending',
      'feedback_completed','rejected','duplicate','invalid','manually_reviewed'
    )),
  validation_reason text,
  -- CRM traceability + dedup: the underlying crm_visit_id set and resolution metadata.
  crm_source_ids jsonb not null default '[]'::jsonb,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One DV-Day per (evaluator, employee, date). The same field day cannot be double-counted.
  constraint probation_dv_days_unique_day unique (evaluator_hr_id, employee_hr_id, dv_date)
);

create index if not exists idx_probation_dv_days_case on public.probation_dv_days (case_id);
create index if not exists idx_probation_dv_days_employee on public.probation_dv_days (employee_hr_id);
create index if not exists idx_probation_dv_days_status on public.probation_dv_days (dv_status);
create index if not exists idx_probation_dv_days_date on public.probation_dv_days (dv_date);

alter table public.probation_dv_days enable row level security;

-- ===========================================================================
-- 3. probation_dv_visits — per-visit detail rows underlying each DV-Day
-- ===========================================================================
create table if not exists public.probation_dv_visits (
  id uuid primary key default gen_random_uuid(),
  dv_day_id uuid not null references public.probation_dv_days (id) on delete cascade,
  -- CRM source id; unique so the same activity can never attach to two DV-Days.
  crm_visit_id bigint unique,
  contact_name text,
  customer_name text,
  comment text,
  visit_type integer,
  visit_type_description text,
  ampm text,
  visit_date date,
  created_at timestamptz not null default now()
);

create index if not exists idx_probation_dv_visits_day on public.probation_dv_visits (dv_day_id);

alter table public.probation_dv_visits enable row level security;

-- ===========================================================================
-- 4. probation_feedback — one structured, active scorecard per DV-Day
-- ===========================================================================
create table if not exists public.probation_feedback (
  id uuid primary key default gen_random_uuid(),
  -- Exactly one active feedback record per DV-Day (spec invariant).
  dv_day_id uuid not null unique references public.probation_dv_days (id) on delete cascade,
  case_id uuid references public.probation_cases (id) on delete cascade,
  employee_hr_id text not null,
  evaluator_hr_id text not null,
  evaluator_role text,
  -- Scorecard: { dimensionKey: 1..10 }. Dimensions + scale are config-driven (probation_config).
  scores jsonb not null default '{}'::jsonb,
  strengths text,
  development_areas text,
  objective_observations text,
  recommendation text
    check (recommendation is null or recommendation in ('on_track','needs_improvement','serious_concern')),
  -- Restricted-visibility note (HR/CEO only); never surfaced to peer field evaluators.
  confidential_note text,
  status text not null default 'submitted'
    check (status in ('submitted','edited')),
  current_version integer not null default 1,
  submitted_by text,
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_probation_feedback_case on public.probation_feedback (case_id);
create index if not exists idx_probation_feedback_employee on public.probation_feedback (employee_hr_id);

alter table public.probation_feedback enable row level security;

-- ===========================================================================
-- 5. probation_feedback_versions — immutable version history (edit audit)
-- ===========================================================================
create table if not exists public.probation_feedback_versions (
  id uuid primary key default gen_random_uuid(),
  feedback_id uuid not null references public.probation_feedback (id) on delete cascade,
  version_number integer not null,
  action text not null check (action in ('submit','edit')),
  edited_by text,
  edit_reason text,
  -- Full snapshot of the scorecard at this version (previous/new values live across rows).
  snapshot jsonb not null default '{}'::jsonb,
  scores jsonb not null default '{}'::jsonb,
  recommendation text,
  created_at timestamptz not null default now(),
  constraint probation_feedback_versions_unique unique (feedback_id, version_number)
);

create index if not exists idx_probation_feedback_versions_feedback
  on public.probation_feedback_versions (feedback_id);

alter table public.probation_feedback_versions enable row level security;

-- ===========================================================================
-- 6. probation_assessments — SFE (data-backed) and HR (deferred) scores
-- ===========================================================================
create table if not exists public.probation_assessments (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.probation_cases (id) on delete cascade,
  employee_hr_id text not null,
  kind text not null check (kind in ('sfe','hr')),
  -- System-calculated evidence (KPI aggregation), kept distinct from the human score.
  system_evidence jsonb not null default '{}'::jsonb,
  -- Human-entered score on the configured scale (null while pending/unavailable).
  score numeric,
  comments text,
  overrides jsonb not null default '{}'::jsonb,
  override_reason text,
  confidential_note text,
  -- 'unavailable' = component intentionally not collectable yet (HR pending attendance backfill).
  status text not null default 'pending'
    check (status in ('pending','submitted','unavailable')),
  submitted_by text,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint probation_assessments_unique_kind unique (case_id, kind)
);

create index if not exists idx_probation_assessments_case on public.probation_assessments (case_id);

alter table public.probation_assessments enable row level security;

-- ===========================================================================
-- 7. probation_development_actions — structured development follow-ups
-- ===========================================================================
create table if not exists public.probation_development_actions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.probation_cases (id) on delete cascade,
  dv_day_id uuid references public.probation_dv_days (id) on delete set null,
  employee_hr_id text not null,
  title text not null,
  description text,
  owner_hr_id text,
  due_date date,
  score_category text,
  status text not null default 'open'
    check (status in ('open','in_progress','done','cancelled')),
  follow_up_outcome text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_probation_dev_actions_case on public.probation_development_actions (case_id);
create index if not exists idx_probation_dev_actions_employee on public.probation_development_actions (employee_hr_id);
create index if not exists idx_probation_dev_actions_status on public.probation_development_actions (status);

alter table public.probation_development_actions enable row level security;

-- ===========================================================================
-- 8. probation_config — admin-editable singleton (requirements / weights / scale / SLA)
-- ===========================================================================
create table if not exists public.probation_config (
  id boolean primary key default true,
  -- Required DV-Days per role (default DM 3 / TM 1 / PM|GPM 1 / NSM 1 = 6 total).
  requirements jsonb not null default '{"dm":3,"tm":1,"pm_gpm":1,"nsm":1}'::jsonb,
  -- Weighted role contributions to the overall score (must be admin-set, never silently assumed).
  role_weights jsonb not null default '{"dm":0.30,"tm":0.15,"pm_gpm":0.15,"nsm":0.15,"sfe":0.15,"hr":0.10}'::jsonb,
  -- Scoring scale (owner-locked 1..10).
  scoring_scale jsonb not null default '{"min":1,"max":10}'::jsonb,
  -- Feedback SLA timings in hours (due / escalate / overdue).
  sla jsonb not null default '{"dueHours":24,"escalateHours":48,"overdueHours":72}'::jsonb,
  updated_by text,
  updated_at timestamptz not null default now(),
  constraint probation_config_singleton check (id)
);

alter table public.probation_config enable row level security;

-- Seed the singleton row once (idempotent).
insert into public.probation_config (id) values (true)
on conflict (id) do nothing;

-- ===========================================================================
-- 9. probation_history — extend for case-timeline linkage (additive)
-- ===========================================================================
alter table public.probation_history add column if not exists case_id uuid;
create index if not exists idx_probation_history_case on public.probation_history (case_id);

notify pgrst, 'reload schema';

commit;
