-- Phoenix Workforce email notification template and recipient routing controls.
-- Run after 20260510_email_notification_policies.sql.

alter table public.email_notification_policies
  add column if not exists recipient_modes text[] not null default array['hr_notifications']::text[],
  add column if not exists target_titles text[] not null default '{}'::text[],
  add column if not exists target_lines text[] not null default '{}'::text[],
  add column if not exists template_subject text null,
  add column if not exists template_title text null,
  add column if not exists template_greeting text null,
  add column if not exists template_body_text text null,
  add column if not exists template_closing_text text null,
  add column if not exists template_preview_text text null;

alter table public.email_notification_policies
  drop constraint if exists email_notification_policies_type_check,
  drop constraint if exists email_notification_policies_recipient_mode_check,
  drop constraint if exists email_notification_policies_recipient_modes_check;

alter table public.email_notification_policies
  add constraint email_notification_policies_type_check
    check (notification_type in (
      'probation',
      'contract_renewal',
      'birthday',
      'offer',
      'resignation',
      'password_reset',
      'user_created',
      'general'
    )),
  add constraint email_notification_policies_recipient_mode_check
    check (recipient_mode in (
      'hr_notifications',
      'employee',
      'direct_manager',
      'manager_manager',
      'manager_chain',
      'employee_and_direct_manager',
      'candidate',
      'same_line_selected_titles',
      'selected_titles_all_lines',
      'selected_titles_selected_lines'
    )),
  add constraint email_notification_policies_recipient_modes_check
    check (
      recipient_modes <@ array[
        'hr_notifications',
        'employee',
        'direct_manager',
        'manager_manager',
        'manager_chain',
        'employee_and_direct_manager',
        'candidate',
        'same_line_selected_titles',
        'selected_titles_all_lines',
        'selected_titles_selected_lines'
      ]::text[]
    );

update public.email_notification_policies
set recipient_modes = array[recipient_mode]
where recipient_modes is null or cardinality(recipient_modes) = 0;

insert into public.email_notification_policies (
  notification_type,
  label,
  description,
  enabled,
  recipient_mode,
  recipient_modes,
  include_hr_inbox,
  template_subject,
  template_title,
  template_greeting,
  template_body_text,
  template_closing_text,
  template_preview_text
)
values
  (
    'probation',
    'Probation',
    'Probation review alerts routed through the reporting hierarchy.',
    true,
    'direct_manager',
    array['direct_manager'],
    true,
    '{subject}',
    '{title}',
    'Dear Phoenix Team,',
    '{summary}',
    'Please review and take the required action.',
    'Probation workflow update from Phoenix Workforce.'
  ),
  (
    'contract_renewal',
    'Contract renewal',
    'Contract renewal workflow alerts routed to the manager chain.',
    true,
    'manager_chain',
    array['manager_chain'],
    true,
    '{subject}',
    '{title}',
    'Dear Phoenix Team,',
    '{summary}',
    'Please review the renewal status and proceed with the required action.',
    'Contract renewal workflow update from Phoenix Workforce.'
  ),
  (
    'birthday',
    'Birthdays',
    'Birthday wishes routed to the employee.',
    true,
    'employee',
    array['employee'],
    false,
    '{subject}',
    'Happy Birthday',
    'Dear {employee},',
    'On behalf of Sato Pharma Family and Phoenix HR team, we wish you a very happy birthday.',
    'Wishing you a wonderful birthday and a year ahead full of success.',
    'Happy birthday wishes from Phoenix HR.'
  ),
  (
    'offer',
    'Offers',
    'Offer communication for candidates and HR follow-up.',
    true,
    'candidate',
    array['candidate'],
    false,
    '{subject}',
    '{title}',
    'Dear Phoenix Team,',
    '{summary}',
    'Phoenix HR will continue the next steps according to the offer workflow.',
    'Offer update from Phoenix Workforce.'
  ),
  (
    'resignation',
    'Resignations',
    'Resignation workflow alerts routed to the reporting chain.',
    true,
    'manager_chain',
    array['manager_chain'],
    true,
    '{subject}',
    '{title}',
    'Dear Phoenix Team,',
    '{summary}',
    'Please review the resignation workflow and complete the required action.',
    'Resignation workflow update from Phoenix Workforce.'
  ),
  (
    'password_reset',
    'Password reset',
    'Password reset links routed directly to the target account email.',
    true,
    'candidate',
    array['candidate'],
    false,
    '{subject}',
    '{title}',
    'Dear Phoenix User,',
    '{summary}',
    'If you did not request this action, please contact HR immediately.',
    'Phoenix Workforce password reset link.'
  ),
  (
    'user_created',
    'User created',
    'New account setup links routed directly to the target account email.',
    true,
    'candidate',
    array['candidate'],
    false,
    '{subject}',
    '{title}',
    'Dear Phoenix User,',
    '{summary}',
    'Please complete setup before the link expires.',
    'Phoenix Workforce account setup link.'
  ),
  (
    'general',
    'General',
    'General Phoenix Workforce notifications routed to configured recipients.',
    true,
    'hr_notifications',
    array['hr_notifications'],
    false,
    '{subject}',
    '{title}',
    'Dear Phoenix Team,',
    '{summary}',
    'Please review this update when available.',
    'General Phoenix Workforce notification.'
  )
on conflict (notification_type) do update
set
  label = excluded.label,
  description = excluded.description,
  template_subject = coalesce(public.email_notification_policies.template_subject, excluded.template_subject),
  template_title = coalesce(public.email_notification_policies.template_title, excluded.template_title),
  template_greeting = coalesce(public.email_notification_policies.template_greeting, excluded.template_greeting),
  template_body_text = coalesce(public.email_notification_policies.template_body_text, excluded.template_body_text),
  template_closing_text = coalesce(public.email_notification_policies.template_closing_text, excluded.template_closing_text),
  template_preview_text = coalesce(public.email_notification_policies.template_preview_text, excluded.template_preview_text);
