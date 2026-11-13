-- Phoenix Workforce Coaching & Field Excellence module.
-- Database layer only. Idempotent and defensive for fresh environments.
-- No existing payroll, sales, expenses, employees, organogram, or auth tables are modified.

create extension if not exists pgcrypto;

create sequence if not exists public.coaching_report_number_seq;

create table if not exists public.coaching_reports (
  id uuid primary key default gen_random_uuid(),
  report_number text unique not null default (
    'CR-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.coaching_report_number_seq')::text, 6, '0')
  ),
  medical_rep_hr_id text not null references public.employees(hr_id) on update cascade on delete restrict,
  coach_hr_id text not null references public.employees(hr_id) on update cascade on delete restrict,
  coach_role text null,
  line_id bigint null references public.lines(id) on update cascade on delete set null,
  area_id bigint null references public.areas(id) on update cascade on delete set null,
  team_id bigint null references public.teams(id) on update cascade on delete set null,
  coaching_date date not null,
  coaching_month int generated always as (extract(month from coaching_date)::int) stored,
  coaching_quarter int generated always as (extract(quarter from coaching_date)::int) stored,
  coaching_year int generated always as (extract(year from coaching_date)::int) stored,
  status text not null default 'draft',
  actual_score numeric(10, 2) not null default 0,
  max_score numeric(10, 2) not null default 120,
  final_score_percent numeric(6, 2) not null default 0,
  performance_zone text null,
  area_of_development text null,
  strength_points text null,
  general_remarks text null,
  employee_acknowledged boolean not null default false,
  acknowledged_at timestamptz null,
  submitted_at timestamptz null,
  locked_at timestamptz null,
  created_by text null,
  updated_by text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint coaching_reports_status_check
    check (status in ('draft', 'submitted', 'reviewed_by_employee', 'locked', 'cancelled')),
  constraint coaching_reports_score_bounds_check
    check (actual_score >= 0 and max_score > 0 and actual_score <= max_score),
  constraint coaching_reports_percent_bounds_check
    check (final_score_percent >= 0 and final_score_percent <= 100),
  constraint coaching_reports_zone_check
    check (
      performance_zone is null
      or performance_zone in ('critical_red', 'red_zone', 'yellow_zone', 'green_zone', 'excellence_zone')
    )
);

alter table public.coaching_reports add column if not exists report_number text;
alter table public.coaching_reports add column if not exists medical_rep_hr_id text;
alter table public.coaching_reports add column if not exists coach_hr_id text;
alter table public.coaching_reports add column if not exists coach_role text null;
alter table public.coaching_reports add column if not exists line_id bigint null;
alter table public.coaching_reports add column if not exists area_id bigint null;
alter table public.coaching_reports add column if not exists team_id bigint null;
alter table public.coaching_reports add column if not exists coaching_date date;
alter table public.coaching_reports add column if not exists coaching_month int generated always as (extract(month from coaching_date)::int) stored;
alter table public.coaching_reports add column if not exists coaching_quarter int generated always as (extract(quarter from coaching_date)::int) stored;
alter table public.coaching_reports add column if not exists coaching_year int generated always as (extract(year from coaching_date)::int) stored;
alter table public.coaching_reports add column if not exists status text not null default 'draft';
alter table public.coaching_reports add column if not exists actual_score numeric(10, 2) not null default 0;
alter table public.coaching_reports add column if not exists max_score numeric(10, 2) not null default 120;
alter table public.coaching_reports add column if not exists final_score_percent numeric(6, 2) not null default 0;
alter table public.coaching_reports add column if not exists performance_zone text null;
alter table public.coaching_reports add column if not exists area_of_development text null;
alter table public.coaching_reports add column if not exists strength_points text null;
alter table public.coaching_reports add column if not exists general_remarks text null;
alter table public.coaching_reports add column if not exists employee_acknowledged boolean not null default false;
alter table public.coaching_reports add column if not exists acknowledged_at timestamptz null;
alter table public.coaching_reports add column if not exists submitted_at timestamptz null;
alter table public.coaching_reports add column if not exists locked_at timestamptz null;
alter table public.coaching_reports add column if not exists created_by text null;
alter table public.coaching_reports add column if not exists updated_by text null;
alter table public.coaching_reports add column if not exists created_at timestamptz not null default now();
alter table public.coaching_reports add column if not exists updated_at timestamptz not null default now();

