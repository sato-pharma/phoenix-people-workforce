-- ats_product_manager_screening_questions
--
-- WHAT THIS CHANGES:
--   1. Seeds the Product Manager screening flow — FIVE questions keyed `pm_*`, scoped to
--      ['product_manager'], sort_order 200-204 (a clear block after the HR Section Head's 100-107):
--        pm_experience     years as a Product Manager in pharma. TAPPING "Not a Product Manager" or
--                          "Less than 1 year" ENDS the conversation with a thank-you (`end_on`).
--        pm_launch         has launched a new product
--        pm_greater_cairo  lives in Greater Cairo — a PREFERENCE, so NO `end_on`
--        pm_specialities   Chest / ENT / Urology experience — also a preference
--        pm_ms_office      command of PowerPoint, Excel and Word
--   2. Adds `product_manager` to the EXISTING shared start-date question (`oc_start_date`) instead of
--      writing a sixth, and moves it to sort_order 300 so it stays the LAST question for every role
--      that gets it — it is already last for all four of them (office_coordinator 0-14, medical_rep
--      7/10/14, district_manager 6/7/10/14, human_resources 8-14), so no role's order changes.
-- WHY: the owner opened the Product Manager seat and asked for its WhatsApp questions (2026-10-16, in
--   chat). Each question is one of the seven requirements on the job post. His three rulings, in his
--   own words: "no pass if more than 1 year make him continue" — the experience question is a real
--   gate and ends the chat below a year; "exclude this question" about English — so there is NO
--   English question; "ask about expexcted salary and when will be able to join if accwpted" — the
--   expected salary is the built-in `salary` question, which this family is already asked, and the
--   joining date is the shared start-date row widened in step 2.
--   Two requirements need no question of their own: "pharmacist or vet graduate" is the built-in
--   `background` question (its audience already lists product_manager, as do `experience` and
--   `salary`), and "excellent communication and analytical skills" is not asked — a self-rating
--   screens nobody, and the CV and the interview answer it.
-- ROLLBACK:
--   delete from public.ats_whatsapp_screening_questions where question_key like 'pm\_%' escape '\';
--     (only safe while nobody has answered one — an answered question is retired with is_active = false)
--   update public.ats_whatsapp_screening_questions
--      set applies_to_role_families = array_remove(applies_to_role_families, 'product_manager'),
--          sort_order = 14
--    where question_key = 'oc_start_date';
--
-- MEASURED 2026-10-16: `oc_start_date` exists on PRODUCTION only — it is one of the questions the owner
-- wrote on the Screening Questions screen, which is his to own, so staging has no such row and step 2
-- matched nothing there. That is why it is written as a guarded update rather than an upsert: where the
-- shared row does not exist, this migration leaves the Product Manager with its five questions and no
-- start-date question, and never invents a sixth row behind his back.
--
-- ADDITIVE AND IDEMPOTENT: the five rows are inserted only if their key is absent, so a re-run — or
-- the owner's later edit of their wording on the Screening Questions screen — is never overwritten.
-- The start-date statement only ever adds this one family, and only while the family is absent.
-- Every row title is inside Meta's 24-character ceiling and every description inside its 72, which
-- Meta enforces server-side as a 400 for the whole message rather than as a truncation.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Neither destructive nor bulk: five new rows, and one existing row gains a family and a sort order.

begin;

-- ── 1. The five Product Manager questions ───────────────────────────────────────────────────────

insert into public.ats_whatsapp_screening_questions
  (question_key, body_text, kind, options, sort_order, is_active, applies_to_role_families, show_if, end_on)
select v.question_key, v.body_text, v.kind, v.options, v.sort_order, true, array['product_manager'], null::jsonb, v.end_on
from (
  values
    (
      'pm_experience',
      'How long have you worked as a Product Manager in a pharmaceutical company?',
      'tappable',
      '[{"title":"Not a Product Manager","value":"not_yet","description":"I work in another role"},{"title":"Less than 1 year","value":"lt_1","description":null},{"title":"1 - 3 years","value":"1_3","description":null},{"title":"3 - 5 years","value":"3_5","description":null},{"title":"More than 5 years","value":"gt_5","description":null}]'::jsonb,
      200,
      '{"values":["not_yet","lt_1"],"message":"Thank you for your interest in Sato Pharma.\n\nThis role needs more than a year of experience as a Product Manager in a pharmaceutical company, so we are unable to take your application further at the moment.\n\nYour CV stays on file, and we will contact you if a suitable opening comes up."}'::jsonb
    ),
    (
      'pm_launch',
      'Have you launched a new product?',
      'tappable',
      '[{"title":"Yes, I led the launch","value":"led_launch","description":"The launch was mine to run"},{"title":"Yes, I was in the team","value":"in_the_team","description":"I was part of a launch team"},{"title":"No, not yet","value":"no","description":null}]'::jsonb,
      201,
      null::jsonb
    ),
    (
      'pm_greater_cairo',
      'Do you live in Greater Cairo?',
      'tappable',
      '[{"title":"Yes","value":"yes","description":null},{"title":"No, but I can move","value":"can_move","description":"I would relocate for the job"},{"title":"No","value":"no","description":null}]'::jsonb,
      202,
      null::jsonb
    ),
    (
      'pm_specialities',
      'Have you worked on products in any of these areas?',
      'tappable',
      '[{"title":"Chest","value":"chest","description":null},{"title":"ENT","value":"ent","description":null},{"title":"Urology","value":"urology","description":null},{"title":"Two or more of them","value":"two_or_more","description":null},{"title":"None of these","value":"none","description":null}]'::jsonb,
      203,
      null::jsonb
    ),
    (
      'pm_ms_office',
      'How would you describe your command of PowerPoint, Excel and Word?',
      'tappable',
      '[{"title":"Advanced","value":"advanced","description":"I build my own decks and sheets"},{"title":"Good","value":"good","description":"I can do most of what a job needs"},{"title":"Basic","value":"basic","description":"I know the essentials"}]'::jsonb,
      204,
      null::jsonb
    )
) as v(question_key, body_text, kind, options, sort_order, end_on)
where not exists (
  select 1 from public.ats_whatsapp_screening_questions q where q.question_key = v.question_key
);

-- ── 2. The shared start-date question gains this family, and keeps the last slot ────────────────

update public.ats_whatsapp_screening_questions
   set applies_to_role_families = array_append(applies_to_role_families, 'product_manager'),
       sort_order = 300,
       updated_at = now()
 where question_key = 'oc_start_date'
   and applies_to_role_families is not null
   and not ('product_manager' = any (applies_to_role_families));

commit;
