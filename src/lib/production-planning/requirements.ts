/**
 * Production Planner — what one order needs, what is already owned, and what to do about the gap.
 *
 * The owner's question is never "how much does a run consume". It is the four-part one he asked on
 * 2026-10-05: how much do I need, how much is already at the factory, how much must I send, and
 * "عايز اعرف اللي هيتبقى" — what will be LEFT after the run. All four are on every row here, and
 * the last one is why `willSendQty` exists at all: he decides to deliver 50 kg against a 38.1125 kg
 * minimum, and wants the remainder, not a congratulation.
 *
 * Three rules this file holds and must not be "simplified" away:
 *
 *   · A material whose supplier is `shared_unsettled` contributes NOTHING to the buy list. Its
 *     requirement is still shown — he should see it — but it never becomes money until somebody
 *     settles with the factory who brings it. `prodplan_plan_lines` refuses to store it.
 *   · A material the FACTORY brings is shown and never bought. EGPI's citric acid is not his
 *     problem, and putting it in a buy list would have him paying twice.
 *   · Cover reads TOTAL owned, across the factory and Sato's own store. His words: "انا مثلا ممكن
 *     ابقى جايب مثلا 100 كيلو ولا حاجه اودي 50 لاي جي بي اي واشيل 50 في المخزن عندي" — half at the
 *     factory and half in his own store is still a hundred kilos he owns.
 */
import type { RunGeometryResult } from "./geometry";
import {
  applyOverage,
  ceilDiv,
  isSettledSupplier,
  QTY_SCALE,
  roundQtyUpForUnit,
  roundQtyUpToPurchasable,
  type CompositionBasis,
  type MaterialSupplier,
  type UnitKind,
} from "./rules";

/**
 * Where a resolved overage came from, so the screen can say "measured" rather than imply it.
 * `actual` is a line with no formula, read from recorded runs: what the factory really consumed
 * already holds its loss, so nothing is added on top of it.
 */
export type OverageSource = "measured" | "material" | "default" | "actual";

/**
 * Where the AMOUNT came from. `measured` is a Sato material with no formula line whose per-batch
 * figure is the product's own recorded runs (opening + delivered − closing ÷ batches) — the
 * Royafloxacin review of 2026-11-13: "leave the aluminum consumption field blank and calculate it
 * based on the actual consumption after production is completed". A line in force always wins.
 */
export type AmountSource = "formula" | "measured";

/** One material as the planner needs it: its identity, its line in the formula, its stock. */
export type MaterialRequirementInput = {
  readonly materialId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly unitKind: UnitKind;
  readonly displayUnit: string;
  /** Base units in one display unit, in micro — 1 kg of a gram-based material is `1_000_000_000n`. */
  readonly basePerDisplayMicro: bigint;
  readonly isImported: boolean;
  readonly leadTimeDays: number | null;
  readonly minOrderQty: bigint | null;
  readonly purchaseIncrement: bigint | null;
  /** Null when the composition has not been entered — an honest gap, never a zero. */
  readonly basis: CompositionBasis | null;
  readonly qtyPerBasis: bigint | null;
  readonly supplier: MaterialSupplier | null;
  /** Already resolved by the caller: material override, else measured, else the settings default. */
  readonly overagePctScaled: bigint;
  readonly overageSource: OverageSource;
  /**
   * Micro base units ONE batch of THIS product really consumed, averaged over its recorded runs and
   * rounded up. Read only when there is no formula line. Null or absent: nothing measured yet.
   */
  readonly measuredPerRunQty?: bigint | null;
  /** How many batches that average covers, so the screen can say "from 3 recorded batches". */
  readonly measuredRuns?: bigint | null;
  /** Stock by location id, in micro base units. Missing means nothing held there. */
  readonly heldByLocationId: ReadonlyMap<string, bigint>;
  /** Id of the location that IS the factory, so "send to the factory" has a meaning. */
  readonly factoryLocationId: string | null;
  /** His own decision, when he has made one: how much he will actually deliver. */
  readonly willSendQty: bigint | null;
};

