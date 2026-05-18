begin;

create extension if not exists pgcrypto;

create table if not exists public.email_templates (
  id uuid primary key default gen_random_uuid(),
  template_key text not null unique,
  template_name text not null default '',
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

alter table public.email_templates
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists template_key text,
  add column if not exists template_name text default '',
  add column if not exists description text,
  add column if not exists is_active boolean default true,
  add column if not exists subject text default '',
  add column if not exists greeting text default 'Dear {{recipientName}},',
  add column if not exists body_html text default '<p>Body content is not configured yet.</p>',
  add column if not exists body_text text default 'Body content is not configured yet.',
  add column if not exists closing_text text default 'Best regards,\nPhoenix HR Team',
  add column if not exists preview_text text default '',
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now(),
  add column if not exists updated_by text;

update public.email_templates
set
  id = coalesce(id, gen_random_uuid()),
  template_name = coalesce(template_name, template_key, ''),
  is_active = coalesce(is_active, true),
  subject = coalesce(subject, ''),
  greeting = coalesce(greeting, 'Dear {{recipientName}},'),
  body_html = coalesce(body_html, '<p>Body content is not configured yet.</p>'),
  body_text = coalesce(body_text, 'Body content is not configured yet.'),
  closing_text = coalesce(closing_text, 'Best regards,\nPhoenix HR Team'),
  preview_text = coalesce(preview_text, ''),
  created_at = coalesce(created_at, now()),
  updated_at = coalesce(updated_at, now());

alter table public.email_templates
  alter column id set default gen_random_uuid(),
  alter column id set not null,
  alter column template_key set not null,
  alter column template_name set not null,
  alter column is_active set default true,
  alter column is_active set not null,
  alter column subject set default '',
  alter column subject set not null,
  alter column greeting set default 'Dear {{recipientName}},',
  alter column greeting set not null,
  alter column body_html set default '<p>Body content is not configured yet.</p>',
  alter column body_html set not null,
  alter column body_text set default 'Body content is not configured yet.',
  alter column body_text set not null,
  alter column closing_text set default 'Best regards,\nPhoenix HR Team',
  alter column closing_text set not null,
  alter column preview_text set default '',
  alter column preview_text set not null,
  alter column created_at set default now(),
  alter column created_at set not null,
  alter column updated_at set default now(),
  alter column updated_at set not null;

create unique index if not exists email_templates_template_key_idx
  on public.email_templates (template_key);

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

alter table public.email_template_recipient_rules
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists template_key text,
  add column if not exists to_roles text[] default '{}'::text[],
  add column if not exists cc_roles text[] default '{}'::text[],
  add column if not exists bcc_roles text[] default '{}'::text[],
  add column if not exists target_titles text[] default '{}'::text[],
  add column if not exists target_lines text[] default '{}'::text[],
  add column if not exists static_to_emails text[] default '{}'::text[],
  add column if not exists static_cc_emails text[] default '{}'::text[],
  add column if not exists static_bcc_emails text[] default '{}'::text[],
  add column if not exists updated_at timestamptz default now(),
  add column if not exists updated_by text;

update public.email_template_recipient_rules
set
  id = coalesce(id, gen_random_uuid()),
  to_roles = coalesce(to_roles, '{}'::text[]),
  cc_roles = coalesce(cc_roles, '{}'::text[]),
  bcc_roles = coalesce(bcc_roles, '{}'::text[]),
  target_titles = coalesce(target_titles, '{}'::text[]),
  target_lines = coalesce(target_lines, '{}'::text[]),
  static_to_emails = coalesce(static_to_emails, '{}'::text[]),
  static_cc_emails = coalesce(static_cc_emails, '{}'::text[]),
  static_bcc_emails = coalesce(static_bcc_emails, '{}'::text[]),
  updated_at = coalesce(updated_at, now());

alter table public.email_template_recipient_rules
  alter column id set default gen_random_uuid(),
  alter column id set not null,
  alter column template_key set not null,
  alter column to_roles set default '{}'::text[],
  alter column to_roles set not null,
  alter column cc_roles set default '{}'::text[],
  alter column cc_roles set not null,
  alter column bcc_roles set default '{}'::text[],
  alter column bcc_roles set not null,
  alter column target_titles set default '{}'::text[],
  alter column target_titles set not null,
  alter column target_lines set default '{}'::text[],
  alter column target_lines set not null,
  alter column static_to_emails set default '{}'::text[],
  alter column static_to_emails set not null,
  alter column static_cc_emails set default '{}'::text[],
  alter column static_cc_emails set not null,
  alter column static_bcc_emails set default '{}'::text[],
  alter column static_bcc_emails set not null,
  alter column updated_at set default now(),
  alter column updated_at set not null;

create unique index if not exists email_template_rules_template_key_idx
  on public.email_template_recipient_rules (template_key);

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

commit;
