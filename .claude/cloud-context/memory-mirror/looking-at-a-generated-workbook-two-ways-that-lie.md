---
name: looking-at-a-generated-workbook-two-ways-that-lie
description: "How to actually SEE a generated .xlsx without Excel, and the FOUR ways the answer lies: LibreOffice's PNG export renders only the leftmost columns and an ExcelJS round-trip destroys merges, so both make a CORRECT workbook look broken; --convert-to html rebuilds pivots unconditionally, so it makes a STALE cache look fresh; and that rebuild silently DROPS calculated pivot fields, so a pivot's layout comes back one column short per product. Use html for cell values and the pivot SOURCE, never to judge refreshOnLoad and never as the reference for a pivot LAYOUT. And `check-workbook-integrity.mjs` false-flags every openpyxl-built file (absolute `/xl/...` relationship paths): 14 'problems' on a clean workbook."
metadata: 
  node_type: memory
  type: project
  originSessionId: bb208cb6-364e-4bfd-9cf7-551847e48bcf
  modified: 2026-09-06T11:50:00.000Z
---

**The problem.** `VERIFY THE EMITTED ARTIFACT, NEVER THE SOURCE` means a generated workbook has to
be looked at, and Excel is not drivable headlessly here. LibreOffice is installed
(`/c/Program Files/LibreOffice/program/soffice.exe`) and is the obvious tool. Two of its three
output modes lie, in the same direction: **they make a correct workbook look broken**, which is the
expensive way round — you go hunting for a defect that does not exist.

**Lie 1 — `--convert-to png` renders only the leftmost columns.** On a sheet whose columns are 4 / 30
/ 96 characters wide, the PNG showed columns 1-2 and stopped; column 3 — every body paragraph, every
live counter, the whole right-hand half — came out blank, and the title (which sits in column 3)
was simply absent. Nothing errors. It reads exactly like "the builder never wrote those cells".
Diagnosed as a bug twice in one session; both times the cells were present and correct.

**Lie 2 — a "review copy" made by round-tripping through ExcelJS is not evidence.** To render one
sheet of a six-sheet workbook the tempting move is to load it with ExcelJS, `removeWorksheet` the
others, and save. That save **drops the merges** (7 `mergeCell` refs became 0) and the column widths,
so headings clip mid-word and the layout falls apart — in the copy only. AGENTS.md §4 already
forbids this for the premium closing engine's pivots and VBA; it damages an ordinary workbook too,
and specifically destroys the thing a visual review is trying to judge.

**What actually works: `--convert-to html`.** It emits every sheet's real cell values, so grep the
stripped text for the strings that should be there:

```bash
soffice --headless --norestore "-env:UserInstallation=file:///C:/Users/satoh/AppData/Local/Temp/claude/lo-profile" \
  --convert-to html --outdir "$OUT" "$FILE"
# then: strip tags, and assert the strings you expect are present
```

That settled both false alarms in one command. Use the PNG only for STRUCTURE at a glance — the
masthead, the rules, the zebra banding, whether anything is a filled block — never to judge whether
content exists.

**And the structural check is separate from both.** `node scripts/check-workbook-integrity.mjs <file>`
answers "will Excel silently repair this", which no render can tell you. Run it as well, not instead.


**Lie 3 — and this one lies the OTHER way round: `--convert-to html` cannot judge a PIVOT's
freshness.** LibreOffice rebuilds a pivot (its DataPilot) from the declared source on every load,
unconditionally and **regardless of `refreshOnLoad`**. So it renders a STALE cache as though it were
live. That is a false NEGATIVE — the defect looks FIXED — which is the dangerous direction, and the
opposite of lies 1 and 2 above.

Measured 2026-09-05 on the Weekly Sales BI workbook: the cached records were poisoned to `777777` in
BOTH a fixed build and an unfixed one, and both rendered the true total 6,786. The poison never
appeared anywhere. A clean render is therefore no evidence at all about `refreshOnLoad`.

