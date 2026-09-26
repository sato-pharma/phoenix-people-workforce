// Business Review — the Monthly Closing's own customer-grain rows.
//
// The review's sales source, `AchievementRow`, is grained at period x line x region x area x rep
// seat x product and carries NO brick, NO customer, NO distributor and NO channel. So "is he
// selling across all his bricks or one", "is the bulk of it one customer" and "distributor,
// wholesaler or direct" (owner, 2026-09-26) cannot be answered from it at any price. They come
// from here.
//
// ONE RPC, NOT A ROW CRUNCH. `phx_closing_customers(p_line, p_period)` is an AGGREGATE the closing
// already owns, returning client x distributor x area x brick with units and value. Reading raw
// import rows across a window and grouping them in node would be a second opinion about what a
// closing row is worth, over far more data.
//
// WHAT THE RPC ALREADY DECIDES, verified against production on 2026-09-26 by reading its body:
//
//   * THE CLOSING'S OWN PLACEMENT (the owner's ruling for this pack). Its area is
//     `coalesce(fact_area, customer_map.area_code)` — the FACT area first, which is where the
//     closing books the row and what `closingAreaOf` returns. A hand-apportioned customer therefore
//     lands in the pack exactly where it lands in the published sheet, including the July 2026
//     direct orders the owner's own overlay places.
//   * NO DISTRIBUTOR'S BONUS. It prices a distributor row at `effective_units * factory_price`,
//     never the sheet's own value and never `total_qty` — the September 2026 rule, in SQL.
//   * A DIRECT ORDER KEEPS ITS OWN VALUE (`direct_value`), in the month the rollup carries it,
//     which is the month Finance booked it.
//   * HEAD OFFICE IS OUT. `LA003`, `LA004` and `SS001` are excluded, so Lacto Basic and Satoslim
//     cannot leak into a line's figures.
//
// WHAT THIS MODULE MUST STILL DO, because the RPC does not:
//
//   * MASK EL QEMA. `QM` carried 41 rows and 30 customers across Jul-Aug 2026 on production. Its
//     detail rows are REMOVED for everyone but the Super Admin, so the mask runs HERE, before any
//     concentration figure is computed — masking afterwards would leak the name through a share
//     that no longer adds up.
//   * NAME THE CHANNEL. There is no column for it. `DIRECT` and `DirectReq` are the direct book;
//     everything else is a distributor row, and a WHOLESALER is one whose CUSTOMER is a warehouse,
//     decided by `classifyCustomerChannel` — the one authority, shared with the closing's city
//     split and the venue guard.
//
// The 61 blank-customer `DIRECT` rows are the retired vintage: they carry no `client_code`, so the
// RPC drops them by construction. That is correct and is not a gap to repair here.

import { classifyCustomerChannel } from "@/lib/sales/customer-channel";
import {
  withoutMaskedSourceRows,
  type SourceMaskViewer,
} from "@/lib/sales/closing-source-mask";
import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";

import type { ReviewSalesDetail, SalesChannel } from "../concentration";

/** The distributor codes that ARE the direct-order book rather than a distributor. */
const DIRECT_DISTRIBUTOR_CODES = new Set(["DIRECT", "DIRECTREQ"]);

export type ClosingDetailLine = {
  /** The review's own line key, for grouping. */
  lineCode: string;
  /** `source_of_sales_fact_rollup.official_line`, which is what the RPC matches on. */
  officialLine: string;
};

export type ClosingDetailLoad = {
  /** Already masked, already classified. Ready for `buildConcentration`. */
  rows: ReviewSalesDetail[];
  /** Keyed by the review's line code, so a line pack never scans the company's rows. */
  byLine: Record<string, ReviewSalesDetail[]>;
  /** Months that returned at least one row — a month with none is SAID, never shown as a zero. */
  periodsWithData: string[];
  /**
   * What the mask removed, as a count and a value. Reported so the coverage layer can say a figure
   * is short without naming the source — the whole point of the mask.
   */
  masked: { rows: number; value: number };
};

/** One row as the RPC returns it. Every field is text or numeric; nothing is trusted unparsed. */
type CustomerRpcRow = {
  client_code?: unknown;
  client_name?: unknown;
  distributor_code?: unknown;
  region_code?: unknown;
  area_code?: unknown;
  brick_id?: unknown;
  units?: unknown;
  value?: unknown;
};

