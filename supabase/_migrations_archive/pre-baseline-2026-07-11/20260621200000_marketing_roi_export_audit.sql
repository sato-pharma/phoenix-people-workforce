-- Marketing ROI export audit (append-only, server-insert-only). One row per generated
-- XLSX export, capturing who/when/what + whether confidential products were included
-- (the compliance proof that a CEO/Super Admin opted in to a restricted export).
--
-- Server-only: the app uses the service-role client (bypasses RLS) and enforces scope in
-- the service layer; RLS is enabled with an explicit deny-all policy as defense-in-depth so
-- the anon/authenticated client can never read or write it (matches sos_import_coverage_snapshots).
--
-- APPROVAL-GATED — NOT YET APPLIED: stage to staging, verify, then apply to production with
-- explicit per-migration approval.

create table if not exists public.marketing_roi_export_audit (
  id uuid primary key default gen_random_uuid(),
  exported_by_hr_id text not null references public.employees(hr_id) on update cascade,
  role text not null,
  exported_at timestamptz not null default now(),
  kind text not null check (kind in ('report', 'request')),
  request_id uuid null references public.marketing_requests(id) on update cascade on delete set null,
  filter_json jsonb not null default '{}'::jsonb,
  row_count integer not null default 0 check (row_count >= 0),
  included_restricted boolean not null default false,
  sheets jsonb not null default '[]'::jsonb,
  sales_data_as_of text null
);

create index if not exists marketing_roi_export_audit_actor_idx
  on public.marketing_roi_export_audit (exported_by_hr_id, exported_at desc);
create index if not exists marketing_roi_export_audit_request_idx
  on public.marketing_roi_export_audit (request_id);

alter table public.marketing_roi_export_audit enable row level security;
drop policy if exists marketing_roi_export_audit_no_direct_access on public.marketing_roi_export_audit;
create policy marketing_roi_export_audit_no_direct_access
  on public.marketing_roi_export_audit for all using (false) with check (false);

grant all on table public.marketing_roi_export_audit to service_role;

notify pgrst, 'reload schema';