alter table public.coaching_reports
  alter column report_number set default (
    'CR-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.coaching_report_number_seq')::text, 6, '0')
  );

update public.coaching_reports
set report_number = 'CR-' || to_char(coalesce(created_at, now()), 'YYYY') || '-'
  || lpad(nextval('public.coaching_report_number_seq')::text, 6, '0')
where report_number is null or btrim(report_number) = '';

alter table public.coaching_reports alter column report_number set not null;
alter table public.coaching_reports alter column medical_rep_hr_id set not null;
alter table public.coaching_reports alter column coach_hr_id set not null;
alter table public.coaching_reports alter column coaching_date set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'coaching_reports_report_number_key'
      and conrelid = 'public.coaching_reports'::regclass
  ) then
    alter table public.coaching_reports add constraint coaching_reports_report_number_key unique (report_number);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'coaching_reports_status_check'
      and conrelid = 'public.coaching_reports'::regclass
  ) then
    alter table public.coaching_reports
      add constraint coaching_reports_status_check
      check (status in ('draft', 'submitted', 'reviewed_by_employee', 'locked', 'cancelled')) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'coaching_reports_score_bounds_check'
      and conrelid = 'public.coaching_reports'::regclass
  ) then
    alter table public.coaching_reports
      add constraint coaching_reports_score_bounds_check
      check (actual_score >= 0 and max_score > 0 and actual_score <= max_score) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'coaching_reports_percent_bounds_check'
      and conrelid = 'public.coaching_reports'::regclass
  ) then
    alter table public.coaching_reports
      add constraint coaching_reports_percent_bounds_check
      check (final_score_percent >= 0 and final_score_percent <= 100) not valid;
  end if;

  alter table public.coaching_reports drop constraint if exists coaching_reports_zone_check;
  alter table public.coaching_reports
    add constraint coaching_reports_zone_check
    check (
      performance_zone is null
      or performance_zone in ('critical_red', 'red_zone', 'yellow_zone', 'green_zone', 'excellence_zone')
    ) not valid;

  if not exists (
    select 1 from pg_constraint
    where conname = 'coaching_reports_medical_rep_hr_id_fkey'
      and conrelid = 'public.coaching_reports'::regclass
  ) then
    alter table public.coaching_reports
      add constraint coaching_reports_medical_rep_hr_id_fkey
      foreign key (medical_rep_hr_id) references public.employees(hr_id)
      on update cascade on delete restrict not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'coaching_reports_coach_hr_id_fkey'
      and conrelid = 'public.coaching_reports'::regclass
  ) then
    alter table public.coaching_reports
      add constraint coaching_reports_coach_hr_id_fkey
      foreign key (coach_hr_id) references public.employees(hr_id)
      on update cascade on delete restrict not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'coaching_reports_line_id_fkey'
      and conrelid = 'public.coaching_reports'::regclass
  ) then
    alter table public.coaching_reports
      add constraint coaching_reports_line_id_fkey
      foreign key (line_id) references public.lines(id)
      on update cascade on delete set null not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'coaching_reports_area_id_fkey'
      and conrelid = 'public.coaching_reports'::regclass
  ) then
    alter table public.coaching_reports
      add constraint coaching_reports_area_id_fkey
      foreign key (area_id) references public.areas(id)
      on update cascade on delete set null not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'coaching_reports_team_id_fkey'
      and conrelid = 'public.coaching_reports'::regclass
  ) then
    alter table public.coaching_reports
      add constraint coaching_reports_team_id_fkey
      foreign key (team_id) references public.teams(id)
      on update cascade on delete set null not valid;
  end if;
