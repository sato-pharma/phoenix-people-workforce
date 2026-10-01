/**
 * Phoenix CRM — the daily forecast: the boxes a rep expects to sell today, product by product.
 *
 * Owner, 2026-10-01: "build the daily forecast module in Phoenix ONLY FOR CNS LINE". It replaces the
 * "Daily forecast" the CNS reps typed into the line's WhatsApp group — seven lines copied by hand, on
 * a template that circulated between regions with the numbers barely changed (read from the group's
 * own export, 1 July – 30 September 2026). Here the numbers arrive PRE-FILLED and he changes only the
 * ones he disagrees with, so it takes one tap instead of a typed message.
 *
 * 🔴 CNS ONLY. `FORECAST_LINE_CODE` is the one place the line is named; the tab, the routes and the
 * database function all refuse any other line. Widening it is his decision, never a tidy-up.
 *
 * 🔴 WHAT IS PRE-FILLED IS HIS DAILY SHARE OF TARGET — the month's target units ÷ the month's working
 * days (Saturday to Wednesday, less national holidays: the call rate's own calendar). It is NOT
 * "remaining target ÷ remaining days", the formula the NSM gave the group on 2026-09-23, because
 * Phoenix holds no per-rep sales DURING a month: the distributors' files land in the first two weeks
 * of the next one. A pre-fill claiming to know what is left would be inventing the figure it needs.
 *
 * 🔴 UNITS ARE NEVER ADDED ACROSS PRODUCTS. A box of Tebofortine 40 and a box of Dolabactin are not
 * the same quantity. Every per-product figure stays per product; anything summed across products is
 * summed by VALUE (units × the product's price).
 *
 * 🔴 GOLDEN RULE #1 — THE REP NEVER SEES HOW ACCURATE HE WAS. His own targets and his own last month
 * are his work and stay visible to him; a verdict on his forecasting ("over-promised") judges him, so
 * it lives on the managers' board only. The form's shape carries no accuracy field at all.
 *
 * Pure rules, no I/O: the boundary test keeps every module here free of server code.
 */

/** The one line the daily forecast serves (owner, 2026-10-01). */
export const FORECAST_LINE_CODE = "cns";

/** A day's forecast for one product can never exceed this many boxes — a typo guard, not a cap on ambition. */
export const FORECAST_MAX_UNITS = 5000;

/**
 * How far a month's delivery may sit from what was forecast before the board calls it a miss. Inside
 * the band the forecast was on the mark; below it he promised more than came; above it he promised
 * less. Fifteen per cent either way, because a daily forecast is a judgement and not a count.
 */
export const FORECAST_ACCURACY_BAND = 0.15;

export function isForecastLine(lineCode: string | null | undefined): boolean {
  return typeof lineCode === "string" && lineCode.trim().toLowerCase() === FORECAST_LINE_CODE;
}

/**
 * Whether the daily forecast is offered to this viewer at all: the Super Admin (in test mode), or
 * anyone with a CNS territory in scope — a CNS rep (his own), a CNS manager (beneath him), the CEO
 * and the SFE Manager (the company). The Phoenix CRM tab and the portal sidebar's "Daily Forecast"
 * row both ask THIS, so the row can never offer a door the tab then refuses.
 *
 * Structural rather than `PhoenixCrmViewer`, because this module is pure and imports no server code.
 */
export function forecastIsOffered(viewer: {
  isSuperAdmin: boolean;
  scopeTerritories: ReadonlyArray<{ lineCode: string | null }>;
}): boolean {
  return viewer.isSuperAdmin || viewer.scopeTerritories.some((seat) => isForecastLine(seat.lineCode));
}

/**
 * One product's pre-filled boxes for one day: the month's target units ÷ the month's working days,
 * rounded to a whole box. Null when there is no target to share (a month not yet loaded, a product
 * with no target for this area) or no working day to share it over — never a made-up zero.
 */
export function dailyShare(monthTargetUnits: number | null | undefined, workingDays: number): number | null {
  if (monthTargetUnits === null || monthTargetUnits === undefined || !Number.isFinite(monthTargetUnits)) return null;
  if (!Number.isFinite(workingDays) || workingDays <= 0) return null;
  if (monthTargetUnits <= 0) return 0;
  return Math.round(monthTargetUnits / workingDays);
}

/**
 * Last month's result on one product, as a RATIO (0.65 is 65%): the closing's units against the
 * target's units for the SAME product, so the division is between like quantities. Null when there
 * was no target — "no target" is never shown as 0%.
 */
export function unitsRatio(actualUnits: number | null | undefined, targetUnits: number | null | undefined): number | null {
  if (targetUnits === null || targetUnits === undefined || !Number.isFinite(targetUnits) || targetUnits <= 0) return null;
  const actual = actualUnits !== null && actualUnits !== undefined && Number.isFinite(actualUnits) ? actualUnits : 0;
  return actual / targetUnits;
}

export type ForecastLineDraft = { productCode: string; units: number };

export type ForecastDraftResult = { ok: true; value: ForecastLineDraft[] } | { ok: false; error: string };

/**
 * What the screen sends, checked: one line per product, each a product this territory has a target
 * for, each a whole number of boxes from 0 to FORECAST_MAX_UNITS. Zero is a real answer ("none of
 * this today"); a blank is not sent at all.
 */
