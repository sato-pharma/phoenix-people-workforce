-- sos_mapping_guard_alert is the audience for the mapping guard added 2026-09-10: when a customer,
-- brick or area re-mapping would overwrite a mapping decision of the owner's, or move a customer to
-- another region, the database holds the change and whoever holds this key is told — Telegram and
-- in-app, never email — and follows the link to /sales/mapping-guard to release or refuse it.
--
-- The owner is the only default, and the narrowness is the point rather than an oversight.
-- Releasing a hold is his decision by construction: the guard fires precisely when somebody else's
-- change was about to replace one of his, so an audience that includes that somebody would defeat
-- it. Anyone who genuinely needs adding can be added from /admin/notification-recipients without a
-- deploy — which is exactly what this migration exists to make true.
--
-- Same failure this fixes as 20260907213500 did for crm_account_setup_alert, 20260907061500 for
-- retention_risk_alert and 20260903170000 for distributor_upload_overdue_alert: the key goes into
-- the TS role registry in this same change, but notification_key's CHECK constraint only allows the
-- 20 keys from 20260907213500, and the key has no seed row. That pair is invisible until an admin
-- touches it. getNotificationRolePolicies() falls back to DEFAULT_NOTIFICATION_ROLE_POLICIES per key
-- when no DB row exists, so the console RENDERS Super Admin correctly and the alert SENDS correctly
-- — but updateNotificationRolePolicy() does a plain .update().eq("notification_key", key).select()
-- .single(), so the first admin who retargets or silences this alert gets 0 rows matched and a "no
-- rows returned" error, and the INSERT that would repair it is then rejected by the stale CHECK.
--
-- Same shape as 20260907213500, 20260907061500, 20260903170000, 20260829235500, 20260810000000 and
-- 20260723020000: look the constraint's real name up dynamically rather than guessing it, so this
-- cannot silently no-op (or fail) against a differently-named constraint in any environment. The
-- rebuilt list carries all 20 existing keys forward — ADD CONSTRAINT validates existing rows by
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
    'crm_account_setup_alert',
    'sos_mapping_guard_alert'
  ));

-- Seeded byte-matched to DEFAULT_NOTIFICATION_ROLE_POLICIES in role-recipients.ts, so the console
-- and the send path cannot disagree on deploy day. ON CONFLICT DO NOTHING so this is safe to
-- re-run and can never clobber a real admin edit made after it first applied.
insert into public.notification_role_policies (notification_key, label, description, roles, enabled) values
  ('sos_mapping_guard_alert', 'Mapping change held for review',
    'Who is told when a customer, brick or area re-mapping is stopped because it overwrites a mapping decision of the owner''s or moves a customer to another region. Defaults to Super Admin ALONE, deliberately: the held change is released from /sales/mapping-guard, and releasing one is an owner decision by construction — the whole point of the hold is that somebody else''s change was about to replace his. Widening this list hands that decision to whoever is listed, which is the opposite of what the guard is for.',
    array['Super Admin'], true)
on conflict (notification_key) do nothing;

commit;
