import {
  HOSPITAL_NAME_KEYWORDS,
  normalizeCustomerName,
  PHARMACY_OVERRIDE_CLIENT_CODES,
  STORE_NAME_KEYWORDS,
  STORE_OVERRIDE_CUSTOMER_KEYS,
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
// NOTHING IS DROPPED AND NOTHING IS GUESSED (2026-08-06). Two silent misattributions shipped with
// the first version of these sheets and are closed by migration
// 20260806160000_closing_channel_unattributed_buckets.sql, which carries the measured cost of each:
//
//   * a `client_code is not null` filter on the retail half DROPPED money outright — CNS was short
//     4,363,635.38 of 8,354,429.79 in 2026-05 and short in five other months, while Anti Infective
//     and Pedia were clean in every 2026 month, which is why it survived review; and
//   * a direct order with no customer name was keyed 'name:' || fold(''), which is never null, so
//     the channel CASE fell through to `else 'pharmacy'` and filed it as retail pharmacy business.
//     Anti Infective 2026-07 printed Pharmacies 450,035.45 against a true 356,481.45 — overstated
//     26.2% — and Pedia 2026-07 carried 534,713.65 that way, 38% of the month.
//
// Both now land in named buckets (see CHANNEL_ORDER). The rule this file keeps: a channel is a
// VERDICT about a customer, so money with no customer to judge never gets one. It gets a row that
// says what is missing, and the sheet's own self-check ties every month to an independently
// re-aggregated population so the next silent filter cannot hide either.
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

/**
 * This sheet's row vocabulary: the three real channels, plus the three reasons a row can carry no
 * channel at all.
 *
 * Deliberately NOT extra members of `CustomerChannel`. That type is the CLASSIFIER's output — a
 * verdict about a customer's name — and the store city split keys on its "store" member. These
 * three are the opposite of a verdict: there is nothing to judge, so the sheet needs somewhere to
 * put the money without pretending to have classified it.
 */
export type ChannelComparisonChannel =
  | CustomerChannel
  | "unidentified_no_code"
  | "unidentified_no_name"
  | "direct_unnamed";

/** The channel values the RPCs emit for money that reaches no customer. Order matters: display. */
export const UNATTRIBUTED_CHANNELS = [
  "unidentified_no_code",
  "unidentified_no_name",
  "direct_unnamed",
] as const satisfies ReadonlyArray<ChannelComparisonChannel>;

export function isUnattributedChannel(channel: string): boolean {
  return (UNATTRIBUTED_CHANNELS as readonly string[]).includes(channel);
}

export type ChannelComparisonRow = {
  channel: ChannelComparisonChannel;
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

/**
 * One month's answer to "does this sheet hold the whole month".
 *
 * `population` is re-aggregated inside the RPC from the source tables with the guards WRITTEN OUT
 * AGAIN rather than reused, so it does not move when the channel query does. `difference` is what
 * the sheet prints, and it is the number the old sheet could not have printed: its self-check tied
 * only the exported month, and a CNS July export read "Difference 0.00" while the six month blocks
 * above it were short by up to 4.36M each.
 */
export type ChannelSelfCheck = {
  period: string;
  /** The month as this sheet's own channel rows add up. */
  sheetUnits: number;
  sheetValue: number;
  /** The month as the source tables add up, counted a second and independent time. */
  populationUnits: number;
  populationValue: number;
  /** sheet − population. Anything but zero means this sheet is not the whole month. */
  differenceUnits: number;
  differenceValue: number;
  /** True when both differences round to zero at 2dp — the money the sheet actually displays. */
  ok: boolean;
  /**
   * False when the database has not been migrated and the RPC returned no independent total, so
   * there was nothing to check against.
   *
   * Kept as its own flag rather than letting a missing figure default to the sheet's own — that
   * would make the difference zero and print OK, which is precisely the "0.00 and it is a lie"
   * behaviour this whole block exists to remove. The sheet says NOT CHECKED instead.
   */
  populationAvailable: boolean;
};

export type ChannelComparison = {
  line: string | null;
  /** Oldest to newest. A calendar order, never the order the loader happened to return. */
  periods: string[];
  rows: ChannelComparisonRow[];
  totalsByPeriod: Record<string, ChannelCell>;
  targetsByPeriod: Record<string, ChannelPeriodTarget>;
  /**
   * EVERY month this sheet displays, checked — not only the exported one. Same order as `periods`.
   * Empty only when the sheet has no months at all.
   */
  selfCheck: ChannelSelfCheck[];
  /** The worst month, so the sheet can lead with the failure rather than bury it. Null when clean. */
  worstSelfCheck: ChannelSelfCheck | null;
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

/**
 * Fixed display order: the two channels a decision usually turns on first, then the bulk, then the
 * money that reaches no customer at all.
 *
 * The three unattributed rows are LAST and are dropped entirely when they carry nothing (see
 * assembleChannelComparison), so the three lines with a real customer behind them stay the shape of
 * the sheet and a clean line never grows a row of zeroes. Each names its own CAUSE rather than
 * shrugging "Other", because the cause is the fix: a missing client code is a distributor file
 * problem, a missing name is a directory problem, and an unnamed direct order is a Direct Orders
 * module problem. One bucket would have hidden which.
 */
export const CHANNEL_ORDER: ReadonlyArray<{ channel: ChannelComparisonChannel; label: string }> = [
  { channel: "hospital", label: "Hospitals" },
  { channel: "store", label: "Stores (wholesalers)" },
  { channel: "pharmacy", label: "Pharmacies" },
  { channel: "unidentified_no_code", label: "Unidentified — no client code on the line" },
  { channel: "unidentified_no_name", label: "Unidentified — client code with no name" },
  { channel: "direct_unnamed", label: "Direct orders — no customer name" },
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
/**
 * The pseudo-channel the RPC uses for its independent re-aggregation of a month. Never displayed as
 * a channel — it is what the sheet checks ITSELF against.
 */
export const POPULATION_CHANNEL = "__population__";

/** Money rounds to the piastre for display; a difference smaller than that is not a difference. */
function tiesAtDisplayPrecision(difference: number): boolean {
  return Math.abs(Number(difference.toFixed(2))) < 0.005;
}

export function assembleChannelComparison(input: {
  line: string | null;
  rows: readonly ChannelTotalsRow[];
  targetsByPeriod?: Record<string, ChannelPeriodTarget>;
  restrictedProductsIncluded: boolean;
}): ChannelComparison {
  const { line, rows, restrictedProductsIncluded } = input;

  const channelRows = rows.filter((row) => row.channel !== POPULATION_CHANNEL);
  const populationRows = rows.filter((row) => row.channel === POPULATION_CHANNEL);

  // Only months the line actually traded in. A month with no import batch for this line is "no
  // data", not "sold nothing", and a zero column would read as the second. Population rows count
  // towards this too: a month whose whole value went missing must still get a column, or the sheet
  // would answer "there was no such month" instead of "this sheet lost it".
  const periods = [...new Set(
    [...channelRows, ...populationRows].map((row) => row.period).filter((period) => period.trim() !== ""),
  )].sort();

  const comparisonRows: ChannelComparisonRow[] = CHANNEL_ORDER.map((entry) => {
    const byPeriod: Record<string, ChannelCell> = {};
    for (const period of periods) {
      const match = channelRows.find((row) => row.period === period && row.channel === entry.channel);
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
  })
    // The three real channels are the sheet's fixed shape and always appear, even at zero — a line
    // that sold nothing to a hospital this month is information. The unattributed rows are an
    // exception report, so each appears only when it has something to report. On a clean line the
    // sheet is byte-identical to before.
    .filter((row) =>
      !isUnattributedChannel(row.channel) || row.total.units !== 0 || row.total.value !== 0);

  const totalsByPeriod: Record<string, ChannelCell> = {};
  for (const period of periods) {
    totalsByPeriod[period] = comparisonRows
      .map((row) => row.byPeriod[period])
      .reduce(addChannelCells, emptyChannelCell());
  }

  // EVERY month, not just the exported one. `totalsByPeriod` is what the sheet actually prints —
  // the sum of the rows it displays — so a channel value the RPC invents tomorrow and CHANNEL_ORDER
  // does not list shows up here as a difference instead of vanishing.
  const selfCheck: ChannelSelfCheck[] = periods.map((period) => {
    const sheet = totalsByPeriod[period] ?? emptyChannelCell();
    const population = populationRows.find((row) => row.period === period);
    const populationUnits = population?.units ?? sheet.units;
    const populationValue = population?.value ?? sheet.value;
    const differenceUnits = sheet.units - populationUnits;
    const differenceValue = sheet.value - populationValue;
    return {
      differenceUnits,
      differenceValue,
      ok: tiesAtDisplayPrecision(differenceUnits) && tiesAtDisplayPrecision(differenceValue),
      period,
      populationAvailable: population !== undefined,
      populationUnits,
      populationValue,
      sheetUnits: sheet.units,
      sheetValue: sheet.value,
    };
  });

  return {
    grandTotal: addAcrossPeriods(periods.map((period) => totalsByPeriod[period])),
    line,
    periods,
    restrictedProductsIncluded,
    rows: comparisonRows,
    selfCheck,
    targetsByPeriod: input.targetsByPeriod ?? {},
    totalsByPeriod,
    worstSelfCheck: selfCheck
      .filter((check) => !check.ok)
      .reduce<ChannelSelfCheck | null>(
        (worst, check) =>
          !worst || Math.abs(check.differenceValue) > Math.abs(worst.differenceValue) ? check : worst,
        null,
      ),
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
    // The owner's per-customer rulings, sent from the same two lists the TypeScript classifier and
    // the store city split already read. Without this the workbook would call an overridden
    // customer's channel one way and the Customers tab another — one customer, two answers.
    p_pharmacy_override_codes: [...PHARMACY_OVERRIDE_CLIENT_CODES],
    p_periods: wanted,
    p_store_override_codes: [...STORE_OVERRIDE_CUSTOMER_KEYS],
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
  /**
   * The three "no customer to judge" columns, each its own number rather than a share of Pharmacies
   * — which is where all three used to land, because the channel CASE ends in `else 'pharmacy'`.
   * hospital + store + pharmacy + these three = total, and the sheet's TOTAL row proves it.
   */
  unidentifiedNoCode: number;
  unidentifiedNoName: number;
  directUnnamed: number;
  total: number;
};

/** A row with every money column at zero. The one place the column list is written out. */
export function emptyBreakdownRow(key: string, label: string): ChannelBreakdownRow {
  return {
    directUnnamed: 0,
    hospital: 0,
    key,
    label,
    pharmacy: 0,
    store: 0,
    total: 0,
    unidentifiedNoCode: 0,
    unidentifiedNoName: 0,
  };
}

/** Which rep seat owns an area. Supplied by the RPC; the store split moves money over it. */
export type ChannelBreakdownAreaRep = { key: string; label: string };

/** How much store money each brick holds, and in which area — the store split's brick-side input. */
export type ChannelBreakdownBrickArea = { brickKey: string; areaKey: string; store: number };

export type ChannelBreakdown = {
  line: string | null;
  period: string | null;
  restrictedProductsIncluded: boolean;
  byDimension: Record<ChannelBreakdownDimension, ChannelBreakdownRow[]>;
  /** Area code (uppercase) → the rep seat that owns it. Covers every area on the crosswalk, not
   *  only the ones that sold this month: an area can RECEIVE a share of its city's store pool. */
  areaRep: ReadonlyMap<string, ChannelBreakdownAreaRep>;
  /** Store money per brick and area, for the brick side of the split. */
  brickArea: readonly ChannelBreakdownBrickArea[];
  /**
   * The month re-aggregated from the source tables a second, independent time inside the RPC. The
   * sheet checks its four grids against this rather than against each other — four grids built from
   * one query agree with each other whether or not that query is right.
   *
   * NULL, never 0, when the database has not been migrated and no such row came back. A zero would
   * make every grid look short by the whole month; the sheet says NOT CHECKED instead.
   */
  population: number | null;
  /** Set by applyStoreSplitToChannelBreakdown so the sheet can state what it moved. */
  storeSplit?: { applied: boolean; movedValue: number; movedFromBricks: number };
  /**
   * Set by applyJulyDirectAreasToBreakdown when July 2026's hand-mapped direct orders were moved
   * onto the areas and reps the Closing Matrix puts them on. Absent in every other month, which is
   * correct: direct orders carry no area and belong in their own row.
   */
  julyDirect?: { applied: boolean; value: number };
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
  // The store city split's brick-side landing. A wholesaler supplies its whole city, so once its
  // sell-in is shared across that city's areas it belongs to no single brick — including the one
  // the shop itself stands on. Leaving it on that brick is what the Closing Matrix stopped doing.
  if (key === "__STORE_SPLIT__") return "Store sales shared across the city — no single brick";
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

/**
 * The dominant channel of a row and its share, for the Leader column the sibling grids use.
 *
 * The unattributed buckets COMPETE here rather than being skipped. If most of a row has no customer
 * on it, "Pharmacies 30%" is a claim the data does not support — naming the bucket as the leader is
 * the honest reading, and it points straight at the rows worth fixing.
 */
export function breakdownLeader(row: ChannelBreakdownRow): { label: string; share: number } | null {
  if (row.total <= 0) return null;
  const candidates: ReadonlyArray<{ label: string; value: number }> = [
    { label: "Hospitals", value: row.hospital },
    { label: "Stores", value: row.store },
    { label: "Pharmacies", value: row.pharmacy },
    { label: "No client code", value: row.unidentifiedNoCode },
    { label: "No customer name", value: row.unidentifiedNoName },
    { label: "Direct, unnamed", value: row.directUnnamed },
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
  /** Optional so the app keeps working against a database where the migration has not run yet:
   *  they read 0 and the grids behave exactly as they did before. */
  unidentified_no_code?: number;
  unidentified_no_name?: number;
  direct_unnamed?: number;
  total: number;
  /** Only on `area_rep` rows. */
  rep_key?: string | null;
  /** Only on `brick_area` rows. */
  area_key?: string | null;
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
  const areaRep = new Map<string, ChannelBreakdownAreaRep>();
  const brickArea: ChannelBreakdownBrickArea[] = [];
  let population: number | null = null;

  for (const raw of input.rows) {
    // The RPC emits three row sets that are not grids: the area→rep seat map, the store money per
    // brick and area, and the month's independently re-aggregated total. They travel in the same
    // array on purpose — an app running the previous code filters on the four grid dimensions and
    // never sees them, which is what lets the migration be applied before the deploy.
    if (raw.dimension === "area_rep") {
      areaRep.set(String(raw.key ?? "").trim().toUpperCase(), {
        key: String(raw.rep_key ?? "").trim() || "__NO_SEAT__",
        label: String(raw.label ?? "").trim(),
      });
      continue;
    }
    if (raw.dimension === "brick_area") {
      brickArea.push({
        areaKey: String(raw.area_key ?? "").trim(),
        brickKey: String(raw.key ?? "").trim(),
        store: Number(raw.store ?? 0),
      });
      continue;
    }
    if (raw.dimension === "population") {
      population = Number(raw.total ?? 0);
      continue;
    }
    const dimension = raw.dimension as ChannelBreakdownDimension;
    if (!BREAKDOWN_DIMENSIONS.includes(dimension)) continue;
    byDimension[dimension].push({
      directUnnamed: Number(raw.direct_unnamed ?? 0),
      hospital: Number(raw.hospital ?? 0),
      key: String(raw.key ?? ""),
      label: String(raw.label ?? ""),
      pharmacy: Number(raw.pharmacy ?? 0),
      store: Number(raw.store ?? 0),
      total: Number(raw.total ?? 0),
      unidentifiedNoCode: Number(raw.unidentified_no_code ?? 0),
      unidentifiedNoName: Number(raw.unidentified_no_name ?? 0),
    });
  }
  // Biggest first inside each grid. The RPC already orders this way; re-sorting here means the
  // sheet cannot be silently re-ordered by a change to the RPC's ORDER BY.
  for (const dimension of BREAKDOWN_DIMENSIONS) {
    byDimension[dimension].sort((left, right) => right.total - left.total || left.key.localeCompare(right.key));
  }

  return {
    areaRep,
    brickArea,
    byDimension,
    line: input.line,
    period: input.period,
    population,
    restrictedProductsIncluded: input.restrictedProductsIncluded,
  };
}

/** Sum a grid, for the TOTAL row and for the tie-back check the sheet states. */
export function sumBreakdownRows(rows: readonly ChannelBreakdownRow[]): ChannelBreakdownRow {
  return rows.reduce<ChannelBreakdownRow>(
    (total, row) => ({
      directUnnamed: total.directUnnamed + row.directUnnamed,
      hospital: total.hospital + row.hospital,
      key: "TOTAL",
      label: "TOTAL",
      pharmacy: total.pharmacy + row.pharmacy,
      store: total.store + row.store,
      total: total.total + row.total,
      unidentifiedNoCode: total.unidentifiedNoCode + row.unidentifiedNoCode,
      unidentifiedNoName: total.unidentifiedNoName + row.unidentifiedNoName,
    }),
    emptyBreakdownRow("TOTAL", "TOTAL"),
  );
}

/**
 * Does this grid hold the whole month? One number per grid, checked against the RPC's independent
 * re-aggregation rather than against the other three grids — four grids built from one query agree
 * with each other whether or not that query is right, which is exactly how the missing 4.36M went
 * unnoticed.
 */
export function breakdownSelfCheck(breakdown: ChannelBreakdown): Array<{
  dimension: ChannelBreakdownDimension;
  gridValue: number;
  population: number;
  difference: number;
  ok: boolean;
  /** False when the RPC supplied no independent total, so nothing could be checked. */
  available: boolean;
}> {
  const available = breakdown.population != null;
  return BREAKDOWN_DIMENSIONS.map((dimension) => {
    const gridValue = sumBreakdownRows(breakdown.byDimension[dimension]).total;
    // With nothing to check against, the grid is compared to itself: difference zero, but the
    // `available` flag is what the sheet prints, so it reads NOT CHECKED rather than OK.
    const population = breakdown.population ?? gridValue;
    const difference = gridValue - population;
    return { available, difference, dimension, gridValue, ok: tiesAtDisplayPrecision(difference), population };
  });
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
    // The owner's per-customer rulings, sent from the same two lists the TypeScript classifier and
    // the store city split already read. Without this the workbook would call an overridden
    // customer's channel one way and the Customers tab another — one customer, two answers.
    p_pharmacy_override_codes: [...PHARMACY_OVERRIDE_CLIENT_CODES],
    p_period: period,
    p_store_override_codes: [...STORE_OVERRIDE_CUSTOMER_KEYS],
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