export type MaterialRequirement = {
  readonly materialId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly unitKind: UnitKind;
  readonly displayUnit: string;
  readonly basePerDisplayMicro: bigint;
  readonly isImported: boolean;
  readonly leadTimeDays: number | null;
  readonly supplier: MaterialSupplier | null;
  readonly basis: CompositionBasis | null;
  readonly overagePctScaled: bigint;
  readonly overageSource: OverageSource;
  /** Null for a material with no amount at all — no line and nothing measured. */
  readonly amountSource: AmountSource | null;
  /** Micro base units a batch, when `amountSource` is `measured`. */
  readonly measuredPerRunQty: bigint | null;
  readonly measuredRuns: bigint | null;
  /** How many doses / sets / bottles / samples this material is counted against. */
  readonly basisCount: bigint;
  /** Before overage — the formula's own figure. Shown so the overage is never invisible. */
  readonly rawNeededQty: bigint;
  /** With overage applied and rounded up to something the material can exist in. */
  readonly neededQty: bigint;
  /**
   * The loss on its own: `neededQty − rawNeededQty`, so the screen shows net + loss = total
   * (review of 2026-11-13: "calculate the loss percentage separately for better clarity"). Taken
   * from the two figures the engine already rounded, so the three always add up to the digit.
   */
  readonly lossQty: bigint;
  /** Needed for ONE run at this sample rate, which is what cover is measured in. */
  readonly neededPerRunQty: bigint;
  readonly heldAtFactoryQty: bigint;
  readonly heldElsewhereQty: bigint;
  readonly heldTotalQty: bigint;
  /** Owned nowhere and therefore to be bought, rounded up to what a supplier will sell. */
  readonly toBuyQty: bigint;
  /** The least he must deliver to the factory. Zero when the factory already holds enough. */
  readonly minToDeliverQty: bigint;
  /** What he said he would send, or the minimum when he has not said. */
  readonly willSendQty: bigint;
  /** At the factory AFTER the run: held there + delivered − consumed. Can be negative = short. */
  readonly balanceAfterQty: bigint;
  /** The same balance expressed in runs, so "0.9 of a run left" reads as what it is. */
  readonly balanceAfterRunsMicro: bigint | null;
  /** Runs the total owned covers, in micro-runs. Null when there is no composition to divide by. */
  readonly coverRunsMicro: bigint | null;
  /** False for a material the factory brings, or one nobody has settled. */
  readonly contributesToBuyList: boolean;
  /** Why it does not, in a form the screen can show rather than guess at. */
  readonly excludedReason: "factory_supplies" | "supplier_unsettled" | "no_composition" | null;
};

/** How many doses / packaging sets / bottles / samples a basis is counted against. */
export function basisCountFor(basis: CompositionBasis, run: RunGeometryResult): bigint {
  switch (basis) {
    case "per_dose":
      return run.totalDoses;
    case "per_packaging_set":
      return run.packagingSets;
    case "per_good_unit":
      return run.goodUnits;
    case "per_sample_unit":
      return run.sampleUnits;
    case "per_box":
      return run.perBoxCount;
    case "per_strip":
      return run.stripCount;
  }
}

/** The same basis for exactly ONE run at the order's own sample rate — the unit cover is read in. */
function basisCountForOneRun(basis: CompositionBasis, run: RunGeometryResult): bigint {
  if (run.runs <= BigInt(0)) return BigInt(0);
  // Spread the order's samples evenly over its runs, rounding up, so a per-run packaging figure is
  // never optimistic. A mass is volume-driven and comes out the same either way.
  switch (basis) {
    case "per_dose":
      return run.totalDoses / run.runs;
    case "per_packaging_set":
      return ceilDiv(run.packagingSets, run.runs);
    case "per_good_unit":
      return ceilDiv(run.goodUnits, run.runs);
    case "per_sample_unit":
      return ceilDiv(run.sampleUnits, run.runs);
    case "per_box":
      return ceilDiv(run.perBoxCount, run.runs);
    case "per_strip":
      return ceilDiv(run.stripCount, run.runs);
  }
}