const text = (value: unknown): string => String(value ?? "").trim();

/**
 * Which of the three ways this pound reached the market.
 *
 * Direct first, because a direct order to a warehouse is still a direct order — the question is how
 * the sale was placed, and only then who bought it.
 */
export function channelOfClosingRow(input: {
  clientCode: string;
  clientName: string;
  distributorCode: string;
}): SalesChannel {
  if (DIRECT_DISTRIBUTOR_CODES.has(input.distributorCode.toUpperCase())) return "direct";
  return classifyCustomerChannel(input.clientName, input.clientCode, input.distributorCode) === "store"
    ? "wholesaler"
    : "distributor";
}

/**
 * Load the customer-grain rows for one window.
 *
 * `figurePeriods` is the FIGURE window, never the requested one: a month whose distributor files
 * have not landed is held out of every other figure on the page, and letting it into this one would
 * put a brick on a chart that the achievement beside it does not know about.
 *
 * One RPC call per (line, period) — six for the default three-line, two-month window — issued
 * together rather than in sequence. `rpcAll` pages each, because a line's customer list runs to
 * thousands and PostgREST caps a response at 1,000 rows.
 */
export async function loadClosingDetailFacts(input: {
  figurePeriods: readonly string[];
  lines: readonly ClosingDetailLine[];
  viewer: SourceMaskViewer;
}): Promise<ClosingDetailLoad> {
  const periods = [...new Set(input.figurePeriods.filter(Boolean))].sort();
  const empty: ClosingDetailLoad = { byLine: {}, masked: { rows: 0, value: 0 }, periodsWithData: [], rows: [] };
  if (periods.length === 0 || input.lines.length === 0) return empty;

  const db = getSupabaseAdmin();
  const jobs: { line: ClosingDetailLine; period: string }[] = [];
  for (const line of input.lines) for (const period of periods) jobs.push({ line, period });

  const loaded = await Promise.all(
    jobs.map(async ({ line, period }) => {
      const data = (await rpcAll<CustomerRpcRow>(
        db,
        "phx_closing_customers",
        { p_line: line.officialLine, p_period: period },
        ["client_code", "distributor_code"],
      )) as CustomerRpcRow[];
      return { line, period, rows: data };
    }),
  );

  const all: ReviewSalesDetail[] = [];
  const periodsWithData = new Set<string>();
  const byLine: Record<string, ReviewSalesDetail[]> = {};
  let maskedRows = 0;
  let maskedValue = 0;

  for (const { line, period, rows } of loaded) {
    if (rows.length > 0) periodsWithData.add(period);

    // The mask runs on the RAW rows, before anything is derived from them. `withoutMaskedSourceRows`
    // is the one authority for who may see a source name, and it reads `distributorCode`.
    const shaped = rows.map((row) => ({
      areaCode: text(row.area_code).toUpperCase(),
      brickId: text(row.brick_id),
      clientCode: text(row.client_code),
      clientName: text(row.client_name),
      distributorCode: text(row.distributor_code),
      value: Number(row.value ?? 0),
    }));
    const kept = withoutMaskedSourceRows(shaped, input.viewer);
    if (kept.length !== shaped.length) {
      const keptSet = new Set(kept);
      for (const row of shaped) {
        if (keptSet.has(row)) continue;
        maskedRows += 1;
        maskedValue += Number.isFinite(row.value) ? row.value : 0;
      }
    }

    const mapped: ReviewSalesDetail[] = kept.map((row) => ({
      areaCode: row.areaCode,
      // A brick with no id cannot be ranked against the named ones, and dropping the row would lose
      // real money — so it becomes one explicit bucket rather than many anonymous ones.
      brickId: row.brickId || "(no brick)",
      brickName: row.brickId || "No brick recorded",
      channel: channelOfClosingRow(row),
      clientCode: row.clientCode,
      clientName: row.clientName || row.clientCode,
      period,
      value: Number.isFinite(row.value) ? row.value : 0,
    }));

    all.push(...mapped);
    (byLine[line.lineCode] ??= []).push(...mapped);
  }

  return {
    byLine,
    masked: { rows: maskedRows, value: maskedValue },
    periodsWithData: [...periodsWithData].sort(),
    rows: all,
  };
}
