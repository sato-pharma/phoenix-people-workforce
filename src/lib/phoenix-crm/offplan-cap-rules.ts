/**
 * Phoenix CRM — the out-of-plan allowance, with no I/O.
 *
 * Owner, 2026-10-10: at most two doctors a day and eight a week may be visited OUT OF PLAN. The door
 * enforces it (`phoenix_crm_visits_offplan_cap`); this file is how both sides READ it — the rep sees what
 * he still has when he starts an unplanned visit, and his managers see where he stands beside each
 * off-plan visit they decide.
 *
 * What is counted is exactly what the trigger counts: DISTINCT doctors (AM and PM customers) on
 * `out_of_plan` visits of one seat, in the visit day and in the FIELD week (Saturday to Thursday, a
 * Friday closing the week before it). An out-of-list visit and a pharmacy call are never in it. A doctor
 * already counted takes no second place, so he is never refused by his own count.
 *
 * Golden rule #1: to the rep this is an ALLOWANCE he is shown — what is left, what the day holds — and
 * never a check on him; it says nothing of any approval's outcome and reads no flag.
 */

import { fieldWeekStart } from "@/lib/phoenix-crm/calendar";

export type OffPlanTally = { used: number; cap: number };

/** One out-of-plan doctor visit, as the allowance reads it. */
export type OffPlanRow = { customerId: string; visitDate: string };

export type OffPlanAllowance = {
  day: OffPlanTally;
  week: OffPlanTally;
  /** The doctors already counted on the day: nobody new can be offered once `day` is full. */
  dayDoctors: string[];
  /** The doctors already counted in the week: they stay open to him once `week` is full. */
  weekDoctors: string[];
  /**
   * The customers that fall under a named exception (owner, 2026-10-17: Mostafa Mahmoud Mohamed Ali at مستشفي
   * الجوي التخصصي) — the day and the week never block them and never count them. Absent means none.
   */
  exemptCustomerIds?: string[];
  /** The exception's own names, for the one sentence that tells him — "no daily or weekly limit at <venue>". */
  exemptLabels?: string[];
  /**
   * A dated exception for the whole of the rep's out-of-plan visits (owner, 2026-10-26: Aya Mamdouh, a new hire,
   * "no cap only during the first month then automatic return normal") — every customer is open, and `until`
   * is the last day it covers. Absent means none, and on the day after `until` it is absent by itself.
   */
  exemptAll?: { label: string; until: string };
};

/** The customers a seat's named exceptions cover, and what they are called — plus a dated whole-rep window. */
export type OffPlanExemptions = { customerIds: string[]; labels: string[]; all?: { label: string; until: string } };

/** The two numbers, as the settings carry them. */
export type OffPlanCaps = { offPlanDailyCap: number; offPlanWeeklyCap: number };

/** Where one rep stands on one visit day — what a manager reads beside an off-plan visit. */
export type OffPlanStanding = { day: OffPlanTally; week: OffPlanTally };

/** The first and last visit day of the field week a day belongs to, both inclusive (Saturday to Friday). */
export function offPlanWeekWindow(isoDay: string): { from: string; to: string } {
  const from = fieldWeekStart(isoDay);
  const [year, month, day] = from.split("-").map(Number);
  const end = new Date(Date.UTC(year, month - 1, day + 6));
  return { from, to: end.toISOString().slice(0, 10) };
}

/** The rep's allowance on a visit day, from the out-of-plan rows of his week. */
export function offPlanAllowance(input: {
  rows: ReadonlyArray<OffPlanRow>;
  day: string;
  caps: OffPlanCaps;
  exemptions?: OffPlanExemptions;
}): OffPlanAllowance {
  const week = fieldWeekStart(input.day);
  const dayDoctors = new Set<string>();
  const weekDoctors = new Set<string>();
  for (const row of input.rows) {
    if (fieldWeekStart(row.visitDate) !== week) continue;
    weekDoctors.add(row.customerId);
    if (row.visitDate === input.day) dayDoctors.add(row.customerId);
  }
  return {
    day: { used: dayDoctors.size, cap: input.caps.offPlanDailyCap },
    week: { used: weekDoctors.size, cap: input.caps.offPlanWeeklyCap },
    dayDoctors: [...dayDoctors],
    weekDoctors: [...weekDoctors],
    ...(input.exemptions && input.exemptions.customerIds.length > 0
      ? { exemptCustomerIds: input.exemptions.customerIds, exemptLabels: input.exemptions.labels }
      : {}),
    ...(input.exemptions?.all ? { exemptAll: input.exemptions.all } : {}),
  };
}

