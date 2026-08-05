import { classifyCustomerChannel, type CustomerChannel } from "@/lib/sales/customer-channel";
import { loadMonthlyClosingComparison, type ComparisonScope } from "@/lib/sales/monthly-closing-comparison";

// ─────────────────────────────────────────────────────────────────────────────
// Monthly Closing — Channel Comparison across months.
//
// Hospital vs Store vs Pharmacy, month by month, in units and value. The owner asked for this as a
// sheet in the downloaded closing workbook, compared over the months he exports.
//
// WHY THIS READS THE COMPARISON AND NOT THE Calc SHEET: every other sheet in the workbook is live
// =SUMIFS over the hidden Calc block, but Calc holds only
// Distributor | Region | Area | Product | Units | Value — no customer NAME. The channel is derived
// from the name, so Calc cannot express it. loadMonthlyClosingComparison already returns
// data.customers with the name attached, so this needs no new query for the exported month.
//
// TARGETS ARE NOT SPLIT PER CHANNEL. Targets are keyed (month, line, area, product) and carry no
// channel dimension, so a per-channel target would be a number Phoenix invented. The sheet shows
// the MONTH TOTAL target beside the channel split instead — a real figure that happens not to
// attribute to a channel — which is what the owner chose when told the constraint.
// ─────────────────────────────────────────────────────────────────────────────

export type ChannelCell = {
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

export type ChannelComparison = {
  line: string | null;
  /** Oldest to newest. A calendar order, never the order the loader happened to return. */
  periods: string[];
  rows: ChannelComparisonRow[];
  totalsByPeriod: Record<string, ChannelCell>;
};

/** Fixed display order: the two channels a decision usually turns on first, then the bulk. */
export const CHANNEL_ORDER: ReadonlyArray<{ channel: CustomerChannel; label: string }> = [
  { channel: "hospital", label: "Hospitals" },
  { channel: "store", label: "Stores (wholesalers)" },
  { channel: "pharmacy", label: "Pharmacies" },
];

function emptyCell(): ChannelCell {
  return { customers: 0, units: 0, value: 0 };
}

export type ChannelSourceCustomer = {
  clientCode: string;
  clientName: string;
  units: number;
  value: number;
};

/**
 * Split one month's customers into the three channels.
 *
 * Customer COUNT is distinct client code, not row count: the loader returns one row per
 * customer-per-distributor, so counting rows would report a pharmacy buying from three
 * distributors as three pharmacies. Units and value still sum across every row, because those
 * genuinely are three different sales.
 *
 * Pure and exported so a test can exercise it without a database.
 */
export function summariseChannels(
  customers: readonly ChannelSourceCustomer[],
): Record<CustomerChannel, ChannelCell> {
  const seen: Record<CustomerChannel, Set<string>> = {
    hospital: new Set(),
    pharmacy: new Set(),
    store: new Set(),
  };
  const out: Record<CustomerChannel, ChannelCell> = {
    hospital: emptyCell(),
    pharmacy: emptyCell(),
    store: emptyCell(),
  };

  for (const customer of customers) {
    const channel = classifyCustomerChannel(customer.clientName);
    const cell = out[channel];
    cell.units += Number.isFinite(customer.units) ? customer.units : 0;
    cell.value += Number.isFinite(customer.value) ? customer.value : 0;
    const code = String(customer.clientCode ?? "").trim();
    if (code) seen[channel].add(code);
  }

  for (const channel of Object.keys(out) as CustomerChannel[]) {
    out[channel].customers = seen[channel].size;
  }
  return out;
}

/** Sum the per-channel cells of one month into that month's total. */
export function totalCell(cells: readonly ChannelCell[]): ChannelCell {
  return cells.reduce<ChannelCell>(
    (total, cell) => ({
      customers: total.customers + cell.customers,
      units: total.units + cell.units,
      value: total.value + cell.value,
    }),
    emptyCell(),
  );
}

/**
 * Build the comparison across the given periods.
 *
 * Periods are sorted ascending here rather than trusted from the caller, because the sheet is read
 * left to right as a trend and a month out of order silently turns a rise into a fall. `YYYY-MM`
 * sorts correctly as a string, which is exactly why the format is used throughout.
 *
 * One load per month, sequential rather than parallel: each is a round trip to a database on
 * another continent, and a closing export already competes with the rest of the workbook's
 * queries. Correctness first; this runs on a download, not a page render.
 */
export async function loadChannelComparison(
  line: string | null,
  periods: readonly string[],
  scope?: ComparisonScope,
): Promise<ChannelComparison> {
  const ordered = [...new Set(periods.filter((period) => typeof period === "string" && period.trim() !== ""))].sort();

  const rows: ChannelComparisonRow[] = CHANNEL_ORDER.map((entry) => ({
    byPeriod: {},
    channel: entry.channel,
    label: entry.label,
    total: emptyCell(),
  }));
  const totalsByPeriod: Record<string, ChannelCell> = {};

  for (const period of ordered) {
    const comparison = await loadMonthlyClosingComparison(line, period, scope);
    const split = summariseChannels(comparison.data.customers);
    for (const row of rows) {
      const cell = split[row.channel];
      row.byPeriod[period] = cell;
      row.total = totalCell([row.total, cell]);
    }
    totalsByPeriod[period] = totalCell(CHANNEL_ORDER.map((entry) => split[entry.channel]));
  }

  return { line, periods: ordered, rows, totalsByPeriod };
}
