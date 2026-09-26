-- notification_role_policies_activity_inactivity_digest
--
-- WHAT THIS CHANGES: adds the audience key `activity_inactivity_digest` to the notification-role
--   registry — rebuilds the notification_key CHECK constraint to allow it and seeds its default row.
-- WHY: the Activity Control Center already computed, every five minutes, which colleagues had not
--   signed in for a week — and then printed five of their names to the server log with an ellipsis
--   and threw the rest away. Nobody received it. It now runs once a day and reaches a person in-app
--   and on Telegram, so "who receives it" has to be admin-editable like every other system alert.
--   The key is added to the TS registry (role-recipients.ts) in this same change; without the
--   constraint seat and the seed row, the first admin who retargets or silences the audience gets 0
--   rows matched and a "no rows returned" error from updateNotificationRolePolicy's .single(), and
--   the repairing INSERT is then rejected by the stale CHECK.
-- ROLLBACK: rebuild the constraint without 'activity_inactivity_digest' and
--   delete from public.notification_role_policies where notification_key = 'activity_inactivity_digest';
--
-- Same shape as 20260923212443 and every key migration before it: look the constraint's real name
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
    'service_milestone_notice',
    'activity_inactivity_digest'
  ));

-- Seeded byte-matched to DEFAULT_NOTIFICATION_ROLE_POLICIES in role-recipients.ts — Super Admin
-- alone, which is who asked for this digest. Nothing read this key before today, so the seed
-- changes no existing behaviour.
insert into public.notification_role_policies (notification_key, label, description, roles, enabled) values
  ('activity_inactivity_digest', 'Inactive-colleague digest',
    'Who is told, once a day in-app and on Telegram, which colleagues have not signed in to Phoenix for a week or more. Deliberately never email (the owner''s standing rule for this kind of internal notice). Defaults to Super Admin alone, which is who asked for it (2026-09-26).',
    array['Super Admin'], true)
on conflict (notification_key) do nothing;

commit;
