---
name: july-anti-infective-reunion-split-exception
description: "JULY 2026 / ANTI-INFECTIVE ONLY — client 441164 ريونيون is deliberately split 50/50 across D22 and D26 while its brick and customer_map still say D21; do not \"fix\" the mismatch"
metadata: 
  node_type: memory
  type: project
  originSessionId: fdc8c238-3c90-4c5c-806a-c59514e3414d
  modified: 2026-08-06T20:52:02.233Z
---

Owner ruling, 2026-08-06. Client **441164 ريونيون للتجارةوالاستثمار** (distributor IS-S) returned its
entire June purchase in July: **−400 units / −EGP 34,380.00** across RO001 and SA001. The owner ruled
that return is split **evenly between Dakahlia 2 (D22) and Port Said – Domiat (D26)**, and Dakahlia 1
(D21) — where it actually sat — keeps none of it.

Applied as a row-level split in batch `332747f9` (rows 918, 722 → D22 halves; new rows 953, 954 →
D26 halves), each −100 u. Backup: `public.zz_backup_sos_july_reunion_20260806`.

**Why it looks wrong but is right:** the split rows still carry `brick_id = 'B186-1'`, and
`source_of_sales_customer_map` still maps 441164 → D21. Both are deliberate. `customer_map` is **not
period-scoped**, so re-pointing it would move June's +34,380 too and break "July only". The brick is
the customer's real location; only the area credit is the exception.

**How to apply:** never "reconcile" these rows back to D21, and never re-point customer_map to fix
the mismatch. The exception is July 2026 + Anti-Infective + this one client. It is stamped in each
row's `raw_row.split_exception`. **Verified live 2026-08-06 19:2x: matrix AND drill-down now agree.**
`phx_closing_customers` was rewritten (it now groups by the fact region/area/brick and takes
`coalesce(a.fact_area, cm.area_code)` — fact FIRST), so it returns D22 −200/−17,190 and D26
−200/−17,190, not the old whole −34,380 under D21. The drill-down discrepancy this note previously
warned about is CLOSED; do not go looking for it. See
[[july-direct-overlay-and-rollup-must-move-together]] for the same month's separate direct
restatement.

**The EXPORT was still wrong after all that, and for a third reason.** PR #1861 added a store-split
exemption for hand-split customers but keyed it on `ClosingDetailRow.areaCode` — the BRICK's area,
which is D21 for all four rows — so it never fired and the workbook re-split the return across
Dakahlia 1/2/3 while the screen stayed right. Fixed 2026-08-06 by reading `sheetAreaCode` (the fact
area) first, in both the exemption and the export's place narrowing. See
[[closing-detail-areacode-is-brick-not-fact-area]] — that is the reusable lesson, not this client.
