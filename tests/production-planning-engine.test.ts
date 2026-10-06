import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { evaluateAlarms, resolveAlarmArming, resolveFxArming, thresholdRunsToMicro } from "../src/lib/production-planning/alarm.ts";
import {
  costQuantity,
  formatMoney,
  resolveEffectiveFxRate,
  totalCosts,
} from "../src/lib/production-planning/costing.ts";
import {
  dosesPerRun,
  formatExactRuns,
  resolveRunGeometry,
  yieldForRuns,
  type RunGeometry,
} from "../src/lib/production-planning/geometry.ts";
import { learnFromRuns, resolveOverage } from "../src/lib/production-planning/learning.ts";
import {
  resolveMaterialRequirement,
  sortRequirements,
  summariseRequirements,
  type MaterialRequirementInput,
} from "../src/lib/production-planning/requirements.ts";
import {
  applyOverage,
  formatQty,
  parsePct,
  parseQty,
  ProductionPlanningInputError,
  QTY_SCALE,
  roundQtyUpToPurchasable,
} from "../src/lib/production-planning/rules.ts";

/**
 * Production Planner — the arithmetic the owner checked by hand, pinned.
 *
 * Every figure asserted here he has either stated himself or verified in the spreadsheet, so this
 * file is the contract between the module and what he already believes:
 *
 *  · the run volume is FIXED and samples come OUT of it, so 10,000 samples turn one run's 12,500
 *    bottles into 8,500 — while RAISING packaging from 12,500 sets to 18,500;
 *  · his headline number is the TOTAL, not the saleable half: 100,000 with 10,000 samples is 90,000
 *    good units, 7.52 runs, rounded to 8, yielding 106,000 boxes — 6,000 over the ask;
 *  · the buy list for those 8 runs is ivy 72.1 kg, sorbitol 4,120 kg, packaging 109,180 — NOT the
 *    74.984 / 4,284.8 / 113,300 that a session put in front of him on 2026-10-05, which were
 *    computed on the superseded "samples on top" reading at a fractional 8.32 runs;
 *  · the 9-run order he already has a spreadsheet for is untouched: ivy 81.1125 kg needed and
 *    38.1125 to send against the 43 at the factory;
 *  · a material nobody has settled with the factory contributes NOTHING to a buy list;
 *  · the arithmetic runs on BigInt, so potassium sorbate for 9 runs reads 15.52725 kg and not
 *    15.527250000000002 — the figure on screen and the formula in Excel have to agree to the digit;
 *  · the reorder alarm and the FX fetch both read FAIL-SAFE off the settings row.
 */

const MIGRATION = "supabase/migrations/20261005214007_production_planning.sql";

/** Ivyronc, exactly as the migration seeds it. */
const IVYRONC: RunGeometry = {
  runVolumeMl: BigInt(1_250_000),
  doseMl: BigInt(5),
  goodUnitMl: BigInt(100),
  sampleUnitMl: BigInt(40),
  wholeRunsOnly: true,
  unitsPerBox: BigInt(1),
};

/** kg → micro grams in one display unit: 1 kg is 1,000 g, carried at 1e6. */
const KG = BigInt(1_000) * QTY_SCALE;
const PIECE = QTY_SCALE;

const EGPI = "loc-egpi";
const SATO_STORE = "loc-sato";

function material(
  overrides: Partial<MaterialRequirementInput> & Pick<MaterialRequirementInput, "code">,
): MaterialRequirementInput {
  return {
    materialId: overrides.materialId ?? `mat-${overrides.code}`,
    code: overrides.code,
    nameAr: overrides.nameAr ?? overrides.code,
    nameEn: overrides.nameEn ?? overrides.code,
    unitKind: overrides.unitKind ?? "mass",
    displayUnit: overrides.displayUnit ?? "kg",
    basePerDisplayMicro: overrides.basePerDisplayMicro ?? KG,
    isImported: overrides.isImported ?? false,
    leadTimeDays: overrides.leadTimeDays ?? null,
    minOrderQty: overrides.minOrderQty ?? null,
    purchaseIncrement: overrides.purchaseIncrement ?? null,
    basis: overrides.basis ?? "per_dose",
    qtyPerBasis: overrides.qtyPerBasis ?? null,
    supplier: overrides.supplier ?? "sato",
    overagePctScaled: overrides.overagePctScaled ?? parsePct("3"),
    overageSource: overrides.overageSource ?? "default",
    heldByLocationId: overrides.heldByLocationId ?? new Map(),
    factoryLocationId: overrides.factoryLocationId ?? EGPI,
    willSendQty: overrides.willSendQty ?? null,
  };
}

