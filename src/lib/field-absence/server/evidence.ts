/**
 * Field Absence Calendar — every record the system holds for a person on a day, fused into one set.
 *
 * Built ONLY from readers the system already trusts for "did this person work that day", so this
 * calendar and the deduction paths can never disagree about what counts as a record:
 *
 *   - CRM — `getCrmActivityDayMaps`: the old CRM (iReports360) and the started Phoenix CRM teams
 *     through the visits door, crediting the rep AND both partner slots (a double visit is in the
 *     manager's record too, and a rep who has since left still credits his partner), every working
 *     visit type (-5, -6 and -16 included), the CRM's own leave code -4, and Phoenix work evidence
 *     whether or not the team has been started. Its `fieldVisitMap` and `leaveMap` are both records.
 *   - A departed person's OWN CRM visits — `queryVisits` with `includeResignedAgents`, read only for the
 *     people whose employment status is no longer active. The reader above hides every row a departed
 *     agent filed himself (that exclusion exists so his reused CRM account never credits a stranger),
 *     so without this a rep serving his notice, or a leaver on the days before his last one, read as
 *     "not seen" on days he plainly visited (measured, October 2026: up to 31 of 31 visit days). It is
 *     safe here because a person is judged only while he held the seat and was employed, and those
 *     days were his. Classified by `crmDayKind`, the day reader's own ruling, never a second copy.
 *   - A manager's OWN single visits — `loadManagerOwnVisitDays`, through the manager-plan adapter. Since
 *     16 Oct 2026 a district manager's own visit no longer lands in `phoenix_crm_visits`, so the door
 *     above cannot see it, and a manager who spent the day on his own single visits read here as a man
 *     with no record at all (measured 19 Oct 2026: two district managers, nothing in any other source).
 *     The owner's ruling that day: count it on the calendar AND in the no-activity engine. It answers
 *     "did he work", never how he performed — no KPI, coverage, call-rate or target reader is involved.
 *   - Vacation — `loadFiledLeaveDays`: any request filed and not refused (his "no submit vacation").
 *   - Business trips — `loadOutstationTripDays`: any trip not rejected, every day from start to end.
 *   - Fingerprint punches — `loadEmployeeDayPunchMinutes`, the fingerprint report's own Cairo-day
 *     bucketing. The owner, 2026-10-18, of the National Sales Managers: *"he punched, then this means
 *     that he came to office. Then this working day, then don't show his name."* A field seat holder
 *     who never punches simply has no punches; nothing here maps or enrols anyone on the device.
 *   - National holidays — `loadCallRateHolidays`, which never throws and says when it is incomplete.
 *
 * 🔒 A WEEKLY PLAN IS NEVER A RECORD (owner, 2026-10-12, `.claude/rules/time-off.md`). It proves the
 * day was expected, not that anything happened, so no plan source is read here.
 *
 * Each source is read on its own: one that fails is NAMED in `unreadable` and the calendar is left
 * unjudged, rather than the failure turning every person into an absentee.
 */

import {
  crmDayKind,
  DAY_MAP_VISIT_COLUMNS,
  describeCrmDay,
  getCrmActivityDayMaps,
  type CrmDayVisitRow,
} from "@/lib/attendance/crm-day-maps";
import { loadEmployeeDayPunchMinutes } from "@/lib/attendance/punch-minutes";
import { loadCallRateHolidays } from "@/lib/crm/call-rate-holidays";
import { queryVisits } from "@/lib/crm/reads";
import { canonicalHrIdForDisplay, hrIdLookupKeys } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import { describeOutstationTripDay, loadOutstationTripDays } from "@/lib/outstation/trip-work-evidence";
import { describeManagerOwnVisitDay, loadManagerOwnVisitDays } from "@/lib/phoenix-crm/server/manager-plan-readers";
import { loadFiledLeaveDays } from "@/lib/vacation/approved-leave-days";

import { addSeen, isIsoDay, type FieldAbsenceEvidence, type FieldAbsenceSource } from "../rules";

