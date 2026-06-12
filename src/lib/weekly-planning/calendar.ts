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
  employeeName: string;
  endDate: string;
  id: string;
  lineName: string | null;
  medicalRepHrId: string | null;
  medicalRepName: string | null;
  notes: string | null;
  planId: string;
  planKind: EmployeePlanKind;
  region: string | null;
  source: "plan";
  startDate: string;
  status: EmployeePlanStatus;
  time: string | null;
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
  lineName: string | null;
  medicalRepHrId: string;
  medicalRepName: string;
  region: string | null;
};

export type PlanningCalendarWorkspace = {
  conflicts: PlanningCalendarConflict[];
  items: PlanningCalendarItem[];
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

export function planningConflictKey(date: string, lineName: string | null, medicalRepHrId: string | null) {
  const line = normalizedPlanningCalendarKey(lineName);
  const rep = normalizedPlanningCalendarKey(medicalRepHrId);
  if (!date || !line || !rep) return null;
  return `${date}|${line}|${rep}`;
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
    const employeeNames = uniqueSorted(group.map((item) => item.employeeName));
    const medicalRepName = cleanText(first.medicalRepName) || cleanText(first.medicalRepHrId) || "the same Medical Rep";
    const medicalRepIdentity = cleanText(first.medicalRepHrId) || cleanText(first.medicalRepName);
    const lineName = cleanText(first.lineName) || "Unassigned line";
    const warning = `${employeeNames.join(", ")} are planned with ${medicalRepName} on the same day in ${lineName}.`;
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

  const employeeNames = uniqueSorted(matches.map((booking) => booking.employeeName));
  const repName = cleanText(input.medicalRepName) || matches[0]?.medicalRepName || "this Medical Rep";
  return `${employeeNames.join(", ")} already planned with ${repName} on this date. This is a warning only; it does not block submission.`;
}
