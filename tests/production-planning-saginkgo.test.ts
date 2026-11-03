import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import { dosesPerRun, type RunGeometry, yieldForRuns } from "../src/lib/production-planning/geometry.ts";
import {
  coerceMeasureUnit,
  MEASURE_UNITS_PER_LARGE,
  type MaterialSupplier,
  parsePct,
  parseQty,
  QTY_SCALE,
} from "../src/lib/production-planning/rules.ts";
import {
  computePlan,
  type LoadedComposition,
  type LoadedMaterial,
  type LoadedProduct,
  type ProductionPlanningData,
} from "../src/lib/production-planning/service.ts";
import {
  buildSampleUnitsHintAr,
  buildSampleUnitsHintEn,
  measureUnitLabelsAr,
  measureUnitLabelsEn,
  PP_EN,
  requestModeLabelsEn,
  runActualLabelAr,
  runActualLabelEn,
  runSizeLabelEn,
  saleableUnitWordAr,
  saleableUnitWordEn,
  unitsWithBoxesAr,
  unitsWithBoxesEn,
} from "../src/lib/production-planning/strings.ts";
import type { WireWorkspace } from "../src/lib/production-planning/wire.ts";
import { buildProductionPlanningWorkbook } from "../src/lib/production-planning/workbook.ts";
import { stripSqlComments } from "./support/comment-strip.ts";

/**
 * Production Planner — Saginkgo 120 mg, a capsule made at Med Care's Badr factory.
 *
 * The owner sent Med Care's Certificate of Composition on 2026-11-03, then answered
 * **"1 batch = 1000 box , box = 30 capsula"** and **"sato 5 items except the leaflet no leaflet in
 * this product"** and **"call it med care badr"**.
 *
 * ── What this file keeps true ───────────────────────────────────────────────────────────────────
 *
 *  1. **The formula is the certificate's, to the microgram.** It is read back OUT of the migration,
 *     and the five weighed lines must add to the certificate's 300 mg.
 *  2. **A batch is 1,000 boxes exactly** — 30,000 capsules, 9 kg, nothing left over.
 *  3. **Sato's list is four things and there is no leaflet.** The foil is Sato's with no line until
 *     its weight per box is known: a row reading "no composition", never a zero.
 *  4. **The shell is one bought item**, not gelatin and titanium dioxide on a purchase order.
 *  5. **A capsule never reads "tablet"**, and `mg_capsule` keeps the milligram divisor: through a
 *     divisor of 1,000 the batch tile would read 9,000 kg.
 *  6. **A free sample is a whole box of five capsules** (**"بوكس شريط واحد فيه خمسة"**), on the screen
 *     and in the sheet's own formulas, and no other product's figures move.
 */

const MIGRATION = "supabase/migrations/20261103155601_production_planning_saginkgo_seed.sql";
const SCHEMA_MIGRATION = "supabase/migrations/20261103155559_production_planning_sample_in_own_box.sql";

const MEDCARE = "loc-medcare-badr";
const HOCHSTER = "loc-hochster";
const SATO_STORE = "loc-sato";

const CAPSULES_A_BATCH = 30_000;
const BOXES_A_BATCH = 1_000;

/** The certificate's "Other ingredients" and active table, in micrograms a capsule. */
const CERTIFICATE_MICROGRAMS: Record<string, number> = {
  AEROSIL_200: 2_000,
  ASCORBIC_ACID: 45_000,
  GINKGO_EXTRACT: 120_000,
  MAGNESIUM_STEARATE: 3_000,
  PREGELATINIZED_STARCH: 130_000,
};

