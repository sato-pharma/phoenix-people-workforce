import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import {
  PHOENIX_TEMPLATE_CODE,
  PHOENIX_TEMPLATE_COL,
  PHOENIX_TEMPLATE_COLUMNS,
  PHOENIX_TEMPLATE_DISTRIBUTORS_SHEET,
  PHOENIX_TEMPLATE_PRODUCTS_SHEET,
  PHOENIX_TEMPLATE_SHEET,
  detectTemplateDistributor,
  isPhoenixTemplateCode,
  phoenixTemplateProfile,
} from "../src/lib/sales/normalizer/phoenix-template.ts";
import { buildPhoenixTemplateWorkbook } from "../src/lib/sales/normalizer/phoenix-template-workbook.ts";
import { normalizeRows } from "../src/lib/sales/normalizer/engine.ts";
import { distinctUnknowns } from "../src/lib/sales/normalizer/mapping.ts";
import { mappingLeft, mappingLeftPhrase, needsMappingTabLabel, stillNeedMappingSentence } from "../src/lib/sales/normalizer/mapping-left.ts";
import { SECOND_TEMPLATES } from "../src/lib/sales/normalizer/distributor-templates.ts";
import { listNormalizerDistributors, listNormalizerSourceOptions } from "../src/lib/sales/normalizer/service.ts";
import { PREVIEW_UNKNOWN_LIMIT, recognitionErrorMessage, summarizePreview } from "../src/lib/sales/recognize.ts";
import type { Crosswalks, NormalizeException, NormalizeResult } from "../src/lib/sales/normalizer/types.ts";

// The Phoenix UNIVERSAL upload template: one sheet the business fills for any distributor, uploaded
// through the same Source Normalizer pipeline every distributor file goes through.
//
// What these tests pin is the promise the screen makes to the person filling it in:
//   1. the obligatory columns are the ones the owner named, and the two helper columns exist;
//   2. the template sits BESIDE the distributors in the picker and never leaks into the profiled
//      distributor list the Sales Upload page builds from;
//   3. a filled sheet resolves to a REAL distributor, so every mapping, the customer crosswalk and
//      the batch are filed under that distributor and not under the sentinel;
//   4. the EMITTED workbook really carries the dropdowns and the auto-code formulas (asserted on the
//      bytes ExcelJS writes, never on the source that wrote them);
//   5. one click surfaces up to 2,000 unknowns per kind, and says how many there really are.

const DISTRIBUTORS = [
  { distributorCode: "PS", distributorName: "Overseas" },
  { distributorCode: "IB", distributorName: "Ibnsina" },
  { distributorCode: "EP", distributorName: "El Ezaby" },
];

// Nothing resolves against these, which is the point: an engine pass over an empty dictionary sends
// every row it READS to `exceptions` carrying that row's number, so a test can say exactly which
// rows a pass touched. (`loadCrosswalks` needs the live masters; these maps need nothing.)
const EMPTY_CROSSWALKS: Crosswalks = {
  areaAliasByKey: new Map(),
  areaByCode: new Map(),
  brickById: new Map(),
  customerBrickByCanonicalKey: new Map(),
  customerBrickByKey: new Map(),
  productAliasByKey: new Map(),
  productByCanonicalCode: new Map(),
  productByCode: new Map(),
  regionAliasByKey: new Map(),
  regionByCode: new Map(),
  territoryAliasByKey: new Map(),
};

const PRODUCTS = [
  { productCode: "LA001", productName: "Lacto Advanced", line: "Pedia" },
  { productCode: "CN002", productName: "Cerebro", line: "CNS" },
];

/** A bare sheet in the template's shape: two banner rows, headers on row 3, data under them. */
function templateSheet(headers: string[], rows: unknown[][]): ExcelJS.Worksheet {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(PHOENIX_TEMPLATE_SHEET);
  ws.addRow(["Phoenix Workforce — Sales upload template"]);
  ws.addRow([]);
  ws.addRow(headers);
  rows.forEach((r) => ws.addRow(r));
  return ws;
}

const FULL_HEADERS = PHOENIX_TEMPLATE_COLUMNS.map((c) => c.header);