/** The four Ivyronc lines whose figures the owner has already verified. */
const IVY = material({
  code: "IVY_EXTRACT",
  qtyPerBasis: parseQty("0.035"), // 35 mg per 5 ml dose
  isImported: true,
  leadTimeDays: 180,
  heldByLocationId: new Map([[EGPI, parseQty("43000")]]), // 43 kg
});
const SORBITOL = material({
  code: "SORBITOL",
  qtyPerBasis: parseQty("2"), // 500 kg a run across 250,000 doses
  heldByLocationId: new Map([[EGPI, parseQty("299000")]]), // 299 kg
});
const CARTON = material({
  code: "CARTON",
  unitKind: "count",
  displayUnit: "piece",
  basePerDisplayMicro: PIECE,
  basis: "per_packaging_set",
  qtyPerBasis: parseQty("1"),
  heldByLocationId: new Map([[EGPI, parseQty("13850")]]),
});
const STICKER = material({
  code: "STICKER",
  unitKind: "count",
  displayUnit: "piece",
  basePerDisplayMicro: PIECE,
  basis: "per_packaging_set",
  qtyPerBasis: parseQty("1"),
  heldByLocationId: new Map([[EGPI, parseQty("65850")]]),
});
const POTASSIUM_SORBATE = material({
  code: "POTASSIUM_SORBATE",
  qtyPerBasis: parseQty("0.0067"),
  supplier: "shared_unsettled",
});

/** kg as a readable string, from micro grams. */
function kg(micro: bigint): string {
  return formatQty((micro * QTY_SCALE) / KG);
}

