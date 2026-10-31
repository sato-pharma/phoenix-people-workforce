/**
 * Phoenix CRM — the weekly plan's rules, with no I/O.
 *
 * Owner, 2026-09-16, amended 2026-09-22:
 *   - Nothing about the list ever stops a rep planning. A customer carried over from iReports360 and
 *     not validated yet is planned like any other — he simply has no place and no timings, and he
 *     counts in no report until he is validated. The rep places the customers; the system assists and
 *     never plans for them.
 *   - Each customer's timings show. Placing a customer on a day his saved hours do not cover is NEVER
 *     blocked and asks nothing (owner, 2026-09-30: "never block, because the rep didn't add his time"):
 *     the hours are the rep's own entry and may simply be missing. A reason an older caller still sends
 *     is kept; an "Other" with no note drops the empty reason, never the customer.
 *   - A plan day holds at most 15 PM doctors and 5 AM accounts (settings). These are the only hard
 *     limits, and they bind the plan only — visits are never capped.
 *   - The district manager approves; the SFE Manager sees every plan and can return one. The system
 *     never approves a plan.
 * The week: Saturday to Wednesday plus Thursday morning (accounts only); never Friday (calendar.ts).
 */

import { CAIRO_MONTHS } from "@/lib/format/cairo-datetime";
import { isUuid as isUuidText } from "@/lib/http/uuid";
import { formatPhoenixLongDate } from "@/lib/i18n/format";
import { editablePlanDays, fieldWeekDays, planDayListTypes, PLAN_DEADLINE_LABEL, weekdayOfIsoDay } from "@/lib/phoenix-crm/calendar";
import { sharedPlanCapRefusal, type SharedPlaceNamed } from "@/lib/phoenix-crm/shared-place-rules";
import { formatTimingWindow, PHOENIX_CRM_WEEKDAY_NAMES, windowsForWeekday } from "@/lib/phoenix-crm/timings";
import type { PhoenixCrmDoctorListType, PhoenixCrmPlanStatus, PhoenixCrmSettings, PhoenixCrmTiming } from "@/lib/phoenix-crm/types";

export const PLAN_EXCEPTION_TYPES = [
  { key: "another_place", label: "At another place" },
  { key: "by_appointment", label: "By appointment" },
  { key: "timings_changed", label: "Timings changed" },
  { key: "other", label: "Other (write a note)" },
] as const;

export type PlanExceptionType = (typeof PLAN_EXCEPTION_TYPES)[number]["key"];

const EXCEPTION_KEYS = new Set<string>(PLAN_EXCEPTION_TYPES.map((type) => type.key));

export const PLAN_NOTE_MAX = 300;
export const PLAN_DECISION_NOTE_MAX = 500;
/** A request-body field that is a uuid, checked by the one uuid test Phoenix keeps (@/lib/http/uuid). */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && isUuidText(value);
}

export function exceptionLabel(type: string | null): string | null {
  if (!type) return null;
  return PLAN_EXCEPTION_TYPES.find((entry) => entry.key === type)?.label ?? null;
}

export function planStatusLabel(status: PhoenixCrmPlanStatus | null): string {
  if (status === "submitted") return "Waiting for review";
  if (status === "approved") return "Approved";
  if (status === "returned") return "Returned for changes";
  if (status === "draft") return "Draft";
  return "Not started";
}

/**
 * 🔴 THE STATUS NAMES THE PERSON IT IS WAITING ON (owner, 2026-10-08: *"make the plan status be
 * appearing ex drafted by Mostafa Galal, waiting Dr Taha approval, waiting Mostafa to edit and resend
 * and so on"*).
 *
 * `planStatusLabel` above says what STATE the row is in; this says WHOSE it is, which is the thing a
 * manager and a rep both actually read the pill for. "Waiting for review" never answered "waiting for
 * WHOM" on a board of nine territories with three different managers above them, and "Returned for
 * changes" never answered "returned to whom, and what happens next" — the same gap that made a
 * returned week read as lost (`planTurnSentence`).
 *
 * It is the SAME four states and the same tone, so nothing about the colour or the ordering moves —
 * only the words. Every name arrives already resolved: this file prints no dates and reads no people.
 * With no name to use it falls back to `planStatusLabel`'s own word, so a vacant seat or a territory
 * whose manager chain is empty still reads correctly rather than saying "waiting for null".
 */
