import type {
  EmployeePlanActivityType,
  EmployeePlanKind,
  EmployeePlanStatus,
} from "@/lib/weekly-planning/plan-v1";

export const sharedPlanningCalendarStatuses = [
  "submitted",
  "manager_approved",
  "ceo_approved",
  "final_approved",
  "hr_acknowledged",
] as const satisfies readonly EmployeePlanStatus[];

export type PlanningCalendarHolidayItem = {
  description: string | null;
  endDate: string;
  id: string;
  source: "holiday";
  startDate: string;
  title: string;
};

export type PlanningCalendarPlanItem = {
  activityTitle: string;
  activityType: EmployeePlanActivityType;
  area: string | null;
  conflictKey: string | null;
  conflictWarning: string | null;
  employeeHrId: string;
  employeeJobTitle: string | null;
  // Raw legal name (as recorded on the plan header at submission time) — kept
  // for anything that genuinely needs the legal record; UI rendering (planning
  // calendar) uses employeeDisplayName / title instead, both nickname-aware.
  employeeName: string;
  // Nickname-aware short name for compact UI (month-grid cells). Falls back to
  // employeeName when no nickname is set.
  employeeDisplayName: string;
  endDate: string;
  id: string;
  lineName: string | null;
  medicalRepHrId: string | null;
  medicalRepName: string | null;
  // Nickname-aware display name for the double-visit medical rep (nickname when
  // set, else medicalRepName), resolved live against the current employee
  // directory. Falls back to medicalRepName when the rep can't be resolved
  // (e.g. a vacant seat or a rep no longer in the directory).
  medicalRepDisplayName: string | null;
  notes: string | null;
  planId: string;
  planKind: EmployeePlanKind;
  region: string | null;
  source: "plan";
  startDate: string;
  status: EmployeePlanStatus;
  time: string | null;
  /**
   * The manager a district manager picked for a With my manager or product manager half-day (owner,
   * 2026-10-24): it shows on THAT person's calendar whatever the role rules below would hide. Absent or
   * null on every other plan item.
   */
  withHrId?: string | null;
  /**
   * The person's approved leave on this day, drawn from Vacations rather than from any plan (owner,
   * 2026-10-27: "in all her calendars it should syncronize everywhere"). `withApprovedLeave` builds it.
   * Absent on every plan row.
   */
  onLeave?: boolean;
  // Rendered UI label ("Employee - Region - Area"), shown as agenda-list text
  // and a hover tooltip in planning-calendar.tsx — built from
  // employeeDisplayName (nickname-aware), not the raw employeeName.
  title: string;
};

export type PlanningCalendarItem = PlanningCalendarHolidayItem | PlanningCalendarPlanItem;

export type PlanningCalendarConflict = {
  areaNames: string[];
  date: string;
  employeeHrIds: string[];
  employeeNames: string[];
  id: string;
  lineName: string;
  medicalRepHrId: string;
  medicalRepName: string;
  planItemIds: string[];
  regionNames: string[];
  warning: string;
};

// What the Plans form needs to say "already planned with this Medical Rep on this date" - and nothing
// more. The booking never carries the other manager's HR id, line, area, region or activity: the server
// names the manager only when the viewer may already see that manager's plan on the planning calendar.
export type SameLinePlanBooking = {
  date: string;
  medicalRepHrId: string;
  medicalRepName: string;
  // Nickname-aware display name of the manager who booked the rep; null when the viewer may not see
  // that manager's plans, and the warning then says "Another manager".
  plannedByDisplayName: string | null;
};

// The longest window GET /api/weekly-plans/conflicts answers: the form asks for one plan period (a week
// or a month, 31 days at most); six weeks leaves room for a period that straddles a month end.
export const SAME_LINE_BOOKING_MAX_RANGE_DAYS = 42;

