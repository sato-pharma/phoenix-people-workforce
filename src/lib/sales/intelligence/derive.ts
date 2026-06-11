import type { SiCustomerRow as SiCustomerFactRow, SiDistProductRow, SiReference } from "@/lib/sales/intelligence/loader";
import type {
  SiAreaRow,
  SiCustomerInsights,
  SiCustomerRow,
  SiDistributorRow,
  SiMonthCompleteness,
  SiProductRow,
  SiRanked,
  SiTotals,
} from "@/lib/sales/intelligence/types";

// ─────────────────────────────────────────────────────────────────────────────
// Sales Intelligence — pure aggregation/derivation. All functions take already-scoped,
// already-excluded rows and produce BY-NAME aggregates. No DB, no IO; unit-tested directly.
// ─────────────────────────────────────────────────────────────────────────────

const round = (value: number) => Number((value || 0).toFixed(6));
const round2 = (value: number) => Number((value || 0).toFixed(2));

export function sumTotals(rows: Array<{ value: number; units: number }>): SiTotals {
  let value = 0;
  let units = 0;
  for (const row of rows) {
    value += row.value;
    units += row.units;
  }
  return { value: round2(value), units: round2(units) };
}

type Accum = { name: string; value: number; units: number };

/**
 * Group rows by a name key, sum value+units, compute each group's share of the total value,
 * and return sorted by value desc. The display name resolver lets callers translate a code to
 * a name once per group.
 */
function rank<T>(
  rows: T[],
  keyOf: (row: T) => string,
  nameOf: (row: T) => string,
  valueOf: (row: T) => number,
  unitsOf: (row: T) => number,
): SiRanked[] {
  const groups = new Map<string, Accum>();
  let total = 0;
  for (const row of rows) {
    const key = keyOf(row);
    const value = valueOf(row);
    total += value;
    const current = groups.get(key);
    if (current) {
      current.value += value;
      current.units += unitsOf(row);
    } else {
      groups.set(key, { name: nameOf(row), value, units: unitsOf(row) });
    }
  }
  return [...groups.values()]
    .map((group) => ({
      name: group.name,
      value: round2(group.value),
      units: round2(group.units),
      share: total > 0 ? round(group.value / total) : 0,
    }))
    .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name));
}

export function aggregateByLine(rows: SiDistProductRow[]): SiRanked[] {
  return rank(
    rows,
    (row) => row.officialLine || "—",
    (row) => row.officialLine || "—",
    (row) => row.value,
    (row) => row.units,
  );
}

export function aggregateByProduct(rows: SiDistProductRow[]): SiProductRow[] {
  // Group by product code so two distributors' rows for the same product merge, but display the name.
  const groups = new Map<string, { name: string; officialLine: string; value: number; units: number }>();
  let total = 0;
  for (const row of rows) {
    total += row.value;
    const key = row.productCode || row.productName;
    const current = groups.get(key);
    if (current) {
      current.value += row.value;
      current.units += row.units;
    } else {
      groups.set(key, { name: row.productName || row.productCode, officialLine: row.officialLine || "—", value: row.value, units: row.units });
    }
  }
  const sorted = [...groups.values()].sort((left, right) => right.value - left.value || left.name.localeCompare(right.name));
  let cumulative = 0;
  return sorted.map((group) => {
    const share = total > 0 ? group.value / total : 0;
    cumulative += share;
    return {
      name: group.name,
      officialLine: group.officialLine,
      value: round2(group.value),
      units: round2(group.units),
      share: round(share),
      cumulativeShare: round(Math.min(cumulative, 1)),
    };
  });
}

export function aggregateByRegion(rows: SiDistProductRow[], reference: SiReference): SiRanked[] {
  return rank(
    rows,
    (row) => row.regionCode || "—",
    (row) => reference.regionName.get(row.regionCode) || row.regionCode || "—",
    (row) => row.value,
    (row) => row.units,
  );
}

