// THE CUSTOMER COUNT DASHBOARD — how many pharmacies bought, month by month, cut by line, product,
// region, area, brick and medical rep (owner, 24 Nov 2026: "I want to be able to track and export
// and have a dashboard of the number of customers … month by month, per product, per line, per rep,
// per area, per region, per brick, per everything", then "keep a monthly closing sheets, but I want
// a dashboard specialized for now customer count").
//
// WHO BOUGHT is decided once, in closing-pharmacy-counts.ts (`monthBuyingEntries`), the same rule
// the Closing Matrix's Pharmacies column reads — so a month here is the number that month's closing
// shows. Each month is judged on its own.
//
// The payload is a list of FACTS — one per (month, line, pharmacy, area, brick, product) — with
// every name dictionary-coded. Any cut the screen asks for is then a count of DISTINCT pharmacy ids
// over the facts that pass the filters: a pharmacy that bought three products counts once in its
// area, once in its region, once on the line and once in the company. Pharmacy ids are small
// integers that mean nothing outside one payload; no customer code or name ever leaves the server.
//
// Client-safe: types and pure functions only.

export type CustomerCountArea = { code: string; name: string; region: number };
export type CustomerCountProduct = { code: string; name: string; line: number };
export type CustomerCountBrick = { name: string; area: number };

/** [month, line, pharmacy, area, brick, product, rep] — indexes into the payload's lists. */
export type CustomerCountFact = [number, number, number, number, number, number, number];

export type CustomerCountPayload = {
  /** The months loaded, oldest first ("2026-08"). */
  months: string[];
  lines: string[];
  products: CustomerCountProduct[];
  regions: string[];
  areas: CustomerCountArea[];
  bricks: CustomerCountBrick[];
  /** The rep on the area's seat at the END of that month — a past month names whoever held it then. */
  reps: string[];
  facts: CustomerCountFact[];
  /** Every month the viewer could pick (published), newest first; and every line they may read. */
  availableMonths: string[];
  availableLines: string[];
  /** Line → month pairs that were asked for but not published, so the screen can say so. */
  unpublished: { line: string; month: string }[];
};

export const F_MONTH = 0;
export const F_LINE = 1;
export const F_PHARMACY = 2;
export const F_AREA = 3;
export const F_BRICK = 4;
export const F_PRODUCT = 5;
export const F_REP = 6;

export type CustomerCountFilters = {
  lines?: readonly number[];
  products?: readonly number[];
  regions?: readonly number[];
  areas?: readonly number[];
  reps?: readonly number[];
};

export type CustomerCountDimension = "line" | "product" | "region" | "area" | "brick" | "rep";

export const DIMENSION_LABELS: Record<CustomerCountDimension, string> = {
  line: "Line",
  product: "Product",
  region: "Region",
  area: "Area",
  brick: "Brick",
  rep: "Medical Rep",
};

const asSet = (values: readonly number[] | undefined) => (values && values.length > 0 ? new Set(values) : null);

/** The facts that pass every filter. An empty filter list means "all". */
export function filterFacts(payload: CustomerCountPayload, filters: CustomerCountFilters): CustomerCountFact[] {
  const lines = asSet(filters.lines);
  const products = asSet(filters.products);
  const regions = asSet(filters.regions);
  const areas = asSet(filters.areas);
  const reps = asSet(filters.reps);
  if (!lines && !products && !regions && !areas && !reps) return payload.facts;
  return payload.facts.filter((fact) => {
    if (lines && !lines.has(fact[F_LINE])) return false;
    if (products && !products.has(fact[F_PRODUCT])) return false;
    if (areas && !areas.has(fact[F_AREA])) return false;
    if (regions && !regions.has(payload.areas[fact[F_AREA]]?.region ?? -1)) return false;
    if (reps && !reps.has(fact[F_REP])) return false;
    return true;
  });
}

/** month index → the set of pharmacy ids that bought in it. */
export function pharmaciesByMonth(payload: CustomerCountPayload, facts: readonly CustomerCountFact[]): Set<number>[] {
  const sets = payload.months.map(() => new Set<number>());
  for (const fact of facts) sets[fact[F_MONTH]]?.add(fact[F_PHARMACY]);
  return sets;
}

export type CustomerCountMonthPoint = {
  month: string;
  /** Distinct pharmacies that bought in the month. */
  pharmacies: number;
  /** Bought this month, not the month before. Null for the first month loaded (nothing to compare). */
  gained: number | null;
  /** Bought the month before, not this month. */
  lost: number | null;
  /** Average number of products each buying pharmacy took. */
  productsPerPharmacy: number;
};

export function monthTrend(payload: CustomerCountPayload, facts: readonly CustomerCountFact[]): CustomerCountMonthPoint[] {
  const byMonth = pharmaciesByMonth(payload, facts);
  const pairs = payload.months.map(() => new Set<string>());
  for (const fact of facts) pairs[fact[F_MONTH]]?.add(`${fact[F_PHARMACY]}|${fact[F_PRODUCT]}`);
  return payload.months.map((month, index) => {
    const now = byMonth[index];
    const before = index > 0 ? byMonth[index - 1] : null;
    let gained: number | null = null;
    let lost: number | null = null;
    if (before) {
      gained = 0;
      lost = 0;
      for (const id of now) if (!before.has(id)) gained += 1;
      for (const id of before) if (!now.has(id)) lost += 1;
    }
    return {
      month,
      pharmacies: now.size,
      gained,
      lost,
      productsPerPharmacy: now.size > 0 ? pairs[index].size / now.size : 0,
    };
  });
}

