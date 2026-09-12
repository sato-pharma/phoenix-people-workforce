-- The Sato Email Composer: its fixed templates, its send log, and the distribution lists as its own.
--
-- Owner 2026-09-11: a new composer beside /admin/email-reply-composer (which is left as it is), for
-- Super Admin and the HR Business Partner. Pick a fixed template or type freely, send to the
-- distribution lists, in the Sato Pharma identity. And: "I don't want this distribution list to be
-- linked with anything except the email composer that you will build."
--
-- So `closing_fixed_cc` is retired here. It existed only so the Monthly Closing publish could read
-- its Cc roles from a list; that publish now reads them from code again, and the roles are the same
-- three (CEO, Marketing Manager, SFE Manager), so nobody's Cc changes.
--
-- Service role only on both tables, like distribution_lists: every read and write goes through
-- server routes gated to the two seats.
begin;

create table if not exists public.sato_email_templates (
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

comment on table public.sato_email_templates is
  'Fixed templates for the Sato Email Composer. Manual email only: no system event sends one of these.';

alter table public.sato_email_templates enable row level security;

create policy phx_sato_email_templates_service_role on public.sato_email_templates
  for all
  to service_role
  using (true)
  with check (true);

grant all on table public.sato_email_templates to service_role;

create table if not exists public.sato_email_sends (
  id uuid primary key default gen_random_uuid(),
  sender_login_id text,
  sender_hr_id text,
  sender_role text not null,
  subject text not null,
  template_key text,
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

comment on table public.sato_email_sends is
  'One row per Sato Email Composer send. email_count is how many messages it was cut into (at most 25 recipients each, the cap the manual-email policy already enforces); outcomes holds each message''s provider result.';

create index if not exists sato_email_sends_created_at_idx on public.sato_email_sends (created_at desc);

alter table public.sato_email_sends enable row level security;

create policy phx_sato_email_sends_service_role on public.sato_email_sends
  for all
  to service_role
  using (true)
  with check (true);

grant all on table public.sato_email_sends to service_role;

-- Starter templates. The square-bracketed parts are for the sender to fill in; the composer warns
-- before sending if any are left.
insert into public.sato_email_templates (template_key, name, subject, body_html, sort_order) values
  ('general_announcement', 'General announcement', '[Announcement title]',
   '<p>Dear colleagues,</p><p>[Write the announcement here.]</p><p>Thank you for your attention.</p>', 10),
  ('public_holiday', 'Public holiday notice', 'Public holiday: [Holiday name]',
   '<p>Dear colleagues,</p><p>Please note that [Holiday name] will be observed as a public holiday on [Day and date]. Work resumes as normal on [Day and date].</p><p>We wish you and your families a happy holiday.</p>', 20),
  ('policy_update', 'Policy update', 'Policy update: [Policy name]',
   '<p>Dear colleagues,</p><p>The [Policy name] has been updated, effective [Date].</p><p>The main changes are:</p><ul><li>[First change]</li><li>[Second change]</li></ul><p>For any questions, please contact Human Resources.</p>', 30),
  ('meeting_invitation', 'Meeting invitation', 'Invitation: [Meeting title]',
   '<p>Dear colleagues,</p><p>You are invited to [Meeting title].</p><p><strong>Date:</strong> [Date]<br><strong>Time:</strong> [Time]<br><strong>Place:</strong> [Place or meeting link]</p><p>Please confirm your attendance by replying to this email.</p>', 40),
  ('welcome_new_colleague', 'Welcome a new colleague', 'Please welcome [Name]',
   '<p>Dear colleagues,</p><p>We are pleased to welcome [Name], who joins Sato Pharma as [Job title] in [Department or area], starting [Date].</p><p>Please join us in wishing [Name] every success in the new role.</p>', 50),
  ('reminder', 'Reminder', 'Reminder: [Subject]',
   '<p>Dear colleagues,</p><p>This is a friendly reminder that [what is due] is due by [Date].</p><p>Thank you for your cooperation.</p>', 60)
on conflict (template_key) do nothing;

delete from public.distribution_lists where list_key = 'closing_fixed_cc';

-- Both descriptions still said they replace a group in the old composer, which is no longer true.
-- Guarded on the seeded wording so a description somebody has since edited is left alone.
update public.distribution_lists
set description = 'HR seats (HR Advisory and HR Operations), plus Omar Anwar (B-10) by name.',
    updated_at = now(),
    updated_by = 'migration:sato_email_composer'
where list_key = 'hr_team'
  and description like 'HR seats. Replaces%';

update public.distribution_lists
set description = 'Finance Manager, plus Adel El Sayed (OF-0002) by name.',
    updated_at = now(),
    updated_by = 'migration:sato_email_composer'
where list_key = 'finance_team'
  and description like 'Finance seats. Replaces%';

commit;
