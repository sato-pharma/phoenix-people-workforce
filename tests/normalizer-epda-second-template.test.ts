import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import { secondLayoutDetectionProfiles } from "@/lib/sales/distributor-detection";
import { detectDistributor, type DetectionProfile } from "@/lib/sales/normalizer/detect-distributor";
import { SECOND_TEMPLATES, salesDistributorCode, withSecondTemplates } from "@/lib/sales/normalizer/distributor-templates";
import { normalizeRows, pickBestSheet, profileForWorkbook, validateSheetHeaders } from "@/lib/sales/normalizer/engine";
import { RAW_DISTRIBUTOR_PROFILES, SECOND_LAYOUT_PROFILES, rawProfileForDistributor } from "@/lib/sales/normalizer/profiles";
import { normalizeAliasKey, normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import { buildRawDistributorTemplate } from "@/lib/sales/raw-template";
import type { Crosswalks, DistributorProfile } from "@/lib/sales/normalizer/types";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// EPDA's October 2026 books wear a new layout, and the old one stays readable.
//
// The owner, 2026-11-04: "call this epda pharmacies 2 and epda bulk 2 if i used normal templete or
// this temeplete in either way sales disrb is ebda pharmacies or bulk". Three things are at risk:
//   • the sales must land under EP-BK or EP-PHS, never under a template's own code and never under the
//     separate source EP ("epda"), whose headers are the same as the new layout's;
//   • SalesOrReturnBonus is a count beside the paid units, so a bonus must not drop the paid units;
//   • the old layout, with its month-first dates and is_bonus flag, must read exactly as before.
// ─────────────────────────────────────────────────────────────────────────────

const BRICK = "B133-5";
const PRODUCT = "IV001";
const PRODUCT_SHEET_NAME = "ايفيرونك شراب 100 مل -45ج";
const PRICE = 30.375;
const CUSTOMER = "1137935";
const TERRITORY = "اسيوط";

const NEW_HEADERS = ["", "BranchID", "branchName", "Transdate", "TerritoryName", "AccountSerial", "AccountName", "Address", "ProductSerial", "ProductName", "SalesOrReturnQty", "SalesOrReturnBonus", "TrxNumber", "UnitSalesPrice", "LineValue", "Distributor"];
const OLD_HEADERS = ["class_code", "class_name", "qnt", "inv_date", "cust_code", "cust_name", "cust_address", "is_bonus"];

function crosswalks(): Crosswalks {
  const aliases: Array<[string, string]> = ["EP-BK", "EP-PHS", "EP"].map((d) => [`${normalizeCodeKey(d)} ${normalizeAliasKey(PRODUCT_SHEET_NAME)}`, PRODUCT]);
  return {
    areaAliasByKey: new Map(),
    areaByCode: new Map(),
    brickById: new Map([[BRICK, {
      areaCode: "UE3", areaName: "Assuit 1", blockCode: "B133", brickId: BRICK, brickName: "Manfalut",
      regionCode: "UE", regionName: "Upper Egypt",
    }]]),
    customerBrickByCanonicalKey: new Map(),
    customerBrickByKey: new Map([[`${normalizeCodeKey("EP-BK")} ${normalizeCodeKey("5001")}`, BRICK]]),
    productAliasByKey: new Map(aliases),
    productByCanonicalCode: new Map(),
    productByCode: new Map([[PRODUCT, { productCode: PRODUCT, productName: "Ivyronc", factoryPrice: PRICE, line: "Pedia" }]]),
    regionAliasByKey: new Map(),
    regionByCode: new Map(),
    territoryAliasByKey: new Map([[normalizeAliasKey(TERRITORY), { targetType: "brick", targetCode: BRICK }]]),
  } as unknown as Crosswalks;
}

function bookOf(headers: string[], rows: unknown[][]): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(headers);
  rows.forEach((r) => sheet.addRow(r));
  return workbook;
}

const newRow = (qty: number, bonus: number, day: number, lineValue: number): unknown[] => [
  "EPDA SALES SHEET FOR AS ساتو فارما", 1, "ebda", new Date(Date.UTC(2026, 9, day, 13, 6, 48)), TERRITORY, CUSTOMER, "الناصر - اسيوط", "شارع الجلاء", "18812737", PRODUCT_SHEET_NAME, qty, bonus, "261000434", 33.75, lineValue, "epda",
];

const newBook = () => bookOf(NEW_HEADERS, [
  newRow(100, 0, 18, 3375),
  newRow(120, 12, 19, 4050),
  newRow(0, 12, 20, 0),
  newRow(-40, 0, 29, -1350),
]);

function real(code: string): DistributorProfile {
  const p = rawProfileForDistributor(code);
  assert.ok(p, `the ${code} profile must exist — this test reads the real one`);
  return p;
}

