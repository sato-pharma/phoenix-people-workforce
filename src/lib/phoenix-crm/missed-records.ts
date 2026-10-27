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

/** The three kinds of visit the Super Admin may enter for a rep — the same three the rep logs himself. */
export type MissedVisitKind = "single" | "double" | "chain";

export const MISSED_VISIT_KIND_LABELS: Record<MissedVisitKind, string> = {
  single: "Single",
  double: "Double",
  chain: "Chain",
};

export type MissedVisitEntry = {
  visitId: string;
  customerId: string;
  visitDate: string;
  /** Minutes past midnight in Cairo; null when he gave no time. */
  visitMinute: number | null;
  /** HIS choice — never read from the plan. */
  planned: boolean;
  /** HIS choice (owner, 2026-10-24); who stands in each place is checked against the organogram on the server. */
  kind: MissedVisitKind;
  /**
   * Everyone ticked in the picker (visit-company.ts), in the order ticked — one on a double, two or more
   * on a chain (owner, 2026-10-27: "Everything is applicable"), nobody on a single. Who each one is, and
   * the kind the visit is filed under, is settled on the server against the territory's own offers.
   */
  picked: string[];
  /** Optional on his entry (owner, 2026-10-24) — possibly empty. */
  products: string[];
  /** Optional on his entry (owner, 2026-10-24); null when he wrote none. */
  comment: string | null;
  /** Why the rep was there off his plan; set only on an unplanned visit. */
  reason: string | null;
};

export type MissedVisitParse = { ok: true; value: MissedVisitEntry } | { ok: false; error: string };

function hrIdOrNull(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  return text || null;
}

/**
 * One missed visit from the wire.
 *
 * 🔴 THE PRODUCTS AND THE COMMENT ARE OPTIONAL HERE, AND ONLY HERE (owner, 2026-10-24: "make product
 * choosing optional and comment optional only when admin is entering a visit for a rep"). A rep's own
 * visit still requires both (owner, 2026-09-30), and so does every other door; the database widens its
 * products CHECK for an 'admin' visit alone (20261024213000). The kind — single, double or chain — is
 * his too; the people on it are named here and checked against the territory's chain on the server.
 * The reason is still required on an unplanned one: the manager decides it, and has to know why.
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

  // An older screen sends no kind: that visit was a single one, as every entry was before.
  const kind: MissedVisitKind = body.kind === undefined || body.kind === null ? "single" : (body.kind as MissedVisitKind);
  if (kind !== "single" && kind !== "double" && kind !== "chain") return { ok: false, error: "Choose single, double or chain." };
  // A screen opened before 2026-10-27 still sends the manager and the one above him by name.
  const sent: unknown[] = Array.isArray(body.picked) ? body.picked : [body.managerHrId, body.seniorHrId];
  const picked: string[] = [];
  for (const entry of sent) {
    const hrId = hrIdOrNull(entry);
    if (hrId && !picked.includes(hrId)) picked.push(hrId);
  }
  if (kind === "single") picked.length = 0;
  if (kind === "double" && picked.length !== 1) return { ok: false, error: "Choose the one person who was on the double visit." };
  if (kind === "chain" && picked.length < 2) return { ok: false, error: "Choose the two or more people who were on the chain visit." };

  const products: string[] = [];
  for (const entry of Array.isArray(body.products) ? body.products : []) {
    const product = typeof entry === "string" ? entry.trim() : "";
    if (product && !products.includes(product)) products.push(product);
  }
  if (products.length > VISIT_PRODUCTS_MAX) return { ok: false, error: `Choose at most ${VISIT_PRODUCTS_MAX} products.` };

  const comment = (typeof body.comment === "string" ? body.comment.trim() : "") || null;
  if (comment && comment.length > VISIT_COMMENT_MAX) return { ok: false, error: `Keep the comment under ${VISIT_COMMENT_MAX} characters.` };

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
      kind,
      picked,
      products,
      comment,
      reason,
    },
  };
}

// ── A manager's missed record (owner, 2026-10-24: "Visits and days") ────────────────────────────

export type MissedManagerVisitEntry = {
  clientRef: string;
  /** A customer of a rep list he reaches, or one of Manager's own list — exactly one. */
  customerId: string | null;
  managerCustomerId: string | null;
  visitDate: string;
  visitMinute: number | null;
  products: string[];
  comment: string | null;
  /** Where the doctor is, typed — required only when the customer's territory is vacant (decided on the server). */
  address: string | null;
};

export type MissedManagerVisitParse = { ok: true; value: MissedManagerVisitEntry } | { ok: false; error: string };

