/**
 * Production Planner — run geometry. The one piece of arithmetic every other figure hangs off.
 *
 * ── The owner's rule, in his own words (2026-10-05) ──────────────────────────────────────────────
 *
 * "حجم التشغيلة ثابت" — the run volume is FIXED. One Ivyronc run is 1,250 litres whatever is asked
 * for. And: "لما بطلب منه عينات هو بيعمل العينات دي من التوتال فوليوم فهيقلل عدد الازايز" — when he
 * asks for free medical samples, the factory makes them OUT OF that same volume, so they reduce the
 * number of 100 ml bottles.
 *
 * Two consequences that are easy to get backwards, and both of them matter to the money:
 *
 *   1. A sample does NOT add volume. 10,000 samples of 40 ml inside one 1,250 L run leave
 *      (1,250,000 − 400,000) / 100 = 8,500 good bottles instead of 12,500.
 *   2. A sample DOES take a full packaging set — a bottle, a cap, a carton and a sticker — even
 *      though it holds 40 ml rather than 100. So samples RAISE packaging consumption: that same run
 *      consumes 18,500 sets, not 12,500.
 *
 * And the headline number he types is the TOTAL: "ما فيش حاجه زي اللي انا قلت لك كده انا عايز 100
 * الف و10000 لا هو 100 الف اقول لك 100 الف وعايز 10000 فده معناه انك هتديني 90 و100" — asking for
 * 100,000 with 10,000 samples means 90,000 good units and 10,000 samples, not 110,000 boxes.
 *
 * Runs are whole. The planner therefore rounds the run count UP and reports the real yield and the
 * surplus over what was asked, rather than quietly answering a different question from the one it
 * was asked. A planner asked for 150,000 that silently answers for 151,284 is the single worst way
 * to be wrong here, because every number below it is right.
 */
import { ceilDiv, ProductionPlanningInputError, QTY_SCALE, type PlanRequestMode } from "./rules";

/** The fixed geometry of one run, straight off the `prodplan_products` row. */
export type RunGeometry = {
  /** The FIXED volume of one run, in millilitres. */
  readonly runVolumeMl: bigint;
  /** One dose, in millilitres — 5 ml for a syrup. */
  readonly doseMl: bigint;
  /** A saleable bottle, in millilitres. */
  readonly goodUnitMl: bigint;
  /** A free medical sample, in millilitres. */
  readonly sampleUnitMl: bigint;
  /** False only for a product the factory can make a partial run of. */
  readonly wholeRunsOnly: boolean;
  /** Bottles in one box as the owner counts them. 1 for Ivyronc. */
  readonly unitsPerBox: bigint;
  /**
   * True when one sample is a whole box of its own holding `sampleUnitMl` of product. Saginkgo's is a
   * box with one strip of five capsules (owner, 2026-11-03). Absent or false counts a sample as one
   * more saleable unit, which at 30 to a box would make it a thirtieth of a box.
   */
  readonly sampleInOwnBox?: boolean;
};

export type PlanRequest = {
  readonly mode: PlanRequestMode;
  /** Read through `mode`: total boxes (his usual), good units only, or a run count. */
  readonly requestedQty: bigint;
  /** Free medical samples wanted, as a TOTAL across the whole order. */
  readonly sampleUnits: bigint;
};

/** What a given number of runs actually yields. */
export type RunYield = {
  readonly runs: bigint;
  readonly goodUnits: bigint;
  readonly sampleUnits: bigint;
  /** Good units plus samples: every unit that consumes a bottle, cap, carton and sticker. */
  readonly packagingSets: bigint;
  /** Boxes delivered, as the owner counts boxes. */
  readonly totalBoxes: bigint;
  /** What a `per_box` material counts: `totalBoxes`, less the samples when they wear their own box. */
  readonly perBoxCount: bigint;
  readonly totalVolumeMl: bigint;
  readonly totalDoses: bigint;
  /** Volume that fills neither a bottle nor a sample. Normally zero; never silently dropped. */
  readonly leftoverMl: bigint;
};

export type RunGeometryResult = RunYield & {
  /** What the ask came to in boxes, so the surplus or shortfall is against his own number. */
  readonly requestedBoxes: bigint;
  /** Boxes over the ask. Zero when the ask lands exactly on a run boundary. */
  readonly surplusBoxes: bigint;
  /** True when the run count was rounded up and the answer is therefore bigger than the ask. */
  readonly rounded: boolean;
  /** The exact run requirement before rounding, in micro-runs — 7.52 runs is 7_520_000n. */
  readonly exactRunsMicro: bigint;
  /**
   * One run fewer, and what it would leave short. Offered because undershooting is sometimes the
   * right call and that is the owner's to make, not the planner's.
   */
  readonly oneRunFewer: (RunYield & { readonly shortfallBoxes: bigint }) | null;
};

