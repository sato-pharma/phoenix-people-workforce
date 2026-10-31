-- coaching_skills_survey
--
-- WHAT THIS CHANGES:
--   * coaching_skills_survey_skills    — the coaching matrix skills (the "Skills" sheet of
--     "Team Skills Survey 2026"), seeded with its ten skills word for word. The Training Manager
--     renames, describes, reorders, adds and turns them off.
--   * coaching_skills_survey_settings  — ONE row: the Training Manager's settings from the workbook
--     (target score 4.0, capability weight 0.8, years for full experience score 5, the four
--     experience bands).
--   * coaching_skills_surveys          — the District Manager's survey: one row per team member per
--     quarter, ten 0–5 ratings in `scores` (a skill missing from the object = not observed, which is
--     left out of every average, while 0 is a real score), and the development priorities.
--   * employees.total_experience_years + total_experience_as_of — HR fills a person's TOTAL years in
--     the role (at Sato and before); a trigger stamps the as-of date whenever the number changes, so
--     the survey's "Years in Role" keeps counting from the day HR typed it.
-- WHY: the owner, 2026-10-31 — the Team Coaching Skills Survey replaces the old coaching form. The
--   District Manager rates his team, the Training Manager owns the settings and the skills list, the
--   ranking and the analysis are calculated, and the person rated never sees any of it.
-- ROLLBACK:
--   drop table public.coaching_skills_surveys; drop table public.coaching_skills_survey_settings;
--   drop table public.coaching_skills_survey_skills;
--   drop trigger employees_stamp_total_experience_as_of on public.employees;
--   drop function public.phx_stamp_total_experience_as_of();
--   alter table public.employees drop column total_experience_as_of, drop column total_experience_years;
--   (additive only — nothing existing is changed, so the rollback loses only survey data.)
--
-- VERIFY:
--   select relname, relrowsecurity from pg_class where relname like 'coaching_skills_survey%';
--   select key, display_order, name from public.coaching_skills_survey_skills order by display_order;
--   select * from public.coaching_skills_survey_settings;
--   select column_name, data_type from information_schema.columns
--    where table_name = 'employees' and column_name like 'total_experience%';
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

set local lock_timeout = '5s';

-- HR's field. numeric(4,1): "2" or "0.5", as the workbook's own validation asked (0 to 60).
alter table public.employees
  add column if not exists total_experience_years numeric(4,1),
  add column if not exists total_experience_as_of date;

alter table public.employees
  drop constraint if exists employees_total_experience_years_range;
alter table public.employees
  add constraint employees_total_experience_years_range
  check (total_experience_years is null or (total_experience_years >= 0 and total_experience_years <= 60));

comment on column public.employees.total_experience_years is
  'Total years of experience in the role, at Sato and before. Filled by HR. Read by the Team Coaching Skills Survey as Years in Role.';
comment on column public.employees.total_experience_as_of is
  'The Cairo day total_experience_years was last changed. Stamped by trigger; Years in Role = the years plus the time since this day.';

create or replace function public.phx_stamp_total_experience_as_of()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.total_experience_years is not null then
      new.total_experience_as_of := (now() at time zone 'Africa/Cairo')::date;
    end if;
  elsif new.total_experience_years is distinct from old.total_experience_years then
    new.total_experience_as_of := case
      when new.total_experience_years is null then null
      else (now() at time zone 'Africa/Cairo')::date
    end;
  end if;
  return new;
end;
$$;

revoke execute on function public.phx_stamp_total_experience_as_of() from public, anon, authenticated;
grant execute on function public.phx_stamp_total_experience_as_of() to service_role;

drop trigger if exists employees_stamp_total_experience_as_of on public.employees;
create trigger employees_stamp_total_experience_as_of
  before insert or update of total_experience_years on public.employees
  for each row execute function public.phx_stamp_total_experience_as_of();

-- The skills list — the workbook's "Skills" sheet.
create table if not exists public.coaching_skills_survey_skills (
  key text primary key,
  display_order integer not null,
  name text not null,
  good_looks_like text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  constraint coaching_skills_survey_skills_key_shape check (key ~ '^[a-z0-9_]{1,60}$'),
  constraint coaching_skills_survey_skills_name_present check (length(btrim(name)) > 0)
);

