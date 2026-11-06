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
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";
import { asyncPool } from "@/lib/utils/async-pool";

import type { ReviewSalesDetail, SalesChannel } from "../concentration";

/** At most this many `phx_closing_customers` calls in flight per load (asyncPool clamps to 1 in dev). */
const CLOSING_DETAIL_FETCH_CONCURRENCY = 4;

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

  // Brick NAMES, never the code. `phx_closing_customers` returns a brick_id only, so without this a
  // brick prints as "B215-2" rather than "كوم حماده" — and the owner's standing rule is names, never
  // codes, everywhere in the system. The master is one small indexed read (701 rows, all named on
  // production), and a failed load reads "Brick not named" rather than taking the whole pack down —
  // never the id, which the owner ruled out in plain words on 2026-10-01.
  //
  // STARTED TOGETHER (2026-10-01, "slow to transfer between page and page"): the master shares
  // nothing with the RPC fan-out below, so it no longer holds the first RPC back. It still resolves
  // before a single row is labelled, and it still cannot fail the load — it answers an empty map.
  const brickNamesLoad = (async (): Promise<Map<string, string>> => {
    const names = new Map<string, string>();
    try {
      // Paged: 704 bricks today, and a read cut at a ceiling would print the rest as "Brick not named".
      const data = await fetchAllRows<{ brick_id?: unknown; brick_name?: unknown }>(
        () => db.from("source_of_sales_bricks").select("brick_id, brick_name"),
        "brick_id",
      );
      for (const b of data) {
        const id = text(b.brick_id);
        const name = text(b.brick_name);
        if (id && name) names.set(id, name);
      }
    } catch {
      // The section still ships, keyed by id and labelled in words, rather than failing the export.
    }
    return names;
  })();

  const jobs: { line: ClosingDetailLine; period: string }[] = [];
  for (const line of input.lines) for (const period of periods) jobs.push({ line, period });

  // BOUNDED, NOT ALL AT ONCE (PERF-020, 2026-10-04). A three-line pack over a six-month window is
  // eighteen `phx_closing_customers` scans, and an unbounded fan-out opened all eighteen pooler
  // connections together — several managers exporting at once could exhaust Supavisor. Four in
  // flight is the same budget `ACHIEVEMENT_MONTH_FETCH_CONCURRENCY` holds in vs-target.ts. asyncPool
  // keeps the results in `jobs` order, starts nothing new after a rejection, and rejects the whole
  // load exactly as the old unbounded fan-out did, so a failed month still fails the pack.
  const [brickNames, loaded] = await Promise.all([
    brickNamesLoad,
    asyncPool(CLOSING_DETAIL_FETCH_CONCURRENCY, jobs, async ({ line, period }) => {
      const data = (await rpcAll<CustomerRpcRow>(
        db,
        "phx_closing_customers",
        { p_line: line.officialLine, p_period: period },
        ["client_code", "distributor_code"],
      )) as CustomerRpcRow[];
      return { line, period, rows: data };
    }),
  ]);

  // Customer NAMES, never the code (owner, 2026-10-01: "NEVER SHOW CODES ALWAYS SHOW NAMES"). The
  // direct-order book's rows reach the RPC with an EMPTY client name and the pharmacy's Phoenix code
  // ("DOP-000021") as the client code — measured on production for Pedia August 2026, every one of
  // them — so the biggest-customers table printed the code. The name is the direct-order pharmacy
  // register's own. A code still unnamed after that reads in words, never as itself.
  const unnamedCodes = [
    ...new Set(
      loaded.flatMap(({ rows }) =>
        rows.filter((row) => !text(row.client_name) && text(row.client_code)).map((row) => text(row.client_code)),
      ),
    ),
  ];
  const directPharmacyNames = new Map<string, string>();
  for (let i = 0; i < unnamedCodes.length; i += 200) {
    try {
      const { data } = await db
        .from("direct_order_pharmacies")
        .select("phoenix_pharmacy_code, pharmacy_name")
        .in("phoenix_pharmacy_code", unnamedCodes.slice(i, i + 200));
      for (const row of (data ?? []) as { phoenix_pharmacy_code?: unknown; pharmacy_name?: unknown }[]) {
        const code = text(row.phoenix_pharmacy_code);
        const name = text(row.pharmacy_name);
        if (code && name) directPharmacyNames.set(code, name);
      }
    } catch {
      // The customer is then labelled "Customer not named" — still never its code.
    }
  }

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
      // The master's NAME when known — and never the id, not even as a last resort (owner,
      // 2026-10-01: "NEVER SHOW CODES ALWAYS SHOW NAMES"). An unnamed brick says so in words.
      brickName: brickNames.get(row.brickId) || (row.brickId ? "Brick not named" : "No brick recorded"),
      channel: channelOfClosingRow(row),
      clientCode: row.clientCode,
      clientName: row.clientName || directPharmacyNames.get(row.clientCode) || "Customer not named",
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
