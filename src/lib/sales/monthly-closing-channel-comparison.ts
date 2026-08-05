import {
  HOSPITAL_NAME_KEYWORDS,
  normalizeCustomerName,
  STORE_NAME_KEYWORDS,
  type CustomerChannel,
} from "@/lib/sales/customer-channel";
import { RESTRICTED_PRODUCT_CODES } from "@/lib/sales/access-scope";
import { loadMonthlyTargets, resolveTargetLineCode } from "@/lib/sales/monthly-targets";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// Monthly Closing — Channel Comparison across months.
//
// Hospitals vs Stores (wholesalers) vs Pharmacies, month by month, in units, value and distinct
// customers. Feeds the "Channel Comparison" sheet of the downloaded closing workbook.
//
// WHY THIS DOES NOT READ THE HIDDEN Calc SHEET LIKE EVERY OTHER SHEET: Calc holds
// Distributor | Region | Area | Product | Units | Value — no customer NAME and no month. The
// channel is derived from the name and the sheet compares months, so Calc cannot express either
// half. See writeChannelComparisonSheet for what that means for the cells.
//
// WHY IT DOES NOT READ loadMonthlyClosingComparison PER MONTH EITHER (the obvious shortcut):
// that loader's customer rows come from phx_closing_customers, which
//   * returns the MAPPED customer name, blank for ~25% of customers (434 of 1,733 on Anti
//     Infective 2026-01, worth 148,263 EGP) — all of which then fall to "pharmacy"; and
//   * drops DIRECT orders entirely, because they carry no client_code.
// Both were measured against the owner's reviewed figures and both moved real money between
// channels. phx_closing_channel_totals exists to answer this one question properly, and it is a
// single round trip for the whole sheet rather than one per month.
//
// TARGETS ARE NOT SPLIT PER CHANNEL. They are keyed (month, line, area, product) and carry no
// channel dimension, so a per-channel target would be a number Phoenix invented. The sheet shows
// the MONTH TOTAL target beside the channel split instead — a real figure that happens not to
// attribute to a channel — which is what the owner chose when told the constraint.
// ─────────────────────────────────────────────────────────────────────────────

export type ChannelCell = {
  /** DISTINCT customers, never a row count — see the RPC's own comment. */
  customers: number;
  units: number;
  value: number;
};

export type ChannelComparisonRow = {
  channel: CustomerChannel;
  /** Human-readable, never a code — the owner's standing rule for every surface. */
  label: string;
  byPeriod: Record<string, ChannelCell>;
  total: ChannelCell;
};

/** The month total target. Null where no target was ever set — never 0, which would read as
 * "asked to sell nothing" and turn achievement into a division by nothing. */
export type ChannelPeriodTarget = {
  targetUnits: number | null;
  targetValue: number | null;
};

export type ChannelComparison = {
  line: string | null;
  /** Oldest to newest. A calendar order, never the order the loader happened to return. */
  periods: string[];
  rows: ChannelComparisonRow[];
  totalsByPeriod: Record<string, ChannelCell>;
  targetsByPeriod: Record<string, ChannelPeriodTarget>;
  /** Every channel, every month — the bottom-right corner of the value block. */
  grandTotal: ChannelCell;
  /**
   * Whether the restricted products (LA003 / LA004 / SS001) are inside these figures. They are
   * stripped by default for everyone and only a CEO or Super Admin who opts in may reveal them,
   * and the two views are a completely different picture rather than a rounding difference — so
   * the sheet states which one produced it.
   */
  restrictedProductsIncluded: boolean;
};

/** Fixed display order: the two channels a decision usually turns on first, then the bulk. */
export const CHANNEL_ORDER: ReadonlyArray<{ channel: CustomerChannel; label: string }> = [
  { channel: "hospital", label: "Hospitals" },
  { channel: "store", label: "Stores (wholesalers)" },
  { channel: "pharmacy", label: "Pharmacies" },
];

