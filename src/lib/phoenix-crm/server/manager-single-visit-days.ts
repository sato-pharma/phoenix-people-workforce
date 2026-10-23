/**
 * Phoenix CRM — a district sales manager asks for a second or third day of single visits, and his managers
 * decide it (owner, 2026-10-20: "one per week with no approval … if you need to do the second or the third day
 * maximum, he need to send an approval from his manager … if regional manager, then … regional manager and the
 * national sales manager. If no regional manager, then approval direct from national sales manager").
 *
 * He asks FIRST, for ONE named date, and plans or logs the single visits once it is approved (asked, 2026-10-20:
 * "Ask first, then plan", "One named date", "Yes, planned and unplanned"). The approvers are read from the
 * organogram at the ask and stored on it (`managerApproversFor`) — the regional manager first, then the national
 * sales manager above him; the national sales manager alone where there is no regional manager. The Administrator
 * may decide either step in their place. An approved date then holds single visits on both its halves
 * (`dmSingleVisitCapError`, `manager-single-visit-cap.ts`).
 *
 * Every read and write is in ONE world: `is_test` on every query.
 */

import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { formatPhoenixLongDate } from "@/lib/i18n/format";
import { logWarning } from "@/lib/observability/log";
import {
  holdsAnExtraDay,
  isSingleVisitDayAskLive,
  isSingleVisitDayAskStatus,
  managerAskStage,
  managerPlanWeeks,
  managerWeekDays,
  MANAGER_PLAN_REASON_MAX,
  singleVisitDayAskError,
  singleVisitDayAskStatusLabel,
  type SingleVisitDayAskStatus,
} from "@/lib/phoenix-crm/manager-plan-rules";
import { personKey, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { testModeFor, worldFor, type PhoenixCrmViewer, type TestWorldRead } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, textOrNull } from "@/lib/phoenix-crm/server/db";
import { assertManagerPlanWriter, managerAskDeciderRole, managerPlanWriter, managerPlanWriterFor } from "@/lib/phoenix-crm/server/manager-plan-reach";
import { managerApproversFor } from "@/lib/phoenix-crm/server/manager-plan-writers";
import {
  loadSingleVisitDayAskRow,
  loadSingleVisitDayAsks,
  type SingleVisitDayAskRow,
} from "@/lib/phoenix-crm/server/manager-single-visit-day-rows";
import { notifyPhoenixCrm } from "@/lib/phoenix-crm/server/notifications";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { loadPlanHolidays } from "@/lib/phoenix-crm/server/plan-holidays";

type Row = Record<string, unknown>;

function record(raw: unknown): Row {
  return (raw && typeof raw === "object" ? raw : {}) as Row;
}

function noteOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length > MANAGER_PLAN_REASON_MAX) throw validationError(`Keep the note under ${MANAGER_PLAN_REASON_MAX} characters.`);
  return text.length > 0 ? text : null;
}

// ── What his screens show ───────────────────────────────────────────────────────────────────────

export type SingleVisitDayAskView = {
  requestId: string;
  visitDate: string;
  dateText: string;
  status: SingleVisitDayAskStatus;
  statusLabel: string;
  /** Optional: he may ask without writing why. */
  reason: string | null;
  /** The note of whoever refused or approved it last, when they wrote one. */
  decisionNote: string | null;
};

export type SingleVisitDaysView = {
  /** He is a district sales manager who may ask: the others' single visits are not limited. */
  canAsk: boolean;
  /** His asks for this week and the coming one, newest first. */
  asks: SingleVisitDayAskView[];
  /** The days he may still ask for. */
  askable: { date: string; dateText: string }[];
};

const EMPTY_VIEW: SingleVisitDaysView = { canAsk: false, asks: [], askable: [] };

function waitingOnOf(ask: Pick<SingleVisitDayAskRow, "status" | "approverHrId" | "secondApproverHrId">): string | null {
  if (ask.status === "pending") return ask.approverHrId;
  if (ask.status === "first_approved") return ask.secondApproverHrId;
  return null;
}

