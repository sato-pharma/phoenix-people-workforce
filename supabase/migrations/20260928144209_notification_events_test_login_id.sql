-- Phoenix CRM test world — who a notice belongs to.
--
-- A test-world notice is ADDRESSED to the employee it mirrors, because `employee_hr_id` and
-- `recipients` are what the notification bell queries by. What keeps it off her bell is this marker:
-- the `TEST-` login allowed to see it. NULL on every real notification, which is why the change is
-- invisible to everyone who is not signed in as a test account.
--
-- Additive and backfill-free on purpose: every existing row stays NULL and so stays everyone's, and
-- the reader treats "no marker" as an ordinary notification.
alter table public.notification_events
  add column if not exists test_login_id text;

comment on column public.notification_events.test_login_id is
  'Phoenix CRM test world only: the TEST- login allowed to see this notice. NULL on every real notification. See src/lib/auth/test-persona.ts.';

-- Partial: the marked rows are a handful among all notifications, and this keeps the index that size.
create index if not exists notification_events_test_login_id_idx
  on public.notification_events (test_login_id)
  where test_login_id is not null;
