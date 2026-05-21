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
    'offer',
    'Job Offer',
    'Email sent to candidates containing job offer details and action links.',
    true,
    '{{jobTitle}} Job Offer',
    'Dear {{recipientName}},',
    '<p>We are pleased to confirm your offer for {{jobTitle}} and would like to share the next steps. We appreciate your interest in joining our team.</p>' ||
    E'' ||
    '<p>Reporting to {{managerName}} in {{line}} ({{area}}). Planned start date: {{startDate}}.</p>' ||
    E'' ||
    '<p>You can review and respond using the action link below.</p>' ||
    '<p><a href="{{ctaUrl}}" style="display:inline-block;margin-top:12px;border:1px solid #c2410c;border-radius:10px;background:#f97316;color:#ffffff;text-decoration:none;padding:10px 16px;font-weight:700;">{{ctaLabel}}</a></p>',
    'We are pleased to confirm your job offer for {{jobTitle}}.\n\nReporting to {{managerName}} in {{line}} ({{area}}). Planned start date: {{startDate}}.\n\nYou can use the action link to review and respond.',
    'You can contact HR for any follow-up question.',
    'Phoenix Workforce job offer notification for {{jobTitle}}.'
  ),
  (
    'interview_invitation',
    'Interview Invitation',
    'Candidate interview invitation template.',
    true,
    'Interview invitation: {{jobTitle}}',
    'Dear {{candidateName}},',
    '<p>You are invited to interview for {{jobTitle}}.</p><p>Date: {{interviewDate}} at {{interviewTime}}.</p><p>Location: {{interviewLocation}}</p><p>Interviewer: {{interviewerName}}</p><p>Meeting link: {{meetingUrl}}</p>',
    'You are invited to interview for {{jobTitle}}.\n\nDate: {{interviewDate}} at {{interviewTime}}.\nLocation: {{interviewLocation}}\nInterviewer: {{interviewerName}}\nMeeting link: {{meetingUrl}}',
    'Please confirm your availability or contact HR if the time needs to change.',
    'Phoenix Workforce interview invitation for {{jobTitle}}.'
  ),
  (
    'interview_feedback',
    'Interview Feedback',
    'Internal interview feedback follow-up for HR and hiring stakeholders.',
    true,
    'Interview feedback: {{candidateName}} - {{jobTitle}}',
    'Dear Team,',
    '<p>Interview feedback has been submitted for {{candidateName}}.</p><p>Role: {{jobTitle}}.</p><p>Status: {{status}}.</p><p>Feedback: {{feedback}}</p><p>Next step: {{nextStep}}</p>',
    'Interview feedback has been submitted for {{candidateName}}.\n\nRole: {{jobTitle}}.\nStatus: {{status}}.\nFeedback: {{feedback}}\nNext step: {{nextStep}}',
    'Please review the feedback and complete the next recruiting step.',
    'Phoenix Workforce interview feedback update.'
  ),
  (
    'probation_workflow',
    'Probation Tracker',
    'Tracked communication for probation review and action updates.',
    true,
    '{{subject}}',
    'Dear Team,',
    '<p>{{summary}}</p><p>Employee: {{employeeName}} ({{employeeHrId}}).</p><p>{{status}}</p>',
    '{{summary}}\n\nEmployee: {{employeeName}} ({{employeeHrId}}).\n{{status}}',
    'Please review and proceed with the required next step.',
    'Phoenix Workforce probation tracker update.'
  ),
  (
    'probation_reminder',
    'Probation Reminder',
    'Scheduled probation reminders for manager and HR follow-up.',
    true,
    '{{subject}}',
    'Dear Team,',
    '<p>{{summary}}</p><p>Employee: {{employeeName}} ({{employeeHrId}}).</p><p>Hire date: {{startDate}}.</p><p>{{status}}</p>',
    '{{summary}}\n\nEmployee: {{employeeName}} ({{employeeHrId}}).\nHire date: {{startDate}}.\n{{status}}',
    'Please submit the required feedback before the probation checkpoint closes.',
    'Phoenix Workforce probation reminder.'
  ),
  (
    'contract_renewal',
    'Contract Renewal',
    'Notifies stakeholders when a contract renewal workflow changes status.',
    true,
    '{{subject}}',
    'Dear Team,',
    '<p>{{summary}}</p><p>Employee: {{employeeName}} ({{employeeHrId}}).</p><p>Renewal date: {{endDate}}.</p><p>{{status}}</p>',
    '{{summary}}\n\nEmployee: {{employeeName}} ({{employeeHrId}}).\nRenewal date: {{endDate}}.\n{{status}}',
    'Please review and process the renewal action.',
    'Phoenix Workforce contract renewal communication.'
  ),
  (
    'birthday',
    'Birthday Wishes',
    'Reminder email for employee birthday follow-up.',
    true,
    'Happy Birthday, {{recipientName}}',
    'Dear {{recipientName}},',
    '<p>On behalf of Sato Pharma Family and Phoenix HR team we wish you a very happy birthday.</p><p>May this bring you more success, happiness, achievements that you have ever dreamt of.</p><p>We are proud to have you as part of our team and we wish you a wonderful year ahead.</p>',
    'On behalf of Sato Pharma Family and Phoenix HR team we wish you a very happy birthday. May this bring you more success, happiness, achievements that you have ever dreamt of. We are proud to have you as part of our team and we wish you a wonderful year ahead.',
    'Wishing you a wonderful birthday and a year ahead full of success.',
    'happy birthday wishes from Sato Pharma Family and Phoenix HR team'
  ),
  (
    'leave_request',
    'Leave Request',
    'Notifies approvers of new leave requests and includes decision links.',
    true,
    'Leave request from {{employeeName}}',
    'Dear Team,',
    '<p>{{employeeName}} submitted a {{vacationType}} request.</p><p>Duration: {{startDate}} to {{endDate}}.</p>' ||
    '<p>Employee notes: {{status}}</p><p>' ||
    '<a href="{{ctaUrl}}" style="display:inline-block;margin-top:12px;border:1px solid #0369a1;border-radius:10px;background:#0ea5e9;color:#ffffff;text-decoration:none;padding:10px 16px;font-weight:700;">{{ctaLabel}}</a></p>',
    '{{employeeName}} submitted a {{vacationType}} request from {{startDate}} to {{endDate}}. Status: {{status}}.',
    'Please review and complete the leave request decision workflow.',
    'A leave request requires action in Phoenix Workforce.'
  ),
  (
    'leave_approval',
    'Leave Approval',
    'Sent when a leave request is approved.',
    true,
    'Leave request approved: {{employeeName}}',
    'Dear {{recipientName}},',
    '<p>Your leave request has been approved.</p><p>Employee: {{employeeName}} ({{employeeHrId}}).</p><p>Period: {{startDate}} - {{endDate}}.</p><p>Status: {{status}}.</p>' ||
    '<p>' ||
    '{{ctaLabel}}: {{ctaUrl}}</p>',
    'Your leave request has been approved. Employee: {{employeeName}} ({{employeeHrId}}). Period: {{startDate}} - {{endDate}}. Status: {{status}}.',
    'Please archive the request if no further action is required.',
    'Your leave request was approved in Phoenix Workforce.'
  ),
  (
    'leave_rejection',
    'Leave Rejection',
    'Sent when a leave request is rejected.',
    true,
    'Leave request rejected: {{employeeName}}',
    'Dear {{recipientName}},',
    '<p>Your leave request was rejected.</p><p>Employee: {{employeeName}} ({{employeeHrId}}).</p><p>Period: {{startDate}} - {{endDate}}.</p><p>Status: {{status}}.</p>' ||
    '<p>' ||
    '{{ctaLabel}}: {{ctaUrl}}</p>',
    'Your leave request was rejected. Employee: {{employeeName}} ({{employeeHrId}}). Period: {{startDate}} - {{endDate}}. Status: {{status}}.',
    'Please contact HR for clarifications before submitting a revised request.',
    'Your leave request was rejected in Phoenix Workforce.'
  ),
  (
    'resignation_workflow',
    'Resignation',
    'Notifies stakeholders when a resignation workflow changes status.',
    true,
    '{{subject}}',
    'Dear Team,',
    '<p>{{summary}}</p><p>Employee: {{employeeName}} ({{employeeHrId}}).</p><p>Effective date: {{date}}.</p><p>{{status}}</p>',
    '{{summary}}\n\nEmployee: {{employeeName}} ({{employeeHrId}}).\nEffective date: {{date}}.\n{{status}}',
    'Please route this according to HR procedure.',
    'Phoenix Workforce resignation workflow update.'
  ),
  (
    'password_setup',
    'Password Setup',
    'Sends secure links for first-time account password setup.',
    true,
    '{{subject}}',
    'Dear {{recipientName}},',
    '<p>{{summary}}</p><p>This secure link expires: {{expiryText}}.</p><p><a href="{{ctaUrl}}" style="display:inline-block;margin-top:12px;border:1px solid #6b7280;border-radius:10px;background:#0f172a;color:#ffffff;text-decoration:none;padding:10px 16px;font-weight:700;">{{ctaLabel}}</a></p>',
    '{{summary}}\n\nThis secure link expires: {{expiryText}}.\nUse the action link to continue.',
    'Please complete setup before the link expires.',
    'Phoenix Workforce password setup link.'
  ),
  (
    'password_reset',
    'Password Reset',
    'Sends secure links for resetting an account password.',
    true,
    '{{subject}}',
    'Dear {{recipientName}},',
    '<p>{{summary}}</p><p>This secure link expires: {{expiryText}}.</p><p><a href="{{ctaUrl}}" style="display:inline-block;margin-top:12px;border:1px solid #6b7280;border-radius:10px;background:#0f172a;color:#ffffff;text-decoration:none;padding:10px 16px;font-weight:700;">{{ctaLabel}}</a></p>',
    '{{summary}}\n\nThis secure link expires: {{expiryText}}.\nUse the action link to continue.',
    'If you did not request this, contact your administrator.',
    'Phoenix Workforce password reset link.'
  ),
  (
    'user_created',
    'User Created',
    'Welcome and account setup communication for new users.',
    true,
    '{{subject}}',
    'Dear {{recipientName}},',
    '<p>{{summary}}</p><p>This secure link expires: {{expiryText}}.</p><p><a href="{{ctaUrl}}" style="display:inline-block;margin-top:12px;border:1px solid #059669;border-radius:10px;background:#10b981;color:#ffffff;text-decoration:none;padding:10px 16px;font-weight:700;">{{ctaLabel}}</a></p>',
    '{{summary}}\n\nThis secure link expires: {{expiryText}}.\nUse the action link to complete account setup.',
    'If you need support, please contact HR.',
    'Welcome to Phoenix Workforce account setup.'
  ),
  (
    'general',
    'General HR Notification',
    'Generic HR communication used when a one-size-fits-all message is needed.',
    true,
    '{{subject}}',
    'Dear Team,',
    '<p>{{summary}}</p><p>{{status}}</p>',
    '{{summary}}',
    'Please review the above notification and act accordingly.',
    '{{previewText}}'
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
  ('offer', array['candidate'], '{}', '{}', '{}'::text[], '{}'::text[], '{}', '{}', '{}'),
  ('interview_invitation', array['candidate'], '{}', '{}', '{}'::text[], '{}'::text[], '{}', '{}', '{}'),
  ('interview_feedback', array['hr', 'hiring_manager', 'recruiter'], '{}', '{}', '{}'::text[], '{}'::text[], '{}', '{}', '{}'),
  ('probation_workflow', array['direct_manager'], array['hr'], '{}', '{}'::text[], '{}'::text[], '{}', '{}', '{}'),
  ('probation_reminder', array['direct_manager'], array['manager_of_manager', 'hr'], '{}', '{}'::text[], '{}'::text[], '{}', '{}', '{}'),
  ('contract_renewal', array['manager_chain'], '{}', '{}', '{}'::text[], '{}'::text[], '{}', '{}', '{}'),
  ('leave_request', array['direct_manager'], array['manager_of_manager', 'hr'], '{}', '{}'::text[], '{}'::text[], '{}', '{}', '{}'),
  ('leave_approval', array['employee'], '{}', '{employee}', '{}'::text[], '{}'::text[], '{}', '{}', '{}'),
  ('leave_rejection', array['employee'], '{}', '{employee}', '{}'::text[], '{}'::text[], '{}', '{}', '{}'),
  ('birthday', array['employee'], array['district_manager'], '{}', '{}'::text[], '{}'::text[], '{}', '{}', '{}'),
  ('resignation_workflow', array['manager_chain'], array['hr'], '{}', '{}'::text[], '{}'::text[], '{}', '{}', '{}'),
  ('password_setup', array['candidate'], '{}', '{}', '{}'::text[], '{}'::text[], '{}', '{}', '{}'),
  ('password_reset', array['candidate'], '{}', '{}', '{}'::text[], '{}'::text[], '{}', '{}', '{}'),
  ('user_created', array['employee'], '{}', '{}', '{}'::text[], '{}'::text[], '{}', '{}', '{}'),
  ('general', array['admin'], array['hr_manager', 'finance'], '{}', '{}'::text[], '{}'::text[], '{}', '{}', '{}')
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
