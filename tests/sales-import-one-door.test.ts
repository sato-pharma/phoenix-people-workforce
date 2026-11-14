import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { SalesWorkflowError } from "../src/lib/sales/contracts.ts";
import type { assertNotADuplicateUpload } from "../src/lib/sales/import-duplicate-guard.ts";
import { applyImportStoreRules, type PeriodLockReader } from "../src/lib/sales/import-store-rules.ts";
import { productPeriodPricesFromRows } from "../src/lib/sales/product-period-price.ts";

// ─────────────────────────────────────────────────────────────────────────────
// ONE FRONT DOOR FOR THE MONEY RULES OF A SALES IMPORT (enterprise audit REC-008, F-SAL-003; 14 Nov 2026).
//
// Monthly Import, the Sales Upload and the Source Normalizer reach two writers —
// `persistDistributorSalesUpload` and `persistNormalizedBatch`. Each used to apply EPDA's bonus
// deduction, the locked-month refusal and the same-workbook refusal itself, and the Normalizer writer
// had missed the lock: a locked month's rows were written and only the database's own lock caught
// them, leaving an orphaned pending batch. `applyImportStoreRules` (import-store-rules.ts) is now the
// only place those rules run on an import. This file pins:
//   1. no other import path runs those rules on its own;
//   2. a locked or unreadable month is refused before the duplicate lookup and before anything is written;
//   3. the same sheet, shaped as each writer shapes it, gives identical rows, totals and duplicate check.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Each call of `name(` outside comments, as `file:enclosing function`. */
function callersOf(name: string): string[] {
  const found: string[] = [];
  for (const file of [...sourceFiles("src"), ...sourceFiles("app")]) {
    const text = readFileSync(join(ROOT, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, "");
      if (!new RegExp(`(?<![\\w.])${name}\\(`).test(code)) return;
      if (new RegExp(`function ${name}\\(`).test(code)) return; // its own definition
      let owner = "(top level)";
      for (let i = index; i >= 0; i -= 1) {
        const match = lines[i].match(/^export (?:async )?function (\w+)|^(?:async )?function (\w+)/);
        if (match) {
          owner = match[1] ?? match[2];
          break;
        }
      }
      found.push(`${relative(ROOT, join(ROOT, file)).replace(/\\/g, "/")}:${owner}`);
    });
  }
  return [...new Set(found)].sort();
}

function testNoImportRunsTheRulesOnItsOwn() {
  // HEADLINE: the rules have one home. A writer that deducted, checked the lock or looked for a
  // duplicate itself would be a second door, and the next rule would be wired into only one of them.
  assert.deepEqual(
    callersOf("applyEpdaBonusDeduction"),
    [
      "src/lib/sales/import-epda-bonus-deduction.ts:summarizeEpdaBonusDeduction",
      "src/lib/sales/import-store-rules.ts:applyImportStoreRules",
    ],
    "only the door deducts on a write (the summary is the preview's read)",
  );
  assert.deepEqual(callersOf("assertNotADuplicateUpload"), [], "only the door looks for the same workbook (through its seam)");
  assert.deepEqual(
    callersOf("assertPeriodNotLocked"),
    [
      "src/lib/sales/import-store-rules.ts:applyImportStoreRules",
      "src/lib/sales/monthly-distributor-import.ts:deleteSourceOfSalesUploadBatch",
    ],
    "only the door checks the lock on an import; deleting an upload checks it too",
  );
  const rules = readFileSync(join(ROOT, "src/lib/sales/import-store-rules.ts"), "utf8");
  assert.match(rules, /await \(seams\.assertNotADuplicate \?\? assertNotADuplicateUpload\)\(\{/, "the door's own lookup is the live one unless a test hands it another");

  // Both writers call the door, and the old address of the lock check still works.
  for (const [file, signature] of [
    ["src/lib/sales/monthly-distributor-import.ts", "export async function persistDistributorSalesUpload("],
    ["src/lib/sales/normalizer/service.ts", "export async function persistNormalizedBatch("],
  ] as const) {
    const text = readFileSync(join(ROOT, file), "utf8");
    const body = text.slice(text.indexOf(signature), text.indexOf("\n}\n", text.indexOf(signature)));
    assert.equal(body.split("applyImportStoreRules(").length - 1, 1, `${signature} calls the door once`);
    assert.ok(body.indexOf("applyImportStoreRules(") < body.indexOf('.from("source_of_sales_import_batches")'), `${signature} calls it before the batch row`);
  }
  assert.match(
    readFileSync(join(ROOT, "src/lib/sales/monthly-distributor-import.ts"), "utf8"),
    /export \{ assertPeriodNotLocked, type PeriodLockReader \} from "@\/lib\/sales\/import-store-rules";/,
    "every importer that reached the lock check at its old address still does",
  );
}

type GuardInput = Parameters<typeof assertNotADuplicateUpload>[0];

const lockReader = (result: { data: unknown; error: { code?: string } | null }): PeriodLockReader =>
  ({
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }) }),
  }) as unknown as PeriodLockReader;

