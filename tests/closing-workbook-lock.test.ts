import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import ExcelJS from "exceljs";
import JSZip from "jszip";

import {
  hashSheetPassword,
  lockEngineWorkbook,
  lockExcelWorkbook,
  unlockEngineCells,
} from "../src/lib/sales/closing-workbook-lock.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A downloaded Monthly Closing is READ-ONLY (owner, 2026-10-13: "lock the closing, premium or
// normal ... never be able to edit any cell in any tab"). This file pins the lock module itself on
// small hand-made workbooks, so a failure names the lock and not a closing fixture. The real
// builders are pinned where their fixtures live: the normal workbook in closing-channel-tabs, the
// premium engine in closing-engine-export.
// ─────────────────────────────────────────────────────────────────────────────

// Same algorithm as ExcelJS's own, which is the one Excel accepts. Reproduced here rather than
// imported so a drift in either side fails this file.
function referenceHash(password: string, salt: string, spinCount: number): string {
  let key = createHash("sha512").update(Buffer.concat([Buffer.from(salt, "base64"), Buffer.from(password, "utf16le")])).digest();
  for (let i = 0; i < spinCount; i += 1) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32LE(i, 0);
    key = createHash("sha512").update(Buffer.concat([key, counter])).digest();
  }
  return key.toString("base64");
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

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
  workbook.addWorksheet("Data").getCell("A1").value = "row";
  const calc = workbook.addWorksheet("Calc");
  calc.getCell("A1").value = 1;
  calc.state = "hidden";
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
  + `</sheets></workbook>`;
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
  // sheet1: ordinary, with the elements that must stay AFTER the protection.
  zip.file(
    "xl/worksheets/sheet1.xml",
    `${SHEET_HEAD}<sheetData><row r="1"><c r="A1" s="1"><v>1</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells><pageMargins left="1"/></worksheet>`,
  );
  // sheet2: a pivot sheet with an EMPTY sheetData, a calc element, and a protection already there.
  zip.file(
    "xl/worksheets/sheet2.xml",
    `${SHEET_HEAD}<sheetData/><sheetCalcPr fullCalcOnLoad="1"/><sheetProtection sheet="1" password="CC1A"/><conditionalFormatting sqref="A1"/></worksheet>`,
  );
  // sheet3: the Rep Card, with the picker cell and a cell that merely shares its look.
  zip.file(
    "xl/worksheets/sheet3.xml",
    `${SHEET_HEAD}<sheetData><row r="5"><c r="B5" s="1" t="s"><v>0</v></c><c r="B6" s="1"><v>2</v></c></row></sheetData><dataValidations count="1"><dataValidation sqref="B5"/></dataValidations></worksheet>`,
  );
  return zip;
}

