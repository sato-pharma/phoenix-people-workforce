import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

import ExcelJS from "exceljs";

import { computePlan, type LoadedMaterial, type ProductionPlanningData } from "../src/lib/production-planning/service.ts";
import { parsePct, parseQty, QTY_SCALE } from "../src/lib/production-planning/rules.ts";
import { PP, PP_EN, PRODUCTION_PLANNING_WORKBOOK_FONT } from "../src/lib/production-planning/strings.ts";
import type { WireMaterial, WirePlan, WireWorkspace } from "../src/lib/production-planning/wire.ts";
import { buildProductionPlanningWorkbook, productionPlanningWorkbookFilename } from "../src/lib/production-planning/workbook.ts";

/**
 * The Excel export — read back from the emitted bytes, with every formula EVALUATED.
 *
 * The owner asked for a workbook carrying the formulas themselves ("فيها برضو الفورمولاز"), so the
 * thing that has to be true is not "the file has 14 columns" but "changing the yellow cells inside
 * Excel produces the module's own answer". Three ways this test is deliberately harder than the
 * obvious one:
 *
 *  1. 🔴 IT NEVER READS A CACHED RESULT. ExcelJS drops a cached result of exactly 0, so a workbook
 *     whose formulas were all written as `0` would pass a cache-reading test on every zero cell. The
 *     evaluator below resolves each formula through its references instead — which is also the only
 *     way to catch a formula that points at the wrong row.
 *  2. The expected numbers come from the ENGINE, not from this file. `computePlan` is run over the
 *     same Ivyronc fixtures the engine test uses, and the sheet is then required to reproduce its
 *     answer — so a change to the engine cannot leave the workbook quietly behind.
 *  3. The four figures the owner verified by hand are asserted as literals as well: 8 runs, 106,000
 *     boxes, ivy 72.1 kg, packaging 109,180. If the engine and the sheet ever agree on something he
 *     did not agree to, this is where it shows.
 *
 * What it does NOT cover, said plainly: whether EXCEL renders the sheet right-to-left in Tahoma.
 * That is a render, and the only honest test of it is opening the file. What is pinned here is that
 * the view carries `rightToLeft`, that no cell is left on a Latin-only face, and that nothing on the
 * sheet is aligned to an explicit side — the three things the code can be held to.
 */

const BUILDER = "src/lib/production-planning/workbook.ts";

/** kg → micro grams in one display unit, exactly as the engine test spells it. */
const KG = BigInt(1_000) * QTY_SCALE;
const PIECE = QTY_SCALE;
const EGPI = "loc-egpi";
const SATO_STORE = "loc-sato";

function loadedMaterial(overrides: Partial<LoadedMaterial> & Pick<LoadedMaterial, "code">): LoadedMaterial {
  return {
    id: overrides.id ?? `mat-${overrides.code}`,
    code: overrides.code,
    nameAr: overrides.nameAr ?? overrides.code,
    nameEn: overrides.nameEn ?? overrides.code,
    unitKind: overrides.unitKind ?? "mass",
    baseUnit: overrides.baseUnit ?? "g",
    displayUnit: overrides.displayUnit ?? "kg",
    basePerDisplay: overrides.basePerDisplay ?? KG,
    isImported: overrides.isImported ?? false,
    leadTimeDays: overrides.leadTimeDays ?? null,
    minOrderQty: overrides.minOrderQty ?? null,
    purchaseIncrement: overrides.purchaseIncrement ?? null,
    reorderCoverRuns: overrides.reorderCoverRuns ?? null,
    sortOrder: overrides.sortOrder ?? 1,
    notes: overrides.notes ?? null,
  };
}

const MATERIALS: LoadedMaterial[] = [
  loadedMaterial({ code: "IVY_EXTRACT", isImported: true, leadTimeDays: 180, nameAr: "مستخلص اللبلاب", sortOrder: 1 }),
  loadedMaterial({ code: "SORBITOL", nameAr: "سوربيتول", sortOrder: 2 }),
  loadedMaterial({
    basePerDisplay: PIECE,
    baseUnit: "piece",
    code: "CARTON",
    displayUnit: "piece",
    nameAr: "كرتونة",
    sortOrder: 3,
    unitKind: "count",
  }),
  loadedMaterial({ code: "POTASSIUM_SORBATE", nameAr: "سوربات البوتاسيوم", sortOrder: 4 }),
];