/**
 * One material's full answer for one order.
 *
 * `balanceAfterQty` is deliberately signed. A negative balance is the whole point of the column: it
 * says the run stops before it finishes, and hiding that behind a `max(0, …)` would turn the one
 * number he asked for into a reassuring zero.
 */
export function resolveMaterialRequirement(
  input: MaterialRequirementInput,
  run: RunGeometryResult,
): MaterialRequirement {
  let heldAtFactoryQty = BigInt(0);
  let heldElsewhereQty = BigInt(0);
  for (const [locationId, qty] of input.heldByLocationId) {
    if (input.factoryLocationId !== null && locationId === input.factoryLocationId) {
      heldAtFactoryQty += qty;
    } else {
      heldElsewhereQty += qty;
    }
  }
  const heldTotalQty = heldAtFactoryQty + heldElsewhereQty;

  const shared = {
    materialId: input.materialId,
    code: input.code,
    nameAr: input.nameAr,
    nameEn: input.nameEn,
    unitKind: input.unitKind,
    displayUnit: input.displayUnit,
    basePerDisplayMicro: input.basePerDisplayMicro,
    isImported: input.isImported,
    leadTimeDays: input.leadTimeDays,
    supplier: input.supplier,
    basis: input.basis,
    overagePctScaled: input.overagePctScaled,
    overageSource: input.overageSource,
    heldAtFactoryQty,
    heldElsewhereQty,
    heldTotalQty,
  } as const;

  const hasLine = input.basis !== null && input.qtyPerBasis !== null && input.qtyPerBasis > BigInt(0);
  const measuredPerRunQty =
    !hasLine && input.measuredPerRunQty != null && input.measuredPerRunQty > BigInt(0) ? input.measuredPerRunQty : null;

  // No composition entered and nothing measured is a gap, not a zero. The screen says so rather than
  // printing a 0 that reads as "none needed".
  if (!hasLine && measuredPerRunQty === null) {
    return {
      ...shared,
      amountSource: null,
      measuredPerRunQty: null,
      measuredRuns: null,
      basisCount: BigInt(0),
      rawNeededQty: BigInt(0),
      neededQty: BigInt(0),
      lossQty: BigInt(0),
      neededPerRunQty: BigInt(0),
      toBuyQty: BigInt(0),
      minToDeliverQty: BigInt(0),
      willSendQty: input.willSendQty ?? BigInt(0),
      balanceAfterQty: heldAtFactoryQty + (input.willSendQty ?? BigInt(0)),
      balanceAfterRunsMicro: null,
      coverRunsMicro: null,
      contributesToBuyList: false,
      // The factory's own Q.S. materials (Royanoxicam's water and alcohol) never get a line, and are
      // not a gap: they are simply not his to buy.
      excludedReason: input.supplier === "factory" ? "factory_supplies" : "no_composition",
    };
  }

  // A measured amount is counted per BATCH and carries no overage: the factory's real consumption
  // already includes its loss, and adding the default 3% on top would count the loss twice.
  const measured = measuredPerRunQty !== null;
  const qtyPerBasis = measured ? measuredPerRunQty : input.qtyPerBasis!;
  const overagePctScaled = measured ? BigInt(0) : input.overagePctScaled;
  const overageSource: OverageSource = measured ? "actual" : input.overageSource;

  const basisCount = measured ? run.runs : basisCountFor(input.basis!, run);
  // qtyPerBasis is already in MICRO base units, so multiplying it by a plain basis count gives the
  // total in micro base units directly. Dividing by QTY_SCALE here would drop a factor of a million.
  const rawNeededMicro = qtyPerBasis * basisCount;
  const rawNeededQty = roundQtyUpForUnit(rawNeededMicro, input.unitKind);
  const neededQty = applyOverage(rawNeededMicro, overagePctScaled, input.unitKind);
  const lossQty = neededQty > rawNeededQty ? neededQty - rawNeededQty : BigInt(0);

  const perRunBasis = measured ? (run.runs > BigInt(0) ? BigInt(1) : BigInt(0)) : basisCountForOneRun(input.basis!, run);
  const neededPerRunQty = applyOverage(qtyPerBasis * perRunBasis, overagePctScaled, input.unitKind);

  const coverRunsMicro = neededPerRunQty > BigInt(0) ? (heldTotalQty * QTY_SCALE) / neededPerRunQty : null;

  const supplierSettled = input.supplier !== null && isSettledSupplier(input.supplier);
  const satoSupplies = input.supplier === "sato";

  const excludedReason: MaterialRequirement["excludedReason"] = !supplierSettled
    ? "supplier_unsettled"
    : satoSupplies
      ? null
      : "factory_supplies";

  // Only a material WE bring becomes money or a delivery. The factory's own materials and the
  // unsettled ones are reported and left alone.
  const rawToBuy = satoSupplies && neededQty > heldTotalQty ? neededQty - heldTotalQty : BigInt(0);
  const toBuyQty = roundQtyUpToPurchasable(rawToBuy, input.unitKind, {
    minOrderQty: input.minOrderQty,
    purchaseIncrement: input.purchaseIncrement,
  });

  const minToDeliverQty =
    satoSupplies && neededQty > heldAtFactoryQty ? neededQty - heldAtFactoryQty : BigInt(0);
  const willSendQty = input.willSendQty ?? minToDeliverQty;
  const balanceAfterQty = heldAtFactoryQty + willSendQty - (satoSupplies ? neededQty : BigInt(0));

  return {
    ...shared,
    overagePctScaled,
    overageSource,
    amountSource: measured ? "measured" : "formula",
    measuredPerRunQty,
    measuredRuns: measured ? (input.measuredRuns ?? null) : null,
    basisCount,
    rawNeededQty,
    neededQty,
    lossQty,
    neededPerRunQty,
    toBuyQty,
    minToDeliverQty,
    willSendQty,
    balanceAfterQty,
    balanceAfterRunsMicro:
      neededPerRunQty > BigInt(0) ? (balanceAfterQty * QTY_SCALE) / neededPerRunQty : null,
    coverRunsMicro,
    contributesToBuyList: satoSupplies,
    excludedReason,
  };
}