export function emptyChannelCell(): ChannelCell {
  return { customers: 0, units: 0, value: 0 };
}

/** Sum cells. Customers add up across CHANNELS (a customer is in exactly one) but NOT across
 * months, where the same pharmacy buying every month would be counted every time — so a row's
 * `total.customers` is deliberately the peak month, not the sum. See addAcrossPeriods. */
export function addChannelCells(left: ChannelCell, right: ChannelCell): ChannelCell {
  return {
    customers: left.customers + right.customers,
    units: left.units + right.units,
    value: left.value + right.value,
  };
}

/**
 * Roll a channel's months into its row total. Units and value SUM — those are genuinely different
 * sales. Customers take the MAXIMUM month instead: the RPC counts distinct customers within a
 * month, and adding January's 1,716 pharmacies to February's 1,620 would report 3,336 pharmacies
 * for a line that has about 1,700, because almost every one of them bought in both months. The
 * busiest single month is the honest "how many customers does this channel have" answer the sheet
 * can give without a second, customer-level query.
 */
export function addAcrossPeriods(cells: readonly ChannelCell[]): ChannelCell {
  return cells.reduce<ChannelCell>(
    (total, cell) => ({
      customers: Math.max(total.customers, cell.customers),
      units: total.units + cell.units,
      value: total.value + cell.value,
    }),
    emptyChannelCell(),
  );
}

