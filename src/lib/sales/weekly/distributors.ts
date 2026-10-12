// Canonical registry of the distributors the Weekly Sales module ingests. Single source of truth
// for the mapping dropdowns and (from the parser rebuild PR) the upload-adapter selection — not
// derived from the old hardcoded header templates.

export type WeeklyCadence = "weekly" | "twice-monthly";

export type WeeklyDistributorDef = {
  code: string;
  name: string;
  cadence: WeeklyCadence;
  /** PS ships separate sales + stock matrix files; everyone else ships one combined workbook. */
  separateSalesStockFiles?: boolean;
  /** true for distributors with NO monthly flat-file equivalent (e.g. POS uses a transposed matrix
   *  layout parsed only by the weekly adapter; there is no separate monthly import for it). */
  weeklyOnly?: boolean;
  /** true when the adapter matches columns by HEADER NAME instead of a fixed position (e.g. Direct's
   *  hand-coded sheet). These distributors are intentionally exempt from column-contract.ts — a
   *  positional contract would misdescribe the parser and the AI pre-verify would flag false "drift"
   *  whenever the operator's columns aren't in the exact reference order. */
  headerNameMatched?: boolean;
  /** true when the monthly counterpart is imported via a coded system channel (DIRECT_TEMPLATE /
   *  isCodedSystemChannel in monthly-distributor-import.ts) rather than through the normalizer
   *  RAW_DISTRIBUTOR_PROFILES path. These distributors are NOT weeklyOnly (they do have a monthly
   *  import) but also do not appear in RAW_DISTRIBUTOR_PROFILES. */
  monthlyCoded?: boolean;
  /** false when the weekly sheets are NOT cumulative within the month — each sheet carries only that
   *  week's own lines, so nothing may be subtracted from it. Defaults to true (every real distributor
   *  export restates the month to date). Read it through weeklyDistributorIsCumulative(), never by
   *  touching this field, so an unknown code keeps the cumulative default. */
  cumulative?: boolean;
};

export const WEEKLY_DISTRIBUTORS: readonly WeeklyDistributorDef[] = [
  { code: "IS", name: "Ibn Sina", cadence: "weekly" },
  { code: "IS-S", name: "Ibn Sina Sato", cadence: "weekly" },
  // Ibn Sina exports one SalesAndStockReport2_DataHub workbook PER SUPPLIER, so it reaches us as
  // THREE feeds by the owner's ruling of 2026-10-13: IS for the outsourced products, IS-S for Sato
  // Pharma (PAS), and IS-L for LACTO MISR EG (supplier 111399 — the four Lacto SKUs 684793/684794
  // plain and 684795/684796 ADVANCED). Identical sheet shape to IS-S, so it shares adaptISS and an
  // identical column contract — but it MUST be its own code, because de-cumulation groups by
  // (distributor, cycle_month) and subtracts the previous week_start's (product × branch) cell.
  // Filed under IS-S, a Lacto sheet becomes that group's latest week while carrying none of the Sato
  // cells, so the NEXT Sato file subtracts zero instead of its predecessor's month-to-date and books
  // the whole cumulative month as one week — a silent double count one week later.
  //
  // NOT weeklyOnly — the owner's follow-up the same day was "every where in mapping and upload and
  // normalizer and every where", so IS-L is wired on the MONTHLY side exactly like IS-S too: a
  // RAW_DISTRIBUTOR_PROFILES entry for Ibn Sina's raw export and IBN_SINA_LACTO_ISL_TEMPLATE for the
  // coded one. No monthly Lacto sheet has arrived yet (production, 2026-10-13:
  // source_of_sales_fact_rollup carries LA001–LA004 from PS, EP-PHS, EP-BK, Direct, DirectReq, QM and
  // Office, and from no Ibn Sina code at all) — the lane is open so the first one imports instead of
  // being rejected as an unknown channel.
  { code: "IS-L", name: "Ibn Sina Lacto", cadence: "weekly" },
  { code: "PS", name: "Overseas", cadence: "weekly", separateSalesStockFiles: true },
  { code: "POS", name: "POS Purchasing Sales", cadence: "weekly", weeklyOnly: true },
  { code: "EG", name: "EGD", cadence: "twice-monthly" },
  { code: "RM", name: "RAMCO", cadence: "twice-monthly" },
  { code: "SF", name: "Sofico", cadence: "twice-monthly" },
  // Direct (company) channel — hand-coded sheet (Distrub ID / Region ID / Product ID / Qty / Invoice
  // Date / Value / Pharmacy Name), mirrors the monthly Direct template (monthly-distributor-import.ts
  // DIRECT_TEMPLATE). No branch/area: region-only, with a "NATIONAL" sentinel bucket. Value is read
  // straight from the sheet's own Value column (never recomputed from factory price). Has no monthly
  // flat-file equivalent of its own raw-export kind, but DOES have a monthly Direct counterpart — kept
  // out of weeklyOnly since that flag means "no monthly import at all" (POS alone today).
  //
  // NOT cumulative. Every other distributor exports a running month-to-date sheet; Direct is keyed by
  // invoice, so each week's sheet holds only that week's own orders. Proven on prod 2026-08-15 from
  // the stored rows themselves: across the 2026-05 cycle's weeks 2 and 3, of 26 distinct
  // branch×product cells only 7 appear in both — 10 vanish and 9 are new. A running total cannot lose
  // cells. Subtracting the prior sheet had been producing negative weeks (2026-05 W3 came out at
  // -65,198.50 and 2026-07 W2 at -418,067.75).
  { code: "Direct", name: "Direct (Company)", cadence: "weekly", headerNameMatched: true, monthlyCoded: true, cumulative: false },
];

