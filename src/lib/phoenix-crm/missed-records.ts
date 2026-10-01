/**
 * Phoenix CRM — a record a rep MISSED, entered for him by the Super Admin.
 *
 * Owner, 2026-10-01, four answers in one sitting:
 *   - "the rep is responsible for all his records, but if he missed a visit or a record, admin can
 *     enter it for him" — so this ADDS what is missing and never rewrites what the rep recorded;
 *   - "for anyone, anytime, anywhere" — any rep's territory, any day that has already begun, and with
 *     no location: the Super Admin is not at the door, so the visit carries no reading at all;
 *   - "I choose planned or unplanned" — HIS choice, never inferred. Planned counts at once; unplanned
 *     raises the same manager-then-SFE approval a rep's own off-plan visit raises;
 *   - "marked as entered by admin" — the rep sees the mark on the visit, in words.
 *
 * 🔴 ITS OWN MARK, AND NOT `capture_source`. The database records an entered visit as
 * capture_source = 'admin', but that column is one of the rep-blind ones (tests/phoenix-crm-blind-half)
 * and may never reach the rep's own visit rows. What the rep's rows CAN say is who entered the visit,
 * and on every other path the person who enters a visit is on it: the rep, or the manager entering his
 * own single, double or chain visit (scope.ts `resolveVisitParticipants`). So "entered by somebody who
 * was not on the visit" is exactly this path — `isEnteredForRep` — and the mark is read from that.
 *
 * Pure: no I/O. `server/missed-records.ts` does the reading and the saving.
 */

import { isIsoDay } from "@/lib/phoenix-crm/calendar";
import { parseDayActivityDraft, type DayActivityDraft } from "@/lib/phoenix-crm/day-activities";
import { VISIT_COMMENT_MAX, VISIT_PRODUCTS_MAX } from "@/lib/phoenix-crm/entry-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { UNPLANNED_REASON_MAX, UNPLANNED_REASON_MIN } from "@/lib/phoenix-crm/unplanned-rules";

/** The words the rep, his managers and SFE read on anything the Super Admin entered for him. */
export const MISSED_RECORD_MARK = "Entered by the Super Admin";

/** Noon, in minutes past midnight: the time a visit is filed at when the Super Admin gives none. */
export const MISSED_VISIT_DEFAULT_MINUTE = 12 * 60;

/**
 * Before 02:00 is the small hours AFTER the chosen day, which still belong to it — the visit day ends
 * at 02:00 (owner, 2026-09-29; `cairoBusinessDay`). phoenix_crm_admin_enter_visit reads it the same way.
 */
export const VISIT_DAY_CUTOFF_MINUTE = 2 * 60;

type Body = Record<string, unknown>;

function bodyOf(raw: unknown): Body {
  return (raw && typeof raw === "object" ? raw : {}) as Body;
}

/**
 * A day the Super Admin may enter a missed record on: any day that has already begun, up to and
 * including the visit day running now. A day that has not begun holds no visit to have missed.
 */
export function isMissedRecordDay(day: unknown, visitDay: string): day is string {
  return isIsoDay(day) && day <= visitDay;
}

export type MinuteParse = { ok: true; value: number | null } | { ok: false; error: string };

/** "14:30" → 870; empty → null (noon stands in). Anything else is refused rather than guessed. */
export function parseVisitTime(raw: unknown): MinuteParse {
  const text = typeof raw === "string" ? raw.trim() : raw === null || raw === undefined ? "" : String(raw).trim();
  if (!text) return { ok: true, value: null };
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  const hours = match ? Number(match[1]) : NaN;
  const minutes = match ? Number(match[2]) : NaN;
  if (!match || hours > 23 || minutes > 59) return { ok: false, error: "Write the time as hours and minutes, for example 14:30, or leave it empty." };
  return { ok: true, value: hours * 60 + minutes };
}

export type MissedVisitEntry = {
  visitId: string;
  customerId: string;
  visitDate: string;
  /** Minutes past midnight in Cairo; null when he gave no time. */
  visitMinute: number | null;
  /** HIS choice — never read from the plan. */
  planned: boolean;
  products: string[];
  comment: string;
  /** Why the rep was there off his plan; set only on an unplanned visit. */
  reason: string | null;
};

export type MissedVisitParse = { ok: true; value: MissedVisitEntry } | { ok: false; error: string };

/**
 * One missed visit from the wire.
 *
 * The comment is REQUIRED, as it is on a rep's own visit (owner, 2026-09-30: "visit comment is
 * required"): an entered visit with nothing said about it is a row and not a record. The reason is
 * required on an unplanned one for the person it goes to — the manager decides it, and has to know why.
 */