/** A channel's share of its month. Zero when the month sold nothing — never a division by zero. */
export function channelShare(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

export type ChannelTotalsRow = {
  period: string;
  channel: string;
  customers: number;
  units: number;
  value: number;
};

/**
 * Shape the RPC's (period, channel) rows into the sheet's structure.
 *
 * Pure and exported so a test can exercise every block of the sheet without a database. Periods
 * are sorted ascending here rather than trusted from the caller, because the sheet is read left to
 * right as a trend and a month out of order silently turns a rise into a fall. `YYYY-MM` sorts
 * correctly as a string, which is exactly why the format is used throughout.
 */
export function assembleChannelComparison(input: {
  line: string | null;
  rows: readonly ChannelTotalsRow[];
  targetsByPeriod?: Record<string, ChannelPeriodTarget>;
  restrictedProductsIncluded: boolean;
}): ChannelComparison {
  const { line, rows, restrictedProductsIncluded } = input;

  // Only months the line actually traded in. A month with no import batch for this line is "no
  // data", not "sold nothing", and a zero column would read as the second.
  const periods = [...new Set(rows.map((row) => row.period).filter((period) => period.trim() !== ""))].sort();

  const comparisonRows: ChannelComparisonRow[] = CHANNEL_ORDER.map((entry) => {
    const byPeriod: Record<string, ChannelCell> = {};
    for (const period of periods) {
      const match = rows.find((row) => row.period === period && row.channel === entry.channel);
      byPeriod[period] = match
        ? { customers: match.customers, units: match.units, value: match.value }
        : emptyChannelCell();
    }
    return {
      byPeriod,
      channel: entry.channel,
      label: entry.label,
      total: addAcrossPeriods(periods.map((period) => byPeriod[period])),
    };
  });

  const totalsByPeriod: Record<string, ChannelCell> = {};
  for (const period of periods) {
    totalsByPeriod[period] = comparisonRows
      .map((row) => row.byPeriod[period])
      .reduce(addChannelCells, emptyChannelCell());
  }

  return {
    grandTotal: addAcrossPeriods(periods.map((period) => totalsByPeriod[period])),
    line,
    periods,
    restrictedProductsIncluded,
    rows: comparisonRows,
    targetsByPeriod: input.targetsByPeriod ?? {},
    totalsByPeriod,
  };
}

/**
 * The month total target for one line, summed over every area and product it was set for.
 *
 * A month nobody set a target for reports nulls rather than zeros — the Target vs Achievement
 * sheet makes the same distinction for the same reason.
 */
export function sumLineTargets(
  rows: readonly { lineCode: string; targetUnits: number | null; targetValue: number | null }[],
  targetLineCode: string | null,
): ChannelPeriodTarget {
  if (!targetLineCode) return { targetUnits: null, targetValue: null };
  const mine = rows.filter((row) => row.lineCode === targetLineCode);
  if (mine.length === 0) return { targetUnits: null, targetValue: null };
  const units = mine.reduce((sum, row) => sum + (row.targetUnits ?? 0), 0);
  const value = mine.reduce((sum, row) => sum + (row.targetValue ?? 0), 0);
  return {
    targetUnits: mine.some((row) => row.targetUnits != null) ? units : null,
    targetValue: mine.some((row) => row.targetValue != null) ? value : null,
  };
}

/**
 * Build the comparison for one line across the given months.
 *
 * ONE round trip for the whole channel block — the stems and the confidential-product list travel
 * as parameters so `customer-channel.ts` and `access-scope.ts` stay the single sources of both
 * vocabularies (a hand-transcribed copy of those six words once mis-stated the store channel by
 * 8.7M EGP). Targets are then read per month in parallel, and a targets outage degrades the
 * target block to blanks rather than failing the export — the sales figures are the headline and
 * stand on their own.
 */
export async function loadMonthlyClosingChannelComparison(
  line: string | null,
  periods: readonly string[],
  options?: { includeRestrictedProducts?: boolean },
): Promise<ChannelComparison> {
  const includeRestricted = options?.includeRestrictedProducts === true;
  const wanted = [...new Set(periods.filter((period) => typeof period === "string" && period.trim() !== ""))].sort();
  if (!line || wanted.length === 0) {
    return assembleChannelComparison({ line, restrictedProductsIncluded: includeRestricted, rows: [] });
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_closing_channel_totals", {
    p_exclude_codes: includeRestricted ? [] : [...RESTRICTED_PRODUCT_CODES],
    p_hospital_stems: HOSPITAL_NAME_KEYWORDS.map((keyword) => normalizeCustomerName(keyword.stem)),
    p_line: line,
    p_periods: wanted,
    p_store_stems: STORE_NAME_KEYWORDS.map((keyword) => normalizeCustomerName(keyword.stem)),
  });
  if (error) throw error;

  const rows: ChannelTotalsRow[] = ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    channel: String(row.channel ?? ""),
    customers: Number(row.customers ?? 0),
    period: String(row.period ?? ""),
    units: Number(row.units ?? 0),
    value: Number(row.value ?? 0),
  }));

  const targetLineCode = resolveTargetLineCode(line);
  const tradedPeriods = [...new Set(rows.map((row) => row.period))].sort();
  const targetsByPeriod: Record<string, ChannelPeriodTarget> = {};
  if (targetLineCode) {
    const loaded = await Promise.all(
      tradedPeriods.map((period) =>
        loadMonthlyTargets(period)
          .then((targetRows) => ({ period, target: sumLineTargets(targetRows, targetLineCode) }))
          .catch(() => ({ period, target: { targetUnits: null, targetValue: null } as ChannelPeriodTarget })),
      ),
    );
    for (const entry of loaded) targetsByPeriod[entry.period] = entry.target;
  }

  return assembleChannelComparison({
    line,
    restrictedProductsIncluded: includeRestricted,
    rows,
    targetsByPeriod,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The same channel split, but cutting ONE month four ways: by product, by rep, by area and by
// brick. Feeds the "Channel by Product / Rep / Area / Brick" sheet.
//
// EVERY GRID SUMS TO THE MONTH. That is the property worth protecting: money that cannot be
// attributed gets a visible bucket row rather than being dropped, because a grid that quietly adds
// up to less than the Closing Matrix is what gets questioned. Direct orders carry no area and no
// brick at all, so they can only ever appear as their own row in those two grids — and in the rep
// grid, where no seat owns them.
// ─────────────────────────────────────────────────────────────────────────────

export type ChannelBreakdownDimension = "product" | "rep" | "area" | "brick";

export type ChannelBreakdownRow = {
  /** Product code, area code, brick id, rep HR id — or one of the bucket keys below. */
  key: string;
  /** Resolved by resolveBreakdownLabel; the loader leaves the RPC's own label here. */
  label: string;
  hospital: number;
  store: number;
  pharmacy: number;
  total: number;
};

export type ChannelBreakdown = {
  line: string | null;
  period: string | null;
  restrictedProductsIncluded: boolean;
  byDimension: Record<ChannelBreakdownDimension, ChannelBreakdownRow[]>;
};

export const BREAKDOWN_DIMENSIONS: ReadonlyArray<ChannelBreakdownDimension> = ["product", "rep", "area", "brick"];

/** The bucket keys the RPC emits for money that reaches no product, rep, area or brick. */
export const BREAKDOWN_BUCKET_PREFIX = "__";
const VACANT_PREFIX = "__VACANT__:";

/**
 * What a bucket row is CALLED, in plain words, per grid.
 *
 * Deliberately explicit about the cause rather than a shrug like "Other": the reader has to be able
 * to tell "this money exists but has no brick on the invoice" from "this area has no rep" without
 * asking anybody. Direct orders reach the closing from the Direct Orders module rather than a
 * distributor invoice line, and those rows carry no area and no brick at all — so they are named as
 * a channel of their own wherever geography is the axis.
 */
export function bucketLabel(dimension: ChannelBreakdownDimension, key: string, rpcLabel: string): string | null {
  if (key === "__DIRECT__") {
    if (dimension === "rep") return "Direct orders (company) — no rep seat owns them";
    if (dimension === "area") return "Direct orders (company) — no area on the row";
    if (dimension === "brick") return "Direct orders (company) — no brick on the row";
    return "Direct orders (company)";
  }
  if (key === "__NO_BRICK__") return "Distributor sales whose brick did not map";
  if (key === "__NO_AREA__") return "Distributor sales with no area on the row";
  if (key === "__NO_PRODUCT__") return "Sales with no product code";
  if (key === "__NO_SEAT__") return "Not on the seat model — no rep owns this area";
  if (key.startsWith(VACANT_PREFIX)) {
    const area = rpcLabel.trim();
    return area ? `Vacant seat — ${area}` : "Vacant seat";
  }
  return null;
}

/** Master name maps the workbook already holds, so a grid never invents a name of its own. */
export type BreakdownNameMaps = {
  areaName: ReadonlyMap<string, string>;
  brickName: ReadonlyMap<string, string>;
  productName: ReadonlyMap<string, string>;
};

/**
 * A row's display name: the bucket wording when it is a bucket, else the workbook's own master
 * name, else whatever the RPC could supply, else the raw key. Never blank and never an ellipsis —
 * a nameless row is worse than a coded one.
 */
export function resolveBreakdownLabel(
  dimension: ChannelBreakdownDimension,
  row: ChannelBreakdownRow,
  maps: BreakdownNameMaps,
): string {
  const bucket = bucketLabel(dimension, row.key, row.label);
  if (bucket) return bucket;
  const key = row.key.trim();
  const upper = key.toUpperCase();
  const fromMaster = dimension === "area"
    ? maps.areaName.get(upper)
    : dimension === "brick"
      ? maps.brickName.get(upper)
      : dimension === "product"
        ? maps.productName.get(upper)
        : undefined;
  return fromMaster || row.label.trim() || key;
}

/** The dominant channel of a row and its share, for the Leader column the sibling grids use. */
export function breakdownLeader(row: ChannelBreakdownRow): { label: string; share: number } | null {
  if (row.total <= 0) return null;
  const candidates: ReadonlyArray<{ label: string; value: number }> = [
    { label: "Hospitals", value: row.hospital },
    { label: "Stores", value: row.store },
    { label: "Pharmacies", value: row.pharmacy },
  ];
  const best = candidates.reduce((top, entry) => (entry.value > top.value ? entry : top), candidates[0]);
  if (best.value <= 0) return null;
  return { label: best.label, share: best.value / row.total };
}

type BreakdownRpcRow = {
  dimension: string;
  key: string;
  label: string;
  hospital: number;
  store: number;
  pharmacy: number;
  total: number;
};

/** Shape the RPC's flat rows into one list per dimension. Pure, so a test needs no database. */
export function assembleChannelBreakdown(input: {
  line: string | null;
  period: string | null;
  restrictedProductsIncluded: boolean;
  rows: readonly BreakdownRpcRow[];
}): ChannelBreakdown {
  const byDimension = {
    area: [] as ChannelBreakdownRow[],
    brick: [] as ChannelBreakdownRow[],
    product: [] as ChannelBreakdownRow[],
    rep: [] as ChannelBreakdownRow[],
  } satisfies Record<ChannelBreakdownDimension, ChannelBreakdownRow[]>;

  for (const raw of input.rows) {
    const dimension = raw.dimension as ChannelBreakdownDimension;
    if (!BREAKDOWN_DIMENSIONS.includes(dimension)) continue;
    byDimension[dimension].push({
      hospital: Number(raw.hospital ?? 0),
      key: String(raw.key ?? ""),
      label: String(raw.label ?? ""),
      pharmacy: Number(raw.pharmacy ?? 0),
      store: Number(raw.store ?? 0),
      total: Number(raw.total ?? 0),
    });
  }
  // Biggest first inside each grid. The RPC already orders this way; re-sorting here means the
  // sheet cannot be silently re-ordered by a change to the RPC's ORDER BY.
  for (const dimension of BREAKDOWN_DIMENSIONS) {
    byDimension[dimension].sort((left, right) => right.total - left.total || left.key.localeCompare(right.key));
  }

  return {
    byDimension,
    line: input.line,
    period: input.period,
    restrictedProductsIncluded: input.restrictedProductsIncluded,
  };
}

/** Sum a grid, for the TOTAL row and for the tie-back check the sheet states. */
export function sumBreakdownRows(rows: readonly ChannelBreakdownRow[]): ChannelBreakdownRow {
  return rows.reduce<ChannelBreakdownRow>(
    (total, row) => ({
      hospital: total.hospital + row.hospital,
      key: "TOTAL",
      label: "TOTAL",
      pharmacy: total.pharmacy + row.pharmacy,
      store: total.store + row.store,
      total: total.total + row.total,
    }),
    { hospital: 0, key: "TOTAL", label: "TOTAL", pharmacy: 0, store: 0, total: 0 },
  );
}

/**
 * One month, four cuts, ONE round trip. Same parameters and therefore the same vocabulary as
 * loadMonthlyClosingChannelComparison — the stems and the confidential list travel from
 * customer-channel.ts and access-scope.ts rather than being restated in SQL.
 */
export async function loadMonthlyClosingChannelBreakdown(
  line: string | null,
  period: string | null,
  options?: { includeRestrictedProducts?: boolean },
): Promise<ChannelBreakdown> {
  const includeRestricted = options?.includeRestrictedProducts === true;
  if (!line || !period) {
    return assembleChannelBreakdown({ line, period, restrictedProductsIncluded: includeRestricted, rows: [] });
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_closing_channel_breakdown", {
    p_exclude_codes: includeRestricted ? [] : [...RESTRICTED_PRODUCT_CODES],
    p_hospital_stems: HOSPITAL_NAME_KEYWORDS.map((keyword) => normalizeCustomerName(keyword.stem)),
    p_line: line,
    p_period: period,
    p_store_stems: STORE_NAME_KEYWORDS.map((keyword) => normalizeCustomerName(keyword.stem)),
  });
  if (error) throw error;

  return assembleChannelBreakdown({
    line,
    period,
    restrictedProductsIncluded: includeRestricted,
    rows: (data ?? []) as BreakdownRpcRow[],
  });
}
