import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import { dosesPerRun, type RunGeometry, yieldForRuns } from "../src/lib/production-planning/geometry.ts";
import {
  formatQty,
  isBoughtBySato,
  type MaterialSupplier,
  MEASURE_UNITS,
  MEASURE_UNITS_PER_LARGE,
  parsePct,
  parseQty,
  QTY_SCALE,
} from "../src/lib/production-planning/rules.ts";
import {
  computePlan,
  effectiveSupplier,
  evaluateExpiryForProduct,
  type LoadedStock,
  materialsForProduct,
  otherProductsUsingMaterial,
  type LoadedComposition,
  type LoadedMaterial,
  type ProductionPlanningData,
  withProductSampleDefault,
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
 * batch, and 20 go in a box. The toll manufacturer moved from Medizen to Egyphar on 2026-10-21
 * at his word, which changed the factory and nothing else: the fixtures below carry Egyphar, and
 * every quantity in this file is still the one off those papers.
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
const FACTORY_MOVE = "supabase/migrations/20261021004800_production_planning_royanoxicam_egyphar.sql";
const NO_SAMPLES = "supabase/migrations/20261024150548_prodplan_products_default_sample_units.sql";
const SUPPLIER_LINK = "supabase/migrations/20261029000100_prodplan_product_materials_supplier.sql";
const MEDIZEN_MIGRATION = "supabase/migrations/20261029040000_production_planning_royanoxicam_medizen.sql";
const SERVICE = "src/lib/production-planning/service.ts";
const WORKSPACE_SCREEN = "src/components/production-planning/production-planning-workspace.tsx";

const EGYPHAR = "loc-egyphar";
const SATO_STORE = "loc-sato";
const MEDIZEN = "loc-medizen";

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
      { code: "EGYPHAR", id: EGYPHAR, isFactory: true, nameAr: "إيجيفار", nameEn: "Egyphar" },
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
        defaultSampleUnits: BigInt(0),
        factoryLocationId: EGYPHAR,
        geometry: ROYANOXICAM,
        id: "prod-royanoxicam",
        manufacturerName: "Egyphar",
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
        supplier: effectiveSupplier(data, "prod-royanoxicam", item.id, row),
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

/** One exported component of the screen, up to the next export — enough to say what it renders. */
function exportedBody(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `the screen should export ${name}`);
  const next = source.indexOf("\nexport function ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

/** The planning data with the product link naming who brings a material that has no line. */
function withLinkSuppliers(links: [string, MaterialSupplier][]): ProductionPlanningData {
  return { ...planningData(), linkSupplierByProductId: new Map([["prod-royanoxicam", new Map(links)]]) };
}

/** One counted lot, as the loader hands it over. */
function lot(materialId: string, locationId: string, qty: string, expiryDate: string | null = null): LoadedStock {
  return {
    asOfDate: "2026-04-19",
    expiryDate,
    locationId,
    materialId,
    note: null,
    qty: parseQty(qty),
    source: "factory_report",
  };
}

/**
 * Royanoxicam at TWO factories — Egyphar's product and Medizen's, the same formula — with Medizen's
 * old stock in Medizen's store and whatever else the caller puts in `stock`.
 */
function twoFactoryData(stock: LoadedStock[]): ProductionPlanningData {
  const base = planningData();
  const egyphar = base.products[0]!;
  return {
    ...base,
    compositionsByProductId: new Map([
      ...base.compositionsByProductId,
      ["prod-royanoxicam-medizen", base.compositionsByProductId.get("prod-royanoxicam") ?? []],
    ]),
    locations: [
      ...base.locations,
      { code: "MEDIZEN", id: MEDIZEN, isFactory: true, nameAr: "ميديزن", nameEn: "Medizen" },
    ],
    materialIdsByProductId: new Map([
      ...base.materialIdsByProductId,
      ["prod-royanoxicam-medizen", base.materialIdsByProductId.get("prod-royanoxicam") ?? new Set<string>()],
    ]),
    products: [
      { ...egyphar, nameEn: "Royanoxicam 8 mg — Egyphar" },
      {
        ...egyphar,
        code: "ROYANOXICAM_MEDIZEN",
        factoryLocationId: MEDIZEN,
        id: "prod-royanoxicam-medizen",
        manufacturerName: "Medizen Pharmaceutical Industries",
        nameEn: "Royanoxicam 8 mg — Medizen",
      },
    ],
    stock,
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
function compositionRowsFromMigration(
  path: string = MIGRATION,
): { code: string; basis: string; qty: number; supplier: string }[] {
  const sql = stripSqlComments(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
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
  assert.deepEqual([...MEASURE_UNITS], ["ml", "g", "mg", "mg_capsule"], "four units, and every one of them carries a divisor");

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

  // The factory's eleven still show what a run CONSUMES — the lactose is 19.9 kg plus waste — and none
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

  // ── The factory moved, and NOTHING ELSE DID ──────────────────────────────────────────────────
  //
  // Owner, 2026-10-21: "look the fctory changed from medizen to egyphar and the almunumnblister
  // leave empty for now". The danger in a factory change is that it arrives as a rewrite — a
  // session correcting every mention of the old factory is one careless replace away from touching
  // a quantity, and these figures are a declaration of composition, not decoration. The assertions
  // below read the move migration itself and refuse it the right to say anything about the
  // formula, the geometry or the foil.
  const moveSql = stripSqlComments(readFileSync(FACTORY_MOVE, "utf8").replace(/\r\n/g, "\n"));

  assert.match(moveSql, /set\s+code\s*=\s*'EGYPHAR'/, "the move renames the factory in place");
  assert.match(moveSql, /where\s+code\s*=\s*'MEDIZEN'/, "and it is the Medizen row it renames");
  assert.equal(
    /insert\s+into\s+public\.prodplan_locations/.test(moveSql),
    false,
    "a SECOND factory row would leave one in every picker that nothing is ever made at",
  );

  // 🔴 The whole point of this migration is that it may not touch a number.
  assert.equal(
    /prodplan_compositions/.test(moveSql),
    false,
    "the factory move writes NO composition row — a formula is not a property of the factory",
  );
  assert.equal(
    /qty_per_basis|run_volume_ml|dose_ml|units_per_box/.test(moveSql),
    false,
    "and it touches no quantity: the batch is still 31 kg of 200,000 tablets, 20 to a box",
  );
  assert.equal(
    /BLISTER_ALU_ROYANOXICAM/.test(moveSql),
    false,
    "the foil keeps its deliberate absence — he answered leave it empty, not guess it",
  );

  // The excipients were seeded against the ROLE and not a named company, which is the whole reason
  // the supplier split survived a change of factory without one composition row being rewritten.
  const seededLines = compositionRowsFromMigration();
  assert.equal(
    seededLines.every((row) => row.supplier === "sato" || row.supplier === "factory"),
    true,
    "every composition line names a ROLE, never a company — that is what made this move free",
  );

  // ── Royanoxicam gives no free samples, so the planner must not open on Ivyronc's 10,000 ─────────
  //
  // The owner, 2026-10-24: "when we chose the run counts in royanoxicam and press calculate" — and
  // what he saw was 3 runs reading 590,000 tablets and 10,000 samples. The screen sent one module-wide
  // 10,000 on every product's first read and kept it in the form. The count is now the PRODUCT's
  // (`default_sample_units`), filled in by the server only when the read names none.
  const noSamplesData = planningData();
  const firstRead = withProductSampleDefault(
    { mode: "runs", productId: "prod-royanoxicam", requestedQty: "3" },
    noSamplesData,
  );
  assert.equal(firstRead.sampleUnits, "0", "a read naming no samples takes Royanoxicam's own 0, not 10,000");
  const threeRuns = computePlan(noSamplesData, firstRead);
  assert.equal(threeRuns.sampleUnits, "0");
  assert.equal(threeRuns.goodUnits, "600000", "3 runs are 600,000 saleable tablets, not 590,000");
  assert.equal(threeRuns.totalBoxes, "30000");

  // Only an ABSENT count is filled in. A count he typed is his answer — an empty field included,
  // which still means zero, and a deliberate 10,000 still comes out of the run.
  const typed = withProductSampleDefault(
    { mode: "runs", productId: "prod-royanoxicam", requestedQty: "3", sampleUnits: "10000" },
    noSamplesData,
  );
  assert.equal(typed.sampleUnits, "10000", "a typed sample count is never overwritten by the default");
  assert.equal(computePlan(noSamplesData, typed).goodUnits, "590000");
  assert.equal(
    withProductSampleDefault({ productId: "prod-royanoxicam", requestedQty: "3", sampleUnits: "" }, noSamplesData)
      .sampleUnits,
    "",
    "an emptied field is his zero, not a request for the default",
  );

  // The default follows the product the read is FOR, including the first read that names none.
  const twoProducts: ProductionPlanningData = {
    ...noSamplesData,
    products: [
      { ...noSamplesData.products[0], code: "IVYRONC", defaultSampleUnits: BigInt(10_000), id: "prod-ivyronc" },
      ...noSamplesData.products,
    ],
  };
  assert.equal(withProductSampleDefault({ requestedQty: "1" }, twoProducts).sampleUnits, "10000");
  assert.equal(
    withProductSampleDefault({ productId: "prod-royanoxicam", requestedQty: "1" }, twoProducts).sampleUnits,
    "0",
  );

  // The row the default comes from, and the screen that must stop sending its own.
  const noSamplesSql = stripSqlComments(readFileSync(NO_SAMPLES, "utf8").replace(/\r\n/g, "\n"));
  assert.match(
    noSamplesSql,
    /add column if not exists default_sample_units integer not null default 10000/,
    "Ivyronc and Guamusin keep the 10,000 the screen always opened on",
  );
  assert.match(
    noSamplesSql,
    /set default_sample_units = 0,[\s\S]*?where code = 'ROYANOXICAM'/,
    "Royanoxicam opens on no samples",
  );
  const screen = readFileSync(WORKSPACE_SCREEN, "utf8");
  assert.equal(
    /sampleUnits:\s*DEFAULT_SAMPLE_UNITS/.test(screen),
    false,
    "the first read sends no module-wide sample count — the server answers with the product's own",
  );
  assert.match(
    screen,
    /setSampleUnits\(workspace\.plan\.sampleUnits\)/,
    "the form takes its samples from the plan it is showing, so a product switch cannot carry them over",
  );
  // ── Sato supplies four things, and the foil is one of them ──────────────────────────────────────
  //
  // The owner, 2026-10-29: "In Roya Noxicam tablet, we only supply the active material, Laura
  // Noxicam boxes, pamphlet, and aluminium foil only. We don't supply inactive materials." The foil
  // still has no line — its weight per box is his to give ("leave empty for now") — so who brings it
  // lives on the product link, `prodplan_product_materials.supplier`. 🔴 A line in force always wins.
  const ONE_BATCH = { mode: "total_boxes", productId: "prod-royanoxicam", requestedQty: "10000", sampleUnits: "0" };
  const linked = withLinkSuppliers([
    [BLISTER_ALU.id, "sato"],
    // A link that disagrees with a line, to prove the line wins.
    [LACTOSE.id, "sato"],
  ]);
  const linkedPlan = computePlan(linked, ONE_BATCH);
  const foil = rowOf(linkedPlan, "BLISTER_ALU_ROYANOXICAM");
  assert.equal(foil.supplier, "sato", "🔴 the foil reads Sato's — the link answers for a material with no line");
  assert.equal(
    foil.excludedReason,
    "no_composition",
    "and it is still a gap, never a zero: the amount per box has not been entered",
  );
  assert.equal(foil.contributesToBuyList, false, "so nothing is bought for it until he gives the amount");
  assert.equal(
    rowOf(linkedPlan, "LACTOSE_MONO_200").supplier,
    "factory",
    "🔴 a line in force always wins over the link — the lactose stays the factory's",
  );
  assert.equal(rowOf(linkedPlan, "LACTOSE_MONO_200").excludedReason, "factory_supplies");
  assert.equal(effectiveSupplier(linked, "prod-royanoxicam", BLISTER_ALU.id, null), "sato");
  assert.equal(effectiveSupplier(linked, null, BLISTER_ALU.id, null), null, "no product, no link to read");
  assert.equal(
    effectiveSupplier(planningData(), "prod-royanoxicam", BLISTER_ALU.id, null),
    null,
    "no link at all still reads nobody has said",
  );

  // The water and the alcohol are the factory's and never get a line (Q.S. — they evaporate). A
  // factory link with no line is the factory's material, not a gap in the formula.
  const qsPlan = computePlan(withLinkSuppliers([[BLISTER_ALU.id, "factory"]]), ONE_BATCH);
  assert.equal(
    rowOf(qsPlan, "BLISTER_ALU_ROYANOXICAM").excludedReason,
    "factory_supplies",
    "a factory material with no line reads as the factory's, never as formula not entered",
  );

  // The workspace carries the same answer, so the screen can sort his materials from the factory's.
  const linkedWire = workspaceFor(linked, linkedPlan);
  assert.equal(linkedWire.materials.find((item) => item.code === "BLISTER_ALU_ROYANOXICAM")?.supplier, "sato");
  assert.equal(linkedWire.materials.find((item) => item.code === "LACTOSE_MONO_200")?.supplier, "factory");

  // ── The Cost and Stock tabs list only what Sato buys ───────────────────────────────────────────
  // He kept the formula complete, so Formula and Planner still show the factory's lines; only the
  // money and the store leave them out.
  assert.equal(isBoughtBySato("factory"), false, "the factory's materials leave the Cost and Stock tabs");
  assert.equal(isBoughtBySato("sato"), true);
  assert.equal(isBoughtBySato(null), true, "nobody has said is never hidden — it might be his");
  assert.equal(isBoughtBySato("shared_unsettled"), true, "and an unsettled split stays listed until it is settled");
  assert.match(
    screen,
    /workspace\.materials\.filter\(\(material\) => isBoughtBySato\(material\.supplier\)\)/,
    "the view keeps exactly the materials Sato buys",
  );
  for (const tab of ["StockTab", "CostTab"]) {
    const body = exportedBody(screen, tab);
    assert.match(
      body,
      /const \{ data, factoryHidden \} = satoBoughtView\(workspace\)/,
      `🔴 ${tab} reads the Sato-bought view, never the whole formula`,
    );
    assert.match(
      body,
      /<FactoryHiddenNote count=\{factoryHidden\} \/>/,
      `and ${tab} says how many it left out — a short list is never silent`,
    );
  }

  // The rows the link answers for, off the migration itself.
  const supplierSql = stripSqlComments(readFileSync(SUPPLIER_LINK, "utf8").replace(/\r\n/g, "\n"));
  assert.match(supplierSql, /add column if not exists supplier text null/, "the link gains a nullable supplier");
  assert.match(
    supplierSql,
    /check \(supplier is null or supplier in \('sato', 'factory', 'shared_unsettled'\)\)/,
    "and takes the same three suppliers a formula line does",
  );
  assert.match(
    supplierSql,
    /set supplier = 'sato'[\s\S]*?p\.code = 'ROYANOXICAM'[\s\S]*?m\.code = 'BLISTER_ALU_ROYANOXICAM'/,
    "the foil is Sato's",
  );
  assert.match(
    supplierSql,
    /set supplier = 'factory'[\s\S]*?p\.code = 'ROYANOXICAM'[\s\S]*?m\.code in \('PURIFIED_WATER', 'ETHYL_ALCOHOL'\)/,
    "the water and the alcohol are the factory's",
  );
  assert.equal(
    /prodplan_compositions|qty_per_basis/.test(supplierSql),
    false,
    "and no formula line is written — the foil's amount is still his to give",
  );
  // ── Royanoxicam at a SECOND factory: Medizen, with its own old stock ────────────────────────────
  //
  // The owner, 2026-10-29, sending Medizen's stock sheet of 19/04/2026: Egyphar has no stock, Medizen
  // does, so the same product is added on Medizen with that stock and the same composition. Each
  // factory is its own product; 🔴 another factory's store is NEVER counted. Before
  // `stockForProduct`, any store not flagged as THIS product's factory read as "Sato's own store",
  // so Medizen's 10,244 boxes sat in the Egyphar plan and came off its buy list.
  const MEDIZEN_STOCK = [lot(BOX_20.id, MEDIZEN, "10244"), lot(LORNOXICAM.id, MEDIZEN, "131", "2026-12-06")];
  const EGYPHAR_BATCH = { ...ONE_BATCH, productId: "prod-royanoxicam" };
  const MEDIZEN_BATCH = { ...ONE_BATCH, productId: "prod-royanoxicam-medizen" };

  const bare = computePlan(twoFactoryData([]), EGYPHAR_BATCH);
  const egypharPlan = computePlan(twoFactoryData(MEDIZEN_STOCK), EGYPHAR_BATCH);
  for (const code of ["BOX_ROYANOXICAM_20", "LORNOXICAM"]) {
    const row = rowOf(egypharPlan, code);
    const before = rowOf(bare, code);
    assert.equal(row.heldElsewhere, before.heldElsewhere, `🔴 Medizen's ${code} is not in Egyphar's own-store column`);
    assert.equal(row.heldAtFactory, before.heldAtFactory, `nor in Egyphar's factory column`);
    assert.equal(row.heldTotal, before.heldTotal, `so Egyphar holds no ${code} it did not hold before`);
    assert.equal(row.toBuy, before.toBuy, `and Egyphar's buy list for ${code} is unchanged by Medizen's stock`);
  }

  // Sato's own store still counts for every product — the filter drops other FACTORIES only.
  const satoHeld = computePlan(twoFactoryData([...MEDIZEN_STOCK, lot(BOX_20.id, SATO_STORE, "1000")]), EGYPHAR_BATCH);
  assert.notEqual(
    rowOf(satoHeld, "BOX_ROYANOXICAM_20").heldElsewhere,
    rowOf(bare, "BOX_ROYANOXICAM_20").heldElsewhere,
    "boxes in Sato's own store are held for the Egyphar batch",
  );
  assert.notEqual(
    rowOf(satoHeld, "BOX_ROYANOXICAM_20").toBuy,
    rowOf(bare, "BOX_ROYANOXICAM_20").toBuy,
    "and they come off its buy list",
  );

  // Medizen's own product reads Medizen's stock as held at its factory.
  const medizenBare = computePlan(twoFactoryData([]), MEDIZEN_BATCH);
  const medizenPlan = computePlan(twoFactoryData(MEDIZEN_STOCK), MEDIZEN_BATCH);
  assert.notEqual(
    rowOf(medizenPlan, "BOX_ROYANOXICAM_20").heldAtFactory,
    rowOf(medizenBare, "BOX_ROYANOXICAM_20").heldAtFactory,
    "Medizen's boxes are held at Medizen's factory for Medizen's batch",
  );
  assert.equal(
    rowOf(medizenPlan, "BOX_ROYANOXICAM_20").heldElsewhere,
    rowOf(medizenBare, "BOX_ROYANOXICAM_20").heldElsewhere,
    "and never read as Sato's own store",
  );
  assert.notEqual(
    rowOf(medizenPlan, "BOX_ROYANOXICAM_20").toBuy,
    rowOf(medizenBare, "BOX_ROYANOXICAM_20").toBuy,
    "so they come off Medizen's buy list",
  );

  // The expiry sweep walks every product, so a lot is reported once — under the product made there.
  const expiryData = twoFactoryData(MEDIZEN_STOCK);
  assert.equal(
    evaluateExpiryForProduct(expiryData, "prod-royanoxicam", "2026-11-01").some((row) => row.locationId === MEDIZEN),
    false,
    "🔴 Medizen's lornoxicam is never an Egyphar expiry",
  );
  assert.deepEqual(
    evaluateExpiryForProduct(expiryData, "prod-royanoxicam-medizen", "2026-11-01").map((row) => [row.code, row.locationId]),
    [["LORNOXICAM", MEDIZEN]],
    "it is Medizen's, and it is reported",
  );

  // The service reads the raw stock list in ONE place, the filter itself.
  const service = readFileSync(SERVICE, "utf8");
  const helperStart = service.indexOf("function stockForProduct(");
  assert.ok(helperStart >= 0, "the service keeps one stock filter");
  const helper = service.slice(helperStart, service.indexOf("\n}\n", helperStart));
  assert.equal(
    (service.match(/\bdata\.stock\b/g) ?? []).length,
    (helper.match(/\bdata\.stock\b/g) ?? []).length,
    "🔴 every reader of the stock goes through stockForProduct — a second `data.stock` is another factory's stock leaking",
  );

  // The Stock tab records and reads THIS product's factory only.
  const stockTab = exportedBody(screen, "StockTab");
  assert.match(stockTab, /const ownFactoryId = selectedProductOf\(data\)\?\.factoryLocationId \?\? null/);
  assert.match(
    stockTab,
    /\{ownLocations\.map\(\(location\) =>/,
    "the store picker offers Sato's stores and this product's factory, never another factory",
  );
  assert.equal(/data\.locations\.map\(/.test(stockTab), false, "and nothing in the tab lists every location");
  assert.match(
    stockTab,
    /const factory = material\.heldByLocation\.find\(\(row\) => row\.locationId === ownFactoryId\)/,
    "the factory column is this product's factory, never the first one flagged",
  );

  // The migration, off the file.
  const medizenSql = stripSqlComments(readFileSync(MEDIZEN_MIGRATION, "utf8").replace(/\r\n/g, "\n"));
  assert.match(
    medizenSql,
    /insert into public\.prodplan_locations[\s\S]*?\('MEDIZEN', '[^']+', 'At the factory \(Medizen\)', true, 60\)/,
    "Medizen is a factory store again, a new row — Egyphar keeps the old one",
  );
  assert.match(
    medizenSql,
    /'ROYANOXICAM_MEDIZEN',[\s\S]*?'mg',\s*31000000, 155, 155, 155, true, 20,\s*0,/,
    "the same geometry to the digit: 31 kg of 155 mg tablets, 20 to a box, no samples",
  );
  assert.match(
    medizenSql,
    /set factory_location_id = l\.id[\s\S]*?l\.code = 'MEDIZEN'[\s\S]*?p\.code = 'ROYANOXICAM_MEDIZEN'/,
    "made at Medizen",
  );
  assert.match(
    medizenSql,
    /set name_en = 'Royanoxicam 8 mg — Egyphar'[\s\S]*?where code = 'ROYANOXICAM'/,
    "and the Egyphar product says so, so the two read apart in the picker",
  );
  assert.match(
    medizenSql,
    /select medizen\.id, pm\.material_id, pm\.sort_order, pm\.supplier[\s\S]*?egyphar\.code = 'ROYANOXICAM'/,
    "the material list is Egyphar's own, order and supplier included — the foil stays Sato's",
  );
  const medizenLines = compositionRowsFromMigration(MEDIZEN_MIGRATION);
  assert.deepEqual(
    medizenLines,
    compositionRowsFromMigration(),
    "🔴 the SAME formula he sent: every one of the seed's lines, quantity, basis and supplier",
  );
  assert.equal(medizenLines.length, 13);
  assert.equal(
    medizenLines.some((row) => row.code === "BLISTER_ALU_ROYANOXICAM"),
    false,
    "the foil still has no line — its amount per box is his to give",
  );
  for (const [code, qty, expiry] of [
    ["LORNOXICAM", "131.000000", "date '2026-12-06'"],
    ["BLISTER_ALU_ROYANOXICAM", "71290.500000", "null::date"],
    ["BOX_ROYANOXICAM_20", "10244.000000", "null::date"],
    ["LEAFLET_ROYANOXICAM", "3990.000000", "null::date"],
  ] as const) {
    assert.match(
      medizenSql,
      new RegExp(`\\('${code}',\\s+${qty.replace(".", "\\.")}::numeric,\\s+${expiry.replace(/[()]/g, "\\$&")}`),
      `Medizen holds ${qty} of ${code} on the 19/04/2026 sheet`,
    );
  }
  assert.match(medizenSql, /date '2026-04-19', v\.expiry, 'factory_report'/, "counted on the sheet's own date");
  assert.match(medizenSql, /where l\.code = 'MEDIZEN'\s+and not exists/, "at Medizen, and only once");
}
