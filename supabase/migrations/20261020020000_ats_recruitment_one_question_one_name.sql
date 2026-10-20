-- Recruitment workspace rebuild — one question, one name; Talent Acquisition and RM/AM + NSM get their
-- questions; the columns the re-ask and the "Ask again on WhatsApp" button record into.
--
-- WHY. The owner ticked "one question one name" on 20 Oct 2026: the bot asked the same question under
-- two or three keys — "How old are you?" as field_age_band, oc_age_band and hrsh_age_band; "When
-- could you start?" as oc_start_date and hrsh_start_date; "Are you based in Cairo?" as oc_cairo and
-- hrsh_cairo; the ATS and med-rep hiring questions as hr_* and hrsh_* twins. So a filter on "Age"
-- had to know three keys, a CV's chips said "How old are you?" twice for nobody, and an answer
-- given under one key was missing under the other. He also ticked "give Talent Acquisition its
-- questions" (they were scoped to the Human Resources menu row retired on 6 Oct, so a Talent
-- Acquisition applicant was asked nothing) and "fill out the RM/AM + NSM questions" (start date, age
-- and team size led).
--
-- HOW. `ats_whatsapp_screening_questions.question_key` is immutable (its trigger refuses a rename),
-- so each merge KEEPS one row, widens its role list, RETIRES the twins (is_active = false — never
-- deleted, their history stays readable), and rewrites the retired key wherever an answer or a
-- condition holds it: candidates' screening_extra_answers, sessions' extra_answers and
-- extra_current_question_key, and every show_if. Where both keys are present the kept key's answer
-- wins and the twin is dropped. The option values of every merged pair are identical (read live on
-- production 20 Oct 2026), so no answer changes meaning.
--
-- PRODUCTION ONLY, BY DESIGN. The hr_*, oc_start_date and hrsh_* rows were created on the Screening
-- Questions screen, not by a migration, so staging does not hold them. Every step is guarded by key and
-- is a no-op where the key is absent; it was verified on production, where the rows live.
--
-- `human_resources` STAYS in the widened role lists beside talent_acquisition: three month-old chats
-- are still open under that family, and taking it out would strand them mid-question. No new chat can
-- choose it (the menu row is retired), so it costs nothing.
--
-- oc_age_band (3 bands: under 25 / 25 to 30 / over 30) is retired and Office Coordinator applicants are
-- now asked field_age_band's 5 bands. Its three stored answers are KEPT as they are — they cannot be
-- mapped onto the 5 bands without guessing — and the workspace shows them as their own filter options.

-- ---------------------------------------------------------------------------------------------
-- 1. Columns the re-ask and the follow-up template record into
-- ---------------------------------------------------------------------------------------------

alter table public.ats_whatsapp_classification_sessions
  add column if not exists reasked_at timestamptz;
comment on column public.ats_whatsapp_classification_sessions.reasked_at is
  'When the in-window re-ask cron re-sent the current question (once per session). Null = never re-asked.';

alter table public.ats_candidates
  add column if not exists followup_sent_at timestamptz,
  add column if not exists followup_sent_by text;
comment on column public.ats_candidates.followup_sent_at is
  'When HR last pressed "Ask again on WhatsApp" (the phx_application_followup template). Sent only on that press.';

-- ---------------------------------------------------------------------------------------------
-- 2. Widen the kept questions' role lists (order kept, no duplicates)
-- ---------------------------------------------------------------------------------------------

create or replace function pg_temp.phx_roles_union(p_roles text[], p_add text[])
returns text[]
language sql
immutable
as $$
  select array(
    select r from unnest(coalesce(p_roles, '{}'::text[]) || p_add) with ordinality u(r, i)
    group by r order by min(i)
  )
$$;

update public.ats_whatsapp_screening_questions
set applies_to_role_families = pg_temp.phx_roles_union(applies_to_role_families,
      array['talent_acquisition', 'hr_section_head', 'office_coordinator', 'area_regional_manager', 'national_sales_manager']),
    updated_at = now()
where question_key = 'field_age_band';

update public.ats_whatsapp_screening_questions
set applies_to_role_families = pg_temp.phx_roles_union(applies_to_role_families,
      array['talent_acquisition', 'hr_section_head', 'area_regional_manager', 'national_sales_manager']),
    updated_at = now()
where question_key = 'oc_start_date';

update public.ats_whatsapp_screening_questions
set applies_to_role_families = pg_temp.phx_roles_union(applies_to_role_families, array['hr_section_head']),
    updated_at = now()
where question_key = 'oc_cairo';

update public.ats_whatsapp_screening_questions
set applies_to_role_families = pg_temp.phx_roles_union(applies_to_role_families, array['talent_acquisition', 'hr_section_head']),
    show_if = null,
    updated_at = now()
where question_key in ('hr_ats_experience', 'hr_medrep_hiring');

update public.ats_whatsapp_screening_questions
set applies_to_role_families = pg_temp.phx_roles_union(applies_to_role_families, array['talent_acquisition']),
    updated_at = now()
where question_key in ('hr_residence_region', 'hr_residence_area', 'hr_sheraton_commute');

