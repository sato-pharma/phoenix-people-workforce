---
name: a-closing-rule-that-moves-zero-may-simply-have-no-upload-yet
description: Before calling a newly shipped allocation rule dormant, broken or "correctly absent", list that period's import batches against the previous month — Pedia September 2026 was still missing six distributor books, the whole EPDA family among them, so the EPDA-BULK spread had nothing to act on.
metadata:
  type: project
---

Measured on production, 2026-10-09 16:50 Cairo, hours after the EPDA-BULK contribution rule shipped
in PR 5662. `buildBulkAllocation` on the live Pedia 2026-09 closing details (1,785 rows) returns
**0 bulk rows, 0 movements, 0.00 EGP**, and `source_of_sales_distributor_product_rollup` holds no
`EP-BK` row at or after 2026-07. Read alone, that looks like the rule is inert and like
[[epda-bulk-merged-into-epda-pharmacies-from-july-2026]] settles it.

**It does not.** September 2026 is **mid-upload**. Thirteen books are in, five that August had are
still missing — **Marcyrl (the Office channel), epda, EPDA-Pharmacies, Ibn sina and mec** — and nine of the thirteen landed that same afternoon between 16:17 and 16:46 Cairo,
one of them while this very check was running. So **no EPDA book of any kind has reached September
yet**, the bulk rule has no input rather than no effect, and whether the sector returns as its own
`EP-BK` file (his 2026-10-09 ruling) or merged into قطاع الصيدليات (the July-onward measurement)
cannot be answered from this month until those books land. The Office spread is equally unanswerable
on Pedia-adjacent lines while Marcyrl is absent.

**Why:** a zero from an allocation rule and a zero from a missing upload are the same number, and the
first reads as a defect worth "fixing". Six missing books also mean any Pedia September figure on
screen is a partial month, not a result.

**How to apply:** `select distinct distributor_code from public.source_of_sales_import_batches where
period = '<period>'` against the previous period, resolving codes through
`source_of_sales_distributors.distributor_name`, BEFORE judging a rule or quoting a number. The
batch table also dates each upload, which is what separates "not yet sent" from "sent and
mis-handled". `tests/closing-bulk-allocation.test.ts` pins the arithmetic, so a green suite plus a
0.00 EGP production reading is consistent with a correct rule waiting for its file.

**Corrected 2026-10-09:** Direct was listed here as a sixth missing book by comparing raw codes; `DirectReq` had landed 2026-10-05 and the repo folds the two vintages onto one channel — [[direct-company-is-never-a-coverage-hole]].
