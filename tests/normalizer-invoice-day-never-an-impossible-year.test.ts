import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { normalizeRows } from "@/lib/sales/normalizer/engine";
import { rawProfileForDistributor } from "@/lib/sales/normalizer/profiles";
import { normalizeAliasKey } from "@/lib/sales/normalizer/resolvers";
import type { CodedRow, Crosswalks, DistributorProfile } from "@/lib/sales/normalizer/types";

// THE INVOICE DAY IS A REAL DATE OR NULL — NEVER AN IMPOSSIBLE YEAR.
//
// `CodedRow.invoiceDay` is persisted as `source_of_sales_import_rows.invoice_date`, a Postgres `date`,
// which accepts years far past 9999 — so nothing downstream refused what the engine produced.
// Measured on production 2026-09-18, validated batches only:
//   • Sofico 2026-08 — 166 rows stored as 46235-01-01 … 46265-01-01. BILLINGDATE arrives as a plain
//     number, an Excel serial day ("46247" is 13 Aug 2026), and `new Date("46247")` reads it as a YEAR.
//   • mec 2026-07 and 2026-08 — 13 rows stored as 202607-01-01 … 202609-01-01. mec's date column is
//     the month "شهر" ("202607"), read the same way.
// The month on those rows was right only because the upload's chosen period overwrote it. The day
// had no such rescue. The fix caps the year at 9999, the importer's own bound, so mec's month is no
// day. Sofico's serial is now read as the real day it is — pinned, month and day together, in
// normalizer-reads-sofico-excel-serial-billing-dates.test.ts. Here it must only never be a year.

const BRICK_ID = "CA101";

function crosswalks(territory: string): Crosswalks {
  return {
    areaAliasByKey: new Map(),
    areaByCode: new Map(),
    brickById: new Map([[BRICK_ID, {
      areaCode: "CA1", areaName: "Cairo 1", blockCode: "CA1-1", brickId: BRICK_ID, brickName: "Marg",
      regionCode: "CA", regionName: "Cairo",
    }]]),
    customerBrickByCanonicalKey: new Map(),
    customerBrickByKey: new Map(),
    productAliasByKey: new Map(),
    productByCanonicalCode: new Map(),
    productByCode: new Map([["LA001", { productCode: "LA001", productName: "Lacto Advanced", factoryPrice: 40, line: "Pedia" }]]),
    regionAliasByKey: new Map(),
    regionByCode: new Map(),
    territoryAliasByKey: new Map([[normalizeAliasKey(territory), { targetType: "brick", targetCode: BRICK_ID }]]),
  };
}

function sheetOf(headers: string[], rows: unknown[][]): ExcelJS.Worksheet {
  const ws = new ExcelJS.Workbook().addWorksheet("Sheet1");
  ws.addRow(headers);
  rows.forEach((r) => ws.addRow(r));
  return ws;
}

function profile(code: string): DistributorProfile {
  const p = rawProfileForDistributor(code);
  assert.ok(p, `the ${code} profile must exist — this test reads the real one`);
  return p;
}

/** The coded rows by sheet row number, refusing a pass that coded fewer rows than it was given. */
function codedByRow(rows: CodedRow[], expected: number): Map<number, CodedRow> {
  assert.equal(rows.length, expected, "every row must be CODED, or the day assertions below prove nothing");
  return new Map(rows.map((r) => [r.rawRowNumber, r]));
}

const isRealDay = (day: string | null) => day === null || /^(19|[2-9]\d)\d{2}-\d{2}-\d{2}$/.test(day);

export function runNormalizerInvoiceDayImpossibleYearTests() {
  // ── Sofico: BILLINGDATE as an Excel serial number, as production received it ──
  const sofico = normalizeRows(
    sheetOf(
      ["ITEMIDE", "ITEMNAME", "qty", "TOTALVALUE", "BILLINGDATE", "ORDERACCOUNT", "CUSTOMERNAME0013", "ADDRESSSHIP", "bricks"],
      [
        ["LA001", "Lacto Advanced", 1, 40.8, 46247, "1500000946", "Dr Abdallah", "Marg", "المرج"],
        ["LA001", "Lacto Advanced", 2, 81.6, 46265, "1500000946", "Dr Abdallah", "Marg", "المرج"],
        ["LA001", "Lacto Advanced", 3, 122.4, "13-08-2026", "1500000946", "Dr Abdallah", "Marg", "المرج"],
        ["LA001", "Lacto Advanced", 4, 163.2, new Date(Date.UTC(2026, 7, 13)), "1500000946", "Dr Abdallah", "Marg", "المرج"],
      ],
    ),
    profile("SF"),
    crosswalks("المرج"),
  );
  const sf = codedByRow(sofico.coded, 4);

  // An Excel serial day is not a year. It used to come out as "46247-01-01"; it is now its real day.
  assert.equal(sf.get(2)?.invoiceDay, "2026-08-13", `Sofico BILLINGDATE 46247 is 13 Aug 2026 — got ${sf.get(2)?.invoiceDay}`);
  assert.equal(sf.get(3)?.invoiceDay, "2026-08-31", "the last serial of the month (46265) is 31 Aug 2026");

  // The source value is still kept exactly as the distributor sent it — the audit trail is untouched.
  assert.equal(sf.get(2)?.rawRow.BILLINGDATE, "46247");

  // A real date is still read, to the day, and its period is unchanged.
  assert.equal(sf.get(4)?.invoiceDay, "2026-08-13", "a DD-MM-YYYY text date still reads to the day");
  assert.equal(sf.get(4)?.invoiceDate, "2026-08");
  assert.equal(sf.get(5)?.invoiceDay, "2026-08-13", "an Excel date cell still reads to the day");
  assert.equal(sf.get(5)?.invoiceDate, "2026-08");

  // ── mec: the date column is the month "شهر", as text and as a number ──
  const mec = normalizeRows(
    sheetOf(
      ["دالصنف", "إسم الصنف", "الكمية", "الصافى", "شهر", "كود", "العميل", "address", "المنطقة"],
      [
        ["LA001", "Lacto Advanced", 1, 63.4, "202607", "751058", "Maher Kamel", "Azarita", "الازاريطة"],
        ["LA001", "Lacto Advanced", 3, 202.5, 202608, "769005", "Green", "Moharam Bek", "الازاريطة"],
      ],
    ),
    profile("MC"),
    crosswalks("الازاريطة"),
  );
  const mc = codedByRow(mec.coded, 2);
  // HEADLINE: a month is not a day. It used to come out as "202607-01-01".
  assert.equal(mc.get(2)?.invoiceDay, null, `mec month "202607" must give no day, never an impossible year — got ${mc.get(2)?.invoiceDay}`);
  assert.equal(mc.get(3)?.invoiceDay, null, `mec month 202608 must give no day — got ${mc.get(3)?.invoiceDay}`);

  // Whatever a date column holds, nothing the engine emits is an impossible year.
  for (const row of [...sofico.coded, ...mec.coded]) {
    assert.ok(isRealDay(row.invoiceDay), `row ${row.rawRowNumber} carries an impossible day: ${row.invoiceDay}`);
  }
}
