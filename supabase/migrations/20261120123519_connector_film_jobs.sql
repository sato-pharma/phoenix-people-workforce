-- connector_film_jobs — the ChatGPT connector's film queue, the name list its masking reads, and room
-- in the job-exports bucket for a film of up to twenty minutes.
--
-- WHAT THIS CHANGES:
--   1. public.connector_film_jobs — a new, empty table. One row per film the owner or the CEO asks
--      ChatGPT to make (phoenix_make_film): the script (scenes, narration, page addresses), who asked,
--      and where the render stands. The worker service renders a queued row into an MP4 and links the
--      finished file through connector_files. Read and written by the server only: RLS on, no policy,
--      and public, anon and authenticated hold no privilege.
--   2. public.connector_film_mask_names() — a read-only function returning, as ONE jsonb array, every
--      distinct person, doctor, customer and pharmacy name the masking swaps for a made-up one before
--      a frame is taken (two words or more, five characters or more). SECURITY DEFINER, executable by
--      service_role only: PUBLIC, anon and authenticated are revoked.
--   3. storage.buckets 'job-exports': file_size_limit 50 MB -> 256 MB, so a long film can be stored.
--      The bucket stays private and its allowed types are unchanged (mp4 is already allowed, #656).
-- WHY: the owner asked for ChatGPT to make branding films of Phoenix, up to about twenty minutes, an
--   overview and then one episode per module (20 Nov 2026), with masked data, a voice-over and captions.
--   Account: docs/phoenix-intelligence/CHATGPT_DATA_CONNECTOR.md, "Films".
-- ROLLBACK: drop function if exists public.connector_film_mask_names();
--           drop table if exists public.connector_film_jobs;
--           update storage.buckets set file_size_limit = 52428800 where id = 'job-exports';
--   (ship the code revert FIRST: phoenix_make_film writes this table.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This change is neither destructive nor bulk: one new, empty table, one read-only function, one limit raised.

begin;

create table if not exists public.connector_film_jobs (
  id                uuid primary key default gen_random_uuid(),
  login_id          text not null references public.app_auth_users(login_id) on update cascade on delete cascade,
  hr_id             text,
  role              text not null,
  -- The account's session_version when the film was asked for: the render re-checks the account live and
  -- stops when the password was changed or the account was signed out everywhere since.
  session_version   integer not null,
  title             text not null,
  script            jsonb not null,
  status            text not null default 'queued' check (status in ('queued', 'rendering', 'done', 'failed')),
  -- { "scene": n, "scenes": total, "stage": "words a person reads" }
  progress          jsonb not null default '{}'::jsonb,
  file_id           uuid references public.connector_files(id) on delete set null,
  duration_seconds  numeric,
  voice_used        boolean,
  error             text,
  claimed_by        text,
  created_at        timestamptz not null default now(),
  started_at        timestamptz,
  finished_at       timestamptz
);

create index if not exists connector_film_jobs_queue_idx on public.connector_film_jobs (status, created_at);
create index if not exists connector_film_jobs_login_idx on public.connector_film_jobs (login_id, created_at desc);

alter table public.connector_film_jobs enable row level security;
revoke all on table public.connector_film_jobs from public;
revoke all on table public.connector_film_jobs from anon;
revoke all on table public.connector_film_jobs from authenticated;
grant select, insert, update, delete on table public.connector_film_jobs to service_role;

comment on table public.connector_film_jobs is
  'Films the owner or the CEO asked ChatGPT to make of Phoenix (phoenix_make_film). Rendered by the worker service into an MP4 with masked data, a voice-over and captions; the file is linked through connector_files. Server only: RLS on, no policy.';

create or replace function public.connector_film_mask_names()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(distinct n), '[]'::jsonb)
  from (
    select btrim(v) as n
    from (
      select full_name as v from public.employees
      union all select name_ar from public.employees
      union all select full_name from public.ats_candidates
      union all select candidate_name from public.offers
      union all select full_name from public.medical_insurance_members
      union all select name from public.crm_contacts
      union all select name_ar from public.crm_contacts
      union all select contact_name from public.ireports360_contacts
      union all select contact_name_ar from public.ireports360_contacts
      union all select name from public.phoenix_crm_customers
      union all select primary_pharmacy_name from public.phoenix_crm_customers
      union all select pharmacy_name from public.direct_order_pharmacies
      union all select doctor_name from public.direct_order_pharmacies
      union all select customer_name from public.source_of_sales_customer_map
    ) raw
    where v is not null
  ) names
  where length(n) >= 5 and n ~ '\s';
$$;

revoke execute on function public.connector_film_mask_names() from public, anon, authenticated;
grant execute on function public.connector_film_mask_names() to service_role;

comment on function public.connector_film_mask_names() is
  'Every distinct person, doctor, customer and pharmacy name (two words or more) the ChatGPT connector''s film masking swaps for a made-up one. Service role only.';

update storage.buckets set file_size_limit = 268435456 where id = 'job-exports';

commit;