const COMPOSITIONS = [
  // 35 mg of ivy extract per 5 ml dose, which is 70 kg of extract in 2,000,000 doses.
  { basis: "per_dose" as const, effectiveFrom: "2026-01-01", materialId: "mat-IVY_EXTRACT", notes: null, overagePct: null, qtyPerBasis: parseQty("0.035"), supplier: "sato" as const },
  { basis: "per_dose" as const, effectiveFrom: "2026-01-01", materialId: "mat-SORBITOL", notes: null, overagePct: null, qtyPerBasis: parseQty("2"), supplier: "sato" as const },
  { basis: "per_packaging_set" as const, effectiveFrom: "2026-01-01", materialId: "mat-CARTON", notes: null, overagePct: null, qtyPerBasis: parseQty("1"), supplier: "sato" as const },
  // Nobody has settled this one with the factory, so it must never reach a buy list — or the cost block.
  { basis: "per_dose" as const, effectiveFrom: "2026-01-01", materialId: "mat-POTASSIUM_SORBATE", notes: null, overagePct: null, qtyPerBasis: parseQty("0.0067"), supplier: "shared_unsettled" as const },
];

function planningData(): ProductionPlanningData {
  return {
    level: "full",
    products: [
      {
        code: "IVYRONC",
        geometry: {
          doseMl: BigInt(5),
          goodUnitMl: BigInt(100),
          runVolumeMl: BigInt(1_250_000),
          sampleUnitMl: BigInt(40),
          unitsPerBox: BigInt(1),
          wholeRunsOnly: true,
        },
        // Ivyronc's own factory, named on the PRODUCT: `locations.find((l) => l.isFactory)` took the
        // first flagged row, so a second factory anywhere in the table would have moved this split.
        factoryLocationId: EGPI,
        id: "prod-ivyronc",
        manufacturerName: "EGPI",
        measureUnit: "ml",
        nameAr: "آيفيرونك",
        nameEn: "Ivyronc",
        notes: null,
      },
    ],
    locations: [
      { code: "EGPI", id: EGPI, isFactory: true, nameAr: "المصنع", nameEn: "EGPI" },
      { code: "SATO_STORE", id: SATO_STORE, isFactory: false, nameAr: "مخزن ساتو", nameEn: "Sato store" },
    ],
    materials: MATERIALS,
    // All four belong to Ivyronc. The scoping is what keeps a second product's materials off this
    // product's buy list, so the fixture has to carry it or the sheet would be built from every
    // material in the module.
    materialIdsByProductId: new Map([["prod-ivyronc", new Set(MATERIALS.map((material) => material.id))]]),
    compositionsByProductId: new Map([["prod-ivyronc", COMPOSITIONS]]),
    // `expiryDate: null` throughout, which is what every Ivyronc row carries: the lots arrived with
    // Guamusin, and a null-dated row is one lot whose sum is itself — so these figures cannot move.
    stock: [
      { asOfDate: "2026-10-01", expiryDate: null, locationId: EGPI, materialId: "mat-IVY_EXTRACT", note: null, qty: parseQty("43000"), source: "factory_report" },
      { asOfDate: "2026-10-01", expiryDate: null, locationId: EGPI, materialId: "mat-SORBITOL", note: null, qty: parseQty("299000"), source: "factory_report" },
      { asOfDate: "2026-10-01", expiryDate: null, locationId: EGPI, materialId: "mat-CARTON", note: null, qty: parseQty("13850"), source: "factory_report" },
      // 🔴 SATO'S OWN STORE HOLDS SOME OF THE IVY, and that is here on purpose: it is the only thing
      // that tells the two stock columns apart. What he must BUY is measured against everything he
      // owns, but what is left at the factory after the run is measured against the factory alone —
      // he sends from his own store, the run never reaches it. With this row at zero, a sheet that
      // subtracted the requirement from both locations computed the same answer and the break test
      // could not see the difference.
      { asOfDate: "2026-10-01", expiryDate: null, locationId: SATO_STORE, materialId: "mat-IVY_EXTRACT", note: null, qty: parseQty("7000"), source: "own_count" },
    ],
    prices: [
      { currency: "USD", effectiveFrom: "2026-01-01", materialId: "mat-IVY_EXTRACT", pricePerDisplayUnit: parseQty("120"), supplierName: null },
      { currency: "EGP", effectiveFrom: "2026-01-01", materialId: "mat-SORBITOL", pricePerDisplayUnit: parseQty("45"), supplierName: null },
    ],
    settings: {
      alarmDryRun: true,
      alarmEnabled: false,
      alarmLastEvaluatedOn: null,
      alarmLastSentOn: null,
      defaultOveragePct: parsePct("3"),
      expiryAlarmDryRun: true,
      expiryAlarmEnabled: false,
      expiryLastEvaluatedOn: null,
      expiryLastSentOn: null,
      expiryWarnDays: 90,
      fxFallbackUsdToEgp: null,
      fxFetchDryRun: true,
      fxFetchEnabled: false,
      reorderCoverRuns: QTY_SCALE,
      updatedAt: null,
      updatedByLogin: null,
    },
    fx: { rateDate: "2026-10-05", source: "manual", usdToEgpMicro: BigInt(48) * QTY_SCALE },
    learning: new Map(),
  };
}

