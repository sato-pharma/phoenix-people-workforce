-- marketing_invoice_overdue_alert is the finance-side audience for the overdue-invoice nudge added
-- 2026-08-29 ("the requester and finance"). It went into the TS role registry in the same change,
-- but notification_key's CHECK constraint still only allows the 16 keys from 20260810000000, and the
-- key has no seed row. That combination is invisible until an admin touches it:
-- getNotificationRolePolicies() falls back to DEFAULT_NOTIFICATION_ROLE_POLICIES per key when no DB
-- row exists, so the console RENDERS the Finance Manager correctly and the nudge SENDS correctly —
-- but updateNotificationRolePolicy() does a plain
-- .update().eq("notification_key", key).select().single(), so the first admin who retargets or
-- silences this alert from /admin/notification-recipients gets 0 rows matched and a "no rows
-- returned" error from .single(), and an INSERT to repair it would then be rejected by the stale
-- CHECK constraint. The owner is told at /admin/notification-recipients that he can retarget this
-- audience without a deploy; this migration is what makes that sentence true.
--
-- Same shape as 20260810000000 and 20260723020000: look the constraint's real name up dynamically
-- rather than guessing it, so this cannot silently no-op (or fail) against a differently-named
-- constraint in any environment.
--
-- The rebuilt list carries all 16 existing keys forward. Every migration that touches this
-- constraint replaces it wholesale, and ADD CONSTRAINT validates existing rows by default — verified
-- against production 2026-08-29: all 16 keys have a seeded row, so dropping one from this list would
-- make the migration fail outright rather than silently narrow the column.
--
-- NOTE the roles CHECK constraint is a SEPARATE constraint (notification_role_policies_roles_check,
-- last rebuilt by 20260828140000) and is deliberately untouched here: 'Finance Manager' is already
-- one of the 17 phoenixRoles it allows, confirmed live before writing this.
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
    'marketing_invoice_overdue_alert'
  ));

-- Seed with today's REAL EFFECTIVE values, byte-matched to DEFAULT_NOTIFICATION_ROLE_POLICIES in
-- role-recipients.ts — zero behaviour change on deploy day, because that record is exactly what the
-- read path already falls back to. ON CONFLICT DO NOTHING so this is safe to re-run and can never
-- clobber a real admin edit made between deploy and any future re-application.
insert into public.notification_role_policies (notification_key, label, description, roles, enabled) values
  ('marketing_invoice_overdue_alert', 'Marketing invoice overdue alert',
    'Who is told when an approved marketing request''s invoice passes its deadline. The REQUESTER is always notified about their own request and is not configurable here — this list is the finance-side audience, defaulting to the Finance Manager, who holds the finance_execution rung on the marketing approval chain and is the person chasing the invoice.',
    array['Finance Manager'], true)
on conflict (notification_key) do nothing;

commit;
