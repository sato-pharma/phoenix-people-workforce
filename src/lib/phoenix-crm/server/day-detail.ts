import { ApiError } from "@/lib/http/api-errors";
import { dayDetailCounts, type DayDetailCounts } from "@/lib/phoenix-crm/day-detail";
import { isMissedRecordDay } from "@/lib/phoenix-crm/missed-records";
import { canEnterMissedRecordOn, canEnterMissedRecords, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadVisitDay, type VisitDayView } from "@/lib/phoenix-crm/server/visits";
import { loadApprovedLeaveDays } from "@/lib/vacation/approved-leave-days";
import type { AccessContext } from "@/lib/auth/permissions";
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
     * The Super Admin may enter a record the rep MISSED on this day (owner, 2026-10-01) — a visit, or how
     * the day was spent. Null for everyone else, for a vacant seat, for a line that has not opened, and
     * for a day still to come. The entry itself is the panel's, through /missed-records, where the same
     * gate (`territoryForMissedRecord`) is asserted again.
     */
    missedRecords: { seatId: string; through: string } | null;
    /**
     * The Super Admin may take back a visit HE entered on this page (owner, 2026-10-01). Apart from
     * `missedRecords` on purpose: his own mistake stays his to remove after the rep has left the seat or
     * the line has closed again, where nothing new may be entered (`territoryForMissedRecordRemoval`).
     */
    removesEnteredVisits: boolean;
  };

export async function loadPhoenixCrmDayDetail(
  viewer: PhoenixCrmViewer,
  raw: { seatId: unknown; date: unknown; test: unknown },
): Promise<PhoenixCrmDayDetail> {
  const loaded = await loadVisitDay(viewer, raw);
  // 🔴 EARLIEST FIRST, WHICH IS NOT HOW THE VISITS TAB ORDERS THEM. That tab is a rep's own day,
  // where the visit he just saved belongs at the top; this page is somebody ELSE reading the day
  // afterwards, and a day is read the way it was lived. The first cut inherited newest-first under
  // a heading that said "in the order they happened", which was simply untrue.
  const day = { ...loaded, visits: [...loaded.visits].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt)) };
  const { counts, pharmacies } = dayDetailCounts(
    day.visits.map((visit) => ({
      capturedAt: visit.capturedAt,
      customerId: visit.customerId,
      customerName: visit.customerName,
      listType: visit.listType,
      pharmacyName: visit.pharmacyName,
    })),
  );

  // Leave is HR's, read through HR's own module (a Phoenix CRM service may not touch that table —
  // `tests/phoenix-crm-boundary`). It is an annotation: losing it must not lose the day, so the
  // throw that module leaves to its caller is caught here.
  let onLeave = false;
  const hrId = day.territory.repHrId;
  if (hrId) {
    try {
      const away = await loadApprovedLeaveDays([hrId], { from: day.date, to: day.date });
      onLeave = away.length > 0;
    } catch {
      onLeave = false;
    }
  }

  const seat = viewer.org.seats.get(day.territory.seatId);
  const missedRecords =
    seat && canEnterMissedRecordOn(viewer, seat, day.isTest) && isMissedRecordDay(day.date, viewer.visitDay)
      ? { seatId: seat.seatId, through: viewer.visitDay }
      : null;

  return { ...day, counts, missedRecords, onLeave, pharmacies, removesEnteredVisits: canEnterMissedRecords(viewer) };
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
  | { kind: "ready"; view: PhoenixCrmDayDetail }
  | { kind: "refused"; message: string }
  | { kind: "failed"; error: unknown };

export async function loadPhoenixCrmDayPage(
  access: AccessContext,
  raw: { seatId: unknown; date: unknown; test: unknown },
): Promise<PhoenixCrmDayLoad> {
  try {
    const viewer = await resolvePhoenixCrmViewer(access);
    return { kind: "ready", view: await loadPhoenixCrmDayDetail(viewer, raw) };
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    if (status === 400 || status === 403 || status === 404) {
      return { kind: "refused", message: error instanceof Error ? error.message : REFUSED };
    }
    return { error, kind: "failed" };
  }
}

const REFUSED = "This territory is not one you read in Phoenix CRM.";
