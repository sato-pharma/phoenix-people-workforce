/**
 * Production Planner — the EXECUTION phase: what the factory actually produced.
 *
 * ── The owner's instruction, 2026-11-24 ──────────────────────────────────────────────────────────
 *
 * "We used to enter the quantities for planning. Now I want to be able to add units executed, units
 * already produced … تم انتاج ٢٢١٣٠ علبه ساجنكو و٦٩٨٥ عينه عايزه اشوف ادخلهم فين علشان يديني الستوك
 * وخليه ما يحسبش نسبة هادر. بعد كام يوم حاجيب الرصيد من المصنع ونبقى نحسب كمية الهادر ساعتها يحسب على
 * الactual only … I want to be in full control to either plan, either execute."
 *
 * So an execution is two steps, and this file is the arithmetic of both:
 *
 *   1. RECORD WHAT WAS PRODUCED. The boxes and samples he types are turned into doses, strips and
 *      boxes by the product's own geometry, and each Sato material comes off stock at its NET formula
 *      quantity — no overage, no measured loss, because the waste is not known yet. The factory's
 *      store is drawn on first, soonest expiry first, then Sato's own stores. What no recorded lot
 *      holds is reported as UNRECORDED, never written as a negative balance: the run happened, so
 *      the material existed — the records were short.
 *   2. RECORD THE FACTORY'S BALANCE, days later. Consumed = opening + delivered − the factory's own
 *      closing figure; the waste is consumed − formula, on the actual only. Only a balanced run
 *      teaches the overage learner.
 *
 * Pure: no database, so `tests/production-planning-execution.test.ts` runs every line of it.
 */
import { basisCountFor } from "./requirements";
import { packingForUnits, type RunGeometry, type RunGeometryResult } from "./geometry";
import {
  ceilDiv,
  FRACTION_SCALE,
  ProductionPlanningInputError,
  QTY_SCALE,
  roundDiv,
  roundQtyUpForUnit,
  type CompositionBasis,
  type UnitKind,
} from "./rules";

/** The three stages a recorded run can be in. The table's CHECK spells the same three. */
export const RUN_STAGES = ["awaiting_balance", "balanced", "cancelled"] as const;
export type RunStage = (typeof RUN_STAGES)[number];

export function coerceRunStage(value: unknown): RunStage {
  return (RUN_STAGES as readonly unknown[]).includes(value) ? (value as RunStage) : "balanced";
}

/** Only a run whose closing balance came from the factory is a measurement of waste. */
export function runTeachesTheLearner(stage: RunStage): boolean {
  return stage === "balanced";
}

/**
 * What a produced count comes to, in every basis a formula line can be counted against.
 *
 * Shaped as a `RunGeometryResult` so `basisCountFor` — the planner's own function — counts it, and
 * the execution can never disagree with the plan about what "per strip" means. `runs` is the exact
 * batch count rounded UP and `exactRunsMicro` the figure itself (23.294167 for the owner's 22,130
 * Saginkgo boxes and 6,985 samples), because a produced count is not a whole number of batches.
 */
export function executedYield(
  geometry: RunGeometry,
  produced: { readonly saleableBoxes: bigint; readonly sampleUnits: bigint },
): RunGeometryResult {
  const { saleableBoxes, sampleUnits } = produced;
  if (saleableBoxes < BigInt(0) || sampleUnits < BigInt(0)) {
    throw new ProductionPlanningInputError("A produced count cannot be negative.", "saleableBoxes");
  }
  if (saleableBoxes === BigInt(0) && sampleUnits === BigInt(0)) {
    throw new ProductionPlanningInputError("Nothing produced is nothing to record.", "saleableBoxes");
  }
  const goodUnits = saleableBoxes * geometry.unitsPerBox;
  const totalVolumeMl = goodUnits * geometry.goodUnitMl + sampleUnits * geometry.sampleUnitMl;
  const exactRunsMicro = ceilDiv(totalVolumeMl * QTY_SCALE, geometry.runVolumeMl);
  return {
    runs: ceilDiv(exactRunsMicro, QTY_SCALE),
    goodUnits,
    sampleUnits,
    ...packingForUnits(geometry, goodUnits, sampleUnits),
    totalVolumeMl,
    // Rounded UP: a part-dose of powder still came out of the drum.
    totalDoses: ceilDiv(totalVolumeMl, geometry.doseMl),
    leftoverMl: BigInt(0),
    requestedBoxes: BigInt(0),
    surplusBoxes: BigInt(0),
    rounded: false,
    exactRunsMicro,
    oneRunFewer: null,
  };
}