function eitherTemplateLandsUnderTheRealDistributor() {
  for (const code of ["EP-BK", "EP-PHS"]) {
    const workbook = newBook();
    const profile = profileForWorkbook(workbook, real(code));
    assert.notEqual(profile, real(code), `${code}: a sheet in the new layout is read through the second template`);
    assert.equal(profile.distributorCode, code, `${code}: the second template keeps the real distributor's code`);
    assert.equal(profile.distributorName, real(code).distributorName, `${code}: and its name, because the batch is filed under it`);

    const sheet = pickBestSheet(workbook, profile);
    assert.ok(sheet);
    assert.equal(validateSheetHeaders(sheet, profile, []).valid, true);
    const result = normalizeRows(sheet, profile, crosswalks());
    assert.equal(result.exceptions.length, 0, `${code}: every row is coded`);
    assert.equal(result.coded.length, 4, `${code}: no row is skipped, the title column and a bonus included`);
    for (const row of result.coded) {
      assert.equal(row.distributorCode, code, `${code}: every row is stamped with the real distributor`);
      assert.equal(row.invoiceDate, "2026-10", `${code}: the month comes from the date cell`);
      assert.equal(row.brickId, BRICK, `${code}: the place comes from EPDA's own territory column`);
    }
    assert.equal(result.coded[0].invoiceDay, "2026-10-18", `${code}: the exact day is kept`);
  }
}

function aBonusNeverDropsPaidUnitsAndAReturnStaysNegative() {
  const profile = profileForWorkbook(newBook(), real("EP-BK"));
  const sheet = pickBestSheet(newBook(), profile);
  assert.ok(sheet);
  const { coded, ignoredRows } = normalizeRows(sheet, profile, crosswalks());
  assert.deepEqual(coded.map((r) => r.qty), [100, 120, 0, -40], "paid units as the file has them: a bonus of 12 drops nothing and adds nothing");
  assert.equal(ignoredRows.length, 0, "no row is skipped as free goods");
  assert.deepEqual(coded.map((r) => r.value), [100 * PRICE, 120 * PRICE, 0, -40 * PRICE], "value is units x factory price, never the sheet's LineValue");
  assert.ok(coded.every((r) => r.bonusQty === 0), "the bonus is never carried as units");
  assert.equal(coded[1].rawRow.SalesOrReturnBonus, "12", "the cell is kept as sent, for the audit trail");

  for (const p of SECOND_LAYOUT_PROFILES) {
    assert.equal(p.bonusColumns?.length ?? 0, 0, `${p.distributorCode}: a bonus count must never be mapped as a free-goods flag`);
  }
}

function theOldTemplateStillReadsAsBefore() {
  for (const code of ["EP-BK", "EP-PHS"]) {
    const workbook = bookOf(OLD_HEADERS, [
      ["IV1", PRODUCT_SHEET_NAME, 100, "9/5/2026", "5001", "Nour", "Marg", 0],
      ["IV1", PRODUCT_SHEET_NAME, 10, "9/5/2026", "5001", "Nour", "Marg", 1],
    ]);
    const profile = profileForWorkbook(workbook, real(code));
    assert.equal(profile, real(code), `${code}: an old-layout sheet keeps the old template`);
    if (code !== "EP-BK") continue;
    const sheet = pickBestSheet(workbook, profile);
    assert.ok(sheet);
    const result = normalizeRows(sheet, profile, crosswalks());
    assert.deepEqual(result.coded.map((r) => [r.qty, r.invoiceDay]), [[100, "2026-09-05"]], "month-first dates still read, and an is_bonus line is still skipped");
    assert.deepEqual(result.ignoredRows.map((r) => r.reason), ["bonus"]);
  }
}

function aSheetThatFitsNeitherIsStillRefused() {
  const workbook = bookOf(["Foo", "Bar", "Baz"], [["1", "2", "3"]]);
  const profile = profileForWorkbook(workbook, real("EP-BK"));
  assert.equal(profile, real("EP-BK"), "the refusal is against the old template");
  const sheet = pickBestSheet(workbook, profile);
  assert.ok(sheet);
  assert.equal(validateSheetHeaders(sheet, profile, []).valid, false);
}

function thePlainEpdaSourceIsUntouched() {
  const workbook = newBook();
  assert.equal(profileForWorkbook(workbook, real("EP")), real("EP"), "EP has no second template");
  assert.equal(real("EP").distributorCode, "EP");
  const sheet = pickBestSheet(workbook, real("EP"));
  assert.ok(sheet);
  assert.ok(normalizeRows(sheet, real("EP"), crosswalks()).coded.every((r) => r.distributorCode === "EP"), "a file picked as epda stays epda");
}

