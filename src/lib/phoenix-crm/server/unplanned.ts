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
import { personKey, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { assertUnplannedVisitApprover, canDecideUnplannedVisit, canOverrideDecision, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, chunk, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { notifyPhoenixCrm } from "@/lib/phoenix-crm/server/notifications";
import type { OffPlanVisitRef } from "@/lib/phoenix-crm/server/offplan-day";
import { nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import {
  isRepeatOfOwnUnplannedDecision,
  isUnplannedVisitStatus,
  isUnplannedVisitWaiting,
  reviewerWasOnTheVisit,
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
//
// 🔴 `manager_hr_id`, `senior_hr_id` and `product_manager_hr_id` are WHO WAS ON THE VISIT, and they are
// read for ONE reason: until 2026-10-12 this read loaded only the evidence, so a manager deciding a
// ride-along he had been on himself saw no sign of it on the card. Measured on production that day: of
// the 31 off-plan visits that carried a companion, 27 were decided by that companion — every one the
// named manager, and every one approved. That is a missing piece of INFORMATION, never a finding
// against anybody, so the card states it and the decision itself is unchanged.
const UNPLANNED_COLUMNS =
  "visit_id, seat_id, rep_hr_id, entered_by_hr_id, customer_id, visit_date, clarification, status, version, created_at, " +
  "manager_decided_by_hr_id, manager_decided_at, manager_note, sfe_decided_by_hr_id, sfe_decided_at, sfe_note, " +
  "customer:phoenix_crm_customers!customer_id(name, list_type, speciality), " +
  "visit:phoenix_crm_visits!visit_id(photo_path, location_flag, distance_meters, products, comment, captured_at, " +
  "manager_hr_id, senior_hr_id, product_manager_hr_id, companions:phoenix_crm_visit_companions(hr_id, position))";

/** Who the rep recorded as being with him, in the order the card reads them. A null column drops out. */
const COMPANION_ROLES = [
  { column: "manager_hr_id", label: "Manager" },
  // The next manager up — a Regional or National Sales Manager; there is no "senior" title (owner, 2026-10-27).
  { column: "senior_hr_id", label: "Manager above" },
  // The Training Manager rides in this column too (owner, 2026-10-24).
  { column: "product_manager_hr_id", label: "Product or training manager" },
] as const;

/** The label of everyone past the three fixed places (owner, 2026-10-27: "Everything is applicable"). */
const MORE_COMPANION_LABEL = "Also on the visit";

/**
 * The companion hr ids on one row, read off the joined visit: the three fixed places in their order, then
 * everyone else the visit lists (`phoenix_crm_visit_companions`, 2026-10-27) that is not already one of
 * them. Each entry carries the label the card reads it under.
 */
function companionEntries(row: Row): Array<{ hrId: string; label: string }> {
  const visit = record(Array.isArray(row.visit) ? row.visit[0] : row.visit);
  const out: Array<{ hrId: string; label: string }> = [];
  const seen = new Set<string>();
  const add = (value: unknown, label: string) => {
    const hrId = textOrNull(value);
    const key = personKey(hrId);
    if (!hrId || key === null || seen.has(key)) return;
    seen.add(key);
    out.push({ hrId, label });
  };
  for (const role of COMPANION_ROLES) add(visit[role.column], role.label);
  const listed = (Array.isArray(visit.companions) ? visit.companions : [])
    .map((entry) => record(entry))
    .sort((left, right) => Number(left.position ?? 0) - Number(right.position ?? 0));
  for (const entry of listed) add(entry.hr_id, MORE_COMPANION_LABEL);
  return out;
}

/** The companion hr ids on one row. */
function companionHrIds(row: Row): string[] {
  return companionEntries(row).map((entry) => entry.hrId);
}

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
  /** Who the rep recorded as being with him on the visit, named, longest-standing role first. */
  companions: Array<{ role: string; name: string }>;
  /**
   * Did the person who took a step on this visit go on it? Stated, never enforced: the approval chain
   * is the owner's (direct manager, then SFE; one refusal ends it; a vacant chain starts at SFE; the
   * Administrator is not a step), and nothing here skips, adds or blocks a step.
   */
  managerDecidedByWasOnTheVisit: boolean;
  sfeDecidedByWasOnTheVisit: boolean;
};

/** One PostgREST page of this read — `max_rows` in supabase/config.toml, which it cannot exceed. */
const UNPLANNED_PAGE = 1000;

/**
 * Waiting off-plan visits for a set of territories, the longest-waiting first.
 *
 * 🔴 IT IS PAGED, AND THE SFE MANAGER IS WHY. For a district manager this read is one small team;
 * for the SFE Manager it is the queue across EVERY territory in the company, and his step is the
 * second one, so every visit the district managers approve arrives in it. A PostgREST read with no
 * range stops at `max_rows = 1000` with no error and no marker (supabase/config.toml), so past that
 * the Team tab would simply stop showing the oldest waiting visits — the ones most in need of a
 * decision — and the summary beside it would under-count by the same silent amount.
 *
 * Delta (1) is why it is paged NOW rather than later: every visit by a rep whose week was not sent
 * is off-plan, so the queue starts filling from the first morning.
 *
 * KEYSET ON `visit_id`, never `.range()` on an offset: the primary key is unique, so a decision
 * landing mid-read can shift no row across a page boundary. The caller's own `created_at` sort below
 * is what puts the longest-waiting first, so reading in key order costs nothing.
 */
export async function loadUnplannedRows(seatIds: ReadonlyArray<string>, isTest: boolean, options: { waitingOnly?: boolean } = {}): Promise<Row[]> {
  if (seatIds.length === 0) return [];
  const rows: Row[] = [];
  for (const batch of chunk([...seatIds])) {
    let after: string | null = null;
    for (;;) {
      let query = getSupabaseAdmin()
        .from("phoenix_crm_unplanned_visits")
        .select(UNPLANNED_COLUMNS)
        .in("seat_id", batch)
        .eq("is_test", isTest)
        .order("visit_id", { ascending: true })
        .limit(UNPLANNED_PAGE);
      if (options.waitingOnly !== false) query = query.in("status", ["manager_pending", "sfe_pending"]);
      if (after) query = query.gt("visit_id", after);
      const { data, error } = await query;
      throwIfError(error);
      const page = (data ?? []) as unknown as Row[];
      rows.push(...page);
      // A short page is the last page. A full one is read again from its last key — never assumed
      // to be the end, which is the whole defect this replaces.
      if (page.length < UNPLANNED_PAGE) break;
      after = String(page[page.length - 1].visit_id);
    }
  }
  return rows.sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
}

/** The hr ids a batch of rows needs names for. */
export function unplannedPeople(rows: ReadonlyArray<Row>): Array<string | null> {
  return rows.flatMap((row) => [
    textOrNull(row.rep_hr_id),
    textOrNull(row.manager_decided_by_hr_id),
    textOrNull(row.sfe_decided_by_hr_id),
    // The companions, so the card can NAME them. A missing name here would print an hr id, which
    // Golden Rule #1 forbids on any screen.
    ...companionHrIds(row),
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

  // Who was with him, named. `personKey` is what compares two hr ids anywhere in this module — the
  // raw strings differ in case and padding between the columns that store them.
  const companionIds = companionHrIds(row);
  const companions = companionEntries(row).map((entry) => ({ role: entry.label, name: nameOf(names, entry.hrId) }));
  const companionKeys = new Set(companionIds.map((hrId) => personKey(hrId)).filter((key): key is string => key !== null));
  const wasOnTheVisit = (value: unknown): boolean => {
    const key = personKey(textOrNull(value));
    return key !== null && companionKeys.has(key);
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
    companions,
    managerDecidedByWasOnTheVisit: wasOnTheVisit(row.manager_decided_by_hr_id),
    sfeDecidedByWasOnTheVisit: wasOnTheVisit(row.sfe_decided_by_hr_id),
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
    .select(
      // `clarification` rides along for the notice the SFE step gets when a manager passes the visit
      // on (notifications.ts): the reason he wrote is what SFE is being asked to judge.
      // The three companion columns are read for the fence below: this read, unlike the board's, has
      // no visit join at all, so without them the decision cannot tell whether the person clicking
      // was on the visit he is deciding.
      // Who took each step, and the version, answer a second press of the same decision with the
      // answer he already has (`isRepeatOfOwnUnplannedDecision`).
      "visit_id, seat_id, rep_hr_id, customer_id, visit_date, status, clarification, is_test, " +
        "manager_decided_by_hr_id, sfe_decided_by_hr_id, version, " +
        "customer:phoenix_crm_customers!customer_id(name), " +
        "visit:phoenix_crm_visits!visit_id(manager_hr_id, senior_hr_id, product_manager_hr_id, companions:phoenix_crm_visit_companions(hr_id, position))",
    )
    .eq("visit_id", visitId)
    .maybeSingle();
  throwIfError(error);
  const row = data as Row | null;
  if (!row) throw notFoundError("This visit is no longer waiting for a decision. Reload the page.");

  const isTest = row.is_test === true;
  const seat = viewer.org.seats.get(String(row.seat_id));
  if (!seat) throw notFoundError("This territory is no longer in the organogram. Reload the page.");
  const status: UnplannedVisitStatus = isUnplannedVisitStatus(row.status) ? row.status : "approved";
  // 🔴 THE SAME PERSON'S SAME DECISION AGAIN IS THE ANSWER HE ALREADY HAS — read before any step is
  // checked, because his own approval has moved the visit to a step that is not his (production,
  // 24–30 Oct 2026: fourteen refusals, every one a second press seconds after his own decision saved).
  // Nothing is written and nobody is told twice.
  const repeat = isRepeatOfOwnUnplannedDecision(
    { status, managerDecidedByHrId: textOrNull(row.manager_decided_by_hr_id), sfeDecidedByHrId: textOrNull(row.sfe_decided_by_hr_id) },
    viewer.hrId,
    decision,
  );
  if (repeat) return { visitId, status, version: Number(row.version) };
  if (!isUnplannedVisitWaiting(status)) throw forbiddenError("This visit was already decided. Reload the page.");
  // A RECORDED visit waits for the Administrator first (owner, 2026-10-16), and his step is taken on the
  // Visit Recording page — never here, by anybody, his own override included.
  if (status === "admin_pending") throw forbiddenError("This recorded visit waits for the Administrator's approval first. Reload the page.");
  const stage = unplannedVisitStageOf(status) as UnplannedVisitStage;
  // The Administrator approves or declines at whichever step it waits at, in place of its holder, and
  // is no step himself (owner, 2026-10-14; before that he could only decline, 2026-10-08).
  const asAdministrator = canOverrideDecision(viewer, isTest);
  if (!asAdministrator) {
    assertUnplannedVisitApprover(viewer, seat, isTest, stage);
    // 🔴 THE THIRD FENCE ON THE OWNER'S 2026-10-12 RULING, and the only one that reads the person
    // actually clicking rather than the organogram. `unplannedFirstStatus` sends a visit whose
    // reviewer was on it to SFE at save time, and the migration moved the rows already waiting, so
    // nothing should ever reach here — this closes the deploy window, and the case where a visit
    // gains a companion after its approval row was raised. It is a REFUSAL of this step, never of the
    // visit: the rep loses nothing, nothing is flagged, and the SFE step is untouched.
    if (stage === "manager" && reviewerWasOnTheVisit(viewer.hrId, companionHrIds(row))) {
      throw forbiddenError("You were on this visit, so SFE decides it rather than you.");
    }
  }

  const result = await callPhoenixCrm<Row>("phoenix_crm_decide_unplanned_visit", {
    p: {
      visit_id: visitId,
      stage,
      decision,
      actor_hr_id: viewer.hrId,
      actor_role: asAdministrator ? "administrator" : viewer.role,
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
      clarification: textOrNull(row.clarification),
    },
    isTest,
  );

  return { visitId, status: nextStatus, version };
}