/** One filled row, in column order, for the distributor named. */
function row(distributorName: string, customerCode: string): unknown[] {
  const cells = new Array<unknown>(PHOENIX_TEMPLATE_COLUMNS.length).fill("");
  cells[PHOENIX_TEMPLATE_COL.distributorName - 1] = distributorName;
  cells[PHOENIX_TEMPLATE_COL.invoiceDate - 1] = "05-09-2026";
  cells[PHOENIX_TEMPLATE_COL.customerCode - 1] = customerCode;
  cells[PHOENIX_TEMPLATE_COL.customerName - 1] = "Saleh Pharmacy";
  cells[PHOENIX_TEMPLATE_COL.customerAddress - 1] = "12 Tahrir Street, Dokki";
  cells[PHOENIX_TEMPLATE_COL.productName - 1] = "Lacto Advanced";
  cells[PHOENIX_TEMPLATE_COL.quantity - 1] = 12;
  return cells;
}

// ── 1. The columns the owner named ───────────────────────────────────────────────────────────────
function theObligatoryColumnsAreTheOnesHeNamed() {
  const required = PHOENIX_TEMPLATE_COLUMNS.filter((c) => c.required).map((c) => c.header);
  for (const must of ["Distributor Name", "Customer Name", "Customer Address", "Customer Code"]) {
    assert.ok(required.includes(must), `${must} must be obligatory on the Phoenix template`);
  }
  // A sale is a product, a quantity and a date — without them a row cannot be coded at all.
  for (const must of ["Invoice Date", "Product Name", "Quantity"]) {
    assert.ok(required.includes(must), `${must} must be obligatory on the Phoenix template`);
  }

  // The two auto columns are filled by formula, so they are never obligatory for the person filling in.
  assert.deepEqual(PHOENIX_TEMPLATE_COLUMNS.filter((c) => c.kind === "auto").map((c) => c.header), ["Distributor Code", "Product Code"]);
  assert.equal(PHOENIX_TEMPLATE_COLUMNS.filter((c) => c.kind === "auto" && c.required).length, 0);

  // Exactly two helper columns — "in case if i have any helper" (owner).
  assert.deepEqual(PHOENIX_TEMPLATE_COLUMNS.filter((c) => c.kind === "helper").map((c) => c.header), ["Helper 1", "Helper 2"]);

  // Every column carries a note; the person filling it in reads them as cell comments.
  for (const c of PHOENIX_TEMPLATE_COLUMNS) assert.ok(c.note.length > 10, `${c.header} needs a note`);

  // The index map and the column order must not drift apart.
  assert.equal(PHOENIX_TEMPLATE_COLUMNS[PHOENIX_TEMPLATE_COL.customerAddress - 1].header, "Customer Address");
  assert.equal(PHOENIX_TEMPLATE_COLUMNS[PHOENIX_TEMPLATE_COL.quantity - 1].header, "Quantity");
  assert.equal(PHOENIX_TEMPLATE_COLUMNS.length, 12);
}

// ── 2. Beside the distributors, never inside them ────────────────────────────────────────────────
function thePickerOffersItBesideTheDistributors() {
  const options = listNormalizerSourceOptions();
  assert.equal(options[0].code, PHOENIX_TEMPLATE_CODE, "the template is offered first in the Source Normalizer picker");
  assert.ok(options.length > 1, "the distributors are still offered");
  // EPDA Bulk 2 and EPDA Pharmacies 2 stand beside their distributors, which are all still offered.
  assert.deepEqual(options.slice(1).filter((o) => !SECOND_TEMPLATES.some((t) => t.code === o.code)), listNormalizerDistributors());

  // The Sales Upload page feeds listNormalizerDistributors() into profiledDistributorCodes. A
  // sentinel there would advertise a distributor that does not exist.
  assert.equal(listNormalizerDistributors().some((d) => isPhoenixTemplateCode(d.code)), false);
}

function theSentinelIsRecognisedHowEverItIsWritten() {
  assert.equal(isPhoenixTemplateCode(PHOENIX_TEMPLATE_CODE), true);
  assert.equal(isPhoenixTemplateCode(" phx-template "), true);
  assert.equal(isPhoenixTemplateCode("PS"), false);
  assert.equal(isPhoenixTemplateCode(""), false);
  assert.equal(isPhoenixTemplateCode(null), false);
  assert.equal(isPhoenixTemplateCode(undefined), false);
}

