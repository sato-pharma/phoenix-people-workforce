---
name: epda-october-2026-new-layout-and-new-customer-codes
description: "EPDA's October 2026 books arrived in a new 16-column layout with every customer renumbered and no formula from old code to new. Read as EPDA Bulk 2 and EPDA Pharmacies 2, filed under EPDA-BULK and EPDA-Pharmacies; 405 of 620 codes added to the map on 4 Nov 2026."
metadata:
  node_type: memory
  type: project
  originSessionId: 69ab51c2-70e7-43d8-9d3b-bd311e52edf6
  modified: 2026-11-04T03:10:04.688Z
---

EPDA's October 2026 files (`بيع عملاء ساتو فارم جملة` and `... صيدليات`, audited 4 Nov 2026) differ from every earlier book:

- **Layout:** `BranchID, branchName, Transdate, TerritoryName, AccountSerial, AccountName, Address, ProductSerial, ProductName, SalesOrReturnQty, SalesOrReturnBonus, TrxNumber, UnitSalesPrice, LineValue, Distributor`, plus a title column with a blank header. These are the columns of the separate live source `EP` ("epda"), so no header tells the three books apart; picking "epda" for these files would file the sales under the wrong source.
- **Templates:** owner, 4 Nov: "call this epda pharmacies 2 and epda bulk 2 if i used normal templete or this temeplete in either way sales disrb is ebda pharmacies or bulk". The old `EP-BK` and `EP-PHS` profiles stay; the sheet's columns choose the layout.
- **Bonus is now a QUANTITY beside the paid units on the same row**, where the old `is_bonus` was a 0/1 flag that skipped the row. Pointing the old bonus setting at the new column would drop paid units on 41 lines.
- **Customer codes:** 0 of 620 were on `source_of_sales_customer_map`, 0 appear in September. There is no formula: 161844 became 1161844 but 162989 became 1163004. Fuzzy name matches pointed at the wrong shop (احمد عيد to احمد العزبى), so do not use them.
- **Added to production 4 Nov:** 405 map rows, source `epda-2026-10-renumber-exact-name`, confidence 90 (21 bulk, 384 pharmacy): exact name, one brick, same book, and not contradicted by the territory. Serials `18813002` Saginko and `18781583` Royafloxacin. The pharmacy file itself holds neither (checked in the raw file, 4 Nov).
- **TerritoryName places most of the rest by itself**, because a territory brick alias comes before the map in `resolveBrick`. `القاهرة` and `المريوطية` have no alias.
- **Owner's rulings, 4 Nov, confidence 100:** يارو to ترعة المريوطية, المستقبل to مدينة السلام, برايفت ميديكال to مدينة نصر. **He keeps the 13 unplaced pharmacies for the upload screen by his own choice ("I'll pick on upload")**, so do not map them for him; an unplaced customer blocks the whole file until then.
- **Returns are in the file** at scale: 8,394,034.77 on wholesale, where September carried none, so the validator's returns warning fires.

**Why:** a session seeing a 100% new-code month or the detector naming "epda" should know this is a vendor change, not a mapping regression.

**How to apply:** check whether later EPDA months keep this layout and numbering before assuming either way. Related: [[sato-sector-distributors-ep-bk-ep-phs]].

**State, 4 Nov 02:11 Cairo:** PR 79 merged as `b985b1310d97` but is NOT live: the GitHub account was suspended before `release-gate` recorded it (see [[github-account-suspended-2026-11-02]]). The production map rows and product codes are live; the old version still refuses the new headers, so the October books wait.

**Bonus deduction, live 4 Nov 05:09 Cairo:** Omar-3-xx PR 8 merged as `7376aefe7`: from October, EPDA-BULK and EPDA-Pharmacies store Ivyronc at 70%, Royafloxacin and Saginko at 85%, when the rows are stored. A book uploaded before that revision has no deduction and must be re-uploaded; none existed at 05:09. Inside the closing, the city split still gives fractions of a unit between areas for Royafloxacin and Saginko wholesalers, as it does for every distributor, and `formatUnits` shows them whole. Rule: `.claude/rules/sales-imports.md`.

**Live, read 4 Nov 03:58 Cairo, superseding the state above:** Omar-3-xx/phoenix-people-workforce PR 7 merged as `807ed1a4e052`; healthz serves it, readyz 200, gate row recorded 03:57, website and worker SUCCESS. Screens not viewed in a browser. The books are not uploaded and October is not published.

**Upload screen, PR 10 (Omar-3-xx), merged 4 Nov 05:32 Cairo as `fdb5f05d2`:** "Actual and reduced" table on Validate and after Confirm. Trial on his real files, read only: Bulk Ivyronc 4,557 to 3,190, Saginko 3,528 to 3,002, Royafloxacin 3,470 to 2,952; Pharmacies Ivyronc 302 to 212. The table has not yet been seen in a browser.