/** The reason a start/end pair may not be asked of the conflicts route, or null when it may. */
export function sameLineBookingRangeProblem(start: string, end: string): string | null {
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  const isRealDay = (value: string, ms: number) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
  if (!isRealDay(start, startMs) || !isRealDay(end, endMs) || end < start) {
    return "A valid start and end date are required.";
  }
  const days = Math.round((endMs - startMs) / 86_400_000) + 1;
  if (days > SAME_LINE_BOOKING_MAX_RANGE_DAYS) {
    return `Ask for at most ${SAME_LINE_BOOKING_MAX_RANGE_DAYS} days at a time.`;
  }
  return null;
}

export type PlanningCalendarWorkspace = {
  conflicts: PlanningCalendarConflict[];
  hasMoreHeaders: boolean;
  hasMoreItems: boolean;
  headerLimit: number;
  items: PlanningCalendarItem[];
  itemLimit: number;
  loadedHeaderCount: number;
  loadedItemCount: number;
  month: number;
  schemaReady: boolean;
  /** True when Vacations could not be read, so the screen says leave is missing rather than drawing nobody away. */
  leaveUnavailable?: boolean;
  summary: {
    conflictCount: number;
    holidayCount: number;
    /** Person-days of approved leave drawn this month. */
    leaveCount?: number;
    planCount: number;
    submittedOwnerCount: number;
  };
  viewerLineName: string | null;
  weeks: Array<Array<{ date: string | null; inMonth: boolean }>>;
  year: number;
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

export function normalizedPlanningCalendarKey(value: string | null | undefined) {
  return cleanText(value).toLowerCase();
}

export function activityDisplayLabel(activityType: EmployeePlanActivityType, activityTitle?: string | null) {
  const title = cleanText(activityTitle);
  if (activityType === "Field") return "Single Visit";
  if (activityType === "Other" && title.toLowerCase() === "coaching") return "Coaching";
  return title || activityType;
}

export function planningCalendarTitle(employeeName: string, region: string | null, area: string | null, activityTitle: string) {
  return [
    cleanText(employeeName) || "Unknown employee",
    cleanText(region) || cleanText(activityTitle) || "No region",
    cleanText(area) || "No area",
  ].join(" - ");
}

export function planSlotLabel(startTime: string | null | undefined, endTime: string | null | undefined) {
  const start = cleanText(startTime).slice(0, 5);
  const end = cleanText(endTime).slice(0, 5);
  if (start === "09:00" && end === "13:00") return "AM";
  if (start === "13:00" && end === "17:00") return "PM";
  if (start || end) return [start, end].filter(Boolean).join(" - ");
  return "Full day";
}

/**
 * The Planning Calendar shows where people WORK in the field, so a day (or half-day) planned as
 * "Office" or as "Admin" work is not drawn at all (owner, 2026-10-24: a National Sales Manager
 * planning Sunday and Monday Office, Tuesday Behira 1 and Wednesday Alex Center shows Tuesday and
 * Wednesday only; the same evening, admin work is hidden the same way). A day a planner marked
 * "National Vacation" is hidden too (owner, 2026-10-26): nothing records where he was, so it could
 * only show his home area, and the company calendar already draws the official holiday itself.
 */
const planningCalendarHiddenActivityTypes: ReadonlySet<string> = new Set(["Office", "Admin", "National Vacation"]);

export function withoutOfficeDays<T extends { activityType: string }>(items: T[]): T[] {
  return items.filter((item) => !planningCalendarHiddenActivityTypes.has(item.activityType));
}

function sameHalfDayPlan(left: PlanningCalendarPlanItem, right: PlanningCalendarPlanItem) {
  const same = (a: string | null | undefined, b: string | null | undefined) => normalizedPlanningCalendarKey(a) === normalizedPlanningCalendarKey(b);
  return (
    left.activityType === right.activityType &&
    left.status === right.status &&
    same(left.activityTitle, right.activityTitle) &&
    same(left.region, right.region) &&
    same(left.area, right.area) &&
    same(left.lineName, right.lineName) &&
    same(left.medicalRepHrId, right.medicalRepHrId) &&
    same(left.withHrId, right.withHrId)
  );
}

/**
 * One person with the same plan in the AM and the PM of one day is ONE Full day entry, never two
 * halves (owner, 2026-10-24: "if same employee same day am and pm the same plan area then full day and
 * do not separate in calendar or details"). It runs in the one loader, so the month grid, the agenda,
 * the details table and the Excel export all show it once. Two different halves stay two.
 */
export function mergeFullDayPlanItems<T extends PlanningCalendarPlanItem>(items: T[]): T[] {
  const halves = new Map<string, { am: T[]; pm: T[] }>();
  for (const item of items) {
    if (item.startDate !== item.endDate || (item.time !== "AM" && item.time !== "PM")) continue;
    const key = `${normalizedPlanningCalendarKey(item.employeeHrId)}|${item.startDate}`;
    const day = halves.get(key) ?? { am: [], pm: [] };
    (item.time === "AM" ? day.am : day.pm).push(item);
    halves.set(key, day);
  }
  const merged = new Map<T, T>();
  const dropped = new Set<T>();
  for (const { am, pm } of halves.values()) {
    if (am.length !== 1 || pm.length !== 1 || !sameHalfDayPlan(am[0], pm[0])) continue;
    const notes = [...new Set([am[0].notes, pm[0].notes].map((note) => cleanText(note)).filter(Boolean))].join(" · ");
    merged.set(am[0], { ...am[0], notes: notes || null, time: "Full day" });
    dropped.add(pm[0]);
  }
  return items.filter((item) => !dropped.has(item)).map((item) => merged.get(item) ?? item);
}

/**
 * An item is never drawn with an empty area when something knows it (owner, 2026-10-24: "grab area
 * from the rep name, do not leave it empty", then "check his CRM visits or his expenses, where was
 * he"). The stored area wins; otherwise the rep it is planned WITH (a double visit, or a manager's
 * half-day with a rep); otherwise where he actually was that day (`buildPlaceEvidence`); otherwise
 * the planner's own area.
 */
export function resolvePlanItemArea(
  storedArea: string | null | undefined,
  repAreaName: string | null | undefined,
  ownerAreaName: string | null | undefined,
  evidenceAreaName?: string | null,
): string | null {
  return placeText(storedArea) || placeText(repAreaName) || placeText(evidenceAreaName) || placeText(ownerAreaName) || null;
}

/**
 * The whole country is never a place on the calendar (owner, 2026-10-24: "magdy on 28-10 is showing
 * travelling to egypt"). The National Sales Manager's employee file says region "Egypt" and area
 * "Egypt", so a travel day with no destination stored read "Travelling to Egypt". Such a value is
 * skipped wherever it comes from, and an item that knows nothing better shows "-".
 */
export function isWholeCountryPlace(value: string | null | undefined) {
  return planningGroupKey(value) === "egypt";
}

function placeText(value: string | null | undefined) {
  const text = cleanText(value);
  return text && !isWholeCountryPlace(text) ? text : "";
}

/**
 * The region each area belongs to, read from the active employee directory: the region most of the
 * area's people sit in, and none when two regions tie or only the whole country is known. A half-day
 * planned in an area therefore groups under that area's region, never the planner's own.
 */
export function buildAreaRegionIndex(rows: ReadonlyArray<{ areaName?: string | null; regionName?: string | null }>): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const areaKey = planningGroupKey(placeText(row.areaName));
    const region = placeText(row.regionName);
    if (!areaKey || !region) continue;
    const byRegion = counts.get(areaKey) ?? new Map<string, number>();
    byRegion.set(region, (byRegion.get(region) ?? 0) + 1);
    counts.set(areaKey, byRegion);
  }
  const index = new Map<string, string>();
  for (const [areaKey, byRegion] of counts) {
    const ranked = [...byRegion].sort((left, right) => right[1] - left[1]);
    if (ranked.length === 1 || ranked[0][1] > ranked[1][1]) index.set(areaKey, ranked[0][0]);
  }
  return index;
}