function requirePositive(value: bigint, field: string, label: string): bigint {
  if (value <= BigInt(0)) throw new ProductionPlanningInputError(`${label} must be more than zero.`, field);
  return value;
}

/** Doses in one run. Exact, because the migration CHECKs that run volume is a whole dose multiple. */
export function dosesPerRun(geometry: RunGeometry): bigint {
  return geometry.runVolumeMl / geometry.doseMl;
}

/** Bottles in one run when no samples are taken out of it. */
export function goodUnitsPerRunWithoutSamples(geometry: RunGeometry): bigint {
  return geometry.runVolumeMl / geometry.goodUnitMl;
}

/** How a good-unit count and a sample count become sets and boxes. */
function packingFor(
  geometry: RunGeometry,
  goodUnits: bigint,
  sampleUnits: bigint,
): Pick<RunYield, "packagingSets" | "perBoxCount" | "totalBoxes"> {
  if (geometry.sampleInOwnBox) {
    // Saginkgo: 100 samples are 100 boxes of five, and the 500 capsules in them are still capsules, so
    // the set count stays in the saleable unit the tile prints it in.
    const saleableBoxes = ceilDiv(goodUnits, geometry.unitsPerBox);
    return {
      packagingSets: goodUnits + (sampleUnits * geometry.sampleUnitMl) / geometry.goodUnitMl,
      perBoxCount: saleableBoxes,
      totalBoxes: saleableBoxes + sampleUnits,
    };
  }
  const packagingSets = goodUnits + sampleUnits;
  // ROUNDED UP: a part-box is still a box (owner, 2026-10-24, "Round up to a box"). Guamusin's
  // 40,000 sachets are 3,334 cartons of twelve, not 3,333 with four sachets silently dropped — and
  // `per_box` materials (the carton, the film) read this count, so flooring it under-ordered them.
  const totalBoxes = ceilDiv(packagingSets, geometry.unitsPerBox);
  return { packagingSets, perBoxCount: totalBoxes, totalBoxes };
}

/**
 * What `runs` runs yield once `sampleUnits` samples have been taken out of the same volume.
 *
 * `leftoverMl` is the volume that fills neither a bottle nor a sample. It is normally zero — for
 * Ivyronc it is zero whenever the sample count is a multiple of five — and it is returned rather
 * than dropped so a planner can never quietly lose syrup it was asked about.
 */
export function yieldForRuns(geometry: RunGeometry, runs: bigint, sampleUnits: bigint): RunYield {
  if (runs < BigInt(0)) throw new ProductionPlanningInputError("A run count cannot be negative.", "runs");
  if (sampleUnits < BigInt(0)) throw new ProductionPlanningInputError("A sample count cannot be negative.", "sampleUnits");

  const totalVolumeMl = runs * geometry.runVolumeMl;
  const sampleVolumeMl = sampleUnits * geometry.sampleUnitMl;
  if (sampleVolumeMl > totalVolumeMl) {
    throw new ProductionPlanningInputError(
      `${sampleUnits} samples need more syrup than ${runs} run(s) make. Raise the run count or lower the samples.`,
      "sampleUnits",
    );
  }

  const volumeForGoodUnits = totalVolumeMl - sampleVolumeMl;
  const goodUnits = volumeForGoodUnits / geometry.goodUnitMl;
  const leftoverMl = volumeForGoodUnits % geometry.goodUnitMl;

  return {
    runs,
    goodUnits,
    sampleUnits,
    ...packingFor(geometry, goodUnits, sampleUnits),
    totalVolumeMl,
    totalDoses: totalVolumeMl / geometry.doseMl,
    leftoverMl,
  };
}

/**
 * The smallest whole number of runs that satisfies the ask.
 *
 * The requirement in volume is `goodUnits × goodUnitMl + samples × sampleUnitMl`, and the run count
 * is that over the fixed run volume, rounded up. Worked example, which `tests/production-planning`
 * pins: 100,000 total boxes with 10,000 samples is 90,000 good units, so
 * (90,000 × 100 + 10,000 × 40) / 1,250,000 = 7.52 runs → 8 runs → 96,000 good units and 10,000
 * samples = 106,000 boxes, 6,000 over the ask.
 */