export async function runClosingWorkbookLockTests() {
  // ── The hash is the one Excel and ExcelJS agree on, and a blank password is no hash ────────────
  assert.equal(hashSheetPassword(""), null, "no password configured means no hash, never a hash of nothing");
  const hashed = hashSheetPassword("Phoenix-2026!")!;
  assert.equal(hashed.algorithmName, "SHA-512");
  assert.equal(hashed.spinCount, 100_000, "Excel's own stretch count");
  assert.equal(
    hashed.hashValue,
    referenceHash("Phoenix-2026!", hashed.saltValue, hashed.spinCount),
    "the hash must be reproducible from the salt, or Excel rejects the password",
  );
  assert.notEqual(hashed.hashValue, hashSheetPassword("Phoenix-2026!")!.hashValue, "a fresh salt per workbook");

  // ── ExcelJS-built workbooks: every tab, the hidden one included ────────────────────────────────
  const withPassword = await exceljsFixture();
  assert.equal(lockExcelWorkbook(withPassword, { password: "Phoenix-2026!" }), 3, "all three tabs are locked, hidden Calc included");
  const lockedXml = await sheetXmls((await withPassword.xlsx.writeBuffer()) as unknown as Buffer);
  assert.equal(lockedXml.length, 3);
  for (const xml of lockedXml) {
    const tag = /<sheetProtection\b[^>]*\/>/.exec(xml)?.[0];
    assert.ok(tag, "every worksheet part carries a sheetProtection element");
    assert.equal(attr(tag!, "sheet"), "1", "protection is switched on");
    assert.equal(attr(tag!, "hashValue") !== undefined, true, "the configured password is in the file as a hash");
    assert.equal(
      attr(tag!, "hashValue"),
      referenceHash("Phoenix-2026!", attr(tag!, "saltValue")!, Number(attr(tag!, "spinCount"))),
      "every tab's hash verifies against the password",
    );
    assert.equal(attr(tag!, "objects"), "1", "drawing objects are locked on the rebuilt workbooks");
    assert.equal(attr(tag!, "selectLockedCells"), undefined, "selecting a cell stays allowed -- a reader must be able to copy a figure");
    assert.equal(attr(tag!, "formatCells"), undefined, "formatting stays at its locked default");
    assert.equal(attr(tag!, "sort"), undefined, "sorting stays locked: it rewrites cells");
    assert.equal(attr(tag!, "autoFilter"), "0", "the filter buttons stay usable");
    assert.ok(!xml.includes('password="'), "no legacy 16-bit password hash, which Excel unlocks in seconds");
  }

  const noPassword = await exceljsFixture();
  lockExcelWorkbook(noPassword, { password: "" });
  for (const xml of await sheetXmls((await noPassword.xlsx.writeBuffer()) as unknown as Buffer)) {
    const tag = /<sheetProtection\b[^>]*\/>/.exec(xml)?.[0];
    assert.ok(tag && attr(tag, "sheet") === "1", "with no secret configured the tabs are still locked");
    assert.equal(attr(tag, "hashValue"), undefined, "...and carry no hash");
  }

  // ── The premium engine: the element lands where the schema allows it ───────────────────────────
  const engine = await engineFixture();
  const locked = await lockEngineWorkbook(engine, { password: "Phoenix-2026!" });
  assert.deepEqual([...locked].sort(), ["Pivot", "Plain", "Rep Card"], "every sheet part is locked");
  const [plain, pivot, repCard] = await Promise.all(
    [1, 2, 3].map((n) => engine.file(`xl/worksheets/sheet${n}.xml`)!.async("string")),
  );
  for (const xml of [plain!, pivot!, repCard!]) {
    assert.equal((xml.match(/<sheetProtection\b/g) ?? []).length, 1, "exactly one protection element per sheet");
    const tag = /<sheetProtection\b[^>]*\/>/.exec(xml)![0];
    assert.equal(attr(tag, "pivotTables"), "0", "pivot expand/collapse stays allowed");
    assert.equal(attr(tag, "autoFilter"), "0");
    assert.equal(attr(tag, "objects"), undefined, "slicers and buttons are shapes and stay clickable");
    assert.equal(
      attr(tag, "hashValue"),
      referenceHash("Phoenix-2026!", attr(tag, "saltValue")!, Number(attr(tag, "spinCount"))),
    );
    assert.ok(xml.indexOf("<sheetProtection") > xml.search(/<\/sheetData>|<sheetData\s*\/>/), "after sheetData");
  }
  assert.ok(
    plain!.indexOf("<sheetProtection") < plain!.indexOf("<mergeCells"),
    "CT_Worksheet order: sheetProtection comes before mergeCells, or Excel offers to repair the file",
  );
  assert.ok(
    pivot!.indexOf("<sheetCalcPr") < pivot!.indexOf("<sheetProtection")
      && pivot!.indexOf("<sheetProtection") < pivot!.indexOf("<conditionalFormatting"),
    "an empty sheetData and a sheetCalcPr: protection goes after the calc element and before the formatting",
  );
  assert.ok(!pivot!.includes('password="CC1A"'), "a protection the template already carried is replaced, never doubled");
  assert.ok(
    repCard!.indexOf("<sheetProtection") < repCard!.indexOf("<dataValidations"),
    "protection precedes dataValidations",
  );

  // ── The one open cell: the Rep Card's rep picker ───────────────────────────────────────────────
  const opened = await unlockEngineCells(engine, "xl/worksheets/sheet3.xml", ["B5", "Z99"]);
  assert.deepEqual(opened, ["B5"], "a cell that is not on the sheet is skipped, not invented");
  const styles = await engine.file("xl/styles.xml")!.async("string");
  const card = await engine.file("xl/worksheets/sheet3.xml")!.async("string");
  const pickerStyle = Number(/<c r="B5" s="(\d+)"/.exec(card)![1]);
  const siblingStyle = Number(/<c r="B6" s="(\d+)"/.exec(card)![1]);
  assert.equal(siblingStyle, 1, "a cell that only shares the picker's look keeps the locked style");
  assert.notEqual(pickerStyle, siblingStyle, "the picker gets a style of its own");
  const xfs = [...styles.matchAll(/<xf\b[^>]*?\/>|<xf\b[^>]*?>[\s\S]*?<\/xf>/g)].map((one) => one[0]);
  assert.equal(xfs.length, 3, "one style added");
  assert.match(/<cellXfs count="(\d+)"/.exec(styles)![1]!, /^3$/, "the count is kept honest");
  assert.ok(xfs[pickerStyle]!.includes('<protection locked="0"/>'), "the picker is unlocked");
  assert.ok(xfs[pickerStyle]!.includes('applyProtection="1"'));
  assert.ok(xfs[pickerStyle]!.includes('<alignment horizontal="left"/>'), "...and looks exactly as before");
  assert.ok(!xfs[1]!.includes("protection"), "the original style is untouched");
}
