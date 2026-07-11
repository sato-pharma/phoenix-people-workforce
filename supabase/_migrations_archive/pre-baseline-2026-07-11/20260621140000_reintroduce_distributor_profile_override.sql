-- Phase 6 (Monthly / Sales Operation editable profiles): RE-INTRODUCE the editable distributor ->
-- Phoenix column-mapping override that 20260620000000_drop_distributor_profile_override.sql removed.
-- Each row WHOLLY overrides the code-defined RAW_DISTRIBUTOR_PROFILES for one distributor (whole-profile
-- override). resolveDistributorProfile() resolves DB-first (active=true) and falls back to code, so this
-- table starts EMPTY and behaviour is identical until an admin saves a mapping in the editor.
-- Additive + reversible. Service-role writes only; authenticated read of active rows.
-- Adds distributor_name (absent in the original 20260605164821 schema) so a brand-new distributor can be
-- onboarded with a display name from the editor.

create table if not exists public.source_of_sales_distributor_profile (
  distributor_code text primary key,
  distributor_name text not null default '',
  product_code_columns text[] not null default '{}'::text[],
  product_name_columns text[] not null default '{}'::text[],
  qty_columns text[] not null default '{}'::text[],
  branch_code_columns text[] not null default '{}'::text[],
  branch_name_columns text[] not null default '{}'::text[],
  bonus_columns text[] not null default '{}'::text[],
  value_columns text[] not null default '{}'::text[],
  discount_columns text[] not null default '{}'::text[],
  date_columns text[] not null default '{}'::text[],
  customer_code_columns text[] not null default '{}'::text[],
  customer_name_columns text[] not null default '{}'::text[],
  customer_address_columns text[] not null default '{}'::text[],
  area_id_columns text[] not null default '{}'::text[],
  area_name_columns text[] not null default '{}'::text[],
  brick_id_columns text[] not null default '{}'::text[],
  brick_name_columns text[] not null default '{}'::text[],
  region_columns text[] not null default '{}'::text[],
  value_source text not null default 'recompute',
  region_only boolean not null default false,
  active boolean not null default true,
  updated_by text not null default 'system',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_of_sales_distributor_profile_code_not_blank check (btrim(distributor_code) <> ''),
  constraint source_of_sales_distributor_profile_value_source_check check (value_source in ('recompute', 'sheet'))
);

alter table public.source_of_sales_distributor_profile enable row level security;

revoke all on table public.source_of_sales_distributor_profile from anon, authenticated;
grant select on table public.source_of_sales_distributor_profile to authenticated;
grant select, insert, update, delete on table public.source_of_sales_distributor_profile to service_role;

drop policy if exists source_of_sales_distributor_profile_authenticated_read on public.source_of_sales_distributor_profile;
create policy source_of_sales_distributor_profile_authenticated_read
on public.source_of_sales_distributor_profile
for select
to authenticated
using (active = true);

drop policy if exists source_of_sales_distributor_profile_service_role_all on public.source_of_sales_distributor_profile;
create policy source_of_sales_distributor_profile_service_role_all
on public.source_of_sales_distributor_profile
for all
to service_role
using (true)
with check (true);
