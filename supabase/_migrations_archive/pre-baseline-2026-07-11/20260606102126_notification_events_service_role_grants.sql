begin;

alter table public.notification_events enable row level security;

revoke all on public.notification_events from anon, authenticated;
grant select, insert, update, delete on public.notification_events to service_role;

drop policy if exists phx_notification_events_service_role on public.notification_events;
create policy phx_notification_events_service_role
  on public.notification_events
  for all
  to service_role
  using (true)
  with check (true);

notify pgrst, 'reload schema';

commit;
