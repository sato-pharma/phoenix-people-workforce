import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import {
  dosesPerRun,
  resolveRunGeometry,
  type RunGeometry,
  yieldForRuns,
} from "../src/lib/production-planning/geometry.ts";
import { basisCountFor } from "../src/lib/production-planning/requirements.ts";
import { formatQty, parsePct, parseQty, QTY_SCALE } from "../src/lib/production-planning/rules.ts";
import {
  computePlan,
  evaluateExpiryForProduct,
  materialsForProduct,
  otherProductsUsingMaterial,
  type LoadedComposition,
  type LoadedMaterial,
  type ProductionPlanningData,
} from "../src/lib/production-planning/service.ts";
import {
  basisLabelsAr,
  basisLabelsEn,
  measureUnitLabelsAr,
  measureUnitLabelsEn,
} from "../src/lib/production-planning/strings.ts";
import type { WireMaterial, WirePlan, WireWorkspace } from "../src/lib/production-planning/wire.ts";
import { buildProductionPlanningWorkbook } from "../src/lib/production-planning/workbook.ts";
import { stripSqlComments } from "./support/comment-strip.ts";

/**
 * Production Planner — Guamusin, and Ivyronc not moving while it arrives.
 *
 * The owner sent this product's facts one message at a time on 2026-10-08, then filled in the data
 * workbook, then re-attached the corrected copy with "follow the sheet i uoploaded 100%". So the
 * figures asserted here are HIS, from `xlsx/Guamusin-data-checked.xlsx`: a powder in 5 g sachets,
 * a fixed 100 kg batch, 12 sachets to a carton, six runs ordered, made at DBK.
 *
 * Six runs is 600 kg, which is 120,000 sachets, which is exactly 10,000 cartons — and the paracetamol
 * at 1,000 mg a sachet is exactly the 120 kg his sheet asks for. Those three are the numbers he will
 * check first, so they are pinned first.
 *
 * ── The three defects this file exists to keep fixed ─────────────────────────────────────────────
 *
 * All three were latent, and every one of them reads as correct on Ivyronc alone:
 *
 *  1. **`per_packaging_set` is not the box count.** A sachet, a sticker and a carton are consumed at
 *     different rates once a box holds twelve units. The two were ONE cell on the sheet and ONE basis
 *     in the engine, which is right only while `unitsPerBox` is 1 — Ivyronc's bottle. On Guamusin a
 *     per-packaging-set material would have been understated twelve-fold.
 *  2. **An unscoped material list.** `data.materials` is every material in the module. Without the
 *     `prodplan_product_materials` join, Guamusin's thirteen lines would appear on Ivyronc's buy list
 *     as thirteen "formula not entered" rows and Ivyronc's on Guamusin's.
 *  3. **A shared `is_factory` flag.** The held/send split read the FIRST flagged location, so flagging
 *     DBK beside EGPI would have re-pointed Ivyronc's factory to whichever row sorted first — moving
 *     72 kg of ivy extract from "the factory already has it" to "send it".
 */

const MIGRATION = "supabase/migrations/20261008210000_production_planning_guamusin.sql";

const EGPI = "loc-egpi";
const DBK = "loc-dbk";
const SATO_STORE = "loc-sato";

/** Guamusin: a fixed 100 kg batch, counted in grams, 5 g a sachet, 12 sachets a carton. */
const GUAMUSIN: RunGeometry = {
  doseMl: BigInt(5),
  goodUnitMl: BigInt(5),
  runVolumeMl: BigInt(100_000),
  sampleUnitMl: BigInt(5),
  unitsPerBox: BigInt(12),
  wholeRunsOnly: true,
};

