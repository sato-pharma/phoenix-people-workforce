// ─────────────────────────────────────────────────────────────────────────────
// Employee 360 — Bricks: the rep's AREA against the rep's CURRENT LIST.
//
// The owner's request, 2026-09-21: show "the bricks that is counted for this area sales, either it
// have sales or no", and compare them with "the bricks that contains the doctors in this rep list —
// the newest list, not the all historical for the area".
//
// So two sets, joined on the brick:
//
//   AREA SIDE — every brick of the area(s) whose target this rep carries (the seat model,
//   `au_v_line_area_map`, today's rows only), sold or not, plus any brick the closing booked sales
//   to in those areas. Sales per brick are the Monthly Closing's own brick grain
//   (`phx_closing_brick`: validated distributor batches, confidential products stripped).
//
//   LIST SIDE — the rep's list TODAY: the open periods of `crm_contact_assignments`, placed on a
//   brick by the SAME two-step resolution the Reps List board uses (the contact's own mapping, then
//   its CRM region's). Doctors are AM + PM; pharmacies are counted apart — a pharmacy is not a
//   contact (owner, 2026-09-01).
//
// Four things here are load-bearing:
//
//   1. BRICKS DO NOT ADD UP TO THE AREA'S CLOSING FIGURE, AND THE PANEL SAYS SO. The closing credits
//      an area with money no brick holds: wholesaler sales split across a city's areas, warehouse
//      stock shared over the country, the Office allocation, direct orders. A brick's figure is what
//      distributors booked ON it. The Sales section above stays the rep's number.
//
//   2. EL QEMA LEAVES NO TRACE. Its rows are removed before anything is summed, for everyone but
//      Super Admin, with the closing's own mask (`withoutMaskedSourceRows`) — a warehouse brick
//      carrying its stock would otherwise announce it.
//
//   3. A REP'S FIGURES START AT THE HIRE MONTH (owner, 2026-09-21), so a month before it never
//      feeds a brick's sales on this page.
//
//   4. THE MONTHS FOLLOW THE PAGE'S PERIOD, and only months whose distributor files have landed.
//      When none of the period's months has landed yet — every early month, since files arrive over
//      the first two weeks — the latest landed month is used and labelled as such, rather than
//      painting every brick as "no sales".
// ─────────────────────────────────────────────────────────────────────────────

import type { PhoenixRole } from "@/lib/auth/permissions";
import { scopeForRole } from "@/lib/auth/permissions";
import { cairoTodayIso } from "@/lib/crm/dates";
import { getRepsListBrickPlacement, type RepsListGroup } from "@/lib/crm/reps-list";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import {
  loadAreaBrickMaster,
  loadClosingBrickSales,
  upperCode,
  type BrickMasterRow,
  type BrickSalesRow,
} from "@/lib/sales/closing-brick-sales";
import { withoutMaskedSourceRows } from "@/lib/sales/closing-source-mask";
import { lineName } from "@/lib/sales/monthly-targets";
import { isSalesPeriodReleased, loadSalesReleaseKeys } from "@/lib/sales/unpublished-sales-access";
import { SALES_HISTORY_FLOOR, isValidVsTargetPeriod, loadUploadedPeriodsInRange } from "@/lib/sales/vs-target";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { loadEmployee360HireMonths } from "./sales-canonical";
import type { Employee360Window } from "./service";

/** How a brick of the area stands against the rep's current list. */
export type Employee360BrickStatus = "covered" | "sales-no-doctor" | "doctor-no-sales" | "idle";

export type Employee360AreaBrick = {
  /** Never rendered — the name is. */
  brickId: string;
  brickName: string;
  areaName: string;
  salesValue: number;
  doctors: number;
  pharmacies: number;
  status: Employee360BrickStatus;
};

/** A brick holding doctors or pharmacies from the rep's list that is NOT one of his area's. */
export type Employee360OutsideBrick = {
  brickId: string;
  brickName: string;
  /** Null when the brick's area has no name on file — never replaced by the code. */
  areaName: string | null;
  doctors: number;
  pharmacies: number;
};

