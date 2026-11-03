/**
 * Production Planner — the pure kernel. No Supabase, no server-only import, so the client
 * workspace, the Excel builder and the tests all read exactly these rules.
 *
 * Owner, 2026-10-05: Sato Pharma does not manufacture. Ivyronc is made under toll manufacturing by
 * EGPI and Sato supplies most of the raw materials, so before every production run somebody has to
 * work out how much of each material is needed, how much is already held, how much to buy and how
 * much to deliver. That was done by hand in a spreadsheet and lost its memory between runs.
 *
 * ── Why every quantity in here is a BigInt ───────────────────────────────────────────────────────
 *
 * The figure on the screen and the formula in the Excel export have to agree to the digit, because
 * the owner checks one against the other. In IEEE doubles they do not: potassium sorbate for nine
 * runs is `0.0067 * 2250000 * 1.03`, which prints `15527.250000000002` — a number no cell in a
 * spreadsheet will ever show, and one that makes the sheet look wrong when the arithmetic is right.
 *
 * So a quantity is carried as an integer count of MICRO base units (base unit × 1,000,000), which is
 * exactly the precision of the `numeric(24,6)` columns it comes from, and a percentage as an integer
 * count of 1/10,000ths, exactly matching `numeric(8,4)`. Nothing in the chain from the database to
 * the rendered cell passes through a float.
 *
 * That is also why every read of a quantity column must be `select("qty::text")`. PostgREST
 * serialises `numeric` as a JSON *number*, so without the cast the value has already been through a
 * double before this file ever sees it, and `parseQty` is handed damage it cannot detect.
 */

/** Micro base units in one base unit. Matches `numeric(24,6)` in the migration exactly. */
export const QTY_SCALE = BigInt(1_000_000);

/** Scaled units in one percentage point. Matches `numeric(8,4)`. */
export const PCT_SCALE = BigInt(10_000);

/**
 * Scaled units in the fraction 1 — i.e. `PCT_SCALE * 100`. A percentage of `p` scaled units is the
 * fraction `p / FRACTION_SCALE`, so 3% is 30,000 scaled and the multiplier is 1,030,000 / 1,000,000.
 */
export const FRACTION_SCALE = PCT_SCALE * BigInt(100);

/** Base units carried in a mass, and in a count. The migration's `base_unit` CHECK spells these. */
export type UnitKind = "mass" | "count";

/**
 * The unit a product's run volume, dose, saleable unit and sample are counted in.
 *
 * The arithmetic is unit-agnostic — a run of 1,250,000 divided by a dose of 5 is 250,000 doses
 * whether those are millilitres of syrup or grams of powder. This exists so the SCREEN and the
 * Excel sheet can say the right word: Ivyronc is `ml`, Guamusin is `g`. The product columns are
 * still named `_ml` for the one product that existed when they were created, which is why the
 * migration carries a `comment on column` on each of them.
 *
 * 🔴 `mg` EXISTS BECAUSE THE GEOMETRY COLUMNS ARE INTEGERS AND A TABLET IS NOT A WHOLE GRAM.
 * Royanoxicam's film-coated tablet weighs 155 mg, and `dose_ml` is an `integer` with a
 * `run_volume_ml % dose_ml = 0` CHECK behind it — so grams would have to store 0.155 and the row
 * would not insert at all. In milligrams the batch is 31,000,000 and the dose 155, which divides
 * to exactly 200,000 tablets. The LARGE label is still the kilogram, so the tile reads 31 kg.
 *
 * `mg_capsule` IS THE SAME ARITHMETIC AS `mg`, AND SAYS "CAPSULE" INSTEAD OF "TABLET". This column picks
 * the words as well as the unit, so Saginkgo under `mg` would read "30,000 tablets".
 */
export type MeasureUnit = "ml" | "g" | "mg" | "mg_capsule";

/** What a composition's `qty_per_basis` is measured against. Matches the migration's CHECK. */
export type CompositionBasis =
  | "per_dose"
  | "per_packaging_set"
  | "per_good_unit"
  | "per_sample_unit"
  /**
   * Per BOX as the owner counts boxes — `packagingSets / unitsPerBox`. A Guamusin carton holds 12
   * sachets, so it is consumed once per box and not once per sachet. For Ivyronc `unitsPerBox` is 1,
   * which makes this identical to `per_packaging_set`, so adding it moved none of his figures.
   */
  | "per_box";

