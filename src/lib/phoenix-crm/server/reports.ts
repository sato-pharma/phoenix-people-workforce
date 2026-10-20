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

import { addDaysIso } from "@/lib/crm/dates";
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
  averagePerTerritory,
  delta,
  isComparisonMode,
  previousPeriod,
  REPORT_MAX_DAYS,
  resolveReportMonth,
  resolveReportPeriod,
  type ByList,
  type ComparisonMode,
  type CoverageCell,
  type Delta,
  type ManagerVisitEntry,
  type ManagerVisitSummary,
  type PlanCounts,
  type PlanDay,
  type RepVisitGroup,
  type ReportMonth,
  type ReportPeriod,
  type VisitCounts,
} from "@/lib/phoenix-crm/report-rules";
import { monthEndOf } from "@/lib/phoenix-crm/calendar";
import { doctorListType, parseListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { buildTrackingSheet, type TrackingSheetRow } from "@/lib/phoenix-crm/tracking-sheet";
import { monthDays } from "@/lib/phoenix-crm/team-calendar";
import {
  buildCustomerFrequencyReport,
  customerFrequencyTotals,
  plannedOutsideLeave,
  type CustomerFrequencyInput,
  type CustomerFrequencyRow,
} from "@/lib/phoenix-crm/customer-frequency";
import { cairoDayOfInstant, dailyPlanActivityText } from "@/lib/phoenix-crm/daily-plan-report";
import { MISSED_RECORD_MARK } from "@/lib/phoenix-crm/missed-records";
import { isLeaveDay } from "@/lib/phoenix-crm/plan-leave";
import { isPlanDaySent } from "@/lib/phoenix-crm/plan-rules";
import { isVisitAskAskableRole } from "@/lib/phoenix-crm/visit-ask-rules";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import type { PhoenixCrmGrade, PhoenixCrmListType } from "@/lib/phoenix-crm/types";
import { heldManagerSeats, managersInScope, personKey, territoriesBelow, territoriesUnderManager, territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import {
  locationReportSeats,
  readsFieldHeardByProduct,
  readsLocationDetail,
  readsOwnRideAlongs,
  readsPlaceVsActual,
  readsTeamReports,
  readsTeamReportsOn,
  reportIncludesTest,
  type PhoenixCrmViewer,
} from "@/lib/phoenix-crm/server/access";
import { blindVisitsReport } from "@/lib/phoenix-crm/server/blind-payloads";
// `throwIfError` lost its last caller here when place-vs-actual became a keyset walk: the pager
// throws on a failed page itself, which is the whole reason a short answer can no longer read as a
// complete one. Every other read in this file is an RPC through `callPhoenixCrm`.
import { callPhoenixCrm, chunk, numberOrNull, textOrNull } from "@/lib/phoenix-crm/server/db";
import { formatDistance } from "@/lib/phoenix-crm/geo";
import { loadSeatDayActivities } from "@/lib/phoenix-crm/server/day-activities";
import { loadSeatLeaveDays } from "@/lib/phoenix-crm/server/leave-days";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { loadPlanDayFacts, PLAN_DAY_COLUMNS, PLAN_STATUSES_WITH_SENT_DAYS } from "@/lib/phoenix-crm/server/plan-day-status";
import { seatTierTitle } from "@/lib/phoenix-crm/server/territory";
import { loadScopeProductManagers } from "@/lib/phoenix-crm/server/scope-product-managers";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function asRows(data: unknown): Row[] {
  return Array.isArray(data) ? (data as Row[]) : [];
}

// ── Reading many territories at once ────────────────────────────────────────────────────────────

/** Territories per read inside one batch, and how many of those reads are in flight at once. */
const SEAT_GROUP_SIZE = 20;
const SEAT_GROUP_CONCURRENCY = 4;

/** Ascending by `id` — a lower-case uuid string sorts exactly as Postgres sorts the uuid. */
function byRowId(left: { id?: unknown }, right: { id?: unknown }): number {
  const a = String(left.id);
  const b = String(right.id);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * One keyset read over many territories, made as several smaller reads four at a time — and handed
 * back as exactly the rows, in exactly the order, the single walk returned.
 *
 * WHY (2026-10-16 Phoenix CRM performance audit). Every multi-territory report read its rows as one
 * keyset walk per batch of 150 or 200 territories, 1,000 rows a page, one page after the other — a
 * national scope's month is a dozen round trips in series while the manager watches a spinner. Split
 * into groups of twenty territories, the pages are read four at a time.
 *
 * 🔴 NOTHING ON A SCREEN MAY MOVE. Each batch is still the caller's own batch; every territory in it
 * lands in exactly one group, and a row belongs to one territory, so the union is the batch's rows,
 * each once. They are then put back in `id` order — the walk's own order — because a stable sort
 * downstream breaks its ties in the order it was given. `id` is a uuid on every table read through
 * here, and a lower-case uuid's text sorts as Postgres sorts the uuid (hex digits and fixed-place
 * dashes, byte for byte). `read` must therefore be a keyset walk on `id`.
 */
export async function readSeatGroups<T extends { id?: unknown }>(
  seatIds: ReadonlyArray<string>,
  batchSize: number,
  read: (seatIds: string[]) => Promise<T[]>,
): Promise<T[]> {
  const batches = chunk(seatIds, batchSize);
  const groups = batches.flatMap((batch, at) => chunk([...new Set(batch)], SEAT_GROUP_SIZE).map((seats) => ({ at, seats })));
  const parts = await mapWithConcurrency(groups, SEAT_GROUP_CONCURRENCY, (group) => read(group.seats));
  const byBatch = batches.map((): T[] => []);
  parts.forEach((rows, index) => byBatch[groups[index]!.at]!.push(...rows));
  return byBatch.flatMap((rows) => rows.sort(byRowId));
}

const inFlight = new Map<string, Promise<unknown>>();

/**
 * One read shared by the callers that ask for it AT THE SAME MOMENT — and nothing kept once it lands.
 *
 * The reports pack loads every section at once, and several sections open with the same heavy read:
 * the readiness of every territory (the exceptions board and adoption), the countable visits of the
 * period (what the field heard and the missing-stock board). Two callers asking the same question in
 * the same instant now share one answer. Nothing is cached: the next request reads afresh, so no
 * figure can be older than it was. `key` must hold EVERYTHING that changes the answer.
 *
 * A shared answer is shared by reference, so a caller must never change what it is handed.
 */
export function shareInFlight<T>(key: string, load: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const started = load().finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
}

/**
 * A read started BEFORE the code knows it will be needed, so it runs beside the reads ahead of it.
 * Its rejection is marked handled here — a page that returns early without it must not trip an
 * unhandled rejection — and the SAME promise, failure and all, is what the caller awaits when it does
 * need it, so a failed read still fails the page exactly where it used to.
 */
export function startedEarly<T>(read: Promise<T>): Promise<T> {
  read.catch(() => undefined);
  return read;
}

export type ReportFilterInput = {
  seatId?: unknown;
  lineCode?: unknown;
  includeTest?: unknown;
  from?: unknown;
  to?: unknown;
  month?: unknown;
  /** C3: what the figures are read against — off (the default), previous, or peers. */
  compare?: unknown;
  /**
   * One of the viewer's managers, by HR id: the territories under the seats he holds (owner, 2026-10-20: "when
   * filter by manager u find no manager"). Refused when he is not one of the viewer's managers.
   */
  managerHrId?: unknown;
};

export type ChosenTerritories = { seats: OrgSeat[]; includeTest: boolean };

function trimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The viewer's territories, narrowed by line and territory; never wider than the viewer.
 *
 * Exported for the four insight boards (server/insight-reports.ts) so they narrow through THIS rule and
 * never a second copy of it.
 */
export function chooseTerritories(viewer: PhoenixCrmViewer, raw: ReportFilterInput): ChosenTerritories {
  let seats = viewer.scopeTerritories;
  const lineCode = trimmed(raw.lineCode);
  if (lineCode) {
    seats = seats.filter((seat) => seat.lineCode === lineCode);
    if (seats.length === 0) throw forbiddenError("This line is outside your scope.");
  }
  // The manager filter (owner, 2026-10-20: "when filter by manager u find no manager"): the territories under the
  // seats he holds, and only ever a narrowing of the viewer's own — a manager outside his reach is refused.
  const managerHrId = trimmed(raw.managerHrId);
  if (managerHrId) {
    const under = territoriesUnderManager(viewer.org, viewer.hrId, viewer.basis, managerHrId);
    if (under) seats = seats.filter((seat) => under.has(seat.seatId));
    if (!under || seats.length === 0) throw forbiddenError("This manager is outside your scope.");
  }
  const seatId = trimmed(raw.seatId);
  if (seatId) {
    seats = seats.filter((seat) => seat.seatId === seatId);
    if (seats.length === 0) throw forbiddenError("This territory is outside your scope.");
  }
  return { seats, includeTest: reportIncludesTest(viewer, raw.includeTest) };
}

export function periodOf(viewer: PhoenixCrmViewer, raw: ReportFilterInput): ReportPeriod {
  const result = resolveReportPeriod({ from: raw.from, to: raw.to, cairoToday: viewer.cairoToday });
  if (!result.ok) throw validationError(result.error);
  return result.value;
}

function byTerritoryName<T extends { territoryName: string }>(left: T, right: T): number {
  return left.territoryName.localeCompare(right.territoryName);
}

// ── Comparison (C3) ─────────────────────────────────────────────────────────────────────────────

/**
 * What a section's figures are read against, when the viewer asks for it.
 *
 * One shape for all three sections, because a screen that reads each one differently is a screen
 * where one of them quietly stops being drawn. The headline figure is a COUNT in every case — visits,
 * planned calls kept, customers covered — never a percentage: the difference between two percentages
 * is percentage POINTS, which reads as a percent and is not one.
 *
 * 🔴 **`peers` fills `bySeat` with the SAME district average for every territory**, deliberately. It
 * is not a ranking and must not become one: the baseline is "the average territory in your scope",
 * identical for every row on the board, so a reader looking for who is worst is left to work it out
 * from figures he already had rather than handed an ordering with names on it.
 */
export type ReportComparison = {
  mode: Exclude<ComparisonMode, "off">;
  /** What the second line on a cell says it is against. */
  label: string;
  /** The days the baseline was measured over; null for `peers`, which uses the same days. */
  baselinePeriod: ReportPeriod | null;
  /** How many territories the peer average spans; null for `previous`. */
  territories: number | null;
  totals: ByList<Delta>;
  bySeat: Array<{ seatId: string; am: Delta; pm: Delta }>;
};

/** One section's figures reduced to the two counts a comparison is built from. */
type ComparisonFigures = { totals: ByList<number>; bySeat: Map<string, { am: number; pm: number }> };

function comparisonModeOf(viewer: PhoenixCrmViewer, raw: ReportFilterInput): Exclude<ComparisonMode, "off"> | null {
  const mode = isComparisonMode(raw.compare) ? raw.compare : "off";
  if (mode === "off") return null;
  // Manager-only in v1 (the plan). A rep shown "the average" is being shown his colleagues' work in
  // aggregate — the same disclosure the place-vs-actual report withholds from him — and reading his
  // own territory against last month is a smaller question nobody has asked for yet.
  if (!readsTeamReports(viewer)) return null;
  return mode;
}

/**
 * Build the comparison from figures the caller has already measured.
 *
 * `now` and `baseline` are the same shape, so the two modes differ only in WHAT was measured: the
 * previous days over the same seats, or the same days over every seat in the viewer's scope.
 */
function buildComparison(input: {
  mode: Exclude<ComparisonMode, "off">;
  now: ComparisonFigures;
  baseline: ComparisonFigures;
  baselinePeriod: ReportPeriod | null;
  peerTerritoryCount: number | null;
  seatIds: ReadonlyArray<string>;
}): ReportComparison {
  const { baseline, mode, now } = input;
  if (mode === "peers") {
    const count = input.peerTerritoryCount ?? 0;
    const am = averagePerTerritory(baseline.totals.AM, count);
    const pm = averagePerTerritory(baseline.totals.PM, count);
    return {
      baselinePeriod: null,
      bySeat: input.seatIds.map((seatId) => ({
        seatId,
        am: delta(now.bySeat.get(seatId)?.am ?? 0, am),
        pm: delta(now.bySeat.get(seatId)?.pm ?? 0, pm),
      })),
      label: count > 0 ? `vs the average of ${count} territories` : "vs the average territory",
      mode,
      territories: count,
      totals: { AM: delta(now.totals.AM, am), PM: delta(now.totals.PM, pm) },
    };
  }
  return {
    baselinePeriod: input.baselinePeriod,
    bySeat: input.seatIds.map((seatId) => ({
      seatId,
      am: delta(now.bySeat.get(seatId)?.am ?? 0, baseline.bySeat.get(seatId)?.am ?? 0),
      pm: delta(now.bySeat.get(seatId)?.pm ?? 0, baseline.bySeat.get(seatId)?.pm ?? 0),
    })),
    label: input.baselinePeriod ? `vs ${input.baselinePeriod.from} to ${input.baselinePeriod.to}` : "vs the period before",
    mode,
    territories: null,
    totals: { AM: delta(now.totals.AM, baseline.totals.AM), PM: delta(now.totals.PM, baseline.totals.PM) },
  };
}

/**
 * The territories a peer average spans: the viewer's WHOLE scope, whatever the screen is filtered to.
 *
 * Narrowing it to the chosen line or territory would compare a territory with itself and answer +0%
 * every time. The filter is what the reader is looking AT; the peer set is what he is looking at it
 * against, and the two are not the same set.
 */
export function peerTerritories(viewer: PhoenixCrmViewer): OrgSeat[] {
  return viewer.scopeTerritories;
}

// ── What the report screen can choose from ──────────────────────────────────────────────────────

export type ReportTerritory = { seatId: string; name: string; lineCode: string | null; lineName: string | null; repName: string | null };

/**
 * A manager the report screen's "Manager" filter offers (owner, 2026-10-20: "when filter by manager u find no
 * manager") — every manager the viewer reads who holds a seat above one of his territories, with the territories
 * under him so the screen can narrow its territory list without asking again. Names, never codes: `hrId` is the
 * filter's value only.
 */
export type ReportScopeManager = {
  hrId: string;
  name: string;
  title: string;
  lineCode: string | null;
  lineName: string | null;
  seatIds: string[];
};

export type ReportScopeView = {
  cairoToday: string;
  /**
   * 🔒 ALWAYS FALSE SINCE 2026-10-03 — the Super Admin's test mode is retired (owner: *"the test in
   * the phoenix crm is now irrelevant, u can fully retire it"*) and the "Include my test entries" tick
   * went with it. The field is KEPT rather than dropped so a browser tab open across the deploy reads
   * a defined `false` instead of `undefined`, and so the next reader of this type sees that it was
   * retired rather than never existing. Nothing may make it true again.
   */
  canIncludeTest: boolean;
  maxDays: number;
  defaults: { from: string; to: string; month: string };
  lines: Array<{ lineCode: string; lineName: string }>;
  territories: ReportTerritory[];
  /** The managers the "Manager" filter offers — empty when there is nobody but the viewer's own reps to choose. */
  managers: ReportScopeManager[];
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
  /**
   * Who the tab is drawn for. `field`: the field force, its managers, SFE, the CEO and the Super Admin
   * — every section, as each one's own gate allows. `products`: a product or marketing manager (owner,
   * 2026-10-02), who holds no seat in the sales organogram and reads ONE section — what the field heard
   * about his own products, company-wide — with no line and no territory to choose.
   */
  audience: "field" | "products";
  /**
   * Whether the visits reps ask of this viewer are answered above this tab (owner, 2026-10-02): a
   * Product Manager or Group Product Manager, and the Marketing Manager, whom CNS reps may ask (the
   * owner's CNS rule). It draws nothing until somebody has asked — an empty inbox, never a refusal.
   */
  answersVisitAsks: boolean;
};

/** The one predicate behind canSeeLocations, so the screen and the service cannot drift apart. */
// Lifted into server/access.ts as `readsTeamReports` (2026-09-26) once the exceptions board asked the
// same question, and given its OWN predicate on 2026-10-02, when the owner took the CEO and the regional
// managers off this report and left the exceptions board and the digest as they were. Kept as a named
// alias here so every call site still reads as what it is testing.
const canReadLocationReport = readsPlaceVsActual;

/** The viewer's managers who stand above at least one of his territories, each with the territories under him. */
function reportScopeManagers(viewer: PhoenixCrmViewer): Array<Omit<ReportScopeManager, "name">> {
  const inScope = new Set(viewer.scopeTerritories.map((seat) => seat.seatId));
  const out: Array<Omit<ReportScopeManager, "name">> = [];
  for (const member of managersInScope(viewer.org, viewer.hrId, viewer.basis)) {
    if (member.seat.isOtherPseudoDm) continue;
    const held = heldManagerSeats(viewer.org, member.hrId).map((seat) => seat.seatId);
    const seatIds = territoriesBelow(viewer.org, held)
      .map((seat) => seat.seatId)
      .filter((seatId) => inScope.has(seatId));
    if (seatIds.length === 0) continue;
    out.push({
      hrId: member.hrId,
      lineCode: member.seat.lineCode,
      lineName: member.seat.lineName,
      seatIds,
      title: seatTierTitle(member.seat.tier),
    });
  }
  return out;
}

export async function loadReportScope(viewer: PhoenixCrmViewer): Promise<ReportScopeView> {
  const seats = viewer.scopeTerritories;
  const managerEntries = reportScopeManagers(viewer);
  const names = await loadPeopleNames([...seats.map((seat) => seat.occupantHrId), ...managerEntries.map((entry) => entry.hrId)]);
  const lines = new Map<string, string>();
  for (const seat of seats) {
    if (seat.lineCode) lines.set(seat.lineCode, seat.lineName ?? seat.lineCode);
  }
  return {
    cairoToday: viewer.cairoToday,
    canIncludeTest: false,
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
    managers: managerEntries
      .map((entry) => ({ ...entry, name: nameOf(names, entry.hrId, "Unnamed manager") }))
      .sort((left, right) => (left.lineName ?? "").localeCompare(right.lineName ?? "") || left.name.localeCompare(right.name)),
    // A product manager has one "manager" to show on that report and it is HIMSELF — the visits he
    // rode (`readsOwnRideAlongs`, owner 2026-10-07). Without this the chip is hidden and the tab
    // falls back to the one report he had before.
    hasManagers: managersInScope(viewer.org, viewer.hrId, viewer.basis).length > 0 || readsOwnRideAlongs(viewer),
    canSeeLocations: canReadLocationReport(viewer),
    // The team's gate first: a product manager who also read team reports would read them as a manager.
    audience: !readsTeamReports(viewer) && readsFieldHeardByProduct(viewer) ? "products" : "field",
    answersVisitAsks: !readsTeamReports(viewer) && isVisitAskAskableRole(viewer.role),
  };
}

// ── Visits per rep per day ──────────────────────────────────────────────────────────────────────

export type RepVisitRow = RepVisitGroup & {
  key: string;
  territoryName: string;
  lineName: string | null;
  /** The rep's name; for visits no rep was on, the manager's name with "(own visits)", or "Managers' own visits" when none is recorded. */
  repName: string;
};

export type VisitsReportView = {
  period: ReportPeriod;
  includeTest: boolean;
  rows: RepVisitRow[];
  totals: ByList<VisitCounts>;
  /** C3: null when the viewer did not ask, or may not (manager-only in v1). Headline figure: visits. */
  comparison: ReportComparison | null;
};

/** The visits RPC reduced to the one count a comparison reads: visits, AM and PM apart. */
async function visitFigures(
  seatIds: ReadonlyArray<string>,
  period: ReportPeriod,
  includeTest: boolean,
): Promise<ComparisonFigures> {
  if (seatIds.length === 0) return { bySeat: new Map(), totals: { AM: 0, PM: 0 } };
  const data = await callPhoenixCrm<unknown>("phoenix_crm_report_visits_by_day", {
    p_seat_ids: [...seatIds],
    p_from: period.from,
    p_to: period.to,
    p_include_test: includeTest,
  });
  const wanted = new Set(seatIds);
  const { groups, totals } = groupVisitsByRep(asRows(data).filter((row) => wanted.has(String(row.seat_id))));
  const bySeat = new Map<string, { am: number; pm: number }>();
  for (const group of groups) {
    const current = bySeat.get(group.seatId) ?? { am: 0, pm: 0 };
    // A territory can hold two groups — the rep's own visits and the managers' — and the comparison
    // is about the TERRITORY, so they add rather than one overwriting the other.
    bySeat.set(group.seatId, { am: current.am + group.am.visits, pm: current.pm + group.pm.visits });
  }
  return { bySeat, totals: { AM: totals.AM.visits, PM: totals.PM.visits } };
}

export async function loadVisitsReport(viewer: PhoenixCrmViewer, raw: ReportFilterInput): Promise<VisitsReportView> {
  const chosen = chooseTerritories(viewer, raw);
  const period = periodOf(viewer, raw);
  if (chosen.seats.length === 0) {
    return blindVisitsReport(
      viewer,
      { period, includeTest: chosen.includeTest, rows: [], totals: { AM: emptyVisitCounts(), PM: emptyVisitCounts() }, comparison: null },
      chosen.seats,
    );
  }

  const mode = comparisonModeOf(viewer, raw);
  const previous = previousPeriod(period);
  const peers = peerTerritories(viewer);
  const [data, baseline] = await Promise.all([
    callPhoenixCrm<unknown>("phoenix_crm_report_visits_by_day", {
      p_seat_ids: chosen.seats.map((seat) => seat.seatId),
      p_from: period.from,
      p_to: period.to,
      p_include_test: chosen.includeTest,
    }),
    mode === null
      ? Promise.resolve(null)
      : mode === "previous"
        ? visitFigures(chosen.seats.map((seat) => seat.seatId), previous, chosen.includeTest)
        : visitFigures(peers.map((seat) => seat.seatId), period, chosen.includeTest),
  ]);
  const seatsById = new Map(chosen.seats.map((seat) => [seat.seatId, seat]));
  const { groups, totals } = groupVisitsByRep(asRows(data).filter((row) => seatsById.has(String(row.seat_id))));
  const names = await loadPeopleNames(groups.map((group) => group.repHrId ?? group.managerHrId));
  const rows = groups
    .map((group) => {
      const seat = seatsById.get(group.seatId) as OrgSeat;
      return {
        ...group,
        key: `${group.seatId}|${group.repHrId ?? "managers"}|${group.managerHrId ?? ""}`,
        territoryName: territoryName(seat),
        lineName: seat.lineName,
        repName: group.repHrId
          ? nameOf(names, group.repHrId)
          : group.managerHrId
            ? `${nameOf(names, group.managerHrId)} (own visits)`
            : "Managers' own visits",
      };
    })
    .sort(
      (left, right) =>
        byTerritoryName(left, right) ||
        Number(left.repHrId === null) - Number(right.repHrId === null) ||
        left.repName.localeCompare(right.repName),
    );

  const nowFigures: ComparisonFigures = {
    bySeat: groups.reduce((map, group) => {
      const current = map.get(group.seatId) ?? { am: 0, pm: 0 };
      map.set(group.seatId, { am: current.am + group.am.visits, pm: current.pm + group.pm.visits });
      return map;
    }, new Map<string, { am: number; pm: number }>()),
    totals: { AM: totals.AM.visits, PM: totals.PM.visits },
  };

  // 🔴 THROUGH THE BLIND SHAPER, LAST (Golden Rule #1, audit 2026-10-02). The tab is open to a rep on
  // his own seat and only the screen hid his far-visit count; the field itself left the server.
  return blindVisitsReport(viewer, {
    period,
    includeTest: chosen.includeTest,
    rows,
    totals,
    comparison:
      mode === null || baseline === null
        ? null
        : buildComparison({
            baseline,
            baselinePeriod: mode === "previous" ? previous : null,
            mode,
            now: nowFigures,
            peerTerritoryCount: mode === "peers" ? peers.length : null,
            seatIds: chosen.seats.map((seat) => seat.seatId),
          }),
  }, chosen.seats);
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
  /**
   * The day activity the rep recorded, by date — "Meeting · half day" — printed BESIDE that day's
   * misses (owner, 2026-10-01: "show it beside the miss"). Shown, never counted: a customer missed on
   * a meeting day is still missed, as the day-activities ruling of 2026-09-26 has it.
   */
  activities: Record<string, string>;
};

export type PlanReportView = {
  period: ReportPeriod;
  includeTest: boolean;
  /** Today, when the period reaches it: its planned customers can still be visited, so "missed" is not final. */
  runningDay: string | null;
  rows: TerritoryPlanRow[];
  totals: ByList<PlanCell>;
  /** C3. Headline figure: planned calls KEPT — a count, not the kept percentage. */
  comparison: ReportComparison | null;
  /**
   * HR's leave could not be read, so a day the rep was on leave may read as missed. The figures stay —
   * the screen says this beside them (`plan-leave.ts`, `server/leave-days.ts`).
   */
  leaveUnread: boolean;
};

function planCell(counts: PlanCounts): PlanCell {
  return { ...counts, keptPct: planKeptPercent(counts) };
}

/**
 * The plan RPC reduced to the one count a comparison reads: planned calls KEPT.
 *
 * Kept, not the kept PERCENTAGE: the difference between two percentages is percentage points, and a
 * cell reading "68% (vs 61% · +11.5%)" has three numbers in it of which one is a lie.
 *
 * It reads no leave, and needs none: leave moves a customer he did NOT see from missed to on leave,
 * and a kept call is one he did see, so the count compared here is the same either way.
 */
async function planFigures(
  seatIds: ReadonlyArray<string>,
  period: ReportPeriod,
  includeTest: boolean,
): Promise<ComparisonFigures> {
  if (seatIds.length === 0) return { bySeat: new Map(), totals: { AM: 0, PM: 0 } };
  const data = await callPhoenixCrm<unknown>("phoenix_crm_report_plan_vs_actual", {
    p_seat_ids: [...seatIds],
    p_from: period.from,
    p_to: period.to,
    p_include_test: includeTest,
  });
  const wanted = new Set(seatIds);
  const { groups, totals } = groupPlanByTerritory(asRows(data).filter((row) => wanted.has(String(row.seat_id))));
  return {
    bySeat: new Map(groups.map((group) => [group.seatId, { am: group.am.visitedPlanned, pm: group.pm.visitedPlanned }])),
    totals: { AM: totals.AM.visitedPlanned, PM: totals.PM.visitedPlanned },
  };
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
      comparison: null,
      leaveUnread: false,
    };
  }

  const mode = comparisonModeOf(viewer, raw);
  const previous = previousPeriod(period);
  const peers = peerTerritories(viewer);
  const [data, baseline, leave, dayActivities, names] = await Promise.all([
    callPhoenixCrm<unknown>("phoenix_crm_report_plan_vs_actual", {
      p_seat_ids: chosen.seats.map((seat) => seat.seatId),
      p_from: period.from,
      p_to: period.to,
      p_include_test: chosen.includeTest,
    }),
    mode === null
      ? Promise.resolve(null)
      : mode === "previous"
        ? planFigures(chosen.seats.map((seat) => seat.seatId), previous, chosen.includeTest)
        : planFigures(peers.map((seat) => seat.seatId), period, chosen.includeTest),
    // 🔴 A day HR approved his leave is never a day of misses (owner, 2026-10-01) — `plan-leave.ts`.
    loadSeatLeaveDays(chosen.seats, period),
    // The day's recorded activity, printed beside its misses and never moving a figure.
    loadSeatDayActivities(
      chosen.seats.map((seat) => seat.seatId),
      chosen.includeTest,
      period,
    ),
    // Every chosen territory's rep, read beside the figures rather than after them: a row is only
    // ever one of these territories, so the rows' names are a subset of this answer.
    loadPeopleNames(chosen.seats.map((seat) => seat.occupantHrId)),
  ]);
  const seatsById = new Map(chosen.seats.map((seat) => [seat.seatId, seat]));
  const { groups, totals } = groupPlanByTerritory(
    asRows(data).filter((row) => seatsById.has(String(row.seat_id))),
    leave.days,
  );
  const activitiesBySeat = new Map<string, Record<string, string>>();
  for (const [key, activity] of dayActivities) {
    const seatId = key.slice(0, key.lastIndexOf("|"));
    const held = activitiesBySeat.get(seatId) ?? {};
    // A day the rep missed recording, entered for him by the Super Admin, says so here as everywhere.
    held[activity.activityDate.slice(0, 10)] = `${dailyPlanActivityText({
      activityType: activity.activityType,
      label: activity.activityLabel,
      halfDay: activity.halfDay,
      note: activity.note,
    })}${activity.enteredByAdmin ? ` · ${MISSED_RECORD_MARK}` : ""}`;
    activitiesBySeat.set(seatId, held);
  }
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
        activities: activitiesBySeat.get(group.seatId) ?? {},
      };
    })
    .sort(byTerritoryName);
  return {
    period,
    includeTest: chosen.includeTest,
    runningDay,
    rows,
    totals: { AM: planCell(totals.AM), PM: planCell(totals.PM) },
    comparison:
      mode === null || baseline === null
        ? null
        : buildComparison({
            baseline,
            baselinePeriod: mode === "previous" ? previous : null,
            mode,
            now: {
              bySeat: new Map(groups.map((group) => [group.seatId, { am: group.am.visitedPlanned, pm: group.pm.visitedPlanned }])),
              totals: { AM: totals.AM.visitedPlanned, PM: totals.PM.visitedPlanned },
            },
            peerTerritoryCount: mode === "peers" ? peers.length : null,
            seatIds: chosen.seats.map((seat) => seat.seatId),
          }),
    leaveUnread: leave.unread,
  };
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
  /** C3. Headline figure: customers COVERED — a count, not the coverage percentage. */
  comparison: ReportComparison | null;
};

