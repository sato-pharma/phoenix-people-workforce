import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { detectDistributor } from "../src/lib/sales/normalizer/detect-distributor.ts";
import { buildDetectionProfiles } from "../src/lib/sales/distributor-detection.ts";
import { buildHeaderMap, pickBestSheet, validateSheetHeaders } from "../src/lib/sales/normalizer/engine.ts";
import { foldArabicDigits, HEADER_SCAN_ROWS, normalizeHeaderKey } from "../src/lib/sales/normalizer/header-normalize.ts";
import { listEditableProfiles } from "../src/lib/sales/normalizer/distributor-profile-store.ts";
import { RAW_DISTRIBUTOR_PROFILES, rawProfileForDistributor } from "../src/lib/sales/normalizer/profiles.ts";
import { normalizeCodeKey, numericCanonicalKey } from "../src/lib/sales/normalizer/resolvers.ts";

// Build Arabic-Indic numerals (U+0660+) from an ASCII digit string, so this test contains no literal
// Arabic in source — the rules are exercised via code points only.
const arabicIndic = (digits: string) => digits.split("").map((d) => String.fromCharCode(0x0660 + Number(d))).join("");
const TATWEEL = String.fromCharCode(0x0640);
const injectTatweel = (s: string) => (s.length > 1 ? s[0] + TATWEEL + s.slice(1) : s);

// ── pure normalizer ────────────────────────────────────────────────────────────────────────────
function asciiHeadersUnchangedExceptCaseAndSpace() {
  assert.equal(normalizeHeaderKey("ITEM_CODE"), "item_code");
  assert.equal(normalizeHeaderKey("  Item   Code "), "item code"); // trim + collapse whitespace
  assert.equal(normalizeHeaderKey("QTY"), "qty");
}

function foldsArabicAndEasternDigits() {
  assert.equal(foldArabicDigits(arabicIndic("12345")), "12345");
  // Eastern-Arabic / Persian digits (U+06F0+)
  const eastern = "12".split("").map((d) => String.fromCharCode(0x06f0 + Number(d))).join("");
  assert.equal(foldArabicDigits(eastern), "12");
}

function codeKeysFoldArabicDigits() {
  assert.equal(normalizeCodeKey(arabicIndic("12")), "12");
  assert.equal(numericCanonicalKey(arabicIndic("0001502")), "1502"); // leading zeros stripped after fold
  assert.equal(numericCanonicalKey("TE001"), null); // alphanumeric never collapsed
}

function stripsTatweelDiacriticsAndUnifiesAlefYa() {
  // tatweel-injected header equals its clean form
  const base = "abc";
  assert.equal(normalizeHeaderKey(base[0] + TATWEEL + base.slice(1)), "abc");
  // alef forms unify: hamza-on-alef (U+0623) -> bare alef (U+0627)
  assert.equal(normalizeHeaderKey(String.fromCharCode(0x0623)), normalizeHeaderKey(String.fromCharCode(0x0627)));
  // alef maqsura (U+0649) -> ya (U+064A)
  assert.equal(normalizeHeaderKey(String.fromCharCode(0x0649)), normalizeHeaderKey(String.fromCharCode(0x064a)));
}

// ── engine: deep scan + worksheet selection (ASCII EG-BR fixture) ─────────────────────────────────
function buildSheet(wb: ExcelJS.Workbook, name: string, rows: string[][]) {
  const ws = wb.addWorksheet(name);
  for (const r of rows) ws.addRow(r);
  return ws;
}

function deepHeaderRowIsFound() {
  const eg = rawProfileForDistributor("EG-BR");
  assert.ok(eg, "EG-BR profile must exist");
  const headerRow = ["TO_COMPANY_ENTITY_NAME", "QTY", "ITEM_NAME_ENG", "TO_COMPANY_ENTITY_CODE", "CARD_DATE", "ITEM_CODE"];
  const wb = new ExcelJS.Workbook();
  // 12 preamble/banner rows (single stray cell each) push the real header to row 13 — past the old 10.
  const preamble = Array.from({ length: 12 }, (_, i) => [`note ${i + 1}`]);
  const ws = buildSheet(wb, "Data", [...preamble, headerRow, ["x", "5", "PROD", "60229", "2026-05-01", "3116"]]);
  assert.ok(HEADER_SCAN_ROWS >= 13, "scan depth must reach row 13");
  const hm = buildHeaderMap(ws, eg!);
  assert.equal(hm.headerRow, 13);
  assert.ok(hm.col.has(normalizeHeaderKey("ITEM_CODE")));
  assert.ok(hm.col.has(normalizeHeaderKey("TO_COMPANY_ENTITY_CODE")));
}

function picksTheDataWorksheetNotTheCover() {
  const eg = rawProfileForDistributor("EG-BR")!;
  const wb = new ExcelJS.Workbook();
  // Sheet 1 is a cover/summary with NO known headers; sheet 2 carries the real EG-BR header.
  buildSheet(wb, "Cover", [["SATO PHARMA"], ["Monthly report"], ["generated"]]);
  const data = buildSheet(wb, "Sales", [["ITEM_CODE", "ITEM_NAME_ENG", "QTY", "TO_COMPANY_ENTITY_CODE", "CARD_DATE"], ["3116", "PROD", "5", "60229", "2026-05-01"]]);
  const picked = pickBestSheet(wb, eg);
  assert.equal(picked?.name, data.name);
}

// ── prime directive: importer + strict gate + detector all agree on a tatweel'd Arabic header ──────
async function allThreeReadersAgreeOnArabicHeader() {
  const mc = rawProfileForDistributor("MC");
  assert.ok(mc, "MC profile must exist");
  const headerTexts = [
    mc!.productCodeColumns?.[0],
    mc!.productNameColumns?.[0],
    injectTatweel(mc!.qtyColumns[0]), // qty header with a tatweel inserted
    mc!.dateColumns?.[0],
    mc!.customerCodeColumns?.[0],
  ].filter((v): v is string => Boolean(v));

  // (1) importer: buildHeaderMap maps the tatweel'd qty column
  const wb = new ExcelJS.Workbook();
  const ws = buildSheet(wb, "MC", [headerTexts, headerTexts.map(() => "1")]);
  const hm = buildHeaderMap(ws, mc!);
  assert.ok(hm.col.has(normalizeHeaderKey(mc!.qtyColumns[0])), "qty header must map despite tatweel");

  // (2) strict gate: header validation passes
  const validation = validateSheetHeaders(ws, mc!, RAW_DISTRIBUTOR_PROFILES);
  assert.equal(validation.valid, true, "strict gate must accept the Arabic header");

  // (3) detector: auto-detect resolves to MC
  const detProfiles = buildDetectionProfiles(await listEditableProfiles());
  const detection = detectDistributor(headerTexts, detProfiles);
  assert.equal(detection.best?.distributorCode, "MC");
}

export async function runDistributorHeaderNormalizationTests() {
  asciiHeadersUnchangedExceptCaseAndSpace();
  foldsArabicAndEasternDigits();
  codeKeysFoldArabicDigits();
  stripsTatweelDiacriticsAndUnifiesAlefYa();
  deepHeaderRowIsFound();
  picksTheDataWorksheetNotTheCover();
  await allThreeReadersAgreeOnArabicHeader();
}
