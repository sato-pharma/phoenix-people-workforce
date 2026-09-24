-- notification_role_policies_service_milestone_key
--
-- WHAT THIS CHANGES: adds the audience key `service_milestone_notice` to the notification-role
--   registry — rebuilds the notification_key CHECK constraint to allow it and seeds its default row.
-- WHY: the milestones module now reminds someone that a service milestone or a birthday is coming
--   up, and "who is reminded" must be admin-editable like every other system alert. The key is
--   added to the TS registry (role-recipients.ts) in this same change; without the constraint seat
--   and the seed row, the first admin who retargets or silences the audience gets 0 rows matched
--   and a "no rows returned" error from updateNotificationRolePolicy's .single(), and the repairing
--   INSERT is then rejected by the stale CHECK. Same invisible pair every key migration fixes.
-- ROLLBACK: rebuild the constraint without 'service_milestone_notice' and
--   delete from public.notification_role_policies where notification_key = 'service_milestone_notice';
--
-- Same shape as 20260918120027 and every key migration before it: look the constraint's real name
-- up dynamically so this cannot silently no-op against a differently-named constraint; carry every
-- existing key forward (ADD CONSTRAINT validates existing rows, so dropping one would fail the
-- migration outright rather than silently narrow the column); seed with ON CONFLICT DO NOTHING so a
-- re-run can never clobber a real admin edit. The roles CHECK is a separate, untouched constraint —
-- 'Super Admin' is already among the roles it allows.

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
    'sos_mapping_guard_alert',
    'new_hire_mailbox_alert',
    'service_milestone_notice'
  ));

-- Seeded with today's REAL EFFECTIVE default, byte-matched to DEFAULT_NOTIFICATION_ROLE_POLICIES in
-- role-recipients.ts — Super Admin alone, because the owner narrowed the whole milestones module to
-- Super Admin on 2026-09-23. Zero behaviour change on deploy day: that record is exactly what the
-- read path already falls back to.
insert into public.notification_role_policies (notification_key, label, description, roles, enabled) values
  ('service_milestone_notice', 'Service milestone notice',
    'Who is reminded, in-app and on Telegram, that someone is coming up on a service milestone or a birthday at Sato Pharma, so a card can be printed in time. It keeps reminding, once a day, until a recipient opens the Milestones page — the owner''s chosen acknowledgement (2026-09-23). Defaults to Super Admin alone, since the owner narrowed the whole module to Super Admin the same day.',
    array['Super Admin'], true)
on conflict (notification_key) do nothing;

commit;
