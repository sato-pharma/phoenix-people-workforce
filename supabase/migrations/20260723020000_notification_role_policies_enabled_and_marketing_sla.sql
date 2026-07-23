-- Adds a real master on/off switch to notification_role_policies (today "off" only means an
-- empty roles array, which the two hybrid keys below don't fully honor) and a 13th key for the
-- marketing SLA reminder, which was hard-disabled in code (335437cc, 2026-07-22) with no toggle
-- at all. Backs the new "Automated Email Control Center" admin dashboard.
begin;

alter table public.notification_role_policies
  add column enabled boolean not null default true;

-- The notification_key CHECK was declared inline/unnamed in 20260719200000, so Postgres
-- auto-named it. Look the real name up instead of guessing, so this migration can't silently
-- no-op (or fail) against a differently-named constraint in any environment.
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
    'marketing_sla_reminder'
  ));

-- Critical: these two rows already exist with non-empty `roles`, so the `default true` above
-- would otherwise silently re-arm two digests the owner explicitly disabled on 2026-07-22.
update public.notification_role_policies
  set enabled = false
  where notification_key in ('probation_weekly_dv_digest', 'outstation_sla_reminder');

-- New key, seeded disabled to match the current (code-stubbed) off state. roles is intentionally
-- empty and not role-configurable: marketing SLA reminders route to each request's own assigned
-- approver/requester (see src/lib/marketing-requests/service.ts), not a role broadcast list —
-- this row exists purely to carry a real master on/off switch for the dashboard.
insert into public.notification_role_policies (notification_key, label, description, roles, enabled) values
  ('marketing_sla_reminder', 'Marketing request SLA reminder',
    'Reminds the assigned approver and requester about overdue marketing request due dates, and escalates critical overdue requests. Recipients are always the specific request''s assigned approver and requester — not role-configurable here; this switch only turns the whole reminder on or off.',
    array[]::text[], false)
on conflict (notification_key) do nothing;

commit;
