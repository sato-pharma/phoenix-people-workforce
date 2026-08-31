-- Recruitment / ATS — owner-editable WORDING for the six built-in WhatsApp screening questions,
-- and for the ANSWERS the applicant taps to reply to them.
--
-- WHY. 20260831150000 gave the owner a builder for BRAND-NEW questions, asked after the fixed six.
-- Opening that screen he asked for "the questions already available" — the six the bot has always
-- asked — to be editable too, and then for the answers to be shown and editable as well. Copying the
-- six into ats_whatsapp_screening_questions would have asked every applicant all six a SECOND time
-- (that table is the extra-question loop, appended after the fixed six), so both live here instead,
-- in their own table, keyed by the step they belong to.
--
-- WHAT IS AND IS NOT EDITABLE — the one boundary this whole feature rests on.
--
--   EDITABLE:     the prompt text, and the TITLE and DESCRIPTION of each tappable answer — that is,
--                 every word the applicant actually reads.
--   NOT EDITABLE: the CODE underneath each answer. A row's WhatsApp id is `phx:<step>:<value>`, and
--                 `<value>` is a candidateRoleFamily / candidateRegionCode / background / experience
--                 code read far beyond this bot — pool filters, candidate folders, manager routing,
--                 the organogram. Relabelling changes what is displayed; the value the applicant's
--                 tap sends back is byte-identical, so every downstream reader sees exactly what it
--                 saw before. A free-typed VALUE would instead produce answers the rest of Phoenix
--                 cannot interpret, which is why option_labels is keyed BY value and can only ever
--                 rewrite the two display fields.
--
-- The area question is the partial case: its rows are the live areas of whichever region the
-- applicant just chose, read from au.canonical_areas at send time, so there is no fixed list to
-- relabel. Only its "My area is not listed" escape row is relabellable, and the app is what knows
-- that — this table simply stores whatever labels it is given, by value.
--
-- ABSENT ROW = CODE DEFAULT, at both levels. There are no seed rows on purpose, body_text is
-- nullable, and option_labels defaults to an empty object. A key with no row — or a row whose
-- body_text is null, or whose option_labels lacks a value — falls back to
-- whatsapp-classify-menus.ts. So "reset to default" is a DELETE rather than a second copy of the
-- default text that would silently go stale the day the code default is improved, editing only the
-- answers does not force a copy of the prompt to be stored beside them, and the whole feature stays
-- inert until somebody actually edits something.
--
-- Purely additive: one new table, no existing row read, rewritten or moved. Reversible by dropping
-- it — every prompt and every answer then returns to its code default with no other change.

begin;

create table if not exists public.ats_whatsapp_question_prompts (
  question_key text primary key,

  -- NULL means "the code default". Only set when the owner has actually reworded the question.
  body_text text,

  -- { "<option value>": { "title": "...", "description": "..." } } — display text only, keyed by the
  -- code the tap sends back. A value absent here keeps its code label. The per-field length limits
  -- (title 24, description 72) are Meta's and are enforced in TypeScript at both save time and send
  -- time; a plain CHECK cannot walk a jsonb object's members, so this constraint holds the shape and
  -- the app holds the lengths — the same division the six hardcoded questions have always used.
  option_labels jsonb not null default '{}'::jsonb,

  -- Answer VALUES not to offer, as an array. Hiding rather than deleting is deliberate: the code
  -- stays legal, so an applicant who answered before it was hidden still reads back correctly
  -- everywhere, and un-hiding is one click rather than a code change. This is also how an answer is
  -- ADDED — every value a question could offer already exists in code, and some are deliberately not
  -- shown (the owner named the job-title list himself on 2026-08-28, leaving `sales` and `pharmacist`
  -- off it). A value present here is not offered; absent, it is.
  hidden_options jsonb not null default '[]'::jsonb,

  -- The order the answers are shown in, as an array of values. Empty means the code's own order.
  -- Values missing from the array keep their code order AFTER the ones listed, so a partial order
  -- written by an older client can never silently drop an answer off the menu.
  option_order jsonb not null default '[]'::jsonb,

  updated_by_hr_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The six built-in steps, and nothing else. A typo'd key would otherwise sit here silently
  -- overriding nothing at all, which reads on screen exactly like a saved edit that does not work.
  constraint ats_whatsapp_question_prompts_key_check
    check (question_key in ('job_title', 'background', 'region', 'area', 'experience', 'salary')),

  -- Meta rejects the whole message when the body is over 1024, so an over-long prompt would not be
  -- truncated — it would stop the conversation dead for that applicant. Mirrored in TypeScript at
  -- both save time and send time; kept here too so no path can write one. An empty string is refused
  -- separately from NULL: NULL is "use the default", "" is a question nobody could answer.
  constraint ats_whatsapp_question_prompts_body_check
    check (body_text is null or char_length(body_text) between 1 and 1024),

  -- An object, never an array or a scalar — the app indexes it by option value.
  constraint ats_whatsapp_question_prompts_option_labels_check
    check (jsonb_typeof(option_labels) = 'object'),

  -- Arrays of values, never objects — the app iterates both.
  constraint ats_whatsapp_question_prompts_hidden_options_check
    check (jsonb_typeof(hidden_options) = 'array'),
  constraint ats_whatsapp_question_prompts_option_order_check
    check (jsonb_typeof(option_order) = 'array'),

  -- A row carrying no override of any kind overrides nothing. Refusing it keeps "is this question
  -- customised?" answerable from the row's existence alone.
  constraint ats_whatsapp_question_prompts_not_empty_check
    check (
      body_text is not null
      or option_labels <> '{}'::jsonb
      or hidden_options <> '[]'::jsonb
      or option_order <> '[]'::jsonb
    )
);

comment on table public.ats_whatsapp_question_prompts is
  'Owner-editable prompt text and answer LABELS for the six built-in WhatsApp screening questions. One row per step; an absent row, a null body_text, or a value missing from option_labels all mean the code default in whatsapp-classify-menus.ts. Answer VALUES are never stored here - they stay in code, because the rest of the app reads them.';

comment on column public.ats_whatsapp_question_prompts.body_text is
  'The prompt an applicant reads, or NULL for the code default. For question_key = ''area'' the token {region} is replaced with the region name they chose.';

comment on column public.ats_whatsapp_question_prompts.option_labels is
  'Display overrides for the tappable answers, keyed by the option VALUE (the code the tap sends back): { "<value>": { "title": "...", "description": "..." } }. Rewrites what is shown only - never the value itself.';

alter table public.ats_whatsapp_question_prompts enable row level security;

-- Matches every other ats_ table: application-scoped visibility, service_role only at the database.
drop policy if exists phx_ats_whatsapp_question_prompts_service_role on public.ats_whatsapp_question_prompts;
create policy phx_ats_whatsapp_question_prompts_service_role
  on public.ats_whatsapp_question_prompts
  for all
  to service_role
  using (true)
  with check (true);

grant select, insert, update, delete on public.ats_whatsapp_question_prompts to service_role;

commit;
