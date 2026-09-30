/**
 * Phoenix CRM — one week of the plan as the board holds it before it is saved, with no I/O.
 *
 * Owner, 2026-09-29: the plan is ONE board — the month on top as Week 1..N, a week's six days, and a
 * day's customers ticked by brick with the day's other activity at the top. The rep's ticks stay on the
 * page as a DRAFT over the week's saved version until he saves it, and a week is saved on its own
 * through the ordinary weekly save (`POST /api/phoenix-crm/plans`), so every day passes the same rules
 * a hand-placed day always has.
 *
 * Ported from plan-tab.tsx, which the board replaced the same day:
 *   - a draft stands over the version it was started on, and once saved over the version that save
 *     made, so it outlives the reload that follows (and a reload that failed);
 *   - only the days the rep may still change are drafted, sent and compared — a day that has passed
 *     keeps what was saved;
 *   - a customer who left the list since he was planned comes off at the next save, and a customer
 *     whose planned place is no longer his is sent at his place for that day;
 *   - a customer placed on a day his saved hours do not cover is never blocked and asks nothing (owner,
 *     2026-09-30), and a day holds the AM and PM caps at most — the plan's only hard limits
 *     (plan-rules.ts);
 *   - the day's planned activity rides on the same save, and the FULL list for the editable days is
 *     sent every time, so taking one off is a save like any other.
 *
 * And the three copies (plan-copy.ts places them): a customer lands on his day whatever hours are saved
 * against it (owner, 2026-09-30 — never block on a time the rep did not enter), and every copy is
 * summarised as how many were placed and how many could not be — a full day, no place left, or no
 * longer on the list. A copy only fills the draft; nothing here saves or sends.
 */

import { fieldWeekStart, weekdayOfIsoDay, weekNumberInMonth } from "@/lib/phoenix-crm/calendar";
import type { PhoenixCrmDayActivity } from "@/lib/phoenix-crm/day-activities";
import type { CopySourcePlacement, CopyWeek } from "@/lib/phoenix-crm/plan-copy";
import { PLAN_EXCEPTION_TYPES, type PlanExceptionType, type PlanItemDraft } from "@/lib/phoenix-crm/plan-rules";
import type { PlannerCustomer, PlannerPlace } from "@/lib/phoenix-crm/suggestions";
import { windowsForWeekday } from "@/lib/phoenix-crm/timings";
import type { PhoenixCrmListType, PhoenixCrmTiming } from "@/lib/phoenix-crm/types";

/** The longest note a planned activity keeps — the table's own limit (server/plan-activities.ts PLAN_ACTIVITY_NOTE_MAX). */
export const PLANNED_ACTIVITY_NOTE_MAX = 300;

/** One day's other activity, as the save sends it. */
export type PlannedActivity = {
  planDate: string;
  activityType: PhoenixCrmDayActivity;
  halfDay: boolean;
  note: string | null;
};

/** A saved placement as the week view carries it — the part of PlanItemView a draft needs. */
export type DraftDayItem = {
  customerId: string;
  placeId: string | null;
  listType: PhoenixCrmListType;
  name: string;
  exceptionType: string | null;
  exceptionNote: string | null;
};

/** A day of the week view — the part of PlanDayView a draft needs. */
export type DraftDay = {
  date: string;
  listTypes: ReadonlyArray<PhoenixCrmListType>;
  ramadan: boolean;
  /** Today or later: the rep may still change it. */
  editable: boolean;
  activity: { activityType: PhoenixCrmDayActivity; halfDay: boolean; note: string | null } | null;
  items: ReadonlyArray<DraftDayItem>;
};

/** A field-week of the month — the part of MonthlyWeekView a draft needs. */
export type DraftWeek = {
  weekStart: string;
  days: ReadonlyArray<DraftDay>;
  plan: { planId: string; version: number } | null;
};

/**
 * The rep's changes to one week, over the saved version they were started on. Once saved, the draft also
 * stands over the version that save wrote, so it survives the reload that follows it.
 */
