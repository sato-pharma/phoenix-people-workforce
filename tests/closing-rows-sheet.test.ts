import assert from "node:assert/strict";

import {
  INVOICE_REF_KEYS,
  INVOICE_REF_SELECT,
  invoiceRefAbsence,
  invoiceRefOf,
} from "../src/lib/sales/closing-detail-invoice-ref.ts";
import {
  CLOSING_ROWS_COLUMN_FORMATS,
  CLOSING_ROWS_HEADERS,
  CLOSING_ROWS_SHEET_NAME,
  CLOSING_ROWS_WIDTHS,
  buildClosingRowsSheet,
  closingRowsSheetSpec,
} from "../src/lib/sales/closing-rows-sheet.ts";
import type { ClosingDetailRow } from "../src/lib/sales/monthly-closing-details.ts";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE ROWS TAB — every counted row of a closing, at invoice grain.
//
// Owner, 2026-10-13: "put the Rows tab in the premium closing download and in the ranking … I want
// the raw detailed sheet to be in the export rep ranking in monthly closing."
//
// What is pinned here is the ARRANGEMENT and the three rules that make the tab safe to hand out:
// its total is the closing's own figure, units are never totalled across products, and El Qema
// leaves no trace on it for ANY reader. The emitted-file half — that the tab really lands in the
// rep-ranking workbook, before Trust, with the distributor NAMED — is in
// tests/closing-rep-ranking.test.ts, where the workbook is actually built.
//
// No database: every row here is a fixture, so a failure names a broken rule and never an outage.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const PERIOD = "2026-09";

/** A complete detail row — every field set, so nothing a sheet prints can be accidentally undefined. */
function detailRow(overrides: Partial<ClosingDetailRow> = {}): ClosingDetailRow {
  return {
    areaCode: "DK1",
    areaMismatch: false,
    areaName: "Dakahlia 1",
    blockCode: "B1",
    bonusQty: 0,
    brickId: "B184-4",
    brickName: "Mansoura",
    brickUnmapped: false,
    clientAddress: "12 Gomhoria Street, Mansoura",
    clientCode: "C1",
    clientName: "Sayed Pharmacy",
    discount: 0,
    distributorCode: "IS",
    effectiveUnits: 10,
    evenSplitApplied: false,
    exclusions: [],
    factoryPrice: 100,
    family: "RF",
    id: 1_490_398,
    includedInClosing: true,
    invoiceDate: "2026-09-07",
    invoicePeriod: PERIOD,
    invoiceRef: "0/1/1/18743",
    isConfidential: false,
    isDirect: false,
    missingClientCode: false,
    officialLine: "Anti Infective",
    operationalRegionCode: "DL",
    operationalRegionName: "Delta",
    productCode: "RF500",
    productName: "Royafloxacin 500 mg",
    qty: 10,
    regionCode: "DL",
    regionName: "Delta",
    rowNumber: 1,
    salesValue: 1_000,
    sheetAreaCode: "DK1",
    sheetAreaName: "Dakahlia 1",
    sheetRegionCode: "DL",
    sheetRegionName: "Delta",
    sheetValue: 1_000,
    validationState: "valid",
    ...overrides,
  };
}

const NAMES = new Map<string, string>([
  ["IS", "Ibn Sina"],
  ["PS", "Overseas"],
  ["OFFICE", "Marcyrl"],
  ["QM", "El Qema"],
]);

/** The index of a heading, so an assertion names the column rather than counting to it. */
function at(heading: string): number {
  const index = CLOSING_ROWS_HEADERS.indexOf(heading);
  assert.notEqual(index, -1, `the sheet still has a "${heading}" column`);
  return index;
}

