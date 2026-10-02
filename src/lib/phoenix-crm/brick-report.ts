/**
 * Phoenix CRM — coverage against sales, at the grain a rep actually works: the BRICK.
 *
 * C2 of the owner's plan. A manager can already see how many customers a rep covered, and on another
 * screen what an area sold. What nobody could see is the two together: **of the bricks my line sells
 * into, which ones does this rep's list even reach, and how often does he go there.**
 *
 * This module is PURE — the join, the statuses and the ordering. Both halves are loaded by
 * `server/brick-report.ts`, which is also where the El Qema mask is applied, because a mask needs a
 * viewer's role and this file must stay testable with plain fixtures.
 *
 * ## 🔴 The caveat is not decoration
 *
 * **A brick's sales never add up to the area's closing figure**, and this view says so in words that
 * cannot be edited out per screen (`BRICK_SALES_CAVEAT`, beside the loader). The closing credits an
 * area with money no brick holds — a wholesaler's sales spread over its city's areas, El Qema's
 * warehouse stock spread over the country, the Office allocation, and direct orders, which
 * `phx_closing_brick` excludes outright. A manager who reads a brick column as "the area, broken
 * down" is reading a smaller number and concluding something false about a rep.
 *
 * ## The four statuses, and why a brick with neither is still listed
 *
 * The point of the board is the MISMATCH, so a brick is interesting in three of the four states and
 * the fourth is the quiet majority. `idle` rows are kept — a brick of the area with no sales and
 * nobody on the list is how a manager sees the edge of what the line has ever touched — but they sort
 * last, under their own count, so they never bury the two rows that need him.
 *
 * ## AM and PM stay apart
 *
 * The call-rate golden rule reaches every count of a customer: AM and PM are carried as two figures,
 * never summed into one "customers" total a reader could divide. `customers` exists as the row's own
 * size for sorting, and no screen presents it as a call rate.
 */

/**
 * The sentence every screen showing brick sales must carry, in one place.
 *
 * 🔴 It lives HERE, in the pure module, and not beside the loader in `@/lib/sales/closing-brick-sales`
 * — that file reaches the database, and this module is bundled for the phone (`phoenix-crm-boundary`
 * forbids a rule module importing server code, and a transitive supabase client is exactly what that
 * rule exists to keep out). It is a constant and not a prop with a default because the failure it
 * prevents is silent: a second screen renders the same figures under its own softer wording, and a
 * manager reads a brick total as the area's closing.
 */
export const BRICK_SALES_CAVEAT =
  "Bricks do not add up to the area's closing figure. A brick's sales are what distributors booked on it — "
  + "a wholesaler's sales spread over its city's areas, warehouse stock spread over the country, the Office "
  + "allocation and direct orders are credited to the area without belonging to any one brick.";

/** How one brick of the line's geography stands against this territory's list. */
export type BrickCoverageStatus =
  /** The line sells here and the rep has customers here — the normal, good state. */
  | "covered"
  /** Money comes off this brick and nobody on the rep's list sits in it. The row that earns the board. */
  | "sales-no-list"
  /** The rep has customers here and the closing books nothing — new ground, or a brick that lost its sales. */
  | "list-no-sales"
  /** Neither. Kept, but last. */
  | "idle";

export type BrickCoverageRow = {
  seatId: string;
  territoryName: string;
  /** Never rendered on its own — the name is. */
  brickId: string | null;
  brickName: string;
  areaName: string | null;
  status: BrickCoverageStatus;
  /** AM and PM apart, always. `customers` is their sum and is a SIZE, never a rate. */
  am: number;
  pm: number;
  customers: number;
  amVisited: number;
  pmVisited: number;
  visited: number;
  visits: number;
  /** What distributors booked ON this brick over the months that landed. Never the area's figure. */
  sales: number;
};

export type BrickCoverageSummary = {
  bricks: number;
  withSales: number;
  salesNoList: number;
  listNoSales: number;
  covered: number;
  /** The sum of the brick rows only — deliberately NOT called the area's sales. */
  brickSales: number;
};

export type BrickCoverageReport = {
  rows: BrickCoverageRow[];
  summary: BrickCoverageSummary;
  /** The months whose distributor files had landed, so the sales half names what it covers. */
  salesMonths: string[];
  /** Fixed wording; a screen prints it, it never composes its own. */
  caveat: string;
};

/** One row of `phoenix_crm_report_brick_coverage`, already parsed. */
export type BrickCrmRow = {
  seatId: string;
  brickId: string | null;
  brickName: string | null;
  areaCode: string | null;
  areaName: string | null;
  customers: number;
  am: number;
  pm: number;
  visited: number;
  amVisited: number;
  pmVisited: number;
  visits: number;
};

/** One brick's booked sales, already masked and already summed across the months. */
export type BrickSalesTotal = { brickId: string; areaCode: string; value: number };

