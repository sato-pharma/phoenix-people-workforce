import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { dosesPerRun, type RunGeometry, yieldForRuns } from "../src/lib/production-planning/geometry.ts";
import { parsePct, parseQty, QTY_SCALE } from "../src/lib/production-planning/rules.ts";
import {
  computePlan,
  type LoadedComposition,
  type LoadedMaterial,
  type LoadedProduct,
  type ProductionPlanningData,
} from "../src/lib/production-planning/service.ts";
import { stripSqlComments } from "./support/comment-strip.ts";

/**
 * Production Planner — Carvibradine 6.25/5 mg, the FOURTH product, and the first to SHARE materials
 * with a product made at a different factory.
 *
 * The owner sent Hochster's two papers on 2026-10-29 — the bill of materials and the composition
 * certificate — with one sentence of supply split: **"In Carvibradine T we supply Carvidilol,
 * Ivabradine, Pumphlet, Boxes & aluminium Foil"**. A coated tablet weighs 180 mg and one batch is a
 * fixed 30.6 kg, which is exactly 170,000 tablets.
 *
 * ── What this file keeps true ───────────────────────────────────────────────────────────────────
 *
 *  1. **The formula is the certificate's, to the microgram.** The composition is read back OUT of
 *     the migration rather than retyped, and its twelve quantified lines, multiplied by 170,000,
 *     must reproduce every figure in the BOM's "QTY/BATCH" column — so a mistyped milligram in the
 *     SQL fails here instead of buying the wrong amount of active.
 *  2. **The buy list is the five things he named, and nothing else.** The foil is his too, and has
 *     no line until its weight per box is known — a row reading "no composition", never a zero.
 *  3. **A shared material's stock belongs to the factory that holds it.** Seven excipients are the
 *     same rows Royanoxicam lists. Aerosil counted at Egyphar must never read as held at Hochster,
 *     or Carvibradine's run would be planned against powder sitting in another company's store.
 *  4. **The box size is NOT guessed.** Neither paper states it and he could not say on 2026-10-29.
 *     The migration refuses itself until the real number is written in, and the last block of this
 *     file fails — "box size pending" — until it is.
 */

const MIGRATION = "supabase/migrations/20261029030057_production_planning_carvibradine.sql";
const ROYANOXICAM_MIGRATION = "supabase/migrations/20261020200000_production_planning_royanoxicam.sql";

const HOCHSTER = "loc-hochster";
const EGYPHAR = "loc-egyphar";
const SATO_STORE = "loc-sato";

const TABLETS_A_BATCH = 170_000;

/** The eleven rows this migration creates. */
const NEW_MATERIALS = [
  "ABSOLUTE_ETHANOL",
  "BLISTER_ALU_CARVIBRADINE",
  "BOX_CARVIBRADINE",
  "CARVEDILOL",
  "HPMC_E5",
  "IVABRADINE_HCL",
  "LACTOSE_MONO",
  "LEAFLET_CARVIBRADINE",
  "MALTODEXTRIN",
  "MCC_PH102",
  "PREGELATINIZED_STARCH",
];

/** The seven Royanoxicam already lists, linked and never re-inserted. */
const SHARED_MATERIALS = [
  "AEROSIL_200",
  "CROSCARMELLOSE_NA",
  "ETHYL_ALCOHOL",
  "MAGNESIUM_STEARATE",
  "PEG_6000",
  "PURIFIED_WATER",
  "TITANIUM_DIOXIDE",
];

/** The BOM's "QTY/BATCH (Kg)" column, in milligrams so the comparison is integer-exact. */
const BOM_MG_PER_BATCH: Record<string, number> = {
  AEROSIL_200: 297_500,
  CARVEDILOL: 1_062_500,
  CROSCARMELLOSE_NA: 892_500,
  HPMC_E5: 595_000,
  IVABRADINE_HCL: 916_300,
  LACTOSE_MONO: 11_560_000,
  MAGNESIUM_STEARATE: 297_500,
  MALTODEXTRIN: 1_888_700,
  MCC_PH102: 9_860_000,
  PEG_6000: 136_000,
  PREGELATINIZED_STARCH: 2_975_000,
  TITANIUM_DIOXIDE: 119_000,
};

