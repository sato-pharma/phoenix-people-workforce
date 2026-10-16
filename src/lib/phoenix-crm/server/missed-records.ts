/**
 * Phoenix CRM — the Super Admin enters a record a rep MISSED: a visit, or how his day was spent.
 *
 * Owner, 2026-10-01 — "the rep is responsible for all his records, but if he missed a visit or a
 * record, admin can enter it for him … for anyone, anytime, anywhere", "I choose planned or
 * unplanned", and the rep sees it "marked as entered by admin". The rules are pure and live in
 * `@/lib/phoenix-crm/missed-records`; this file is their I/O.
 *
 * 🔴 IT ADDS WHAT IS MISSING AND NEVER REWRITES WHAT THE REP RECORDED. A visit is one a customer a day,
 * so a customer the rep already saw that day cannot be entered again (`already_visited`); a day the
 * rep recorded himself stays his (`activityIsRepsOwn`), and only what the Super Admin entered can be
 * changed or cleared by him.
 *
 * 🔴 A VISIT ENTERED HERE HAS NO LOCATION, AND NOTHING THAT JUDGES A REP READS IT AS ONE. He was not at
 * the door, so phoenix_crm_admin_enter_visit stores no reading at all — never his own position, never a
 * made-up point. The location checks, the behaviour sweep and the place-against-actual report each
 * leave it out (`location-integrity.ts`, `behaviour.ts`, `reports.ts`), so it can never accuse anybody.
 *
 * 🔴 PLANNED OR UNPLANNED IS HIS CHOICE, never the plan's. The form starts from the plan the rep had
 * sent for that day so the usual answer is one tap, and he can turn it either way: planned counts at
 * once; unplanned raises the same manager-then-SFE approval a rep's own off-plan visit does, and the
 * reviewing manager is told exactly as he is for a rep's.
 */