export function resolveRunGeometry(geometry: RunGeometry, request: PlanRequest): RunGeometryResult {
  requirePositive(geometry.runVolumeMl, "run_volume_ml", "The run volume");
  requirePositive(geometry.doseMl, "dose_ml", "The dose");
  requirePositive(geometry.goodUnitMl, "good_unit_ml", "The bottle size");
  requirePositive(geometry.sampleUnitMl, "sample_unit_ml", "The sample size");
  requirePositive(geometry.unitsPerBox, "units_per_box", "Units per box");
  if (request.requestedQty <= BigInt(0)) {
    throw new ProductionPlanningInputError("Ask for more than nothing.", "requestedQty");
  }
  if (request.sampleUnits < BigInt(0)) {
    throw new ProductionPlanningInputError("A sample count cannot be negative.", "sampleUnits");
  }

  const samples = request.sampleUnits;

  // Mode `runs`: he named the run count himself, so there is nothing to round and no surplus to
  // report — whatever it yields is the answer.
  if (request.mode === "runs") {
    const result = yieldForRuns(geometry, request.requestedQty, samples);
    return {
      ...result,
      requestedBoxes: result.totalBoxes,
      surplusBoxes: BigInt(0),
      rounded: false,
      exactRunsMicro: request.requestedQty * QTY_SCALE,
      oneRunFewer: null,
    };
  }

  // Both quantity modes reduce to a target in GOOD UNITS. `total_boxes` is his usual, and it is the
  // total: the samples come out of it, they are not added on top.
  let targetGoodUnits: bigint;
  if (request.mode === "good_units") {
    targetGoodUnits = request.requestedQty * geometry.unitsPerBox;
  } else {
    const targetSets = request.requestedQty * geometry.unitsPerBox;
    // A sample in its own box takes a whole box out of the total, not one unit of it.
    if (geometry.sampleInOwnBox ? samples > request.requestedQty : samples > targetSets) {
      throw new ProductionPlanningInputError(
        `${samples} samples do not fit inside an order of ${request.requestedQty} box(es). The samples come out of the total, not on top of it.`,
        "sampleUnits",
      );
    }
    targetGoodUnits = geometry.sampleInOwnBox
      ? (request.requestedQty - samples) * geometry.unitsPerBox
      : targetSets - samples;
  }

  const requiredVolumeMl = targetGoodUnits * geometry.goodUnitMl + samples * geometry.sampleUnitMl;
  const exactRunsMicro = ceilDiv(requiredVolumeMl * QTY_SCALE, geometry.runVolumeMl);
  const requestedBoxes = geometry.sampleInOwnBox
    ? targetGoodUnits / geometry.unitsPerBox + samples
    : (targetGoodUnits + samples) / geometry.unitsPerBox;

  if (!geometry.wholeRunsOnly) {
    // A product the factory will make a partial run of gets exactly what was asked for. Nothing is
    // rounded, so there is no surplus and no neighbour to offer.
    const totalDoses = requiredVolumeMl / geometry.doseMl;
    return {
      runs: ceilDiv(exactRunsMicro, QTY_SCALE),
      goodUnits: targetGoodUnits,
      sampleUnits: samples,
      ...packingFor(geometry, targetGoodUnits, samples),
      totalVolumeMl: requiredVolumeMl,
      totalDoses,
      leftoverMl: BigInt(0),
      requestedBoxes,
      surplusBoxes: BigInt(0),
      rounded: false,
      exactRunsMicro,
      oneRunFewer: null,
    };
  }

  const runs = ceilDiv(requiredVolumeMl, geometry.runVolumeMl);
  const result = yieldForRuns(geometry, runs, samples);

  let oneRunFewer: (RunYield & { shortfallBoxes: bigint }) | null = null;
  if (runs > BigInt(1)) {
    const fewerVolume = (runs - BigInt(1)) * geometry.runVolumeMl;
    // Only offerable when the samples themselves still fit in the smaller volume.
    if (samples * geometry.sampleUnitMl <= fewerVolume) {
      const fewer = yieldForRuns(geometry, runs - BigInt(1), samples);
      oneRunFewer = {
        ...fewer,
        shortfallBoxes: requestedBoxes > fewer.totalBoxes ? requestedBoxes - fewer.totalBoxes : BigInt(0),
      };
    }
  }

  return {
    ...result,
    requestedBoxes,
    surplusBoxes: result.totalBoxes > requestedBoxes ? result.totalBoxes - requestedBoxes : BigInt(0),
    rounded: exactRunsMicro % QTY_SCALE !== BigInt(0),
    exactRunsMicro,
    oneRunFewer,
  };
}

/** `7520000n` → `"7.52"`. What the sentence above the result table says the exact requirement was. */
export function formatExactRuns(exactRunsMicro: bigint): string {
  const whole = exactRunsMicro / QTY_SCALE;
  const fraction = (exactRunsMicro % QTY_SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
