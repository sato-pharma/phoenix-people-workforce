import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { dosesPerRun, type RunGeometry, yieldForRuns } from "../src/lib/production-planning/geometry.ts";
import { type MaterialSupplier, parsePct, parseQty, QTY_SCALE } from "../src/lib/production-planning/rules.ts";
import {
  computePlan,
  type LoadedComposition,
  type LoadedMaterial,
  type LoadedProduct,
  type ProductionPlanningData,
} from "../src/lib/production-planning/service.ts";
import { shownBatchWeight, shownTotalWeight, shownUnitWeights } from "../src/lib/production-planning/display-weights.ts";
import { stripSqlComments } from "./support/comment-strip.ts";

/**
 * Production Planner — Royafloxacin 500 mg, a film-coated tablet made at Medizen.
 *
 * The owner sent Medizen's composition paper and its stock sheet of 02/09/2026 on 2026-11-03, then
 * answered **"80 000 tab  -  65.2 kg"** and that the split is the same as Royanoxicam's.
 *
 * ── What this file keeps true ───────────────────────────────────────────────────────────────────
 *
 *  1. **The formula is the paper's, to the microgram.** It is read back OUT of the migration, and the
 *     lines must add to the paper's 815 mg core and 847.6 mg coated tablet.
 *  2. **A batch is his 65.2 kg, which is the CORE**: 80,000 tablets of 815 mg, 8,000 boxes of 10,
 *     nothing left over. The coat's lines count per tablet on top of it.
 *  3. **Sato brings four things and the foil has no amount**: it reads "no composition", never a zero.
 *  4. **The stock is the sheet's, at Medizen, and none of it is another product's.** The lornoxicam on
 *     the same sheet stays out: **"خليه يختار بس الليفو فلوكساسين فقط"**.
 */

const MIGRATION = "supabase/migrations/20261103223424_production_planning_royafloxacin.sql";
const EGPI_MIGRATION = "supabase/migrations/20261111133401_production_planning_royafloxacin_egpi.sql";

const MEDIZEN = "loc-medizen";
const EGYPHAR = "loc-egyphar";
const SATO_STORE = "loc-sato";

const TABLETS_A_BATCH = 80_000;
const BOXES_A_BATCH = 8_000;

/** The paper's core table, in micrograms a tablet. */
const CORE_MICROGRAMS: Record<string, number> = {
  AEROSIL_200: 8_000,
  CROSCARMELLOSE_NA: 35_000,
  LEVOFLOXACIN_HEMIHYDRATE: 512_500,
  MAGNESIUM_STEARATE: 8_000,
  MCC_PH102: 153_500,
  PVP_K30: 48_000,
  SODIUM_STARCH_GLYCOLATE: 30_000,
  TALC_POWDER: 20_000,
};

