-- ─────────────────────────────────────────────────────────────────────────────
-- marketing_requests: add a real "cancelled" terminal status.
--
-- WHY THIS EXISTS
--
-- The owner needed to cancel an approved, finance-executed marketing request
-- (MKT-REQ-20260825-AADD59CE) on 2026-09-22. The status column only accepted the
-- fixed set draft / pending_validation / pending_approval / returned / rejected /
-- approved / active / roi_tracking / closed / finance_hold / archived, so "cancelled"
-- could not be stored at all — the request was parked in `archived` as a stand-in.
--
-- This adds `cancelled` as a genuine terminal state, distinct from:
--   * rejected  — turned down DURING the approval chain;
--   * closed    — ran its full ROI life;
--   * archived  — filed away after the ROI window, whatever the prior outcome.
-- `cancelled` means an approved/active request that was deliberately called off.
--
-- Like `rejected` and `archived`, a cancelled request is NOT one of
-- `approvedMarketingRequestStatuses`, so it never counts as committed spend on any
-- ROI or finance surface. It IS a finished decision, so it appears in the approver
-- history. The application layer (types, labels, lifecycle prose, history outcome)
-- is updated in the same change.
--
-- Schema-only and non-destructive: it merely widens the allowed set. No existing row
-- is touched here.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.marketing_requests
  drop constraint if exists marketing_requests_status_check;

alter table public.marketing_requests
  add constraint marketing_requests_status_check
  check (
    status = any (
      array[
        'draft',
        'pending_validation',
        'pending_approval',
        'returned',
        'rejected',
        'approved',
        'active',
        'roi_tracking',
        'closed',
        'finance_hold',
        'archived',
        'cancelled'
      ]::text[]
    )
  );
