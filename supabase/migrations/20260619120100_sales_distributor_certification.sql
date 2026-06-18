-- C4 — Distributor certification lifecycle.
-- Governs whether a distributor is allowed into production imports. A distributor moves through
-- Draft -> Testing -> Certified -> Production Ready; only Certified / Production Ready may process
-- production uploads (enforced in the upload service once this is applied + wired).
-- NOT YET APPLIED — staged for approval. Server-only (service role); RLS enabled with no policies.

create table if not exists public.source_of_sales_distributor_certification (
  distributor_code text primary key,
  status text not null default 'Draft' check (status in ('Draft', 'Testing', 'Certified', 'Production Ready')),
  notes text,
  updated_by text not null default 'system',
  updated_at timestamptz not null default now()
);

alter table public.source_of_sales_distributor_certification enable row level security;

comment on table public.source_of_sales_distributor_certification is
  'C4: distributor onboarding lifecycle (Draft/Testing/Certified/Production Ready). Only Certified+ may run production imports. Server-only.';