/**
 * Who brings a material. `shared_unsettled` is not an oversight — it is the honest answer for the
 * three materials nobody has settled with the factory yet, and it contributes NOTHING to a buy list
 * until a human decides. `prodplan_plan_lines` refuses it outright.
 */
export type MaterialSupplier = "sato" | "factory" | "shared_unsettled";

/** How `requested_qty` on a plan is read. Matches the migration's CHECK. */
export type PlanRequestMode = "total_boxes" | "good_units" | "runs";

export const UNIT_KINDS: readonly UnitKind[] = ["mass", "count"] as const;

export const COMPOSITION_BASES: readonly CompositionBasis[] = [
  "per_dose",
  "per_packaging_set",
  "per_good_unit",
  "per_sample_unit",
  "per_box",
] as const;

export const MEASURE_UNITS: readonly MeasureUnit[] = ["ml", "g", "mg", "mg_capsule"] as const;

/**
 * How many of a measure unit make up the LARGE unit its big figures are read in — a litre, or a
 * kilogram.
 *
 * 🔴 THE DIVISOR IS NOT ALWAYS 1,000. It was, for as long as the only pairs were ml→L and g→kg, so
 * the planner divided by a literal thousand. A milligram geometry read through that divisor turns
 * Royanoxicam's 31,000,000 mg batch into "31,000 kg" — a thousand-fold overstatement on the tile
 * the owner reads the batch size off, with every other figure on the screen still correct.
 */
export const MEASURE_UNITS_PER_LARGE: Record<MeasureUnit, bigint> = {
  g: BigInt(1000),
  mg: BigInt(1_000_000),
  mg_capsule: BigInt(1_000_000),
  ml: BigInt(1000),
};

/**
 * A measure unit read FAIL-SAFE off a database row.
 *
 * Unrecognised or missing falls back to `ml`, which is what every row held before the column
 * existed — so a half-failed read mislabels nothing it did not already label that way.
 */
export function coerceMeasureUnit(value: unknown): MeasureUnit {
  return MEASURE_UNITS.find((candidate) => candidate === value) ?? "ml";
}

export const MATERIAL_SUPPLIERS: readonly MaterialSupplier[] = ["sato", "factory", "shared_unsettled"] as const;

export const PLAN_REQUEST_MODES: readonly PlanRequestMode[] = ["total_boxes", "good_units", "runs"] as const;

/** Suppliers a committed plan line may carry: the unsettled ones have to be decided first. */
export const SETTLED_SUPPLIERS: readonly MaterialSupplier[] = ["sato", "factory"] as const;

/**
 * Whether a material belongs on the Cost and Stock tabs — the materials SATO buys and holds.
 *
 * Owner, 2026-10-29, on Royanoxicam: "we only supply the active material, Laura Noxicam boxes,
 * pamphlet, and aluminium foil only. We don't supply inactive materials." The formula stays complete
 * (the factory's lines are still on the Formula and Planner screens); only the money and the store
 * leave them out. Unsettled and unknown stay listed: nobody has said they are not his.
 */
export function isBoughtBySato(supplier: MaterialSupplier | null): boolean {
  return supplier !== "factory";
}

export function isSettledSupplier(supplier: MaterialSupplier): supplier is "sato" | "factory" {
  return supplier === "sato" || supplier === "factory";
}

/** Everything a caller got wrong. The HTTP layer maps this to 400, never to 500. */
export class ProductionPlanningInputError extends Error {
  readonly field: string | null;

  constructor(message: string, field: string | null = null) {
    super(message);
    this.name = "ProductionPlanningInputError";
    this.field = field;
  }
}

function fail(message: string, field: string | null = null): never {
  throw new ProductionPlanningInputError(message, field);
}

const QTY_PATTERN = /^-?\d+(?:\.\d+)?$/;

/**
 * Turn a quantity as the database or a form hands it over into micro base units.
 *
 * A string is the only safe carrier and the only one a database read should ever use. A `number` is
 * accepted because the UI's own inputs are numbers, but it is refused the moment it is outside the
 * range where a double still carries six decimal places exactly — which is precisely the case a
 * missing `::text` cast produces, and the case that would otherwise pass silently.
 */
