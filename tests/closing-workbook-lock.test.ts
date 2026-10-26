import assert from "node:assert/strict";

import ExcelJS from "exceljs";
import JSZip from "jszip";

import { unprotectEngineWorkbook, unprotectExcelWorkbook } from "../src/lib/sales/closing-workbook-lock.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A downloaded Monthly Closing is NOT PROTECTED (owner, 2026-10-26: "make the exported monthly
// closing xlsx all its types download non protected"), reversing his 2026-10-13 lock. This file pins
// the module itself on small hand-made workbooks, so a failure names it and not a closing fixture.
// The real builders are pinned where their fixtures live: the normal workbook in
// closing-channel-tabs, the premium engine in closing-engine-export, the ranking in
// closing-rep-ranking.
// ─────────────────────────────────────────────────────────────────────────────

async function sheetXmls(buffer: Buffer | ArrayBuffer | Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort();
  return Promise.all(names.map((name) => zip.file(name)!.async("string")));
}

async function exceljsFixture(): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  const first = workbook.addWorksheet("Closing Matrix");
  first.getCell("A1").value = "Area";
  first.getCell("B1").value = 1234;
  // A protection already on a tab (as the old builders left it) must be cleared, not kept.
  await first.protect("Phoenix-2026!", { selectLockedCells: true });
  workbook.addWorksheet("Data").getCell("A1").value = "row";
  const calc = workbook.addWorksheet("Calc");
  calc.getCell("A1").value = 1;
  calc.state = "hidden";
  await calc.protect("", {});
  return workbook;
}

const MINIMAL_RELS =
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + `<Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/>`
  + `<Relationship Id="rId2" Type="x" Target="worksheets/sheet2.xml"/>`
  + `<Relationship Id="rId3" Type="x" Target="worksheets/sheet3.xml"/>`
  + `</Relationships>`;
const MINIMAL_WORKBOOK =
  `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>`
  + `<sheet name="Plain" sheetId="1" r:id="rId1"/><sheet name="Pivot" sheetId="2" r:id="rId2"/><sheet name="Rep Card" sheetId="3" r:id="rId3"/>`
  + `</sheets><workbookProtection lockStructure="1"/></workbook>`;
const SHEET_HEAD = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B5"/>`;
const STYLES =
  `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2">`
  + `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
  + `<xf numFmtId="0" fontId="3" fillId="3" borderId="4" xfId="0" applyFont="1"><alignment horizontal="left"/></xf>`
  + `</cellXfs></styleSheet>`;

async function engineFixture(): Promise<JSZip> {
  const zip = new JSZip();
  zip.file("xl/workbook.xml", MINIMAL_WORKBOOK);
  zip.file("xl/_rels/workbook.xml.rels", MINIMAL_RELS);
  zip.file("xl/styles.xml", STYLES);
  // sheet1: ordinary, carrying a modern hashed protection between its sheetData and mergeCells.
  zip.file(
    "xl/worksheets/sheet1.xml",
    `${SHEET_HEAD}<sheetData><row r="1"><c r="A1" s="1"><v>1</v></c></row></sheetData><sheetProtection algorithmName="SHA-512" hashValue="x" saltValue="y" spinCount="100000" sheet="1" objects="1"/><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells><pageMargins left="1"/></worksheet>`,
  );
  // sheet2: a pivot sheet with an EMPTY sheetData, a calc element, and a protection already there.
  zip.file(
    "xl/worksheets/sheet2.xml",
    `${SHEET_HEAD}<sheetData/><sheetCalcPr fullCalcOnLoad="1"/><sheetProtection sheet="1" password="CC1A"/><conditionalFormatting sqref="A1"/></worksheet>`,
  );
  // sheet3: the Rep Card, never protected -- it must come out byte-for-byte unchanged.
  zip.file(
    "xl/worksheets/sheet3.xml",
    `${SHEET_HEAD}<sheetData><row r="5"><c r="B5" s="1" t="s"><v>0</v></c><c r="B6" s="1"><v>2</v></c></row></sheetData><dataValidations count="1"><dataValidation sqref="B5"/></dataValidations></worksheet>`,
  );
  return zip;
}

export async function runClosingWorkbookLockTests() {
  // ── ExcelJS-built workbooks: every tab, the hidden one included, leaves unprotected ────────────
  const built = await exceljsFixture();
  const beforeXml = await sheetXmls((await built.xlsx.writeBuffer()) as unknown as Buffer);
  assert.equal(
    beforeXml.filter((xml) => xml.includes("<sheetProtection")).length,
    2,
    "the fixture really starts with two protected tabs",
  );
  assert.equal(unprotectExcelWorkbook(built), 3, "all three tabs are visited, hidden Calc included");
  const openXml = await sheetXmls((await built.xlsx.writeBuffer()) as unknown as Buffer);
  assert.equal(openXml.length, 3);
  for (const xml of openXml) {
    assert.ok(!xml.includes("<sheetProtection"), "no worksheet part carries a sheetProtection element");
  }
  const reread = new ExcelJS.Workbook();
  await reread.xlsx.load((await built.xlsx.writeBuffer()) as unknown as ArrayBuffer);
  assert.equal(reread.getWorksheet("Closing Matrix")!.getCell("B1").value, 1234, "the figures are untouched");
  assert.equal(reread.getWorksheet("Calc")!.state, "hidden", "a hidden tab stays hidden -- only its protection goes");

  // ── The premium engine: protection stripped from the XML, everything else kept ────────────────
  const engine = await engineFixture();
  const repCardBefore = await engine.file("xl/worksheets/sheet3.xml")!.async("string");
  const visited = await unprotectEngineWorkbook(engine);
  assert.deepEqual([...visited].sort(), ["Pivot", "Plain", "Rep Card"], "every sheet part is visited");
  const [plain, pivot, repCard] = await Promise.all(
    [1, 2, 3].map((n) => engine.file(`xl/worksheets/sheet${n}.xml`)!.async("string")),
  );
  for (const xml of [plain!, pivot!, repCard!]) {
    assert.ok(!xml.includes("<sheetProtection"), "no engine sheet carries protection");
  }
  assert.ok(plain!.includes("<mergeCells") && plain!.includes("<pageMargins"), "the elements around it survive");
  assert.ok(
    pivot!.includes("<sheetCalcPr") && pivot!.includes("<conditionalFormatting"),
    "a legacy protection is removed and its neighbours kept",
  );
  assert.equal(repCard, repCardBefore, "a sheet that was never protected is left byte-for-byte");
  const workbookXml = await engine.file("xl/workbook.xml")!.async("string");
  assert.ok(!workbookXml.includes("<workbookProtection"), "the workbook structure is not protected either");
  assert.ok(workbookXml.includes('<sheet name="Rep Card"'), "the sheet list is kept");
}
