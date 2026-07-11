-- Read-receipts on digest notifications: links a weekly digest to the
-- notification event created when it was sent, so the settlement dashboard
-- can show whether the employee has actually opened it (in-app read
-- receipt, or email-open tracking via the existing Resend webhook feed) —
-- not just that it was queued for delivery.

begin;

alter table public.attendance_weekly_digests
  add column if not exists notification_event_id uuid null
    references public.notification_events(id) on delete set null;

create index if not exists attendance_weekly_digests_notification_event_idx
  on public.attendance_weekly_digests (notification_event_id)
  where notification_event_id is not null;

notify pgrst, 'reload schema';

commit;
