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

export type SameLinePlanBooking = {
  activityTitle: string;
  area: string | null;
  date: string;
  employeeHrId: string;
  employeeName: string;
  // Nickname-aware display name (nickname when set, else employeeName). Use this
  // for live UI rendering; legal/audit contexts keep using employeeName.
  employeeDisplayName: string;
  lineName: string | null;
  medicalRepHrId: string;
  medicalRepName: string;
  region: string | null;
};

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
  summary: {
    conflictCount: number;
    holidayCount: number;
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
 * Wednesday only; the same evening, admin work is hidden the same way).
 */
const planningCalendarHiddenActivityTypes: ReadonlySet<string> = new Set(["Office", "Admin"]);

export function withoutOfficeDays<T extends { activityType: string }>(items: T[]): T[] {
  return items.filter((item) => !planningCalendarHiddenActivityTypes.has(item.activityType));
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
  return cleanText(storedArea) || cleanText(repAreaName) || cleanText(evidenceAreaName) || cleanText(ownerAreaName) || null;
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
    const warning = conflictLineNames.length > 1
      ? `${employeeNames.join(", ")} are each planned with ${medicalRepName} on the same day (across lines: ${lineName}).`
      : `${employeeNames.join(", ")} are planned with ${medicalRepName} on the same day in ${lineName}.`;
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
  currentEmployeeHrId?: string | null;
  medicalRepHrId?: string | null;
  medicalRepName?: string | null;
  bookings: SameLinePlanBooking[];
}) {
  const repKeys = new Set(
    [input.medicalRepHrId, input.medicalRepName].map(normalizedPlanningCalendarKey).filter(Boolean),
  );
  if (!input.activityDate || repKeys.size === 0) return null;
  const currentHrId = normalizedPlanningCalendarKey(input.currentEmployeeHrId);
  const matches = input.bookings.filter((booking) => {
    if (booking.date !== input.activityDate) return false;
    const bookingRepKeys = [
      normalizedPlanningCalendarKey(booking.medicalRepHrId),
      normalizedPlanningCalendarKey(booking.medicalRepName),
    ].filter(Boolean);
    if (!bookingRepKeys.some((key) => repKeys.has(key))) return false;
    return normalizedPlanningCalendarKey(booking.employeeHrId) !== currentHrId;
  });
  if (matches.length === 0) return null;

  const employeeNames = uniqueSorted(matches.map((booking) => booking.employeeDisplayName));
  const repName = cleanText(input.medicalRepName) || matches[0]?.medicalRepName || "this Medical Rep";
  return `${employeeNames.join(", ")} already planned with ${repName} on this date. This is a warning only; it does not block submission.`;
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
