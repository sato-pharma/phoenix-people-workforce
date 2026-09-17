-- A person's Approve on Customer Pharmacy Mapping gets its own link status: `admin_approved`.
--
-- WHY. `approveCustomerPharmacyLink` (src/lib/customer-pharmacy-mapping/actions.ts) is the Approve
-- button on /admin/customer-pharmacy-mapping, which the Super Admin and the CEO can open. It moved a
-- pending link to `system_validated`, and only an `Approved…` line in validation_notes told the two
-- apart. AGENTS.md 4.1 fixes `system_validated` to mean NO HUMAN LOOKED: it is what
-- `resolveMarketingSystemValidationStatus` grants on a GPS fix plus a live photo. A human ruling was
-- being filed under the machine's label.
--
-- Owner decision 2026-09-17, asked in chat as multiple choice: a NEW status, not a reuse of
-- `sfe_validated`. `sfe_validated` is the desk status — every one of its 17 production links on
-- 2026-09-17 is a desk entry or a sibling that inherited a desk entry's status — so reusing it would
-- have mixed the two again.
--
-- SCOPE. Only `marketing_customer_pharmacies` can hold the new value. The same four-value check on
-- `marketing_customers` and `marketing_pharmacies` is deliberately left alone: the Approve button
-- decides a LINK, never a customer or a venue.
--
-- PRODUCTION DATA (2026-09-17): no row changes. The Approve button had written 0 links at the time
-- of writing (no `Approved: ` / `Approved by ` note stamp anywhere), so there is nothing to relabel.
-- Any approval made between this date and the deploy is found by that stamp and is left for the
-- owner to decide; this migration never rewrites validation_status.
--
-- ROLLBACK. Re-add the constraint without 'admin_approved'. That fails while any link holds the
-- value, which is the point: those are human rulings, and dropping the value would need a decision
-- about each of them first.

begin;

alter table public.marketing_customer_pharmacies
  drop constraint if exists marketing_customer_pharmacies_status_check;

alter table public.marketing_customer_pharmacies
  add constraint marketing_customer_pharmacies_status_check
  check (
    validation_status = any (
      array['pending', 'system_validated', 'sfe_validated', 'admin_approved', 'rejected']::text[]
    )
  );

comment on constraint marketing_customer_pharmacies_status_check on public.marketing_customer_pharmacies is
  'system_validated = evidence gate, no human looked. sfe_validated = desk entry. admin_approved = a person pressed Approve on Customer Pharmacy Mapping (owner decision 2026-09-17).';

commit;
