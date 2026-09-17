// Weekly Sales — the MEDICAL REP's own screen: his own area's sales, week by week, per product.
//
// WHY A REP GETS HIS OWN LOADER INSTEAD OF THE MANAGERS' DASHBOARD
// ────────────────────────────────────────────────────────────────
// The owner asked for weekly sales "in medical rep accounts". The managers' Weekly Sales screen is a
// territory dashboard: region and distributor breakdowns, a Field Force table that names every rep in
// the line, and an export. A rep must see none of that. He sees his own area's value week by week and
// each product's units week by week, and no other rep's name or number (the owner's Source of Sales
// precedent, 2026-09-14). So PORTAL_WEEKLY_ROLES keeps refusing him on the managers' portal screen, its
// API and its export, and the territory gate (territory-gate.ts) refuses him on the admin dashboard
// API, its three workbooks and the portal Sales Analytics weekly pages, which his `weekly_sales:read`
// grant alone opened until 2026-09-16. Weekly sales totals reach him cut to his own areas by three
// paths: this module; its Depot Detail tab and that tab's download (portal-weekly-rep-depot-detail.ts),
// which keeps the same rows depot by depot; and the month-pace strip on his Source of Sales screen
// (sos-month-pace-loader.ts).
// Weekly Stock is the exception: it covers the depots of his line and region (owner, 2026-09-14), and
// each depot, area and region row carries the average weekly sales its weeks of cover are measured
// against.
//
// WHY THE LOAD LIFTS HIS GEOGRAPHY, THEN KEEPS ONLY HIS SEAT
// ────────────────────────────────────────────────────────
// A weekly row is a depot shipment. Most rows carry a REGION and no area, and a rep's share of them is
// placed by the owner's depot-split rule inside buildPortalWeeklyFieldForce. The territory scope bounds
// a rep by his employee REGION, and for weekly data that bound can be wrong: an Upper Egypt rep sits in
// UE-1 or UE-2 while the depot rows still say "UE", and no depot row says Delta (3). Bounded by region,
// those reps' shares are never fetched and the screen reads zero, which is a confident and false zero.
//
// So the load keeps his LINE bound and lifts only the geography. It builds the line's attribution the
// same way the managers' Field Force tab does, then keeps ONLY the entries keyed to his own seat. The
// line-wide grid never leaves this module: the result carries his seat's numbers and nothing else, with
// no other rep, no region total and no distributor.
//
// Unmapped products are excluded (owner rule: every weekly report sets excludeUnmapped). The managers'
// Field Force tab deliberately does not exclude them, because it must add up to its own KPI strip, so a
// rep's figure here can sit slightly below his row on his manager's tab. Both are allocations of depot
// data; the Monthly Closing is the official number.
//
// UNITS ARE NEVER ADDED ACROSS PRODUCTS (owner rule). A unit figure only ever sits under one product.

import { resolveEmployeeIdentityId, type AccessContext, type PhoenixRole } from "@/lib/auth/permissions";
import { sharedIdentityKeys } from "@/lib/auth/identity-aliases";
import { bridgeEmployeeLineToOfficial } from "@/lib/sales/official-lines";
import { liftWeeklyGeography, resolveWeeklyAccessScope, type WeeklyAccessScope } from "@/lib/sales/weekly/access";
import { loadWeeklyAreaSplitIndex } from "@/lib/sales/weekly/branch-area-split";
import {
  buildPortalWeeklyFieldForce,
  fieldForceLineKey,
  loadFieldForceSeatIndex,
  type FieldForceSeat,
  type PortalWeeklyFieldForce,
} from "@/lib/sales/weekly/portal-weekly-field-force";
import { loadWeeklyDashboard } from "@/lib/sales/weekly/service";
import type { WeeklyDashboard } from "@/lib/sales/weekly/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** Portal roles that get the rep's own Weekly Sales screen. The managers' dashboard still refuses them. */
export const PORTAL_WEEKLY_REP_ROLES = ["Medical Rep"] as const satisfies readonly PhoenixRole[];

const PORTAL_WEEKLY_REP_ROLE_SET = new Set<PhoenixRole>(PORTAL_WEEKLY_REP_ROLES);

export function isPortalWeeklyRepRole(role: PhoenixRole): boolean {
  return PORTAL_WEEKLY_REP_ROLE_SET.has(role);
}

export type RepWeeklyMonthOption = { code: string; name: string };

export type RepWeeklyWeek = {
  /** Week of the month. Labelled by number, as on the managers' screen: distributors stamp different dates. */
  weekNumber: number;
  /**
   * A depot whose sales reached his areas this week sent no sheet for the week before, so this week's
   * figure spans that gap and reads high.
   */
  spansGap: boolean;
};

