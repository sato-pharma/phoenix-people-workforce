// The two Store Split sheets for a CONSOLIDATED closing workbook — several months of one line,
// added together.
//
// 🔒 SPLIT EACH MONTH, THEN ADD (owner, 2026-09-14, asked and answered).
//
// The split is a property of ONE month. A warehouse's band — the 200-pack threshold, and El Qema's
// ≤200 / 201–699 / ≥700 — is judged on that month's own total per warehouse and product
// (`warehouseSplitQtyByKey` sums every row it is handed). Handing the split several months' rows in
// one call would therefore re-judge every band on the COMBINED total: 150 packs in July and 150 in
// August would read as 300, cross 200 and split, when the closing split neither month. The numbers
// would be plausible and wrong, which is the worst kind.
//
// So each month is split exactly as its own single-month workbook splits it, and only the ANSWERS
// are added. Nothing here re-implements the rule; it calls the same three functions the builder
// calls, once per month.
//
// Months the split was not applied to (before August 2026 — owner, 2026-09-04) are left out when any
// month of the selection WAS split, because their movements are hypothetical and the Closing Matrix
// beside these sheets does not carry them. A selection where no month was split keeps them all, and
// the sheet's own note then says the figures are for reference only, exactly as July's file does.

import { closingAreaOf } from "@/lib/sales/closing-row-area";
import {
  detailStoreSplitByCustomer,
  isStoreCitySplitActive,
  summariseStoreSplitByArea,
  type SplitRegions,
  type StoreSplitAreaSummary,
  type StoreSplitCustomerSummary,
  type StoreSplitDetailRow,
  type StoreSplitRow,
} from "@/lib/sales/store-sales-city-split";

type SplitSourceRow = StoreSplitRow & { areaName?: string; clientCode?: string; productName?: string };

/** One month's whole rows, as its own single-month export would hand them to the split. */
export type StoreSplitMonth<T extends SplitSourceRow = SplitSourceRow> = {
  period: string;
  /** That month's organogram Others — they take no share of an El Qema split. Per month, like the rows. */
  regions?: SplitRegions;
  rows: readonly T[];
};

/** The months whose split the sheets describe — see the header note. */
export function storeSplitMonthsToReport<T extends SplitSourceRow>(
  months: readonly StoreSplitMonth<T>[],
): StoreSplitMonth<T>[] {
  const applied = months.filter((month) => isStoreCitySplitActive(month.period));
  return applied.length > 0 ? applied : [...months];
}

const AREA_SUMS = [
  "beforeQty",
  "beforeValue",
  "movedOutQty",
  "movedOutValue",
  "receivedQty",
  "receivedValue",
  "netQty",
  "netValue",
  "afterQty",
  "afterValue",
] as const;

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}

function areaLineKey(areaCode: string, line: string): string {
  return `${String(areaCode ?? "").trim().toUpperCase()}|${String(line ?? "").trim()}`;
}

/** The Store Split sheet: per area and line, every month's own split added. */
export function foldStoreSplitByArea<T extends SplitSourceRow>(
  months: readonly StoreSplitMonth<T>[],
): StoreSplitAreaSummary[] {
  const perMonth = storeSplitMonthsToReport(months).map((month) => ({
    month,
    summary: summariseStoreSplitByArea(month.rows, month.period, month.regions),
  }));

  const byKey = new Map<string, StoreSplitAreaSummary>();
  for (const { summary } of perMonth) {
    for (const entry of summary) {
      const key = areaLineKey(entry.areaCode, entry.line);
      const found = byKey.get(key);
      if (!found) {
        byKey.set(key, { ...entry });
        continue;
      }
      for (const field of AREA_SUMS) found[field] = round2(found[field] + entry[field]);
    }
  }

  // An area the split touched in only SOME months still sold in the others. A month's summary omits
  // an untouched area, so without this "Sales now" would cover part of the span while the Closing
  // Matrix beside it covers all of it. Those months' sales are added unmoved: before and after both
  // grow, what moved does not.
  for (const { month, summary } of perMonth) {
    const touched = new Set(summary.map((entry) => areaLineKey(entry.areaCode, entry.line)));
    const wanted = new Set([...byKey.keys()].filter((key) => !touched.has(key)));
    if (wanted.size === 0) continue;
    const sales = new Map<string, { qty: number; value: number }>();
    for (const row of month.rows) {
      if (row.isDirect || !row.includedInClosing) continue;
      const key = areaLineKey(closingAreaOf(row), String(row.officialLine ?? ""));
      if (!wanted.has(key)) continue;
      const entry = sales.get(key) ?? { qty: 0, value: 0 };
      entry.qty += Number(row.qty) || 0;
      entry.value += Number(row.salesValue) || 0;
      sales.set(key, entry);
    }
    for (const [key, sold] of sales) {
      const entry = byKey.get(key);
      if (!entry) continue;
      entry.beforeQty = round2(entry.beforeQty + sold.qty);
      entry.beforeValue = round2(entry.beforeValue + sold.value);
      entry.afterQty = round2(entry.afterQty + sold.qty);
      entry.afterValue = round2(entry.afterValue + sold.value);
    }
  }

  return [...byKey.values()];
}

