-- ats_screening_questions_conditional_flow
--
-- WHAT THIS CHANGES:
--   1. Adds two nullable jsonb columns to public.ats_whatsapp_screening_questions:
--        show_if  {"question_key": "...", "values": ["<option code>", ...]}
--                 the question is asked ONLY when the applicant's answer to question_key was one of
--                 those option codes. NULL = asked whenever the role matches (every existing row).
--        end_on   {"values": ["<option code>", ...], "message": "<words>"}
--                 tapping one of those answers ENDS the conversation and sends `message` in place of
--                 the usual closing summary. NULL = no answer ends it (every existing row).
--      with CHECKs on their shape (an end_on rule needs a tappable question and a non-empty message
--      within WhatsApp's 1024-character body limit).
--   2. Seeds the HR Section Head question flow — eight questions keyed `hrsh_*`, all scoped to
--      ['hr_section_head'] — which is the first user of both columns:
--        Are you based in Cairo?  (No ends the conversation with the Cairo-residence message)
--          Yes -> current area of residence
--        How old are you?
--        Experience in pharmaceutical companies?
--          Yes -> experience hiring medical reps, then recruitment-system experience
--        Current monthly net salary (typed)
--        When could you start?
--   3. Narrows the built-in questions for this seat in ats_whatsapp_question_prompts:
--        background  gains hr_section_head (its audience is an explicit list, so a new role is absent
--                    until it is added)
--        experience  asked to every role EXCEPT hr_section_head (the pharma question replaces it)
--        salary      asked to every role EXCEPT hr_section_head (the current-salary question replaces
--                    the expected-salary one)
--      region and area are already scoped to the sales roles, so this seat is not asked either.
-- WHY: the owner asked for an HR Section Head flow whose questions depend on earlier answers and which
--   thanks a non-Cairo applicant and stops. The bot had no show-if and no end-on-answer, and both are
--   generic: the owner can use them on any question from now on.
-- ROLLBACK:
--   delete from public.ats_whatsapp_screening_questions where question_key like 'hrsh\_%' escape '\';
--     (only safe while nobody has answered one — answered questions are retired with is_active = false)
--   update public.ats_whatsapp_question_prompts
--     set applies_to_role_families = array_remove(applies_to_role_families, 'hr_section_head')
--     where question_key = 'background';
--   update public.ats_whatsapp_question_prompts set applies_to_role_families = null
--     where question_key in ('experience', 'salary') and body_text is null;   -- salary has wording: leave its row
--   alter table public.ats_whatsapp_screening_questions
--     drop constraint if exists ats_whatsapp_screening_questions_end_on_check,
--     drop constraint if exists ats_whatsapp_screening_questions_show_if_check,
--     drop column if exists end_on, drop column if exists show_if;
--
-- ADDITIVE AND IDEMPOTENT: no existing question row is changed. The seeded rows are inserted only if
-- their key is absent, so a re-run — or an owner's later edit of their wording on the Screening
-- Questions screen — is never overwritten. The three prompt-audience statements only ever add this one
-- role's rule.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.

begin;

-- ── 1. The two rule columns ─────────────────────────────────────────────────────────────────────

alter table public.ats_whatsapp_screening_questions
  add column if not exists show_if jsonb,
  add column if not exists end_on jsonb;

alter table public.ats_whatsapp_screening_questions
  drop constraint if exists ats_whatsapp_screening_questions_show_if_check;

alter table public.ats_whatsapp_screening_questions
  add constraint ats_whatsapp_screening_questions_show_if_check
    check (
      show_if is null
      or (
        jsonb_typeof(show_if) = 'object'
        and jsonb_typeof(show_if -> 'question_key') = 'string'
        and jsonb_typeof(show_if -> 'values') = 'array'
        and jsonb_array_length(show_if -> 'values') > 0
      )
    );

alter table public.ats_whatsapp_screening_questions
  drop constraint if exists ats_whatsapp_screening_questions_end_on_check;

alter table public.ats_whatsapp_screening_questions
  add constraint ats_whatsapp_screening_questions_end_on_check
    check (
      end_on is null
      or (
        kind = 'tappable'
        and jsonb_typeof(end_on) = 'object'
        and jsonb_typeof(end_on -> 'values') = 'array'
        and jsonb_array_length(end_on -> 'values') > 0
        and jsonb_typeof(end_on -> 'message') = 'string'
        and char_length(btrim(end_on ->> 'message')) between 1 and 1024
      )
    );

comment on column public.ats_whatsapp_screening_questions.show_if is
  'Conditional question: {"question_key": "<other question>", "values": ["<option code>", ...]}. Asked only when the applicant''s answer to that question was one of those option codes. NULL = asked whenever the role matches.';
comment on column public.ats_whatsapp_screening_questions.end_on is
  'End-on-answer: {"values": ["<option code>", ...], "message": "<words>"}. Tapping one of those answers ends the conversation and sends message instead of the closing summary. The answers so far are still recorded. NULL = no answer ends it.';

-- ── 2. The HR Section Head questions ────────────────────────────────────────────────────────────
-- sort_order starts at 100: after every question that exists today, and the order among these eight is
-- the order they are asked. The admin screen renumbers by list position on save, which keeps it.

insert into public.ats_whatsapp_screening_questions
  (question_key, body_text, kind, options, sort_order, is_active, applies_to_role_families, show_if, end_on)
select v.question_key, v.body_text, v.kind, v.options, v.sort_order, true, array['hr_section_head'], v.show_if, v.end_on
from (
  values
    (
      'hrsh_cairo',
      'Are you based in Cairo?',
      'tappable',
      '[{"title":"Yes","value":"yes","description":null},{"title":"No","value":"no","description":null}]'::jsonb,
      100,
      null::jsonb,
      '{"values":["no"],"message":"Thank you for your interest in Sato Pharma.\n\nThis role is based at our Cairo office and we need the successful candidate to live in Cairo, so we are unable to take your application further at the moment.\n\nYour CV stays on file, and we will contact you if a suitable opening comes up."}'::jsonb
    ),
    (
      'hrsh_residence',
      'What is your current area of residence?',
      'tappable',
      '[{"title":"Heliopolis","value":"heliopolis","description":null},{"title":"Nasr City","value":"nasr_city","description":null},{"title":"New Cairo","value":"new_cairo","description":null},{"title":"Rehab / Madinaty","value":"rehab_madinaty","description":null},{"title":"Obour / Shorouk","value":"obour_shorouk","description":null},{"title":"Ain Shams / Matariya","value":"ain_shams_matariya","description":null},{"title":"Downtown / Shubra","value":"downtown_shubra","description":null},{"title":"Maadi / Helwan","value":"maadi_helwan","description":null},{"title":"Giza side","value":"giza_side","description":null},{"title":"Somewhere else","value":"somewhere_else","description":null}]'::jsonb,
      101,
      '{"question_key":"hrsh_cairo","values":["yes"]}'::jsonb,
      null::jsonb
    ),
    (
      'hrsh_age_band',
      'How old are you?',
      'tappable',
      '[{"title":"Under 25","value":"under_25","description":null},{"title":"25 to 29","value":"25_to_29","description":null},{"title":"30 to 34","value":"30_to_34","description":null},{"title":"35 to 39","value":"35_to_39","description":null},{"title":"40 or older","value":"40_or_older","description":null}]'::jsonb,
      102,
      null::jsonb,
      null::jsonb
    ),
    (
      'hrsh_pharma',
      'Do you have experience in pharmaceutical companies?',
      'tappable',
      '[{"title":"Yes","value":"yes","description":null},{"title":"No","value":"no","description":null}]'::jsonb,
      103,
      null::jsonb,
      null::jsonb
    ),
    (
      'hrsh_medrep_hiring',
      'Do you have experience hiring medical reps for a pharmaceutical company?',
      'tappable',
      '[{"title":"Yes, it was my main job","value":"yes_main_job","description":"I hired medical reps regularly"},{"title":"Yes, a few times","value":"yes_a_few_times","description":"I have hired some medical reps"},{"title":"Other roles only","value":"other_roles_only","description":"I hired, but not medical reps"},{"title":"No","value":"no","description":"I have not hired before"}]'::jsonb,
      104,
      '{"question_key":"hrsh_pharma","values":["yes"]}'::jsonb,
      null::jsonb
    ),
    (
      'hrsh_ats_experience',
      'Have you used a recruitment system (ATS)?',
      'tappable',
      '[{"title":"Yes, every day","value":"yes_every_day","description":"It was part of my daily work"},{"title":"Some exposure","value":"some_exposure","description":"I have used one now and then"},{"title":"Excel sheets only","value":"excel_sheets_only","description":"I tracked candidates in Excel"},{"title":"Never","value":"never","description":null}]'::jsonb,
      105,
      '{"question_key":"hrsh_pharma","values":["yes"]}'::jsonb,
      null::jsonb
    ),
    (
      'hrsh_current_salary',
      E'What is your current monthly net salary?\n\nSend it as a normal message, in EGP.',
      'free_text',
      null::jsonb,
      106,
      null::jsonb,
      null::jsonb
    ),
    (
      'hrsh_start_date',
      'If you were offered the job, when could you start?',
      'tappable',
      '[{"title":"Immediately","value":"immediately","description":null},{"title":"Within 2 weeks","value":"within_2_weeks","description":null},{"title":"About 1 month","value":"about_1_month","description":null},{"title":"2 months or more","value":"2_months_or_more","description":null}]'::jsonb,
      107,
      null::jsonb,
      null::jsonb
    )
) as v(question_key, body_text, kind, options, sort_order, show_if, end_on)
where not exists (
  select 1 from public.ats_whatsapp_screening_questions q where q.question_key = v.question_key
);

-- ── 3. The built-in questions, narrowed for this seat ───────────────────────────────────────────
-- `background` already holds an explicit list, so the new role is added to it.
update public.ats_whatsapp_question_prompts
   set applies_to_role_families = array_append(applies_to_role_families, 'hr_section_head'),
       updated_at = now()
 where question_key = 'background'
   and applies_to_role_families is not null
   and not ('hr_section_head' = any (applies_to_role_families));

-- `experience` has no row yet (it is asked to everyone by default) and `salary` has a row with no
-- audience. Both become "every role except hr_section_head". Written as an explicit list because that
-- is how this table spells a narrowed audience — a role added to the system LATER has to be added to
-- these two lists to be asked them, exactly as it already has to be for `background`.
insert into public.ats_whatsapp_question_prompts (question_key, applies_to_role_families)
select k, array[
    'district_manager', 'area_regional_manager', 'national_sales_manager', 'medical_rep', 'product_manager',
    'sales', 'pharmacist', 'human_resources', 'talent_acquisition', 'finance', 'office_coordinator', 'other'
  ]
from (values ('experience'), ('salary')) as t(k)
on conflict (question_key) do update
  set applies_to_role_families = excluded.applies_to_role_families,
      updated_at = now()
  where public.ats_whatsapp_question_prompts.applies_to_role_families is null;

commit;
