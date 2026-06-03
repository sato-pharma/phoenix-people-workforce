-- Coaching reports schema.
-- Fresh staging revealed the application had coaching service code and workflow
-- registry entries, but no canonical migration creating the coaching data model.
-- Keep Data API access server-only through service_role.

begin;

create extension if not exists pgcrypto;

create table if not exists public.coaching_reports (
  id uuid primary key default gen_random_uuid(),
  report_number text not null unique default ('CR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  medical_rep_hr_id text not null,
  coach_hr_id text not null,
  coach_role text null,
  coaching_date date not null,
  coaching_month integer generated always as (extract(month from coaching_date)::integer) stored,
  coaching_quarter integer generated always as (extract(quarter from coaching_date)::integer) stored,
  coaching_year integer generated always as (extract(year from coaching_date)::integer) stored,
  line_id integer null,
  area_id integer null,
  team_id integer null,
  area_of_development text null,
  strength_points text null,
  general_remarks text null,
  actual_score numeric not null default 0,
  max_score numeric not null default 120,
  final_score_percent numeric not null default 0,
  performance_zone text null,
  status text not null default 'draft',
  employee_acknowledged boolean not null default false,
  acknowledged_at timestamptz null,
  submitted_at timestamptz null,
  locked_at timestamptz null,
  created_by text null,
  updated_by text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint coaching_reports_status_check check (
    status in ('draft', 'submitted', 'reviewed_by_employee', 'locked', 'cancelled')
  ),
  constraint coaching_reports_zone_check check (
    performance_zone is null or performance_zone in (
      'critical_red',
      'red_zone',
      'yellow_zone',
      'green_zone',
      'excellence_zone'
    )
  )
);

create table if not exists public.coaching_score_items (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.coaching_reports(id) on delete cascade,
  display_order integer not null,
  parameter_category text not null,
  score_item_key text not null,
  score_item_label text not null,
  score integer not null,
  strength_point text null,
  area_to_be_improved text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint coaching_score_items_score_check check (score between 1 and 6),
  constraint coaching_score_items_category_check check (
    parameter_category in (
      'knowledge',
      'call_structure_skills',
      'business_intelligence',
      'business_planning',
      'personal_skills'
    )
  ),
  constraint coaching_score_items_report_key_unique unique (report_id, score_item_key)
);

create table if not exists public.coaching_report_acknowledgments (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.coaching_reports(id) on delete cascade,
  employee_hr_id text not null,
  acknowledgment_text text not null,
  ip_address text null,
  user_agent text null,
  acknowledged_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint coaching_report_ack_unique unique (report_id, employee_hr_id)
);

create table if not exists public.coaching_report_audit_logs (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.coaching_reports(id) on delete cascade,
  action text not null,
  actor_hr_id text not null,
  old_values jsonb null,
  new_values jsonb null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists coaching_reports_medical_rep_idx
  on public.coaching_reports (medical_rep_hr_id, coaching_date desc);
create index if not exists coaching_reports_coach_idx
  on public.coaching_reports (coach_hr_id, coaching_date desc);
create index if not exists coaching_reports_status_idx
  on public.coaching_reports (status, coaching_date desc);
create index if not exists coaching_score_items_report_id_idx
  on public.coaching_score_items (report_id);
create index if not exists coaching_report_audit_logs_report_id_idx
  on public.coaching_report_audit_logs (report_id, created_at desc);

alter table public.coaching_reports enable row level security;
alter table public.coaching_score_items enable row level security;
alter table public.coaching_report_acknowledgments enable row level security;
alter table public.coaching_report_audit_logs enable row level security;

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

drop policy if exists phx_coaching_ack_service_role on public.coaching_report_acknowledgments;
create policy phx_coaching_ack_service_role
  on public.coaching_report_acknowledgments
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists phx_coaching_audit_service_role on public.coaching_report_audit_logs;
create policy phx_coaching_audit_service_role
  on public.coaching_report_audit_logs
  for all
  to service_role
  using (true)
  with check (true);

create or replace function public.set_coaching_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists coaching_reports_set_updated_at on public.coaching_reports;
create trigger coaching_reports_set_updated_at
  before update on public.coaching_reports
  for each row
  execute function public.set_coaching_updated_at();

drop trigger if exists coaching_score_items_set_updated_at on public.coaching_score_items;
create trigger coaching_score_items_set_updated_at
  before update on public.coaching_score_items
  for each row
  execute function public.set_coaching_updated_at();

create or replace view public.coaching_reports_summary
with (security_invoker = true)
as
select
  r.id as report_id,
  r.report_number,
  r.status,
  r.medical_rep_hr_id,
  coalesce(med.full_name, r.medical_rep_hr_id) as medical_rep_name,
  r.coach_hr_id,
  coalesce(coach.full_name, r.coach_hr_id) as coach_name,
  r.coaching_date,
  r.coaching_month,
  r.coaching_quarter,
  r.coaching_year,
  r.line_id,
  l.name as line_name,
  r.area_id,
  a.name as area_name,
  r.team_id,
  t.name as team_name,
  r.actual_score,
  r.max_score,
  r.final_score_percent,
  r.performance_zone,
  r.submitted_at,
  coalesce(r.employee_acknowledged, ack.acknowledged_at is not null) as acknowledged,
  coalesce(r.acknowledged_at, ack.acknowledged_at) as acknowledged_at,
  r.created_at,
  r.updated_at
from public.coaching_reports r
left join public.employees med
  on lower(med.hr_id) = lower(r.medical_rep_hr_id)
left join public.employees coach
  on lower(coach.hr_id) = lower(r.coach_hr_id)
left join public.lines l
  on l.id = r.line_id
left join public.areas a
  on a.id = r.area_id
left join public.teams t
  on t.id = r.team_id
left join lateral (
  select max(cra.acknowledged_at) as acknowledged_at
  from public.coaching_report_acknowledgments cra
  where cra.report_id = r.id
) ack on true;

create or replace view public.coaching_quarterly_summary
with (security_invoker = true)
as
select
  r.medical_rep_hr_id,
  r.coaching_year as year,
  r.coaching_quarter as quarter,
  count(*)::integer as coaching_count,
  avg(r.final_score_percent)::numeric as average_score,
  max(r.final_score_percent)::numeric as best_score,
  min(r.final_score_percent)::numeric as lowest_score,
  (array_agg(r.final_score_percent order by r.coaching_date asc, r.created_at asc))[1]::numeric as first_score,
  (array_agg(r.final_score_percent order by r.coaching_date desc, r.created_at desc))[1]::numeric as latest_score,
  (
    (array_agg(r.final_score_percent order by r.coaching_date desc, r.created_at desc))[1]
    - (array_agg(r.final_score_percent order by r.coaching_date asc, r.created_at asc))[1]
  )::numeric as improvement_score,
  (array_agg(r.performance_zone order by r.coaching_date desc, r.created_at desc))[1] as latest_zone
from public.coaching_reports r
where r.status in ('submitted', 'reviewed_by_employee', 'locked')
group by r.medical_rep_hr_id, r.coaching_year, r.coaching_quarter;

create or replace function public.phx_coaching_item_definition(p_key text)
returns table (
  display_order integer,
  parameter_category text,
  score_item_label text
)
language sql
stable
as $$
  select item.display_order, item.parameter_category, item.score_item_label
  from (
    values
      (1, 'knowledge', 'medical_patient_knowledge', 'Medical & Patient/Physician Knowledge'),
      (2, 'knowledge', 'product_knowledge', 'Product Knowledge'),
      (3, 'knowledge', 'competitor_knowledge', 'Competitor Knowledge'),
      (4, 'call_structure_skills', 'opening_patient_profile_attractive_approach', 'Opening, Patient Profile & Attractive Approach'),
      (5, 'call_structure_skills', 'asking_questions_probing', 'Asking Questions / Probing'),
      (6, 'call_structure_skills', 'presentation_skills', 'Presentation Skills'),
      (7, 'call_structure_skills', 'closing_asking_for_business', 'Closing & Asking for Business'),
      (8, 'business_intelligence', 'handling_customer_objection', 'Handling Customer Objection'),
      (9, 'business_intelligence', 'body_language_tone_of_voice', 'Body Language & Tone of Voice'),
      (10, 'business_intelligence', 'professional_pharmacy_feedback', 'Professional Pharmacy Feedback'),
      (11, 'business_intelligence', 'assertiveness_asking_for_business', 'Assertiveness in Asking for Business'),
      (12, 'business_intelligence', 'customer_adaptation_relationship', 'Customer Adaptation & Relationship'),
      (13, 'business_planning', 'time_territory_planning', 'Time & Territory Planning'),
      (14, 'business_planning', 'using_promotional_material', 'Using Promotional Material'),
      (15, 'business_planning', 'pre_call_planning', 'Pre-Call Planning'),
      (16, 'business_planning', 'execution_follow_up', 'Execution & Follow-Up'),
      (17, 'personal_skills', 'appearance', 'Appearance'),
      (18, 'personal_skills', 'dress_code', 'Dress Code'),
      (19, 'personal_skills', 'attitude', 'Attitude'),
      (20, 'personal_skills', 'discipline', 'Discipline')
  ) as item(display_order, parameter_category, score_item_key, score_item_label)
  where item.score_item_key = p_key;
$$;

create or replace function public.phx_coaching_zone(p_percent numeric)
returns text
language sql
immutable
as $$
  select case
    when p_percent < 50 then 'critical_red'
    when p_percent <= 65 then 'red_zone'
    when p_percent <= 80 then 'yellow_zone'
    when p_percent <= 90 then 'green_zone'
    else 'excellence_zone'
  end;
$$;

create or replace function public.submit_coaching_report(
  p_report_id uuid,
  p_actor_hr_id text,
  p_scores jsonb default null,
  p_area_of_development text default null,
  p_general_remarks text default null,
  p_strength_points text default null
)
returns public.coaching_reports
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_report public.coaching_reports%rowtype;
  v_actual_score numeric;
  v_percent numeric;
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
    delete from public.coaching_score_items
    where report_id = p_report_id;

    insert into public.coaching_score_items (
      report_id,
      display_order,
      parameter_category,
      score_item_key,
      score_item_label,
      score,
      strength_point,
      area_to_be_improved
    )
    select
      p_report_id,
      def.display_order,
      def.parameter_category,
      item.key,
      def.score_item_label,
      (coalesce(item.value ->> 'score', item.value #>> '{}'))::integer,
      nullif(item.value ->> 'strengthPoint', ''),
      nullif(item.value ->> 'areaToBeImproved', '')
    from jsonb_each(p_scores) as item(key, value)
    join lateral public.phx_coaching_item_definition(item.key) def on true;
  end if;

  select coalesce(sum(score), 0)
  into v_actual_score
  from public.coaching_score_items
  where report_id = p_report_id;

  if (
    select count(*)
    from public.coaching_score_items
    where report_id = p_report_id
  ) <> 20 then
    raise exception 'Exactly 20 coaching scores are required before submission.';
  end if;

  v_percent := round((v_actual_score / 120.0) * 100.0, 2);

  update public.coaching_reports
  set
    actual_score = v_actual_score,
    area_of_development = coalesce(nullif(p_area_of_development, ''), area_of_development),
    final_score_percent = v_percent,
    general_remarks = coalesce(nullif(p_general_remarks, ''), general_remarks),
    max_score = 120,
    performance_zone = public.phx_coaching_zone(v_percent),
    status = 'submitted',
    strength_points = coalesce(nullif(p_strength_points, ''), strength_points),
    submitted_at = now(),
    updated_by = p_actor_hr_id
  where id = p_report_id
  returning *
  into v_report;

  return v_report;
end;
$$;

create or replace function public.acknowledge_coaching_report(
  p_report_id uuid,
  p_employee_hr_id text,
  p_acknowledgment_text text default 'I acknowledge and submit this coaching report review.',
  p_ip_address text default null,
  p_user_agent text default null
)
returns public.coaching_reports
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_report public.coaching_reports%rowtype;
begin
  select *
  into v_report
  from public.coaching_reports
  where id = p_report_id
  for update;

  if not found then
    raise exception 'Coaching report was not found.';
  end if;

  if lower(v_report.medical_rep_hr_id) <> lower(p_employee_hr_id) then
    raise exception 'You are not authorized to acknowledge this coaching report.';
  end if;

  if v_report.status not in ('submitted') then
    raise exception 'This coaching report has already been acknowledged or is no longer open for acknowledgment.';
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
    p_employee_hr_id,
    coalesce(nullif(p_acknowledgment_text, ''), 'I acknowledge and submit this coaching report review.'),
    nullif(p_ip_address, ''),
    nullif(p_user_agent, '')
  )
  on conflict (report_id, employee_hr_id)
  do update set
    acknowledgment_text = excluded.acknowledgment_text,
    ip_address = excluded.ip_address,
    user_agent = excluded.user_agent,
    acknowledged_at = now();

  update public.coaching_reports
  set
    acknowledged_at = now(),
    employee_acknowledged = true,
    status = 'reviewed_by_employee',
    updated_by = p_employee_hr_id
  where id = p_report_id
  returning *
  into v_report;

  return v_report;
end;
$$;

revoke all on table public.coaching_reports from anon, authenticated;
revoke all on table public.coaching_score_items from anon, authenticated;
revoke all on table public.coaching_report_acknowledgments from anon, authenticated;
revoke all on table public.coaching_report_audit_logs from anon, authenticated;
revoke all on table public.coaching_reports_summary from anon, authenticated;
revoke all on table public.coaching_quarterly_summary from anon, authenticated;
revoke all on function public.submit_coaching_report(uuid, text, jsonb, text, text, text) from public, anon, authenticated;
revoke all on function public.acknowledge_coaching_report(uuid, text, text, text, text) from public, anon, authenticated;

grant select, insert, update, delete on table public.coaching_reports to service_role;
grant select, insert, update, delete on table public.coaching_score_items to service_role;
grant select, insert, update, delete on table public.coaching_report_acknowledgments to service_role;
grant select, insert on table public.coaching_report_audit_logs to service_role;
grant select on table public.coaching_reports_summary to service_role;
grant select on table public.coaching_quarterly_summary to service_role;
grant execute on function public.submit_coaching_report(uuid, text, jsonb, text, text, text) to service_role;
grant execute on function public.acknowledge_coaching_report(uuid, text, text, text, text) to service_role;

notify pgrst, 'reload schema';

commit;