export function parseMissedVisit(raw: unknown, visitDay: string): MissedVisitParse {
  const body = bodyOf(raw);
  if (!isUuid(body.id)) return { ok: false, error: "Reload the page and enter the visit again." };
  if (!isUuid(body.customerId)) return { ok: false, error: "Choose the customer the rep visited." };
  if (!isMissedRecordDay(body.visitDate, visitDay)) {
    return { ok: false, error: "Choose the day of the visit: today or an earlier day." };
  }
  const minute = parseVisitTime(body.visitTime);
  if (!minute.ok) return minute;
  if (body.planned !== true && body.planned !== false) return { ok: false, error: "Choose whether the visit was planned or unplanned." };

  const products: string[] = [];
  for (const entry of Array.isArray(body.products) ? body.products : []) {
    const product = typeof entry === "string" ? entry.trim() : "";
    if (product && !products.includes(product)) products.push(product);
  }
  if (products.length === 0) return { ok: false, error: "Choose the products discussed." };
  if (products.length > VISIT_PRODUCTS_MAX) return { ok: false, error: `Choose at most ${VISIT_PRODUCTS_MAX} products.` };

  const comment = typeof body.comment === "string" ? body.comment.trim() : "";
  if (!comment) return { ok: false, error: "Write what happened on the visit." };
  if (comment.length > VISIT_COMMENT_MAX) return { ok: false, error: `Keep the comment under ${VISIT_COMMENT_MAX} characters.` };

  let reason: string | null = null;
  if (body.planned === false) {
    // Cleaned exactly as the database cleans it, so the two can never disagree about a length.
    const text = String(body.reason ?? "")
      .trim()
      .replace(/\s+/g, " ");
    if (text.length < UNPLANNED_REASON_MIN) return { ok: false, error: "Write why the rep visited this customer off the plan." };
    if (text.length > UNPLANNED_REASON_MAX) return { ok: false, error: `Keep the reason under ${UNPLANNED_REASON_MAX} characters.` };
    reason = text;
  }

  return {
    ok: true,
    value: {
      visitId: String(body.id).toLowerCase(),
      customerId: String(body.customerId).toLowerCase(),
      visitDate: body.visitDate,
      visitMinute: minute.value,
      planned: body.planned,
      products,
      comment,
      reason,
    },
  };
}

export type MissedActivityEntry = { activityDate: string; clear: false; draft: DayActivityDraft } | { activityDate: string; clear: true; draft: null };

export type MissedActivityParse = { ok: true; value: MissedActivityEntry } | { ok: false; error: string };

/** One missed day activity from the wire — or the clearing of one he entered himself. */
export function parseMissedActivity(raw: unknown, visitDay: string): MissedActivityParse {
  const body = bodyOf(raw);
  if (!isMissedRecordDay(body.activityDate, visitDay)) {
    return { ok: false, error: "Choose the day: today or an earlier day." };
  }
  if (body.clear === true) return { ok: true, value: { activityDate: body.activityDate, clear: true, draft: null } };
  const draft = parseDayActivityDraft(body);
  if (!draft.ok) return draft;
  return { ok: true, value: { activityDate: body.activityDate, clear: false, draft: draft.value } };
}

function personKey(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

/**
 * Whether a VISIT was entered for its rep by somebody who was not on it — which only the Super Admin's
 * missed-record entry does (see the header). Read from who entered it, never from `capture_source`.
 */
export function isEnteredForRep(visit: { enteredBy: unknown; rep: unknown; manager: unknown; senior: unknown }): boolean {
  const enteredBy = personKey(visit.enteredBy);
  if (!enteredBy) return false;
  return ![visit.rep, visit.manager, visit.senior].some((person) => personKey(person) === enteredBy);
}

/**
 * Whether a DAY ACTIVITY was entered by somebody other than its rep. Only the rep writes his own day
 * (a manager never does), so anyone else is the Super Admin.
 */
export function isActivityEnteredForRep(activity: { enteredBy: unknown; rep: unknown }): boolean {
  const enteredBy = personKey(activity.enteredBy);
  return Boolean(enteredBy) && enteredBy !== personKey(activity.rep);
}

/**
 * Whether a calendar cell opens for the Super Admin to enter what is missing. `through` is the last day
 * he may enter for (the visit day running now), null for everyone else — whose cells open only on a
 * day with work on it, as before.
 */
export function opensForMissedRecords(day: string, through: string | null): boolean {
  return through !== null && isMissedRecordDay(day, through);
}