export type WeekDraft = {
  /** Territory, test or live, week. */
  scope: string;
  /** The plan and version on screen when the draft started. */
  basis: string;
  items: PlanItemDraft[];
  activities: PlannedActivity[];
  /** What the last save wrote, and the version it made. */
  saved: { items: PlanItemDraft[]; activities: PlannedActivity[]; planId: string; version: number } | null;
};

export type DailyCaps = { amDailyCap: number; pmDailyCap: number };

// ── Keys and versions ───────────────────────────────────────────────────────────────────────────

export function weekScope(seatId: string, test: boolean, weekStart: string): string {
  return [seatId, test ? "test" : "live", weekStart].join("|");
}

export function weekBasis(plan: DraftWeek["plan"]): string {
  return `${plan?.planId ?? "none"}|${plan?.version ?? 0}`;
}

export function asExceptionType(value: string | null | undefined): PlanExceptionType | null {
  return PLAN_EXCEPTION_TYPES.find((type) => type.key === value)?.key ?? null;
}

function cleanNote(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  return text ? text : null;
}

export function indexCustomers(customers: ReadonlyArray<PlannerCustomer>): Map<string, PlannerCustomer> {
  return new Map(customers.map((customer) => [customer.customerId, customer]));
}

// ── The saved week, and a draft over it ─────────────────────────────────────────────────────────

/** The saved placements of the days the rep may still change — what a draft starts from. */
export function savedWeekItems(week: DraftWeek): PlanItemDraft[] {
  return week.days
    .filter((day) => day.editable)
    .flatMap((day) =>
      day.items.map((item) => ({
        planDate: day.date,
        customerId: item.customerId,
        placeId: item.placeId,
        exceptionType: asExceptionType(item.exceptionType),
        exceptionNote: item.exceptionNote,
      })),
    );
}

/** The saved activities of the days the rep may still change. */
export function savedWeekActivities(week: DraftWeek): PlannedActivity[] {
  return week.days.flatMap((day) =>
    day.editable && day.activity
      ? [{ planDate: day.date, activityType: day.activity.activityType, halfDay: day.activity.halfDay, note: day.activity.note }]
      : [],
  );
}

/**
 * The draft still belongs to the week on screen: same territory and week, and over the version on screen
 * (or the one its own save made). A version it does not know means the week changed somewhere else.
 */
export function draftFits(draft: WeekDraft | null | undefined, scope: string, week: DraftWeek): draft is WeekDraft {
  if (!draft || draft.scope !== scope) return false;
  const current = weekBasis(week.plan);
  return draft.basis === current || (draft.saved !== null && `${draft.saved.planId}|${draft.saved.version}` === current);
}

export function startDraft(scope: string, week: DraftWeek): WeekDraft {
  return { scope, basis: weekBasis(week.plan), items: savedWeekItems(week), activities: savedWeekActivities(week), saved: null };
}

/** The rep keeps his ticks over a version saved elsewhere: the next save goes over the version on screen. */
export function rebaseDraft(draft: WeekDraft, week: DraftWeek): WeekDraft {
  return { ...draft, basis: weekBasis(week.plan), saved: null };
}

/** What a save wrote, standing over the version on screen AND the version the save made. */
export function markWeekSaved(
  scope: string,
  week: DraftWeek,
  saved: { planId: string; version: number },
  items: PlanItemDraft[],
  activities: PlannedActivity[],
): WeekDraft {
  return {
    scope,
    basis: weekBasis(week.plan),
    items,
    activities,
    saved: { items, activities, planId: saved.planId, version: saved.version },
  };
}

function itemSignature(item: PlanItemDraft): string {
  return ["item", item.planDate, item.customerId, item.placeId ?? "", item.exceptionType ?? "", (item.exceptionNote ?? "").trim()].join("|");
}

function activitySignature(activity: PlannedActivity): string {
  return ["activity", activity.planDate, activity.activityType, activity.halfDay ? "half" : "whole", (activity.note ?? "").trim()].join("|");
}

/** Order-free, so re-ticking a customer in another order is not a change. */
export function weekSignature(items: ReadonlyArray<PlanItemDraft>, activities: ReadonlyArray<PlannedActivity>): string {
  return [...items.map(itemSignature), ...activities.map(activitySignature)].sort().join("\n");
}

