-- App Error Events — self-hosted crash/error monitor
--
-- Records unhandled application errors (server-side uncaught request errors
-- and client-side crashes) tagged by HR ID and module, so admins can see who
-- hit what error where without depending on a third-party SaaS free tier.
--
-- SCOPE: real bugs/crashes only — not routine "permission denied" or
-- validation-failed responses, which are handled ad hoc across API routes
-- with no single capture point.
--
-- DESIGN:
--   * RLS is ENABLED but no permissive policies are defined — matching the
--     existing Phoenix pattern (see report_it_reports): the app layer uses
--     the service-role client (bypasses RLS) for both writes and reads, and
--     enforces the "admin:read" permission check in application code before
--     ever calling the read path.
--   * hr_id/login_id/role are denormalised snapshots of the caller at the
--     time of the error (not FKs) — the caller may be a guest, or an
--     employee record may later change/move, and the log should reflect
--     what was true when the error happened.
--   * message/stack are length-capped at insert time by the application
--     (src/lib/error-monitor/service.ts), but a generous check constraint
--     backstops that so no single row can bloat the table indefinitely.
--
-- SAFETY: all statements are idempotent (IF NOT EXISTS / OR REPLACE).

begin;

create table if not exists app_error_events (
  id            uuid        primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),

  -- Where the error was captured
  source        text        not null check (source in ('server', 'client')),
  route_type    text,       -- server-only: 'render' | 'route' | 'action'

  -- Who hit it (denormalised snapshot, not an FK — see design note above)
  hr_id         text,
  login_id      text,
  role          text,

  -- Where it happened
  module_key    text        not null default 'other',
  module_label  text        not null default 'Other',
  route         text,

  -- What happened
  message       text        not null check (char_length(message) <= 4000),
  stack         text        check (stack is null or char_length(stack) <= 4000),
  digest        text,       -- React error boundary digest, when present

  -- Release/environment context
  environment   text,
  release       text,
  user_agent    text
);

create index if not exists idx_app_error_events_hr_id
  on app_error_events (hr_id);

create index if not exists idx_app_error_events_module_key
  on app_error_events (module_key);

create index if not exists idx_app_error_events_created_at
  on app_error_events (created_at desc);

alter table app_error_events enable row level security;

-- Ask PostgREST to refresh its schema cache.
notify pgrst, 'reload schema';

commit;