const prices = productPeriodPricesFromRows(
  [
    { productCode: "IV001", factoryPrice: 10 },
    { productCode: "AB001", factoryPrice: 5 },
  ],
  [{ productCode: "IV001", effectivePeriod: "2026-11", factoryPrice: 12 }],
);

/** The same three sheet lines, as Monthly Import shapes them and as the Normalizer shapes them. */
const SHEET = [
  { productCode: "IV001", areaCode: "A01", qty: 100, value: 1000 },
  { productCode: "IV001", areaCode: "A01", qty: 1, value: 10 },
  { productCode: "AB001", areaCode: "A02", qty: 7, value: 35 },
];
const PERIOD = "2026-10";
const DISTRIBUTOR = "EP-BK";

function monthlyRows() {
  return SHEET.map((line) => ({ ...line, distributorCode: DISTRIBUTOR, invoicePeriod: PERIOD, isDirect: false }));
}
function normalizerRows() {
  return SHEET.map((line) => ({ ...line, distributorCode: DISTRIBUTOR, invoiceDate: PERIOD }));
}

/** Calls the door exactly as each writer does, with the database replaced. */
async function throughEachWriter(lock: PeriodLockReader) {
  const seen: GuardInput[] = [];
  const seams = { lockReader: lock, loadPrices: async () => prices, assertNotADuplicate: async (input: GuardInput) => void seen.push(input) };
  const sheet = monthlyRows();
  const sheetTotals = { totalQty: sheet.reduce((s, r) => s + r.qty, 0), totalValue: sheet.reduce((s, r) => s + r.value, 0) };
  const monthly = await applyImportStoreRules(
    {
      period: PERIOD,
      distributorCode: DISTRIBUTOR,
      fileName: "epda-bulk-october.xlsx",
      sheetRows: sheet,
      countsAsSales: true,
      deductionMonthOf: (row) => row.invoicePeriod ?? PERIOD,
      priceMonthOf: (row) => row.invoicePeriod,
      priceDistributorOf: (row) => row.distributorCode,
      totalRows: sheet.length,
      sheetTotals,
    },
    seams,
  );
  const normalizerSheet = normalizerRows().filter((r) => r.invoiceDate === PERIOD);
  const normalizer = await applyImportStoreRules(
    {
      period: PERIOD,
      distributorCode: DISTRIBUTOR,
      fileName: "epda-bulk-october.xlsx",
      sheetRows: normalizerSheet,
      countsAsSales: true,
      deductionMonthOf: (r) => r.invoiceDate,
      priceMonthOf: (r) => r.invoiceDate,
      priceDistributorOf: () => DISTRIBUTOR,
      totalRows: normalizerSheet.length,
    },
    seams,
  );
  return { monthly, normalizer, seen };
}

