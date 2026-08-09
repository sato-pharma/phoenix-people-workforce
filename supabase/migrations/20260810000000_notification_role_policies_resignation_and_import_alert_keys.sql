-- resignation_workflow_alert (src/lib/notifications/role-recipients.ts, added 2026-08-09 by
-- 1a35ad6c / "fix(resignations): restore notifications, and send them to Super Admin + Talent
-- Acquisition" #1937) and employee_import_alert (added the same day) both went into the TS role
-- registry but were never migrated here: notification_key's CHECK constraint still only allows
-- the 13 keys from 20260723020000, and neither key has a seed row. Reads already work —
-- getNotificationRolePolicies() falls back to DEFAULT_NOTIFICATION_ROLE_POLICIES per key when no
-- DB row exists — but updateNotificationRolePolicy() does a plain
-- .update().eq("notification_key", key).select().single(): with no row to match, an admin editing
-- either key's recipients from the notification-recipients console gets 0 rows updated and a
-- "no rows returned" error from .single(), and even a future INSERT would be rejected by the
-- stale CHECK constraint. Same fix shape as 20260723020000: look the constraint's real name up
-- dynamically instead of guessing it, so this can't silently no-op (or fail) against a
-- differently-named constraint in any environment.
--
-- Also carries 'payroll_workflow_alert' into the rebuilt list (seeded separately by
-- 20260809230000, merged after this migration was first drafted): every migration that touches
-- this constraint replaces it wholesale, so omitting an already-seeded key here would make this
-- migration fail outright the moment it runs (ADD CONSTRAINT validates existing rows by default,
-- and payroll_workflow_alert's row already exists by then) — not silently drop it.
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

-- Seed both with today's REAL EFFECTIVE values (byte-matched to DEFAULT_NOTIFICATION_ROLE_POLICIES
-- in role-recipients.ts) — zero behavior change on deploy day. ON CONFLICT DO NOTHING so this is
-- safe to re-run and can never clobber a real admin edit made between deploy and any future
-- re-application.
insert into public.notification_role_policies (notification_key, label, description, roles, enabled) values
  ('resignation_workflow_alert', 'Resignation workflow alert',
    'Who is told when a resignation is submitted or changes state. Owner-set 2026-08-09: Super Admin and Talent Acquisition only — deliberately NOT the CEO and NOT the leaver''s manager chain. Editable here rather than in code.',
    array['Super Admin', 'Talent Acquisition'], true),
  ('employee_import_alert', 'Employee import alert',
    'Oversight audience for a completed employee import. The admin who ran the import is always notified in addition to these roles — they are told the outcome of their own action, so removing every role here does not silence them.',
    array['Super Admin'], true)
on conflict (notification_key) do nothing;

commit;