function theTemplateCodesAreOnlyEverAChoiceOnAScreen() {
  assert.equal(salesDistributorCode("EP-BK-2"), "EP-BK");
  assert.equal(salesDistributorCode("ep-phs-2"), "EP-PHS");
  assert.equal(salesDistributorCode("EP-BK"), "EP-BK");
  assert.equal(salesDistributorCode("EP"), "EP");

  assert.deepEqual(SECOND_TEMPLATES.map((t) => t.name), ["EPDA Bulk 2", "EPDA Pharmacies 2"]);
  const codes = new Set(RAW_DISTRIBUTOR_PROFILES.map((p) => p.distributorCode));
  for (const t of SECOND_TEMPLATES) {
    assert.equal(codes.has(t.code), false, `${t.code} must never be a distributor`);
    assert.equal(codes.has(t.distributorCode), true, `${t.name} must name a real distributor`);
  }
  assert.ok(SECOND_LAYOUT_PROFILES.every((p) => codes.has(p.distributorCode)), "a second layout is only ever stamped with a real code");

  const offered = withSecondTemplates([{ code: "EP", name: "epda" }, { code: "EP-BK", name: "EPDA-BULK" }, { code: "EP-PHS", name: "EPDA-Pharmacies" }]);
  assert.deepEqual(
    offered.map((o) => o.name),
    ["epda", "EPDA-BULK", "EPDA Bulk 2", "EPDA-Pharmacies", "EPDA Pharmacies 2"],
    "each template sits right after its distributor, and the old names stay",
  );
}

function detectionDoesNotSendTheseBooksToPlainEpda() {
  const ep = real("EP");
  const epDetection: DetectionProfile = {
    distributorCode: "EP",
    distributorName: ep.distributorName,
    requiredGroups: [[...(ep.productCodeColumns ?? []), ...(ep.productNameColumns ?? [])], ep.qtyColumns, ep.customerCodeColumns ?? []],
    optionalGroups: [ep.customerNameColumns ?? [], ep.customerAddressColumns ?? [], ep.valueColumns ?? [], ep.discountColumns ?? [], ep.dateColumns ?? []],
  };
  const headers = NEW_HEADERS.filter(Boolean);
  assert.equal(detectDistributor(headers, [epDetection]).best?.distributorCode, "EP", "without the templates the detector names epda, the trap this guards");
  const result = detectDistributor(headers, [epDetection, ...secondLayoutDetectionProfiles()]);
  assert.equal(result.best, null, "the three tie, so no distributor is named");
  assert.equal(result.ambiguous, true);
  assert.notEqual(result.confidence, "high", "the commit's cross-check only warns on high confidence");
  assert.equal(
    detectDistributor([...headers, "Discount%"], [epDetection, ...secondLayoutDetectionProfiles()]).best?.distributorCode,
    "EP",
    "a real epda file carries Discount%, so it is still named",
  );
}

async function theTemplateDownloadGivesThePickedLayout() {
  const second = await buildRawDistributorTemplate("EP-BK-2");
  assert.equal(second.distributorName, "EPDA-BULK", "the sheet is stamped with the real distributor");
  assert.ok(second.headers.includes("SalesOrReturnQty"), "EPDA Bulk 2 downloads the new layout");
  assert.equal(second.headers.includes("qnt"), false, "and not the old one");
}

function theRecognizerAndBothPickersGoThroughIt() {
  const recognize = stripComments(readFileSync("src/lib/sales/recognize.ts", "utf8"));
  assert.match(recognize, /profile = profileForWorkbook\(workbook, profile\)/, "the recognizer lets the sheet choose the template");
  assert.equal(recognize.includes("salesDistributorCode"), false, "a template's code posted by hand is refused, never quietly swapped, because the batch header would store it");
  assert.equal(rawProfileForDistributor("EP-BK-2"), null, "so it has no profile to be recognized through");

  const learn = stripComments(readFileSync("src/lib/sales/normalizer/service.ts", "utf8"));
  assert.match(learn, /const profile = profileForWorkbook\(workbook, storedProfile\)/, "a cleaned new-layout sheet still teaches the dictionary");

  const normalizer = stripComments(readFileSync("src/components/sales/normalizer-workspace.tsx", "utf8"));
  assert.match(normalizer, /const distributorCode = salesDistributorCode\(pickedSource\)/, "the Source Normalizer posts the real distributor");

  const upload = stripComments(readFileSync("src/components/sales/sales-upload-workspace.tsx", "utf8"));
  assert.match(upload, /code: salesDistributorCode\(picked\.code\)/, "Sales Upload posts the real distributor");
  assert.match(upload, /<DistributorWorkspaceShell distributors=\{withSecondTemplates\(distributors\)\}>/, "Sales Upload offers the templates");
}

export async function runNormalizerEpdaSecondTemplateTests() {
  await theTemplateDownloadGivesThePickedLayout();
  eitherTemplateLandsUnderTheRealDistributor();
  aBonusNeverDropsPaidUnitsAndAReturnStaysNegative();
  theOldTemplateStillReadsAsBefore();
  aSheetThatFitsNeitherIsStillRefused();
  thePlainEpdaSourceIsUntouched();
  theTemplateCodesAreOnlyEverAChoiceOnAScreen();
  detectionDoesNotSendTheseBooksToPlainEpda();
  theRecognizerAndBothPickersGoThroughIt();
}