export async function runClosingRowsSheetTests(): Promise<void> {
  // ── The invoice reference, read out of each feed's own heading ────────────────────────────────
  // 🔴 A KEY WITH A SPACE MUST BE QUOTED. Unquoted, PostgREST reads the space as the end of the
  // column and the WHOLE select fails — which takes the entire details read down, not one column.
  for (const { alias, key } of INVOICE_REF_KEYS) {
    const fragment = `${alias}:raw_row->>${key.includes(" ") ? `"${key}"` : key}`;
    assert.ok(
      INVOICE_REF_SELECT.includes(fragment),
      `the select reads ${key} as ${alias}${key.includes(" ") ? " — quoted, because the key has a space in it" : ""}`,
    );
  }
  for (const spaced of INVOICE_REF_KEYS.filter((entry) => entry.key.includes(" "))) {
    assert.ok(
      !INVOICE_REF_SELECT.includes(`>>${spaced.key}`),
      `${spaced.key} never appears unquoted — that one fragment would fail the whole details read`,
    );
  }
  assert.ok(INVOICE_REF_KEYS.length >= 6, "every feed's own heading is still listed");

  assert.equal(invoiceRefOf({ invoice_ref_ps: "37505609" }), "37505609", "a feed's own heading is read");
  assert.equal(
    invoiceRefOf({ invoice_ref_eg: "  ", invoice_ref_ps: "37505609" }),
    "37505609",
    "a blank heading is no reference at all — the next one answers",
  );
  assert.equal(invoiceRefOf({}), null, "a feed that carries none answers null, never an empty string");

  // Three different absences, each actionable, and none of them a blank cell.
  const absences = new Set([
    invoiceRefAbsence({ isDirect: false, isOfficeAllocation: false }),
    invoiceRefAbsence({ isDirect: true, isOfficeAllocation: false }),
    invoiceRefAbsence({ isDirect: false, isOfficeAllocation: true }),
  ]);
  assert.equal(absences.size, 3, "a missing reference is explained three different ways, never one");
  for (const reason of absences) assert.ok(reason.trim().length > 0, "and never as a blank cell");

  // ── The sheet's own shape ─────────────────────────────────────────────────────────────────────
  assert.equal(CLOSING_ROWS_HEADERS.length, CLOSING_ROWS_WIDTHS.length, "one width per heading");
  assert.equal(
    CLOSING_ROWS_HEADERS.length,
    CLOSING_ROWS_COLUMN_FORMATS.length,
    "one format slot per heading — positional, so a shifted array silently reformats a column",
  );
  assert.equal(closingRowsSheetSpec({
    distributorNames: NAMES,
    line: "Anti Infective",
    periodLabel: "Sep 2026",
    rows: [],
  }), null, "no rows is NO TAB — an empty sheet reads as a read that failed");

  // 🔴 UNITS MUST NOT TAKE THE MONEY FORMAT. The engine's money format rounds to whole pounds and
  // prints an em dash for zero; an Office allocation row carries 0.442381 units by the golden rule,
  // so rounded it would read as a row that sold nothing.
  for (const heading of ["Units", "Bonus units", "Discount", "Ex-factory price", "Row id"]) {
    assert.equal(
      CLOSING_ROWS_COLUMN_FORMATS[at(heading)],
      "plain",
      `${heading} prints exactly as it is, never rounded to money`,
    );
  }
  assert.notEqual(
    CLOSING_ROWS_COLUMN_FORMATS[at("Value EGP")],
    "plain",
    "and Value is money, like every other money column in the file",
  );

  // ── The tie-out: this tab's total IS the closing's figure ─────────────────────────────────────
  const rows: ClosingDetailRow[] = [
    detailRow({ id: 1, salesValue: 1_000 }),
    detailRow({ id: 2, distributorCode: "PS", invoiceRef: null, salesValue: 2_500.5 }),
    detailRow({
      bonusQty: 3,
      distributorCode: "Office",
      effectiveUnits: 0.442381,
      id: 3,
      invoiceRef: null,
      salesValue: 15.676877,
    }),
    detailRow({
      clientAddress: "7 Tahrir Street, Cairo",
      clientCode: "C9",
      clientName: "El Qema's own customer",
      distributorCode: "QM",
      factoryPrice: 81,
      id: 4,
      invoiceRef: "QM-9931",
      salesValue: 500,
    }),
  ];
  const spec = closingRowsSheetSpec({
    distributorNames: NAMES,
    line: "Anti Infective",
    periodLabel: "Sep 2026",
    rows,
  })!;
  assert.ok(spec !== null, "rows make a sheet");
  assert.equal(spec.rowCount, rows.length, "every row is on it — this tab drops nothing");
  assert.equal(spec.records.length, rows.length);
  assert.equal(
    spec.totalValue,
    rows.reduce((total, row) => total + row.salesValue, 0),
    "the total is the sum of what the closing counted, to the cent",
  );
  for (const record of spec.records) {
    assert.equal(record.length, CLOSING_ROWS_HEADERS.length, "every row fills every column");
  }

  // ── Names, never codes (the owner's standing rule) ────────────────────────────────────────────
  assert.equal(spec.records[0]![at("Distributor")], "Ibn Sina", "the distributor is NAMED");
  assert.equal(spec.records[1]![at("Distributor")], "Overseas");
  assert.equal(
    spec.records[0]![at("Route")],
    "Distributor",
    "an ordinary invoice row says how it reached the closing",
  );
  assert.equal(
    spec.records[2]![at("Route")],
    "Office allocation",
    "and an Office row says it is an allocation, not an invoice",
  );
  assert.equal(
    spec.records[2]![at("Units")],
    0.442381,
    "an Office row's fractional units survive — they are the golden rule's own spread",
  );
  assert.equal(spec.records[2]![at("Bonus units")], 3, "a real bonus prints as a number");
  assert.equal(spec.records[0]![at("Bonus units")], "none", "and no bonus says so rather than printing a zero");

  // ── A missing reference is EXPLAINED, never blank ─────────────────────────────────────────────
  assert.equal(spec.records[0]![at("Invoice reference")], "0/1/1/18743", "the feed's own reference is carried");
  assert.equal(
    spec.records[1]![at("Invoice reference")],
    invoiceRefAbsence({ isDirect: false, isOfficeAllocation: false }),
    "a feed with no reference column says so in the cell",
  );
  assert.equal(
    spec.records[2]![at("Invoice reference")],
    invoiceRefAbsence({ isDirect: false, isOfficeAllocation: true }),
    "and an Office allocation says it is not an invoice at all",
  );

  // ── 🔒 EL QEMA LEAVES NO TRACE — for EVERY reader, not only the ones the loader masks ──────────
  // The loader already removes their rows for viewers who may not reveal them. This sheet blanks
  // them for the Super Admin too, because a finished workbook is forwarded and carries no access
  // context with it: "no any traces for Al Qimma detail. Never anyone know" (owner, 2026-09-09).
  const qema = spec.records[3]!;
  assert.equal(qema[at("Distributor")], "", "a masked row names no distributor — not El Qema, not another");
  assert.equal(qema[at("Customer name")], "Main Stores", "its buyer is the words the masked read substitutes");
  assert.equal(qema[at("Customer code")], "", "with no customer code");
  assert.equal(qema[at("Customer address")], "", "no address");
  assert.equal(qema[at("Ex-factory price")], "", "and no price — the four things that identify a supplier's line");
  assert.equal(qema[at("Invoice reference")], "", "nor its invoice reference, which names the supplier's own book");
  assert.equal(qema[at("Value EGP")], 500, "its MONEY is untouched — the mask hides the source, never the figure");
  const everyCell = JSON.stringify([spec.records, spec.caption, spec.notes]);
  assert.ok(!everyCell.includes("El Qema's own customer"), "nothing of the masked customer survives anywhere");
  assert.ok(
    !/El Qema[^(]/.test(everyCell.replace(/El Qema never appears[\s\S]*?\./g, "")),
    "and the name appears only in the footnote that explains the rule",
  );
  assert.ok(!everyCell.includes("Unnamed distributor"), "a masked row is never labelled as an unnamed one either");

  // ── The caption and footnotes are COUNTED, never stated ───────────────────────────────────────
  // The figure in a sentence has to come from the data, or it is true only until the data changes.
  assert.ok(spec.caption.includes("4 rows"), "the caption counts the rows it actually has");
  assert.ok(
    spec.caption.includes(Math.round(spec.totalValue).toLocaleString("en-US")),
    "and names the total it actually adds to",
  );
  const bigger = closingRowsSheetSpec({
    distributorNames: NAMES,
    line: "Anti Infective",
    periodLabel: "Sep 2026",
    rows: [...rows, detailRow({ id: 5, salesValue: 10 })],
  })!;
  assert.ok(bigger.caption.includes("5 rows"), "a fifth row moves the count — it is counted, not written down");
  assert.ok(
    spec.notes.some((note) => note.includes("UNITS ARE NOT TOTALLED")),
    "🔴 the foot says units are not totalled — units of different products are never added",
  );
  assert.ok(
    spec.notes.some((note) => note.includes("AS INVOICED")),
    "and that the geography is as invoiced, which is why a per-area sum need not match the tabs beside it",
  );
  assert.ok(
    spec.notes.some((note) => note.includes("2 of these rows carry no invoice reference")),
    "the rows with no reference are counted too",
  );

  // ── The premium adapter ───────────────────────────────────────────────────────────────────────
  const sheet = buildClosingRowsSheet({
    distributorNames: NAMES,
    line: "Anti Infective",
    periodLabel: "Sep 2026",
    rows,
  })!;
  assert.equal(sheet.name, CLOSING_ROWS_SHEET_NAME, "the tab is called Rows in both workbooks");
  assert.equal(sheet.rows.length, rows.length);
  assert.deepEqual([...(sheet.columnFormats ?? [])], [...CLOSING_ROWS_COLUMN_FORMATS], "it carries the formats through");
  assert.equal(
    sheet.after,
    undefined,
    "🔴 it APPENDS. A sheet inserted mid-strip re-attaches every print area at or after its position to the neighbour",
  );
  assert.ok(sheet.band && sheet.band.length > 0, "it is listed under its own contents heading, not the review's");
  assert.ok(sheet.title.includes("Sep 2026") && sheet.title.includes("Anti Infective"), "the masthead names the month and line");
}