export function regionOfArea(index: Map<string, string>, areaName: string | null | undefined): string | null {
  const key = planningGroupKey(placeText(areaName));
  return (key && index.get(key)) || null;
}

/**
 * The same never-empty rule for the region the calendar groups by (owner, 2026-10-24: "group them by
 * region"): the region typed on the plan wins; otherwise the rep it is planned WITH; otherwise the
 * region of the area the item is in (`buildAreaRegionIndex`); otherwise the planner's own region. A
 * Phoenix CRM manager half-day stores no region at all, so it always resolves through the directory.
 * The whole country ("Egypt") is never a region here (`isWholeCountryPlace`).
 */
export function resolvePlanItemRegion(
  storedRegion: string | null | undefined,
  repRegionName: string | null | undefined,
  ownerRegionName: string | null | undefined,
  areaRegionName?: string | null,
): string | null {
  return placeText(storedRegion) || placeText(repRegionName) || placeText(areaRegionName) || placeText(ownerRegionName) || null;
}

/**
 * The region a plan item's own text names, or null. A Training item stores its FORMAT there ("Zoom",
 * "Physical", "Other" — `normalizeTrainingFormat`), never a place, so it is not a region: the calendar
 * filed "PHYSICAL" as a region band beside Delta 1 and Alex Center (NSM audit, 2026-10-26). A Training
 * day then groups under the region `resolvePlanItemRegion` falls back to.
 */
