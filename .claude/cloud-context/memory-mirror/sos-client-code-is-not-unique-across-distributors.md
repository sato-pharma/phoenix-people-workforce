---
name: sos-client-code-is-not-unique-across-distributors
description: "A Source-of-Sales client_code is only unique WITHIN a distributor — joining on it alone attributes one pharmacy's sales to another."
metadata: 
  node_type: memory
  type: reference
  originSessionId: d7876385-32d4-4aa5-880a-8afbb11a769b
  modified: 2026-08-03T17:14:24.861Z
---

`source_of_sales_import_rows.client_code` is the DISTRIBUTOR's own customer number. It is **not**
globally unique. Verified in production 2026-08-03: client code `124` belongs to
"عادل الجديدة - نجع النجار" at distributor **EG**, while `124` in `direct_order_pharmacy_distributor_codes`
belongs to a completely different pharmacy, "اسماء الجديدة".

**Always match on `(distributor_code, client_code)` together.** A code-only join silently
attributes a stranger's sales to the pharmacy on screen — and the screen in question is where a CEO
approves money. `loadPharmacyRetailHistory` in `src/lib/direct-orders/service.ts` does this
correctly; copy that shape.

**The `Direct` distributor carries NO client codes at all.** All 683 of its rows have
`client_code` null, so a pharmacy registered against `Direct` can never be matched to retail sales.
That is why the owner had `Direct (Company)` removed from the direct-order distributor picker
(`DIRECT_ORDER_EXCLUDED_DISTRIBUTOR_CODES`) — a pharmacy must be registered against the distributor
that actually supplies it for its retail history to resolve. Report "cannot be matched" rather than
rendering a misleading zero.

Related: `is_direct` on those rows flags exactly that same `Direct` batch set. Retail
(distributor-invoiced) and direct (Phoenix direct orders) are different channels and must never be
summed into one figure — see [[direct-order-sales-month-is-finance-owned]] for how direct sales get
their period.