/**
 * The migration, comment-free.
 *
 * 🔴 `\r` is stripped first: `core.autocrlf=true` puts CRLF in this laptop's working tree and the
 * CI runner checks out LF, so a reader that does not normalise is red here and green there.
 */
function sqlOf(file: string): string {
  return stripSqlComments(readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
}

/** The text between two markers, asserting both are there. */
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

function linkedMaterialCodes(sql: string): { code: string; sortOrder: number }[] {
  const values = block(sql, "insert into public.prodplan_product_materials", "on conflict (product_id, material_id)");
  return [...values.matchAll(/\('([A-Z0-9_]+)',\s*(\d+)\)/g)].map((match) => ({
    code: match[1]!,
    sortOrder: Number(match[2]!),
  }));
}

function compositionRows(sql: string): { code: string; basis: LoadedComposition["basis"]; qty: string; supplier: LoadedComposition["supplier"] }[] {
  const pattern = /\('([A-Z0-9_]+)',\s*'(per_dose|per_box)',\s*([0-9.]+),\s*'(sato|factory)'/g;
  return [...sql.matchAll(pattern)].map((match) => ({
    basis: match[2] as LoadedComposition["basis"],
    code: match[1]!,
    qty: match[3]!,
    supplier: match[4] as LoadedComposition["supplier"],
  }));
}

/** `units_per_box` as the migration writes it — `null` while the box size is still unknown. */
function unitsPerBoxIn(sql: string): number | null {
  const match = /'mg',\s*30600000,\s*180,\s*180,\s*180,\s*true,\s*(null|\d+),\s*0,/.exec(sql);
  assert.ok(match, "30,600,000 mg a batch, a 180 mg tablet, a whole batch at a time, and no free samples");
  return match[1] === "null" ? null : Number(match[1]);
}

/** Carvibradine: a fixed 30.6 kg batch counted in MILLIGRAMS, 180 mg a tablet. */
function carvibradine(unitsPerBox: number): RunGeometry {
  return {
    doseMl: BigInt(180),
    goodUnitMl: BigInt(180),
    runVolumeMl: BigInt(30_600_000),
    sampleUnitMl: BigInt(180),
    unitsPerBox: BigInt(unitsPerBox),
    wholeRunsOnly: true,
  };
}

const KG = BigInt(1_000) * QTY_SCALE;
const PIECE = QTY_SCALE;

function material(code: string, sortOrder: number): LoadedMaterial {
  const counted = code.startsWith("BOX_") || code.startsWith("LEAFLET_");
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
    manufacturerName: overrides.manufacturerName ?? overrides.code,
    measureUnit: "mg",
    nameAr: overrides.code,
    nameEn: overrides.code,
    notes: null,
    ...overrides,
  };
}

/**
 * Both tablets at their own factories, with Carvibradine's materials and composition built from the
 * MIGRATION itself — so every figure the plan prints below is the SQL's, not a copy of it.
 */
function planningData(sql: string, unitsPerBox: number, stock: ProductionPlanningData["stock"] = []): ProductionPlanningData {
  const linked = linkedMaterialCodes(sql);
  const materials = linked.map(({ code, sortOrder }) => material(code, sortOrder));
  const compositions = compositionRows(sql).map(
    (row): LoadedComposition => ({
      basis: row.basis,
      effectiveFrom: "2026-10-29",
      materialId: `mat-${row.code}`,
      notes: null,
      overagePct: null,
      qtyPerBasis: parseQty(row.qty),
      supplier: row.supplier,
    }),
  );
  return {
    compositionsByProductId: new Map([
      ["prod-carvibradine", compositions],
      ["prod-royanoxicam", []],
    ]),
    fx: { rateDate: "2026-10-29", source: "manual", usdToEgpMicro: BigInt(48) * QTY_SCALE },
    learning: new Map(),
    level: "full",
    locations: [
      { code: "EGYPHAR", id: EGYPHAR, isFactory: true, nameAr: "إيجيفار", nameEn: "Egyphar" },
      { code: "SATO_STORE", id: SATO_STORE, isFactory: false, nameAr: "مخزن ساتو", nameEn: "Sato store" },
      { code: "HOCHSTER", id: HOCHSTER, isFactory: true, nameAr: "هوكستر", nameEn: "Hochster" },
    ],
    materialIdsByProductId: new Map([
      ["prod-carvibradine", new Set(materials.map((item) => item.id))],
      ["prod-royanoxicam", new Set([`mat-AEROSIL_200`])],
    ]),
    materials,
    prices: [],
    products: [
      // Egyphar is listed FIRST and is a factory too: a resolver that fell back to "the first
      // factory" instead of the product's own column would read Royanoxicam's store for Carvibradine.
      product({
        code: "ROYANOXICAM",
        factoryLocationId: EGYPHAR,
        geometry: { ...carvibradine(20), doseMl: BigInt(155), goodUnitMl: BigInt(155), runVolumeMl: BigInt(31_000_000), sampleUnitMl: BigInt(155) },
        id: "prod-royanoxicam",
      }),
      product({
        code: "CARVIBRADINE",
        factoryLocationId: HOCHSTER,
        geometry: carvibradine(unitsPerBox),
        id: "prod-carvibradine",
        manufacturerName: "Hochster Pharmaceutical Industries",
      }),
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
    stock,
  };
}

function rowOf(plan: { rows: readonly { code: string }[] }, code: string) {
  const row = plan.rows.find((candidate) => candidate.code === code);
  assert.ok(row, `the plan should carry a row for ${code}`);
  return row as (typeof plan.rows)[number] & Record<string, string | boolean | null>;
}

export function runProductionPlanningCarvibradineTests() {
  const sql = sqlOf(MIGRATION);

  // ── The geometry: 30.6 kg of 180 mg tablets is exactly 170,000 ──────────────────────────────
  // A box of one isolates the tablet arithmetic from the box, whose real size is checked last.
  const oneTabletBoxes = carvibradine(1);
  assert.equal(dosesPerRun(oneTabletBoxes), BigInt(TABLETS_A_BATCH), "the BOM's own \"Batch Size: 170000 Tablet\"");
  assert.equal(
    yieldForRuns(oneTabletBoxes, BigInt(1), BigInt(0)).leftoverMl,
    BigInt(0),
    "30,600,000 mg divides by 180 mg exactly — nothing is left over",
  );

  // ── The formula, read back out of the migration ──────────────────────────────────────────────
  const seeded = compositionRows(sql);
  const perDose = seeded.filter((row) => row.basis === "per_dose");
  assert.equal(perDose.length, 12, "twelve quantified lines — the three Q.S solvents carry none");

  // 🔴 THE TOTAL IS THE PROOF. Summed in micrograms, because floating-point grams would need a
  // tolerance and a tolerance hides exactly the typo this check exists for.
  const microgramsOf = (qty: string) => Math.round(Number(qty) * 1_000_000);
  const totalMicrograms = perDose.reduce((sum, row) => sum + microgramsOf(row.qty), 0);
  assert.equal(totalMicrograms, 180_000, "180 mg — 175 mg of core plus 5 mg of coat, one coated tablet");

  // Every line, times the 170,000 tablets of a batch, is the BOM's own figure to the milligram.
  for (const row of perDose) {
    assert.equal(
      (microgramsOf(row.qty) * TABLETS_A_BATCH) / 1_000,
      BOM_MG_PER_BATCH[row.code],
      `${row.code} a batch must be the BOM's figure`,
    );
  }
  assert.deepEqual(
    perDose.map((row) => row.code).sort(),
    Object.keys(BOM_MG_PER_BATCH).sort(),
    "and every BOM line has its composition row",
  );
  assert.equal(
    Object.values(BOM_MG_PER_BATCH).reduce((sum, mg) => sum + mg, 0),
    30_600_000,
    "which together are the 30.6 kg batch",
  );

  // ── Who brings what — his one sentence ───────────────────────────────────────────────────────
  // "In Carvibradine T we supply Carvidilol, Ivabradine, Pumphlet, Boxes & aluminium Foil".
  assert.deepEqual(
    seeded.filter((row) => row.supplier === "sato").map((row) => row.code).sort(),
    ["BOX_CARVIBRADINE", "CARVEDILOL", "IVABRADINE_HCL", "LEAFLET_CARVIBRADINE"],
    "the four Sato lines that HAVE a quantity; the aluminium is his too and has no line yet",
  );
  assert.equal(
    seeded.some((row) => row.code === "BLISTER_ALU_CARVIBRADINE"),
    false,
    "the foil is seeded as a material and NOT as a composition — a guessed weight is what this prevents",
  );
  assert.equal(
    seeded.some((row) => ["ABSOLUTE_ETHANOL", "ETHYL_ALCOHOL", "PURIFIED_WATER"].includes(row.code)),
    false,
    "Q.S solvents that evaporate during processing have no per-tablet quantity to hold",
  );

  // ── The materials: eleven new, seven shared, three that only LOOK shared ─────────────────────
  assert.deepEqual(insertedMaterialCodes(sql).sort(), NEW_MATERIALS, "the eleven materials this migration creates");
  const linked = linkedMaterialCodes(sql);
  assert.equal(linked.length, 18, "eighteen materials on Carvibradine's list");
  assert.deepEqual(
    linked.map((row) => row.sortOrder),
    linked.map((_, index) => (index + 1) * 10),
    "in the certificate's order, ten apart",
  );
  const royanoxicamMaterials = new Set(insertedMaterialCodes(sqlOf(ROYANOXICAM_MIGRATION)));
  for (const code of SHARED_MATERIALS) {
    assert.ok(linked.some((row) => row.code === code), `${code} is on Carvibradine's list`);
    assert.ok(royanoxicamMaterials.has(code), `${code} already exists — Royanoxicam created it`);
  }
  for (const code of NEW_MATERIALS) {
    assert.equal(royanoxicamMaterials.has(code), false, `${code} must not collide with a Royanoxicam row`);
  }
  // A different grade is a different material: merging them would let one product's stock count
  // for the other's.
  assert.equal(linked.some((row) => row.code === "LACTOSE_MONO_200"), false, "not Royanoxicam's 200-mesh lactose");
  assert.equal(
    linked.some((row) => /^HPMC_/.test(row.code) && row.code !== "HPMC_E5"),
    false,
    "and not Royanoxicam's E15 hypromellose",
  );

  // ── Hochster, the fourth factory, and Carvibradine made there ────────────────────────────────
  assert.match(
    sql,
    /\('HOCHSTER',\s*'مخزن المصنع — هوكستر',\s*'At the factory \(Hochster\)',\s*true,\s*50\)/,
    "Hochster is a factory store, sorted after Egyphar",
  );
  assert.match(
    sql,
    /set factory_location_id = l\.id[\s\S]*?where l\.code = 'HOCHSTER'[\s\S]*?and p\.code = 'CARVIBRADINE'/,
    "and Carvibradine's own factory is Hochster — not whichever factory a resolver finds first",
  );
  assert.match(sql, /'Hochster Pharmaceutical Industries',\s*'mg',/);

  // ── The plan: one batch, the buy list he named ───────────────────────────────────────────────
  const plan = computePlan(planningData(sql, 1), {
    mode: "runs",
    productId: "prod-carvibradine",
    requestedQty: "1",
    sampleUnits: "0",
  });
  assert.equal(plan.goodUnits, String(TABLETS_A_BATCH), "a tablet is the saleable unit");
  assert.equal(plan.measureUnit, "mg");
  assert.equal(plan.runVolumeLitres, "30.6", "the batch tile reads the BOM's 30.6 kg, not 30,600");

  assert.equal(rowOf(plan, "CARVEDILOL").needed, "1.094375", "1.0625 kg of active plus the 3% default");
  assert.equal(rowOf(plan, "IVABRADINE_HCL").needed, "0.943789", "0.9163 kg of active plus the 3% default");
  for (const code of ["CARVEDILOL", "IVABRADINE_HCL"]) {
    assert.equal(rowOf(plan, code).contributesToBuyList, true, `Sato brings ${code}`);
  }

  // The factory's lines still show what a run CONSUMES, and none of them reaches the buy list.
  assert.equal(rowOf(plan, "LACTOSE_MONO").needed, "11.9068", "11.56 kg plus the 3% default");
  assert.equal(rowOf(plan, "LACTOSE_MONO").contributesToBuyList, false);
  assert.equal(rowOf(plan, "LACTOSE_MONO").excludedReason, "factory_supplies");
  assert.equal(rowOf(plan, "AEROSIL_200").excludedReason, "factory_supplies", "a shared row is still Hochster's here");

  // 🔴 The foil is a ROW WITH NO COMPOSITION, never a row with a zero.
  assert.equal(rowOf(plan, "BLISTER_ALU_CARVIBRADINE").excludedReason, "no_composition");
  assert.equal(rowOf(plan, "BLISTER_ALU_CARVIBRADINE").contributesToBuyList, false);
  assert.equal(rowOf(plan, "ABSOLUTE_ETHANOL").excludedReason, "no_composition");

  // ── A shared material's stock belongs to the factory that holds it ───────────────────────────
  const aerosilAtEgyphar = planningData(sql, 1, [
    {
      asOfDate: "2026-10-29",
      expiryDate: "2028-01-31",
      locationId: EGYPHAR,
      materialId: "mat-AEROSIL_200",
      note: null,
      qty: parseQty("5000"),
      source: "factory_report",
    },
  ]);
  const atHochster = computePlan(aerosilAtEgyphar, {
    mode: "runs",
    productId: "prod-carvibradine",
    requestedQty: "1",
    sampleUnits: "0",
  });
  assert.equal(
    rowOf(atHochster, "AEROSIL_200").heldAtFactory,
    "0",
    "5 kg of Aerosil at Egyphar is NOT held at Hochster — Carvibradine's run cannot be planned against it",
  );
  const atEgyphar = computePlan(aerosilAtEgyphar, {
    mode: "runs",
    productId: "prod-royanoxicam",
    requestedQty: "1",
    sampleUnits: "0",
  });
  assert.equal(rowOf(atEgyphar, "AEROSIL_200").heldAtFactory, "5", "and it still counts for Royanoxicam, where it sits");

  // ── 🔴 The box size — the one figure neither paper states ────────────────────────────────────
  //
  // He could not say on 2026-10-29: the person who knows was asleep. `units_per_box` cannot be
  // edited from the Settings tab, so a guess would sit on the screen as a measured figure. This
  // stays red until the real number is in the migration AND the guard that refuses it is gone.
  const unitsPerBox = unitsPerBoxIn(sql);
  if (unitsPerBox === null) {
    assert.fail(
      "Carvibradine box size pending: neither Hochster paper states how many tablets go in one box. " +
        "Write the real number into units_per_box in the migration, delete its raise-exception guard, then apply it.",
    );
  }
  assert.equal(/raise exception/.test(sql), false, "the guard that refused the migration is deleted with the number in");
  assert.ok(unitsPerBox >= 1 && unitsPerBox <= 1000, "inside the column's own CHECK");

  const boxes = Math.ceil(TABLETS_A_BATCH / unitsPerBox);
  const boxed = computePlan(planningData(sql, unitsPerBox), {
    mode: "runs",
    productId: "prod-carvibradine",
    requestedQty: "1",
    sampleUnits: "0",
  });
  assert.equal(boxed.totalBoxes, String(boxes), `170,000 tablets fill ${boxes} boxes of ${unitsPerBox}`);
  for (const code of ["BOX_CARVIBRADINE", "LEAFLET_CARVIBRADINE"]) {
    assert.equal(rowOf(boxed, code).contributesToBuyList, true, `Sato brings ${code}`);
    assert.equal(
      rowOf(boxed, code).needed,
      String(Math.ceil(boxes * 1.03)),
      `one ${code} a box plus the default waste`,
    );
  }
}