/** The brick master, so a brick with sales and nobody on it still has a NAME and not an id. */
export type BrickName = { brickId: string; brickName: string; areaCode: string };

/** The territory a row belongs to, resolved by the caller from the seat model. */
export type BrickTerritory = { seatId: string; territoryName: string; areaCodes: readonly string[] };

const up = (value: string | null | undefined) => String(value ?? "").trim().toUpperCase();

/**
 * A brick with no captured place is a REAL answer, not a gap to hide.
 *
 * A customer the rep has never stood at has no place, so no brick. Dropping him would make the
 * board read as if his territory were smaller than it is; naming the row is what tells the manager
 * the rep has not been there at all.
 */
export const NO_BRICK_LABEL = "No place captured yet";

/** A brick neither the CRM nor the master names. The id stays the row's key, never its label. */
export const UNNAMED_BRICK_LABEL = "Brick name not recorded";

const STATUS_ORDER: Record<BrickCoverageStatus, number> = {
  "sales-no-list": 0,
  "list-no-sales": 1,
  covered: 2,
  idle: 3,
};

function statusOf(customers: number, sales: number): BrickCoverageStatus {
  if (sales > 0 && customers === 0) return "sales-no-list";
  if (sales <= 0 && customers > 0) return "list-no-sales";
  if (sales > 0 && customers > 0) return "covered";
  return "idle";
}

/**
 * Join the territory's bricks, its CRM coverage and the closing's brick sales.
 *
 * Every brick that appears on EITHER side is a row: the rep's own bricks, and every brick of his
 * area(s) the closing booked to. That union is the whole point — a brick present only in the sales
 * half is the one a manager most needs to see.
 */
export function buildBrickCoverageReport(input: {
  territories: readonly BrickTerritory[];
  crmRows: readonly BrickCrmRow[];
  sales: readonly BrickSalesTotal[];
  brickNames: readonly BrickName[];
  salesMonths: readonly string[];
}): BrickCoverageReport {
  const nameOfBrick = new Map(input.brickNames.map((entry) => [entry.brickId, entry]));
  const salesByBrick = new Map<string, number>();
  for (const row of input.sales) {
    if (!row.brickId) continue;
    salesByBrick.set(row.brickId, (salesByBrick.get(row.brickId) ?? 0) + row.value);
  }

  const rows: BrickCoverageRow[] = [];
  for (const territory of input.territories) {
    const areaSet = new Set(territory.areaCodes.map(up));
    const seen = new Set<string>();
    const emit = (brickId: string | null, crm: BrickCrmRow | null) => {
      const master = brickId ? nameOfBrick.get(brickId) : undefined;
      const sales = brickId ? (salesByBrick.get(brickId) ?? 0) : 0;
      const customers = crm?.customers ?? 0;
      rows.push({
        seatId: territory.seatId,
        territoryName: territory.territoryName,
        brickId,
        brickName: brickId === null ? NO_BRICK_LABEL : (crm?.brickName || master?.brickName || UNNAMED_BRICK_LABEL),
        areaName: crm?.areaName ?? null,
        status: statusOf(customers, sales),
        am: crm?.am ?? 0,
        pm: crm?.pm ?? 0,
        customers,
        amVisited: crm?.amVisited ?? 0,
        pmVisited: crm?.pmVisited ?? 0,
        visited: crm?.visited ?? 0,
        visits: crm?.visits ?? 0,
        sales,
      });
    };

    for (const crm of input.crmRows) {
      if (crm.seatId !== territory.seatId) continue;
      const key = crm.brickId ?? "";
      if (seen.has(key)) continue;
      seen.add(key);
      emit(crm.brickId, crm);
    }

    // The sales half's own bricks, for the areas this territory carries. A brick already emitted
    // above is skipped; one that is new here is a `sales-no-list` row, which is the board's point.
    for (const sale of input.sales) {
      if (!sale.brickId || seen.has(sale.brickId)) continue;
      if (!areaSet.has(up(sale.areaCode))) continue;
      seen.add(sale.brickId);
      emit(sale.brickId, null);
    }
  }

  rows.sort(
    (left, right) =>
      STATUS_ORDER[left.status] - STATUS_ORDER[right.status]
      || right.sales - left.sales
      || right.customers - left.customers
      || left.brickName.localeCompare(right.brickName)
      || left.territoryName.localeCompare(right.territoryName),
  );

  const summary: BrickCoverageSummary = {
    bricks: rows.length,
    withSales: rows.filter((row) => row.sales > 0).length,
    salesNoList: rows.filter((row) => row.status === "sales-no-list").length,
    listNoSales: rows.filter((row) => row.status === "list-no-sales").length,
    covered: rows.filter((row) => row.status === "covered").length,
    brickSales: rows.reduce((total, row) => total + row.sales, 0),
  };

  return { rows, summary, salesMonths: [...input.salesMonths], caveat: BRICK_SALES_CAVEAT };
}