/** The dates an ask already holds — asked, passed on or approved — which no second ask may take. */
function heldDatesOf(asks: ReadonlyArray<SingleVisitDayAskRow>): Set<string> {
  return new Set(asks.filter((ask) => holdsAnExtraDay(ask.status)).map((ask) => ask.visitDate));
}

/** GET: his asks for this week and the coming one, and the days he may still ask for. */
export async function loadSingleVisitDaysView(viewer: PhoenixCrmViewer, isTest: boolean): Promise<SingleVisitDaysView> {
  const writer = managerPlanWriter(viewer);
  if (!writer || writer.kind !== "dm" || !viewer.hrId) return EMPTY_VIEW;
  const weeks = managerPlanWeeks(viewer.cairoToday);
  const days = weeks.flatMap((week) => managerWeekDays(week));
  // The holidays depend only on the two weeks, never on his asks, so they load beside them (performance
  // brief, 2026-10-23) instead of after the names.
  const [asks, holidays] = await Promise.all([
    loadSingleVisitDayAsks({ managerHrId: viewer.hrId, weekStarts: weeks, isTest }),
    days.length > 0 ? loadPlanHolidays(days[0], days[days.length - 1]) : Promise.resolve(new Map<string, string>()),
  ]);
  const names = await loadPeopleNames(asks.map(waitingOnOf));
  const held = heldDatesOf(asks);
  const canAsk = viewer.canCreate && !(viewer.isSuperAdmin && !viewer.isTestPersona);
  return {
    canAsk,
    asks: asks.map((ask) => {
      const live = isSingleVisitDayAskLive(ask.status, ask.visitDate, viewer.cairoToday);
      const waitingOn = waitingOnOf(ask);
      return {
        requestId: ask.requestId,
        visitDate: ask.visitDate,
        dateText: formatPhoenixLongDate(ask.visitDate),
        status: ask.status,
        statusLabel: singleVisitDayAskStatusLabel(ask.status, waitingOn ? nameOf(names, waitingOn, "your manager") : null, live),
        reason: ask.reason,
        decisionNote: ask.decisionNote ?? ask.firstDecisionNote,
      };
    }),
    askable: canAsk
      ? days
          .filter((date) => singleVisitDayAskError({ date, cairoToday: viewer.cairoToday, holiday: holidays.get(date) ?? null, heldDates: held }) === null)
          .map((date) => ({ date, dateText: formatPhoenixLongDate(date) }))
      : [],
  };
}

// ── Who is told ─────────────────────────────────────────────────────────────────────────────────

async function tellSingleVisitDay(input: {
  seat: OrgSeat | null;
  ask: Pick<SingleVisitDayAskRow, "requestId" | "managerHrId" | "weekStart" | "visitDate">;
  step: "single_visit_day_waiting" | "single_visit_day_decided" | "single_visit_day_expired";
  recipientHrId: string;
  actorHrId: string | null;
  version: number;
  note: string | null;
  byAdministrator: boolean;
  approved?: boolean;
  secondStep?: boolean;
  isTest: boolean;
}): Promise<void> {
  if (!input.seat) return;
  await notifyPhoenixCrm(
    {
      kind: "manager_plan",
      seat: input.seat,
      plannerKind: "dm",
      step: input.step,
      recipientHrId: input.recipientHrId,
      managerHrId: input.ask.managerHrId,
      actorHrId: input.actorHrId,
      recordId: input.ask.requestId,
      planId: null,
      weekStart: input.ask.weekStart,
      version: input.version,
      note: input.note,
      customerName: null,
      byAdministrator: input.byAdministrator,
      approved: input.approved,
      secondStep: input.secondStep,
      visitDate: input.ask.visitDate,
    },
    input.isTest,
  );
}

/** The seat his notices are filed on: the one stored on the ask, or his district manager seat now. */
function askSeat(viewer: Pick<PhoenixCrmViewer, "org" | "productManagers">, ask: Pick<SingleVisitDayAskRow, "managerSeatId" | "managerHrId">): OrgSeat | null {
  const filed = ask.managerSeatId ? viewer.org.seats.get(ask.managerSeatId) : undefined;
  if (filed) return filed;
  const writer = managerPlanWriterFor(viewer, ask.managerHrId);
  return writer?.kind === "dm" ? writer.seat : null;
}

