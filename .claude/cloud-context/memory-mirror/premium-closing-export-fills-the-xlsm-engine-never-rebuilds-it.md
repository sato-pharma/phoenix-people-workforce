---
name: premium-closing-export-fills-the-xlsm-engine-never-rebuilds-it
description: "The premium closing export must FILL the .xlsm engine's Data tables inside the zip - never rebuild the sheets server-side, and never round-trip the workbook through ExcelJS"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5344b79a-0aa0-46cd-ae76-929339b93a87
  modified: 2026-08-30T21:12:28.979Z
---

**The premium Monthly Closing workbook is the owner's `.xlsm` engine, filled with fresh data — not a
workbook built from scratch that resembles it.**

**What the engine actually is** (measured 2026-08-31 on `xlsx/phoenix-closing-2026-07-CNS.xlsm`):

| Part | Detail |
| --- | --- |
| `Data` sheet | Excel Tables **`SalesData`** (14 cols: Region, Area, Area Code, Medical rep, District manager, Product, Units, Target Units, Targeted Units, Sales Value, Target Value, Targeted Sales, June Value, Status) and **`AreaBook`** (12 cols), plus the `PickList` range at `Data!$AC$1:$AC$50` |
| 3 pivot tables | `Matrix (Live) PT`, `Units Matrix PT`, `AreaProduct PT` — the cache reads `<worksheetSource name="SalesData"/>`, i.e. **by table name**, so they grow with the table on their own |
| 2 slicers | `Slicer_Region`, one slicer cache |
| `Rep Card` | **120 formulas** behind a "Pick a rep or an area" dropdown, INDEX/MATCH into `AreaBook` |
| VBA | `xl/vbaProject.bin` — the button bar; `PhxOnePage` / `PhxPrintArea` are its print names |

Every other sheet is static values: Overview, Rep Ranking, Top Achievers, Closing Matrix, Units
Matrix, Area x Product, Family Performance, Watch List, Top Customers (10,316 rows), Details (14,066
rows).

**Why this memory exists.** On 2026-08-30 a from-scratch ExcelJS module rebuilt nine of those sheets
as flat text and shipped it as the premium export. It looked close and was hollow: no Data, no
pivots, no slicers, no Rep Card, no Details, no buttons. The owner's reaction was
*"Where did the engine go? I want you to enhance the engine, not to remove it."*
The trigger for the mistake is worth naming, because it regenerates: ExcelJS genuinely **cannot
write pivot tables, slicers or VBA**, and that true limitation was accepted as a conclusion instead
of as a reason to stop rebuilding and start filling.

**How to apply.**

- **Fill, never rebuild.** Load the template `.xlsm` as a zip, rewrite the data-bearing sheet parts,
  update `xl/tables/table*.xml` `ref=`, the `_FilterDatabase` / print-area defined names and
  `PickList`, set `refreshOnLoad="1"` on `pivotCacheDefinition1`, and leave every other part
  byte-identical.
- 🔴 **Never load or save it through ExcelJS.** A round trip silently drops pivots, slicers, tables
  and VBA. Verified survivable by direct zip surgery 2026-08-31: 3 pivots, 2 slicers, 2 tables, 120
  Rep Card formulas and `vbaProject.bin` all intact after a rewrite.
- 🔴 **The template ships EMPTY.** Pre-filled with a real month, a filler that misses a sheet hands a
  reader another line's real numbers under the correct heading. Blank is recoverable; plausible and
  wrong is not.
- **Prefer `.xlsx` for anything sent to people.** Pivots, slicers, tables and the Rep Card dropdown
  all work without macros — only the buttons are VBA, and Excel does both of their jobs natively
  (File → Export → PDF, and the outline +/- controls). A macro-enabled attachment is frequently
  stripped by mail systems, and Mark-of-the-Web makes Excel refuse the macros outright for anyone who
  downloaded it. Keep `.xlsm` as the owner's own copy if he wants the buttons.
- **Check the Units Matrix pivot against the units rule** — a pivot that totals Units across product
  codes breaks [[units-of-different-products-are-never-added]]. Verify the layout; never assume.

Related: [[the-old-monthly-closing-export-is-never-touched]] ·
[[exceljs-writes-two-schema-invalid-ooxml-fragments]] ·
[[units-of-different-products-are-never-added]]