export function planStatusLine(input: {
  status: PhoenixCrmPlanStatus | null;
  /** The territory's rep, resolved to a name; null on a vacant seat. */
  repName?: string | null;
  /** The manager who approves this territory's weeks; null when the chain above it is vacant. */
  reviewerName?: string | null;
  /** Who decided it last, for an approved week; falls back to the reviewer, then to the bare word. */
  deciderName?: string | null;
  /** The reader is the rep himself: his own screen says "you", never his own name (owner walk, 2026-10-28). */
  self?: boolean;
  /**
   * Every day of the week has passed. A week with no plan then can no longer be drafted, so it never
   * says "drafts it" (the production smoke test, 2026-10-29: Weeks 1 to 3 of October read "Not started —
   * Atef Sherif drafts it" on 29 October).
   */
  passed?: boolean;
}): string {
  const rep = input.self ? "you" : nameOrNull(input.repName);
  const reviewer = nameOrNull(input.reviewerName);
  const decider = nameOrNull(input.deciderName) ?? reviewer;
  if (input.status === "draft") return rep ? `Drafted by ${rep}` : planStatusLabel("draft");
  if (input.status === "submitted") return reviewer ? `Waiting for ${reviewer} to approve` : planStatusLabel("submitted");
  if (input.status === "returned") return rep ? `Waiting for ${rep} to edit and resend` : planStatusLabel("returned");
  if (input.status === "approved") return decider ? `Approved by ${decider}` : planStatusLabel("approved");
  if (input.passed) return PLAN_NEVER_PLANNED_TEXT;
  if (input.self) return "Not started — you draft it";
  return rep ? `Not started — ${rep} drafts it` : planStatusLabel(null);
}

/** A week that passed with no plan at all. */
export const PLAN_NEVER_PLANNED_TEXT = "Never planned — the week has passed";

function nameOrNull(value: string | null | undefined): string | null {
  const name = typeof value === "string" ? value.trim() : "";
  return name.length > 0 ? name : null;
}

/**
 * When a plan is due, as a rep reads it: the date AND the hour (owner, 2026-10-02 — "the deadline to
 * submit the plan is thuersday 11:5pm and show themn this").
 *
 * ONE composer, so every screen showing a due date shows the same deadline. Showing the date alone is
 * what this replaces: the cut-off was midnight, nothing said so, and the rep was left to guess the hour
 * of the one thing his week is judged on. `PLAN_DEADLINE_LABEL` holds the wording and
 * `planDeadlinePassed` the verdict — never a second copy of either.
 */
export function planDueLabel(dueOn: string | null | undefined): string {
  if (!dueOn) return "—";
  return withPlanDeadline(formatPhoenixLongDate(dueOn));
}

/**
 * The deadline joined onto a due date someone has ALREADY formatted — for a screen with its own date
 * style, so it can carry the hour without being dragged onto the long format.
 *
 * The Team tab is why this exists (owner, 2026-10-02): a reviewer reads "Thu 8 Oct 2026" there, in a
 * compact row beside a dozen reps, and a long date would not fit it. The join and the wording still live
 * in ONE place, so the two screens can never drift to two different deadlines.
 *
 * "at", not a comma: the long date already carries one after the weekday, and "Thursday, 8 October 2026,
 * 11:55 PM" reads as a list rather than as a time.
 */
export function withPlanDeadline(dateText: string): string {
  return `${dateText} at ${PLAN_DEADLINE_LABEL}`;
}

/** A rep edits a draft or a returned plan. Submitted and approved plans are reopened first. */
export function isPlanEditable(status: PhoenixCrmPlanStatus): boolean {
  return status === "draft" || status === "returned";
}

/**
 * 🔴 A PLAN THAT HAS GONE FOR REVIEW — THE ONE THING THAT MAKES A VISIT "PLANNED", AND THE FILTER THAT
 * MUST NOT BE DROPPED FOR LOOKING REDUNDANT.
 *
 * A draft plan is the rep's own to edit and today is an editable day, so counting a plain plan row
 * would let him place the doctor at the door, save seconds later and never be off plan — the approval
 * would never happen and the rule would be theatre. A RETURNED plan is his to edit too, so it is not
 * authority either. The exact complement of `isPlanEditable`, named for what it means at the door.
 * This answers for a WEEK; a reader asking about one DAY asks `planDayStatus` first, because a week
 * returned for one day still stands as sent on its other days (owner, 2026-10-02).
 *
 * `phoenix_crm_save_visit` is stricter still: it asks whether the plan had reached review BEFORE this
 * visit's server-issued `captured_at`, which a form being drawn cannot know yet. The two disagree only
 * when the rep reopens his plan between opening the form and saving, and then the save comes back
 * asking for his reason — the database is the authority and the screen never overrules it.
 */
