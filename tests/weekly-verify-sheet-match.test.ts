import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ExcelJS from "exceljs";

import { planWeeklyVerify, verifyWeeklyUpload, weeklyVerifyVerdict, type WeeklyVerifyPlan } from "../src/lib/sales/weekly/ai-verify.ts";
import { weeklyVerifyAiBadge } from "../src/lib/sales/weekly/verify-ai-state.ts";
import { stripComments } from "./support/comment-strip.ts";
import { listCodeWeeklyContracts, weeklyContractByCode } from "../src/lib/sales/weekly/column-contract.ts";
import { parseWeeklyWorkbookBuffer } from "../src/lib/sales/weekly/parser.ts";
import { weeklySheetMatcher } from "../src/lib/sales/weekly/sheet-match.ts";
import { dbRowToContract } from "../src/lib/sales/weekly/weekly-column-profile-store.ts";

// The pre-upload verification screen must pick exactly the sheets the import reads — and say MISSING
// when the import would read none, never show some other sheet in its place.
//
// It used to match on column-contract.ts's looser names ("Stock", "Return", "Sheet1") and fall back to
// the workbook's FIRST sheet, while the adapters in parser.ts matched their own names and (for EGD and
// RAMCO) never fell back. On an EGD workbook without "Current Stock Branches" the screen showed
// "Current Stock Pharmacy" — which the import deliberately ignores — as the stock source, or column 3
// of the sales sheet when no stock-like sheet existed, while the import read no stock at all. That is
// how the 2026-08 month-end EGD file was confirmed and stored with stock 0 on every row.
//
// Every scenario below runs BOTH the verification plan and the real parser on the same bytes and
// requires the two to name the same sheets. Both now read sheet-match.ts.

type SheetSpec = { name: string; header: string[]; headerRow?: number };

async function workbookBuffer(sheets: SheetSpec[]): Promise<ExcelJS.Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const spec of sheets) {
    const ws = wb.addWorksheet(spec.name);
    if ((spec.headerRow ?? 1) === 2) ws.addRow(["title"]);
    ws.addRow(spec.header);
  }
  return wb.xlsx.writeBuffer();
}