/** The draft holds changes its own baseline does not: the last save, or the week as it was loaded. */
export function isWeekDirty(draft: WeekDraft | null | undefined, week: DraftWeek): boolean {
  if (!draft) return false;
  const items = draft.saved ? draft.saved.items : savedWeekItems(week);
  const activities = draft.saved ? draft.saved.activities : savedWeekActivities(week);
  return weekSignature(draft.items, draft.activities) !== weekSignature(items, activities);
}

/** The draft says exactly what the week on screen already holds (a save that went through, say). */
export function matchesSavedWeek(draft: WeekDraft, week: DraftWeek): boolean {
  return weekSignature(draft.items, draft.activities) === weekSignature(savedWeekItems(week), savedWeekActivities(week));
}

/**
 * "Discard changes" for one week: back to what was last saved. The draft's OWN save when it still stands
 * over the version on screen, else no draft at all — and with no draft the week reads its saved
 * placements again, which is exactly what the rep asked for.
 *
 * It lives here rather than inline in the board so the one thing it must never do is pinned by a test
 * over every state a draft can be in: leave a tick on the screen while the unsaved bar goes away. A
 * discard that clears the dirty flag without clearing the ticks leaves the rep looking at a plan he just
 * discarded, and his next save writes it.
 */
export function discardWeekDraft(draft: WeekDraft, week: DraftWeek): WeekDraft | null {
  if (!draft.saved || !draftFits(draft, draft.scope, week)) return null;
  return { ...draft, items: draft.saved.items, activities: draft.saved.activities };
}

/**
 * A held week that has answered itself, and so needs nothing from the rep.
 *
 * A save whose answer was lost (offline, a timeout) keeps the draft and reloads the week: when the
 * reload shows the week already saying exactly what the draft says, the save DID land. Nothing is on
 * screen at that point — no banner, no unsaved bar — so the hold has to go with it, or a draft standing
 * over a version that no longer exists is kept alive: the rep's next tick then raises "this week changed
 * since you started" against his own landed save, and `readyToSave` refuses to save at all.
 */
export function holdSettled(draft: WeekDraft | null | undefined, week: DraftWeek, held: boolean): boolean {
  if (!held || !draft) return false;
  return !draftFits(draft, draft.scope, week) && matchesSavedWeek(draft, week);
}

// ── Changing the draft ──────────────────────────────────────────────────────────────────────────

/** Ticks a customer on a day; a customer ticked again replaces what was there. */
export function placeCustomer(items: ReadonlyArray<PlanItemDraft>, item: PlanItemDraft): PlanItemDraft[] {
  return [...items.filter((entry) => !(entry.planDate === item.planDate && entry.customerId === item.customerId)), item];
}

export function takeOffCustomer(items: ReadonlyArray<PlanItemDraft>, date: string, customerId: string): PlanItemDraft[] {
  return items.filter((entry) => !(entry.planDate === date && entry.customerId === customerId));
}

export function setCustomerReason(
  items: ReadonlyArray<PlanItemDraft>,
  date: string,
  customerId: string,
  exceptionType: PlanExceptionType | null,
  exceptionNote: string | null,
): PlanItemDraft[] {
  return items.map((entry) => (entry.planDate === date && entry.customerId === customerId ? { ...entry, exceptionType, exceptionNote } : entry));
}

/** One activity a day: a new one replaces the day's, and null takes it off. */
export function setPlannedActivity(
  activities: ReadonlyArray<PlannedActivity>,
  date: string,
  next: Omit<PlannedActivity, "planDate"> | null,
): PlannedActivity[] {
  const rest = activities.filter((activity) => activity.planDate !== date);
  const all = next ? [...rest, { planDate: date, ...next }] : rest;
  return all.sort((left, right) => left.planDate.localeCompare(right.planDate));
}

/** A copy's placements added to the draft; a customer already on that day is never doubled. */
export function addCopiedItems(items: ReadonlyArray<PlanItemDraft>, additions: ReadonlyArray<PlanItemDraft>): PlanItemDraft[] {
  const taken = new Set(items.map((item) => `${item.planDate}|${item.customerId}`));
  const out = [...items];
  for (const addition of additions) {
    const key = `${addition.planDate}|${addition.customerId}`;
    if (taken.has(key)) continue;
    taken.add(key);
    out.push(addition);
  }
  return out;
}