end $$;

create table if not exists public.coaching_score_items (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.coaching_reports(id) on update cascade on delete cascade,
  parameter_category text not null,
  score_item_key text not null,
  score_item_label text not null,
  score integer not null check (score between 1 and 6),
  display_order int not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint coaching_score_items_report_key_unique unique (report_id, score_item_key)
);

alter table public.coaching_score_items add column if not exists report_id uuid;
alter table public.coaching_score_items add column if not exists parameter_category text;
alter table public.coaching_score_items add column if not exists score_item_key text;
alter table public.coaching_score_items add column if not exists score_item_label text;
alter table public.coaching_score_items add column if not exists score integer;
alter table public.coaching_score_items add column if not exists display_order int;
alter table public.coaching_score_items add column if not exists created_at timestamptz not null default now();
alter table public.coaching_score_items add column if not exists updated_at timestamptz not null default now();
alter table public.coaching_score_items alter column report_id set not null;
alter table public.coaching_score_items alter column parameter_category set not null;
alter table public.coaching_score_items alter column score_item_key set not null;
alter table public.coaching_score_items alter column score_item_label set not null;
alter table public.coaching_score_items alter column score set not null;
alter table public.coaching_score_items alter column display_order set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'coaching_score_items_score_check'
      and conrelid = 'public.coaching_score_items'::regclass
  ) then
    alter table public.coaching_score_items
      add constraint coaching_score_items_score_check
      check (score between 1 and 6) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'coaching_score_items_report_id_fkey'
      and conrelid = 'public.coaching_score_items'::regclass
  ) then
    alter table public.coaching_score_items
      add constraint coaching_score_items_report_id_fkey
      foreign key (report_id) references public.coaching_reports(id)
      on update cascade on delete cascade not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'coaching_score_items_report_key_unique'
      and conrelid = 'public.coaching_score_items'::regclass
  ) then
    alter table public.coaching_score_items
      add constraint coaching_score_items_report_key_unique
      unique (report_id, score_item_key);
  end if;
end $$;

create table if not exists public.coaching_report_acknowledgments (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.coaching_reports(id) on update cascade on delete cascade,
  employee_hr_id text not null references public.employees(hr_id) on update cascade on delete restrict,
  acknowledged_at timestamptz not null default now(),
  acknowledgment_text text not null,
  ip_address text null,
  user_agent text null
);

alter table public.coaching_report_acknowledgments add column if not exists report_id uuid;
alter table public.coaching_report_acknowledgments add column if not exists employee_hr_id text;
alter table public.coaching_report_acknowledgments add column if not exists acknowledged_at timestamptz not null default now();
alter table public.coaching_report_acknowledgments add column if not exists acknowledgment_text text;
alter table public.coaching_report_acknowledgments add column if not exists ip_address text null;
alter table public.coaching_report_acknowledgments add column if not exists user_agent text null;
alter table public.coaching_report_acknowledgments alter column report_id set not null;
alter table public.coaching_report_acknowledgments alter column employee_hr_id set not null;
alter table public.coaching_report_acknowledgments alter column acknowledgment_text set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'coaching_report_acknowledgments_report_id_fkey'
      and conrelid = 'public.coaching_report_acknowledgments'::regclass
  ) then
    alter table public.coaching_report_acknowledgments
      add constraint coaching_report_acknowledgments_report_id_fkey
      foreign key (report_id) references public.coaching_reports(id)
      on update cascade on delete cascade not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'coaching_report_acknowledgments_employee_hr_id_fkey'
      and conrelid = 'public.coaching_report_acknowledgments'::regclass
  ) then
    alter table public.coaching_report_acknowledgments
      add constraint coaching_report_acknowledgments_employee_hr_id_fkey
      foreign key (employee_hr_id) references public.employees(hr_id)
      on update cascade on delete restrict not valid;
  end if;
