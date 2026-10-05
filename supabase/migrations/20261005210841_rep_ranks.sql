-- rep_ranks
--
-- WHAT THIS CHANGES: three new service-role-only tables behind Phoenix Ranks, the shared board that
--   scores every medical rep of every line (owner, 2026-10-05):
--     * rep_rank_day_facts   one row per rep per Cairo day — the AM start clock, whether the day was
--                            worked, the day's expected weight, and the Phoenix CRM location counts
--                            the Field accuracy score is built from.
--     * rep_rank_kpi_months  one row per rep per month — the KPIs board's own row (KpiRepRow) for that
--                            month, stored so a quarter and a semester are CONSOLIDATED from the
--                            board's numbers (consolidateKpiRows) instead of re-derived.
--     * rep_rank_standings   one row per rep per window (day, week, month, quarter, semester) — the
--                            pillar scores, the total, the company and line positions.
--   `metrics` on rep_rank_standings holds the raw counts behind each score and is read by the ADMIN
--   twin only; the portal reads `pillars` (scores 0-100). Owner, 2026-10-05: "the metrics keep in
--   your back end or show it to the admin account. But for the reps, only … accuracy score".
-- WHY: the board is shared by every rep, so it is computed once a night as the system and read by
--   everyone, rather than recomputed per viewer (a semester is six KPIs boards).
-- ROLLBACK: drop table public.rep_rank_standings; drop table public.rep_rank_kpi_months;
--   drop table public.rep_rank_day_facts;  — nothing else reads them, and every row is recomputable.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create table if not exists public.rep_rank_day_facts (
  day date not null,
  hr_id_key text not null,
  rep_name text,
  -- Minutes past Cairo midnight of the day's first VERIFIED start (Early Birds' clock): the first GPS
  -- check-in, or the first countable Phoenix CRM visit for a started team. Null = no verified start.
  start_minutes integer,
  start_source text check (start_source is null or start_source in ('gps', 'first_visit')),
  submitted boolean not null default false,
  -- 0..1: how much of a working day this day is for this rep (employment, Thursday weight).
  expected_weight numeric(6, 4) not null default 0,
  visits integer not null default 0,
  -- Phoenix CRM AM/PM countable visits that day, and how many were saved at the place.
  -- `phoenix_located` leaves out a visit to a customer with no place to measure against.
  phoenix_countable integer not null default 0,
  phoenix_located integer not null default 0,
  phoenix_at_place integer not null default 0,
  computed_at timestamptz not null default now(),
  primary key (day, hr_id_key)
);

create index if not exists rep_rank_day_facts_rep_idx on public.rep_rank_day_facts (hr_id_key, day);

create table if not exists public.rep_rank_kpi_months (
  month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  hr_id_key text not null,
  row jsonb not null,
  computed_at timestamptz not null default now(),
  primary key (month, hr_id_key)
);

create table if not exists public.rep_rank_standings (
  window_kind text not null check (window_kind in ('day', 'week', 'month', 'quarter', 'semester')),
  window_key text not null,
  hr_id_key text not null,
  window_from date not null,
  window_to date not null,
  rep_name text not null,
  line_name text,
  area_name text,
  region_name text,
  ranked boolean not null default false,
  unranked_reason text,
  company_position integer,
  company_count integer,
  line_position integer,
  line_count integer,
  total_score numeric(6, 2),
  pillars jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  scoring_version integer not null,
  computed_at timestamptz not null default now(),
  primary key (window_kind, window_key, hr_id_key)
);

create index if not exists rep_rank_standings_rep_idx
  on public.rep_rank_standings (hr_id_key, window_kind, window_from);
create index if not exists rep_rank_standings_window_idx
  on public.rep_rank_standings (window_kind, window_from);

alter table public.rep_rank_day_facts enable row level security;
alter table public.rep_rank_kpi_months enable row level security;
alter table public.rep_rank_standings enable row level security;

revoke all on table public.rep_rank_day_facts from public, anon, authenticated;
revoke all on table public.rep_rank_kpi_months from public, anon, authenticated;
revoke all on table public.rep_rank_standings from public, anon, authenticated;
grant all on table public.rep_rank_day_facts to service_role;
grant all on table public.rep_rank_kpi_months to service_role;
grant all on table public.rep_rank_standings to service_role;

comment on table public.rep_rank_standings is
  'Phoenix Ranks (owner, 2026-10-05): one row per medical rep per window. pillars = scores 0-100 (shown to every rep); metrics = the raw counts behind them (admin twin only). Computed nightly by /api/cron/rep-ranks as the system.';

commit;
