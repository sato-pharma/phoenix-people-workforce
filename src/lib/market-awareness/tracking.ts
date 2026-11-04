import type { MarketAwarenessLine } from "@/lib/market-awareness/lines";
import type {
  MarketAwarenessReconciliation,
  MarketAwarenessTracking,
  MarketAwarenessTrackingPoint,
  MarketAwarenessTrackingSeries,
} from "@/lib/market-awareness/types";
import { shiftPeriod } from "@/lib/sales/periods";
import {
  isSalesPeriodReleased,
  loadSalesReleaseKeys,
  newestPeriodPublishedForLines,
} from "@/lib/sales/unpublished-sales-access";
import { getSupabaseAdmin, toQueryError } from "@/lib/supabase/server";

/**
 * The Tracking tab's numbers.
 *
 * READ THE CLOSING'S OWN SOURCE, NOT A SECOND ONE. `phx_market_awareness_tracking` aggregates
 * `source_of_sales_fact_rollup` on validated batches, which was measured against
 * `phx_closing_distributor_product` and agreed to the EGP on every tracked line (2026-08: Anti
 * Infective, CNS and Pedia all zero difference; the migration re-proves it on apply). Adding
 * `brick_id` to that same aggregate reconciles by construction, because it is the same rows grouped
 * one level finer.
 *
 * BOTH HALVES, ALWAYS. A closing is distributor invoices PLUS direct orders. The RPC returns them
 * apart so neither can be quoted alone by accident, and `totalValue` is what the screen shows.
 *
 * NOTHING IS CACHED OR STORED. A price fix restates every published closing by design, and a stored
 * tracking figure would become a second sales truth that silently disagrees with the first.
 */

type TrackingRow = {
  period: string;
  scope: "brick" | "area" | "area_bricked";
  indirect_units: number | string;
  indirect_value: number | string;
  direct_units: number | string;
  direct_value: number | string;
};

export type TrackingRequest = {
  lines: MarketAwarenessLine[];
  areaCode: string;
  brickIds: string[];
  /** Product codes per line id — a product is only ever counted against its own line. */
  productCodesByLineId: Map<number, string[]>;
  startPeriod: string;
  baselineMonths: number;
  durationMonths: number;
};