/**
 * The coverage RPC reduced to the one count a comparison reads: customers covered.
 *
 * Coverage is measured over a MONTH, not a period, so `previous` here is the previous calendar month
 * — a whole one against a whole one. The month on screen is usually still running, so an early
 * comparison is a part-month against a full one and reads as a collapse; the screen says which month
 * the baseline is, and that is the honest fix rather than scaling a part-month up to look complete.
 */
async function coverageFigures(
  seatIds: ReadonlyArray<string>,
  monthStart: string,
  includeTest: boolean,
): Promise<ComparisonFigures> {
  if (seatIds.length === 0) return { bySeat: new Map(), totals: { AM: 0, PM: 0 } };
  const data = await callPhoenixCrm<unknown>("phoenix_crm_report_coverage", {
    p_seat_ids: [...seatIds],
    p_month_start: monthStart,
    p_include_test: includeTest,
  });
  const wanted = new Set(seatIds);
  const { groups, totals } = groupCoverageByTerritory(asRows(data).filter((row) => wanted.has(String(row.seat_id))));
  return {
    bySeat: new Map(groups.map((group) => [group.seatId, { am: group.am.covered, pm: group.pm.covered }])),
    totals: { AM: totals.AM.covered, PM: totals.PM.covered },
  };
}

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
      comparison: null,
    };
  }

  const mode = comparisonModeOf(viewer, raw);
  const previousMonthStart = addDaysIso(month.monthStart, -1).slice(0, 7) + "-01";
  const peers = peerTerritories(viewer);
  const [data, baseline, names] = await Promise.all([
    callPhoenixCrm<unknown>("phoenix_crm_report_coverage", {
      p_seat_ids: chosen.seats.map((seat) => seat.seatId),
      p_month_start: month.monthStart,
      p_include_test: chosen.includeTest,
    }),
    mode === null
      ? Promise.resolve(null)
      : mode === "previous"
        ? coverageFigures(chosen.seats.map((seat) => seat.seatId), previousMonthStart, chosen.includeTest)
        : coverageFigures(peers.map((seat) => seat.seatId), month.monthStart, chosen.includeTest),
    loadPeopleNames(chosen.seats.map((seat) => seat.occupantHrId)),
  ]);
  const chosenIds = new Set(chosen.seats.map((seat) => seat.seatId));
  const { groups, totals } = groupCoverageByTerritory(asRows(data).filter((row) => chosenIds.has(String(row.seat_id))));
  const bySeat = new Map(groups.map((group) => [group.seatId, group]));
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
  return {
    month,
    includeTest: chosen.includeTest,
    rows,
    totals: { AM: coverageCell(totals.AM), PM: coverageCell(totals.PM) },
    comparison:
      mode === null || baseline === null
        ? null
        : buildComparison({
            baseline,
            // Coverage is a MONTH, so its "previous" is the month before, stated as its own days.
            baselinePeriod: mode === "previous" ? { from: previousMonthStart, to: monthEndOf(previousMonthStart) } : null,
            mode,
            now: {
              bySeat: new Map(groups.map((group) => [group.seatId, { am: group.am.covered, pm: group.pm.covered }])),
              totals: { AM: totals.AM.covered, PM: totals.PM.covered },
            },
            peerTerritoryCount: mode === "peers" ? peers.length : null,
            seatIds: chosen.seats.map((seat) => seat.seatId),
          }),
  };
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
  /**
   * True when the one row is the VIEWER'S OWN and the report is about nobody else — a product or
   * marketing manager reading the visits he himself rode (`readsOwnRideAlongs`). The screen says
   * "You went out" rather than counting managers, and offers no search across a team that is not
   * there.
   */
  own: boolean;
};

