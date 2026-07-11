create table if not exists public.manual_email_send_audit (
  id uuid primary key default gen_random_uuid(),
  actor text,
  to_recipients text[] not null default '{}',
  cc_recipients text[] not null default '{}',
  bcc_recipients text[] not null default '{}',
  recipients_hash text not null,
  external_recipients text[] not null default '{}',
  external_justification text,
  subject text not null,
  template_key text,
  client_request_id text,
  provider_message_id text,
  provider_skipped boolean not null default false,
  provider_reason text,
  error_message text,
  status text not null check (status in ('sent', 'skipped', 'failed')),
  created_at timestamptz not null default now()
);

comment on table public.manual_email_send_audit is
  'Append-only audit trail for manual email composer sends. Access is restricted to service-role backend code.';

create index if not exists manual_email_send_audit_created_at_idx
  on public.manual_email_send_audit (created_at desc);

create index if not exists manual_email_send_audit_recipients_hash_idx
  on public.manual_email_send_audit (recipients_hash);

alter table public.manual_email_send_audit enable row level security;

revoke all on public.manual_email_send_audit from anon, authenticated;
grant select, insert on public.manual_email_send_audit to service_role;

drop policy if exists "manual email audit service role access" on public.manual_email_send_audit;
create policy "manual email audit service role access"
  on public.manual_email_send_audit
  for all
  to service_role
  using (true)
  with check (true);
