import { addDaysIso } from "@/lib/crm/dates";
import { clusterByBrick } from "@/lib/phoenix-crm/brick-groups";
import { VISIT_DAY_CUTOFF_HOURS } from "@/lib/phoenix-crm/calendar";
import { formatClockMinute, PHOENIX_CRM_WEEKDAY_NAMES } from "@/lib/phoenix-crm/timings";

import type { PlannerReference } from "@/lib/phoenix-crm/suggestions";
import type { PhoenixCrmGrade, PhoenixCrmListType, PhoenixCrmPlanStatus } from "@/lib/phoenix-crm/types";
import type { UnplannedKind } from "@/lib/phoenix-crm/unplanned-rules";

/**
 * Phoenix CRM — the rep's day, as one list he can work down.
 *
 * GOLDEN RULE #1, the EASY half (owner, 2026-09-26): "very easy very simple". He opens the app
 * twelve times a day and, until now, landed on a tab bar and navigated. This builds the one screen
 * he should land on: today's stops, in the order he will drive them, each one either done or one tap
 * from being entered.
 *
 * Pure. The I/O half is `src/lib/phoenix-crm/server/today.ts`.
 *
 * ## The rule that matters more than the rest
 *
 * A stop he has already visited **keeps its place**. The obvious implementation moves a visited stop
 * to the bottom, and it is wrong: a rep glances at this screen between two doors, and a list that
 * reshuffles under him mid-morning is a list he has to re-read every time. It changes state in
 * place, and nothing moves until tomorrow.
 *
 * ## What is NOT here
 *
 * No distance, no accuracy, no spread, no flag, and no count of any of them. This is his plan, his
 * day and his targets — his own work, which Golden Rule #1 keeps visible — and nothing else.
 */

/**
 * One receiving window today, in minutes past midnight. An end above 1440 runs past midnight (a
 * clinic open 10:00 PM – 1:00 AM); a null end is a start time only, as the owner's own sheet gives.
 */
export type TodayWindow = { startMinute: number; endMinute: number | null };

export type TodayStop = {
  customerId: string;
  name: string;
  listType: PhoenixCrmListType;
  speciality: string | null;
  brick: string | null;
  placeLabel: string | null;
  /** Today's receiving hours at his place, or "Does not receive this day". */
  todayWindows: string;
  /** Minutes past midnight of the first window today, for ordering inside one brick. */
  startMinute: number | null;
  /**
   * The three fields the "Next up" card reads (2026-09-30). Optional so a stop built without them —
   * a fixture, an answer from before they existed — still reads, as "no hours saved yet".
   *
   * `grade` is the A/B/C grade on his list. `windows` are today's receiving windows at his place,
   * already the Ramadan set in Ramadan (the server decides the season, never the phone); empty when
   * none apply today. `hoursSaved` is false when no hours are saved for him at all, so "no hours yet"
   * is never read as "does not receive today".
   */
  grade?: PhoenixCrmGrade | null;
  windows?: readonly TodayWindow[];
  hoursSaved?: boolean;
  /** Where the sales master has a customer NOT VALIDATED YET — he has no clinic of his own to read. */
  reference?: PlannerReference | null;
  /** A place is saved for him (named or not). Optional for the same reason as the three above. */
  hasPlace?: boolean;
  done: boolean;
  /** Cairo clock of the visit, when it is done. */
  doneAt: string | null;
};

/** A visit he made today to somebody who was not on the plan. Beside the day, never inside it. */
export type TodayExtra = {
  customerId: string;
  name: string;
  listType: PhoenixCrmListType;
  doneAt: string;
  /** Out of plan (his list, not today's plan) or out of list (not on his list at all). */
  offKind: UnplannedKind | null;
  /** Where it has got to, in his words: waiting for the manager, for SFE, for the customer to be added. */
  statusLabel: string | null;
};

/**
 * A pharmacy he took feedback from today, and the customer it came from.
 *
 * 🔴 A PHARMACY IS NEVER A STOP OF ITS OWN. In Phoenix CRM a pharmacy is feedback recorded ON a visit
 * (`phoenix_crm_visits.pharmacy_name`) — a customer's `list_type` is AM or PM and nothing else — so
 * there is no pharmacy to plan and none to "Add visit" against. This is the day's pharmacy work read
 * back, and it is counted APART from AM and PM (the AM · PM · Pharmacies golden rule): a pharmacy is
 * never inside the AM or the PM figure, whatever the vendor tagged.
 */
