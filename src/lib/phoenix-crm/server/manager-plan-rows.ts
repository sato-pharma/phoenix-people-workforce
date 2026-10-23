/**
 * Phoenix CRM — the manager's weekly plan as it is stored: the row shapes and the plain reads. A district
 * manager's since 2026-10-16; a regional, national or product manager's too since 2026-10-17.
 *
 * 🔴 NO NOTICE SENDER IS IMPORTED HERE, AND NONE MAY BE. The Approvals Hub reads these rows
 * (`manager-plan-queue.ts`), and the Hub's own reader is imported by the notification layer's actionable
 * check — so a sender pulled in here closes the import cycle through `notifications/in-app.ts`. The
 * writes and their notices live in `manager-plans.ts`.
 */

import { weeklyPlanDueOn } from "@/lib/phoenix-crm/calendar";
import {
  isManagerHalf,
  isManagerPlannerKind,
  isManagerPlanStatus,
  isManagerSlotKind,
  parseManagerDmVisit,
  parseManagerSeniorVisit,
  type ManagerDmVisit,
  type ManagerSeniorVisit,
  type ManagerHalf,
  type ManagerPlannerKind,
  type ManagerPlanStage,
  type ManagerPlanStatus,
  type ManagerSlotKind,
} from "@/lib/phoenix-crm/manager-plan-rules";
import { personKey } from "@/lib/phoenix-crm/scope";
import { chunk, dedupeIds, textOrNull } from "@/lib/phoenix-crm/server/db";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function record(raw: unknown): Row {
  return (raw && typeof raw === "object" ? raw : {}) as Row;
}

function dayOf(value: unknown): string | null {
  const text = textOrNull(value);
  return text ? text.slice(0, 10) : null;
}

// ── The stored rows ─────────────────────────────────────────────────────────────────────────────

export type ManagerPlanRow = {
  planId: string;
  managerHrId: string;
  /** Null only for a product manager, who holds no seat (owner, 2026-10-17). */
  managerSeatId: string | null;
  /** Who plans the week: "dm" for every week written before 2026-10-17. */
  plannerKind: ManagerPlannerKind;
  lineCode: string | null;
  weekStart: string;
  status: ManagerPlanStatus;
  version: number;
  dueOn: string;
  submittedAt: string | null;
  submittedLate: boolean | null;
  firstApproverHrId: string | null;
  secondApproverHrId: string | null;
  firstDecidedAt: string | null;
  firstDecidedByHrId: string | null;
  firstDecidedRole: string | null;
  firstDecisionNote: string | null;
  decidedAt: string | null;
  decidedByHrId: string | null;
  decidedByRole: string | null;
  decisionNote: string | null;
  returnedDay: string | null;
  returnedStage: ManagerPlanStage | null;
  /**
   * HR acknowledged the approved week by itself — never on a district manager's, and read only on an APPROVED
   * week: the acknowledgement belongs to that approval, so a week reopened or returned since (whose stamp the
   * database clears, 20261018234000) can never read as acknowledged.
   */
  hrAcknowledgedAt: string | null;
  isTest: boolean;
};

export const MANAGER_PLAN_COLUMNS =
  "id, manager_hr_id, manager_seat_id, planner_kind, line_code, week_start, status, version, due_on, submitted_at, submitted_late, first_approver_hr_id, second_approver_hr_id, first_decided_at, first_decided_by_hr_id, first_decided_role, first_decision_note, decided_at, decided_by_hr_id, decided_by_role, decision_note, returned_day, returned_stage, hr_acknowledged_at, is_test";