export type Employee360BrickCoverage = {
  lineName: string;
  areaNames: string[];
  /** `YYYY-MM`, oldest first. Empty when no month has landed since the hire month. */
  salesMonths: string[];
  /** True when none of the page period's months had landed and the latest landed month stands in. */
  salesMonthsFallback: boolean;
  bricks: Employee360AreaBrick[];
  outside: Employee360OutsideBrick[];
  /** Sales booked to the area with no brick on the row. */
  salesWithoutBrick: number;
  unmapped: { doctors: number; pharmacies: number; regions: number };
  totals: {
    areaBricks: number;
    bricksWithSales: number;
    bricksWithDoctors: number;
    salesNoDoctor: number;
    /** Share of the bricks' sales sitting in bricks with no listed doctor, 0..1; null with no sales. */
    salesNoDoctorShare: number | null;
    brickSales: number;
    listDoctors: number;
    listPharmacies: number;
    doctorsInArea: number;
    doctorsOutside: number;
    pharmaciesOutside: number;
  };
};

// ── Pure core ────────────────────────────────────────────────────────────────

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to) || to < from) return out;
  let [year, month] = from.split("-").map(Number);
  for (;;) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    if (key > to) break;
    out.push(key);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

/**
 * Which months feed the bricks' sales. PURE.
 *
 * The page period's months that have landed, from the hire month and the closing's brick floor
 * (July 2026) on. When that is empty, the latest landed month that qualifies, flagged as a fallback.
 */
export function resolveBrickSalesMonths(input: {
  window: Pick<Employee360Window, "from" | "to">;
  uploadedPeriods: ReadonlySet<string>;
  hireMonth: string | null;
}): { months: string[]; fallback: boolean } {
  const eligible = (period: string) =>
    isValidVsTargetPeriod(period) && (!input.hireMonth || period >= input.hireMonth);
  const inWindow = monthsBetween(input.window.from.slice(0, 7), input.window.to.slice(0, 7)).filter(
    (period) => input.uploadedPeriods.has(period) && eligible(period),
  );
  if (inWindow.length > 0) return { months: inWindow, fallback: false };
  const toMonth = input.window.to.slice(0, 7);
  const latest = [...input.uploadedPeriods].filter((period) => eligible(period) && period <= toMonth).sort().pop();
  return latest ? { months: [latest], fallback: true } : { months: [], fallback: false };
}

// Re-exported so this file stays the import site its own tests and callers already use; the
// declarations moved to @/lib/sales/closing-brick-sales with the loaders (C2a, 2026-09-27).
export type { BrickMasterRow, BrickSalesRow };

const upper = upperCode;

/**
 * Join the area's bricks, the closing's brick sales and the rep's list groups. PURE — the fixtures
 * in the test file are the whole contract.
 *
 * `sales` must already be masked and narrowed to the months in play; this function narrows it to the
 * rep's areas (upper-cased on both sides).
 */
