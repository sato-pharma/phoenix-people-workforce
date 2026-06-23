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
};

export const WEEKLY_DISTRIBUTORS: readonly WeeklyDistributorDef[] = [
  { code: "IS", name: "Ibn Sina", cadence: "weekly" },
  { code: "IS-S", name: "Ibn Sina Sato", cadence: "weekly" },
  { code: "PS", name: "Overseas", cadence: "weekly", separateSalesStockFiles: true },
  { code: "POS", name: "POS Purchasing Sales", cadence: "weekly", weeklyOnly: true },
  { code: "EG", name: "EGD", cadence: "twice-monthly" },
  { code: "RM", name: "RAMCO", cadence: "twice-monthly" },
  { code: "SF", name: "Sofico", cadence: "twice-monthly" },
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
