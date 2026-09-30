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
import { fieldWeekDays, planDayListTypes, weekdayOfIsoDay } from "@/lib/phoenix-crm/calendar";
import { formatTimingWindow, PHOENIX_CRM_WEEKDAY_NAMES, windowsForWeekday } from "@/lib/phoenix-crm/timings";
import type { PhoenixCrmListType, PhoenixCrmPlanStatus, PhoenixCrmSettings, PhoenixCrmTiming } from "@/lib/phoenix-crm/types";

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

/** A rep edits a draft or a returned plan. Submitted and approved plans are reopened first. */
export function isPlanEditable(status: PhoenixCrmPlanStatus): boolean {
  return status === "draft" || status === "returned";
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
  listType: PhoenixCrmListType;
  /** Carried over from iReports360 and not validated yet: no place, no timings, and it counts in nothing. */
  pending: boolean;
  places: ReadonlyArray<{ placeId: string; timings: PhoenixCrmTiming[] }>;
};

export type ResolvedPlanItem = PlanItemDraft & {
  listType: PhoenixCrmListType;
  receives: boolean;
  /** The first window's start that day, for ordering the day. Null when the customer does not receive that day. */
  startMinute: number | null;
};

/** "Saturday 19 Sept" — the month from Phoenix's own table, so every engine prints the same name. */
function dayLabel(isoDay: string): string {
  const [, month, day] = isoDay.split("-").map(Number);
  return `${PHOENIX_CRM_WEEKDAY_NAMES[weekdayOfIsoDay(isoDay)]} ${day} ${CAIRO_MONTHS[month - 1] ?? ""}`;
}

/**
 * Every item checked against the week, the list, the timings and the daily limits. Only the days the
 * rep may still change are sent here; the service keeps the stored items of days that have passed.
 */
export function resolvePlanItems(input: {
  weekStart: string;
  items: ReadonlyArray<PlanItemDraft>;
  customers: ReadonlyMap<string, PlanRuleCustomer>;
  settings: Pick<PhoenixCrmSettings, "pmDailyCap" | "amDailyCap">;
  isRamadan: (isoDay: string) => boolean;
}): PlanRuleResult<ResolvedPlanItem[]> {
  const weekDays = new Set(fieldWeekDays(input.weekStart));
  const resolved: ResolvedPlanItem[] = [];
  const perDay = new Map<string, { AM: number; PM: number }>();

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
    const allowed = planDayListTypes(item.planDate);
    if (!allowed.includes(customer.listType)) {
      return {
        ok: false,
        error:
          allowed.length === 0
            ? `${dayLabel(item.planDate)} is not a working day.`
            : `${dayLabel(item.planDate)} is a morning: it holds AM only, so ${customer.name} cannot go there.`,
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

    const counts = perDay.get(item.planDate) ?? { AM: 0, PM: 0 };
    counts[customer.listType] += 1;
    perDay.set(item.planDate, counts);
    resolved.push({
      ...item,
      placeId: place ? place.placeId : null,
      exceptionType,
      exceptionNote,
      listType: customer.listType,
      receives,
      startMinute,
    });
  }

  for (const [day, counts] of perDay) {
    if (counts.PM > input.settings.pmDailyCap) {
      return {
        ok: false,
        error: `${dayLabel(day)} has ${counts.PM} PM. A day holds ${input.settings.pmDailyCap} PM at most.`,
      };
    }
    if (counts.AM > input.settings.amDailyCap) {
      return {
        ok: false,
        error: `${dayLabel(day)} has ${counts.AM} AM. A day holds ${input.settings.amDailyCap} AM at most.`,
      };
    }
  }

  return { ok: true, value: resolved };
}

/** "Sat 6:00 PM – 8:00 PM" lines for a place on a plan day, for the reviewer. */
export function describeDayWindows(timings: PhoenixCrmTiming[], isoDay: string, ramadan: boolean): string {
  const { windows, noRamadanTime } = windowsForWeekday(timings, weekdayOfIsoDay(isoDay), ramadan);
  if (windows.length === 0) return "Does not receive this day";
  const text = windows.map((window) => formatTimingWindow(window)).join(", ");
  return noRamadanTime ? `${text} (no Ramadan time)` : text;
}