export function buildEmployee360BrickCoverage(input: {
  lineName: string;
  areas: ReadonlyArray<{ areaCode: string; areaName: string }>;
  brickMaster: readonly BrickMasterRow[];
  sales: readonly Pick<BrickSalesRow, "areaCode" | "brickId" | "value">[];
  groups: ReadonlyArray<
    Pick<RepsListGroup, "areaCode" | "areaName" | "brickId" | "heading" | "mapped"> & {
      rows: ReadonlyArray<{ listType: string }>;
    }
  >;
  salesMonths: string[];
  salesMonthsFallback: boolean;
}): Employee360BrickCoverage {
  const areaCodes = new Set(input.areas.map((area) => upper(area.areaCode)));
  const areaNameOf = new Map(input.areas.map((area) => [upper(area.areaCode), area.areaName]));
  const masterById = new Map(input.brickMaster.map((row) => [row.brickId, row]));

  // Sales booked to the rep's areas, per brick.
  const salesByBrick = new Map<string, number>();
  let salesWithoutBrick = 0;
  for (const row of input.sales) {
    if (!areaCodes.has(upper(row.areaCode))) continue;
    const brickId = String(row.brickId ?? "").trim();
    if (!brickId) {
      salesWithoutBrick += row.value;
      continue;
    }
    salesByBrick.set(brickId, (salesByBrick.get(brickId) ?? 0) + row.value);
  }

  // The rep's list, per brick. A group is IN the area when its brick's own area is one of his.
  const listByBrick = new Map<string, { doctors: number; pharmacies: number; group: (typeof input.groups)[number] }>();
  const unmapped = { doctors: 0, pharmacies: 0, regions: 0 };
  let listDoctors = 0;
  let listPharmacies = 0;
  for (const group of input.groups) {
    const pharmacies = group.rows.filter((row) => row.listType === "Pharmacy").length;
    const doctors = group.rows.length - pharmacies;
    listDoctors += doctors;
    listPharmacies += pharmacies;
    if (!group.mapped || !group.brickId) {
      unmapped.doctors += doctors;
      unmapped.pharmacies += pharmacies;
      unmapped.regions += 1;
      continue;
    }
    const existing = listByBrick.get(group.brickId);
    if (existing) {
      existing.doctors += doctors;
      existing.pharmacies += pharmacies;
    } else {
      listByBrick.set(group.brickId, { doctors, pharmacies, group });
    }
  }

  // The area's bricks: every CURRENT brick of its areas, every brick the closing booked sales to
  // there, and every list brick whose own area is one of them.
  const areaBrickIds = new Set<string>();
  for (const row of input.brickMaster) {
    if (row.current && areaCodes.has(upper(row.areaCode))) areaBrickIds.add(row.brickId);
  }
  for (const brickId of salesByBrick.keys()) areaBrickIds.add(brickId);
  for (const [brickId, entry] of listByBrick) {
    if (areaCodes.has(upper(entry.group.areaCode))) areaBrickIds.add(brickId);
  }

  const bricks: Employee360AreaBrick[] = [];
  for (const brickId of areaBrickIds) {
    const master = masterById.get(brickId);
    const list = listByBrick.get(brickId);
    const salesValue = salesByBrick.get(brickId) ?? 0;
    const doctors = list?.doctors ?? 0;
    const pharmacies = list?.pharmacies ?? 0;
    const hasSales = salesValue > 0;
    const hasDoctors = doctors > 0;
    const areaCode = upper(master?.areaCode ?? list?.group.areaCode ?? "");
    bricks.push({
      brickId,
      brickName: (master?.brickName || list?.group.heading || "").trim() || "Unnamed brick",
      areaName: areaNameOf.get(areaCode) ?? list?.group.areaName ?? "",
      salesValue,
      doctors,
      pharmacies,
      status: hasSales ? (hasDoctors ? "covered" : "sales-no-doctor") : hasDoctors ? "doctor-no-sales" : "idle",
    });
  }
  // Biggest seller first; the bricks that sold nothing follow, those holding doctors ahead.
  bricks.sort(
    (left, right) =>
      right.salesValue - left.salesValue ||
      right.doctors - left.doctors ||
      right.pharmacies - left.pharmacies ||
      left.brickName.localeCompare(right.brickName),
  );

  const outside: Employee360OutsideBrick[] = [];
  for (const [brickId, entry] of listByBrick) {
    if (areaBrickIds.has(brickId)) continue;
    outside.push({
      brickId,
      brickName: entry.group.heading.trim() || "Unnamed brick",
      areaName: entry.group.areaName,
      doctors: entry.doctors,
      pharmacies: entry.pharmacies,
    });
  }
  outside.sort((left, right) => right.doctors - left.doctors || right.pharmacies - left.pharmacies || left.brickName.localeCompare(right.brickName));

  const brickSales = bricks.reduce((sum, brick) => sum + Math.max(0, brick.salesValue), 0);
  const salesNoDoctorValue = bricks
    .filter((brick) => brick.status === "sales-no-doctor")
    .reduce((sum, brick) => sum + brick.salesValue, 0);

  return {
    lineName: input.lineName,
    // A nameless area is left out of the label, never replaced by its code.
    areaNames: input.areas.map((area) => area.areaName).filter(Boolean),
    salesMonths: input.salesMonths,
    salesMonthsFallback: input.salesMonthsFallback,
    bricks,
    outside,
    salesWithoutBrick,
    unmapped,
    totals: {
      areaBricks: bricks.length,
      bricksWithSales: bricks.filter((brick) => brick.salesValue > 0).length,
      bricksWithDoctors: bricks.filter((brick) => brick.doctors > 0).length,
      salesNoDoctor: bricks.filter((brick) => brick.status === "sales-no-doctor").length,
      salesNoDoctorShare: brickSales > 0 ? salesNoDoctorValue / brickSales : null,
      brickSales,
      listDoctors,
      listPharmacies,
      doctorsInArea: bricks.reduce((sum, brick) => sum + brick.doctors, 0),
      doctorsOutside: outside.reduce((sum, brick) => sum + brick.doctors, 0),
      pharmaciesOutside: outside.reduce((sum, brick) => sum + brick.pharmacies, 0),
    },
  };
}

