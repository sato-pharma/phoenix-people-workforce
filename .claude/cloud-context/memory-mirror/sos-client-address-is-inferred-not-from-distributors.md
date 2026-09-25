---
name: sos-client-address-is-inferred-not-from-distributors
description: "SoS distributor files carry NO customer address — client_address was null on 100% of rows; what is there now was inferred from pharmacy references and is marked client_address_source"
metadata: 
  node_type: memory
  type: project
  originSessionId: 1bb25907-4e90-41b6-a7c9-047b4129f1e4
  modified: 2026-08-05T16:46:56.648Z
---

Diagnosed and backfilled 2026-08-05. The owner reported "the customer address is still downloaded
empty" on the Monthly Closing **Data** tab.

## The finding

`client_address` was **null on 100% of rows** — 294,445 `source_of_sales_import_rows` and 198,029
`source_of_sales_customer_directory_rollup`, across all 15 distributors. Not a report bug:
`clientName` and `clientCode` are pulled by identical code one line apart in
`src/lib/sales/normalizer/engine.ts` and are 100% populated. **The distributor files simply do not
contain an address column**, and the profile guesses (`Address_En`, `ADDRESSSHIP`,
`CUSTOMER_ADDRESS`, `Address`) match nothing.

## What is in there now — and it is INFERRED

Backfilled from `marketing_pharmacy_code_references.raw_pharmacy_address` (19,376 addresses),
matched on pharmacy code = client code. Safe because across 11 contributing distributors, **0 codes
are shared between distributors and 0 codes carry conflicting addresses**.

- `source_of_sales_import_rows`: 202,007 rows / 18,986 customers
- `source_of_sales_customer_directory_rollup`: 131,932 rows / same 18,986 customers, 0 disagreements
- ~31% of rows still blank — no reference address exists for those customers

**`source_of_sales_import_rows.client_address_source` is the provenance flag.** NULL = came from the
distributor. `'marketing_pharmacy_reference'` = inferred. It is also the undo key:
`update source_of_sales_import_rows set client_address=null, client_address_source=null where client_address_source='marketing_pharmacy_reference';`
The rollup has no such column by design — it is derived, and its refresh RPC copies `client_address`
straight from the import rows, so a re-import reproduces the value rather than reverting it.

**How to apply:** never describe SoS Client Address as distributor-supplied — for ~19k customers it
is a code match. If asked to "fix the address properly", the real fix is still open and needs a
distributor file (**PS** covers 216k of 294k rows) to read its true header names.

## Two traps found alongside

- **`raw_row` is an empty `{}` on 282,215 of 294,445 import rows.** It is supposed to preserve the
  source row, so there is currently no audit trail of what columns a distributor file actually had —
  which is why the header names could not be recovered from the database.
- **~4,977 of the reference addresses are truncated at exactly 30 characters** (hard spike in the
  length distribution, smooth decay below). Pre-existing in the reference import, not introduced by
  the backfill, but it means about a quarter of what now shows is a partial address — against the
  owner's standing no-truncation rule.

Related: [[sos-always-todays-geography-rule]], [[closing-uses-total-qty-not-effective-units]].
