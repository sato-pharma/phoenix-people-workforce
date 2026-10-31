-- ats_personnel_specialist_hiring
--
-- WHAT THIS CHANGES — the Personnel Specialist / Senior Personnel Specialist opening (Sheraton, Cairo):
--   1. The workspace learns a ninth role tab, `personnel`: the placements check constraint gains it.
--   2. SIX new screening questions, keyed `pers_*`, scoped to ['personnel'] only:
--        pers_position         (sort  2) which of the two grades — the FIRST extra question
--        pers_years            (sort 90) years in personnel administration
--        pers_headcount        (sort 91) how many employees their personnel work covered
--        pers_insurance_forms  (sort 92) Form 1 / 2 / 6 submitted themselves on the insurance portal
--        pers_payroll_inputs   (sort 93) prepared the monthly payroll inputs for Finance
--        pers_labour_office    (sort 94) dealt with the labour office themselves
--      NONE carries an `end_on`: no answer turns anybody away (owner, 2026-10-31 — a flow with no
--      automatic rejection). Every row title is inside Meta's 24 characters and every description
--      inside its 72 — Meta answers an over-long row with a 400 for the whole message.
--   3. SEVEN existing questions are WIDENED to `personnel` rather than copied (the owner's "one question,
--      one name", 2026-10-20 — a copy splits one filter across two keys):
--        oc_ms_office_outlook, hr_residence_region, field_age_band, hr_sheraton_commute, hrsh_pharma, hrsh_current_salary, oc_start_date.
--      Each keeps its sort order, so no other role's order moves.
--   4. The built-in expected-salary question's saved audience gains `personnel`. Experience and
--      background are NOT widened: pers_years replaces the generic experience question for this seat.
--   5. ats_workspace_filter's Talent Acquisition fence counts `personnel` as an HR applicant, by
--      declared family and by placement — the owner's rule that her seat never sees an HR applicant.
--      Every other line is the live definition: its comment- and whitespace-normalised body hashed
--      f25a7daf2196961eb5b2509dc722a1e1 on BOTH projects on 2026-10-31, the same as the body of
--      20261020210704_ats_workspace_exclude_filters.sql, which this one is copied from.
--   6. The Job Posts page gains a "Personnel Specialist" title with its duties and requirements, taken
--      from the Senior Personnel Specialist job description written for the owner on 2026-10-31.
--
-- THE ORDER THE BOT ASKS IN: built-ins always come before extras (nextBuiltInQuestion), and a shared
-- row keeps its own sort order, so a Personnel applicant is asked: expected salary, position, MS Office,
-- governorate, age, Sheraton commute, the five pers_* questions, pharma experience, current salary,
-- start date (oc_start_date stays at 300, last for every role).
--
-- WHY: owner, 2026-10-31 — "add to whatsapp bot and add in careers in satopharma.com and create a photo
--   for hiring post", for the 14-question flow he was shown that evening.
--
-- MEASURED 2026-10-31: the seven shared rows exist on PRODUCTION; staging holds only two of them (the
-- rest were written on the Screening Questions screen, not by a migration), so step 3 is a no-op there
-- for the other five — every statement is guarded by key and by "not already present".
--
-- ROLLBACK:
--   delete from public.ats_whatsapp_screening_questions where question_key like 'pers\_%' escape '\';
--     (only while nobody has answered one — an answered question is retired with is_active = false)
--   update public.ats_whatsapp_screening_questions
--      set applies_to_role_families = array_remove(applies_to_role_families, 'personnel')
--    where question_key in ('oc_ms_office_outlook', 'hr_residence_region', 'field_age_band', 'hr_sheraton_commute', 'hrsh_pharma', 'hrsh_current_salary', 'oc_start_date');
--   update public.ats_whatsapp_question_prompts
--      set applies_to_role_families = array_remove(applies_to_role_families, 'personnel')
--    where question_key = 'salary';
--   re-run ats_workspace_filter from 20261020210704_ats_workspace_exclude_filters.sql;
--   delete from public.ats_job_post_titles where lower(btrim(title)) = 'personnel specialist';
--   the check constraint can be narrowed again only once no placement row holds 'personnel'.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Neither destructive nor bulk: six new question rows and one new title row; seven question rows and
-- one saved audience each gain one family; a check constraint is widened and one function replaced.

begin;

-- ── 1. The ninth role tab ───────────────────────────────────────────────────────────────────────

alter table public.ats_candidate_placements drop constraint if exists ats_candidate_placements_role_tab_check;
alter table public.ats_candidate_placements add constraint ats_candidate_placements_role_tab_check check (role_tab in (
  'medical_rep', 'district_manager', 'product_manager', 'rm_am_nsm',
  'hr_section_head', 'talent_acquisition', 'office_coordinator', 'personnel', 'other'
));

-- ── 2. The six Personnel questions ──────────────────────────────────────────────────────────────

insert into public.ats_whatsapp_screening_questions
  (question_key, body_text, kind, options, sort_order, is_active, applies_to_role_families, button_label, show_if, end_on)
select v.question_key, v.body_text, 'tappable', v.options, v.sort_order, true, array['personnel'], v.button_label, null::jsonb, null::jsonb
from (
  values
    (
      'pers_position',
      'Which position are you applying for?',
      '[{"title":"Personnel Specialist","value":"specialist","description":null},{"title":"Senior Specialist","value":"senior","description":"Senior Personnel Specialist"}]'::jsonb,
      2,
      'Choose position'
    ),
    (
      'pers_years',
      'How many years have you worked in personnel administration?',
      '[{"title":"None yet","value":"none","description":null},{"title":"Under 2 years","value":"lt_2","description":null},{"title":"2 to 4 years","value":"2_4","description":null},{"title":"5 to 8 years","value":"5_8","description":null},{"title":"More than 8 years","value":"gt_8","description":null}]'::jsonb,
      90,
      null::text
    ),
    (
      'pers_headcount',
      'How many employees did you handle personnel work for in your last job?',
      '[{"title":"Under 50","value":"lt_50","description":null},{"title":"50 to 150","value":"50_150","description":null},{"title":"150 to 300","value":"150_300","description":null},{"title":"More than 300","value":"gt_300","description":null}]'::jsonb,
      91,
      null::text
    ),
    (
      'pers_insurance_forms',
      'Have you submitted social insurance forms (Form 1, Form 2, Form 6) yourself on the insurance portal?',
      '[{"title":"Yes, regularly","value":"regularly","description":null},{"title":"Yes, a few times","value":"few_times","description":null},{"title":"Someone else did it","value":"someone_else","description":null},{"title":"Never","value":"never","description":null}]'::jsonb,
      92,
      null::text
    ),
    (
      'pers_payroll_inputs',
      'Have you prepared the monthly payroll inputs for Finance — joiners, leavers, attendance and deductions?',
      '[{"title":"Yes, I owned it","value":"owned","description":null},{"title":"Yes, I helped","value":"helped","description":null},{"title":"No","value":"no","description":null}]'::jsonb,
      93,
      null::text
    ),
    (
      'pers_labour_office',
      'Have you dealt with the labour office yourself — filing contracts or handling an inspection?',
      '[{"title":"Yes, I handled it","value":"handled","description":null},{"title":"Yes, I assisted","value":"assisted","description":null},{"title":"No","value":"no","description":null}]'::jsonb,
      94,
      null::text
    )
) as v(question_key, body_text, options, sort_order, button_label)
where not exists (
  select 1 from public.ats_whatsapp_screening_questions q where q.question_key = v.question_key
);

-- ── 3. The shared questions gain the family (order kept, never duplicated) ───────────────────────

update public.ats_whatsapp_screening_questions
   set applies_to_role_families = array_append(applies_to_role_families, 'personnel'),
       updated_at = now()
 where question_key in ('oc_ms_office_outlook', 'hr_residence_region', 'field_age_band', 'hr_sheraton_commute', 'hrsh_pharma', 'hrsh_current_salary', 'oc_start_date')
   and applies_to_role_families is not null
   and not ('personnel' = any (applies_to_role_families));

-- ── 4. The built-in expected salary is asked of this seat ────────────────────────────────────────
-- A NULL or empty audience already means everyone, so only an explicit list is touched.

update public.ats_whatsapp_question_prompts
   set applies_to_role_families = array_append(applies_to_role_families, 'personnel'),
       updated_at = now()
 where question_key = 'salary'
   and applies_to_role_families is not null
   and cardinality(applies_to_role_families) > 0
   and not ('personnel' = any (applies_to_role_families));

-- ── 5. The Talent Acquisition fence counts a Personnel applicant as an HR applicant ───────────────

create or replace function public.ats_workspace_filter(p jsonb)
 returns setof uuid
 language sql
 stable
 set search_path to ''
as $function$
  with pr as (
    select
      coalesce(array(select jsonb_array_elements_text(coalesce(p->'allowed_tabs', '[]'::jsonb))), '{}'::text[]) as allowed_tabs,
      coalesce((p->>'hide_hr_people')::boolean, false) as hide_hr_people,
      nullif(p->>'tab', '') as tab,
      nullif(p->>'region', '') as region,
      nullif(p->>'area', '') as area,
      case when jsonb_typeof(p->'statuses') = 'array' and jsonb_array_length(p->'statuses') > 0 then array(select jsonb_array_elements_text(p->'statuses')) end as statuses,
      case when jsonb_typeof(p->'exclude_statuses') = 'array' and jsonb_array_length(p->'exclude_statuses') > 0 then array(select jsonb_array_elements_text(p->'exclude_statuses')) end as exclude_statuses,
      case when jsonb_typeof(p->'sources') = 'array' and jsonb_array_length(p->'sources') > 0 then array(select jsonb_array_elements_text(p->'sources')) end as sources,
      case when jsonb_typeof(p->'exclude_sources') = 'array' and jsonb_array_length(p->'exclude_sources') > 0 then array(select jsonb_array_elements_text(p->'exclude_sources')) end as exclude_sources,
      nullif(p->>'from', '')::timestamptz as from_at,
      nullif(p->>'to', '')::timestamptz as to_at,
      case when p ? 'answers' and jsonb_typeof(p->'answers') = 'object' then p->'answers' end as answers,
      nullif(p->>'missing', '')::boolean as missing,
      case when jsonb_typeof(p->'call_results') = 'array' and jsonb_array_length(p->'call_results') > 0 then array(select jsonb_array_elements_text(p->'call_results')) end as call_results,
      case when jsonb_typeof(p->'exclude_call_results') = 'array' and jsonb_array_length(p->'exclude_call_results') > 0 then array(select jsonb_array_elements_text(p->'exclude_call_results')) end as exclude_call_results,
      nullif(p->>'returned', '')::boolean as returned,
      nullif(p->>'overdue', '')::boolean as overdue,
      coalesce(nullif(p->>'overdue_shortlist_days', '')::int, 14) as overdue_shortlist_days,
      coalesce(nullif(p->>'overdue_sent_days', '')::int, 7) as overdue_sent_days,
      case when jsonb_typeof(p->'folder_ids') = 'array' and jsonb_array_length(p->'folder_ids') > 0 then array(select jsonb_array_elements_text(p->'folder_ids'))::uuid[] end as folder_ids,
      coalesce(nullif(p->>'archived', ''), 'exclude') as archived,
      nullif(btrim(coalesce(p->>'search', '')), '') as search,
      case when jsonb_typeof(p->'search_ids') = 'array' and jsonb_array_length(p->'search_ids') > 0 then array(select jsonb_array_elements_text(p->'search_ids'))::uuid[] end as search_ids,
      case when p ? 'candidate_ids' then array(select jsonb_array_elements_text(p->'candidate_ids'))::uuid[] end as candidate_ids
  )
  select c.id
  from public.ats_candidates c
  cross join pr
  where
    -- the Talent Acquisition fence, by person
    (not pr.hide_hr_people or (
      coalesce(c.declared_role_family, '') not in ('hr_section_head', 'talent_acquisition', 'personnel', 'human_resources')
      and not exists (
        select 1 from public.ats_candidate_placements hp
        where hp.candidate_id = c.id and hp.role_tab in ('hr_section_head', 'talent_acquisition', 'personnel')
      )
    ))
    -- the tab
    and (
      case
        when pr.tab is null then (
          exists (select 1 from public.ats_candidate_placements ap
                  where ap.candidate_id = c.id and ap.role_tab = any(pr.allowed_tabs))
          or ('needs_placing' = any(pr.allowed_tabs)
              and not exists (select 1 from public.ats_candidate_placements np where np.candidate_id = c.id))
        )
        when pr.tab = 'needs_placing' then (
          'needs_placing' = any(pr.allowed_tabs)
          and not exists (select 1 from public.ats_candidate_placements np where np.candidate_id = c.id)
        )
        else (
          pr.tab = any(pr.allowed_tabs)
          and exists (
            select 1 from public.ats_candidate_placements tp
            where tp.candidate_id = c.id
              and tp.role_tab = pr.tab
              and (
                pr.region is null
                or (pr.region = 'unspecified' and (
                      (tp.role_tab = 'medical_rep' and tp.area_code is null)
                      or (tp.role_tab <> 'medical_rep' and tp.region_code is null)))
                or (pr.region <> 'unspecified' and tp.region_code = pr.region
                    and (tp.role_tab <> 'medical_rep' or tp.area_code is not null))
              )
              and (pr.area is null or tp.area_code = pr.area)
          )
        )
      end
    )
    and (case pr.archived
           when 'only' then c.archived_at is not null
           when 'include' then true
           else c.archived_at is null
         end)
    and (pr.statuses is null or c.status = any(pr.statuses))
    -- hide: a candidate with no status reads as 'new', the same key ats_workspace_counts uses
    and (pr.exclude_statuses is null or coalesce(c.status, 'new') <> all(pr.exclude_statuses))
    and (pr.sources is null or (
      case
        when lower(coalesce(c.source, '')) in ('whatsapp', 'email', 'website', 'interview_calendar') then lower(c.source)
        else 'other'
      end
    ) = any(pr.sources))
    and (pr.exclude_sources is null or (
      case
        when lower(coalesce(c.source, '')) in ('whatsapp', 'email', 'website', 'interview_calendar') then lower(c.source)
        else 'other'
      end
    ) <> all(pr.exclude_sources))
    and (pr.from_at is null or c.created_at >= pr.from_at)
    and (pr.to_at is null or c.created_at < pr.to_at)
    and (pr.answers is null or not exists (
      select 1 from jsonb_each(pr.answers) a
      where jsonb_typeof(a.value) = 'array'
        and jsonb_array_length(a.value) > 0
        and not (
          (public.ats_candidate_answer_value(c, a.key) is null and a.value ? '__missing__')
          or coalesce(public.ats_candidate_answer_value(c, a.key), '') in (select jsonb_array_elements_text(a.value))
        )
    ))
    and (pr.missing is null
         or (pr.missing and coalesce(cardinality(c.missing_answer_keys), 0) > 0)
         or (not pr.missing and c.missing_answer_keys is not null and cardinality(c.missing_answer_keys) = 0))
    and (pr.call_results is null or exists (
      select 1 from (
        select r.result from public.ats_candidate_call_results r
        where r.candidate_id = c.id
        order by r.created_at desc, r.id desc
        limit 1
      ) latest
      where latest.result = any(pr.call_results)
    ))
    -- hide: only the LATEST call result counts; a candidate never called stays in
    and (pr.exclude_call_results is null or not exists (
      select 1 from (
        select r.result from public.ats_candidate_call_results r
        where r.candidate_id = c.id
        order by r.created_at desc, r.id desc
        limit 1
      ) latest
      where latest.result = any(pr.exclude_call_results)
    ))
    and (pr.returned is null
         or (pr.returned = exists (select 1 from public.ats_v_candidate_returns rv where rv.candidate_id = c.id)))
    and (pr.overdue is null or pr.overdue = (
      (c.status = 'shortlisted'
        and coalesce(c.status_changed_at, c.created_at) < now() - make_interval(days => pr.overdue_shortlist_days))
      or (c.status = 'sent_to_manager'
        and coalesce(
              (select max(s.sent_at) from public.ats_candidate_manager_sends s where s.candidate_id = c.id),
              c.status_changed_at, c.created_at
            ) < now() - make_interval(days => pr.overdue_sent_days))
    ))
    and (pr.folder_ids is null or exists (
      select 1 from public.ats_cv_folder_items fi
      where fi.candidate_id = c.id and fi.folder_id = any(pr.folder_ids)
    ))
    and (pr.candidate_ids is null or c.id = any(pr.candidate_ids))
    and (pr.search is null and pr.search_ids is null
      or (pr.search is not null and (
            c.full_name ilike '%' || pr.search || '%'
            or c.email_norm ilike '%' || lower(pr.search) || '%'
            or (length(regexp_replace(pr.search, '\D', '', 'g')) >= 4
                and c.phone_norm like '%' || regexp_replace(pr.search, '\D', '', 'g') || '%')
          ))
      or (pr.search_ids is not null and c.id = any(pr.search_ids)))
$function$;

-- ── 6. The Personnel Specialist title on the Job Posts page ──────────────────────────────────────

insert into public.ats_job_post_titles (title, department, headline, reports_to, location, duties, needs, menu_name)
values (
  'Personnel Specialist',
  'Human Resources',
  E'Two grades open:\nSpecialist and Senior.',
  'HR Section Head',
  'Sheraton, Cairo',
  '[
    {"lead": "Keep every employee file complete", "rest": "— IDs, contracts, qualifications and signed forms"},
    {"lead": "Run social insurance end to end", "rest": "— Form 1, Form 2 and Form 6 on the insurance portal"},
    {"lead": "Prepare the monthly payroll inputs", "rest": "— joiners, leavers, attendance and deductions"},
    {"lead": "Handle the labour office", "rest": "— contract filing, inspections and correspondence"},
    {"lead": "Manage contracts and the employee lifecycle", "rest": "— renewals, probation, transfers and promotions"},
    {"lead": "Own joining and exit paperwork", "rest": "from the first-day file to the final settlement"}
  ]'::jsonb,
  '[
    {"lead": "2–4 years in personnel administration", "rest": "— 5–8 years for the Senior grade"},
    {"lead": "Hands-on social insurance and labour office experience", "rest": ""},
    {"lead": "Payroll inputs and income tax on salaries", "rest": ""},
    {"lead": "Bachelor''s degree", "rest": "in Commerce, Law or Business"},
    {"lead": "Precise and discreet", "rest": "— salary data stays confidential"},
    {"lead": "Pharma or FMCG field-force experience", "rest": "is a plus"},
    {"lead": "Greater Cairo resident", "rest": "/ able to commute to Sheraton"}
  ]'::jsonb,
  'Personnel Specialist'
)
on conflict do nothing;

commit;