// ── 3. The profile carries the REAL distributor ──────────────────────────────────────────────────
function theProfileIsTheTemplatesHeadersUnderTheRealDistributor() {
  const profile = phoenixTemplateProfile("ps", "Overseas");
  assert.equal(profile.distributorCode, "PS", "the profile is filed under the real distributor code");
  assert.equal(profile.distributorName, "Overseas");
  assert.deepEqual(profile.customerAddressColumns, ["Customer Address"]);
  assert.deepEqual(profile.qtyColumns, ["Quantity"]);
  assert.equal(profile.valueSource, "recompute", "value is units x factory price, as for every distributor");
  assert.equal(profile.dateFormat, "day-first");

  // The four headers no distributor's own export carries: a template file out-scores every real
  // profile, so it can never draw a "this looks like another distributor's file" warning.
  assert.deepEqual(profile.fingerprintColumns, ["Distributor Name", "Distributor Code", "Helper 1", "Helper 2"]);
}

// ── 4. Reading the distributor off a filled sheet ────────────────────────────────────────────────
function theSheetNamesItsDistributorAndTheSystemResolvesIt() {
  const ws = templateSheet(FULL_HEADERS, [row("Overseas", "10021"), row("", "10022"), row("overseas ", "10023")]);
  const found = detectTemplateDistributor(ws, DISTRIBUTORS);
  assert.equal(found.ok, true);
  if (!found.ok) return;
  assert.equal(found.distributors.length, 1, "one distributor named, one part");
  const [only] = found.distributors;
  assert.equal(only.distributorCode, "PS");
  assert.equal(only.distributorName, "Overseas");
  // The middle row names no distributor at all and the file is still accepted: a blank Distributor
  // Name carries the name above it down, so only the rows the person typed one on are counted here.
  assert.equal(only.namedRows, 2);
  // All three rows are still SALES, and all three belong to Overseas.
  assert.equal(only.dataRows, 3);
  assert.deepEqual([...found.distributorByRow.entries()], [[4, "PS"], [5, "PS"], [6, "PS"]]);
}

function aTypedCodeStillResolvesWhenTheNameIsBlank() {
  const cells = row("", "10024");
  cells[PHOENIX_TEMPLATE_COL.distributorCode - 1] = "ib";
  const found = detectTemplateDistributor(templateSheet(FULL_HEADERS, [cells]), DISTRIBUTORS);
  assert.equal(found.ok, true);
  if (found.ok) assert.equal(found.distributors[0].distributorCode, "IB");
}

function anUnknownDistributorIsRefusedWithItsNameInTheMessage() {
  const found = detectTemplateDistributor(templateSheet(FULL_HEADERS, [row("Al Nahdi", "10025")]), DISTRIBUTORS);
  assert.equal(found.ok, false);
  if (found.ok) return;
  assert.ok(found.message.includes("Al Nahdi"), "the refusal must name what the sheet said");
  assert.ok(!found.message.includes("…"), "no ellipsis (owner rule)");
}

// The owner's rule, 2026-09-18: one filled template may carry as many distributors as he likes.
function severalDistributorsInOneFileAreEachTheirOwnBatch() {
  const found = detectTemplateDistributor(
    templateSheet(FULL_HEADERS, [
      row("Overseas", "1"),   // row 4 - names Overseas
      row("", "2"),           // row 5 - names nobody, so it is still Overseas
      row("Ibnsina", "3"),    // row 6 - the next block starts
      row("", "4"),           // row 7 - still Ibnsina
      row("Overseas", "5"),   // row 8 - back to Overseas; the file is not required to be in order
    ]),
    DISTRIBUTORS,
  );
  assert.equal(found.ok, true, "several distributors in one file are accepted, not refused");
  if (!found.ok) return;

  // In the order the sheet first names them, never alphabetically or by code.
  assert.deepEqual(found.distributors.map((d) => d.distributorName), ["Overseas", "Ibnsina"]);
  assert.deepEqual(found.distributors.map((d) => d.distributorCode), ["PS", "IB"]);
  // Overseas owns rows 4, 5 and 8; Ibnsina owns 6 and 7. The carried rows count as DATA for the
  // distributor above them, and as NAMED for nobody.
  assert.deepEqual(found.distributors.map((d) => d.dataRows), [3, 2]);
  assert.deepEqual(found.distributors.map((d) => d.namedRows), [2, 1]);
  assert.deepEqual([...found.distributorByRow.entries()], [[4, "PS"], [5, "PS"], [6, "IB"], [7, "IB"], [8, "PS"]]);
}