/**
 * The Store Split Detail sheet's lower table: store x product, every month's own split added.
 *
 * Two months fold into one row only when the store, its area, the product AND the areas the sale was
 * shared across are identical — then every share is additive, because each is that month's value
 * over the same set of areas. A month whose band put the sale over a different set of areas keeps
 * its own row, rather than averaging two different splits into one that never happened.
 */
export function foldStoreSplitDetail<T extends SplitSourceRow>(
  months: readonly StoreSplitMonth<T>[],
): StoreSplitDetailRow[] {
  const byKey = new Map<string, StoreSplitDetailRow>();
  for (const month of storeSplitMonthsToReport(months)) {
    for (const detail of detailStoreSplitByCustomer(month.rows, month.period, month.regions)) {
      const key = [
        detail.clientCode,
        detail.clientName,
        detail.originAreaCode,
        detail.line,
        detail.productCode,
        detail.homeAreaCodes.join(","),
        detail.awayAreaCodes.join(","),
        detail.sharedWithAreaCodes.join(","),
      ].join("|");
      const found = byKey.get(key);
      if (!found) {
        byKey.set(key, { ...detail });
        continue;
      }
      found.units = round2(found.units + detail.units);
      found.value = round2(found.value + detail.value);
      found.shareUnits = round3(found.shareUnits + detail.shareUnits);
      found.shareValue = round2(found.shareValue + detail.shareValue);
      found.awayShareUnits = round3(found.awayShareUnits + detail.awayShareUnits);
      found.awayShareValue = round2(found.awayShareValue + detail.awayShareValue);
      found.originKeepsValue = round2(found.originKeepsValue + detail.originKeepsValue);
    }
  }
  return [...byKey.values()].sort(
    (left, right) => right.value - left.value
      || left.clientName.localeCompare(right.clientName)
      || left.productName.localeCompare(right.productName),
  );
}

/** The Store Split Detail sheet's upper table: one row per store, every month's own split added. */
export function foldStoreSplitByCustomer<T extends SplitSourceRow>(
  months: readonly StoreSplitMonth<T>[],
): StoreSplitCustomerSummary[] {
  const byStore = new Map<string, StoreSplitCustomerSummary & { productCodes: Set<string> }>();
  for (const month of storeSplitMonthsToReport(months)) {
    for (const detail of detailStoreSplitByCustomer(month.rows, month.period, month.regions)) {
      const key = `${detail.clientCode}|${detail.clientName}|${detail.originAreaCode}|${detail.line}`;
      const existing = byStore.get(key);
      if (existing) {
        existing.units = round2(existing.units + detail.units);
        existing.value = round2(existing.value + detail.value);
        existing.productCodes.add(detail.productCode);
        existing.products = existing.productCodes.size;
        // The widest split the store had in any month of the span.
        existing.areasSharedWith = Math.max(existing.areasSharedWith, detail.sharedWithAreaCodes.length);
        continue;
      }
      byStore.set(key, {
        areasSharedWith: detail.sharedWithAreaCodes.length,
        city: detail.city,
        clientCode: detail.clientCode,
        clientName: detail.clientName,
        line: detail.line,
        originAreaCode: detail.originAreaCode,
        originAreaName: detail.originAreaName,
        productCodes: new Set([detail.productCode]),
        products: 1,
        units: detail.units,
        value: detail.value,
      });
    }
  }
  return [...byStore.values()]
    .map(({ productCodes: _productCodes, ...summary }) => summary)
    .sort((left, right) => right.value - left.value || left.clientName.localeCompare(right.clientName));
}
