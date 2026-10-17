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

import { loadVendorLeftoversBySeat } from "@/lib/crm/phoenix-vendor-leftovers";
import { logError } from "@/lib/observability/log";
import type { ReversibleItem } from "@/lib/phoenix-crm/administrator-reversal-rules";
import { fieldWeekStart } from "@/lib/phoenix-crm/calendar";
import { isPlanDaySent } from "@/lib/phoenix-crm/plan-rules";
import type { OrgSeat } from "@/lib/phoenix-crm/scope";
import {
  canOverrideDecision,
  canReviewTerritory,
  isLocationBlind,
  locationSight,
  testModeFor,
  testReadSeats,
  type PhoenixCrmViewer,
} from "@/lib/phoenix-crm/server/access";
import { loadReversibleItems } from "@/lib/phoenix-crm/server/administrator-reversals";
import { offPlanLocationFlag } from "@/lib/phoenix-crm/server/blind-payloads";
import { loadDayStartsBySeat } from "@/lib/phoenix-crm/server/day-start";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import { managerPlanReach } from "@/lib/phoenix-crm/server/manager-plan-reach";
import { loadReadiness, loadRequestRows, mapRequestRow, requestPeople, requestRights, type ListRequest, type SeatReadiness } from "@/lib/phoenix-crm/server/list";
import { loadOffPlanRows } from "@/lib/phoenix-crm/server/offplan-cap";
import { loadMovedFromDays } from "@/lib/phoenix-crm/server/offplan-day";
import {
  offPlanStandingKey,
  offPlanStandings,
  offPlanWeekWindow,
  type OffPlanCaps,
  type OffPlanStanding,
} from "@/lib/phoenix-crm/offplan-cap-rules";
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
import { doctorListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import {
  emptyTeamToday,
  summarizeTeamToday,
  teamClockOf,
  type TeamTodayFigures,
  type TeamTodayPlanned,
  type TeamTodayVisit,
} from "@/lib/phoenix-crm/team-today";
import { sortVendorLeftovers, type VendorLeftoverRep } from "@/lib/phoenix-crm/vendor-leftovers";
import type { PhoenixCrmDoctorListType } from "@/lib/phoenix-crm/types";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type TeamTerritoryRow = {
  territory: TerritorySummary;
  /** Real entries only; null in test mode. */
  readiness: SeatReadiness | null;
  pendingRequests: number;
  /** The viewer decides this territory's requests and approves its plans. */
  canReview: boolean;
  /**
   * The rep's visit day so far — when he said he started, his plan's progress AM and PM apart, and
   * what he logged. `startedClock` is null when he did not press it, which the line reads as nothing
   * rather than as a flag against him (owner, 2026-10-03; `team-today.ts`).
   */
  today: TeamTodayFigures & { lastVisitClock: string | null; startedClock: string | null };
  /**
   * Who on this territory is still recording his day in iReports360 since the team moved — work that
   * now lands in no figure at all. Empty on the rep's OWN row: it is his managers' to read, never his
   * (Golden Rule #1), and the server clears it rather than trusting a screen to leave it off.
   */
  stillOnVendor: VendorLeftoverRep[];
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

// Today's plan-against-actual for a manager. A pharmacy is never planned and is in no KPI, so a
// pharmacy row is not one of these counts at all.
function listTypeOf(value: unknown): PhoenixCrmDoctorListType | null {
  return doctorListType(value);
}

function withClock(
  figures: TeamTodayFigures,
  startedAt: string | null,
): TeamTodayFigures & { lastVisitClock: string | null; startedClock: string | null } {
  return {
    ...figures,
    lastVisitClock: figures.lastVisitAt ? teamClockOf(figures.lastVisitAt) : null,
    // Both clocks are the SERVER's time read in Cairo — the phone never states a zone, here or on the
    // day page.
    startedClock: startedAt ? teamClockOf(startedAt) : null,
  };
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
  // The batches run four at a time rather than one after another — an SFE Manager's whole company is
  // four batches of three steps each — and are folded back in batch order below, so the figures are
  // summed from the same rows in the same order as before.
  const parts = await mapWithConcurrency(chunks(seatIds, SEAT_CHUNK), 4, async (part) => {
    const seatsWithPlan: string[] = [];
    const planned: TeamTodayPlanned[] = [];
    const visits: TeamTodayVisit[] = [];
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
      seatsWithPlan.push(String(row.seat_id));
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
        const plannedListType = listTypeOf(row.list_type);
        if (seatId && plannedListType !== null) planned.push({ seatId, customerId: String(row.customer_id), listType: plannedListType });
      }
    }
    for (const row of (dayVisits.data ?? []) as Row[]) {
      const visitListType = listTypeOf(row.list_type);
      if (visitListType === null) continue;
      visits.push({ seatId: String(row.seat_id), customerId: String(row.customer_id), listType: visitListType, capturedAt: String(row.captured_at) });
    }
    return { seatsWithPlan, planned, visits };
  });

  const seatsWithPlan = new Set<string>();
  const planned: TeamTodayPlanned[] = [];
  const visits: TeamTodayVisit[] = [];
  for (const part of parts) {
    for (const seatId of part.seatsWithPlan) seatsWithPlan.add(seatId);
    planned.push(...part.planned);
    visits.push(...part.visits);
  }
  return summarizeTeamToday({ seatIds, seatsWithPlan, planned, visits });
}