// The one thing several distributors make ambiguous: a sale sitting above every name.
function salesAboveTheFirstNameAreRefusedOnlyWhenTheFileNamesSeveral() {
  const orphaned = detectTemplateDistributor(
    templateSheet(FULL_HEADERS, [row("", "1"), row("Overseas", "2"), row("Ibnsina", "3")]),
    DISTRIBUTORS,
  );
  assert.equal(orphaned.ok, false);
  // The guard runs the RIGHT way round: the refusal is what this case is about, so bail only if
  // the file was ACCEPTED. Inverted, it returned before every assertion below and proved nothing.
  if (orphaned.ok) return;
  assert.ok(/row 4\b/.test(orphaned.message), `the refusal must say WHICH row: ${orphaned.message}`);
  assert.ok(!orphaned.message.includes("…"), "no ellipsis (owner rule)");

  // With ONE distributor in the file there is nothing to be ambiguous about, so the same row is
  // simply that distributor's - which is how a template with the name typed once has always worked.
  const single = detectTemplateDistributor(
    templateSheet(FULL_HEADERS, [row("", "1"), row("Overseas", "2")]),
    DISTRIBUTORS,
  );
  assert.equal(single.ok, true);
  if (!single.ok) return;
  assert.equal(single.distributors[0].dataRows, 2);
  assert.equal(single.distributorByRow.get(4), "PS", "the row above the name still belongs to it");
}

// What the recognizer actually does with that map: one pass of the engine per distributor, over
// that distributor's own rows. The crosswalks are empty on purpose - nothing resolves, so every
// scanned row lands in `exceptions` carrying its sheet row number, which is exactly the evidence
// this needs: WHICH rows the pass read, and no others.
function theEngineReadsOnlyOneDistributorsRowsWhenAsked() {
  const ws = templateSheet(FULL_HEADERS, [row("Overseas", "10021"), row("Ibnsina", "10022"), row("", "10023")]);
  const found = detectTemplateDistributor(ws, DISTRIBUTORS);
  assert.equal(found.ok, true);
  if (!found.ok) return;

  const pass = (code: string, name: string) =>
    normalizeRows(ws, phoenixTemplateProfile(code, name), EMPTY_CROSSWALKS, {
      includeRow: (r) => found.distributorByRow.get(r) === code,
    });

  const overseas = pass("PS", "Overseas");
  const ibnsina = pass("IB", "Ibnsina");
  // How many rows each pass READ is the whole point: three sales in the sheet, one of them read for
  // Overseas, and two for Ibnsina - its own row, and the row below it that carried its name down.
  assert.equal(overseas.summary.totalRows, 1, "Overseas' pass reads only its own row");
  assert.equal(ibnsina.summary.totalRows, 2, "Ibnsina keeps the row that carried its name down");
  // And nothing crossed over: no row Overseas reported sits in Ibnsina's block, or the other way.
  assert.deepEqual(overseas.exceptions.map((e) => e.rawRowNumber).filter((n) => n !== 4), []);
  assert.deepEqual(ibnsina.exceptions.map((e) => e.rawRowNumber).filter((n) => n !== 5 && n !== 6), []);
}

function anEmptyOrShapelessSheetIsRefusedInWords() {
  const empty = detectTemplateDistributor(templateSheet(FULL_HEADERS, []), DISTRIBUTORS);
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.ok(/No distributor is named/i.test(empty.message));

  // Somebody else's export, uploaded on the template option by mistake.
  const foreign = templateSheet(["Item Code", "Item Name", "Qty", "Client Code"], [["LA001", "Lacto", 3, "X1"]]);
  const wrong = detectTemplateDistributor(foreign, DISTRIBUTORS);
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.ok(/no "Distributor Name" column/i.test(wrong.message));
}

