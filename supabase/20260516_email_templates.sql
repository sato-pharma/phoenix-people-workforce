-- Email Templates: source of truth for all system email content and recipient rules.
-- Each template_key corresponds to a specific email type in the system.
-- Falls back to hardcoded defaults if no DB row exists for a given key.

CREATE TABLE IF NOT EXISTS public.email_templates (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key        TEXT        UNIQUE NOT NULL,
  template_name       TEXT        NOT NULL,
  description         TEXT        NOT NULL DEFAULT '',
  subject             TEXT        NOT NULL DEFAULT '',
  greeting            TEXT        NOT NULL DEFAULT '',
  body_html           TEXT        NOT NULL DEFAULT '',
  body_text           TEXT        NOT NULL DEFAULT '',
  closing             TEXT        NOT NULL DEFAULT '',
  preview_text        TEXT        NOT NULL DEFAULT '',
  is_active           BOOLEAN     NOT NULL DEFAULT TRUE,
  smart_greeting      BOOLEAN     NOT NULL DEFAULT TRUE,

  -- Role-based recipients (values are EmailRecipientRole enum members)
  to_roles            TEXT[]      NOT NULL DEFAULT '{}',
  cc_roles            TEXT[]      NOT NULL DEFAULT '{}',
  bcc_roles           TEXT[]      NOT NULL DEFAULT '{}',

  -- Title/line-based routing (used with same_line_selected_titles etc.)
  target_titles       TEXT[]      NOT NULL DEFAULT '{}',
  target_lines        TEXT[]      NOT NULL DEFAULT '{}',

  -- Static override emails
  static_to_emails    TEXT[]      NOT NULL DEFAULT '{}',
  static_cc_emails    TEXT[]      NOT NULL DEFAULT '{}',
  static_bcc_emails   TEXT[]      NOT NULL DEFAULT '{}',

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by          TEXT
);

-- RLS: admin/service_role only
ALTER TABLE public.email_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "email_templates_service_role" ON public.email_templates;
CREATE POLICY "email_templates_service_role"
  ON public.email_templates
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.email_templates_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS email_templates_updated_at ON public.email_templates;
CREATE TRIGGER email_templates_updated_at
  BEFORE UPDATE ON public.email_templates
  FOR EACH ROW EXECUTE FUNCTION public.email_templates_set_updated_at();