/** The standing of a rep nobody counted anything for: nothing used, against the settings' own numbers. */
function emptyOffPlanStanding(caps: OffPlanCaps): OffPlanStanding {
  return { day: { used: 0, cap: caps.offPlanDailyCap }, week: { used: 0, cap: caps.offPlanWeeklyCap } };
}

/** One read for every waiting off-plan visit: the whole span of weeks they sit in, for their seats. */
async function loadWaitingOffPlanStandings(
  asks: ReadonlyArray<{ seatId: string; day: string }>,
  isTest: boolean,
  caps: OffPlanCaps,
): Promise<Map<string, OffPlanStanding>> {
  if (asks.length === 0) return new Map();
  const windows = asks.map((ask) => offPlanWeekWindow(ask.day));
  const from = windows.map((window) => window.from).sort()[0];
  const to = windows.map((window) => window.to).sort().at(-1) as string;
  try {
    const rows = await loadOffPlanRows(
      asks.map((ask) => ask.seatId),
      isTest,
      { from, to },
    );
    return offPlanStandings({ rows, asks, caps });
  } catch (error) {
    // A line beside a card is never worth the Team tab: the card still decides, and the door still enforces.
    console.error("phoenix-crm: the out-of-plan standing could not be read", error);
    return new Map();
  }
}

/** `canOverride` on each of the three: the Administrator may decline it — he is no step and is never counted. */
export type TeamRequest = ListRequest & { seatId: string; territoryName: string; canDecide: boolean; canOverride: boolean };

export type TeamUnplannedVisit = UnplannedVisitView & {
  territoryName: string;
  canDecide: boolean;
  canOverride: boolean;
  /**
   * The other days of the visit's field week its customer stood on the rep's SENT plan, as the plan
   * stood when he logged the visit (owner, 2026-10-02: "the approver sees the original day"). Read by
   * the server from the plan itself (server/offplan-day.ts), never from what the rep wrote; empty when
   * the visit was not moved from a day.
   */
  plannedFor: string[];
  /**
   * Where the rep stood on the out-of-plan allowance — two doctors a day, eight a week (owner,
   * 2026-10-10) — on the visit's own day and in its field week, so the decider reads it beside the visit.
   * Counted from EVERY out-of-plan doctor visit, not only the ones waiting.
   */
  repOffPlan: OffPlanStanding;
};

