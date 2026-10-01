/**
 * Phoenix CRM — the daily plan report (owner, 2026-09-30: "build the daily plan report").
 *
 * iReports360's Daily Plan, rebuilt from this module's own plans: ONE territory, day by day — the
 * day's Start AM and Start PM, its other activities, then the customers planned for the AM round and
 * for the PM round, each with where he is, his hours that day, and whether he was visited.
 *
 *   - A LISTING, never a measure. Plan against actual is the measure; this report counts nothing,
 *     scores nothing against a grade and prints no percentage, so the two can never be read as two
 *     answers to one question.
 *   - One territory at a time, as the old report asked for one rep: a plan is one rep's, and a whole
 *     district laid out customer by customer is thousands of rows nobody reads.
 *   - It reaches FORWARD. The days ahead are the point of a plan, so the period runs as far as a plan
 *     can: the last field week a rep can plan (`plannableWeeks`). Every other section stops at today.
 *   - 🔴 A DAY THAT HAS PASSED READS AS ITS PLAN STOOD WHEN THE DAY ENDED — sent or not — by the one
 *     test plan against actual uses (`phoenix_crm_report_plan_vs_actual`, its `sent_days`: the last
 *     status recorded before the day's end). A plan reopened later does not rewrite a day already
 *     lived, and the two sections never disagree about whether a day was planned. Today and the days
 *     ahead read the plan as it is now, and a draft says so in words: a draft is the rep's own and
 *     can still change.
 *   - AM and PM are two lists, never one, and nothing adds them.
 *   - Friday holds no plan (`planDayListTypes`) and is left out.
 *   - The rep reads his own plan here — his plan and his day are his (Golden Rule #1's boundary).
 *     Nothing on it is a distance, a flag or a check.
 *
 * Pure: the server reads the rows (server/daily-plan-report.ts) and hands them to
 * `buildDailyPlanDays`; the screen and the workbook print what comes back.
 */

import { addDaysIso } from "@/lib/crm/dates";
import { cairoWallClock } from "@/lib/format/cairo-zone";
import { fieldWeekStart, isIsoDay, planDayListTypes, plannableWeeks } from "@/lib/phoenix-crm/calendar";
import type { PhoenixCrmDayActivity } from "@/lib/phoenix-crm/day-activities";
import { describeDayStarts, noDayStarts, type PlanDayStarts } from "@/lib/phoenix-crm/plan-day-starts";
import { daysInPeriod, REPORT_MAX_DAYS, type ReportRuleResult } from "@/lib/phoenix-crm/report-rules";
import { formatClockMinute } from "@/lib/phoenix-crm/timings";
import type { PhoenixCrmGrade, PhoenixCrmListType, PhoenixCrmPlanStatus } from "@/lib/phoenix-crm/types";

// ── The days it reads ───────────────────────────────────────────────────────────────────────────

export type DailyPlanPeriod = { from: string; to: string };