insert into public.coaching_skills_survey_skills (key, display_order, name, good_looks_like) values
  ('pre_call_planning', 1, 'Pre-call planning',
   'Sets clear call objectives, reviews customer history and prepares key messages and questions before the visit.'),
  ('opening_the_call', 2, 'Opening the call',
   'Builds rapport quickly, states the purpose of the visit and agrees the agenda with the customer.'),
  ('probing_active_listening', 3, 'Probing & active listening',
   'Asks open questions, listens carefully and uncovers the customer''s real needs before presenting.'),
  ('message_delivery', 4, 'Message delivery',
   'Presents key product messages clearly, accurately and in approved wording, linked to the customer''s needs.'),
  ('handling_objections', 5, 'Handling objections',
   'Listens, clarifies and answers concerns with facts and confidence, without becoming defensive.'),
  ('closing_gaining_commitment', 6, 'Closing & gaining commitment',
   'Summarises what was agreed and secures a clear next step or commitment from the customer.'),
  ('post_call_analysis_follow_up', 7, 'Post-call analysis & follow-up',
   'Reviews the call, records useful notes and follows up on actions on time.'),
  ('product_disease_knowledge', 8, 'Product & disease knowledge',
   'Shows accurate, up-to-date knowledge of products, indications and the market.'),
  ('compliance_ethics', 9, 'Compliance & ethics',
   'Follows promotional rules and company policies and reports adverse events correctly.'),
  ('territory_time_management', 10, 'Territory & time management',
   'Plans visits and routes, prioritises key customers and uses field time efficiently.')
on conflict (key) do nothing;

-- The Training Manager's settings — one row.
create table if not exists public.coaching_skills_survey_settings (
  id integer primary key default 1,
  target_score numeric(3,1) not null default 4.0,
  capability_weight numeric(4,3) not null default 0.8,
  full_experience_years numeric(4,1) not null default 5,
  experience_bands jsonb not null default '[
    {"label": "Less than 1 year", "from": 0, "to": 1},
    {"label": "1 to 3 years", "from": 1, "to": 3},
    {"label": "3 to 5 years", "from": 3, "to": 5},
    {"label": "5 years or more", "from": 5, "to": 100}
  ]'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text,
  constraint coaching_skills_survey_settings_single_row check (id = 1),
  constraint coaching_skills_survey_settings_target check (target_score >= 0 and target_score <= 5),
  constraint coaching_skills_survey_settings_weight check (capability_weight >= 0 and capability_weight <= 1),
  constraint coaching_skills_survey_settings_years check (full_experience_years > 0),
  constraint coaching_skills_survey_settings_bands check (jsonb_typeof(experience_bands) = 'array')
);

insert into public.coaching_skills_survey_settings (id) values (1) on conflict (id) do nothing;

-- The District Manager's survey — one row per team member per quarter.
create table if not exists public.coaching_skills_surveys (
  id uuid primary key default gen_random_uuid(),
  survey_date date not null,
  survey_year integer not null,
  survey_quarter integer not null,
  rater_hr_id text not null references public.employees (hr_id) on delete restrict,
  rater_role text not null,
  member_hr_id text not null references public.employees (hr_id) on delete restrict,
  member_role text not null,
  district_name text,
  line_id bigint,
  area_id bigint,
  team_id bigint,
  years_in_role numeric(4,1),
  scores jsonb not null default '{}'::jsonb,
  development_priorities text,
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),
  updated_by text,
  constraint coaching_skills_surveys_quarter check (survey_quarter between 1 and 4),
  constraint coaching_skills_surveys_year check (survey_year between 2024 and 2100),
  constraint coaching_skills_surveys_scores_object check (jsonb_typeof(scores) = 'object'),
  constraint coaching_skills_surveys_years_range check (years_in_role is null or (years_in_role >= 0 and years_in_role <= 100)),
  constraint coaching_skills_surveys_one_per_quarter unique (member_hr_id, survey_year, survey_quarter)
);

create index if not exists coaching_skills_surveys_period_idx
  on public.coaching_skills_surveys (survey_year, survey_quarter);
create index if not exists coaching_skills_surveys_rater_idx
  on public.coaching_skills_surveys (rater_hr_id);

-- Service role only: every read and write goes through the app, which scopes it per viewer.
alter table public.coaching_skills_survey_skills enable row level security;
alter table public.coaching_skills_survey_settings enable row level security;
alter table public.coaching_skills_surveys enable row level security;

drop policy if exists coaching_skills_survey_skills_service_role on public.coaching_skills_survey_skills;
create policy coaching_skills_survey_skills_service_role on public.coaching_skills_survey_skills
  for all to service_role using (true) with check (true);
drop policy if exists coaching_skills_survey_settings_service_role on public.coaching_skills_survey_settings;
create policy coaching_skills_survey_settings_service_role on public.coaching_skills_survey_settings
  for all to service_role using (true) with check (true);
drop policy if exists coaching_skills_surveys_service_role on public.coaching_skills_surveys;
create policy coaching_skills_surveys_service_role on public.coaching_skills_surveys
  for all to service_role using (true) with check (true);

revoke all on table public.coaching_skills_survey_skills from public, anon, authenticated;
revoke all on table public.coaching_skills_survey_settings from public, anon, authenticated;
revoke all on table public.coaching_skills_surveys from public, anon, authenticated;
grant all on table public.coaching_skills_survey_skills to service_role;
grant all on table public.coaching_skills_survey_settings to service_role;
grant all on table public.coaching_skills_surveys to service_role;

notify pgrst, 'reload schema';

commit;
