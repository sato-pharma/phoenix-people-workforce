-- Private Calendar — No Activity day-after email tracking.
--
-- first_notified_at: when the day-after "please clarify" email was sent to the
-- employee (CC HR/Super Admin). Also doubles as the row-creation marker for
-- days the employee never touched themselves — the daily cron creates the row
-- at first-notification time if one doesn't already exist.

begin;

alter table public.private_calendar_no_activity_clarifications
    add column if not exists first_notified_at timestamptz;

comment on column public.private_calendar_no_activity_clarifications.first_notified_at is
    'When the day-after "please clarify" email was sent to the employee (CC HR). Set by the daily cron, not the employee.';

notify pgrst, 'reload schema';

commit;