export function managerPlanRowOf(raw: unknown): ManagerPlanRow | null {
  const row = record(raw);
  const planId = textOrNull(row.id);
  const managerHrId = personKey(textOrNull(row.manager_hr_id));
  const weekStart = dayOf(row.week_start);
  if (!planId || !managerHrId || !weekStart) return null;
  const stage = row.returned_stage === "first" || row.returned_stage === "second" ? row.returned_stage : null;
  const status: ManagerPlanStatus = isManagerPlanStatus(row.status) ? row.status : "draft";
  return {
    planId,
    managerHrId,
    managerSeatId: textOrNull(row.manager_seat_id),
    plannerKind: isManagerPlannerKind(row.planner_kind) ? row.planner_kind : "dm",
    lineCode: textOrNull(row.line_code),
    weekStart,
    status,
    version: Number(row.version ?? 1),
    dueOn: dayOf(row.due_on) ?? weeklyPlanDueOn(weekStart),
    submittedAt: textOrNull(row.submitted_at),
    submittedLate: typeof row.submitted_late === "boolean" ? row.submitted_late : null,
    firstApproverHrId: personKey(textOrNull(row.first_approver_hr_id)),
    secondApproverHrId: personKey(textOrNull(row.second_approver_hr_id)),
    firstDecidedAt: textOrNull(row.first_decided_at),
    firstDecidedByHrId: personKey(textOrNull(row.first_decided_by_hr_id)),
    firstDecidedRole: textOrNull(row.first_decided_role),
    firstDecisionNote: textOrNull(row.first_decision_note),
    decidedAt: textOrNull(row.decided_at),
    decidedByHrId: personKey(textOrNull(row.decided_by_hr_id)),
    decidedByRole: textOrNull(row.decided_by_role),
    decisionNote: textOrNull(row.decision_note),
    returnedDay: dayOf(row.returned_day),
    returnedStage: stage,
    hrAcknowledgedAt: status === "approved" ? textOrNull(row.hr_acknowledged_at) : null,
    isTest: row.is_test === true,
  };
}

/** One plan by its id, in one world. Null when there is none. */
export async function loadManagerPlanRow(planId: string, isTest: boolean | null): Promise<ManagerPlanRow | null> {
  const rows = await fetchAllRowsKeyset<Row>(
    () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let query: any = getSupabaseAdmin().from("phoenix_crm_manager_plans").select(MANAGER_PLAN_COLUMNS).eq("id", planId);
      if (isTest !== null) query = query.eq("is_test", isTest);
      return query;
    },
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  return rows.length > 0 ? managerPlanRowOf(rows[0]) : null;
}

/** These managers' plans for one week, in one world. */
export async function loadWeekPlanRows(managerHrIds: ReadonlyArray<string>, weekStart: string, isTest: boolean): Promise<ManagerPlanRow[]> {
  const out: ManagerPlanRow[] = [];
  for (const part of chunk(dedupeIds(managerHrIds), 100)) {
    const rows = await fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_manager_plans")
          .select(MANAGER_PLAN_COLUMNS)
          .in("manager_hr_id", part)
          .eq("week_start", weekStart)
          .eq("is_test", isTest),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
    for (const row of rows) {
      const plan = managerPlanRowOf(row);
      if (plan) out.push(plan);
    }
  }
  return out;
}

export type ManagerSlotRow = {
  slotId: string;
  planId: string;
  date: string;
  half: ManagerHalf;
  kind: ManagerSlotKind;
  repSeatId: string | null;
  repHrId: string | null;
  activityType: string | null;
  areaSeatId: string | null;
  areaCode: string | null;
  areaName: string | null;
  /** The district manager seat he picked for this half — a regional, national or product manager only. */
  scopeDmSeatId: string | null;
  /** That district's line, or the line a product manager picked with no district manager. */
  scopeLineCode: string | null;
  /** With a district manager (owner, 2026-10-23): who he goes with and the areas he ticked. Null on every other kind. */
  dmVisit: ManagerDmVisit | null;
  /** With my manager or product manager (owner, 2026-10-23): a district manager's pick and the areas he ticked. Null on every other kind. */
  seniorVisit: ManagerSeniorVisit | null;
  note: string | null;
};

const SLOT_COLUMNS =
  "id, plan_id, plan_date, half, kind, rep_seat_id, rep_hr_id, activity_type, area_seat_id, area_code, area_name, scope_dm_seat_id, scope_line_code, dm_visit, senior_visit, note";