export function runProductionPlanningEngineTests() {
  // ── The run volume is FIXED, and samples come OUT of it ────────────────────────────────────────
  assert.equal(dosesPerRun(IVYRONC), BigInt(250_000), "one 1,250 L run is 250,000 doses of 5 ml");

  const oneRunNoSamples = yieldForRuns(IVYRONC, BigInt(1), BigInt(0));
  assert.equal(oneRunNoSamples.goodUnits, BigInt(12_500), "one run with no samples is 12,500 bottles");
  assert.equal(oneRunNoSamples.packagingSets, BigInt(12_500), "and 12,500 packaging sets");
  assert.equal(oneRunNoSamples.leftoverMl, BigInt(0), "with nothing left over");

  const oneRun10kSamples = yieldForRuns(IVYRONC, BigInt(1), BigInt(10_000));
  assert.equal(
    oneRun10kSamples.goodUnits,
    BigInt(8_500),
    "10,000 samples of 40 ml inside ONE fixed 1,250 L run leave 8,500 bottles, not 12,500",
  );
  assert.equal(
    oneRun10kSamples.packagingSets,
    BigInt(18_500),
    "but they RAISE packaging to 18,500 sets — a 40 ml sample still takes a whole bottle, cap, carton and sticker",
  );
  assert.equal(oneRun10kSamples.totalBoxes, BigInt(18_500), "boxes equal packaging sets at 1 bottle per box");

  // A sample count that does not divide the leftover volume is reported, never silently dropped.
  const awkward = yieldForRuns(IVYRONC, BigInt(1), BigInt(10_001));
  assert.equal(awkward.leftoverMl, BigInt(60), "40 ml × 10,001 leaves 60 ml that fills neither a bottle nor a sample");

  // Asking for more samples than the syrup can make is an error, not a negative bottle count.
  assert.throws(
    () => yieldForRuns(IVYRONC, BigInt(1), BigInt(40_000)),
    (error: unknown) => error instanceof ProductionPlanningInputError,
    "31,250 samples is the whole run; 40,000 cannot come out of it",
  );

  // ── His headline number is the TOTAL ──────────────────────────────────────────────────────────
  const plan = resolveRunGeometry(IVYRONC, {
    mode: "total_boxes",
    requestedQty: BigInt(100_000),
    sampleUnits: BigInt(10_000),
  });
  assert.equal(formatExactRuns(plan.exactRunsMicro), "7.52", "90,000 × 100 ml + 10,000 × 40 ml is exactly 7.52 runs");
  assert.equal(plan.runs, BigInt(8), "runs are whole, so 7.52 rounds UP to 8");
  assert.equal(plan.goodUnits, BigInt(96_000), "8 fixed runs minus 10,000 samples yield 96,000 bottles");
  assert.equal(plan.sampleUnits, BigInt(10_000), "the samples he asked for");
  assert.equal(plan.packagingSets, BigInt(106_000), "106,000 packaging sets");
  assert.equal(plan.totalBoxes, BigInt(106_000), "106,000 boxes delivered");
  assert.equal(plan.requestedBoxes, BigInt(100_000), "against the 100,000 he asked for");
  assert.equal(plan.surplusBoxes, BigInt(6_000), "6,000 boxes over the ask, reported rather than hidden");
  assert.equal(plan.rounded, true, "and the result says plainly that it was rounded");
  assert.equal(plan.totalDoses, BigInt(2_000_000), "8 runs are 2,000,000 doses");

  // Undershooting is his call, so one run fewer is offered with what it would leave short.
  assert.ok(plan.oneRunFewer, "one run fewer is offered");
  assert.equal(plan.oneRunFewer?.runs, BigInt(7));
  assert.equal(plan.oneRunFewer?.goodUnits, BigInt(83_500), "7 runs minus 10,000 samples is 83,500 bottles");
  assert.equal(plan.oneRunFewer?.totalBoxes, BigInt(93_500));
  assert.equal(plan.oneRunFewer?.shortfallBoxes, BigInt(6_500), "6,500 short of the ask");

  // Samples cannot exceed the total, because they come out of it and are not added on top.
  assert.throws(
    () => resolveRunGeometry(IVYRONC, { mode: "total_boxes", requestedQty: BigInt(5_000), sampleUnits: BigInt(6_000) }),
    (error: unknown) => error instanceof ProductionPlanningInputError,
    "6,000 samples do not fit inside an order of 5,000 boxes",
  );

  // `good_units` mode asks for the saleable half only, so the samples ARE on top of it.
  const goodUnitsMode = resolveRunGeometry(IVYRONC, {
    mode: "good_units",
    requestedQty: BigInt(90_000),
    sampleUnits: BigInt(10_000),
  });
  assert.equal(goodUnitsMode.runs, BigInt(8), "the same 8 runs: 90,000 saleable plus 10,000 samples");
  assert.equal(goodUnitsMode.requestedBoxes, BigInt(100_000));

  // `runs` mode is his own number: nothing to round, no surplus to report.
  const runsMode = resolveRunGeometry(IVYRONC, { mode: "runs", requestedQty: BigInt(9), sampleUnits: BigInt(0) });
  assert.equal(runsMode.runs, BigInt(9));
  assert.equal(runsMode.goodUnits, BigInt(112_500), "9 runs with no samples is 112,500 bottles");
  assert.equal(runsMode.packagingSets, BigInt(112_500));
  assert.equal(runsMode.surplusBoxes, BigInt(0), "he named the run count, so there is no surplus to report");
  assert.equal(runsMode.rounded, false);

  // ── The CORRECTED buy list for 100,000 + 10,000 samples ───────────────────────────────────────
  const ivy8 = resolveMaterialRequirement(IVY, plan);
  assert.equal(kg(ivy8.rawNeededQty), "70", "0.035 g × 2,000,000 doses is 70 kg before overage");
  assert.equal(
    kg(ivy8.neededQty),
    "72.1",
    "ivy extract for 8 runs is 72.1 kg at 3% — NOT the 74.984 kg computed on the superseded 'samples on top' reading",
  );

  const sorbitol8 = resolveMaterialRequirement(SORBITOL, plan);
  assert.equal(kg(sorbitol8.rawNeededQty), "4000", "2 g × 2,000,000 doses is 4,000 kg before overage");
  assert.equal(
    kg(sorbitol8.neededQty),
    "4120",
    "sorbitol for 8 runs is 4,120 kg — NOT the 4,284.8 kg that came from 8.32 fractional runs",
  );

  const carton8 = resolveMaterialRequirement(CARTON, plan);
  assert.equal(carton8.basisCount, BigInt(106_000), "packaging is counted per SET, samples included");
  assert.equal(
    formatQty(carton8.neededQty),
    "109180",
    "packaging for 8 runs is 109,180 — NOT the 113,300 from the superseded reading",
  );

  // ── The 9-run order he already has a spreadsheet for is untouched ──────────────────────────────
  const ivy9 = resolveMaterialRequirement(IVY, runsMode);
  assert.equal(kg(ivy9.neededQty), "81.1125", "8.75 kg × 9 × 1.03 = 81.1125 kg, exactly as his sheet says");
  assert.equal(kg(ivy9.heldAtFactoryQty), "43", "43 kg at the factory");
  assert.equal(kg(ivy9.heldTotalQty), "43", "and nothing in Sato's own store");
  assert.equal(kg(ivy9.minToDeliverQty), "38.1125", "so the minimum to deliver is 38.1125 kg");
  assert.equal(kg(ivy9.toBuyQty), "38.1125", "and he owns none of it anywhere else, so that is also the buy");

  const sorbitol9 = resolveMaterialRequirement(SORBITOL, runsMode);
  assert.equal(kg(sorbitol9.neededQty), "4635", "500 kg × 9 × 1.03 = 4,635 kg");
  assert.equal(kg(sorbitol9.minToDeliverQty), "4336", "4,635 − 299 held = 4,336 kg to deliver");

  const carton9 = resolveMaterialRequirement(CARTON, runsMode);
  assert.equal(formatQty(carton9.neededQty), "115875", "12,500 × 9 × 1.03 = 115,875 cartons");
  assert.equal(formatQty(carton9.minToDeliverQty), "102025", "115,875 − 13,850 held = 102,025");

  const sticker9 = resolveMaterialRequirement(STICKER, runsMode);
  assert.equal(formatQty(sticker9.neededQty), "115875");
  assert.equal(formatQty(sticker9.minToDeliverQty), "50025", "115,875 − 65,850 held = 50,025 stickers");

  // ── "I will deliver 50 kg — what will be LEFT after the nine batches?" ─────────────────────────
  const ivy9WithHisDecision = resolveMaterialRequirement(
    { ...IVY, willSendQty: parseQty("50000") }, // 50 kg
    runsMode,
  );
  assert.equal(
    kg(ivy9WithHisDecision.balanceAfterQty),
    "11.8875",
    "43 held + 50 sent − 81.1125 consumed = 11.8875 kg left at the factory, which is the number he asked for",
  );
  assert.equal(
    formatExactRuns(ivy9WithHisDecision.balanceAfterRunsMicro ?? BigInt(0)),
    "1.319001",
    "and that remainder covers 1.319001 of a run (11.8875 over the 9.0125 kg one run takes), which is what the figure MEANS",
  );

  // A negative balance is reported as negative. Hiding a short run behind max(0, …) is the one
  // failure this column exists to prevent.
  const ivyShort = resolveMaterialRequirement({ ...IVY, willSendQty: parseQty("10000") }, runsMode);
  assert.ok(ivyShort.balanceAfterQty < BigInt(0), "sending only 10 kg leaves the run SHORT, and it says so");
  assert.equal(kg(ivyShort.balanceAfterQty), "-28.1125");

  // Two locations: material in Sato's own store is owned just as much as material at the factory.
  const ivySplit = resolveMaterialRequirement(
    {
      ...IVY,
      heldByLocationId: new Map([
        [EGPI, parseQty("50000")],
        [SATO_STORE, parseQty("50000")],
      ]),
    },
    runsMode,
  );
  assert.equal(kg(ivySplit.heldTotalQty), "100", "50 kg at the factory and 50 in his own store is 100 kg owned");
  assert.equal(kg(ivySplit.toBuyQty), "0", "so there is nothing to buy");
  assert.equal(kg(ivySplit.minToDeliverQty), "31.1125", "but 31.1125 kg still has to travel to the factory");

  // ── An unsettled material contributes NOTHING to a buy list ───────────────────────────────────
  const sorbate9 = resolveMaterialRequirement(POTASSIUM_SORBATE, runsMode);
  assert.equal(
    kg(sorbate9.neededQty),
    "15.52725",
    "0.0067 g × 2,250,000 × 1.03 reads 15.52725 kg — in doubles this prints 15.527250000000002",
  );
  assert.equal(sorbate9.contributesToBuyList, false, "nobody has settled who brings it");
  assert.equal(sorbate9.excludedReason, "supplier_unsettled");
  assert.equal(sorbate9.toBuyQty, BigInt(0), "so it is shown and never bought");
  assert.equal(sorbate9.minToDeliverQty, BigInt(0), "and never delivered");

  // A material the FACTORY brings is shown and never bought either.
  const factoryBottle = resolveMaterialRequirement(
    material({
      code: "BOTTLE",
      unitKind: "count",
      basePerDisplayMicro: PIECE,
      basis: "per_packaging_set",
      qtyPerBasis: parseQty("1"),
      supplier: "factory",
    }),
    runsMode,
  );
  assert.equal(formatQty(factoryBottle.neededQty), "115875", "the requirement is still shown");
  assert.equal(factoryBottle.contributesToBuyList, false);
  assert.equal(factoryBottle.excludedReason, "factory_supplies");
  assert.equal(factoryBottle.toBuyQty, BigInt(0), "EGPI's own bottles are not his to buy");

  // No composition entered is a GAP, not a zero requirement.
  const noComposition = resolveMaterialRequirement(material({ code: "XANTHAN_GUM", qtyPerBasis: null }), runsMode);
  assert.equal(noComposition.excludedReason, "no_composition");
  assert.equal(noComposition.coverRunsMicro, null, "there is nothing to divide by, so cover is unknown, not zero");

  // ── A count is whole, and a purchase respects the supplier's own minimum ──────────────────────
  const oddCount = resolveMaterialRequirement(
    material({
      code: "CARTON_ODD",
      unitKind: "count",
      basePerDisplayMicro: PIECE,
      basis: "per_packaging_set",
      qtyPerBasis: parseQty("1"),
      overagePctScaled: parsePct("3.33"),
    }),
    runsMode,
  );
  assert.equal(oddCount.neededQty % QTY_SCALE, BigInt(0), "there is no such thing as 0.4 of a carton");
  assert.equal(
    roundQtyUpToPurchasable(parseQty("102025"), "count", {
      minOrderQty: parseQty("50000"),
      purchaseIncrement: parseQty("25000"),
    }),
    parseQty("125000"),
    "102,025 cartons on 25,000-piece pallets is 125,000",
  );
  assert.equal(
    roundQtyUpToPurchasable(parseQty("10"), "count", { minOrderQty: parseQty("50000"), purchaseIncrement: null }),
    parseQty("50000"),
    "and a minimum order is a minimum",
  );
  assert.equal(roundQtyUpToPurchasable(BigInt(0), "count", { minOrderQty: parseQty("50000") }), BigInt(0), "but nothing needed buys nothing");

  // ── The BigInt boundary: a quantity that skipped ::text is refused, not rounded ────────────────
  assert.equal(formatQty(parseQty("43000.000000")), "43000", "a numeric round-trips with its zeros trimmed");
  assert.equal(formatQty(parseQty("15.527250")), "15.52725");
  assert.equal(parseQty("0.0067"), BigInt(6_700), "0.0067 g is 6,700 micro grams, exactly");
  assert.throws(
    () => parseQty("1.0000001"),
    (error: unknown) => error instanceof ProductionPlanningInputError,
    "a seventh decimal place is refused rather than silently rounded to the column's precision",
  );
  assert.throws(
    () => parseQty(1e15),
    (error: unknown) => error instanceof ProductionPlanningInputError,
    "a number too large to carry six decimals is evidence the ::text cast was skipped",
  );
  assert.equal(
    applyOverage(parseQty("112500"), parsePct("3"), "count"),
    parseQty("115875"),
    "112,500 at 3% is exactly 115,875 — no ceil off-by-one to work around",
  );

  // ── The learner: one run is not a measurement ─────────────────────────────────────────────────
  const oneRunObserved = learnFromRuns([
    {
      runId: "run-1",
      materialId: IVY.materialId,
      consumedQty: parseQty("9000"),
      theoreticalQty: parseQty("8750"),
      runsCount: BigInt(1),
      isExcludedFromLearning: false,
    },
  ]);
  const afterOne = oneRunObserved.get(IVY.materialId);
  assert.ok(afterOne, "the observation is recorded");
  assert.equal(afterOne?.recommendedOveragePctScaled, null, "but one run recommends nothing");
  assert.equal(afterOne?.withheldReason, "not_enough_runs");
  assert.equal(afterOne?.impliedOveragePctScaled, parsePct("2.8571"), "while still reporting what it saw");

  const twoRunsObserved = learnFromRuns([
    {
      runId: "run-1",
      materialId: IVY.materialId,
      consumedQty: parseQty("9000"),
      theoreticalQty: parseQty("8750"),
      runsCount: BigInt(1),
      isExcludedFromLearning: false,
    },
    {
      runId: "run-2",
      materialId: IVY.materialId,
      consumedQty: parseQty("9100"),
      theoreticalQty: parseQty("8750"),
      runsCount: BigInt(1),
      isExcludedFromLearning: false,
    },
  ]);
  const afterTwo = twoRunsObserved.get(IVY.materialId);
  assert.equal(afterTwo?.runsCounted, BigInt(2));
  assert.equal(
    afterTwo?.recommendedOveragePctScaled,
    parsePct("3.4286"),
    "18,100 consumed against 17,500 predicted is a measured 3.4286%",
  );
  assert.equal(
    resolveOverage(null, afterTwo, parsePct("3")).source,
    "measured",
    "and the measurement replaces the 3% guess",
  );
  assert.equal(
    resolveOverage(parsePct("5"), afterTwo, parsePct("3")).pctScaled,
    parsePct("5"),
    "a figure a human typed against the material still wins, because somebody decided it",
  );
  assert.equal(resolveOverage(null, undefined, parsePct("3")).source, "default");

  // A factory that used LESS than predicted is reported, and never recommended as a negative overage.
  const underConsumed = learnFromRuns([
    { runId: "a", materialId: "m", consumedQty: parseQty("8000"), theoreticalQty: parseQty("8750"), runsCount: BigInt(1), isExcludedFromLearning: false },
    { runId: "b", materialId: "m", consumedQty: parseQty("8100"), theoreticalQty: parseQty("8750"), runsCount: BigInt(1), isExcludedFromLearning: false },
  ]).get("m");
  assert.ok((underConsumed?.impliedOveragePctScaled ?? BigInt(0)) < BigInt(0), "the under-consumption is reported as negative");
  assert.equal(underConsumed?.recommendedOveragePctScaled, BigInt(0), "but it is never recommended below zero");

  // An excluded run leaves the model without being deleted.
  const excluded = learnFromRuns([
    {
      runId: "run-bad",
      materialId: IVY.materialId,
      consumedQty: parseQty("900000"),
      theoreticalQty: parseQty("8750"),
      runsCount: BigInt(1),
      isExcludedFromLearning: true,
    },
  ]);
  assert.equal(excluded.size, 0, "a mistyped run changes nothing, and its row still exists in the database");

  // ── Costing: one stored currency, the other derived, and nothing faked when the rate is gone ──
  const rate = resolveEffectiveFxRate(
    { rateDate: "2026-10-05", fetchedUsdToEgp: parseQty("48.5"), fetchOk: true, manualUsdToEgp: null },
    null,
  );
  assert.equal(rate.source, "fetched");
  const ivyCost = costQuantity(parseQty("72100"), KG, { currency: "USD", pricePerDisplayUnit: parseQty("12.5"), effectiveFrom: "2026-01-01" }, rate);
  assert.equal(formatMoney(ivyCost.usdScaled ?? BigInt(0)), "901.25", "72.1 kg at $12.50 a kilogram is $901.25");
  assert.equal(formatMoney(ivyCost.egpScaled ?? BigInt(0)), "43710.63", "and at 48.5 that is 43,710.63 EGP");
  assert.equal(ivyCost.derivedMissing, false);

  const manualWins = resolveEffectiveFxRate(
    { rateDate: "2026-10-05", fetchedUsdToEgp: parseQty("48.5"), fetchOk: true, manualUsdToEgp: parseQty("50") },
    null,
  );
  assert.equal(manualWins.source, "manual", "a rate he typed beats the fetched one");
  assert.equal(manualWins.usdToEgpMicro, parseQty("50"));

  const failedFetch = resolveEffectiveFxRate(
    { rateDate: "2026-10-05", fetchedUsdToEgp: null, fetchOk: false, manualUsdToEgp: null },
    null,
  );
  assert.equal(failedFetch.usdToEgpMicro, null, "a failed fetch has no rate");
  assert.equal(failedFetch.source, "none");
  const uncostable = costQuantity(parseQty("72100"), KG, { currency: "USD", pricePerDisplayUnit: parseQty("12.5"), effectiveFrom: "2026-01-01" }, failedFetch);
  assert.equal(uncostable.egpScaled, null, "so the derived currency is MISSING, which is not the same as zero");
  assert.equal(uncostable.derivedMissing, true);

  const totals = totalCosts([
    { cost: ivyCost, contributesToBuyList: true },
    { cost: null, contributesToBuyList: true },
    { cost: ivyCost, contributesToBuyList: false },
  ]);
  assert.equal(formatMoney(totals.usdScaled), "901.25", "an unpriced material adds nothing");
  assert.equal(totals.unpricedMaterials, 1, "and the total says one material had no price");
  assert.equal(formatMoney(BigInt(0)), "0.00");
  assert.equal(formatMoney(BigInt(19_9996)), "20.00", "a fraction that rounds up carries into the whole part");

  // ── The alarm: only what we buy, and fail-safe arming ─────────────────────────────────────────
  const almostEmpty = resolveMaterialRequirement(
    { ...IVY, heldByLocationId: new Map([[EGPI, parseQty("8000")]]) },
    runsMode,
  );
  const alarms = evaluateAlarms([almostEmpty, sorbate9, factoryBottle, noComposition], {
    defaultThresholdRunsMicro: thresholdRunsToMicro(BigInt(1)),
    thresholdByMaterialId: new Map(),
  });
  assert.equal(alarms.length, 1, "only the material WE bring, with a formula, can raise an alarm");
  assert.equal(alarms[0]?.code, "IVY_EXTRACT");
  assert.equal(alarms[0]?.severity, "below_threshold", "8 kg against 9.0125 kg a run is under one run of cover");
  assert.equal(alarms[0]?.leadTimeDays, 180, "and the email can say it takes six months to arrive");

  const empty = resolveMaterialRequirement({ ...IVY, heldByLocationId: new Map() }, runsMode);
  assert.equal(
    evaluateAlarms([empty], { defaultThresholdRunsMicro: thresholdRunsToMicro(BigInt(1)), thresholdByMaterialId: new Map() })[0]
      ?.severity,
    "out_of_stock",
  );

  // An imported material gets a warning band, because six months of lead time is already late.
  const comfortable = resolveMaterialRequirement(
    { ...IVY, heldByLocationId: new Map([[EGPI, parseQty("15000")]]) },
    runsMode,
  );
  assert.equal(
    evaluateAlarms([comfortable], { defaultThresholdRunsMicro: thresholdRunsToMicro(BigInt(1)), thresholdByMaterialId: new Map() })[0]
      ?.severity,
    "approaching",
  );
  const localComfortable = resolveMaterialRequirement(
    { ...SORBITOL, heldByLocationId: new Map([[EGPI, parseQty("800000")]]) }, // 800 kg against 515 kg a run
    runsMode,
  );
  assert.equal(
    evaluateAlarms([localComfortable], {
      defaultThresholdRunsMicro: thresholdRunsToMicro(BigInt(1)),
      thresholdByMaterialId: new Map(),
    }).length,
    0,
    "for a local material, well over the threshold is simply enough",
  );

  assert.deepEqual(resolveAlarmArming(null), { enabled: false, dryRun: true }, "no settings row sends nothing");
  assert.deepEqual(resolveAlarmArming({}), { enabled: false, dryRun: true }, "nor does a row with nothing set");
  assert.deepEqual(
    resolveAlarmArming({ alarm_enabled: "true", alarm_dry_run: "false" }),
    { enabled: false, dryRun: true },
    "a STRING 'true' is not an arming — only an explicit boolean arms it",
  );
  assert.deepEqual(resolveAlarmArming({ alarm_enabled: true, alarm_dry_run: false }), { enabled: true, dryRun: false });
  assert.deepEqual(resolveFxArming(null), { enabled: false, dryRun: true }, "the FX pair is independent and equally fail-safe");

  // ── Ordering and summary: what he must act on comes first ─────────────────────────────────────
  const rows = [sorbate9, factoryBottle, ivyShort, carton9, noComposition];
  const sorted = sortRequirements(rows);
  assert.equal(sorted[0]?.code, "IVY_EXTRACT", "the short one leads");
  assert.equal(sorted[1]?.code, "CARTON", "then what has to be bought");
  assert.equal(sorted.at(-1)?.code, "XANTHAN_GUM", "and a material with no formula is last");

  const summary = summariseRequirements(rows);
  assert.equal(summary.materials, 5);
  assert.equal(summary.unsettled, 1);
  assert.equal(summary.factorySupplied, 1);
  assert.equal(summary.withoutComposition, 1);
  assert.equal(summary.shortAfterRunCount, 1);

  // ── The migration and the engine agree about the geometry ─────────────────────────────────────
  const migration = readFileSync(MIGRATION, "utf8");
  assert.ok(
    migration.includes("1250000, 5, 100, 40, true, 1"),
    `${MIGRATION} must seed Ivyronc with the run geometry this test pins`,
  );
  for (const guard of [
    "prodplan_products_run_volume_dose_check",
    "prodplan_products_good_unit_dose_check",
    "prodplan_products_sample_unit_dose_check",
  ]) {
    assert.ok(migration.includes(guard), `${guard} is what keeps run rounding in integer arithmetic`);
  }
  assert.ok(
    migration.includes("prodplan_plan_lines_supplier_check"),
    "a committed plan line must refuse shared_unsettled in the database, not only in the engine",
  );
  assert.ok(
    migration.includes("generated always as (opening_qty + delivered_qty - closing_qty) stored"),
    "consumed_qty must be generated so it cannot drift from its own inputs",
  );
  assert.ok(
    migration.includes("alarm_enabled boolean not null default false") &&
      migration.includes("alarm_dry_run boolean not null default true") &&
      migration.includes("fx_fetch_enabled boolean not null default false") &&
      migration.includes("fx_fetch_dry_run boolean not null default true"),
    "all four arming flags ship OFF and in dry run",
  );
}