// ── One customer on one day ─────────────────────────────────────────────────────────────────────

export type DayFit = {
  /** Null for a customer not validated yet: he is planned without a place. */
  placeId: string | null;
  place: PlannerPlace | null;
  receives: boolean;
  windows: PhoenixCrmTiming[];
  noRamadanTime: boolean;
};

/**
 * Where a customer is planned on a day: the place asked for when it is still his, else his first place
 * that receives that day, else his first place (and then the day needs a reason). A customer not
 * validated yet has no place and no days and hours, so nothing is known against him — he "receives".
 * Null when a validated customer has no place left at all.
 */
export function customerOnDay(customer: PlannerCustomer, date: string, ramadan: boolean, preferredPlaceId: string | null = null): DayFit | null {
  if (customer.pending) return { placeId: null, place: null, receives: true, windows: [], noRamadanTime: false };
  if (customer.places.length === 0) return null;
  const weekday = weekdayOfIsoDay(date);
  const read = (place: PlannerPlace): DayFit => {
    const seasonal = windowsForWeekday(place.timings, weekday, ramadan);
    return { placeId: place.placeId, place, receives: seasonal.windows.length > 0, windows: seasonal.windows, noRamadanTime: seasonal.noRamadanTime };
  };
  const preferred = preferredPlaceId ? customer.places.find((place) => place.placeId === preferredPlaceId) : undefined;
  if (preferred) return read(preferred);
  const fits = customer.places.map(read);
  return fits.find((fit) => fit.receives) ?? fits[0];
}

export function receivesOnDay(customer: PlannerCustomer, day: Pick<DraftDay, "date" | "ramadan">): boolean {
  return customerOnDay(customer, day.date, day.ramadan)?.receives ?? false;
}

/** One drafted placement, read against today's list. */
export type DraftRow = {
  customerId: string;
  name: string;
  listType: PhoenixCrmListType;
  customer: PlannerCustomer | null;
  /** The place the save sends. */
  placeId: string | null;
  receives: boolean;
  windows: PhoenixCrmTiming[];
  noRamadanTime: boolean;
  exceptionType: PlanExceptionType | null;
  exceptionNote: string | null;
  /** Planned before the customer left the list (or lost his last place): it comes off at the next save. */
  gone: boolean;
  /** The drafted place is no longer his: the save sends his place for this day instead. */
  moved: boolean;
};

export function resolveDayRows(day: DraftDay, items: ReadonlyArray<PlanItemDraft>, byId: ReadonlyMap<string, PlannerCustomer>): DraftRow[] {
  return items
    .filter((item) => item.planDate === day.date)
    .map((item): DraftRow => {
      const customer = byId.get(item.customerId) ?? null;
      const fit = customer ? customerOnDay(customer, day.date, day.ramadan, item.placeId) : null;
      if (!customer || !fit) {
        const saved = day.items.find((entry) => entry.customerId === item.customerId);
        return {
          customerId: item.customerId,
          name: customer?.name ?? saved?.name ?? "A customer no longer on the list",
          listType: customer?.listType ?? saved?.listType ?? "PM",
          customer,
          placeId: item.placeId,
          receives: true,
          windows: [],
          noRamadanTime: false,
          exceptionType: null,
          exceptionNote: null,
          gone: true,
          moved: false,
        };
      }
      return {
        customerId: item.customerId,
        name: customer.name,
        listType: customer.listType,
        customer,
        placeId: fit.placeId,
        receives: fit.receives,
        windows: fit.windows,
        noRamadanTime: fit.receives && fit.noRamadanTime,
        exceptionType: fit.receives ? null : item.exceptionType,
        exceptionNote: fit.receives ? null : item.exceptionNote,
        gone: false,
        moved: fit.placeId !== item.placeId,
      };
    });
}