/** The most an address on a manager's visit may hold — `MANAGER_CUSTOMER_ADDRESS_MAX`, restated so this file stays pure. */
const MANAGER_VISIT_ADDRESS_MAX = 300;
const MANAGER_VISIT_COMMENT_MAX = 1000;
const MANAGER_VISIT_PRODUCTS_MAX = 12;

/**
 * One missed single visit of a manager's own, from the wire. Products and comment are optional, as they
 * are on a visit he logs himself; whether it was planned is read from HIS plan on the server (a manager's
 * unplanned visit asks nobody's approval, so there is no choice to make — only a fact to file).
 */
export function parseMissedManagerVisit(raw: unknown, visitDay: string): MissedManagerVisitParse {
  const body = bodyOf(raw);
  if (!isUuid(body.id)) return { ok: false, error: "Reload the page and enter the visit again." };
  const customerId = isUuid(body.customerId) ? String(body.customerId).toLowerCase() : null;
  const managerCustomerId = isUuid(body.managerCustomerId) ? String(body.managerCustomerId).toLowerCase() : null;
  if ((customerId === null) === (managerCustomerId === null)) return { ok: false, error: "Choose the customer the manager visited." };
  if (!isMissedRecordDay(body.visitDate, visitDay)) return { ok: false, error: "Choose the day of the visit: today or an earlier day." };
  const minute = parseVisitTime(body.visitTime);
  if (!minute.ok) return minute;

  const products: string[] = [];
  for (const entry of Array.isArray(body.products) ? body.products : []) {
    const product = typeof entry === "string" ? entry.trim() : "";
    if (product && !products.includes(product)) products.push(product);
  }
  if (products.length > MANAGER_VISIT_PRODUCTS_MAX) return { ok: false, error: `Choose at most ${MANAGER_VISIT_PRODUCTS_MAX} products.` };

  const comment = (typeof body.comment === "string" ? body.comment.trim().replace(/\s+/g, " ") : "") || null;
  if (comment && comment.length > MANAGER_VISIT_COMMENT_MAX) return { ok: false, error: `Keep the comment under ${MANAGER_VISIT_COMMENT_MAX} characters.` };
  const address = (typeof body.address === "string" ? body.address.trim().replace(/\s+/g, " ") : "") || null;
  if (address && address.length > MANAGER_VISIT_ADDRESS_MAX) return { ok: false, error: `Keep the address under ${MANAGER_VISIT_ADDRESS_MAX} characters.` };

  return {
    ok: true,
    value: {
      clientRef: `admin:${String(body.id).toLowerCase()}`,
      customerId,
      managerCustomerId,
      visitDate: body.visitDate,
      visitMinute: minute.value,
      products,
      comment,
      address,
    },
  };
}

/**
 * The instant a missed visit is filed at: the time he gave on the day he chose, in Cairo — noon when he gave
 * none — and never later than `now`. The small hours before 02:00 belong to the day before, exactly as
 * phoenix_crm_admin_enter_visit reads them for a rep's.
 */
export function missedVisitInstant(date: string, minute: number | null, now: Date, offsetMinutesAt: (at: Date) => number): Date {
  const effective = minute ?? MISSED_VISIT_DEFAULT_MINUTE;
  const [year, month, day] = date.split("-").map(Number);
  const wall = Date.UTC(year, month - 1, day + (effective < VISIT_DAY_CUTOFF_MINUTE ? 1 : 0), 0, effective);
  // The offset is read at the wall time taken as UTC, then once more at the instant it gives: right on both
  // sides of a clock change, which is the one place a single read can be an hour out.
  const first = wall - offsetMinutesAt(new Date(wall)) * 60_000;
  const at = new Date(wall - offsetMinutesAt(new Date(first)) * 60_000);
  return at.getTime() > now.getTime() ? now : at;
}

/** Whether a manager's own visit was entered for him by somebody else — which only the Super Admin's missed record does. */
export function isManagerVisitEnteredForHim(visit: { enteredBy: unknown; manager: unknown }): boolean {
  const enteredBy = personKey(visit.enteredBy);
  return Boolean(enteredBy) && enteredBy !== personKey(visit.manager);
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

export type RemoveMissedVisitParse = { ok: true; value: { visitId: string } } | { ok: false; error: string };

/**
 * Which entered visit to remove (owner, 2026-10-01: "add a way to remove a missed visit I entered by
 * mistake"). The wire names the visit and nothing else: whether it may go — a visit HE entered, never a
 * rep's own — is phoenix_crm_admin_remove_visit's to decide, from the row itself.
 */
export function parseRemoveMissedVisit(raw: unknown): RemoveMissedVisitParse {
  const body = bodyOf(raw);
  if (!isUuid(body.visitId)) return { ok: false, error: "Reload the page and try again." };
  return { ok: true, value: { visitId: String(body.visitId).toLowerCase() } };
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
