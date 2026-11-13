-- phoenix_crm_pharmacy_distributor_links
--
-- WHAT THIS CHANGES:
--   A new table, phoenix_crm_pharmacy_distributor_links: one row per (Phoenix CRM pharmacy, distributor
--   customer) pair that is the same shop. A Phoenix CRM pharmacy is a phoenix_crm_customers row with
--   list_type = 'Pharmacy'; a distributor customer is a source_of_sales_customer_map row, keyed by its own
--   unique (distributor_code, customer_code). One shop bought through three distributors is three rows.
--   Service role only: RLS on, no grant to anon or authenticated, no policy.
--
-- WHY (owner, 13 Nov 2026): he asked for every Phoenix CRM pharmacy to be compared by name with the
--   distributor customers of the same area, then "save the exact and strong matches as links". He chose
--   to save only the matches whose name fits ONE shop in the area (a name shared by several shops waits
--   for the rep), and to link dropped pharmacies too. The rows are written by
--   scripts/phoenix-crm/pharmacy-distributor-links.mjs --apply, not by this file.
--
-- WHAT DOES NOT CHANGE: no existing table, row, view or function is touched; nothing reads this table yet.
--
-- ROLLBACK:
--   drop table public.phoenix_crm_pharmacy_distributor_links;
--   It holds only rows the script can write again from the live data, so nothing is lost by dropping it.

begin;

create table if not exists public.phoenix_crm_pharmacy_distributor_links (
  id bigint generated always as identity primary key,
  crm_customer_id uuid not null references public.phoenix_crm_customers (id) on delete cascade,
  distributor_code text not null,
  customer_code text not null,
  -- How the pair was found: the name audit's band, or 'confirmed' once a person says so.
  match_band text not null check (match_band in ('exact', 'strong', 'likely', 'possible', 'confirmed')),
  -- Name similarity, 0..100, as the audit scored it.
  name_score smallint not null check (name_score between 0 and 100),
  crm_name text not null,
  distributor_customer_name text not null,
  area_code text,
  source text not null,
  linked_by_hr_id text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phoenix_crm_pharmacy_distributor_links_pair_key unique (crm_customer_id, distributor_code, customer_code),
  constraint phoenix_crm_pharmacy_distributor_links_customer_fkey
    foreign key (distributor_code, customer_code)
    references public.source_of_sales_customer_map (distributor_code, customer_code)
    on update cascade on delete cascade
);

comment on table public.phoenix_crm_pharmacy_distributor_links is
  'A Phoenix CRM pharmacy and the distributor customer that is the same shop. One row per distributor. Written by scripts/phoenix-crm/pharmacy-distributor-links.mjs.';

create index if not exists phoenix_crm_pharmacy_distributor_links_customer_idx
  on public.phoenix_crm_pharmacy_distributor_links (distributor_code, customer_code);

alter table public.phoenix_crm_pharmacy_distributor_links enable row level security;
revoke all on table public.phoenix_crm_pharmacy_distributor_links from public, anon, authenticated;
grant select, insert, update, delete on table public.phoenix_crm_pharmacy_distributor_links to service_role;

commit;