/** The paper's coat table, in micrograms a tablet. */
const COAT_MICROGRAMS: Record<string, number> = {
  HPMC_E15: 19_560,
  PEG_6000: 4_890,
  TALC_PURIFIED: 1_000,
  TITANIUM_DIOXIDE: 7_150,
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
  const pattern = /\('([A-Z0-9_]+)',\s*'(per_dose|per_box)',\s*([0-9.]+),\s*'(sato|factory)'/g;
  return [...sql.matchAll(pattern)].map((match) => ({
    basis: match[2] as LoadedComposition["basis"],
    code: match[1]!,
    qty: match[3]!,
    supplier: match[4] as LoadedComposition["supplier"],
  }));
}

function stockRows(sql: string): { code: string; qty: string; expiry: string | null }[] {
  const values = block(sql, "insert into public.prodplan_stock_entries", "where l.code = 'MEDIZEN'");
  return [...values.matchAll(/\('([A-Z0-9_]+)',\s*([0-9.]+)::numeric,\s*(?:date '([0-9-]+)'|null::date),/g)].map((match) => ({
    code: match[1]!,
    expiry: match[3] ?? null,
    qty: match[2]!,
  }));
}

const GEOMETRY: RunGeometry = {
  doseMl: BigInt(815),
  goodUnitMl: BigInt(815),
  runVolumeMl: BigInt(65_200_000),
  sampleUnitMl: BigInt(815),
  stripsPerBox: BigInt(2),
  unitsPerBox: BigInt(10),
  wholeRunsOnly: true,
};

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

const PRODUCT: LoadedProduct = {
  code: "ROYAFLOXACIN",
  defaultSampleUnits: BigInt(0),
  factoryLocationId: MEDIZEN,
  geometry: GEOMETRY,
  id: "prod-royafloxacin",
  manufacturerName: "Medizen Pharmaceutical Industries",
  measureUnit: "mg",
  nameAr: "ROYAFLOXACIN",
  nameEn: "ROYAFLOXACIN",
  notes: null,
};

/** Royafloxacin at Medizen, built from the MIGRATION itself, stock included unless a test names its own. */
function planningData(sql: string, stock?: ProductionPlanningData["stock"]): ProductionPlanningData {
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
    compositionsByProductId: new Map([[PRODUCT.id, compositions]]),
    fx: { rateDate: "2026-11-03", source: "manual", usdToEgpMicro: BigInt(48) * QTY_SCALE },
    learning: new Map(),
    level: "full",
    linkSupplierByProductId: new Map([[PRODUCT.id, linkSuppliers]]),
    locations: [
      { code: "EGYPHAR", id: EGYPHAR, isFactory: true, nameAr: "إيجيفار", nameEn: "Egyphar" },
      { code: "SATO_STORE", id: SATO_STORE, isFactory: false, nameAr: "مخزن ساتو", nameEn: "Sato store" },
      { code: "MEDIZEN", id: MEDIZEN, isFactory: true, nameAr: "ميديزن", nameEn: "Medizen" },
    ],
    materialIdsByProductId: new Map([[PRODUCT.id, new Set(materials.map((item) => item.id))]]),
    materials,
    prices: [],
    products: [PRODUCT],
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
    stock:
      stock ??
      stockRows(sql).map((row) => ({
        asOfDate: "2026-09-02",
        expiryDate: row.expiry,
        locationId: MEDIZEN,
        materialId: `mat-${row.code}`,
        note: null,
        qty: parseQty(row.qty),
        source: "factory_report",
      })),
  };
}

function rowOf(plan: { rows: readonly { code: string }[] }, code: string) {
  const row = plan.rows.find((candidate) => candidate.code === code);
  assert.ok(row, `the plan should carry a row for ${code}`);
  return row as (typeof plan.rows)[number] & Record<string, string | boolean | null>;
}

export async function runProductionPlanningRoyafloxacinTests() {
  const sql = sqlOf(MIGRATION);

  // ── The geometry: "80 000 tab  -  65.2 kg" ──────────────────────────────────────────────────
  assert.equal(dosesPerRun(GEOMETRY), BigInt(TABLETS_A_BATCH), "80,000 tablets a batch");
  assert.equal(yieldForRuns(GEOMETRY, BigInt(1), BigInt(0)).leftoverMl, BigInt(0), "65,200,000 mg divides by 815 mg exactly");
  assert.match(sql, /'mg',\s*65200000,\s*815,\s*815,\s*815,\s*true,\s*10,\s*2,\s*0,/, "65.2 kg, the 815 mg core, 10 a box, 2 strips, no samples by default");

  // ── The formula, read back out of the migration ─────────────────────────────────────────────
  const seeded = compositionRows(sql);
  const microgramsOf = (qty: string) => Math.round(Number(qty) * 1_000_000);
  const sumOf = (table: Record<string, number>) =>
    seeded.filter((row) => row.code in table).reduce((sum, row) => sum + microgramsOf(row.qty), 0);
  for (const row of seeded.filter((item) => item.basis === "per_dose")) {
    const expected = CORE_MICROGRAMS[row.code] ?? COAT_MICROGRAMS[row.code];
    assert.equal(microgramsOf(row.qty), expected, `${row.code} is the paper's figure`);
  }
  assert.deepEqual(
    seeded.filter((row) => row.basis === "per_dose").map((row) => row.code).sort(),
    [...Object.keys(CORE_MICROGRAMS), ...Object.keys(COAT_MICROGRAMS)].sort(),
    "every weighed line on the paper has a row",
  );
  // 🔴 THE TOTALS ARE THE PROOF, summed in micrograms because a tolerance hides the typo this is for.
  assert.equal(sumOf(CORE_MICROGRAMS), 815_000, "the paper's \"Total Core Tablet Weight\": 815 mg");
  assert.equal(sumOf(CORE_MICROGRAMS) + sumOf(COAT_MICROGRAMS), 847_600, "the paper's \"Total Coated Tablet Weight\": 847.6 mg");

  // ── Who brings what: the same split as Royanoxicam ──────────────────────────────────────────
  assert.deepEqual(
    seeded.filter((row) => row.supplier === "sato").map((row) => row.code).sort(),
    ["BOX_ROYAFLOXACIN_10", "LEAFLET_ROYAFLOXACIN", "LEVOFLOXACIN_HEMIHYDRATE"],
    "the three Sato lines that HAVE a quantity; the foil is Sato's too and has no line",
  );
  const linked = linkedMaterials(sql);
  assert.equal(linked.length, 18, "fifteen on the paper, then the foil, the box and the leaflet");
  assert.deepEqual(
    linked.filter((row) => row.supplier !== null).map((row) => [row.code, row.supplier]),
    [
      ["ETHYL_ALCOHOL_95", "factory"],
      ["ETHYL_ALCOHOL", "factory"],
      ["PURIFIED_WATER", "factory"],
      ["BLISTER_ALU_ROYAFLOXACIN", "sato"],
    ],
    "only the four with no line name a supplier on the link",
  );

  // ── Shared rows are linked, never re-inserted ───────────────────────────────────────────────
  assert.deepEqual(
    insertedMaterialCodes(sql).sort(),
    [
      "BLISTER_ALU_ROYAFLOXACIN",
      "BOX_ROYAFLOXACIN_10",
      "ETHYL_ALCOHOL_95",
      "LEAFLET_ROYAFLOXACIN",
      "LEVOFLOXACIN_HEMIHYDRATE",
      "SODIUM_STARCH_GLYCOLATE",
      "TALC_POWDER",
    ],
    "seven new materials, the rest are existing rows",
  );
  assert.match(sql, /set factory_location_id = l\.id[\s\S]*?where l\.code = 'MEDIZEN'[\s\S]*?and p\.code = 'ROYAFLOXACIN'/, "made at Medizen");

  // ── The stock is the sheet's, and only this product's ───────────────────────────────────────
  const stock = stockRows(sql);
  assert.deepEqual(
    stock.map((row) => [row.code, row.qty, row.expiry]),
    [
      ["LEVOFLOXACIN_HEMIHYDRATE", "600000.000000", "2031-05-30"],
      ["BLISTER_ALU_ROYAFLOXACIN", "30910.000000", null],
      ["BOX_ROYAFLOXACIN_10", "23470.000000", null],
      ["LEAFLET_ROYAFLOXACIN", "27120.000000", null],
    ],
    "the 02/09/2026 sheet: 600 kg, 30.91 kg, 23,470 boxes, 27,120 leaflets, in base units",
  );
  assert.equal(/LORNOXICAM/.test(sql), false, "🔴 the lornoxicam on the same sheet is not this product's");

  // ── One batch, through the real engine ──────────────────────────────────────────────────────
  const plan = computePlan(planningData(sql), { mode: "runs", productId: PRODUCT.id, requestedQty: "1", sampleUnits: "0" });
  assert.equal(plan.goodUnits, String(TABLETS_A_BATCH), "80,000 tablets");
  assert.equal(plan.totalBoxes, String(BOXES_A_BATCH), "8,000 boxes");
  assert.equal(plan.runVolumeLitres, "65.2", "🔴 the batch tile reads his 65.2 kg");

  const levofloxacin = rowOf(plan, "LEVOFLOXACIN_HEMIHYDRATE");
  assert.equal(levofloxacin.rawNeeded, "41", "512.5 mg × 80,000 tablets");
  assert.equal(levofloxacin.needed, "42.23", "plus the 3% default");
  assert.equal(levofloxacin.heldAtFactory, "600", "the 600 kg on the sheet counts as held");
  assert.equal(levofloxacin.contributesToBuyList, true, "Sato brings it");

  const box = rowOf(plan, "BOX_ROYAFLOXACIN_10");
  assert.equal(box.basisCount, "8000", "one box a box");
  assert.equal(box.heldAtFactory, "23470", "off the sheet");
  assert.equal(rowOf(plan, "LEAFLET_ROYAFLOXACIN").basisCount, "8000", "one leaflet a box, never one a tablet");
  assert.equal(rowOf(plan, "LEAFLET_ROYAFLOXACIN").heldAtFactory, "27120", "off the sheet");

  // 🔴 The coat counts per tablet on top of his core weight, so nothing here is scaled to 65.2 kg.
  assert.equal(rowOf(plan, "HPMC_E15").rawNeeded, "1.5648", "19.56 mg × 80,000 tablets");

  for (const code of [...Object.keys(CORE_MICROGRAMS), ...Object.keys(COAT_MICROGRAMS)].filter((item) => item !== "LEVOFLOXACIN_HEMIHYDRATE")) {
    assert.equal(rowOf(plan, code).contributesToBuyList, false, `${code} is Medizen's`);
    assert.equal(rowOf(plan, code).excludedReason, "factory_supplies", `${code} shows what a run consumes and stops there`);
  }

  // 🔴 The foil is Sato's with stock and NO AMOUNT: a row with no composition, never a zero.
  const foil = rowOf(plan, "BLISTER_ALU_ROYAFLOXACIN");
  assert.equal(foil.supplier, "sato", "the aluminium is Sato's, from the link");
  assert.equal(foil.excludedReason, "no_composition", "and neither paper carries its weight");
  assert.equal(foil.contributesToBuyList, false, "so it is never bought on a guess");
  assert.equal(foil.heldAtFactory, "30.91", "while its stock is still on the row");

  for (const code of ["ETHYL_ALCOHOL_95", "ETHYL_ALCOHOL", "PURIFIED_WATER"]) {
    assert.equal(rowOf(plan, code).supplier, "factory", `${code} is the factory's, from the link`);
    assert.equal(rowOf(plan, code).contributesToBuyList, false, `${code} is never on Sato's list`);
  }

  // ── A shared material's stock belongs to the factory that holds it ──────────────────────────
  const aerosilElsewhere = computePlan(
    planningData(sql, [
      {
        asOfDate: "2026-11-03",
        expiryDate: "2028-01-31",
        locationId: EGYPHAR,
        materialId: "mat-AEROSIL_200",
        note: null,
        qty: parseQty("5000"),
        source: "factory_report",
      },
    ]),
    { mode: "runs", productId: PRODUCT.id, requestedQty: "1", sampleUnits: "0" },
  );
  assert.equal(rowOf(aerosilElsewhere, "AEROSIL_200").heldAtFactory, "0", "Aerosil at Egyphar is NOT held at Medizen");
  // ══ 2026-11-11 — Medizen corrected, its sample in a box of its own, and Royafloxacin at EGPI ══════
  // Owner's choices: "847.6 mg, 70 kg as stated", "Same tablet as Medizen", "Same 600 kg, move to EGPI".
  const egpiSql = sqlOf(EGPI_MIGRATION);
  const medizenUpdate = block(egpiSql, "update public.prodplan_products", "where code = 'ROYAFLOXACIN';");
  assert.match(medizenUpdate, /batch_weight_display = 70,/, "Medizen shows the factory's 70 kg a batch");
  assert.match(medizenUpdate, /unit_weight_display = 847\.6,/, "and the paper's 847.6 mg tablet, not the email's 845.6");
  assert.match(medizenUpdate, /sample_in_own_box = true,/, "its free sample is a box of its own");
  assert.match(medizenUpdate, /sample_unit_ml = 1630,/, "holding one strip of TWO tablets: 2 × 815");
  assert.doesNotMatch(medizenUpdate, /run_volume_ml|dose_ml/, "🔴 the counting geometry is NOT touched: still 80,000 × 815 mg");

  const egpiProduct = block(egpiSql, "'ROYAFLOXACIN_EGPI',", "on conflict (code) do nothing;");
  assert.match(egpiProduct, /76919700, 815, 815, 1630, true, 10,\s*2, 0, true, 80, 847\.6,/, "EGPI's geometry and shown weights");
  const egpiTablets = 76_919_700 / 815;
  assert.equal(egpiTablets, 94_380, "an EGPI batch counts 94,380 tablets exactly");
  assert.equal(egpiTablets / 10, 9_438, "which is 9,438 whole boxes of ten");
  assert.ok(Math.abs(egpiTablets * 847.6 - 80_000_000) < 847.6 * 10, "and 80 kg of the 847.6 mg tablet to within one box");

  // 🔴 Only what Sato supplies is on the EGPI product — "Please hide any items that are not supplied by SATO".
  const egpiLines = block(egpiSql, "insert into public.prodplan_compositions", "on conflict (product_id, material_id, effective_from)");
  assert.doesNotMatch(egpiLines, /'factory'/, "no factory line is seeded at EGPI");
  for (const code of ["LEVOFLOXACIN_HEMIHYDRATE", "BOX_ROYAFLOXACIN_10", "LEAFLET_ROYAFLOXACIN", "BOX_ROYAFLOXACIN_SAMPLE"]) {
    assert.match(egpiLines, new RegExp(`'ROYAFLOXACIN_EGPI', '${code}'`), `EGPI carries ${code}`);
  }
  assert.match(egpiLines, /'LEVOFLOXACIN_HEMIHYDRATE', 'per_dose',\s+0\.512500/, "levofloxacin 512.5 mg a tablet at EGPI too");
  assert.match(egpiLines, /'ROYAFLOXACIN',\s+'BOX_ROYAFLOXACIN_SAMPLE',\s+'per_sample_unit', 1\.000000/, "and Medizen gains the sample box, one a sample");

  // The 600 kg moves: Medizen's lot closes at zero and EGPI's opens at 600 kg, same expiry, append-only.
  const move = block(egpiSql, "insert into public.prodplan_stock_entries", "commit;");
  assert.match(move, /'MEDIZEN', 0\.000000::numeric/, "Medizen's levofloxacin lot closes at zero");
  assert.match(move, /'EGPI', 600000\.000000::numeric/, "EGPI's opens at 600 kg (600,000 g)");
  assert.match(move, /date '2031-05-30', 'adjustment'/, "the same lot, as an adjustment");

  // ── A sample in its own box: 1 batch with 100 samples ─────────────────────────────────────────
  const OWN_BOX: RunGeometry = { ...GEOMETRY, sampleInOwnBox: true, sampleUnitMl: BigInt(1630) };
  const withSamples = yieldForRuns(OWN_BOX, BigInt(1), BigInt(100));
  assert.equal(withSamples.goodUnits, BigInt(79_800), "100 sample boxes of 2 take 200 tablets out of the batch");
  assert.equal(withSamples.perBoxCount, BigInt(7_980), "so the saleable boxes are 7,980");
  assert.equal(withSamples.totalBoxes, BigInt(8_080), "and with the 100 sample boxes, 8,080 boxes in all");
  assert.equal(withSamples.stripCount, BigInt(7_980 * 2 + 100), "a sample box is ONE strip");

  // ── The shown weights are labels, run through the micro units ─────────────────────────────────
  const medizenShown = { doseMl: "815", goodUnitMl: "815", sampleUnitMl: "1630", batchWeightDisplay: "70", unitWeightDisplay: "847.6" };
  assert.deepEqual(shownUnitWeights(medizenShown), { dose: "847.6", goodUnit: "847.6", sampleUnit: "1695.2" });
  assert.equal(shownBatchWeight(medizenShown, "65.2"), "70", "the batch tile reads 70 kg, not the core's 65.2");
  assert.equal(shownTotalWeight(medizenShown, BigInt(3), "195.6"), "210", "three batches read 210 kg");
  const plainShown = { doseMl: "815", goodUnitMl: "815", sampleUnitMl: "815", batchWeightDisplay: null, unitWeightDisplay: null };
  assert.deepEqual(shownUnitWeights(plainShown), { dose: "815", goodUnit: "815", sampleUnit: "815" }, "no stated weight shows the geometry");
  assert.equal(shownBatchWeight(plainShown, "65.2"), "65.2");
  assert.equal(shownTotalWeight(plainShown, BigInt(3), "195.6"), "195.6");

  // 🔴 And they move no quantity: levofloxacin for one batch is the same with or without them.
  const shownPlan = computePlan(
    { ...planningData(sql), products: [{ ...PRODUCT, batchWeightDisplay: "70", unitWeightDisplay: "847.6" }] },
    { mode: "runs", productId: PRODUCT.id, requestedQty: "1", sampleUnits: "0" },
  );
  assert.equal(rowOf(shownPlan, "LEVOFLOXACIN_HEMIHYDRATE").needed, "42.23", "41 kg a batch plus the 3% default, stated weights or not");
  assert.equal(shownPlan.runVolumeLitres, "70", "while the plan's batch figure reads the stated 70 kg");
}