export function planItemStoredRegion(activityType: string | null | undefined, locationText: string | null | undefined): string | null {
  if (cleanText(activityType) === "Training") return null;
  return cleanText(locationText) || null;
}

/**
 * One group per region however it was typed: a plan says "Delta 1" or "ALEX-BHR" where the employee
 * file says "Delta (1)" or "Alex-BHR", so the key drops case, brackets and punctuation.
 */
export function planningGroupKey(value: string | null | undefined) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[()]/g, " ")
    .replace(/[^a-z0-9؀-ۿ]+/g, " ")
    .trim();
}

const NO_REGION_LABEL = "No region";
const NO_AREA_LABEL = "No area";

function isAllCaps(value: string) {
  return /[A-Z]/.test(value) && value === value.toUpperCase();
}

/** The spelling a group header shows: brackets dropped for a region ("Delta (1)" reads "Delta 1"), and a
 * mixed-case spelling preferred over an all-caps one. */
function groupLabel(spellings: string[], dropBrackets: boolean) {
  const cleaned = spellings.map((spelling) => {
    const text = dropBrackets ? spelling.replace(/[()]/g, " ") : spelling;
    return text.replace(/\s+/g, " ").trim();
  });
  return cleaned.find((spelling) => !isAllCaps(spelling)) ?? cleaned[0];
}

export type PlanningAreaGroup<T> = { items: T[]; key: string; label: string };
export type PlanningRegionGroup<T> = { areas: PlanningAreaGroup<T>[]; items: T[]; key: string; label: string };

function groupBy<T>(items: T[], valueOf: (item: T) => string | null | undefined, dropBrackets: boolean, emptyLabel: string) {
  const groups = new Map<string, { items: T[]; spellings: string[] }>();
  for (const item of items) {
    const key = planningGroupKey(valueOf(item));
    const group = groups.get(key) ?? { items: [], spellings: [] };
    group.items.push(item);
    const spelling = cleanText(valueOf(item));
    if (spelling) group.spellings.push(spelling);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ items: group.items, key, label: key ? groupLabel(group.spellings, dropBrackets) : emptyLabel }))
    .sort((left, right) => {
      if (!left.key !== !right.key) return left.key ? -1 : 1;
      return left.label.localeCompare(right.label, "en", { numeric: true, sensitivity: "base" });
    });
}

/**
 * The month tile and the selected day's details group by region, then by area inside it (owner,
 * 2026-10-24: "in the planning calendar tile group them by region and when press on the tile in the
 * details group them by region the area"). Regions and areas sort by name, "No region" and "No area"
 * last; items keep their order inside a group.
 */
