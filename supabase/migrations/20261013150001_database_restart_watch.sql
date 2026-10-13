-- The database restart watch.
--
-- WHY THIS EXISTS. The production Postgres crash-restarted twice in three days — 2026-10-10
-- 11:05:48 and 2026-10-12 19:04:50 Cairo — and nothing anywhere said so either time. The owner
-- found both himself. Each restart was unclean ("database system was not properly shut down;
-- automatic recovery in progress") with no shutdown request and no PANIC, each self-recovered
-- inside a minute, and each threw a burst of Cloudflare 521/520/525 and PostgREST 503 at every
-- REST caller: 79 failed requests over 13 paths on 12 Oct. /api/healthz answered 200 throughout,
-- because it does not touch the database. See docs/observability.md.
--
-- WHY pg_postmaster_start_time() AND NOT THE LOGS. It is one statement, it is live, and it cannot
-- age out — the 10 Oct logs were already beyond the log window when this was built, and only
-- cron.job_run_details' 'server restarted' still proved that day. The start time moving IS the
-- restart; no log parsing, no edge-code matching, no guess.
--
-- WHY A TABLE AND NOT A CACHED VALUE IN THE APP. The app restarts on every deploy, so an in-process
-- last-seen value would be lost exactly when a restart is most likely to be missed — and two
-- Railway replicas would each hold their own. One row per observed restart is also the history
-- nobody had when the second one arrived.

create table if not exists public.database_restarts (
  postmaster_start_at timestamptz primary key,
  noticed_at timestamptz not null default now()
);

comment on table public.database_restarts is
  'One row per distinct pg_postmaster_start_time() ever observed by note_database_restart(). A new row means the database restarted since the last check. Written only by that function; carries no business data.';

alter table public.database_restarts enable row level security;
revoke all on table public.database_restarts from anon, authenticated;

-- Reads the live start time, records it if it is new, and reports whether it moved.
--
-- SECURITY DEFINER because pg_postmaster_start_time() and the insert both have to happen under an
-- owner that can see them, and the function is the whole surface: execute is granted to
-- service_role alone, so no browser role can call it and the table is not reachable at all.
--
-- is_new is TRUE only when this call inserted the row. previous_start_at is NULL on the very first
-- sighting, which is how the caller tells "the database restarted" from "this watch has never run
-- before" — the migration seeds the current value below precisely so the first real call is quiet.
create or replace function public.note_database_restart()
returns table (current_start_at timestamptz, previous_start_at timestamptz, is_new boolean)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_start timestamptz := pg_catalog.pg_postmaster_start_time();
  v_prev timestamptz;
  v_inserted timestamptz;
begin
  select max(r.postmaster_start_at) into v_prev
    from public.database_restarts r
   where r.postmaster_start_at < v_start;

  insert into public.database_restarts (postmaster_start_at)
  values (v_start)
  on conflict (postmaster_start_at) do nothing
  returning database_restarts.postmaster_start_at into v_inserted;

  return query select v_start, v_prev, v_inserted is not null;
end;
$$;

comment on function public.note_database_restart() is
  'Records the live pg_postmaster_start_time() and reports whether it moved since the last call. Called every 15 minutes by the job-heartbeat sweep; service_role only.';

revoke execute on function public.note_database_restart() from public, anon, authenticated;
grant execute on function public.note_database_restart() to service_role;

-- Seed the CURRENT start time, so the first call after this migration reports is_new = false and
-- the restart that prompted this work does not alarm as if it had just happened.
insert into public.database_restarts (postmaster_start_at)
values (pg_catalog.pg_postmaster_start_time())
on conflict (postmaster_start_at) do nothing;