end $$;

create unique index if not exists coaching_report_acknowledgments_report_id_unique_idx
  on public.coaching_report_acknowledgments (report_id);

create table if not exists public.coaching_report_audit_logs (
  id uuid primary key default gen_random_uuid(),
  report_id uuid null references public.coaching_reports(id) on update cascade on delete cascade,
  actor_hr_id text null,
  action text not null,
  old_values jsonb null,
  new_values jsonb null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.coaching_report_audit_logs add column if not exists report_id uuid null;
alter table public.coaching_report_audit_logs add column if not exists actor_hr_id text null;
alter table public.coaching_report_audit_logs add column if not exists action text;
alter table public.coaching_report_audit_logs add column if not exists old_values jsonb null;
alter table public.coaching_report_audit_logs add column if not exists new_values jsonb null;
alter table public.coaching_report_audit_logs add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.coaching_report_audit_logs add column if not exists created_at timestamptz not null default now();
alter table public.coaching_report_audit_logs alter column action set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'coaching_report_audit_logs_report_id_fkey'
      and conrelid = 'public.coaching_report_audit_logs'::regclass
  ) then
    alter table public.coaching_report_audit_logs
      add constraint coaching_report_audit_logs_report_id_fkey
      foreign key (report_id) references public.coaching_reports(id)
      on update cascade on delete cascade not valid;
  end if;
end $$;

create or replace function public.set_coaching_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_coaching_reports_updated_at on public.coaching_reports;
create trigger set_coaching_reports_updated_at
  before update on public.coaching_reports
  for each row
  execute function public.set_coaching_updated_at();

drop trigger if exists set_coaching_score_items_updated_at on public.coaching_score_items;
create trigger set_coaching_score_items_updated_at
  before update on public.coaching_score_items
  for each row
  execute function public.set_coaching_updated_at();

create index if not exists coaching_reports_medical_rep_hr_id_idx
  on public.coaching_reports (medical_rep_hr_id);

create index if not exists coaching_reports_coach_hr_id_idx
  on public.coaching_reports (coach_hr_id);

create index if not exists coaching_reports_coaching_date_idx
  on public.coaching_reports (coaching_date);

create index if not exists coaching_reports_year_quarter_idx
  on public.coaching_reports (coaching_year, coaching_quarter);

create index if not exists coaching_reports_month_year_idx
  on public.coaching_reports (coaching_year, coaching_month);

create index if not exists coaching_reports_line_area_team_idx
  on public.coaching_reports (line_id, area_id, team_id);

create index if not exists coaching_reports_status_idx
  on public.coaching_reports (status);

create index if not exists coaching_reports_performance_zone_idx
  on public.coaching_reports (performance_zone);

create index if not exists coaching_reports_rep_period_idx
  on public.coaching_reports (medical_rep_hr_id, coaching_year, coaching_quarter);

create index if not exists coaching_score_items_report_id_idx
  on public.coaching_score_items (report_id);

create index if not exists coaching_score_items_report_category_key_idx
  on public.coaching_score_items (report_id, parameter_category, score_item_key);

create index if not exists coaching_score_items_category_idx
  on public.coaching_score_items (parameter_category);

create index if not exists coaching_report_acknowledgments_report_id_idx
  on public.coaching_report_acknowledgments (report_id);

create index if not exists coaching_report_acknowledgments_employee_hr_id_idx
  on public.coaching_report_acknowledgments (employee_hr_id);

create index if not exists coaching_report_audit_logs_report_id_idx
  on public.coaching_report_audit_logs (report_id, created_at desc);

create index if not exists coaching_report_audit_logs_actor_hr_id_idx
  on public.coaching_report_audit_logs (actor_hr_id, created_at desc);

