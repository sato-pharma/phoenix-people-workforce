-- Admin-resolvable mapping from an iReports360 CRM CUSTOMER (the visited contact — a doctor,
-- pharmacy or hospital, keyed on the vendor's own contactID) to a real Phoenix brick
-- (source_of_sales_bricks). Mirrors the existing region mapping
-- (ireports360_crm_region_brick_resolutions, 20260722140000) exactly, one level finer:
--
--   CRM region  -> brick   answers "roughly where is this locality?"      (294 regions)
--   CRM customer-> brick   answers "exactly where is this customer?"      (~12.5k contacts)
--
-- A customer-level mapping is strictly more precise than its region's, so downstream readers
-- prefer it and fall back to the region mapping when a customer has no decision of its own.
--
-- status=pending (default, shows on the "Customer Mapping" admin tab) / mapped (brick_id set,
-- resolved) / ignored (an admin decided this contact is not worth mapping — a CRM-side artifact,
-- a duplicate, or a non-geographic entry — so it stops appearing on the punch-list, mirroring
-- 'ignored' on the region table and 'resigned' on ireports360_crm_identity_resolutions).
create table if not exists public.ireports360_crm_customer_brick_resolutions (
  crm_contact_id integer primary key,
  crm_contact_name text not null,
  brick_id text references public.source_of_sales_bricks(brick_id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'mapped', 'ignored')),
  resolved_by_hr_id text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ireports360_crm_customer_brick_resolutions_brick_id_check
    check (status <> 'mapped' or brick_id is not null)
);

-- The punch-list and the master-table overlay both look up "every mapped customer", so keep that
-- slice cheap as the table grows toward one row per contact.
create index if not exists ireports360_crm_customer_brick_resolutions_status_idx
  on public.ireports360_crm_customer_brick_resolutions (status)
  where status = 'mapped';

-- Scanning visits for the distinct contacts that still need a decision is the punch-list's hot
-- path; without this it is a full scan of a 100k+ row table on every render.
create index if not exists ireports360_visits_contact_crm_id_idx
  on public.ireports360_visits (contact_crm_id)
  where contact_crm_id is not null;

alter table public.ireports360_crm_customer_brick_resolutions enable row level security;

revoke all on table public.ireports360_crm_customer_brick_resolutions from anon, authenticated;

grant select, insert, update, delete on table public.ireports360_crm_customer_brick_resolutions to service_role;

drop policy if exists ireports360_crm_customer_brick_resolutions_service_role on public.ireports360_crm_customer_brick_resolutions;
create policy ireports360_crm_customer_brick_resolutions_service_role
  on public.ireports360_crm_customer_brick_resolutions
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.ireports360_crm_customer_brick_resolutions is
  'Admin resolution decisions mapping an iReports360 CRM customer/contact (contact_crm_id — a doctor, pharmacy or hospital) to a real Phoenix brick (source_of_sales_bricks.brick_id). Finer-grained than ireports360_crm_region_brick_resolutions: a customer mapping wins over its region mapping wherever both exist. status=ignored hides a contact from the Customer Mapping tab without ever assigning it a brick.';

notify pgrst, 'reload schema';
