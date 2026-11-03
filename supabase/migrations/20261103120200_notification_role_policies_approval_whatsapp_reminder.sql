-- notification_role_policies_approval_whatsapp_reminder
--
-- WHAT THIS CHANGES: adds the key `approval_whatsapp_reminder` to the notification-role registry, rebuilding the
--   notification_key CHECK constraint to allow it and seeding its row, OFF.
-- WHY: the WhatsApp reminder to a slow approver (owner, 3 Nov 2026) stays off until he turns it on, on the existing
--   recipients screen. The key is added to role-recipients.ts in this same change. Without the constraint seat and the
--   seed row, the first press of that switch gets "no rows returned" and the repairing INSERT is rejected by the stale
--   CHECK. `roles` is empty because the recipients are per request, as with marketing_sla_reminder.
-- ROLLBACK: rebuild the constraint without 'approval_whatsapp_reminder' and
--   delete from public.notification_role_policies where notification_key = 'approval_whatsapp_reminder';
--
-- Same shape as every key migration before it. The key list is the live constraint read on 3 Nov 2026 plus this key.

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
    'payroll_workflow_alert',
    'marketing_invoice_overdue_alert',
    'distributor_upload_overdue_alert',
    'retention_risk_alert',
    'crm_account_setup_alert',
    'new_hire_mailbox_alert',
    'service_milestone_notice',
    'activity_inactivity_digest',
    'accepted_offer_alert',
    'approval_whatsapp_reminder'
  ));

-- Seeded byte-matched to DEFAULT_NOTIFICATION_ROLE_POLICIES in role-recipients.ts.
insert into public.notification_role_policies (notification_key, label, description, roles, enabled) values
  ('approval_whatsapp_reminder', 'WhatsApp reminder for waiting approvals',
    'Once a working day, each approver holding a leave, excuse, marketing or direct-order request for more than three days gets one WhatsApp message with the count.',
    array[]::text[], false)
on conflict (notification_key) do nothing;

commit;