export function isPlanSentForReview(status: PhoenixCrmPlanStatus | null): boolean {
  return status === "submitted" || status === "approved";
}

/**
 * What a rep may do with one week (owner, 2026-10-01 — weekly only, and a sent week changes only
 * through "Ask to edit this week": the district manager, then SFE, then HR's acknowledgement).
 *
 *   - plan   — he may tick, save and send it;
 *   - sent   — it is sent or approved, and he may ask to edit it;
 *   - asked  — it is sent and his request to edit it is on its way;
 *   - closed — greyed out: a week that has passed, a week ahead of his one, or a week he never sent
 *              that is not the one he is in.
 *
 * The ONE week he plans is `repPlanWeek`. Three other weeks open for him: one his manager RETURNED (the
 * manager asked for changes), one an edit request REOPENED, and the week he is IN while he has never
 * sent it — late, and stamped late (owner, 2026-10-02). Every other week is closed, which is the whole
 * rule — the board greys it, and the server refuses it.
 */
export type RepWeekState = "plan" | "sent" | "asked" | "closed";

export function repWeekState(input: {
  weekStart: string;
  /** The week's own open window: true while it has a day from today on. */
  open: boolean;
  status: PhoenixCrmPlanStatus | null;
  /** The week the rep plans now (calendar.ts `repPlanWeek`). */
  repWeek: string;
  /** The week he is in (calendar.ts `fieldWeekStart` of today). */
  runningWeek: string;
  /** A request to edit this week is waiting on somebody. */
  editAsked: boolean;
  /** A request to edit this week was acknowledged, and reopened it. */
  editReopened: boolean;
}): RepWeekState {
  if (!input.open) return "closed";
  if (isPlanSentForReview(input.status)) return input.editAsked ? "asked" : "sent";
  if (input.weekStart === input.repWeek) return "plan";
  if (input.status === "returned") return "plan";
  if (input.status === "draft" && input.editReopened) return "plan";
  // 🔴 THE WEEK HE IS IN, NEVER SENT (owner, 2026-10-02 — he ruled it is still sent, late and stamped
  // late). Without this a rep who missed the deadline could send nothing all week, and every visit he
  // made was off-plan and waited on two approvals. He plans it from today on (`open` and the
  // editable days already stop at today), the send is stamped late from the server clock, and his visits
  // count as planned only from the moment it is sent — `phoenix_crm_save_visit` reads the send itself.
  if (input.weekStart === input.runningWeek && (input.status === null || input.status === "draft")) return "plan";
  return "closed";
}

/**
 * 🔴 ONE DAY RETURNED (owner, 2026-10-02: "Only that day" reopens). A reviewer may send back ONE day of
 * a sent week with a note. The week is `returned`, exactly as a whole-week return makes it — so
 * `repWeekState` answers "plan" for it unchanged — and `phoenix_crm_plans.returned_day` names the day.
 * That day is the only one the rep may change while it stands; every other day stays exactly as he
 * sent it, and the server refuses a change to it (`repChangeableDays` is the ONLY list of days a save
 * may touch). Sending the week again clears it in the database.
 *
 * One later act lifts it before then: HR acknowledging a request to edit this week AFTER the day was
 * returned. He asked to edit the WEEK and his district manager, SFE and HR agreed, so the whole week
 * opens. The acknowledgement leaves a returned plan's status as it stands (it reopens only a sent
 * week), so which act came last is read from their own times — never assumed.
 *
 * Null: the week is not returned for one day (a draft, a whole-week return, a sent week), or the
 * one-day return was lifted.
 */
export function standingReturnedDay(input: {
  status: PhoenixCrmPlanStatus | null;
  /** `phoenix_crm_plans.returned_day` as stored. */
  returnedDay: string | null;
  /** When the plan was returned (`phoenix_crm_plans.decided_at`). */
  decidedAt: string | null;
  /** When HR acknowledged the week's latest request to edit it, when that request was acknowledged. */
  editAcknowledgedAt: string | null;
}): string | null {
  if (input.status !== "returned" || !input.returnedDay) return null;
  const returnedAt = input.decidedAt ? Date.parse(input.decidedAt) : Number.NaN;
  const acknowledgedAt = input.editAcknowledgedAt ? Date.parse(input.editAcknowledgedAt) : Number.NaN;
  if (Number.isFinite(returnedAt) && Number.isFinite(acknowledgedAt) && acknowledgedAt > returnedAt) return null;
  return input.returnedDay;
}