export function parseQty(value: string | number | bigint | null | undefined, field = "qty"): bigint {
  if (value === null || value === undefined || value === "") fail("A quantity is required.", field);
  if (typeof value === "bigint") return value;

  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("A quantity must be a finite number.", field);
    // Beyond 2^53 / 10^6 a double can no longer hold six decimals, so a value this large arriving as
    // a number is evidence the `::text` cast was skipped rather than a quantity anybody typed.
    if (Math.abs(value) > Number.MAX_SAFE_INTEGER / 1_000_000) {
      fail("A quantity this large must arrive as a string (select the column as ::text).", field);
    }
    text = value.toFixed(6);
  } else {
    text = value.trim();
  }

  if (!QTY_PATTERN.test(text)) fail(`"${text}" is not a quantity.`, field);

  const negative = text.startsWith("-");
  const digits = negative ? text.slice(1) : text;
  const dot = digits.indexOf(".");
  const whole = dot < 0 ? digits : digits.slice(0, dot);
  const fractionRaw = dot < 0 ? "" : digits.slice(dot + 1);
  if (fractionRaw.length > 6) {
    // Six decimals is the column's own precision. Silently rounding a seventh would make the stored
    // number and the typed number differ with nothing saying so.
    fail("A quantity carries at most six decimal places.", field);
  }
  const fraction = fractionRaw.padEnd(6, "0");
  const magnitude = BigInt(whole) * QTY_SCALE + BigInt(fraction);
  return negative ? -magnitude : magnitude;
}

/** A quantity that must be present and not negative. */
export function parseNonNegativeQty(
  value: string | number | bigint | null | undefined,
  field = "qty",
): bigint {
  const parsed = parseQty(value, field);
  if (parsed < BigInt(0)) fail("A quantity cannot be negative.", field);
  return parsed;
}

/**
 * Micro base units back to the decimal string the database and the Excel formula both use.
 * Trailing zeros are trimmed, so 43,000 g prints `43000` and not `43000.000000`.
 */
export function formatQty(micro: bigint): string {
  const negative = micro < BigInt(0);
  const magnitude = negative ? -micro : micro;
  const whole = magnitude / QTY_SCALE;
  const fraction = (magnitude % QTY_SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  const text = fraction ? `${whole}.${fraction}` : whole.toString();
  return negative ? `-${text}` : text;
}

const PCT_PATTERN = /^\d+(?:\.\d+)?$/;

/** A percentage as the database or a form hands it over, into 1/10,000ths. */
export function parsePct(value: string | number | bigint | null | undefined, field = "percent"): bigint {
  if (value === null || value === undefined || value === "") fail("A percentage is required.", field);
  if (typeof value === "bigint") return value;
  const text = typeof value === "number" ? value.toFixed(4) : value.trim();
  if (!PCT_PATTERN.test(text)) fail(`"${text}" is not a percentage.`, field);
  const dot = text.indexOf(".");
  const whole = dot < 0 ? text : text.slice(0, dot);
  const fractionRaw = dot < 0 ? "" : text.slice(dot + 1);
  if (fractionRaw.length > 4) fail("A percentage carries at most four decimal places.", field);
  const scaled = BigInt(whole) * PCT_SCALE + BigInt(fractionRaw.padEnd(4, "0"));
  if (scaled > BigInt(100) * PCT_SCALE) fail("A percentage above 100 is not an overage.", field);
  return scaled;
}

/** 1/10,000ths back to a decimal string, trailing zeros trimmed: 30,000 prints `3`. */
export function formatPct(scaled: bigint): string {
  const whole = scaled / PCT_SCALE;
  const fraction = (scaled % PCT_SCALE).toString().padStart(4, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** A whole, positive count — a run count, a bottle count, a dose count. */
export function parseWholeCount(
  value: string | number | bigint | null | undefined,
  field: string,
  { min = BigInt(0), max = BigInt(1_000_000_000_000) }: { min?: bigint; max?: bigint } = {},
): bigint {
  if (value === null || value === undefined || value === "") fail("A count is required.", field);
  const text = typeof value === "bigint" ? value.toString() : String(value).trim();
  if (!/^-?\d+$/.test(text)) fail(`"${text}" is not a whole count.`, field);
  const parsed = BigInt(text);
  if (parsed < min) fail(`A count below ${min} is not allowed here.`, field);
  if (parsed > max) fail(`A count above ${max} is not allowed here.`, field);
  return parsed;
}

/**
 * Integer division that rounds UP. Every "how much do I need" answer in this module uses it: you
 * cannot buy 0.6 of a carton, and rounding a requirement down produces a run that stops halfway.
 * Negative numerators round toward zero, which never arises for a requirement.
 */
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === BigInt(0)) throw new Error("ceilDiv by zero");
  if (denominator < BigInt(0)) return ceilDiv(-numerator, -denominator);
  if (numerator <= BigInt(0)) return numerator / denominator;
  return (numerator + denominator - BigInt(1)) / denominator;
}

/** Integer division rounding half away from zero. Used for money, never for a requirement. */
export function roundDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === BigInt(0)) throw new Error("roundDiv by zero");
  if (denominator < BigInt(0)) return roundDiv(-numerator, -denominator);
  if (numerator < BigInt(0)) return -roundDiv(-numerator, denominator);
  return (numerator * BigInt(2) + denominator) / (denominator * BigInt(2));
}

