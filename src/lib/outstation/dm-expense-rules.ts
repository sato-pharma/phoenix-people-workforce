/**
 * THE DISTRICT MANAGER EXPENSE RULES (owner, 28 Nov 2026) — pure, so every number here is tested.
 *
 * He dictated them in the District Manager expense policy of November 2026 and then said "Build them now".
 * They apply to a District Manager's outstation claim ONLY (his pick: "District Managers only"); a Medical
 * Rep and every other claimant keep the rules they had.
 *
 *   1. The two trip photos are at least 3 hours apart — the departure camera does not take its photo
 *      until 3 hours after the arrival ("Regarding the departure, not to be less than 3 hours from the
 *      arrival"). Refused where it is taken, the way the window-closed and blank-photo rules are, so a
 *      claim is never rejected after the fact.
 *   2. A ticket is added within 12 hours of the District Manager's first double visit of that day
 *      ("12 hours from the first double visit done for this district manager at this day"); with no
 *      double visit that day, within 12 hours of the end of the trip's last day.
 *   3. Each trip day's allowance is paid by the day's work: more than 150 km from home, a PM half day is
 *      allowed; 150 km or less, a full day is AM with at least 1 (a contract account or a hospital) and PM
 *      with at least 6 evening visits, no AM visit counts as PM only = half; fewer than 6 PM is paid
 *      in proportion, PM / 6 at most. The AM minimum was 2 as dictated, lowered to 1 by the owner the same
 *      evening ("make the am account 1 instead of 2", 28 Nov 2026). Only the allowance moves — never fuel or tickets.
 *   4. On every trip day the District Manager confirms the first and the last double visit a rep logs with
 *      him, and the confirmation records where he was. A day without both loses its whole allowance.
 */
import { cairoMidnightUtcIso } from "@/lib/attendance/timezone";

const HOUR_MS = 60 * 60 * 1000;
const CAIRO = "Africa/Cairo";

/** True for a claim filed under the District Manager role. Client-safe: the wizard reads it too. */
export function isDistrictManagerRole(role: string | null | undefined): boolean {
  return String(role ?? "").trim().toLowerCase() === "district manager";
}

export const DM_TRIP_PHOTO_GAP_HOURS = 3;
export const DM_TICKET_WINDOW_HOURS = 12;
export const DM_FULL_DAY_DISTANCE_KM = 150;
export const DM_AM_MINIMUM = 1;
export const DM_PM_MINIMUM = 6;

/** The version stamp a District Manager claim filed under these rules carries (`dm_work_allowance.rules`). */
export const DM_EXPENSE_RULES_VERSION = "dm-2026-11";

function instant(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

const CAIRO_TIME = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "short",
  timeZone: CAIRO,
});

/** e.g. "28 Nov, 14:05" in Cairo time — the words a refusal prints. */
export function cairoShortTime(ms: number): string {
  return CAIRO_TIME.format(new Date(ms));
}

// ── 1. The 3-hour gap ────────────────────────────────────────────────────────────────────────────

/**
 * The arrival instant the 3-hour gap counts from. The arrival photo's own time comes from the phone, so
 * on an online claim it is never taken as earlier than half an hour before the server received the
 * claim: a phone clock set back cannot open the departure camera early. An offline claim has only the
 * phone's time, because it reached the server later by design.
 */
export function dmArrivalAnchor(input: {
  arrivalCapturedAt: string | null | undefined;
  offlineCaptured: boolean;
  submittedAt: string | null | undefined;
}): number | null {
  const arrival = instant(input.arrivalCapturedAt);
  const submitted = instant(input.submittedAt);
  if (input.offlineCaptured || submitted === null) return arrival;
  const floor = submitted - 30 * 60 * 1000;
  return arrival === null ? floor : Math.max(arrival, floor);
}

/** The refusal for a departure photo taken under 3 hours after the arrival, or null when it may be taken. */
export function dmDepartureTooSoonMessage(input: { arrivalAnchorMs: number | null; nowMs: number }): string | null {
  if (input.arrivalAnchorMs === null) return null;
  const opensAt = input.arrivalAnchorMs + DM_TRIP_PHOTO_GAP_HOURS * HOUR_MS;
  if (input.nowMs >= opensAt) return null;
  return (
    `The departure photo must be at least ${DM_TRIP_PHOTO_GAP_HOURS} hours after the arrival photo. ` +
    `Take it at the end of the trip, from ${cairoShortTime(opensAt)}.`
  );
}

/** When the departure camera opens for a District Manager, as an ISO instant (the portal card shows it). */
export function dmDepartureOpensAt(arrivalAnchorMs: number | null): string | null {
  return arrivalAnchorMs === null ? null : new Date(arrivalAnchorMs + DM_TRIP_PHOTO_GAP_HOURS * HOUR_MS).toISOString();
}