/**
 * The days of a week the rep may change: every day from today on — or, while one day is returned
 * (`standingReturnedDay`), that day alone, and nothing once it has passed (he sends the week again as
 * it is). The one list `savePlan` hands the database as the days it may touch.
 */
export function repChangeableDays(input: { weekStart: string; cairoToday: string; returnedDay: string | null }): string[] {
  const open = editablePlanDays(input.weekStart, input.cairoToday);
  return input.returnedDay ? open.filter((day) => day === input.returnedDay) : open;
}

/**
 * A week's days as the rep may change them: while one day is returned, every other day reads as fixed
 * (`editable: false`) — which is what greys it on his board and keeps it out of every draft, copy,
 * suggestion and save the board builds, since all of them read `editable`.
 */
export function onlyReturnedDayEditable<T extends { date: string; editable: boolean }>(days: ReadonlyArray<T>, returnedDay: string | null): T[] {
  if (!returnedDay) return [...days];
  return days.map((day) => (day.editable && day.date !== returnedDay ? { ...day, editable: false } : day));
}

/**
 * 🔴 WHAT A PLAN SAYS ABOUT ONE DAY — THE ONE RULE FOR "IS THIS DAY ON A SENT PLAN" (owner, 2026-10-02,
 * "Still planned"). A week returned for ONE day still stands on every OTHER day exactly as it stood when
 * that day was returned — sent, or approved — so the rep's visits there still count as planned. Only
 * the returned day is back with him, and it waits until he sends the week again. Every other week's
 * days share the week's own status.
 *
 * `returnedDay` is the STANDING one (`standingReturnedDay`): once an acknowledged edit opens the whole
 * week after the return, it is null, the week reads `returned` on every day, and no day of it is
 * authority — a day the rep can change never is. A week returned whole has no day, and reads
 * `returned` throughout.
 *
 * `returnedFrom` is what the week was when the day was returned. Only Today needs it (it shows the
 * APPROVED plan only); anything that asks whether a day was SENT gets the same answer either way, and
 * an unknown one reads as `submitted` — sent, never approved.
 *
 * The database asks the same question when a visit is saved (phoenix_crm_save_visit `v_on_sent_plan`,
 * migration 20261002125244): the latest plan event reaching `submitted` or `approved`, or the latest
 * being a one-day return of another day that no acknowledged edit has since opened.
 */
export function planDayStatus(input: {
  status: PhoenixCrmPlanStatus | null;
  /** The STANDING one-day return (`standingReturnedDay`), never the raw column. */
  returnedDay: string | null;
  /** What the week was when its one day was returned: `submitted` or `approved`. */
  returnedFrom?: PhoenixCrmPlanStatus | null;
  date: string;
}): PhoenixCrmPlanStatus | null {
  if (input.status !== "returned" || !input.returnedDay || input.date === input.returnedDay) return input.status;
  return input.returnedFrom === "approved" ? "approved" : "submitted";
}

/** Is this day on a sent plan? `planDayStatus`, then `isPlanSentForReview` — never a second copy of either. */
export function isPlanDaySent(input: Parameters<typeof planDayStatus>[0]): boolean {
  return isPlanSentForReview(planDayStatus(input));
}

/**
 * 🔴 WHOSE TURN THE WEEK IS ON, IN ONE SENTENCE — for a reader who has no button on it (owner,
 * 2026-10-07, shown the screen itself and asked directly: "no buttons, but say whose turn it is").
 *
 * A manager who RETURNS a week gets no Approve and no Return on it afterwards, and that is correct:
 * it is the rep's to change until he sends it again. But the page then simply ENDED — the day's
 * customers, and nothing under them. He read that as his week lost, and the whole "it comes back to
 * the manager with no option to approve" started there, on a week that had never come back at all
 * (PED Giza 1's week of 10 October: returned 20:36, the rep's last save 16:52, before the return).
 *
 * So wherever the decision block would have been, this says who holds it now. It is NOT a second
 * copy of who may decide — it is only ever read when `canApprove` and `canReturn` are both false,
 * and it states what the plan row itself already says.
 *
 * Every stamp and every name arrives already formatted: this file prints no dates and resolves no
 * people.
 */
