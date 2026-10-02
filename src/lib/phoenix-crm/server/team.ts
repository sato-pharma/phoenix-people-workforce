/**
 * Phoenix CRM — the managers' Team view: each territory's list readiness and the list requests (a
 * grade, a drop, an add, a bring-back) waiting for a decision. (The week's plans to review come from
 * plans.ts loadPlanReviews.)
 *
 * Owner, 2026-09-16:
 *   - a new doctor's grade, a grade change and a drop need the district manager's approval; the system
 *     never decides;
 *   - weekly plans start once the list is ready (every reference customer validated, or dropped with
 *     the manager's approval), so a manager needs to see who is still validating.
 *
 * Owner, 2026-09-22 — that last rule is GONE: a rep plans and visits freely on a customer he has not
 * validated yet. Readiness is therefore progress through the carried-over list, not a gate. A manager
 * watches it to see how far each rep has got, and nothing in it waits on him — which is why the Team
 * tab shows it as information rather than as a warning or a default filter.
 *
 * Scope runs downward only. Readiness is measured on real entries; test mode (the Super Admin) lists
 * test requests only.
 *
 * Owner, 2026-09-30 ("the easiest CRM, yet controlled"): each territory also carries the rep's visit
 * day so far — his sent plan's progress AM and PM apart and what he logged — read for every territory
 * in three batched queries (loadTeamToday), never one per rep.
 */

import { logError } from "@/lib/observability/log";
import { fieldWeekStart } from "@/lib/phoenix-crm/calendar";
import { isPlanDaySent } from "@/lib/phoenix-crm/plan-rules";
import type { OrgSeat } from "@/lib/phoenix-crm/scope";
import {
  canDecideListRequest,
  canReviewTerritory,
  isLocationBlind,
  testModeFor,
  testReadSeats,
  type PhoenixCrmViewer,
} from "@/lib/phoenix-crm/server/access";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import { doubleVisitPlanReach, type DoubleVisitPlanReach } from "@/lib/phoenix-crm/server/double-visit-plans";
import { loadReadiness, loadRequestRows, mapRequestRow, requestPeople, type ListRequest, type SeatReadiness } from "@/lib/phoenix-crm/server/list";
import { loadMovedFromDays } from "@/lib/phoenix-crm/server/offplan-day";
import { loadPeopleNames } from "@/lib/phoenix-crm/server/people";
import { loadPlanDayFacts, PLAN_DAY_COLUMNS, PLAN_STATUSES_WITH_SENT_DAYS } from "@/lib/phoenix-crm/server/plan-day-status";
import { canDecidePlanEditRow, loadPlanEditRows, mapPlanEditRow, planEditPeople, type PlanEditRequestView } from "@/lib/phoenix-crm/server/plan-edits";
import { describeTerritory, territoryPeople, type TerritorySummary } from "@/lib/phoenix-crm/server/territory";
import {
  canDecideUnplannedRow,
  loadUnplannedRows,
  mapUnplannedRow,
  unplannedPeople,
  unplannedVisitRef,
  type UnplannedVisitView,
} from "@/lib/phoenix-crm/server/unplanned";
import { loadVisitAskSummary, type VisitAskSummary } from "@/lib/phoenix-crm/server/visit-asks";
import {
  emptyTeamToday,
  summarizeTeamToday,
  teamClockOf,
  type TeamTodayFigures,
  type TeamTodayPlanned,
  type TeamTodayVisit,
} from "@/lib/phoenix-crm/team-today";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type TeamTerritoryRow = {
  territory: TerritorySummary;
  /** Real entries only; null in test mode. */
  readiness: SeatReadiness | null;
  pendingRequests: number;
  /** The viewer decides this territory's requests and approves its plans. */
  canReview: boolean;
  /** The rep's visit day so far — his plan's progress AM and PM apart, and what he logged. */
  today: TeamTodayFigures & { lastVisitClock: string | null };
};

type Row = Record<string, unknown>;

/**
 * A bounded `in (...)` per query: an SFE Manager reads every territory in the company. Forty seats keep
 * each reply under PostgREST's 1,000-row cap even on a full day — at most 5 AM + 15 PM planned stops
 * a seat is 800 plan items, and a day's visits run to the same order.
 */
const SEAT_CHUNK = 40;

