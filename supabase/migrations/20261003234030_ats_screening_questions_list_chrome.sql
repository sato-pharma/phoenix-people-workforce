-- ats_screening_questions_list_chrome
--
-- WHAT THIS CHANGES: adds `button_label` and `section_title` (both nullable text) to
--   public.ats_whatsapp_screening_questions — the owner's OWN extra questions, the ones the builder
--   on the Screening Questions screen creates — with length CHECKs at Meta's ceilings (20 and 24)
--   and a CHECK that a free_text question carries neither.
-- WHY: the sibling change on ats_whatsapp_question_prompts made the list button and answer heading
--   editable for the six built-in questions. Leaving the admin's own questions out would put an
--   Arabic question of his under a generic English "Choose an option" — the same half-translated
--   message, one screen section lower.
-- ROLLBACK:
--   alter table public.ats_whatsapp_screening_questions
--     drop constraint if exists ats_whatsapp_screening_questions_free_text_chrome_check,
--     drop constraint if exists ats_whatsapp_screening_questions_section_title_check,
--     drop constraint if exists ats_whatsapp_screening_questions_button_label_check,
--     drop column if exists section_title,
--     drop column if exists button_label;
--   Dropping the columns loses whatever wording was saved in them; every question's list reverts to
--   "Choose an option" / "Options", which is what it said before this feature.
--
-- PURELY ADDITIVE: no row is written, read, moved or deleted, and nothing is seeded — NULL means
-- "use the code's generic default", so a question nobody has worded keeps following the code.
-- Unlike the prompts table there is no not-empty CHECK to extend here: a row in this table IS the
-- question, so it was never in danger of being refused for overriding nothing.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.ats_whatsapp_screening_questions
  add column if not exists button_label text,
  add column if not exists section_title text;

-- Meta's own ceilings, and both are refusals of the WHOLE message rather than truncations. Blank is
-- refused as well: the "use the default" state is NULL, and an empty string would be a list with no
-- words on its button, which WhatsApp will not send.
alter table public.ats_whatsapp_screening_questions
  drop constraint if exists ats_whatsapp_screening_questions_button_label_check;

alter table public.ats_whatsapp_screening_questions
  add constraint ats_whatsapp_screening_questions_button_label_check
    check (button_label is null or char_length(btrim(button_label)) between 1 and 20);

alter table public.ats_whatsapp_screening_questions
  drop constraint if exists ats_whatsapp_screening_questions_section_title_check;

alter table public.ats_whatsapp_screening_questions
  add constraint ats_whatsapp_screening_questions_section_title_check
    check (section_title is null or char_length(btrim(section_title)) between 1 and 24);

-- A free_text question is sent as a plain message. It has no list, so a button or heading saved
-- against one would be stored, read back, and shown to nobody — and the next reader would "fix"
-- that by sending a list.
alter table public.ats_whatsapp_screening_questions
  drop constraint if exists ats_whatsapp_screening_questions_free_text_chrome_check;

alter table public.ats_whatsapp_screening_questions
  add constraint ats_whatsapp_screening_questions_free_text_chrome_check
    check (kind <> 'free_text' or (button_label is null and section_title is null));

comment on column public.ats_whatsapp_screening_questions.button_label is
  'The words on the button that opens this question''s WhatsApp list. NULL means use the code''s default ("Choose an option"). Max 20 — Meta refuses the whole message over it.';

comment on column public.ats_whatsapp_screening_questions.section_title is
  'The heading WhatsApp prints above this question''s answers. NULL means use the code''s default ("Options"). Max 24 — Meta refuses the whole message over it.';

commit;
