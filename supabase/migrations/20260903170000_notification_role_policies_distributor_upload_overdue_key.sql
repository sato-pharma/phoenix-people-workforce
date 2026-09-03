-- distributor_upload_overdue_alert is the audience for the distributor-upload nudge added
-- 2026-09-03. The owner was asked directly who should get it and answered "sfe" and
-- "You + Super Admins", so the default is Super Admin + SFE Manager.
--
-- Same failure this fixes as 20260829235500 did for marketing_invoice_overdue_alert: the key goes
-- into the TS role registry in this same change, but notification_key's CHECK constraint only allows
-- the 17 keys from 20260829235500, and the key has no seed row. That pair is invisible until an admin
-- touches it. getNotificationRolePolicies() falls back to DEFAULT_NOTIFICATION_ROLE_POLICIES per key
-- when no DB row exists, so /admin/notification-recipients RENDERS both roles correctly and the nudge
-- SENDS correctly — but updateNotificationRolePolicy() does a plain
-- .update().eq("notification_key", key).select().single(), so the first admin who retargets or
-- silences this alert gets 0 rows matched and a "no rows returned" error from .single(), and the
-- INSERT that would repair it is then rejected by the stale CHECK. The console tells the owner he can
-- retarget this audience without a deploy; this migration is what makes that sentence true.
--
-- Same shape as 20260829235500, 20260810000000 and 20260723020000: look the constraint's real name up
-- dynamically rather than guessing it, so this cannot silently no-op (or fail) against a
-- differently-named constraint in any environment.
--
-- The rebuilt list carries all 17 existing keys forward. Every migration that touches this constraint
-- replaces it wholesale, and ADD CONSTRAINT validates existing rows by default — verified against
-- production 2026-09-03 before writing this: the live constraint allows exactly those 17 keys and all
-- 17 have a seeded row, so dropping one from this list would make the migration fail outright rather
-- than silently narrow the column.
--
-- NOTE the roles CHECK constraint is a SEPARATE constraint (notification_role_policies_roles_check,
-- last rebuilt by 20260828140000) and is deliberately untouched here: both 'Super Admin' and
-- 'SFE Manager' are already among the phoenixRoles it allows, confirmed live before writing this.
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
    'distributor_upload_overdue_alert'
  ));

-- Seed with today's REAL EFFECTIVE values, byte-matched to DEFAULT_NOTIFICATION_ROLE_POLICIES in
-- role-recipients.ts — zero behaviour change on deploy day, because that record is exactly what the
-- read path already falls back to. ON CONFLICT DO NOTHING so this is safe to re-run and can never
-- clobber a real admin edit made between deploy and any future re-application.
insert into public.notification_role_policies (notification_key, label, description, roles, enabled) values
  ('distributor_upload_overdue_alert', 'Distributor upload overdue alert',
    'Who is told when a distributor''s file for the month just closed is later than that same distributor''s file was last month. Defaults to Super Admin and SFE Manager — the two roles holding sales:import, which is what /sales/upload requires, so every recipient can actually perform the upload the message is asking for rather than landing on a redirect.',
    array['Super Admin', 'SFE Manager'], true)
on conflict (notification_key) do nothing;

commit;