// ── 5. The EMITTED workbook, not the code that wrote it ──────────────────────────────────────────
async function reopenTheTemplate() {
  const buffer = await buildPhoenixTemplateWorkbook({ distributors: DISTRIBUTORS, products: PRODUCTS, now: new Date("2026-09-18T09:00:00Z") });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
  return wb;
}

async function theDownloadedFileCarriesTheDropdownsAndTheAutoCodes() {
  const wb = await reopenTheTemplate();
  const ws = wb.getWorksheet(PHOENIX_TEMPLATE_SHEET);
  assert.ok(ws, "the data sheet is called Sales");

  // Headers on row 3, in the documented order (rows 1-2 are the banner).
  const headerRow = ws!.getRow(3);
  assert.deepEqual(
    PHOENIX_TEMPLATE_COLUMNS.map((_, i) => String(headerRow.getCell(i + 1).value ?? "")),
    FULL_HEADERS,
  );

  // The two auto columns are VLOOKUP formulas against the reference sheets, on the first data row.
  const distCode = ws!.getCell(4, PHOENIX_TEMPLATE_COL.distributorCode).value as { formula?: string } | null;
  assert.ok(distCode?.formula?.includes("VLOOKUP"), "Distributor Code is a formula, not a column to type in");
  assert.ok(distCode?.formula?.includes(PHOENIX_TEMPLATE_DISTRIBUTORS_SHEET));
  const productCode = ws!.getCell(4, PHOENIX_TEMPLATE_COL.productCode).value as { formula?: string } | null;
  assert.ok(productCode?.formula?.includes("VLOOKUP"));
  assert.ok(productCode?.formula?.includes(PHOENIX_TEMPLATE_PRODUCTS_SHEET));

  // Both pickers are real dropdowns on the emitted file.
  const nameDV = ws!.getCell(4, PHOENIX_TEMPLATE_COL.distributorName).dataValidation as { type?: string; formulae?: string[] } | undefined;
  assert.equal(nameDV?.type, "list");
  assert.ok(nameDV?.formulae?.[0]?.includes(PHOENIX_TEMPLATE_DISTRIBUTORS_SHEET));
  const prodDV = ws!.getCell(4, PHOENIX_TEMPLATE_COL.productName).dataValidation as { type?: string } | undefined;
  assert.equal(prodDV?.type, "list");

  // A customer code with leading zeros must survive the paste ("0001502731" stays itself).
  assert.equal(ws!.getCell(4, PHOENIX_TEMPLATE_COL.customerCode).numFmt, "@");

  // The reference tabs are deliberately NOT headed with the Sales sheet's column names, so the
  // sheet picker can never mistake a lookup tab for the data tab.
  for (const sheetName of [PHOENIX_TEMPLATE_DISTRIBUTORS_SHEET, PHOENIX_TEMPLATE_PRODUCTS_SHEET]) {
    const ref = wb.getWorksheet(sheetName);
    assert.ok(ref, `${sheetName} sheet is present`);
    const refHeaders = (ref!.getRow(1).values as unknown[]).slice(1).map((v) => String(v ?? ""));
    for (const h of refHeaders) assert.equal(FULL_HEADERS.includes(h), false, `${sheetName} must not reuse the Sales header "${h}"`);
  }

  // The dropdown really lists the distributors and the products it was built from.
  const distSheet = wb.getWorksheet(PHOENIX_TEMPLATE_DISTRIBUTORS_SHEET);
  const listed = [...DISTRIBUTORS].map((d) => d.distributorName).sort((a, b) => a.localeCompare(b));
  assert.ok(distSheet, "the Distributors reference sheet is present");
  assert.deepEqual(listed.map((_, i) => String(distSheet!.getCell(2 + i, 1).value ?? "")), listed);
}