export function planTurnSentence(input: {
  status: PhoenixCrmPlanStatus | null;
  /** The STANDING one-day return (`standingReturnedDay`), never the raw column. */
  returnedDay: string | null;
  /** Who decided it last, resolved to a name; null when nobody has, or the name is not known. */
  deciderName: string | null;
  /** When it was decided, as a Cairo stamp; null when that is not known. */
  decidedStamp: string | null;
  /** The territory's rep; null on a vacant seat. */
  repName: string | null;
  /** The manager who approves this territory's weeks; null when the chain above it is vacant. */
  reviewerName: string | null;
  /** The due date with its deadline, exactly as every other screen prints it (`planDueLabel`). */
  dueLabel: string;
}): string {
  const rep = input.repName ?? "the rep";
  const when = input.decidedStamp ? ` ${input.decidedStamp}` : "";
  const by = input.deciderName ? ` by ${input.deciderName}` : "";
  if (input.status === "returned") {
    const what = input.returnedDay ? `${planDayLabel(input.returnedDay)} went back to ${rep}` : `This week went back to ${rep}`;
    return `${what}${when}${by}. It is with ${rep} now — it comes back here for review when they send it again.`;
  }
  if (input.status === "submitted") {
    return `Sent for review. ${input.reviewerName ? `${input.reviewerName} approves it.` : "The manager above this territory approves it."}`;
  }
  if (input.status === "approved") return `Approved${when}${by}. Nothing is waiting on this week.`;
  // It starts the sentence, so a vacant seat reads "The rep", never "the rep" (the smoke test, 2026-10-29).
  return `Not sent yet. ${input.repName ?? "The rep"} sends it by ${input.dueLabel}.`;
}

export type PlanItemDraft = {
  planDate: string;
  customerId: string;
  /** Null for a customer carried over from iReports360 and not validated yet: he has no place. */
  placeId: string | null;
  exceptionType: PlanExceptionType | null;
  exceptionNote: string | null;
};

