-- add_share_link_refusal_counters
--
-- WHAT THIS CHANGES:
--   Adds two columns to each of the three share-link tables — `refused_count integer not null
--   default 0` and `last_refused_at timestamptz` — plus one partial index per table over
--   `last_refused_at` for rows that have actually been refused.
--
--   Tables: public.direct_order_report_share_links
--           public.marketing_request_report_share_links
--           public.ats_cv_lifecycle_share_links
--
-- WHY:
--   A refused feed read currently leaves no trace this application can see. The route answers 403
--   and returns; the only record is Railway's HTTP log, which the app cannot read and which keeps
--   barely a quarter of an hour of lines for the current deployment. So a copy of the owner's
--   Direct Orders Google Sheet polled a token that was revoked on 2026-08-05 once a minute for 59
--   days — about 84,500 refusals — and nothing anywhere said a word. It was found by accident a
--   month in, while reading logs after an unrelated deploy. These two columns are what
--   `src/lib/share-links/dead-token-polling.ts` judges, so the owner is told the next day instead.
--
--   `not null default 0` on an existing table is metadata-only on PostgreSQL 11+ — no table
--   rewrite, no lock held while rows are touched. The three tables hold tens of rows anyway.
--
-- ROLLBACK:
--   drop index if exists public.direct_order_report_share_links_last_refused_idx;
--   drop index if exists public.marketing_request_report_share_links_last_refused_idx;
--   drop index if exists public.ats_cv_lifecycle_share_links_last_refused_idx;
--   alter table public.direct_order_report_share_links
--     drop column if exists refused_count, drop column if exists last_refused_at;
--   alter table public.marketing_request_report_share_links
--     drop column if exists refused_count, drop column if exists last_refused_at;
--   alter table public.ats_cv_lifecycle_share_links
--     drop column if exists refused_count, drop column if exists last_refused_at;
--   Fully reversible — this adds columns and indexes and reads nothing. Note the standing rule
--   that dropping a column the shipped code still names is TWO deploys, never one.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: it is additive DDL on three small tables and writes no rows.
--
-- NO GRANT AND NO RLS CHANGE, deliberately. These tables are reached only through the
-- service-role client (the feed routes are unauthenticated and resolve the link server-side), so
-- the new columns inherit exactly the access the rest of each row already has. Granting anything
-- to anon or authenticated here would widen a table that holds bearer tokens.

begin;

alter table public.direct_order_report_share_links
  add column if not exists refused_count integer not null default 0,
  add column if not exists last_refused_at timestamptz;

alter table public.marketing_request_report_share_links
  add column if not exists refused_count integer not null default 0,
  add column if not exists last_refused_at timestamptz;

alter table public.ats_cv_lifecycle_share_links
  add column if not exists refused_count integer not null default 0,
  add column if not exists last_refused_at timestamptz;

comment on column public.direct_order_report_share_links.refused_count is
  'Reads refused because this link is revoked or expired. Counted only for an existing row, so an unauthenticated caller cannot drive the write path. Never reset — the 24h window on last_refused_at is what makes the alert stop.';
comment on column public.direct_order_report_share_links.last_refused_at is
  'When a dead-link read was last refused. Judged by src/lib/share-links/dead-token-polling.ts.';
comment on column public.marketing_request_report_share_links.refused_count is
  'Reads refused because this link is revoked or expired. See the direct-order column of the same name.';
comment on column public.marketing_request_report_share_links.last_refused_at is
  'When a dead-link read was last refused. Judged by src/lib/share-links/dead-token-polling.ts.';
comment on column public.ats_cv_lifecycle_share_links.refused_count is
  'Reads refused because this link is revoked or expired. See the direct-order column of the same name.';
comment on column public.ats_cv_lifecycle_share_links.last_refused_at is
  'When a dead-link read was last refused. Judged by src/lib/share-links/dead-token-polling.ts.';

-- The sweep asks exactly one question of each table — "which links were refused since <24h ago>?"
-- — so the index is partial on the column being filtered. Partial rather than plain because all
-- but a handful of rows will never hold a value here: a healthy system refuses nothing.
create index if not exists direct_order_report_share_links_last_refused_idx
  on public.direct_order_report_share_links (last_refused_at desc)
  where last_refused_at is not null;

create index if not exists marketing_request_report_share_links_last_refused_idx
  on public.marketing_request_report_share_links (last_refused_at desc)
  where last_refused_at is not null;

create index if not exists ats_cv_lifecycle_share_links_last_refused_idx
  on public.ats_cv_lifecycle_share_links (last_refused_at desc)
  where last_refused_at is not null;

commit;