async function afillOfTheRealFileResolvesItsDistributor() {
  // The round trip that matters: fill the file the user actually downloads (banner rows, formulas,
  // 1,000 pre-wired rows) and read the distributor back off it.
  const wb = await reopenTheTemplate();
  const ws = wb.getWorksheet(PHOENIX_TEMPLATE_SHEET);
  assert.ok(ws, "the data sheet is called Sales");
  ws!.getCell(4, PHOENIX_TEMPLATE_COL.distributorName).value = "El Ezaby";
  ws!.getCell(4, PHOENIX_TEMPLATE_COL.customerCode).value = "0001502731";
  ws!.getCell(5, PHOENIX_TEMPLATE_COL.customerCode).value = "0001502732";

  const found = detectTemplateDistributor(ws!, DISTRIBUTORS);
  assert.equal(found.ok, true, "a filled real template resolves its distributor");
  if (found.ok) {
    assert.equal(found.distributors.length, 1);
    assert.equal(found.distributors[0].distributorCode, "EP");
    assert.equal(found.distributors[0].distributorName, "El Ezaby");
    // Two filled rows out of a thousand pre-wired ones. Every other row carries dropdowns and live
    // VLOOKUP formulas, and NONE of them may be mistaken for a sale.
    assert.equal(found.distributors[0].dataRows, 2, "the pre-wired empty rows are not sales");
    assert.deepEqual([...found.distributorByRow.keys()], [4, 5]);
  }
}

// ── 6. One click surfaces the whole job, and says how big it is ──────────────────────────────────
function unmappedCustomer(i: number): NormalizeException {
  return {
    rawProduct: "",
    rawProductName: "",
    rawTerritory: "",
    rawCustomerCode: `C${i}`,
    rawCustomerName: `Pharmacy ${i}`,
    rawCustomerAddress: "Cairo",
    rawRowNumber: i + 4,
    reason: "brick",
  };
}

function thePreviewCarries2000UnknownsAndTellsTheTruthAboutTheRest() {
  // 500 was the old cap: a file with 3,000 unmapped pharmacies presented 500 as if that were all of
  // them, which is why one click only ever mapped a small number.
  assert.equal(PREVIEW_UNKNOWN_LIMIT, 2000);

  const exceptions = Array.from({ length: 2100 }, (_, i) => unmappedCustomer(i));
  const result: NormalizeResult = {
    coded: [],
    distributorCode: "PS",
    exceptions,
    ignoredRows: [],
    blankCustomerRows: [],
    customerBrickCorrections: [],
    summary: { brickResolved: 0, blankCustomerSkipped: 0, fullyCoded: 0, ignored: 0, productResolved: 0, totalRows: 2100 },
  };

  const preview = summarizePreview("PS", "Overseas", result, []);
  assert.equal(preview.unknownCustomers.length, PREVIEW_UNKNOWN_LIMIT);
  assert.equal(preview.unknownTotals?.customers, 2100, "the screen must be able to say 2,000 of 2,100");
  assert.equal(preview.distributorCode, "PS", "the preview carries the RESOLVED distributor back to every route");
}

