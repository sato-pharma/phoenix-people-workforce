// Weekly Sales — structural layout descriptors per distributor.
//
// The parser is mapping-driven (product aliases + branch->region indexes own the business meaning).
// This file only describes the PHYSICAL layout of each distributor's raw export: which sheet holds
// the sales / return / stock data, which row is the header, and which 1-based column index carries
// each field. There are NO header-alias guesses here anymore — each distributor adapter pins exact
// columns against the verified real layout.

export type WeeklySheetRole = "sales" | "return" | "stock";

/** A column pinned by 1-based index inside a given sheet. */
export type WeeklyColumnRef = number;

/** Describes one physical sheet inside a distributor workbook (matched by name token). */
export type WeeklySheetDescriptor = {
  role: WeeklySheetRole;
  /** sheet name must contain this token (case-insensitive); when omitted, the only/first sheet is used */
  sheetNameIncludes?: string;
  /** exact sheet name (case-insensitive) — preferred over the token when present */
  sheetName?: string;
  /** 1-based header row; data starts at headerRow + 1 */
  headerRow: number;
};

export type WeeklyDistributorLayout = {
  /** canonical distributor code (uppercased) */
  code: string;
  display: string;
  /** PS ships two separate matrix files; everyone else ships one combined workbook */
  separateSalesStockFiles?: boolean;
};

// Fallback display names used when the master reference lacks a name row.
const WEEKLY_DISTRIBUTOR_FALLBACK_NAMES: Record<string, string> = {
  IS: "Ibn Sina",
  "IS-S": "Ibn Sina Sato",
  PS: "Overseas",
  EG: "EGD",
  RM: "RAMCO",
};

export function weeklyTemplateDistributorFallbackName(distributorCode: string): string | null {
  const normalized = (distributorCode ?? "").trim().toUpperCase();
  return normalized ? WEEKLY_DISTRIBUTOR_FALLBACK_NAMES[normalized] ?? null : null;
}

// Distributors that ship separate Sales and Stock weekly files (PS only). Add codes here
// when other split-file distributors are onboarded.
const WEEKLY_SPLIT_SALES_STOCK_DISTRIBUTORS = ["PS"];

/** True when a distributor ships its weekly feed as separate Sales and Stock files. */
export function weeklyDistributorSplitsSalesStock(distributorCode: string): boolean {
  return WEEKLY_SPLIT_SALES_STOCK_DISTRIBUTORS.includes((distributorCode ?? "").trim().toUpperCase());
}

// All weekly-enabled distributor codes (drives the branch-map admin dropdown).
const ALL_WEEKLY_DISTRIBUTOR_CODES = ["IS-S", "IS", "PS", "EG", "RM"];

/** Distributors shown in the Branch Mapping admin tab dropdown. */
export function weeklyBranchMapDistributors(): { code: string; name: string; splitsSalesStock: boolean }[] {
  return ALL_WEEKLY_DISTRIBUTOR_CODES.map((code) => ({
    code,
    name: weeklyTemplateDistributorFallbackName(code) ?? code,
    splitsSalesStock: weeklyDistributorSplitsSalesStock(code),
  }));
}

// Fixed list for the Weekly Mapping admin tab. Curated by the business — not every
// distributor needs mapping, so this is an explicit list rather than auto-derived.
const WEEKLY_MAPPING_DISTRIBUTOR_LIST: { code: string; name: string }[] = [
  { code: "IS-S", name: "Ibn Sina Sato" },
  { code: "RM", name: "Ramco" },
  { code: "PS", name: "POS" },
  { code: "EGD", name: "EGD" },
];

/** Distributors shown in the Weekly Mapping admin tab dropdown. */
export function weeklyMappingDistributors(): { code: string; name: string }[] {
  return WEEKLY_MAPPING_DISTRIBUTOR_LIST.map((d) => ({ ...d }));
}
