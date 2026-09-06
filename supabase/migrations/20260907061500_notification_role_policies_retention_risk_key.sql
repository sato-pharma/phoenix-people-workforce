-- retention_risk_alert is the audience for the retention-risk sweep added 2026-09-07: five
-- consecutive working days of recorded leave, or five with no CRM entry at all for a Medical Rep.
-- The owner was asked directly who should receive it and picked all four of HR Operations, HR
-- Advisory, Super Admin and SFE Manager, plus the subject's own line manager. The line manager is
-- NOT a role here and deliberately so: the sweep adds one named manager per alert, resolved from
-- that employee's own reporting line, which is a different thing from "everyone holding a manager
-- role" and must not become editable into one by accident.
--
-- Same failure this fixes as 20260903170000 did for distributor_upload_overdue_alert: the key goes
-- into the TS role registry in this same change, but notification_key's CHECK constraint only
-- allows the 18 keys from 20260903170000, and the key has no seed row. That pair is invisible until
-- an admin touches it. getNotificationRolePolicies() falls back to DEFAULT_NOTIFICATION_ROLE_POLICIES
-- per key when no DB row exists, so /admin/notification-recipients RENDERS all four roles correctly
-- and the sweep SENDS correctly — but updateNotificationRolePolicy() does a plain
-- .update().eq("notification_key", key).select().single(), so the first admin who retargets or
-- silences this alert gets 0 rows matched and a "no rows returned" error from .single(), and the
-- INSERT that would repair it is then rejected by the stale CHECK. The console tells the owner he
-- can retarget this audience without a deploy; this migration is what makes that sentence true.
--
-- Same shape as 20260903170000, 20260829235500, 20260810000000 and 20260723020000: look the
-- constraint's real name up dynamically rather than guessing it, so this cannot silently no-op (or
-- fail) against a differently-named constraint in any environment.
--
-- The rebuilt list carries all 18 existing keys forward. Every migration that touches this
-- constraint replaces it wholesale, and ADD CONSTRAINT validates existing rows by default —
-- verified against production 2026-09-07 before writing this: the live constraint allows exactly
-- those 18 keys and all 18 have a seeded row, so dropping one from this list would make the
-- migration fail outright rather than silently narrow the column.
--
-- NOTE the roles CHECK constraint is a SEPARATE constraint (notification_role_policies_roles_check,
-- last rebuilt by 20260828140000) and is deliberately untouched here: all four of 'HR Operations',
-- 'HR Advisory', 'Super Admin' and 'SFE Manager' are already among the phoenixRoles it allows,
-- confirmed live before writing this.
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
    'retention_risk_alert'
  ));

-- Seed with today's REAL EFFECTIVE values, byte-matched to DEFAULT_NOTIFICATION_ROLE_POLICIES in
-- role-recipients.ts — zero behaviour change on deploy day, because that record is exactly what the
-- read path already falls back to. ON CONFLICT DO NOTHING so this is safe to re-run and can never
-- clobber a real admin edit made between deploy and any future re-application.
insert into public.notification_role_policies (notification_key, label, description, roles, enabled) values
  ('retention_risk_alert', 'Retention risk alert',
    'Who is told when an employee reaches five consecutive working days of recorded leave, or a Medical Rep reaches five consecutive working days with no CRM entry of any kind. Defaults to HR Operations, HR Advisory, Super Admin and SFE Manager — the owner picked all four on 2026-09-06. The person''s own line manager is added per alert by the sweep itself and is deliberately NOT a role here: it is one named manager per subject, not everyone holding a manager role.',
    array['HR Operations', 'HR Advisory', 'Super Admin', 'SFE Manager'], true)
on conflict (notification_key) do nothing;

commit;
