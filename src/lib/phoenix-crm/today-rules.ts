import { addDaysIso } from "@/lib/crm/dates";
import { clusterByBrick } from "@/lib/phoenix-crm/brick-groups";
import { VISIT_DAY_CUTOFF_HOURS } from "@/lib/phoenix-crm/calendar";
import { isPharmacyListType, pharmacyNameKey } from "@/lib/phoenix-crm/pharmacy-call-rules";
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
  /**
   * Google Maps' way to that saved place (owner, 2026-10-02; `directionsUrl` in directions.ts), or
   * null when none is saved with a usable point. Optional for the same reason as the fields above.
   */
  directionsUrl?: string | null;
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
  /**
   * The customers whose visits named it today, in the order he visited them. Never the pharmacy itself:
   * its own visit (owner, 2026-10-03) carries its name too, and is not "a visit that named it".
   */
  fromCustomers: string[];
  /** Cairo clock of the first visit today that named it. */
  firstAt: string;
};

export type TodayCounts = {
  plannedAm: number;
  plannedPm: number;
  /**
   * 🔴 PLANNED STOPS DONE — never every visit logged today, which is what this counted until
   * 2026-10-02. The chip reads "AM 3 of 2": a denominator from the plan and a numerator from the
   * whole day. One visit off the plan and the chip turns GREEN with a planned stop still undone, so
   * the one figure on his landing page that says whether his day is finished said yes while it was
   * not. `team-today.ts` has always kept the two apart for his managers ("a visit off the plan counts
   * in logged and never inflates the plan's figure"); this is the same rule on his own screen.
   */
  doneAm: number;
  donePm: number;
  /**
   * The visits today that were NOT on the plan — out of plan and out of list, approved or still
   * waiting. Counted APART and never added into doneAm or donePm: it is real work he must see he
   * did, and it is not progress through the day he planned.
   */
  extraAm: number;
  extraPm: number;
  /** Distinct pharmacies he took feedback from today. Never added into doneAm or donePm. */
  donePharmacies: number;
};

/**
 * The day's pharmacies, grouped by `pharmacyNameKey` with the most recent spelling as the name, so
 * one pharmacy never reads as two — "ص.الفيومي" on a doctor's visit and the visit to "صيدلية الفيومي"
 * itself are one pharmacy (owner, 2026-10-03: every pharmacy visit carries its own name).
 */