-- Seed default templates so the admin page is populated immediately
INSERT INTO public.email_templates (template_key, template_name, description, subject, greeting, body_html, body_text, closing, preview_text, is_active, smart_greeting, to_roles, cc_roles, bcc_roles)
VALUES
  (
    'job_offer',
    'Job Offer',
    'Sent to candidates when a job offer is extended.',
    'Your Job Offer — {{jobTitle}} at Phoenix Workforce',
    'Dear {{candidateName}},',
    '<p>We are pleased to extend this formal offer of employment for the position of <strong>{{jobTitle}}</strong>.</p><p>Please review the attached offer details and confirm your acceptance before <strong>{{date}}</strong>.</p>',
    'We are pleased to extend this formal offer of employment for the position of {{jobTitle}}. Please review the attached offer details and confirm your acceptance before {{date}}.',
    'We look forward to welcoming you to the Phoenix Workforce team.',
    'Your job offer from Phoenix Workforce — please review and respond.',
    TRUE, TRUE,
    ARRAY['candidate'], ARRAY[]::TEXT[], ARRAY[]::TEXT[]
  ),
  (
    'probation',
    'Probation Tracker',
    'Alerts managers and HR when a probation review is approaching or overdue.',
    'Probation Review — {{employeeName}} ({{employeeHrId}})',
    'Dear Team,',
    '<p>This is an automated reminder regarding the probation review for <strong>{{employeeName}}</strong> ({{employeeHrId}}) — <em>{{jobTitle}}</em>.</p><p>{{status}}</p>',
    'This is an automated reminder regarding the probation review for {{employeeName}} ({{employeeHrId}}) — {{jobTitle}}. {{status}}',
    'Please review and take the required action by the specified deadline.',
    'Probation review reminder from Phoenix Workforce.',
    TRUE, TRUE,
    ARRAY['direct_manager'], ARRAY['hr'], ARRAY[]::TEXT[]
  ),
  (
    'contract_renewal',
    'Contract Renewal',
    'Notifies the manager chain when a contract renewal is approaching.',
    'Contract Renewal — {{employeeName}} ({{employeeHrId}})',
    'Dear Team,',
    '<p>This is a reminder that the employment contract for <strong>{{employeeName}}</strong> ({{employeeHrId}}) is approaching its renewal date.</p><p>End Date: <strong>{{endDate}}</strong></p><p>{{status}}</p>',
    'This is a reminder that the employment contract for {{employeeName}} ({{employeeHrId}}) is approaching its renewal date. End Date: {{endDate}}. {{status}}',
    'Please initiate the contract renewal workflow at your earliest convenience.',
    'Contract renewal reminder from Phoenix Workforce.',
    TRUE, TRUE,
    ARRAY['manager_chain'], ARRAY['hr'], ARRAY[]::TEXT[]
  ),
  (
    'leave_request',
    'Leave Request',
    'Sent to the approving manager when an employee submits a leave request.',
    'Leave Request — {{employeeName}} ({{employeeHrId}})',
    'Dear {{managerName}},',
    '<p><strong>{{employeeName}}</strong> ({{employeeHrId}}) has submitted a leave request.</p><p>From: <strong>{{startDate}}</strong> — To: <strong>{{endDate}}</strong></p><p>Please review and action this request.</p>',
    '{{employeeName}} ({{employeeHrId}}) has submitted a leave request from {{startDate}} to {{endDate}}. Please review and action this request.',
    'Kindly action this request within the expected SLA.',
    'Leave request pending your approval — Phoenix Workforce.',
    TRUE, TRUE,
    ARRAY['direct_manager'], ARRAY['hr'], ARRAY[]::TEXT[]
  ),
  (
    'leave_approval',
    'Leave Approval',
    'Sent to the employee when their leave request is approved.',
    'Leave Approved — {{employeeName}} ({{employeeHrId}})',
    'Dear {{employeeName}},',
    '<p>Your leave request has been <strong>approved</strong>.</p><p>Period: <strong>{{startDate}}</strong> — <strong>{{endDate}}</strong></p>',
    'Your leave request has been approved. Period: {{startDate}} — {{endDate}}.',
    'Enjoy your time off. Contact HR if you have any questions.',
    'Your leave request has been approved — Phoenix Workforce.',
    TRUE, TRUE,
    ARRAY['employee'], ARRAY[]::TEXT[], ARRAY[]::TEXT[]
  ),
  (
    'leave_rejection',
    'Leave Rejection',
    'Sent to the employee when their leave request is rejected.',
    'Leave Request Update — {{employeeName}} ({{employeeHrId}})',
    'Dear {{employeeName}},',
    '<p>We regret to inform you that your leave request for <strong>{{startDate}}</strong> — <strong>{{endDate}}</strong> could not be approved at this time.</p><p>Please speak with your manager or HR for further guidance.</p>',
    'We regret to inform you that your leave request for {{startDate}} — {{endDate}} could not be approved at this time. Please speak with your manager or HR for further guidance.',
    'Please contact HR or your manager if you have any questions.',
    'Update regarding your leave request — Phoenix Workforce.',
    TRUE, TRUE,
    ARRAY['employee'], ARRAY[]::TEXT[], ARRAY[]::TEXT[]
  ),
  (
    'password_setup',
    'Password Setup',
    'Sent to users when they need to set or reset their password.',
    'Set Your Phoenix Workforce Password',
    'Dear {{recipientName}},',
    '<p>You have been invited to set up your Phoenix Workforce account password.</p><p>Please click the button below to complete your setup. This link will expire in 24 hours.</p>',
    'You have been invited to set up your Phoenix Workforce account password. Please use the link below to complete your setup. This link will expire in 24 hours.',
    'If you did not request this, please contact HR immediately.',
    'Set up your Phoenix Workforce account — action required.',
    TRUE, TRUE,
    ARRAY['candidate'], ARRAY[]::TEXT[], ARRAY[]::TEXT[]
  ),
  (
    'user_created',
    'User Created',
    'Sent when a new employee account is created in the system.',
    'Welcome to Phoenix Workforce — Account Setup',
    'Dear {{recipientName}},',
    '<p>Your Phoenix Workforce account has been created. Please click the button below to complete your account setup and set your password.</p><p>This link expires in 48 hours.</p>',
    'Your Phoenix Workforce account has been created. Please use the link below to complete your account setup. This link expires in 48 hours.',
    'Please complete setup before the link expires.',
    'Your Phoenix Workforce account is ready — complete your setup.',
    TRUE, TRUE,
    ARRAY['candidate'], ARRAY[]::TEXT[], ARRAY[]::TEXT[]
  ),
  (
    'general_hr',
    'General HR Notification',
    'A general-purpose HR notification for ad-hoc communications.',
    '{{subject}}',
    'Dear Team,',
    '<p>{{body}}</p>',
    '{{body}}',
    'For questions, please contact your HR Business Partner.',
    'A notification from Phoenix Workforce HR.',
    TRUE, TRUE,
    ARRAY['hr'], ARRAY[]::TEXT[], ARRAY[]::TEXT[]
  ),
  (
    'birthday',
    'Birthday Reminder',
    'Reminds managers to acknowledge employee birthdays.',
    'Birthday Reminder — {{employeeName}}',
    'Dear {{managerName}},',
    '<p>This is a reminder that today is <strong>{{employeeName}}''s</strong> birthday.</p><p>Please take a moment to send them your best wishes.</p>',
    'This is a reminder that today is {{employeeName}}''s birthday. Please take a moment to send them your best wishes.',
    'A thoughtful gesture goes a long way.',
    'Birthday reminder from Phoenix Workforce People Operations.',
    TRUE, TRUE,
    ARRAY['direct_manager'], ARRAY[]::TEXT[], ARRAY[]::TEXT[]
  ),
  (
    'resignation',
    'Resignation Notice',
    'Notifies the manager chain and HR when an employee submits a resignation.',
    'Resignation Notice — {{employeeName}} ({{employeeHrId}})',
    'Dear Team,',
    '<p><strong>{{employeeName}}</strong> ({{employeeHrId}}) has submitted a resignation effective <strong>{{date}}</strong>.</p><p>Please initiate the offboarding workflow and ensure a smooth handover process.</p>',
    '{{employeeName}} ({{employeeHrId}}) has submitted a resignation effective {{date}}. Please initiate the offboarding workflow and ensure a smooth handover process.',
    'Please coordinate with HR to complete the offboarding checklist.',
    'Resignation notice — offboarding action required.',
    TRUE, TRUE,
    ARRAY['manager_chain'], ARRAY['hr'], ARRAY[]::TEXT[]
  )
ON CONFLICT (template_key) DO NOTHING;

COMMENT ON TABLE public.email_templates IS 'Source of truth for all system email templates. Each row defines content and recipient rules for one email type.';
