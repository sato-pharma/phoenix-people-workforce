import { ApiError } from "@/lib/http/api-errors";
import { logError } from "@/lib/observability/log";
import { dayDetailCounts, type DayDetailCounts } from "@/lib/phoenix-crm/day-detail";
import { isMissedRecordDay } from "@/lib/phoenix-crm/missed-records";
import type { ManagerDayVisit } from "@/lib/phoenix-crm/manager-visit-detail";
import { territoryName } from "@/lib/phoenix-crm/scope";
import { canEnterMissedRecordOn, canEnterMissedRecords, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadDayRouteSafely, type DayRouteLoad } from "@/lib/phoenix-crm/server/day-route";
import { loadRepVisitDetails } from "@/lib/phoenix-crm/server/manager-visit-details";
import { loadVisitDay, resolveVisitDayAddress, type VisitDayView } from "@/lib/phoenix-crm/server/visits";
import { loadApprovedLeaveDays } from "@/lib/vacation/approved-leave-days";
import { canAccess, type AccessContext } from "@/lib/auth/permissions";
import type { PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";

/**
 * Phoenix CRM — the day the team calendar links to, loaded in full.
 *
 * Owner, 2026-09-30: a calendar cell with work on it opens this in a NEW TAB, "with location,
 * timing, everything". `day-detail.ts` beside this file holds the counting rule.
 *
 * 🔴 IT DOES NOT RE-READ THE DAY — `loadVisitDay` already does it, and already GATES it. That one
 * function resolves the territory through `territoryForRead` (so the viewer's own scope decides
 * what he may open), stamps the visit day, loads the day activity, and applies `isLocationBlind`.
 * Writing a second reader here would be a second answer to the question of who may see what.
 *
 * 🔴 SO THE LOCATION LINE ON THIS PAGE IS ALREADY BLIND WHERE IT MUST BE. A manager reading his
 * rep's day sees the measured sentence; the REP reading his own sees `BLIND_LOCATION` — "Visit
 * saved", no distance, no flag — because `mapVisitRow` blanked it upstream (Golden rule #1). The
 * screen never decides this, which is the only way it cannot be got wrong by a later edit.
 *
 * 🔴 AND THE VISITS TAB IS UNCHANGED. It deliberately shows no location to anyone; this page is the
 * one the owner asked for, reached only from the managers' calendar, and it is a superset rather
 * than a second version of that tab.
 */

export type PhoenixCrmDayDetail = VisitDayView &
  DayDetailCounts & {
    /** HR's own approved leave covering this day for the person in the seat. */
    onLeave: boolean;
    /**
     * 🔴 HR's leave could not be read, so `onLeave` is false for a reason that is not about the rep.
     * Said on the page: a day of approved leave otherwise reads exactly like a day he worked and
     * logged nothing.
     */
    leaveUnread: boolean;
    /**
     * The Super Admin may enter a record the rep MISSED on this day (owner, 2026-10-01) — a visit, or how
     * the day was spent. Null for everyone else, for a vacant seat, for a line that has not opened, and
     * for a day still to come. The entry itself is the panel's, through /missed-records, where the same
     * gate (`territoryForMissedRecord`) is asserted again.
     */
    missedRecords: { seatId: string; through: string } | null;
    /**
     * The Super Admin may CORRECT a rep's visit on this page — who was on it, its products, its comment
     * (owner, 2026-10-06). Drawn per visit; the route (`/visit-edit`) asserts the same gate again
     * (`territoryForVisitEdit`), so nothing on the screen decides who may.
     */
    editsVisits: boolean;
    /**
     * The Super Admin may DELETE any visit or the day's record on this page as if it never happened
     * (owner, 2026-10-23). The route (`/admin-delete`) asserts the same gate again.
     */
    adminDeletes: boolean;
    /**
     * Every visit of the day as the record a manager's day carries — customer, type, half, clock, brick, area,
     * address, single or double, who came along (owner, 2026-10-21: "everyone's visits in details … exactly as Mina
     * Farouk"). Drawn as the same plan-against-actual table his day page draws. Read from the countable view, like
     * the calendar cell; empty when `visitsInFullUnread`.
     */
    visitsInFull: ManagerDayVisit[];
    /** That read failed: said on the page, and the visit cards below it still carry the day. */
    visitsInFullUnread: boolean;
  };

export async function loadPhoenixCrmDayDetail(
  viewer: PhoenixCrmViewer,
  raw: { seatId: unknown; date: unknown; test: unknown },
): Promise<PhoenixCrmDayDetail> {
  // 🔴 LEAVE AND THE VISITS IN FULL START BESIDE THE DAY, NOT AFTER IT (2026-10-31, "fix the slowest five pages").
  // Both need only the seat, the day and the test flag, and `resolveVisitDayAddress` answers those with no read and
  // with the same refusal `loadVisitDay` would throw, so nothing is read for a day the viewer may not open. Each
  // keeps its own catch and its own sentence below, so neither ever rejects while the day is being read.
  const address = resolveVisitDayAddress(viewer, raw);
  const leaveRead = readDayLeave(address.seat.occupantHrId, address.date);
  const visitsInFullRead = readVisitsInFull(viewer, address);
  const loaded = await loadVisitDay(viewer, raw);
  // 🔴 EARLIEST FIRST, WHICH IS NOT HOW THE VISITS TAB ORDERS THEM. That tab is a rep's own day,
  // where the visit he just saved belongs at the top; this page is somebody ELSE reading the day
  // afterwards, and a day is read the way it was lived. The first cut inherited newest-first under
  // a heading that said "in the order they happened", which was simply untrue.
  const day = { ...loaded, visits: [...loaded.visits].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt)) };
  // 🔴 THE SAME BASIS AS THE CALENDAR CELL THAT OPENED THIS PAGE. `countsInKpi` is the row's own
  // answer (`visitCountsInKpi`), so the headline here equals the grid's figure; the list below keeps
  // every visit with its status, and what is held back is said in words rather than dropped.
  const { archiveHistory, awaitingApproval, awaitingValidation, counts, pharmacies } = dayDetailCounts(
    day.visits.map((visit) => ({
      archiveHistory: visit.archiveHistory,
      capturedAt: visit.capturedAt,
      copiedFromOldSystem: visit.copiedFromOldSystem,
      countsInKpi: visit.countsInKpi,
      customerId: visit.customerId,
      customerName: visit.customerName,
      customerValidated: visit.customerValidated,
      listType: visit.listType,
      pharmacyName: visit.pharmacyName,
    })),
  );

  const [{ onLeave, leaveUnread }, { visitsInFull, visitsInFullUnread }] = await Promise.all([leaveRead, visitsInFullRead]);

  const seat = viewer.org.seats.get(day.territory.seatId);
  const missedRecords =
    seat && canEnterMissedRecordOn(viewer, seat, day.isTest) && isMissedRecordDay(day.date, viewer.visitDay)
      ? { seatId: seat.seatId, through: viewer.visitDay }
      : null;

  return {
    ...day,
    archiveHistory,
    awaitingApproval,
    awaitingValidation,
    counts,
    leaveUnread,
    missedRecords,
    onLeave,
    pharmacies,
    editsVisits: canEnterMissedRecords(viewer),
    adminDeletes: canEnterMissedRecords(viewer),
    visitsInFull,
    visitsInFullUnread,
  };
}