/** One product, across the rep's own areas. Units are this product's only. */
export type RepWeeklyProduct = {
  productCode: string;
  productName: string;
  unitsByWeek: Record<number, number>;
  units: number;
  value: number;
};

/** One of the rep's own seats. A rep usually holds one; the screen lists them only when he holds more. */
export type RepWeeklyArea = {
  key: string;
  lineName: string;
  areaName: string;
  regionName: string;
  value: number;
  valueByWeek: Record<number, number>;
  exactValue: number;
  allocatedValue: number;
};

export type PortalWeeklyRepStatus =
  /** His numbers are below. */
  | "ok"
  /** His weekly access resolved to nothing (no line on his employee record, or no weekly grant). */
  | "no_access"
  /** The organogram did not answer, so we cannot say which area is his. */
  | "seat_index_unavailable"
  /** He holds no filled rep seat on a line he may read. */
  | "no_seat"
  /** No weekly upload has been validated yet. */
  | "no_data";

export type PortalWeeklyRepSales = {
  status: PortalWeeklyRepStatus;
  /** His own name, from his seat. Never another rep's. */
  repName: string | null;
  month: RepWeeklyMonthOption | null;
  months: RepWeeklyMonthOption[];
  weeks: RepWeeklyWeek[];
  areas: RepWeeklyArea[];
  products: RepWeeklyProduct[];
  totals: {
    value: number;
    /** Credited from a depot the owner mapped to an area by hand. */
    exactValue: number;
    /** Spread from a depot's name by the owner's split rule. An allocation, never an observation. */
    allocatedValue: number;
    valueByWeek: Record<number, number>;
  };
  /** The depot-split index did not load, so only hand-mapped depots reached him and the figure reads low. */
  allocationUnavailable: boolean;
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-09-01" → "September 2026". A pure string parse, so no time zone can move the month. */
export function repWeeklyMonthLabel(cycleMonth: string): string {
  const [year, month] = (cycleMonth || "").split("-");
  const name = MONTH_NAMES[Number(month) - 1];
  return name && year ? `${name} ${year}` : cycleMonth || "—";
}

/**
 * The scope the rep's LOAD runs under: his line bound kept, his geography lifted.
 *
 * Only the territory tier carries geography. Every other tier is returned unchanged, including "none",
 * which the caller refuses before loading anything. Lifting the bound is safe only because the caller
 * narrows the built grid to the viewer's own seat before anything is returned (selectRepWeeklySales).
 * The lift is liftWeeklyGeography, the one the managers' Field Force tab, the month-pace strip and
 * Weekly Stock lift with, so every weekly screen reads the same rows before it narrows.
 */
export function repWeeklyLoadScope(scope: WeeklyAccessScope): WeeklyAccessScope {
  return liftWeeklyGeography(scope);
}

/** True when the scope can read no weekly row at all: the "none" tier, or a line bound that is empty. */
export function repWeeklyScopeIsEmpty(scope: WeeklyAccessScope): boolean {
  if (scope.tier === "none") return true;
  if (scope.tier === "product") return scope.productCodes.size === 0;
  if (scope.tier === "territory") return scope.allowedLineNames !== null && scope.allowedLineNames.size === 0;
  return false;
}

/** The requested month when it is one that exists, otherwise the newest. Months arrive newest first. */
export function pickRepWeeklyMonth(
  requested: string | null | undefined,
  months: readonly RepWeeklyMonthOption[],
): RepWeeklyMonthOption | null {
  const wanted = (requested ?? "").trim();
  return months.find((month) => month.code === wanted) ?? months[0] ?? null;
}

/** The line's canonical name ("Anti infective" in the org tree reads "Anti Infective" here). */
export function repWeeklyLineName(seat: Pick<FieldForceSeat, "lineName" | "lineCode">): string {
  const raw = seat.lineName || seat.lineCode;
  return bridgeEmployeeLineToOfficial(raw) ?? raw;
}

/** The same key buildPortalWeeklyFieldForce files a seat's sales under. */
export function repWeeklySeatKey(seat: Pick<FieldForceSeat, "lineCode" | "areaCode">): string {
  return `${fieldForceLineKey(seat.lineCode)}|${seat.areaCode}`;
}

/**
 * The viewer's own FILLED rep seats, one per key.
 *
 * Matched on every HR id the person is known by (sharedIdentityKeys), because a seat stores whichever
 * id the organogram was built with. A seat on a line his access scope does not include is dropped:
 * fail closed, the same answer the rest of his sales scope gives. When nothing survives he gets the
 * "no seat" state, never a row of zeros that would read as a week with no sales.
 */
export function selectOwnRepSeats(
  seats: readonly FieldForceSeat[],
  viewerKeys: ReadonlySet<string>,
  allowedLineNames: ReadonlySet<string> | null,
): FieldForceSeat[] {
  const allowedLineKeys = allowedLineNames
    ? new Set([...allowedLineNames].map((name) => fieldForceLineKey(name)))
    : null;
  const byKey = new Map<string, FieldForceSeat>();
  for (const seat of seats) {
    if (seat.isVacant || !seat.repHrId || !viewerKeys.has(seat.repHrId)) continue;
    if (allowedLineKeys && !allowedLineKeys.has(fieldForceLineKey(repWeeklyLineName(seat)))) continue;
    const key = repWeeklySeatKey(seat);
    if (!byKey.has(key)) byKey.set(key, seat);
  }
  return [...byKey.values()].sort(
    (a, b) => repWeeklyLineName(a).localeCompare(repWeeklyLineName(b)) || a.areaName.localeCompare(b.areaName),
  );
}

const addInto = (target: Record<number, number>, source: Record<number, number>) => {
  for (const [week, amount] of Object.entries(source)) {
    target[Number(week)] = (target[Number(week)] ?? 0) + amount;
  }
};

/**
 * Keep the rep's own seats from a line-wide field-force grid. Pure.
 *
 * THE PRIVACY BOUNDARY OF THIS SCREEN. The grid holds every rep in the line; what comes out holds only
 * the entries whose key is one of `ownSeats`. The residue bucket is never read, no other entry's name
 * or number is copied, and even his own label is rebuilt from his seat rather than taken from the grid.
 */
export function selectRepWeeklySales(input: {
  fieldForce: PortalWeeklyFieldForce;
  ownSeats: readonly FieldForceSeat[];
  month: RepWeeklyMonthOption | null;
  months: RepWeeklyMonthOption[];
  /**
   * Read only for each week's number. Its money is line-wide and never copied, and so is its gap flag:
   * one depot's sheet there hides another depot's missing week.
   */
  weekComparison?: WeeklyDashboard["weekComparison"];
  allocationUnavailable?: boolean;
}): PortalWeeklyRepSales {
  const { fieldForce, ownSeats, month } = input;

  const entryByKey = new Map(
    fieldForce.reps.filter((rep) => rep.kind !== "unattributed").map((rep) => [rep.key, rep]),
  );

  const areas: RepWeeklyArea[] = [];
  const productsByCode = new Map<string, RepWeeklyProduct>();
  const totals = { value: 0, exactValue: 0, allocatedValue: 0, valueByWeek: {} as Record<number, number> };
  // His own flags: a week reads high for him only when a depot whose money reached HIS seats skipped
  // the week before. Another rep's depot missing a week says nothing about his figure.
  const gapWeeks = new Set<number>();

  for (const seat of ownSeats) {
    const key = repWeeklySeatKey(seat);
    const entry = entryByKey.get(key);
    for (const week of entry?.gapWeekNumbers ?? []) gapWeeks.add(week);
    const area: RepWeeklyArea = {
      key,
      lineName: repWeeklyLineName(seat),
      areaName: seat.areaName,
      regionName: seat.regionName,
      value: entry?.value ?? 0,
      valueByWeek: { ...(entry?.valueByWeek ?? {}) },
      exactValue: entry?.exactValue ?? 0,
      allocatedValue: entry?.allocatedValue ?? 0,
    };
    areas.push(area);

    totals.value += area.value;
    totals.exactValue += area.exactValue;
    totals.allocatedValue += area.allocatedValue;
    addInto(totals.valueByWeek, area.valueByWeek);

    // One product code across his areas is still one product, so its units may be added here.
    for (const product of entry?.products ?? []) {
      const merged = productsByCode.get(product.productCode) ?? {
        productCode: product.productCode,
        productName: product.productName,
        unitsByWeek: {},
        units: 0,
        value: 0,
      };
      merged.units += product.units;
      merged.value += product.value;
      addInto(merged.unitsByWeek, product.unitsByWeek);
      productsByCode.set(product.productCode, merged);
    }
  }

  const products = [...productsByCode.values()].sort(
    (a, b) => b.value - a.value || a.productName.localeCompare(b.productName),
  );

  // The week axis is the month's upload calendar, not his rows: a week he sold nothing in stays on screen
  // as a dash instead of silently disappearing.
  const calendar = new Set(fieldForce.weekNumbers);
  for (const entry of input.weekComparison ?? []) {
    if (month && entry.cycleMonth !== month.code) continue;
    calendar.add(entry.weekNumber);
  }
  const weeks: RepWeeklyWeek[] = [...calendar]
    .sort((a, b) => a - b)
    .map((weekNumber) => ({ weekNumber, spansGap: gapWeeks.has(weekNumber) }));

  return {
    status: ownSeats.length > 0 ? "ok" : "no_seat",
    repName: ownSeats.find((seat) => seat.repName)?.repName ?? null,
    month,
    months: input.months,
    weeks,
    areas,
    products,
    totals,
    allocationUnavailable: input.allocationUnavailable === true,
  };
}

/** An empty payload for every state that has no numbers to show. */
export function emptyRepWeeklySales(
  status: Exclude<PortalWeeklyRepStatus, "ok">,
  extras?: { repName?: string | null; months?: RepWeeklyMonthOption[]; month?: RepWeeklyMonthOption | null },
): PortalWeeklyRepSales {
  return {
    status,
    repName: extras?.repName ?? null,
    month: extras?.month ?? null,
    months: extras?.months ?? [],
    weeks: [],
    areas: [],
    products: [],
    totals: { value: 0, exactValue: 0, allocatedValue: 0, valueByWeek: {} },
    allocationUnavailable: false,
  };
}

/**
 * Every cycle month with at least one validated upload, newest first.
 *
 * Read from the batch list and not from the dashboard: the rep's load narrows the row fetch to one
 * month, and a dashboard built that way reports only that month in availableMonths, so the month
 * picker would collapse to the month already chosen.
 */
export async function loadValidatedWeeklyMonths(): Promise<RepWeeklyMonthOption[]> {
  const supabase = getSupabaseAdmin();
  const months = new Set<string>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("weekly_sales_batches")
      .select("id, cycle_month")
      .eq("status", "validated")
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    for (const row of rows) {
      const code = String((row as { cycle_month?: string | null }).cycle_month ?? "").trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(code)) months.add(code);
    }
    if (rows.length < pageSize) break;
  }
  return [...months]
    .sort((left, right) => right.localeCompare(left))
    .map((code) => ({ code, name: repWeeklyMonthLabel(code) }));
}

