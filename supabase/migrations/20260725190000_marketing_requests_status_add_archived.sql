-- Add an `archived` status to marketing_requests so stale requests whose ROI window has
-- already closed can be moved out of the active/actionable set without deleting history.
-- Owner-approved: will archive requests whose computed ROI-window-end falls before
-- 2026-07-01 (44 approved / 32 pending_approval / 5 rejected as of 2026-07-25) -- see the
-- separate, later bulk UPDATE for the actual data change. This migration ONLY widens the
-- CHECK constraint; it touches zero rows.
--
-- Deliberately NOT reusing `closed`: `closed` is one of the values in
-- approvedMarketingRequestStatuses (src/lib/marketing-requests/service.ts), which feeds
-- "approved" dashboard/finance totals (home-snapshot.ts, and per-request counts in
-- service.ts). Folding previously-rejected/pending_approval rows into `closed` would
-- inflate those figures. `archived` is a new, distinct terminal state and is intentionally
-- excluded from approvedMarketingRequestStatuses.
begin;

alter table public.marketing_requests
  drop constraint marketing_requests_status_check;

alter table public.marketing_requests
  add constraint marketing_requests_status_check
  check (status = any (array[
    'draft'::text,
    'pending_validation'::text,
    'pending_approval'::text,
    'returned'::text,
    'rejected'::text,
    'approved'::text,
    'active'::text,
    'roi_tracking'::text,
    'closed'::text,
    'finance_hold'::text,
    'archived'::text
  ]));

commit;