/**
 * Round a quantity up to something the material can actually exist in: a COUNT is whole, because
 * there is no such thing as 0.4 of a sticker. A mass keeps its six decimals.
 *
 * The migration holds the same rule as a CHECK on every quantity-bearing table, so a count that
 * reached the database with a fraction would be refused there too.
 */
export function roundQtyUpForUnit(micro: bigint, unitKind: UnitKind): bigint {
  if (unitKind !== "count") return micro;
  return ceilDiv(micro, QTY_SCALE) * QTY_SCALE;
}

/**
 * Round a quantity up to what a supplier will actually sell: a minimum order, and then a whole
 * number of purchase increments above it. Both are optional and both are editable on the screen.
 */
export function roundQtyUpToPurchasable(
  micro: bigint,
  unitKind: UnitKind,
  { minOrderQty = null, purchaseIncrement = null }: { minOrderQty?: bigint | null; purchaseIncrement?: bigint | null },
): bigint {
  if (micro <= BigInt(0)) return BigInt(0);
  let result = roundQtyUpForUnit(micro, unitKind);
  if (minOrderQty !== null && minOrderQty > BigInt(0) && result < minOrderQty) result = minOrderQty;
  if (purchaseIncrement !== null && purchaseIncrement > BigInt(0)) {
    result = ceilDiv(result, purchaseIncrement) * purchaseIncrement;
  }
  return roundQtyUpForUnit(result, unitKind);
}

/**
 * Apply an overage to a quantity. `(1 + pct/100)` as exact integer arithmetic, then rounded up: the
 * overage covers loss in the factory, and covering 99.4% of the loss is not covering it.
 */
export function applyOverage(micro: bigint, overagePctScaled: bigint, unitKind: UnitKind): bigint {
  if (overagePctScaled < BigInt(0)) throw new Error("a negative overage is not an overage");
  const scaled = micro * (FRACTION_SCALE + overagePctScaled);
  return roundQtyUpForUnit(ceilDiv(scaled, FRACTION_SCALE), unitKind);
}

/** Micro base units into the unit the owner reads and types — kilograms, pieces. */
export function toDisplayQty(micro: bigint, basePerDisplayMicro: bigint): { micro: bigint; text: string } {
  if (basePerDisplayMicro <= BigInt(0)) throw new Error("base_per_display must be positive");
  const displayMicro = roundDiv(micro * QTY_SCALE, basePerDisplayMicro);
  return { micro: displayMicro, text: formatQty(displayMicro) };
}

/** The unit the owner types in, back into micro base units. */
export function fromDisplayQty(displayMicro: bigint, basePerDisplayMicro: bigint): bigint {
  if (basePerDisplayMicro <= BigInt(0)) throw new Error("base_per_display must be positive");
  return roundDiv(displayMicro * basePerDisplayMicro, QTY_SCALE);
}

/** The shape every quantity leaves this module in: exact for arithmetic, a string for a cell. */
export type Quantity = {
  /** Micro base units — grams × 1e6, pieces × 1e6. The only value arithmetic is done on. */
  readonly micro: bigint;
  /** The same number as a decimal string, which is what a cell and a formula both carry. */
  readonly text: string;
};

export function quantity(micro: bigint): Quantity {
  return { micro, text: formatQty(micro) };
}
