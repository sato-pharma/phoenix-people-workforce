-- payroll.workflow_updated and payroll.salary_upload_imported are ops notifications about a
-- BATCH, not a person — there is no employee subject to resolve permission_based against
-- (permissionBasedRecipients bails on `if (!subject) continue` before it ever reaches the
-- company/system-scope bypass). Both reached nobody in production: 8 workflow_updated events
-- and 1 salary_upload_imported event, all recorded with employee_hr_id NULL, last 2026-07-13.
--
-- Same fix as attendance_ingestion_alert / employee_import_alert / resignation_workflow_alert:
-- name the audience explicitly via metadata.moduleOwnerHrIds (which permission_based consumes
-- without requiring a subject) instead of widening the resolver. Owner decision 2026-08-09
-- (asked alongside the other three subject-less system alerts): company-scope holders of the
-- module's permission — Super Admin, CEO, Finance Manager. Each still has to pass
-- canAccess(context, "payroll", "read") individually; payroll:read is a floor grant to every
-- role (permissions.ts), so the real gate is this role list, not canAccess.
begin;

do $$
declare
  v_conname text;
begin
  select conname into v_conname
    from pg_constraint
    where conrelid = 'public.notification_role_policies'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%notification_key%';
  if v_conname is not null then
    execute format('alter table public.notification_role_policies drop constraint %I', v_conname);
  end if;
end $$;

alter table public.notification_role_policies
  add constraint notification_role_policies_notification_key_check
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
    'attendance_ingestion_alert',
    'marketing_sla_reminder',
    'resignation_workflow_alert',
    'employee_import_alert',
    'payroll_workflow_alert'
  ));

insert into public.notification_role_policies (notification_key, label, description, roles, enabled) values
  ('payroll_workflow_alert', 'Payroll workflow alert',
    'Who is told when a payroll batch changes state (approve/reject/lock/etc.) or a salary upload is imported. Both are ops events about a batch, not a specific employee, so there is no subject to infer an audience from — recipients are exactly this role list.',
    array['Super Admin', 'CEO', 'Finance Manager'], true)
on conflict (notification_key) do nothing;

commit;
