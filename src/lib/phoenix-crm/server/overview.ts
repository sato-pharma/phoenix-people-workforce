/**
 * Phoenix CRM — the page's opening read: who is looking, which tabs they get, the territories their
 * pickers offer, and what waits for their decision.
 *
 *   - Reps work their own territories (visits, list, plan); a district manager also enters visits for
 *     the territories they manage (the rep enters the double visit as a rule); regional and national
 *     managers, the CEO and the SFE Manager read, and the managers review in the Team tab.
 *   - Pickers are never wider than the viewer (scope runs downward only).
 *   - A line's people use the module from the line's opening day; before it the page says when.
 *   - The Super Admin works in test mode on any territory; "waiting for you" counts test entries then,
 *     because the Super Admin never decides a real one. A test account (src/lib/auth/test-persona.ts)
 *     works as the person it mirrors, and its "waiting for you" counts test entries for the same reason.
 */

import { addDaysIso } from "@/lib/crm/dates";
import { isTelegramConnected } from "@/lib/notifications/settings";
import { logError } from "@/lib/observability/log";
import { forecastIsOffered } from "@/lib/phoenix-crm/daily-forecast";
import { PLAN_EDIT_WAITING_STATUSES, type PlanEditStatus } from "@/lib/phoenix-crm/plan-edit-rules";
import { managerChain, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { telegramCardOffered } from "@/lib/phoenix-crm/telegram-card";
import {
  lineOpeningText,
  readsCalendar,
  readsFieldHeardByProduct,
  type PhoenixCrmViewer,
} from "@/lib/phoenix-crm/server/access";
import {
  countPhoenixCrmListRequestsWaitingForYou,
  countPhoenixCrmOffPlanVisitsWaitingForYou,
  countPhoenixCrmWeeklyPlansWaitingForYou,
  phoenixCrmDecisionSeats,
} from "@/lib/phoenix-crm/server/decision-queues";
import { chunk, throwIfError } from "@/lib/phoenix-crm/server/db";
import { isDirectoryCompanyRole } from "@/lib/phoenix-crm/server/doctors";
import { managerPlanReach } from "@/lib/phoenix-crm/server/manager-plan-reach";
import { dmPlansInPhoenixCrm } from "@/lib/phoenix-crm/server/manager-plan-switch";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { describeTerritory, territoryPeople, type TerritorySummary } from "@/lib/phoenix-crm/server/territory";
import { countVisitAsksWaitingForYou } from "@/lib/phoenix-crm/server/visit-asks";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * 🔴 THERE IS NO `today` MODULE ANY MORE (owner, 2026-09-30: "regarding the Today, you will retire it
 * from Phoenix CRM, and make something like it — of course not a big tool like this — in the rep's
 * landing page"). What replaced it is `RepTodayPlanPanel` on `/employee-portals`: the day's planned
 * customers clustered by brick, green once visited, with a small "+" per row into Add visit.
 *
 * Do NOT add it back as a tab. The rules it read still live in `today-rules.ts` and are what the
 * landing panel uses, so the module's logic was kept and only the SCREEN was retired.
 */
export type PhoenixCrmTabs = {
  visits: boolean;
  list: boolean;
  plan: boolean;
  forecast: boolean;
  team: boolean;
  calendar: boolean;
  doctors: boolean;
  reports: boolean;
  settings: boolean;
};

export type PhoenixCrmOverview = {
  viewer: {
    name: string;
    role: string;
    isSuperAdmin: boolean;
    isSfeManager: boolean;
    /** A test account: every entry it reads and saves is a test entry. */
    isTestPersona: boolean;
    /** Holds a territory as its rep (in an open line). */
    isRep: boolean;
    /** Holds a manager seat. */
    isManager: boolean;
  };
  cairoToday: string;
  /**
   * The visit day: the Cairo date of now minus 2 hours, so until 02:00 it is the day that just ended
   * (owner, 2026-09-29). The Visits tab shows it while its own day is still loading — the calendar
   * date there read "Wednesday" at 01:54 on the walk of 2026-09-30.
   */
  visitDay: string;
  tabs: PhoenixCrmTabs;
  /** Every territory the viewer reads; the Super Admin's test pickers use the same list. */
  territories: TerritorySummary[];
  /** The viewer's own territories (rep), by seat. */
  ownSeatIds: string[];
  /** Territories the viewer can enter visits for: their own, and the ones they manage (district managers). */
  visitSeatIds: string[];
  /** Held territories whose line has not opened yet, with the sentence saying when it opens. */
  waiting: Array<{ territory: TerritorySummary; message: string }>;
  /**
   * List requests (a grade, a drop, an add, a bring-back) at a step this viewer decides, and submitted
   * plans, waiting for this viewer's decision.
   */
  waitingForYou: {
    requests: number;
    plans: number;
    /** Requests to edit a sent week at a step this viewer takes (owner, 2026-10-01), in `isTest`'s world. */
    planEdits: number;
    isTest: boolean;
    /**
     * A rep's asks for a visit waiting for THIS viewer's answer (owner, 2026-10-02), in `isTest`'s world:
     * a manager's on the Team tab, a product manager's on Reports — the one page of the module he opens.
     */
    visitAsks: number;
    /**
     * Off-plan visits waiting at THIS viewer's own step, in `isTest`'s world: `manager_pending` on the
     * territories he reviews, `sfe_pending` for the SFE Manager across his scope.
     *
     * 🔴 IT WAS MISSING UNTIL 2026-10-02, AND AN OFF-PLAN VISIT COUNTS IN NOTHING UNTIL IT IS DECIDED
     * (module memory, the visit-type rule) — so the one item whose delay costs a rep his figures was
     * the one item no badge mentioned. Inside the Team tab `teamWaitingLine` named it correctly; the
     * module chooser's card, the tab bar's count and the "open on Team" choice all summed the other
     * four and left it out. Every sum of this object takes it now.
     */
    offPlanVisits: number;
  };
  /** Why the viewer has nothing to open yet, in one sentence; null when the module is open for them. */
  closedMessage: string | null;
  /**
   * Whether the viewer's Telegram is connected (owner, 2026-10-02 — 0 of 74 reps were, so every
   * Telegram leg of the module reached nobody). Null when the "Get Phoenix CRM messages on Telegram"
   * card is not for this viewer (`telegramCardOffered`: the reps and managers the notices go to) or
   * the status could not be read — and then no card is drawn, never one asking a connected person.
   */
  telegram: { connected: boolean } | null;
  /**
   * The district manager's weekly plan (owner, 2026-10-16). `planner`: he plans his own week here — a DM
   * or acting DM seat whose team is live (`dmPlansInPhoenixCrm`), which opens the Plan tab on his board.
   * `reads`: the Team tab's "Manager plans" report and "Manager's own list" — "own" for the district
   * manager himself, "pick" for the managers above him, SFE, the CEO and the Super Admin. Null for a rep,
   * who never reads any of it.
   */
  managerPlans: { planner: boolean; reads: "own" | "pick" } | null;
};

/** Seats, once each, in the order first seen. */
function dedupeSeats(seats: readonly OrgSeat[]): OrgSeat[] {
  const seen = new Map<string, OrgSeat>();
  for (const seat of seats) if (!seen.has(seat.seatId)) seen.set(seat.seatId, seat);
  return [...seen.values()];
}

function closedMessage(viewer: PhoenixCrmViewer): string | null {
  if (viewer.isSuperAdmin || viewer.scopeTerritories.length > 0) return null;
  // A directory role holds no territory (the Training Manager has no seat in the organogram) and
  // still has the Doctors tab to open, so the module is not closed for them.
  if (isDirectoryCompanyRole(viewer.role)) return null;
  // A product or marketing manager holds no seat either, and has one report to open: what the field
  // heard about his own products (owner, 2026-10-02).
  if (readsFieldHeardByProduct(viewer)) return null;
  const heldClosed = [...viewer.waitingTerritories, ...viewer.managerSeats].find(
    (seat) => !seat.lineCode || !viewer.openLines.has(seat.lineCode),
  );
  if (heldClosed) return lineOpeningText(viewer, heldClosed);
  if (viewer.basis === "all") return "Phoenix CRM has not opened for any line yet.";
  return "Phoenix CRM is for the field force: you hold no territory or manager seat in the organogram.";
}

/**
 * 🔴 THE LIST-REQUEST, PLAN AND OFF-PLAN COUNTS MOVED TO `server/decision-queues.ts` ON 2026-10-03,
 * AND MUST NOT BE COPIED BACK. The central Needs You board grew a Phoenix CRM source that reads the
 * same question, and a board that disagrees with this badge is the under-report `src/lib/needs-you`
 * exists to make impossible — so there is now exactly one producer and two readers. `countPlanEdits`
 * below stays here because nothing else asks it.
 */

/** Requests to edit a sent week waiting at the given steps, on weeks that still have a day ahead. */
async function countPlanEdits(statuses: PlanEditStatus[], isTest: boolean, seatIds: string[] | null, cairoToday: string): Promise<number> {
  const supabase = getSupabaseAdmin();
  const count = (seatPart: string[] | null) => {
    let query = supabase
      .from("phoenix_crm_plan_edit_requests")
      .select("id", { count: "exact", head: true })
      .in("status", statuses)
      .eq("is_test", isTest)
      .gte("week_start", addDaysIso(cairoToday, -5));
    if (seatPart) query = query.in("seat_id", seatPart);
    return query;
  };
  if (seatIds === null) {
    const { count: total, error } = await count(null);
    throwIfError(error);
    return total ?? 0;
  }
  // An SFE Manager's whole company is a few batches; their head counts run four at a time and are
  // added up in batch order — the same sum, without waiting for each in turn.
  const parts = await mapWithConcurrency(chunk(seatIds, 100), 4, async (part) => {
    const { count: partCount, error } = await count(part);
    throwIfError(error);
    return partCount ?? 0;
  });
  return parts.reduce((total, partCount) => total + partCount, 0);
}

/**
 * The viewer's Telegram, connected or not — the same row the Notification Settings panel reads. Null
 * when it cannot be read: a page never fails, and nobody is asked to connect, over a status nobody knows.
 */
async function telegramConnectedOrNull(viewer: PhoenixCrmViewer): Promise<boolean | null> {
  try {
    return await isTelegramConnected(viewer.access);
  } catch (error) {
    logError("Phoenix CRM could not read the viewer's Telegram status", {
      error,
      labels: { event: "phoenix_crm_telegram_status_failed" },
    });
    return null;
  }
}

/**
 * The visit asks waiting for this viewer's answer (server/visit-asks.ts), or 0 when they cannot be read.
 * It never fails the page — every Phoenix CRM page opens on this read — and the bell carries each ask
 * whatever this count says.
 */
async function visitAsksWaitingOrZero(viewer: PhoenixCrmViewer, isTest: boolean): Promise<number> {
  try {
    // One head count — and none at all for a viewer the asks never reach, a rep among them.
    return await countVisitAsksWaitingForYou(viewer, isTest);
  } catch (error) {
    logError("Phoenix CRM could not count the visit asks waiting", {
      error,
      labels: { event: "phoenix_crm_visit_ask_count_failed" },
    });
    return 0;
  }
}

export async function loadPhoenixCrmOverview(viewer: PhoenixCrmViewer): Promise<PhoenixCrmOverview> {
  const scope = viewer.scopeTerritories;
  const ownSeatIds = viewer.isSuperAdmin ? [] : viewer.ownTerritories.map((seat) => seat.seatId);
  const visitSeats: OrgSeat[] = viewer.isSuperAdmin
    ? scope
    : viewer.canCreate
      ? scope.filter(
          (seat) =>
            ownSeatIds.includes(seat.seatId) || managerChain(viewer.org, seat.seatId).some((member) => member.hrId === viewer.hrId),
        )
      : [];
  // Who decides what, in which world — the ONE producer of that rule (server/decision-queues.ts),
  // shared with the central Needs You board so the two can never disagree about whose turn it is.
  const decisionSeats = phoenixCrmDecisionSeats(viewer);
  const { isTest: waitingIsTest, reviewSeatIds, sfeSeatIds } = decisionSeats;

  // The Telegram card (owner, 2026-10-02) is for the reps and managers the module's notices go to.
  const telegramOffered = telegramCardOffered({
    isSuperAdmin: viewer.isSuperAdmin,
    isTestPersona: viewer.isTestPersona,
    isRep: ownSeatIds.length > 0,
    isManager: viewer.managerSeats.length > 0,
    isSfeManager: viewer.isSfeManager,
  });

  const managerReach = managerPlanReach(viewer);
  const [names, requests, plans, managerEdits, sfeEdits, telegramConnected, visitAsks, offPlanVisits, managerPlanner] =
    await Promise.all([
      loadPeopleNames([viewer.hrId, ...territoryPeople(viewer.org, [...scope, ...viewer.waitingTerritories])]),
      // The list requests at his own step — the reviewer's and the SFE's, summed by the one producer
      // (server/decision-queues.ts). An out-of-list visit's approval is one of these: the visit files
      // an `add` whose first step is the district manager.
      countPhoenixCrmListRequestsWaitingForYou(decisionSeats),
      // The weekly plans at his own step, through the one producer (server/decision-queues.ts) — the
      // Needs You board reads the SAME function, so the badge and the board cannot drift.
      countPhoenixCrmWeeklyPlansWaitingForYou(decisionSeats, viewer.cairoToday),
      // A request to edit a sent week (owner, 2026-10-01): the district manager's step and SFE's.
      // The Super Admin's test count holds every step, as his list-request count does.
      reviewSeatIds !== null && reviewSeatIds.length === 0
        ? 0
        : countPlanEdits(
            reviewSeatIds === null ? [...PLAN_EDIT_WAITING_STATUSES] : ["manager_pending"],
            waitingIsTest,
            reviewSeatIds,
            viewer.cairoToday,
          ),
      sfeSeatIds.length === 0 ? 0 : countPlanEdits(["sfe_pending"], false, sfeSeatIds, viewer.cairoToday),
      // In the same wave, and never able to fail the page: an unreadable status draws no card.
      telegramOffered ? telegramConnectedOrNull(viewer) : null,
      // The visit asks waiting for his answer (owner, 2026-10-02), in the world his other counts are in.
      // Never able to fail the page either: a count that cannot be read is no count, and the bell still
      // carries every ask.
      visitAsksWaitingOrZero(viewer, waitingIsTest),
      // The off-plan visits at his own step — the manager's on the territories he reviews, SFE's across
      // his scope, and both steps in the Super Admin's test world.
      countPhoenixCrmOffPlanVisitsWaitingForYou(decisionSeats),
      // Only a district manager who plans his own week asks the live-team switch; it fails open, and a test
      // persona always plans here — the same answer the save's own gate gives (`assertPlansHere`).
      managerReach?.mode === "own"
        ? viewer.isTestPersona || dmPlansInPhoenixCrm(viewer.hrId, { org: viewer.org, cairoToday: viewer.cairoToday }).catch(() => true)
        : false,
    ]);

  const territories = scope
    .map((seat) => describeTerritory(viewer.org, seat, names))
    .sort((left, right) => left.name.localeCompare(right.name));
  const hasScope = viewer.isSuperAdmin || scope.length > 0;
  const tabs: PhoenixCrmTabs = {
    visits: hasScope,
    list: hasScope,
    // A district manager whose team is live plans HIS week here too (owner, 2026-10-16), on his own board.
    plan: viewer.isSuperAdmin || ownSeatIds.length > 0 || managerPlanner,
    // The daily forecast is CNS ONLY (owner, 2026-10-01). A CNS rep has his own territory in scope, a
    // CNS manager (and the CEO and the SFE Manager, who read the company) has CNS territories beneath
    // him; anyone whose scope holds no CNS territory is never offered it.
    forecast: forecastIsOffered(viewer),
    team: viewer.isSuperAdmin || (scope.length > 0 && (viewer.managerSeats.length > 0 || viewer.basis === "all")),
    // 🔴 THE CALENDAR LEFT THE TEAM TAB'S PREDICATE ON 2026-10-01, at the owner's instruction:
    // "I want the medical rep to have also his team calendar seeing only himself". It is now the
    // one month view a rep is given, so it can no longer ride Team's rule — and it reads the
    // SERVICE'S own predicate rather than restating the condition here, because a tab that
    // disagrees with its page is a rep pressing Calendar and being refused by what is behind it.
    calendar: readsCalendar(viewer),
    // The Doctors directory. A directory role (owner, 2026-09-22: the SFE Manager and the Training
    // Manager read the whole company) gets it without holding a seat — a Training Manager has no
    // territory in the organogram, so `hasScope` alone would leave him with no tab at all.
    doctors: hasScope || isDirectoryCompanyRole(viewer.role),
    // A product or marketing manager reads ONE section of Reports — what the field heard about his own
    // products, company-wide (owner, 2026-10-02) — and the tab is that section's door.
    reports: hasScope || readsFieldHeardByProduct(viewer),
    settings: viewer.isSuperAdmin && viewer.canUpdate,
  };

  return {
    viewer: {
      name: nameOf(names, viewer.hrId, "You"),
      role: viewer.role,
      isSuperAdmin: viewer.isSuperAdmin,
      isSfeManager: viewer.isSfeManager,
      isTestPersona: viewer.isTestPersona,
      isRep: ownSeatIds.length > 0,
      isManager: viewer.managerSeats.length > 0,
    },
    cairoToday: viewer.cairoToday,
    visitDay: viewer.visitDay,
    tabs,
    territories,
    ownSeatIds,
    visitSeatIds: visitSeats.map((seat) => seat.seatId),
    // His own territories waiting for their line, AND the ones beneath him — a manager whose whole
    // district is on an unopened line has to read the date too, or the module simply looks broken to
    // him (it did, to a CNS district manager, on 2026-09-26). Deduped by seat, because an acting DM
    // holds a rep seat that is also inside his own scope.
    waiting: dedupeSeats([...viewer.waitingTerritories, ...viewer.waitingScopeTerritories]).map((seat) => ({
      territory: describeTerritory(viewer.org, seat, names),
      message: lineOpeningText(viewer, seat),
    })),
    waitingForYou: {
      requests,
      plans,
      planEdits: managerEdits + sfeEdits,
      isTest: waitingIsTest,
      visitAsks,
      offPlanVisits,
    },
    closedMessage: closedMessage(viewer),
    telegram: telegramConnected === null ? null : { connected: telegramConnected },
    managerPlans: managerReach ? { planner: managerPlanner, reads: managerReach.mode } : null,
  };
}
