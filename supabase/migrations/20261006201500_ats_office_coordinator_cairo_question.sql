-- ats_office_coordinator_cairo_question
--
-- WHAT THIS CHANGES: adds ONE screening question, `oc_cairo` ("Are you based in Cairo?"), scoped to
--   ['office_coordinator']. Answering No ends the conversation with the same Cairo-office thank-you the
--   HR Section Head gets (`hrsh_cairo`); Yes carries on to the rest of the Office Coordinator questions.
-- WHY: the owner asked for the Cairo question on the Office Coordinator flow, as the 3rd or 4th question.
--   The built-in questions always come first (role, background, experience, salary) and the extras after
--   them, so sort_order 0 makes this the FIRST extra — the 4th question the applicant meets on the
--   careers form (background, experience, salary, Cairo) and straight after the salary on WhatsApp —
--   ahead of the age question (sort_order 1) and every later one. The same set drives both channels.
-- ROLLBACK:
--   delete from public.ats_whatsapp_screening_questions where question_key = 'oc_cairo';
--     (only safe while nobody has answered it — an answered question is retired with is_active = false)
--
-- ADDITIVE AND IDEMPOTENT: inserts the row only if its key is absent, so a re-run — or the owner's later
-- edit of its wording on the Screening Questions screen — is never overwritten. No existing row changes.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.

begin;

insert into public.ats_whatsapp_screening_questions
  (question_key, body_text, kind, options, sort_order, is_active, applies_to_role_families, end_on)
select
  'oc_cairo',
  'Are you based in Cairo?',
  'tappable',
  '[{"title":"Yes","value":"yes","description":null},{"title":"No","value":"no","description":null}]'::jsonb,
  0,
  true,
  array['office_coordinator'],
  jsonb_build_object(
    'values', jsonb_build_array('no'),
    'message', E'Thank you for your interest in Sato Pharma.\n\nThis role is based at our Cairo office and we need the successful candidate to live in Cairo, so we are unable to take your application further at the moment.\n\nYour CV stays on file, and we will contact you if a suitable opening comes up.'
  )
where not exists (
  select 1 from public.ats_whatsapp_screening_questions where question_key = 'oc_cairo'
);

commit;
