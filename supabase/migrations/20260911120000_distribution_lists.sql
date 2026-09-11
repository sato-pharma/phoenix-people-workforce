-- Named, reusable recipient groups ("distribution lists") plus a register of the company email
-- aliases that live on Turbify.
--
-- Two tables because the two halves answer different questions and fail in different ways:
--
--   distribution_lists     — who Phoenix itself should address. Resolved fresh at send time from
--                            the live employee directory, so it cannot go stale when somebody
--                            joins, moves line or leaves. This is the half that replaces the
--                            roughly a dozen hardcoded recipient arrays scattered across the
--                            domain modules.
--
--   company_email_aliases  — what exists on the MAIL SERVER. Turbify has no API (see
--                            docs/agents-owner-rules.md), so Phoenix can never read or write a
--                            real alias. Every membership figure here is therefore an
--                            ATTESTATION — what a human last recorded after looking at the
--                            control panel — never an observation. Same rule as
--                            mailbox_offboarding_tasks. The value is the DRIFT: comparing the
--                            attested membership against the live list says exactly what to
--                            change by hand, which is how a leaver stops silently receiving
--                            company mail.
--
-- Deliberately NOT constrained: the role list. notification_role_policies pins its roles in a
-- CHECK, which went stale the moment the HR seats were renamed ("HR Advisory"/"HR Operations"
-- are absent from its original constraint). Roles are sanitized in TypeScript against
-- phoenixRoles instead, so adding a role never needs a migration here.
begin;

create table if not exists public.distribution_lists (
  list_key text primary key check (list_key ~ '^[a-z][a-z0-9_]*$'),
  label text not null,
  description text not null default '',

  -- Rule half. Every NON-EMPTY dimension must match (AND across dimensions, OR within one), so
  -- roles={'Medical Rep'} + line_ids={3} means "medical reps on line 3", and an empty array
  -- means "no constraint on this dimension" rather than "matches nobody".
  roles text[] not null default '{}'::text[],
  line_ids integer[] not null default '{}'::integer[],
  area_ids integer[] not null default '{}'::integer[],
  department_ids integer[] not null default '{}'::integer[],
  position_ids integer[] not null default '{}'::integer[],
  region_codes text[] not null default '{}'::text[],

  -- Static half. included_hr_ids are added on top of whatever the rule matched; excluded_hr_ids
  -- are removed last and therefore always win. external_emails are addresses with no employee
  -- behind them (an auditor, a distributor contact) and skip the directory entirely.
  included_hr_ids text[] not null default '{}'::text[],
  excluded_hr_ids text[] not null default '{}'::text[],
  external_emails text[] not null default '{}'::text[],

  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text
);

comment on table public.distribution_lists is
  'Named recipient groups resolved from the live employee directory at send time. Routing only — no send path reads this to originate mail on its own.';

alter table public.distribution_lists enable row level security;

create policy phx_distribution_lists_service_role on public.distribution_lists
  for all
  to service_role
  using (true)
  with check (true);

grant all on table public.distribution_lists to service_role;

create table if not exists public.company_email_aliases (
  alias_address text primary key check (alias_address = lower(alias_address) and alias_address like '%@%'),
  label text not null,
  purpose text not null default '',
  provider text not null default 'turbify' check (provider in ('turbify', 'other')),

  -- Which Phoenix list this alias is supposed to mirror. Nullable: an alias can be registered
  -- purely so the leaver sweep knows it exists, before anyone decides what drives it.
  distribution_list_key text references public.distribution_lists (list_key) on delete set null,

  -- ATTESTED membership, not observed — see the header. recorded_at going stale is the normal
  -- state, not a fault, which is why the reader shows the age rather than hiding it.
  recorded_member_emails text[] not null default '{}'::text[],
  recorded_at timestamptz,
  recorded_by text,

  is_active boolean not null default true,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text
);

comment on column public.company_email_aliases.recorded_member_emails is
  'What a human last saw in the Turbify control panel. Turbify has no API, so this can never be verified from here — treat it as an attestation with an age, never as current truth.';

alter table public.company_email_aliases enable row level security;

create policy phx_company_email_aliases_service_role on public.company_email_aliases
  for all
  to service_role
  using (true)
  with check (true);

grant all on table public.company_email_aliases to service_role;

create index if not exists company_email_aliases_list_key_idx
  on public.company_email_aliases (distribution_list_key)
  where distribution_list_key is not null;

-- Seeded from the three groups the email composer resolves today
-- (src/lib/email/email-composer-service.ts). Those match on a SUBSTRING of the department and
-- job-title text — roleText(employee).includes("hr") — which is why they are being replaced:
-- the rule is invisible, unauditable and silently catches or misses people as titles are typed.
-- Seeded DISABLED so nothing changes audience on deploy day; each is switched on once its
-- membership has been read back on the admin screen and checked against the substring set.
insert into public.distribution_lists (list_key, label, description, roles, department_ids, enabled) values
  ('hr_team', 'HR Team',
   'HR seats. Replaces the composer''s "HR Team" group, which matched any employee whose department or job title text contained "hr".',
   array['HR Advisory', 'HR Operations']::text[], '{}'::integer[], false),
  ('finance_team', 'Finance Team',
   'Finance seats. Replaces the composer''s "Finance Team" group, which matched any employee whose department or job title text contained "finance".',
   array['Finance Manager', 'Financial Advisor']::text[], '{}'::integer[], false),
  ('sales_managers', 'Sales Managers',
   'District, Regional and National sales managers across every line. No hardcoded predecessor — added because the closing and weekly senders each build their own copy of this audience.',
   array['District Manager', 'Regional Manager', 'National Sales Manager']::text[], '{}'::integer[], false)
on conflict (list_key) do nothing;

commit;
