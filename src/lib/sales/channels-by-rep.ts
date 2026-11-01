import { canViewRestrictedProducts, RESTRICTED_PRODUCT_CODES } from "@/lib/sales/access-scope";
import {
  HOSPITAL_NAME_KEYWORDS,
  normalizeCustomerName,
  PHARMACY_OVERRIDE_CLIENT_CODES,
  STORE_OVERRIDE_CUSTOMER_KEYS,
  STORE_NAME_KEYWORDS,
} from "@/lib/sales/customer-channel";
import { customerChannelSqlRule } from "@/lib/sales/customer-channel-sql-rule";
import { latestPublishedClosingPeriod } from "@/lib/sales/monthly-closing-publication";
import { lineName } from "@/lib/sales/monthly-targets";
import { listMonthlyClosingPeriods } from "@/lib/sales/monthly-distributor-import";
import { CHANNELS_BY_REP_WHOLE_HISTORY, latestNonFuturePeriod } from "@/lib/sales/periods";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { PhoenixRole } from "@/lib/auth/permissions";

// ─────────────────────────────────────────────────────────────────────────────
// Channels by Rep — Hospital / Store / Pharmacy sales, per medical rep.
//
// The owner asked for a comparison of hospital, store and pharmacy sales per rep, and explicitly
// chose SALES ONLY with no target line. That is not a shortcut: targets are keyed
// (month, line, area, product) on the seat model and carry NO channel dimension, so any per-channel
// target would be a number this system invented. See src/lib/sales/monthly-targets.ts.
//
// A NOTE ON A DATED COMMENT: access-scope.ts says the sales dashboards are "never per-medical-rep"
// because "the sales files carry line/region/area/brick/product/customer but not rep ownership".
// That was true before the AU seat model. Rep ownership now exists — a sale's area resolves through
// au.sos_area_crosswalk to a canonical area, which with the line resolves to a REP seat, whose
// current occupant is the rep. That is the chain this module uses, and it is the same one the
// monthly closing attributes through.
//
// VALUE is the closing's too (owner, 2026-09-18). The RPC prices a distributor row at its paid
// units x factory price and keeps a direct order's own value. It never reads the value a distributor
// typed into its sheet, and bonus units never count. Until then this tab alone added up the sheet's
// value: El Qema's August Pedia sales read 1,888,898.40 EGP here against 2,367,360.00 in the closing.
// ─────────────────────────────────────────────────────────────────────────────

/** How a slice of sales reached (or failed to reach) a person. */
export type ChannelsByRepAttribution = "rep" | "vacant-seat" | "unmapped";

export type ChannelsByRepRow = {
  attribution: ChannelsByRepAttribution;
  areaCode: string | null;
  areaName: string | null;
  hospitalCustomers: number;
  hospitalValue: number;
  /** What to show in the name column. Always human-readable, never a code or an hr_id. */
  label: string;
  lineCode: string | null;
  /** The line as a reader knows it ("Anti Infective"), never the code. Null when the row has no line. */
  lineName: string | null;
  pharmacyCustomers: number;
  pharmacyValue: number;
  repHrId: string | null;
  seatId: string | null;
  storeCustomers: number;
  storeValue: number;
  totalValue: number;
};

export type ChannelsByRepTotals = {
  hospitalValue: number;
  pharmacyValue: number;
  storeValue: number;
  totalValue: number;
  /** Value that reached no person — vacant seats plus rows off the seat model entirely. */
  unattributedValue: number;
};

export type ChannelsByRepResult = {
  /** Every month the picker offers, newest first. */
  availablePeriods: string[];
  /** The month these figures cover; null means the whole history. */
  period: string | null;
  /** False means the restricted products were stripped, so every figure excludes them. */
  restrictedProductsIncluded: boolean;
  rows: ChannelsByRepRow[];
  totals: ChannelsByRepTotals;
};

const PERIOD_RE = /^\d{4}-\d{2}$/;

