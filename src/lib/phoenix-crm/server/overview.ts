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
 *     because the Super Admin never decides a real one.
 */

import { plannableWeeks } from "@/lib/phoenix-crm/calendar";
import { managerChain, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { canReviewTerritory, lineOpeningText, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { chunk, throwIfError } from "@/lib/phoenix-crm/server/db";
import { isDirectoryCompanyRole } from "@/lib/phoenix-crm/server/doctors";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { describeTerritory, territoryPeople, type TerritorySummary } from "@/lib/phoenix-crm/server/territory";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type PhoenixCrmTabs = {
  visits: boolean;
  list: boolean;
  plan: boolean;
  team: boolean;
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
    /** Holds a territory as its rep (in an open line). */
    isRep: boolean;
    /** Holds a manager seat. */
    isManager: boolean;
  };
  cairoToday: string;
  tabs: PhoenixCrmTabs;
  /** Every territory the viewer reads; the Super Admin's test pickers use the same list. */
  territories: TerritorySummary[];
  /** The viewer's own territories (rep), by seat. */
  ownSeatIds: string[];
  /** Territories the viewer can enter visits for: their own, and the ones they manage (district managers). */
  visitSeatIds: string[];
  /** Held territories whose line has not opened yet, with the sentence saying when it opens. */
  waiting: Array<{ territory: TerritorySummary; message: string }>;
  /** Grade and drop requests, and submitted plans, waiting for this viewer's decision. */
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
): Promise<number> {
  const supabase = getSupabaseAdmin();
  const count = (seatPart: string[] | null) => {
    let query = supabase.from(table).select("id", { count: "exact", head: true }).eq("status", status).eq("is_test", isTest);
    if (seatPart) query = query.in("seat_id", seatPart);
    if (fromWeek) query = query.gte("week_start", fromWeek);
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
  // Real decisions are the reviewer's; the Super Admin decides test entries only.
  const reviewSeatIds = viewer.isSuperAdmin ? null : scope.filter((seat) => canReviewTerritory(viewer, seat, false)).map((seat) => seat.seatId);

  const [names, requests, plans] = await Promise.all([
    loadPeopleNames([viewer.hrId, ...territoryPeople(viewer.org, [...scope, ...viewer.waitingTerritories])]),
    reviewSeatIds !== null && reviewSeatIds.length === 0 ? 0 : countWaiting("phoenix_crm_list_requests", "pending", viewer.isSuperAdmin, reviewSeatIds),
    reviewSeatIds !== null && reviewSeatIds.length === 0
      ? 0
      : countWaiting("phoenix_crm_plans", "submitted", viewer.isSuperAdmin, reviewSeatIds, plannableWeeks(viewer.cairoToday)[0]),
  ]);

  const territories = scope
    .map((seat) => describeTerritory(viewer.org, seat, names))
    .sort((left, right) => left.name.localeCompare(right.name));
  const hasScope = viewer.isSuperAdmin || scope.length > 0;
  const tabs: PhoenixCrmTabs = {
    visits: hasScope,
    list: hasScope,
    plan: viewer.isSuperAdmin || ownSeatIds.length > 0,
    team: viewer.isSuperAdmin || (scope.length > 0 && (viewer.managerSeats.length > 0 || viewer.basis === "all")),
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
      isRep: ownSeatIds.length > 0,
      isManager: viewer.managerSeats.length > 0,
    },
    cairoToday: viewer.cairoToday,
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
    waitingForYou: { requests, plans, isTest: viewer.isSuperAdmin },
    closedMessage: closedMessage(viewer),
  };
}