/**
 * The NET formula quantity for a produced count, in micro base units — no overage, by his word
 * ("خليه ما يحسبش نسبة هادر"). A count material is rounded up to a whole piece.
 */
export function netFormulaQty(
  line: { readonly basis: CompositionBasis; readonly qtyPerBasis: bigint; readonly unitKind: UnitKind },
  produced: RunGeometryResult,
): bigint {
  return roundQtyUpForUnit(line.qtyPerBasis * basisCountFor(line.basis, produced), line.unitKind);
}

/** One live lot a deduction can draw on. */
export type DeductibleLot = {
  readonly locationId: string;
  readonly expiryDate: string | null;
  readonly qty: bigint;
  readonly asOfDate: string;
};

export type LotTake = {
  readonly lot: DeductibleLot;
  /** What this deduction takes off the lot. */
  readonly take: bigint;
  /** The lot's balance after it — what the new stock row stores. */
  readonly remaining: bigint;
  readonly atFactory: boolean;
};

export type DeductionPlan = {
  readonly takes: readonly LotTake[];
  readonly fromFactory: bigint;
  readonly fromSatoStores: bigint;
  /** What the formula needed beyond every recorded lot. Never written as a negative balance. */
  readonly unrecorded: bigint;
  readonly heldAtFactoryBefore: bigint;
  readonly heldElsewhereBefore: bigint;
};

/** Soonest expiry first, undated (packaging) last — the lot that dies first is the one used first. */
function byExpiry(a: { readonly expiryDate: string | null }, b: { readonly expiryDate: string | null }): number {
  if (a.expiryDate === b.expiryDate) return 0;
  if (a.expiryDate === null) return 1;
  if (b.expiryDate === null) return -1;
  return a.expiryDate < b.expiryDate ? -1 : 1;
}

/**
 * Which lots a production deduction comes off, and how much from each.
 *
 * The factory's store first — the run consumed what was AT the factory — then Sato's own stores,
 * each soonest expiry first. A lot at zero is skipped, never written again.
 */
export function planDeduction(args: {
  readonly lots: readonly DeductibleLot[];
  readonly factoryLocationId: string | null;
  readonly needQty: bigint;
}): DeductionPlan {
  const atFactory = (lot: DeductibleLot) => args.factoryLocationId !== null && lot.locationId === args.factoryLocationId;
  const factoryLots = args.lots.filter(atFactory).sort(byExpiry);
  const otherLots = args.lots.filter((lot) => !atFactory(lot)).sort(byExpiry);

  let left = args.needQty > BigInt(0) ? args.needQty : BigInt(0);
  let fromFactory = BigInt(0);
  let fromSatoStores = BigInt(0);
  const takes: LotTake[] = [];
  for (const lot of [...factoryLots, ...otherLots]) {
    if (left <= BigInt(0)) break;
    if (lot.qty <= BigInt(0)) continue;
    const take = lot.qty < left ? lot.qty : left;
    left -= take;
    const isFactory = atFactory(lot);
    if (isFactory) fromFactory += take;
    else fromSatoStores += take;
    takes.push({ lot, take, remaining: lot.qty - take, atFactory: isFactory });
  }

  const sum = (lots: readonly DeductibleLot[]) => lots.reduce((total, lot) => total + lot.qty, BigInt(0));
  return {
    takes,
    fromFactory,
    fromSatoStores,
    unrecorded: left,
    heldAtFactoryBefore: sum(factoryLots),
    heldElsewhereBefore: sum(otherLots),
  };
}

/**
 * The date a deduction row carries: the production date, or the lot's own newer report date.
 *
 * The load reads the newest `as_of_date` first, so a row dated behind the report it replaces would
 * lose to it and the deduction would silently not happen — `moveStockRows` takes the same care.
 */
export function deductionRowDate(producedOn: string, lot: DeductibleLot): string {
  return lot.asOfDate > producedOn ? lot.asOfDate : producedOn;
}

/** The factory's lots as they stand after the deduction, for spreading its reported balance. */
export type FactoryLotStanding = {
  readonly expiryDate: string | null;
  readonly qty: bigint;
  readonly asOfDate: string;
};

/**
 * Spread ONE reported factory balance over the factory's lots of that material.
 *
 * The factory reports one figure per material. What is left is taken to be the LATEST-expiring
 * stock, because the run drew the soonest-expiring first — so the figure fills the latest lot up to
 * what it held, then the next, and any excess over what the records held goes on the latest lot. A
 * lot the figure does not reach is closed at zero. With no lot at the factory at all, the figure
 * opens one on `fallbackExpiryDate` (the lot the run drew from, else undated).
 */
