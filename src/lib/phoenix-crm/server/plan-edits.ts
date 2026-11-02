/**
 * Phoenix CRM — one week at a time, and asking to edit a week that is already sent.
 *
 * Owner, 2026-10-01, after the first Delta (1) session on the plan board:
 *   - a rep plans ONE week, the week that begins on the coming Saturday (calendar.ts `repPlanWeek`).
 *     He cannot enter a week that has passed or a week ahead of it. `assertRepMayChangeWeek` is that
 *     rule on the server: every save and every send of a week goes through it;
 *   - a SENT week is no longer taken back by the rep. He asks to edit it — one button, no reason, and
 *     TWICE A WEEK AT MOST (owner, 2026-10-20; `raisePlanEdit` counts every request raised on the week) —
 *     and the request runs: his district manager approves, then SFE approves, then HR (Omar Gawish)
 *     acknowledges; only then does the week open again (`phoenix_crm_decide_plan_edit_request`
 *     reopens it inside the same transaction). One refusal ends it;
 *   - two other weeks open for him, both by somebody else's act: one his manager RETURNED, and one an
 *     edit request REOPENED (plan-rules.ts `repWeekState`);
 *   - and the week he is IN while he has never sent it (owner, 2026-10-02): a rep who missed the
 *     deadline still sends it, late and stamped late, from today's day on.
 *
 * The STEP a decision is taken at is read from the row, never from the request, and the database
 * refuses the wrong step as well (`plan_edit_wrong_stage`), so the two guards agree rather than one
 * trusting the other.
 */

