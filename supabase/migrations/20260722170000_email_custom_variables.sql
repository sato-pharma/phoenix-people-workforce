-- Admin-defined custom email template variables (owner request, 2026-07-22).
--
-- Lets an admin create a new {{token}} for email templates WITHOUT a code change, by binding
-- it to an existing column on `employees`. The value is resolved at render time from the
-- SUBJECT employee's record.
--
-- SECURITY — why this is safe, and where the real control lives:
-- `source_column` is validated against a HARDCODED server-side allowlist in
-- src/lib/email-templates/custom-variables.ts (EMPLOYEE_VARIABLE_SOURCES), NOT against this
-- table and NOT against information_schema. The employees table holds net_salary,
-- basic_salary, bank_account, national_id, social/medical insurance numbers, mobile_number
-- and residence_* — none of which may ever become an email token, because a template can CC
-- an entire line. The allowlist is identity/org/contract fields only. A row whose
-- source_column is not on the allowlist resolves to an empty string and is reported as
-- invalid in the admin UI; it can never leak a value.
--
-- Read/written only through the service role (server-side); no client-facing grants.

create table if not exists public.email_custom_variables (
  token text primary key,
  label text not null,
  source_column text not null,
  description text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.email_custom_variables is
  'Admin-defined {{token}} -> employees column bindings for email templates. source_column is enforced against a hardcoded safe-column allowlist in application code (never arbitrary SQL); salary/national-id/bank/insurance/contact columns are permanently excluded. Not exposed to anon/authenticated.';

alter table public.email_custom_variables enable row level security;

revoke all on public.email_custom_variables from anon, authenticated;
