-- Live "times fired" counters per admin-editable email template (owner request, 2026-07-22).
-- Incremented server-side (service role) by sendTemplatedEmail() in
-- src/lib/email-templates/service.ts on every real, successful automated send — never by a
-- manual "Send Test" click. Read only via the server-side catalog function
-- (getEmailTemplateCatalog), so no client-facing grants are needed; RLS stays default-deny
-- for anon/authenticated and the service role bypasses it as usual.

create table if not exists public.email_template_send_stats (
  template_key text primary key,
  sent_count integer not null default 0,
  last_sent_at timestamptz,
  updated_at timestamptz not null default now()
);

comment on table public.email_template_send_stats is
  'Live send counters per admin email template (email_templates.template_key), incremented server-side by sendTemplatedEmail() on every real automated send. Not exposed to anon/authenticated.';

alter table public.email_template_send_stats enable row level security;

revoke all on public.email_template_send_stats from anon, authenticated;