/** The wire material the workbook reads, derived from the same fixture the engine ran on. */
function wireMaterials(): WireMaterial[] {
  return MATERIALS.map((material) => {
    const composition = COMPOSITIONS.find((row) => row.materialId === material.id) ?? null;
    const price = planningData().prices.find((row) => row.materialId === material.id) ?? null;
    return {
      // This fixture has ONE product, so nothing is shared and the warning is genuinely empty here.
      alsoUsedByProductIds: [],
      supplier: composition?.supplier ?? null,
      basePerDisplay: (material.basePerDisplay / QTY_SCALE).toString(),
      baseUnit: material.baseUnit,
      code: material.code,
      composition: composition
        ? {
            basis: composition.basis,
            effectiveFrom: composition.effectiveFrom,
            notes: null,
            overagePct: null,
            qtyPerBasis: (Number(composition.qtyPerBasis) / Number(QTY_SCALE)).toString(),
            supplier: composition.supplier,
          }
        : null,
      displayUnit: material.displayUnit,
      // Empty for the same reason `stock` is: the workbook reads neither, because every held figure
      // on the sheet comes through `plan.rows` — the engine's own answer, already summed over lots.
      heldByLocation: [],
      id: material.id,
      isImported: material.isImported,
      leadTimeDays: material.leadTimeDays,
      learning: null,
      minOrderQty: null,
      nameAr: material.nameAr,
      nameEn: material.nameEn,
      notes: null,
      price: price
        ? {
            currency: price.currency,
            effectiveFrom: price.effectiveFrom,
            pricePerDisplayUnit: (Number(price.pricePerDisplayUnit) / Number(QTY_SCALE)).toString(),
            supplierName: null,
          }
        : null,
      purchaseIncrement: null,
      reorderCoverRuns: null,
      stock: [],
      unitKind: material.unitKind,
    };
  });
}

function workspaceFor(plan: WirePlan): WireWorkspace {
  const data = planningData();
  return {
    canWrite: true,
    // No lot is near its date in this fixture, so the banner is empty and the sheet is the only
    // thing under test. `tests/production-planning-expiry.test.ts` is where the verdicts are pinned.
    expiry: [],
    fx: { rate: "48", rateDate: "2026-10-05", source: "manual" },
    level: "full",
    locations: data.locations,
    materials: wireMaterials(),
    plan,
    plans: [],
    productId: "prod-ivyronc",
    products: [
      {
        code: "IVYRONC",
        doseMl: "5",
        factoryLocationId: EGPI,
        goodUnitMl: "100",
        id: "prod-ivyronc",
        manufacturerName: "EGPI",
        measureUnit: "ml",
        nameAr: "آيفيرونك",
        nameEn: "Ivyronc",
        notes: null,
        runVolumeMl: "1250000",
        sampleUnitMl: "40",
        unitsPerBox: "1",
        wholeRunsOnly: true,
      },
    ],
    // The workbook must not read this — it is a Settings-tab control, and a retired material has no
    // place on a buy list. Empty here is the assertion.
    retiredMaterials: [],
    allMaterials: [],
    runs: [],
    settings: {
      alarmDryRun: true,
      alarmEnabled: false,
      alarmLastEvaluatedOn: null,
      alarmLastSentOn: null,
      defaultOveragePct: "3",
      expiryAlarmDryRun: true,
      expiryAlarmEnabled: false,
      expiryLastEvaluatedOn: null,
      expiryLastSentOn: null,
      expiryWarnDays: 90,
      fxFallbackUsdToEgp: null,
      fxFetchDryRun: true,
      fxFetchEnabled: false,
      reorderCoverRuns: "1",
      updatedAt: null,
      updatedByLogin: null,
    },
  };
}

