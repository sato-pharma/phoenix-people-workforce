/**
 * Phoenix CRM — the managers' Team view: each territory's list readiness and the grade and drop
 * requests waiting for a decision. (The week's plans to review come from plans.ts loadPlanReviews.)
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
 */

import { forbiddenError } from "@/lib/http/api-errors";
import type { OrgSeat } from "@/lib/phoenix-crm/scope";
import { canReviewTerritory, readTestFlag, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadReadiness, loadRequestRows, mapRequestRow, type ListRequest, type SeatReadiness } from "@/lib/phoenix-crm/server/list";
import { loadPeopleNames } from "@/lib/phoenix-crm/server/people";
import { describeTerritory, territoryPeople, type TerritorySummary } from "@/lib/phoenix-crm/server/territory";

export type TeamTerritoryRow = {
  territory: TerritorySummary;
  /** Real entries only; null in test mode. */
  readiness: SeatReadiness | null;
  pendingRequests: number;
  /** The viewer decides this territory's requests and approves its plans. */
  canReview: boolean;
};

export type TeamRequest = ListRequest & { seatId: string; territoryName: string; canDecide: boolean };

export type TeamView = {
  isTest: boolean;
  territories: TeamTerritoryRow[];
  /** Waiting requests, the longest-waiting first. */
  requests: TeamRequest[];
  summary: {
    territories: number;
    vacant: number;
    ready: number;
    notReady: number;
    requestsWaiting: number;
    /** Requests this viewer decides. */
    waitingForYou: number;
  };
};

export async function loadTeamView(viewer: PhoenixCrmViewer, raw: { test: unknown }): Promise<TeamView> {
  const isTest = readTestFlag(raw.test);
  if (isTest && !viewer.isSuperAdmin) throw forbiddenError("Test entries are the Super Admin's.");
  const seats: OrgSeat[] = isTest ? viewer.org.territories : viewer.scopeTerritories;
  const seatIds = seats.map((seat) => seat.seatId);

  const [readiness, requestRows] = await Promise.all([
    isTest || seatIds.length === 0 ? Promise.resolve(new Map<string, SeatReadiness>()) : loadReadiness(seatIds),
    seatIds.length === 0 ? Promise.resolve([]) : loadRequestRows(seatIds, isTest, { pendingOnly: true }),
  ]);

  const pendingBySeat = new Map<string, number>();
  for (const row of requestRows) {
    const seatId = String(row.seat_id);
    pendingBySeat.set(seatId, (pendingBySeat.get(seatId) ?? 0) + 1);
  }
  // Test mode shows only the territories the Super Admin has tried; real mode shows every territory in scope.
  const rowSeats = isTest ? seats.filter((seat) => pendingBySeat.has(seat.seatId)) : seats;
  const names = await loadPeopleNames([
    ...territoryPeople(viewer.org, rowSeats),
    ...requestRows.flatMap((row) => [row.requested_by_hr_id as string | null, row.decided_by_hr_id as string | null]),
  ]);

  const summaries = new Map(rowSeats.map((seat) => [seat.seatId, describeTerritory(viewer.org, seat, names)]));
  const territories = rowSeats.map(
    (seat): TeamTerritoryRow => ({
      territory: summaries.get(seat.seatId) as TerritorySummary,
      // loadReadiness answers for every territory asked, or throws; nothing here reads a gap as ready.
      readiness: isTest ? null : (readiness.get(seat.seatId) as SeatReadiness),
      pendingRequests: pendingBySeat.get(seat.seatId) ?? 0,
      canReview: canReviewTerritory(viewer, seat, isTest),
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
      return {
        ...mapRequestRow(row, names),
        seatId,
        territoryName: summaries.get(seatId)?.name ?? "Territory",
        canDecide: canReviewTerritory(viewer, seat, isTest),
      };
    })
    .sort((left, right) => Number(right.canDecide) - Number(left.canDecide) || left.requestedAt.localeCompare(right.requestedAt));

  const realRows = territories.filter((row) => row.readiness);
  return {
    isTest,
    territories,
    requests,
    summary: {
      territories: territories.length,
      vacant: territories.filter((row) => !row.territory.repHrId).length,
      ready: realRows.filter((row) => row.readiness?.ready).length,
      notReady: realRows.filter((row) => !row.readiness?.ready).length,
      requestsWaiting: requests.length,
      waitingForYou: requests.filter((request) => request.canDecide).length,
    },
  };
}