// ── IO ───────────────────────────────────────────────────────────────────────

type RepTerritory = { lineCode: string; areas: Array<{ areaCode: string; areaName: string }> };

/**
 * The areas whose target this rep's seat carries TODAY, through the public views over `au` (PostgREST
 * exposes only `public`). Null when the person holds no rep seat — a manager or a vacancy has no area
 * of his own to compare, and the panel is not drawn.
 */
async function loadRepTerritory(hrId: string): Promise<RepTerritory | null> {
  const supabase = getSupabaseAdmin();
  const { data: seats, error: seatError } = await supabase
    .from("au_v_employee_seat_drift")
    .select("hr_id, seat_id, seat_tier")
    .in("hr_id", hrIdLookupKeys(hrId))
    .eq("seat_tier", "REP");
  if (seatError) throw new Error(seatError.message);
  const seatIds = [...new Set((seats ?? []).map((row) => String((row as { seat_id?: string | null }).seat_id ?? "")).filter(Boolean))];
  if (seatIds.length === 0) return null;

  const today = cairoTodayIso();
  const { data: map, error: mapError } = await supabase
    .from("au_v_line_area_map")
    .select("line_code, area_code, area_name, rep_seat_id, carries_target, effective_from, effective_to")
    .in("rep_seat_id", seatIds)
    .is("effective_to", null)
    .eq("carries_target", true);
  if (mapError) throw new Error(mapError.message);

  const rows = ((map ?? []) as Array<{
    area_code: string | null;
    area_name: string | null;
    effective_from: string | null;
    line_code: string | null;
  }>).filter((row) => row.area_code && row.line_code && (!row.effective_from || row.effective_from <= today));
  if (rows.length === 0) return null;
  // One line per rep seat; a seat that somehow spans two keeps the first, never a mix.
  const lineCode = String(rows[0].line_code);
  const areas = new Map<string, string>();
  for (const row of rows) {
    if (row.line_code !== lineCode) continue;
    const code = upper(row.area_code);
    if (!areas.has(code)) areas.set(code, (row.area_name ?? "").trim());
  }
  return { lineCode, areas: [...areas].map(([areaCode, areaName]) => ({ areaCode, areaName })) };
}

/**
 * One line-month of the closing's brick sales, SHARED WHILE IN FLIGHT (2026-10-01, "slow to transfer
 * between page and page"): the figure is the whole line's, not the viewer's (the El Qema mask is
 * applied per viewer afterwards), so two reps of one line opening their pages at once — or one page
 * asking twice — wait on one `phx_closing_brick` read instead of each running it. Nothing is kept once
 * it settles, a failure included, so no answer outlives its own read. Every waiter gets the same rows
 * and none mutates them: the mask filters into a new array and everything after only reads.
 */
const closingBrickSalesInFlight = new Map<string, Promise<BrickSalesRow[]>>();

function loadClosingBrickSalesShared(line: string, period: string): Promise<BrickSalesRow[]> {
  const key = `${line}|${period}`;
  const inFlight = closingBrickSalesInFlight.get(key);
  if (inFlight) return inFlight;
  const request: Promise<BrickSalesRow[]> = loadClosingBrickSales(line, period).finally(() => {
    if (closingBrickSalesInFlight.get(key) === request) closingBrickSalesInFlight.delete(key);
  });
  closingBrickSalesInFlight.set(key, request);
  return request;
}

