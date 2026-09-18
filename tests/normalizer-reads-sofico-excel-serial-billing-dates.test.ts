import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { normalizeRows } from "@/lib/sales/normalizer/engine";
import { rawProfileForDistributor } from "@/lib/sales/normalizer/profiles";
import { normalizeAliasKey } from "@/lib/sales/normalizer/resolvers";
import type { CodedRow, Crosswalks, DistributorProfile } from "@/lib/sales/normalizer/types";
import { resolveUploadPeriod } from "@/lib/sales/sales-upload";

// SOFICO'S EXCEL SERIAL BILLING DATES ARE READ AS THE REAL DATE — MONTH AND DAY TOGETHER.
//
// Sofico's BILLINGDATE column is formatted as General, so each cell reaches the engine as its Excel
// serial day: "46247" is 13 Aug 2026. Both readers took it for the YEAR 46247 — the month came out
// "46247-01", a different impossible month for every day of the file, so the upload could never
// resolve one period and the uploader had to pick August by hand. Measured on production 2026-09-18:
// Sofico's August batch, 166 rows, BILLINGDATE 46235–46265 — every day of August 2026.
//
// A serial is a FIVE-DIGIT whole number only. mec's month column "202607" is six digits and is not a
// day; read as a serial it would be the year 2454.

const BRICK_ID = "CA101";
const TERRITORY = "المرج";

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

function profile(code: string): DistributorProfile {
  const p = rawProfileForDistributor(code);
  assert.ok(p, `the ${code} profile must exist — this test reads the real one`);
  return p;
}

const SOFICO_HEADERS = ["ITEMIDE", "ITEMNAME", "qty", "TOTALVALUE", "BILLINGDATE", "ORDERACCOUNT", "CUSTOMERNAME0013", "ADDRESSSHIP", "bricks"];

/** A Sofico sheet whose BILLINGDATE cells are the given values, one row each. */
function soficoSheet(billingDates: unknown[]): ExcelJS.Worksheet {
  const ws = new ExcelJS.Workbook().addWorksheet("Sheet1");
  ws.addRow(SOFICO_HEADERS);
  billingDates.forEach((date, i) => ws.addRow(["LA001", "Lacto Advanced", i + 1, 40.8 * (i + 1), date, "1500000946", "Dr Abdallah", "Marg", TERRITORY]));
  return ws;
}

/** The coded rows by sheet row number, refusing a pass that coded fewer rows than it was given. */
function codedByRow(rows: CodedRow[], expected: number): Map<number, CodedRow> {
  assert.equal(rows.length, expected, "every row must be CODED, or the date assertions below prove nothing");
  return new Map(rows.map((r) => [r.rawRowNumber, r]));
}

const monthAndDay = (row: CodedRow | undefined) => ({ month: row?.invoiceDate, day: row?.invoiceDay });

export function runNormalizerSoficoExcelSerialDateTests() {
  // ── Sofico's August file, as production received it: serial numbers across the month ──
  const august = normalizeRows(soficoSheet([46235, 46247, 46265]), profile("SF"), crosswalks(TERRITORY));
  const aug = codedByRow(august.coded, 3);

  // HEADLINE: 46247 is 13 Aug 2026 — the month AND the day. It used to read "46247-01" / no day.
  assert.deepEqual(
    monthAndDay(aug.get(3)),
    { month: "2026-08", day: "2026-08-13" },
    `Sofico BILLINGDATE 46247 is 13 Aug 2026, month and day — got ${JSON.stringify(monthAndDay(aug.get(3)))}`,
  );
  assert.deepEqual(monthAndDay(aug.get(2)), { month: "2026-08", day: "2026-08-01" }, "46235 is 1 Aug 2026");
  assert.deepEqual(monthAndDay(aug.get(4)), { month: "2026-08", day: "2026-08-31" }, "46265 is 31 Aug 2026");

  // The source value is kept exactly as the distributor sent it — the audit trail is untouched.
  assert.equal(aug.get(3)?.rawRow.BILLINGDATE, "46247");

  // The file now resolves to ONE month by itself — nobody has to pick August by hand.
  assert.deepEqual(
    resolveUploadPeriod(august.coded.map((r) => r.invoiceDate), ""),
    { kind: "ok", period: "2026-08", consolidate: false },
    "an all-August Sofico file must resolve to 2026-08 with no month chosen",
  );

  // ── Each serial is read on its own: the days either side of August land in their own months ──
  const edges = normalizeRows(soficoSheet([46234, 46266]), profile("SF"), crosswalks(TERRITORY));
  const edge = codedByRow(edges.coded, 2);
  assert.deepEqual(monthAndDay(edge.get(2)), { month: "2026-07", day: "2026-07-31" }, "46234 is 31 Jul 2026");
  assert.deepEqual(monthAndDay(edge.get(3)), { month: "2026-09", day: "2026-09-01" }, "46266 is 1 Sep 2026");
  // …so a file spanning two months is still refused as multi-month, never quietly merged into one.
  assert.equal(resolveUploadPeriod(edges.coded.map((r) => r.invoiceDate), "").kind, "multi");

  // ── A text date and an Excel date cell in the same column still read as before ──
  const mixed = normalizeRows(soficoSheet(["13-08-2026", new Date(Date.UTC(2026, 7, 13))]), profile("SF"), crosswalks(TERRITORY));
  const mix = codedByRow(mixed.coded, 2);
  assert.deepEqual(monthAndDay(mix.get(2)), { month: "2026-08", day: "2026-08-13" }, "a DD-MM-YYYY text date is unchanged");
  assert.deepEqual(monthAndDay(mix.get(3)), { month: "2026-08", day: "2026-08-13" }, "an Excel date cell is unchanged");

  // ── Sofico Tender shares the date column, so it reads the same serial the same way ──
  // (Its territory is ADDRESSSHIP, not "bricks", so its crosswalk keys on that cell's "Marg".)
  const tender = normalizeRows(soficoSheet([46247]), profile("SF-T"), crosswalks("Marg"));
  assert.deepEqual(monthAndDay(codedByRow(tender.coded, 1).get(2)), { month: "2026-08", day: "2026-08-13" }, "Sofico Tender 46247 is 13 Aug 2026");

  // The month and the day never disagree, on any row read here.
  for (const row of [...august.coded, ...edges.coded, ...mixed.coded, ...tender.coded]) {
    assert.equal(row.invoiceDay?.slice(0, 7), row.invoiceDate, `row ${row.rawRowNumber}: day ${row.invoiceDay} is not in month ${row.invoiceDate}`);
  }

  // ── mec's six-digit month is not a serial: read as one it would be the year 2454 ──
  const mecSheet = new ExcelJS.Workbook().addWorksheet("Sheet1");
  mecSheet.addRow(["دالصنف", "إسم الصنف", "الكمية", "الصافى", "شهر", "كود", "العميل", "address", "المنطقة"]);
  mecSheet.addRow(["LA001", "Lacto Advanced", 1, 63.4, "202607", "751058", "Maher Kamel", "Azarita", "الازاريطة"]);
  mecSheet.addRow(["LA001", "Lacto Advanced", 3, 202.5, 202608, "769005", "Green", "Moharam Bek", "الازاريطة"]);
  const mec = codedByRow(normalizeRows(mecSheet, profile("MC"), crosswalks("الازاريطة")).coded, 2);
  assert.equal(mec.get(2)?.invoiceDay, null, `mec month "202607" is not a day — got ${mec.get(2)?.invoiceDay}`);
  assert.equal(mec.get(3)?.invoiceDay, null, `mec month 202608 is not a day — got ${mec.get(3)?.invoiceDay}`);
}
