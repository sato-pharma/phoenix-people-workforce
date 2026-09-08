-- Recruitment / ATS — owner-editable WhatsApp message templates, and the record of every message
-- prepared from one.
--
-- WHAT THIS IS FOR. A recruiter picks a candidate, picks a template ("Interview invitation"), fills
-- in the handful of things that change — date, time, interviewer — and Phoenix opens WhatsApp with
-- the whole message already typed against that candidate's number. The templates are the owner's to
-- write, rename, reorder, switch off and delete; nothing about the wording lives in code.
--
-- WHY THERE IS NO `is_approved` / `meta_template_name` COLUMN. These are NOT WhatsApp Cloud API
-- templates and must never be confused with them. An API template is submitted to Meta, approved by
-- Meta, uses positional {{1}} slots and is billed. These are plain text that a human presses send on
-- inside their own WhatsApp. Adding a Meta-facing column here would invite exactly that conflation.

create table if not exists public.ats_whatsapp_message_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- Free text, not an enum. The owner adds a category by typing one; a check constraint here would
  -- mean a migration every time he wants a new group on the screen.
  category text,
  body text not null,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_by_hr_id text,
  updated_by_hr_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Guards that match the app's own validation, so a hand SQL edit cannot create a row the editor
  -- would refuse. The body ceiling is the practical wa.me URL limit, not WhatsApp's 4096 — the text
  -- travels percent-encoded, where an Arabic address costs nine bytes a character.
  constraint ats_whatsapp_message_templates_name_not_blank check (length(btrim(name)) > 0),
  constraint ats_whatsapp_message_templates_name_length check (length(name) <= 80),
  constraint ats_whatsapp_message_templates_body_not_blank check (length(btrim(body)) > 0),
  constraint ats_whatsapp_message_templates_body_length check (length(body) <= 2000)
);

comment on table public.ats_whatsapp_message_templates is
  'Owner-editable WhatsApp message templates for the ATS. Plain text with {{placeholders}}; NOT Meta-approved Cloud API templates.';

create index if not exists ats_whatsapp_message_templates_active_order_idx
  on public.ats_whatsapp_message_templates (is_active, sort_order, name);

-- ---------------------------------------------------------------------------------------------
-- The prepared-message record.
--
-- EVERY COLUMN NAME HERE SAYS "PREPARED", NOT "SENT", AND THAT IS LOAD-BEARING. Phoenix opens a
-- WhatsApp window with the message in it; the human then presses send, or does not. Nothing in this
-- system can observe delivery, so a column called `sent_at` would be a claim we cannot support and
-- that a later reader would reasonably build a "messages delivered" report on.
-- ---------------------------------------------------------------------------------------------

create table if not exists public.ats_whatsapp_template_sends (
  id uuid primary key default gen_random_uuid(),
  -- Null when the template was deleted afterwards: the history of what went out must survive the
  -- template being retired, so this is SET NULL rather than CASCADE. The rendered body below is the
  -- real record anyway — it is what the candidate actually saw.
  template_id uuid references public.ats_whatsapp_message_templates (id) on delete set null,
  -- Null for a manual send: the owner asked to be able to type any number, with no CV behind it.
  candidate_id uuid references public.ats_candidates (id) on delete set null,
  to_number text not null,
  rendered_body text not null,
  variable_values jsonb not null default '{}'::jsonb,
  opened_by_hr_id text,
  created_at timestamptz not null default now()
);

comment on table public.ats_whatsapp_template_sends is
  'Append-only record of WhatsApp messages PREPARED (opened in WhatsApp) from a template. Not proof of delivery — a human still presses send.';
comment on column public.ats_whatsapp_template_sends.opened_by_hr_id is
  'Who opened the message in WhatsApp. Deliberately not named sent_by: delivery is unobservable from here.';

create index if not exists ats_whatsapp_template_sends_candidate_idx
  on public.ats_whatsapp_template_sends (candidate_id, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- Seed: the two templates the owner named, in his own wording.
--
-- Seeded rather than left empty so the feature is usable the minute it deploys, and so the
-- placeholder style is demonstrated by example — the fastest way to learn {{interview_date}} is to
-- open a template that already uses it.
--
-- `on conflict do nothing` against the name: re-running this migration must not duplicate them, and
-- must never overwrite an edit the owner has since made to his own wording.
-- ---------------------------------------------------------------------------------------------

create unique index if not exists ats_whatsapp_message_templates_name_key
  on public.ats_whatsapp_message_templates (lower(btrim(name)));

insert into public.ats_whatsapp_message_templates (name, category, body, sort_order)
values (
  'Interview invitation',
  'Interview',
  'Dear {{candidate_first_name}}

Good day,

As per our call please find below your interview details.

Please confirm receiving my message

• Date: {{interview_date}}
• Time: {{interview_time}}
• Dress code: {{dress_code}}
• Interviewer: {{interviewer_name}} ({{interviewer_title}})
• Location: {{location_link}}
• Address: {{address}}

Good Luck,
{{sender_name}}
{{company_name}}',
  10
)
on conflict do nothing;

insert into public.ats_whatsapp_message_templates (name, category, body, sort_order)
values (
  'Interview feedback',
  'Interview',
  'Dear {{candidate_first_name}}

Good day,

Thank you for taking the time to meet us for the {{job_title}} role.

{{feedback}}

Best regards,
{{sender_name}}
{{company_name}}',
  20
)
on conflict do nothing;
