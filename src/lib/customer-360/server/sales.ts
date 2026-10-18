/**
 * Customer 360 v2 — the Monthly Closing's sales for the pharmacies tied to validated customers.
 *
 * 🔒 THE MONTHLY CLOSING IS THE ONE SOURCE OF SALES TRUTH. Every figure here is a row of
 * `phx_closing_customers` — the closing's own customer aggregate, with its own price, its own Head
 * Office exclusion, its own direct-order value and its own placement — narrowed to the linked pairs
 * by `phx_closing_customers_for_pairs` (…20261018230827), which decides nothing of its own. The old
 * pharmacy page's read of `source_of_sales_channel_customer_rollup` is retired onto the same door.
 *
 * MONTHS (owner, 2026-10-18, "Add Jan-Jun as history"): a month counts for a line when its closing
 * is PUBLISHED for that line; the months before publishing began count as history, from the
 * closing's own uploaded figures. The two gates stay separate functions, never merged — a merged set
 * once swapped `cns|2026-07` keys for bare months and emptied every history surface. The running
 * month is never in either.
 */

import { currentCairoDateParts } from "@/lib/i18n/format";
import { loadPublishedPeriodKeys, loadUploadedPeriodsInRange } from "@/lib/sales/vs-target";
import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";

import { HUB_LINES, type HubLineCode, type SalesPair } from "../hub";
import type { ClosedMonths, ClosingSalesRow } from "../report";
import { CUSTOMER_360_FROM_MONTH } from "./sources";

/** The first month the Monthly Closing publishes (the dashboard floor) — everything before is history. */
const PUBLISHING_FLOOR = "2026-07";

/** Pairs per wrapper call: the list travels in the request body, and each call re-reads one line. */
const PAIRS_PER_CALL = 1500;

function previousMonth(year: number, month: number): string {
  const index = year * 12 + (month - 1) - 1;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** The last month that has ended, in Cairo. */
export function lastEndedMonth(): string {
  const now = currentCairoDateParts();
  return previousMonth(now.year, now.month);
}

/** Months from `from` to `to` inclusive, `YYYY-MM`. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [year, month] = from.split("-").map(Number);
  const [endYear, endMonth] = to.split("-").map(Number);
  while (year < endYear || (year === endYear && month <= endMonth)) {
    out.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

export async function loadClosedMonths(): Promise<ClosedMonths> {
  const lastEnded = lastEndedMonth();
  const [publishedKeys, uploaded] = await Promise.all([
    lastEnded >= PUBLISHING_FLOOR ? loadPublishedPeriodKeys(PUBLISHING_FLOOR, lastEnded) : Promise.resolve(new Set<string>()),
    loadUploadedPeriodsInRange(CUSTOMER_360_FROM_MONTH, previousMonth(Number(PUBLISHING_FLOOR.slice(0, 4)), Number(PUBLISHING_FLOOR.slice(5, 7)))),
  ]);
  const published = { anti_infective: [], cns: [], pedia: [] } as Record<HubLineCode, string[]>;
  for (const key of publishedKeys) {
    const [lineCode, period] = key.split("|");
    const line = HUB_LINES.find((one) => one.code === lineCode)?.code;
    if (line && period && period <= lastEnded) published[line].push(period);
  }
  for (const line of HUB_LINES) published[line.code].sort();
  const history = [...uploaded].filter((period) => period < PUBLISHING_FLOOR).sort();
  const all = [...new Set([...history, ...Object.values(published).flat()])].sort();
  return { all, history, published };
}

type WrapperRow = {
  period?: unknown;
  client_code?: unknown;
  client_name?: unknown;
  distributor_code?: unknown;
  brick_id?: unknown;
  value?: unknown;
};

const text = (value: unknown): string => String(value ?? "").trim();

/**
 * The closing's rows for `pairs` over `months`, every tracked line. NOT masked — the caller masks
 * per viewer, after nothing has been summed (closing-source-mask.ts).
 */
export async function loadClosingRowsForPairs(pairs: readonly SalesPair[], months: ClosedMonths): Promise<ClosingSalesRow[]> {
  if (pairs.length === 0 || months.all.length === 0) return [];
  const db = getSupabaseAdmin();
  const payload = pairs.map((pair) => ({ brick_id: pair.brickId, client_code: pair.customerCode, distributor_code: pair.distributorCode }));
  const out: ClosingSalesRow[] = [];
  for (const line of HUB_LINES) {
    const periods = [...new Set([...months.history, ...months.published[line.code]])].sort();
    if (periods.length === 0) continue;
    for (let at = 0; at < payload.length; at += PAIRS_PER_CALL) {
      const rows = await rpcAll<WrapperRow>(
        db,
        "phx_closing_customers_for_pairs",
        { p_line: line.officialLine, p_pairs: payload.slice(at, at + PAIRS_PER_CALL), p_periods: periods },
        ["period", "distributor_code", "client_code", "brick_id", "area_code", "region_code"],
      );
      for (const row of rows) {
        const value = Number(row.value ?? 0);
        if (!Number.isFinite(value)) continue;
        out.push({
          brickId: text(row.brick_id) || null,
          clientCode: text(row.client_code),
          clientName: text(row.client_name),
          distributorCode: text(row.distributor_code).toUpperCase(),
          line: line.code,
          period: text(row.period),
          value,
        });
      }
    }
  }
  return out;
}