import { addDaysIso } from "@/lib/crm/dates";
import { conflictError, notFoundError, validationError } from "@/lib/http/api-errors";
import { formatPhoenixLongDate } from "@/lib/i18n/format";
import { editablePlanDays, fieldWeekStart, repPlanWeek } from "@/lib/phoenix-crm/calendar";
import {
  isPlanEditStatus,
  isPlanEditWaiting,
  PLAN_EDIT_ASKS_USED_UP,
  PLAN_EDIT_NOTE_MAX,
  PLAN_EDIT_WAITING_STATUSES,
  planEditDecisionsFor,
  planEditAsksLeft,
  planEditFirstStatus,
  planEditStageOf,
  planEditStatusLabel,
  type PlanEditStage,
  type PlanEditStatus,
} from "@/lib/phoenix-crm/plan-edit-rules";
import { isUuid, planStatusLine, repChangeableDays, repWeekState, standingReturnedDay, type RepWeekState } from "@/lib/phoenix-crm/plan-rules";
import { territoryReviewer, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { assertPlanEditApprover, canDecidePlanEdit, canOverrideDecision, territoryForRepWrite, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, chunk, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { notifyPhoenixCrm } from "@/lib/phoenix-crm/server/notifications";
import { loadPeopleNames, nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";
import type { PhoenixCrmPlanStatus } from "@/lib/phoenix-crm/types";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/** How many batches of requests one read keeps in flight at once (2026-10-16 speed audit). */
const PLAN_EDIT_READ_CONCURRENCY = 4;

function record(raw: unknown): Row {
  return (raw && typeof raw === "object" ? raw : {}) as Row;
}

function planStatusOf(value: unknown): PhoenixCrmPlanStatus | null {
  return value === "draft" || value === "submitted" || value === "approved" || value === "returned" ? value : null;
}

const REQUEST_COLUMNS =
  "id, plan_id, seat_id, week_start, rep_hr_id, status, version, created_at, decided_at, " +
  "manager_decided_by_hr_id, manager_decided_at, manager_note, sfe_decided_by_hr_id, sfe_decided_at, sfe_note, " +
  "hr_acknowledged_by_hr_id, hr_acknowledged_at, admin_decided_by_hr_id, admin_decided_at, admin_note, is_test, plan:phoenix_crm_plans!plan_id(status, version)";

/** One request to edit a week, as a screen shows it. */
export type PlanEditRequestView = {
  requestId: string;
  planId: string;
  seatId: string;
  weekStart: string;
  weekLabel: string;
  repName: string;
  status: PlanEditStatus;
  statusLabel: string;
  /** Which step it is waiting on, or null once it is settled. */
  stage: PlanEditStage | null;
  version: number;
  raisedAt: string;
  /** The week's own status now — a manager can still Return a week while a request is on its way. */
  planStatusLabel: string;
  managerDecidedByName: string | null;
  managerNote: string | null;
  sfeDecidedByName: string | null;
  sfeNote: string | null;
  hrAcknowledgedByName: string | null;
  /** The Administrator's decline, when it was he who ended the request: his note (his name is never shown). */
  administratorNote: string | null;
  administratorDeclined: boolean;
  /** When the week was opened (SFE's approval) — what tells an edit that opened the week from a one-day return after it. */
  hrAcknowledgedAt: string | null;
};

/** The hr ids a batch of rows needs names for. */
export function planEditPeople(rows: ReadonlyArray<Row>): Array<string | null> {
  return rows.flatMap((row) => [
    textOrNull(row.rep_hr_id),
    textOrNull(row.manager_decided_by_hr_id),
    textOrNull(row.sfe_decided_by_hr_id),
    textOrNull(row.hr_acknowledged_by_hr_id),
    textOrNull(row.admin_decided_by_hr_id),
  ]);
}

export function mapPlanEditRow(row: Row, names: PeopleNames): PlanEditRequestView {
  const status: PlanEditStatus = isPlanEditStatus(row.status) ? row.status : "manager_pending";
  const plan = record(Array.isArray(row.plan) ? row.plan[0] : row.plan);
  const person = (value: unknown) => {
    const hrId = textOrNull(value);
    return hrId ? nameOf(names, hrId) : null;
  };
  const weekStart = String(row.week_start);
  return {
    requestId: String(row.id),
    planId: String(row.plan_id),
    seatId: String(row.seat_id),
    weekStart,
    weekLabel: `Week starting ${formatPhoenixLongDate(weekStart)}`,
    repName: nameOf(names, textOrNull(row.rep_hr_id)),
    status,
    statusLabel: planEditStatusLabel(status),
    stage: planEditStageOf(status),
    version: Number(row.version),
    raisedAt: String(row.created_at),
    // "The week now:" on the edit-request card names the rep whose week it is (owner, 2026-10-08).
    // This mapper has no org index, so the reviewer is not resolvable here and a submitted or approved
    // week keeps its bare word — `planStatusLine` falls back on its own rather than inventing a name.
    planStatusLabel: planStatusLine({ status: planStatusOf(plan.status), repName: nameOf(names, textOrNull(row.rep_hr_id)) }),
    managerDecidedByName: person(row.manager_decided_by_hr_id),
    managerNote: textOrNull(row.manager_note),
    sfeDecidedByName: person(row.sfe_decided_by_hr_id),
    sfeNote: textOrNull(row.sfe_note),
    hrAcknowledgedByName: person(row.hr_acknowledged_by_hr_id),
    administratorNote: textOrNull(row.admin_note),
    administratorDeclined: textOrNull(row.admin_decided_by_hr_id) !== null,
    hrAcknowledgedAt: textOrNull(row.hr_acknowledged_at),
  };
}

/** The screen's twin: may this viewer act on this row as it stands right now? */
export function canDecidePlanEditRow(viewer: PhoenixCrmViewer, seat: OrgSeat, isTest: boolean, status: PlanEditStatus): boolean {
  const stage = planEditStageOf(status);
  return stage !== null && canDecidePlanEdit(viewer, seat, isTest, stage);
}

/**
 * Waiting requests for a set of territories, the longest-waiting first. A request whose week has
 * passed is left out — there is nothing left to change, and a late decision on it only closes it.
 */
export async function loadPlanEditRows(seatIds: ReadonlyArray<string>, isTest: boolean, cairoToday: string): Promise<Row[]> {
  if (seatIds.length === 0) return [];
  // The earliest Saturday whose week still has a day from today on (its Thursday is today or later).
  const lastLiveWeek = addDaysIso(cairoToday, -5);
  // A few batches at a time, never one after another (2026-10-16 speed audit); sorted below either way.
  const pages = await mapWithConcurrency(chunk([...seatIds]), PLAN_EDIT_READ_CONCURRENCY, async (batch) => {
    const { data, error } = await getSupabaseAdmin()
      .from("phoenix_crm_plan_edit_requests")
      .select(REQUEST_COLUMNS)
      .in("seat_id", batch)
      .eq("is_test", isTest)
      .in("status", [...PLAN_EDIT_WAITING_STATUSES])
      .gte("week_start", lastLiveWeek);
    throwIfError(error);
    return (data ?? []) as unknown as Row[];
  });
  return pages.flat().sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
}

/**
 * Per plan: the request a week's own panel shows — the one on its way, else the latest settled — and how
 * many requests were ever raised on it, every outcome counted (two a week at most, owner 2026-10-20).
 */
export type PlanEditState = { waiting: PlanEditRequestView | null; latest: PlanEditRequestView | null; asked: number };

export async function loadPlanEditState(
  planIds: ReadonlyArray<string>,
  isTest: boolean,
  options: { names?: boolean; rows?: ReadonlyArray<Row> } = {},
): Promise<Map<string, PlanEditState>> {
  const state = new Map<string, PlanEditState>();
  if (planIds.length === 0) return state;
  const wanted = new Set(planIds);
  // A caller that already holds the requests — the planned-day bundle reads them in the same statement as
  // the plan (2 Nov 2026) — hands them in, each row in `REQUEST_COLUMNS`' shape, and nothing is read.
  // Otherwise a few batches at a time, never one after another (2026-10-16 speed audit), in batch order.
  const pages = options.rows
    ? [options.rows.filter((row) => wanted.has(String(row.plan_id)) && row.is_test === isTest)]
    : await mapWithConcurrency(chunk([...planIds]), PLAN_EDIT_READ_CONCURRENCY, async (batch) => {
        const { data, error } = await getSupabaseAdmin()
          .from("phoenix_crm_plan_edit_requests")
          .select(REQUEST_COLUMNS)
          .in("plan_id", batch)
          .eq("is_test", isTest);
        throwIfError(error);
        return (data ?? []) as unknown as Row[];
      });
  const rows = pages.flat();
  // The people who decided are the screen's to name; the server's own check needs no names.
  const names: PeopleNames = rows.length > 0 && options.names !== false ? await loadPeopleNames(planEditPeople(rows)) : new Map();
  rows.sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
  for (const row of rows) {
    const planId = String(row.plan_id);
    const view = mapPlanEditRow(row, names);
    const entry = state.get(planId) ?? { waiting: null, latest: null, asked: 0 };
    entry.asked += 1;
    if (!entry.latest) entry.latest = view;
    if (!entry.waiting && isPlanEditWaiting(view.status)) entry.waiting = view;
    state.set(planId, entry);
  }
  return state;
}

/** When HR acknowledged the week's latest request, if that request is the one that reopened it. */
export function editAcknowledgedAt(edit: PlanEditState | null): string | null {
  return edit?.latest?.status === "reopened" ? edit.latest.hrAcknowledgedAt : null;
}

/** The rep's state for one week, from its plan row and its requests. */
export function repStateOf(input: {
  weekStart: string;
  cairoToday: string;
  status: PhoenixCrmPlanStatus | null;
  edit: PlanEditState | null;
}): RepWeekState {
  const open = editablePlanDays(input.weekStart, input.cairoToday).length > 0;
  return repWeekState({
    weekStart: input.weekStart,
    open,
    status: input.status,
    repWeek: repPlanWeek(input.cairoToday),
    runningWeek: fieldWeekStart(input.cairoToday),
    editAsked: Boolean(input.edit?.waiting),
    editReopened: input.edit?.latest?.status === "reopened",
  });
}

/** What the rep may change of a week he may plan: the days, and the one day returned when only one was. */
export type RepWeekAccess = {
  /** The ONLY days a save may touch — every day from today on, or the one returned day while it stands. */
  editableDays: string[];
  /** The ONE day his manager returned, while it stands (owner, 2026-10-02: "Only that day"); else null. */
  returnedDay: string | null;
};

/**
 * 🔴 THE RULE ON THE SERVER: a rep saves and sends ONE week — the one he plans now, or one his manager
 * returned or an edit request reopened. Called before every save and every send of a week; a phone one
 * release behind, or a hand-made request, meets the same refusal the greyed week shows.
 *
 * It answers with the days he may change (owner, 2026-10-02): a week his manager returned for ONE day
 * opens that day alone, and `savePlan` hands the database nothing else to touch — so the days left as
 * he sent them are refused on the server, not merely greyed on his board.
 */
export async function assertRepMayChangeWeek(
  viewer: PhoenixCrmViewer,
  seat: OrgSeat,
  isTest: boolean,
  weekStart: string,
  /**
   * The week's own plan row, when the caller has just read it — carrying at least `id, status,
   * returned_day, decided_at`. A send reads the plan by its id a moment before (plans.ts
   * `transitionPlan`), so it hands that row over rather than reading the same row again (2026-10-16
   * speed audit). Left out, the guard reads it itself, as it always has.
   */
  readRow?: Row,
): Promise<RepWeekAccess> {
  let planRow: Row | null;
  if (readRow) {
    planRow = readRow;
  } else {
    const { data, error } = await getSupabaseAdmin()
      .from("phoenix_crm_plans")
      .select("id, status, returned_day, decided_at")
      .eq("seat_id", seat.seatId)
      .eq("is_test", isTest)
      .eq("week_start", weekStart)
      .maybeSingle();
    throwIfError(error);
    planRow = data as Row | null;
  }
  const status = planRow ? planStatusOf(planRow.status) : null;
  const storedDay = planRow && status === "returned" ? textOrNull(planRow.returned_day) : null;
  let edit: PlanEditState | null = null;
  // A draft may be one an edit request reopened; a week returned for one day may since have been opened
  // whole by an acknowledged edit. Both answers are on the week's requests.
  if (planRow && (status === "draft" || storedDay !== null)) {
    edit = (await loadPlanEditState([String(planRow.id)], isTest, { names: false })).get(String(planRow.id)) ?? null;
  }
  const state = repStateOf({ weekStart, cairoToday: viewer.cairoToday, status, edit });
  if (state === "plan") {
    const returnedDay = standingReturnedDay({
      status,
      returnedDay: storedDay,
      decidedAt: planRow ? textOrNull(planRow.decided_at) : null,
      editAcknowledgedAt: editAcknowledgedAt(edit),
    });
    return { editableDays: repChangeableDays({ weekStart, cairoToday: viewer.cairoToday, returnedDay }), returnedDay };
  }
  if (state === "sent" || state === "asked") {
    throw conflictError("This week is already sent. To change it, ask to edit this week. Reload the planner.");
  }
  const openWeek = repPlanWeek(viewer.cairoToday);
  throw conflictError(`You plan one week at a time: the week starting ${formatPhoenixLongDate(openWeek)}. Reload the planner.`);
}

// ── The rep asks ────────────────────────────────────────────────────────────────────────────────

export type PlanEditResult = { requestId: string; status: PlanEditStatus; version: number };

/** "Ask to edit this week" — one button, no reason (owner, 2026-10-01). */
export async function raisePlanEdit(viewer: PhoenixCrmViewer, raw: unknown): Promise<PlanEditResult> {
  const body = record(raw);
  if (!isUuid(body.planId)) throw validationError("Choose the week. Reload the page.");
  const planId = String(body.planId).toLowerCase();
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw validationError("Reload the plan and try again.");

  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_plans")
    .select("id, seat_id, week_start, status, is_test")
    .eq("id", planId)
    .maybeSingle();
  throwIfError(error);
  const planRow = data as Row | null;
  if (!planRow) throw notFoundError("This plan is no longer there. Reload the page.");
  const seat = viewer.org.seats.get(String(planRow.seat_id));
  if (!seat) throw notFoundError("This territory is no longer in the organogram. Reload the page.");
  const isTest = planRow.is_test === true;
  // The gate ANSWERS with the world this viewer writes in, and the plan found by id must be in it — a
  // real plan reached by its id from a test login is not his to ask about, so it reads as not there.
  if (territoryForRepWrite(viewer, seat.seatId, isTest).isTest !== isTest) {
    throw notFoundError("This plan is no longer there. Reload the page.");
  }
  const weekStart = String(planRow.week_start);
  if (editablePlanDays(weekStart, viewer.cairoToday).length === 0) throw conflictError("This week is over. Reload the planner.");

  // 🔴 TWICE A WEEK AT MOST (owner, 2026-10-20). Every request ever raised on this week counts — refused,
  // expired and reopened alike — so this count reads the week's requests with no status filter. Two
  // presses at once still end at two: the database lets only one request wait on a week at a time, under
  // the plan's own lock (`plan_edit_already_open`).
  const { count: asked, error: askedError } = await getSupabaseAdmin()
    .from("phoenix_crm_plan_edit_requests")
    .select("id", { count: "exact", head: true })
    .eq("plan_id", planId)
    .eq("is_test", isTest);
  throwIfError(askedError);
  if (planEditAsksLeft(asked ?? 0) === 0) throw conflictError(PLAN_EDIT_ASKS_USED_UP);

  const reviewer = territoryReviewer(viewer.org, seat.seatId);
  const result = await callPhoenixCrm<Row>("phoenix_crm_raise_plan_edit_request", {
    p: {
      plan_id: planId,
      actor_hr_id: viewer.hrId,
      first_status: planEditFirstStatus(reviewer !== null),
      manager_hr_id: reviewer?.hrId ?? null,
      expected_plan_version: expectedVersion,
      is_test: isTest,
    },
  });
  const status: PlanEditStatus = isPlanEditStatus(result.status) ? result.status : "manager_pending";
  const requestId = String(result.request_id);
  const version = Number(result.version);
  await notifyPhoenixCrm(
    { kind: "plan_edit", org: viewer.org, seat, requestId, version, weekStart, status, repHrId: viewer.hrId, actorHrId: viewer.hrId, note: null },
    isTest,
  );
  return { requestId, status, version };
}

// ── Each step decides ───────────────────────────────────────────────────────────────────────────

/**
 * The district manager approves or refuses, then SFE does — and SFE's approval reopens the week. The
 * STEP is read from the row, never from the request. The Administrator is no step: he may APPROVE or
 * DECLINE a request waiting at either one, in the holder's place (owner, 2026-10-14; before that he could
 * only decline, with a note the rep reads, 2026-10-08).
 */
export async function decidePlanEdit(viewer: PhoenixCrmViewer, raw: unknown): Promise<PlanEditResult> {
  const body = record(raw);
  if (!isUuid(body.requestId)) throw validationError("Choose the request. Reload the page.");
  const requestId = String(body.requestId).toLowerCase();
  const decision = body.decision === "approve" || body.decision === "refuse" ? body.decision : null;
  if (!decision) throw validationError("Choose what to do with the request.");
  const note = String(body.note ?? "").trim().replace(/\s+/g, " ") || null;
  if (note !== null && note.length > PLAN_EDIT_NOTE_MAX) throw validationError(`Keep the note under ${PLAN_EDIT_NOTE_MAX} characters.`);
  if (decision === "refuse" && note === null) throw validationError("Write a note explaining why.");
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw validationError("Reload the page and try again.");

  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_plan_edit_requests")
    .select("id, plan_id, seat_id, week_start, rep_hr_id, status, is_test")
    .eq("id", requestId)
    .maybeSingle();
  throwIfError(error);
  const row = data as Row | null;
  if (!row) throw notFoundError("This request is no longer there. Reload the page.");
  const isTest = row.is_test === true;
  const seat = viewer.org.seats.get(String(row.seat_id));
  if (!seat) throw notFoundError("This territory is no longer in the organogram. Reload the page.");
  const status: PlanEditStatus = isPlanEditStatus(row.status) ? row.status : "refused";
  const stage = planEditStageOf(status);
  if (stage === null) throw conflictError("This request was already decided. Reload the page.");
  // The Administrator approves or declines at whichever step it waits at (owner, 2026-10-14). His decline
  // is recorded as his own stage; his approval takes the step the row is AT, exactly as that step's
  // holder would, and the database writes it as his act.
  const asAdministrator = canOverrideDecision(viewer, isTest);
  if (!asAdministrator) {
    assertPlanEditApprover(viewer, seat, isTest, stage);
    if (!planEditDecisionsFor(stage).includes(decision)) throw validationError("Approve or refuse this step.");
  }

  const result = await callPhoenixCrm<Row>("phoenix_crm_decide_plan_edit_request", {
    p: {
      request_id: requestId,
      stage: asAdministrator && decision === "refuse" ? "administrator" : stage,
      decision,
      actor_hr_id: viewer.hrId,
      actor_role: asAdministrator ? "administrator" : viewer.role,
      note,
      expected_version: expectedVersion,
      is_test: isTest,
    },
  });
  const nextStatus: PlanEditStatus = isPlanEditStatus(result.status) ? result.status : status;
  const version = Number(result.version);
  await notifyPhoenixCrm(
    {
      kind: "plan_edit",
      org: viewer.org,
      seat,
      requestId,
      version,
      weekStart: String(row.week_start),
      status: nextStatus,
      repHrId: String(row.rep_hr_id),
      actorHrId: viewer.hrId,
      note,
    },
    isTest,
  );
  return { requestId, status: nextStatus, version };
}