export type TodayPharmacy = {
  /** As the rep most recently spelled it — pharmacies are free text, grouped case-insensitively. */
  name: string;
  /** The customers whose visits named it today, in the order he visited them. */
  fromCustomers: string[];
  /** Cairo clock of the first visit today that named it. */
  firstAt: string;
};

export type TodayCounts = {
  plannedAm: number;
  plannedPm: number;
  doneAm: number;
  donePm: number;
  /** Distinct pharmacies he took feedback from today. Never added into doneAm or donePm. */
  donePharmacies: number;
};

/**
 * The day's pharmacies, grouped case-insensitively with the most recent spelling as the name — the
 * same rule the List uses for a customer's pharmacies, so one pharmacy never reads as two.
 */
export function todayPharmacies(visitsToday: readonly TodayVisit[]): TodayPharmacy[] {
  const byKey = new Map<string, { name: string; fromCustomers: string[]; firstAt: string }>();
  for (const visit of visitsToday) {
    const name = (visit.pharmacyName ?? "").trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    const entry = byKey.get(key);
    if (entry) {
      // The most recent spelling wins, exactly as the List's own grouping decides it.
      entry.name = name;
      if (!entry.fromCustomers.includes(visit.name)) entry.fromCustomers.push(visit.name);
    } else {
      byKey.set(key, { name, fromCustomers: [visit.name], firstAt: visit.doneAt });
    }
  }
  return [...byKey.values()];
}

export type TodayBuild = {
  stops: TodayStop[];
  alsoVisited: TodayExtra[];
  /** The pharmacies he took feedback from today — beside AM and PM, never inside either. */
  pharmacies: TodayPharmacy[];
  counts: TodayCounts;
};

export type PlannedStop = Omit<TodayStop, "done" | "doneAt">;

/** What the server says for today's hours when no place is saved at all. */
export const NO_PLACE_YET = "No place saved yet";

/**
 * What a row says once it DOES show where the customer is. Read on the owner's walk of 2026-09-30:
 * with the brick, area and town now on the line, ending it "No place saved yet" contradicts the very
 * words beside it — a place IS shown. What is missing is the validated clinic and its hours, and that
 * is what the rep acts on, so the line says so in three words instead of sixteen times in four.
 */
export const NO_HOURS_YET = "No hours yet";

/**
 * Where and when, said ONCE (walk of 2026-09-30): a customer with no place read "No place saved yet ·
 * No place saved yet", because the hours line says the same thing; and a place saved without a name
 * read "No place saved yet", which was untrue. A stop from before `hasPlace` existed is judged by its
 * hours line.
 */
export function stopWhereLine(stop: Pick<TodayStop, "hasPlace" | "placeLabel" | "reference" | "todayWindows">, brick: string | null): string {
  const hasPlace = stop.hasPlace ?? stop.todayWindows !== NO_PLACE_YET;
  if (hasPlace) return [stop.placeLabel, brick, stop.todayWindows].filter((part): part is string => Boolean(part)).join(" · ");
  // Not validated yet, so there is no clinic and no hours — but he is still on the day, and the day
  // has to read as a route (owner, 2026-09-30: "list all drs of today with timing and location"). So
  // it says where the sales master has him, and then why there are no hours. The names are the
  // ORGANOGRAM's: iReports360's own area and region words disagree with it on 37 of 39 areas.
  const parts = [brick, stop.reference?.area ?? null, stop.reference?.address ?? null].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? [...parts, NO_HOURS_YET].join(" · ") : NO_PLACE_YET;
}

export type TodayVisit = {
  customerId: string;
  name: string;
  listType: PhoenixCrmListType;
  /** The pharmacy this visit took feedback from, when it named one. */
  pharmacyName?: string | null;
  /** Cairo clock, already formatted — the server owns the timezone, never the phone. */
  doneAt: string;
  offKind?: UnplannedKind | null;
  statusLabel?: string | null;
};

/**
 * Today's stops, the visits that were not on the plan, and the four counts.
 *
 * `planned` arrives already ordered by the caller (brick, then the receiving hour, then the name);
 * this keeps that order exactly, marking each stop done or not.
 */
