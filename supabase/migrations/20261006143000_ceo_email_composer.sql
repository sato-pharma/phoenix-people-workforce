-- The CEO Email Composer: its own letter templates and its own send log.
--
-- Owner 2026-10-06: "i want to make a module thats called ceo email composr exactly as sato email
-- composer copy paste but a more corporate templete … and the templete is wiith the signature of
-- the ceo".
--
-- TWO TABLES, NOT A COLUMN ON THE SATO ONES. The wordings are different documents — a letter from
-- one named person over his signature, against an announcement the organisation issues — and they
-- are edited by different seats (the CEO and the Super Admin here; the HR Business Partner and the
-- Super Admin there). A shared table with a `variant` column would offer each seat the other's
-- drafts and make one row's audit trail answer for two screens.
--
-- NOTHING IS ADDED TO distribution_lists. The lists belong to the composers and are resolved by the
-- same code both screens call (owner 2026-09-11: "I don't want this distribution list to be linked
-- with anything except the email composer that you will build") — the CEO composer addresses the
-- same switched-on lists through resolveSatoEmailAudience, so there is no new list, no new rule and
-- no change to who receives anything.
--
-- Service role only on both tables, like sato_email_templates and distribution_lists: every read
-- and write goes through server routes gated to the two seats (src/lib/ceo-email/access.ts).
begin;

create table if not exists public.ceo_email_templates (
  template_key text primary key check (template_key ~ '^[a-z][a-z0-9_]*$'),
  name text not null,
  subject text not null default '',
  body_html text not null default '',
  is_active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text
);

comment on table public.ceo_email_templates is
  'Fixed letter templates for the CEO Email Composer. Manual mail only: no system event ever sends one of these, and they are not the admin email-template catalogue automated notifications render from.';

alter table public.ceo_email_templates enable row level security;

create policy phx_ceo_email_templates_service_role on public.ceo_email_templates
  for all
  to service_role
  using (true)
  with check (true);

grant all on table public.ceo_email_templates to service_role;

create table if not exists public.ceo_email_sends (
  id uuid primary key default gen_random_uuid(),
  sender_login_id text,
  sender_hr_id text,
  sender_role text not null,
  subject text not null,
  template_key text,
  -- The closing line the sender chose ("Sincerely"). NOT the signatory: the name on the letter is
  -- resolved server-side from the employee directory on every render (src/lib/ceo-email/identity.ts)
  -- and is deliberately not storable from a draft, so a send can never record a signature the
  -- browser chose.
  closing_line text,
  list_keys text[] not null default '{}'::text[],
  employee_hr_ids text[] not null default '{}'::text[],
  recipient_emails text[] not null default '{}'::text[],
  recipient_count integer not null check (recipient_count >= 0),
  email_count integer not null check (email_count >= 0),
  sent_emails integer not null default 0,
  skipped_emails integer not null default 0,
  failed_emails integer not null default 0,
  status text not null check (status in ('sent', 'partial', 'skipped', 'failed')),
  outcomes jsonb not null default '[]'::jsonb,
  client_request_id text not null,
  created_at timestamptz not null default now()
);

comment on table public.ceo_email_sends is
  'One row per CEO Email Composer send. email_count is how many messages it was cut into (at most 25 recipients each, the cap the manual-email policy already enforces); outcomes holds each message''s provider result.';

create index if not exists ceo_email_sends_created_at_idx on public.ceo_email_sends (created_at desc);

alter table public.ceo_email_sends enable row level security;

create policy phx_ceo_email_sends_service_role on public.ceo_email_sends
  for all
  to service_role
  using (true)
  with check (true);

grant all on table public.ceo_email_sends to service_role;

-- The starter letters. Executive correspondence, not HR notices: each one states a decision, a
-- recognition or a position, and the [square-bracketed] parts are for the sender to fill in — the
-- composer lists any that are still unfilled before it will send.
--
-- None of them carries a greeting or a sign-off: the letterhead prints the date, the closing line
-- and the signature block, so a "Dear colleagues" here would open the letter twice.
insert into public.ceo_email_templates (template_key, name, subject, body_html, sort_order) values
  ('company_decision', 'A decision I have taken', '[What is changing]',
   '<p>I have decided that [state the decision in one sentence], effective [date].</p><p>[Why, in two or three sentences. What it is a response to, and what it is meant to achieve.]</p><p>What this means in practice:</p><ul><li>[First consequence]</li><li>[Second consequence]</li></ul><p>[Who will follow up, and by when.] I am asking each of you to [what you want people to do].</p>', 10),
  ('performance_update', 'Where the business stands', '[Period] performance',
   '<p>[Period] closed at [the headline figure], against a target of [the target].</p><p>[What drove it — one paragraph, naming the lines, regions or products that carried it.]</p><p>[What did not work, stated plainly. A letter that only reports good news stops being read.]</p><p>For the coming [period] my priorities are:</p><ul><li>[First priority]</li><li>[Second priority]</li><li>[Third priority]</li></ul><p>Thank you for the work behind these numbers.</p>', 20),
  ('organisational_change', 'An organisational change', '[The change]',
   '<p>[Name] will take up the role of [role], effective [date], reporting to [whom].</p><p>[One paragraph on what the role covers and why the change is being made.]</p><p>[Who is affected and what they should do differently, if anything.]</p><p>Please give [Name] every support in the new role.</p>', 30),
  ('recognition', 'Recognition', 'Thank you — [what was achieved]',
   '<p>I want to recognise [team, area or name] for [what was achieved, concretely].</p><p>[What it took, and why it matters to the company. Specific, not general praise.]</p><p>[Any figure that makes the achievement real.] This is the standard I would like us to hold across the company.</p>', 40),
  ('occasion', 'A message on an occasion', '[Occasion]',
   '<p>[The greeting for the occasion, in one sentence.]</p><p>[One paragraph: what the year or the period has asked of people, and what you want to say to them about it.]</p><p>[Any practical note — the days the company is closed, when work resumes.]</p><p>My best wishes to you and to your families.</p>', 50),
  ('position_statement', 'Where I stand on something', '[The subject]',
   '<p>[The position, stated in the first sentence. No preamble.]</p><p>[The reasoning — two or three sentences.]</p><p>[What is expected of people as a result, and what will happen if it is not met. Say it once, clearly.]</p><p>[Who to raise a question with.]</p>', 60),
  ('condolence', 'Condolence', '[Name]',
   '<p>It is with great sadness that I share the loss of [Name], [role and years of service].</p><p>[One or two sentences about the person and what they gave the company. Nothing procedural.]</p><p>[Practical information only if the family has asked for it to be shared.]</p><p>Our thoughts are with [his or her] family.</p>', 70),
  ('call_to_action', 'Something I am asking of everyone', '[What you are asking for]',
   '<p>I am asking every [who] to [the one thing], by [date].</p><p>[Why it matters — one paragraph, in terms of what it changes for the company or for the patient.]</p><p>[How to do it, in as few steps as it really takes.]</p><p>[Who owns it and will report back to me.]</p>', 80)
on conflict (template_key) do nothing;

commit;
