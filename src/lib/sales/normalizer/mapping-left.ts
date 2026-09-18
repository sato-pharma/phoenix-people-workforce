// What is really left to map in one analyzed file.
//
// A preview carries each unknown list back cut at PREVIEW_UNKNOWN_LIMIT (2,000), with the true totals
// beside them. The Needs mapping tab and the messages after Save mappings and Auto-map counted the CUT
// lists, and counted every row that could not import as a row needing mapping. So on 2026-09-18 a
// pharmacy-only file (no product on any row) read "2000 codes (28,800 rows)" both before and after
// 1,487 of its pharmacies were saved: the list had refilled to 2,000 from the 3,348 still unmapped, and
// no row can import without a product however many pharmacies are mapped. Everything here reads the
// true totals, and counts only the rows a mapping would unblock.

export type MappingLeftPreview = {
  unknownCustomers: readonly unknown[];
  unknownProducts: readonly unknown[];
  unknownTerritories: readonly unknown[];
  unknownTotals?: { customers: number; products: number; territories: number; rows?: number };
  summary: { ignored: number };
};

export type MappingLeft = {
  pharmacies: number;
  products: number;
  territories: number;
  /** Every distinct code still unmapped, across the three kinds. */
  codes: number;
  /** Rows a mapping would unblock; null when the preview does not say (one built before this field). */
  rows: number | null;
};

// The larger of the true total and the list itself: a preview without totals still counts what it shows.
const trueCount = (total: number | undefined, shown: number) => (typeof total === "number" && total > shown ? total : shown);

const counted = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function mappingLeft(preview: MappingLeftPreview): MappingLeft {
  const totals = preview.unknownTotals;
  const pharmacies = trueCount(totals?.customers, preview.unknownCustomers.length);
  const products = trueCount(totals?.products, preview.unknownProducts.length);
  const territories = trueCount(totals?.territories, preview.unknownTerritories.length);
  return {
    codes: pharmacies + products + territories,
    pharmacies,
    products,
    rows: typeof totals?.rows === "number" ? totals.rows : null,
    territories,
  };
}

/** "3,348 pharmacies" · "3,348 pharmacies, 4 products and 2 territories" · "" when nothing is left. */
export function mappingLeftPhrase(left: Pick<MappingLeft, "pharmacies" | "products" | "territories">): string {
  const parts = [
    left.pharmacies ? counted(left.pharmacies, "pharmacy", "pharmacies") : "",
    left.products ? counted(left.products, "product", "products") : "",
    left.territories ? counted(left.territories, "territory", "territories") : "",
  ].filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The tab: "Needs mapping — 3,348 pharmacies left (3,348 rows)". */
export function needsMappingTabLabel(preview: MappingLeftPreview): string {
  const left = mappingLeft(preview);
  const ignored = preview.summary.ignored;
  const detail = [
    left.codes > 0 && left.rows !== null ? counted(left.rows, "row", "rows") : "",
    ignored ? `${ignored.toLocaleString("en-US")} ignored` : "",
  ].filter(Boolean);
  const what = left.codes > 0 ? `${mappingLeftPhrase(left)} left` : "nothing left";
  return `Needs mapping — ${what}${detail.length ? ` (${detail.join(", ")})` : ""}`;
}

/** The line after a save: "3,348 pharmacies still need mapping." */
export function stillNeedMappingSentence(left: MappingLeft): string {
  if (left.codes === 0) return "Everything is mapped now.";
  return `${mappingLeftPhrase(left)} still ${left.codes === 1 ? "needs" : "need"} mapping.`;
}
