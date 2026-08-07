import { canViewRestrictedProducts, RESTRICTED_PRODUCT_CODES } from "@/lib/sales/access-scope";
import {
  HOSPITAL_NAME_KEYWORDS,
  normalizeCustomerName,
  STORE_OVERRIDE_CUSTOMER_KEYS,
  STORE_NAME_KEYWORDS,
} from "@/lib/sales/customer-channel";
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
  period: string | null;
  /** False means the restricted products were stripped, so every figure excludes them. */
  restrictedProductsIncluded: boolean;
  rows: ChannelsByRepRow[];
  totals: ChannelsByRepTotals;
};

const PERIOD_RE = /^\d{4}-\d{2}$/;

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

export async function loadChannelsByRep(options: {
  period?: string | null;
  revealRestricted?: boolean;
  role: PhoenixRole;
}): Promise<ChannelsByRepResult> {
  const period =
    typeof options.period === "string" && PERIOD_RE.test(options.period) ? options.period : null;
  const excluded = excludedProductCodes(options.role, options.revealRestricted === true);
  const stems = channelStems();

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_sales_channels_by_rep", {
    p_excluded_product_codes: excluded,
    p_hospital_stems: stems.hospital,
    p_period: period,
    p_store_override_keys: [...STORE_OVERRIDE_CUSTOMER_KEYS],
    p_store_stems: stems.store,
  });
  if (error) throw error;

  const rows = ((data ?? []) as Record<string, unknown>[]).map(mapChannelsByRepRow);
  return {
    period,
    restrictedProductsIncluded: excluded.length === 0,
    rows,
    totals: totalsFor(rows),
  };
}