export function parseForecastDraft(raw: unknown, allowedProductCodes: ReadonlySet<string>): ForecastDraftResult {
  const lines = raw && typeof raw === "object" ? (raw as { lines?: unknown }).lines : undefined;
  if (!Array.isArray(lines) || lines.length === 0) return { ok: false, error: "Enter at least one product's boxes before sending." };
  if (lines.length > 50) return { ok: false, error: "This forecast has more products than the line sells. Reload the page." };
  const seen = new Set<string>();
  const value: ForecastLineDraft[] = [];
  for (const entry of lines) {
    const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const productCode = typeof record.productCode === "string" ? record.productCode.trim().toUpperCase() : "";
    if (!productCode || !allowedProductCodes.has(productCode)) {
      return { ok: false, error: "A product in this forecast is not one of your targets this month. Reload the page." };
    }
    if (seen.has(productCode)) return { ok: false, error: "A product appears twice in this forecast. Reload the page." };
    seen.add(productCode);
    const units = typeof record.units === "number" ? record.units : Number(record.units);
    if (!Number.isInteger(units) || units < 0 || units > FORECAST_MAX_UNITS) {
      return { ok: false, error: `Boxes must be a whole number from 0 to ${FORECAST_MAX_UNITS}.` };
    }
    value.push({ productCode, units });
  }
  return { ok: true, value };
}

/**
 * A forecast against the day's target, by VALUE: Σ (boxes × price) ÷ Σ (month target value ÷ working
 * days). A ratio, 1 = exactly the day's share. Null when the day has no target value to divide by.
 */
export function forecastShareOfDay(
  lines: ReadonlyArray<{ units: number; price: number | null }>,
  dayTargetValue: number | null,
): number | null {
  if (dayTargetValue === null || !Number.isFinite(dayTargetValue) || dayTargetValue <= 0) return null;
  let value = 0;
  for (const line of lines) {
    if (line.price === null || !Number.isFinite(line.price)) continue;
    value += line.units * line.price;
  }
  return value / dayTargetValue;
}

export type MonthAccuracyInput = {
  /** The days in the month he sent a forecast on. */
  daysSent: number;
  /** The month's working days — the same count the pre-fill divided by. */
  workingDays: number;
  /** Boxes forecast across the month, PER PRODUCT — never one total across products. */
  forecastUnits: ReadonlyMap<string, number>;
  /** Each product's price for the month. A product without one cannot be valued and is left out. */
  prices: ReadonlyMap<string, number>;
  /** What the published closing credits the territory with, by value, on the same products. */
  actualValue: number;
};

export type MonthAccuracy = {
  /** His average forecast day, carried across the month's working days, by value. */
  projectedValue: number;
  actualValue: number;
  /** actual ÷ projected, as a ratio — 1 is exactly what he forecast. Null when nothing was forecast. */
  delivered: number | null;
};

/**
 * How a month's delivery compares with what was forecast.
 *
 * The forecast is an AVERAGE DAY carried across the month, not the sum of the days he happened to
 * send: a rep who sent seven days of the month is compared on the rate he forecast, not punished for
 * the fifteen he did not send (who sent and who did not is the board's other column). Each product is
 * averaged on its own units and only then valued, so no two products' boxes are ever added together.
 */
export function monthAccuracy(input: MonthAccuracyInput): MonthAccuracy {
  const actualValue = Number.isFinite(input.actualValue) ? input.actualValue : 0;
  if (input.daysSent <= 0 || input.workingDays <= 0) return { projectedValue: 0, actualValue, delivered: null };
  let projectedValue = 0;
  for (const [productCode, units] of input.forecastUnits) {
    const price = input.prices.get(productCode);
    if (price === undefined || !Number.isFinite(price)) continue;
    projectedValue += (units / input.daysSent) * input.workingDays * price;
  }
  return { projectedValue, actualValue, delivered: projectedValue > 0 ? actualValue / projectedValue : null };
}

export type AccuracyReading = "over-promised" | "on the mark" | "under-promised";

/** The board's word for a month: whether what came in fell short of the forecast, met it, or beat it. */
export function accuracyReading(delivered: number | null): AccuracyReading | null {
  if (delivered === null || !Number.isFinite(delivered)) return null;
  if (delivered < 1 - FORECAST_ACCURACY_BAND) return "over-promised";
  if (delivered > 1 + FORECAST_ACCURACY_BAND) return "under-promised";
  return "on the mark";
}

/**
 * The board's order: the territories that have NOT sent today first — they are what a manager opens
 * the board to find — then by region and name, so a region reads together. Vacant territories come
 * after all of them: nobody can send for one, so it is never part of the "not sent".
 */
export function compareBoardRows(
  left: { sent: boolean; regionName: string | null; name: string; vacant?: boolean },
  right: { sent: boolean; regionName: string | null; name: string; vacant?: boolean },
): number {
  // A vacant territory goes last: nobody can send for it, so it is never one of the "not sent".
  if (Boolean(left.vacant) !== Boolean(right.vacant)) return left.vacant ? 1 : -1;
  if (left.sent !== right.sent) return left.sent ? 1 : -1;
  const region = (left.regionName ?? "").localeCompare(right.regionName ?? "");
  return region !== 0 ? region : left.name.localeCompare(right.name);
}

/** "2026-10" for a Cairo day. */
export function periodOfDay(day: string): string {
  return day.slice(0, 7);
}
