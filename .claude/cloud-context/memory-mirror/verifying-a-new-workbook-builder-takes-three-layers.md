---
name: verifying-a-new-workbook-builder-takes-three-layers
description: "Shipping a NEW .xlsx builder needs three separate checks — a cell-level readback in a registered test, scripts/check-workbook-integrity.mjs on emitted bytes, and a LibreOffice HTML render with a control string. Each answers a different question; none substitutes for another, and asserting on the builder's SOURCE answers none of them."
metadata: 
  node_type: memory
  type: project
  originSessionId: 1436f94e-44d5-4d9a-ad81-3f4e76a51bcd
  modified: 2026-09-05T05:53:06.440Z
---

**Three layers, three different questions.** Built the Manager CV Engagement export (PR #3171,
2026-09-05) and nearly shipped on layer 1 alone.

**1 — Cell-level readback, in a registered test.** Build the buffer, load it straight back, assert on
cells. This is what makes [[verify-the-emitted-artifact-never-the-source]] real for a workbook:

```ts
const buffer = await buildXWorkbook({ … });
assert.equal(buffer[0], 0x50); assert.equal(buffer[1], 0x4b);   // it is a zip at all
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buffer as unknown as ArrayBuffer);
assert.deepEqual(wb.worksheets.map((s) => s.name), ["Cover", "Managers", "CVs"]);
```

Answers *are the right values in the right cells*. Cannot see whether Excel will open the file.

**2 — `node scripts/check-workbook-integrity.mjs <file>`.** Emit a REALISTIC sample to the scratchpad
(nulls, Arabic, legacy status strings, a resigned row, hundreds of rows) and run it. Six structural
checks — parse, repeated attributes, content types, dangling relationships, ascending row/cell order,
refs agreeing — and it prints `CLEAN` or names the part. Answers *will Excel silently repair this*,
which no readback and no render can tell you. **Run it on every new builder before merging**; I found
it only afterwards, from [[looking-at-a-generated-workbook-two-ways-that-lie]].

**3 — LibreOffice `--convert-to html`, then grep the stripped text.** Answers *is the content
actually there and formatted*. **Give it a CONTROL that must be ABSENT**, the same discipline as
[[verify-a-mobile-layout-without-a-dev-server]]: an all-present list looks identical to a harness
that silently matched nothing. Here the control was the raw date serial `46270` — 0 occurrences
proved the number format was applied rather than the number leaking through, while `02 Aug 2026`
appearing proved the cell was a real date.

**A sortable date column is a SERIAL plus a numFmt, never display text.** `"05 Sept 2026"` as a
string sorts alphabetically, which destroys the one thing a detail sheet is for. Resolve the Cairo
calendar day FIRST, then anchor at UTC midnight, then convert:
`Date.UTC(y, m - 1, d) / 86_400_000 + 25_569` with `numFmt: "dd mmm yyyy"`. An Excel date carries no
zone, so anchoring any other way slides a 01:00-Cairo row back a day. The readback proves it: ExcelJS
returns a real `Date`, not a number, so `assert.ok(v instanceof Date)` is the assertion.

**Two things that bit, both cheap to avoid:**

- **A source-scanning assertion must match CODE SHAPE, not bare words.** `/outlineProperties|addImage/`
  went red on the builder's own header comment explaining those two traps. Use
  `/outlineProperties\s*[:=]|\.addImage\(/`. Same trap `cv-lifecycle-share-links-screen.test.ts`
  documents for `rounded-`.
- **`en-GB` renders September as "Sept" on Node 24's ICU, "Sep" elsewhere.** Pin the DAY
  (`/^05 \w+ 2026$/`), never the month abbreviation, or a runtime upgrade fails the test over
  nothing.

Related: [[exceljs-writes-two-schema-invalid-ooxml-fragments]] (what layer 2 catches) ·
[[excel-rejects-a-workbook-libreoffice-calls-perfect]] · [[prove-it-fails-verify-which-assertion-fired]]