/** A rep's request to edit a sent week (owner, 2026-10-01), with whether THIS viewer acts at its step. */
/** `canOverride`: the Administrator may decline it (never counted as waiting for him — he is no step). */
export type TeamPlanEdit = PlanEditRequestView & { territoryName: string; canDecide: boolean; canOverride: boolean };

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
   * The district manager's weekly plan (owner, 2026-10-16), which replaced the double-visit planner on
   * this tab: "own" — the district manager himself (his report and Manager's own list); "pick" — his
   * RSM/NSM, SFE, the CEO and the Super Admin, choosing a district manager. Null for a rep.
   */
  managerPlans: { mode: "own" | "pick" } | null;
  /**
   * A rep's asks for a visit with somebody (owner, 2026-10-02): how this viewer reads them — the ones
   * asked of him or told to him, or every one in scope for SFE and the Super Admin — whether he has any
   * to read, and how many wait for his answer. Null for everyone the asks never reach (a CEO). They are
   * drawn in the Double visits section, apart from the district manager's own plan.
   */
  visitAsks: VisitAskSummary | null;
  /**
   * The decided items the Administrator can still take back (owner, 2026-10-08): a reopened week, an
   * approved off-plan visit, an approved list request, fourteen days back. Null for everyone else, so no
   * other viewer's payload carries it, and null too when it could not be read — the tab still opens.
   */
  reversible: ReversibleItem[] | null;
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
    /** Requests to edit a week at a step this viewer takes — the manager's, or SFE's. */
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

  // The Administrator's list of decisions he can still take back depends on nothing below, so it
  // starts first and is collected last. Its failure was already caught into null — the tab still opens.
  const reversibleRead = loadReversibleItems(viewer, isTest).catch((error: unknown) => {
    logError("Phoenix CRM could not read the reversible decisions for the Team tab", {
      error,
      labels: { event: "phoenix_crm_reversible_items_failed" },
    });
    return null;
  });

  const [readiness, requestRows, unplannedRows, planEditRows, todayBySeat, dayStartBySeat, visitAsks, vendorLeftovers] =
    await Promise.all([
      isTest || seatIds.length === 0 ? Promise.resolve(new Map<string, SeatReadiness>()) : loadReadiness(seatIds),
      seatIds.length === 0 ? Promise.resolve([]) : loadRequestRows(seatIds, isTest, { pendingOnly: true }),
      loadUnplannedRows(seatIds, isTest),
      loadPlanEditRows(seatIds, isTest, viewer.cairoToday),
      // The VISIT day (until 02:00 the day that just ended), the same day the rep's own Today shows.
      seatIds.length === 0 ? Promise.resolve(new Map<string, TeamTodayFigures>()) : loadTeamToday(seatIds, isTest, viewer.visitDay),
      // The same day again: when each rep said he started it (owner, 2026-10-03). One batched read for
      // the whole scope, beside the figures rather than inside them — it is a different table.
      loadDayStartsBySeat(seatIds, isTest, viewer.visitDay),
      visitAskSummaryOrNull(viewer, isTest),
      // The vendor mirror knows nothing of test entries, so test mode asks it nothing. Asked for THIS
      // scope's territories: only their rows are ever read off the answer.
      isTest ? Promise.resolve(new Map<string, VendorLeftoverRep[]>()) : loadVendorLeftoversBySeat({ seatIds }),
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
  // So does where each one's rep stands on the out-of-plan allowance (it catches its own failure).
  const [names, movedFrom, offPlanStandingsRead] = await Promise.all([
    loadPeopleNames([
      ...territoryPeople(viewer.org, rowSeats),
      ...requestPeople(requestRows),
      ...unplannedPeople(unplannedRows),
      ...planEditPeople(planEditRows),
    ]),
    loadMovedFromDays(unplannedRows.map(unplannedVisitRef), isTest),
    loadWaitingOffPlanStandings(
      unplannedRows.map((row) => ({ seatId: String(row.seat_id), day: String(row.visit_date) })),
      isTest,
      viewer.config.settings,
    ),
  ]);

  const summaries = new Map(rowSeats.map((seat) => [seat.seatId, describeTerritory(viewer.org, seat, names)]));
  const territories = rowSeats.map(
    (seat): TeamTerritoryRow => ({
      territory: summaries.get(seat.seatId) as TerritorySummary,
      // loadReadiness answers for every territory asked, or throws; nothing here reads a gap as ready.
      readiness: isTest ? null : (readiness.get(seat.seatId) as SeatReadiness),
      pendingRequests: pendingBySeat.get(seat.seatId) ?? 0,
      canReview: canReviewTerritory(viewer, seat, isTest),
      today: withClock(todayBySeat.get(seat.seatId) ?? emptyTeamToday(), dayStartBySeat.get(seat.seatId) ?? null),
      // 🔴 Golden Rule #1, the same clearing the off-plan location flag gets below: a rep's scope
      // holds his own territory, so this answer would otherwise carry his own row to him.
      stillOnVendor: isLocationBlind(viewer, seat) ? [] : sortVendorLeftovers(vendorLeftovers.get(seat.seatId) ?? []),
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
        // A request SFE returned for a comment is with the rep: nobody decides it, and the bulk drop skips it.
        ...requestRights(viewer, seat, isTest, request),
        canOverride: canOverrideDecision(viewer, isTest),
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
        // 🔴 And a manager below the Super Admin and SFE reads the distance only (owner, 2026-10-02): a
        // weak signal is never far (far beats weak, geo.ts), so for him it is a visit at the place, with
        // no line on the card — "Weak location signal when it was saved" is not his to read.
        locationFlag: offPlanLocationFlag(seat ? locationSight(viewer, seat) : "none", view.locationFlag),
        territoryName: summaries.get(view.seatId)?.name ?? "Territory",
        // The step it is ON decides who may press the button: the manager's step is the territory's
        // reviewer, the SFE's step is the SFE Manager. Everyone else in scope reads it and no more.
        canDecide: seat ? canDecideUnplannedRow(viewer, seat, isTest, view.status) : false,
        canOverride: canOverrideDecision(viewer, isTest),
        plannedFor: movedFrom.get(view.visitId) ?? [],
        repOffPlan: offPlanStandingsRead.get(offPlanStandingKey(view.seatId, view.visitDate)) ?? emptyOffPlanStanding(viewer.config.settings),
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
        // The step it is ON decides who may press the button: the district manager's or SFE's.
        canDecide: seat ? canDecidePlanEditRow(viewer, seat, isTest, view.status) : false,
        canOverride: canOverrideDecision(viewer, isTest),
      };
    })
    .sort((left, right) => Number(right.canDecide) - Number(left.canDecide) || left.raisedAt.localeCompare(right.raisedAt));

  const realRows = territories.filter((row) => row.readiness);
  const reversible = await reversibleRead;
  return {
    isTest,
    viewerHrId: viewer.hrId,
    territories,
    requests,
    unplannedVisits,
    planEdits,
    managerPlans: (() => {
      const reach = managerPlanReach(viewer);
      return reach ? { mode: reach.mode } : null;
    })(),
    visitAsks,
    reversible,
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