// ── 2. Tickets within 12 hours ───────────────────────────────────────────────────────────────────

/**
 * The last instant a ticket may be added: 12 hours after the District Manager's first double visit of the
 * ticket's day, else 12 hours after the end of the trip's last Cairo day.
 */
export function dmTicketDeadline(input: {
  firstDoubleVisitAt: string | null | undefined;
  tripEndDate: string | null | undefined;
}): { basis: "first_double_visit" | "trip_end"; deadlineMs: number } | null {
  const first = instant(input.firstDoubleVisitAt);
  if (first !== null) return { basis: "first_double_visit", deadlineMs: first + DM_TICKET_WINDOW_HOURS * HOUR_MS };
  const lastDay = String(input.tripEndDate ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lastDay)) return null;
  const endOfLastDay = Date.parse(cairoMidnightUtcIso(lastDay, 1, CAIRO));
  return { basis: "trip_end", deadlineMs: endOfLastDay + DM_TICKET_WINDOW_HOURS * HOUR_MS };
}

/** The refusal for a ticket added after its 12 hours, or null when it is in time. */
export function dmTicketTooLateMessage(input: {
  deadline: { basis: "first_double_visit" | "trip_end"; deadlineMs: number } | null;
  nowMs: number;
}): string | null {
  if (!input.deadline || input.nowMs <= input.deadline.deadlineMs) return null;
  const from =
    input.deadline.basis === "first_double_visit"
      ? "your first double visit of that day"
      : "the end of the trip's last day";
  return (
    `A ticket must be added within ${DM_TICKET_WINDOW_HOURS} hours of ${from}, and that time ended on ` +
    `${cairoShortTime(input.deadline.deadlineMs)}. It is not accepted now.`
  );
}

/** Where a ticket file came from: the app's own camera, or a file the phone chose. */
export type DmTicketFile = { contentType: string; source?: string | null };

/**
 * A District Manager's ticket (owner, 28 Nov 2026): a paper ticket is photographed live in the app, and
 * an online ticket is the operator's original PDF. A picture from the gallery, a screenshot included,
 * is refused. Null when every file passes.
 */
export function dmTicketSourceRefusal(files: ReadonlyArray<DmTicketFile>): string | null {
  const bad = files.find((file) => file.contentType !== "application/pdf" && file.source !== "live_camera");
  if (!bad) return null;
  return (
    "A ticket photo must be taken live in the app: tap \u201cTake a photo of the ticket\u201d. An online ticket " +
    "must be the operator's original PDF. A screenshot or a picture from the gallery is not accepted."
  );
}

// ── 3 and 4. The day's work and the confirmed double visits ──────────────────────────────────────

export type DmDoubleVisit = {
  capturedAt: string;
  confirmedAt: string | null;
  id: string;
  repName: string | null;
};

export type DmTripDayWork = {
  /** AM visits that day: hospitals and contract accounts (the AM list), his own and his double visits. */
  am: number;
  /** The double visits reps logged with him that day, any order. */
  doubleVisits: DmDoubleVisit[];
  /** False while the day is not over yet (the CRM day ends at 02:00), so its count can still grow. */
  final: boolean;
  /** PM visits that day: the evening clinic list. Pharmacies are never inside PM or AM. */
  pm: number;
};

