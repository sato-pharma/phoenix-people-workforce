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
};

export const WEEKLY_DISTRIBUTORS: readonly WeeklyDistributorDef[] = [
  { code: "IS", name: "Ibn Sina", cadence: "weekly" },
  { code: "IS-S", name: "Ibn Sina Sato", cadence: "weekly" },
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
  // out of weeklyOnly since that flag means "no monthly import at all" (POS-only today).
  { code: "Direct", name: "Direct (Company)", cadence: "weekly", headerNameMatched: true, monthlyCoded: true },
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

export function weeklyDistributorOptions(): { code: string; name: string }[] {
  return WEEKLY_DISTRIBUTORS.map((distributor) => ({ code: distributor.code, name: distributor.name }));
}
