---
name: a-landed-import-book-can-vanish-with-no-audit-trail
description: "A validated source-of-sales import batch can be deleted minutes after it lands and NOTHING records it — September's EPDA-BULK book (52 rows, 9,723 units, 1,082,980.26 EGP) existed at 19:40:22 Cairo and was absent at 19:47 with 0 rows and no row in sales_audit_logs or system_audit_logs, so a coverage read is a point-in-time fact, never a standing one."
metadata:
  node_type: memory
  type: project
---

Measured 9 October 2026. A watcher reading `source_of_sales_import_batches` every five minutes
reported `LANDED EP-BK (EPDA-BULK) | ساتو قطاع الجملة.xlsx | status=validated | rows=52 |
units=9,723 | value=1,082,980.26 EGP | created=19:40:22 Cairo | batch=c3e732e2-46db-4c57-a047-3e4750c9a0af`.
Seven minutes later that batch id was **absent** from the table, `source_of_sales_import_rows` held
**0 rows** for it, and neither `sales_audit_logs` nor `system_audit_logs` had a single entry in the
preceding 90 minutes. The 52 rows are unrecoverable from the database — only the sheet or a
re-upload has them. A peer session named *EP-BULK sheet unit validation discrepancy* had opened
eight minutes earlier, so the cause was the owner pulling the book over a unit discrepancy, not a
fault; it was EPDA-BULK's first standalone book since June
([[epda-bulk-merged-into-epda-pharmacies-from-july-2026]]).

**It happened TWICE in half an hour, and the replacement was different.** EPDA-Pharmacies landed
at 19:38:20 Cairo (1,387 rows, 4,584 units, 944,194.05 EGP), was read twice while alive, and by
20:02 its batch row and all 1,387 staged rows were gone the same way — 2026-09 went from 15 batches
to 14 with that one removed. EPDA-BULK meanwhile came BACK at 20:02:20 as a new batch id with a
**bigger** book: 73 rows, 11,398 units, 1,158,293.25 EGP against the withdrawn 52 rows, 9,723 units,
1,082,980.26 EGP — +21 rows, +1,675 units, +75,312.99 EGP, the owner having fixed the sheet rather
than dropped it. So a withdrawal is not a retraction: the same distributor's book can return with
different numbers under a new id, and only a snapshot taken while a batch was alive lets the two be
compared at all. The first book's 52 rows are unrecoverable.

**Why it matters.** A month-coverage answer ("four books outstanding", "EP-BK is in") is true only
at the instant it was read. Quoting one minutes later can report a book the owner has already
withdrawn, and a rebuild or publication keyed to "the books are in" can freeze a net over a book
that no longer exists — which is exactly the shape of
[[publishing-one-line-freezes-the-whole-periods-store-split-net]].

**How to apply.** Re-read presence immediately before quoting it, and print the Cairo read time
beside the count, not just the landing time. Watch by **batch id**, not by distributor code — a
re-upload gets a new id, so an id-keyed watcher reports the replacement as a fresh landing while a
code-keyed one stays silent. And when a batch's numbers matter, capture its per-product rows in the
same turn you see it: after a delete there is nothing left to query, and no audit row explains the
gap. Related: [[a-rule-script-run-in-the-primary-reads-its-stale-checked-out-code]],
[[a-closing-rule-that-moves-zero-may-simply-have-no-upload-yet]],
[[september-books-ownership-split-across-sessions]].
