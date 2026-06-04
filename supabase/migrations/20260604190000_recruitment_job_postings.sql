-- Recruitment / ATS — Phase 4 public job postings + application intake.
--
-- A posting wraps a requisition with a public token; candidates apply via
-- /apply/<token> with no login. Applications carry a hashed submitter IP for
-- rate-limiting. Service-role-only RLS (the public path runs server-side under a
-- system context; nothing is granted to browser roles).

create table if not exists public.recruitment_job_postings (
  id uuid primary key default gen_random_uuid(),
  requisition_id uuid not null references public.recruitment_requisitions(id) on update cascade on delete cascade,
  public_token text not null unique,
  title text not null default '',
  status text not null default 'open',
  created_by text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recruitment_job_postings_status_check check (status in ('open', 'closed')),
  constraint recruitment_job_postings_requisition_unique unique (requisition_id)
);

create index if not exists recruitment_job_postings_requisition_idx
  on public.recruitment_job_postings (requisition_id);

-- Hashed submitter IP on public applications (rate-limiting only).
alter table public.recruitment_applications
  add column if not exists submitted_ip_hash text null;
create index if not exists recruitment_applications_submitted_ip_idx
  on public.recruitment_applications (submitted_ip_hash);

alter table public.recruitment_job_postings enable row level security;
revoke all on public.recruitment_job_postings from anon, authenticated;
grant all on public.recruitment_job_postings to service_role;

drop policy if exists phx_recruitment_job_postings_service_role on public.recruitment_job_postings;
create policy phx_recruitment_job_postings_service_role
  on public.recruitment_job_postings for all to service_role using (true) with check (true);

notify pgrst, 'reload schema';