create or replace view public.coaching_reports_summary as
select
  r.id as report_id,
  r.report_number,
  rep.full_name as medical_rep_name,
  r.medical_rep_hr_id,
  coach.full_name as coach_name,
  r.coach_hr_id,
  l.name as line_name,
  a.name as area_name,
  t.name as team_name,
  r.coaching_date,
  r.coaching_month,
  r.coaching_quarter,
  r.coaching_year,
  r.actual_score,
  r.max_score,
  r.final_score_percent,
  r.performance_zone,
  r.status,
  r.employee_acknowledged as acknowledged,
  r.acknowledged_at,
  r.submitted_at,
  r.created_at,
  r.updated_at,
  r.line_id,
  r.area_id,
  r.team_id
from public.coaching_reports r
join public.employees rep on rep.hr_id = r.medical_rep_hr_id
join public.employees coach on coach.hr_id = r.coach_hr_id
left join public.lines l on l.id = r.line_id
left join public.areas a on a.id = r.area_id
left join public.teams t on t.id = r.team_id;

create or replace view public.coaching_quarterly_summary as
with ranked as (
  select
    r.medical_rep_hr_id,
    r.coaching_year,
    r.coaching_quarter,
    r.final_score_percent,
    r.performance_zone,
    r.coaching_date,
    r.created_at,
    first_value(r.final_score_percent) over (
      partition by r.medical_rep_hr_id, r.coaching_year, r.coaching_quarter
      order by r.coaching_date asc, r.created_at asc
    ) as first_score,
    first_value(r.final_score_percent) over (
      partition by r.medical_rep_hr_id, r.coaching_year, r.coaching_quarter
      order by r.coaching_date desc, r.created_at desc
    ) as latest_score,
    first_value(r.performance_zone) over (
      partition by r.medical_rep_hr_id, r.coaching_year, r.coaching_quarter
      order by r.coaching_date desc, r.created_at desc
    ) as latest_zone
  from public.coaching_reports r
  where r.status in ('submitted', 'reviewed_by_employee', 'locked')
)
select
  medical_rep_hr_id,
  coaching_year as year,
  coaching_quarter as quarter,
  count(*)::int as coaching_count,
  round(avg(final_score_percent), 2) as average_score,
  max(final_score_percent) as best_score,
  min(final_score_percent) as lowest_score,
  max(latest_score) as latest_score,
  max(first_score) as first_score,
  round(max(latest_score) - max(first_score), 2) as improvement_score,
  max(latest_zone) as latest_zone
from ranked
group by medical_rep_hr_id, coaching_year, coaching_quarter;

create or replace function public.submit_coaching_report(
  p_report_id uuid,
  p_actor_hr_id text,
  p_area_of_development text default null,
  p_strength_points text default null,
  p_general_remarks text default null,
  p_scores jsonb default null
)
returns public.coaching_reports
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report public.coaching_reports%rowtype;
  v_updated public.coaching_reports%rowtype;
  v_actual_score numeric(10, 2);
  v_score_count int;
  v_final_percent numeric(6, 2);
  v_zone text;