export function buildTodayStops(input: { planned: readonly PlannedStop[]; visitsToday: readonly TodayVisit[] }): TodayBuild {
  const visitByCustomer = new Map(input.visitsToday.map((visit) => [visit.customerId, visit]));
  const plannedIds = new Set(input.planned.map((stop) => stop.customerId));

  const stops: TodayStop[] = input.planned.map((stop) => {
    const visit = visitByCustomer.get(stop.customerId) ?? null;
    return { ...stop, done: visit !== null, doneAt: visit?.doneAt ?? null };
  });

  // Beside the day, never inside it. An off-plan visit is real work and he must see he did it, but
  // dropping it into the middle of his route would make the list he is reading change shape.
  const alsoVisited: TodayExtra[] = input.visitsToday
    .filter((visit) => !plannedIds.has(visit.customerId))
    .map((visit) => ({
      customerId: visit.customerId,
      name: visit.name,
      listType: visit.listType,
      doneAt: visit.doneAt,
      offKind: visit.offKind ?? null,
      statusLabel: visit.statusLabel ?? null,
    }));

  // AM · PM · PHARMACIES, three figures APART — the golden rule. Nothing here ever sums or averages
  // them, and a pharmacy is never counted inside AM or PM.
  const pharmacies = todayPharmacies(input.visitsToday);
  const counts: TodayCounts = {
    plannedAm: stops.filter((stop) => stop.listType === "AM").length,
    plannedPm: stops.filter((stop) => stop.listType === "PM").length,
    doneAm: input.visitsToday.filter((visit) => visit.listType === "AM").length,
    donePm: input.visitsToday.filter((visit) => visit.listType === "PM").length,
    donePharmacies: pharmacies.length,
  };

  return { stops, alsoVisited, pharmacies, counts };
}

/** His day in brick clusters, in the order he will drive them. */
/**
 * 🔴 THE BRICK IS NOT SAID TWICE ON ONE ROW (owner, 2026-09-30: "you are duplicating — for example
 * the Bagour, the Bagour is duplicated"). With the brick now in the panel header, an address that
 * OPENS with that same town repeats it on every row: "باجور" over "الباجور، سبك الضحاك" sixteen
 * times. So the leading segment is dropped when it IS the brick, and only then.
 *
 * Segments split on the Arabic comma as well as the Latin one, and the Arabic definite article is
 * ignored in the comparison — "الباجور" and "باجور" are the same town written two ways, which is
 * exactly how this data holds it. A segment that merely CONTAINS the brick ("جروان الباجور") is a
 * different place and is kept. An address that was nothing but the brick leaves no address at all,
 * and the line then says plainly that no place is saved yet.
 */
export function addressWithoutTheBrick(address: string | null, brick: string | null): string | null {
  if (!address || !brick) return address;
  const bare = (value: string) => value.trim().replace(/^ال/, "");
  const parts = address
    .split(/[،,]/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > 0 && bare(parts[0]) === bare(brick)) parts.shift();
  return parts.length > 0 ? parts.join("، ") : null;
}

export function todayByBrick(stops: readonly TodayStop[]) {
  return clusterByBrick(stops, (stop) => stop.brick, "first-appearance");
}

/**
 * The order a day is driven: AM before PM, then the hour the place opens, then the name.
 *
 * The same shape as the planner's own `compareRows`. Brick clustering is applied AFTER this, so the
 * clusters come out in the order the first stop in each one falls.
 */
export function compareTodayStops(left: PlannedStop, right: PlannedStop): number {
  return (
    left.listType.localeCompare(right.listType) ||
    (left.startMinute ?? 9999) - (right.startMinute ?? 9999) ||
    left.name.localeCompare(right.name)
  );
}

/**
 * Why there is nothing to show — a sentence, never an empty screen.
 *
 * Each of these is about HIS OWN WORK, which is what Golden Rule #1 keeps visible: a plan he has not
 * sent, a day the field week does not cover, a day he planned empty.
 */