function whatIsLeftToMapDropsAsPharmaciesAreSaved() {
  // The owner's file on 2026-09-18: a pharmacy list with no product on any row. He saved 1,487
  // pharmacies and the tab still read "2000 codes (28,800 rows)" — the cut list had refilled to 2,000
  // from the 3,348 still unmapped, and every product-less row counted as needing mapping. Here 2,100
  // pharmacies are still unmapped and 900 are mapped already.
  const stillUnmapped = Array.from({ length: 2100 }, (_, i): NormalizeException => ({ ...unmappedCustomer(i), reason: "both" }));
  const alreadyMapped = Array.from({ length: 900 }, (_, i): NormalizeException => ({ ...unmappedCustomer(5000 + i), reason: "product" }));
  const result: NormalizeResult = {
    coded: [],
    distributorCode: "PS",
    exceptions: [...stillUnmapped, ...alreadyMapped],
    ignoredRows: [],
    blankCustomerRows: [],
    customerBrickCorrections: [],
    summary: { brickResolved: 900, blankCustomerSkipped: 0, fullyCoded: 0, ignored: 0, productResolved: 0, totalRows: 3000 },
  };

  const preview = summarizePreview("PS", "Overseas", result, []);
  assert.equal(preview.unknownCustomers.length, PREVIEW_UNKNOWN_LIMIT, "the list itself still stops at 2,000");
  assert.equal(preview.unknownTotals.rows, 2100, "a mapped pharmacy's product-less row is not waiting on any mapping");
  const left = mappingLeft(preview);
  assert.deepEqual(left, { codes: 2100, pharmacies: 2100, products: 0, rows: 2100, territories: 0 });
  assert.equal(needsMappingTabLabel(preview), "Needs mapping — 2,100 pharmacies left (2,100 rows)", "the tab counts what is left, not the cut list and not every row");
  assert.equal(stillNeedMappingSentence(left), "2,100 pharmacies still need mapping.", "the line after Save says the true number too");

  // Once every pharmacy is mapped nothing is left, whatever the product-less rows and ignored items say.
  const done = summarizePreview("PS", "Overseas", { ...result, exceptions: alreadyMapped, summary: { ...result.summary, ignored: 12 } }, []);
  assert.equal(needsMappingTabLabel(done), "Needs mapping — nothing left (12 ignored)");
  assert.equal(stillNeedMappingSentence(mappingLeft(done)), "Everything is mapped now.");

  // A row counts once, and only when a mapping would unblock it.
  const rows = distinctUnknowns([
    { ...unmappedCustomer(1), rawProduct: "583450", reason: "product" },
    { ...unmappedCustomer(2), rawProduct: "583450", reason: "both" },
    { ...unmappedCustomer(3), reason: "unparseable_qty" },
    { ...unmappedCustomer(4), rawCustomerCode: "", reason: "brick" },
  ], []);
  assert.equal(rows.rowsNeedingMapping, 2, "an unknown product or place counts; a bad quantity or a row with nothing to map it by does not");

  assert.equal(mappingLeftPhrase({ pharmacies: 1, products: 2, territories: 1 }), "1 pharmacy, 2 products and 1 territory");
  assert.equal(stillNeedMappingSentence({ codes: 1, pharmacies: 1, products: 0, rows: 1, territories: 0 }), "1 pharmacy still needs mapping.");
}

// ── 7. Every refusal is a sentence, not a shrug ──────────────────────────────────────────────────
function aRefusalSaysWhatIsWrong() {
  assert.equal(
    recognitionErrorMessage({ status: "template_error", distributorName: "Phoenix template", message: "No distributor is named in this template." }),
    "No distributor is named in this template.",
    "a template refusal is already written for the user and must reach them verbatim",
  );

  const coded = recognitionErrorMessage({ status: "coded_sheet", distributorName: "Overseas" });
  assert.ok(/already a coded Phoenix sheet/i.test(coded));

  const header = recognitionErrorMessage({
    status: "header_error",
    distributorName: "Overseas",
    missingGroups: [{ label: "customer code", expected: ["Client Code"] }],
    observedHeaders: ["Item Code", "Qty"],
  });
  assert.ok(header.includes("Overseas"), "the refusal names the distributor");
  assert.ok(header.includes("Client Code"), "and the column it wanted");
  assert.ok(header.includes("Item Code"), "and the columns the file actually has");
}

export async function runSosPhoenixTemplateTests() {
  theObligatoryColumnsAreTheOnesHeNamed();
  thePickerOffersItBesideTheDistributors();
  theSentinelIsRecognisedHowEverItIsWritten();
  theProfileIsTheTemplatesHeadersUnderTheRealDistributor();
  theSheetNamesItsDistributorAndTheSystemResolvesIt();
  aTypedCodeStillResolvesWhenTheNameIsBlank();
  anUnknownDistributorIsRefusedWithItsNameInTheMessage();
  severalDistributorsInOneFileAreEachTheirOwnBatch();
  salesAboveTheFirstNameAreRefusedOnlyWhenTheFileNamesSeveral();
  theEngineReadsOnlyOneDistributorsRowsWhenAsked();
  anEmptyOrShapelessSheetIsRefusedInWords();
  await theDownloadedFileCarriesTheDropdownsAndTheAutoCodes();
  await afillOfTheRealFileResolvesItsDistributor();
  thePreviewCarries2000UnknownsAndTellsTheTruthAboutTheRest();
  whatIsLeftToMapDropsAsPharmaciesAreSaved();
  aRefusalSaysWhatIsWrong();
}
