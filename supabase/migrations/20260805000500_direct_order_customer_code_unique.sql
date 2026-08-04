-- One distributor customer code belongs to ONE pharmacy.
--
-- Found by the automated review on PR #1738: `ensureDirectOrderPharmacyFromDirectory` checks for
-- an existing pharmacy and then inserts, and those two statements are not atomic. Two reps
-- submitting an order for the same directory customer at the same moment both see "no pharmacy
-- yet" and both insert — producing exactly the duplicate pharmacy records this module exists to
-- eliminate. The existing UNIQUE (pharmacy_id, distributor_code) does not prevent it: that stops
-- ONE pharmacy holding two codes at a distributor, not TWO pharmacies claiming the same code.
--
-- The database is the only place this can be enforced reliably, because the race is between two
-- connections. With the index in place the loser's insert raises 23505, and the service catches it
-- and re-reads the winner's row (see ensureDirectOrderPharmacyFromDirectory).
--
-- Verified before applying: zero existing (distributor_code, customer_code) duplicates in
-- production, so this cannot fail on live data.
create unique index if not exists direct_order_pharmacy_distributor_codes_code_unique
  on public.direct_order_pharmacy_distributor_codes (distributor_code, customer_code);

comment on index public.direct_order_pharmacy_distributor_codes_code_unique is
  'A distributor customer code identifies one customer, so it may map to only one Phoenix '
  'pharmacy. Also serves as the concurrency guard for ensureDirectOrderPharmacyFromDirectory.';
