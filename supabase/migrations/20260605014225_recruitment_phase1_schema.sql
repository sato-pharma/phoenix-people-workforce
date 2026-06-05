-- Recruitment / ATS module — Phase 1 schema (requisition -> candidate -> application),
-- append-only history, interviews, file metadata. RLS service-role-only (PII).

-- 1. Requisitions -----------------------------------------------------------
create table if not exists public.recruitment_requisitions (
  id uuid primary key default gen_random_uuid(),
  requisition_code text not null unique,
  vacancy_id bigint null references public.position_vacancies(id) on update cascade on delete set null,
  department_id bigint null,
  line_id bigint null,
  area_id bigint null,
  team_id bigint null,
  position_id bigint null,
  job_title text not null default '',
  hiring_manager_hr_id text null references public.employees(hr_id) on update cascade on delete set null,
  recruitment_owner_hr_id text null references public.employees(hr_id) on update cascade on delete set null,
  grade text null,
  salary_band_min numeric null,
  salary_band_max numeric null,
  headcount_type text not null default 'replacement',
  replacement_for_hr_id text null,
  headcount integer not null default 1,
  priority text not null default 'normal',
  recruitment_deadline date null,
  status text not null default 'req_draft',
  notes text null,
  created_by text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recruitment_requisitions_headcount_type_check
    check (headcount_type in ('replacement', 'expansion')),
  constraint recruitment_requisitions_priority_check
    check (priority in ('low', 'normal', 'high', 'urgent')),
  constraint recruitment_requisitions_status_check
    check (status in (
      'req_draft', 'req_open', 'req_published', 'req_on_hold',
      'req_filled', 'req_closed', 'req_cancelled'
    ))
);

create index if not exists recruitment_requisitions_status_idx
  on public.recruitment_requisitions (status);
create index if not exists recruitment_requisitions_vacancy_id_idx
  on public.recruitment_requisitions (vacancy_id);
create index if not exists recruitment_requisitions_hiring_manager_idx
  on public.recruitment_requisitions (hiring_manager_hr_id);