async function testTheSameSheetStoresTheSameThroughEitherWriter() {
  const { monthly, normalizer, seen } = await throughEachWriter(lockReader({ data: null, error: null }));
  const units = (rows: { productCode: string; areaCode: string | null; qty: number; value: number }[]) =>
    rows.map(({ productCode, areaCode, qty, value }) => ({ productCode, areaCode, qty, value }));

  // HEADLINE: identical rows and totals.
  assert.deepEqual(units(normalizer.rows), units(monthly.rows), "the same sheet stores the same rows through either writer");
  assert.equal(normalizer.totalQty, monthly.totalQty);
  assert.equal(normalizer.totalValue, monthly.totalValue);
  // EPDA-BULK's Ivyronc in October loses 30%: 101 units read 71 (the whole book is one group); the other product is untouched.
  assert.equal(monthly.deducted, true);
  assert.equal(monthly.totalQty, 71 + 7);
  assert.equal(monthly.rows.length, SHEET.length, "a deduction never drops a row, so the stored count is the sheet's");

  // And the same duplicate check, on every month a stored batch could sit in.
  assert.equal(seen.length, 2, "both writers look for the same workbook under another month");
  const [a, b] = seen;
  for (const key of ["distributorCode", "fileName", "period", "totalRows", "totalQty", "totalValue"] as const) {
    assert.equal(b[key], a[key], `both writers compare ${key} alike`);
  }
  for (const at of ["2026-09", "2026-10", "2026-11"]) {
    assert.equal(b.totalQtyAt?.(at), a.totalQtyAt?.(at), `both compare units stored in ${at} alike`);
    assert.equal(b.totalValueAt?.(at), a.totalValueAt?.(at), `both compare value at ${at}'s price alike`);
  }
  assert.equal(a.totalQtyAt?.("2026-09"), 108, "a September batch kept every unit, so it is compared undeducted");
  assert.equal(a.totalQty, monthly.totalQty, "the check compares exactly the totals that are stored");
  assert.equal(a.totalValue, monthly.totalValue);
}

async function testALockedMonthIsRefusedBeforeAnythingElse() {
  // HEADLINE: the Normalizer path now refuses a locked month — before the lookup, before any write.
  for (const [result, code, status] of [
    [{ data: { locked: true }, error: null }, "period_locked", 409],
    [{ data: null, error: { code: "57014" } }, "period_lock_unreadable", 503],
  ] as const) {
    const seen: GuardInput[] = [];
    const rows = normalizerRows();
    await assert.rejects(
      applyImportStoreRules(
        {
          period: PERIOD,
          distributorCode: DISTRIBUTOR,
          fileName: "october.xlsx",
          sheetRows: rows,
          countsAsSales: true,
          deductionMonthOf: (r) => r.invoiceDate,
          priceMonthOf: (r) => r.invoiceDate,
          priceDistributorOf: () => DISTRIBUTOR,
          totalRows: rows.length,
        },
        { lockReader: lockReader(result), loadPrices: async () => prices, assertNotADuplicate: async (input) => void seen.push(input) },
      ),
      (error: unknown) => error instanceof SalesWorkflowError && error.code === code && error.status === status,
      `a ${code} month is refused with a ${status}`,
    );
    assert.equal(seen.length, 0, "nothing past the lock runs");
  }
  // A blocked Monthly batch is kept as the sheet said and never looked up — but a locked month refuses it too.
  const sheet = monthlyRows();
  const seen: GuardInput[] = [];
  const blocked = await applyImportStoreRules(
    {
      period: PERIOD,
      distributorCode: DISTRIBUTOR,
      fileName: "october.xlsx",
      sheetRows: sheet,
      countsAsSales: false,
      deductionMonthOf: (row) => row.invoicePeriod,
      priceMonthOf: (row) => row.invoicePeriod,
      priceDistributorOf: (row) => row.distributorCode,
      totalRows: sheet.length,
      sheetTotals: { totalQty: 108, totalValue: 1045 },
    },
    { lockReader: lockReader({ data: null, error: null }), assertNotADuplicate: async (input) => void seen.push(input) },
  );
  assert.equal(blocked.rows, sheet, "a blocked batch keeps the sheet's rows");
  assert.equal(blocked.deducted, false);
  assert.deepEqual([blocked.totalQty, blocked.totalValue], [108, 1045], "and the sheet's totals");
  assert.equal(seen.length, 0, "a blocked batch never counts, so it is never compared");
  await assert.rejects(
    applyImportStoreRules(
      {
        period: PERIOD,
        distributorCode: DISTRIBUTOR,
        fileName: "october.xlsx",
        sheetRows: sheet,
        countsAsSales: false,
        deductionMonthOf: (row) => row.invoicePeriod,
        priceMonthOf: (row) => row.invoicePeriod,
        priceDistributorOf: (row) => row.distributorCode,
        totalRows: sheet.length,
      },
      { lockReader: lockReader({ data: { locked: true }, error: null }) },
    ),
    (error: unknown) => error instanceof SalesWorkflowError && error.code === "period_locked",
    "a blocked batch for a locked month is refused too",
  );
}

export async function runSalesImportOneDoorTests() {
  testNoImportRunsTheRulesOnItsOwn();
  await testTheSameSheetStoresTheSameThroughEitherWriter();
  await testALockedMonthIsRefusedBeforeAnythingElse();
}