// The whole history, which the tab offers as a choice, took 30.2 s on production on 2026-11-01 with the
// restricted products stripped. At the default 15s that read shows an error while the query runs on
// with nobody waiting for it. One month is 3 to 9 s.
const CHANNELS_BY_REP_REQUEST_TIMEOUT_MS = 50_000;

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The stems the RPC matches on, folded exactly as a customer name will be folded before comparison.
 *
 * Derived from customer-channel.ts every call rather than copied. That file declares itself THE
 * single edit point — "adding an entry re-classifies all history" — and a duplicate list in SQL or
 * here would silently break that the first time one copy was edited. It is not a theoretical risk:
 * a hand-transcribed copy of these six words mis-stated the store channel by 8.7M EGP.
 */
export function channelStems(): { hospital: string[]; store: string[] } {
  return {
    hospital: HOSPITAL_NAME_KEYWORDS.map((keyword) => normalizeCustomerName(keyword.stem)).filter(Boolean),
    store: STORE_NAME_KEYWORDS.map((keyword) => normalizeCustomerName(keyword.stem)).filter(Boolean),
  };
}

/**
 * Which product codes this viewer must not see.
 *
 * Restricted products are stripped for EVERYONE by default; only a CEO or Super Admin who
 * explicitly opts in may reveal them, and the opt-in is ignored for every other role so that URL,
 * API or filter tampering cannot leak them. Worth knowing what is at stake in the other direction:
 * those three products are 81.5% of all sales value, so the default view is a genuinely different
 * picture from the revealed one, not a rounding difference.
 */
export function excludedProductCodes(role: PhoenixRole, revealRestricted: boolean): string[] {
  if (revealRestricted && canViewRestrictedProducts(role)) return [];
  return [...RESTRICTED_PRODUCT_CODES];
}

/**
 * Label a row for a human. The owner's standing rule is that a screen shows names, never raw codes
 * — but a bucket that reached no person still has to say so plainly rather than being blank or, far
 * worse, being dropped. Roughly 27% of sales land in these two buckets, so they are not an edge
 * case to hide; they are the first thing worth asking about.
 */
export function labelFor(row: {
  areaName: string | null;
  areaCode: string | null;
  attribution: ChannelsByRepAttribution;
  repName: string | null;
}): string {
  if (row.attribution === "rep") return row.repName ?? "Unnamed employee";
  if (row.attribution === "vacant-seat") {
    const where = row.areaName ?? row.areaCode;
    return where ? `Vacant seat — ${where}` : "Vacant seat";
  }
  return "Not on the seat model";
}

/** Shape one RPC row. Exported so a test can exercise the mapping without a database. */
export function mapChannelsByRepRow(raw: Record<string, unknown>): ChannelsByRepRow {
  const seatId = text(raw.seat_id);
  const repHrId = text(raw.rep_hr_id);
  const attribution: ChannelsByRepAttribution =
    repHrId != null ? "rep" : seatId != null ? "vacant-seat" : "unmapped";
  const areaCode = text(raw.area_code);
  const areaName = text(raw.area_name);
  const row = {
    areaCode,
    areaName,
    attribution,
    hospitalCustomers: num(raw.hospital_customers),
    hospitalValue: num(raw.hospital_value),
    lineCode: text(raw.line_code),
    lineName: lineName(text(raw.line_code)) || null,
    pharmacyCustomers: num(raw.pharmacy_customers),
    pharmacyValue: num(raw.pharmacy_value),
    repHrId,
    seatId,
    storeCustomers: num(raw.store_customers),
    storeValue: num(raw.store_value),
    totalValue: num(raw.total_value),
  };
  return { ...row, label: labelFor({ ...row, repName: text(raw.rep_name) }) };
}

/** Sum the rows. Kept pure so the totals a reader sees are provably the rows they can see. */
export function totalsFor(rows: readonly ChannelsByRepRow[]): ChannelsByRepTotals {
  return rows.reduce<ChannelsByRepTotals>(
    (totals, row) => ({
      hospitalValue: totals.hospitalValue + row.hospitalValue,
      pharmacyValue: totals.pharmacyValue + row.pharmacyValue,
      storeValue: totals.storeValue + row.storeValue,
      totalValue: totals.totalValue + row.totalValue,
      unattributedValue:
        totals.unattributedValue + (row.attribution === "rep" ? 0 : row.totalValue),
    }),
    { hospitalValue: 0, pharmacyValue: 0, storeValue: 0, totalValue: 0, unattributedValue: 0 },
  );
}

