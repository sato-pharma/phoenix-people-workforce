alter table public.coaching_score_items
  add column if not exists area_to_be_improved text null;

alter table public.coaching_score_items
  add column if not exists strength_point text null;

comment on column public.coaching_score_items.area_to_be_improved is
  'Optional coach note for what should be improved on this specific scoring point.';

comment on column public.coaching_score_items.strength_point is
  'Optional coach note for what was strong on this specific scoring point.';

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

    with provided as (
      select
        key,
        case
          when jsonb_typeof(value) = 'object' then value ->> 'score'
          else value #>> '{}'
        end as score_text
      from jsonb_each(p_scores)
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
        select
          key,
          case
            when jsonb_typeof(value) = 'object' then value ->> 'score'
            else value #>> '{}'
          end as score_text
        from jsonb_each(p_scores)
      )
      select 1
      from provided p
      full outer join expected e on e.score_item_key = p.key
      where e.score_item_key is null
        or p.key is null
        or p.score_text is null
        or p.score_text !~ '^[0-9]+$'
        or p.score_text::int < 1
        or p.score_text::int > 6
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
      display_order,
      area_to_be_improved,
      strength_point
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
    ),
    normalized as (
      select
        e.*,
        p_scores -> e.score_item_key as raw_value
      from expected e
    )
    select
      p_report_id,
      parameter_category,
      score_item_key,
      score_item_label,
      case
        when jsonb_typeof(raw_value) = 'object' then (raw_value ->> 'score')::int
        else (raw_value #>> '{}')::int
      end,
      display_order,
      nullif(btrim(case when jsonb_typeof(raw_value) = 'object' then raw_value ->> 'areaToBeImproved' else null end), ''),
      nullif(btrim(case when jsonb_typeof(raw_value) = 'object' then raw_value ->> 'strengthPoint' else null end), '')
    from normalized;
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

revoke all on function public.submit_coaching_report(uuid, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.submit_coaching_report(uuid, text, text, text, text, jsonb) to service_role;

notify pgrst, 'reload schema';