// ── A small Excel evaluator, over the formulas this workbook actually writes ─────────────────────

/**
 * Excel's own semantics for the five functions the sheet uses. ROUNDUP goes AWAY from zero (which is
 * what makes 7.52 runs into 8), and the epsilon is there because the inputs reach it through a
 * division: without it a value that should be exactly 8 and arrives as 8.000000000000002 would round
 * to 9, which is a bug in this evaluator rather than in the sheet.
 */
const FN = {
  CEILING: (value: number, significance: number) => Math.ceil(value / significance) * significance,
  FLOOR: (value: number, significance: number) => Math.floor(value / significance) * significance,
  IF: (condition: boolean, whenTrue: number, whenFalse: number) => (condition ? whenTrue : whenFalse),
  IFERROR: (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback),
  MAX: (...values: number[]) => Math.max(...values),
  MIN: (...values: number[]) => Math.min(...values),
  ROUNDUP: (value: number, digits: number) => {
    const factor = 10 ** digits;
    const scaled = value * factor;
    return Math.ceil(scaled - 1e-9 * Math.max(1, Math.abs(scaled))) / factor;
  },
};

function evaluateCell(sheet: ExcelJS.Worksheet, address: string, trail: string[] = []): number {
  const plain = address.replace(/\$/g, "").toUpperCase();
  assert.ok(!trail.includes(plain), `${plain} refers back to itself through ${trail.join(" -> ")}`);
  const cell = sheet.getCell(plain);
  const value = cell.value;
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return value;
  if (typeof value === "object" && "formula" in value) {
    return evaluateFormula(sheet, String((value as { formula: string }).formula), [...trail, plain]);
  }
  assert.fail(`${plain} holds ${JSON.stringify(value)}, which is not a number or a formula`);
}

function evaluateFormula(sheet: ExcelJS.Worksheet, formula: string, trail: string[] = []): number {
  // Ranges first, because a SUM's own range would otherwise be rewritten cell by cell into nonsense.
  let expression = formula.replace(
    /SUM\(\$?([A-Z]{1,2})\$?(\d+):\$?([A-Z]{1,2})\$?(\d+)\)/g,
    (_match, startColumn: string, startRow: string, endColumn: string, endRow: string) => {
      assert.equal(startColumn, endColumn, "this sheet only ever sums down one column");
      let total = 0;
      for (let rowNumber = Number(startRow); rowNumber <= Number(endRow); rowNumber += 1) {
        total += evaluateCell(sheet, `${startColumn}${rowNumber}`, trail);
      }
      return `(${total})`;
    },
  );

  // Then every remaining reference, which by now cannot be part of a range.
  expression = expression.replace(
    /\$?([A-Z]{1,2})\$?(\d+)/g,
    (_match, letters: string, rowNumber: string) => `(${evaluateCell(sheet, `${letters}${rowNumber}`, trail)})`,
  );

  for (const name of Object.keys(FN)) {
    expression = expression.replaceAll(`${name}(`, `FN.${name}(`);
  }

  assert.match(
    expression,
    /^[-+*/().,<>=\d\sA-Za-z]+$/,
    `the evaluator does not understand ${JSON.stringify(formula)} — add the function rather than loosening this`,
  );
  // A test-only evaluator over formulas this repo wrote itself, never over anything from the wire.
  const evaluate = new Function("FN", `return (${expression});`) as (fn: typeof FN) => number;
  const result = evaluate(FN);
  assert.ok(Number.isFinite(result), `${formula} evaluated to ${result}`);
  return result;
}