export function spreadFactoryBalance(args: {
  readonly lots: readonly FactoryLotStanding[];
  readonly reportedQty: bigint;
  readonly fallbackExpiryDate: string | null;
}): { readonly expiryDate: string | null; readonly qty: bigint }[] {
  if (args.reportedQty < BigInt(0)) throw new ProductionPlanningInputError("A balance cannot be negative.", "closingQty");
  if (args.lots.length === 0) return [{ expiryDate: args.fallbackExpiryDate, qty: args.reportedQty }];

  // Latest expiry first; undated counts as the latest of all.
  const ordered = [...args.lots].sort((a, b) => -byExpiry(a, b));
  const out = ordered.map((lot) => ({ expiryDate: lot.expiryDate, qty: BigInt(0) }));
  let left = args.reportedQty;
  ordered.forEach((lot, index) => {
    if (left <= BigInt(0)) return;
    const put = lot.qty < left ? lot.qty : left;
    out[index] = { expiryDate: lot.expiryDate, qty: put };
    left -= put;
  });
  if (left > BigInt(0)) out[0] = { expiryDate: out[0].expiryDate, qty: out[0].qty + left };
  return out;
}

export type MeasuredWaste = {
  readonly consumedQty: bigint;
  /** consumed − formula. SIGNED: a factory that used less than the formula reads negative. */
  readonly wasteQty: bigint;
  /** waste ÷ formula, in 1/10,000ths of a percent. Null when there is no formula to divide by. */
  readonly wastePctScaled: bigint | null;
};

/** The waste on the actual only: opening + delivered − the factory's closing, against the formula. */
export function measuredWaste(args: {
  readonly openingQty: bigint;
  readonly deliveredQty: bigint;
  readonly closingQty: bigint;
  readonly formulaQty: bigint | null;
}): MeasuredWaste {
  const consumedQty = args.openingQty + args.deliveredQty - args.closingQty;
  if (args.formulaQty === null || args.formulaQty <= BigInt(0)) {
    return { consumedQty, wasteQty: BigInt(0), wastePctScaled: null };
  }
  const wasteQty = consumedQty - args.formulaQty;
  return { consumedQty, wasteQty, wastePctScaled: roundDiv(wasteQty * FRACTION_SCALE, args.formulaQty) };
}

/** When a stock count was taken, against a production that already drew on the same lot. */
export const COUNT_TIMINGS = ["before_production", "after_production"] as const;
export type CountTiming = (typeof COUNT_TIMINGS)[number];

export function coerceCountTiming(value: unknown): CountTiming | null {
  return (COUNT_TIMINGS as readonly unknown[]).includes(value) ? (value as CountTiming) : null;
}

/**
 * A replacing stock count (factory report, own count, adjustment) on a lot whose standing row is a
 * production deduction still waiting for the factory's balance.
 *
 * The owner, 2026-11-24: 76,600 Saginkgo boxes were typed three minutes AFTER the production was
 * recorded, as the count from BEFORE it. A count replaces the balance, so the 22,130 boxes the run
 * took silently came back and the stock read as if nothing had been made. So the count must say
 * which it is:
 *
 *   before_production — what the lot held before the run: the run's take comes off it again, and
 *                       the run's opening figure moves by the same difference;
 *   after_production  — what the lot holds now: stored as typed.
 *
 * A before-production count smaller than what the run took is refused: the run could not have taken
 * what was not there, so either the count or the production is wrong.
 */
export function countAgainstProduction(args: {
  readonly typedQty: bigint;
  readonly timing: CountTiming;
  /** What the production took off this lot (`moved_qty`). */
  readonly movedQty: bigint;
  /** What the lot holds now — the production row's own balance. */
  readonly standingQty: bigint;
}): { readonly storedQty: bigint; readonly openingDelta: bigint } {
  if (args.timing === "after_production") return { storedQty: args.typedQty, openingDelta: BigInt(0) };
  if (args.typedQty < args.movedQty) {
    throw new ProductionPlanningInputError(
      "A count from before the production cannot be smaller than what the production took.",
      "countTiming",
    );
  }
  return {
    storedQty: args.typedQty - args.movedQty,
    // What the lot held before the run, as the run recorded it, was standing + moved.
    openingDelta: args.typedQty - (args.standingQty + args.movedQty),
  };
}

