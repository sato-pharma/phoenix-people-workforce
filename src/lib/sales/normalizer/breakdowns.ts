import type { CodedRow, NormalizeIgnoredRow } from "@/lib/sales/normalizer/types";

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
//
// FREE GOODS: a row the distributor flagged as free goods (is_bonus) is skipped
// whole and never becomes a coded row — no distributor's bonus is ever counted
// as sales (owner, 2026-09-07, restated 2026-09-18). Its UNITS are still shown,
// in the Bonus column of By product and By line, so the Qty on screen and the
// Qty in the file reconcile without anyone opening the sheet. They touch Qty and
// Value nowhere, and Region/Brick never carry them: a flagged row is dropped
// before geography is resolved, so it has none.
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

/** The units a free-goods row carried, under the product it was for. A row whose product the alias
 *  dictionary could not place falls back to the raw name the sheet printed, so the units are still
 *  reported rather than silently dropped a second time. */
function freeGoodsUnits(
  ignoredRows: readonly NormalizeIgnoredRow[],
  excluded: ReadonlySet<string>,
): { code: string; label: string; line: string | null; qty: number }[] {
  const map = new Map<string, { code: string; label: string; line: string | null; qty: number }>();
  for (const row of ignoredRows) {
    if (row.reason !== "bonus") continue;
    const code = row.productCode || row.productName || row.rawProductName || row.rawProduct;
    if (!code) continue;
    if (excluded.has((row.productCode ?? "").trim().toUpperCase())) continue;
    const current = map.get(code) ?? {
      code,
      label: row.productName || row.rawProductName || row.rawProduct || code,
      line: row.officialLine || null,
      qty: 0,
    };
    current.qty += Number.isFinite(row.qty) ? row.qty : 0;
    map.set(code, current);
  }
  return [...map.values()];
}

/** Add the excluded free-goods units to an existing breakdown table's Bonus column, keyed the way
 *  `aggregate` keys it. A product that sold NOTHING but free goods gets its own row — qty 0, value 0
 *  — because "it is not in the table at all" is exactly how 1,522 packs went missing. `rowCount`
 *  stays the count of CODED rows: nothing here was coded. */
function withFreeGoods(
  rows: PreviewBreakdownRow[],
  units: { code: string; label: string; line: string | null; qty: number }[],
  keyOf: (u: { code: string; line: string | null }) => string,
  labelOf: (u: { code: string; label: string; line: string | null }) => string,
  parentOf: (u: { line: string | null }) => string | null,
): PreviewBreakdownRow[] {
  if (units.length === 0) return rows;
  const byKey = new Map(rows.map((r) => [r.code, r]));
  const merged = [...rows];
  for (const unit of units) {
    const key = keyOf(unit);
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) {
      existing.totalBonusQty = round(existing.totalBonusQty + unit.qty);
      continue;
    }
    const created: PreviewBreakdownRow = {
      code: key,
      label: labelOf(unit) || key,
      parent: parentOf(unit),
      rowCount: 0,
      totalQty: 0,
      totalBonusQty: round(unit.qty),
      totalValue: 0,
    };
    byKey.set(key, created);
    merged.push(created);
  }
  return merged.sort((a, b) => b.totalValue - a.totalValue || a.label.localeCompare(b.label));
}

/** Build the four validation breakdown tables from coded rows. `excludeProductCodes`
 *  (confidential products) are removed before aggregation for non-CEO viewers.
 *  `ignoredRows` carries the recognizer's skipped rows: the free-goods ones among them report their
 *  units in the Bonus column (never Qty, never Value) so the screen reconciles with the file. */
export function buildPreviewBreakdowns(
  coded: CodedRow[],
  excludeProductCodes: readonly string[] = [],
  ignoredRows: readonly NormalizeIgnoredRow[] = [],
): PreviewBreakdowns {
  const excluded = new Set(excludeProductCodes.map((c) => c.trim().toUpperCase()).filter(Boolean));
  const rows = excluded.size === 0
    ? coded
    : coded.filter((r) => !excluded.has((r.productCode ?? "").trim().toUpperCase()));
  const freeGoods = freeGoodsUnits(ignoredRows, excluded);

  return {
    byProduct: withFreeGoods(
      aggregate(rows, (r) => r.productCode || r.productName, (r) => r.productName, (r) => r.officialLine || null),
      freeGoods,
      (u) => u.code,
      (u) => u.label,
      (u) => u.line,
    ),
    byRegion: aggregate(rows, (r) => r.regionCode || r.regionName, (r) => r.regionName, () => null),
    byBrick: aggregate(rows, (r) => r.brickId || r.brickName, (r) => r.brickName, (r) => r.areaName || r.regionName || null),
    byLine: withFreeGoods(
      aggregate(rows, (r) => r.officialLine, (r) => r.officialLine, () => null),
      freeGoods.filter((u) => Boolean(u.line)),
      (u) => u.line ?? "",
      (u) => u.line ?? "",
      () => null,
    ),
  };
}

/** The total units every free-goods row excluded, for the reconciliation receipt. */
export function freeGoodsQtyTotal(ignoredRows: readonly NormalizeIgnoredRow[]): number {
  return round(
    ignoredRows.reduce((sum, r) => (r.reason === "bonus" && Number.isFinite(r.qty) ? sum + r.qty : sum), 0),
  );
}
