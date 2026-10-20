import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import { dosesPerRun, type RunGeometry, yieldForRuns } from "../src/lib/production-planning/geometry.ts";
import {
  formatQty,
  MEASURE_UNITS,
  MEASURE_UNITS_PER_LARGE,
  parsePct,
  parseQty,
  QTY_SCALE,
} from "../src/lib/production-planning/rules.ts";
import {
  computePlan,
  materialsForProduct,
  otherProductsUsingMaterial,
  type LoadedComposition,
  type LoadedMaterial,
  type ProductionPlanningData,
} from "../src/lib/production-planning/service.ts";
import {
  measureUnitLabelsAr,
  measureUnitLabelsEn,
  runActualLabelAr,
  runActualLabelEn,
  runSizeLabelAr,
  runSizeLabelEn,
  saleableUnitWordAr,
  saleableUnitWordEn,
} from "../src/lib/production-planning/strings.ts";
import type { WireMaterial, WirePlan, WireWorkspace } from "../src/lib/production-planning/wire.ts";
import { buildProductionPlanningWorkbook } from "../src/lib/production-planning/workbook.ts";
import { stripSqlComments } from "./support/comment-strip.ts";

/**
 * Production Planner — Royanoxicam 8 mg, the THIRD product, and the millimetre-scale unit it needed.
 *
 * The owner sent Medizen's own two papers on 2026-10-20 — the bill of materials and page 1 of the
 * proposed declaration of composition, "بيان تركيب رويانوكسيكام فقط" — with one sentence of
 * geometry: **"batch size is 31 kg"**. A film-coated tablet weighs 155 mg, 200,000 of them are a
 * batch, and 20 go in a box.
 *
 * ── The two defects this file exists to keep fixed ──────────────────────────────────────────────
 *
 * Both read as perfectly correct on the syrup and the powder, which is why neither could be caught
 * before a third unit existed:
 *
 *  1. **A measure-unit branch written as a ternary sends an unknown unit down the SYRUP path.**
 *     `unit === "g" ? kilograms : litres` is exhaustive over two units and silently wrong over
 *     three: Royanoxicam's 155 mg dose would have rendered "155 مل", the same defect the pair was
 *     created to fix for Guamusin's sachet. Every one of those branches is a `Record<MeasureUnit, …>`
 *     now, so a fourth unit fails the type gate instead of labelling itself in millilitres.
 *  2. **The large-unit divisor was a literal 1,000.** True for ml→L and g→kg, and a thousand-fold
 *     overstatement for mg→kg: the batch tile would have read 31,000 kg, and the Excel export would
 *     have carried `/1000` inside a live FORMULA — every other figure on both still correct.
 *
 * The composition itself is asserted against the MIGRATION FILE rather than retyped here, so a
 * mistyped milligram in the SQL fails this test rather than reproducing itself in the assertion.
 */

const MIGRATION = "supabase/migrations/20261020200000_production_planning_royanoxicam.sql";

const MEDIZEN = "loc-medizen";
const SATO_STORE = "loc-sato";

/** Royanoxicam: a fixed 31 kg batch counted in MILLIGRAMS, 155 mg a tablet, 20 tablets a box. */
const ROYANOXICAM: RunGeometry = {
  doseMl: BigInt(155),
  goodUnitMl: BigInt(155),
  runVolumeMl: BigInt(31_000_000),
  sampleUnitMl: BigInt(155),
  unitsPerBox: BigInt(20),
  wholeRunsOnly: true,
};

const KG = BigInt(1_000) * QTY_SCALE;
const PIECE = QTY_SCALE;

function material(overrides: Partial<LoadedMaterial> & Pick<LoadedMaterial, "code">): LoadedMaterial {
  return {
    basePerDisplay: overrides.basePerDisplay ?? KG,
    baseUnit: overrides.baseUnit ?? "g",
    code: overrides.code,
    displayUnit: overrides.displayUnit ?? "kg",
    id: overrides.id ?? `mat-${overrides.code}`,
    isImported: overrides.isImported ?? false,
    leadTimeDays: overrides.leadTimeDays ?? null,
    minOrderQty: overrides.minOrderQty ?? null,
    nameAr: overrides.nameAr ?? overrides.code,
    nameEn: overrides.nameEn ?? overrides.code,
    notes: null,
    purchaseIncrement: overrides.purchaseIncrement ?? null,
    reorderCoverRuns: overrides.reorderCoverRuns ?? null,
    sortOrder: overrides.sortOrder ?? 1,
    unitKind: overrides.unitKind ?? "mass",
  };
}

