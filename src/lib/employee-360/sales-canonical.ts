// ─────────────────────────────────────────────────────────────────────────────
// Employee 360's sales rows, sourced from SoS Monthly Closing instead of sales_records.
//
// Employee 360 was the last surface still answering "how much did this person sell" from the
// legacy table. It disagreed with every other screen: for rep B-158 it rendered 700,019.87
// (140% of target) while the incentive tab, the monthly dashboard, the closing view and
// reconciliation all read 460,228.50 for the same six months — a 52% overstatement, and every
// single month differed (May was 4.1x). Rule #1 says a person's month reads identically
// everywhere, so this module produces the SAME SalesRow shape deep-service already aggregates,
// from the canonical engine.
//
// Sibling of employee-portal/sos-team-performance.ts (the MRs / DSMs Performance pages) and built
// from the same parts — one window load, merge areas, gate on the PUBLISHED closing, credit each
// month by seat tenure, roll a manager up through his seats. Divergence between these surfaces is
// exactly the class of bug this whole migration exists to remove (owner, 2026-10-27: "fix the
// employee 360 with all system updates since the module was built").
//
// Four things here are load-bearing:
//
//   1. ONLY A PUBLISHED MONTH IS A FIGURE (owner, 2026-10-27). A month whose line has no published
//      Monthly Closing is never summed and never shown as a zero; the section names it "Not
//      published yet". The gate is `isRowPublished` over `loadPublishedPeriodKeys`, the one the
//      closing-backed portal pages use, per (line, month), so a line that publishes late never
//      leaks its raw rows in under another line's publication. Publication starts at July 2026
//      (SALES_VS_TARGET_FLOOR), so that is where the window starts.
//
//   2. EACH MONTH BELONGS TO WHOEVER HELD THE SEAT THAT MONTH. The engine names TODAY's occupant
//      on every past month; `creditRepRowsByTenure` and `creditDmRowsByTenure` re-credit each
//      month to the person seated (and employed) on its last day, the rule the rep and DSM boards
//      already follow. This replaces the old hire-month cut, which only ever removed months and
//      could not give a predecessor his own history back.
//
//   3. A MANAGER'S TEAM IS HIS SEATS, NOT HIS REPS. A month whose rep seat stood vacant still sold;
//      the closing totals it under the district, and the old rep-only match lost it from the
//      manager's team total. A manager's rows are Sales vs Target's own nodes for him that month —
//      the district (`rollupByDm`), the region (`rollupByRegionalManager`, which leaves out a
//      district with no manager — owner, 2026-10-27) and the line (`rollupByTeam`).
//
//   4. CONFIDENTIAL PRODUCTS ARE STRIPPED BY CODE. Canonical rows carry the product code, so the
//      exact strip is available and is what this module uses.
// ─────────────────────────────────────────────────────────────────────────────

import { cache } from "react";

import type { PhoenixRole } from "@/lib/auth/permissions";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { currentCairoDateParts } from "@/lib/i18n/format";
import { logError } from "@/lib/observability/log";
import { applyAchievementAreaMerges } from "@/lib/sales/closing-area-merges";
import { periodEndDate } from "@/lib/sales/closing-performance-review";
import {
  RESTRICTED_PRODUCT_CODES,
  canViewRestrictedProducts,
  stripRestrictedRows,
} from "@/lib/sales/access-scope";
import {
  lineName,
  loadProductFamilyMap,
  loadProductNameMap,
  type AchievementRow,
} from "@/lib/sales/monthly-targets";
import { loadSalesSeatTree, type SalesSeatTree } from "@/lib/sales/seat-hierarchy";
import {
  creditDmRowsByTenure,
  creditRepRowsByTenure,
  loadSeatTenure,
  seatHolderOn,
  type SeatTenure,
} from "@/lib/sales/seat-tenure-credit";
import {
  SALES_VS_TARGET_FLOOR,
  isRowPublished,
  loadAchievementRange,
  loadPublishedPeriodKeys,
} from "@/lib/sales/vs-target";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type { SalesRow } from "./deep-service";

/**
 * deep-service's SalesRow plus the two identifiers the canonical engine has and the legacy
 * table never did.
 *
 * `productCode` is load-bearing: it is what makes the exact restricted-product strip possible.
 * `managerHrId` names the district manager credited with the month; it is carried for display and
 * is NOT used for scoping — a manager's rows are chosen by seat before aggregation.
 * `employee_hr_id` is null for a month whose rep seat stood vacant: it still counts in every total
 * above the rep, and contributes no rep to a team's head count.
 */
