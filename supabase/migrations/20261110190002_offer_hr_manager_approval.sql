-- offer_hr_manager_approval
--
-- WHAT THIS CHANGES:
--   public.offers gains the status 'pending_approval' and seven approval columns:
--     approval_requested_at / approval_requested_by — when Talent Acquisition sent it for approval, and who
--     approved_at / approved_by                     — when the HR Manager approved it (the send), and who
--     approval_returned_at / approval_returned_by   — when the HR Manager rejected it back to draft, and who
--     approval_return_reason                        — his reason, shown to Talent Acquisition
--   The two status CHECKs are rewritten to admit the new status: `offers_status_known`, and
--   `offers_sent_at_present_when_sent`, which lets a pending offer (like a draft) carry no sent_at.
-- WHY:
--   Owner, 2026-11-10: "When the talent acquisition sends a job offer, it doesn't send automatic. It
--   comes to me, the HR manager, for my approval. If I approved, the email is pumped. If I reject or
--   leave it pending, it leaves as it is." Send by anybody without `offers:approve` now parks the
--   offer here; only the HR Manager's Approve and send puts it in the candidate's inbox.
-- ROLLBACK:
--   update public.offers set status = 'draft' where status = 'pending_approval';
--   then restore both CHECKs to their earlier lists ('draft','sent','accepted','declined','withdrawn'
--   and `status = 'draft' or sent_at is not null`) and drop the seven columns. Additive only: no
--   existing row changes, so nothing is lost by applying it.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.offers
  add column if not exists approval_requested_at timestamptz,
  add column if not exists approval_requested_by text,
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by text,
  add column if not exists approval_returned_at timestamptz,
  add column if not exists approval_returned_by text,
  add column if not exists approval_return_reason text;

alter table public.offers drop constraint if exists offers_status_known;
alter table public.offers
  add constraint offers_status_known
  check (status in ('draft', 'pending_approval', 'sent', 'accepted', 'declined', 'withdrawn'));

alter table public.offers drop constraint if exists offers_sent_at_present_when_sent;
alter table public.offers
  add constraint offers_sent_at_present_when_sent
  check (status in ('draft', 'pending_approval') or sent_at is not null);

-- The HR Manager's queue: few rows, read on every Offers page load and every bell count.
create index if not exists offers_pending_approval_idx
  on public.offers (approval_requested_at)
  where status = 'pending_approval';

commit;