/** AM and PM on a day, apart — a customer who left the list is not counted. */
export function dayCounts(rows: ReadonlyArray<DraftRow>): Record<PhoenixCrmListType, number> {
  const counts: Record<PhoenixCrmListType, number> = { AM: 0, PM: 0 };
  for (const row of rows) if (!row.gone) counts[row.listType] += 1;
  return counts;
}

/** What each list's cap still has room for on a day. */
export function roomOnDay(rows: ReadonlyArray<DraftRow>, caps: DailyCaps): Record<PhoenixCrmListType, number> {
  const counts = dayCounts(rows);
  return { AM: Math.max(0, caps.amDailyCap - counts.AM), PM: Math.max(0, caps.pmDailyCap - counts.PM) };
}

/** How full each of a day's lists is, and whether the day itself is. */
export type DayFullness = { AM: boolean; PM: boolean; day: boolean };

/**
 * A list is full once it holds the day's cap (5 AM, 15 PM by default); the day is full once EVERY list
 * it holds is — a Thursday morning holds AM only, so a full AM fills it (owner, 2026-09-30: "when the
 * AM is full or PM or full day, with a light green highlight").
 *
 * It is shown the way Today already shows a finished list: the square meter turns EMERALD at the cap
 * and an emerald rail lights the day. Never a flat wash, never a word on a row, and never a refusal —
 * a full list simply has no room left to tick.
 */
export function dayFullness(
  counts: Record<PhoenixCrmListType, number>,
  caps: DailyCaps,
  listTypes: ReadonlyArray<PhoenixCrmListType>,
): DayFullness {
  const AM = listTypes.includes("AM") && caps.amDailyCap > 0 && counts.AM >= caps.amDailyCap;
  const PM = listTypes.includes("PM") && caps.pmDailyCap > 0 && counts.PM >= caps.pmDailyCap;
  return { AM, PM, day: listTypes.length > 0 && listTypes.every((listType) => (listType === "AM" ? AM : PM)) };
}

// ── What the server would refuse ────────────────────────────────────────────────────────────────

export type DraftProblem =
  | { kind: "morning"; date: string; name: string }
  | { kind: "cap"; date: string; listType: PhoenixCrmListType; count: number; cap: number };

/** Named before the save leaves the page, in the order the rep meets them. */
export function weekProblems(
  week: DraftWeek,
  items: ReadonlyArray<PlanItemDraft>,
  byId: ReadonlyMap<string, PlannerCustomer>,
  caps: DailyCaps,
): DraftProblem[] {
  const problems: DraftProblem[] = [];
  for (const day of week.days) {
    if (!day.editable) continue;
    const rows = resolveDayRows(day, items, byId);
    for (const row of rows) {
      if (row.gone) continue;
      // A day his saved hours do not cover is never a problem (owner, 2026-09-30): only a Thursday PM is.
      if (!day.listTypes.includes(row.listType)) problems.push({ kind: "morning", date: day.date, name: row.name });
    }
    const counts = dayCounts(rows);
    if (counts.PM > caps.pmDailyCap) problems.push({ kind: "cap", date: day.date, listType: "PM", count: counts.PM, cap: caps.pmDailyCap });
    if (counts.AM > caps.amDailyCap) problems.push({ kind: "cap", date: day.date, listType: "AM", count: counts.AM, cap: caps.amDailyCap });
  }
  return problems;
}

/** Planned customers the next save changes by itself: those who left the list, and those whose place moved. */
export function weekFixes(week: DraftWeek, items: ReadonlyArray<PlanItemDraft>, byId: ReadonlyMap<string, PlannerCustomer>): number {
  return week.days
    .filter((day) => day.editable)
    .reduce((sum, day) => sum + resolveDayRows(day, items, byId).filter((row) => row.gone || row.moved).length, 0);
}

// ── The save ────────────────────────────────────────────────────────────────────────────────────

export type WeekSavePayload = {
  seatId: string;
  test: boolean;
  weekStart: string;
  /** The version the draft stands over; null for a week with no plan yet. */
  expectedVersion: number | null;
  /** Every placement of the editable days — a day left out of it is emptied. */
  items: PlanItemDraft[];
  /** The FULL activity list of the editable days, so taking one off saves too. */
  activities: PlannedActivity[];
};