export function aggregateByArea(rows: SiDistProductRow[], reference: SiReference): SiAreaRow[] {
  const groups = new Map<string, { name: string; regionName: string; value: number; units: number }>();
  let total = 0;
  for (const row of rows) {
    total += row.value;
    const key = `${row.regionCode} ${row.areaCode}`;
    const current = groups.get(key);
    if (current) {
      current.value += row.value;
      current.units += row.units;
    } else {
      groups.set(key, {
        name: reference.areaName.get(row.areaCode) || row.areaCode || "—",
        regionName: reference.regionName.get(row.regionCode) || row.regionCode || "—",
        value: row.value,
        units: row.units,
      });
    }
  }
  return [...groups.values()]
    .map((group) => ({
      name: group.name,
      regionName: group.regionName,
      value: round2(group.value),
      units: round2(group.units),
      share: total > 0 ? round(group.value / total) : 0,
    }))
    .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name));
}

export function aggregateByDistributor(rows: SiDistProductRow[], reference: SiReference): SiDistributorRow[] {
  const groups = new Map<string, { name: string; value: number; units: number; products: SiDistProductRow[] }>();
  let total = 0;
  for (const row of rows) {
    total += row.value;
    const key = row.distributorCode || "—";
    const current = groups.get(key);
    if (current) {
      current.value += row.value;
      current.units += row.units;
      current.products.push(row);
    } else {
      groups.set(key, {
        name: reference.distributorName.get(row.distributorCode) || row.distributorCode || "—",
        value: row.value,
        units: row.units,
        products: [row],
      });
    }
  }
  return [...groups.values()]
    .map((group) => ({
      name: group.name,
      value: round2(group.value),
      units: round2(group.units),
      share: total > 0 ? round(group.value / total) : 0,
      productMix: aggregateByProduct(group.products).slice(0, 8).map((product) => ({
        name: product.name,
        value: product.value,
        units: product.units,
        share: product.share,
      })),
    }))
    .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name));
}

export function aggregateCustomers(
  rows: SiCustomerFactRow[],
  reference: SiReference,
  topN = 50,
): Omit<SiCustomerInsights, "period"> {
  const groups = new Map<string, { name: string; distributorName: string; value: number; units: number }>();
  let total = 0;
  for (const row of rows) {
    total += row.value;
    const key = `${row.clientCode} ${row.distributorCode}`;
    const current = groups.get(key);
    if (current) {
      current.value += row.value;
      current.units += row.units;
    } else {
      groups.set(key, {
        name: row.clientName || row.clientCode,
        distributorName: reference.distributorName.get(row.distributorCode) || row.distributorCode || "—",
        value: row.value,
        units: row.units,
      });
    }
  }
  const ranked: SiCustomerRow[] = [...groups.values()]
    .map((group) => ({
      name: group.name,
      distributorName: group.distributorName,
      value: round2(group.value),
      units: round2(group.units),
      share: total > 0 ? round(group.value / total) : 0,
    }))
    .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name));

  const top10Value = ranked.slice(0, 10).reduce((sum, customer) => sum + customer.value, 0);
  return {
    customers: ranked.slice(0, topN),
    customerCount: groups.size,
    top10Share: total > 0 ? round(top10Value / total) : 0,
  };
}

const normCode = (value: string) => value.trim().toUpperCase();

/**
 * A month is COMPLETE only when every distributor that has EVER appeared in a validated batch
 * (in this or an earlier period) — and is still active — also uploaded a validated batch this
 * period. The earliest period is always "complete" (no prior history to expect from).
 */
export function computeMonthCompleteness(
  validatedBatches: Array<{ period: string; distributorCode: string }>,
  activeDistributorCodes: string[],
  distributorName?: Map<string, string>,
): Map<string, SiMonthCompleteness> {
  const activeSet = new Set(activeDistributorCodes.map(normCode));
  const periods = [...new Set(validatedBatches.map((batch) => batch.period).filter(Boolean))].sort();
  const result = new Map<string, SiMonthCompleteness>();
  const seenSoFar = new Set<string>();
  const display = (code: string) => distributorName?.get(code) ?? code;

  for (const period of periods) {
    const uploadedCodes = new Set(
      validatedBatches.filter((batch) => batch.period === period).map((batch) => normCode(batch.distributorCode)),
    );
    uploadedCodes.forEach((code) => seenSoFar.add(code));
    const expected = [...seenSoFar].filter((code) => activeSet.has(code)).sort();
    const uploaded = [...uploadedCodes].filter((code) => activeSet.has(code)).sort();
    const missing = expected.filter((code) => !uploadedCodes.has(code));
    result.set(period, {
      period,
      expected: expected.map(display),
      uploaded: uploaded.map(display),
      missing: missing.map(display),
      complete: missing.length === 0,
    });
  }
  return result;
}
