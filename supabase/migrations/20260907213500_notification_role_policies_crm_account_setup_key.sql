-- crm_account_setup_alert is the audience for the new-hire CRM notice added 2026-09-07: when an
-- employee is created on the employee master, whoever holds this key is told — by email and
-- in-app — and follows the link to enter that person's CRM username and CRM code.
--
-- The owner named the SFE Manager, so that is the only default. Super Admin is deliberately NOT
-- seeded alongside him: this is one person's standing job, and an audience of two on a per-hire
-- notice is how both recipients learn to assume the other one did it. Anyone who needs adding can
-- be added from /admin/notification-recipients without a deploy — which is exactly what this
-- migration exists to make true.
--
-- Same failure this fixes as 20260907061500 did for retention_risk_alert and 20260903170000 for
-- distributor_upload_overdue_alert: the key goes into the TS role registry in this same change, but
-- notification_key's CHECK constraint only allows the 19 keys from 20260907061500, and the key has
-- no seed row. That pair is invisible until an admin touches it. getNotificationRolePolicies()
-- falls back to DEFAULT_NOTIFICATION_ROLE_POLICIES per key when no DB row exists, so the console
-- RENDERS the SFE Manager correctly and the notice SENDS correctly — but
-- updateNotificationRolePolicy() does a plain .update().eq("notification_key", key).select()
-- .single(), so the first admin who retargets or silences this notice gets 0 rows matched and a
-- "no rows returned" error, and the INSERT that would repair it is then rejected by the stale
-- CHECK.
--
-- Same shape as 20260907061500, 20260903170000, 20260829235500, 20260810000000 and
-- 20260723020000: look the constraint's real name up dynamically rather than guessing it, so this
-- cannot silently no-op (or fail) against a differently-named constraint in any environment. The
-- rebuilt list carries all 19 existing keys forward — ADD CONSTRAINT validates existing rows by
-- default, so dropping one would make this migration fail outright rather than silently narrow the
-- column.
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
    'crm_account_setup_alert'
  ));

-- Seeded byte-matched to DEFAULT_NOTIFICATION_ROLE_POLICIES in role-recipients.ts, so the console
-- and the send path cannot disagree on deploy day. ON CONFLICT DO NOTHING so this is safe to
-- re-run and can never clobber a real admin edit made after it first applied.
insert into public.notification_role_policies (notification_key, label, description, roles, enabled) values
  ('crm_account_setup_alert', 'New hire CRM account setup',
    'Who is told when an employee is added to the employee master, so that person can be given an iReports360 (CRM) account. The notice carries the new hire''s line, hiring date, region, area, manager, work email and mobile, and links to the New Hire CRM Setup tab where the CRM username and CRM code are entered. Defaults to the SFE Manager — the owner''s instruction, 2026-09-07.',
    array['SFE Manager'], true)
on conflict (notification_key) do nothing;

commit;
