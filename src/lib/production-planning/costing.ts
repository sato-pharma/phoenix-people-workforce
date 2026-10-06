/**
 * Production Planner — what an order costs, in both currencies.
 *
 * The owner's instruction, 2026-10-05: "هتعمل لي اوبشن ان انا احط السعر بايدي... هتخليني اختار دولار
 * ولا مصري لو اخترت بالمصري... اوتوماتيك هتحسب بالدولار... وهتابديت نفسك على سعر الجنيه داي باي داي"
 * — he types the price, he picks USD or EGP, the other one derives itself, and the rate updates
 * day by day.
 *
 * ── Why a price is stored in ONE currency ────────────────────────────────────────────────────────
 *
 * It is tempting to store both. Two stored currencies for one price are two truths: the moment the
 * rate moves, one of them is wrong and nothing in the row says which. So `prodplan_material_prices`
 * holds exactly what he typed, in the currency he typed it in, and the other side is derived here
 * from the rate in force — which is also why a committed plan snapshots the rate it used.
 *
 * ── Why a failed FX fetch is not a null ──────────────────────────────────────────────────────────
 *
 * `prodplan_fx_rates.fetch_ok` is persisted rather than inferred from a missing number, and a failed
 * fetch never overwrites a good rate. A costing with no usable rate returns `null` for the derived
 * currency and says why; it does not quietly return zero, which would read as "free".
 */
import { QTY_SCALE, roundDiv, toDisplayQty } from "./rules";

export type Currency = "USD" | "EGP";

export const CURRENCIES: readonly Currency[] = ["USD", "EGP"] as const;

/** Money is carried in 1/10,000ths of a unit, matching the `numeric(18,4)` cost columns. */
export const MONEY_SCALE = BigInt(10_000);

/** A price is `numeric(18,6)` per display unit; the quantity it multiplies is micro base units. */
const PRICE_SCALE = QTY_SCALE;

/** One day's rate as `prodplan_fx_rates` holds it. */
export type FxRateRow = {
  readonly rateDate: string;
  readonly fetchedUsdToEgp: bigint | null;
  readonly fetchOk: boolean;
  readonly manualUsdToEgp: bigint | null;
};

export type EffectiveFxRate = {
  readonly rateDate: string | null;
  /** USD → EGP, in micro. Null when there is nothing usable, which is never treated as zero. */
  readonly usdToEgpMicro: bigint | null;
  readonly source: "manual" | "fetched" | "fallback" | "none";
};

/**
 * The rate to actually use: a figure a human typed beats a fetched one, a fetched one beats the
 * settings fallback, and nothing at all is reported as nothing at all.
 */
export function resolveEffectiveFxRate(
  row: FxRateRow | null,
  fallbackUsdToEgpMicro: bigint | null,
): EffectiveFxRate {
  if (row) {
    if (row.manualUsdToEgp !== null && row.manualUsdToEgp > BigInt(0)) {
      return { rateDate: row.rateDate, usdToEgpMicro: row.manualUsdToEgp, source: "manual" };
    }
    if (row.fetchOk && row.fetchedUsdToEgp !== null && row.fetchedUsdToEgp > BigInt(0)) {
      return { rateDate: row.rateDate, usdToEgpMicro: row.fetchedUsdToEgp, source: "fetched" };
    }
  }
  if (fallbackUsdToEgpMicro !== null && fallbackUsdToEgpMicro > BigInt(0)) {
    return { rateDate: row?.rateDate ?? null, usdToEgpMicro: fallbackUsdToEgpMicro, source: "fallback" };
  }
  return { rateDate: row?.rateDate ?? null, usdToEgpMicro: null, source: "none" };
}

export type MaterialPrice = {
  readonly currency: Currency;
  /** Per DISPLAY unit — per kilogram, per piece — in micro, exactly as typed. */
  readonly pricePerDisplayUnit: bigint;
  readonly effectiveFrom: string;
};

export type LineCost = {
  /** In 1/10,000ths of a US dollar. Null when the rate is unusable and the price was in EGP. */
  readonly usdScaled: bigint | null;
  /** In 1/10,000ths of an Egyptian pound. Null when the rate is unusable and the price was in USD. */
  readonly egpScaled: bigint | null;
  readonly pricedIn: Currency;
  /** True when the other currency could not be derived, so the screen says so rather than show 0. */
  readonly derivedMissing: boolean;
};

