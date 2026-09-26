// Business Review — where a scope's money actually came from.
//
// "Is he selling across all his bricks, or almost all of them, or only one? Is the bulk of it one
// customer? Is it distributor sales, wholesaler sales, or direct?" (owner, 2026-09-26). None of
// those can be answered from the source the review has read until now: `AchievementRow` is grained
// at period × line × region × area × rep seat × product and carries no brick, no customer, no
// distributor and no channel at all. They come from the Monthly Closing's own detail rows.
//
// THIS MODULE IS PURE. It takes rows that the caller has already loaded, scoped and MASKED, and
// answers the three questions. It reads no database and imports nothing from the sales loaders, so
// it can be tested on fixtures and rendered on the client.
//
// FOUR RULES IT DOES NOT GET TO DECIDE, and the caller must have applied before calling:
//
//   1. THE AREA IS THE CLOSING'S AREA. A detail row carries two — the distributor sheet's own
//      (`sheetAreaCode`) and the one resolved from the customer's brick (`areaCode`) — and every
//      closing RPC books by the first. Callers pass `closingAreaOf(row)`, or a filtered export and
//      this page disagree about which area a hand-apportioned customer sold in.
//   2. EL QEMA LEAVES NO TRACE IN A CLOSING DETAIL. Its rows are REMOVED for everyone but the
//      Super Admin (`closing-source-mask.ts`), so a pack built for a district manager must be
//      masked BEFORE it reaches this module. Masking afterwards would leak the name through a
//      concentration figure that no longer adds up.
//   3. NO DISTRIBUTOR'S BONUS IS COUNTED FROM SEPTEMBER 2026. A sale is units × factory price.
//   4. A DIRECT ORDER COUNTS IN THE MONTH FINANCE BOOKS IT, at its pharmacy's own brick and area.
//
// WHOLESALER IS A NAME RULE, NOT A FLAG. There is no column saying a customer is a warehouse;
// `classifyCustomerChannel` in src/lib/sales/customer-channel.ts is the one authority, and it is
// the same one the closing's city split and the venue guard already use. This module never
// re-implements it — the caller classifies and passes the answer in.

/** One closing detail row, reduced to what these three questions need. */
export type ReviewSalesDetail = {
  period: string;
  /** `closingAreaOf(row)` — the area the CLOSING books it in. See rule 1 above. */
  areaCode: string;
  brickId: string;
  brickName: string;
  clientCode: string;
  clientName: string;
  /**
   * Which of the three ways this pound reached the market. `wholesaler` is a customer that
   * `classifyCustomerChannel` calls a store; `direct` is a row from the direct-order book rather
   * than a distributor's sheet.
   */
  channel: SalesChannel;
  /** Sales value in EGP, already net of the rules above. */
  value: number;
};

export type SalesChannel = "distributor" | "wholesaler" | "direct";

export const SALES_CHANNELS: readonly SalesChannel[] = ["distributor", "wholesaler", "direct"];

/** One contributor and what proportion of the whole it carried. `share` is 0–100. */
export type ContributorShare = {
  key: string;
  label: string;
  value: number;
  share: number;
};

export type ContributorSpread = {
  /** How many distinct contributors carried any value at all. */
  count: number;
  /** Largest first, capped by `topN`. */
  top: ContributorShare[];
  /** The largest one's share of the total, 0–100, or null when there is no value to divide. */
  topShare: number | null;
  /**
   * How many contributors it takes to reach HALF the value, largest first — the plainest reading
   * of "is it spread or is it one". 1 means half the money came from a single brick or customer.
   * Null when there is no value.
   */
  halfFrom: number | null;
};

export type ConcentrationFacts = {
  totalValue: number;
  bricks: ContributorSpread;
  customers: ContributorSpread;
  /** EGP per channel. The three sum to `totalValue`. */
  channels: Record<SalesChannel, number>;
};

function emptySpread(): ContributorSpread {
  return { count: 0, halfFrom: null, top: [], topShare: null };
}

/**
 * Roll one bag of rows up into a spread over whatever key `keyOf` picks.
 *
 * A contributor with zero or negative value is COUNTED OUT of `count` rather than ranked at the
 * bottom: a return that cancels a sale leaves a customer who bought nothing this window, and
 * "he sells to 41 customers" must not include four who only sent stock back.
 */
function spreadOf(
  rows: readonly ReviewSalesDetail[],
  keyOf: (row: ReviewSalesDetail) => { key: string; label: string },
  topN: number,
): ContributorSpread {
  const totals = new Map<string, ContributorShare>();
  for (const row of rows) {
    if (!Number.isFinite(row.value)) continue;
    const { key, label } = keyOf(row);
    if (!key) continue;
    const seen = totals.get(key);
    if (seen) seen.value += row.value;
    else totals.set(key, { key, label, share: 0, value: row.value });
  }

  const ranked = [...totals.values()].filter((c) => c.value > 0).sort((a, b) => b.value - a.value);
  const total = ranked.reduce((sum, c) => sum + c.value, 0);
  if (ranked.length === 0 || total <= 0) return emptySpread();

  for (const contributor of ranked) contributor.share = (contributor.value / total) * 100;

  let running = 0;
  let halfFrom = ranked.length;
  for (let i = 0; i < ranked.length; i += 1) {
    running += ranked[i].value;
    if (running * 2 >= total) {
      halfFrom = i + 1;
      break;
    }
  }

  return {
    count: ranked.length,
    halfFrom,
    top: ranked.slice(0, Math.max(0, topN)),
    topShare: ranked[0].share,
  };
}