/**
 * 🔴 THE VISITS A PRODUCT MANAGER RODE, AND HIS ALONE (owner, 2026-10-07 — the visits Nada Abdullah
 * filed with Ahmed SharafEldeen "are not appearing in his data").
 *
 * He holds no seat in the sales organogram, so `managersInScope` can never name him and
 * `chooseTerritories` gives him nothing: the manager branch above would return an empty report
 * forever. So his own hr id is the whole `p_hr_ids`, and the territories are every open line's — the
 * same reach the field-heard report already gives him, because a product manager rides company-wide
 * and a line filter would hide a visit he was personally on.
 *
 * His title is his APP ROLE, not a seat tier: `seatTierTitle` reads a seat he does not have.
 */
async function loadOwnRideAlongReport(viewer: PhoenixCrmViewer, raw: ReportFilterInput): Promise<ManagerReportView> {
  const period = periodOf(viewer, raw);
  const includeTest = reportIncludesTest(viewer, raw.includeTest);
  const seats = viewer.org.territories.filter((seat) => Boolean(seat.lineCode && viewer.openLines.has(seat.lineCode)));
  const data = await callPhoenixCrm<unknown>("phoenix_crm_report_manager_visits", {
    p_hr_ids: [viewer.hrId],
    p_from: period.from,
    p_to: period.to,
    p_include_test: includeTest,
  });
  const seatsById = new Map(seats.map((seat) => [seat.seatId, seat]));
  const grouped = groupManagerVisits(asRows(data).filter((row) => seatsById.has(String(row.seat_id))));
  // The function UPPERCASES the ids it was given, so a differently-spelled hr id would key the map
  // under a name this lookup does not use. Exactly one person was asked for, so the first group IS
  // his — the fallback is what keeps a casing difference from reading as "you rode nothing".
  const found = grouped.get(viewer.hrId) ?? [...grouped.values()][0];
  const repIds = (found?.entries ?? []).map((entry) => entry.repHrId);
  const names = await loadPeopleNames([viewer.hrId, ...repIds]);
  const row: ManagerReportRow = {
    ...(found?.summary ?? emptyManagerSummary()),
    hrId: viewer.hrId,
    name: nameOf(names, viewer.hrId),
    title: viewer.role,
    lineName: null,
    entries: (found?.entries ?? []).map((entry) => {
      const seat = seatsById.get(entry.seatId) as OrgSeat;
      return { ...entry, territoryName: territoryName(seat), repName: entry.repHrId ? nameOf(names, entry.repHrId) : null };
    }),
  };
  return { period, includeTest, own: true, rows: [row] };
}

