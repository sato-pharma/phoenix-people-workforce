-- Admin decisions for CRM agent/double-visitor identities that never resolve via
-- employees.crm_id/crm_username (see the "Unmapped Agents" tab on /admin/visits-report).
-- Three outcomes per crm_id:
--   resigned - no longer worth chasing (left the company, or a generic/territory CRM
--              account with no matching employee at all) - store the decision, hide the
--              identity from the Unmapped Agents list; the underlying visit rows stay
--              genuinely unmapped forever, on purpose.
--   mapped   - a specific employees.hr_id was identified by an admin - stamped onto every
--              existing unmapped visit row for this crm_id immediately, and also fed back
--              into the CRM identity-resolution waterfall so future syncs resolve it too
--              (see resolveEmployeeHrId in src/lib/visits-report/service.ts).
--   pending  - default; no decision yet, identity keeps showing up in the list.

create table if not exists public.ireports360_crm_identity_resolutions (
  crm_id bigint primary key,
  status text not null default 'pending' check (status in ('pending', 'resigned', 'mapped')),
  mapped_hr_id text null,
  crm_name text null,
  resolved_by_hr_id text null,
  resolved_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ireports360_crm_identity_resolutions_mapped_hr_id_check
    check (status <> 'mapped' or mapped_hr_id is not null)
);

alter table public.ireports360_crm_identity_resolutions enable row level security;

revoke all on table public.ireports360_crm_identity_resolutions from anon, authenticated;

grant select, insert, update, delete on table public.ireports360_crm_identity_resolutions to service_role;

drop policy if exists ireports360_crm_identity_resolutions_service_role on public.ireports360_crm_identity_resolutions;
create policy ireports360_crm_identity_resolutions_service_role
  on public.ireports360_crm_identity_resolutions
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.ireports360_crm_identity_resolutions is
  'Admin resolution decisions for iReports360 CRM identities that never auto-map to an employees.hr_id. status=resigned hides the identity from the Unmapped Agents tab without mutating visit rows; status=mapped stamps mapped_hr_id onto matching ireports360_visits rows and feeds the ongoing sync''s identity-matching waterfall.';