/** The same count for several days of several seats: `seatId → day → standing`, for the managers' cards. */
export function offPlanStandings(input: {
  rows: ReadonlyArray<OffPlanRow & { seatId: string }>;
  asks: ReadonlyArray<{ seatId: string; day: string }>;
  caps: OffPlanCaps;
}): Map<string, OffPlanStanding> {
  const bySeat = new Map<string, OffPlanRow[]>();
  for (const row of input.rows) {
    const list = bySeat.get(row.seatId) ?? [];
    list.push({ customerId: row.customerId, visitDate: row.visitDate });
    bySeat.set(row.seatId, list);
  }
  const standings = new Map<string, OffPlanStanding>();
  for (const ask of input.asks) {
    const key = offPlanStandingKey(ask.seatId, ask.day);
    if (standings.has(key)) continue;
    const { day, week } = offPlanAllowance({ rows: bySeat.get(ask.seatId) ?? [], day: ask.day, caps: input.caps });
    standings.set(key, { day, week });
  }
  return standings;
}

export function offPlanStandingKey(seatId: string, day: string): string {
  return `${seatId}|${day}`;
}

/** Why this doctor cannot be taken out of plan now: the day is full, or the week is and he is not in it. */
export function offPlanBlock(allowance: OffPlanAllowance, customerId: string): "day" | "week" | null {
  if (allowance.exemptAll) return null;
  if (allowance.exemptCustomerIds?.includes(customerId)) return null;
  if (allowance.dayDoctors.includes(customerId)) return null;
  if (allowance.day.used >= allowance.day.cap) return "day";
  if (allowance.week.used >= allowance.week.cap && !allowance.weekDoctors.includes(customerId)) return "week";
  return null;
}

/** What is left today, never below zero. */
export function offPlanLeft(tally: OffPlanTally): number {
  return Math.max(0, tally.cap - tally.used);
}

function customers(count: number): string {
  return count === 1 ? "1 customer" : `${count} customers`;
}

/**
 * The one sentence under the meters, said to the rep. The tighter limit leads, and it says what to do:
 * plan the doctor for another day, never that anything is wrong.
 */
export function offPlanAllowanceSentence(allowance: OffPlanAllowance, voice: "rep" | "manager" = "rep"): string {
  const dayLeft = offPlanLeft(allowance.day);
  const weekLeft = offPlanLeft(allowance.week);
  // A manager entering the visit reads the same allowance about the rep, never "you".
  const who = voice === "rep" ? "You have" : "The rep has";
  const whose = voice === "rep" ? "you" : "the rep";
  if (dayLeft === 0) {
    return `${who} visited ${customers(allowance.day.used)} out of plan today, the most one day holds. Plan the next one for another day.`;
  }
  if (weekLeft === 0) {
    return `${who} visited ${customers(allowance.week.used)} out of plan this week, the most a week holds. The new week opens on Saturday; a customer ${whose} already visited this week stays open.`;
  }
  if (weekLeft < dayLeft) {
    return `${voice === "rep" ? "You" : "The rep"} can take ${customers(weekLeft)} more out of plan this week.`;
  }
  return `${voice === "rep" ? "You" : "The rep"} can take ${customers(dayLeft)} more out of plan today.`;
}

/**
 * The one line that tells the rep, and the card that shows it, about a named exception — nothing when he
 * has none. An allowance he is given, never a check on him (golden rule #1).
 */
export function offPlanExemptionSentence(allowance: OffPlanAllowance, voice: "rep" | "manager" = "rep"): string | null {
  if (allowance.exemptAll) {
    const whose = voice === "rep" ? "your" : "the rep's";
    return `Until ${offPlanDayLabel(allowance.exemptAll.until)} there is no daily or weekly limit on ${whose} unplanned visits. From the day after, the usual limit applies.`;
  }
  if (voice !== "rep") return null;
  const labels = allowance.exemptLabels ?? [];
  if (labels.length === 0) return null;
  return `At ${labels.join(" and ")} there is no daily or weekly limit on unplanned visits. They do not use up your numbers above.`;
}

/** "2026-11-23" → "23 November", read from the ISO day itself so no timezone can move it. */
export function offPlanDayLabel(isoDay: string): string {
  const [year, month, day] = isoDay.split("-").map(Number);
  if (!year || !month || !day) return isoDay;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
}

/**
 * What a manager reads on an off-plan visit that fell under a named exception — a hospital of one rep
 * (2026-10-17) or a new hire's first month (2026-10-26). One sentence fits both.
 */
export const OFF_PLAN_EXEMPT_CARD_TEXT =
  "Named exception: the owner lifted the daily and weekly out-of-plan limit for this visit. Decide it as usual.";

/** What a manager reads beside a rep's off-plan day: "Out of plan that day 2 of 2 · that week 5 of 8". */
export function offPlanStandingLine(standing: OffPlanStanding): string {
  return `Out of plan that day ${standing.day.used} of ${standing.day.cap} · that week ${standing.week.used} of ${standing.week.cap}`;
}

/** Whether either number is reached — a manager's card says so in amber. */
export function offPlanStandingFull(standing: OffPlanStanding): boolean {
  return standing.day.used >= standing.day.cap || standing.week.used >= standing.week.cap;
}