/**
 * Leave is HR's, read through HR's own module (a Phoenix CRM service may not touch that table —
 * `tests/phoenix-crm-boundary`). It is an annotation: losing it must not lose the day, so the
 * throw that module leaves to its caller is caught here.
 *
 * 🔴 AND A FAILED READ IS SAID, NEVER SWALLOWED. It used to be caught and discarded, so a day the
 * rep was on approved leave read exactly like a day he worked and logged nothing — the page's own
 * "What else this day was" block simply did not appear. `leaveUnread` is the same sentence the
 * plan report has carried since 2026-10-01 (`plan-leave.ts` LEAVE_UNREAD_NOTE).
 */
async function readDayLeave(hrId: string | null, date: string): Promise<{ onLeave: boolean; leaveUnread: boolean }> {
  let onLeave = false;
  let leaveUnread = false;
  if (hrId) {
    try {
      const away = await loadApprovedLeaveDays([hrId], { from: date, to: date });
      onLeave = away.length > 0;
    } catch (error) {
      onLeave = false;
      leaveUnread = true;
      logError("Phoenix CRM day page could not read approved leave", {
        error,
        labels: { event: "phoenix_crm_day_leave_unread" },
      });
    }
  }
  return { onLeave, leaveUnread };
}

/**
 * The same day, visit by visit, as the record a manager's day page draws (owner, 2026-10-21). Only ever an addition
 * to the cards below, which still carry the day: a failed read is said, never a reason to lose the page.
 */