/**
 * The panel for one person, or null when they hold no rep seat. Server-only.
 *
 * `viewerRole` decides the El Qema mask — see note 2 in the header.
 */
export async function getEmployee360BrickCoverage(
  hrId: string,
  window: Pick<Employee360Window, "from" | "to">,
  viewerRole: PhoenixRole,
): Promise<Employee360BrickCoverage | null> {
  // STARTED TOGETHER (2026-10-01, "slow to transfer between page and page"): the landed months, the
  // hire months and the list's brick placement need nothing from the seat, so they load while the seat
  // and its areas are read instead of after them. They are still only USED once a seat is found: a
  // person with none returns null below exactly as before, and a failed seat read still fails the
  // panel on its own error. The no-op handlers only stop a failure of theirs from surfacing unhandled
  // while the seat is awaited — or at all, on those two early paths; each is awaited below.
  const currentMonth = cairoTodayIso().slice(0, 7);
  const uploadedPeriodsLoad = loadUploadedPeriodsInRange(SALES_HISTORY_FLOOR, currentMonth);
  const hireMonthsLoad = loadEmployee360HireMonths();
  const placementLoad = getRepsListBrickPlacement(hrId);
  const earlyLoads: Promise<unknown>[] = [uploadedPeriodsLoad, hireMonthsLoad, placementLoad];
  for (const load of earlyLoads) load.catch(() => undefined);

  const territory = await loadRepTerritory(hrId);
  if (!territory) return null;
  const line = lineName(territory.lineCode);

  // The closing months need only the landed months and the hire month — not the placement — so the
  // closing reads start as soon as those two are in.
  const [uploadedPeriods, hireMonths, publishedKeys] = await Promise.all([
    uploadedPeriodsLoad,
    hireMonthsLoad,
    loadSalesReleaseKeys(),
  ]);
  const key = canonicalHrIdKey(hrId);
  // Only months this line has published (owner, 2026-11-04). The fallback to "the latest landed month"
  // reads this same list, so it cannot reach past the last published month either.
  const { months, fallback } = resolveBrickSalesMonths({
    window,
    uploadedPeriods: new Set(
      [...uploadedPeriods].filter((period) => isSalesPeriodReleased(period, territory.lineCode, publishedKeys)),
    ),
    hireMonth: key ? (hireMonths.get(key) ?? null) : null,
  });

  const viewer = { role: viewerRole, scope: scopeForRole(viewerRole) };
  const sales = (await Promise.all(months.map((period) => loadClosingBrickSalesShared(line, period))))
    .flatMap((rows) => [...withoutMaskedSourceRows(rows, viewer)]);

  const areaCodes = territory.areas.map((area) => area.areaCode);
  const areaSet = new Set(areaCodes);
  const salesBrickIds = [...new Set(sales.filter((row) => areaSet.has(upper(row.areaCode))).map((row) => row.brickId))];
  const [brickMaster, placement] = await Promise.all([loadAreaBrickMaster(areaCodes, salesBrickIds), placementLoad]);

  return buildEmployee360BrickCoverage({
    lineName: line,
    areas: territory.areas,
    brickMaster,
    sales,
    groups: placement.groups,
    salesMonths: months,
    salesMonthsFallback: fallback,
  });
}

/**
 * What the page draws. A failed read is its OWN state, never folded into "no seat": the page must
 * say the panel could not load rather than silently showing nothing, which reads as "no area".
 */
export type Employee360BrickPanel =
  | { status: "ready"; coverage: Employee360BrickCoverage }
  | { status: "no-seat" }
  | { status: "failed" };

export async function loadEmployee360BrickPanel(
  hrId: string,
  window: Pick<Employee360Window, "from" | "to">,
  viewerRole: PhoenixRole,
): Promise<Employee360BrickPanel> {
  try {
    const coverage = await getEmployee360BrickCoverage(hrId, window, viewerRole);
    return coverage ? { status: "ready", coverage } : { status: "no-seat" };
  } catch (error) {
    console.error("[employee-360] brick panel failed", error);
    return { status: "failed" };
  }
}
