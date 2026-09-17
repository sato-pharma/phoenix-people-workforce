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
import { readTestFlag, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm } from "@/lib/phoenix-crm/server/db";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { seatTierTitle } from "@/lib/phoenix-crm/server/territory";

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
};

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