/** 🔴 `\r` is stripped first: this laptop's working tree is CRLF and the CI runner checks out LF. */
function sqlOf(file: string): string {
  return stripSqlComments(readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
}

function block(sql: string, from: string, to: string): string {
  const start = sql.indexOf(from);
  assert.notEqual(start, -1, `the migration should carry ${JSON.stringify(from)}`);
  const end = sql.indexOf(to, start);
  assert.notEqual(end, -1, `the migration should carry ${JSON.stringify(to)} after ${JSON.stringify(from)}`);
  return sql.slice(start, end);
}

function insertedMaterialCodes(sql: string): string[] {
  const values = block(sql, "insert into public.prodplan_materials (", "on conflict (code) do nothing;");
  return [...values.matchAll(/^\s*\('([A-Z0-9_]+)',/gm)].map((match) => match[1]!);
}

function linkedMaterials(sql: string): { code: string; sortOrder: number; supplier: MaterialSupplier | null }[] {
  const values = block(sql, "insert into public.prodplan_product_materials", "on conflict (product_id, material_id)");
  return [...values.matchAll(/\('([A-Z0-9_]+)',\s*(\d+),\s*(null|'[a-z_]+')::text\)/g)].map((match) => ({
    code: match[1]!,
    sortOrder: Number(match[2]!),
    supplier: match[3] === "null" ? null : (match[3]!.replace(/'/g, "") as MaterialSupplier),
  }));
}

function compositionRows(sql: string): { code: string; basis: LoadedComposition["basis"]; qty: string; supplier: LoadedComposition["supplier"] }[] {
  const pattern = /\('([A-Z0-9_]+)',\s*'(per_dose|per_box|per_sample_unit)',\s*([0-9.]+),\s*'(sato|factory)'/g;
  return [...sql.matchAll(pattern)].map((match) => ({
    basis: match[2] as LoadedComposition["basis"],
    code: match[1]!,
    qty: match[3]!,
    supplier: match[4] as LoadedComposition["supplier"],
  }));
}

const GEOMETRY: RunGeometry = {
  doseMl: BigInt(300),
  goodUnitMl: BigInt(300),
  runVolumeMl: BigInt(9_000_000),
  sampleInOwnBox: true,
  sampleUnitMl: BigInt(1_500),
  unitsPerBox: BigInt(30),
  wholeRunsOnly: true,
};

const KG = BigInt(1_000) * QTY_SCALE;
const PIECE = QTY_SCALE;

function material(code: string, sortOrder: number): LoadedMaterial {
  const counted = code.startsWith("BOX_") || code.startsWith("CAPSULE_");
  return {
    basePerDisplay: counted ? PIECE : KG,
    baseUnit: counted ? "piece" : "g",
    code,
    displayUnit: counted ? "piece" : "kg",
    id: `mat-${code}`,
    isImported: false,
    leadTimeDays: null,
    minOrderQty: null,
    nameAr: code,
    nameEn: code,
    notes: null,
    purchaseIncrement: null,
    reorderCoverRuns: null,
    sortOrder,
    unitKind: counted ? "count" : "mass",
  };
}

function product(overrides: Partial<LoadedProduct> & Pick<LoadedProduct, "code" | "id" | "factoryLocationId" | "geometry">): LoadedProduct {
  return {
    defaultSampleUnits: BigInt(0),
    manufacturerName: overrides.code,
    measureUnit: "mg_capsule",
    nameAr: overrides.code,
    nameEn: overrides.code,
    notes: null,
    ...overrides,
  };
}

/** Saginkgo at Med Care, built from the MIGRATION itself, beside a product at another factory. */
function planningData(sql: string, stock: ProductionPlanningData["stock"] = []): ProductionPlanningData {
  const linked = linkedMaterials(sql);
  const materials = linked.map(({ code, sortOrder }) => material(code, sortOrder));
  const compositions = compositionRows(sql).map(
    (row): LoadedComposition => ({
      basis: row.basis,
      effectiveFrom: "2026-11-03",
      materialId: `mat-${row.code}`,
      notes: null,
      overagePct: null,
      qtyPerBasis: parseQty(row.qty),
      supplier: row.supplier,
    }),
  );
  const linkSuppliers = new Map<string, MaterialSupplier>();
  for (const row of linked) if (row.supplier) linkSuppliers.set(`mat-${row.code}`, row.supplier);
  return {
    compositionsByProductId: new Map([["prod-saginkgo", compositions]]),
    fx: { rateDate: "2026-11-03", source: "manual", usdToEgpMicro: BigInt(48) * QTY_SCALE },
    learning: new Map(),
    level: "full",
    linkSupplierByProductId: new Map([["prod-saginkgo", linkSuppliers]]),
    locations: [
      { code: "HOCHSTER", id: HOCHSTER, isFactory: true, nameAr: "هوكستر", nameEn: "Hochster" },
      { code: "SATO_STORE", id: SATO_STORE, isFactory: false, nameAr: "مخزن ساتو", nameEn: "Sato store" },
      { code: "MEDCARE_BADR", id: MEDCARE, isFactory: true, nameAr: "ميد كير بدر", nameEn: "Med Care Badr" },
    ],
    materialIdsByProductId: new Map([["prod-saginkgo", new Set(materials.map((item) => item.id))]]),
    materials,
    prices: [],
    products: [product({ code: "SAGINKGO", factoryLocationId: MEDCARE, geometry: GEOMETRY, id: "prod-saginkgo" })],
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
    stock,
  };
}

function rowOf(plan: { rows: readonly { code: string }[] }, code: string) {
  const row = plan.rows.find((candidate) => candidate.code === code);
  assert.ok(row, `the plan should carry a row for ${code}`);
  return row as (typeof plan.rows)[number] & Record<string, string | boolean | null>;
}

/** The sheet's own arithmetic through its references: the only operators these cells use. */
function evaluateCell(sheet: ExcelJS.Worksheet, address: string): number {
  const value = sheet.getCell(address).value as number | { formula?: string } | null;
  if (typeof value === "number") return value;
  assert.ok(value && typeof value === "object" && value.formula, `${address} should hold a number or a formula`);
  const expression = value.formula!
    .replace(/ROUNDUP\(/g, "roundUp(")
    .replace(/FLOOR\(/g, "floor(")
    .replace(/\$?([A-Z]+)\$?(\d+)/g, (_, column: string, row: string) => String(evaluateCell(sheet, `${column}${row}`)));
  const roundUp = (figure: number) => Math.ceil(figure);
  const floor = (figure: number) => Math.floor(figure);
  return new Function("roundUp", "floor", `return (${expression});`)(roundUp, floor) as number;
}

export async function runProductionPlanningSaginkgoTests() {
  const sql = sqlOf(MIGRATION);

  // ── The geometry: "1 batch = 1000 box , box = 30 capsula" ───────────────────────────────────
  assert.equal(dosesPerRun(GEOMETRY), BigInt(CAPSULES_A_BATCH), "1,000 boxes of 30");
  assert.equal(yieldForRuns(GEOMETRY, BigInt(1), BigInt(0)).leftoverMl, BigInt(0), "9,000,000 mg divides by 300 mg exactly");
  assert.match(sql, /'mg_capsule',\s*9000000,\s*300,\s*300,\s*1500,\s*true,\s*30,\s*true,\s*0,/, "9 kg, 300 mg a capsule, 30 a box, a sample box of five, none by default");

  // ── The formula, read back out of the migration ─────────────────────────────────────────────
  const seeded = compositionRows(sql);
  const weighed = seeded.filter((row) => row.code in CERTIFICATE_MICROGRAMS);
  const microgramsOf = (qty: string) => Math.round(Number(qty) * 1_000_000);
  for (const row of weighed) {
    assert.equal(microgramsOf(row.qty), CERTIFICATE_MICROGRAMS[row.code], `${row.code} is the certificate's figure`);
    assert.equal(row.basis, "per_dose", `${row.code} is counted per capsule`);
  }
  assert.deepEqual(weighed.map((row) => row.code).sort(), Object.keys(CERTIFICATE_MICROGRAMS).sort(), "every certificate line has a row");
  // 🔴 THE TOTAL IS THE PROOF, summed in micrograms because a tolerance hides the typo this is for.
  assert.equal(
    weighed.reduce((sum, row) => sum + microgramsOf(row.qty), 0),
    300_000,
    "the certificate's \"Total content Weight\": 300 mg",
  );

  // ── Who brings what: Sato's four, Med Care's four, and no leaflet ───────────────────────────
  assert.deepEqual(
    seeded.filter((row) => row.supplier === "sato").map((row) => row.code).sort(),
    ["BOX_SAGINKGO", "BOX_SAGINKGO_SAMPLE", "CAPSULE_EMPTY_SAGINKGO", "GINKGO_EXTRACT"],
    "the four Sato lines that HAVE a quantity; the aluminium is Sato's too and has no line yet",
  );
  assert.deepEqual(
    seeded.filter((row) => row.supplier === "factory").map((row) => row.code).sort(),
    ["AEROSIL_200", "ASCORBIC_ACID", "MAGNESIUM_STEARATE", "PREGELATINIZED_STARCH"],
    "Med Care's four excipients",
  );
  const linked = linkedMaterials(sql);
  assert.equal(linked.length, 9, "nine materials on Saginkgo's list");
  assert.equal(
    linked.some((row) => row.code.includes("LEAFLET")),
    false,
    "🔴 \"no leaflet in this product\"",
  );
  assert.equal(insertedMaterialCodes(sql).some((code) => code.includes("LEAFLET")), false, "and none is created for it");
  assert.deepEqual(
    linked.filter((row) => row.supplier !== null).map((row) => [row.code, row.supplier]),
    [["BLISTER_ALU_SAGINKGO", "sato"]],
    "only the foil, which has no line, names its supplier on the link",
  );

  // ── The shell is one bought item ────────────────────────────────────────────────────────────
  // The whole list, so gelatin, titanium dioxide or a paraben from the cap table cannot join it.
  assert.deepEqual(
    linked.map((row) => row.code),
    [
      "GINKGO_EXTRACT",
      "PREGELATINIZED_STARCH",
      "ASCORBIC_ACID",
      "MAGNESIUM_STEARATE",
      "AEROSIL_200",
      "CAPSULE_EMPTY_SAGINKGO",
      "BLISTER_ALU_SAGINKGO",
      "BOX_SAGINKGO",
      "BOX_SAGINKGO_SAMPLE",
    ],
    "the certificate's five, then the shell, the foil and the two boxes",
  );

  // ── Shared rows are linked, never re-inserted ───────────────────────────────────────────────
  assert.deepEqual(
    insertedMaterialCodes(sql).sort(),
    ["ASCORBIC_ACID", "BLISTER_ALU_SAGINKGO", "BOX_SAGINKGO", "BOX_SAGINKGO_SAMPLE", "CAPSULE_EMPTY_SAGINKGO", "GINKGO_EXTRACT"],
    "six new materials",
  );

  // ── The store, and the CHECK that lets the row in ───────────────────────────────────────────
  assert.match(sql, /set factory_location_id = l\.id[\s\S]*?where l\.code = 'MEDCARE_BADR'[\s\S]*?and p\.code = 'SAGINKGO'/, "made at Med Care's Badr factory");
  assert.match(sql, /'Med Care Badr',\s*'mg_capsule',/, "his name for it: there is another Med Care");
  assert.match(sql, /'At the factory \(Med Care Badr\)'/, "and the store carries the same name");
  const schemaSql = sqlOf(SCHEMA_MIGRATION);
  assert.match(schemaSql, /check \(measure_unit = any \(array\['ml'::text, 'g'::text, 'mg'::text, 'mg_capsule'::text\]\)\)/, "every older unit stays allowed");
  assert.match(schemaSql, /add column if not exists sample_in_own_box boolean not null default false/, "every older product keeps its reading of a sample");

  // ── One batch, through the real engine ──────────────────────────────────────────────────────
  const plan = computePlan(planningData(sql), { mode: "runs", productId: "prod-saginkgo", requestedQty: "1", sampleUnits: "0" });
  assert.equal(plan.goodUnits, String(CAPSULES_A_BATCH), "30,000 capsules");
  assert.equal(plan.totalBoxes, String(BOXES_A_BATCH), "1,000 boxes");
  assert.equal(plan.measureUnit, "mg_capsule");
  assert.equal(plan.runVolumeLitres, "9", "🔴 the batch tile reads 9 kg, not 9,000");

  assert.equal(rowOf(plan, "GINKGO_EXTRACT").needed, "3.708", "3.6 kg of active plus the 3% default");
  assert.equal(rowOf(plan, "CAPSULE_EMPTY_SAGINKGO").needed, "30900", "one shell a capsule plus the 3% default");
  assert.equal(rowOf(plan, "BOX_SAGINKGO").needed, "1030", "one box a box plus the 3% default");
  for (const code of ["GINKGO_EXTRACT", "CAPSULE_EMPTY_SAGINKGO", "BOX_SAGINKGO"]) {
    assert.equal(rowOf(plan, code).contributesToBuyList, true, `Sato brings ${code}`);
  }
  for (const code of Object.keys(CERTIFICATE_MICROGRAMS).filter((item) => item !== "GINKGO_EXTRACT")) {
    assert.equal(rowOf(plan, code).contributesToBuyList, false, `${code} is Med Care's`);
    assert.equal(rowOf(plan, code).excludedReason, "factory_supplies", `${code} shows what a run consumes and stops there`);
  }

  // 🔴 The foil is Sato's and still a ROW WITH NO COMPOSITION, never a row with a zero.
  const foil = rowOf(plan, "BLISTER_ALU_SAGINKGO");
  assert.equal(foil.supplier, "sato", "the aluminium is Sato's, from the link");
  assert.equal(foil.excludedReason, "no_composition", "and its weight per box has not been entered");
  assert.equal(foil.contributesToBuyList, false, "so nothing is bought until he gives the amount");

  assert.equal(rowOf(plan, "BOX_SAGINKGO_SAMPLE").needed, "0", "no sample box until an order names samples");

  // ── 🔴 A free sample is a whole box of five capsules, out of his total ──────────────────────
  // 1,000 boxes with 100 samples: 900 boxes + 100 × 5 capsules = 27,500 capsules, one batch. That batch
  // makes 30,000: 500 in samples, 29,500 saleable, 984 boxes of them because a part-box is a box.
  const sampled = computePlan(planningData(sql), { mode: "total_boxes", productId: "prod-saginkgo", requestedQty: "1000", sampleUnits: "100" });
  assert.equal(sampled.runs, "1", "the samples come out of the batch");
  assert.equal(sampled.goodUnits, "29500", "five capsules a sample, not one");
  assert.equal(sampled.packagingSets, "30000", "and the capsule tile still reads the whole batch");
  assert.equal(sampled.totalBoxes, "1084", "984 boxes of 30 plus 100 sample boxes");
  assert.equal(sampled.requestedBoxes, "1000", "his headline number stays his");
  assert.equal(sampled.surplusBoxes, "84", "and the rest of the batch is reported");
  assert.equal(rowOf(sampled, "BOX_SAGINKGO").basisCount, "984", "🔴 the 30-capsule box is never bought for a sample");
  assert.equal(rowOf(sampled, "BOX_SAGINKGO_SAMPLE").basisCount, "100", "one sample box a sample");
  assert.equal(rowOf(sampled, "CAPSULE_EMPTY_SAGINKGO").basisCount, "30000", "a sample's capsules are real shells");
  assert.equal(rowOf(sampled, "GINKGO_EXTRACT").basisCount, "30000", "the fill does not change");

  // "good units" adds the samples on top of the saleable boxes he named.
  const onTop = computePlan(planningData(sql), { mode: "good_units", productId: "prod-saginkgo", requestedQty: "900", sampleUnits: "100" });
  assert.equal(onTop.requestedBoxes, "1000", "900 saleable boxes and 100 sample boxes");
  assert.throws(
    () => computePlan(planningData(sql), { mode: "total_boxes", productId: "prod-saginkgo", requestedQty: "50", sampleUnits: "51" }),
    /do not fit inside an order of 50/,
    "51 sample boxes cannot come out of 50 boxes",
  );

  // 🔴 NO OTHER PRODUCT MOVES: without the flag the same numbers keep the older reading, a sample as
  // one saleable unit. The Ivyronc, Guamusin and Royanoxicam suites pin those products' own figures.
  const older = { ...GEOMETRY, sampleInOwnBox: false };
  const olderYield = yieldForRuns(older, BigInt(1), BigInt(100));
  assert.equal(olderYield.packagingSets, olderYield.goodUnits + BigInt(100), "a sample is one more unit");
  assert.equal(olderYield.totalBoxes, BigInt(987), "and part of a box: (29,500 + 100) / 30, rounded up");
  assert.equal(olderYield.perBoxCount, olderYield.totalBoxes, "and a per-box material counts them all");

  assert.ok(
    buildSampleUnitsHintEn({ dose: "300", goodUnit: "300", measureUnit: "mg_capsule", sampleUnit: "1,500", unitsInOwnSampleBox: "5" }).startsWith("A sample is its own box of 5 capsules"),
    "the field says what a sample is",
  );
  assert.ok(
    buildSampleUnitsHintAr({ dose: "300", goodUnit: "300", measureUnit: "mg_capsule", sampleUnit: "1,500", unitsInOwnSampleBox: "5" }).includes("علبة مستقلة فيها 5 كبسولة"),
    "in both languages",
  );

  // ── The sheet's own formulas agree, evaluated through their references ──────────────────────
  const { buffer } = await buildProductionPlanningWorkbook(
    {
      materials: [],
      plan: sampled,
      products: [
        {
          code: "SAGINKGO",
          doseMl: "300",
          factoryLocationId: MEDCARE,
          goodUnitMl: "300",
          id: "prod-saginkgo",
          manufacturerName: "Med Care Badr",
          measureUnit: "mg_capsule",
          nameAr: "ساجنكو",
          nameEn: "Saginkgo",
          notes: null,
          runVolumeMl: "9000000",
          sampleInOwnBox: true,
          sampleUnitMl: "1500",
          unitsPerBox: "30",
          wholeRunsOnly: true,
        },
      ],
    } as unknown as WireWorkspace,
    { lang: "en" },
  );
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = book.worksheets[0]!;
  const cellLabelled = (label: string): number => {
    for (let index = 1; index <= sheet.rowCount; index += 1) {
      if (String(sheet.getCell(index, 1).value ?? "").startsWith(label)) return evaluateCell(sheet, `B${index}`);
    }
    throw new Error(`no row labelled ${label}`);
  };
  assert.equal(cellLabelled(PP_EN.sheetGoodUnitsRequested), 27_000, "(1,000 − 100) boxes of 30");
  assert.equal(cellLabelled(PP_EN.tileRuns), 1, "one batch in the sheet too");
  assert.equal(cellLabelled(PP_EN.sheetPackagingSets), 30_000, "the capsule count");
  assert.equal(cellLabelled(PP_EN.sheetSaleableBoxes), 984, "the boxes the 30-capsule box material reads");
  assert.equal(cellLabelled(PP_EN.sheetTotalBoxes), 1_084, "plus the sample boxes");
  assert.equal(cellLabelled(PP_EN.tileSurplus), 84, "and the same surplus as the screen");

  // ── A shared material's stock belongs to the factory that holds it ──────────────────────────
  const aerosilElsewhere = computePlan(
    planningData(sql, [
      {
        asOfDate: "2026-11-03",
        expiryDate: "2028-01-31",
        locationId: HOCHSTER,
        materialId: "mat-AEROSIL_200",
        note: null,
        qty: parseQty("5000"),
        source: "factory_report",
      },
    ]),
    { mode: "runs", productId: "prod-saginkgo", requestedQty: "1", sampleUnits: "0" },
  );
  assert.equal(rowOf(aerosilElsewhere, "AEROSIL_200").heldAtFactory, "0", "Aerosil at Hochster is NOT held at Med Care");

  // ── 🔴 A capsule never reads "tablet", and an unknown unit is the reason for the apply order ─
  assert.equal(saleableUnitWordEn("mg_capsule"), "capsule");
  assert.equal(saleableUnitWordAr("mg_capsule"), "كبسولة");
  assert.equal(saleableUnitWordEn("mg"), "tablet", "Royanoxicam and Carvibradine keep their word");
  assert.equal(
    unitsWithBoxesEn({ boxes: "1,000", measureUnit: "mg_capsule", units: "30,000", unitsPerBox: "30" }),
    "30,000 capsules (1,000 boxes)",
  );
  assert.equal(
    unitsWithBoxesAr({ boxes: "1,000", measureUnit: "mg_capsule", units: "30,000", unitsPerBox: "30" }),
    "30,000 كبسولة (1,000 علبة)",
  );
  assert.ok(requestModeLabelsEn({ measureUnit: "mg_capsule", unitsPerBox: "30" }).total.endsWith("30 capsules per box"));
  assert.equal(runActualLabelEn("mg_capsule"), "Capsules actually produced");
  assert.equal(runActualLabelAr("mg_capsule"), "الكبسولات الناتجة فعليًا");
  assert.equal(runSizeLabelEn("mg_capsule"), "Batch size", "a capsule batch is weighed");
  assert.deepEqual(measureUnitLabelsEn("mg_capsule"), measureUnitLabelsEn("mg"));
  assert.deepEqual(measureUnitLabelsAr("mg_capsule"), measureUnitLabelsAr("mg"));
  assert.equal(MEASURE_UNITS_PER_LARGE.mg_capsule, MEASURE_UNITS_PER_LARGE.mg, "the same divisor as a tablet");
  assert.equal(coerceMeasureUnit("mg_capsule"), "mg_capsule", "the read keeps it instead of falling back to millilitres");
}