export function todayEmptyReason(input: {
  status: PhoenixCrmPlanStatus | null;
  isFieldDay: boolean;
  stops: number;
}): string | null {
  if (!input.isFieldDay) return "Today is not a field day.";
  if (input.stops > 0) return null;
  // 🔴 ONE SENTENCE, NEVER TWO. Today shows the APPROVED plan only, so an unapproved plan ALWAYS has
  // zero stops — which means this reason and the plan's own status note always fired together, and the
  // screen carried two boxes saying the same thing. That is the defect the walk of 2026-09-30 had
  // already removed once ("No place saved yet · No place saved yet"); the status note is the fuller
  // answer, so it IS the reason.
  const note = planStatusNote(input.status);
  if (note) return note;
  if (input.status === null) return "No plan has been sent for this week yet. Open Plan to send it.";
  return "Nobody is planned for today.";
}

/**
 * 🔴 TODAY SHOWS THE APPROVED PLAN AND NOTHING ELSE (owner, 2026-09-30, overruling the same day:
 * "what appears in the today tab is the approved plan — the approved plan ONLY. If not approved, show
 * that the plan is still pending approval").
 *
 * The day was briefly shown for a plan in any state, with a button to send it from here. He removed
 * both: Today is the day he has been CLEARED to work, so a plan still waiting on someone is a
 * sentence, never a list of stops, and the sending belongs on Plan where he does it.
 *
 * His ruling also closes the trap that prompted the earlier attempt — Add visit landing on the
 * out-of-plan reason screen and asking him to justify his own plan — by construction rather than by a
 * special case: every customer Today can show is on an APPROVED plan, which is inside the set the
 * server counts as planned, so the route can only reach the form as a planned visit.
 *
 * `returned` is named as itself rather than folded into "pending": nobody is waiting on it, he is.
 */
export function planStatusNote(status: PhoenixCrmPlanStatus | null): string | null {
  if (status === null || status === "approved") return null;
  if (status === "submitted") return "Your plan for this week is still pending approval. Today shows your day once it is approved.";
  if (status === "returned") return "Your plan for this week was sent back to you. Open Plan to change it and send it again.";
  return "Your plan for this week has not been sent yet. Open Plan to send it for approval.";
}

// ── Next up ─────────────────────────────────────────────────────────────────────────────────────
//
// Owner, 2026-09-30: "the best-appearing and easiest CRM". Between two doors the rep's question is
// not "what is on my plan" but "who do I go to NOW". The list answers the first; this answers the
// second, from the one thing the screen already knows about each customer: when he receives.
//
// It is a SUGGESTION drawn from his own plan and his customers' own hours. It moves no figure,
// changes no order on the list beneath it (a visited stop still keeps its place), and nothing about
// it is recorded.

const MINUTES_PER_DAY = 1440;
/** A window with a start time only counts as one hour long — the module's rule everywhere (timings.ts). */
const OPEN_ENDED_MINUTES = 60;

/**
 * Where a not-done stop stands against the clock, best first:
 *
 * - `now` — he receives right now;
 * - `later` — he receives later today (the soonest first);
 * - `no-hours` — no hours are saved for him, so he may well be in;
 * - `passed` — he received today and the hours are over;
 * - `not-today` — he does not receive on this weekday at all.
 */
export type NextStopState = "now" | "later" | "no-hours" | "passed" | "not-today";

const STATE_RANK: Record<NextStopState, number> = { now: 0, later: 1, "no-hours": 2, passed: 3, "not-today": 4 };

export type NextStop = {
  stop: TodayStop;
  state: NextStopState;
  /** One plain line for the card: "Receives now until 8:00 PM", "No hours saved yet". */
  status: string;
};

/**
 * The order the screen draws his day in: the AM section, then the PM section, each clustered by brick
 * in the order he meets the bricks. This is "the plan's own brick order" a tie is broken by.
 */
export function todayRouteOrder(stops: readonly TodayStop[]): TodayStop[] {
  return (["AM", "PM"] as const).flatMap((listType) =>
    todayByBrick(stops.filter((stop) => stop.listType === listType)).flatMap((group) => group.rows),
  );
}

function windowsOf(stop: TodayStop): TodayWindow[] {
  const windows = stop.windows ?? (stop.startMinute === null ? [] : [{ startMinute: stop.startMinute, endMinute: null }]);
  return [...windows].sort((left, right) => left.startMinute - right.startMinute);
}