/** The body of `POST /api/phoenix-crm/plans` for one week. A customer no longer on the list is left out. */
export function buildWeekSavePayload(input: {
  seatId: string;
  test: boolean;
  week: DraftWeek;
  draft: WeekDraft | null;
  customers: ReadonlyArray<PlannerCustomer>;
}): WeekSavePayload {
  const byId = indexCustomers(input.customers);
  const items = input.draft ? input.draft.items : savedWeekItems(input.week);
  const activities = input.draft ? input.draft.activities : savedWeekActivities(input.week);
  const editable = input.week.days.filter((day) => day.editable);
  const editableDates = new Set(editable.map((day) => day.date));
  return {
    seatId: input.seatId,
    test: input.test,
    weekStart: input.week.weekStart,
    expectedVersion: input.draft?.saved?.version ?? input.week.plan?.version ?? null,
    items: editable.flatMap((day) =>
      resolveDayRows(day, items, byId)
        .filter((row) => !row.gone)
        .map((row) => ({
          planDate: day.date,
          customerId: row.customerId,
          placeId: row.placeId,
          exceptionType: row.receives ? null : row.exceptionType,
          exceptionNote: row.receives ? null : cleanNote(row.exceptionNote),
        })),
    ),
    activities: activities
      .filter((activity) => editableDates.has(activity.planDate))
      .map((activity) => ({
        planDate: activity.planDate,
        activityType: activity.activityType,
        halfDay: activity.halfDay,
        note: cleanNote(activity.note)?.slice(0, PLANNED_ACTIVITY_NOTE_MAX) ?? null,
      }))
      .sort((left, right) => left.planDate.localeCompare(right.planDate)),
  };
}

// ── Which week and day to open ──────────────────────────────────────────────────────────────────

/** The first week still open and not sent yet (a returned one is waiting to be sent again), else the first open one. */
export function firstWeekToPlan<T extends { open: boolean; status: string | null }>(weeks: ReadonlyArray<T>): T | null {
  return (
    weeks.find((week) => week.open && (week.status === null || week.status === "draft" || week.status === "returned")) ??
    weeks.find((week) => week.open) ??
    null
  );
}

export type WeekToPlanMove<T> = { kind: "week"; week: T } | { kind: "month"; monthStart: string } | { kind: "none" };

/**
 * Where "+ Make weekly plan" goes. The first week of this month still to plan; when this month has
 * none left — late in a month every week is past or sent, and the next week to plan belongs to the
 * NEXT month — that month, once, and only while nothing here is unsaved; else the first open week
 * here. Found on the owner's walk of 2026-09-30: on 30 September the button opened September's Week 4,
 * already sent, instead of the week of Saturday 3 October.
 */
export function weekToPlanMove<T extends { open: boolean; status: string | null }>(input: {
  weeks: ReadonlyArray<T>;
  monthStart: string;
  months: ReadonlyArray<{ monthStart: string }>;
  mayChangeMonth: boolean;
}): WeekToPlanMove<T> {
  const toPlan = input.weeks.find(
    (week) => week.open && (week.status === null || week.status === "draft" || week.status === "returned"),
  );
  if (toPlan) return { kind: "week", week: toPlan };
  const later = input.mayChangeMonth ? input.months.find((option) => option.monthStart > input.monthStart) : undefined;
  if (later) return { kind: "month", monthStart: later.monthStart };
  const open = input.weeks.find((week) => week.open);
  return open ? { kind: "week", week: open } : { kind: "none" };
}

/** The first day the rep may still change, else the week's first day. */
export function firstDayToPlan<T extends { editable: boolean }>(days: ReadonlyArray<T>): T | null {
  return days.find((day) => day.editable) ?? days[0] ?? null;
}

// ── Copies ──────────────────────────────────────────────────────────────────────────────────────

/** The week's days as plan-copy.ts reads them: who is on each day already, from the draft. */
export function copyWeekOf(week: DraftWeek, items: ReadonlyArray<PlanItemDraft>, byId: ReadonlyMap<string, PlannerCustomer>): CopyWeek {
  return {
    weekStart: week.weekStart,
    days: week.days.map((day) => ({
      date: day.date,
      listTypes: [...day.listTypes],
      editable: day.editable,
      items: day.editable
        ? resolveDayRows(day, items, byId)
            .filter((row) => !row.gone)
            .map((row) => ({ customerId: row.customerId, listType: row.listType }))
        : day.items.map((item) => ({ customerId: item.customerId, listType: item.listType })),
    })),
  };
}