begin
  select *
  into v_report
  from public.coaching_reports
  where id = p_report_id
  for update;

  if not found then
    raise exception 'Coaching report was not found.';
  end if;

  if v_report.status <> 'draft' then
    raise exception 'Only draft coaching reports can be submitted.';
  end if;

  if p_scores is not null then
    if jsonb_typeof(p_scores) <> 'object' then
      raise exception 'Coaching scores must be a JSON object.';
    end if;

    with expected(score_item_key, parameter_category, score_item_label, display_order) as (
      values
        ('medical_patient_knowledge', 'knowledge', 'Medical & Patient/Physician Knowledge', 1),
        ('product_knowledge', 'knowledge', 'Product Knowledge', 2),
        ('competitor_knowledge', 'knowledge', 'Competitor Knowledge', 3),
        ('opening_patient_profile_attractive_approach', 'call_structure_skills', 'Opening, Patient Profile & Attractive Approach', 4),
        ('asking_questions_probing', 'call_structure_skills', 'Asking Questions / Probing', 5),
        ('presentation_skills', 'call_structure_skills', 'Presentation Skills', 6),
        ('closing_asking_for_business', 'call_structure_skills', 'Closing & Asking for Business', 7),
        ('handling_customer_objection', 'business_intelligence', 'Handling Customer Objection', 8),
        ('body_language_tone_of_voice', 'business_intelligence', 'Body Language & Tone of Voice', 9),
        ('professional_pharmacy_feedback', 'business_intelligence', 'Professional Pharmacy Feedback', 10),
        ('assertiveness_asking_for_business', 'business_intelligence', 'Assertiveness in Asking for Business', 11),
        ('customer_adaptation_relationship', 'business_intelligence', 'Customer Adaptation & Relationship', 12),
        ('time_territory_planning', 'business_planning', 'Time & Territory Planning', 13),
        ('using_promotional_material', 'business_planning', 'Using Promotional Material', 14),
        ('pre_call_planning', 'business_planning', 'Pre-Call Planning', 15),
        ('execution_follow_up', 'business_planning', 'Execution & Follow-Up', 16),
        ('appearance', 'personal_skills', 'Appearance', 17),
        ('dress_code', 'personal_skills', 'Dress Code', 18),
        ('attitude', 'personal_skills', 'Attitude', 19),
        ('discipline', 'personal_skills', 'Discipline', 20)
    ),
    provided as (
      select key, value
      from jsonb_each_text(p_scores)
    )
    select count(*)
    into v_score_count
    from provided;

    if v_score_count <> 20 then
      raise exception 'Exactly 20 coaching scores are required before submission.';
    end if;

    if exists (
      with expected(score_item_key) as (
        values
          ('medical_patient_knowledge'), ('product_knowledge'), ('competitor_knowledge'),
          ('opening_patient_profile_attractive_approach'), ('asking_questions_probing'),
          ('presentation_skills'), ('closing_asking_for_business'), ('handling_customer_objection'),
          ('body_language_tone_of_voice'), ('professional_pharmacy_feedback'),
          ('assertiveness_asking_for_business'), ('customer_adaptation_relationship'),
          ('time_territory_planning'), ('using_promotional_material'), ('pre_call_planning'),
          ('execution_follow_up'), ('appearance'), ('dress_code'), ('attitude'), ('discipline')
      ),
      provided as (
        select key, value
        from jsonb_each_text(p_scores)
      )
      select 1
      from provided p
      full outer join expected e on e.score_item_key = p.key
      where e.score_item_key is null
        or p.key is null
        or p.value !~ '^[0-9]+$'
        or p.value::int < 1
        or p.value::int > 6
    ) then
      raise exception 'Coaching score payload contains missing, unknown, or out-of-range items.';
    end if;

    delete from public.coaching_score_items
    where report_id = p_report_id;

    insert into public.coaching_score_items (
      report_id,
      parameter_category,
      score_item_key,
      score_item_label,
      score,
      display_order
    )
    with expected(score_item_key, parameter_category, score_item_label, display_order) as (
      values
        ('medical_patient_knowledge', 'knowledge', 'Medical & Patient/Physician Knowledge', 1),
        ('product_knowledge', 'knowledge', 'Product Knowledge', 2),
        ('competitor_knowledge', 'knowledge', 'Competitor Knowledge', 3),
        ('opening_patient_profile_attractive_approach', 'call_structure_skills', 'Opening, Patient Profile & Attractive Approach', 4),
        ('asking_questions_probing', 'call_structure_skills', 'Asking Questions / Probing', 5),
        ('presentation_skills', 'call_structure_skills', 'Presentation Skills', 6),
        ('closing_asking_for_business', 'call_structure_skills', 'Closing & Asking for Business', 7),
        ('handling_customer_objection', 'business_intelligence', 'Handling Customer Objection', 8),
        ('body_language_tone_of_voice', 'business_intelligence', 'Body Language & Tone of Voice', 9),
        ('professional_pharmacy_feedback', 'business_intelligence', 'Professional Pharmacy Feedback', 10),
        ('assertiveness_asking_for_business', 'business_intelligence', 'Assertiveness in Asking for Business', 11),
        ('customer_adaptation_relationship', 'business_intelligence', 'Customer Adaptation & Relationship', 12),
        ('time_territory_planning', 'business_planning', 'Time & Territory Planning', 13),
        ('using_promotional_material', 'business_planning', 'Using Promotional Material', 14),
        ('pre_call_planning', 'business_planning', 'Pre-Call Planning', 15),
        ('execution_follow_up', 'business_planning', 'Execution & Follow-Up', 16),
        ('appearance', 'personal_skills', 'Appearance', 17),
        ('dress_code', 'personal_skills', 'Dress Code', 18),
        ('attitude', 'personal_skills', 'Attitude', 19),
        ('discipline', 'personal_skills', 'Discipline', 20)
    )
    select
      p_report_id,
      parameter_category,
      score_item_key,
      score_item_label,
      (p_scores ->> score_item_key)::int,
      display_order
    from expected;
  end if;

  select count(*), coalesce(sum(score), 0)
  into v_score_count, v_actual_score
  from public.coaching_score_items
  where report_id = p_report_id;

  if v_score_count <> 20 then
    raise exception 'Exactly 20 coaching scores are required before submission.';
  end if;

  v_final_percent := round((v_actual_score / 120) * 100, 2);
  v_zone := case
    when v_final_percent < 50 then 'critical_red'
    when v_final_percent <= 65 then 'red_zone'
    when v_final_percent <= 80 then 'yellow_zone'
    when v_final_percent <= 90 then 'green_zone'
    else 'excellence_zone'
  end;

  update public.coaching_reports
  set
    actual_score = v_actual_score,
    area_of_development = coalesce(p_area_of_development, area_of_development),
    final_score_percent = v_final_percent,
    general_remarks = coalesce(p_general_remarks, general_remarks),
    max_score = 120,
    performance_zone = v_zone,
    status = 'submitted',
    strength_points = coalesce(p_strength_points, strength_points),
    submitted_at = coalesce(submitted_at, now()),
    locked_at = null,
    updated_by = p_actor_hr_id
  where id = p_report_id
  returning *
  into v_updated;

  insert into public.coaching_report_audit_logs (
    report_id,
    actor_hr_id,
    action,
    old_values,
    new_values
  )
  values (
    p_report_id,
    p_actor_hr_id,
    'submitted',
    jsonb_build_object('status', v_report.status),
    jsonb_build_object(
      'status', 'submitted',
      'actualScore', v_actual_score,
      'finalScorePercent', v_final_percent,
      'performanceZone', v_zone
    )
  );

  return v_updated;