export async function loadManagerReport(viewer: PhoenixCrmViewer, raw: ReportFilterInput): Promise<ManagerReportView> {
  // The team's gate first, so a product manager who also held a manager seat reads the full board.
  if (readsOwnRideAlongs(viewer)) return loadOwnRideAlongReport(viewer, raw);
  const chosen = chooseTerritories(viewer, raw);
  const period = periodOf(viewer, raw);
  // A manager above a chosen territory through any seat they hold (a person on two seats is listed once). With the
  // "Manager" filter set, the chosen manager and the managers under him — never the ones above him, whose rows would
  // only repeat his team's visits (owner, 2026-10-20).
  const chosenManager = personKey(trimmed(raw.managerHrId));
  const underChosen = chosenManager ? new Set(managersInScope(viewer.org, chosenManager, "tree").map((member) => member.hrId)) : null;
  const managers = managersInScope(viewer.org, viewer.hrId, viewer.basis).filter((member) => {
    if (underChosen && !underChosen.has(member.hrId)) return false;
    const held = new Set(heldManagerSeats(viewer.org, member.hrId).map((seat) => seat.seatId));
    return chosen.seats.some((territory) => territory.path.some((seatId) => seatId !== territory.seatId && held.has(seatId)));
  });
  // The lines' product managers, for a viewer who reads the company or a national sales manager
  // (`loadScopeProductManagers`): they hold no seat, so `managersInScope` never named them and the visits they rode
  // stood on no row of this board (owner, 2026-10-20: "EVERYSINGLE ROLE THATS APLLICABLE TOAPPEAR"). Not with the
  // "Manager" filter set: that names a seat holder, and a product manager is under nobody's seat.
  const seatHolders = new Set(managers.map((member) => member.hrId));
  const productManagers = chosenManager
    ? []
    : (await loadScopeProductManagers(viewer, chosen.seats)).filter((manager) => !seatHolders.has(manager.hrId));
  if (managers.length === 0 && productManagers.length === 0) return { period, includeTest: chosen.includeTest, own: false, rows: [] };

  const data = await callPhoenixCrm<unknown>("phoenix_crm_report_manager_visits", {
    p_hr_ids: [...managers.map((member) => member.hrId), ...productManagers.map((manager) => manager.hrId)],
    p_from: period.from,
    p_to: period.to,
    p_include_test: chosen.includeTest,
  });
  // Never wider than the viewer: a visit in a territory outside the chosen ones is left out.
  const seatsById = new Map(chosen.seats.map((seat) => [seat.seatId, seat]));
  const grouped = groupManagerVisits(asRows(data).filter((row) => seatsById.has(String(row.seat_id))));
  const repIds = [...grouped.values()].flatMap((found) => found.entries.map((entry) => entry.repHrId));
  const names = await loadPeopleNames([...managers.map((member) => member.hrId), ...productManagers.map((manager) => manager.hrId), ...repIds]);
  const entriesOf = (hrId: string) =>
    (grouped.get(hrId)?.entries ?? []).map((entry) => {
      const seat = seatsById.get(entry.seatId) as OrgSeat;
      return { ...entry, territoryName: territoryName(seat), repName: entry.repHrId ? nameOf(names, entry.repHrId) : null };
    });

  const rows = [
    ...managers.map((member) => ({
      ...(grouped.get(member.hrId)?.summary ?? emptyManagerSummary()),
      hrId: member.hrId,
      name: nameOf(names, member.hrId),
      title: seatTierTitle(member.seat.tier),
      lineName: member.seat.lineName,
      entries: entriesOf(member.hrId),
    })),
    // His title is his APP ROLE and his line every line he is named on — he holds no seat to read either from.
    ...productManagers.map((manager) => ({
      ...(grouped.get(manager.hrId)?.summary ?? emptyManagerSummary()),
      hrId: manager.hrId,
      name: nameOf(names, manager.hrId),
      title: manager.role,
      lineName: manager.lineNames.join(" + ") || null,
      entries: entriesOf(manager.hrId),
    })),
  ]
    .sort((left, right) => (left.lineName ?? "").localeCompare(right.lineName ?? "") || left.name.localeCompare(right.name));
  return { period, includeTest: chosen.includeTest, own: false, rows };
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
  listType: PhoenixCrmListType;
  /** Where the place is saved: its name, its address, and the geography resolved when it was captured. */
  placeLabel: string | null;
  placeAddress: string | null;
  placeWhere: string | null;
  placeLat: number | null;
  placeLon: number | null;
  /** Where he actually stood. */
  visitLat: number;
  visitLon: number;
  /**
   * How sure the phone was — the Super Admin's and the SFE Manager's alone (owner, 2026-10-02: the
   * district manager and the NSM see the distance only). ABSENT for them, never zero.
   */
  accuracyMeters?: number | null;
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
  /** `weakGps` is a verdict on the reading, so it is the Super Admin's and the SFE Manager's alone. */
  summary: { visits: number; far: number; weakGps?: number; noPlace: number; measured: number; farthestMeters: number | null };
};

