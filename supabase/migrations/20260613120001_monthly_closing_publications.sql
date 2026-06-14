-- ─────────────────────────────────────────────────────────────────────────────
-- Monthly Closing — publication gate (per line, per period).
--
-- The admin Source-of-Sales pipeline produces a monthly closing matrix from
-- validated distributor sheets. Employees (sales managers + product managers)
-- must NOT see a month's closing while the admin is still uploading/validating
-- sheets for it. A (line, period) becomes visible in the EMPLOYEE PORTAL only
-- after an admin explicitly PUBLISHES it here.
--
-- This is a pure VISIBILITY GATE — no numbers are snapshotted. The portal reads
-- the same live aggregates for a published (line, period); since the month is
-- closed once published, the figures are stable. Unpublishing hides it again.
--
-- RLS: enabled, NO public policies. All access is server-side via the service
-- role (getSupabaseAdmin), gated by the application `sales` permission in the
-- route handlers — mirroring the source_of_sales_* posture.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.monthly_closing_publications (
  id uuid primary key default gen_random_uuid(),
  -- Display line name as used by the closing matrix (e.g. "Pedia").
  line text not null,
  -- Lower-cased, whitespace-collapsed line key for stable matching.
  normalized_line text not null,
  -- The validated period in YYYY-MM form (matches source_of_sales_import_batches.period).
  period text not null,
  published_by text,
  published_at timestamptz not null default now(),
  unique (normalized_line, period)
);

create index if not exists monthly_closing_publications_period_idx
  on public.monthly_closing_publications (period);

alter table public.monthly_closing_publications enable row level security;
