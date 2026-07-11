-- Backfill the extended columns that sales_audit_logs has in production but were
-- never captured in a source-controlled migration. These are referenced by the
-- v_unified_audit_logs view (20260615090000_audit_view_security_invoker.sql) and
-- written by src/lib/sales/service.ts and src/lib/operations/events.ts.
-- All columns use ADD COLUMN IF NOT EXISTS so this is safe to run on production
-- where the columns already exist.

alter table public.sales_audit_logs
  add column if not exists batch_id uuid null,
  add column if not exists actor_username text null,
  add column if not exists actor_display_name text null,
  add column if not exists metadata jsonb null default '{}'::jsonb,
  add column if not exists line text null,
  add column if not exists period text null;