export type PlanRuleResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** The shape of the item list the planner sends. A customer twice on one day collapses to the first. */
export function parsePlanItems(raw: unknown): PlanRuleResult<PlanItemDraft[]> {
  if (!Array.isArray(raw)) return { ok: false, error: "The plan has no list of customers. Reload the planner." };
  if (raw.length > 400) return { ok: false, error: "The plan holds more customers than a week can. Reload the planner." };
  const seen = new Set<string>();
  const items: PlanItemDraft[] = [];
  for (const entry of raw) {
    const body = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const planDate = String(body.planDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(planDate)) return { ok: false, error: "A planned customer has no day. Reload the planner." };
    if (!isUuid(body.customerId)) {
      return { ok: false, error: "A planned customer is missing. Reload the planner." };
    }
    // A customer who is not validated yet has no place; every other customer must name one.
    const hasPlace = body.placeId !== null && body.placeId !== undefined && body.placeId !== "";
    if (hasPlace && !isUuid(body.placeId)) {
      return { ok: false, error: "A planned customer is missing. Reload the planner." };
    }
    const exceptionRaw = String(body.exceptionType ?? "").trim();
    const exceptionType = exceptionRaw && EXCEPTION_KEYS.has(exceptionRaw) ? (exceptionRaw as PlanExceptionType) : null;
    if (exceptionRaw && !exceptionType) return { ok: false, error: "A planned customer has an exception reason the planner does not know. Reload the planner." };
    const note = String(body.exceptionNote ?? "").trim();
    if (note.length > PLAN_NOTE_MAX) return { ok: false, error: `An exception note is longer than ${PLAN_NOTE_MAX} characters.` };
    const key = `${planDate}|${String(body.customerId).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      planDate,
      customerId: String(body.customerId).toLowerCase(),
      placeId: hasPlace ? String(body.placeId).toLowerCase() : null,
      exceptionType,
      exceptionNote: note || null,
    });
  }
  return { ok: true, value: items };
}

export type PlanRuleCustomer = {
  customerId: string;
  name: string;
  listType: PhoenixCrmDoctorListType;
  /** Carried over from iReports360 and not validated yet: no place, no timings, and it counts in nothing. */
  pending: boolean;
  /**
   * `sharedPlaceId` is the polyclinic, centre, tower or hospital outpatient suite a seated place sits
   * in, and null for a customer with his own clinic. The venue's day cap is counted off it below.
   * `session` is the AM or PM he receives in there (owner, 2026-10-10): the item is filed in it, and a
   * place with none follows the customer's own list.
   */
  places: ReadonlyArray<{ placeId: string; timings: PhoenixCrmTiming[]; sharedPlaceId?: string | null; session?: PhoenixCrmDoctorListType | null }>;
};

export type ResolvedPlanItem = PlanItemDraft & {
  listType: PhoenixCrmDoctorListType;
  receives: boolean;
  /** The first window's start that day, for ordering the day. Null when the customer does not receive that day. */
  startMinute: number | null;
  /** The venue behind the chosen place, or null. Stored on the item so the SEND can re-count the week. */
  sharedPlaceId: string | null;
};

/**
 * "Saturday 19 Sept", "Tuesday 6 Oct" — the month from Phoenix's own table, so every engine prints the
 * same name. The returned day reads this way wherever it is named (owner, 2026-10-02: "Your manager
 * returned Tuesday 6 Oct").
 */
export function planDayLabel(isoDay: string): string {
  const [, month, day] = isoDay.split("-").map(Number);
  return `${PHOENIX_CRM_WEEKDAY_NAMES[weekdayOfIsoDay(isoDay)]} ${day} ${CAIRO_MONTHS[month - 1] ?? ""}`;
}

/**
 * A DAY OFF on the plan (owner, 2026-10-02): a public holiday, or a full day of the rep's own approved
 * leave. Either way the day holds no customer — its `listTypes` are empty, as on a Friday — and a
 * save that still names it is refused. `name` is what the day picker says: "Armed Forces Day",
 * "Annual Vacation".
 */
export type PlanDayOff = { kind: "holiday" | "leave"; name: string };

/**
 * The day off a plan day is, or null. A public holiday comes first: it is everybody's day off, so a
 * rep on leave across one reads the holiday's name on it.
 */
export function planDayOff(date: string, holidays?: ReadonlyMap<string, string>, leave?: ReadonlyMap<string, string>): PlanDayOff | null {
  const holiday = holidays?.get(date);
  if (holiday) return { kind: "holiday", name: holiday };
  const away = leave?.get(date);
  return away ? { kind: "leave", name: away } : null;
}

/** "a public holiday (Armed Forces Day)" · "a day off on approved leave (Annual Vacation)" — one wording for the refusal and the board. */
export function dayOffPhrase(off: PlanDayOff): string {
  return off.kind === "holiday" ? `a public holiday (${off.name})` : `a day off on approved leave (${off.name})`;
}

/**
 * The note on a day off. A day off holds no customer — but a leave approved after the week was planned
 * leaves its customers on the day, and the note must not say "it holds no customer" above them (the
 * production smoke test, 2026-10-29: Monday 26 October in Assuit 1 · Anti Infective, 17 customers under it).
 */
export function dayOffNote(dayName: string, off: PlanDayOff, held: number): string {
  if (held <= 0) return `${dayName} is ${dayOffPhrase(off)}: it holds no customer.`;
  const customers = held === 1 ? "1 customer is" : `${held} customers are`;
  return `${dayName} is ${dayOffPhrase(off)}. A day off holds no customer, yet ${customers} still planned on it.`;
}

/** A plan day's two counts. A pharmacy is never planned, so there is no third. */
export type PlanDayCount = { AM: number; PM: number };

/** Each day's AM and PM count, from items that already carry their list type. */
export function countPlanDays(items: ReadonlyArray<{ planDate: string; listType: PhoenixCrmDoctorListType }>): Map<string, PlanDayCount> {
  const perDay = new Map<string, PlanDayCount>();
  for (const item of items) {
    const counts = perDay.get(item.planDate) ?? { AM: 0, PM: 0 };
    counts[item.listType] += 1;
    perDay.set(item.planDate, counts);
  }
  return perDay;
}

/**
 * 🔴 THE DAILY CAPS, AS ONE RULE FOR BOTH PATHS — THE SAVE AND THE SEND.
 *
 * A day holds at most `pmDailyCap` PM doctors and `amDailyCap` AM accounts (settings; 15 and 5). It
 * used to be tested inside `resolvePlanItems` alone, which sees only the items of the save it is
 * checking — so a day the rep did not touch in that save was never counted, and an over-cap day
 * written by an earlier path or under an earlier settings value stayed on the plan and was promoted
 * to submitted and approved unchecked. Measured on production 2026-10-03: one approved week held 18
 * PM on its Saturday against a cap of 15, its 62 over-cap items older than the plan row they sit on.
 *
 * `onlyDays`, when given, is the only set of days this answer may NAME: every day is still counted,
 * but a day outside it is passed over. The send needs that — it re-checks the whole week, and may
 * only refuse a day the rep can still change (`repChangeableDays`), or an over-cap day that has
 * passed would deadlock the week with no way left to fix it.
 *
 * The days are answered in date order, so the earliest offending one is named — never Map order,
 * which depends on which rows a read happened to return first.
 */
export function planCapRefusal(input: {
  counts: ReadonlyMap<string, PlanDayCount>;
  settings: Pick<PhoenixCrmSettings, "pmDailyCap" | "amDailyCap">;
  onlyDays?: ReadonlyArray<string> | null;
}): string | null {
  const nameable = input.onlyDays ? new Set(input.onlyDays) : null;
  for (const day of [...input.counts.keys()].sort()) {
    if (nameable && !nameable.has(day)) continue;
    const counts = input.counts.get(day) ?? { AM: 0, PM: 0 };
    if (counts.PM > input.settings.pmDailyCap) {
      return `${planDayLabel(day)} has ${counts.PM} PM. A day holds ${input.settings.pmDailyCap} PM at most.`;
    }
    if (counts.AM > input.settings.amDailyCap) {
      return `${planDayLabel(day)} has ${counts.AM} AM. A day holds ${input.settings.amDailyCap} AM at most.`;
    }
  }
  return null;
}

/**
 * 🔴 THE WHOLE WEEK RE-CHECKED AGAINST THE CAPS WHEN THE REP SENDS IT — the day he never touched
 * included (production, 2026-10-03).
 *
 * `items` is every stored item of the week, not the save's payload and not only the changeable days:
 * counting the changeable days alone is the very hole this closes. `changeableDays` is
 * `repChangeableDays` — the days he can still edit — and only one of those may be named, so an
 * over-cap day that has passed (or a week returned for one OTHER day) lets the send through rather
 * than trapping a plan nobody can fix. Golden rule #1: the refusal names the day and the count and
 * says what to do, and nothing about it is a check on him.
 */
export function planSendCapRefusal(input: {
  items: ReadonlyArray<{ planDate: string; listType: PhoenixCrmDoctorListType }>;
  settings: Pick<PhoenixCrmSettings, "pmDailyCap" | "amDailyCap">;
  changeableDays: ReadonlyArray<string>;
}): string | null {
  const over = planCapRefusal({ counts: countPlanDays(input.items), settings: input.settings, onlyDays: input.changeableDays });
  return over ? `${over} Take one off that day, save, then send.` : null;
}

/**
 * Every item checked against the week, the list, the timings and the daily limits. Only the days the
 * rep may still change are sent here; the service keeps the stored items of days that have passed.
 */
export function resolvePlanItems(input: {
  weekStart: string;
  items: ReadonlyArray<PlanItemDraft>;
  customers: ReadonlyMap<string, PlanRuleCustomer>;
  settings: Pick<PhoenixCrmSettings, "pmDailyCap" | "amDailyCap" | "sharedPlaceDailyCap">;
  isRamadan: (isoDay: string) => boolean;
  /**
   * The venues the planned places sit in, `sharedPlaceId → name and kind`, so the refusal can say
   * "Nile Polyclinic" rather than a code. A venue missing from the map is still COUNTED and named
   * "Polyclinic or centre" — the cap must never depend on a lookup having succeeded.
   */
  sharedPlaces?: ReadonlyMap<string, SharedPlaceNamed>;
  /** The venues lifted outright for this seat (owner, 2026-10-31): never held to the venue's daily number. */
  liftedVenues?: ReadonlySet<string>;
  /** The week's public holidays, `day → name`: a day named here holds no customer (owner, 2026-10-02). */
  holidays?: ReadonlyMap<string, string>;
  /** The rep's own full days of approved leave, `day → its name` (server/leave-days.ts): days off too. */
  leave?: ReadonlyMap<string, string>;
}): PlanRuleResult<ResolvedPlanItem[]> {
  const weekDays = new Set(fieldWeekDays(input.weekStart));
  const resolved: ResolvedPlanItem[] = [];

  for (const item of input.items) {
    if (!weekDays.has(item.planDate)) {
      return { ok: false, error: `${item.planDate} is not a working day of this plan's week.` };
    }
    const customer = input.customers.get(item.customerId);
    if (!customer) {
      return { ok: false, error: "A planned customer is no longer on your list. Reload the planner." };
    }
    // A customer who is not validated yet has no place: he is planned as he is, and validated at the door.
    const place = customer.pending ? null : customer.places.find((entry) => entry.placeId === item.placeId);
    if (!customer.pending && !place) {
      return { ok: false, error: `${customer.name}'s place was changed. Reload the planner and place this customer again.` };
    }
    const off = planDayOff(item.planDate, input.holidays, input.leave);
    if (off) {
      return { ok: false, error: `${planDayLabel(item.planDate)} is ${dayOffPhrase(off)}. Take ${customer.name} off it.` };
    }
    // A seated customer is planned in the SESSION of his seating, a clinic of his own in his list.
    const listType = place?.session ?? customer.listType;
    const allowed = planDayListTypes(item.planDate);
    if (!allowed.includes(listType)) {
      return {
        ok: false,
        error:
          allowed.length === 0
            ? `${planDayLabel(item.planDate)} is not a working day.`
            : `${planDayLabel(item.planDate)} is a morning: it holds AM only, so ${customer.name} cannot go there.`,
      };
    }

    // Nothing is known about when a pending customer receives, so there is no day he is "off" on and
    // no reason to ask the rep for one.
    let receives = true;
    let startMinute: number | null = null;
    let exceptionType: PlanExceptionType | null = null;
    let exceptionNote: string | null = null;
    if (place) {
      const weekday = weekdayOfIsoDay(item.planDate);
      const { windows } = windowsForWeekday(place.timings, weekday, input.isRamadan(item.planDate));
      receives = windows.length > 0;
      exceptionType = item.exceptionType;
      exceptionNote = item.exceptionNote;
      if (receives) {
        exceptionType = null;
        exceptionNote = null;
        startMinute = windows[0].startMinute;
      } else if (exceptionType === "other" && !exceptionNote) {
        // Never blocked (owner, 2026-09-30): an "Other" with no note keeps the customer on the day.
        exceptionType = null;
      }
    }

    resolved.push({
      ...item,
      placeId: place ? place.placeId : null,
      exceptionType,
      exceptionNote,
      listType,
      receives,
      startMinute,
      sharedPlaceId: place?.sharedPlaceId ?? null,
    });
  }

  // The caps are ONE rule, shared with the send (`planSendCapRefusal`) so a day this save never
  // touched cannot slip past them on its way to the manager.
  const overCap = planCapRefusal({ counts: countPlanDays(resolved), settings: input.settings });
  if (overCap) return { ok: false, error: overCap };

  // 🔴 THE VENUE CAP IS ITS OWN FUNCTION AND MUST STAY ONE (owner, 2026-10-09 — three visits a day
  // inside one polyclinic, at the plan AND at the door). It is NOT a third comparison inside
  // `planCapRefusal`: that function is pinned to exactly two by
  // `tests/phoenix-crm-plan-cap-on-send.test.ts`, because its two caps are counts of a DAY while this
  // one is a count per BUILDING within a day — a different grouping, named with the venue's own name.
  const overVenue = sharedPlanCapRefusal({
    cap: input.settings.sharedPlaceDailyCap,
    dayLabel: planDayLabel,
    items: resolved,
    venues: input.sharedPlaces ?? new Map(),
    liftedVenues: input.liftedVenues,
  });
  if (overVenue) return { ok: false, error: overVenue };

  return { ok: true, value: resolved };
}

/** "Sat 6:00 PM – 8:00 PM" lines for a place on a plan day, for the reviewer. */
export function describeDayWindows(timings: PhoenixCrmTiming[], isoDay: string, ramadan: boolean): string {
  const { windows, noRamadanTime } = windowsForWeekday(timings, weekdayOfIsoDay(isoDay), ramadan);
  if (windows.length === 0) return "Does not receive this day";
  const text = windows.map((window) => formatTimingWindow(window)).join(", ");
  return noRamadanTime ? `${text} (no Ramadan time)` : text;
}
