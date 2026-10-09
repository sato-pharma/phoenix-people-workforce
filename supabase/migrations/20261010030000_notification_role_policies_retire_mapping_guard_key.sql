-- notification_role_policies: retire the sos_mapping_guard_alert audience
--
-- WHAT THIS CHANGES: deletes the 'sos_mapping_guard_alert' row from public.notification_role_policies
-- and rebuilds the notification_key CHECK without that key. The Mapping Guard it alerted about no
-- longer exists (20261010030100_retire_mapping_guard.sql), so the Email Center must stop offering an
-- audience nobody can be told anything through.
-- WHY: owner instruction 2026-10-10, "drop this module ... retire and kill it".
-- ROLLBACK:
--   re-add notification_role_policies_notification_key_check with the 25 keys of
--   20261002220322_notification_role_policies_accepted_offer_key.sql, then re-insert the
--   'sos_mapping_guard_alert' row (roles = array['Super Admin'], enabled = true).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- One policy row (Super Admin only, enabled) is deleted; every other key is carried forward. The
-- row is deleted BEFORE the constraint is rebuilt, because ADD CONSTRAINT validates existing rows.
-- Idempotent — a re-run changes nothing.

begin;

delete from public.notification_role_policies where notification_key = 'sos_mapping_guard_alert';

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
    'payroll_workflow_alert',
    'marketing_invoice_overdue_alert',
    'distributor_upload_overdue_alert',
    'retention_risk_alert',
    'crm_account_setup_alert',
    'new_hire_mailbox_alert',
    'service_milestone_notice',
    'activity_inactivity_digest',
    'accepted_offer_alert'
  ));

commit;