export function weeklyDistributorByCode(code: string | null | undefined): WeeklyDistributorDef | undefined {
  const key = String(code ?? "").trim().toUpperCase();
  return WEEKLY_DISTRIBUTORS.find((distributor) => distributor.code.toUpperCase() === key);
}

/** Validate + return the canonical distributor code (uppercased registry form), or throw. */
export function canonicalWeeklyDistributorCode(code: string | null | undefined): string {
  const found = weeklyDistributorByCode(code);
  if (!found) throw new Error(`Unknown weekly distributor "${String(code ?? "").trim()}".`);
  return found.code;
}

export function isWeeklyDistributorCode(code: string | null | undefined): boolean {
  return Boolean(weeklyDistributorByCode(code));
}

/**
 * Are this distributor's weekly sheets cumulative within the month-cycle (i.e. does each sheet
 * restate the month to date, so the real week = sheet minus the previous sheet)?
 *
 * Defaults to TRUE, including for an unrecognised code — every distributor except Direct restates,
 * so the safe default is the existing behaviour. Only an explicit `cumulative: false` opts out.
 */
export function weeklyDistributorIsCumulative(code: string | null | undefined): boolean {
  return weeklyDistributorByCode(code)?.cumulative !== false;
}

// ── Direct (Company) from August 2026: written by the Direct Orders module, never uploaded ───────
//
// OWNER RULE, 2026-09-19: weekly sales carry direct orders on the same rules as the Source of Sales —
// an order counts in the month Finance books it. From 2026-08 the database writes those batches itself
// (`phx_rebuild_direct_order_weekly_batches`, template_key `direct_orders_system`), so an uploaded
// Direct sheet for the same months would count every order twice. The floor and the template key below
// MUST match that migration; `tests/weekly-direct-orders-injection.test.ts` reads the SQL and fails
// when they drift.

/** First cycle month (first of the month, YYYY-MM-DD) whose Direct weekly sales come from orders. */
export const DIRECT_WEEKLY_FROM_ORDERS_CYCLE = "2026-08-01";

/** `template_key` of the batches the Direct Orders module writes. Uploaded sheets carry `Direct`. */
export const DIRECT_ORDERS_WEEKLY_TEMPLATE_KEY = "direct_orders_system";

/**
 * Why an uploaded Direct sheet is refused, or null when the upload may go ahead.
 *
 * Both dates are checked because a batch's `cycle_month` is operator-tagged and can differ from the
 * month of its `week_start`: a sheet dated in August but tagged July is still August's money.
 */
export function directWeeklyUploadRefusal(
  distributorCode: string | null | undefined,
  cycleMonth: string | null | undefined,
  weekStart: string | null | undefined,
): string | null {
  if (weeklyDistributorByCode(distributorCode)?.code !== "Direct") return null;
  const months = [cycleMonth, weekStart]
    .map((value) => String(value ?? "").trim().slice(0, 7))
    .filter((value) => /^\d{4}-\d{2}$/.test(value))
    .map((value) => `${value}-01`);
  const closed = months.find((month) => month >= DIRECT_WEEKLY_FROM_ORDERS_CYCLE);
  if (!closed) return null;
  return (
    `Direct (Company) weekly sales for ${closed.slice(0, 7)} come from the Direct Orders module — every ` +
    `approved order Finance books into a month is placed in the week of its collection date automatically. ` +
    `An uploaded Direct sheet would count each order twice, so it is not accepted from ` +
    `${DIRECT_WEEKLY_FROM_ORDERS_CYCLE.slice(0, 7)} onwards.`
  );
}

/** True for a batch the Direct Orders module wrote — it is rebuilt from the orders, never edited by hand. */
export function isDirectOrdersWeeklyBatch(templateKey: string | null | undefined): boolean {
  return String(templateKey ?? "").trim() === DIRECT_ORDERS_WEEKLY_TEMPLATE_KEY;
}

export function weeklyDistributorOptions(): { code: string; name: string }[] {
  return WEEKLY_DISTRIBUTORS.map((distributor) => ({ code: distributor.code, name: distributor.name }));
}
