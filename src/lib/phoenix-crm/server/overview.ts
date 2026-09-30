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

import { plannableWeeks } from "@/lib/phoenix-crm/calendar";
import { isForecastLine } from "@/lib/phoenix-crm/daily-forecast";
import { managerChain, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { canReviewTerritory, lineOpeningText, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { chunk, throwIfError } from "@/lib/phoenix-crm/server/db";
import { isDirectoryCompanyRole } from "@/lib/phoenix-crm/server/doctors";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { describeTerritory, territoryPeople, type TerritorySummary } from "@/lib/phoenix-crm/server/territory";
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
  waitingForYou: { requests: number; plans: number; isTest: boolean };
  /** Why the viewer has nothing to open yet, in one sentence; null when the module is open for them. */
  closedMessage: string | null;
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
  const heldClosed = [...viewer.waitingTerritories, ...viewer.managerSeats].find(
    (seat) => !seat.lineCode || !viewer.openLines.has(seat.lineCode),
  );
  if (heldClosed) return lineOpeningText(viewer, heldClosed);
  if (viewer.basis === "all") return "Phoenix CRM has not opened for any line yet.";
  return "Phoenix CRM is for the field force: you hold no territory or manager seat in the organogram.";
}

/**
 * `fromWeek` keeps a plan count to the weeks the Team tab lists (plannableWeeks): a plan whose week
 * is over no longer waits for anyone.
 */
async function countWaiting(
  table: "phoenix_crm_list_requests" | "phoenix_crm_plans",
  status: "pending" | "submitted",
  isTest: boolean,
  seatIds: string[] | null,
  fromWeek: string | null = null,
  stage: "reviewer" | "sfe" | null = null,
): Promise<number> {
  const supabase = getSupabaseAdmin();
  const count = (seatPart: string[] | null) => {
    let query = supabase.from(table).select("id", { count: "exact", head: true }).eq("status", status).eq("is_test", isTest);
    if (seatPart) query = query.in("seat_id", seatPart);
    if (fromWeek) query = query.gte("week_start", fromWeek);
    // A list request waits on the step it is ON (2026-09-29): a grade change and the first step of a
    // drop, an add or a bring-back are the territory's reviewer's; the second step is the SFE Manager's.
    if (stage === "reviewer") query = query.or("stage.is.null,stage.eq.manager");
    if (stage === "sfe") query = query.eq("stage", "sfe");
    return query;
  };
  if (seatIds === null) {
    const { count: total, error } = await count(null);
    throwIfError(error);
    return total ?? 0;
  }
  let total = 0;
  for (const part of chunk(seatIds, 100)) {
    const { count: partCount, error } = await count(part);
    throwIfError(error);
    total += partCount ?? 0;
  }
  return total;
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
  // Real decisions are the reviewer's; the Super Admin decides test entries only, and so does a test
  // account — on the territories the person it mirrors reviews.
  const waitingIsTest = viewer.isSuperAdmin || viewer.isTestPersona;
  const reviewSeatIds = viewer.isSuperAdmin
    ? null
    : scope.filter((seat) => canReviewTerritory(viewer, seat, viewer.isTestPersona)).map((seat) => seat.seatId);

  // The SFE step of a list request is the SFE Manager's across his whole scope (real entries only; the
  // Super Admin's test count above already holds every step).
  const sfeSeatIds =
    !viewer.isSuperAdmin && !viewer.isTestPersona && viewer.isSfeManager && viewer.canApprove ? scope.map((seat) => seat.seatId) : [];

  const [names, reviewerRequests, sfeRequests, plans] = await Promise.all([
    loadPeopleNames([viewer.hrId, ...territoryPeople(viewer.org, [...scope, ...viewer.waitingTerritories])]),
    reviewSeatIds !== null && reviewSeatIds.length === 0
      ? 0
      : countWaiting("phoenix_crm_list_requests", "pending", waitingIsTest, reviewSeatIds, null, reviewSeatIds === null ? null : "reviewer"),
    sfeSeatIds.length === 0 ? 0 : countWaiting("phoenix_crm_list_requests", "pending", false, sfeSeatIds, null, "sfe"),
    reviewSeatIds !== null && reviewSeatIds.length === 0
      ? 0
      : countWaiting("phoenix_crm_plans", "submitted", waitingIsTest, reviewSeatIds, plannableWeeks(viewer.cairoToday)[0]),
  ]);

  const territories = scope
    .map((seat) => describeTerritory(viewer.org, seat, names))
    .sort((left, right) => left.name.localeCompare(right.name));
  const hasScope = viewer.isSuperAdmin || scope.length > 0;
  const tabs: PhoenixCrmTabs = {
    visits: hasScope,
    list: hasScope,
    plan: viewer.isSuperAdmin || ownSeatIds.length > 0,
    // The daily forecast is CNS ONLY (owner, 2026-10-01). A CNS rep has his own territory in scope, a
    // CNS manager (and the CEO and the SFE Manager, who read the company) has CNS territories beneath
    // him; anyone whose scope holds no CNS territory is never offered it.
    forecast: viewer.isSuperAdmin || scope.some((seat) => isForecastLine(seat.lineCode)),
    team: viewer.isSuperAdmin || (scope.length > 0 && (viewer.managerSeats.length > 0 || viewer.basis === "all")),
    // The team calendar rides the TEAM tab's own predicate rather than a second copy of it: both
    // show a manager his people, and a rule written twice is a rule that will disagree with itself.
    calendar: viewer.isSuperAdmin || (scope.length > 0 && (viewer.managerSeats.length > 0 || viewer.basis === "all")),
    // The Doctors directory. A directory role (owner, 2026-09-22: the SFE Manager and the Training
    // Manager read the whole company) gets it without holding a seat — a Training Manager has no
    // territory in the organogram, so `hasScope` alone would leave him with no tab at all.
    doctors: hasScope || isDirectoryCompanyRole(viewer.role),
    reports: hasScope,
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
    waitingForYou: { requests: reviewerRequests + sfeRequests, plans, isTest: waitingIsTest },
    closedMessage: closedMessage(viewer),
  };
}
