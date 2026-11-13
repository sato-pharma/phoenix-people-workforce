BEGIN;

create extension if not exists pgcrypto;

create table if not exists public.email_templates (
  id uuid primary key default gen_random_uuid(),
  template_key text not null unique,
  template_name text not null,
  description text null,
  is_active boolean not null default true,
  subject text not null default '',
  greeting text not null default 'Dear {{recipientName}},',
  body_html text not null default '<p>Body content is not configured yet.</p>',
  body_text text not null default 'Body content is not configured yet.',
  closing_text text not null default 'Best regards,\nPhoenix HR Team',
  preview_text text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text null
);

create table if not exists public.email_template_recipient_rules (
  id uuid primary key default gen_random_uuid(),
  template_key text not null unique references public.email_templates(template_key) on delete cascade,
  to_roles text[] not null default '{}'::text[],
  cc_roles text[] not null default '{}'::text[],
  bcc_roles text[] not null default '{}'::text[],
  target_titles text[] not null default '{}'::text[],
  target_lines text[] not null default '{}'::text[],
  static_to_emails text[] not null default '{}'::text[],
  static_cc_emails text[] not null default '{}'::text[],
  static_bcc_emails text[] not null default '{}'::text[],
  updated_at timestamptz not null default now(),
  updated_by text null
);

create unique index if not exists email_templates_template_key_idx on public.email_templates (template_key);
create unique index if not exists email_template_rules_template_key_idx on public.email_template_recipient_rules (template_key);

alter table public.email_templates enable row level security;
alter table public.email_template_recipient_rules enable row level security;

revoke all on public.email_templates from anon, authenticated;
revoke all on public.email_template_recipient_rules from anon, authenticated;

grant all on public.email_templates to service_role;
grant all on public.email_template_recipient_rules to service_role;

drop policy if exists phx_email_templates_service_role on public.email_templates;
create policy phx_email_templates_service_role
  on public.email_templates
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists phx_email_template_rules_service_role on public.email_template_recipient_rules;
create policy phx_email_template_rules_service_role
  on public.email_template_recipient_rules
  for all
  to service_role
  using (true)
  with check (true);

COMMIT;
