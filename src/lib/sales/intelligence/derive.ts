import { daysInPeriod, periodDayIso } from "@/lib/sales/periods";
import type {
  SiCustomerRow as SiCustomerFactRow,
  SiDailyRow,
  SiDistProductRow,
  SiPeriodTotalRow,
  SiReference,
} from "@/lib/sales/intelligence/loader";
import type {
  SiAreaRow,
  SiConcentrationIndex,
  SiCustomerInsights,
  SiCustomerRow,
  SiDailyCurve,
  SiDelta,
  SiDistributorRow,
  SiMonthCompleteness,
  SiMoverRow,
  SiMoverSet,
  SiProductRow,
  SiRanked,
  SiRunRate,
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

// Geography (region/area) views show FIELD regions only. The whole Direct (company) channel is
// non-geographic — it carries a synthetic NATIONAL region and/or a 'DIRECT' area bucket and is
// head-office, not field-rep, sales — so it is dropped here. Direct still surfaces in the
// distributor breakdown and the net-sales total, which use the UNFILTERED rows. This mirrors the
// monthly closing keeping "Direct – National" out of the region subtotals.
const NON_GEOGRAPHIC_REGION_CODES = new Set(["NATIONAL", ""]);
const DIRECT_CHANNEL_CODE = "DIRECT";

export function geographicRows<T extends { regionCode: string; distributorCode?: string; areaCode?: string }>(
  rows: T[],
): T[] {
  return rows.filter((row) => {
    if (NON_GEOGRAPHIC_REGION_CODES.has((row.regionCode || "").trim().toUpperCase())) return false;
    if ((row.distributorCode || "").trim().toUpperCase() === DIRECT_CHANNEL_CODE) return false;
    if ((row.areaCode || "").trim().toUpperCase() === DIRECT_CHANNEL_CODE) return false;
    return true;
  });
}

/**
 * Resolve a code to its human display name — and NEVER fall back to the raw code. The executive
 * surface is a hard "no codes on screen" zone: an unmapped code collapses to a humane label
 * ("Unmapped area") instead of leaking a value like "B117" or "DIRECT". Lookup is case-insensitive
 * so a master keyed "Direct" still resolves an import row coded "DIRECT".
 */
export function displayName(map: Map<string, string>, code: string | undefined, unmappedLabel: string): string {
  const raw = (code ?? "").trim();
  if (!raw) return unmappedLabel;
  const name = map.get(raw) ?? map.get(raw.toUpperCase()) ?? map.get(raw.toLowerCase());
  if (name && name.trim() && name.trim().toUpperCase() !== raw.toUpperCase()) return name.trim();
  return unmappedLabel;
}

export type SiDetailsFilters = {
  distributorCode?: string | null;
  regionCode?: string | null;
  areaCode?: string | null;
  officialLine?: string | null;
  productCode?: string | null;
};

/** Narrow detail rows by any combination of distributor / region / area / line / product. Empty
 *  fields match everything. Codes compare case-insensitively; line compares by its display text. */
export function applyDetailsFilters<
  T extends { distributorCode: string; regionCode: string; areaCode: string; officialLine: string; productCode: string },
>(rows: T[], filters: SiDetailsFilters): T[] {
  const norm = (value?: string | null) => (value ?? "").trim().toUpperCase();
  const wantDist = norm(filters.distributorCode);
  const wantRegion = norm(filters.regionCode);
  const wantArea = norm(filters.areaCode);
  const wantLine = (filters.officialLine ?? "").trim().toLowerCase();
  const wantProduct = norm(filters.productCode);
  return rows.filter(
    (row) =>
      (!wantDist || norm(row.distributorCode) === wantDist) &&
      (!wantRegion || norm(row.regionCode) === wantRegion) &&
      (!wantArea || norm(row.areaCode) === wantArea) &&
      (!wantLine || (row.officialLine ?? "").trim().toLowerCase() === wantLine) &&
      (!wantProduct || norm(row.productCode) === wantProduct),
  );
}

/** Narrow CUSTOMER-grain rows (which carry no line/product dimension — a customer spans many
 *  products) by the geography/channel filters they DO support: distributor / region / area.
 *  Line/product filters are intentionally ignored here; callers surface that to the user. */
export function applyGeoChannelFilters<
  T extends { distributorCode: string; regionCode: string; areaCode: string },
>(rows: T[], filters: SiDetailsFilters): T[] {
  const norm = (value?: string | null) => (value ?? "").trim().toUpperCase();
  const wantDist = norm(filters.distributorCode);
  const wantRegion = norm(filters.regionCode);
  const wantArea = norm(filters.areaCode);
  if (!wantDist && !wantRegion && !wantArea) return rows;
  return rows.filter(
    (row) =>
      (!wantDist || norm(row.distributorCode) === wantDist) &&
      (!wantRegion || norm(row.regionCode) === wantRegion) &&
      (!wantArea || norm(row.areaCode) === wantArea),
  );
}

/** True when a filter set narrows by a dimension a customer/daily aggregate can't follow. */
export function hasProductOrLineFilter(filters: SiDetailsFilters): boolean {
  return Boolean((filters.officialLine ?? "").trim() || (filters.productCode ?? "").trim());
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
  // Group by product code so two distributors' rows for the same product merge, but display the
  // name. The code rides along as an opaque drill key (never displayed).
  const groups = new Map<string, { code: string; name: string; officialLine: string; value: number; units: number }>();
  let total = 0;
  for (const row of rows) {
    total += row.value;
    const key = row.productCode || row.productName;
    const current = groups.get(key);
    if (current) {
      current.value += row.value;
      current.units += row.units;
    } else {
      groups.set(key, {
        code: normCode(row.productCode || row.productName),
        name: row.productName || row.productCode,
        officialLine: row.officialLine || "—",
        value: row.value,
        units: row.units,
      });
    }
  }
  const sorted = [...groups.values()].sort((left, right) => right.value - left.value || left.name.localeCompare(right.name));
  let cumulative = 0;
  return sorted.map((group) => {
    const share = total > 0 ? group.value / total : 0;
    cumulative += share;
    return {
      code: group.code,
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
    (row) => displayName(reference.regionName, row.regionCode, "Unmapped region"),
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
        name: displayName(reference.areaName, row.areaCode, "Unmapped area"),
        regionName: displayName(reference.regionName, row.regionCode, "Unmapped region"),
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
        name: displayName(reference.distributorName, row.distributorCode, "Unmapped distributor"),
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
  const groups = new Map<string, { name: string; distributorName: string; brick: string; value: number; units: number }>();
  let total = 0;
  for (const row of rows) {
    total += row.value;
    const key = `${row.clientCode} ${row.distributorCode}`;
    const current = groups.get(key);
    if (current) {
      current.value += row.value;
      current.units += row.units;
    } else {
      // Locate the customer by its finest mapped place — brick first, area as fallback. Never a
      // raw code: an unmapped brick/area collapses to "—".
      const brickLabel = displayName(reference.brickName, row.brickId, "");
      const brick = brickLabel || displayName(reference.areaName, row.areaCode, "") || "—";
      groups.set(key, {
        name: row.clientName || row.clientCode,
        distributorName: displayName(reference.distributorName, row.distributorCode, "Unmapped distributor"),
        brick,
        value: row.value,
        units: row.units,
      });
    }
  }
  const ranked: SiCustomerRow[] = [...groups.values()]
    .map((group) => ({
      name: group.name,
      distributorName: group.distributorName,
      brick: group.brick,
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

// ── v2 executive analytics (pure) ────────────────────────────────────────────────────────────

export type SiKeyedRanked = SiRanked & { key: string };

/** Like rank(), but carries a stable join KEY (code) so MoM joins never depend on display names. */
function rankKeyed<T>(
  rows: T[],
  keyOf: (row: T) => string,
  nameOf: (row: T) => string,
): SiKeyedRanked[] {
  const groups = new Map<string, { key: string; name: string; value: number; units: number }>();
  let total = 0;
  for (const row of rows as Array<T & { value: number; units: number }>) {
    const key = normCode(keyOf(row)) || "—";
    total += row.value;
    const current = groups.get(key);
    if (current) {
      current.value += row.value;
      current.units += row.units;
    } else {
      groups.set(key, { key, name: nameOf(row), value: row.value, units: row.units });
    }
  }
  return [...groups.values()]
    .map((group) => ({
      key: group.key,
      name: group.name,
      value: round2(group.value),
      units: round2(group.units),
      share: total > 0 ? round(group.value / total) : 0,
    }))
    .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name));
}

export function aggregateByProductKeyed(rows: SiDistProductRow[]): Array<SiKeyedRanked & { officialLine: string }> {
  const lineByKey = new Map<string, string>();
  for (const row of rows) {
    const key = normCode(row.productCode) || "—";
    if (!lineByKey.has(key)) lineByKey.set(key, row.officialLine || "—");
  }
  return rankKeyed(rows, (row) => row.productCode || row.productName, (row) => row.productName || row.productCode)
    .map((entry) => ({ ...entry, officialLine: lineByKey.get(entry.key) ?? "—" }));
}

export function aggregateByDistributorKeyed(rows: SiDistProductRow[], reference: SiReference): SiKeyedRanked[] {
  return rankKeyed(rows, (row) => row.distributorCode, (row) => reference.distributorName.get(row.distributorCode) || row.distributorCode || "—");
}

export function aggregateByRegionKeyed(rows: SiDistProductRow[], reference: SiReference): SiKeyedRanked[] {
  return rankKeyed(rows, (row) => row.regionCode, (row) => reference.regionName.get(row.regionCode) || row.regionCode || "—");
}

/** MoM delta: pct is null when the baseline is missing or zero — never invented. */
export function makeDelta(current: number, prior: number | null): SiDelta {
  const pct = prior !== null && prior !== 0 ? round((current - prior) / Math.abs(prior)) : null;
  return { current: round2(current), prior: prior === null ? null : round2(prior), pct };
}

/**
 * Movers between two keyed aggregates. prior === null (baseline month not imported) yields empty
 * sets — the UI swaps to a no-baseline presentation rather than half-rendering.
 */
export function computeMovers(
  current: SiKeyedRanked[],
  prior: SiKeyedRanked[] | null,
  topN = 10,
): SiMoverSet {
  if (prior === null) return { gainers: [], decliners: [], entrants: [], lost: [] };
  const priorByKey = new Map(prior.map((row, index) => [row.key, { row, rank: index + 1 }]));
  const currentKeys = new Set(current.map((row) => row.key));

  const movers: SiMoverRow[] = current.map((row, index) => {
    const baseline = priorByKey.get(row.key);
    const priorValue = baseline ? baseline.row.value : null;
    return {
      key: row.key,
      name: row.name,
      value: row.value,
      priorValue,
      deltaValue: round2(row.value - (priorValue ?? 0)),
      deltaPct: priorValue !== null && priorValue !== 0 ? round((row.value - priorValue) / Math.abs(priorValue)) : null,
      rank: index + 1,
      priorRank: baseline ? baseline.rank : null,
      isNew: !baseline,
    };
  });

  const changed = movers.filter((mover) => !mover.isNew);
  const gainers = changed.filter((mover) => mover.deltaValue > 0).sort((a, b) => b.deltaValue - a.deltaValue).slice(0, topN);
  const decliners = changed.filter((mover) => mover.deltaValue < 0).sort((a, b) => a.deltaValue - b.deltaValue).slice(0, topN);
  const entrants = movers.filter((mover) => mover.isNew && mover.value > 0).sort((a, b) => b.value - a.value).slice(0, topN);
  const lost: SiMoverRow[] = prior
    .filter((row) => !currentKeys.has(row.key) && row.value > 0)
    .slice(0, topN)
    .map((row, index) => ({
      key: row.key,
      name: row.name,
      value: 0,
      priorValue: row.value,
      deltaValue: round2(-row.value),
      deltaPct: -1,
      rank: 0,
      priorRank: index + 1,
      isNew: false,
    }));
  return { gainers, decliners, entrants, lost };
}

/**
 * Zero-filled daily curve for one month. Sums across distributors per day; cumulative MTD; the
 * NULL-date bucket is carried as undatedValue/Units so totals always reconcile honestly.
 */
export function buildDailyCurve(rows: SiDailyRow[], period: string): SiDailyCurve {
  const totalDays = daysInPeriod(period);
  const byDay = new Map<number, { value: number; units: number; customers: number }>();
  let undatedValue = 0;
  let undatedUnits = 0;
  for (const row of rows) {
    if (!row.invoiceDate) {
      undatedValue += row.value;
      undatedUnits += row.units;
      continue;
    }
    const day = Number(row.invoiceDate.slice(8, 10));
    if (!Number.isInteger(day) || day < 1 || day > totalDays) {
      undatedValue += row.value;
      undatedUnits += row.units;
      continue;
    }
    const current = byDay.get(day) ?? { value: 0, units: 0, customers: 0 };
    current.value += row.value;
    current.units += row.units;
    current.customers += row.customerCount;
    byDay.set(day, current);
  }

  let cumulative = 0;
  const points = Array.from({ length: totalDays }, (_, index) => {
    const day = index + 1;
    const entry = byDay.get(day) ?? { value: 0, units: 0, customers: 0 };
    cumulative += entry.value;
    return {
      date: periodDayIso(period, day),
      day,
      value: round2(entry.value),
      units: round2(entry.units),
      customers: entry.customers,
      cumulativeValue: round2(cumulative),
    };
  });

  const datedValue = cumulative;
  const datedValueShare = datedValue + undatedValue > 0 ? round(datedValue / (datedValue + undatedValue)) : 0;
  return {
    period,
    points,
    undatedValue: round2(undatedValue),
    undatedUnits: round2(undatedUnits),
    datedValueShare,
  };
}

/**
 * Month-end projection from the daily pace. Only meaningful for an in-flight month (incomplete
 * uploads or the current calendar month); `reliable` requires ≥80% dated value and ≥5 traded days.
 */
export function computeRunRate(
  curve: SiDailyCurve | null,
  totals: SiTotals,
  flags: { monthComplete: boolean; isCurrentCalendarMonth: boolean },
): SiRunRate {
  if (!curve) return null;
  if (flags.monthComplete && !flags.isCurrentCalendarMonth) return null;
  const tradedDays = curve.points.filter((point) => point.value > 0);
  const daysElapsed = tradedDays.length > 0 ? tradedDays[tradedDays.length - 1].day : 0;
  if (daysElapsed === 0) return null;
  const daysInMonth = curve.points.length;
  const dailyAvgValue = totals.value / daysElapsed;
  return {
    projectedValue: round2(dailyAvgValue * daysInMonth),
    daysElapsed,
    daysInMonth,
    dailyAvgValue: round2(dailyAvgValue),
    datedValueShare: curve.datedValueShare,
    reliable: curve.datedValueShare >= 0.8 && tradedDays.length >= 5,
  };
}

/** Herfindahl–Hirschman concentration over value shares. */
export function concentrationIndices(items: Array<{ value: number }>): SiConcentrationIndex {
  const total = items.reduce((sum, item) => sum + Math.max(item.value, 0), 0);
  if (total <= 0) return { hhi: 0, top1Share: 0, top5Share: 0, band: "low" };
  const shares = items
    .map((item) => Math.max(item.value, 0) / total)
    .sort((left, right) => right - left);
  const hhi = Math.round(shares.reduce((sum, share) => sum + share * share, 0) * 10000);
  const top1Share = round(shares[0] ?? 0);
  const top5Share = round(shares.slice(0, 5).reduce((sum, share) => sum + share, 0));
  return { hhi, top1Share, top5Share, band: hhi > 2500 ? "high" : hhi >= 1500 ? "moderate" : "low" };
}

/** New / lost / retained customers between two months (keys = clientCode×distributorCode). */
export function diffCustomerSets(
  current: SiCustomerFactRow[],
  prior: SiCustomerFactRow[] | null,
  reference: SiReference,
  topN = 25,
): {
  newCount: number; lostCount: number; retainedCount: number; retentionRate: number | null;
  newValue: number; lostPriorValue: number; topNew: SiCustomerRow[]; topLost: SiCustomerRow[];
} {
  const keyOf = (row: SiCustomerFactRow) => `${normCode(row.clientCode)} ${normCode(row.distributorCode)}`;
  const toRow = (row: SiCustomerFactRow, value: number): SiCustomerRow => ({
    name: row.clientName || row.clientCode,
    distributorName: displayName(reference.distributorName, row.distributorCode, "Unmapped distributor"),
    brick: displayName(reference.brickName, row.brickId, "") || displayName(reference.areaName, row.areaCode, "") || "—",
    value: round2(value),
    units: round2(row.units),
    share: 0,
  });
  if (prior === null) {
    return { newCount: 0, lostCount: 0, retainedCount: 0, retentionRate: null, newValue: 0, lostPriorValue: 0, topNew: [], topLost: [] };
  }
  const priorByKey = new Map(prior.map((row) => [keyOf(row), row]));
  const currentKeys = new Set(current.map(keyOf));
  const fresh = current.filter((row) => !priorByKey.has(keyOf(row)));
  const lost = prior.filter((row) => !currentKeys.has(keyOf(row)));
  const retainedCount = current.length - fresh.length;
  return {
    newCount: fresh.length,
    lostCount: lost.length,
    retainedCount,
    retentionRate: prior.length > 0 ? round(retainedCount / prior.length) : null,
    newValue: round2(fresh.reduce((sum, row) => sum + row.value, 0)),
    lostPriorValue: round2(lost.reduce((sum, row) => sum + row.value, 0)),
    topNew: [...fresh].sort((a, b) => b.value - a.value).slice(0, topN).map((row) => toRow(row, row.value)),
    topLost: [...lost].sort((a, b) => b.value - a.value).slice(0, topN).map((row) => toRow(row, row.value)),
  };
}

/** Per-period KPI spark series from the one-scan period totals. */
export function buildKpiSparks(
  periodTotals: SiPeriodTotalRow[],
  completeness: Map<string, SiMonthCompleteness>,
  maxPoints = 12,
) {
  return periodTotals.slice(-maxPoints).map((row) => ({
    period: row.period,
    value: round2(row.value),
    units: round2(row.units),
    customers: row.customerCount,
    products: row.productCount,
    areas: row.areaCount,
    avgPrice: row.units > 0 ? round2(row.value / row.units) : 0,
    monthComplete: completeness.get(row.period)?.complete ?? true,
  }));
}

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

/** The newest period that is COMPLETE (every distributor seen so far also uploaded). null when
 *  there are no periods or none is complete. `availablePeriods` may arrive in any order. */
export function latestCompletePeriod(
  availablePeriods: string[],
  completeness: Map<string, SiMonthCompleteness>,
): string | null {
  return (
    [...availablePeriods]
      .sort((left, right) => right.localeCompare(left))
      .find((period) => completeness.get(period)?.complete) ?? null
  );
}

/**
 * Default landing month. Prefer the latest COMPLETE period. But "complete" ratchets — every
 * distributor ever seen is expected forever — so with sporadic uploads no month is ever complete
 * and a naive "newest" default lands on the freshest THIN partial (e.g. a month where only the one
 * fast distributor has reported), which reads as "only one distributor exists". So when nothing is
 * complete, land on the RICHEST recent month — the one with the most distributors uploaded — and
 * break ties toward the newest. The viewer can always switch months from the filter bar.
 */
export function pickDefaultPeriod(
  availablePeriods: string[],
  completeness: Map<string, SiMonthCompleteness>,
): string | null {
  if (availablePeriods.length === 0) return null;
  const byNewest = [...availablePeriods].sort((left, right) => right.localeCompare(left));
  const complete = latestCompletePeriod(availablePeriods, completeness);
  if (complete) return complete;
  let best = byNewest[0] ?? null;
  let bestCount = -1;
  for (const period of byNewest) {
    const count = completeness.get(period)?.uploaded.length ?? 0;
    if (count > bestCount) {
      bestCount = count;
      best = period;
    }
  }
  return best;
}
