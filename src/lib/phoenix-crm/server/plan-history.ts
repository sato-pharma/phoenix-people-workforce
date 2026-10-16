/**
 * Phoenix CRM — last month's iReports360 plan, as a REFERENCE for building the new month.
 *
 * Owner, 2026-09-25: offer "Copy last month" — pre-fill the new month from the rep's own iReports360
 * plan, editable. This reads that old plan and returns it; it never writes back to iReports360, and it
 * places nothing on its own. The rep's "copy" replays these doctors onto the new month's matching
 * weekdays through the ordinary weekly save, so every placement still passes the timings and cap rules.
 *
 * The seat's iReports360 identity comes from the same reference the list uses (phoenix_crm_seat_reference,
 * server/list.ts): its `source_hr_id` is the agent whose plan we read, and its `contact_crm_id → customer_id`
 * is how an old planned doctor becomes a native customer. A doctor planned last month who is not on the
 * seat's current list still shows, by name, but cannot be placed (no native customer to place).
 *
 * The mirror is a scrape and may be absent or empty for reasons unrelated to planning; a missing plan
 * degrades to "no reference", never an error, exactly as every other iReports360 reader here does.
 */

import { getAgentPlanEntriesForWindow } from "@/lib/crm/plan-board";
import { formatPhoenixMonth } from "@/lib/i18n/format";
import { isMonthKey, monthEndOf, monthStartOf, plannableMonths, weekdayOfIsoDay } from "@/lib/phoenix-crm/calendar";
import { parseGrade } from "@/lib/phoenix-crm/entry-rules";
import { doctorListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { readTestFlag, territoryForRead, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadReference } from "@/lib/phoenix-crm/server/list";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import type { PhoenixCrmGrade, PhoenixCrmDoctorListType } from "@/lib/phoenix-crm/types";

/** "2026-09-01" → the first day of the month before it. */
function previousMonthStart(monthStart: string): string {
  const [year, month] = monthStart.slice(0, 7).split("-").map(Number);
  const previous = new Date(Date.UTC(year, month - 2, 1));
  return previous.toISOString().slice(0, 10);
}

export type PlanHistoryEntry = {
  contactCrmId: number;
  /** The native customer this old contact maps to on the seat's current list, or null (cannot place). */
  nativeCustomerId: string | null;
  onNativeList: boolean;
  name: string;
  listType: PhoenixCrmDoctorListType;
  grade: PhoenixCrmGrade | null;
  speciality: string | null;
  /** The weekdays (0 = Sunday … 6 = Saturday) he was planned on last month — what the copy replays. */
  weekdays: number[];
  /** How many days he was planned last month (dated entries), or the monthly frequency if that is all. */
  frequency: number;
};

export type PlanHistoryView = {
  /** The source had a readable plan last month; false degrades the panel to a plain "nothing to copy". */
  available: boolean;
  sourceName: string | null;
  /** The plan belongs to the seat's current rep (not an earlier occupant's carried-over list). */
  sourceIsCurrent: boolean;
  historyMonth: string;
  historyMonthLabel: string;
  entries: PlanHistoryEntry[];
};

export async function loadPlanHistory(
  viewer: PhoenixCrmViewer,
  raw: { seatId: unknown; test: unknown; month: unknown },
): Promise<PlanHistoryView> {
  const { seat, isTest } = territoryForRead(viewer, raw.seatId, readTestFlag(raw.test));
  const months = plannableMonths(viewer.cairoToday);
  const targetMonth = isMonthKey(raw.month) && months.includes(`${raw.month}-01`) ? `${raw.month}-01` : months[0];
  const historyMonth = previousMonthStart(targetMonth);
  const historyStart = monthStartOf(historyMonth);
  const historyEnd = monthEndOf(historyMonth);
  const base: PlanHistoryView = {
    available: false,
    sourceName: null,
    sourceIsCurrent: false,
    historyMonth: historyStart,
    historyMonthLabel: formatPhoenixMonth(historyStart),
    entries: [],
  };

  const reference = await loadReference(seat.seatId, isTest);
  const source = reference[0] ?? null;
  if (!source?.source_hr_id) return base;
  // The source's name and his plan need only his hr id, so they are read together (2026-10-16 speed
  // audit). A failed plan read still fails the panel exactly as before, and a missing mirror still
  // degrades to "no reference".
  const [names, rows] = await Promise.all([
    loadPeopleNames([source.source_hr_id]),
    getAgentPlanEntriesForWindow(source.source_hr_id, historyStart, historyEnd),
  ]);
  base.sourceName = nameOf(names, source.source_hr_id, "") || null;
  base.sourceIsCurrent = source.source_is_current;

  const referenceByContact = new Map(reference.map((row) => [Number(row.contact_crm_id), row]));

  if (rows === null) return base; // mirror unavailable — no reference, not an error

  type Aggregate = { weekdays: Set<number>; dated: number; frequency: number; ampm: string | null; grade: string | null; name: string | null; speciality: string | null };
  const byContact = new Map<number, Aggregate>();
  for (const row of rows) {
    if (row.contact_crm_id == null || row.contact_crm_id === 100000) continue; // 100000 is the catch-all, not a doctor
    const key = Number(row.contact_crm_id);
    const aggregate = byContact.get(key) ?? { weekdays: new Set<number>(), dated: 0, frequency: 0, ampm: row.ampm, grade: row.contact_grade, name: row.contact_name, speciality: row.speciality };
    if (row.plan_date) {
      aggregate.weekdays.add(weekdayOfIsoDay(row.plan_date));
      aggregate.dated += 1;
    } else if (row.plan_frequency && row.plan_frequency > 0) {
      aggregate.frequency = Math.max(aggregate.frequency, row.plan_frequency);
    }
    aggregate.ampm = aggregate.ampm ?? row.ampm;
    aggregate.grade = aggregate.grade ?? row.contact_grade;
    aggregate.name = aggregate.name ?? row.contact_name;
    aggregate.speciality = aggregate.speciality ?? row.speciality;
    byContact.set(key, aggregate);
  }

  const entries: PlanHistoryEntry[] = [];
  for (const [contactCrmId, aggregate] of byContact) {
    const referenceRow = referenceByContact.get(contactCrmId) ?? null;
    // Prefer the native list's own answer for a mapped contact; fall back to the mirror for a doctor
    // planned last month who has since left the seat's list.
    // This is a history of what was PLANNED, and a pharmacy is never planned (owner, 2026-10-02),
    // so one on the seat's list has nothing to show here and is left out rather than filed as PM.
    const listType: PhoenixCrmDoctorListType | null = referenceRow
      ? doctorListType(referenceRow.list_type)
      : aggregate.ampm === "AM"
        ? "AM"
        : "PM";
    if (listType === null) continue;
    entries.push({
      contactCrmId,
      nativeCustomerId: referenceRow?.customer_id ?? null,
      onNativeList: Boolean(referenceRow),
      name: (referenceRow?.name ?? aggregate.name ?? "").trim() || `Contact ${contactCrmId}`,
      listType,
      grade: parseGrade(referenceRow?.grade ?? aggregate.grade),
      speciality: (referenceRow?.speciality ?? aggregate.speciality ?? null) || null,
      weekdays: [...aggregate.weekdays].sort((left, right) => left - right),
      frequency: aggregate.dated > 0 ? aggregate.dated : aggregate.frequency,
    });
  }
  entries.sort((left, right) => left.listType.localeCompare(right.listType) || left.name.localeCompare(right.name));

  return { ...base, available: entries.length > 0, entries };
}