/** At most this many rows travel to the phone; the summary is measured over every visit in the period. */
const LOCATION_ROW_CAP = 300;

export async function loadVisitLocationReport(viewer: PhoenixCrmViewer, raw: ReportFilterInput): Promise<VisitLocationReportView> {
  if (!canReadLocationReport(viewer)) throw forbiddenError("This report is for managers, SFE and the Super Admin.");
  const chosen = chooseTerritories(viewer, raw);
  // 🔴 NEVER HIS OWN SEAT (audit, 2026-10-02). An ACTING District Manager who still holds a rep seat
  // passes the gate above as a manager, and his own visits' distances were then on this report while
  // every visit screen blinded him on that seat. A seat he is blind on is a seat it does not measure.
  const seats = locationReportSeats(viewer, chosen.seats);
  const period = periodOf(viewer, raw);
  // 🔴 THE DISTANCE, AND THE READING BEHIND IT ONLY FOR THE SUPER ADMIN AND SFE (owner, 2026-10-02).
  // The district manager and the NSM read how far apart the two points are and whether that is far;
  // the accuracy, and the weak-signal verdict that is made from it, leave the server for nobody else.
  const detail = readsLocationDetail(viewer);
  const empty: VisitLocationReportView = {
    period,
    includeTest: chosen.includeTest,
    rows: [],
    total: 0,
    summary: { visits: 0, far: 0, ...(detail ? { weakGps: 0 } : {}), noPlace: 0, measured: 0, farthestMeters: null },
  };
  if (seats.length === 0) return empty;

  const columns =
    "id, seat_id, visit_date, captured_at, rep_hr_id, entered_by_hr_id, list_type, lat, lon, accuracy_meters, distance_meters, " +
    "location_flag, is_unplanned, is_test, " +
    "customer:phoenix_crm_customers!customer_id(name), " +
    "place:phoenix_crm_places!place_id(label, address, brick_name, area_name, region_name, lat, lon)";

  // 🔴 IT PAGES, AND UNTIL 2026-10-02 IT DID NOT — IT STOPPED DEAD AT 1,000 VISITS PER SEAT BATCH.
  // PostgREST caps every response at `db-max-rows` (supabase/config.toml: 1000) and says NOTHING
  // when it does, so a period holding more visits than that lost the rest in silence. Everything on
  // this report is computed over these rows — `total`, the far / weak-GPS / no-place counts, the
  // measured count and the farthest distance — so each one was a figure over a truncated set wearing
  // the shape of a complete one, and the row the manager most needs (the farthest) is exactly the
  // one a cut-off could drop. A keyset walk on `id`, the shape every other read in this module uses —
  // made over groups of territories four at a time (`readSeatGroups`), the same rows in the same order.
  const rows = await readSeatGroups(seats.map((seat) => seat.seatId), 200, (batch) =>
    fetchAllRowsKeyset<Row>(
      () => {
        const query = getSupabaseAdmin()
          .from("phoenix_crm_visits")
          .select(columns)
          .in("seat_id", batch)
          .gte("visit_date", period.from)
          .lte("visit_date", period.to)
          // Place against ACTUAL, and a visit the Super Admin entered for a rep who missed logging it
          // has no actual: nobody was at the door with a phone (owner, 2026-10-01). Its stand-in flag
          // would read "no place saved" and its missing reading would plot at 0°N 0°E, so it is not a
          // row here. Every visit that remains carries a reading — phoenix_crm_visits_location_source
          // holds it.
          .neq("capture_source", "admin")
          // Nor the pharmacy visit a doctor's visit filed beside itself (owner, 2026-10-03): nobody stood
          // at the pharmacy with a phone for it, so it has no place reading of its own to report.
          .is("linked_from_visit_id", null);
        return chosen.includeTest ? query : query.eq("is_test", false);
      },
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
  );

  const seatsById = new Map(seats.map((seat) => [seat.seatId, seat]));
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
      listType: parseListType(row.list_type),
      placeLabel: textOrNull(placeRow.label),
      placeAddress: textOrNull(placeRow.address),
      placeWhere: where || null,
      placeLat: numberOrNull(placeRow.lat),
      placeLon: numberOrNull(placeRow.lon),
      visitLat: Number(row.lat),
      visitLon: Number(row.lon),
      ...(detail ? { accuracyMeters: numberOrNull(row.accuracy_meters) } : {}),
      distanceMeters: distance,
      distanceText: distance === null ? "—" : formatDistance(distance),
      // A weak reading is never far (far beats weak, geo.ts), so to a distance-only reader it is a visit
      // at the place, read by its plain distance — never a word about the signal.
      locationFlag: !detail && flag === "weak_gps" ? "ok" : flag,
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
    summary: { visits: mapped.length, far, ...(detail ? { weakGps } : {}), noPlace, measured, farthestMeters: farthest },
  };
}