// ── His ask ─────────────────────────────────────────────────────────────────────────────────────

/** POST: he asks for one more day of single visits, on one named date. A district sales manager only. */
export async function askSingleVisitDay(viewer: PhoenixCrmViewer, raw: unknown): Promise<SingleVisitDaysView> {
  const body = record(raw);
  const writer = assertManagerPlanWriter(viewer);
  if (writer.kind !== "dm" || !writer.seat) {
    throw forbiddenError("Only a district sales manager asks for another day of single visits. Your single visits are not limited.");
  }
  const isTest = testModeFor(viewer, body.test);
  const date = textOrNull(body.date);
  if (!date) throw validationError("Choose the day you need for single visits.");
  // Writing why is optional (owner, 2026-10-20: "make writing why optional").
  const reason = noteOf(body.reason);
  const asks = await loadSingleVisitDayAsks({ managerHrId: writer.hrId, weekStarts: managerPlanWeeks(viewer.cairoToday), isTest });
  const holidays = await loadPlanHolidays(date, date);
  const refusal = singleVisitDayAskError({ date, cairoToday: viewer.cairoToday, holiday: holidays.get(date) ?? null, heldDates: heldDatesOf(asks) });
  if (refusal) throw validationError(refusal);

  const approvers = await managerApproversFor(viewer.org, writer);
  const result = record(
    await callPhoenixCrm<Row>("phoenix_crm_raise_manager_single_visit_day", {
      p: {
        manager_hr_id: writer.hrId,
        manager_seat_id: writer.seat.seatId,
        actor_hr_id: viewer.hrId,
        visit_date: date,
        approver_hr_id: approvers.firstHrId,
        second_approver_hr_id: approvers.secondHrId,
        reason,
        is_test: isTest,
      },
    }),
  );
  const requestId = textOrNull(result.request_id);
  const weekStart = textOrNull(result.week_start)?.slice(0, 10) ?? null;
  if (requestId && weekStart && approvers.firstHrId) {
    await tellSingleVisitDay({
      seat: writer.seat,
      ask: { requestId, managerHrId: writer.hrId, weekStart, visitDate: date },
      step: "single_visit_day_waiting",
      recipientHrId: approvers.firstHrId,
      actorHrId: viewer.hrId,
      version: Number(result.version ?? 1),
      note: reason,
      byAdministrator: false,
      isTest,
    });
  }
  return loadSingleVisitDaysView(viewer, isTest);
}

// ── Their decision ──────────────────────────────────────────────────────────────────────────────

/**
 * POST: the holder of the ask's step — his regional manager first, then the national sales manager stored on
 * the ask — or the Administrator in place of either, approves the day (or passes it on) or refuses it. The
 * page names the step and the version it showed, so a step already decided is never decided again unread.
 */
