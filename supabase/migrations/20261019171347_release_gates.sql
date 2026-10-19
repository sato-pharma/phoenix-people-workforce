-- The release gate: one row per commit whose checks all passed (owner, 2026-10-19 — "speed up the
-- Railway deploy ... which is faster and costs less").
--
-- WHY. Railway's "Wait for CI" holds a merge's build until every check finishes, so the build (4 to 10
-- minutes, and its speed is Railway's builder's, not ours) starts only AFTER the checks end. With the
-- two running side by side the merge reaches production in about as long as the slower of them.
-- That is only safe if the new container will not take traffic until CI has passed, and the only
-- thing Railway asks a new container is its healthcheck. So the container's readiness probe
-- (/api/readyz) answers 503 until a row for its own commit exists here, and Railway keeps the old
-- version serving until the probe passes. The row is written by the last job of ci.yml, on `main`
-- only, after `validate` and `checks` (the two required checks) are both green.
--
-- WHY A TABLE. The container already reaches Supabase on every probe, and it already holds the service
-- key, so this adds no credential and no network path. The alternatives all needed a new secret on
-- Railway (a GitHub token to read check runs) or a third system.
--
-- NOTHING IS EVER DELETED OR PRUNED. A container that restarts weeks after its deploy asks again, and a
-- pruned row would fail that restart's probe. A row is ~100 bytes and merges are tens a day.
--
-- SAFE IN BOTH DIRECTIONS. A container whose environment is not production Railway (a laptop, CI, any
-- other host) never reads this table. A production container with no row for its commit stays
-- not-ready, which is the fail-closed answer: the previous version keeps serving.

create table if not exists public.release_gates (
  -- The full 40-hex commit the checks ran on — the same value Railway injects into the container as
  -- RAILWAY_GIT_COMMIT_SHA. CHECK-enforced so a short or upper-case sha cannot be recorded and then
  -- never match.
  sha             text primary key,
  recorded_at     timestamptz not null default now(),
  -- The Actions run that proved it, so a row can be traced to the checks behind it.
  workflow_run_id text,
  constraint release_gates_sha_is_full_commit check (sha ~ '^[0-9a-f]{40}$')
);

alter table public.release_gates enable row level security;

-- Service role only: CI writes with the production service key and the container reads with its own.
-- Nothing in a browser touches this table.
drop policy if exists phx_release_gates_service_role on public.release_gates;
create policy phx_release_gates_service_role
  on public.release_gates
  for all
  to service_role
  using (true)
  with check (true);

revoke all on public.release_gates from anon, authenticated;
grant select, insert on public.release_gates to service_role;

comment on table public.release_gates is
  'One row per commit on main whose required checks (validate, checks) all passed. A production container answers /api/readyz 503 until its own commit is here, so a build that finishes before CI does cannot take traffic early. Never pruned.';