const piece = (code: string, sortOrder: number) =>
  material({ basePerDisplay: PIECE, baseUnit: "piece", code, displayUnit: "piece", sortOrder, unitKind: "count" });

const LORNOXICAM = material({ code: "LORNOXICAM", sortOrder: 1 });
const LACTOSE = material({ code: "LACTOSE_MONO_200", sortOrder: 3 });
const BLISTER_ALU = material({ code: "BLISTER_ALU_ROYANOXICAM", sortOrder: 14 });
const BOX_20 = piece("BOX_ROYANOXICAM_20", 15);
const LEAFLET = piece("LEAFLET_ROYANOXICAM", 16);

const composition = (
  materialId: string,
  basis: LoadedComposition["basis"],
  qtyPerBasis: string,
  supplier: LoadedComposition["supplier"],
): LoadedComposition => ({
  basis,
  effectiveFrom: "2026-10-20",
  materialId,
  notes: null,
  // NULL, so every line inherits the module's own default. Guamusin's explicit zero was a Guamusin
  // decision and must not spread; Royanoxicam's 1.6 kg of active therefore buys 1.648.
  overagePct: null,
  qtyPerBasis: parseQty(qtyPerBasis),
  supplier,
});

function planningData(): ProductionPlanningData {
  return {
    compositionsByProductId: new Map([
      [
        "prod-royanoxicam",
        [
          composition(LORNOXICAM.id, "per_dose", "0.008", "sato"),
          composition(LACTOSE.id, "per_dose", "0.0995", "factory"),
          composition(BOX_20.id, "per_box", "1", "sato"),
          composition(LEAFLET.id, "per_box", "1", "sato"),
          // 🔴 BLISTER_ALU is deliberately absent: the BOM names no packaging, so how much foil a
          // box of twenty takes is recorded nowhere. Its row must read "no composition", never zero.
        ],
      ],
    ]),
    fx: { rateDate: "2026-10-20", source: "manual", usdToEgpMicro: BigInt(48) * QTY_SCALE },
    learning: new Map(),
    level: "full",
    locations: [
      { code: "MEDIZEN", id: MEDIZEN, isFactory: true, nameAr: "ميديزن", nameEn: "Medizen" },
      { code: "SATO_STORE", id: SATO_STORE, isFactory: false, nameAr: "مخزن ساتو", nameEn: "Sato store" },
    ],
    materialIdsByProductId: new Map([
      [
        "prod-royanoxicam",
        new Set([LORNOXICAM.id, LACTOSE.id, BLISTER_ALU.id, BOX_20.id, LEAFLET.id]),
      ],
    ]),
    materials: [LORNOXICAM, LACTOSE, BLISTER_ALU, BOX_20, LEAFLET],
    prices: [],
    products: [
      {
        code: "ROYANOXICAM",
        factoryLocationId: MEDIZEN,
        geometry: ROYANOXICAM,
        id: "prod-royanoxicam",
        manufacturerName: "Medizen Pharmaceutical Industries",
        measureUnit: "mg",
        nameAr: "رويانوكسيكام 8 مجم",
        nameEn: "Royanoxicam 8 mg",
        notes: null,
      },
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
    stock: [],
  };
}

function rowOf(plan: { rows: readonly { code: string }[] }, code: string) {
  const row = plan.rows.find((candidate) => candidate.code === code);
  assert.ok(row, `the plan should carry a row for ${code}`);
  return row as (typeof plan.rows)[number] & Record<string, string | boolean | null>;
}

/** Royanoxicam's workspace — enough of one for the sheet, which reads no held stock of its own. */
function workspaceFor(data: ProductionPlanningData, plan: WirePlan): WireWorkspace {
  const compositions = data.compositionsByProductId.get("prod-royanoxicam") ?? [];
  return {
    canWrite: true,
    expiry: [],
    fx: { rate: "48", rateDate: "2026-10-20", source: "manual" },
    level: "full",
    locations: data.locations,
    materials: materialsForProduct(data, "prod-royanoxicam").map((item): WireMaterial => {
      const row = compositions.find((candidate) => candidate.materialId === item.id) ?? null;
      return {
        alsoUsedByProductIds: otherProductsUsingMaterial(data, "prod-royanoxicam", item.id).map((p) => p.id),
        basePerDisplay: (item.basePerDisplay / QTY_SCALE).toString(),
        baseUnit: item.baseUnit,
        code: item.code,
        composition: row
          ? {
              basis: row.basis,
              effectiveFrom: row.effectiveFrom,
              notes: null,
              overagePct: null,
              qtyPerBasis: formatQty(row.qtyPerBasis),
              supplier: row.supplier,
            }
          : null,
        displayUnit: item.displayUnit,
        heldByLocation: [],
        id: item.id,
        isImported: item.isImported,
        leadTimeDays: item.leadTimeDays,
        learning: null,
        minOrderQty: null,
        nameAr: item.nameAr,
        nameEn: item.nameEn,
        notes: null,
        price: null,
        purchaseIncrement: null,
        reorderCoverRuns: null,
        stock: [],
        unitKind: item.unitKind,
      };
    }),
    plan,
    plans: [],
    productId: "prod-royanoxicam",
    products: data.products.map((product) => ({
      code: product.code,
      doseMl: product.geometry.doseMl.toString(),
      factoryLocationId: product.factoryLocationId,
      goodUnitMl: product.geometry.goodUnitMl.toString(),
      id: product.id,
      manufacturerName: product.manufacturerName,
      measureUnit: product.measureUnit,
      nameAr: product.nameAr,
      nameEn: product.nameEn,
      notes: null,
      runVolumeMl: product.geometry.runVolumeMl.toString(),
      sampleUnitMl: product.geometry.sampleUnitMl.toString(),
      unitsPerBox: product.geometry.unitsPerBox.toString(),
      wholeRunsOnly: product.geometry.wholeRunsOnly,
    })),
    retiredMaterials: [],
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

/** The row in column A carrying exactly this label. */
function rowOfLabel(sheet: ExcelJS.Worksheet, label: string): number {
  const matches: number[] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    if (row.getCell(1).value === label) matches.push(row.number);
  });
  assert.equal(matches.length, 1, `the sheet should carry exactly one row labelled ${JSON.stringify(label)}`);
  return matches[0]!;
}

/**
 * The migration's composition block, read back out of the SQL.
 *
 * 🔴 `\r` is stripped first: `core.autocrlf=true` puts CRLF in this laptop's working tree and the
 * CI runner checks out LF, so a reader that does not normalise is red here and green there.
 */
function compositionRowsFromMigration(): { code: string; basis: string; qty: number; supplier: string }[] {
  const sql = stripSqlComments(readFileSync(MIGRATION, "utf8").replace(/\r\n/g, "\n"));
  const rows: { code: string; basis: string; qty: number; supplier: string }[] = [];
  const pattern = /\('([A-Z0-9_]+)',\s*'(per_dose|per_box)',\s*([0-9.]+),\s*'(sato|factory)'/g;
  for (const match of sql.matchAll(pattern)) {
    rows.push({ basis: match[2]!, code: match[1]!, qty: Number(match[3]!), supplier: match[4]! });
  }
  return rows;
}

export async function runProductionPlanningRoyanoxicamTests() {
  // ── His one sentence of geometry: "batch size is 31 kg" ──────────────────────────────────────
  assert.equal(dosesPerRun(ROYANOXICAM), BigInt(200_000), "31 kg at 155 mg a tablet is 200,000 tablets");

  const oneRun = yieldForRuns(ROYANOXICAM, BigInt(1), BigInt(0));
  assert.equal(oneRun.goodUnits, BigInt(200_000), "a tablet is the saleable unit, so a batch is 200,000 of them");
  assert.equal(oneRun.totalBoxes, BigInt(10_000), "which is exactly 10,000 boxes of twenty");
  assert.equal(oneRun.leftoverMl, BigInt(0), "31,000,000 mg divides by 155 mg exactly — nothing is left over");

  // ── DEFECT 2: the large-unit divisor is NOT always a thousand ────────────────────────────────
  assert.equal(MEASURE_UNITS_PER_LARGE.mg, BigInt(1_000_000), "a kilogram is a million milligrams");
  assert.equal(MEASURE_UNITS_PER_LARGE.g, BigInt(1_000), "and still a thousand grams");
  assert.equal(MEASURE_UNITS_PER_LARGE.ml, BigInt(1_000), "and a litre a thousand millilitres");
  assert.deepEqual([...MEASURE_UNITS], ["ml", "g", "mg"], "three units, and every one of them carries a divisor");

  const data = planningData();
  const plan = computePlan(data, {
    mode: "total_boxes",
    productId: "prod-royanoxicam",
    requestedQty: "10000",
    sampleUnits: "0",
  });
  assert.equal(plan.runs, "1", "10,000 boxes is one whole batch, with nothing rounded up");
  assert.equal(plan.goodUnits, "200000");
  assert.equal(plan.totalBoxes, "10000");
  assert.equal(plan.surplusBoxes, "0");
  assert.equal(plan.measureUnit, "mg", "and the plan carries the unit it is counted in");
  // 🔴 31, not 31,000. Through the literal divisor this read a thousand-fold high while every other
  // figure in the same object stayed correct, which is what makes it worth an assertion of its own.
  assert.equal(plan.runVolumeLitres, "31", "the batch reads 31 kg — the owner's own words");
  assert.equal(plan.totalVolumeLitres, "31", "and one batch of it in total");

  // ── The buy list is the four lines he named, and only those ──────────────────────────────────
  // Owner, 2026-10-20: "loranoxiam and pamphlet and box and almunium are me others medizen".
  assert.equal(rowOf(plan, "LORNOXICAM").needed, "1.648", "1.6 kg of active plus the 3% default");
  assert.equal(rowOf(plan, "LORNOXICAM").contributesToBuyList, true, "Sato brings the active");
  assert.equal(rowOf(plan, "BOX_ROYANOXICAM_20").needed, "10300", "10,000 boxes plus the default waste");
  assert.equal(rowOf(plan, "LEAFLET_ROYANOXICAM").needed, "10300", "one leaflet a box, on the same basis");
  assert.equal(rowOf(plan, "BOX_ROYANOXICAM_20").contributesToBuyList, true);
  assert.equal(rowOf(plan, "LEAFLET_ROYANOXICAM").contributesToBuyList, true);

  // Medizen's eleven still show what a run CONSUMES — the lactose is 19.9 kg plus waste — and none
  // of them reaches the buy list. A missing row and an excluded row are different statements.
  assert.equal(rowOf(plan, "LACTOSE_MONO_200").needed, "20.497", "19.9 kg plus the 3% default");
  assert.equal(rowOf(plan, "LACTOSE_MONO_200").contributesToBuyList, false);
  assert.equal(rowOf(plan, "LACTOSE_MONO_200").excludedReason, "factory_supplies");

  // 🔴 The foil is a ROW WITH NO COMPOSITION, never a row with a zero. Sato supplies it, so the day
  // its per-box weight is entered it joins the buy list — and until then the screen says so.
  assert.equal(rowOf(plan, "BLISTER_ALU_ROYANOXICAM").excludedReason, "no_composition");
  assert.equal(rowOf(plan, "BLISTER_ALU_ROYANOXICAM").contributesToBuyList, false);

  // ── DEFECT 1: every label branch is exhaustive, and mg is not the syrup ──────────────────────
  assert.deepEqual(measureUnitLabelsEn("mg"), { large: "kg", small: "mg" });
  assert.deepEqual(measureUnitLabelsAr("mg"), { large: "كجم", small: "مجم" });
  assert.notEqual(
    measureUnitLabelsEn("mg").small,
    measureUnitLabelsEn("ml").small,
    "a milligram geometry must not fall through to the syrup branch — that is the whole defect",
  );
  assert.equal(saleableUnitWordEn("mg"), "tablet", "the saleable unit is a tablet, not a box");
  assert.equal(saleableUnitWordAr("mg"), "قرص");
  assert.equal(runSizeLabelEn("mg"), "Batch size", "a tablet batch is weighed, like the powder");
  assert.equal(runSizeLabelAr("mg"), "وزن التشغيلة", "never حجم, which is a volume");
  assert.equal(runActualLabelEn("mg"), "Tablets actually produced");
  assert.equal(runActualLabelAr("mg"), "الأقراص الناتجة فعليًا");

  // The two older products' labels, unmoved by the refactor from ternaries to records.
  assert.deepEqual(measureUnitLabelsEn("g"), { large: "kg", small: "g" });
  assert.deepEqual(measureUnitLabelsEn("ml"), { large: "L", small: "ml" });
  assert.equal(saleableUnitWordEn("g"), "sachet");
  assert.equal(saleableUnitWordEn("ml"), "box");
  assert.equal(runSizeLabelAr("ml"), "حجم التشغيلة", "the syrup keeps its volume noun");

  // ── The composition, read back out of the migration ──────────────────────────────────────────
  const seeded = compositionRowsFromMigration();
  const perDose = seeded.filter((row) => row.basis === "per_dose");
  assert.equal(perDose.length, 11, "eleven quantified lines — the Q.S water and alcohol carry none");

  // 🔴 THE TOTAL IS THE PROOF. Summed in milligrams rather than grams, because 0.0995 + 0.0005 in
  // floating point is not 0.1 and a tolerance would hide exactly the typo this check exists for.
  const totalMgPerTablet = perDose.reduce((sum, row) => sum + Math.round(row.qty * 1_000_000), 0);
  assert.equal(totalMgPerTablet, 155_000, "155.000 mg — 150 mg of core plus 5 mg of coat, one coated tablet");
  assert.equal(
    (totalMgPerTablet * 200_000) / 1_000_000_000,
    31,
    "and 200,000 tablets of it is exactly the 31 kg batch he stated",
  );

  const byCode = new Map(seeded.map((row) => [row.code, row]));
  assert.equal(byCode.get("LORNOXICAM")?.qty, 0.008, "8 mg of active a tablet");
  assert.equal(byCode.get("LACTOSE_MONO_200")?.qty, 0.0995, "99.5 mg of lactose");
  assert.equal(byCode.get("TITANIUM_DIOXIDE")?.qty, 0.00045, "0.45 mg of opacifier — the smallest line");

  assert.deepEqual(
    seeded.filter((row) => row.supplier === "sato").map((row) => row.code).sort(),
    ["BOX_ROYANOXICAM_20", "LEAFLET_ROYANOXICAM", "LORNOXICAM"],
    "the three Sato lines that HAVE a quantity; the aluminium is his too and has no line yet",
  );
  assert.equal(
    seeded.some((row) => row.code === "BLISTER_ALU_ROYANOXICAM"),
    false,
    "the foil is seeded as a material and NOT as a composition — a guessed weight is what this prevents",
  );
  assert.equal(
    seeded.some((row) => row.code === "PURIFIED_WATER" || row.code === "ETHYL_ALCOHOL"),
    false,
    "Q.S solvents that evaporate during processing have no per-tablet quantity to hold",
  );

  // The geometry, from the same file, so the SQL and this test cannot drift apart.
  const migrationSql = stripSqlComments(readFileSync(MIGRATION, "utf8").replace(/\r\n/g, "\n"));
  assert.match(
    migrationSql,
    /'mg',\s*31000000,\s*155,\s*155,\s*155,\s*true,\s*20,/,
    "31,000,000 mg a batch, a 155 mg tablet, 20 to a box",
  );
  assert.match(migrationSql, /'ml'::text,\s*'g'::text,\s*'mg'::text/, "and the CHECK lets the third unit in");

  // ── DEFECT 2 in the EXPORT, where it lives inside a formula he can read ──────────────────────
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(
    (await buildProductionPlanningWorkbook(workspaceFor(data, plan), { actorName: "B-10", lang: "en" })).buffer as never,
  );
  const sheet = book.worksheets[0]!;
  const runSizeSmallRow = rowOfLabel(sheet, "Batch size (mg)");
  const runSizeLargeRow = rowOfLabel(sheet, "Batch size (kg)");
  assert.equal(sheet.getCell(`B${runSizeSmallRow}`).value, 31_000_000, "the cell every formula reads is milligrams");

  // Asserted at its FORMULA, not its cached value: the cached number is only what we wrote, so it
  // would still read 31 after someone replaced the formula with a constant — and a constant is
  // exactly the edit that lets the two figures drift apart.
  const largeCell = sheet.getCell(`B${runSizeLargeRow}`).value as { formula?: string; result?: unknown };
  assert.equal(
    largeCell.formula,
    `$B$${runSizeSmallRow}/1000000`,
    "a million milligrams to the kilogram — /1000 would print this batch as 31,000 kg",
  );
  assert.equal(Number(largeCell.result), 31, "which comes to the 31 kg he stated");
}
