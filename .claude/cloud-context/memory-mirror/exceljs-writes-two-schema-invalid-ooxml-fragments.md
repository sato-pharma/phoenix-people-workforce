---
name: exceljs-writes-two-schema-invalid-ooxml-fragments
description: "ExcelJS emits <outlinePr> after <pageSetUpPr> and editAs on <xdr:oneCellAnchor>, both schema-invalid, so Excel silently repairs the workbook; fix by post-processing the zip"
metadata:
  node_type: memory
  type: reference
---

**ExcelJS produces two OOXML fragments Excel rejects.** Symptom is the "We found a problem with some
content" repair dialog, whose log names *"Replaced Part: /xl/worksheets/sheetN.xml … Load error.
Line 2, column 0"* and *"Repaired Records: Drawing"*. Both were hit 2026-08-27 building the Monthly
Closing premium workbook.

**1. `<sheetPr>` child order.** `CT_SheetPr` fixes the sequence **`tabColor`, `outlinePr`,
`pageSetUpPr`**. Setting `ws.properties.outlineProperties` together with `pageSetup.fitToPage` makes
ExcelJS write `<pageSetUpPr/>` **before** `<outlinePr/>` — invalid, and Excel discards the ENTIRE
sheet part. The tell: only the sheets carrying an outline group fail; a sheet without one loads fine.

**2. `editAs` on a one-cell anchor.** `CT_OneCellAnchor` declares **no attributes at all** — `editAs`
belongs to `CT_TwoCellAnchor` only. ExcelJS writes `editAs="oneCell"` on `<xdr:oneCellAnchor>`
**whether or not you pass it**, so dropping the option from `ws.addImage` does NOT fix it.

**Fix: post-process the .xlsx zip** — swap the two `<sheetPr>` children, and strip `editAs=".."` from
`<xdr:oneCellAnchor`. Both are safe: a one-cell anchor already means "move, don't size", and
`pageSetUpPr` survives the swap. Column/row outline groups themselves (`outlineLevel`,
`outlineLevelCol`) are untouched and keep working.

**Diagnosis notes that cost time:**
- **A clean `zipfile.testzip()` proves nothing** — the container was always fine; the defect is inside
  the part XML. Parse every `.xml`/`.rels` with ElementTree instead.
- **A non-greedy `<sheetPr\b.*?(?:/>|</sheetPr>)` regex stops at the FIRST `/>`**, so it reports only
  the first child and makes a correct file look like it lost `pageSetUpPr`. Verify by walking the
  parsed element's children, never by regex.
- **openpyxl reports `images: 0` on every sheet** — it cannot read ExcelJS DrawingML. Check
  `xl/media/*` in the zip instead.
- **openpyxl under-reports grouped columns** — ExcelJS merges adjacent identical `<col>` definitions
  into ranges, so a group can appear as `min="4" max="5"` rather than per-column entries.

Related: [[units-of-different-products-are-never-added]] (the workbook this was found building).