export type DmDayVerdict = {
  am: number;
  /** The day's allowance before the rule. */
  baseAmount: number;
  /** Both the first and the last double visit confirmed (true when the day had exactly one and it is). */
  confirmed: boolean;
  date: string;
  final: boolean;
  /** The share of the day's allowance paid, 0–1. */
  factor: number;
  firstVisitId: string | null;
  lastVisitId: string | null;
  paidAmount: number;
  pm: number;
  /** One plain sentence: how the day was worked out. */
  reason: string;
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The first and the last double visit of a day, by when the rep logged it. */
export function firstAndLastDoubleVisit(visits: DmDoubleVisit[]): { first: DmDoubleVisit | null; last: DmDoubleVisit | null } {
  const sorted = [...visits]
    .filter((v) => instant(v.capturedAt) !== null)
    .sort((a, b) => (instant(a.capturedAt) ?? 0) - (instant(b.capturedAt) ?? 0) || a.id.localeCompare(b.id));
  return { first: sorted[0] ?? null, last: sorted[sorted.length - 1] ?? null };
}

/**
 * One trip day, judged. `km` is the trip's distance from home. The share is the work rule; an unconfirmed
 * first or last double visit — or no double visit at all — makes the day pay nothing.
 */
export function judgeDmTripDay(input: {
  baseAmount: number;
  date: string;
  km: number | null;
  work: DmTripDayWork;
}): DmDayVerdict {
  const { am, pm, doubleVisits, final } = input.work;
  const { first, last } = firstAndLastDoubleVisit(doubleVisits);
  const confirmed = Boolean(first?.confirmedAt) && Boolean(last?.confirmedAt);
  const far = typeof input.km === "number" && input.km > DM_FULL_DAY_DISTANCE_KM;
  const half = !far && am < DM_AM_MINIMUM;
  const pmShare = Math.min(Math.max(pm, 0), DM_PM_MINIMUM) / DM_PM_MINIMUM;
  const workFactor = (half ? 0.5 : 1) * pmShare;
  const factor = confirmed ? workFactor : 0;
  const paidAmount = round2(input.baseAmount * factor);

  const parts: string[] = [];
  if (far) parts.push(`More than ${DM_FULL_DAY_DISTANCE_KM} km from home: a PM half day is allowed`);
  else if (half) parts.push(`${am === 0 ? "No AM visit" : `${am} AM (fewer than ${DM_AM_MINIMUM})`} counts as PM only: half`);
  else parts.push(`${am} AM`);
  parts.push(pm >= DM_PM_MINIMUM ? `${pm} PM` : `${pm} of ${DM_PM_MINIMUM} PM`);
  let reason = parts.join("; ") + ".";
  if (!first) reason = `No double visit with you that day, so nothing to confirm: no allowance. ${reason}`;
  else if (!confirmed) {
    const missing =
      first.id === last?.id
        ? "The day's double visit is not confirmed"
        : [!first.confirmedAt ? "the first" : null, !last?.confirmedAt ? "the last" : null].filter(Boolean).join(" and ") +
          " double visit not confirmed";
    reason = `${missing.charAt(0).toUpperCase()}${missing.slice(1)}: no allowance. ${reason}`;
  }
  if (!final) reason = `The day is not over yet. ${reason}`;

  return {
    am,
    baseAmount: input.baseAmount,
    confirmed,
    date: input.date,
    factor,
    final,
    firstVisitId: first?.id ?? null,
    lastVisitId: last?.id ?? null,
    paidAmount,
    pm,
    reason,
  };
}

export type DmWorkAllowanceRecord = {
  /** Every day final: nothing more can change the figure. */
  final: boolean;
  days: DmDayVerdict[];
  km: number | null;
  pricedAt: string;
  rules: typeof DM_EXPENSE_RULES_VERSION;
  /** The allowance the claim had before the rule, and what it pays now. */
  allowanceBefore: number;
  allowanceAfter: number;
  /**
   * What submit could not refuse and the approver must see (an offline replay's gallery ticket or train fare
   * over its cap, a fare above a nearest-route estimate). Kept through every re-price.
   */
  evidenceFlags?: string[];
  /** The submit stamp, before the first pricing: nothing is priced yet. Absent once priced. */
  initial?: true;
};

type AllowanceRow = {
  amount: number;
  label: string;
  skipped?: boolean;
  skipReason?: string | null;
  type: "overnight" | "return_day" | "same_day";
  /** The allowance the day had before the work rule (kept so a re-price starts from it, never from a cut). */
  baseAmount?: number;
  workReason?: string | null;
};

/**
 * The whole claim: each allowance row is its trip day (row i = start + i days, the shape of the raw
 * breakdown and `allowanceRowDates`). A row already at 0 (a day another claim holds, the Cairo rule) stays 0.
 */
export function planDmWorkAllowance<Row extends AllowanceRow>(input: {
  km: number | null;
  now: string;
  rowDates: string[];
  rows: Row[];
  work: (date: string) => DmTripDayWork;
  /** The stored record's flags, carried over unchanged. */
  evidenceFlags?: string[];
}): { record: DmWorkAllowanceRecord; rows: Row[] } {
  const days: DmDayVerdict[] = [];
  let before = 0;
  let after = 0;
  const rows = input.rows.map((row, i) => {
    const date = input.rowDates[i] ?? "";
    const base = typeof row.baseAmount === "number" ? row.baseAmount : row.amount;
    before += base;
    if (row.skipped || base <= 0 || !date) {
      after += row.skipped ? 0 : base;
      return { ...row, baseAmount: base };
    }
    const verdict = judgeDmTripDay({ baseAmount: base, date, km: input.km, work: input.work(date) });
    days.push(verdict);
    after += verdict.paidAmount;
    return { ...row, amount: verdict.paidAmount, baseAmount: base, workReason: verdict.reason };
  });
  return {
    record: {
      allowanceAfter: round2(after),
      allowanceBefore: round2(before),
      days,
      ...(input.evidenceFlags && input.evidenceFlags.length > 0 ? { evidenceFlags: [...input.evidenceFlags] } : {}),
      final: days.every((d) => d.final),
      km: input.km,
      pricedAt: input.now,
      rules: DM_EXPENSE_RULES_VERSION,
    },
    rows,
  };
}

const finiteOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const out = Number(value);
  return Number.isFinite(out) ? out : null;
};

