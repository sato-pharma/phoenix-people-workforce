-- ats_question_prompts_list_chrome
--
-- WHAT THIS CHANGES: adds two nullable text columns to public.ats_whatsapp_question_prompts —
--   `button_label` (the words on the button that opens a WhatsApp list, "Choose a role" in code)
--   and `section_title` (the heading above the answers, "Roles" in code) — extends the table's
--   not-empty CHECK so a row carrying ONLY one of them is legal, and adds length CHECKs at Meta's
--   own ceilings (20 and 24) plus a guard that the one free-text question carries neither.
-- WHY: the question body and every answer's words were already owner-editable, but these two were
--   not, so a question reworded into Arabic still sat under an English "Choose a role". They are
--   drawn by WhatsApp around the message rather than inside it, which is why they are separate
--   columns and not part of `body_text`.
-- ROLLBACK:
--   alter table public.ats_whatsapp_question_prompts
--     drop constraint if exists ats_whatsapp_question_prompts_free_text_chrome_check,
--     drop constraint if exists ats_whatsapp_question_prompts_section_title_check,
--     drop constraint if exists ats_whatsapp_question_prompts_button_label_check,
--     drop column if exists section_title,
--     drop column if exists button_label;
--   then re-add the not-empty CHECK without the two new disjuncts (its pre-image is in
--   20260905093000_ats_question_prompts_role_audience.sql). Dropping the columns loses whatever
--   wording was saved in them; the questions themselves revert to the code's own words, which is
--   the same direction every other fallback in this feature takes.
--
-- PURELY ADDITIVE: no row is written, read, moved or deleted. Nothing is seeded — an absent value
-- means "use the code's own words", and storing a copy of a default is what makes a later
-- improvement to the code invisible on a question nobody meant to customise.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.ats_whatsapp_question_prompts
  add column if not exists button_label text,
  add column if not exists section_title text;

-- Meta's own ceilings, and they are refusals of the WHOLE message rather than truncations: a
-- 21-character button does not arrive clipped, it does not arrive, and the applicant is left with a
-- question they cannot answer. Blank is refused too — the "keep the code's own words" state is NULL,
-- and an empty string would be a list with no words on its button.
alter table public.ats_whatsapp_question_prompts
  drop constraint if exists ats_whatsapp_question_prompts_button_label_check;

alter table public.ats_whatsapp_question_prompts
  add constraint ats_whatsapp_question_prompts_button_label_check
    check (button_label is null or char_length(btrim(button_label)) between 1 and 20);

alter table public.ats_whatsapp_question_prompts
  drop constraint if exists ats_whatsapp_question_prompts_section_title_check;

alter table public.ats_whatsapp_question_prompts
  add constraint ats_whatsapp_question_prompts_section_title_check
    check (section_title is null or char_length(btrim(section_title)) between 1 and 24);

-- The salary question is free text — the bot sends it as a plain message, so there is no list, no
-- button and no heading. A value here would save, read back, and reach nobody.
alter table public.ats_whatsapp_question_prompts
  drop constraint if exists ats_whatsapp_question_prompts_free_text_chrome_check;

alter table public.ats_whatsapp_question_prompts
  add constraint ats_whatsapp_question_prompts_free_text_chrome_check
    check (question_key <> 'salary' or (button_label is null and section_title is null));

-- THE ONE THAT WOULD OTHERWISE SHIP BROKEN — the same trap the audience column hit on 2026-09-05.
-- The not-empty CHECK predates these columns, so a row carrying ONLY a button label (an owner who
-- translates the button and leaves the question alone, which is the common case) would be refused
-- outright by a constraint whose message names none of this. Extended, never dropped: a row
-- overriding nothing at all still overrides nothing, and "is this question customised?" must stay
-- answerable from the row's existence alone.
alter table public.ats_whatsapp_question_prompts
  drop constraint if exists ats_whatsapp_question_prompts_not_empty_check;

alter table public.ats_whatsapp_question_prompts
  add constraint ats_whatsapp_question_prompts_not_empty_check
    check (
      body_text is not null
      or option_labels <> '{}'::jsonb
      or hidden_options <> '[]'::jsonb
      or option_order <> '[]'::jsonb
      or applies_to_role_families is not null
      or button_label is not null
      or section_title is not null
    );

comment on column public.ats_whatsapp_question_prompts.button_label is
  'The words on the button that opens this question''s WhatsApp list. NULL means use the code''s own ("Choose a role"). Max 20 — Meta refuses the whole message over it.';

comment on column public.ats_whatsapp_question_prompts.section_title is
  'The heading WhatsApp prints above this question''s answers. NULL means use the code''s own ("Roles"). Max 24 — Meta refuses the whole message over it.';

commit;
