/**
 * Production Planner — turning the 3% overage from a guess into a measurement.
 *
 * The 3% in the settings is a placeholder. The owner's instruction (2026-10-05) was that the module
 * should not keep asking him for it: "انت الاول هتخليني ادخل مدخلاتي... وبعد كده انت هتفهم استهلاكي
 * وهتفهم هتبروبوز بلان" — he types his inputs first, and then it learns his consumption and
 * proposes. So every run EGPI reports is recorded with its opening, delivered and closing balances,
 * and the gap between what was consumed and what the formula predicted IS the overage.
 *
 * Two deliberate refusals in here:
 *
 *   · One run is not a measurement. Below `MIN_RUNS_TO_LEARN` this file reports what it saw and
 *     recommends nothing, because replacing a conservative guess with a single observation is how a
 *     model becomes confidently wrong.
 *   · A NEGATIVE implied overage is reported as what it is and never recommended. The factory using
 *     less than the formula says is interesting; ordering less than the formula says on the strength
 *     of it is how a run stops halfway.
 */
import { FRACTION_SCALE, PCT_SCALE, roundDiv } from "./rules";

/**
 * Runs needed before a measured overage is offered as a recommendation. Two is not statistics; it
 * is the point at which a single mis-typed closing balance stops being the entire dataset.
 */
export const MIN_RUNS_TO_LEARN = 2;

/** One material's actuals from one recorded run, as `prodplan_run_materials` holds them. */
export type RunObservation = {
  readonly runId: string;
  readonly materialId: string;
  /** opening + delivered − closing, straight off the generated column. */
  readonly consumedQty: bigint;
  /** What the model said this run would take. Null for a run recorded before the model knew. */
  readonly theoreticalQty: bigint | null;
  /** Runs inside this record — EGPI reports nine batches in one message. */
  readonly runsCount: bigint;
  readonly isExcludedFromLearning: boolean;
};

export type MaterialLearning = {
  readonly materialId: string;
  /** Records counted, after exclusions. */
  readonly recordsCounted: number;
  /** Production runs those records cover. */
  readonly runsCounted: bigint;
  readonly consumedTotalQty: bigint;
  readonly theoreticalTotalQty: bigint;
  readonly consumedPerRunQty: bigint;
  /**
   * `(consumed − theoretical) / theoretical`, as a percentage in 1/10,000ths. SIGNED: a factory that
   * used less than the formula predicted reads negative, and that is a fact worth seeing.
   */
  readonly impliedOveragePctScaled: bigint | null;
  /**
   * What the planner should actually use. Null until there are enough runs, and never below zero.
   */
  readonly recommendedOveragePctScaled: bigint | null;
  /** Why there is no recommendation yet, in a form the screen can show. */
  readonly withheldReason: "not_enough_runs" | "no_theoretical_figure" | null;
};

/**
 * Fold every recorded run into one measured overage per material.
 *
 * Records are summed rather than averaged per run on purpose: a nine-batch report and a one-batch
 * report are not equal evidence, and summing weights each by the material it actually moved.
 */
export function learnFromRuns(observations: readonly RunObservation[]): Map<string, MaterialLearning> {
  const byMaterial = new Map<
    string,
    { records: number; runs: bigint; consumed: bigint; theoretical: bigint; sawTheoretical: boolean }
  >();

  for (const observation of observations) {
    if (observation.isExcludedFromLearning) continue;
    const bucket = byMaterial.get(observation.materialId) ?? {
      records: 0,
      runs: BigInt(0),
      consumed: BigInt(0),
      theoretical: BigInt(0),
      sawTheoretical: false,
    };
    bucket.records += 1;
    bucket.runs += observation.runsCount > BigInt(0) ? observation.runsCount : BigInt(1);
    bucket.consumed += observation.consumedQty;
    if (observation.theoreticalQty !== null && observation.theoreticalQty > BigInt(0)) {
      bucket.theoretical += observation.theoreticalQty;
      bucket.sawTheoretical = true;
    }
    byMaterial.set(observation.materialId, bucket);
  }

  const result = new Map<string, MaterialLearning>();
  for (const [materialId, bucket] of byMaterial) {
    const implied =
      bucket.sawTheoretical && bucket.theoretical > BigInt(0)
        ? roundDiv((bucket.consumed - bucket.theoretical) * FRACTION_SCALE, bucket.theoretical)
        : null;

    let recommended: bigint | null = null;
    let withheldReason: MaterialLearning["withheldReason"] = null;
    if (implied === null) {
      withheldReason = "no_theoretical_figure";
    } else if (bucket.runs < BigInt(MIN_RUNS_TO_LEARN)) {
      withheldReason = "not_enough_runs";
    } else {
      recommended = implied > BigInt(0) ? implied : BigInt(0);
    }

    result.set(materialId, {
      materialId,
      recordsCounted: bucket.records,
      runsCounted: bucket.runs,
      consumedTotalQty: bucket.consumed,
      theoreticalTotalQty: bucket.theoretical,
      consumedPerRunQty: bucket.runs > BigInt(0) ? bucket.consumed / bucket.runs : BigInt(0),
      impliedOveragePctScaled: implied,
      recommendedOveragePctScaled: recommended,
      withheldReason,
    });
  }
  return result;
}

/**
 * The overage the planner uses for one material, and where it came from.
 *
 * Order of precedence, and the reason for it: a figure a human typed against this material wins,
 * because somebody decided it; then the measurement, because it beats a guess; then the settings
 * default, because something has to cover the loss.
 */
export function resolveOverage(
  materialOverridePctScaled: bigint | null,
  learning: MaterialLearning | undefined,
  defaultPctScaled: bigint,
): { pctScaled: bigint; source: "measured" | "material" | "default" } {
  if (materialOverridePctScaled !== null) return { pctScaled: materialOverridePctScaled, source: "material" };
  const measured = learning?.recommendedOveragePctScaled ?? null;
  if (measured !== null) return { pctScaled: measured, source: "measured" };
  return { pctScaled: defaultPctScaled, source: "default" };
}

/** `30000n` → `"3"`, for the chip beside a requirement that says where its overage came from. */
export function formatOveragePct(scaled: bigint): string {
  const negative = scaled < BigInt(0);
  const magnitude = negative ? -scaled : scaled;
  const whole = magnitude / PCT_SCALE;
  const fraction = (magnitude % PCT_SCALE).toString().padStart(4, "0").replace(/0+$/, "");
  const text = fraction ? `${whole}.${fraction}` : whole.toString();
  return negative ? `-${text}` : text;
}
