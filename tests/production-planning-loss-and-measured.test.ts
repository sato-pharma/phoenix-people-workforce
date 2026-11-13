import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { dataGapsFor } from "../src/lib/production-planning/gaps.ts";
import { resolveRunGeometry, type RunGeometry } from "../src/lib/production-planning/geometry.ts";
import {
  measuredConsumptionByProduct,
  measuredConsumptionKey,
  type ProductRunObservation,
} from "../src/lib/production-planning/learning.ts";
import { resolveMaterialRequirement, type MaterialRequirementInput } from "../src/lib/production-planning/requirements.ts";
import { formatQty, parsePct, parseQty, QTY_SCALE } from "../src/lib/production-planning/rules.ts";
import { PP, PP_EN } from "../src/lib/production-planning/strings.ts";
import type { WireMaterial } from "../src/lib/production-planning/wire.ts";

/**
 * Production Planner — the Royafloxacin 500 review of 2026-11-13 ("Revision of Royafloxacin 500
 * Production Data and Stock Settings"), forwarded by the owner:
 *
 *  1. "calculate the loss percentage separately for better clarity" — every requirement carries the
 *     loss as its OWN quantity, `needed − rawNeeded`, so the screen reads net + loss = total.
 *  2. "leave the aluminum consumption field blank and calculate it based on the actual consumption
 *     after production is completed" — EGPI's 25 kg-a-batch foil line is closed, and a Sato material
 *     with NO formula line takes its per-batch amount from THIS product's recorded runs, with no
 *     loss added on top (the actual already holds it). A line in force always wins.
 */

/** EGPI's Royafloxacin, as 20261111143317 left it: 160,000 tablets a batch, 16,000 boxes, 2 strips. */
const ROYAFLOXACIN_EGPI: RunGeometry = {
  runVolumeMl: BigInt(80_000_000),
  doseMl: BigInt(500),
  goodUnitMl: BigInt(500),
  sampleUnitMl: BigInt(1_000),
  wholeRunsOnly: true,
  unitsPerBox: BigInt(10),
  sampleInOwnBox: true,
  stripsPerBox: BigInt(2),
};

const KG = BigInt(1_000) * QTY_SCALE;
const EGPI = "loc-egpi";

function foil(overrides: Partial<MaterialRequirementInput>): MaterialRequirementInput {
  return {
    materialId: "mat-foil",
    code: "BLISTER_ALU_ROYAFLOXACIN",
    nameAr: "foil",
    nameEn: "foil",
    unitKind: "mass",
    displayUnit: "kg",
    basePerDisplayMicro: KG,
    isImported: false,
    leadTimeDays: null,
    minOrderQty: null,
    purchaseIncrement: null,
    basis: null,
    qtyPerBasis: null,
    supplier: "sato",
    overagePctScaled: parsePct("3"),
    overageSource: "default",
    heldByLocationId: new Map(),
    factoryLocationId: EGPI,
    willSendQty: null,
    ...overrides,
  };
}

function observation(overrides: Partial<ProductRunObservation>): ProductRunObservation {
  return {
    runId: "run-1",
    productId: "egpi",
    materialId: "mat-foil",
    consumedQty: parseQty("25500"), // 25.5 kg, in grams
    theoreticalQty: null,
    runsCount: BigInt(1),
    isExcludedFromLearning: false,
    ...overrides,
  };
}

