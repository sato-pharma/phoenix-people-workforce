-- C1 — Sales mapping audit/history (reversible edits + audit trail).
-- Records every create/edit/delete to the mapping dictionary (customer map + product/territory/area/
-- region aliases) with before/after JSON so a change can be reviewed and reversed.
-- NOT YET APPLIED — staged for approval. Server-only (service role); RLS enabled with no policies,
-- matching the other source_of_sales_* / weekly_sales_* tables.

create table if not exists public.source_of_sales_mapping_audit (
  id uuid primary key default gen_random_uuid(),
  -- which dictionary the change touched
  entity_type text not null check (entity_type in ('customer_map', 'product_alias', 'territory_alias', 'area_alias', 'region_alias')),
  distributor_code text,            -- null for global aliases (territory/area/region)
  entity_key text not null,         -- the natural key changed (e.g. customer_code, normalized_alias)
  action text not null check (action in ('add', 'edit', 'delete')),
  before_json jsonb,                -- prior row (null on add)
  after_json jsonb,                 -- new row (null on delete)
  actor text not null default 'system',
  created_at timestamptz not null default now()
);

create index if not exists idx_sos_mapping_audit_entity
  on public.source_of_sales_mapping_audit (entity_type, distributor_code, entity_key);
create index if not exists idx_sos_mapping_audit_created
  on public.source_of_sales_mapping_audit (created_at desc);

alter table public.source_of_sales_mapping_audit enable row level security;

comment on table public.source_of_sales_mapping_audit is
  'C1: audit/history of Sales mapping dictionary changes (before/after JSON) for review + rollback. Server-only.';