export async function decideSingleVisitDay(
  viewer: PhoenixCrmViewer,
  raw: unknown,
  read?: TestWorldRead,
): Promise<{ requestId: string; status: SingleVisitDayAskStatus }> {
  const body = record(raw);
  const decision = body.decision;
  if (decision !== "approve" && decision !== "refuse") throw validationError("Choose Approve or Refuse.");
  const requestId = textOrNull(body.requestId);
  if (!requestId) throw validationError("This ask could not be read. Reload the page.");
  const isTest = worldFor(viewer, body.test, read);
  const ask = await loadSingleVisitDayAskRow(requestId);
  if (!ask || ask.isTest !== isTest) throw notFoundError("This ask for a day of single visits is no longer there. Reload the page.");
  if (!isSingleVisitDayAskLive(ask.status, ask.visitDate, viewer.cairoToday)) {
    throw conflictError(ask.status === "pending" || ask.status === "first_approved" ? "This day has passed, so the ask is closed." : "This ask has already been decided. Reload the page.");
  }
  const stage = managerAskStage(ask.status);
  if (!stage || (body.stage !== undefined && body.stage !== stage)) throw conflictError("This ask has already moved on. Reload the page.");
  const role = managerAskDeciderRole(viewer, { stage, approverHrId: ask.approverHrId, secondApproverHrId: ask.secondApproverHrId, isTest });
  if (!role) {
    throw forbiddenError(
      stage === "second"
        ? "This ask is waiting for its second approver, who decides this step."
        : "This ask is decided by the manager it was sent to.",
    );
  }
  const note = noteOf(body.note);
  if (decision === "refuse" && !note) throw validationError("Write why the day is refused, so the manager knows.");
  const expectedVersion = Number(body.version);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw validationError("This ask could not be read. Reload the page.");

  const result = record(
    await callPhoenixCrm<Row>("phoenix_crm_decide_manager_single_visit_day", {
      p: {
        request_id: requestId,
        decision,
        actor_hr_id: viewer.hrId,
        actor_role: role,
        stage,
        note,
        expected_version: expectedVersion,
        is_test: isTest,
      },
    }),
  );
  const status: SingleVisitDayAskStatus = isSingleVisitDayAskStatus(result.status) ? result.status : ask.status;
  const version = Number(result.version ?? ask.version + 1);
  const seat = askSeat(viewer, ask);
  const byAdministrator = role === "administrator";
  if (status === "first_approved" && ask.secondApproverHrId) {
    // The regional manager agreed: the national sales manager decides next. The district manager is told
    // nothing yet — his own requests list says who it waits on.
    await tellSingleVisitDay({
      seat,
      ask,
      step: "single_visit_day_waiting",
      recipientHrId: ask.secondApproverHrId,
      actorHrId: viewer.hrId,
      version,
      note: ask.reason,
      byAdministrator,
      secondStep: true,
      isTest,
    });
  } else if (status === "approved" || status === "refused") {
    await tellSingleVisitDay({
      seat,
      ask,
      step: "single_visit_day_decided",
      recipientHrId: ask.managerHrId,
      actorHrId: viewer.hrId,
      version,
      note,
      byAdministrator,
      approved: status === "approved",
      isTest,
    });
  }
  return { requestId, status };
}

// ── The daily pass ──────────────────────────────────────────────────────────────────────────────

/**
 * An ask nobody finished deciding before its day passed is closed, and the district manager is told — in-app
 * and by Telegram, never email. The rows are chosen in SQL, against the database's own Cairo day. Never throws
 * for a single notice.
 */
export async function runSingleVisitDayExpiry(): Promise<{ expired: number; told: number }> {
  const result = record(await callPhoenixCrm<Row>("phoenix_crm_expire_manager_single_visit_days", { p: {} }));
  const expired = Array.isArray(result.expired) ? result.expired.map(record) : [];
  if (expired.length === 0) return { expired: 0, told: 0 };
  logWarning("Phoenix CRM closed district-manager asks for a day of single visits that had passed", {
    labels: { event: "phoenix_crm_manager_single_visit_day_expired", count: String(expired.length) },
  });
  const org = await loadPhoenixCrmOrg();
  let told = 0;
  for (const row of expired) {
    const managerHrId = personKey(textOrNull(row.manager_hr_id));
    const requestId = textOrNull(row.request_id);
    const visitDate = textOrNull(row.visit_date)?.slice(0, 10) ?? null;
    const weekStart = textOrNull(row.week_start)?.slice(0, 10) ?? null;
    if (!managerHrId || !requestId || !visitDate || !weekStart) continue;
    const seat = askSeat({ org, productManagers: [] }, { managerSeatId: textOrNull(row.manager_seat_id), managerHrId });
    try {
      await tellSingleVisitDay({
        seat,
        ask: { requestId, managerHrId, weekStart, visitDate },
        step: "single_visit_day_expired",
        recipientHrId: managerHrId,
        actorHrId: null,
        version: 0,
        note: null,
        byAdministrator: false,
        isTest: row.is_test === true,
      });
      told += 1;
    } catch {
      // One notice failing never stops the pass; the row is already closed.
    }
  }
  return { expired: expired.length, told };
}