/** The day a copied placement would land on, or null when the target has no such day. */
export type TargetDayOf = (placement: CopySourcePlacement) => DraftDay | null;

/** Copy last week: the same weekday of the target week. */
export function sameWeekdayIn(week: DraftWeek): TargetDayOf {
  return (placement) => week.days.find((day) => weekdayOfIsoDay(day.date) === weekdayOfIsoDay(placement.planDate)) ?? null;
}

/** Copy last month: Week N's weekday onto Week N's same weekday. */
export function sameWeekNumberIn(weeks: ReadonlyArray<DraftWeek>): TargetDayOf {
  const byNumber = new Map(weeks.map((week) => [weekNumberInMonth(week.weekStart), week]));
  return (placement) => {
    const week = byNumber.get(weekNumberInMonth(fieldWeekStart(placement.planDate)));
    return week ? sameWeekdayIn(week)(placement) : null;
  };
}

/** Copy a day: every placement lands on the one day. */
export function onTheDay(day: DraftDay): TargetDayOf {
  return () => day;
}

/**
 * The placements a copy made, each at the customer's place for that day (plan-copy.ts takes his first
 * place) — whatever hours are saved against that day: a time the rep did not enter never keeps a
 * customer off (owner, 2026-09-30). Only one with no place left at all is left out, and counted.
 */
export function settleCopiedPlaces(
  placements: ReadonlyArray<PlanItemDraft>,
  dayOf: (date: string) => DraftDay | null,
  byId: ReadonlyMap<string, PlannerCustomer>,
): { kept: PlanItemDraft[]; noPlace: number } {
  const kept: PlanItemDraft[] = [];
  let noPlace = 0;
  for (const placement of placements) {
    const customer = byId.get(placement.customerId);
    const day = dayOf(placement.planDate);
    const fit = customer && day ? customerOnDay(customer, day.date, day.ramadan) : null;
    if (!fit) {
      noPlace += 1;
      continue;
    }
    kept.push({ ...placement, placeId: fit.placeId, exceptionType: null, exceptionNote: null });
  }
  return { kept, noPlace };
}

export type CopySummary = {
  placed: number;
  /** The day it would land on had no room left for that list. */
  full: number;
  /** He has no place left to plan him at. */
  noPlace: number;
  /** He is no longer on the list. */
  notOnList: number;
};

/**
 * How a copy went, placement by placement. A customer already on that day, a day that has passed and a
 * PM customer on a Thursday morning are not counted as failures — a copy only ever fills the days the
 * rep can change with the customers the day can hold.
 */
export function summarizeCopy(input: {
  source: ReadonlyArray<CopySourcePlacement>;
  targetDayOf: TargetDayOf;
  byId: ReadonlyMap<string, PlannerCustomer>;
  /** Who was on each target day BEFORE the copy. */
  alreadyOn: (date: string) => ReadonlySet<string>;
  placed: ReadonlyArray<PlanItemDraft>;
}): CopySummary {
  const placedKeys = new Set(input.placed.map((item) => `${item.planDate}|${item.customerId}`));
  const seen = new Set<string>();
  const summary: CopySummary = { placed: input.placed.length, full: 0, noPlace: 0, notOnList: 0 };
  for (const placement of input.source) {
    const day = input.targetDayOf(placement);
    if (!day || !day.editable) continue;
    const key = `${day.date}|${placement.customerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (placedKeys.has(key) || input.alreadyOn(day.date).has(placement.customerId)) continue;
    const customer = input.byId.get(placement.customerId);
    if (!customer) summary.notOnList += 1;
    else if (!day.listTypes.includes(customer.listType)) continue;
    else if (!customerOnDay(customer, day.date, day.ramadan)) summary.noPlace += 1;
    else summary.full += 1;
  }
  return summary;
}
