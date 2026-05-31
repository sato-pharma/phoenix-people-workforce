create extension if not exists pgcrypto;

create table if not exists public.email_template_history (
  id uuid primary key default gen_random_uuid(),
  template_key text not null references public.email_templates(template_key) on delete cascade,
  version_number integer not null,
  action text not null check (action in ('draft', 'publish', 'rollback', 'save')),
  template_snapshot jsonb not null,
  rules_snapshot jsonb not null,
  changed_by text null,
  changed_at timestamptz not null default now(),
  reason text null,
  rollback_source_version integer null,
  constraint email_template_history_template_version_uniq unique (template_key, version_number)
);

create index if not exists email_template_history_template_key_changed_at_idx
  on public.email_template_history (template_key, changed_at desc);

alter table public.email_template_history enable row level security;

revoke all on public.email_template_history from anon, authenticated;
grant all on public.email_template_history to service_role;

drop policy if exists phx_email_template_history_service_role on public.email_template_history;
create policy phx_email_template_history_service_role
  on public.email_template_history
  for all
  to service_role
  using (true)
  with check (true);