**What it CAN discriminate is the cache SOURCE**, precisely because it rebuilds from whatever source
is declared. Append rows to the Data table, leave the cache untouched, convert, and read the pivot's
grand total:

- `<worksheetSource name="tblWeekly"/>` → **855,270** — the appended rows are in
- `<worksheetSource ref="A1:O8" sheet="Data"/>` → **6,786** — the appended rows are invisible

That is a genuine end-to-end proof of "the pivot grows with the data", by a real spreadsheet engine.

**`refreshOnLoad` itself is only checkable STRUCTURALLY** — the attribute present, singular, and
matching the form Excel itself wrote in `assets/closing-engine/template.xlsm`
(`<pivotCacheDefinition refreshOnLoad="1" ...>`). Confirming a pivot actually OPENS fresh needs
Excel. Never claim it from a LibreOffice render, and say which half the evidence covers.

**Lie 4 — the html rebuild DROPS Excel's CALCULATED pivot fields, silently.** Found 2026-09-06 while
building a static grid for the premium closing's three pivot pages. Both matrices declare three data
fields per product — `Sales Value`, `Target Value` and `Ach`, where `Ach` is a calculated field
(`IF('Target Value'>0,'Sales Value'/'Target Value',-1)`). LibreOffice does not support calculated
pivot fields, so its rebuild renders **two** columns per product and omits `Ach` entirely. The grid
looks completely plausible; the totals are even correct. It is wrong by ONE COLUMN PER PRODUCT, and
using it as the reference for a hand-built grid would have shipped a layout a column short on every
product on the only platform that displays it.

It also renames things: a tabular subtotal row that Excel writes as `Cairo Total` comes back as
`Cairo Result`, and the grand total as `Total Result`.

**So a render can never be the reference for a pivot's LAYOUT.** Read the layout out of
`xl/pivotTables/pivotTable*.xml` — `rowFields`, `colFields`, `dataFields`, `rowGrandTotals`,
`colGrandTotals`, and `<location firstHeaderRow= firstDataRow= firstDataCol=>` — and cross-check the
derived width against the template's own stored `location ref`, which is an independent number that
must agree: 2 + 15x3 + 3 = 50 = AX for the Closing Matrix, 2 + 15x3 + 0 = 47 = AU for the Units
Matrix (its `colGrandTotals="0"`), 3 + 3 = 6 = F for Area x Product. All three matched byte for
byte, which is what made the derivation checkable rather than assumed.

What the render IS still good for here: the VALUES. LibreOffice's own aggregation of the region
subtotals and grand total matched the hand-built grid exactly (864,000 / 160,000 / 1,024,000), which
is a real independent check of the arithmetic even though the layout around it is wrong.

**Lie 5 — the STRUCTURAL checker itself false-flags a Python-built workbook (2026-09-16).**
`node scripts/check-workbook-integrity.mjs` on an openpyxl file reported **14 PROBLEM(S)** —
"relationship … points at missing xl/xl/worksheets/sheet1.xml", "_FilterDatabase names unknown sheet"
— on a workbook that was fine. openpyxl writes ABSOLUTE part names (`Target="/xl/worksheets/sheet1.xml"`,
valid OPC, Excel opens them) and puts `Target` BEFORE `Id`; the checker joins `base + target` (so the
leading `/` doubles the folder) and its sheet lookup regex expects `Id` first, so every sheet-name
check cascades. ExcelJS writes relative targets, which is why it never showed. **Proof that settles
it:** rewrite only the `.rels` targets to relative, `Id` first, in a SCRATCH copy and re-run — it came
back CLEAN (21 parts, 12 merges, 1,097 rows). Ship the original; never "repair" the owner's file to
please the checker. A fix for the checker was spun off as a separate task that day.

Related: [[verify-the-emitted-artifact-never-the-source]] ·
[[verify-a-mobile-layout-without-a-dev-server]] ·
[[premium-closing-export-fills-the-xlsm-engine-never-rebuilds-it]]