end;
$$;

create or replace function public.acknowledge_coaching_report(
  p_report_id uuid,
  p_employee_hr_id text,
  p_acknowledgment_text text,
  p_ip_address text default null,
  p_user_agent text default null
)
returns public.coaching_reports
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report public.coaching_reports%rowtype;
  v_updated public.coaching_reports%rowtype;
begin
  select *
  into v_report
  from public.coaching_reports
  where id = p_report_id
  for update;

  if not found then
    raise exception 'Coaching report was not found.';
  end if;

  if upper(btrim(v_report.medical_rep_hr_id)) <> upper(btrim(p_employee_hr_id)) then
    raise exception 'Forbidden: employees can only acknowledge their own coaching reports.';
  end if;

  if v_report.status <> 'submitted' then
    raise exception 'Only submitted coaching reports can be acknowledged.';
  end if;

  insert into public.coaching_report_acknowledgments (
    report_id,
    employee_hr_id,
    acknowledgment_text,
    ip_address,
    user_agent
  )
  values (
    p_report_id,
    v_report.medical_rep_hr_id,
    coalesce(nullif(btrim(p_acknowledgment_text), ''), 'I acknowledge and submit this coaching report review.'),
    nullif(btrim(p_ip_address), ''),
    nullif(btrim(p_user_agent), '')
  );

  update public.coaching_reports
  set
    acknowledged_at = now(),
    employee_acknowledged = true,
    status = 'reviewed_by_employee',
    updated_by = p_employee_hr_id
  where id = p_report_id
  returning *
  into v_updated;

  insert into public.coaching_report_audit_logs (
    report_id,
    actor_hr_id,
    action,
    old_values,
    new_values,
    metadata
  )
  values (
    p_report_id,
    p_employee_hr_id,
    'acknowledged',
    jsonb_build_object('status', v_report.status),
    jsonb_build_object('status', 'reviewed_by_employee', 'acknowledgedAt', v_updated.acknowledged_at),
    jsonb_build_object('acknowledgmentText', coalesce(nullif(btrim(p_acknowledgment_text), ''), 'I acknowledge and submit this coaching report review.'))
  );

  return v_updated;
