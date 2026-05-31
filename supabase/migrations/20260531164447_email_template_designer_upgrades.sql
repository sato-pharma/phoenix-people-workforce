create table if not exists public.email_template_drafts (
  template_key text primary key,
  template_snapshot jsonb not null,
  rules_snapshot jsonb not null,
  edited_by text,
  edited_at timestamptz not null default now(),
  reason text
);

comment on table public.email_template_drafts is
  'Working email template drafts. Automated sends use the published email_templates rows until an admin publishes the draft.';

create index if not exists email_template_drafts_edited_at_idx
  on public.email_template_drafts (edited_at desc);

alter table public.email_template_drafts enable row level security;

revoke all on public.email_template_drafts from anon, authenticated;
grant select, insert, update, delete on public.email_template_drafts to service_role;

drop policy if exists phx_email_template_drafts_service_role on public.email_template_drafts;
create policy phx_email_template_drafts_service_role
  on public.email_template_drafts
  for all
  to service_role
  using (true)
  with check (true);
