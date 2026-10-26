---
name: pharmacy-database-sync-runs-only-by-hand
description: phx_sync_sales_pharmacy_codes_into_marketing() is never called by the app; the pharmacy database only catches up with the customer map when a session runs it
metadata:
  node_type: memory
  type: project
  originSessionId: 67f15b49-6120-498b-a4bb-a6cae3f7ce6d
  modified: 2026-10-26T15:11:49.947Z
---

`public.phx_sync_sales_pharmacy_codes_into_marketing()` copies every active Source-of-Sales customer-map code into
`marketing_pharmacy_code_references` (`source_file='source_of_sales_customer_map'`). Nothing in `src/` calls it, so
the pharmacy database falls behind the map until a session runs it by hand.

- Run of 2026-08-19 21:43 Cairo: batch `a281791c-…`, 5,518 rows.
- Run of 2026-10-26 18:07 Cairo, made after the Ibn Sina file import: batch `c84d9ccc-6dc5-498d-b438-30b1ac2d413c`, 30,779 rows. That was two months of backlog across every distributor: Ibn Sina 15,041, Overseas 11,954, EGD 1,650, MEC 998, Ramco 773 and the rest. To reverse it, delete by `import_batch_id`.

**Why:** a single "update the pharmacy database" request pulls in ALL map growth since the last run, not only
the file in hand. Report that scope.
**How to apply:** before the run, count candidates not yet synced, then report `references_synced` by distributor. Related:
[[sos-monthly-closing-is-the-only-sales-truth]].
