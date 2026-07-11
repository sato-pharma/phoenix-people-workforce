-- Seed the dedicated employee-facing "Excuse Decision" email template.
--
-- The excuse decision email (approved/rejected) previously reused the manager-oriented
-- `excuse_request` template, which reads "An excuse request has been submitted and is
-- pending your review" with a "Dear Dr." greeting -- wrong wording for an employee being
-- told their own excuse was approved or rejected. `sendEmployeeDecisionEmail` now pins the
-- `excuse_decision` key; this migration publishes a matching, admin-editable row so the
-- template appears (and stays editable) in /admin/email-templates. Idempotent upsert.

BEGIN;

insert into public.email_templates (
  template_key,
  template_name,
  description,
  is_active,
  subject,
  greeting,
  body_html,
  body_text,
  closing_text,
  preview_text
) values
  (
    'excuse_decision',
    'Excuse Decision',
    'Excuse decision result sent to the employee after their manager approves or rejects an excuse (late arrival / early leave) request.',
    true,
    'Your excuse request was {{status}}',
    'Dear {{honorific}}{{recipientName}},',
    '<p>{{summary}}</p><p><strong>Excuse type:</strong> {{excuseType}}</p><p><strong>Date:</strong> {{excuseDate}}</p><p><strong>Duration:</strong> {{duration}}</p><p><strong>Decision:</strong> {{status}}</p>',
    '{{summary}}\n\nExcuse type: {{excuseType}}\nDate: {{excuseDate}}\nDuration: {{duration}}\nDecision: {{status}}',
    'Open Phoenix Workforce to review your excuse history.',
    'An update on your excuse request.'
  )
on conflict (template_key) do update
set
  template_name = excluded.template_name,
  description = excluded.description,
  is_active = excluded.is_active,
  subject = excluded.subject,
  greeting = excluded.greeting,
  body_html = excluded.body_html,
  body_text = excluded.body_text,
  closing_text = excluded.closing_text,
  preview_text = excluded.preview_text;

insert into public.email_template_recipient_rules (
  template_key,
  to_roles,
  cc_roles,
  bcc_roles,
  target_titles,
  target_lines,
  static_to_emails,
  static_cc_emails,
  static_bcc_emails
) values
  ('excuse_decision', array['employee'], '{}', '{}', '{}'::text[], '{}'::text[], '{}', '{}', '{}')
on conflict (template_key) do update
set
  to_roles = excluded.to_roles,
  cc_roles = excluded.cc_roles,
  bcc_roles = excluded.bcc_roles,
  target_titles = excluded.target_titles,
  target_lines = excluded.target_lines,
  static_to_emails = excluded.static_to_emails,
  static_cc_emails = excluded.static_cc_emails,
  static_bcc_emails = excluded.static_bcc_emails;

COMMIT;
