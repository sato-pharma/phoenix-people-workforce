import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { normalizeRows } from "@/lib/sales/normalizer/engine";
import { rawProfileForDistributor } from "@/lib/sales/normalizer/profiles";
import { normalizeAliasKey } from "@/lib/sales/normalizer/resolvers";
import type { CodedRow, Crosswalks, DistributorProfile } from "@/lib/sales/normalizer/types";
import { resolveUploadPeriod } from "@/lib/sales/sales-upload";

// MEC'S MONTH COLUMN "شهر" IS READ AS THE MONTH.
//
// mec's date column is its month "شهر", written YYYYMM ("202607"), per the Headers Mapping. JavaScript
// read it as the YEAR 202607, so every mec row came out in the impossible month "202607-01" and the
// uploader had to pick the month by hand. Measured on production 2026-09-18: 13 rows, 202607–202609.
//
// The owner decided on 2026-09-18 that "شهر" decides a mec row's month — even though it is NOT the
// invoice's calendar month: invoices dated the 25th or later already carry the NEXT month (25 Jul →
// 202608; 25–31 Aug → 202609 — 5 of the 13 rows). So a mec file that crosses that cut-off resolves to
// two months and is refused as multi-month, never quietly merged. "شهر" carries no day.

const BRICK_ID = "AL101";
const TERRITORY = "الازاريطة";

function crosswalks(): Crosswalks {
  return {
    areaAliasByKey: new Map(),
    areaByCode: new Map(),
    brickById: new Map([[BRICK_ID, {
      areaCode: "AL1", areaName: "Alex 1", blockCode: "AL1-1", brickId: BRICK_ID, brickName: "Azarita",
      regionCode: "AL", regionName: "Alexandria",
    }]]),
    customerBrickByCanonicalKey: new Map(),
    customerBrickByKey: new Map(),
    productAliasByKey: new Map(),
    productByCanonicalCode: new Map(),
    productByCode: new Map([["LA001", { productCode: "LA001", productName: "Lacto Advanced", factoryPrice: 40, line: "Pedia" }]]),
    regionAliasByKey: new Map(),
    regionByCode: new Map(),
    territoryAliasByKey: new Map([[normalizeAliasKey(TERRITORY), { targetType: "brick", targetCode: BRICK_ID }]]),
  };
}

function mecProfile(): DistributorProfile {
  const p = rawProfileForDistributor("MC");
  assert.ok(p, "the mec profile must exist — this test reads the real one");
  return p;
}

const MEC_HEADERS = ["دالصنف", "إسم الصنف", "الكمية", "الصافى", "شهر", "تاريخ المستند", "كود", "العميل", "address", "المنطقة"];

/** A mec sheet: one row per [شهر, تاريخ المستند] pair, as mec's own export lays it out. */
function mecSheet(rows: [unknown, Date][]): ExcelJS.Worksheet {
  const ws = new ExcelJS.Workbook().addWorksheet("Sheet1");
  ws.addRow(MEC_HEADERS);
  rows.forEach(([month, documentDate], i) => ws.addRow(["LA001", "Lacto Advanced", i + 1, 63.4 * (i + 1), month, documentDate, "751058", "Maher Kamel", "Azarita", TERRITORY]));
  return ws;
}

/** The coded rows by sheet row number, refusing a pass that coded fewer rows than it was given. */
function codedByRow(rows: CodedRow[], expected: number): Map<number, CodedRow> {
  assert.equal(rows.length, expected, "every row must be CODED, or the month assertions below prove nothing");
  return new Map(rows.map((r) => [r.rawRowNumber, r]));
}

const day = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12));
const periodsOf = (rows: CodedRow[]) => rows.map((r) => r.invoiceDate);

export function runNormalizerMecMonthColumnTests() {
  // ── mec's July file, as production received it ──
  const july = normalizeRows(
    mecSheet([
      ["202607", day(2026, 7, 12)],
      [202607, day(2026, 7, 19)],
      ["202608", day(2026, 7, 25)], // mec's own cut-off: an invoice of 25 July carries "202608"
    ]),
    mecProfile(),
    crosswalks(),
  );
  const jul = codedByRow(july.coded, 3);

  // HEADLINE: "202607" is July 2026. It used to come out as the impossible month "202607-01".
  assert.equal(jul.get(2)?.invoiceDate, "2026-07", `mec month "202607" is July 2026 — got ${jul.get(2)?.invoiceDate}`);
  assert.equal(jul.get(3)?.invoiceDate, "2026-07", "the same month sent as a number cell (202607) reads the same");

  // "شهر" decides, not the invoice's own date: 25 July with "202608" is August (owner, 2026-09-18).
  assert.equal(jul.get(4)?.invoiceDate, "2026-08", `"شهر" 202608 decides the month over a 25 July invoice date — got ${jul.get(4)?.invoiceDate}`);

  // "شهر" carries no day, so no row claims one — the month and the day can never disagree.
  for (const row of july.coded) assert.equal(row.invoiceDay, null, `row ${row.rawRowNumber}: a month is not a day — got ${row.invoiceDay}`);

  // The source value is kept exactly as mec sent it.
  assert.equal(jul.get(2)?.rawRow["شهر"], "202607");

  // A file crossing mec's cut-off is refused as two NAMED months — never merged, never "202607-01".
  assert.deepEqual(
    resolveUploadPeriod(periodsOf(july.coded), ""),
    { kind: "multi", periods: ["2026-07", "2026-08"] },
    "a mec file spanning two months must be refused with both months named",
  );

  // ── A mec file inside one month resolves to it by itself — nobody picks the month by hand ──
  const august = normalizeRows(
    mecSheet([["202608", day(2026, 8, 2)], [202608, day(2026, 8, 17)]]),
    mecProfile(),
    crosswalks(),
  );
  codedByRow(august.coded, 2);
  assert.deepEqual(
    resolveUploadPeriod(periodsOf(august.coded), ""),
    { kind: "ok", period: "2026-08", consolidate: false },
    "an all-202608 mec file must resolve to 2026-08 with no month chosen",
  );

  // ── Six digits that are no month give no month — never an impossible one ──
  const bad = normalizeRows(mecSheet([["202613", day(2026, 8, 2)]]), mecProfile(), crosswalks());
  assert.equal(codedByRow(bad.coded, 1).get(2)?.invoiceDate, "", `"202613" has no 13th month — got ${bad.coded[0]?.invoiceDate}`);
}