/** The address of the cell holding `label` in column A, so the test is not pinned to a row number. */
function rowOfLabel(sheet: ExcelJS.Worksheet, label: string): number {
  const matches: number[] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const text = row.getCell(1).value;
    if (typeof text === "string" && text === label) matches.push(row.number);
  });
  assert.ok(matches.length > 0, `the sheet should carry a row labelled ${JSON.stringify(label)}`);
  return matches[0]!;
}

function close(actual: number, expected: number, what: string, tolerance = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: the sheet computes ${actual}, the engine says ${expected}`,
  );
}

export async function runProductionPlanningWorkbookTests() {
  const data = planningData();
  const plan = computePlan(data, { mode: "total_boxes", productId: "prod-ivyronc", requestedQty: "100000", sampleUnits: "10000" });

  // The engine's own answer, which the sheet then has to reproduce. These four are the owner's.
  assert.equal(plan.runs, "8", "100,000 boxes with 10,000 samples is 7.52 runs, rounded up to 8");
  assert.equal(plan.goodUnits, "96000");
  assert.equal(plan.totalBoxes, "106000");
  assert.equal(plan.surplusBoxes, "6000");

  const { buffer, stats } = await buildProductionPlanningWorkbook(workspaceFor(plan), { actorName: "B-10" });
  assert.ok(buffer.length > 5_000, `the workbook should be a real file, got ${buffer.length} bytes`);
  assert.equal(stats.materials, plan.rows.length);

  // The second of the three layers this workbook needs is a structural check of the BYTES
  // (`node scripts/check-workbook-integrity.mjs <file>`), and the third is a LibreOffice render. Both
  // need the file on disk, which a test must not leave lying about — so it writes one on request:
  //   PHX_PP_WORKBOOK_DUMP=<path> node ... tests/run-tests.ts
  const dumpPath = process.env.PHX_PP_WORKBOOK_DUMP;
  if (dumpPath) writeFileSync(dumpPath, buffer);

  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = reopened.worksheets[0];
  assert.ok(sheet, "the workbook should carry its plan sheet");

  // ── The sheet is right-to-left, and not on a Latin-only face ──────────────────────────────────
  assert.ok(
    (sheet.views as { rightToLeft?: boolean }[]).some((view) => view.rightToLeft === true),
    "the worksheet view must carry rightToLeft — without it Excel lays an Arabic sheet out from the left",
  );
  let cells = 0;
  const faces = new Set<string>();
  const explicitSides: string[] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      cells += 1;
      faces.add(cell.font?.name ?? "(none)");
      const horizontal = cell.alignment?.horizontal;
      if (horizontal === "left" || horizontal === "right") explicitSides.push(cell.address);
    });
  });
  assert.ok(cells > 100, `the sheet should be fully written, found ${cells} cells`);
  assert.deepEqual(
    [...faces],
    [PRODUCTION_PLANNING_WORKBOOK_FONT],
    "every written cell carries the ONE Arabic-capable face — Excel has no fallback list, so a cell left on Calibri or Aptos renders boxes",
  );
  assert.deepEqual(
    explicitSides,
    [],
    "nothing is aligned to an explicit side: only `general` follows the sheet's own direction, and an explicit side pins a heading to the far end of every line it introduces",
  );

  // ── The inputs are typed values, in yellow ────────────────────────────────────────────────────
  const INPUT_LABELS = [
    "إجمالي العلب المطلوب",
    "عدد العينات المجانية",
    "حجم التشغيلة (مل)",
    // "الوحدة" and not "العلبة": the saleable unit is a 100 ml bottle here and a 5 g sachet for
    // Guamusin, and the unit in brackets is the PRODUCT's, not the column name's.
    "حجم الوحدة القابلة للبيع (مل)",
    "عدد الوحدات في العلبة",
    "سعر الصرف",
  ];
  for (const label of INPUT_LABELS) {
    const address = `B${rowOfLabel(sheet, label)}`;
    const cell = sheet.getCell(address);
    assert.equal(
      typeof cell.value,
      "number",
      `${label} is a cell he TYPES in, so it must hold a value and never a formula`,
    );
    const fill = cell.fill as { fgColor?: { argb?: string } } | undefined;
    assert.equal(
      fill?.fgColor?.argb,
      "FFFFF2B2",
      `${label} must be painted as an input — the sheet's own note tells him the yellow cells are the ones to change`,
    );
  }

  // ── The derived figures are FORMULAS, and they evaluate to the engine's answer ─────────────────
  const runsRow = rowOfLabel(sheet, "عدد التشغيلات");
  const runsCell = sheet.getCell(`B${runsRow}`);
  assert.ok(
    typeof runsCell.value === "object" && runsCell.value !== null && "formula" in runsCell.value,
    "the run count is the figure he will not take on trust, so it must be a visible formula and not a number",
  );
  assert.match(
    String((runsCell.value as { formula: string }).formula),
    /^ROUNDUP\(/,
    "runs are whole and round UP: 7.52 runs is eight runs, which is where the surplus comes from",
  );

  close(evaluateCell(sheet, `B${runsRow}`), 8, "the run count");
  close(evaluateCell(sheet, `B${rowOfLabel(sheet, "الناتج الفعلي")}`), 96_000, "the yield");
  // 🔴 TWO rows now, and they are not the same figure. The packaging-set count is what a cap, a
  // carton insert or a sticker is consumed per; the BOX count is `packagingSets / unitsPerBox`. The
  // sheet carried one cell for both, which is only correct while a box holds one unit — true for
  // Ivyronc and false for Guamusin's 12-sachet carton, where a per-packaging-set material would have
  // been understated twelve-fold. Both are pinned here, and the Guamusin block below is where they
  // are pinned APART.
  const packagingSetsRow = rowOfLabel(sheet, "إجمالي العبوات الكاملة");
  const boxesRow = rowOfLabel(sheet, "إجمالي العلب (الكراتين)");
  assert.notEqual(packagingSetsRow, boxesRow, "the packaging-set count and the box count are separate cells");
  close(evaluateCell(sheet, `B${packagingSetsRow}`), 106_000, "the packaging sets");
  close(evaluateCell(sheet, `B${boxesRow}`), 106_000, "the boxes delivered — one bottle per box, so the same figure");
  close(evaluateCell(sheet, `B${rowOfLabel(sheet, "الزيادة عن المطلوب")}`), 6_000, "the surplus over the ask");
  close(evaluateCell(sheet, `B${rowOfLabel(sheet, "إجمالي الجرعات")}`), 2_000_000, "the dose count");
  close(evaluateCell(sheet, `B${rowOfLabel(sheet, "الحجم الكلي (لتر)")}`), 10_000, "the total volume in litres");

  // ── Every material row: the sheet's own arithmetic against the engine's ────────────────────────
  const materialRowOf = new Map<string, number>();
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const text = row.getCell(1).value;
    if (typeof text !== "string") return;
    for (const planRow of plan.rows) {
      // The packaging row is spelled out on the sheet (see the language section below), so it is found
      // by that label; every other row by its stored name.
      const sheetName = planRow.code === "CARTON" ? "علبة التغليف" : planRow.nameAr;
      if (text.startsWith(sheetName) && !materialRowOf.has(planRow.materialId)) {
        materialRowOf.set(planRow.materialId, row.number);
      }
    }
  });
  assert.equal(
    materialRowOf.size,
    plan.rows.length,
    "every material the planner answered for has a row in the sheet",
  );

  for (const planRow of plan.rows) {
    const excelRow = materialRowOf.get(planRow.materialId)!;
    close(evaluateCell(sheet, `F${excelRow}`), Number(planRow.rawNeeded), `${planRow.nameAr} before the overage`);
    close(evaluateCell(sheet, `H${excelRow}`), Number(planRow.needed), `${planRow.nameAr} needed`);
    close(evaluateCell(sheet, `M${excelRow}`), Number(planRow.balanceAfter), `${planRow.nameAr} balance after the run`);
    // Cover is a reading, not money: the engine rounds a COUNT material's per-run requirement up to
    // a whole piece before dividing, and the sheet divides the whole requirement by the run count, so
    // the two agree to about a hundredth of a run on cartons and exactly on everything else.
    if (planRow.coverRuns !== null) {
      close(evaluateCell(sheet, `N${excelRow}`), Number(planRow.coverRuns), `${planRow.nameAr} cover`, 0.01);
    }
    if (planRow.contributesToBuyList) {
      close(evaluateCell(sheet, `K${excelRow}`), Number(planRow.toBuy), `${planRow.nameAr} to buy`);
    } else {
      // A material the factory supplies, or one nobody has settled, is NOT a zero in the buy column:
      // a zero reads as "nothing to buy", which is a different statement from "not agreed yet".
      assert.equal(
        sheet.getCell(`K${excelRow}`).value,
        "—",
        `${planRow.nameAr} contributes to no buy list, so its purchase cell must not read as a zero`,
      );
    }
  }

  // The three figures the owner checked by hand for these 8 runs, read off the sheet's own formulas.
  const ivyRow = materialRowOf.get("mat-IVY_EXTRACT")!;
  const sorbitolRow = materialRowOf.get("mat-SORBITOL")!;
  const cartonRow = materialRowOf.get("mat-CARTON")!;
  close(evaluateCell(sheet, `H${ivyRow}`), 72.1, "ivy extract for 8 runs at 3%");
  close(evaluateCell(sheet, `H${sorbitolRow}`), 4_120, "sorbitol for 8 runs at 3%");
  close(evaluateCell(sheet, `H${cartonRow}`), 109_180, "packaging for 8 runs at 3%");

  // ── The cost block, and the total that sums it ─────────────────────────────────────────────────
  const costTotalRow = rowOfLabel(sheet, "إجمالي التكلفة");
  const usdTotalCell = sheet.getCell(`E${costTotalRow}`);
  assert.match(
    String((usdTotalCell.value as { formula?: string })?.formula ?? ""),
    /^SUM\(/,
    "the cost total is a SUM over the rows above it, so editing a price moves the total",
  );
  // To the cent, not to the micro unit: the module carries money at 1e4 and prints it at two
  // decimals, while Excel keeps the whole product of a price and a quantity. The difference is
  // rounding for display, and asserting it tighter would be asserting that Excel rounds like us.
  close(evaluateCell(sheet, `E${costTotalRow}`), Number(plan.totals.costUsd), "the dollar total", 0.01);
  close(evaluateCell(sheet, `F${costTotalRow}`), Number(plan.totals.costEgp), "the pound total", 0.01);
  assert.ok(Number(plan.totals.costUsd) > 0, "the fixture prices two materials, so the total is not a vacuous zero");

  // ── The builder itself keeps the module's two number rules ────────────────────────────────────
  const source = readFileSync(BUILDER, "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(!code.includes('"ar-EG"'), "ar-EG emits Arabic-Indic digits and ج.م. — the owner chose Latin digits");
  assert.ok(!/style:\s*"currency"/.test(code), "a currency style inserts an ICU-dependent space; the currency is a label here");
  assert.ok(
    !code.includes("Calibri") && !code.includes("Aptos"),
    "the Arabic sheet never declares a Latin-only face",
  );
  assert.ok(
    !code.includes("outlineProperties"),
    "outlineProperties beside fitToPage makes Excel repair the workbook silently — neither belongs here",
  );

  // ── The export follows the language toggle, direction included ────────────────────────────────
  //
  // The owner chose the module's language with a toggle (2026-10-06) and the download carries that
  // choice as `?lang=`. A sheet whose STRINGS are English while its view is still right-to-left is
  // the half-done version of this: Excel then lays column A on the right of an English sheet, which
  // reads as a corrupt file rather than as a language. So both halves are asserted together.
  // The route asks the service for the plan in the SAME language as the sheet (`lang` is forwarded to
  // `getProductionPlanningWorkspace`), so the header sentence comes out English; building the plan
  // without it here would put an Arabic sentence on an English sheet that production never makes.
  const englishPlan = computePlan(data, {
    lang: "en",
    mode: "total_boxes",
    productId: "prod-ivyronc",
    requestedQty: "100000",
    sampleUnits: "10000",
  });
  const { buffer: englishBuffer } = await buildProductionPlanningWorkbook(workspaceFor(englishPlan), {
    actorName: "B-10",
    lang: "en",
  });
  const englishBook = new ExcelJS.Workbook();
  await englishBook.xlsx.load(englishBuffer as unknown as ArrayBuffer);
  const englishSheet = englishBook.worksheets[0];
  assert.ok(englishSheet, "the English workbook should carry its plan sheet too");
  assert.ok(
    (englishSheet!.views as { rightToLeft?: boolean }[]).every((view) => view.rightToLeft !== true),
    "an English sheet must NOT be right-to-left — the direction follows the language, not the module",
  );
  let englishText = "";
  englishSheet!.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (typeof cell.value === "string") englishText += `${cell.value}\n`;
    });
  });
  assert.ok(englishText.length > 0, "the English sheet should carry text at all");
  // The owner, 2026-10-08: "If English, every single Arabic word" - the product and material NAMES
  // included. They are stored in both languages, so the English sheet reads `nameEn` and carries no
  // Arabic character anywhere, which is the assertion a half-applied language fails.
  const arabicInEnglish = englishText.match(/[؀-ۿ]+/g);
  assert.equal(
    arabicInEnglish,
    null,
    `the English sheet still carries Arabic: ${JSON.stringify(arabicInEnglish)}`,
  );
  assert.ok(englishText.includes("Ivyronc"), "the English sheet names the product by its English name");
  // The owner, 2026-10-08: the packaging material is `Box`, and the sheet also says "Total boxes" for
  // the product count — so the packaging ROW is spelled out in the export, in both languages, and the
  // bare stored name never stands in for it. Asserted on the row's own text, not a substring of the
  // sheet, so the product-count labels cannot satisfy it.
  assert.ok(
    englishText.split("\n").some((line) => line.startsWith("Packaging box (")),
    "the English sheet should name the packaging row 'Packaging box', not the bare 'Box' that the product count also uses",
  );
  assert.ok(
    !englishText.split("\n").some((line) => line.startsWith("Box (")),
    "no English material row may be the bare 'Box'",
  );
  const arabicRows: string[] = [];
  sheet!.eachRow({ includeEmpty: false }, (row) => {
    const text = row.getCell(1).value;
    if (typeof text === "string") arabicRows.push(text);
  });
  assert.ok(
    arabicRows.some((line) => line.startsWith("علبة التغليف (")),
    "the Arabic sheet should name the packaging row 'علبة التغليف' (packaging box), not the bare stored name",
  );
  assert.ok(
    !arabicRows.some((line) => line.startsWith("علبة (") || line.startsWith("كرتونة (")),
    "no Arabic material row may be the bare stored packaging name",
  );
  assert.ok(
    !/[^ -~]/.test(productionPlanningWorkbookFilename(plan)),
    "the download's filename is plain ASCII whichever language asked for the sheet",
  );
  // The section titles are checked by name as well, so a sweep that passes on an EMPTY sheet cannot.
  for (const key of ["sheetInputsTitle", "sheetOutputsTitle", "sheetMaterialsTitle", "sheetCostTitle"] as const) {
    assert.ok(
      englishText.includes(PP_EN[key]),
      `the English sheet is missing ${key} (${JSON.stringify(PP_EN[key])}) — the language did not reach the labels`,
    );
    assert.ok(
      !englishText.includes(PP[key]),
      `the English sheet still carries the ARABIC ${key} (${JSON.stringify(PP[key])})`,
    );
  }
  // An unreadable `?lang=` falls back to Arabic rather than to a blank sheet, the same way the
  // screen does — the value arrives off a query string and anything can put anything there.
  const { buffer: junkBuffer } = await buildProductionPlanningWorkbook(workspaceFor(plan), {
    actorName: "B-10",
    lang: "klingon",
  });
  const junkBook = new ExcelJS.Workbook();
  await junkBook.xlsx.load(junkBuffer as unknown as ArrayBuffer);
  assert.ok(
    (junkBook.worksheets[0]!.views as { rightToLeft?: boolean }[]).some((view) => view.rightToLeft === true),
    "an unreadable lang falls back to the Arabic sheet, right-to-left and all",
  );
}
