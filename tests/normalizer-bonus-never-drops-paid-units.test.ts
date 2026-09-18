import assert from "node:assert/strict";

import ExcelJS from "exceljs";

import { normalizeRows } from "@/lib/sales/normalizer/engine";
import { RAW_DISTRIBUTOR_PROFILES, rawProfileForDistributor } from "@/lib/sales/normalizer/profiles";
import { normalizeAliasKey, normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import type { CodedRow, Crosswalks, DistributorProfile } from "@/lib/sales/normalizer/types";

// A BONUS NEVER DROPS PAID UNITS.
//
// The engine reads a profile's `bonusColumns` as a FREE-GOODS FLAG: any row whose cell is not 0 is a
// free-goods line and is skipped WHOLE. That is right for EPDA, whose `is_bonus` marks a line whose
// only quantity IS the free goods. It was wrong for El Qema, whose profile mapped `بونص` there — a
// bonus COUNT printed beside the paid `الكمية` on the same line. A line of 120 paid packs carrying 12
// bonus packs would have lost all 120, and a bonus of 1 reads exactly like the flag.
//
// Owner, 2026-09-07: "we neglect the bonus and the value in any distributor sheet, we take the units
// and multiply by factory". The bonus is ignored; it never drops paid units and never adds to them.
// Production, read 2026-09-18: El Qema's only batch (August, 64 rows, 8,768 packs) had `بونص` = 0 on
// every row and 0 ignored, so the defect had not yet fired.

const BRICK_ID = "CA101";
const PRODUCT = "LA001";
const FACTORY_PRICE = 330;
const PRODUCT_NAME = "Lacto 1 Advance";

function crosswalks(): Crosswalks {
  return {
    areaAliasByKey: new Map(),
    areaByCode: new Map(),
    brickById: new Map([[BRICK_ID, {
      areaCode: "CA1", areaName: "Cairo 1", blockCode: "CA1-1", brickId: BRICK_ID, brickName: "Marg",
      regionCode: "CA", regionName: "Cairo",
    }]]),
    customerBrickByCanonicalKey: new Map(),
    // El Qema has no territory column: every row places through the customer -> brick map.
    customerBrickByKey: new Map([
      [`${normalizeCodeKey("QM")} ${normalizeCodeKey("1001")}`, BRICK_ID],
      [`${normalizeCodeKey("EP-BK")} ${normalizeCodeKey("5001")}`, BRICK_ID],
    ]),
    productAliasByKey: new Map([
      [`${normalizeCodeKey("QM")} ${normalizeAliasKey(PRODUCT_NAME)}`, PRODUCT],
      [`${normalizeCodeKey("EP-BK")} ${normalizeAliasKey(PRODUCT_NAME)}`, PRODUCT],
    ]),
    productByCanonicalCode: new Map(),
    productByCode: new Map([[PRODUCT, { productCode: PRODUCT, productName: PRODUCT_NAME, factoryPrice: FACTORY_PRICE, line: "Pedia" }]]),
    regionAliasByKey: new Map(),
    regionByCode: new Map(),
    territoryAliasByKey: new Map(),
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

const bySheetRow = (rows: CodedRow[], rowNumber: number) => rows.find((r) => r.rawRowNumber === rowNumber);

// The only columns known to mark a WHOLE line as free goods. A new entry needs the file read first.
const FREE_GOODS_FLAG_COLUMNS = new Set(["is_bonus"]);

export function runNormalizerBonusNeverDropsPaidUnitsTests() {
  // ── El Qema: paid packs in الكمية, a bonus count in بونص, on the same invoice line ──
  const qema = normalizeRows(
    sheetOf(
      ["رقم الفاتورة", "التاريخ", "ACCOUNT_ID", "الاسم", "رقم الصنف", "الصنف", "الكمية", "بونص", "اجمالى جمهور", "الاجمالى"],
      [
        ["9001", "15-08-2026", "1001", "صيدلية النور", "5754", PRODUCT_NAME, 120, 12, 39600, 31680],
        ["9002", "16-08-2026", "1001", "صيدلية النور", "5754", PRODUCT_NAME, 50, 1, 16500, 13200],
        ["9003", "17-08-2026", "1001", "صيدلية النور", "5754", PRODUCT_NAME, 30, 0, 9900, 7920],
        ["9004", "18-08-2026", "1001", "صيدلية النور", "5754", PRODUCT_NAME, 40, "", 13200, 10560],
      ],
    ),
    profile("QM"),
    crosswalks(),
  );

  // HEADLINE: 120 paid packs on a line that also carries 12 bonus packs are imported at 120.
  assert.equal(
    bySheetRow(qema.coded, 2)?.qty,
    120,
    "an El Qema line with 120 paid packs and a bonus of 12 must import its 120 paid packs — the bonus cell dropped the whole row",
  );
  // A bonus of 1 is the case a flag reading cannot tell apart from is_bonus = 1.
  assert.equal(bySheetRow(qema.coded, 3)?.qty, 50, "a bonus of 1 must not drop the line's 50 paid packs");
  assert.equal(bySheetRow(qema.coded, 4)?.qty, 30, "a bonus of 0 imports its paid packs, as before");
  assert.equal(bySheetRow(qema.coded, 5)?.qty, 40, "a blank bonus imports its paid packs, as before");

  assert.equal(qema.coded.length, 4, "every El Qema line is coded");
  assert.equal(qema.ignoredRows.filter((r) => r.reason === "bonus").length, 0, "no El Qema line is ignored as free goods");
  assert.equal(qema.coded.reduce((s, r) => s + r.qty, 0), 240, "El Qema's units are the paid packs, 240, with no bonus added");

  // The bonus is neglected: it adds no units and no value. Units times factory price, nothing else.
  for (const row of qema.coded) {
    assert.equal(row.bonusQty, 0, `row ${row.rawRowNumber}: the bonus is never carried as units`);
    assert.equal(row.value, row.qty * FACTORY_PRICE, `row ${row.rawRowNumber}: value is paid units x factory price`);
  }

  // The cell is still kept exactly as the distributor sent it, for the audit trail.
  assert.equal(bySheetRow(qema.coded, 2)?.rawRow["بونص"], "12");

  // ── EPDA: is_bonus is a real free-goods flag, and a flagged line is still skipped ──
  const epda = normalizeRows(
    sheetOf(
      ["class_code", "class_name", "qnt", "inv_date", "cust_code", "cust_name", "cust_address", "is_bonus"],
      [
        ["LA1", PRODUCT_NAME, 100, "8/15/2026", "5001", "Nour Pharmacy", "Marg", 0],
        ["LA1", PRODUCT_NAME, 10, "8/15/2026", "5001", "Nour Pharmacy", "Marg", 1],
      ],
    ),
    profile("EP-BK"),
    crosswalks(),
  );
  assert.equal(bySheetRow(epda.coded, 2)?.qty, 100, "an EPDA line with is_bonus = 0 is imported");
  assert.equal(bySheetRow(epda.coded, 3), undefined, "an EPDA line with is_bonus = 1 is free goods and is not imported");
  assert.deepEqual(
    epda.ignoredRows.map((r) => [r.rawRowNumber, r.reason]),
    [[3, "bonus"]],
    "the EPDA free-goods line is recorded as ignored for the bonus",
  );

  // ── No profile may map a bonus COUNT where the engine expects a free-goods FLAG ──
  for (const p of RAW_DISTRIBUTOR_PROFILES) {
    for (const column of p.bonusColumns ?? []) {
      assert.ok(
        FREE_GOODS_FLAG_COLUMNS.has(column),
        `${p.distributorCode} maps "${column}" as its free-goods flag. The engine drops the WHOLE row when that cell is not 0, so it must mark a whole free-goods line (like EPDA's is_bonus), never a bonus count beside paid units.`,
      );
    }
  }
}