function slotRowOf(raw: unknown): ManagerSlotRow | null {
  const row = record(raw);
  const slotId = textOrNull(row.id);
  const planId = textOrNull(row.plan_id);
  const date = dayOf(row.plan_date);
  if (!slotId || !planId || !date || !isManagerHalf(row.half) || !isManagerSlotKind(row.kind)) return null;
  return {
    slotId,
    planId,
    date,
    half: row.half,
    kind: row.kind,
    repSeatId: textOrNull(row.rep_seat_id),
    repHrId: personKey(textOrNull(row.rep_hr_id)),
    activityType: textOrNull(row.activity_type),
    areaSeatId: textOrNull(row.area_seat_id),
    areaCode: textOrNull(row.area_code),
    areaName: textOrNull(row.area_name),
    scopeDmSeatId: textOrNull(row.scope_dm_seat_id),
    scopeLineCode: textOrNull(row.scope_line_code),
    dmVisit: row.kind === "with_dm" ? parseManagerDmVisit(row.dm_visit) : null,
    seniorVisit: row.kind === "with_senior" ? parseManagerSeniorVisit(row.senior_visit) : null,
    note: textOrNull(row.note),
  };
}

/** The half-days of these plans. */
export async function loadManagerSlotRows(planIds: ReadonlyArray<string>): Promise<ManagerSlotRow[]> {
  const out: ManagerSlotRow[] = [];
  for (const part of chunk(dedupeIds(planIds), 100)) {
    const rows = await fetchAllRowsKeyset<Row>(
      () => getSupabaseAdmin().from("phoenix_crm_manager_plan_slots").select(SLOT_COLUMNS).in("plan_id", part),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
    for (const row of rows) {
      const slot = slotRowOf(row);
      if (slot) out.push(slot);
    }
  }
  return out;
}

/** A customer he planned for a half-day: a rep's own, or one of Manager's own list. */
export type ManagerSlotCustomerRow = {
  slotId: string;
  customerId: string | null;
  managerCustomerId: string | null;
  sourceSeatId: string | null;
  listType: string | null;
  name: string;
  grade: string | null;
  potentialGrade: string | null;
  speciality: string | null;
  /** The customer has since left the list (a rep's) or come off his own list. */
  gone: boolean;
};

const SLOT_CUSTOMER_COLUMNS =
  "id, slot_id, customer_id, manager_customer_id, source_seat_id, list_type, " +
  "customer:phoenix_crm_customers!customer_id(name, grade, speciality, status), " +
  "own:phoenix_crm_manager_customers!manager_customer_id(name, grade, potential_grade, speciality, status)";

/** The customers planned on these half-days, each with its name and grade as they are now. */
export async function loadManagerSlotCustomers(slotIds: ReadonlyArray<string>): Promise<ManagerSlotCustomerRow[]> {
  const out: ManagerSlotCustomerRow[] = [];
  for (const part of chunk(dedupeIds(slotIds), 100)) {
    const rows = await fetchAllRowsKeyset<Row>(
      () => getSupabaseAdmin().from("phoenix_crm_manager_plan_customers").select(SLOT_CUSTOMER_COLUMNS).in("slot_id", part),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
    for (const raw of rows) {
      const slotId = textOrNull(raw.slot_id);
      if (!slotId) continue;
      const customerId = textOrNull(raw.customer_id);
      const managerCustomerId = textOrNull(raw.manager_customer_id);
      const customer = record(customerId ? raw.customer : raw.own);
      const status = textOrNull(customer.status);
      out.push({
        slotId,
        customerId,
        managerCustomerId,
        sourceSeatId: textOrNull(raw.source_seat_id),
        listType: textOrNull(raw.list_type),
        name: textOrNull(customer.name) ?? "A customer no longer on file",
        grade: textOrNull(customer.grade),
        potentialGrade: textOrNull(customer.potential_grade),
        speciality: textOrNull(customer.speciality),
        gone: customerId ? status !== "active" && status !== "pending" : status === "removed",
      });
    }
  }
  return out;
}

export type ManagerEditAskStatus = "pending" | "first_approved" | "reopened" | "refused" | "expired";

export type ManagerEditAskRow = {
  requestId: string;
  planId: string;
  managerHrId: string;
  weekStart: string;
  approverHrId: string;
  /** The national sales manager who decides after a regional approver (owner, 2026-10-17); null: one step. */
  secondApproverHrId: string | null;
  reason: string;
  /** "first_approved": the regional manager agreed, and it waits on the second approver. */
  status: ManagerEditAskStatus;
  firstDecidedAt: string | null;
  firstDecidedByHrId: string | null;
  firstDecidedRole: string | null;
  firstDecisionNote: string | null;
  decidedAt: string | null;
  decidedByHrId: string | null;
  decidedRole: string | null;
  decisionNote: string | null;
  version: number;
  isTest: boolean;
  createdAt: string | null;
};

export const EDIT_ASK_COLUMNS =
  "id, plan_id, manager_hr_id, week_start, approver_hr_id, second_approver_hr_id, reason, status, first_decided_at, first_decided_by_hr_id, first_decided_role, first_decision_note, decided_at, decided_by_hr_id, decided_role, decision_note, version, is_test, created_at";

const EDIT_ASK_STATUSES: ReadonlySet<unknown> = new Set(["pending", "first_approved", "reopened", "refused", "expired"]);

export function editAskRowOf(raw: unknown): ManagerEditAskRow | null {
  const row = record(raw);
  const requestId = textOrNull(row.id);
  const planId = textOrNull(row.plan_id);
  const managerHrId = personKey(textOrNull(row.manager_hr_id));
  const approverHrId = personKey(textOrNull(row.approver_hr_id));
  const weekStart = dayOf(row.week_start);
  if (!requestId || !planId || !managerHrId || !approverHrId || !weekStart) return null;
  if (!EDIT_ASK_STATUSES.has(row.status)) return null;
  return {
    requestId,
    planId,
    managerHrId,
    weekStart,
    approverHrId,
    secondApproverHrId: personKey(textOrNull(row.second_approver_hr_id)),
    reason: textOrNull(row.reason) ?? "",
    status: row.status as ManagerEditAskStatus,
    firstDecidedAt: textOrNull(row.first_decided_at),
    firstDecidedByHrId: personKey(textOrNull(row.first_decided_by_hr_id)),
    firstDecidedRole: textOrNull(row.first_decided_role),
    firstDecisionNote: textOrNull(row.first_decision_note),
    decidedAt: textOrNull(row.decided_at),
    decidedByHrId: personKey(textOrNull(row.decided_by_hr_id)),
    decidedRole: textOrNull(row.decided_role),
    decisionNote: textOrNull(row.decision_note),
    version: Number(row.version ?? 1),
    isTest: row.is_test === true,
    createdAt: textOrNull(row.created_at),
  };
}

/** The asks to edit raised on these plans, newest first. */
export async function loadEditAsks(planIds: ReadonlyArray<string>): Promise<ManagerEditAskRow[]> {
  if (planIds.length === 0) return [];
  const rows = await fetchAllRowsKeyset<Row>(
    () => getSupabaseAdmin().from("phoenix_crm_manager_plan_edit_requests").select(EDIT_ASK_COLUMNS).in("plan_id", dedupeIds(planIds)),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  return rows
    .map(editAskRowOf)
    .filter((row): row is ManagerEditAskRow => row !== null)
    .sort((left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")));
}

/** One ask to edit by its id. */
export async function loadEditAskRow(requestId: string): Promise<ManagerEditAskRow | null> {
  const rows = await fetchAllRowsKeyset<Row>(
    () => getSupabaseAdmin().from("phoenix_crm_manager_plan_edit_requests").select(EDIT_ASK_COLUMNS).eq("id", requestId),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  return rows.length > 0 ? editAskRowOf(rows[0]) : null;
}
