import type { CodedRow } from "@/lib/sales/normalizer/types";

// ─────────────────────────────────────────────────────────────────────────────
// Sales Upload — per-product / per-region / per-brick / per-line validation
// breakdowns, computed from the recognizer's coded rows (the SAME rows that get
// persisted). Pure aggregation, no I/O. Mirrors the coded-importer breakdowns in
// monthly-distributor-import.ts so the two upload paths read identically.
//
// Confidential products (LA003/LA004/SS001): callers pass `excludeProductCodes`
// for non-CEO/Super-Admin viewers, so restricted rows are dropped BEFORE
// aggregation — they never appear in any breakdown table NOR contribute their
// value to a region/brick/line total. CEO/Super Admin pass an empty list.
// ─────────────────────────────────────────────────────────────────────────────

export type PreviewBreakdownRow = {
  code: string;
  label: string;
  parent: string | null; // line for product; region for area; area for brick; null for region/line
  rowCount: number;
  totalQty: number;
  totalBonusQty: number;
  totalValue: number;
};

export type PreviewBreakdowns = {
  byProduct: PreviewBreakdownRow[];
  byRegion: PreviewBreakdownRow[];
  byBrick: PreviewBreakdownRow[];
  byLine: PreviewBreakdownRow[];
};

const round = (value: number) => Number((Number.isFinite(value) ? value : 0).toFixed(2));

function aggregate(
  rows: CodedRow[],
  keyOf: (row: CodedRow) => string,
  labelOf: (row: CodedRow) => string,
  parentOf: (row: CodedRow) => string | null,
): PreviewBreakdownRow[] {
  const map = new Map<string, PreviewBreakdownRow>();
  for (const row of rows) {
    const code = keyOf(row);
    const current = map.get(code) ?? {
      code,
      label: labelOf(row) || code || "—",
      parent: parentOf(row),
      rowCount: 0,
      totalQty: 0,
      totalBonusQty: 0,
      totalValue: 0,
    };
    current.rowCount += 1;
    current.totalQty += Number.isFinite(row.qty) ? row.qty : 0;
    current.totalBonusQty += Number.isFinite(row.bonusQty) ? row.bonusQty : 0;
    current.totalValue += Number.isFinite(row.value) ? row.value : 0;
    map.set(code, current);
  }
  return [...map.values()]
    .map((r) => ({ ...r, totalQty: round(r.totalQty), totalBonusQty: round(r.totalBonusQty), totalValue: round(r.totalValue) }))
    .sort((a, b) => b.totalValue - a.totalValue || a.label.localeCompare(b.label));
}

/** Build the four validation breakdown tables from coded rows. `excludeProductCodes`
 *  (confidential products) are removed before aggregation for non-CEO viewers. */
export function buildPreviewBreakdowns(coded: CodedRow[], excludeProductCodes: readonly string[] = []): PreviewBreakdowns {
  const excluded = new Set(excludeProductCodes.map((c) => c.trim().toUpperCase()).filter(Boolean));
  const rows = excluded.size === 0
    ? coded
    : coded.filter((r) => !excluded.has((r.productCode ?? "").trim().toUpperCase()));

  return {
    byProduct: aggregate(rows, (r) => r.productCode || r.productName, (r) => r.productName, (r) => r.officialLine || null),
    byRegion: aggregate(rows, (r) => r.regionCode || r.regionName, (r) => r.regionName, () => null),
    byBrick: aggregate(rows, (r) => r.brickId || r.brickName, (r) => r.brickName, (r) => r.areaName || r.regionName || null),
    byLine: aggregate(rows, (r) => r.officialLine, (r) => r.officialLine, () => null),
  };
}
