-- Direct Orders — a pharmacy can be REJECTED (proven false), not merely unreviewed.
--
-- On 2026-08-05 the owner ruled that ten hand-created pharmacies (DOP-000001..010) were false. The
-- model had no word for that. `verification_status` permitted only 'verified' and 'pending_review',
-- so the only way to record the decision was to deactivate the rows and set them 'pending_review' —
-- which says "awaiting a look" about ten records that had already been looked at and refused.
--
-- That is the same class of defect this module has been correcting all week: the data stating
-- something other than what happened, in a direction that hides the finding. A refusal the schema
-- cannot express becomes, a month later, a refusal nobody can find.
--
-- REJECTING ALWAYS DEACTIVATES, and the constraint below enforces it rather than trusting callers.
-- `active = false` is what actually removes a pharmacy from the picker, the directory search and the
-- probation sweep — twelve query sites filter on it and none filter on verification_status. A
-- rejected-but-active row would therefore be a refusal the rest of the module quietly ignores.

begin;

alter table public.direct_order_pharmacies
  drop constraint if exists direct_order_pharmacies_verification_status_check;

alter table public.direct_order_pharmacies
  add constraint direct_order_pharmacies_verification_status_check
  check (verification_status = any (array['verified'::text, 'pending_review'::text, 'rejected'::text]));

-- Correct the ten records this state was invented for. They are already inactive; this makes the
-- permanent record say what was actually decided.
update public.direct_order_pharmacies
set verification_status = 'rejected',
    active = false,
    updated_at = now()
where phoenix_pharmacy_code between 'DOP-000001' and 'DOP-000010'
  and verification_status <> 'rejected';

-- The invariant, enforced by the database so no future code path can break it. Added AFTER the
-- backfill so the existing rows already satisfy it.
alter table public.direct_order_pharmacies
  drop constraint if exists direct_order_pharmacies_rejected_is_inactive;

alter table public.direct_order_pharmacies
  add constraint direct_order_pharmacies_rejected_is_inactive
  check (verification_status <> 'rejected' or active = false);

commit;
