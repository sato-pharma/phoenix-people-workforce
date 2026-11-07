-- notification_role_policies: retire the crm_account_setup_alert audience
--
-- WHAT THIS CHANGES: deletes the 'crm_account_setup_alert' row from public.notification_role_policies
-- and rebuilds the notification_key CHECK without that key. The audience was the recipient list of the
-- new-hire iReports360 account notice and its daily reminder; the vendor CRM was retired on
-- 6 November 2026 (crm_cutover.vendor_sync_retired_at), nobody can be given an iReports360 account any
-- more, and the notice's sender, its reminder and the key were removed from the code in the same change
-- as this file, so the recipients screen must stop offering an audience nothing writes to.
-- WHY: owner instruction 2026-11-07, "ANY SINGLE SOURCE OF FIELD WORK IS NOW THE PHOENIX CRM WIRE IT
-- EVERY WHERE".
-- ORDER: applied to staging with this change; applied to PRODUCTION only after the code that drops the key
--   is deployed — the running code before it may still write the key, which the rebuilt check refuses.
-- ROLLBACK:
--   re-add notification_role_policies_notification_key_check with the 24 keys of
--   20261106043000_notification_role_policies_retire_ireports360_sync_key.sql, then re-insert the
--   'crm_account_setup_alert' row (label 'New hire CRM account setup',
--   roles = array['SFE Manager','HR Operations'], enabled = true).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- One policy row (SFE Manager + HR Operations, enabled — read live on 7 Nov 2026) is deleted; every
-- other key is carried forward from the live constraint read the same day. The row is deleted BEFORE
-- the constraint is rebuilt, because ADD CONSTRAINT validates existing rows. Idempotent — a re-run
-- changes nothing. No history is touched: crm_account_setup_tasks and the notification_events rows
-- written under module 'crm_account_setup' stay exactly as they are.

begin;
set local lock_timeout = '5s';

delete from public.notification_role_policies where notification_key = 'crm_account_setup_alert';

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
    'attendance_ingestion_alert',
    'marketing_sla_reminder',
    'resignation_workflow_alert',
    'employee_import_alert',
    'payroll_workflow_alert',
    'marketing_invoice_overdue_alert',
    'distributor_upload_overdue_alert',
    'retention_risk_alert',
    'new_hire_mailbox_alert',
    'service_milestone_notice',
    'activity_inactivity_digest',
    'accepted_offer_alert',
    'approval_whatsapp_reminder'
  ));

notify pgrst, 'reload schema';

commit;
