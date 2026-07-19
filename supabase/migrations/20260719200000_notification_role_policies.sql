-- Admin-editable "which roles receive this notification" table for the 12 cron-triggered
-- system notifications that previously had zero admin control (hardcoded role arrays
-- scattered across 10 domain files). Mirrors email_notification_policies's shape (natural-key
-- PK, service-role-only RLS, CHECK-constrained enums so a typo'd key fails loudly at insert
-- time instead of silently orphaning a row) but targets a structurally different dimension:
-- app_auth_users.role broadcast lists for multi-channel system notifications, not
-- employees.job_title/line_name targeting for the email-template pipeline.
begin;

create table if not exists public.notification_role_policies (
  notification_key text primary key
    check (notification_key in (
      'holiday_confirmation_reminder',
      'vacation_sla_hr_escalation',
      'telegram_daily_hr_digest',
      'weekly_system_health_digest',
      'probation_weekly_dv_digest',
      'field_workforce_compliance_digest',
      'outstation_sla_reminder',
      'resignation_sla_reminder',
      'weekly_plans_drift_alert',
      'excuse_drift_alert',
      'ireports360_sync_notify',
      'attendance_ingestion_alert'
    )),
  label text not null,
  description text not null,
  roles text[] not null default '{}'::text[]
    check (roles <@ array[
      'Employee','Medical Rep','District Manager','Regional Manager','National Sales Manager',
      'Product Manager','Group Product Manager','SFE Manager','Training Manager','Marketing Manager',
      'Finance Manager','Financial Advisor','Talent Acquisition','Manager','CEO','Super Admin'
    ]::text[]),
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table public.notification_role_policies enable row level security;

create policy phx_notification_role_policies_service_role on public.notification_role_policies
  for all
  to service_role
  using (true)
  with check (true);

grant all on table public.notification_role_policies to service_role;

-- Seed with today's REAL EFFECTIVE values (confirmed file:line during implementation) — zero
-- behavior change on deploy day. ON CONFLICT DO NOTHING so this insert is safe to re-run and
-- can never clobber a real admin edit made between deploy and any future re-application.
--
-- Note on 4 of these (telegram_daily_hr_digest, probation_weekly_dv_digest,
-- weekly_plans_drift_alert, excuse_drift_alert): their pre-existing hardcoded source arrays also
-- listed "HR Manager" — that's a phoenixCompanyJobTitle, not a real PhoenixRole, and a live query
-- confirmed zero app_auth_users rows have that role value, so it has always silently matched
-- nobody (also independently unrepresentable here: it's not in this table's own `roles <@`
-- CHECK constraint below). Omitted from the seed as dead weight, not a behavior change — the
-- discrepancy is flagged separately as a pre-existing, unrelated bug.
insert into public.notification_role_policies (notification_key, label, description, roles) values
  ('holiday_confirmation_reminder', 'Holiday confirmation reminder',
    'Reminds admins to confirm an upcoming national holiday''s observed date before it publishes to calendars, plans, vacation, and attendance.',
    array['Super Admin']),
  ('vacation_sla_hr_escalation', 'Vacation SLA — HR stage',
    'HR-stage recipients for overdue vacation requests. The manager-stage recipient is always the specific request''s manager-of-manager and is not configurable here.',
    array['Super Admin']),
  ('telegram_daily_hr_digest', 'Telegram daily HR digest',
    'Daily Telegram + in-app HR operations digest.',
    array['Super Admin']),
  ('weekly_system_health_digest', 'Weekly system health digest',
    'Once-a-week technical/security summary of the System Issues dashboard.',
    array['Super Admin']),
  ('probation_weekly_dv_digest', 'Probation weekly DV digest',
    'Weekly per-probationer Double-Visit broadcast list. The probationer''s own manager, NSM chain, and line-matched PM/GPM are always included and are not configurable here.',
    array['CEO', 'Super Admin', 'SFE Manager', 'Training Manager']),
  ('field_workforce_compliance_digest', 'Field workforce compliance digest',
    'Proactive monthly HR/compliance digest, fires on the 1st of the month.',
    array['Super Admin']),
  ('outstation_sla_reminder', 'Outstation SLA reminder',
    'Reminds approvers of outstation expense requests pending more than 3 days.',
    array['Super Admin', 'Finance Manager', 'CEO']),
  ('resignation_sla_reminder', 'Resignation SLA reminder',
    'Reminds approvers of resignations pending a final decision for more than 5 days.',
    array['Super Admin']),
  ('weekly_plans_drift_alert', 'Weekly plans drift alert',
    'Data-integrity alert when the weekly planning drift-check finds anomalies.',
    array['Super Admin']),
  ('excuse_drift_alert', 'Excuse drift alert',
    'Alert when excuse requests are stuck on a resigned or missing manager.',
    array['Super Admin']),
  ('ireports360_sync_notify', 'iReports360 sync notify',
    'Notifies after every iReports360 CRM sync/reconcile run, success or failure.',
    array['Super Admin']),
  ('attendance_ingestion_alert', 'Attendance ingestion alert',
    'Alerts when the fingerprint attendance pipeline appears stalled. Fires from the 5-minute notification outbox processor, not the daily cron.',
    array['Super Admin'])
on conflict (notification_key) do nothing;

commit;