/** " at 09:14" from a Cairo minute-of-day, or nothing when the minute is unknown. */
function clock(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return "";
  return ` at ${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * The CRM day's label for the screen. The old CRM's own description reads "Regular Visit: <the
 * customer or the rep's comment>", and a free-text comment has no place on a page that names people,
 * so only the visit type before the colon is kept. Phoenix CRM's label is already a count
 * ("Phoenix CRM: 3 visits") and stays whole.
 */
export function crmDayLabel(detail: string | undefined, fallback: string): string {
  if (!detail) return fallback;
  if (detail.startsWith("Phoenix CRM:")) return detail;
  const colon = detail.indexOf(": ");
  return colon > 0 ? `Old CRM: ${detail.slice(0, colon)}` : fallback;
}

/**
 * Each departed person's own CRM days, from rows read with the departed-agent exclusion lifted. A row
 * counts only for its AGENT, and only when that agent is one of `departedHrIds`: his double-visit
 * rows already reach him through `getCrmActivityDayMaps`, and nobody else is credited from here.
 */
export function departedAgentCrmDays(
  rows: readonly CrmDayVisitRow[],
  departedHrIds: readonly string[],
): Array<{ hrId: string; day: string; label: string }> {
  const wanted = new Set(departedHrIds.map((hrId) => canonicalHrIdForDisplay(hrId)).filter((key): key is string => Boolean(key)));
  const byAgent = new Map<string, Map<string, CrmDayVisitRow[]>>();
  for (const row of rows) {
    const hrId = canonicalHrIdForDisplay(row.agent_hr_id);
    const day = (row.visit_date ?? "").slice(0, 10);
    if (!hrId || !wanted.has(hrId) || !isIsoDay(day)) continue;
    const byDay = byAgent.get(hrId) ?? new Map<string, CrmDayVisitRow[]>();
    byDay.set(day, [...(byDay.get(day) ?? []), row]);
    byAgent.set(hrId, byDay);
  }
  const days: Array<{ hrId: string; day: string; label: string }> = [];
  for (const [hrId, byDay] of byAgent) {
    for (const [day, dayRows] of byDay) {
      const kind = crmDayKind(dayRows);
      if (!kind) continue;
      const fallback = kind === "field" ? "CRM visit" : "Leave recorded in the CRM";
      days.push({ day, hrId, label: crmDayLabel(describeCrmDay(dayRows) ?? undefined, fallback) });
    }
  }
  return days;
}

export async function loadFieldAbsenceEvidence(input: {
  hrIds: readonly string[];
  /** The people among `hrIds` whose employment status is no longer active — see the header. */
  departedHrIds?: readonly string[];
  start: string;
  end: string;
}): Promise<FieldAbsenceEvidence> {
  const seen = new Map<string, Map<string, string>>();
  const unreadable: FieldAbsenceSource[] = [];
  if (input.hrIds.length === 0 || input.end < input.start) {
    const holidays = input.end < input.start ? { complete: true, dates: new Set<string>() } : await loadCallRateHolidays(input.start, input.end);
    return { holidays: holidays.dates, holidaysComplete: holidays.complete, seen, unreadable };
  }

  const range = { from: input.start, to: input.end };
  // The vacation table stores HR ids in mixed case and `.in()` is case-sensitive, so every casing of
  // each id is asked for; the answer is folded back onto the canonical key below.
  const leaveIds = [...new Set(input.hrIds.flatMap((hrId) => hrIdLookupKeys(hrId)))];
  const departed = [...new Set(input.departedHrIds ?? [])];

  const [crm, ownVisits, departedCrm, leave, trips, punches, holidays] = await Promise.allSettled([
    getCrmActivityDayMaps({ dateFromIso: input.start, dateToIso: input.end, employeeHrIds: [...input.hrIds] }),
    loadManagerOwnVisitDays({ end: input.end, managerHrIds: [...input.hrIds], start: input.start }),
    departed.length > 0
      ? queryVisits<CrmDayVisitRow>({
          agentHrIds: departed,
          columns: DAY_MAP_VISIT_COLUMNS,
          dateFrom: input.start,
          dateTo: input.end,
          includeResignedAgents: true,
        })
      : Promise.resolve([] as CrmDayVisitRow[]),
    loadFiledLeaveDays(leaveIds, range),
    loadOutstationTripDays({ end: input.end, start: input.start }),
    loadEmployeeDayPunchMinutes({ dateFromIso: input.start, dateToIso: input.end, employeeHrIds: [...input.hrIds] }),
    loadCallRateHolidays(input.start, input.end),
  ]);

  const failed = (source: FieldAbsenceSource, reason: unknown) => {
    if (!unreadable.includes(source)) unreadable.push(source);
    logError("Field Absence Calendar could not read a source", {
      error: reason,
      labels: { event: "field_absence_source_unreadable", source },
    });
  };

  if (crm.status === "fulfilled") {
    const { detailMap, fieldVisitMap, leaveMap } = crm.value;
    for (const [hrId, days] of fieldVisitMap) {
      for (const day of days) addSeen(seen, canonicalHrIdForDisplay(hrId), day, crmDayLabel(detailMap.get(hrId)?.get(day), "CRM visit"));
    }
    for (const [hrId, days] of leaveMap) {
      for (const day of days) addSeen(seen, canonicalHrIdForDisplay(hrId), day, crmDayLabel(detailMap.get(hrId)?.get(day), "Leave recorded in the CRM"));
    }
  } else {
    failed("crm", crm.reason);
  }

  if (ownVisits.status === "fulfilled") {
    for (const day of ownVisits.value) addSeen(seen, canonicalHrIdForDisplay(day.hrId), day.date, describeManagerOwnVisitDay(day));
  } else {
    failed("crm", ownVisits.reason);
  }

  if (departedCrm.status === "fulfilled") {
    for (const day of departedAgentCrmDays(departedCrm.value, departed)) addSeen(seen, day.hrId, day.day, day.label);
  } else {
    failed("crm", departedCrm.reason);
  }

  if (leave.status === "fulfilled") {
    for (const day of leave.value) addSeen(seen, canonicalHrIdForDisplay(day.hrId), day.day, day.typeLabel);
  } else {
    failed("leave", leave.reason);
  }

  if (trips.status === "fulfilled") {
    for (const day of trips.value) addSeen(seen, canonicalHrIdForDisplay(day.hrId), day.date, describeOutstationTripDay(day));
  } else {
    failed("trips", trips.reason);
  }

  if (punches.status === "fulfilled") {
    for (const [hrId, days] of punches.value) {
      for (const [day, punch] of days) {
        if (punch.visiblePunchCount > 0) addSeen(seen, canonicalHrIdForDisplay(hrId), day, `Fingerprint punch${clock(punch.firstPunchMinutes)}`);
      }
    }
  } else {
    failed("punch", punches.reason);
  }

  // `loadCallRateHolidays` never throws; a rejection here would be a bug, and is read as incomplete.
  const holidayLookup = holidays.status === "fulfilled" ? holidays.value : { complete: false, dates: new Set<string>() };

  return { holidays: holidayLookup.dates, holidaysComplete: holidayLookup.complete, seen, unreadable };
}