async function readVisitsInFull(
  viewer: PhoenixCrmViewer,
  address: ReturnType<typeof resolveVisitDayAddress>,
): Promise<{ visitsInFull: ManagerDayVisit[]; visitsInFullUnread: boolean }> {
  let visitsInFull: ManagerDayVisit[] = [];
  let visitsInFullUnread = false;
  try {
    visitsInFull = await loadRepVisitDetails({
      end: address.date,
      // The off-plan visits still waiting for their approvals are listed too, marked, so a record entered for the rep
      // (owner, 2026-10-24: "show as waiting") is on the page and not only a count underneath it.
      includeWaiting: true,
      isTest: address.isTest,
      seatIds: [address.seat.seatId],
      start: address.date,
      territoryNameOf: (seatId) => {
        const territorySeat = viewer.org.seats.get(seatId);
        return territorySeat ? territoryName(territorySeat) : null;
      },
    });
  } catch (error) {
    visitsInFullUnread = true;
    logError("Phoenix CRM day page could not read the visits in full", { error, labels: { event: "phoenix_crm_day_visits_in_full_unread" } });
  }
  return { visitsInFull, visitsInFullUnread };
}

/**
 * The page's own load, tagged — the same three-way shape `loadPhoenixCrmPage` uses, and for the
 * same reason: a REFUSAL and a FAILURE read differently to whoever followed the link. "Not yours"
 * is an answer; "could not load" is a reason to try again. Tagging it here also keeps the page from
 * building JSX inside a try/catch, which React does not catch anyway.
 *
 * Which one it is comes from the typed error's STATUS, never from its wording: a message sweep
 * would silently reclassify itself the first time somebody rephrased a refusal.
 */
export type PhoenixCrmDayLoad =
  | ({ kind: "ready"; view: PhoenixCrmDayDetail } & DayRouteLoad)
  | { kind: "refused"; message: string }
  | { kind: "failed"; error: unknown };

/**
 * `withRoute` is the ADMIN day page's (owner, 2026-10-24: "Admin tab plus a map"); the portal page never asks,
 * so its answer is unchanged. Whether a route comes back at all is still `loadDayRoute`'s own gate.
 */
export async function loadPhoenixCrmDayPage(
  access: AccessContext,
  raw: { seatId: unknown; date: unknown; test: unknown },
  options: { withRoute?: boolean } = {},
): Promise<PhoenixCrmDayLoad> {
  try {
    // 🔴 GATE ONE FIRST, as `loadPhoenixCrmPage` does (audit, 2026-10-02). The organogram is gate two
    // and decides WHICH territories; it knows nothing of the permission matrix or of a per-account
    // module lock, so without this line a locked account still opened any day it could link to.
    if (!(await canAccess(access, "phoenix_crm", "read"))) return { kind: "refused", message: REFUSED };
    const viewer = await resolvePhoenixCrmViewer(access);
    const view = await loadPhoenixCrmDayDetail(viewer, raw);
    if (!options.withRoute) return { kind: "ready", view, route: null, routeUnread: false };
    // The address the full-detail table already resolved for each visit, keyed by its row id (`rep:<id>`).
    const addressOf = new Map(view.visitsInFull.map((visit) => [visit.id, visit.address]));
    const visits = view.visits.map((visit) => ({
      table: "visits" as const,
      rowId: visit.visitId,
      customerName: visit.customerName,
      address: addressOf.get(`rep:${visit.visitId}`) ?? null,
    }));
    return { kind: "ready", view, ...(await loadDayRouteSafely(viewer, visits)) };
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    if (status === 400 || status === 403 || status === 404) {
      return { kind: "refused", message: error instanceof Error ? error.message : REFUSED };
    }
    return { error, kind: "failed" };
  }
}

const REFUSED = "This territory is not one you read in Phoenix CRM.";
