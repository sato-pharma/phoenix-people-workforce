begin;

create index if not exists email_delivery_events_recipients_gin_idx
  on public.email_delivery_events using gin (recipients);

commit;