function blank(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/** The last day any plan can hold today: the Thursday of the last field week a rep can plan. */
export function lastPlannableDay(cairoToday: string): string {
  const weeks = plannableWeeks(cairoToday);
  return addDaysIso(weeks[weeks.length - 1] ?? fieldWeekStart(cairoToday), 5);
}

/** The Thursday closing the field week a day belongs to — the next one when the day is a Friday. */
function weekEndFrom(isoDay: string): string {
  const thursday = addDaysIso(fieldWeekStart(isoDay), 5);
  return thursday >= isoDay ? thursday : addDaysIso(thursday, 7);
}

const DAILY_PLAN_TOO_FAR = "No plan reaches that far ahead: a rep plans up to the last week of next month.";

/**
 * The days the report reads: this field week, Saturday to Thursday, unless chosen. A last day past the
 * last plannable one is brought back to it — the way the other sections bring theirs back to today —
 * and at most `REPORT_MAX_DAYS`, as they are.
 */
export function resolveDailyPlanPeriod(input: { from: unknown; to: unknown; cairoToday: string }): ReportRuleResult<DailyPlanPeriod> {
  const lastDay = lastPlannableDay(input.cairoToday);
  const from = blank(input.from) ? fieldWeekStart(input.cairoToday) : input.from;
  if (!isIsoDay(from)) return { ok: false, error: "Choose a valid first day." };
  const toRaw = blank(input.to) ? weekEndFrom(from) : input.to;
  if (!isIsoDay(toRaw)) return { ok: false, error: "Choose a valid last day." };
  if (from > lastDay) return { ok: false, error: DAILY_PLAN_TOO_FAR };
  const to = toRaw > lastDay ? lastDay : toRaw;
  if (from > to) return { ok: false, error: "The first day is after the last day." };
  if (daysInPeriod(from, to) > REPORT_MAX_DAYS) return { ok: false, error: `Choose at most ${REPORT_MAX_DAYS} days.` };
  return { ok: true, value: { from, to } };
}

/**
 * Why the chosen days cannot be read, in the server's own words; null when they can. The screen's
 * twin of `resolveDailyPlanPeriod`, which brings a last day past the horizon back instead of refusing
 * it — the screen says so rather than quietly reading fewer days than it shows.
 */
export function dailyPlanPeriodProblem(period: DailyPlanPeriod, cairoToday: string): string | null {
  if (!isIsoDay(period.from)) return "Choose a valid first day.";
  if (!isIsoDay(period.to)) return "Choose a valid last day.";
  if (period.from > period.to) return "The first day is after the last day.";
  if (period.to > lastPlannableDay(cairoToday)) return DAILY_PLAN_TOO_FAR;
  if (daysInPeriod(period.from, period.to) > REPORT_MAX_DAYS) return `Choose at most ${REPORT_MAX_DAYS} days.`;
  return null;
}

export type DailyPlanPreset = "yesterday" | "today" | "tomorrow" | "last_week" | "this_week" | "next_week";

/** Three days, then three weeks — the order they come in, so the choices read left to right in time. */
export const DAILY_PLAN_PRESETS: ReadonlyArray<{ value: DailyPlanPreset; label: string }> = [
  { value: "yesterday", label: "Yesterday" },
  { value: "today", label: "Today" },
  { value: "tomorrow", label: "Tomorrow" },
  { value: "last_week", label: "Last week" },
  { value: "this_week", label: "This week" },
  { value: "next_week", label: "Next week" },
];

/**
 * The days a quick pick stands for. A week is a WHOLE field week, Saturday to Thursday — the days ahead
 * of today included, since those are what a plan is for (the other sections' "This week" stops at
 * today). A Friday belongs to the week before it, as everywhere in the module.
 */
export function dailyPlanPresetPeriod(preset: DailyPlanPreset, cairoToday: string): DailyPlanPeriod {
  const oneDay = (day: string) => ({ from: day, to: day });
  if (preset === "yesterday") return oneDay(addDaysIso(cairoToday, -1));
  if (preset === "today") return oneDay(cairoToday);
  if (preset === "tomorrow") return oneDay(addDaysIso(cairoToday, 1));
  const shift = preset === "last_week" ? -7 : preset === "next_week" ? 7 : 0;
  const week = addDaysIso(fieldWeekStart(cairoToday), shift);
  return { from: week, to: addDaysIso(week, 5) };
}

/** Every day of a period that can hold a plan — Friday never does. */
export function dailyPlanDates(period: DailyPlanPeriod): string[] {
  const dates: string[] = [];
  for (let day = period.from; day <= period.to; day = addDaysIso(day, 1)) {
    if (planDayListTypes(day).length > 0) dates.push(day);
  }
  return dates;
}

// ── How a day's plan stands ─────────────────────────────────────────────────────────────────────

/** A plan's status, or `not_sent` (a past day nobody sent before it ended), or `none` (no plan that week). */
export type DailyPlanState = PhoenixCrmPlanStatus | "not_sent" | "none";

const SENT: ReadonlySet<PhoenixCrmPlanStatus> = new Set(["submitted", "approved", "returned"]);

export type DailyPlanEvent = { at: string; toStatus: PhoenixCrmPlanStatus };

/** The Cairo calendar day of an instant ("2026-09-29"); null for anything that is not one. */
export function cairoDayOfInstant(iso: string): string | null {
  const value = new Date(iso);
  return Number.isNaN(value.getTime()) ? null : cairoWallClock(value).toISOString().slice(0, 10);
}

/** Minutes past midnight, Cairo, of an instant — how a visit's time is printed; null for no instant. */
export function cairoMinuteOfInstant(iso: string): number | null {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return null;
  const wall = cairoWallClock(value);
  return wall.getUTCHours() * 60 + wall.getUTCMinutes();
}

/** An instant's place in time, for ordering — never its text, whose fractions and offsets vary. */
function timeOf(iso: string): number {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

/**
 * The status the plan held when a day ENDED: the last one recorded on or before that Cairo day —
 * exactly "before the next Cairo midnight", the test `sent_days` applies in the database. Two events
 * at one instant keep the order they came in, as the database breaks that tie on the event's id.
 * Null when nothing was recorded by then.
 */
export function statusAtDayEnd(events: ReadonlyArray<DailyPlanEvent>, date: string): PhoenixCrmPlanStatus | null {
  const inOrder = events
    .map((event, index) => ({ event, index, time: timeOf(event.at) }))
    .sort((left, right) => left.time - right.time || left.index - right.index);
  let status: PhoenixCrmPlanStatus | null = null;
  for (const { event } of inOrder) {
    const day = cairoDayOfInstant(event.at);
    if (day !== null && day <= date) status = event.toStatus;
  }
  return status;
}

/**
 * How one day's plan stands in this report. A day that has passed reads as the plan stood when it
 * ENDED; today and the days ahead read the plan as it is now.
 */
export function dailyPlanState(input: {
  date: string;
  cairoToday: string;
  /** The plan's status now; null when the week has no plan at all. */
  current: PhoenixCrmPlanStatus | null;
  statusAtEnd: PhoenixCrmPlanStatus | null;
}): DailyPlanState {
  if (input.current === null) return "none";
  if (input.date >= input.cairoToday) return input.current;
  return input.statusAtEnd !== null && SENT.has(input.statusAtEnd) ? input.statusAtEnd : "not_sent";
}

export function dailyPlanStateLabel(state: DailyPlanState): string {
  if (state === "none") return "No plan";
  if (state === "not_sent") return "Not sent before the day";
  if (state === "draft") return "Draft · not sent yet";
  if (state === "submitted") return "Sent for review";
  if (state === "approved") return "Approved";
  return "Returned for changes";
}

// ── Whether a planned customer was seen ─────────────────────────────────────────────────────────

/**
 * The visit day ends at 02:00 Cairo (`cairoBusinessDay`), so until then yesterday is the day still
 * running and a customer planned for it is "not yet", never "not visited".
 *
 * 🔴 AND A DAY HR APPROVED HIS LEAVE IS "ON LEAVE", NEVER "NOT VISITED" (owner, 2026-10-01: "fix missed
 * visits on leave days in plan vs actual"). Past, running or ahead alike: he is away, so the plan for
 * that day is not his to keep. One he saw anyway still reads "visited" — the visit happened
 * (`plan-leave.ts` holds the rule for the three reports that read it).
 */
export type DailyPlanVisitStatus = "visited" | "not_visited" | "not_yet" | "ahead" | "on_leave";

export function dailyPlanVisitStatus(input: { date: string; visitDay: string; visited: boolean; onLeave?: boolean }): DailyPlanVisitStatus {
  if (input.visited) return "visited";
  if (input.onLeave) return "on_leave";
  if (input.date < input.visitDay) return "not_visited";
  return input.date === input.visitDay ? "not_yet" : "ahead";
}

/** "Visited 11:42 AM", "Not visited", "Not yet", "On leave", "Planned". */
export function dailyPlanVisitText(status: DailyPlanVisitStatus, visitedMinute: number | null): string {
  if (status === "visited") return visitedMinute === null ? "Visited" : `Visited ${formatClockMinute(visitedMinute)}`;
  if (status === "not_visited") return "Not visited";
  if (status === "not_yet") return "Not yet";
  if (status === "on_leave") return "On leave";
  return "Planned";
}

/**
 * A visit to a planned customer that was nonetheless saved as off the plan — the plan had not been
 * sent when he was seen (`the visit type` rule: "planned" is a plan SENT before the visit). How its
 * approval stands; `recorded` when no approval was asked for.
 */
export type DailyPlanOffPlan = "waiting" | "approved" | "refused" | "recorded";

export function dailyPlanOffPlanText(offPlan: DailyPlanOffPlan): string {
  if (offPlan === "waiting") return "Saved off the plan · waiting for approval";
  if (offPlan === "approved") return "Saved off the plan · approved";
  if (offPlan === "refused") return "Saved off the plan · refused";
  return "Saved off the plan";
}

// ── The report's shapes ─────────────────────────────────────────────────────────────────────────

export type DailyPlanActivity = { activityType: PhoenixCrmDayActivity; label: string; halfDay: boolean; note: string | null };

/** "Meeting · half day · With the district manager". */
export function dailyPlanActivityText(activity: DailyPlanActivity): string {
  return [activity.label, activity.halfDay ? "half day" : null, activity.note].filter((part): part is string => Boolean(part)).join(" · ");
}

export type DailyPlanCustomer = {
  customerId: string;
  name: string;
  grade: PhoenixCrmGrade | null;
  speciality: string | null;
  /** Carried over from iReports360 and not validated yet: planned on purpose, counted in nothing. */
  pending: boolean;
  /** Left the list, or his planned place was removed, after the day was planned. */
  stale: boolean;
  /**
   * His phone as the rep typed it (owner, 2026-09-30 — the old report's phone column). Null until the
   * rep gives one: the old list's phones are never shown, by the owner's choice.
   */
  phone: string | null;
  /** The place's own name, when it has one. */
  placeLabel: string | null;
  /** The organogram's brick and area: his validated place's, or the sales master's while he waits. */
  brick: string | null;
  area: string | null;
  address: string | null;
  /** "6:00 PM – 8:00 PM", "Does not receive this day", or "No days and hours yet". */
  hoursText: string;
  /** Why he was planned on a day his hours do not cover, when the rep said. */
  exceptionLabel: string | null;
  exceptionNote: string | null;
  status: DailyPlanVisitStatus;
  /** Minutes past midnight, Cairo, the visit to him that day was saved; null when not visited. */
  visitedMinute: number | null;
  offPlan: DailyPlanOffPlan | null;
};

/** What is true of a planned customer himself: not validated yet, gone from the list, planned outside his hours. */
export function dailyPlanCustomerFacts(customer: Pick<DailyPlanCustomer, "pending" | "stale" | "exceptionLabel" | "exceptionNote">): string[] {
  return [
    customer.pending ? "Not validated yet" : null,
    customer.stale ? "Left the list since" : null,
    customer.exceptionLabel ? (customer.exceptionNote ? `${customer.exceptionLabel} · ${customer.exceptionNote}` : customer.exceptionLabel) : null,
  ].filter((note): note is string => note !== null);
}

/** Every note on a planned customer, in the order it matters: what he is, then what became of the visit. */
export function dailyPlanCustomerNotes(customer: DailyPlanCustomer): string[] {
  return [...dailyPlanCustomerFacts(customer), ...(customer.offPlan ? [dailyPlanOffPlanText(customer.offPlan)] : [])];
}

/** "Brick Shebin 3 · Menoufia 2", then the address on its own. */
export function dailyPlanWhereText(customer: Pick<DailyPlanCustomer, "brick" | "area">): string | null {
  const parts = [customer.brick ? `Brick ${customer.brick}` : null, customer.area].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}

export type DailyPlanDay = {
  date: string;
  /** Test entries are the Super Admin's and a test login's; a test plan is listed after the real one. */
  isTest: boolean;
  state: DailyPlanState;
  /** The week was sent after it was due (stamped from the server's clock; never refused). */
  submittedLate: boolean;
  starts: PlanDayStarts;
  /** "Start AM 11:00 AM · Start PM 5:00 PM"; null when he set neither. */
  startsText: string | null;
  activities: DailyPlanActivity[];
  /** What the day can hold: a Thursday is a morning, AM only. */
  listTypes: PhoenixCrmListType[];
  am: DailyPlanCustomer[];
  pm: DailyPlanCustomer[];
  /** The visit day still running (until 02:00 the next morning). */
  running: boolean;
  /** HR approved the rep's leave for this day: its planned customers he did not see are "on leave". */
  onLeave: boolean;
};

export type DailyPlanTerritory = { seatId: string; name: string; lineName: string | null; repName: string | null };

export type DailyPlanReportView = {
  period: DailyPlanPeriod;
  cairoToday: string;
  /** The visit day running now — yesterday's until 02:00 Cairo. */
  visitDay: string;
  lastPlannableDay: string;
  includeTest: boolean;
  /** Null when the viewer reads several territories and has not chosen one: a plan is ONE rep's. */
  territory: DailyPlanTerritory | null;
  days: DailyPlanDay[];
  /** HR's leave could not be read, so a leave day's customers may read "Not visited" — said on screen. */
  leaveUnread: boolean;
};

// ── Putting a territory's plans together ────────────────────────────────────────────────────────

export type DailyPlanSourcePlan = {
  planId: string;
  weekStart: string;
  isTest: boolean;
  status: PhoenixCrmPlanStatus;
  submittedLate: boolean;
  /** Every status the plan was given, oldest first. */
  events: ReadonlyArray<DailyPlanEvent>;
};

export type DailyPlanSourceItem = Omit<DailyPlanCustomer, "status" | "visitedMinute" | "offPlan"> & {
  planId: string;
  date: string;
  listType: PhoenixCrmListType;
};

export type DailyPlanSourceActivity = DailyPlanActivity & { planId: string; date: string };

export type DailyPlanSourceStarts = { planId: string; date: string; starts: PlanDayStarts };

export type DailyPlanSourceVisit = {
  date: string;
  customerId: string;
  isTest: boolean;
  capturedAt: string;
  /** Null for a visit saved on the plan. */
  offPlan: DailyPlanOffPlan | null;
};

function key(...parts: ReadonlyArray<string | boolean>): string {
  return parts.join("|");
}

/**
 * The visit that answers "was he seen that day": the first one saved ON the plan, else the first one
 * saved off it — a customer seen twice is one visited customer, never two.
 */
function answeringVisit(visits: ReadonlyArray<DailyPlanSourceVisit>): DailyPlanSourceVisit | null {
  const inOrder = [...visits].sort((left, right) => timeOf(left.capturedAt) - timeOf(right.capturedAt));
  return inOrder.find((visit) => visit.offPlan === null) ?? inOrder[0] ?? null;
}

/**
 * The report's days, in order: every day of the period that can hold a plan, and on it each plan that
 * covers it — the real plan, then (when test entries are included) the test one. A day no plan covers
 * is still listed, once, so a gap shows instead of vanishing. Items keep the order they came in: the
 * order the plan board lists them.
 */
export function buildDailyPlanDays(input: {
  period: DailyPlanPeriod;
  cairoToday: string;
  visitDay: string;
  plans: ReadonlyArray<DailyPlanSourcePlan>;
  items: ReadonlyArray<DailyPlanSourceItem>;
  activities: ReadonlyArray<DailyPlanSourceActivity>;
  starts: ReadonlyArray<DailyPlanSourceStarts>;
  visits: ReadonlyArray<DailyPlanSourceVisit>;
  /** The days HR approved this territory's rep's leave — read from HR, never inferred from visits. */
  leaveDays?: ReadonlySet<string>;
}): DailyPlanDay[] {
  const leaveDays = input.leaveDays ?? new Set<string>();
  const plansByWeek = new Map<string, DailyPlanSourcePlan[]>();
  for (const plan of input.plans) plansByWeek.set(plan.weekStart, [...(plansByWeek.get(plan.weekStart) ?? []), plan]);
  const itemsByDay = new Map<string, DailyPlanSourceItem[]>();
  for (const item of input.items) itemsByDay.set(key(item.planId, item.date), [...(itemsByDay.get(key(item.planId, item.date)) ?? []), item]);
  const activitiesByDay = new Map<string, DailyPlanActivity[]>();
  for (const { planId, date, ...activity } of input.activities) {
    activitiesByDay.set(key(planId, date), [...(activitiesByDay.get(key(planId, date)) ?? []), activity]);
  }
  const startsByDay = new Map(input.starts.map((entry) => [key(entry.planId, entry.date), entry.starts]));
  const visitsByCustomer = new Map<string, DailyPlanSourceVisit[]>();
  for (const visit of input.visits) {
    const at = key(visit.isTest, visit.date, visit.customerId);
    visitsByCustomer.set(at, [...(visitsByCustomer.get(at) ?? []), visit]);
  }

  const blankDay = (date: string, isTest: boolean): DailyPlanDay => ({
    date,
    isTest,
    state: "none",
    submittedLate: false,
    starts: noDayStarts(),
    startsText: null,
    activities: [],
    listTypes: planDayListTypes(date),
    am: [],
    pm: [],
    running: date === input.visitDay,
    onLeave: leaveDays.has(date),
  });

  return dailyPlanDates(input.period).flatMap((date): DailyPlanDay[] => {
    const covering = [...(plansByWeek.get(fieldWeekStart(date)) ?? [])].sort((left, right) => Number(left.isTest) - Number(right.isTest));
    if (covering.length === 0) return [blankDay(date, false)];
    return covering.map((plan): DailyPlanDay => {
      const customers = (itemsByDay.get(key(plan.planId, date)) ?? []).map((item) => {
        const visit = answeringVisit(visitsByCustomer.get(key(plan.isTest, date, item.customerId)) ?? []);
        const customer: DailyPlanCustomer = {
          customerId: item.customerId,
          name: item.name,
          grade: item.grade,
          speciality: item.speciality,
          pending: item.pending,
          stale: item.stale,
          phone: item.phone,
          placeLabel: item.placeLabel,
          brick: item.brick,
          area: item.area,
          address: item.address,
          hoursText: item.hoursText,
          exceptionLabel: item.exceptionLabel,
          exceptionNote: item.exceptionNote,
          status: dailyPlanVisitStatus({ date, visitDay: input.visitDay, visited: visit !== null, onLeave: leaveDays.has(date) }),
          visitedMinute: visit ? cairoMinuteOfInstant(visit.capturedAt) : null,
          offPlan: visit?.offPlan ?? null,
        };
        return { listType: item.listType, customer };
      });
      const starts = startsByDay.get(key(plan.planId, date)) ?? noDayStarts();
      return {
        ...blankDay(date, plan.isTest),
        state: dailyPlanState({ date, cairoToday: input.cairoToday, current: plan.status, statusAtEnd: statusAtDayEnd(plan.events, date) }),
        submittedLate: plan.submittedLate,
        starts,
        startsText: describeDayStarts(starts),
        activities: activitiesByDay.get(key(plan.planId, date)) ?? [],
        am: customers.filter((entry) => entry.listType === "AM").map((entry) => entry.customer),
        pm: customers.filter((entry) => entry.listType === "PM").map((entry) => entry.customer),
      };
    });
  });
}

/** Whether a day holds anything at all — customers, other activities or a start time. */
export function dailyPlanDayIsEmpty(day: DailyPlanDay): boolean {
  return day.am.length === 0 && day.pm.length === 0 && day.activities.length === 0 && day.startsText === null;
}
