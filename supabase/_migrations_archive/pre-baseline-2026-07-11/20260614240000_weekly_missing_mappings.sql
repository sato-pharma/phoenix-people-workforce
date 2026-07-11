-- Weekly Sales — captured "missing mapping" labels.
--
-- When a distributor's RAW weekly file is uploaded, the parser translates its labels to
-- official Phoenix codes via weekly_distributor_mapping. Any label the mapping does not yet
-- know is recorded here so the "Weekly Missing Data" tab can surface it: the user fills the
-- official code once (which writes weekly_distributor_mapping), then re-uploads the raw file.
--
-- "Open" is derived live: a captured row is still missing only while no matching row exists in
-- weekly_distributor_mapping (same distributor + dimension + normalized value). Filling the
-- mapping auto-resolves it — no status column to keep in sync.
--
-- RLS: enabled, no public policies — service-role only, gated by weekly_sales in the routes.

create table if not exists public.weekly_missing_mappings (
  id uuid primary key default gen_random_uuid(),
  distributor_code text not null,
  dimension text not null check (dimension in ('product', 'region')),
  raw_value text not null,
  normalized_raw_value text not null,
  occurrences integer not null default 1,
  sample_file text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (distributor_code, dimension, normalized_raw_value)
);

create index if not exists weekly_missing_mappings_lookup_idx
  on public.weekly_missing_mappings (distributor_code, dimension);

alter table public.weekly_missing_mappings enable row level security;

comment on table public.weekly_missing_mappings is
  'Weekly Sales: raw labels from uploaded raw files that have no weekly_distributor_mapping yet. Surfaced in the Weekly Missing Data tab; resolved live once the mapping exists.';
