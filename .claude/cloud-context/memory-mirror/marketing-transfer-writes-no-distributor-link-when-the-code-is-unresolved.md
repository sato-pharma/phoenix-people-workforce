---
name: marketing-transfer-writes-no-distributor-link-when-the-code-is-unresolved
description: "Transferring a marketing customer to Direct Orders only writes the distributor link row when its code resolves in source_of_sales_customer_map — an unresolved code ships a pharmacy that is invisible under a distributor filter"
metadata:
  node_type: memory
  type: project
---

Shipped 2026-08-22 in **PR #2295** (`d0c58f75`), in
`src/lib/marketing-requests/validated-customer-transfer.ts`. The transfer creates the Direct Orders
pharmacy, then inserts the `direct_order_pharmacy_distributor_codes` link row **only if** the
marketing code resolves — it looks the `(distributor_code, customer_code)` pair up in
`source_of_sales_customer_map` and skips the insert when there is no hit. Placeholder codes
(`0000`, any single repeated character) are discarded before that lookup by `realDistributorValue`.

**Why the gap matters.** `phx_search_direct_order_customers` LEFT JOINs the link table but then
tests `c.distributor_code = p_distributor_code` in the WHERE, which collapses the left join to an
inner join the moment a distributor is passed. **No link row ⇒ the pharmacy vanishes from the
picker as soon as a rep selects that distributor.** That is the exact fault that made
`حضانه النيل` unfindable and took a whole evening to trace.

**So a transfer can succeed and still ship an invisible pharmacy**, silently — there is no warning,
no failed row, nothing in the ledger to say the link was skipped. Before transferring, check the
marketing code's `reference_status` / `master_match_kind`: only a code that resolves produces a link
row. See [[marketing-not-found-codes-have-three-root-causes]] for how to repair one that doesn't.

**What saves you today is that the order form passes no distributor at all** —
`direct-order-submit-form.tsx:900` renders `<PharmacyComboBox>` with no `distributorCode` prop, so
the rep's search is unfiltered and finds everything. The distributor-scoped path is the *new-pharmacy
registration* form's code picker (`distributor-customer-picker.tsx` →
`/api/direct-orders/customers` → `searchDistributorCustomers`, over
`source_of_sales_customer_map`), which is a **different lookup entirely** — do not confuse the two
when someone reports "I can't find the pharmacy". Ask which screen they are on first.

The manual registration path in `pharmacy-validation.ts:700-740` already wrote this link row
correctly and is the model the transfer now mirrors.