/** Ivyronc, unchanged: 1,250 L a run, a 5 ml dose, a 100 ml bottle, one bottle a box. */
const IVYRONC: RunGeometry = {
  doseMl: BigInt(5),
  goodUnitMl: BigInt(100),
  runVolumeMl: BigInt(1_250_000),
  sampleUnitMl: BigInt(40),
  unitsPerBox: BigInt(1),
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

// Guamusin's materials — four of his thirteen, enough to carry every basis the product uses.
const PARACETAMOL = material({ code: "PARACETAMOL_MICRO", sortOrder: 1 });
const GUAIFENESIN = material({ code: "GUAIFENESIN", isImported: true, leadTimeDays: 60, sortOrder: 2 });
const BOX_12 = piece("BOX_GUAMUSIN_12", 12);
const STICKER = piece("STICKER_GUAMUSIN", 13);
// Fixture-only, and the reason is in defect 1 above: no Guamusin material is per-packaging-set today,
// so without a line on that basis nothing would hold the two counts apart. A sachet-level packaging
// item is exactly what would arrive on this basis the day he adds one.
const SACHET_LEVEL = piece("FIXTURE_PER_SACHET_ITEM", 11);

// Ivyronc's, with the two figures of his that must not move.
const IVY_EXTRACT = material({ code: "IVY_EXTRACT", isImported: true, leadTimeDays: 180, sortOrder: 1 });
const SORBITOL = material({ code: "SORBITOL", sortOrder: 2 });
const CARTON_1 = piece("CARTON", 3);

/**
 * One composition row.
 *
 * `overagePct` is the real difference between the two products and not a fixture convenience:
 * Guamusin's rows carry an explicit ZERO, because the owner left the waste column empty until he has
 * measured it on a real run, while Ivyronc's carry NULL and fall through to the 3% default — which is
 * where his verified 72.1 kg, 4,120 kg and 109,180 pieces come from.
 */
const composition = (
  materialId: string,
  basis: LoadedComposition["basis"],
  qtyPerBasis: string,
  overagePct: bigint | null,
): LoadedComposition => ({
  basis,
  effectiveFrom: "2026-01-01",
  materialId,
  notes: null,
  overagePct,
  qtyPerBasis: parseQty(qtyPerBasis),
  supplier: "sato",
});

const ZERO_WASTE = parsePct("0");

function planningData(): ProductionPlanningData {
  return {
    compositionsByProductId: new Map([
      [
        "prod-guamusin",
        [
          // His per-sachet figures, in grams: 1,000 mg and 200 mg.
          composition(PARACETAMOL.id, "per_dose", "1", ZERO_WASTE),
          composition(GUAIFENESIN.id, "per_dose", "0.2", ZERO_WASTE),
          composition(BOX_12.id, "per_box", "1", ZERO_WASTE),
          composition(SACHET_LEVEL.id, "per_packaging_set", "1", ZERO_WASTE),
        ],
      ],
      [
        "prod-ivyronc",
        [
          composition(IVY_EXTRACT.id, "per_dose", "0.035", null),
          composition(SORBITOL.id, "per_dose", "2", null),
          composition(CARTON_1.id, "per_packaging_set", "1", null),
        ],
      ],
    ]),
    fx: { rateDate: "2026-10-05", source: "manual", usdToEgpMicro: BigInt(48) * QTY_SCALE },
    learning: new Map(),
    level: "full",
    locations: [
      { code: "EGPI", id: EGPI, isFactory: true, nameAr: "المصنع", nameEn: "EGPI" },
      // 🔴 DBK is flagged a factory TOO, deliberately: that is the state that would have moved
      // Ivyronc's split if the held/send code still read the first flagged row.
      { code: "DBK", id: DBK, isFactory: true, nameAr: "الدبيكي", nameEn: "DBK" },
      { code: "SATO_STORE", id: SATO_STORE, isFactory: false, nameAr: "مخزن ساتو", nameEn: "Sato store" },
    ],
    materialIdsByProductId: new Map([
      [
        "prod-guamusin",
        // 🔴 STICKER.id is DELIBERATELY ABSENT while the material stays in `materials` below: that is
        // what makes the exclusion a real assertion rather than the absence of a row.
        new Set([PARACETAMOL.id, GUAIFENESIN.id, SACHET_LEVEL.id, BOX_12.id]),
      ],
      ["prod-ivyronc", new Set([IVY_EXTRACT.id, SORBITOL.id, CARTON_1.id])],
    ]),
    materials: [PARACETAMOL, GUAIFENESIN, SACHET_LEVEL, BOX_12, STICKER, IVY_EXTRACT, SORBITOL, CARTON_1],
    prices: [],
    products: [
      {
        code: "GUAMUSIN",
        factoryLocationId: DBK,
        geometry: GUAMUSIN,
        id: "prod-guamusin",
        manufacturerName: "DBK",
        measureUnit: "g",
        nameAr: "جواموسين",
        nameEn: "Guamusin",
        notes: null,
      },
      {
        code: "IVYRONC",
        factoryLocationId: EGPI,
        geometry: IVYRONC,
        id: "prod-ivyronc",
        manufacturerName: "EGPI",
        measureUnit: "ml",
        nameAr: "آيفيرونك",
        nameEn: "Ivyronc",
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
    stock: [
      // 🔴 TWO LOTS of the same material at the same place — his Aspartame case, carried here on
      // Guaifenesin: 254.61 kg is what his sheet says DBK holds, and it arrived as two batches.
      { asOfDate: "2026-10-08", expiryDate: "2027-06-24", locationId: DBK, materialId: GUAIFENESIN.id, note: null, qty: parseQty("200000"), source: "factory_report" },
      { asOfDate: "2026-10-08", expiryDate: "2029-01-31", locationId: DBK, materialId: GUAIFENESIN.id, note: null, qty: parseQty("54610"), source: "factory_report" },
      { asOfDate: "2026-10-08", expiryDate: "2029-10-30", locationId: DBK, materialId: PARACETAMOL.id, note: null, qty: parseQty("14120"), source: "factory_report" },
      // Packaging, with no date at all: film, cartons and stickers never expire (his words).
      { asOfDate: "2026-10-08", expiryDate: null, locationId: DBK, materialId: BOX_12.id, note: null, qty: parseQty("11060"), source: "factory_report" },
      // Ivyronc's own rows, null-dated exactly as they stand in production today.
      { asOfDate: "2026-10-01", expiryDate: null, locationId: EGPI, materialId: IVY_EXTRACT.id, note: null, qty: parseQty("43000"), source: "factory_report" },
      { asOfDate: "2026-10-01", expiryDate: null, locationId: SATO_STORE, materialId: IVY_EXTRACT.id, note: null, qty: parseQty("7000"), source: "own_count" },
      { asOfDate: "2026-10-01", expiryDate: null, locationId: EGPI, materialId: SORBITOL.id, note: null, qty: parseQty("299000"), source: "factory_report" },
      { asOfDate: "2026-10-01", expiryDate: null, locationId: EGPI, materialId: CARTON_1.id, note: null, qty: parseQty("13850"), source: "factory_report" },
    ],
  };
}

function rowOf(plan: { rows: readonly { code: string }[] }, code: string) {
  const row = plan.rows.find((candidate) => candidate.code === code);
  assert.ok(row, `the plan should carry a row for ${code}`);
  return row as (typeof plan.rows)[number] & Record<string, string>;
}

/** Guamusin's workspace, enough of one for the sheet — the workbook reads no held stock of its own. */
function workspaceFor(data: ProductionPlanningData, plan: WirePlan): WireWorkspace {
  const compositions = data.compositionsByProductId.get("prod-guamusin") ?? [];
  return {
    canWrite: true,
    expiry: [],
    fx: { rate: "48", rateDate: "2026-10-05", source: "manual" },
    level: "full",
    locations: data.locations,
    materials: materialsForProduct(data, "prod-guamusin").map((item): WireMaterial => {
      const composition = compositions.find((row) => row.materialId === item.id) ?? null;
      return {
        // Through the real helper, not a hard-coded `[]`: a fixture that asserted "nothing else uses
        // it" would be the one shape this field exists to disprove.
        alsoUsedByProductIds: otherProductsUsingMaterial(data, "prod-guamusin", item.id).map((p) => p.id),
        supplier: composition?.supplier ?? null,
        basePerDisplay: (item.basePerDisplay / QTY_SCALE).toString(),
        baseUnit: item.baseUnit,
        code: item.code,
        composition: composition
          ? {
              basis: composition.basis,
              effectiveFrom: composition.effectiveFrom,
              notes: null,
              overagePct: "0",
              qtyPerBasis: formatQty(composition.qtyPerBasis),
              supplier: composition.supplier,
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
    productId: "prod-guamusin",
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
    // The sheet never reads the retired list — it is a Settings-tab control — and an empty one here
    // is what proves the workbook did not start depending on it.
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
 * Which row a material's basis-count cell POINTS AT.
 *
 * The cell is written as a bare reference to one derived figure, so the row number inside it IS the
 * basis the sheet thinks the recipe is written per — and a reference to the wrong row is a defect
 * that evaluates to a plausible number, which is why it is read as a reference and not as a value.
 */
function basisCountTarget(sheet: ExcelJS.Worksheet, materialRow: number): number {
  const targets: number[] = [];
  sheet.getRow(materialRow).eachCell((cell) => {
    const value = cell.value;
    if (typeof value !== "object" || value === null || !("formula" in value)) return;
    const match = /^\$B\$(\d+)$/.exec(String((value as { formula: string }).formula));
    if (match) targets.push(Number(match[1]));
  });
  assert.equal(targets.length, 1, `row ${materialRow} should carry exactly one bare basis-count reference`);
  return targets[0]!;
}

export async function runProductionPlanningGuamusinTests() {
  // ── His three headline figures ────────────────────────────────────────────────────────────────
  assert.equal(dosesPerRun(GUAMUSIN), BigInt(20_000), "a 100 kg batch at 5 g a sachet is 20,000 sachets");

  const sixRuns = yieldForRuns(GUAMUSIN, BigInt(6), BigInt(0));
  assert.equal(sixRuns.goodUnits, BigInt(120_000), "six runs is 600 kg, which is 120,000 sachets");
  assert.equal(sixRuns.packagingSets, BigInt(120_000), "and 120,000 sachets to fill");
  assert.equal(sixRuns.totalBoxes, BigInt(10_000), "which is exactly 10,000 cartons of twelve");
  assert.equal(sixRuns.leftoverMl, BigInt(0), "with nothing left over — 600 kg divides by 5 g exactly");

  // 🔴 A PART-BOX IS STILL A BOX — ROUNDED UP, NEVER DROPPED (owner, 2026-10-24: "Round up to a box").
  // Two runs with 10,000 samples are 40,000 sachets, which is 3,333 cartons of twelve and four sachets
  // over. The count used to FLOOR to 3,333, so those four sachets had no carton and no film, and every
  // `per_box` material was ordered one box short. One run on its own is 20,000 sachets: 1,667 boxes.
  const twoRunsWithSamples = yieldForRuns(GUAMUSIN, BigInt(2), BigInt(10_000));
  assert.equal(twoRunsWithSamples.packagingSets, BigInt(40_000), "two runs fill 40,000 sachets, samples included");
  assert.equal(twoRunsWithSamples.totalBoxes, BigInt(3_334), "3,333 full cartons plus one for the last four sachets");
  assert.equal(yieldForRuns(GUAMUSIN, BigInt(1), BigInt(0)).totalBoxes, BigInt(1_667), "one run is 1,666 boxes and a part-box");
  const partBoxPlan = computePlan(planningData(), {
    mode: "runs",
    productId: "prod-guamusin",
    requestedQty: "2",
    sampleUnits: "10000",
  });
  assert.equal(partBoxPlan.totalBoxes, "3334", "the screen's box count carries the part-box");
  const cartonLine = partBoxPlan.rows.find((row) => row.code === "BOX_GUAMUSIN_12");
  assert.equal(cartonLine?.basisCount, "3334", "and a carton is ordered for it");

  // 🔴 DEFECT 1, at its root. These two were ONE number for a year, and they are equal only while a
  // box holds one unit. 120,000 against 10,000 is the twelve-fold gap the sheet was carrying.
  assert.equal(basisCountFor("per_packaging_set", resolvedSix()), BigInt(120_000));
  assert.equal(basisCountFor("per_box", resolvedSix()), BigInt(10_000));
  assert.notEqual(
    basisCountFor("per_packaging_set", resolvedSix()),
    basisCountFor("per_box", resolvedSix()),
    "a per-packaging-set material and a per-box material cannot share a count once a box holds twelve",
  );
  // Both bases still agree on Ivyronc, which is why nothing showed: one bottle to a box.
  const ivyRun = resolveRunGeometry(IVYRONC, { mode: "total_boxes", requestedQty: BigInt(106_000), sampleUnits: BigInt(10_000) });
  assert.equal(basisCountFor("per_packaging_set", ivyRun), basisCountFor("per_box", ivyRun), "they agree at one unit a box");
  assert.equal(basisCountFor("per_dose", resolvedSix()), BigInt(120_000), "one sachet is one dose here");
  assert.equal(basisCountFor("per_good_unit", resolvedSix()), BigInt(120_000));
  assert.equal(basisCountFor("per_sample_unit", resolvedSix()), BigInt(0), "he asked for no free samples");

  // ── The plan, end to end, against his sheet ──────────────────────────────────────────────────
  const data = planningData();
  const plan = computePlan(data, { mode: "total_boxes", productId: "prod-guamusin", requestedQty: "10000", sampleUnits: "0" });
  assert.equal(plan.runs, "6", "10,000 cartons is six whole runs, with nothing rounded up");
  assert.equal(plan.goodUnits, "120000");
  assert.equal(plan.packagingSets, "120000");
  assert.equal(plan.totalBoxes, "10000");
  assert.equal(plan.surplusBoxes, "0", "six runs land exactly on his order");
  assert.equal(plan.measureUnit, "g", "and the plan carries the unit it is counted in");

  // 120 kg of paracetamol and 24 kg of guaifenesin — the two his sheet states for six runs.
  assert.equal(rowOf(plan, "PARACETAMOL_MICRO").needed, "120");
  assert.equal(rowOf(plan, "GUAIFENESIN").needed, "24");
  // 🔴 DEFECT 1 again, through the whole engine: the carton is per BOX and the fixture line is per
  // packaging SET, so one is 10,000 and the other 120,000 in the same plan.
  assert.equal(rowOf(plan, "BOX_GUAMUSIN_12").needed, "10000");
  // 🔴 NO STICKER. The owner corrected his own packaging list hours after it shipped — *"guamusin
  // have no stickers"* — and it had a LIVE `per_box` line, so every plan was putting 10,000 stickers
  // on his buy list. `20261008233000` drops the line and the join; Ivyronc's sticker is untouched.
  assert.equal(
    plan.rows.find((candidate) => candidate.code === "STICKER_GUAMUSIN"),
    undefined,
    "the Guamusin sticker is not a row on this plan at all",
  );
  assert.equal(rowOf(plan, "FIXTURE_PER_SACHET_ITEM").needed, "120000");

  // The lots are SUMMED for the held figure, so the buy list cannot see the split: 200,000 g and
  // 54,610 g of guaifenesin answer 254.61 kg, exactly as one row of 254,610 g did.
  assert.equal(rowOf(plan, "GUAIFENESIN").heldAtFactory, "254.61");
  assert.equal(rowOf(plan, "GUAIFENESIN").toBuy, "0", "254.61 kg against a 24 kg need buys nothing");

  // ── DEFECT 2: one product's materials never reach the other's list ───────────────────────────
  assert.deepEqual(
    materialsForProduct(data, "prod-guamusin").map((item) => item.code),
    ["PARACETAMOL_MICRO", "GUAIFENESIN", "FIXTURE_PER_SACHET_ITEM", "BOX_GUAMUSIN_12"],
  );
  assert.deepEqual(
    materialsForProduct(data, "prod-ivyronc").map((item) => item.code),
    ["IVY_EXTRACT", "SORBITOL", "CARTON"],
  );
  assert.deepEqual(materialsForProduct(data, null), [], "no product named is an empty list, never every material");
  assert.deepEqual(
    materialsForProduct(data, "prod-nothing").map((item) => item.code),
    data.materials.map((item) => item.code),
    "a product with no join rows still gets everything — the only way a pre-join product keeps working",
  );

  // ── DEFECT 3, and Ivyronc not moving ────────────────────────────────────────────────────────
  // His four verified Ivyronc figures, computed from a fixture where DBK is ALSO flagged a factory
  // and Guamusin's five materials sit in the same table. Both would have moved these before.
  const ivy = computePlan(data, { mode: "total_boxes", productId: "prod-ivyronc", requestedQty: "100000", sampleUnits: "10000" });
  assert.equal(ivy.runs, "8", "100,000 bottles with 10,000 samples is still 7.52 runs rounded up to 8");
  assert.equal(ivy.goodUnits, "96000");
  assert.equal(ivy.totalBoxes, "106000");
  assert.equal(ivy.surplusBoxes, "6000");
  assert.equal(ivy.measureUnit, "ml", "and Ivyronc is still a syrup");
  assert.equal(ivy.rows.length, 3, "three rows, not eight — Guamusin's five are not on this list");
  // 72.1 kg of ivy extract: the figure he verified by hand. The held column reads EGPI alone, which
  // is the thing a shared `is_factory` flag would have broken.
  assert.equal(rowOf(ivy, "IVY_EXTRACT").needed, "72.1", "70 kg plus the 3% default, which is his own figure");
  assert.equal(rowOf(ivy, "IVY_EXTRACT").heldAtFactory, "43", "EGPI's 43 kg, and not DBK's nothing");
  assert.equal(rowOf(ivy, "SORBITOL").needed, "4120");
  assert.equal(rowOf(ivy, "CARTON").needed, "109180");

  // ── The expiry verdicts are per product, and packaging never raises ─────────────────────────
  // Stood on 2027-05-01, the near guaifenesin lot is 54 days out and the far one is twenty months.
  const verdicts = evaluateExpiryForProduct(data, "prod-guamusin", "2027-05-01");
  assert.deepEqual(
    verdicts.map((verdict) => [verdict.code, verdict.expiryDate, verdict.severity]),
    [["GUAIFENESIN", "2027-06-24", "warning"]],
    "one lot of one material — the other batch, the paracetamol and the dated-nothing carton all stay quiet",
  );
  assert.equal(verdicts[0]!.qty, parseQty("200000"), "and it carries that LOT's 200 kg, not the material's 254.61");
  assert.deepEqual(
    evaluateExpiryForProduct(data, "prod-ivyronc", "2027-05-01"),
    [],
    "Ivyronc's rows carry no expiry date at all, so its planner is silent",
  );

  // ── The labels follow the product, not the column names ─────────────────────────────────────
  assert.deepEqual(measureUnitLabelsAr("g"), { large: "كجم", small: "جم" });
  assert.deepEqual(measureUnitLabelsAr("ml"), { large: "لتر", small: "مل" });
  assert.deepEqual(measureUnitLabelsEn("g"), { large: "kg", small: "g" });
  assert.deepEqual(measureUnitLabelsEn("ml"), { large: "L", small: "ml" });
  const gramLabels = basisLabelsAr({ dose: "5", goodUnit: "5", measureUnit: "g", sampleUnit: "5" });
  assert.equal(gramLabels.per_dose, "لكل جرعة 5 جم");
  assert.equal(gramLabels.per_box, "لكل علبة (كرتونة)");
  assert.notEqual(gramLabels.per_box, gramLabels.per_packaging_set, "and the two bases read differently on screen");
  assert.equal(basisLabelsEn({ dose: "5", goodUnit: "5", measureUnit: "g", sampleUnit: "5" }).per_box, "per box (carton)");

  // ── The SHEET keeps the two bases apart, not just the engine ────────────────────────────────
  // 🔴 This is the half the Ivyronc workbook test cannot see. Its sheet has carried separate cells
  // since this change, but at one bottle a box both hold 106,000 — so a per-packaging-set material
  // pointed at the BOX cell evaluates to the right number there and the test stays green. Guamusin's
  // sheet is the only place the reference itself can be held, and the figures are 120,000 and 10,000.
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(
    (await buildProductionPlanningWorkbook(workspaceFor(data, plan), { actorName: "B-10" })).buffer as never,
  );
  const sheet = book.worksheets[0]!;
  // Named with its own unit since 2026-10-08, and ONLY where a box holds more than one — Ivyronc's
  // sheet keeps the bare label, which `production-planning-workbook.test.ts` is what asserts.
  const packagingSetsRow = rowOfLabel(sheet, "إجمالي العبوات الكاملة (كيس)");
  const boxesRow = rowOfLabel(sheet, "إجمالي العلب (الكراتين)");
  assert.notEqual(packagingSetsRow, boxesRow, "two rows, because they are two figures");
  // The sheet rounds a part-box UP exactly as the engine does, so a sample count he edits in Excel
  // cannot leave the carton row a box short of the screen.
  const boxesFormula = (sheet.getCell(`B${boxesRow}`).value as { formula?: string }).formula;
  assert.equal(boxesFormula, `ROUNDUP($B$${packagingSetsRow}/$B$${rowOfLabel(sheet, "عدد الوحدات في العلبة")},0)`);

  // 🔴 THE RUN-SIZE CELL IS IN GRAMS AND THE كجم FIGURE IS DERIVED FROM IT. The total-doses formula
  // divides the gram cell by the gram dose, so writing 100 into it instead of 100,000 would divide
  // the entire sheet by a thousand with every figure still looking like a plausible quantity. The
  // noun is "وزن" and not "حجم", because the owner weighs this batch (*"1 run is 100kg not liter"*).
  const runSizeSmallRow = rowOfLabel(sheet, "وزن التشغيلة (جم)");
  const runSizeLargeRow = rowOfLabel(sheet, "وزن التشغيلة (كجم)");
  assert.equal(sheet.getCell(`B${runSizeSmallRow}`).value, 100_000, "the cell every formula reads is grams");

  // The كجم cell is asserted at its FORMULA and not at its cached value: the cached number is only
  // what we wrote into it, so it would still read 100 after someone replaced the formula with a
  // constant — and a constant is exactly the edit that lets the two figures drift apart.
  const largeCell = sheet.getCell(`B${runSizeLargeRow}`).value as { formula?: string; result?: unknown };
  assert.equal(
    largeCell.formula,
    `$B$${runSizeSmallRow}/1000`,
    "and the kilogram figure is DERIVED from it, never typed beside it",
  );
  assert.equal(Number(largeCell.result), 100, "which comes to the 100 kg he asked to read");

  // 🔴 The gram cell is what the total-doses formula divides, which is the whole reason it may not be
  // converted: `runs * runVolume / dose` with runVolume in kg and dose in g is out by a thousand.
  const dosesCell = sheet.getCell(`B${rowOfLabel(sheet, "إجمالي الجرعات")}`).value as { formula?: string };
  assert.ok(
    dosesCell.formula?.includes(`$B$${runSizeSmallRow}`),
    `the doses formula reads the GRAM cell — ${dosesCell.formula}`,
  );
  assert.ok(
    !dosesCell.formula?.includes(`$B$${runSizeLargeRow}`),
    "and never the kilogram one, which would divide the sheet by a thousand",
  );

  // `startsWith`, because the sheet spells a packaging line out beyond its stored name.
  const sheetRowOf = (code: string) => {
    const nameAr = data.materials.find((item) => item.code === code)!.nameAr;
    const matches: number[] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const text = row.getCell(1).value;
      if (typeof text === "string" && text.startsWith(nameAr)) matches.push(row.number);
    });
    // The FIRST match: a material appears twice on the sheet, once in the materials block and again
    // in the cost block, and it is the materials block that carries the basis-count reference.
    assert.ok(matches.length > 0, `the sheet should carry a row for ${code}`);
    return matches[0]!;
  };
  assert.equal(
    basisCountTarget(sheet, sheetRowOf("BOX_GUAMUSIN_12")),
    boxesRow,
    "a per-box material counts cartons — one box per twelve sachets",
  );
  assert.equal(
    basisCountTarget(sheet, sheetRowOf("FIXTURE_PER_SACHET_ITEM")),
    packagingSetsRow,
    "while a per-packaging-set material counts SACHETS — the twelve-fold gap the sheet used to miss",
  );
  assert.equal(
    basisCountTarget(sheet, sheetRowOf("PARACETAMOL_MICRO")),
    rowOfLabel(sheet, "إجمالي الجرعات"),
    "and a per-dose powder counts doses",
  );

  // ── The migration seeds HIS SHEET, to the microgram ─────────────────────────────────────────
  // Read as text and computed, not matched: the engine above can only be right about the numbers it
  // is given, and the one error nothing else here can see is a seed that drifts from the sheet he
  // told a session to follow 100%. So the migration's own per-dose figures are pulled out and added
  // up — they must be one whole 5 g sachet — and then multiplied by the 120,000 doses in six runs to
  // reproduce every "Need for 6 runs" cell he filled in.
  const sql = readFileSync(MIGRATION, "utf8");
  assert.match(sql, /100000, 5, 5, 5, true, 12,/, "a fixed 100 kg batch: a 5 g sachet, and twelve to a box");
  assert.match(sql, /'DBK Pharma',\s+'g',/, "counted in grams, which is what makes the labels say كجم and not لتر");

  const perDose = [...sql.matchAll(/\('([A-Z0-9_]+)',\s*'per_dose',\s*([\d.]+),/g)].map(
    (match) => [match[1]!, match[2]!] as const,
  );
  assert.equal(perDose.length, 10, "ten powders, which is what his declaration of composition lists");
  assert.equal(
    perDose.reduce((sum, [, qty]) => sum + parseQty(qty), BigInt(0)),
    parseQty("5"),
    "and they add to exactly one 5 g sachet — the arithmetic proof the milligrams were read right",
  );

  // His sheet's own "Need for 6 runs" column, in kilograms.
  const SHEET_KG: Record<string, string> = {
    ASPARTAME: "24",
    CITRIC_ACID_ANH: "1.2",
    GUAIFENESIN: "24",
    LEMON_FLAVOUR: "24",
    PARACETAMOL_MICRO: "120",
    PHENYLEPHRINE_HCL: "1.464",
    QUINOLINE_YELLOW_E104: "0.12",
    SACCHARIN_SODIUM: "10.2",
    SODIUM_CITRATE_ANH: "6",
    SUCROSE: "389.016",
  };
  for (const [code, qty] of perDose) {
    const fromSheet = SHEET_KG[code];
    assert.ok(fromSheet, `${code} is seeded but is not one of the ten lines on his sheet`);
    assert.equal(
      parseQty(qty) * BigInt(120_000),
      parseQty(fromSheet!) * BigInt(1_000),
      `${code}: six runs must come out at the ${fromSheet} kg his sheet states`,
    );
  }
  assert.equal(Object.keys(SHEET_KG).length, perDose.length, "and every line on the sheet is seeded");

  // The two packaging lines are per BOX — 10,000 each for six runs, never 120,000.
  const perBox = [...sql.matchAll(/\('([A-Z0-9_]+)',\s*'per_box',\s*([\d.]+),/g)].map((match) => match[1]!);
  // The seeding migration still lists both — history is not rewritten. The CORRECTION migration is
  // what removes the sticker, and this asserts that it does, by reading its own SQL.
  assert.deepEqual(perBox, ["BOX_GUAMUSIN_12", "STICKER_GUAMUSIN"]);
  const noStickers = readFileSync(
    "supabase/migrations/20261008233000_production_planning_guamusin_no_stickers.sql",
    "utf8",
  );
  assert.match(noStickers, /delete from public\.prodplan_compositions/, "it deletes the composition line");
  assert.match(noStickers, /delete from public\.prodplan_product_materials/, "and the product join");
  assert.match(noStickers, /set is_active = false/, "and deactivates rather than deletes the material");
  assert.ok(
    !/delete from public\.prodplan_materials/.test(noStickers),
    "🔴 it must never DELETE the material row — the LEAFLET precedent: a delete makes his own earlier packaging message unreadable against the data, and a later reactivation cannot be told from a fresh seeding",
  );
  // 🔴 IVYRONC'S OWN PACKAGING IS `CARTON` AND A BARE `STICKER`, AND "STICKER" IS A SUBSTRING OF
  // "STICKER_GUAMUSIN" — so `!includes("STICKER")` can never fail and proves nothing. What actually
  // protects Ivyronc is that every match is an EQUALITY on the full code: a single `like '%STICKER%'`
  // would deactivate the syrup's sticker too and read as a tidier version of the same migration.
  assert.ok(!/\bi?like\b/i.test(noStickers), "no LIKE anywhere — a pattern would catch Ivyronc's bare STICKER");
  // The comments are stripped before the codes below are read: the revert recipe in the header
  // quotes the very statements this checks, and would otherwise match its own docs.
  //
  // 🔴 `stripSqlComments`, never a `^\s*--` replace. A line filter judges a line by how it STARTS,
  // so a `--` written after real code survives it — and `tests/comment-strip-ratchet.test.ts` fails
  // the build on the hand-rolled spelling, which is how this line was caught.
  const sqlLines = stripSqlComments(noStickers);
  assert.match(sqlLines, /m\.code = 'STICKER_GUAMUSIN'/, "the joins match the full code");
  assert.match(sqlLines, /where code = 'STICKER_GUAMUSIN'/, "and so does the deactivation");
  for (const code of [...sqlLines.matchAll(/code = '([A-Z0-9_]+)'/g)].map((m) => m[1]!)) {
    assert.ok(
      code === "STICKER_GUAMUSIN" || code === "GUAMUSIN",
      `every code this migration names is Guamusin's own — found ${code}`,
    );
  }

  // ── Guamusin's leaflet, 2026-11-03 ───────────────────────────────────────────────────────────
  //
  // "in guamusin no field for pamphlets", answered "One per box" when asked. 🔴 per_box, never
  // per_packaging_set: on Guamusin that is the twelve-fold gap in defect 1, 120,000 leaflets where
  // six runs need 10,000.
  const leafletCode = stripSqlComments(
    readFileSync("supabase/migrations/20261103153203_production_planning_guamusin_leaflet.sql", "utf8"),
  );
  assert.match(
    leafletCode,
    /m\.unit_kind, 'per_box', 1\.000000, 'sato', 0, date '2026-11-03'/,
    "one leaflet per box, from Sato, with Guamusin's explicit zero waste rather than a null that inherits 3%",
  );
  assert.match(leafletCode, /not exists/, "and a re-run cannot open a second line, which would double the requirement");
  assert.ok(
    !/prodplan_stock_entries/.test(leafletCode),
    "no stock row — nobody has counted them, and a zero would say counted and none",
  );
  for (const code of [...leafletCode.matchAll(/p\.code = '([A-Z0-9_]+)'/g)].map((m) => m[1]!)) {
    assert.equal(code, "GUAMUSIN", "and it is linked to Guamusin alone");
  }

  // The aluminium film's stock, which the formula migration below deliberately does NOT touch: the
  // owner identified the 16,667 beside his 0.018 as boxes per run, not a holding, so 230.95 kg
  // stands.
  assert.match(sql, /SACHET_FILM_ALU/, "the film is a material");
  assert.match(sql, /230950\.000000, null/, "with 230.95 kg of stock and no expiry date");
  // 🔴 The SEED still carries no composition for it — the figure arrived hours later and lands in
  // its own migration. If this ever starts matching, two open lines exist for one material and
  // every plan silently asks for twice the film.
  assert.ok(
    !/\('SACHET_FILM_ALU',\s*'per_/.test(sql),
    "the seed opens no formula line for the film — the only one comes from 20261008234500",
  );

  // ── The aluminium film's formula line, 2026-10-08 ────────────────────────────────────────────
  //
  // The owner sent DBK's own table headed "Quantity Aluminum / box" reading 0.018, and confirmed
  // the basis when asked: 0.018 kg per box of twelve. Everything below pins the three ways that
  // number can be recorded wrongly.
  const filmSql = readFileSync(
    "supabase/migrations/20261008234500_production_planning_guamusin_film_per_box.sql",
    "utf8",
  );
  const filmCode = stripSqlComments(filmSql);

  // 🔴 GRAMS, NOT KILOGRAMS. `prodplan_materials.base_unit` for the film is `g` with
  // base_per_display 1000, and every composition in this module stores BASE units — so 0.018 kg is
  // 18. Writing 0.018 here would ask DBK for eighteen GRAMS of film for the whole 6-run order, a
  // thousandfold under-order that looks completely ordinary on the row.
  assert.match(filmCode, /\b18\.000000\b/, "18 grams per box — 0.018 kg in the module's base unit");
  // The check has to look OUTSIDE string literals: the `notes` column deliberately records "0.018
  // kg … per box" so the row can be read against his sheet, and a blanket search for 0.018 fires on
  // that prose instead of on a quantity. Splitting on the quote character puts every even segment
  // outside a literal; an odd quote count would mean the split is meaningless, so prove it first.
  const quoteCount = (filmCode.match(/'/g) ?? []).length;
  assert.equal(quoteCount % 2, 0, "unbalanced quotes — the outside-literals split below would be nonsense");
  const outsideLiterals = filmCode
    .split("'")
    .filter((_, index) => index % 2 === 0)
    .join(" ");
  assert.ok(
    !/\b0\.018\b/.test(outsideLiterals),
    "🔴 0.018 must not reach the SQL as a QUANTITY: that is the display figure in kg, and stored raw it under-orders the film a thousandfold while the row still reads normally",
  );
  assert.match(outsideLiterals, /\b18\.000000\b/, "the quantity itself sits outside any literal");
  assert.match(filmCode, /'per_box'/, "on the basis he gave, which is the one his own sheet can be checked against");
  assert.match(filmCode, /'SACHET_FILM_ALU'/, "for the film");
  assert.match(filmCode, /'mass'/, "whose unit_kind is mass, matching the material");

  // 🔴 THE IDEMPOTENCE GUARD IS THE LEAFLET LESSON. Two open composition lines for one material
  // double its requirement on every plan while each row still reads as ordinary — 68,250 pieces of
  // superseded leaflet nearly started covering new production that way. Re-running this insert must
  // be incapable of opening a second line.
  assert.match(
    filmCode,
    /not exists/,
    "🔴 the insert must be guarded — without it a re-run opens a SECOND open line and every plan silently asks for twice the film",
  );
  assert.match(filmCode, /c\.effective_to is null/, "and the guard must test for a line IN FORCE, not merely any row");

  // It touches the formula and nothing else: the 230.95 kg stays, because the owner said the 16,667
  // beside his 0.018 was boxes per run and not a holding.
  assert.ok(
    !/prodplan_stock_entries/.test(filmCode),
    "it must not touch stock — the 16,667 in his image is boxes per run, not a new holding",
  );
  assert.ok(
    !/\bdelete\b/i.test(filmCode),
    "and it deletes nothing",
  );

  // THE ARITHMETIC, through the real engine rather than by restating it here. Six runs is 120,000
  // sachets and exactly 10,000 boxes, so 18 g per box is 180 kg — comfortably inside the 230.95 kg
  // DBK holds, which is why this order needs no film at all.
  const filmSixRuns = resolvedSix();
  const filmGramsPerBox = BigInt(18) * QTY_SCALE;
  const boxesForSixRuns = filmSixRuns.totalBoxes;
  assert.equal(boxesForSixRuns, BigInt(10_000), "six runs is exactly 10,000 boxes of twelve");
  const filmNeeded = (filmGramsPerBox * boxesForSixRuns) / QTY_SCALE;
  assert.equal(filmNeeded, BigInt(180_000), "so the film needed is 180,000 g — 180 kg");
  assert.ok(
    filmNeeded * QTY_SCALE < BigInt(230_950) * QTY_SCALE,
    "which is under the 230.95 kg at DBK, so the 6-run order buys no film",
  );

  // Packaging carries a NULL expiry rather than a far-off placeholder — a placeholder would come due
  // one day and put all three packaging lines in his inbox.
  assert.match(sql, /11060\.000000, null/, "the boxes are dated nothing");
  // Aspartame is TWO lots at one place, which is the case the whole expiry column exists for.
  assert.match(sql, /124600\.000000, date '2027-05-09'/, "the near lot he has to use first");
  assert.match(sql, /23000\.000000, date '2026-10-08', date '2029-03-19'/, "and the far one, kept apart from it");
  // A rejected lot is a counted ZERO, which says something different from no row at all.
  assert.match(sql, /\('CITRIC_ACID_ANH',\s*0\.000000, null\)/);
  assert.match(sql, /\('SACCHARIN_SODIUM',\s*0\.000000, null\)/);

  // Three months ahead, which is the 90-day default he asked for.
  assert.match(sql, /expiry_warn_days integer not null default 90/);

  // ── Ivyronc's unrecorded excipients ───────────────────────────────────────────────────────────
  // Found while verifying Guamusin on 2026-10-08: Ivyronc linked 14 materials but carried only 8
  // composition lines in force, so its buy list silently understated FIVE of them — not the one a
  // memory note had claimed. Three are answered outright by his own order calculator
  // (`xlsx/Ivyronc - order calculator and stock ledger.xlsx`, sheet "Per batch", column
  // "Per 5 ml (gram)"). The figures are literals here because `xlsx/` is gitignored and CI never
  // sees the workbook — the same reason Guamusin's are literals above.
  const ivyFormula = stripSqlComments(
    readFileSync(
      "supabase/migrations/20261008235500_production_planning_ivyronc_missing_formula_lines.sql",
      "utf8",
    ),
  );

  // Grams per 5 ml dose, written through unchanged, because these materials' base unit IS the gram.
  // Contrast the aluminium film above, where his 0.018 kg per box had to become 18 g.
  assert.match(ivyFormula, /\('XANTHAN_GUM',\s*0\.005000, 'shared_unsettled'/);
  assert.match(ivyFormula, /\('CITRIC_ACID_ANH',\s*0\.005000, 'factory'/);
  assert.match(ivyFormula, /\('LEMON_FLAVOUR',\s*0\.003500, 'shared_unsettled'/);
  assert.match(ivyFormula, /'per_dose'/, "all three are dosed per 5 ml, never per bottle");
  assert.match(ivyFormula, /'mass'/, "and the composite FK demands the material's own unit_kind");

  // 🔴 `shared_unsettled` IS THE POINT, not a placeholder. His sheet files xanthan gum and lemon
  // flavour under "Sometimes you, sometimes the factory" with the "YOU WILL SEND" cell left blank,
  // so neither is his to buy yet; citric acid is the one the Settled tab gives to the factory
  // outright. Writing `sato` would invent a purchase, `factory` would hide one he may still owe.
  assert.ok(
    !/'XANTHAN_GUM',\s*[\d.]+, 'sato'/.test(ivyFormula),
    "🔴 xanthan gum is unsettled in his sheet — recording it as Phoenix's own invents a purchase he never agreed",
  );

  // The seal is one per bottle from the factory — HIS answer when asked, because the workbook puts
  // it outside the sheet with the bottle and cap and states no count. It is a `count` because the
  // composite FK demands the material's own unit_kind, and `per_packaging_set` because that is the
  // basis its two trio-mates already use; on Ivyronc one packaging set IS one bottle.
  assert.match(ivyFormula, /'ALUMINIUM_SEAL'/, "the seal now has its line");
  assert.match(
    ivyFormula,
    /'count',\s*'per_packaging_set',\s*1\.000000,/,
    "🔴 one per bottle, and a COUNT — a mass unit_kind would violate the composite FK to the material",
  );

  // 🔴 THE SCRAPPED OLD LEAFLET IS DEACTIVATED, NEVER GIVEN A FORMULA LINE. "100% forget about the
  // old leaflet. Only consider the new one" (owner, 2026-10-08). A line would demand 115,875
  // leaflets that are being thrown away; deactivating the material is what its own family already
  // did to the pre-split LEAFLET, and `service.ts` reads materials with `is_active = true`.
  assert.match(
    ivyFormula,
    /update public\.prodplan_materials[\s\S]*?set is_active = false[\s\S]*?where code = 'LEAFLET_OLD'/,
    "🔴 the old leaflet must be switched OFF",
  );
  assert.ok(
    !/\('LEAFLET_OLD'/.test(ivyFormula),
    "🔴 and it must never appear as a composition row — that would demand 115,875 scrapped leaflets",
  );
  assert.ok(
    !/LEAFLET_NEW/.test(ivyFormula),
    "the new leaflet already has its line and must not be touched",
  );
  // 🔴 The write-off record stays. Deleting the 68,250 would destroy the evidence, not hide it.
  assert.ok(
    !/prodplan_stock_entries/.test(ivyFormula),
    "🔴 no stock row is touched — the 68,250 scrapped leaflets stay on the books as the write-off",
  );
  assert.ok(
    !/\bdelete\b/i.test(ivyFormula),
    "and nothing is deleted",
  );

  // overage_pct stays null so it inherits the module's 3%, which is the overage his sheet applies.
  // Guamusin's explicit 0 is a Guamusin decision and must not be copied here.
  assert.match(ivyFormula, /spec\.qty_per_dose_g,\s*null,/, "overage_pct is left null to inherit the 3%");

  // The guard against a second open line — the defect the LEAFLET split exists to prevent.
  assert.match(ivyFormula, /not exists/);
  assert.match(ivyFormula, /c\.effective_to is null/);

  // And the engine reproduces his own "NEEDED for the whole order" cells rather than restating
  // them. One Ivyronc run is 1,250,000 ml at a 5 ml dose, so 250,000 doses — the "250,000 doses of
  // 5 ml" his sheet states for one batch.
  assert.equal(dosesPerRun(IVYRONC), BigInt(250_000), "1,250 litres at 5 ml a dose is 250,000 doses");
  assert.equal(
    (parseQty("0.005") * dosesPerRun(IVYRONC)) / QTY_SCALE,
    BigInt(1_250),
    "0.005 g a dose is his sheet's 1.25 kg of xanthan gum — and of citric acid — a batch",
  );
  assert.equal(
    (parseQty("0.0035") * dosesPerRun(IVYRONC)) / QTY_SCALE,
    BigInt(875),
    "and 0.0035 g a dose is his 0.875 kg of lemon flavour a batch",
  );
}

function resolvedSix() {
  return resolveRunGeometry(GUAMUSIN, { mode: "total_boxes", requestedQty: BigInt(10_000), sampleUnits: BigInt(0) });
}