export function todayPharmacies(visitsToday: readonly TodayVisit[]): TodayPharmacy[] {
  const byKey = new Map<string, { name: string; fromCustomers: string[]; firstAt: string }>();
  for (const visit of visitsToday) {
    const name = (visit.pharmacyName ?? "").trim();
    if (!name) continue;
    const key = pharmacyNameKey(name);
    if (!key) continue;
    const from = isPharmacyListType(visit.listType) ? [] : [visit.name];
    const entry = byKey.get(key);
    if (entry) {
      // The most recent spelling wins, exactly as the List's own grouping decides it.
      entry.name = name;
      for (const customer of from) if (!entry.fromCustomers.includes(customer)) entry.fromCustomers.push(customer);
    } else {
      byKey.set(key, { name, fromCustomers: from, firstAt: visit.doneAt });
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
  return stopWhereParts(stop, brick).join(" · ");
}

/**
 * The same line as its PARTS, in order — for a screen that has to keep each part's own direction.
 *
 * 🔴 JOINED INTO ONE STRING, AN ARABIC PLACE SCRAMBLES THE HOURS BESIDE IT. The line takes the
 * direction of its first letter, so "عيادة النور · 9:00 AM – 1:00 PM" is laid out right to left, and
 * the bidi rules then split the clock from its AM: it read "AM – 1:00 PM 9:00 · عيادة النور". Nothing
 * inside the string can prevent that, so the rep's day renders each part in an isolate of its own,
 * and that needs the parts, not the joined line.
 */
export function stopWhereParts(stop: Pick<TodayStop, "hasPlace" | "placeLabel" | "reference" | "todayWindows">, brick: string | null): string[] {
  const hasPlace = stop.hasPlace ?? stop.todayWindows !== NO_PLACE_YET;
  if (hasPlace) return [stop.placeLabel, brick, stop.todayWindows].filter((part): part is string => Boolean(part));
  // Not validated yet, so there is no clinic and no hours — but he is still on the day, and the day
  // has to read as a route (owner, 2026-09-30: "list all drs of today with timing and location"). So
  // it says where the sales master has him, and then why there are no hours. The names are the
  // ORGANOGRAM's: iReports360's own area and region words disagree with it on 37 of 39 areas.
  const parts = [brick, stop.reference?.area ?? null, stop.reference?.address ?? null].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? [...parts, NO_HOURS_YET] : [NO_PLACE_YET];
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
  //
  // 🔴 AND "DONE" IS THE PLAN'S OWN STOPS, never the day's visits: the planned figures are the
  // denominator, so a numerator drawn from a wider set can pass it. See `TodayCounts.doneAm`.
  const pharmacies = todayPharmacies(input.visitsToday);
  const counts: TodayCounts = {
    plannedAm: stops.filter((stop) => stop.listType === "AM").length,
    plannedPm: stops.filter((stop) => stop.listType === "PM").length,
    doneAm: stops.filter((stop) => stop.done && stop.listType === "AM").length,
    donePm: stops.filter((stop) => stop.done && stop.listType === "PM").length,
    extraAm: alsoVisited.filter((visit) => visit.listType === "AM").length,
    extraPm: alsoVisited.filter((visit) => visit.listType === "PM").length,
    donePharmacies: pharmacies.length,
  };

  return { stops, alsoVisited, pharmacies, counts };
}

/**
 * The day's off-plan work, said BESIDE the plan's own chips: "AM 1", "PM 2".
 *
 * It exists because `doneAm` and `donePm` now count the plan's stops only, and the work he did off
 * the plan must not vanish with that correction — it was the whole of what the old chip was adding
 * in. AM and PM stay apart (the golden rule), each left out at zero, and nothing is summed; empty
 * when he went nowhere off plan, and then the panel draws no line at all.
 *
 * Nothing here says whether a visit is approved. That is the Visits module's own line, and this is
 * a count of HIS OWN WORK (Golden Rule #1) — never a verdict on it.
 */
export function alsoTodayParts(counts: Pick<TodayCounts, "extraAm" | "extraPm">): string[] {
  const parts: string[] = [];
  if (counts.extraAm > 0) parts.push(`AM ${counts.extraAm}`);
  if (counts.extraPm > 0) parts.push(`PM ${counts.extraPm}`);
  return parts;
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

/**
 * 🔴 WHY "PLANNED VISIT" HAS NOBODY TO OFFER — THE REAL REASON, NEVER A BARE "NOBODY" (owner,
 * 2026-10-01, out of his own morning: "I submitted the doctors … the doctors in the plan are not
 * appearing and I'm obligatory should enter them as unplanned visits — why").
 *
 * He had SAVED five accounts on Thursday 1 October; what he SENT were the weeks of 3 and 10 October.
 * Thursday 1 October belongs to the field week starting Saturday 26 September, and a week is filed
 * under the month its Saturday falls in — so today's stops sat in September as a DRAFT. A draft offers
 * nobody, by design: the plan must have reached sent or approved BEFORE the visit's `captured_at`,
 * which is what stops a rep dropping a doctor onto today's draft at the door. All of that was right.
 * What was wrong is that Add visit said "Nobody on today's sent plan yet" — the same six words whether
 * he planned nobody at all or planned five people and left them unsent. The screen knew and did not say.
 *
 * So it names the state, the count he has already placed, and where to go. This is HIS OWN WORK, which
 * Golden Rule #1 keeps VISIBLE: it judges nothing, and it adds no step to his day.
 *
 * `saved` is every stop on today's plan row whatever its status; the caller's `offered` count is the
 * SENT ones. The two differ exactly when this sentence is needed.
 */
export function plannedStartEmptyNote(input: { saved: number; status: PhoenixCrmPlanStatus | null }): string {
  const placed = input.saved > 0 ? `${input.saved} planned for today, but ` : "";
  if (input.status === null) return "No plan sent for this week yet. Open Plan to send it.";
  if (input.status === "draft") return `${placed}your plan for this week is still a draft. Open Plan to send it.`;
  if (input.status === "returned") return `${placed}your plan for this week was sent back to you. Open Plan to send it again.`;
  // Sent or approved with nobody on today: he planned the day empty, which is an answer in itself.
  return "Nobody on today's sent plan yet.";
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