// ── Frequency per customer ──────────────────────────────────────────────────────────────────────

/**
 * How often each customer on ONE territory's list was actually seen this month, against his grade's
 * number and against how often he was planned — the two kept apart (owner, 2026-09-30, asked which
 * basis he wanted and choosing both). `customer-frequency.ts` holds the rule and the ordering.
 *
 * 🔴 ONE TERRITORY AT A TIME, AND IT SAYS SO RATHER THAN GUESSING. Coverage is per territory, so a
 * whole scope fits on one screen; this is per CUSTOMER, and a national manager's scope is thousands
 * of rows. A capped list would be a page that quietly stops being true, so with more than one
 * territory chosen it returns none and names what to pick.
 *
 * 🔴 THE SAME LIST COVERAGE COUNTS, resolved the same way as `phoenix_crm_report_coverage`: validated
 * customers, active or retired during this month. A different list here would put a different
 * denominator beside coverage on the same screen.
 */
export type CustomerFrequencyReportView = {
  month: ReportMonth;
  includeTest: boolean;
  /** Null until one territory is chosen — the sentence, not an empty table pretending to be an answer. */
  seat: { seatId: string; territoryName: string; repName: string | null } | null;
  /**
   * Phoenix CRM visits in this month that count in NOTHING yet, because the customer is not
   * validated. Printed as a sentence beside the table so a frequency of 0 on a team that has just
   * started reads as "the list is still being worked through" and not as a rep who did nothing.
   * It is never added to any row, any total or any percentage.
   */
  awaitingValidation: number;
  needsOneTerritory: boolean;
  rows: CustomerFrequencyRow[];
  totals: ReturnType<typeof customerFrequencyTotals>;
  /** HR's leave could not be read, so a planning on a leave day may count against the plan. */
  leaveUnread: boolean;
};