function num(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The `baselineMonths` periods immediately BEFORE the activity, oldest first. */
export function baselinePeriodsFor(startPeriod: string, baselineMonths: number): string[] {
  const periods: string[] = [];
  for (let back = baselineMonths; back >= 1; back -= 1) {
    const period = shiftPeriod(startPeriod, back);
    if (period) periods.push(period);
  }
  return periods;
}

/** The activity's own month and the `durationMonths - 1` months after it, oldest first. */
export function windowPeriodsFor(startPeriod: string, durationMonths: number): string[] {
  const periods: string[] = [];
  for (let forward = 0; forward < durationMonths; forward += 1) {
    // shiftPeriod counts BACKWARDS, so a negative shift moves forward. It wraps the year in both
    // directions, which is why the month arithmetic is not done here.
    const period = forward === 0 ? startPeriod : shiftPeriod(startPeriod, -forward);
    if (period) periods.push(period);
  }
  return periods;
}

function emptyPoint(period: string): MarketAwarenessTrackingPoint {
  return { period, indirectValue: 0, directValue: 0, totalValue: 0, units: null };
}

export async function buildTracking(request: TrackingRequest): Promise<MarketAwarenessTracking> {
  const baselinePeriods = baselinePeriodsFor(request.startPeriod, request.baselineMonths);
  const windowPeriods = windowPeriodsFor(request.startPeriod, request.durationMonths);
  const allPeriods = [...baselinePeriods, ...windowPeriods];

  // The month the figures run to is the newest one published on ALL of this activity's lines (owner,
  // 2026-11-04). The tracking function answers for any month that holds data, so each line's rows are
  // gated below as well.
  const publishedKeys = await loadSalesReleaseKeys();
  const lastClosedPeriod = newestPeriodPublishedForLines(
    request.lines.map((line) => line.lineCode),
    publishedKeys,
  );
  const supabase = getSupabaseAdmin();

  const fromPeriod = allPeriods[0] ?? request.startPeriod;
  const toPeriod = allPeriods[allPeriods.length - 1] ?? request.startPeriod;

  // Units are only meaningful for a single product. Standing rule: units of different products are
  // never added — above one product the only valid total is value.
  const totalProducts = [...request.productCodesByLineId.values()].reduce(
    (sum, codes) => sum + codes.length,
    0,
  );
  const unitsAreMeaningful = totalProducts === 1;

  const series: MarketAwarenessTrackingSeries[] = [];
  const reconciliationByPeriod = new Map<string, MarketAwarenessReconciliation>();

  for (const line of request.lines) {
    const productCodes = request.productCodesByLineId.get(line.id) ?? [];
    if (productCodes.length === 0) {
      // A targeted line with no product of its own has nothing to measure. An empty series is the
      // honest answer; a zero series would read as "sold nothing".
      series.push({ line, brick: [], area: [] });
      continue;
    }

    const { data, error } = await supabase.rpc("phx_market_awareness_tracking", {
      p_line_code: line.lineCode,
      p_from_period: fromPeriod,
      p_to_period: toPeriod,
      p_area_code: request.areaCode,
      p_brick_ids: request.brickIds,
      p_product_codes: productCodes,
    });
    if (error) throw toQueryError(error);

    const rows = ((data as TrackingRow[] | null) ?? []).filter((row) =>
      isSalesPeriodReleased(row.period, line.lineCode, publishedKeys),
    );
    const brickByPeriod = new Map<string, MarketAwarenessTrackingPoint>();
    const areaByPeriod = new Map<string, MarketAwarenessTrackingPoint>();
    const areaBrickedByPeriod = new Map<string, number>();

    for (const row of rows) {
      const indirectValue = num(row.indirect_value);
      const directValue = num(row.direct_value);
      const point: MarketAwarenessTrackingPoint = {
        period: row.period,
        indirectValue,
        directValue,
        totalValue: indirectValue + directValue,
        units: unitsAreMeaningful ? num(row.indirect_units) + num(row.direct_units) : null,
      };
      if (row.scope === "brick") brickByPeriod.set(row.period, point);
      else if (row.scope === "area") areaByPeriod.set(row.period, point);
      else areaBrickedByPeriod.set(row.period, indirectValue + directValue);
    }

    series.push({
      line,
      brick: allPeriods.map((period) => brickByPeriod.get(period) ?? emptyPoint(period)),
      area: allPeriods.map((period) => areaByPeriod.get(period) ?? emptyPoint(period)),
    });

    // The reconciliation shown on screen: every bricked row in the area against the area total. They
    // agree when every row carries a brick — 100% of rows and value for 2026-08, about 98.2% of
    // value for 2026-07. The gap is real and is surfaced rather than absorbed, because a brick
    // figure that quietly excludes unplaced value contradicts the Monthly Closing.
    for (const period of allPeriods) {
      const areaTotal = areaByPeriod.get(period)?.totalValue ?? 0;
      const bricked = areaBrickedByPeriod.get(period) ?? 0;
      const existing = reconciliationByPeriod.get(period);
      const bricksSum = (existing?.bricksSum ?? 0) + bricked;
      const publishedAreaValue = (existing?.publishedAreaValue ?? 0) + areaTotal;
      const difference = publishedAreaValue - bricksSum;
      reconciliationByPeriod.set(period, {
        period,
        bricksSum,
        publishedAreaValue,
        difference,
        // One EGP of tolerance for numeric rounding across two aggregation orders.
        reconciled: Math.abs(difference) <= 1,
      });
    }
  }

  return {
    baselinePeriods,
    windowPeriods,
    lastClosedPeriod,
    series,
    reconciliation: allPeriods.map(
      (period) =>
        reconciliationByPeriod.get(period) ?? {
          period,
          bricksSum: 0,
          publishedAreaValue: 0,
          difference: 0,
          reconciled: true,
        },
    ),
    windowIncompleteReason: describeWindowCompleteness(windowPeriods, lastClosedPeriod),
  };
}

/**
 * The Tracking tab can never show the running month — a closing is publishable only on the first day
 * of the following month, so the current month is always partially collected. Saying so is better
 * than rendering a half month, which reads as a collapse in sales rather than as a month in
 * progress.
 */
export function describeWindowCompleteness(
  windowPeriods: string[],
  lastClosedPeriod: string | null,
): string | null {
  if (windowPeriods.length === 0) return null;
  if (!lastClosedPeriod) {
    return "No closing has been published yet, so there is nothing to measure against.";
  }
  const pending = windowPeriods.filter((period) => period > lastClosedPeriod);
  if (pending.length === 0) return null;
  if (pending.length === windowPeriods.length) {
    return `The measurement window has not reached a closed month yet. The last published closing is ${lastClosedPeriod}.`;
  }
  return `${pending.length} of the ${windowPeriods.length} months in this window are not closed yet. Figures run to ${lastClosedPeriod}.`;
}