export function groupPlanItemsByRegion<T extends { area: string | null; region: string | null }>(items: T[]): PlanningRegionGroup<T>[] {
  return groupBy(items, (item) => item.region, true, NO_REGION_LABEL).map((region) => ({
    ...region,
    areas: groupBy(region.items, (item) => item.area, false, NO_AREA_LABEL),
  }));
}

export type PlanningTilePerson<T> = { items: T[]; key: string; slots: string | null };

/**
 * The people a month tile draws under one region: each PERSON once (NSM audit, 2026-10-26: the tile
 * printed "Taha Mohamed" twice in one region — his AM and his PM were two different half-days, so
 * `mergeFullDayPlanItems` rightly kept them apart). A person with more than one item reads
 * "AM · PM" beside the name; one item reads as before. Order is the first item's.
 */
export function planningTilePeople<T extends { employeeHrId: string; id: string; time: string | null }>(items: T[]): PlanningTilePerson<T>[] {
  const people = new Map<string, T[]>();
  for (const item of items) {
    const key = normalizedPlanningCalendarKey(item.employeeHrId) || item.id;
    people.set(key, [...(people.get(key) ?? []), item]);
  }
  return [...people.entries()].map(([key, personItems]) => {
    const slots = [...new Set(personItems.map((item) => cleanText(item.time)).filter(Boolean))];
    return { items: personItems, key, slots: personItems.length > 1 && slots.length > 0 ? slots.join(" · ") : null };
  });
}

export type PlaceEvidenceVisit = { areaName: string | null; date: string; hrId: string };
export type PlaceEvidenceClaim = { areaName: string | null; endDate: string; hrId: string; startDate: string };

/** Longest trip the evidence reads day by day; a claim spanning more is not a place on any one day. */
const PLACE_EVIDENCE_MAX_TRIP_DAYS = 31;

export function placeEvidenceKey(hrId: string | null | undefined, date: string | null | undefined) {
  return `${cleanText(hrId).toUpperCase()}|${cleanText(date)}`;
}

function datesBetween(startDate: string, endDate: string): string[] {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return [];
  const days = Math.round((end - start) / 86_400_000) + 1;
  if (days > PLACE_EVIDENCE_MAX_TRIP_DAYS) return [];
  return Array.from({ length: days }, (_, index) => new Date(start + index * 86_400_000).toISOString().slice(0, 10));
}

/**
 * Where a person was on a date, from what happened rather than what was planned: the area of the
 * customers he visited in Phoenix CRM that day (the most visited area when there are several), and
 * otherwise the area on an expense trip that covers the date. A visit outranks a claim: the visit is
 * captured on the spot, the claim is written afterwards. Keyed by `placeEvidenceKey`.
 */
export function buildPlaceEvidence(visits: PlaceEvidenceVisit[], claims: PlaceEvidenceClaim[]): Map<string, string> {
  const evidence = new Map<string, string>();
  const visitCounts = new Map<string, Map<string, number>>();
  for (const visit of visits) {
    const area = cleanText(visit.areaName);
    if (!area || !visit.date || !cleanText(visit.hrId)) continue;
    const key = placeEvidenceKey(visit.hrId, visit.date);
    const counts = visitCounts.get(key) ?? new Map<string, number>();
    counts.set(area, (counts.get(area) ?? 0) + 1);
    visitCounts.set(key, counts);
  }
  for (const [key, counts] of visitCounts) {
    const [top] = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    if (top) evidence.set(key, top[0]);
  }
  for (const claim of claims) {
    const area = cleanText(claim.areaName);
    if (!area || !cleanText(claim.hrId)) continue;
    for (const date of datesBetween(claim.startDate, claim.endDate)) {
      const key = placeEvidenceKey(claim.hrId, date);
      if (!evidence.has(key)) evidence.set(key, area);
    }
  }
  return evidence;
}