-- 2. Candidates (PII; hybrid dedup) -----------------------------------------
create table if not exists public.recruitment_candidates (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  national_id text null,
  national_id_norm text null,
  email text null,
  email_norm text null,
  phone text null,
  phone_norm text null,
  governorate text null,
  current_employer text null,
  years_experience numeric null,
  expected_salary numeric null,
  notice_period text null,
  source text null,
  cv_reference_name text null,
  cv_external_url text null,
  notes text null,
  created_by text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists recruitment_candidates_national_id_norm_uidx
  on public.recruitment_candidates (national_id_norm) where national_id_norm is not null;
create unique index if not exists recruitment_candidates_email_norm_uidx
  on public.recruitment_candidates (email_norm) where email_norm is not null;
create unique index if not exists recruitment_candidates_phone_norm_uidx
  on public.recruitment_candidates (phone_norm) where phone_norm is not null;

-- 3. Applications (the pipeline spine) --------------------------------------
create table if not exists public.recruitment_applications (
  id uuid primary key default gen_random_uuid(),
  application_code text not null unique,
  requisition_id uuid not null references public.recruitment_requisitions(id) on update cascade on delete cascade,
  candidate_id uuid not null references public.recruitment_candidates(id) on update cascade on delete cascade,
  stage text not null default 'application_received',
  source text null,
  offer_id uuid null references public.job_offers(id) on update cascade on delete set null,
  converted_employee_hr_id text null references public.employees(hr_id) on update cascade on delete set null,
  current_owner_hr_id text null references public.employees(hr_id) on update cascade on delete set null,
  decision_reason text null,
  rejected_reason text null,
  last_stage_changed_at timestamptz not null default now(),
  created_by text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recruitment_applications_stage_check
    check (stage in (
      'application_received', 'in_candidate_pool', 'cv_screening', 'phone_screening',
      'interview_scheduling', 'hr_interview', 'hiring_manager_interview', 'final_selection',
      'offer_initiated', 'offer_sent', 'offer_accepted', 'offer_declined', 'offer_expired',
      'pre_boarding', 'hired', 'application_rejected', 'application_withdrawn'
    ))
);

create unique index if not exists recruitment_applications_active_uidx
  on public.recruitment_applications (requisition_id, candidate_id)
  where stage not in (
    'offer_declined', 'offer_expired', 'hired', 'application_rejected', 'application_withdrawn'
  );

create index if not exists recruitment_applications_requisition_idx
  on public.recruitment_applications (requisition_id);
create index if not exists recruitment_applications_candidate_idx
  on public.recruitment_applications (candidate_id);
create index if not exists recruitment_applications_stage_idx
  on public.recruitment_applications (stage);
create index if not exists recruitment_applications_offer_idx
  on public.recruitment_applications (offer_id);

-- 4. Reciprocal soft link on job_offers (no FK to the critical offer table) --
alter table public.job_offers
  add column if not exists application_id uuid null;
create index if not exists job_offers_application_id_idx
  on public.job_offers (application_id);

-- 5. Append-only application history -----------------------------------------
create table if not exists public.recruitment_application_events (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.recruitment_applications(id) on update cascade on delete cascade,
  from_stage text null,
  to_stage text null,
  action text not null,
  actor_hr_id text null,
  reason text null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists recruitment_application_events_app_idx
  on public.recruitment_application_events (application_id, created_at desc);

-- 6. Interviews (thin) -------------------------------------------------------
create table if not exists public.recruitment_interviews (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.recruitment_applications(id) on update cascade on delete cascade,
  interview_type text not null default 'hr',
  interviewer_hr_id text null references public.employees(hr_id) on update cascade on delete set null,
  scheduled_at timestamptz null,
  location text null,
  meeting_link text null,
  outcome text null,
  score jsonb not null default '{}'::jsonb,
  notes text null,
  created_by text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recruitment_interviews_type_check
    check (interview_type in ('phone', 'hr', 'hiring_manager'))
);

create index if not exists recruitment_interviews_app_idx
  on public.recruitment_interviews (application_id);

-- 7. File metadata -----------------------------------------------------------
create table if not exists public.recruitment_files (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid null references public.recruitment_candidates(id) on update cascade on delete cascade,
  application_id uuid null references public.recruitment_applications(id) on update cascade on delete cascade,
  kind text not null default 'cv',
  file_name text not null,
  mime_type text null,
  size_bytes bigint null,
  drive_file_id text null,
  external_url text null,
  uploaded_by_hr_id text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists recruitment_files_candidate_idx
  on public.recruitment_files (candidate_id);
create index if not exists recruitment_files_application_idx
  on public.recruitment_files (application_id);

-- RLS: service-role-only, browser roles revoked (PII). -----------------------
alter table public.recruitment_requisitions enable row level security;
alter table public.recruitment_candidates enable row level security;
alter table public.recruitment_applications enable row level security;
alter table public.recruitment_application_events enable row level security;
alter table public.recruitment_interviews enable row level security;
alter table public.recruitment_files enable row level security;

revoke all on public.recruitment_requisitions from anon, authenticated;
revoke all on public.recruitment_candidates from anon, authenticated;
revoke all on public.recruitment_applications from anon, authenticated;
revoke all on public.recruitment_application_events from anon, authenticated;
revoke all on public.recruitment_interviews from anon, authenticated;
revoke all on public.recruitment_files from anon, authenticated;

grant all on public.recruitment_requisitions to service_role;
grant all on public.recruitment_candidates to service_role;
grant all on public.recruitment_applications to service_role;
grant all on public.recruitment_application_events to service_role;
grant all on public.recruitment_interviews to service_role;
grant all on public.recruitment_files to service_role;

drop policy if exists phx_recruitment_requisitions_service_role on public.recruitment_requisitions;
create policy phx_recruitment_requisitions_service_role
  on public.recruitment_requisitions for all to service_role using (true) with check (true);

drop policy if exists phx_recruitment_candidates_service_role on public.recruitment_candidates;
create policy phx_recruitment_candidates_service_role
  on public.recruitment_candidates for all to service_role using (true) with check (true);

drop policy if exists phx_recruitment_applications_service_role on public.recruitment_applications;
create policy phx_recruitment_applications_service_role
  on public.recruitment_applications for all to service_role using (true) with check (true);

drop policy if exists phx_recruitment_application_events_service_role on public.recruitment_application_events;
create policy phx_recruitment_application_events_service_role
  on public.recruitment_application_events for all to service_role using (true) with check (true);

drop policy if exists phx_recruitment_interviews_service_role on public.recruitment_interviews;
create policy phx_recruitment_interviews_service_role
  on public.recruitment_interviews for all to service_role using (true) with check (true);

drop policy if exists phx_recruitment_files_service_role on public.recruitment_files;
create policy phx_recruitment_files_service_role
  on public.recruitment_files for all to service_role using (true) with check (true);

notify pgrst, 'reload schema';;
