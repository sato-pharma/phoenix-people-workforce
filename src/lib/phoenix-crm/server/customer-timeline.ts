/**
 * Phoenix CRM — one customer's past Phoenix visits, newest first, for his page (owner, 2026-10-02).
 * The rules are in customer-timeline.ts; this is the read.
 *
 * Read through the list's own seat gate, `territoryForRead`: the territory's rep, its managers, SFE, the
 * CEO and the Super Admin — whoever may open the customer may read what happened at his door. The
 * customer must belong to the territory asked about, in the world asked about, or nothing is read.
 *
 * 🔴 THE SELECT NAMES NO LOCATION. Not the visit's position, its accuracy, its distance from the place,
 * its location flag nor the phone's clock: none of them is read here, so none of them can reach the page
 * (Golden Rule #1 — the rep's screens never show a check, and this is one of his screens).
 *
 * Every SAVED visit is on it, read from `phoenix_crm_visits` the way the rep's own day reads them: the
 * timeline is a record of what happened at the customer, never a count of anybody's work.
 */

import { notFoundError, validationError } from "@/lib/http/api-errors";
import { buildCustomerTimeline, type TimelineEntry, type TimelineVisit } from "@/lib/phoenix-crm/customer-timeline";
import { isEnteredForRep } from "@/lib/phoenix-crm/missed-records";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { readTestFlag, territoryForRead, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { parseListType } from "@/lib/phoenix-crm/pharmacy-call-rules";

type Row = Record<string, unknown>;

/** At most this many visits travel to the phone; `more` says when there were older ones. */
export const TIMELINE_VISITS_MAX = 100;

/**
 * Exactly what a timeline reads off a visit — and, by leaving them out, what it never reads: no `lat`,
 * `lon`, `accuracy_meters`, `distance_meters`, `location_flag`, `device_skew_minutes`, photo or voice.
 * Pinned by tests/phoenix-crm-insight-reports.test.ts.
 */
export const TIMELINE_VISIT_COLUMNS =
  "id, visit_date, captured_at, list_type, products, objection, objection_note, comment, next_step, next_step_on, " +
  "detail_comment, detail_edited_at, " +
  "rep_hr_id, manager_hr_id, senior_hr_id, entered_by_hr_id, is_unplanned, unplanned_kind";

export type CustomerTimelineView = {
  customerId: string;
  isTest: boolean;
  /** Newest first. */
  entries: TimelineEntry[];
  /** There were older visits than the ones sent. */
  more: boolean;
};

export async function loadCustomerTimeline(
  viewer: PhoenixCrmViewer,
  raw: { seatId: unknown; test: unknown; customerId: unknown },
): Promise<CustomerTimelineView> {
  const { seat, isTest } = territoryForRead(viewer, raw.seatId, readTestFlag(raw.test));
  const customerId = typeof raw.customerId === "string" ? raw.customerId.trim() : "";
  if (!isUuid(customerId)) throw validationError("Choose a customer.");

  // The customer check and his visits are asked for TOGETHER (2026-10-16 Phoenix CRM performance
  // audit), where the visits used to wait for the check. Nothing reaches the page before the check
  // passes, and its answer is still read first: the visits read is held to this same seat and world,
  // so on a customer who is not here it can only come back empty, and it is thrown away unread.
  const supabase = getSupabaseAdmin();
  const [customer, visits] = await Promise.all([
    supabase
      .from("phoenix_crm_customers")
      .select("id")
      .eq("id", customerId)
      .eq("seat_id", seat.seatId)
      .eq("is_test", isTest)
      .maybeSingle(),
    supabase
      .from("phoenix_crm_visits")
      .select(TIMELINE_VISIT_COLUMNS)
      .eq("seat_id", seat.seatId)
      .eq("customer_id", customerId)
      .eq("is_test", isTest)
      // A copied visit in the visits archive (owner, 2026-11-07) is no visit.
      .is("archived_at", null)
      .order("visit_date", { ascending: false })
      .order("captured_at", { ascending: false })
      .limit(TIMELINE_VISITS_MAX + 1),
  ]);
  throwIfError(customer.error);
  if (!customer.data) throw notFoundError("This customer is not on this territory's list. Reload the page.");
  throwIfError(visits.error);
  const rows = (visits.data ?? []) as unknown as Row[];

  const entries = buildCustomerTimeline(
    rows.slice(0, TIMELINE_VISITS_MAX).map((row): TimelineVisit => ({
      visitId: String(row.id),
      visitDate: String(row.visit_date ?? "").slice(0, 10),
      capturedAt: String(row.captured_at ?? ""),
      listType: parseListType(row.list_type),
      products: Array.isArray(row.products) ? row.products.map((entry) => String(entry)) : [],
      objection: textOrNull(row.objection),
      objectionNote: textOrNull(row.objection_note),
      comment: textOrNull(row.comment),
      detailComment: textOrNull(row.detail_comment),
      detailEditedAt: textOrNull(row.detail_edited_at),
      nextStep: textOrNull(row.next_step),
      nextStepOn: textOrNull(row.next_step_on),
      enteredByAdmin: isEnteredForRep({ enteredBy: row.entered_by_hr_id, rep: row.rep_hr_id, manager: row.manager_hr_id, senior: row.senior_hr_id }),
      isUnplanned: row.is_unplanned === true,
      unplannedKind: textOrNull(row.unplanned_kind),
    })),
  );
  return { customerId, entries, isTest, more: rows.length > TIMELINE_VISITS_MAX };
}
