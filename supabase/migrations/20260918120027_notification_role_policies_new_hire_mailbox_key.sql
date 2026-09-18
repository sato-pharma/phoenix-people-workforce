-- notification_role_policies: the new_hire_mailbox_alert audience
--
-- WHAT THIS CHANGES: adds 'new_hire_mailbox_alert' to the notification_key CHECK on
-- public.notification_role_policies and seeds its row — who is told, in-app and on Telegram, when an
-- employee is added and their Turbify mailbox needs creating. Super Admin alone by default.
--
-- WHY: owner instruction 2026-09-18 (see 20260918112210_new_hire_mailbox_tasks.sql). Its own file,
-- like every audience key before it, because the rebuild of this CHECK is found by this file NAME
-- (tests/distributor-upload-nudge.test.ts reads the newest *_notification_role_policies_*_key.sql),
-- and a key the newest rebuild omits is a key the database will refuse.
--
-- APPLIED 2026-09-18 to staging and production together with 20260918112210, in ONE apply named
-- new_hire_mailbox_tasks (production ledger version 20260918084553). The statements below are that
-- apply's, unchanged; everything here is idempotent, so a re-run changes nothing.
--
-- ROLLBACK:
--   delete from public.notification_role_policies where notification_key = 'new_hire_mailbox_alert';
--   then re-add notification_role_policies_notification_key_check with the 21 keys of
--   20260910233000_notification_role_policies_mapping_guard_key.sql.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: one constraint rebuilt with every existing key kept, and one
-- new seed row.

begin;

-- The audience key. Same shape as 20260910233000 and its predecessors: look the CHECK's real name up
-- rather than guessing it, and carry every existing key forward — ADD CONSTRAINT validates existing
-- rows, so dropping one would fail this migration outright rather than silently narrow the column.
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
    'new_hire_mailbox_alert'
  ));

-- Seeded byte-matched to DEFAULT_NOTIFICATION_ROLE_POLICIES in role-recipients.ts, so the console and
-- the send path cannot disagree on deploy day. ON CONFLICT DO NOTHING: safe to re-run, and it can
-- never clobber a real admin edit made after it first applied.
insert into public.notification_role_policies (notification_key, label, description, roles, enabled) values
  ('new_hire_mailbox_alert', 'New hire mailbox',
    'Who is told, in-app and on Telegram, when an employee is added, so that person''s Turbify mailbox can be created and its app password handed to Phoenix. The notice carries the new hire''s name, job title and the address Phoenix proposes, and links to the New Hire Mailboxes page. Never email: the mailbox it is about does not exist yet. Defaults to Super Admin alone — the owner''s instruction, 2026-09-18.',
    array['Super Admin'], true)
on conflict (notification_key) do nothing;

commit;
