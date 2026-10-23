-- Job leases: one row per singleton background loop, naming the ONE process allowed to run it
-- (23 Oct 2026 technical audit, P5-05).
--
-- WHY. The iReports360 live poller (src/lib/crm/live-poller.ts) is a module-level singleton — one copy
-- per PROCESS — but two processes can be alive at once: the old and the new container overlap during
-- every deploy, and the worker has a standby. Each then ran its own poller: two vendor sessions, every
-- deep run twice, two writers on the same CRM tables. A process now claims this row before each tick
-- and renews it every minute while it holds it; a process that cannot claim it skips its tick, and
-- takes over once the holder stops renewing and the lease runs out (three minutes).
--
-- SAFE IN BOTH ORDERS. The code ships first and treats a missing claim_job_lease() as "held" — exactly
-- the behaviour before this file — so merging the code before applying this changes nothing. Applying
-- this before the code ships creates an empty table nothing reads.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration creates one new table and one function. It changes no existing data.

begin;
set local lock_timeout = '5s';

create table if not exists public.job_leases (
  job_key    text primary key,
  -- host:pid:random of the process holding it (src/lib/platform/job-lease.ts newJobLeaseHolderId).
  holder     text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.job_leases enable row level security;

-- Service role only: the worker process claims with its own service key. Nothing in a browser
-- touches this table.
drop policy if exists phx_job_leases_service_role on public.job_leases;
create policy phx_job_leases_service_role
  on public.job_leases
  for all
  to service_role
  using (true)
  with check (true);

revoke all on public.job_leases from anon, authenticated;
grant select, insert, update on public.job_leases to service_role;

comment on table public.job_leases is
  'One row per singleton background loop (e.g. crm-live-poll): the process allowed to run it and until when. Claimed and renewed through claim_job_lease(); an unrenewed lease simply runs out.';

-- Claims or renews p_job_key for p_holder. Takes the row when it is free, already ours, or expired;
-- otherwise leaves it alone. ONE statement, so two claimants racing on the same key cannot both win:
-- the insert's conflict arm re-checks the row under its lock.
create or replace function public.claim_job_lease(p_job_key text, p_holder text, p_ttl_seconds integer)
returns table (held boolean, holder text, expires_at timestamptz)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public
as $$
#variable_conflict use_column
begin
  if p_job_key is null or p_holder is null or p_ttl_seconds is null or p_ttl_seconds < 1 or p_ttl_seconds > 3600 then
    raise exception 'claim_job_lease: job key, holder and a ttl between 1 and 3600 seconds are required';
  end if;

  insert into public.job_leases as l (job_key, holder, expires_at, updated_at)
  values (p_job_key, p_holder, now() + make_interval(secs => p_ttl_seconds), now())
  on conflict (job_key) do update
    set holder = excluded.holder,
        expires_at = excluded.expires_at,
        updated_at = now()
    where l.holder = excluded.holder or l.expires_at < now();

  return query
    select (l.holder = p_holder) as held, l.holder, l.expires_at
    from public.job_leases l
    where l.job_key = p_job_key;
end;
$$;

revoke execute on function public.claim_job_lease(text, text, integer) from public, anon, authenticated;
grant execute on function public.claim_job_lease(text, text, integer) to service_role;

commit;
