/**
 * Phoenix CRM — the module's own reports (owner, 2026-09-16): visits per rep per day, plan against
 * actual, coverage and frequency, and double and chain visits per manager.
 *
 *   - Read from this module's tables only; never iReports360 and never the old pilot's tables ("we will
 *     not throw it onto the old CRM and wire it in").
 *   - Aggregated in the database (supabase/migrations/20260916150000_phoenix_crm.sql, section 13), one
 *     section at a time, so a phone reads only the section on screen.
 *   - Scope runs downward only: the viewer's territories (scopeTerritories), narrowed by line or
 *     territory. The manager report lists the managers above those territories who are in the viewer's
 *     scope (the viewer and the managers below them): never their own manager, never the CEO.
 *   - AM and PM stay apart in every figure and every total.
 *   - The Super Admin's test entries stay out unless the Super Admin ticks "include test entries";
 *     nobody else can include them.
 */

import { forbiddenError, validationError } from "@/lib/http/api-errors";
import {
  coverageCell,
  emptyCoverageCounts,
  emptyManagerSummary,
  emptyPlanCounts,
  emptyVisitCounts,
  groupCoverageByTerritory,
  groupManagerVisits,
  groupPlanByTerritory,
  groupVisitsByRep,
  planKeptPercent,
  REPORT_MAX_DAYS,
  resolveReportMonth,
  resolveReportPeriod,
  type ByList,
  type CoverageCell,
  type ManagerVisitEntry,
  type ManagerVisitSummary,
  type PlanCounts,
  type PlanDay,
  type RepVisitGroup,
  type ReportMonth,
  type ReportPeriod,
  type VisitCounts,
} from "@/lib/phoenix-crm/report-rules";
import { heldManagerSeats, managersInScope, territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { readTestFlag, readsTeamReports, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, chunk, numberOrNull, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { formatDistance } from "@/lib/phoenix-crm/geo";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { seatTierTitle } from "@/lib/phoenix-crm/server/territory";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function asRows(data: unknown): Row[] {
  return Array.isArray(data) ? (data as Row[]) : [];
}

export type ReportFilterInput = {
  seatId?: unknown;
  lineCode?: unknown;
  includeTest?: unknown;
  from?: unknown;
  to?: unknown;
  month?: unknown;
};

type ChosenTerritories = { seats: OrgSeat[]; includeTest: boolean };

function trimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The viewer's territories, narrowed by line and territory; never wider than the viewer. */
function chooseTerritories(viewer: PhoenixCrmViewer, raw: ReportFilterInput): ChosenTerritories {
  let seats = viewer.scopeTerritories;
  const lineCode = trimmed(raw.lineCode);
  if (lineCode) {
    seats = seats.filter((seat) => seat.lineCode === lineCode);
    if (seats.length === 0) throw forbiddenError("This line is outside your scope.");
  }
  const seatId = trimmed(raw.seatId);
  if (seatId) {
    seats = seats.filter((seat) => seat.seatId === seatId);
    if (seats.length === 0) throw forbiddenError("This territory is outside your scope.");
  }
  return { seats, includeTest: viewer.isSuperAdmin && readTestFlag(raw.includeTest) };
}

function periodOf(viewer: PhoenixCrmViewer, raw: ReportFilterInput): ReportPeriod {
  const result = resolveReportPeriod({ from: raw.from, to: raw.to, cairoToday: viewer.cairoToday });
  if (!result.ok) throw validationError(result.error);
  return result.value;
}

function byTerritoryName<T extends { territoryName: string }>(left: T, right: T): number {
  return left.territoryName.localeCompare(right.territoryName);
}

// ── What the report screen can choose from ──────────────────────────────────────────────────────

export type ReportTerritory = { seatId: string; name: string; lineCode: string | null; lineName: string | null; repName: string | null };

export type ReportScopeView = {
  cairoToday: string;
  canIncludeTest: boolean;
  maxDays: number;
  defaults: { from: string; to: string; month: string };
  lines: Array<{ lineCode: string; lineName: string }>;
  territories: ReportTerritory[];
  /** Whether the manager section has anyone to show (the viewer or managers below them). */
  hasManagers: boolean;
  /**
   * Whether the viewer may open "Where the visit was saved".
   *
   * Owner, 2026-09-26: that report is for the district manager, SFE, the national sales manager and
   * the Super Admin — NOT the medical rep. Everything else on this tab a rep may read about his own
   * territory, so the section is gated on holding a manager seat (or reading the company) rather than
   * on scope, which a rep also has. He still sees the distance on his OWN visit as he always has (his
   * ruling, same day): what is withheld is the comparison across a team.
   */
  canSeeLocations: boolean;
};

/** The one predicate behind canSeeLocations, so the screen and the service cannot drift apart. */
// Lifted into server/access.ts as `readsTeamReports` (2026-09-26) once the exceptions board asked the
// same question. Kept as a named alias here so every call site still reads as what it is testing.
const canReadLocationReport = readsTeamReports;

export async function loadReportScope(viewer: PhoenixCrmViewer): Promise<ReportScopeView> {
  const seats = viewer.scopeTerritories;
  const names = await loadPeopleNames(seats.map((seat) => seat.occupantHrId));
  const lines = new Map<string, string>();
  for (const seat of seats) {
    if (seat.lineCode) lines.set(seat.lineCode, seat.lineName ?? seat.lineCode);
  }
  return {
    cairoToday: viewer.cairoToday,
    canIncludeTest: viewer.isSuperAdmin,
    maxDays: REPORT_MAX_DAYS,
    defaults: { from: `${viewer.cairoToday.slice(0, 7)}-01`, to: viewer.cairoToday, month: viewer.cairoToday.slice(0, 7) },
    lines: [...lines]
      .map(([lineCode, lineName]) => ({ lineCode, lineName }))
      .sort((left, right) => left.lineName.localeCompare(right.lineName)),
    territories: seats
      .map((seat) => ({
        seatId: seat.seatId,
        name: territoryName(seat),
        lineCode: seat.lineCode,
        lineName: seat.lineName,
        repName: seat.occupantHrId ? nameOf(names, seat.occupantHrId) : null,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    hasManagers: managersInScope(viewer.org, viewer.hrId, viewer.basis).length > 0,
    canSeeLocations: canReadLocationReport(viewer),
  };
}

// ── Visits per rep per day ──────────────────────────────────────────────────────────────────────

export type RepVisitRow = RepVisitGroup & {
  key: string;
  territoryName: string;
  lineName: string | null;
  /** The rep's name, or "Managers' own visits" for visits no rep was on. */
  repName: string;
};

export type VisitsReportView = {
  period: ReportPeriod;
  includeTest: boolean;
  rows: RepVisitRow[];
  totals: ByList<VisitCounts>;
};

export async function loadVisitsReport(viewer: PhoenixCrmViewer, raw: ReportFilterInput): Promise<VisitsReportView> {
  const chosen = chooseTerritories(viewer, raw);
  const period = periodOf(viewer, raw);
  if (chosen.seats.length === 0) {
    return { period, includeTest: chosen.includeTest, rows: [], totals: { AM: emptyVisitCounts(), PM: emptyVisitCounts() } };
  }

  const data = await callPhoenixCrm<unknown>("phoenix_crm_report_visits_by_day", {
    p_seat_ids: chosen.seats.map((seat) => seat.seatId),
    p_from: period.from,
    p_to: period.to,
    p_include_test: chosen.includeTest,
  });
  const seatsById = new Map(chosen.seats.map((seat) => [seat.seatId, seat]));
  const { groups, totals } = groupVisitsByRep(asRows(data).filter((row) => seatsById.has(String(row.seat_id))));
  const names = await loadPeopleNames(groups.map((group) => group.repHrId));
  const rows = groups
    .map((group) => {
      const seat = seatsById.get(group.seatId) as OrgSeat;
      return {
        ...group,
        key: `${group.seatId}|${group.repHrId ?? "managers"}`,
        territoryName: territoryName(seat),
        lineName: seat.lineName,
        repName: group.repHrId ? nameOf(names, group.repHrId) : "Managers' own visits",
      };
    })
    .sort(
      (left, right) =>
        byTerritoryName(left, right) ||
        Number(left.repHrId === null) - Number(right.repHrId === null) ||
        left.repName.localeCompare(right.repName),
    );
  return { period, includeTest: chosen.includeTest, rows, totals };
}

// ── Plan against actual ─────────────────────────────────────────────────────────────────────────

export type PlanCell = PlanCounts & { keptPct: number | null };

export type TerritoryPlanRow = {
  seatId: string;
  territoryName: string;
  lineName: string | null;
  repName: string | null;
  days: PlanDay[];
  am: PlanCell;
  pm: PlanCell;
};

export type PlanReportView = {
  period: ReportPeriod;
  includeTest: boolean;
  /** Today, when the period reaches it: its planned customers can still be visited, so "missed" is not final. */
  runningDay: string | null;
  rows: TerritoryPlanRow[];
  totals: ByList<PlanCell>;
};

function planCell(counts: PlanCounts): PlanCell {
  return { ...counts, keptPct: planKeptPercent(counts) };
}

export async function loadPlanReport(viewer: PhoenixCrmViewer, raw: ReportFilterInput): Promise<PlanReportView> {
  const chosen = chooseTerritories(viewer, raw);
  const period = periodOf(viewer, raw);
  const runningDay = period.to === viewer.cairoToday ? viewer.cairoToday : null;
  if (chosen.seats.length === 0) {
    return {
      period,
      includeTest: chosen.includeTest,
      runningDay,
      rows: [],
      totals: { AM: planCell(emptyPlanCounts()), PM: planCell(emptyPlanCounts()) },
    };
  }

  const data = await callPhoenixCrm<unknown>("phoenix_crm_report_plan_vs_actual", {
    p_seat_ids: chosen.seats.map((seat) => seat.seatId),
    p_from: period.from,
    p_to: period.to,
    p_include_test: chosen.includeTest,
  });
  const seatsById = new Map(chosen.seats.map((seat) => [seat.seatId, seat]));
  const { groups, totals } = groupPlanByTerritory(asRows(data).filter((row) => seatsById.has(String(row.seat_id))));
  const names = await loadPeopleNames(groups.map((group) => seatsById.get(group.seatId)?.occupantHrId));
  const rows = groups
    .map((group) => {
      const seat = seatsById.get(group.seatId) as OrgSeat;
      return {
        seatId: group.seatId,
        territoryName: territoryName(seat),
        lineName: seat.lineName,
        repName: seat.occupantHrId ? nameOf(names, seat.occupantHrId) : null,
        days: group.days,
        am: planCell(group.am),
        pm: planCell(group.pm),
      };
    })
    .sort(byTerritoryName);
  return { period, includeTest: chosen.includeTest, runningDay, rows, totals: { AM: planCell(totals.AM), PM: planCell(totals.PM) } };
}

// ── Coverage and frequency ──────────────────────────────────────────────────────────────────────

export type TerritoryCoverageRow = {
  seatId: string;
  territoryName: string;
  lineName: string | null;
  repName: string | null;
  am: CoverageCell;
  pm: CoverageCell;
};

export type CoverageReportView = {
  month: ReportMonth;
  includeTest: boolean;
  /** Every chosen territory, including ones with no validated customers yet. */
  rows: TerritoryCoverageRow[];
  totals: ByList<CoverageCell>;
};

export async function loadCoverageReport(viewer: PhoenixCrmViewer, raw: ReportFilterInput): Promise<CoverageReportView> {
  const chosen = chooseTerritories(viewer, raw);
  const monthResult = resolveReportMonth({ month: raw.month, cairoToday: viewer.cairoToday });
  if (!monthResult.ok) throw validationError(monthResult.error);
  const month = monthResult.value;
  if (chosen.seats.length === 0) {
    return {
      month,
      includeTest: chosen.includeTest,
      rows: [],
      totals: { AM: coverageCell(emptyCoverageCounts()), PM: coverageCell(emptyCoverageCounts()) },
    };
  }

  const data = await callPhoenixCrm<unknown>("phoenix_crm_report_coverage", {
    p_seat_ids: chosen.seats.map((seat) => seat.seatId),
    p_month_start: month.monthStart,
    p_include_test: chosen.includeTest,
  });
  const chosenIds = new Set(chosen.seats.map((seat) => seat.seatId));
  const { groups, totals } = groupCoverageByTerritory(asRows(data).filter((row) => chosenIds.has(String(row.seat_id))));
  const bySeat = new Map(groups.map((group) => [group.seatId, group]));
  const names = await loadPeopleNames(chosen.seats.map((seat) => seat.occupantHrId));
  const rows = chosen.seats
    .map((seat) => {
      const group = bySeat.get(seat.seatId);
      return {
        seatId: seat.seatId,
        territoryName: territoryName(seat),
        lineName: seat.lineName,
        repName: seat.occupantHrId ? nameOf(names, seat.occupantHrId) : null,
        am: coverageCell(group?.am ?? emptyCoverageCounts()),
        pm: coverageCell(group?.pm ?? emptyCoverageCounts()),
      };
    })
    .sort(byTerritoryName);
  return { month, includeTest: chosen.includeTest, rows, totals: { AM: coverageCell(totals.AM), PM: coverageCell(totals.PM) } };
}

// ── Double and chain visits per manager ─────────────────────────────────────────────────────────

export type ManagerReportEntry = ManagerVisitEntry & { territoryName: string; repName: string | null };

export type ManagerReportRow = ManagerVisitSummary & {
  /** The row key; the screen shows the name and title only. */
  hrId: string;
  name: string;
  title: string;
  lineName: string | null;
  entries: ManagerReportEntry[];
};

export type ManagerReportView = {
  period: ReportPeriod;
  includeTest: boolean;
  /** Every manager in scope above the chosen territories, including managers with no visit yet. */
  rows: ManagerReportRow[];
};

export async function loadManagerReport(viewer: PhoenixCrmViewer, raw: ReportFilterInput): Promise<ManagerReportView> {
  const chosen = chooseTerritories(viewer, raw);
  const period = periodOf(viewer, raw);
  // A manager above a chosen territory through any seat they hold (a person on two seats is listed once).
  const managers = managersInScope(viewer.org, viewer.hrId, viewer.basis).filter((member) => {
    const held = new Set(heldManagerSeats(viewer.org, member.hrId).map((seat) => seat.seatId));
    return chosen.seats.some((territory) => territory.path.some((seatId) => seatId !== territory.seatId && held.has(seatId)));
  });
  if (managers.length === 0) return { period, includeTest: chosen.includeTest, rows: [] };

  const data = await callPhoenixCrm<unknown>("phoenix_crm_report_manager_visits", {
    p_hr_ids: managers.map((member) => member.hrId),
    p_from: period.from,
    p_to: period.to,
    p_include_test: chosen.includeTest,
  });
  // Never wider than the viewer: a visit in a territory outside the chosen ones is left out.
  const seatsById = new Map(chosen.seats.map((seat) => [seat.seatId, seat]));
  const grouped = groupManagerVisits(asRows(data).filter((row) => seatsById.has(String(row.seat_id))));
  const repIds = [...grouped.values()].flatMap((found) => found.entries.map((entry) => entry.repHrId));
  const names = await loadPeopleNames([...managers.map((member) => member.hrId), ...repIds]);

  const rows = managers
    .map((member) => {
      const found = grouped.get(member.hrId);
      return {
        ...(found?.summary ?? emptyManagerSummary()),
        hrId: member.hrId,
        name: nameOf(names, member.hrId),
        title: seatTierTitle(member.seat.tier),
        lineName: member.seat.lineName,
        entries: (found?.entries ?? []).map((entry) => {
          const seat = seatsById.get(entry.seatId) as OrgSeat;
          return { ...entry, territoryName: territoryName(seat), repName: entry.repHrId ? nameOf(names, entry.repHrId) : null };
        }),
      };
    })
    .sort((left, right) => (left.lineName ?? "").localeCompare(right.lineName ?? "") || left.name.localeCompare(right.name));
  return { period, includeTest: chosen.includeTest, rows };
}

// ── Where the visit was saved, against where the place is ────────────────────────────

/**
 * Owner, 2026-09-26: a report the district manager, SFE, the national sales manager and the Super
 * Admin can read — where the rep actually stood when he saved the visit, against where that customer's
 * place is saved in Phoenix, and how far apart the two are. The medical rep does not get it.
 *
 * Nothing new is captured for this. Every figure is already a column on the visit (`lat`, `lon`,
 * `accuracy_meters`, `distance_meters`, `location_flag`) and on the place (its own fix, and the brick,
 * area and region resolved server-side when it was captured and frozen since). This is a read, a sort
 * and a table.
 *
 * It is NOT the mock-location board. That one is Super-Admin-only and silent by his rule, because a
 * rep who learns what is measured learns what to defeat. This report says only how far apart two saved
 * points are — which the rep already sees on his own visit and will keep seeing.
 */
export type VisitLocationRow = {
  visitId: string;
  visitDate: string;
  capturedAt: string;
  territoryName: string;
  repName: string;
  customerName: string;
  listType: "AM" | "PM";
  /** Where the place is saved: its name, its address, and the geography resolved when it was captured. */
  placeLabel: string | null;
  placeAddress: string | null;
  placeWhere: string | null;
  placeLat: number | null;
  placeLon: number | null;
  /** Where he actually stood. */
  visitLat: number;
  visitLon: number;
  accuracyMeters: number | null;
  distanceMeters: number | null;
  distanceText: string;
  locationFlag: string;
  /** Off the plan, so a manager reading a long distance knows it was not a planned call either. */
  isUnplanned: boolean;
};

export type VisitLocationReportView = {
  period: ReportPeriod;
  includeTest: boolean;
  /** The worst first, capped; `total` says how many there were in all. */
  rows: VisitLocationRow[];
  total: number;
  summary: { visits: number; far: number; weakGps: number; noPlace: number; measured: number; farthestMeters: number | null };
};

/** At most this many rows travel to the phone; the summary is measured over every visit in the period. */
const LOCATION_ROW_CAP = 300;

export async function loadVisitLocationReport(viewer: PhoenixCrmViewer, raw: ReportFilterInput): Promise<VisitLocationReportView> {
  if (!canReadLocationReport(viewer)) throw forbiddenError("This report is for managers, SFE and the Super Admin.");
  const chosen = chooseTerritories(viewer, raw);
  const period = periodOf(viewer, raw);
  const empty: VisitLocationReportView = {
    period,
    includeTest: chosen.includeTest,
    rows: [],
    total: 0,
    summary: { visits: 0, far: 0, weakGps: 0, noPlace: 0, measured: 0, farthestMeters: null },
  };
  if (chosen.seats.length === 0) return empty;

  const columns =
    "id, seat_id, visit_date, captured_at, rep_hr_id, entered_by_hr_id, list_type, lat, lon, accuracy_meters, distance_meters, " +
    "location_flag, is_unplanned, is_test, " +
    "customer:phoenix_crm_customers!customer_id(name), " +
    "place:phoenix_crm_places!place_id(label, address, brick_name, area_name, region_name, lat, lon)";

  const rows: Row[] = [];
  for (const batch of chunk(chosen.seats.map((seat) => seat.seatId))) {
    let query = getSupabaseAdmin()
      .from("phoenix_crm_visits")
      .select(columns)
      .in("seat_id", batch)
      .gte("visit_date", period.from)
      .lte("visit_date", period.to);
    if (!chosen.includeTest) query = query.eq("is_test", false);
    const { data, error } = await query;
    throwIfError(error);
    rows.push(...asRows(data));
  }

  const seatsById = new Map(chosen.seats.map((seat) => [seat.seatId, seat]));
  const names = await loadPeopleNames(rows.map((row) => textOrNull(row.rep_hr_id) ?? textOrNull(row.entered_by_hr_id)));

  let far = 0;
  let weakGps = 0;
  let noPlace = 0;
  let measured = 0;
  let farthest: number | null = null;
  const mapped: VisitLocationRow[] = rows.map((row) => {
    const flag = String(row.location_flag ?? "ok");
    if (flag === "far") far += 1;
    if (flag === "weak_gps") weakGps += 1;
    if (flag === "no_place") noPlace += 1;
    const distance = numberOrNull(row.distance_meters);
    if (distance !== null) {
      measured += 1;
      if (farthest === null || distance > farthest) farthest = distance;
    }
    const place = (Array.isArray(row.place) ? row.place[0] : row.place) as Row | null;
    const placeRow = (place ?? {}) as Row;
    const customer = (Array.isArray(row.customer) ? row.customer[0] : row.customer) as Row | null;
    const seat = seatsById.get(String(row.seat_id));
    // Names, never codes (owner rule): the brick, area and region as the place recorded them.
    const where = [textOrNull(placeRow.brick_name), textOrNull(placeRow.area_name), textOrNull(placeRow.region_name)].filter(Boolean).join(" · ");
    return {
      visitId: String(row.id),
      visitDate: String(row.visit_date),
      capturedAt: String(row.captured_at),
      territoryName: seat ? territoryName(seat) : "Territory",
      repName: nameOf(names, textOrNull(row.rep_hr_id) ?? textOrNull(row.entered_by_hr_id)),
      customerName: textOrNull((customer ?? {}).name) ?? "Customer",
      listType: row.list_type === "AM" ? "AM" : "PM",
      placeLabel: textOrNull(placeRow.label),
      placeAddress: textOrNull(placeRow.address),
      placeWhere: where || null,
      placeLat: numberOrNull(placeRow.lat),
      placeLon: numberOrNull(placeRow.lon),
      visitLat: Number(row.lat),
      visitLon: Number(row.lon),
      accuracyMeters: numberOrNull(row.accuracy_meters),
      distanceMeters: distance,
      distanceText: distance === null ? "—" : formatDistance(distance),
      locationFlag: flag,
      isUnplanned: row.is_unplanned === true,
    };
  });

  // The farthest first: that is the only order a manager reads this in. A visit with no distance to
  // measure (no place saved yet) sorts last rather than as if it were zero metres away.
  mapped.sort(
    (left, right) =>
      (right.distanceMeters ?? -1) - (left.distanceMeters ?? -1) ||
      right.visitDate.localeCompare(left.visitDate) ||
      left.customerName.localeCompare(right.customerName),
  );

  return {
    period,
    includeTest: chosen.includeTest,
    rows: mapped.slice(0, LOCATION_ROW_CAP),
    total: mapped.length,
    summary: { visits: mapped.length, far, weakGps, noPlace, measured, farthestMeters: farthest },
  };
}