-- The HR Section Head flow keeps its old order — Cairo, then residence, then the rest — now that
-- Cairo is oc_cairo (sort 0) and residence follows it.
update public.ats_whatsapp_screening_questions
set sort_order = 1, updated_at = now()
where question_key = 'hrsh_residence' and exists (
  select 1 from public.ats_whatsapp_screening_questions k where k.question_key = 'oc_cairo'
);

-- ---------------------------------------------------------------------------------------------
-- 3. Merge the twins into the kept key
-- ---------------------------------------------------------------------------------------------

do $$
declare
  pair record;
  n_candidates int;
  n_sessions int;
  n_current int;
  n_show_if int;
begin
  for pair in
    select * from (values
      ('hrsh_age_band', 'field_age_band'),
      ('hrsh_start_date', 'oc_start_date'),
      ('hrsh_cairo', 'oc_cairo'),
      ('hrsh_ats_experience', 'hr_ats_experience'),
      ('hrsh_medrep_hiring', 'hr_medrep_hiring')
    ) as v(old_key, new_key)
  loop
    if not exists (select 1 from public.ats_whatsapp_screening_questions where question_key = pair.new_key)
       or not exists (select 1 from public.ats_whatsapp_screening_questions where question_key = pair.old_key) then
      raise notice 'one-question-one-name: % -> % skipped (a key is not on this project)', pair.old_key, pair.new_key;
      continue;
    end if;

    update public.ats_candidates c
    set screening_extra_answers = case
          when c.screening_extra_answers ? pair.new_key then c.screening_extra_answers - pair.old_key
          else (c.screening_extra_answers - pair.old_key)
               || jsonb_build_object(pair.new_key, c.screening_extra_answers -> pair.old_key)
        end
    where c.screening_extra_answers ? pair.old_key;
    get diagnostics n_candidates = row_count;

    update public.ats_whatsapp_classification_sessions s
    set extra_answers = case
          when s.extra_answers ? pair.new_key then s.extra_answers - pair.old_key
          else (s.extra_answers - pair.old_key) || jsonb_build_object(pair.new_key, s.extra_answers -> pair.old_key)
        end
    where s.extra_answers ? pair.old_key;
    get diagnostics n_sessions = row_count;

    update public.ats_whatsapp_classification_sessions s
    set extra_current_question_key = pair.new_key
    where s.extra_current_question_key = pair.old_key;
    get diagnostics n_current = row_count;

    update public.ats_whatsapp_screening_questions q
    set show_if = jsonb_set(q.show_if, '{question_key}', to_jsonb(pair.new_key)), updated_at = now()
    where q.show_if ->> 'question_key' = pair.old_key;
    get diagnostics n_show_if = row_count;

    update public.ats_whatsapp_screening_questions q
    set is_active = false, updated_at = now()
    where q.question_key = pair.old_key;

    raise notice 'one-question-one-name: % -> % (candidates %, sessions %, current %, show_if %)',
      pair.old_key, pair.new_key, n_candidates, n_sessions, n_current, n_show_if;
  end loop;
end $$;

-- oc_age_band: retired, answers kept (see the header).
update public.ats_whatsapp_screening_questions
set is_active = false, updated_at = now()
where question_key = 'oc_age_band'
  and exists (select 1 from public.ats_whatsapp_screening_questions k where k.question_key = 'field_age_band');

-- ---------------------------------------------------------------------------------------------
-- 4. RM/AM + NSM: how many people they have led (the owner's wording is his to change on the
--    Screening Questions screen)
-- ---------------------------------------------------------------------------------------------

insert into public.ats_whatsapp_screening_questions
  (question_key, body_text, kind, options, sort_order, is_active, applies_to_role_families)
select
  'mgr_team_size',
  'How many people have you led?',
  'tappable',
  '[
    {"title": "None yet", "value": "none_yet", "description": null},
    {"title": "1 to 5", "value": "1_to_5", "description": null},
    {"title": "6 to 10", "value": "6_to_10", "description": null},
    {"title": "11 to 20", "value": "11_to_20", "description": null},
    {"title": "More than 20", "value": "more_than_20", "description": null}
  ]'::jsonb,
  60,
  true,
  array['area_regional_manager', 'national_sales_manager']
where not exists (select 1 from public.ats_whatsapp_screening_questions where question_key = 'mgr_team_size');

-- ---------------------------------------------------------------------------------------------
-- 5. The CV-lifecycle sheet's age column reads the kept key first
-- ---------------------------------------------------------------------------------------------
--
-- Rewritten from the LIVE definition rather than retyped, so nothing else in a 90-line view can drift;
-- security_invoker is restated because CREATE OR REPLACE VIEW replaces a view's options.

do $$
declare
  v_def text := pg_get_viewdef('public.ats_v_cv_lifecycle'::regclass);
  v_old text := '(c.screening_extra_answers ->> ''oc_age_band''::text) AS screening_age_band';
  v_new text := 'COALESCE(c.screening_extra_answers ->> ''field_age_band''::text, c.screening_extra_answers ->> ''oc_age_band''::text) AS screening_age_band';
begin
  if position(v_old in v_def) = 0 then
    raise notice 'ats_v_cv_lifecycle: screening_age_band is not in the expected shape — left as it is';
    return;
  end if;
  execute 'create or replace view public.ats_v_cv_lifecycle with (security_invoker = on) as ' || replace(v_def, v_old, v_new);
end $$;
