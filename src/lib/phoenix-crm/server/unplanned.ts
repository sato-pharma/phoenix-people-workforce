/**
 * Phoenix CRM — the off-plan visits waiting for a decision, and deciding one.
 *
 * Owner, 2026-09-26: a rep may visit a doctor who is not on today's plan, but he writes why, and the
 * visit counts in NOTHING until his direct manager approves it and then the SFE does. One refusal at
 * either step ends it. The manager's manager reads the queue through his ordinary scope and decides
 * nothing — scope is sight, not authority.
 *
 * Whether a visit was off-plan is not decided here and cannot be: it is stamped by the database at
 * save time from the plan's own history (see the migration's header, and `plannedCustomerIds` in
 * visits.ts for the screen's twin of the same test). This file only carries the decision.
 */

import { forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { parseListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";
import type { OrgSeat } from "@/lib/phoenix-crm/scope";
import { assertUnplannedVisitApprover, canDecideUnplannedVisit, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, chunk, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { notifyPhoenixCrm } from "@/lib/phoenix-crm/server/notifications";
import type { OffPlanVisitRef } from "@/lib/phoenix-crm/server/offplan-day";
import { nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import {
  isUnplannedVisitStatus,
  isUnplannedVisitWaiting,
  UNPLANNED_DECISION_NOTE_MAX,
  unplannedVisitStageOf,
  unplannedVisitStatusLabel,
  type UnplannedVisitStage,
  type UnplannedVisitStatus,
} from "@/lib/phoenix-crm/unplanned-rules";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function record(raw: unknown): Row {
  return (raw && typeof raw === "object" ? raw : {}) as Row;
}

// `captured_at` rides on the visit for the moved day (offplan-day.ts): the plan is read as it stood at
// the instant the visit was logged, which is the instant the database judged it off the plan.
const UNPLANNED_COLUMNS =
  "visit_id, seat_id, rep_hr_id, entered_by_hr_id, customer_id, visit_date, clarification, status, version, created_at, " +
  "manager_decided_by_hr_id, manager_decided_at, manager_note, sfe_decided_by_hr_id, sfe_decided_at, sfe_note, " +
  "customer:phoenix_crm_customers!customer_id(name, list_type, speciality), " +
  "visit:phoenix_crm_visits!visit_id(photo_path, location_flag, distance_meters, products, comment, captured_at)";

export type UnplannedVisitView = {
  visitId: string;
  seatId: string;
  /** Whose visit it is: the Team tab's card is one rep's day. The name is what is shown. */
  repHrId: string | null;
  repName: string;
  customerName: string;
  /** Whatever list the customer is on. A pharmacy call is never off-plan, so one never appears here. */
  customerListType: PhoenixCrmListType;
  speciality: string | null;
  visitDate: string;
  raisedAt: string;
  /** The rep's written "why I went" — the whole reason this row exists. */
  clarification: string;
  status: UnplannedVisitStatus;
  statusLabel: string;
  /** Which step it is waiting on, or null once it is settled. */
  stage: UnplannedVisitStage | null;
  version: number;
  /** The evidence the decider looks at: the live photo and how far the rep stood from the place. */
  photoPath: string | null;
  locationFlag: string | null;
  products: string[];
  comment: string | null;
  managerDecidedByName: string | null;
  managerNote: string | null;
  sfeDecidedByName: string | null;
  sfeNote: string | null;
};

/** Waiting off-plan visits for a set of territories, the longest-waiting first. */
export async function loadUnplannedRows(seatIds: ReadonlyArray<string>, isTest: boolean, options: { waitingOnly?: boolean } = {}): Promise<Row[]> {
  if (seatIds.length === 0) return [];
  const rows: Row[] = [];
  for (const batch of chunk([...seatIds])) {
    let query = getSupabaseAdmin().from("phoenix_crm_unplanned_visits").select(UNPLANNED_COLUMNS).in("seat_id", batch).eq("is_test", isTest);
    if (options.waitingOnly !== false) query = query.in("status", ["manager_pending", "sfe_pending"]);
    const { data, error } = await query;
    throwIfError(error);
    rows.push(...((data ?? []) as unknown as Row[]));
  }
  return rows.sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
}

/** The hr ids a batch of rows needs names for. */
export function unplannedPeople(rows: ReadonlyArray<Row>): Array<string | null> {
  return rows.flatMap((row) => [
    textOrNull(row.rep_hr_id),
    textOrNull(row.manager_decided_by_hr_id),
    textOrNull(row.sfe_decided_by_hr_id),
  ]);
}

/**
 * What the moved-day read needs of a row (offplan-day.ts): whose territory, which customer, which day,
 * and the instant the visit was logged — read from the plan's own history, never from the reason.
 */
export function unplannedVisitRef(row: Row): OffPlanVisitRef {
  const visit = record(Array.isArray(row.visit) ? row.visit[0] : row.visit);
  return {
    visitId: String(row.visit_id),
    seatId: String(row.seat_id),
    customerId: String(row.customer_id ?? ""),
    visitDate: String(row.visit_date),
    capturedAt: textOrNull(visit.captured_at),
  };
}

export function mapUnplannedRow(row: Row, names: PeopleNames): UnplannedVisitView {
  const status: UnplannedVisitStatus = isUnplannedVisitStatus(row.status) ? row.status : "manager_pending";
  const customer = record(Array.isArray(row.customer) ? row.customer[0] : row.customer);
  const visit = record(Array.isArray(row.visit) ? row.visit[0] : row.visit);
  const person = (value: unknown) => {
    const hrId = textOrNull(value);
    return hrId ? nameOf(names, hrId) : null;
  };
  return {
    visitId: String(row.visit_id),
    seatId: String(row.seat_id),
    repHrId: textOrNull(row.rep_hr_id),
    repName: nameOf(names, textOrNull(row.rep_hr_id)),
    customerName: textOrNull(customer.name) ?? "Customer",
    customerListType: parseListType(customer.list_type),
    speciality: textOrNull(customer.speciality),
    visitDate: String(row.visit_date),
    raisedAt: String(row.created_at),
    clarification: textOrNull(row.clarification) ?? "",
    status,
    statusLabel: unplannedVisitStatusLabel(status),
    stage: unplannedVisitStageOf(status),
    version: Number(row.version),
    photoPath: textOrNull(visit.photo_path),
    locationFlag: textOrNull(visit.location_flag),
    products: Array.isArray(visit.products) ? visit.products.map(String) : [],
    comment: textOrNull(visit.comment),
    managerDecidedByName: person(row.manager_decided_by_hr_id),
    managerNote: textOrNull(row.manager_note),
    sfeDecidedByName: person(row.sfe_decided_by_hr_id),
    sfeNote: textOrNull(row.sfe_note),
  };
}

/** The screen's twin: may this viewer decide this row as it stands right now? */
export function canDecideUnplannedRow(viewer: PhoenixCrmViewer, seat: OrgSeat, isTest: boolean, status: UnplannedVisitStatus): boolean {
  const stage = unplannedVisitStageOf(status);
  return stage !== null && canDecideUnplannedVisit(viewer, seat, isTest, stage);
}

export type UnplannedDecision = { visitId: string; status: UnplannedVisitStatus; version: number };

/**
 * Approve or refuse an off-plan visit.
 *
 * The STAGE is read from the row, never from the request: a phone that names "sfe" on a visit still
 * sitting with the manager would otherwise choose its own approver. The database refuses the wrong
 * stage as well (`unplanned_wrong_stage`), so the two guards agree rather than one trusting the other.
 */
export async function decideUnplannedVisit(viewer: PhoenixCrmViewer, raw: unknown): Promise<UnplannedDecision> {
  const body = record(raw);
  if (!isUuid(body.visitId)) throw validationError("Choose the visit. Reload the page.");
  const visitId = String(body.visitId).toLowerCase();
  const decision = body.decision === "approve" ? "approve" : body.decision === "refuse" ? "refuse" : null;
  if (!decision) throw validationError("Choose approve or refuse.");
  const note = String(body.note ?? "").trim().replace(/\s+/g, " ") || null;
  if (note !== null && note.length > UNPLANNED_DECISION_NOTE_MAX) {
    throw validationError(`Keep the note under ${UNPLANNED_DECISION_NOTE_MAX} characters.`);
  }
  if (decision === "refuse" && note === null) throw validationError("Write a note explaining why.");
  const expectedVersion = Number(body.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw validationError("Reload the page and try again.");

  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_unplanned_visits")
    .select("visit_id, seat_id, rep_hr_id, customer_id, visit_date, status, is_test, customer:phoenix_crm_customers!customer_id(name)")
    .eq("visit_id", visitId)
    .maybeSingle();
  throwIfError(error);
  const row = data as Row | null;
  if (!row) throw notFoundError("This visit is no longer waiting for a decision. Reload the page.");

  const isTest = row.is_test === true;
  const seat = viewer.org.seats.get(String(row.seat_id));
  if (!seat) throw notFoundError("This territory is no longer in the organogram. Reload the page.");
  const status: UnplannedVisitStatus = isUnplannedVisitStatus(row.status) ? row.status : "approved";
  if (!isUnplannedVisitWaiting(status)) throw forbiddenError("This visit was already decided. Reload the page.");
  const stage = unplannedVisitStageOf(status) as UnplannedVisitStage;
  assertUnplannedVisitApprover(viewer, seat, isTest, stage);

  const result = await callPhoenixCrm<Row>("phoenix_crm_decide_unplanned_visit", {
    p: {
      visit_id: visitId,
      stage,
      decision,
      actor_hr_id: viewer.hrId,
      actor_role: viewer.role,
      note,
      expected_version: expectedVersion,
      is_test: isTest,
    },
  });

  const nextStatus: UnplannedVisitStatus = isUnplannedVisitStatus(result.status) ? result.status : status;
  const version = Number(result.version);
  await notifyPhoenixCrm(
    {
      kind: "unplanned_visit_decided",
      org: viewer.org,
      seat,
      visitId,
      version,
      repHrId: String(row.rep_hr_id),
      customerName: textOrNull(record(Array.isArray(row.customer) ? row.customer[0] : row.customer).name) ?? "the customer",
      visitDate: String(row.visit_date),
      status: nextStatus,
      deciderHrId: viewer.hrId,
      note,
    },
    isTest,
  );

  return { visitId, status: nextStatus, version };
}