/**
 * Which month a request reads; null is the whole history, and only asking for it by name gets it.
 *
 * With no month asked for, the tab opens on the newest published closing, the newest month the business
 * considers finished. Never simply the newest month uploaded: on 2026-11-01 production's 2026-11 held
 * one row and 2026-10 held 55, against 43,390 in 2026-09.
 */
export function resolveChannelsByRepPeriod(input: {
  available: readonly string[];
  latestPublished: string | null;
  requested: string | null | undefined;
}): string | null {
  if (input.requested === CHANNELS_BY_REP_WHOLE_HISTORY) return null;
  if (typeof input.requested === "string" && PERIOD_RE.test(input.requested)) return input.requested;
  return input.latestPublished ?? latestNonFuturePeriod(input.available) ?? input.available[0] ?? null;
}

/** A read this module will not start, for any role. The route answers it with a 400. */
export class ChannelsByRepRefused extends Error {}

/**
 * The whole history with nothing excluded is refused (owner, 2026-11-01). Staging restarted uncleanly
 * 7 min 45 s into that read on 2026-11-01, it has never finished on either database, and nothing can
 * stop it once it starts: the function's own statement_timeout does not fire. One month with the
 * restricted products revealed, and the whole history without them, both stay open.
 */
export function assertChannelsByRepReadAllowed(period: string | null, excluded: readonly string[]): void {
  if (period === null && excluded.length === 0) {
    throw new ChannelsByRepRefused(
      "The whole history with the restricted products included is not available. Choose one month.",
    );
  }
}

export async function loadChannelsByRep(options: {
  period?: string | null;
  revealRestricted?: boolean;
  role: PhoenixRole;
}): Promise<ChannelsByRepResult> {
  const [available, latestPublished] = await Promise.all([
    listMonthlyClosingPeriods(),
    latestPublishedClosingPeriod(),
  ]);
  const period = resolveChannelsByRepPeriod({ available, latestPublished, requested: options.period });
  const availablePeriods = [...new Set([...available, ...(period ? [period] : [])])].sort((left, right) =>
    right.localeCompare(left),
  );
  const excluded = excludedProductCodes(options.role, options.revealRestricted === true);
  assertChannelsByRepReadAllowed(period, excluded);
  const stems = channelStems();

  const supabase = getSupabaseAdmin({ requestTimeoutMs: CHANNELS_BY_REP_REQUEST_TIMEOUT_MS });
  const { data, error } = await supabase.rpc("phx_sales_channels_by_rep", {
    p_excluded_product_codes: excluded,
    p_hospital_stems: stems.hospital,
    // BOTH override lists, or this tab silently disagrees with every sibling. The pharmacy rulings
    // used to be omitted — the RPC had no parameter for them — so 578,248.77 EGP of the owner's
    // explicitly-ruled pharmacies read as STORES here while the Customer Directory and the
    // monthly-closing channel comparison read them as pharmacies. Same customers, two answers.
    p_pharmacy_override_codes: [...PHARMACY_OVERRIDE_CLIENT_CODES],
    p_period: period,
    // The WHOLE rule, not just the six words. Everything the owner has ruled since — the «م - »
    // prefix, his company and chain rulings, the never-store words, El Qema's wholesale-only book
    // and the trade phrase — reaches SQL only through this payload. `p_store_stems` and the two
    // code lists above stay because a migration lands before the deploy that uses it, and the
    // function falls back to them for that window.
    p_rule: customerChannelSqlRule(),
    p_store_override_keys: [...STORE_OVERRIDE_CUSTOMER_KEYS],
    p_store_stems: stems.store,
  });
  if (error) throw error;

  const rows = ((data ?? []) as Record<string, unknown>[]).map(mapChannelsByRepRow);
  return {
    availablePeriods,
    period,
    restrictedProductsIncluded: excluded.length === 0,
    rows,
    totals: totalsFor(rows),
  };
}