/**
 * Cost one quantity at one price, and derive the other currency.
 *
 * The quantity arrives in micro BASE units (grams, pieces) and the price is per DISPLAY unit
 * (kilograms, pieces), so the conversion has to happen before the multiply — pricing 72,100 grams at
 * a per-kilogram price without it is a bill a thousand times too big.
 */
export function costQuantity(
  qtyMicroBaseUnits: bigint,
  basePerDisplayMicro: bigint,
  price: MaterialPrice,
  rate: EffectiveFxRate,
): LineCost {
  const display = toDisplayQty(qtyMicroBaseUnits, basePerDisplayMicro);
  // display.micro is display units × 1e6 and price is per display unit × 1e6, so the product is
  // money × 1e12; money is carried at 1e4, hence the 1e8 divisor.
  const pricedScaled = roundDiv(display.micro * price.pricePerDisplayUnit, (PRICE_SCALE * QTY_SCALE) / MONEY_SCALE);

  if (price.currency === "USD") {
    const egpScaled =
      rate.usdToEgpMicro !== null ? roundDiv(pricedScaled * rate.usdToEgpMicro, QTY_SCALE) : null;
    return { usdScaled: pricedScaled, egpScaled, pricedIn: "USD", derivedMissing: egpScaled === null };
  }

  const usdScaled =
    rate.usdToEgpMicro !== null && rate.usdToEgpMicro > BigInt(0)
      ? roundDiv(pricedScaled * QTY_SCALE, rate.usdToEgpMicro)
      : null;
  return { usdScaled, egpScaled: pricedScaled, pricedIn: "EGP", derivedMissing: usdScaled === null };
}

export type CostTotals = {
  readonly usdScaled: bigint;
  readonly egpScaled: bigint;
  /** Materials whose cost could not be completed, so a total is never passed off as whole. */
  readonly incompleteMaterials: number;
  /** Materials with no price typed at all. */
  readonly unpricedMaterials: number;
};

/**
 * Add up line costs. `incompleteMaterials` and `unpricedMaterials` are part of the answer, not a
 * footnote: a total that silently omits an unpriced material is the kind of number somebody commits
 * money against.
 */
export function totalCosts(
  lines: readonly { readonly cost: LineCost | null; readonly contributesToBuyList: boolean }[],
): CostTotals {
  let usdScaled = BigInt(0);
  let egpScaled = BigInt(0);
  let incompleteMaterials = 0;
  let unpricedMaterials = 0;

  for (const line of lines) {
    if (!line.contributesToBuyList) continue;
    if (line.cost === null) {
      unpricedMaterials += 1;
      continue;
    }
    if (line.cost.derivedMissing) incompleteMaterials += 1;
    usdScaled += line.cost.usdScaled ?? BigInt(0);
    egpScaled += line.cost.egpScaled ?? BigInt(0);
  }

  return { usdScaled, egpScaled, incompleteMaterials, unpricedMaterials };
}

/**
 * Money as a decimal string with exactly two places — the form a cell and a formula both carry.
 *
 * Deliberately NOT `Intl.NumberFormat` with `style: "currency"`: that inserts a space whose
 * character depends on the reader's ICU build, which is a measured hydration failure in this app.
 * The currency itself is a separate label in its own element.
 */
export function formatMoney(scaled: bigint): string {
  const negative = scaled < BigInt(0);
  const magnitude = negative ? -scaled : scaled;
  const whole = magnitude / MONEY_SCALE;
  const hundredths = roundDiv(magnitude % MONEY_SCALE, MONEY_SCALE / BigInt(100));
  // Rounding the fraction can carry into the whole part: 1.99996 must print 2.00, not 1.100.
  const carried = hundredths === BigInt(100);
  const text = `${carried ? whole + BigInt(1) : whole}.${(carried ? BigInt(0) : hundredths).toString().padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}

/** The FX rate as a readable decimal: `48500000n` → `"48.5"`. */
export function formatFxRate(micro: bigint): string {
  const whole = micro / QTY_SCALE;
  const fraction = (micro % QTY_SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