/** The stamp a District Manager trip claim gets at submit: the rules apply to it, nothing priced yet. */
export function initialDmWorkAllowanceStamp(now: string, evidenceFlags: string[] = []): DmWorkAllowanceRecord {
  return {
    allowanceAfter: 0,
    allowanceBefore: 0,
    days: [],
    ...(evidenceFlags.length > 0 ? { evidenceFlags: [...evidenceFlags] } : {}),
    final: false,
    initial: true,
    km: null,
    pricedAt: now,
    rules: DM_EXPENSE_RULES_VERSION,
  };
}

/** The stored record, or null on a claim filed before the rules. */
export function readDmWorkAllowance(value: unknown): DmWorkAllowanceRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<DmWorkAllowanceRecord>;
  if (record.rules !== DM_EXPENSE_RULES_VERSION) return null;
  return {
    allowanceAfter: finiteOrNull(record.allowanceAfter) ?? 0,
    allowanceBefore: finiteOrNull(record.allowanceBefore) ?? 0,
    days: Array.isArray(record.days) ? record.days : [],
    ...(Array.isArray(record.evidenceFlags) && record.evidenceFlags.length > 0
      ? { evidenceFlags: record.evidenceFlags.map(String).filter(Boolean) }
      : {}),
    final: record.final === true,
    // A stamp written before the marker existed: no days and never final is the unpriced submit stamp.
    ...(record.initial === true || (record.final !== true && (!Array.isArray(record.days) || record.days.length === 0))
      ? { initial: true as const }
      : {}),
    km: finiteOrNull(record.km),
    pricedAt: String(record.pricedAt ?? ""),
    rules: DM_EXPENSE_RULES_VERSION,
  };
}

/** The instant a CRM visit day closes: 02:00 Cairo the next morning. */
export function crmDayClosesAt(day: string): number {
  return Date.parse(cairoMidnightUtcIso(day, 1, CAIRO)) + 2 * 60 * 60 * 1000;
}

/** True when the visit reached the server (`created_at`) before its CRM day closed. */
export function arrivedBeforeDayClosed(row: { created_at?: unknown; visit_date?: unknown }): boolean {
  const day = String(row.visit_date ?? "");
  const arrived = Date.parse(String(row.created_at ?? ""));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(arrived)) return true;
  return arrived <= crmDayClosesAt(day);
}

/**
 * True when someone set the claim's allowance by hand after the system priced it (an approver's or HR's
 * edit, updateManagerExpenseAsAdmin): the pricer never writes over it, and the desk's idle-day cut is
 * offered again, because the edited figure was not cut by the work rule.
 */
export function dmAllowanceEditedSincePriced(record: DmWorkAllowanceRecord | null, allowanceAmount: number): boolean {
  if (!record || record.initial) return false;
  return Math.abs(allowanceAmount - record.allowanceAfter) > 0.01;
}

/**
 * The claim's expected total once the allowance moved by `delta`. A not-eligible claim's expected total is
 * 0 whatever its parts (reportExpectedTotal in service.ts) and stays where it is; any other never goes below 0.
 */
export function dmExpectedTotalAfter(input: { delta: number; eligibilityStatus: string; expected: number }): number {
  if (input.eligibilityStatus === "not_eligible") return input.expected;
  return round2(Math.max(0, input.expected + input.delta));
}

/**
 * Why a District Manager trip under the work rules cannot be approved yet, or null when it can (owner,
 * 28 Nov 2026). Its allowance is priced on each trip day's work and confirmed double visits, and an
 * approval freezes the figure: approved before every day is over, a later day would stay at what it paid
 * so far (often nothing). So Approve waits until every trip day is final.
 */
export function dmAllowanceApprovalHold(
  record: DmWorkAllowanceRecord | null,
  tripEndDate: string | null,
  nowMs: number,
): string | null {
  if (!record || record.final) return null;
  const day = tripEndDate && /^\d{4}-\d{2}-\d{2}/.test(tripEndDate) ? tripEndDate.slice(0, 10) : null;
  // The trip's last day has closed but the record was priced before it did: not held here. The approval
  // itself prices it on the finished trip first (approveOutstationRequestForPayroll) and asks him to look again.
  if (day && nowMs >= crmDayClosesAt(day)) return null;
  const last = day
    ? new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "Africa/Cairo", year: "numeric" })
    : null;
  return (
    "This District Manager trip is paid on each trip day's field work and its confirmed double visits, and " +
    `not every day is priced yet${last ? ` (the trip's last day, ${last}, closes at 02:00 the next morning)` : ""}. ` +
    "Approve it once the work allowance check reads final; approving now would freeze the days still open. " +
    "You can still reject it."
  );
}