export function planningConflictKey(date: string, _lineName: string | null, medicalRepHrId: string | null) {
  const rep = normalizedPlanningCalendarKey(medicalRepHrId);
  if (!date || !rep) return null;
  return `${date}|${rep}`;
}

function uniqueSorted(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map(cleanText).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

export function buildPlanningCalendarConflicts(items: PlanningCalendarPlanItem[]) {
  const groups = new Map<string, PlanningCalendarPlanItem[]>();
  for (const item of items) {
    if (!item.conflictKey) continue;
    groups.set(item.conflictKey, [...(groups.get(item.conflictKey) ?? []), item]);
  }

  const conflicts: PlanningCalendarConflict[] = [];
  for (const [key, group] of groups.entries()) {
    const employeeHrIds = uniqueSorted(group.map((item) => item.employeeHrId));
    if (employeeHrIds.length < 2) continue;

    const first = group[0];
    const employeeNames = uniqueSorted(group.map((item) => item.employeeDisplayName));
    const medicalRepName = cleanText(first.medicalRepDisplayName) || cleanText(first.medicalRepName) || "the same Medical Rep";
    const medicalRepIdentity = cleanText(first.medicalRepHrId) || cleanText(first.medicalRepName);
    const conflictLineNames = uniqueSorted(group.map((item) => item.lineName));
    const lineName = conflictLineNames.length === 1 ? (conflictLineNames[0] || "Unassigned line") : conflictLineNames.join(" / ");
    // Two managers on one rep's day is a Phoenix CRM chain visit — the rep out with their District
    // Manager AND a senior manager on the same visit — not a clash. The note reads as a plain
    // statement of who is out together, never an alarm (owner, 2026-10-24: "show as chain visit,
    // not a warning"). `warning` keeps its internal name; the text it carries no longer warns.
    const warning = conflictLineNames.length > 1
      ? `Chain visit — ${employeeNames.join(", ")} are out with ${medicalRepName} on the same day (across lines: ${lineName}).`
      : `Chain visit — ${employeeNames.join(", ")} are out with ${medicalRepName} on the same day in ${lineName}.`;
    conflicts.push({
      areaNames: uniqueSorted(group.map((item) => item.area)),
      date: first.startDate,
      employeeHrIds,
      employeeNames,
      id: `conflict-${key}`,
      lineName,
      medicalRepHrId: medicalRepIdentity,
      medicalRepName,
      planItemIds: group.map((item) => item.id),
      regionNames: uniqueSorted(group.map((item) => item.region)),
      warning,
    });
  }

  return conflicts.sort((left, right) => `${left.date}-${left.medicalRepName}`.localeCompare(`${right.date}-${right.medicalRepName}`));
}

export function attachPlanningConflictWarnings(items: PlanningCalendarPlanItem[], conflicts: PlanningCalendarConflict[]) {
  const warningByPlanItemId = new Map<string, string>();
  for (const conflict of conflicts) {
    for (const planItemId of conflict.planItemIds) {
      warningByPlanItemId.set(planItemId, conflict.warning);
    }
  }
  return items.map((item) => ({
    ...item,
    conflictWarning: warningByPlanItemId.get(item.id) ?? null,
  }));
}

export function sameLineBookingWarning(input: {
  activityDate: string;
  medicalRepHrId?: string | null;
  medicalRepName?: string | null;
  bookings: SameLinePlanBooking[];
}) {
  const repKeys = new Set(
    [input.medicalRepHrId, input.medicalRepName].map(normalizedPlanningCalendarKey).filter(Boolean),
  );
  if (!input.activityDate || repKeys.size === 0) return null;
  // The server never sends the viewer's own bookings, so every match here is someone else's.
  const matches = input.bookings.filter((booking) => {
    if (booking.date !== input.activityDate) return false;
    const bookingRepKeys = [
      normalizedPlanningCalendarKey(booking.medicalRepHrId),
      normalizedPlanningCalendarKey(booking.medicalRepName),
    ].filter(Boolean);
    return bookingRepKeys.some((key) => repKeys.has(key));
  });
  if (matches.length === 0) return null;

  const named = uniqueSorted(matches.map((booking) => booking.plannedByDisplayName));
  const unnamedCount = matches.filter((booking) => !cleanText(booking.plannedByDisplayName)).length;
  const planners = [...named, ...(unnamedCount > 0 ? ["Another manager"] : [])];
  const repName = cleanText(input.medicalRepName) || matches[0]?.medicalRepName || "this Medical Rep";
  return `${planners.join(", ")} already planned with ${repName} on this date. This is a warning only; it does not block submission.`;
}

// Human-readable label for a plan's approval status — the same wording the
// on-screen planning calendar shows on its chips (planning-calendar.tsx keeps a
// private copy for rendering; this is the exportable source of truth reused by
// the XLSX export). Unknown/blank statuses fall back to the raw value.
const planStatusLabels: Record<string, string> = {
  ceo_approved: "CEO approved",
  final_approved: "Final approved",
  hr_acknowledged: "HR acknowledged",
  manager_approved: "Manager approved",
  submitted: "Submitted",
};

export function planStatusLabel(status: EmployeePlanStatus | string | null | undefined): string {
  const key = cleanText(status);
  return planStatusLabels[key] ?? key;
}

/** "Approved leave" for a leave day, the plan's own status for everything else — screen and export alike. */
export const PLANNING_LEAVE_STATUS_LABEL = "Approved leave";

export function planningItemStatusLabel(item: { onLeave?: boolean; status: EmployeePlanStatus | string | null | undefined }): string {
  return item.onLeave ? PLANNING_LEAVE_STATUS_LABEL : planStatusLabel(item.status);
}

/**
 * Approved leave wins over the plan for the same person and day (owner, 2026-10-27, Rasha Sabry: her
 * plan said Office on Tuesday 20 October, she then took that day off, and no calendar showed it). A
 * plan sent before the leave was filed is never rewritten, so the calendar does the overlay:
 *   - a FULL day of leave hides every plan row of that person on that day — they are not there;
 *   - HALF a day hides nothing (the other half is still worked, `planDayGapText`), only the plan's
 *     own "Vacation" row, which the leave row now stands for;
 *   - the leave rows are added once each.
 * `hrKey` is the caller's HR id normaliser, so "A-8" and "a-8" are one person.
 */
export function withApprovedLeave<T extends PlanningCalendarPlanItem>(
  planItems: T[],
  leaveItems: T[],
  hrKey: (hrId: string) => string = normalizedPlanningCalendarKey,
): T[] {
  const dayKey = (item: T) => `${hrKey(item.employeeHrId)}|${item.startDate}`;
  const fullDays = new Set(leaveItems.filter((item) => item.time === "Full day").map(dayKey));
  const anyLeave = new Set(leaveItems.map(dayKey));
  const kept = planItems.filter((item) => {
    if (item.onLeave) return true;
    const key = dayKey(item);
    if (fullDays.has(key)) return false;
    return !(anyLeave.has(key) && item.activityType === "Vacation");
  });
  return [...kept, ...leaveItems];
}

export function planKindLabel(kind: EmployeePlanKind | string | null | undefined): string {
  const key = cleanText(kind).toLowerCase();
  if (key === "weekly") return "Weekly";
  if (key === "monthly") return "Monthly";
  return cleanText(kind);
}

// Who may export the shared Planning Calendar to XLSX. Owner decision: SFE Manager
// and Super Admin ONLY — deliberately narrower than who can VIEW the calendar (a
// shared, company-wide view many roles open) and narrower than the generic
// weekly_plans:"export" permission action, which today also covers CEO and Finance
// Manager. The server export route enforces this exact check; the calendar pages
// use it only to decide whether to render the Export button (button visibility is
// UX, the route is the boundary).
export function canExportPlanningCalendar(role: string | null | undefined): boolean {
  return role === "Super Admin" || role === "SFE Manager";
}