/**
 * The three answers for one scope — a rep's areas, a district, a region, a line, the company.
 *
 * The caller decides the scope by filtering the rows it passes; this function never knows whose
 * money it is looking at, which is what keeps one implementation honest at every level.
 */
export function buildConcentration(
  rows: readonly ReviewSalesDetail[],
  { topN = 5 }: { topN?: number } = {},
): ConcentrationFacts {
  const channels: Record<SalesChannel, number> = { direct: 0, distributor: 0, wholesaler: 0 };
  let totalValue = 0;
  for (const row of rows) {
    if (!Number.isFinite(row.value)) continue;
    totalValue += row.value;
    channels[row.channel] += row.value;
  }

  return {
    bricks: spreadOf(rows, (r) => ({ key: r.brickId, label: r.brickName || r.brickId }), topN),
    channels,
    customers: spreadOf(rows, (r) => ({ key: r.clientCode, label: r.clientName || r.clientCode }), topN),
    totalValue,
  };
}

/**
 * The same three answers, for one scope named by its AREAS.
 *
 * A district is its areas; a rep is his. The rows carry the area the CLOSING books them in, so a
 * hand-apportioned customer lands in the district that the published sheet credits rather than the
 * one its brick sits in — which is the whole reason `closingAreaOf` exists.
 *
 * Area codes are compared upper-cased: they reach this code from the sheet, the brick master and
 * the organogram, and the three do not agree on case.
 */
export function concentrationForAreas(
  rows: readonly ReviewSalesDetail[],
  areaCodes: Iterable<string | null | undefined>,
  options?: { topN?: number },
): ConcentrationFacts {
  const keep = new Set<string>();
  for (const code of areaCodes) {
    const key = String(code ?? "").trim().toUpperCase();
    if (key) keep.add(key);
  }
  if (keep.size === 0) return buildConcentration([], options);
  return buildConcentration(rows.filter((row) => keep.has(row.areaCode.toUpperCase())), options);
}

/**
 * The one-line reading a manager wants under a chart: how spread this scope's selling is.
 *
 * Deliberately three plain bands rather than a score. The thresholds are the owner's question in
 * his own terms — "all of his bricks, or almost of them, or only one" — and a number like a
 * Herfindahl index answers a question nobody asked.
 */
export function describeSpread(spread: ContributorSpread, noun: string): string {
  if (spread.count === 0 || spread.topShare == null) return `No ${noun} carried sales in this window.`;
  if (spread.count === 1) return `Every pound came from one ${noun}: ${spread.top[0].label}.`;
  if (spread.topShare >= 50) {
    return `Concentrated — ${spread.top[0].label} alone carried ${spread.topShare.toFixed(0)}% of ${spread.count} ${noun}s.`;
  }
  // NARROW IS A FRACTION, NEVER A COUNT. "Half the value from 2" is the definition of an even
  // spread when there are four of them and a real warning when there are forty, so the band has to
  // read `halfFrom` against `count`. A flat `halfFrom <= 2` called four evenly-selling bricks
  // narrow, which the test below caught before this ever rendered.
  if (spread.halfFrom != null && spread.count >= 4 && spread.halfFrom / spread.count <= 0.25) {
    return `Narrow — half the value came from ${spread.halfFrom} of ${spread.count} ${noun}s.`;
  }
  return `Spread — ${spread.count} ${noun}s carried sales, the largest ${spread.topShare.toFixed(0)}%.`;
}

/**
 * Marketing spend read against the area's own direction of travel (owner, 2026-09-26: "this area
 * needs marketing request cost of X, and its sales is declining, is growing").
 *
 * `direction` compares the LAST figure month to the one before it, so it answers "where is this
 * going" rather than "what did the window total". A window of one month cannot have a direction
 * and says so rather than printing a flat 0% that reads as "no change".
 */
export type AreaSpendTrend = {
  areaCode: string;
  area: string;
  marketingCommitted: number;
  outstationClaimed: number;
  salesFirst: number;
  salesLast: number;
  /** Percent change from the first figure month to the last, or null when there is only one. */
  changePct: number | null;
  direction: "growing" | "declining" | "flat" | "unknown";
};

export function areaSpendTrend(input: {
  areaCode: string;
  area: string;
  marketingCommitted: number;
  outstationClaimed: number;
  salesByMonth: Readonly<Record<string, number>>;
  /** The figure window's months, ascending. */
  months: readonly string[];
}): AreaSpendTrend {
  const months = input.months.filter((m) => m in input.salesByMonth);
  const base = {
    area: input.area,
    areaCode: input.areaCode,
    marketingCommitted: input.marketingCommitted,
    outstationClaimed: input.outstationClaimed,
  };
  if (months.length < 2) {
    const only = months.length === 1 ? (input.salesByMonth[months[0]] ?? 0) : 0;
    return { ...base, changePct: null, direction: "unknown", salesFirst: only, salesLast: only };
  }
  const salesFirst = input.salesByMonth[months[0]] ?? 0;
  const salesLast = input.salesByMonth[months[months.length - 1]] ?? 0;
  // A month that sold nothing has no percentage to grow BY — reporting "+100%" off a zero base is
  // the classic way a single small invoice reads as a doubling.
  const changePct = salesFirst > 0 ? ((salesLast - salesFirst) / salesFirst) * 100 : null;
  const direction =
    changePct == null
      ? salesLast > 0
        ? "growing"
        : "unknown"
      : changePct > 2
        ? "growing"
        : changePct < -2
          ? "declining"
          : "flat";
  return { ...base, changePct, direction, salesFirst, salesLast };
}