import { conflictError, validationError } from "@/lib/http/api-errors";
import { parseGrade } from "@/lib/phoenix-crm/entry-rules";
import { isMissedRecordDay, parseMissedActivity, parseMissedVisit, parseRemoveMissedVisit } from "@/lib/phoenix-crm/missed-records";
import { isPharmacyListType, parseListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { isPlanSentForReview } from "@/lib/phoenix-crm/plan-rules";
import { territoryReviewer } from "@/lib/phoenix-crm/scope";
import {
  readTestFlag,
  territoryForMissedRecord,
  territoryForMissedRecordRemoval,
  type PhoenixCrmViewer,
} from "@/lib/phoenix-crm/server/access";
import { loadDayActivityOn, mapDayActivityRow, type DayActivityRow } from "@/lib/phoenix-crm/server/day-activities";
import { callPhoenixCrm, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { ensureReferenceCustomers, loadTerritoryCustomers } from "@/lib/phoenix-crm/server/list";
import { notifyPhoenixCrm, withdrawPhoenixCrmVisitNotices } from "@/lib/phoenix-crm/server/notifications";
import { loadPeopleNames } from "@/lib/phoenix-crm/server/people";
import { lineProductsByFamily } from "@/lib/phoenix-crm/server/products";
import { describeTerritory, territoryPeople, type TerritorySummary } from "@/lib/phoenix-crm/server/territory";
import { plannedCustomersOn } from "@/lib/phoenix-crm/server/visits";
import type { PhoenixCrmGrade, PhoenixCrmListType } from "@/lib/phoenix-crm/types";
import { unplannedFirstStatus } from "@/lib/phoenix-crm/unplanned-rules";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function record(raw: unknown): Row {
  return (raw && typeof raw === "object" ? raw : {}) as Row;
}

// ── What can be entered for one territory on one day ────────────────────────────────────────────

export type MissedRecordCustomer = {
  customerId: string;
  name: string;
  listType: PhoenixCrmListType;
  grade: PhoenixCrmGrade | null;
  speciality: string | null;
  /** On the plan the rep had SENT for that day — the starting answer to "planned or unplanned", never the answer. */
  onSentPlan: boolean;
  /** Already has a visit that day. One visit a customer a day, so he cannot be entered again. */
  visited: boolean;
  /** Carried over and not validated yet: the visit counts once he is, exactly as a rep's own would. */
  pending: boolean;
};

export type MissedRecordForm = {
  territory: TerritorySummary;
  isTest: boolean;
  date: string;
  /** The last day a record may be entered for: the visit day running now. */
  through: string;
  /** Whether the rep had sent a plan for that week — "nobody was planned" and "no plan was sent" read differently. */
  planSent: boolean;
  customers: MissedRecordCustomer[];
  /** The line's products, in the words the visit form uses for "Products discussed". */
  products: string[];
  dayActivity: DayActivityRow | null;
  /** The rep recorded that day himself, so it stays his record and is not offered for change. */
  activityIsRepsOwn: boolean;
  /** Why no visit can be entered here, in one sentence; null when nothing stops it. */
  blockedReason: string | null;
};

export async function loadMissedRecordForm(
  viewer: PhoenixCrmViewer,
  raw: { seatId: unknown; test: unknown; date: unknown },
): Promise<MissedRecordForm> {
  const { seat, isTest } = territoryForMissedRecord(viewer, raw.seatId, readTestFlag(raw.test));
  if (!isMissedRecordDay(raw.date, viewer.visitDay)) throw validationError("Choose today or an earlier day.");
  const date = raw.date;

  // The list is minted from the territory's iReports360 reference first, exactly as the rep's own visit
  // form does — a rep who never opened Phoenix CRM still has his customers to enter a visit to.
  //
  // 🔴 ONE WAVE, NOT TWO (Phoenix CRM performance audit, 2026-10-16) — the shape `loadVisitForm` in
  // visits.ts settled on 2026-10-01. Only the customer list depends on the mint, because the mint can
  // add customers to it; nothing else here can name a customer minted a moment ago — he has no plan
  // row, no visit and no name to look up yet. So every other read starts BESIDE the mint, and the
  // mint's own failure is still the one that surfaces, first, exactly as when it ran alone.
  const ensured = ensureReferenceCustomers(seat, isTest);
  const wave = Promise.all([
    ensured.then(() => loadTerritoryCustomers(seat.seatId, isTest, { onListOnly: true })),
    plannedCustomersOn(seat.seatId, isTest, date),
    getSupabaseAdmin().from("phoenix_crm_visits").select("customer_id").eq("seat_id", seat.seatId).eq("is_test", isTest).eq("visit_date", date),
    lineProductsByFamily(seat.lineName),
    loadDayActivityOn(seat.seatId, isTest, date),
    loadPeopleNames(territoryPeople(viewer.org, [seat])),
  ]);
  // Handled at once: if the mint fails, `await ensured` below throws its error and the wave is dropped.
  wave.catch(() => undefined);
  await ensured;
  const [{ customers }, plan, visitedRead, families, activity, names] = await wave;
  throwIfError(visitedRead.error);

  // Sent means gone for review: a draft or a returned plan is the rep's own to edit, and is no authority
  // on who was planned — the same line the rep's own visit form draws, on the same DAY's status
  // (`plannedCustomersOn`): a week returned for one OTHER day still stands as sent on this one.
  const planSent = isPlanSentForReview(plan.status);
  const onPlan = new Set(planSent ? plan.customerIds : []);
  const visited = new Set(((visitedRead.data ?? []) as Row[]).map((row) => String(row.customer_id)));

  const options: MissedRecordCustomer[] = customers.map((row) => {
    const customerId = String(row.id);
    return {
      customerId,
      name: String(row.name),
      listType: parseListType(row.list_type),
      grade: parseGrade(row.grade),
      speciality: textOrNull(row.speciality),
      onSentPlan: onPlan.has(customerId),
      visited: visited.has(customerId),
      // A pharmacy needs no validation (owner, 2026-10-03): never "not validated yet".
      pending: row.status === "pending" && !isPharmacyListType(row.list_type),
    };
  });
  // Who was planned that day first, then everybody else by name.
  options.sort((left, right) => Number(right.onSentPlan) - Number(left.onSentPlan) || left.name.localeCompare(right.name));

  const products = families.map((entry) => entry.family);
  let blockedReason: string | null = null;
  if (!seat.lineCode) blockedReason = "This territory has no line in the organogram, so visits cannot be saved.";
  else if (products.length === 0) blockedReason = `No products are on file for ${seat.lineName ?? "this line"} yet, so a visit cannot record the products discussed.`;

  return {
    territory: describeTerritory(viewer.org, seat, names),
    isTest,
    date,
    through: viewer.visitDay,
    planSent,
    customers: options,
    products,
    dayActivity: activity,
    activityIsRepsOwn: activity !== null && !activity.enteredByAdmin,
    blockedReason,
  };
}

// ── Entering a missed visit ─────────────────────────────────────────────────────────────────────

export type EnteredMissedVisit = {
  visitId: string;
  visitDate: string;
  capturedAt: string;
  customerName: string;
  planned: boolean;
  /** The same entry sent twice: the visit already saved answered, and nothing new was written. */
  duplicate: boolean;
};

export async function enterMissedVisit(viewer: PhoenixCrmViewer, raw: unknown): Promise<EnteredMissedVisit> {
  const body = record(raw);
  const { seat, isTest, repHrId } = territoryForMissedRecord(viewer, body.seatId, readTestFlag(body.test));
  if (!seat.lineCode) throw validationError("This territory has no line in the organogram, so visits cannot be saved.");
  const parsed = parseMissedVisit(body, viewer.visitDay);
  if (!parsed.ok) throw validationError(parsed.error);
  const entry = parsed.value;

  // The products discussed come from the line's own list, exactly as on a rep's visit.
  const families = await lineProductsByFamily(seat.lineName);
  const allowed = new Set(families.map((family) => family.family));
  if (families.length === 0 || entry.products.some((product) => !allowed.has(product))) {
    throw validationError("Choose the products discussed from the line's products. Reload the page.");
  }

  // Where an unplanned visit's approval starts, from the organogram and never from the screen: a
  // territory with no manager seat above it begins at SFE, exactly as a rep's own off-plan visit does.
  const reviewer = territoryReviewer(viewer.org, seat.seatId);
  const result = await callPhoenixCrm<Row>("phoenix_crm_admin_enter_visit", {
    p: {
      id: entry.visitId,
      seat_id: seat.seatId,
      line_code: seat.lineCode,
      actor_hr_id: viewer.hrId,
      rep_hr_id: repHrId,
      is_test: isTest,
      customer_id: entry.customerId,
      visit_date: entry.visitDate,
      visit_minute: entry.visitMinute,
      planned: entry.planned,
      products: entry.products,
      comment: entry.comment,
      unplanned_reason: entry.reason,
      unplanned_first_status: unplannedFirstStatus(reviewer !== null),
      reviewer_hr_id: reviewer?.hrId ?? null,
    },
  });

  const duplicate = result.duplicate === true;
  const customerName = textOrNull(result.customer_name) ?? "Customer";
  // An unplanned visit counts in nothing until it is decided, so the manager who decides it is told —
  // the one notice a rep's own off-plan visit sends too. A repeat of the same entry tells nobody twice.
  if (!entry.planned && !duplicate) {
    await notifyPhoenixCrm(
      {
        kind: "unplanned_visit_raised",
        org: viewer.org,
        seat,
        visitId: entry.visitId,
        repHrId,
        customerName,
        visitDate: String(result.visit_date),
        clarification: entry.reason ?? "",
        enteredByAdmin: true,
      },
      isTest,
    );
  }

  return {
    visitId: String(result.id),
    visitDate: String(result.visit_date),
    capturedAt: String(result.captured_at),
    customerName,
    planned: result.is_unplanned !== true,
    duplicate,
  };
}

// ── Entering a missed day activity ──────────────────────────────────────────────────────────────

export async function enterMissedActivity(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ cleared: boolean; activity: DayActivityRow | null }> {
  const body = record(raw);
  const { seat, isTest, repHrId } = territoryForMissedRecord(viewer, body.seatId, readTestFlag(body.test));
  const parsed = parseMissedActivity(body, viewer.visitDay);
  if (!parsed.ok) throw validationError(parsed.error);
  const entry = parsed.value;

  // 🔴 The rep's own record stays his. The Super Admin fills a day the rep left empty, and changes or
  // clears only what he entered himself.
  const existing = await loadDayActivityOn(seat.seatId, isTest, entry.activityDate);
  if (existing && !existing.enteredByAdmin) {
    throw conflictError("The rep recorded this day, so it stays as recorded.", "rep_recorded_day");
  }

  if (entry.clear) {
    await callPhoenixCrm("phoenix_crm_save_day_activity", {
      p: { actor_hr_id: viewer.hrId, activity_date: entry.activityDate, is_test: isTest, seat_id: seat.seatId },
    });
    return { cleared: true, activity: null };
  }

  const saved = await callPhoenixCrm<Row>("phoenix_crm_save_day_activity", {
    p: {
      activity_date: entry.activityDate,
      activity_type: entry.draft.activityType,
      actor_hr_id: viewer.hrId,
      half_day: entry.draft.halfDay,
      is_test: isTest,
      line_code: seat.lineCode,
      note: entry.draft.note,
      rep_hr_id: repHrId,
      seat_id: seat.seatId,
    },
  });
  // 🔴 THE SAVED ROW, NOT A SECOND READ OF IT (Phoenix CRM performance audit, 2026-10-16). The function
  // returns the row it wrote — date, type, half day and note — but not WHO wrote it or for whom, and
  // those two are exactly what this call just passed it: it stores `actor_hr_id` as the entered-by and
  // `rep_hr_id` as the rep, verbatim. So the "entered for him" mark is the one a read-back would
  // compute. A result missing its date or type (an older function) falls back to reading the day.
  const activity = mapDayActivityRow({ ...saved, entered_by_hr_id: viewer.hrId, rep_hr_id: repHrId });
  return { cleared: false, activity: activity ?? (await loadDayActivityOn(seat.seatId, isTest, entry.activityDate)) };
}

// ── Removing a visit he entered by mistake ──────────────────────────────────────────────────────

/**
 * Take back a visit the Super Admin entered (owner, 2026-10-01: "add a way to remove a missed visit I
 * entered by mistake").
 *
 * 🔴 ONLY HIS OWN ENTRY, AND THE DATABASE DECIDES IT from the row: phoenix_crm_admin_remove_visit
 * refuses anything that is not capture_source 'admin' entered by him (`not_entered_by_you`), so a rep's
 * own visit — his record — can never go through here, whatever the screen sends.
 *
 * 🔴 NOTHING IS LOST: the function keeps the visit, its off-plan approval and that approval's events in
 * phoenix_crm_removed_visits before deleting a row. An off-plan entry already sent to the manager leaves
 * his queue, and the notice he was sent is WITHDRAWN with it (owner, 2026-10-02) — before that it stayed
 * in his bell as a to-do with nothing behind it to open.
 */
export async function removeMissedVisit(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ removed: true; visitId: string; visitDate: string }> {
  const body = record(raw);
  const { seat, isTest } = territoryForMissedRecordRemoval(viewer, body.seatId, readTestFlag(body.test));
  const parsed = parseRemoveMissedVisit(body);
  if (!parsed.ok) throw validationError(parsed.error);

  const result = await callPhoenixCrm<Row>("phoenix_crm_admin_remove_visit", {
    p: { visit_id: parsed.value.visitId, seat_id: seat.seatId, actor_hr_id: viewer.hrId, is_test: isTest },
  });

  // AFTER the removal, never before: the database is what decides whether this visit may go at all,
  // so withdrawing first would take a notice back from a manager whose visit is still sitting there.
  // Awaited, so the reply reports a finished act — and it swallows its own failures, so a notice that
  // cannot be withdrawn still leaves the visit removed.
  const visitId = String(result.visit_id);
  await withdrawPhoenixCrmVisitNotices(visitId);

  return { removed: true, visitId, visitDate: String(result.visit_date) };
}
