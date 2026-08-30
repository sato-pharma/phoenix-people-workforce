-- The job heartbeat register — an IN-HOUSE dead-man's switch for every scheduled job.
--
-- WHY THIS EXISTS. Until now the only thing detecting a cron job that stopped running was
-- Healthchecks.io, an external service on its free tier. That tier holds exactly 20 checks, and on
-- 2026-08-30 it was full: `POST /checks/` returned HTTP 403 for the 21st, so three real jobs
-- (`crm-contact-lists`, `expense-claims-refresh`, `recruitment-cv-digest`) had switch code shipped
-- and nothing watching them. The owner declined a paid plan and asked for a free path.
--
-- The free path is not another vendor. The whole external dependency runs through ONE function,
-- `pingDeadMansSwitch(slug, outcome, detail)` — about twenty lines and a single HTTP POST — and all
-- 24 declared jobs call it, the sweeper below included. Giving that function a second, local
-- backend costs no route changes at all, has no cap, and lands the alert on a channel the owner
-- already reads.
--
-- WHAT A ROW MEANS. One row per declared job slug. It is a record of what a job LAST REPORTED
-- ABOUT ITSELF — never an observation of whether the job is running. The distinction matters the
-- same way it does on `mailbox_offboarding_tasks`: a stale row means "nothing has reported since",
-- which is exactly the signal, but a fresh row only means the process got as far as its own ping.
--
-- WHAT THIS DOES NOT REPLACE. If Phoenix itself is down, nothing here runs and nothing here
-- alerts — that is precisely the property an outside service buys, and it is why the existing 20
-- Healthchecks checks are deliberately left in place rather than migrated. This register covers
-- the jobs that have no external slot, and adds the "last run reported FAILURE" signal, which the
-- external switch shows only on a dashboard nobody is looking at.
--
-- THE SWEEPER'S OWN BLIND SPOT IS REAL AND IS NOT PAPERED OVER. `phoenix-job-heartbeat-sweep` is
-- itself a declared job with a row in this table, so it verifies itself whenever it runs — but a
-- sweeper that stops entirely cannot report its own silence. Closing that needs one external check,
-- which needs one freed Healthchecks slot. Until that exists the hole is documented in
-- docs/observability.md rather than hidden behind a green dashboard, because a monitoring layer
-- that overstates its own coverage is worse than one that admits a gap.

begin;

create table if not exists public.job_heartbeats (
  -- The dead-man's-switch slug, e.g. `phoenix-expense-claims-refresh`. Matches the Healthchecks
  -- slug exactly, so the two backends address the same job by the same name and a reader moving
  -- between the dashboard and this table never has to translate.
  slug text primary key check (char_length(trim(slug)) > 0),

  -- When the register FIRST knew about this slug. The bootstrap anchor: a declared job that has
  -- never reported cannot be called stranded until at least one scheduled fire has passed since we
  -- started watching it. Without this, every newly declared job alarms the moment it is deployed.
  first_seen_at timestamptz not null default now(),

  -- What the last report said. NULL means the row was created by the sweeper's bootstrap and the
  -- job has not reported at all yet — deliberately distinct from 'fail', which means it ran and
  -- said so.
  last_outcome text check (last_outcome in ('success', 'fail')),

  last_success_at timestamptz,
  last_fail_at timestamptz,

  -- The detail string from the most recent report, whatever its outcome — the same text sent to
  -- Healthchecks as the ping body. Capped by the writer, not here.
  last_detail text,

  updated_at timestamptz not null default now()
);

comment on table public.job_heartbeats is
  'In-house dead-man''s switch. One row per scheduled job slug, recording what that job LAST '
  'REPORTED ABOUT ITSELF. A stale row means nothing has reported since — it is never an '
  'observation that the job is or is not running. Written by pingDeadMansSwitch(); swept by '
  '/api/cron/job-heartbeat-sweep.';

comment on column public.job_heartbeats.first_seen_at is
  'Bootstrap anchor. A declared job that has never reported is not stranded until a scheduled fire '
  'has passed since this moment — otherwise every newly declared job alarms on deploy.';

comment on column public.job_heartbeats.last_outcome is
  'NULL = bootstrapped, never reported. ''fail'' = it ran and reported failure. The two are '
  'different signals and must not be collapsed.';

-- The sweeper reads the whole table (24 rows) every 15 minutes and never filters, so no index
-- beyond the primary key earns its keep here.

-- RLS on with no policies and no authenticated grant: the house norm (AGENTS.md — 222 of 308
-- tables). Every read and write goes through the service-role client behind a cron-auth or
-- assertPermission call, so a policy would be decoration. This table also carries no personal
-- data — only job names and timestamps.
alter table public.job_heartbeats enable row level security;

commit;