export type CanonicalEmployee360SalesRow = SalesRow & {
  productCode: string;
  managerHrId: string | null;
};

function lower(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function upper(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

function personKey(value: string | null | undefined): string {
  return canonicalHrIdKey(value) ?? "";
}

type Aggregate = {
  repHrId: string;
  dmHrId: string | null;
  lineCode: string | null;
  productCode: string;
  period: string;
  salesValue: number;
  targetValue: number;
};

/**
 * Fold canonical rows into one aggregate per (rep, line, period, product). PURE.
 *
 * A row whose (line, month) has no published closing is dropped (note 1 above). A row with no rep
 * — a vacant seat's month — is KEPT under an empty rep: it is part of every total above the rep,
 * and the caller has already decided, by seat, whose total it belongs to.
 */
export function aggregateCanonicalEmployee360Rows(
  rows: readonly AchievementRow[],
  publishedKeys: ReadonlySet<string>,
): Aggregate[] {
  const byKey = new Map<string, Aggregate>();
  for (const row of rows) {
    if (!isRowPublished(row, publishedKeys)) continue;
    const repHrId = lower(row.repHrId);
    const productCode = upper(row.productCode);
    const key = `${repHrId}|${row.lineCode ?? ""}|${row.period}|${productCode}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.salesValue += row.actualValue;
      existing.targetValue += row.targetValue ?? 0;
      continue;
    }
    byKey.set(key, {
      repHrId,
      dmHrId: lower(row.dmHrId) || null,
      lineCode: row.lineCode,
      productCode,
      period: row.period,
      salesValue: row.actualValue,
      targetValue: row.targetValue ?? 0,
    });
  }
  return [...byKey.values()];
}

/** Aggregates -> the row shape deep-service aggregates. PURE. */
export function toEmployee360SalesRows(
  aggregates: readonly Aggregate[],
  productNames: ReadonlyMap<string, string>,
  productFamilies: ReadonlyMap<string, string>,
): CanonicalEmployee360SalesRow[] {
  return aggregates.map((aggregate) => {
    const [yearPart, monthPart] = aggregate.period.split("-");
    return {
      employee_hr_id: aggregate.repHrId ? upper(aggregate.repHrId) : null,
      managerHrId: aggregate.dmHrId ? upper(aggregate.dmHrId) : null,
      line: aggregate.lineCode ? lineName(aggregate.lineCode) : null,
      family: productFamilies.get(aggregate.productCode) ?? null,
      // Falls back to the CODE, never to a placeholder: an unmapped SKU stays visible and
      // countable in the product list instead of collapsing into one "—" bucket with every
      // other unmapped product, which is how a real seller disappears from Top Products.
      product: productNames.get(aggregate.productCode) ?? aggregate.productCode,
      productCode: aggregate.productCode,
      month: Number(monthPart) || null,
      year: Number(yearPart) || null,
      sales_value: aggregate.salesValue,
      target_value: aggregate.targetValue,
    };
  });
}

/**
 * Each month credited to the people who held its seats then (note 2 above): the rep seat's holder
 * on `repHrId`, the district seat's on `dmHrId`. With no seat history (the read failed) the rows
 * keep today's holders, as the boards do.
 *
 * A district seat with NO recorded stretch at all (a seat retired before its history was kept)
 * keeps the manager the engine named on the row: there is no history to say otherwise, and
 * crediting nobody would drop the month from the manager who earned it. PURE.
 */
export function creditEmployee360RowsByTenure(
  rows: readonly AchievementRow[],
  tenure: SeatTenure | null,
): AchievementRow[] {
  if (!tenure) return [...rows];
  const seatsWithHistory = new Set(tenure.stretches.map((stretch) => stretch.seatId));
  const credited = creditDmRowsByTenure(creditRepRowsByTenure(rows, tenure), tenure);
  return credited.map((row, index) =>
    row.dmSeatId && !seatsWithHistory.has(row.dmSeatId) && row.dmHrId !== rows[index].dmHrId
      ? { ...row, dmHrId: rows[index].dmHrId }
      : row,
  );
}

/** The seat tiers that make a person a manager of the rows beneath them. */
const MANAGER_SEAT_TIERS = new Set(["NSM", "RSM", "DM", "ACTING_DM"]);
const DISTRICT_SEAT_TIERS = new Set(["DM", "ACTING_DM"]);

export type Employee360SeatModel = {
  seats: SalesSeatTree;
  tenure: SeatTenure | null;
};

const regionKeyOf = (row: AchievementRow): string =>
  `${row.lineCode ?? ""}|${(row.regionCode ?? "").trim().toUpperCase()}`;

/**
 * The district seat a row's REGION is read from. A month earned under a seat since retired (the
 * single Pedia "Upper Egypt" seat, now split in two) names a seat today's tree no longer holds; it
 * is read through the live district seat carrying the same line and region code, so it lands under
 * the same Regional Manager as that region's live districts — `sos-team-performance`'s
 * `seatToReadFrom`. PURE.
 */
function districtSeatReader(rows: readonly AchievementRow[], seats: SalesSeatTree) {
  const liveSeatOfRegion = new Map<string, string>();
  for (const row of rows) {
    const key = regionKeyOf(row);
    if (!row.dmSeatId || liveSeatOfRegion.has(key)) continue;
    const seat = seats.get(row.dmSeatId);
    if (seat && DISTRICT_SEAT_TIERS.has(seat.tier)) liveSeatOfRegion.set(key, row.dmSeatId);
  }
  return (row: AchievementRow): string | null => {
    if (!row.dmSeatId || seats.has(row.dmSeatId)) return row.dmSeatId;
    return liveSeatOfRegion.get(regionKeyOf(row)) ?? null;
  };
}

/**
 * True when the seat tree could not be read (it comes back EMPTY on a failed read) and the subject
 * manages anyone — a person with others in his team, or a district manager on any row. His Regional
 * or National total cannot be placed without the tree, and the rep-only fallback would print a
 * SMALLER number as if it were his team's. The caller says "could not be read" instead. PURE.
 */
export function employee360TeamTreeMissing(
  rows: readonly AchievementRow[],
  subjectHrId: string,
  teamHrIds: readonly string[],
  model: Employee360SeatModel,
): boolean {
  if (model.seats.size > 0) return false;
  const subject = personKey(subjectHrId);
  if (!subject) return false;
  if (teamHrIds.some((hrId) => personKey(hrId) && personKey(hrId) !== subject)) return true;
  return rows.some((row) => personKey(row.dmHrId) === subject);
}

/**
 * The rows one person's Employee 360 sums, BEFORE the publication gate. PURE. Each level is the
 * Sales vs Target page's own grain, so a manager's Employee 360 total equals his node there:
 *
 * - DISTRICT (`rollupByDm`): every row whose tenure-credited district manager is the subject — his
 *   vacant REP seats included, and a month earned under a district seat since retired, since the
 *   credit names whoever held that seat on the month's last day.
 * - REGION (`rollupByRegionalManager`): every row under a Regional seat he held that month, read
 *   through a live district seat for a retired one — and ONLY rows that have a district manager
 *   (owner, 2026-10-27): a district with no manager that month has no District Manager node, so it
 *   is not in his total either.
 * - LINE (`rollupByTeam`): every row of a line whose National seat he held that month, vacant
 *   districts included.
 * - His own months as a rep always count.
 *
 * Anyone the seat model does not make a manager is matched by rep: the subject and `teamHrIds`.
 * `rows` must already be credited by `creditEmployee360RowsByTenure`. An empty seat tree for a
 * manager is the caller's to refuse first (`employee360TeamTreeMissing`).
 */
export function selectEmployee360TeamRows(
  rows: readonly AchievementRow[],
  subjectHrId: string,
  teamHrIds: readonly string[],
  model: Employee360SeatModel,
): AchievementRow[] {
  const subject = personKey(subjectHrId);
  if (!subject) return [];

  const managerSeatIds = new Set<string>();
  for (const seat of model.seats.values()) {
    if (MANAGER_SEAT_TIERS.has(seat.tier) && personKey(seat.occupantHrId) === subject) managerSeatIds.add(seat.seatId);
  }
  for (const stretch of model.tenure?.stretches ?? []) {
    const tier = model.seats.get(stretch.seatId)?.tier;
    if (tier && MANAGER_SEAT_TIERS.has(tier) && personKey(stretch.occupantHrId) === subject) {
      managerSeatIds.add(stretch.seatId);
    }
  }
  const isDistrictManager = rows.some((row) => personKey(row.dmHrId) === subject);

  if (managerSeatIds.size === 0 && !isDistrictManager) {
    const wanted = new Set([subjectHrId, ...teamHrIds].map(personKey).filter(Boolean));
    return rows.filter((row) => wanted.has(personKey(row.repHrId)));
  }

  const holderCache = new Map<string, string>();
  const heldBySubject = (seatId: string, period: string): boolean => {
    if (!managerSeatIds.has(seatId)) return false;
    const cacheKey = `${seatId}|${period}`;
    let holder = holderCache.get(cacheKey);
    if (holder === undefined) {
      const asOf = periodEndDate(period);
      holder = model.tenure
        ? asOf
          ? personKey(seatHolderOn(model.tenure, seatId, asOf))
          : ""
        : personKey(model.seats.get(seatId)?.occupantHrId);
      holderCache.set(cacheKey, holder);
    }
    return holder === subject;
  };

  const nationalSeatsOfLine = new Map<string, string[]>();
  for (const seat of model.seats.values()) {
    if (seat.tier !== "NSM" || !seat.lineCode || !managerSeatIds.has(seat.seatId)) continue;
    nationalSeatsOfLine.set(seat.lineCode, [...(nationalSeatsOfLine.get(seat.lineCode) ?? []), seat.seatId]);
  }
  const districtSeatOf = districtSeatReader(rows, model.seats);

  return rows.filter((row) => {
    if (personKey(row.repHrId) === subject) return true;
    if (personKey(row.dmHrId) === subject) return true;
    if (row.lineCode && (nationalSeatsOfLine.get(row.lineCode) ?? []).some((seatId) => heldBySubject(seatId, row.period))) {
      return true;
    }
    if (!row.dmHrId) return false;
    const districtSeat = model.seats.get(districtSeatOf(row) ?? "");
    if (!districtSeat || !DISTRICT_SEAT_TIERS.has(districtSeat.tier) || !districtSeat.parentSeatId) return false;
    const regional = model.seats.get(districtSeat.parentSeatId);
    return regional?.tier === "RSM" && heldBySubject(regional.seatId, row.period);
  });
}

/**
 * The months a person's sales section names "Not published yet": months in which he has sales and
 * none of them sit in a published closing. A month with SOME published line shows that published
 * figure alone. `YYYY-MM`, ascending. PURE.
 */
export function unpublishedEmployee360Periods(
  rows: readonly AchievementRow[],
  publishedKeys: ReadonlySet<string>,
): string[] {
  const published = new Set<string>();
  const withSales = new Set<string>();
  for (const row of rows) {
    if (isRowPublished(row, publishedKeys)) published.add(row.period);
    else if (row.hasActual) withSales.add(row.period);
  }
  return [...withSales].filter((period) => !published.has(period)).sort();
}

/**
 * Strip confidential products for a viewer who may not see them.
 *
 * By CODE, which the legacy path could not do. LA003/LA004/SS001 are the whole of the Head
 * Office line; they must never reach a total, KPI, chart or product list for a viewer below
 * CEO/Super Admin. A viewer who may see them gets the rows untouched.
 */
export function maskRestrictedEmployee360Rows<T extends { productCode?: string | null }>(
  rows: readonly T[],
  viewerRole: PhoenixRole,
): T[] {
  if (canViewRestrictedProducts(viewerRole)) return [...rows];
  return stripRestrictedRows([...rows], RESTRICTED_PRODUCT_CODES);
}

/** What one person's sales section is built from. */
export type Employee360SalesWindow = Employee360SeatModel & {
  /** July 2026 to this Cairo month, area-merged and credited by seat tenure. Published or not. */
  rows: AchievementRow[];
  publishedKeys: ReadonlySet<string>;
  productNames: ReadonlyMap<string, string>;
  productFamilies: ReadonlyMap<string, string>;
};

/**
 * One person's published sales rows and the months still waiting on a closing. PURE.
 *
 * The confidential strip runs on the engine rows FIRST, so a month whose only sales are a
 * confidential product is not named "Not published yet" to a viewer who may not know it sold.
 */
export function buildEmployee360TeamSales(
  window: Employee360SalesWindow,
  subjectHrId: string,
  teamHrIds: readonly string[],
  viewerRole: PhoenixRole,
): { rows: CanonicalEmployee360SalesRow[]; unpublishedPeriods: string[]; teamUnreadable: boolean } {
  if (employee360TeamTreeMissing(window.rows, subjectHrId, teamHrIds, window)) {
    return { rows: [], unpublishedPeriods: [], teamUnreadable: true };
  }
  const scoped = maskRestrictedEmployee360Rows(
    selectEmployee360TeamRows(window.rows, subjectHrId, teamHrIds, window),
    viewerRole,
  );
  return {
    rows: toEmployee360SalesRows(
      aggregateCanonicalEmployee360Rows(scoped, window.publishedKeys),
      window.productNames,
      window.productFamilies,
    ),
    unpublishedPeriods: unpublishedEmployee360Periods(scoped, window.publishedKeys),
    teamUnreadable: false,
  };
}

/** The seat history, or null (today's holders, logged) when it cannot be read — the boards' rule. */
async function loadEmployee360SeatTenure(): Promise<SeatTenure | null> {
  try {
    return await loadSeatTenure();
  } catch (error) {
    logError("Employee 360 seat-tenure read failed; crediting today's seat holders", {
      error,
      labels: { event: "employee_360_seat_tenure_failed" },
    });
    return null;
  }
}

/**
 * The whole sales window, company-wide and viewer-independent; the narrowing to a person and the
 * confidential mask both happen after, per viewer. Memoized per request. The publication read is
 * deliberately not caught: an empty set would print every published month as "Not published yet".
 */
export const loadEmployee360SalesWindow = cache(async (): Promise<Employee360SalesWindow> => {
  const { year, month } = currentCairoDateParts();
  const to = `${year}-${String(month).padStart(2, "0")}`;
  const [rows, publishedKeys, productNames, productFamilies, seats, tenure] = await Promise.all([
    loadAchievementRange(SALES_VS_TARGET_FLOOR, to),
    loadPublishedPeriodKeys(SALES_VS_TARGET_FLOOR, to),
    loadProductNameMap(),
    loadProductFamilyMap(),
    loadSalesSeatTree(),
    loadEmployee360SeatTenure(),
  ]);
  // Merge Fayoum/Beni Suef BEFORE anything keys on the area: the merge rewrites areaCode without
  // summing, so aggregating first would leave one rep split across two codes on the merging lines.
  return {
    rows: creditEmployee360RowsByTenure(applyAchievementAreaMerges(rows), tenure),
    publishedKeys,
    productNames,
    productFamilies,
    seats,
    tenure,
  };
});

/**
 * Every published Employee-360 sales row, for every rep and every vacant seat. UNFILTERED.
 * The PM path and the company benchmarks read this; a person's own section reads
 * `buildEmployee360TeamSales`.
 */
export const loadCanonicalEmployee360SalesRows = cache(
  async (): Promise<CanonicalEmployee360SalesRow[]> => {
    const window = await loadEmployee360SalesWindow();
    return toEmployee360SalesRows(
      aggregateCanonicalEmployee360Rows(window.rows, window.publishedKeys),
      window.productNames,
      window.productFamilies,
    );
  },
);

/**
 * Every employee's hire month, keyed by the canonical HR id, as `YYYY-MM`. Memoized per request.
 * The employee master is a couple of hundred rows, so it is read whole rather than by an `.in()`
 * over a manager's subtree, which is what overflows the request headers (see deep-service).
 */
export const loadEmployee360HireMonths = cache(async (): Promise<Map<string, string>> => {
  const supabase = getSupabaseAdmin();
  const rows = await fetchAllRows<{ hr_id: string | null; hire_date: string | null }>(
    () => supabase.from("employees").select("hr_id,hire_date").not("hire_date", "is", null),
    "hr_id",
  );
  const out = new Map<string, string>();
  for (const row of rows) {
    const key = canonicalHrIdKey(row.hr_id);
    const hireMonth = String(row.hire_date ?? "").slice(0, 7);
    if (key && /^\d{4}-\d{2}$/.test(hireMonth)) out.set(key, hireMonth);
  }
  return out;
});

/**
 * Keep the rows belonging to these product families. PURE.
 *
 * The PM path: a Product Manager has no reports, so their sales are the sales of the brands
 * they own. Matched case-insensitively on the family name, as the legacy `.in("family", …)`
 * effectively was against a curated column.
 */
export function selectEmployee360RowsForFamilies(
  rows: readonly CanonicalEmployee360SalesRow[],
  families: readonly string[],
): CanonicalEmployee360SalesRow[] {
  const wanted = new Set(families.map(lower).filter(Boolean));
  if (wanted.size === 0) return [];
  return rows.filter((row) => wanted.has(lower(row.family)));
}
