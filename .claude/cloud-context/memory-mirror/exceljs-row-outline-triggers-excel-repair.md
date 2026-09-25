---
name: exceljs-row-outline-triggers-excel-repair
description: "ExcelJS emits sheetPr children in the wrong order, so outlineProperties + fitToPage makes Excel refuse to open the sheet — never set outlineProperties"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 79f3f577-f3d1-4ba8-9694-cc8af3320030
  modified: 2026-08-12T06:45:16.963Z
---

Adding collapsible row groups to an ExcelJS sheet that ALSO uses `pageSetup.fitToPage` produces a
workbook Excel refuses to open: *"We found a problem with some content…"*, with the repair log saying
`Replaced Part: /xl/worksheets/sheetN.xml part with XML error. Load error. Line 2, column 0.`

**Cause — the `sheetPr` child ORDER, not the rows.** OOXML's `CT_SheetPr` is a SEQUENCE:
`tabColor` → `outlinePr` → `pageSetUpPr`. ExcelJS 4.4.0 emits them backwards
(`lib/xlsx/xform/sheet/sheet-properties-xform.js`, `render()`: `pageSetUpPr` then `outlinePr`), so
asking for both yields

```xml
<sheetPr><pageSetUpPr fitToPage="1"/><outlinePr summaryBelow="1"/></sheetPr>
```

The XML is **well-formed** — a strict parser accepts it and `ExcelJS.readFile` round-trips it — so
only Excel notices. A sheet with an outline but no `fitToPage`, or `fitToPage` but no outline, is
fine, which is why one tab in the same workbook opened and the other did not.

**Fix: never set `outlineProperties`.** Row-level `row.outlineLevel = 1` is what creates the groups,
and `summaryBelow` already defaults to true in Excel (summary row BELOW its detail).

```ts
// sheet.properties.outlineProperties = {...}   // <- do NOT, while dressPage sets fitToPage
sheet.properties.outlineLevelRow = 2;           // above the deepest level in use
row.outlineLevel = 1;                           // the actual grouping
```

`outlineLevelRow` matters separately: `lib/doc/row.js` derives `collapsed` as
`outlineLevel >= properties.outlineLevelRow` with **no setter**, so the default of 0 marks every
level-1 row collapsed while leaving it visible. Contradictory, and worth avoiding — but it was NOT
what Excel rejected.

**Detect without opening Excel** — assert the order in the sheet XML:

```js
const sheetPr = /<sheetPr>(.*?)<\/sheetPr>/.exec(xml)?.[1] ?? "";
// if both appear, <outlinePr> must come BEFORE <pageSetUpPr>
```

Guarded in `tests/weekly-summary-report.test.ts`. Hit 2026-08-12 on Weekly Sales Summarized Report
Tab 2 — and it took THREE attempts: overlapping merges, then `collapsed`, both wrong. What actually
found it was diffing the broken sheet against a WORKING sheet in the same workbook (the only
differences were `outlinePr` and `row@outlineLevel`) and then reading the ExcelJS xform source.
Reasoning from the symptom produced two confident wrong answers.

This is the same failure MODE as the duplicate conditional-format priorities that bit this repo
before — see [[exceljs-workbooks-are-recalculated-on-open]] for the other ExcelJS trap in this file.
**Whenever an xlsx gains an exotic feature (outlines, CF, data validation, sparklines), open the
generated file before shipping, or assert on the XML in a test.** The builder reports success either
way; ExcelJS validates nothing, and neither does a well-formedness check.