function chunks<T>(items: ReadonlyArray<T>, size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

function listTypeOf(value: unknown): PhoenixCrmListType {
  return value === "AM" ? "AM" : "PM";
}

function withClock(figures: TeamTodayFigures): TeamTodayFigures & { lastVisitClock: string | null } {
  return { ...figures, lastVisitClock: figures.lastVisitAt ? teamClockOf(figures.lastVisitAt) : null };
}

/**
 * Every territory's visit day in THREE batched reads, never one per rep: the week's sent plans, their
 * items for the day, and the day's visits. "Sent" is submitted or approved — the same test the rep's
 * own Today and Planned visit use, so a manager and his rep never read two different plans — asked of
 * THIS DAY (plan-rules.ts `isPlanDaySent`): a week returned for ONE other day still stands as sent on
 * this one (owner, 2026-10-02, "Still planned"), and only the returned day reads as not sent.
 */
async function loadTeamToday(seatIds: ReadonlyArray<string>, isTest: boolean, date: string): Promise<Map<string, TeamTodayFigures>> {
  const supabase = getSupabaseAdmin();
  const seatsWithPlan = new Set<string>();
  const planned: TeamTodayPlanned[] = [];
  const visits: TeamTodayVisit[] = [];
  for (const part of chunks(seatIds, SEAT_CHUNK)) {
    const [plans, dayVisits] = await Promise.all([
      supabase
        .from("phoenix_crm_plans")
        .select(`id, seat_id, ${PLAN_DAY_COLUMNS}`)
        .in("seat_id", part)
        .eq("is_test", isTest)
        .eq("week_start", fieldWeekStart(date))
        .in("status", [...PLAN_STATUSES_WITH_SENT_DAYS]),
      supabase
        .from("phoenix_crm_visits")
        .select("seat_id, customer_id, list_type, captured_at")
        .in("seat_id", part)
        .eq("is_test", isTest)
        .eq("visit_date", date),
    ]);
    throwIfError(plans.error);
    throwIfError(dayVisits.error);
    const planRows = (plans.data ?? []) as Row[];
    const facts = await loadPlanDayFacts(planRows, isTest);
    const seatByPlan = new Map<string, string>();
    for (const row of planRows) {
      const plan = facts.get(String(row.id));
      if (!plan || !isPlanDaySent({ ...plan, date })) continue;
      seatByPlan.set(String(row.id), String(row.seat_id));
      seatsWithPlan.add(String(row.seat_id));
    }
    if (seatByPlan.size > 0) {
      const items = await supabase
        .from("phoenix_crm_plan_items")
        .select("plan_id, customer_id, list_type")
        .in("plan_id", [...seatByPlan.keys()])
        .eq("plan_date", date);
      throwIfError(items.error);
      for (const row of (items.data ?? []) as Row[]) {
        const seatId = seatByPlan.get(String(row.plan_id));
        if (seatId) planned.push({ seatId, customerId: String(row.customer_id), listType: listTypeOf(row.list_type) });
      }
    }
    for (const row of (dayVisits.data ?? []) as Row[]) {
      visits.push({ seatId: String(row.seat_id), customerId: String(row.customer_id), listType: listTypeOf(row.list_type), capturedAt: String(row.captured_at) });
    }
  }
  return summarizeTeamToday({ seatIds, seatsWithPlan, planned, visits });
}

export type TeamRequest = ListRequest & { seatId: string; territoryName: string; canDecide: boolean };

export type TeamUnplannedVisit = UnplannedVisitView & {
  territoryName: string;
  canDecide: boolean;
  /**
   * The other days of the visit's field week its customer stood on the rep's SENT plan, as the plan
   * stood when he logged the visit (owner, 2026-10-02: "the approver sees the original day"). Read by
   * the server from the plan itself (server/offplan-day.ts), never from what the rep wrote; empty when
   * the visit was not moved from a day.
   */
  plannedFor: string[];
};

/** A rep's request to edit a sent week (owner, 2026-10-01), with whether THIS viewer acts at its step. */
export type TeamPlanEdit = PlanEditRequestView & { territoryName: string; canDecide: boolean };

export type TeamView = {
  isTest: boolean;
  /**
   * The viewer's own HR id, so the screen can stop telling him what he already knows: a district
   * manager reviews every territory beneath him, and "Reviewed by <his own name>" on every row was
   * his own name five times over on a five-territory team (owner, 2026-10-02).
   */
  viewerHrId: string;
  territories: TeamTerritoryRow[];
  /** Waiting requests, the longest-waiting first. */
  requests: TeamRequest[];
  /**
   * Off-plan visits waiting for a decision, the longest-waiting first. They ride in this payload
   * rather than in a fetch of their own, so one decision refreshes the whole tab exactly as a grade
   * or drop decision already does. The screen shows them as one card per rep per visit day
   * (owner, 2026-10-02 — offplan-day.ts `splitOffPlanDays`); each visit is still decided on its own.
   */
  unplannedVisits: TeamUnplannedVisit[];
  /**
   * Requests to edit a sent week waiting on a step, the longest-waiting first: the district manager's,
   * then SFE's, then HR's acknowledgement (owner, 2026-10-01). In this payload for the same reason the
   * off-plan visits are — one decision refreshes the whole tab.
   */
  planEdits: TeamPlanEdit[];
  /**
   * The district manager's double-visit plan (owner, 2026-10-02): whose plans this viewer reads —
   * his own as the district manager, or any district manager's as SFE or the Super Admin — and
   * whether he writes them. Null for everyone the plan's route refuses (a regional or national
   * manager, the CEO), so the section is never offered to them. The rep never sees it.
   */
  doubleVisits: DoubleVisitPlanReach | null;
  /**
   * A rep's asks for a visit with somebody (owner, 2026-10-02): how this viewer reads them — the ones
   * asked of him or told to him, or every one in scope for SFE and the Super Admin — whether he has any
   * to read, and how many wait for his answer. Null for everyone the asks never reach (a CEO). They are
   * drawn in the Double visits section, apart from the district manager's own plan.
   */
  visitAsks: VisitAskSummary | null;
  summary: {
    territories: number;
    vacant: number;
    ready: number;
    notReady: number;
    requestsWaiting: number;
    /** Requests this viewer decides. */
    waitingForYou: number;
    unplannedWaiting: number;
    /** Off-plan visits at a step this viewer decides — the manager's, or the SFE's. */
    unplannedWaitingForYou: number;
    planEditsWaiting: number;
    /** Requests to edit a week at a step this viewer takes — the manager's, SFE's, or HR's. */
    planEditsWaitingForYou: number;
    /** Visit asks waiting for this viewer's answer. */
    visitAsksWaitingForYou: number;
  };
};

/**
 * The asks' figures for the Team tab, or null when they cannot be read — the tab still opens, and the
 * section reads the asks itself.
 */
async function visitAskSummaryOrNull(viewer: PhoenixCrmViewer, isTest: boolean): Promise<VisitAskSummary | null> {
  try {
    return await loadVisitAskSummary(viewer, isTest);
  } catch (error) {
    logError("Phoenix CRM could not read the visit asks for the Team tab", {
      error,
      labels: { event: "phoenix_crm_visit_ask_team_failed" },
    });
    return null;
  }
}

export async function loadTeamView(viewer: PhoenixCrmViewer, raw: { test: unknown }): Promise<TeamView> {
  const isTest = testModeFor(viewer, raw.test);
  const seats: OrgSeat[] = testReadSeats(viewer, isTest, viewer.scopeTerritories);
  const seatIds = seats.map((seat) => seat.seatId);

  const [readiness, requestRows, unplannedRows, planEditRows, todayBySeat, visitAsks] = await Promise.all([
    isTest || seatIds.length === 0 ? Promise.resolve(new Map<string, SeatReadiness>()) : loadReadiness(seatIds),
    seatIds.length === 0 ? Promise.resolve([]) : loadRequestRows(seatIds, isTest, { pendingOnly: true }),
    loadUnplannedRows(seatIds, isTest),
    loadPlanEditRows(seatIds, isTest, viewer.cairoToday),
    // The VISIT day (until 02:00 the day that just ended), the same day the rep's own Today shows.
    seatIds.length === 0 ? Promise.resolve(new Map<string, TeamTodayFigures>()) : loadTeamToday(seatIds, isTest, viewer.visitDay),
    visitAskSummaryOrNull(viewer, isTest),
  ]);

  const pendingBySeat = new Map<string, number>();
  for (const row of requestRows) {
    const seatId = String(row.seat_id);
    pendingBySeat.set(seatId, (pendingBySeat.get(seatId) ?? 0) + 1);
  }
  // Test mode shows only the territories the Super Admin has tried; real mode shows every territory in
  // scope. A territory whose only waiting item is an off-plan visit — or only a day being worked —
  // still belongs in the test list.
  const unplannedSeats = new Set([...unplannedRows, ...planEditRows].map((row) => String(row.seat_id)));
  const workedToday = (seatId: string) => {
    const figures = todayBySeat.get(seatId);
    return Boolean(figures && (figures.planSent || figures.amLogged > 0 || figures.pmLogged > 0));
  };
  const rowSeats = isTest
    ? seats.filter((seat) => pendingBySeat.has(seat.seatId) || unplannedSeats.has(seat.seatId) || workedToday(seat.seatId))
    : seats;
  // The day each waiting off-plan visit was moved from rides beside the names: it needs only the rows.
  const [names, movedFrom] = await Promise.all([
    loadPeopleNames([
      ...territoryPeople(viewer.org, rowSeats),
      ...requestPeople(requestRows),
      ...unplannedPeople(unplannedRows),
      ...planEditPeople(planEditRows),
    ]),
    loadMovedFromDays(unplannedRows.map(unplannedVisitRef), isTest),
  ]);

  const summaries = new Map(rowSeats.map((seat) => [seat.seatId, describeTerritory(viewer.org, seat, names)]));
  const territories = rowSeats.map(
    (seat): TeamTerritoryRow => ({
      territory: summaries.get(seat.seatId) as TerritorySummary,
      // loadReadiness answers for every territory asked, or throws; nothing here reads a gap as ready.
      readiness: isTest ? null : (readiness.get(seat.seatId) as SeatReadiness),
      pendingRequests: pendingBySeat.get(seat.seatId) ?? 0,
      canReview: canReviewTerritory(viewer, seat, isTest),
      today: withClock(todayBySeat.get(seat.seatId) ?? emptyTeamToday()),
    }),
  );
  territories.sort(
    (left, right) =>
      Number(right.canReview && right.pendingRequests > 0) - Number(left.canReview && left.pendingRequests > 0) ||
      right.pendingRequests - left.pendingRequests ||
      Number(left.readiness?.ready ?? true) - Number(right.readiness?.ready ?? true) ||
      left.territory.name.localeCompare(right.territory.name),
  );

  const seatsById = new Map(seats.map((seat) => [seat.seatId, seat]));
  const requests = requestRows
    .map((row): TeamRequest => {
      const seatId = String(row.seat_id);
      const seat = seatsById.get(seatId) as OrgSeat;
      const request = mapRequestRow(row, names);
      return {
        ...request,
        seatId,
        territoryName: summaries.get(seatId)?.name ?? "Territory",
        // The step it is ON decides who may press the button (2026-09-29): a grade change and the
        // first step of a drop, an add or a bring-back are the territory's reviewer's; the second step
        // is the SFE Manager's. Everyone else in scope reads it and no more.
        canDecide: canDecideListRequest(viewer, seat, isTest, request.stage),
      };
    })
    .sort((left, right) => Number(right.canDecide) - Number(left.canDecide) || left.requestedAt.localeCompare(right.requestedAt));

  const unplannedVisits = unplannedRows
    .map((row): TeamUnplannedVisit => {
      const view = mapUnplannedRow(row, names);
      const seat = seatsById.get(view.seatId);
      return {
        ...view,
        // 🔴 Golden Rule #1. A rep's scope holds his OWN territory, so this endpoint answers him with his
        // own waiting off-plan visits — and the location flag is cleared before it leaves the server, not
        // merely left off his screen (found 2026-10-02: no rep screen showed it, the raw answer carried it).
        // A territory this view cannot place is treated as his, so it fails blind.
        locationFlag: !seat || isLocationBlind(viewer, seat) ? null : view.locationFlag,
        territoryName: summaries.get(view.seatId)?.name ?? "Territory",
        // The step it is ON decides who may press the button: the manager's step is the territory's
        // reviewer, the SFE's step is the SFE Manager. Everyone else in scope reads it and no more.
        canDecide: seat ? canDecideUnplannedRow(viewer, seat, isTest, view.status) : false,
        plannedFor: movedFrom.get(view.visitId) ?? [],
      };
    })
    .sort((left, right) => Number(right.canDecide) - Number(left.canDecide) || left.raisedAt.localeCompare(right.raisedAt));

  const planEdits = planEditRows
    .map((row): TeamPlanEdit => {
      const view = mapPlanEditRow(row, names);
      const seat = seatsById.get(view.seatId);
      return {
        ...view,
        territoryName: summaries.get(view.seatId)?.name ?? "Territory",
        // The step it is ON decides who may press the button: the district manager's, SFE's, or HR's.
        canDecide: seat ? canDecidePlanEditRow(viewer, seat, isTest, view.status) : false,
      };
    })
    .sort((left, right) => Number(right.canDecide) - Number(left.canDecide) || left.raisedAt.localeCompare(right.raisedAt));

  const realRows = territories.filter((row) => row.readiness);
  return {
    isTest,
    viewerHrId: viewer.hrId,
    territories,
    requests,
    unplannedVisits,
    planEdits,
    doubleVisits: doubleVisitPlanReach(viewer, isTest),
    visitAsks,
    summary: {
      territories: territories.length,
      vacant: territories.filter((row) => !row.territory.repHrId).length,
      ready: realRows.filter((row) => row.readiness?.ready).length,
      notReady: realRows.filter((row) => !row.readiness?.ready).length,
      requestsWaiting: requests.length,
      waitingForYou: requests.filter((request) => request.canDecide).length,
      unplannedWaiting: unplannedVisits.length,
      unplannedWaitingForYou: unplannedVisits.filter((visit) => visit.canDecide).length,
      planEditsWaiting: planEdits.length,
      planEditsWaitingForYou: planEdits.filter((edit) => edit.canDecide).length,
      visitAsksWaitingForYou: visitAsks?.waitingForYou ?? 0,
    },
  };
}