export async function loadCustomerFrequencyReport(
  viewer: PhoenixCrmViewer,
  raw: ReportFilterInput,
): Promise<CustomerFrequencyReportView> {
  const chosen = chooseTerritories(viewer, raw);
  const monthResult = resolveReportMonth({ month: raw.month, cairoToday: viewer.cairoToday });
  if (!monthResult.ok) throw validationError(monthResult.error);
  const month = monthResult.value;
  const empty = { customers: 0, noTarget: 0, onTarget: 0, over: 0, under: 0 };

  if (chosen.seats.length !== 1) {
    return {
      includeTest: chosen.includeTest,
      month,
      awaitingValidation: 0,
      needsOneTerritory: true,
      rows: [],
      seat: null,
      totals: empty,
      leaveUnread: false,
    };
  }

  const seat = chosen.seats[0] as OrgSeat;
  // The targets the viewer was already resolved with — no second read, and no chance of this page
  // scoring against a different copy of the settings than the rest of his session.
  const settings = viewer.config.settings;

  // Every read the page needs, started together rather than one after another. The three that matter
  // only when the list has customers are still started now — on a territory with a list, which is
  // every working one, they were going to be read anyway — and a listless territory never waits on
  // them: their failure is held (`startedEarly`) and surfaces only where it always did, when they are used.
  const visitDaysRead = startedEarly(visitDaysByCustomer(seat.seatId, chosen.includeTest, month));
  const planDaysRead = startedEarly(plannedDaysByCustomer(seat.seatId, chosen.includeTest, month));
  // 🔴 A planning on a day HR approved his leave is never a time he owed (owner, 2026-10-01).
  const leaveRead = startedEarly(loadSeatLeaveDays([seat], { from: month.monthStart, to: month.monthEnd }));
  const [names, listed] = await Promise.all([
    loadPeopleNames([seat.occupantHrId]),
    listedCustomers(seat.seatId, chosen.includeTest, month),
  ]);
  if (listed.length === 0) {
    return {
      includeTest: chosen.includeTest,
      month,
      awaitingValidation: 0,
      needsOneTerritory: false,
      rows: [],
      seat: { repName: seat.occupantHrId ? nameOf(names, seat.occupantHrId) : null, seatId: seat.seatId, territoryName: territoryName(seat) },
      totals: empty,
      leaveUnread: false,
    };
  }

  const [visitDays, planDaysByCustomer, leave] = await Promise.all([visitDaysRead, planDaysRead, leaveRead]);
  const daysByCustomer = visitDays.days;

  const rows = buildCustomerFrequencyReport(
    // Frequency is a KPI and a pharmacy is in none of them (owner, 2026-10-02), so the pharmacies on
    // the rep's list never reach this report — not at 0, not at any number.
    listed
      .filter((row) => doctorListType(row.list_type) !== null)
      .map((row): CustomerFrequencyInput => {
      const planned = plannedOutsideLeave({
        planDays: planDaysByCustomer.get(String(row.id)) ?? [],
        visitDays: daysByCustomer.get(String(row.id)) ?? [],
        isLeaveDay: (day) => isLeaveDay(leave.days, seat.seatId, day),
      });
      return {
        customerId: String(row.id),
        grade: (textOrNull(row.grade) as PhoenixCrmGrade | null) ?? null,
        listType: doctorListType(row.list_type) ?? "PM",
        name: textOrNull(row.name) ?? "Unnamed customer",
        planned: planned.planned,
        plannedOnLeave: planned.onLeave,
        visits: (daysByCustomer.get(String(row.id)) ?? []).length,
      };
    }),
    settings,
  );

  return {
    awaitingValidation: visitDays.awaitingValidation,
    includeTest: chosen.includeTest,
    month,
    needsOneTerritory: false,
    rows,
    seat: { repName: seat.occupantHrId ? nameOf(names, seat.occupantHrId) : null, seatId: seat.seatId, territoryName: territoryName(seat) },
    totals: customerFrequencyTotals(rows),
    leaveUnread: leave.unread,
  };
}

/**
 * The Cairo days each customer was visited in the month, REPEATS INCLUDED, earliest first.
 *
 * 🔴 ONE READER FOR BOTH REPORTS, AND THE REPEATS ARE WHY IT RETURNS DAYS RATHER THAN A COUNT.
 * Frequency counts VISITS, so two visits to one customer on one day are two; the tracking sheet
 * marks DAYS, so the same pair is one mark. Returning the list lets each report take what it
 * means — `buildTrackingSheet` de-duplicates — instead of two queries that could drift apart.
 *
 * 🔴 THE VIEW, NAMED IN FULL RIGHT HERE. Every KPI in this module reads
 * `phoenix_crm_countable_visits`, never the raw table — an off-plan visit that is not yet approved
 * counts in nothing. An earlier cut took the table as a PARAMETER, which reads as flexibility and
 * is really a way of hiding the name from every sweep that looks for who reads what.
 *
 * 🔴 AND `customer_validated = true`, WHICH IS CURRENTLY BELT AND BRACES AND STAYS ANYWAY. Owner,
 * 2026-10-01: a customer is planned and visited before validation, and counted only after it. Both
 * reports built from this map walk `listedCustomers`, which is already validated-only, so an
 * unvalidated customer's days are dropped at the join today — but that is a property of the CALLER,
 * one edit away from changing, and this is the read whose own name says what it counts.
 */
async function visitDaysByCustomer(
  seatId: string,
  includeTest: boolean,
  month: ReportMonth,
): Promise<{ days: Map<string, string[]>; awaitingValidation: number }> {
  const rows = await fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_countable_visits")
        .select("id, customer_id, visit_date, customer_validated")
        .eq("seat_id", seatId)
        .eq("is_test", includeTest)
        // NOT filtered here any more: a visit to a customer nobody has validated still counts in
        // nothing, but the row is read so the report can say how many are waiting rather than
        // showing a frequency of 0 with no reason for it (owner's pick, 2026-10-02).
        .gte("visit_date", month.monthStart)
        .lte("visit_date", month.monthEnd),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  const out = new Map<string, string[]>();
  let awaitingValidation = 0;
  for (const row of rows) {
    const id = textOrNull(row.customer_id);
    const day = textOrNull(row.visit_date)?.slice(0, 10);
    if (!id || !day) continue;
    if (row.customer_validated !== true) {
      awaitingValidation += 1;
      continue;
    }
    const held = out.get(id) ?? [];
    held.push(day);
    out.set(id, held);
  }
  for (const days of out.values()) days.sort();
  return { awaitingValidation, days: out };
}

