import { canAccess, type AccessContext } from "@/lib/auth/permissions";
import { ApiError, forbiddenError, validationError } from "@/lib/http/api-errors";
import { logError } from "@/lib/observability/log";
import { managerDayFigures, type ManagerDayFigures, type ManagerDayVisit } from "@/lib/phoenix-crm/manager-visit-detail";
import { fieldWeekStart } from "@/lib/phoenix-crm/calendar";
import type { ManagerDayPlan } from "@/lib/phoenix-crm/manager-day-plan";
import { isManagerPlanSent } from "@/lib/phoenix-crm/manager-plan-rules";
import { managerChain, managersInScope, personKey, territoryName } from "@/lib/phoenix-crm/scope";
import { canEnterMissedRecords, readsCalendar, resolvePhoenixCrmViewer, testModeFor, testReadSeats, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { dayRouteVisitOf, loadDayRouteSafely, type DayRouteLoad } from "@/lib/phoenix-crm/server/day-route";
import { computeManagerReports } from "@/lib/phoenix-crm/server/manager-plan-report";
import { loadManagerVisitDetails } from "@/lib/phoenix-crm/server/manager-visit-details";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { loadScopeProductManagers } from "@/lib/phoenix-crm/server/scope-product-managers";
import { seatTierTitle } from "@/lib/phoenix-crm/server/territory";
import { productManagerOfRowKey } from "@/lib/phoenix-crm/team-calendar";
import { loadApprovedLeaveDays } from "@/lib/vacation/approved-leave-days";

/**
 * Phoenix CRM — a MANAGER'S day, loaded in full (owner, 2026-10-20: a district manager's visits showed as a
 * bare count on the team calendar, and "I want full details — every single detail").
 *
 * The rep's day page (`day-detail.ts`) opens a territory; a manager holds a seat above territories, so his day
 * is its own page. It is reached from the manager's row on the team calendar and from nowhere else.
 *
 * 🔴 WHO MAY OPEN IT IS EXACTLY WHO SEES THE ROW. The calendar draws a manager's row for the managers
 *    `managersInScope` returns that stand above a territory the viewer reads, and never in test mode — so this
 *    page resolves the very same list and refuses a seat that is not in it. A second rule here would be a
 *    second answer to a settled question; a rep, who reads only himself, is refused because no manager is in
 *    his scope. The gate order is the day page's: the `phoenix_crm` permission first, then the organogram.
 *
 * 🔴 THE FIGURES ARE THE CALENDAR CELL'S OWN (`managerDayFigures`), SO THE GRID AND THE PAGE IT OPENS CANNOT
 *    PRINT TWO NUMBERS FOR ONE DAY. AM · PM · Pharmacies stay three figures apart, and his own single visits
 *    count in his own report only — said on the page, never added to a rep's row.
 *
 * 🔴 THE PLAN IS THE WEEKLY REPORT'S, NOT A SECOND READ (owner, 2026-10-20: "plan vs actual vs detail per visit in
 *    actual"). The day's planned half-days come out of `computeManagerReports` — the rule every outside reader of a
 *    manager's plan already uses — so this page and the report cannot say two things about one day. A week that was
 *    never sent is not judged (`isManagerPlanSent`); a read that fails is SAID (`planUnread`), never shown as
 *    "no plan".
 *
 * 🔴 A LINE'S PRODUCT MANAGER OPENS HERE TOO, ON HIS ROW KEY `product-manager:<hr id>` (owner, 2026-10-21, asked:
 *    "Open a day page"). He holds no seat, so he is resolved by the calendar's own rule for his row — a company
 *    reader, `loadScopeProductManagers` over the territories the viewer reads, never in test mode — and his
 *    ride-alongs are the visits naming him in the product-manager slot (`productManagerSlot`).
 *
 * 🔴 NO LOCATION INTEGRITY, NO DISTANCE, NO FLAG. The page names where the doctor is and whether a pin was
 *    captured; the measured location line is the integrity board's and stays there.
 */

export type PhoenixCrmManagerDayDetail = {
  isTest: boolean;
  /** The Super Admin may delete any visit on this day as if it never happened (owner, 2026-10-23). */
  adminDeletes: boolean;
  date: string;
  manager: {
    seatId: string;
    name: string;
    /** "District Manager · Pedia" — the tier and the line, never a code. */
    title: string;
    /** The name above him, or null at the top of the viewer's scope. */
    reportsTo: string | null;
  };
  visits: ManagerDayVisit[];
  /** The day's planned half-days with their outcomes; null when the plan could not be read (`planUnread`). */
  plan: ManagerDayPlan | null;
  /** The weekly report could not be read, so `plan` is null for a reason that is not about him (said on the page). */
  planUnread: boolean;
  figures: ManagerDayFigures;
  /** HR's own approved leave covering the day. */
  onLeave: boolean;
  /** HR's leave could not be read, so `onLeave` is false for a reason that is not about him (said on the page). */
  leaveUnread: boolean;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REFUSED = "This manager is not one you read in Phoenix CRM.";

export async function loadPhoenixCrmManagerDayDetail(
  viewer: PhoenixCrmViewer,
  raw: { seatId: unknown; date: unknown; test: unknown },
): Promise<PhoenixCrmManagerDayDetail> {
  const seatId = typeof raw.seatId === "string" ? raw.seatId.trim() : "";
  const date = typeof raw.date === "string" ? raw.date.trim() : "";
  if (!seatId) throw validationError("Choose a manager.");
  if (!DATE.test(date)) throw validationError("That is not a calendar day.");
  if (!readsCalendar(viewer)) throw forbiddenError("This calendar is for a territory you hold or manage.");

  const isTest = testModeFor(viewer, raw.test);
  // The calendar draws no manager row in test mode, so there is no page to open either.
  if (isTest) throw forbiddenError(REFUSED);

  const seats = testReadSeats(viewer, isTest, viewer.scopeTerritories);
  const reads = new Set(seats.map((seat) => seat.seatId));
  const subject = await resolveSubject(viewer, seatId, seats);
  if (!subject) throw forbiddenError(REFUSED);

  const [visits, names] = await Promise.all([
    loadManagerVisitDetails({
      end: date,
      isTest,
      managerHrIds: [subject.hrId],
      productManagerSlot: subject.productManager,
      start: date,
      territoryNameOf: (territorySeatId) => {
        const seat = viewer.org.seats.get(territorySeatId);
        return seat ? territoryName(seat) : null;
      },
      territorySeatIds: reads,
    }),
    loadPeopleNames([subject.hrId, subject.aboveHrId]),
  ]);

  // Leave is HR's, read through HR's own module and only ever an annotation: losing it must not lose the day,
  // and a failed read is SAID rather than swallowed (a vacation day otherwise reads like a day he did nothing).
  let onLeave = false;
  let leaveUnread = false;
  try {
    onLeave = (await loadApprovedLeaveDays([subject.hrId], { from: date, to: date })).length > 0;
  } catch (error) {
    leaveUnread = true;
    logError("Phoenix CRM manager day could not read approved leave", { error, labels: { event: "phoenix_crm_manager_day_leave_unread" } });
  }

  // The plan of the week this day sits in, through the weekly report. Only ever an addition to the visits above:
  // losing it must not lose the day, and a failed read is said, not swallowed.
  let plan: ManagerDayPlan | null = null;
  let planUnread = false;
  try {
    const report = (await computeManagerReports(viewer, [subject.hrId], fieldWeekStart(date), isTest, names)).get(subject.hrId) ?? null;
    plan = {
      halves: (report?.days.find((day) => day.date === date)?.halves ?? []).map((half) => ({ ...half })),
      sent: isManagerPlanSent(report?.status ?? null),
      statusLine: report?.statusLine ?? "",
    };
  } catch (error) {
    planUnread = true;
    logError("Phoenix CRM manager day could not read the weekly plan", { error, labels: { event: "phoenix_crm_manager_day_plan_unread" } });
  }

  const above = subject.aboveHrId;
  return {
    adminDeletes: canEnterMissedRecords(viewer),
    date,
    figures: managerDayFigures(visits),
    isTest,
    leaveUnread,
    manager: {
      name: nameOf(names, subject.hrId),
      reportsTo: above ? nameOf(names, above) : null,
      seatId: subject.seatId,
      title: subject.title,
    },
    onLeave,
    plan,
    planUnread,
    visits,
  };
}

/** Whose day the address names: a seat manager, or a line's product manager on his row key. */
type ManagerDaySubject = { hrId: string; seatId: string; title: string; aboveHrId: string | null; productManager: boolean };

/**
 * The manager this address may open, or null — exactly the people the team calendar draws a row for. A seat manager
 * is one `managersInScope` returns above a territory the viewer reads; a product manager is one the calendar gives a
 * company reader (`loadScopeProductManagers`). A product manager who also holds a seat keeps the seat's page.
 */
async function resolveSubject(
  viewer: PhoenixCrmViewer,
  seatId: string,
  seats: ReturnType<typeof testReadSeats>,
): Promise<ManagerDaySubject | null> {
  const productManagerHrId = personKey(productManagerOfRowKey(seatId));
  if (productManagerHrId) {
    if (viewer.basis !== "all") return null;
    const holdsSeat = managersInScope(viewer.org, viewer.hrId, viewer.basis).some((candidate) => candidate.hrId === productManagerHrId);
    if (holdsSeat) return null;
    const found = (await loadScopeProductManagers(viewer, seats)).find((manager) => manager.hrId === productManagerHrId);
    if (!found) return null;
    const roster = viewer.productManagers.find((entry) => personKey(entry.hrId) === found.hrId);
    return {
      aboveHrId: personKey(roster?.managerHrId ?? null),
      hrId: found.hrId,
      productManager: true,
      seatId,
      title: [found.role, found.lineNames.join(" + ")].filter(Boolean).join(" · "),
    };
  }
  const member = managersInScope(viewer.org, viewer.hrId, viewer.basis).find(
    (candidate) =>
      !candidate.seat.isOtherPseudoDm &&
      candidate.seat.seatId === seatId &&
      seats.some((territory) => territory.path.some((ancestor) => ancestor !== territory.seatId && ancestor === seatId)),
  );
  if (!member) return null;
  return {
    aboveHrId: managerChain(viewer.org, member.seat.seatId)[0]?.hrId ?? null,
    hrId: member.hrId,
    productManager: false,
    seatId: member.seat.seatId,
    title: [seatTierTitle(member.seat.tier), member.seat.lineName].filter(Boolean).join(" · "),
  };
}

export type PhoenixCrmManagerDayLoad =
  | ({ kind: "ready"; view: PhoenixCrmManagerDayDetail } & DayRouteLoad)
  | { kind: "refused"; message: string }
  | { kind: "failed"; error: unknown };

/**
 * The page's own load, tagged — a REFUSAL and a FAILURE read differently to whoever followed the link.
 *
 * `withRoute` is the ADMIN day page's (owner, 2026-10-24: "Admin tab plus a map"); the portal page never asks, so
 * its answer is unchanged. Whether a route comes back at all is still `loadDayRoute`'s own gate.
 */
export async function loadPhoenixCrmManagerDayPage(
  access: AccessContext,
  raw: { seatId: unknown; date: unknown; test: unknown },
  options: { withRoute?: boolean } = {},
): Promise<PhoenixCrmManagerDayLoad> {
  try {
    // Gate one first, as the day page does: a per-account module lock closes the permission, and the organogram
    // (gate two) knows nothing of it.
    if (!(await canAccess(access, "phoenix_crm", "read"))) return { kind: "refused", message: REFUSED };
    const viewer = await resolvePhoenixCrmViewer(access);
    const view = await loadPhoenixCrmManagerDayDetail(viewer, raw);
    if (!options.withRoute) return { kind: "ready", view, route: null, routeUnread: false };
    const visits = view.visits.flatMap((visit) => {
      const located = dayRouteVisitOf(visit.id);
      return located ? [{ ...located, customerName: visit.customerName, address: visit.address }] : [];
    });
    return { kind: "ready", view, ...(await loadDayRouteSafely(viewer, visits)) };
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    if (status === 400 || status === 403 || status === 404) {
      return { kind: "refused", message: error instanceof Error ? error.message : REFUSED };
    }
    return { error, kind: "failed" };
  }
}