export type RequirementTotals = {
  readonly materials: number;
  readonly satoSupplied: number;
  readonly factorySupplied: number;
  readonly unsettled: number;
  readonly withoutComposition: number;
  readonly toBuyCount: number;
  readonly shortAfterRunCount: number;
};

export function summariseRequirements(rows: readonly MaterialRequirement[]): RequirementTotals {
  return {
    materials: rows.length,
    satoSupplied: rows.filter((r) => r.supplier === "sato").length,
    factorySupplied: rows.filter((r) => r.supplier === "factory").length,
    unsettled: rows.filter((r) => r.supplier === "shared_unsettled").length,
    withoutComposition: rows.filter((r) => r.excludedReason === "no_composition").length,
    toBuyCount: rows.filter((r) => r.toBuyQty > BigInt(0)).length,
    shortAfterRunCount: rows.filter((r) => r.contributesToBuyList && r.balanceAfterQty < BigInt(0)).length,
  };
}

/** The order the result table draws in: what he must act on first, then everything else. */
export function sortRequirements(rows: readonly MaterialRequirement[]): MaterialRequirement[] {
  const rank = (row: MaterialRequirement): number => {
    if (row.contributesToBuyList && row.balanceAfterQty < BigInt(0)) return 0;
    if (row.contributesToBuyList && row.toBuyQty > BigInt(0)) return 1;
    if (row.contributesToBuyList) return 2;
    if (row.excludedReason === "supplier_unsettled") return 3;
    if (row.excludedReason === "factory_supplies") return 4;
    return 5;
  };
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code));
}