/**
 * The days each customer was PLANNED this month — on a plan that was actually SENT. One entry per
 * planning, so the length is how often he was planned; the DAYS are what lets a planning on a day
 * HR approved the rep's leave be told apart (`plannedOutsideLeave`, `plan-leave.ts`).
 *
 * 🔴 A DRAFT IS NOT A PLAN. The rep owns his own draft until he submits it, so counting draft rows
 * would let the denominator move under a manager's feet while he reads the page — and it is the
 * same reasoning that makes an off-plan visit count only against a plan that reached `submitted`
 * before the visit (`unplanned-rules.ts`). A plan returned WHOLE is not counted either: it was sent
 * back. A plan returned for ONE day still counts on its other days, which stand as sent (owner,
 * 2026-10-02, "Still planned") — asked day by day through plan-rules.ts `isPlanDaySent`, the rule the
 * visit's own save follows.
 */
async function plannedDaysByCustomer(
  seatId: string,
  includeTest: boolean,
  month: ReportMonth,
): Promise<Map<string, string[]>> {
  const plans = await fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_plans")
        .select(`id, ${PLAN_DAY_COLUMNS}`)
        .eq("seat_id", seatId)
        .eq("is_test", includeTest)
        .in("status", [...PLAN_STATUSES_WITH_SENT_DAYS]),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  const out = new Map<string, string[]>();
  if (plans.length === 0) return out;
  // The day facts and the items are independent reads, so they run together; the item batches run
  // four at a time and are walked back in batch order, so each customer's days arrive as before.
  const [facts, itemBatches] = await Promise.all([
    loadPlanDayFacts(plans, includeTest),
    mapWithConcurrency(chunk(plans.map((plan) => String(plan.id)), 150), 4, (part) =>
      fetchAllRowsKeyset<Row>(
        () =>
          getSupabaseAdmin()
            .from("phoenix_crm_plan_items")
            .select("id, plan_id, customer_id, plan_date")
            .in("plan_id", part)
            .gte("plan_date", month.monthStart)
            .lte("plan_date", month.monthEnd),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      ),
    ),
  ]);

  for (const items of itemBatches) {
    for (const item of items) {
      const id = textOrNull(item.customer_id);
      const day = textOrNull(item.plan_date)?.slice(0, 10);
      const plan = facts.get(String(item.plan_id));
      if (id && day && plan && isPlanDaySent({ ...plan, date: day })) out.set(id, [...(out.get(id) ?? []), day]);
    }
  }
  return out;
}

/**
 * The list a month's report covers — validated, and active or retired DURING the month.
 *
 * Exactly what `phoenix_crm_report_coverage` resolves in SQL, and shared by the two per-customer
 * reports for that reason: a different list here would put a different denominator beside coverage
 * on the same screen. A customer is never counted before he is validated (`coverage.ts` says why),
 * and one dropped mid-month still belongs to the month he was worked in.
 */
async function listedCustomers(seatId: string, includeTest: boolean, month: ReportMonth): Promise<Row[]> {
  const rows = await fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_customers")
        .select("id, name, list_type, grade, status, status_changed_at")
        .eq("seat_id", seatId)
        .eq("is_test", includeTest)
        .not("validated_at", "is", null),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  return rows.filter((row) => {
    if (String(row.status) === "active") return true;
    // 🔴 THE CAIRO DAY OF THE CHANGE, NOT `slice(0, 10)` OF A `timestamptz`. PostgREST returns the
    // instant in UTC, so a customer dropped at 00:30 Cairo on the 1st reads "the 30th" — one day
    // earlier, in the PREVIOUS month — and this comparison then dropped him from the month he was
    // actually worked in, taking his visits out of frequency and his row off the tracking sheet.
    // Cairo is UTC+2/+3, so every drop in the first two or three hours of a month was wrong.
    const changed = textOrNull(row.status_changed_at);
    const changedOn = changed ? cairoDayOfInstant(changed) : null;
    return Boolean(changedOn && changedOn >= month.monthStart);
  });
}

// ── The tracking sheet ───────────────────────────────────────────────────────────

/**
 * Every customer down the side, every day of the month across the top, a mark where a visit landed.
 *
 * 🔴 THE SPACING NOTE IS FOR MANAGERS ONLY (Golden rule #1). "Seen on the 5th and the 9th, then not
 * again" is a judgement about how a rep worked his month, and anything that judges him is never
 * his. `readsTeamReports` decides it here and `buildTrackingSheet` gates it again inside — a helper
 * that returns the note and trusts the screen to hide it is one render from a rep's own phone.
 *
 * One territory at a time, for the same reason frequency is: this is per CUSTOMER, and a national
 * manager's scope is thousands of rows that no cap could honestly shorten.
 */
export type TrackingSheetReportView = {
  month: ReportMonth;
  includeTest: boolean;
  seat: { seatId: string; territoryName: string; repName: string | null } | null;
  needsOneTerritory: boolean;
  /** Every Cairo day of the month, so the grid's header needs no arithmetic of its own. */
  days: string[];
  rows: TrackingSheetRow[];
  /** Whether the spacing notes were computed at all. False for a rep reading his own sheet. */
  showsSpacing: boolean;
};

export async function loadTrackingSheetReport(
  viewer: PhoenixCrmViewer,
  raw: ReportFilterInput,
): Promise<TrackingSheetReportView> {
  const chosen = chooseTerritories(viewer, raw);
  const monthResult = resolveReportMonth({ month: raw.month, cairoToday: viewer.cairoToday });
  if (!monthResult.ok) throw validationError(monthResult.error);
  const month = monthResult.value;
  const days = monthDays(month.month);

  if (chosen.seats.length !== 1) {
    return { days, includeTest: chosen.includeTest, month, needsOneTerritory: true, rows: [], seat: null, showsSpacing: readsTeamReports(viewer) };
  }

  const seat = chosen.seats[0] as OrgSeat;
  // 🔴 PER SEAT, NOT PER VIEWER (audit, 2026-10-02): an ACTING District Manager reading his OWN rep
  // seat's sheet is that seat's rep, and the spacing note judges how its rep worked his month.
  const managerView = readsTeamReportsOn(viewer, seat);
  // The month's visits start beside the list rather than after it; a listless territory returns
  // without them, as it always did (`startedEarly` holds their failure until they are used).
  const visitDaysRead = startedEarly(visitDaysByCustomer(seat.seatId, chosen.includeTest, month));
  const [listed, names] = await Promise.all([
    listedCustomers(seat.seatId, chosen.includeTest, month),
    loadPeopleNames([seat.occupantHrId]),
  ]);
  const seatView = {
    repName: seat.occupantHrId ? nameOf(names, seat.occupantHrId) : null,
    seatId: seat.seatId,
    territoryName: territoryName(seat),
  };
  if (listed.length === 0) {
    return { days, includeTest: chosen.includeTest, month, needsOneTerritory: false, rows: [], seat: seatView, showsSpacing: managerView };
  }

  const daysByCustomer = (await visitDaysRead).days;
  // 🔴 THE SPACING NOTE MUST NOT JUDGE DAYS NOBODY HAS LIVED YET. It measures the tail since the
  // last visit against the longest gap, and it was handed `month.monthEnd` — so on the 3rd of a
  // month it read a 28-day tail and said "Seen on the 1st and the 2nd, then not again" about a
  // customer the rep saw yesterday. Every customer on a running month tripped it at once. The end
  // of the window is the earlier of the month's end and TODAY.
  const spacingThrough = month.monthEnd > viewer.cairoToday ? viewer.cairoToday : month.monthEnd;
  const rows = buildTrackingSheet(
    listed.map((row) => ({
      customerId: String(row.id),
      days: daysByCustomer.get(String(row.id)) ?? [],
      name: textOrNull(row.name) ?? "Unnamed customer",
    })),
    spacingThrough,
    { managerView },
  );

  return { days, includeTest: chosen.includeTest, month, needsOneTerritory: false, rows, seat: seatView, showsSpacing: managerView };
}