async function load(buffer: ExcelJS.Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

/** A header row with `labels` placed at 1-based columns. */
function header(labels: Record<number, string>, width = 40): string[] {
  const row = new Array<string>(width).fill("");
  for (const [col, text] of Object.entries(labels)) row[Number(col) - 1] = text;
  return row;
}

const EG_SALES = header({ 4: "INVOICE_DATE", 5: "ITEM_CODE", 6: "ITEM_NAME", 13: "QTY_INVOICE", 29: "BRANCH_CODE", 30: "BRANCH_NAME" });
const EG_RETURNS = header({ 5: "ITEM_CODE", 14: "RETURN_QTY", 29: "BRANCH_CODE" });
const EG_STOCK = header({ 1: "ITEM_CODE", 2: "ITEM_NAME_ENG", 3: "ITEM_STOCK", 13: "COMPANY_ENTITY_CODE", 14: "COMPANY_ENTITY_NAME" });

async function plan(code: string, files: Partial<Record<"file" | "salesFile" | "stockFile", ExcelJS.Buffer>>): Promise<WeeklyVerifyPlan> {
  const workbooks = new Map<"file" | "salesFile" | "stockFile", ExcelJS.Workbook>();
  for (const [key, buffer] of Object.entries(files)) workbooks.set(key as "file", await load(buffer as ExcelJS.Buffer));
  return planWeeklyVerify({
    distributorCode: code,
    contract: weeklyContractByCode(code)!,
    workbooks,
    fileNames: { file: `${code}.xlsx`, salesFile: `${code} sales.xlsx`, stockFile: `${code} stock.xlsx` },
  });
}

/** The sheet names the real parser read, from the batch label it stores ("A + B", "Sales:Data + Stock:Data"). */
async function parserSheets(code: string, files: { buffer?: ExcelJS.Buffer; salesBuffer?: ExcelJS.Buffer; stockBuffer?: ExcelJS.Buffer }): Promise<string[]> {
  const parsed = await parseWeeklyWorkbookBuffer({
    ...files,
    distributorCode: code,
    distributorName: code,
    fileName: `${code}.xlsx`,
    references: { distributors: [], products: [], regions: [] },
    aliasIndex: new Map(),
    branchMapIndex: { byBranch: new Map(), byColumnIndex: new Map(), bySoftName: new Map() },
  });
  assert.equal(parsed.ok, true, `${code}: the parser returns a result to compare against`);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.result.sheetName
    .split(" + ")
    .map((label) => label.replace(/^(Sales|Stock):/, ""))
    .sort();
}

function planSheets(result: WeeklyVerifyPlan): string[] {
  return result.files.map((file) => file.sheetName).sort();
}

function statusesFor(result: WeeklyVerifyPlan, role: string): string[] {
  return [...new Set(result.columns.filter((col) => col.sheetRole === role).map((col) => col.status))];
}

export async function runWeeklyVerifySheetMatchTests() {
  // ── EGD: the incident shape. Branch stock sheet absent, "Current Stock Pharmacy" present. ──
  {
    const buffer = await workbookBuffer([
      { name: "Branches Sales", header: EG_SALES },
      { name: "Branch Sales Return", header: EG_RETURNS },
      { name: "Current Stock Pharmacy", header: EG_STOCK },
    ]);
    const result = await plan("EG", { file: buffer });
    assert.deepEqual(statusesFor(result, "stock"), ["missing"], "EGD: with no Current Stock Branches sheet, every stock column reads MISSING");
    assert.ok(
      !result.columns.some((col) => col.sheetName === "Current Stock Pharmacy") && !result.files.some((file) => file.sheetName === "Current Stock Pharmacy"),
      "EGD: Current Stock Pharmacy is never shown as the stock source — the import ignores it",
    );
    assert.ok(result.warnings.some((text) => text.startsWith('MISSING: this file has no "Current Stock Branches" sheet')), "EGD: the warning names the missing sheet");
    assert.equal(weeklyVerifyVerdict(result.columns), "drift", "EGD: a missing stock sheet can never verify as a pass");
    assert.deepEqual(planSheets(result), await parserSheets("EG", { buffer }), "EGD: the screen and the import read the same sheets");
  }

  // ── EGD: no stock-like sheet at all. The old fallback showed column 3 of the SALES sheet as stock. ──
  {
    const buffer = await workbookBuffer([{ name: "Branches Sales", header: EG_SALES }]);
    const result = await plan("EG", { file: buffer });
    assert.deepEqual(statusesFor(result, "stock"), ["missing"], "EGD: with only the sales sheet, stock reads MISSING");
    assert.deepEqual(statusesFor(result, "returns"), ["missing"], "EGD: with only the sales sheet, returns read MISSING");
    assert.ok(
      !result.columns.some((col) => col.sheetRole !== "sales" && col.sheetName === "Branches Sales"),
      "EGD: the sales sheet never stands in for the stock or returns sheet",
    );
    assert.deepEqual(planSheets(result), await parserSheets("EG", { buffer }), "EGD (sales only): the screen and the import agree");
  }

  // ── EGD: "Transfer Return" is not the branch returns sheet. The old contract matched any "Return". ──
  {
    const buffer = await workbookBuffer([
      { name: "Branches Sales", header: EG_SALES },
      { name: "Transfer Return", header: EG_RETURNS },
      { name: "Current Stock Branches ", header: EG_STOCK },
    ]);
    const result = await plan("EG", { file: buffer });
    assert.deepEqual(statusesFor(result, "returns"), ["missing"], "EGD: Transfer Return never stands in for Branch Sales Return");
    assert.deepEqual(statusesFor(result, "stock"), ["uncertain"], "EGD: a trailing space on Current Stock Branches still matches, as in real exports");
    assert.deepEqual(planSheets(result), await parserSheets("EG", { buffer }), "EGD (transfer return): the screen and the import agree");
  }

  // ── EGD: a complete workbook still verifies cleanly. ──
  {
    const buffer = await workbookBuffer([
      { name: "Branches Sales", header: EG_SALES },
      { name: "Branch Sales Return", header: EG_RETURNS },
      { name: "Current Stock Branches", header: EG_STOCK },
      { name: "Current Stock Pharmacy", header: EG_STOCK },
    ]);
    const result = await plan("EG", { file: buffer });
    assert.equal(result.columns.some((col) => col.status === "missing"), false, "EGD (complete): nothing is missing");
    assert.deepEqual(result.warnings, [], "EGD (complete): no warnings");
    assert.equal(weeklyVerifyVerdict(result.columns), "pass", "EGD (complete): verifies as a pass");
    assert.deepEqual(planSheets(result), await parserSheets("EG", { buffer }), "EGD (complete): the screen and the import agree");
  }

  // ── RAMCO: no STOCK sheet. RAMCO's adapter has no fallback either. ──
  {
    const buffer = await workbookBuffer([
      { name: "SALES", headerRow: 2, header: header({ 1: "كود", 2: "اسم الفرع", 9: "كود الصنف", 10: "اسم الصنف", 11: "بيع", 13: "مرتجع بيع", 15: "صافى كمية", 24: "التاريخ" }) },
    ]);
    const result = await plan("RM", { file: buffer });
    assert.deepEqual(statusesFor(result, "stock"), ["missing"], "RAMCO: with no STOCK sheet, stock reads MISSING instead of showing the SALES sheet");
    assert.equal(result.matrices.length, 0, "RAMCO: no branch stock block is read off the sales sheet");
    assert.deepEqual(planSheets(result), await parserSheets("RM", { buffer }), "RAMCO: the screen and the import agree");
  }

  // ── Sofico: the adapter matches any sheet containing "Sheet"; the old contract said "Sheet1". ──
  {
    const buffer = await workbookBuffer([
      { name: "Summary", header: header({ 1: "note" }) },
      { name: "Sheet3", header: header({ 2: "net qty", 5: "ITEMNAME", 13: "SITE", 15: "SITENAME", 16: "ITEMIDE" }) },
    ]);
    const result = await plan("SF", { file: buffer });
    assert.deepEqual(result.files.map((file) => file.sheetName), ["Sheet3"], "Sofico: the screen reads Sheet3, the sheet the import reads — not the first sheet");
    assert.deepEqual(planSheets(result), await parserSheets("SF", { buffer }), "Sofico: the screen and the import agree");
  }

  // ── Ibn Sina: the real export has one sheet, "Sheet1", and the import has always read it. ──
  {
    const buffer = await workbookBuffer([
      { name: "Sheet1", header: header({ 3: "Item Code", 4: "Item Name", 5: "Branch Code", 6: "Branch Name", 7: "Stock", 9: "Sales Quantity" }) },
    ]);
    const result = await plan("IS", { file: buffer });
    assert.deepEqual(result.files.map((file) => file.sheetName), ["Sheet1"], "Ibn Sina: the one-sheet export is read, as the import reads it");
    assert.deepEqual(result.warnings, [], "Ibn Sina: a one-sheet file raises no warning");
    assert.equal(result.columns.some((col) => col.status === "missing"), false, "Ibn Sina: nothing is reported missing");
    assert.deepEqual(planSheets(result), await parserSheets("IS", { buffer }), "Ibn Sina: the screen and the import agree");
  }

  // ── Ibn Sina with several sheets and no "Sheet2": the import reads the first — the screen says so. ──
  {
    const buffer = await workbookBuffer([
      { name: "Report", header: header({ 3: "Item Code", 4: "Item Name", 5: "Branch Code", 6: "Branch Name", 7: "Stock", 9: "Sales Quantity" }) },
      { name: "Notes", header: header({ 1: "note" }) },
    ]);
    const result = await plan("IS", { file: buffer });
    assert.ok(result.warnings.some((text) => text.includes('reads this file\'s first sheet, "Report"')), "Ibn Sina: reading the first of several sheets is called out");
    assert.deepEqual(planSheets(result), await parserSheets("IS", { buffer }), "Ibn Sina (several sheets): the screen and the import agree");
  }

  // ── Overseas: both files, both "Data". ──
  {
    const salesBuffer = await workbookBuffer([{ name: "Data", header: header({ 3: "Mat. Code", 4: "Mat. Desc.", 5: "Outlet A", 6: "Total Qty" }) }]);
    const stockBuffer = await workbookBuffer([{ name: "Data", header: header({ 3: "Mat. Code", 4: "Mat. Desc.", 7: "Location 1" }) }]);
    const result = await plan("PS", { salesFile: salesBuffer, stockFile: stockBuffer });
    assert.deepEqual(planSheets(result), await parserSheets("PS", { salesBuffer, stockBuffer }), "Overseas: the screen and the import agree");
  }

  // ── One rule: every contract sheet has a sheet rule, and the contract's names are that rule's. ──
  for (const contract of listCodeWeeklyContracts()) {
    for (const sheet of contract.sheets) {
      const matcher = weeklySheetMatcher(contract.code, sheet.role);
      assert.ok(matcher, `${contract.name} ${sheet.role}: has a sheet rule`);
      assert.equal(sheet.sheetName, matcher!.name, `${contract.name} ${sheet.role}: the contract shows the name the import matches`);
      assert.equal(sheet.sheetIncludes, matcher!.includes, `${contract.name} ${sheet.role}: the contract shows the partial name the import matches`);
    }
  }
  const eg = weeklyContractByCode("EG")!;
  assert.equal(eg.sheets.find((sheet) => sheet.role === "stock")!.sheetIncludes, "Current Stock Branches", "EGD stock: the partial match is the full branch stock name, never just \"Stock\"");
  assert.equal(eg.sheets.find((sheet) => sheet.role === "returns")!.sheetIncludes, "Branch Sales Return", "EGD returns: the partial match is the full name, never just \"Return\"");

  // ── A saved override keeps stale names from the day it was saved; they must not come back. ──
  {
    const stale = JSON.parse(JSON.stringify(eg.sheets)) as Record<string, unknown>[];
    for (const sheet of stale) if (sheet.role === "stock") sheet.sheetIncludes = "Stock";
    const loaded = dbRowToContract({ distributor_code: "EG", distributor_name: "EGD", split_files: false, sheets: stale, active: true });
    assert.equal(loaded?.sheets.find((sheet) => sheet.role === "stock")?.sheetIncludes, "Current Stock Branches", "a stored override's stale sheet names are replaced by the shared rule");
  }

  // ── The badge says WHY AI did not judge the columns (18 Oct 2026: a check that never called AI read
  //    "AI unavailable" on production while AI was answering, and was taken for AI being down). ──
  assert.equal(weeklyVerifyAiBadge("checked"), "AI checked");
  for (const state of ["header_name_file", "nothing_to_check", "failed"] as const) {
    assert.doesNotMatch(weeklyVerifyAiBadge(state), /unavailable/i, `${state}: AI was not down, so the badge never says it is unavailable`);
  }
  assert.match(weeklyVerifyAiBadge("not_configured"), /AI unavailable/, "only a missing key reads as unavailable");
  const direct = await verifyWeeklyUpload({ distributorCode: "Direct", fileBuffer: Buffer.from(""), fileName: "direct.xlsx" });
  assert.equal(direct.aiState, "header_name_file", "a Direct file is matched by header name, so AI has nothing to judge");
  assert.equal(direct.aiUsed, false);
  const panel = stripComments(readFileSync(fileURLToPath(new URL("../src/components/sales/weekly/weekly-upload-workspace.tsx", import.meta.url)), "utf8"));
  assert.ok(panel.includes("weeklyVerifyAiBadge(result.aiState)"), "the verify panel's badge reads the state");
  assert.doesNotMatch(panel, /aiUsed \? "AI checked"/, "and never the old yes/no that called every skipped check unavailable");
}
