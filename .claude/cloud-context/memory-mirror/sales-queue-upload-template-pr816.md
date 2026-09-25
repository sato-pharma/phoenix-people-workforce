---
name: sales-queue-upload-template-pr816
description: "Sales Queue (/sales/queue) is a separate module from SoS and Weekly Sales; its manager-linkage was already fixed in PR"
metadata: 
  node_type: memory
  type: project
  originSessionId: ba4bc4c4-86c9-49c8-a3dd-d627cb69b215
---

Owner asked (2026-07-04/05) to fix "sales aren't 100% accurate per employee" on
`/sales/queue` after cross-checking against a real incentive spreadsheet
(`Pedia 1___5.xlsx`, Sales Ops' 2026 incentive tracker for the Pedia line).
Owner was explicit and repeated multiple times: **Sales Queue, Source of Sales
(SoS), and Weekly Sales are three separate modules — never mix their logic,
tables, or templates.** Sales Queue = `src/lib/sales/service.ts` +
`sales_records`/`sales_import_batches`, monthly closing-sheet cadence. SoS =
`source_of_sales_*` tables, `/sales/import`. Weekly Sales = its own tables.
`sales_manager_region_scope` migration explicitly serves both weekly AND
monthly (Sales Queue) scope, so it's legitimately shared — but nothing else is.

**Root cause was NOT a code bug** — it was a stale upload. The `Pedia
1___5.xlsx` batch was uploaded 2026-06-21, four days *before* two fixes
landed: `a037ceec` "persist manager linkage for flat sheets" (#522) and
`738cb42a` "reject placeholder manager ids" (#526), both 2026-06-25. Confirmed
via a later batch (`Ant Inf 1_5.xlsx`, uploaded 2026-06-25) which already has
735/875 rows with `manager_hr_id` populated including unlinked-employee rows.
Verified the CURRENT pipeline live (via `parseSalesUpload`/`linkSalesRecords`,
zero DB writes) already implements exactly the owner's rule: a vacant area
(blank `HR_ID`) still gets its real `Manager HR_ID` from the sheet and rolls
into that DSM's total, without a named rep row — this is what
[[dsms-performance-hyphen-stripped-hrid-bug]]'s sibling investigation needed
but for a different module.

**Delivered in [PR #816](https://github.com/Phoenix-HR/phoenix-people-workforce/pull/816):**
`src/lib/sales/queue-template.ts` (new) generates a downloadable `.xlsx`
template via `GET /api/sales/queue/template`, linked from `/sales/queue`.
Headers exactly match the flat-sheet schema `extractFlatSheetRows`/
`detectSchemaType` require (`D.M.`, `Sys`, `HR_ID`, `Manager HR_ID`, `Line
Manager HR_ID`, `Line`, `Type of Sales`, `Family`, `PRODUCT`, `Factory Price`,
`Month`, `Year`, `Sales Units`, `Sales Value`, `Target Units`, `Target
Value`).

**Two self-inflicted bugs caught before shipping, both from the same
lesson — the schema detector does EXACT string matching:**
1. Header cells read `"HR_ID *"` / `"Manager HR_ID *"` (added a visual
   required-marker) — `detectSchemaType` checks `headers.includes("HR_ID")`
   exactly, so the decorated header would have made my own template
   unrecognized as `flat_sheet`. Fix: keep headers exact, put "required" in
   the note text instead.
2. Put column-guidance text in row 2 of the data sheet — but
   `extractFlatSheetRows` starts reading DATA at row 2 with no notes-row
   concept (its only skip rule is empty/"Grand Total"), so that note row
   would itself be parsed as a bogus failing sales row. Fix: move all
   guidance to a separate "Read Me" sheet; data sheet is header row + real
   sample rows only, matching the real working file's actual structure.

**How to apply:** any future template/import-format work in this codebase —
verify the EXACT header strings the parser's `detectSchemaType`/column-alias
list expects (`src/lib/sales/validation.ts` for Sales Queue), and don't add
any non-data row after the header unless the specific extractor function is
confirmed to skip it. Don't assume a stale/broken-looking upload reflects a
current code bug — check the batch's `created_at` against recent fix commits
first (`git log --follow -- <file>`) before redesigning.

**Also hit:** a repo-wide test (`tests/access-registry-coverage.test.ts`)
requires every route matching `/(export|download|template)(\/|$)/` to have
`audit: { required: true }` in `src/lib/security/access-registry.ts` — any
new template/export/download route needs a registry entry or `npm test`
fails on `access registry coverage`.

**CONFIRMED end-to-end in production 2026-07-04/05.** Owner re-uploaded the
real Pedia dataset through the new template on live `/sales/queue`
(batch `89fac0fb...`, `sales-queue-upload-template.xlsx`, uploaded by
`phx-1`). Recomputed the org's "Regional Sales Manager" layer discovered
along the way — PD-0001 (Hany Saad Mohamed Omar, job_title "Regional Sales
Manager", reports to A-12) sits between the NSM and 3 DSMs, owning SoS
regions AB/D1/D2 per `sales_manager_region_scope` → DSMs B-74 (Abdallah/AB),
B-154 (Nermeen/D1), B-5 (Hekal/D2). Grand total for his 3 regions (named
reps + vacant areas, via `manager_hr_id in ('B-74','B-154','B-5')`): **EGP
5,072,878.82 sales / EGP 8,354,954.18 target, 60.7%** — owner confirmed
"exactly" matches their own trusted source for the AB and D2 rows
individually (1,837,409.73/3,156,286.60 and 1,613,756.49/3,020,233.84),
proving the vacant-area manager-linkage fix (#522/#526) now correctly rolls
territories like Alex Center 1 and Sharkia 1/2/3 into their DSM's total on a
fresh upload. A cosmetic "Not Linked (1): expected NSM, found Regional Sales
Manager" validation warning for PD-0001 appears in the upload UI but doesn't
affect any stored row or total — PD-0001 never appears as `employee_hr_id`/
`manager_hr_id` in the batch; the warning is a separate NSM-role-check,
not investigated further since it doesn't block or distort figures.
