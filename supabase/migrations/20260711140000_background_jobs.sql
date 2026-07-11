-- Durable background-job queue for async heavy exports/imports.
--
-- Motivation: on Cloud Run a request is capped at ~300s and memory is per-instance.
-- Building large workbooks/imports inside the user's request risks timeout/OOM. This
-- queue lets a request enqueue work, return immediately, and a worker build the result
-- into Storage for the user to poll + download. Additive + non-destructive.

create table if not exists public.background_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null,
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed')),
  params jsonb not null default '{}'::jsonb,
  requested_by text,
  progress integer not null default 0,
  result_bucket text,
  result_path text,
  result_filename text,
  result_content_type text,
  error text,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists idx_background_jobs_status_created on public.background_jobs (status, created_at);
create index if not exists idx_background_jobs_requested_by on public.background_jobs (requested_by);

-- Service-role only; the application enforces access in code (same pattern as
-- app_error_events). RLS enabled with no policies => deny-all for anon/authenticated.
alter table public.background_jobs enable row level security;

-- Atomically claim the next queued job. FOR UPDATE SKIP LOCKED guarantees that
-- concurrent worker instances never grab the same job. Returns a row with a NULL id
-- when the queue is empty.
create or replace function public.claim_next_background_job(p_job_types text[])
returns public.background_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.background_jobs;
begin
  update public.background_jobs
     set status = 'processing',
         started_at = now(),
         updated_at = now(),
         attempts = attempts + 1
   where id = (
     select id
       from public.background_jobs
      where status = 'queued'
        and job_type = any (p_job_types)
      order by created_at
      for update skip locked
      limit 1
   )
  returning * into claimed;

  return claimed;
end;
$$;

-- The worker calls this with the service-role key; it must not be publicly callable.
revoke all on function public.claim_next_background_job(text[]) from public;
revoke all on function public.claim_next_background_job(text[]) from anon;
revoke all on function public.claim_next_background_job(text[]) from authenticated;

-- Private bucket that holds generated export artifacts (downloaded through the app,
-- never served publicly).
insert into storage.buckets (id, name, public)
values ('job-exports', 'job-exports', false)
on conflict (id) do nothing;
