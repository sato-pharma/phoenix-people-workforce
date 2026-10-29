/**
 * OUTSTATION TRIPS ON THE PRIVATE CALENDAR — owner, 2026-10-29: *"There is an expense recorded in Phoenix
 * for 21 : 22 October / this is ahmed sharaf if their is an expense it must automatic appeared in his
 * private calendar"*.
 *
 * The deductions engine has read trip days since 2026-10-12 (`src/lib/outstation/trip-work-evidence.ts`),
 * and spares the day of any trip not rejected, cancelled or withdrawn. The calendar read neither trip
 * table, so the same day showed "No Activity Recorded" to the employee while deductions had already
 * cleared it. This loader puts the calendar on that same reading: one item per person per trip day,
 * built from the very same fold, so the two can never disagree about which states count.
 *
 * Best-effort, like every other calendar source: a failed read answers `ready: false` (the screen then
 * says the source could not be read) and never throws the whole month away.
 */

import { hrIdLookupKeys } from "@/lib/hr-id";
import {
  describeOutstationTripDay,
  loadOutstationTripDays,
  OUTSTATION_EXPENSE_REQUESTS_TABLE,
  OUTSTATION_EXPENSES_TABLE,
  type OutstationTripDay,
} from "@/lib/outstation/trip-work-evidence.ts";
import { privateCalendarHrIdKey, privateCalendarSourceLabels, type PrivateCalendarItem } from "@/lib/private-calendar/logic";

function statusLabel(status: string) {
  const text = status.trim();
  if (text.toLowerCase() === "submitted") return "Submitted, awaiting its decision";
  return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1).replace(/_/g, " ") : "Recorded";
}

/** One trip day as a calendar item. Pure, so the shape is pinned by a test with no database. */
export function mapOutstationTripDayToPrivateCalendarItem(day: OutstationTripDay): PrivateCalendarItem {
  const pending = day.status.trim().toLowerCase() === "submitted";
  const detailLines = [describeOutstationTripDay(day)];
  if (day.destination) detailLines.push(`Where: ${day.destination}`);
  detailLines.push(`Claim status: ${statusLabel(day.status)}`);
  return {
    activityKind: "outstation",
    approvalImpact: pending
      ? "An outstation trip claimed in Phoenix Expenses covers this day while its claim waits for a decision; a rejected claim stops covering it."
      : "An outstation trip claimed in Phoenix Expenses covers this day.",
    chipLines: ["Outstation trip", ...(pending ? ["Claim pending"] : [])],
    description: null,
    detailLines,
    employeeDepartmentName: null,
    employeeHrId: day.hrId,
    employeeJobTitle: null,
    employeeLineName: null,
    employeeName: null,
    endDate: day.date,
    exceptionFlags: [],
    id: `outstation-${day.source}-${privateCalendarHrIdKey(day.hrId)}-${day.date}`,
    managerName: null,
    severity: "success",
    source: "outstation",
    sourceLabel: privateCalendarSourceLabels.outstation,
    sourceRecordId: null,
    sourceSystem: "Phoenix Expenses",
    sourceTable: day.source === "request" ? OUTSTATION_EXPENSE_REQUESTS_TABLE : OUTSTATION_EXPENSES_TABLE,
    startDate: day.date,
    status: statusLabel(day.status),
    time: "Full day",
    title: day.destination ? `Outstation trip to ${day.destination}` : "Outstation trip",
  };
}

/** Keep only these people's trip days. Pure; matches every spelling of an hr id the trip row may hold. */
export function outstationTripDaysFor(days: readonly OutstationTripDay[], hrIds: readonly string[]): OutstationTripDay[] {
  const wanted = new Set<string>();
  for (const hrId of hrIds) {
    for (const key of hrIdLookupKeys(hrId)) wanted.add(privateCalendarHrIdKey(key));
  }
  wanted.delete("");
  return days.filter((day) => wanted.has(privateCalendarHrIdKey(day.hrId)));
}

export async function loadOutstationTripPrivateCalendarItems(
  hrIds: readonly string[],
  start: string,
  end: string,
): Promise<{ items: PrivateCalendarItem[]; ready: boolean }> {
  if (hrIds.length === 0) return { items: [], ready: true };
  try {
    const days = await loadOutstationTripDays({ end, start });
    return { items: outstationTripDaysFor(days, hrIds).map(mapOutstationTripDayToPrivateCalendarItem), ready: true };
  } catch (error) {
    console.error("[private-calendar] outstation trips could not be read", error);
    return { items: [], ready: false };
  }
}