exception
  when unique_violation then
    raise exception 'This coaching report has already been acknowledged.';
end;
$$;

revoke all on public.coaching_reports from anon, authenticated;
revoke all on public.coaching_score_items from anon, authenticated;
revoke all on public.coaching_report_acknowledgments from anon, authenticated;
revoke all on public.coaching_report_audit_logs from anon, authenticated;
revoke all on public.coaching_reports_summary from anon, authenticated;
revoke all on public.coaching_quarterly_summary from anon, authenticated;
revoke all on function public.submit_coaching_report(uuid, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.acknowledge_coaching_report(uuid, text, text, text, text) from public, anon, authenticated;

grant all on public.coaching_reports to service_role;
grant all on public.coaching_score_items to service_role;
grant all on public.coaching_report_acknowledgments to service_role;
grant all on public.coaching_report_audit_logs to service_role;
grant select on public.coaching_reports_summary to service_role;
grant select on public.coaching_quarterly_summary to service_role;
grant usage, select on sequence public.coaching_report_number_seq to service_role;
grant execute on function public.submit_coaching_report(uuid, text, text, text, text, jsonb) to service_role;
grant execute on function public.acknowledge_coaching_report(uuid, text, text, text, text) to service_role;

alter table public.coaching_reports enable row level security;
alter table public.coaching_score_items enable row level security;
alter table public.coaching_report_acknowledgments enable row level security;
alter table public.coaching_report_audit_logs enable row level security;

-- Conservative RLS policy: only service_role may access the new coaching tables directly.
-- TODO: Add user-scoped authenticated policies after the application access layer is implemented
-- and tested for coach hierarchy, employee self-read, and HR/admin export scenarios.
drop policy if exists phx_coaching_reports_service_role on public.coaching_reports;
create policy phx_coaching_reports_service_role
  on public.coaching_reports
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists phx_coaching_score_items_service_role on public.coaching_score_items;
create policy phx_coaching_score_items_service_role
  on public.coaching_score_items
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists phx_coaching_report_acknowledgments_service_role on public.coaching_report_acknowledgments;
create policy phx_coaching_report_acknowledgments_service_role
  on public.coaching_report_acknowledgments
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists phx_coaching_report_audit_logs_service_role on public.coaching_report_audit_logs;
create policy phx_coaching_report_audit_logs_service_role
  on public.coaching_report_audit_logs
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.coaching_reports is
  'Phoenix Coaching & Field Excellence report headers. Access is service-role-only until app-level coaching permissions are implemented.';

comment on table public.coaching_score_items is
  'Dynamic score rows for each coaching report. Expected total is 20 items scored from 1 to 6.';

comment on table public.coaching_report_acknowledgments is
  'Employee acknowledgment history for submitted coaching reports.';

comment on table public.coaching_report_audit_logs is
  'Module-specific audit trail for coaching report lifecycle events.';

notify pgrst, 'reload schema';