export type CustomerCountSummary = {
  latestMonth: string | null;
  previousMonth: string | null;
  latest: number;
  previous: number | null;
  gained: number | null;
  lost: number | null;
  /** Distinct pharmacies that bought in ANY month on show. */
  reached: number;
  /** Bought in EVERY month on show. */
  everyMonth: number;
  productsPerPharmacy: number;
};

export function summarize(payload: CustomerCountPayload, facts: readonly CustomerCountFact[]): CustomerCountSummary {
  const trend = monthTrend(payload, facts);
  const byMonth = pharmaciesByMonth(payload, facts);
  const reached = new Set<number>();
  for (const set of byMonth) for (const id of set) reached.add(id);
  let everyMonth = 0;
  if (byMonth.length > 0) for (const id of reached) if (byMonth.every((set) => set.has(id))) everyMonth += 1;
  const last = trend.at(-1) ?? null;
  const prior = trend.length > 1 ? trend[trend.length - 2] : null;
  return {
    latestMonth: last?.month ?? null,
    previousMonth: prior?.month ?? null,
    latest: last?.pharmacies ?? 0,
    previous: prior ? prior.pharmacies : null,
    gained: last?.gained ?? null,
    lost: last?.lost ?? null,
    reached: reached.size,
    everyMonth,
    productsPerPharmacy: last?.productsPerPharmacy ?? 0,
  };
}

export type CustomerCountBreakdownRow = {
  key: string;
  label: string;
  /** The level above, named: an area's region, a brick's area, a product's line. Empty when none. */
  parent: string;
  /** Distinct pharmacies per month, in the payload's month order. */
  perMonth: number[];
  /** Distinct pharmacies over every month on show. */
  total: number;
  /** Latest month minus the month before; null with one month. */
  change: number | null;
};

function dimensionKey(payload: CustomerCountPayload, fact: CustomerCountFact, dimension: CustomerCountDimension): number {
  switch (dimension) {
    case "line":
      return fact[F_LINE];
    case "product":
      return fact[F_PRODUCT];
    case "region":
      return payload.areas[fact[F_AREA]]?.region ?? -1;
    case "area":
      return fact[F_AREA];
    case "brick":
      return fact[F_BRICK];
    case "rep":
      return fact[F_REP];
  }
}

function dimensionLabel(payload: CustomerCountPayload, dimension: CustomerCountDimension, index: number): { label: string; parent: string } {
  switch (dimension) {
    case "line":
      return { label: payload.lines[index] ?? "", parent: "" };
    case "product": {
      const product = payload.products[index];
      return { label: product?.name || product?.code || "", parent: payload.lines[product?.line ?? -1] ?? "" };
    }
    case "region":
      return { label: payload.regions[index] ?? "Region not mapped", parent: "" };
    case "area": {
      const area = payload.areas[index];
      return { label: area ? `${area.name || area.code}` : "", parent: payload.regions[area?.region ?? -1] ?? "" };
    }
    case "brick": {
      const brick = payload.bricks[index];
      const area = payload.areas[brick?.area ?? -1];
      return { label: brick?.name || "Brick not mapped", parent: area ? area.name || area.code : "" };
    }
    case "rep":
      return { label: payload.reps[index] ?? "", parent: "" };
  }
}

/** One row per line / product / region / area / brick / rep, biggest latest month first. */
export function breakdown(
  payload: CustomerCountPayload,
  facts: readonly CustomerCountFact[],
  dimension: CustomerCountDimension,
): CustomerCountBreakdownRow[] {
  const months = payload.months.length;
  const groups = new Map<number, { perMonth: Set<number>[]; all: Set<number> }>();
  for (const fact of facts) {
    const key = dimensionKey(payload, fact, dimension);
    let group = groups.get(key);
    if (!group) {
      group = { perMonth: Array.from({ length: months }, () => new Set<number>()), all: new Set<number>() };
      groups.set(key, group);
    }
    group.perMonth[fact[F_MONTH]]?.add(fact[F_PHARMACY]);
    group.all.add(fact[F_PHARMACY]);
  }
  const rows: CustomerCountBreakdownRow[] = [];
  for (const [key, group] of groups) {
    const perMonth = group.perMonth.map((set) => set.size);
    const { label, parent } = dimensionLabel(payload, dimension, key);
    rows.push({
      key: `${dimension}:${key}`,
      label,
      parent,
      perMonth,
      total: group.all.size,
      change: months > 1 ? perMonth[months - 1] - perMonth[months - 2] : null,
    });
  }
  return rows.sort(
    (a, b) => (b.perMonth.at(-1) ?? 0) - (a.perMonth.at(-1) ?? 0) || b.total - a.total || a.label.localeCompare(b.label),
  );
}