function windowEndOf(window: TodayWindow): number {
  return window.endMinute ?? window.startMinute + OPEN_ENDED_MINUTES;
}

/** Where one stop stands, with the minute that orders it inside its state (the soonest later start). */
function standingOf(stop: TodayStop, nowMinute: number | null, weekday: number): { state: NextStopState; status: string; sortMinute: number } {
  const windows = windowsOf(stop);
  if (windows.length === 0) {
    return stop.hoursSaved
      ? { state: "not-today", status: `Does not receive on ${PHOENIX_CRM_WEEKDAY_NAMES[weekday] ?? "this day"}`, sortMinute: 0 }
      : { state: "no-hours", status: "No hours saved yet", sortMinute: 0 };
  }
  // No clock to read (the day on the screen is not the day on the clock): the hours, without "now".
  if (nowMinute === null) {
    return { state: "later", status: `Receives from ${formatClockMinute(windows[0].startMinute)}`, sortMinute: windows[0].startMinute };
  }
  const open = windows.find((window) => window.startMinute <= nowMinute && nowMinute < windowEndOf(window));
  if (open) {
    const status =
      open.endMinute === null ? `Receives now, from ${formatClockMinute(open.startMinute)}` : `Receives now until ${formatClockMinute(open.endMinute)}`;
    return { state: "now", status, sortMinute: 0 };
  }
  const later = windows.find((window) => window.startMinute > nowMinute);
  if (later) return { state: "later", status: `Receives from ${formatClockMinute(later.startMinute)}`, sortMinute: later.startMinute };
  return { state: "passed", status: "Today's hours have passed", sortMinute: 0 };
}

/**
 * The customer he should go to next: never one he has already visited today.
 *
 * Best first — one who receives right now; then the one who receives soonest later today; then one
 * with no hours saved; then one whose hours today are over; and a customer who does not receive on
 * this weekday at all goes last. A tie is broken by the plan's own brick order (`todayRouteOrder`).
 *
 * `nowMinute` is minutes past midnight of the VISIT day (`visitDayMinute`): above 1440 between
 * midnight and 02:00, when "today" is still the day that just ended. Null when there is no clock to
 * read, and then no customer is called "now". `weekday` is the visit day's (0 = Sunday), for the
 * sentence "Does not receive on Wednesday".
 *
 * Null when every planned customer is done, or nobody is planned.
 */
export function nextStop(stops: readonly TodayStop[], nowMinute: number | null, weekday: number): NextStop | null {
  const ranked = todayRouteOrder(stops)
    .map((stop, routeIndex) => ({ stop, routeIndex, ...standingOf(stop, nowMinute, weekday) }))
    .filter((entry) => !entry.stop.done)
    .sort(
      (left, right) =>
        STATE_RANK[left.state] - STATE_RANK[right.state] || left.sortMinute - right.sortMinute || left.routeIndex - right.routeIndex,
    );
  const best = ranked[0];
  return best ? { stop: best.stop, state: best.state, status: best.status } : null;
}

const CAIRO_CLOCK = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "2-digit",
  timeZone: "Africa/Cairo",
  year: "numeric",
});

/**
 * Minutes past midnight of the visit day `visitDay`, on the Cairo clock at `nowMs`.
 *
 * The visit day turns over at 02:00 (`VISIT_DAY_CUTOFF_HOURS`), so at 01:30 on Tuesday Monday is still
 * "today" and this answers 1530 — which is how a clinic open until 1:00 AM still reads as receiving.
 * Null when the clock is on neither that day nor its first two hours after: a screen left open
 * overnight must not call anybody "now" on a day that has ended.
 */
export function visitDayMinute(nowMs: number, visitDay: string): number | null {
  if (!Number.isFinite(nowMs)) return null;
  const parts = new Map(CAIRO_CLOCK.formatToParts(new Date(nowMs)).map((part) => [part.type, part.value]));
  const day = `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
  const minute = Number(parts.get("hour")) * 60 + Number(parts.get("minute"));
  if (!Number.isFinite(minute)) return null;
  if (day === visitDay) return minute;
  if (day === addDaysIso(visitDay, 1) && minute < VISIT_DAY_CUTOFF_HOURS * 60) return MINUTES_PER_DAY + minute;
  return null;
}