export function runProductionPlanningLossAndMeasuredTests() {
  const threeRuns = resolveRunGeometry(ROYAFLOXACIN_EGPI, {
    mode: "runs",
    requestedQty: BigInt(3),
    sampleUnits: BigInt(0),
  });
  assert.equal(threeRuns.runs, BigInt(3));
  assert.equal(threeRuns.stripCount, BigInt(96_000), "3 batches are 96,000 strips");

  // ── 1. The loss is its own quantity, and net + loss = total to the digit ─────────────────────────
  // The foil as it WAS (0.78125 g a strip, default 3%): 3 batches = 75 kg net, 2.25 kg loss, 77.25.
  const withLine = resolveMaterialRequirement(
    foil({ basis: "per_strip", qtyPerBasis: parseQty("0.78125") }),
    threeRuns,
  );
  assert.equal(withLine.amountSource, "formula");
  assert.equal(formatQty(withLine.rawNeededQty), "75000", "net: 75 kg");
  assert.equal(formatQty(withLine.lossQty), "2250", "loss: 2.25 kg, the 3% on its own");
  assert.equal(formatQty(withLine.neededQty), "77250", "total: 77.25 kg");
  assert.equal(withLine.rawNeededQty + withLine.lossQty, withLine.neededQty, "net + loss = total");

  // A zero overage is a zero loss, never a negative one.
  const noLoss = resolveMaterialRequirement(
    foil({ basis: "per_strip", qtyPerBasis: parseQty("0.78125"), overagePctScaled: BigInt(0), overageSource: "material" }),
    threeRuns,
  );
  assert.equal(noLoss.lossQty, BigInt(0));

  // ── 2. Blank amount and nothing recorded: a gap, never a zero that reads "none needed" ───────────
  const blank = resolveMaterialRequirement(foil({}), threeRuns);
  assert.equal(blank.amountSource, null);
  assert.equal(blank.neededQty, BigInt(0));
  assert.equal(blank.contributesToBuyList, false);
  assert.equal(blank.excludedReason, "no_composition");

  // ── 3. Blank amount, measured from recorded runs: per batch, NO loss on top, on the buy list ─────
  const measured = measuredConsumptionByProduct([
    observation({ runId: "run-1", consumedQty: parseQty("25500") }),
    observation({ runId: "run-2", consumedQty: parseQty("51001"), runsCount: BigInt(2) }),
    // Excluded runs teach nothing.
    observation({ runId: "run-x", consumedQty: parseQty("999999"), isExcludedFromLearning: true }),
    // The SAME foil at Medizen (8,000 boxes a batch) never mixes into EGPI's average.
    observation({ runId: "run-m", productId: "medizen", consumedQty: parseQty("12500") }),
    // A material recorded with nothing consumed is not measured — zero would read "none needed".
    observation({ runId: "run-1", materialId: "mat-untouched", consumedQty: BigInt(0) }),
  ]);
  const egpi = measured.get(measuredConsumptionKey("egpi", "mat-foil"));
  assert.ok(egpi, "EGPI's foil is measured");
  assert.equal(egpi.runsCounted, BigInt(3), "3 batches across two records; the excluded one left out");
  // 76,501 g over 3 batches = 25,500.333… g, rounded UP so the average is never a micro short.
  assert.equal(formatQty(egpi.perRunQty), "25500.333334");
  assert.equal(formatQty(measured.get(measuredConsumptionKey("medizen", "mat-foil"))!.perRunQty), "12500");
  assert.equal(measured.has(measuredConsumptionKey("egpi", "mat-untouched")), false);

  const fromRuns = resolveMaterialRequirement(
    foil({ measuredPerRunQty: egpi.perRunQty, measuredRuns: egpi.runsCounted }),
    threeRuns,
  );
  assert.equal(fromRuns.amountSource, "measured");
  assert.equal(fromRuns.overageSource, "actual");
  assert.equal(fromRuns.overagePctScaled, BigInt(0), "the actual already holds the loss");
  assert.equal(fromRuns.lossQty, BigInt(0));
  assert.equal(fromRuns.basisCount, BigInt(3), "counted per batch");
  assert.equal(formatQty(fromRuns.neededQty), "76501.000002", "3 × the rounded-up batch average");
  assert.equal(fromRuns.neededPerRunQty, egpi.perRunQty);
  assert.equal(fromRuns.contributesToBuyList, true, "a measured Sato material is bought");
  assert.equal(fromRuns.measuredRuns, BigInt(3));

  // A line in force always wins over a measurement.
  const lineWins = resolveMaterialRequirement(
    foil({ basis: "per_strip", qtyPerBasis: parseQty("0.78125"), measuredPerRunQty: egpi.perRunQty }),
    threeRuns,
  );
  assert.equal(lineWins.amountSource, "formula");
  assert.equal(formatQty(lineWins.neededQty), "77250");

  // ── 4. The missing-data warning: a measured amount IS an amount ─────────────────────────────────
  const wire = (measuredAmount: WireMaterial["measured"]): WireMaterial =>
    ({
      id: "mat-foil",
      nameAr: "foil",
      nameEn: "foil",
      supplier: "sato",
      composition: null,
      measured: measuredAmount,
      heldByLocation: [{ locationId: EGPI, qty: "1000", qtyDisplay: "1", newestAsOfDate: "2026-11-13", lots: 1 }],
    }) as WireMaterial;
  assert.deepEqual(dataGapsFor([wire(null)])[0]?.missing, ["amount"], "blank and unmeasured is a gap");
  assert.deepEqual(dataGapsFor([wire({ perRun: "25.500334", runsCounted: "3" })]), [], "measured is not a gap");

  // ── 5. Both languages carry the new words ───────────────────────────────────────────────────────
  for (const key of ["netNeed", "lossLabel", "totalNeeded", "amountMeasuredRuns", "overageHintActual"] as const) {
    assert.ok(PP[key].length > 0 && PP_EN[key].length > 0, key);
  }

  // ── 6. The data: EGPI's foil line is CLOSED (never deleted), and a plan line may say so ─────────
  const close = readFileSync(
    "supabase/migrations/20261113131448_production_planning_royafloxacin_foil_from_actuals.sql",
    "utf8",
  );
  assert.match(close, /set effective_to = date '2026-11-13'/);
  assert.match(close, /p\.code = 'ROYAFLOXACIN_EGPI'/);
  assert.match(close, /m\.code = 'BLISTER_ALU_ROYAFLOXACIN'/);
  assert.doesNotMatch(close, /^\s*delete\b/im, "a line is closed, never removed");
  const basis = readFileSync("supabase/migrations/20261113131447_production_planning_measured_basis.sql", "utf8");
  assert.match(basis, /'per_run_measured'::text/);
}