// ── How far the committed plan has got (owner, 2026-11-24) ───────────────────────────────────────
//
// "I want to be in full control to either plan, either execute" — but a committed plan and the
// productions recorded against it never met on the screen: Saginkgo's plan said 17 runs and the
// Execution tab could not say how much of it had been made. This reads the NEWEST committed plan of
// the product against every production that is not cancelled and belongs to it — linked by its plan,
// or, for a production recorded before productions carried their plan, made on or after the day the
// plan was committed.
//
// In the plan's own terms: a "total boxes" plan counts samples inside the total (his own rule: 100
// thousand with 10 thousand samples is 90 and 10), a "saleable boxes" plan counts the boxes and the
// samples apart, a "runs" plan counts runs.

export type PlanProgressPlan = {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly requestMode: string;
  readonly requestedQty: string;
  readonly sampleUnits: string;
  readonly committedAt: string | null;
};

export type PlanProgressRun = {
  readonly planId: string | null;
  readonly stage: string;
  readonly producedOn: string;
  readonly saleableBoxes: string | null;
  readonly actualSampleUnits: string;
  readonly exactRuns: string | null;
};

export type PlanProgress = {
  readonly planId: string;
  readonly title: string;
  readonly mode: "total_boxes" | "good_units" | "runs";
  readonly committedOn: string;
  /** Integers for boxes; runs to two decimals. */
  readonly target: string;
  readonly done: string;
  readonly left: string;
  readonly over: string;
  readonly samplesTarget: string;
  readonly samplesDone: string;
  readonly productionsCounted: number;
};

const MICRO = BigInt(1_000_000);

function wholeOf(value: string | null | undefined): bigint {
  const text = (value ?? "").trim();
  return /^\d+$/.test(text) ? BigInt(text) : BigInt(0);
}

function microOf(value: string | null | undefined): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?\d*$/.exec((value ?? "").trim());
  if (!match) return BigInt(0);
  return BigInt(match[1]) * MICRO + BigInt((match[2] ?? "").padEnd(6, "0"));
}

function microText(value: bigint): string {
  const hundredths = (value + BigInt(5_000)) / BigInt(10_000);
  const whole = hundredths / BigInt(100);
  const part = (hundredths % BigInt(100)).toString().padStart(2, "0");
  return part === "00" ? whole.toString() : `${whole}.${part}`.replace(/0$/, "");
}

export function planProgress(
  plans: readonly PlanProgressPlan[],
  runs: readonly PlanProgressRun[],
  committedOnOf: (committedAt: string) => string,
): PlanProgress | null {
  const plan = plans
    .filter((candidate) => candidate.status === "committed" && candidate.committedAt)
    .slice()
    .sort((a, b) => String(b.committedAt).localeCompare(String(a.committedAt)))[0];
  if (!plan || !plan.committedAt) return null;
  const committedOn = committedOnOf(plan.committedAt);
  const counted = runs.filter(
    (run) =>
      run.stage !== "cancelled" &&
      (run.planId === plan.id || (run.planId === null && run.producedOn >= committedOn)),
  );
  const mode = plan.requestMode === "good_units" || plan.requestMode === "runs" ? plan.requestMode : "total_boxes";
  const boxes = counted.reduce((sum, run) => sum + wholeOf(run.saleableBoxes), BigInt(0));
  const samples = counted.reduce((sum, run) => sum + wholeOf(run.actualSampleUnits), BigInt(0));

  if (mode === "runs") {
    const target = wholeOf(plan.requestedQty) * MICRO;
    const done = counted.reduce((sum, run) => sum + microOf(run.exactRuns), BigInt(0));
    return {
      planId: plan.id,
      title: plan.title,
      mode,
      committedOn,
      target: microText(target),
      done: microText(done),
      left: microText(target > done ? target - done : BigInt(0)),
      over: microText(done > target ? done - target : BigInt(0)),
      samplesTarget: wholeOf(plan.sampleUnits).toString(),
      samplesDone: samples.toString(),
      productionsCounted: counted.length,
    };
  }

  const target = wholeOf(plan.requestedQty);
  const done = mode === "total_boxes" ? boxes + samples : boxes;
  return {
    planId: plan.id,
    title: plan.title,
    mode,
    committedOn,
    target: target.toString(),
    done: done.toString(),
    left: (target > done ? target - done : BigInt(0)).toString(),
    over: (done > target ? done - target : BigInt(0)).toString(),
    samplesTarget: wholeOf(plan.sampleUnits).toString(),
    samplesDone: samples.toString(),
    productionsCounted: counted.length,
  };
}
