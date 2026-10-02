-- notification_role_policies: the accepted_offer_alert audience
--
-- WHAT THIS CHANGES: adds 'accepted_offer_alert' to the notification_key CHECK on
-- public.notification_role_policies and seeds its row — who is told, in-app, by push and on
-- Telegram, the moment a job offer is marked accepted, so the new hire can be seated. Super Admin
-- and HR Operations by default.
-- WHY: owner instruction 2026-10-02 ("add a push alert for newly accepted offers", recipients =
-- Super Admin + HR Operations). Its own file, like every audience key before it, because the CHECK
-- rebuild is found by this file NAME (tests/distributor-upload-nudge.test.ts reads the newest
-- *_notification_role_policies_*_key.sql), and a key the newest rebuild omits is a key the database
-- will refuse.
-- ROLLBACK:
--   delete from public.notification_role_policies where notification_key = 'accepted_offer_alert';
--   then re-add notification_role_policies_notification_key_check with the 24 keys of
--   20260926090000_notification_role_policies_activity_inactivity_digest.sql.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: one constraint rebuilt with every existing key kept, and one
-- new seed row. Idempotent — a re-run changes nothing.

begin;

-- The audience key. Same shape as every predecessor: look the CHECK's real name up rather than
-- guessing it, and carry every existing key forward — ADD CONSTRAINT validates existing rows, so
-- dropping one would fail this migration outright rather than silently narrow the column.
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
    'activity_inactivity_digest',
    'accepted_offer_alert'
  ));

-- Seeded byte-matched to DEFAULT_NOTIFICATION_ROLE_POLICIES in role-recipients.ts, so the console and
-- the send path cannot disagree on deploy day. ON CONFLICT DO NOTHING: safe to re-run, and it can
-- never clobber a real admin edit made after it first applied.
insert into public.notification_role_policies (notification_key, label, description, roles, enabled) values
  ('accepted_offer_alert', 'Offer accepted — ready to hire',
    'Who is told, in-app, by push and on Telegram, the moment a job offer is marked accepted, so the new hire can be seated. The notice carries the candidate''s name, the agreed start date and the seat the offer named, and links to the organogram where an accepted offer is now one press to hire. Defaults to Super Admin and HR Operations — the owner''s choice, 2026-10-02.',
    array['Super Admin', 'HR Operations'], true)
on conflict (notification_key) do nothing;

commit;