/** The rep's own Weekly Sales for one month. Server-only; the page calls it for a Medical Rep. */
export async function getPortalWeeklyRepSales(
  ctx: AccessContext,
  options?: { month?: string | null },
): Promise<PortalWeeklyRepSales> {
  const [scope, months, seatIndex] = await Promise.all([
    resolveWeeklyAccessScope(ctx),
    loadValidatedWeeklyMonths(),
    loadFieldForceSeatIndex(),
  ]);

  if (repWeeklyScopeIsEmpty(scope)) return emptyRepWeeklySales("no_access", { months });
  if (seatIndex.seats.length === 0) return emptyRepWeeklySales("seat_index_unavailable", { months });

  const viewerKeys = sharedIdentityKeys(resolveEmployeeIdentityId(ctx));
  const allowedLineNames = scope.tier === "territory" ? scope.allowedLineNames : null;
  const ownSeats = selectOwnRepSeats(seatIndex.seats, viewerKeys, allowedLineNames);
  if (ownSeats.length === 0) return emptyRepWeeklySales("no_seat", { months });

  const repName = ownSeats.find((seat) => seat.repName)?.repName ?? null;
  const month = pickRepWeeklyMonth(options?.month, months);
  if (!month) return emptyRepWeeklySales("no_data", { repName });

  const [dashboard, areaSplit] = await Promise.all([
    loadWeeklyDashboard({
      accessScope: repWeeklyLoadScope(scope),
      allWeeks: true,
      cycleMonths: [month.code],
      cycleMonthMode: "include",
      // One whole month only. Safe for de-cumulation (it groups by distributor and month), and this
      // caller never reads the dashboard's option lists, which is that option's one precondition.
      narrowRowsToCycleMonths: [month.code],
      includeFactRows: true,
      // Owner rule: every weekly report drops unmapped products, so an unmapped SKU is not counted twice.
      excludeUnmapped: true,
    }),
    loadWeeklyAreaSplitIndex().catch(() => null),
  ]);

  const fieldForce = buildPortalWeeklyFieldForce({
    rows: dashboard.factRows ?? [],
    areaSplit,
    seatIndex,
    // Flagged per depot, so each seat carries the gaps of the depots whose money reached it.
    depotWeekGaps: dashboard.factRowDepotWeekGaps ?? [],
    seatIndexUnavailable: false,
  });

  return selectRepWeeklySales({
    fieldForce,
    ownSeats,
    month,
    months,
    weekComparison: dashboard.weekComparison,
    // The split index fails soft to EMPTY maps rather than throwing, so an unreadable line-area map
    // shows up as no region and no governorate placing any area. Say so rather than show a low number.
    allocationUnavailable:
      areaSplit === null || (areaSplit.areasByLineRegion.size === 0 && areaSplit.areasByLineGovernorate.size === 0),
  });
}
