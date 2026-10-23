// Private calendar: PHOENIX CRM work the read door does not serve.
//
// Why this exists: `loadFieldVisitPrivateCalendarItems` reads the CRM door, and the door's Phoenix
// branches are inner-joined to the STARTED teams — a team's Phoenix rows appear only from the
// Saturday the Super Admin pressed Start on it. So for every team with no start, a rep's real
// Phoenix CRM day reaches this calendar as NOTHING, and `derivePrivateCalendarExceptions` reports it
// as "No Activity Recorded". That exception is exactly what the Daily Deductions no-records
// connector adjudicates, so the day became a deduction candidate for a day the rep provably worked.
//
// Measured on production 2026-10-12, 7–12 October: 121 Phoenix visits, 6 Medical Reps, 17 person-days
// — every one of those days carrying 0 iReports360 rows, so nothing else could speak for them.
//
// It adds days and never removes one, and it is the SAME source the deduction connectors consult
// (src/lib/crm/phoenix-work-evidence.ts), so the day this calendar shows as worked, the day the gap
// notice stays silent about and the day no connector charges are one day by construction.
//
// Read-only. Never mutates CRM, attendance or deduction data.

import {
  describePhoenixWorkEvidence,
  loadPhoenixWorkEvidenceDays,
  phoenixWorkEvidenceProvesWorkedDay,
  PHOENIX_CRM_VISITS_TABLE,
  type PhoenixWorkEvidenceDay,
} from "@/lib/crm/phoenix-work-evidence";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { privateCalendarActivityKindLabels, type PrivateCalendarActivityKind } from "@/lib/private-calendar/activity-kinds";
import type { PrivateCalendarItem } from "@/lib/private-calendar/logic";

function normalizedKey(value: string | null | undefined): string | null {
  const keys = hrIdLookupKeys(String(value ?? ""));
  return keys.length > 0 ? keys[0] : null;
}

/**
 * A visit day wears the single-regular-visit colour; a day that was only an activity (training, a
 * meeting) wears "Other CRM activity", exactly as the door's own day-activity rows do on a started
 * team's calendar.
 */
export function phoenixWorkEvidenceActivityKind(day: PhoenixWorkEvidenceDay): PrivateCalendarActivityKind {
  return day.visits > 0 ? "single_regular" : "other_crm";
}

/**
 * Drops an evidence entry for a day the door ALREADY carries Phoenix CRM visits on — a started team's day — so the
 * same work never shows twice, once as the door's field or double visit and once as "logged before the team was
 * started" (audit, 2026-10-23: a started rep's day carried both). A day the door carries only iReports360 rows on,
 * or nothing, keeps its entry: there the evidence is the only voice Phoenix CRM has. Pure, keyed (employee, date).
 */
export function withoutDoorCoveredPhoenixWork(
  evidence: readonly PrivateCalendarItem[],
  doorItems: ReadonlyArray<Pick<PrivateCalendarItem, "employeeHrId" | "startDate" | "visitCounts" | "visitRecords">>,
): PrivateCalendarItem[] {
  const covered = new Set<string>();
  for (const item of doorItems) {
    const carriesPhoenix = (item.visitCounts?.phoenix ?? 0) > 0 || (item.visitRecords ?? []).some((record) => record.phoenix === true);
    const key = canonicalHrIdKey(item.employeeHrId);
    if (carriesPhoenix && key) covered.add(`${key}|${item.startDate}`);
  }
  if (covered.size === 0) return [...evidence];
  return evidence.filter((item) => !covered.has(`${canonicalHrIdKey(item.employeeHrId) ?? ""}|${item.startDate}`));
}

/**
 * One item per (employee, day) for Phoenix CRM work the door does not carry.
 *
 * Best-effort, mirroring its two siblings: a failed read returns nothing rather than throwing,
 * because a CRM outage must not take the whole private calendar down. Note the direction — losing
 * this coverage can only ever ADD a "No Activity Recorded" flag, never remove one, and the deduction
 * connectors read the same evidence themselves through a loader that FAILS CLOSED, so a degraded run
 * here over-reports on a calendar rather than charging anybody.
 */
export async function loadPhoenixWorkEvidencePrivateCalendarItems(
  employeeHrIds: string[],
  start: string,
  end: string,
): Promise<{ items: PrivateCalendarItem[]; ready: boolean }> {
  try {
    const selected = new Set(
      employeeHrIds.map((value) => normalizedKey(value)).filter((value): value is string => Boolean(value)),
    );
    if (selected.size === 0) return { items: [], ready: true };

    const days = await loadPhoenixWorkEvidenceDays({ end, start });
    const items: PrivateCalendarItem[] = [];
    for (const day of days) {
      // A day Phoenix only STARTED is not shown as work: pressing Start is not an outcome, and
      // phoenixWorkEvidenceProvesWorkedDay draws that line in one place for every reader.
      if (!phoenixWorkEvidenceProvesWorkedDay(day)) continue;
      const key = normalizedKey(day.hrId);
      if (!key || !selected.has(key)) continue;

      const kind = phoenixWorkEvidenceActivityKind(day);
      const summary = describePhoenixWorkEvidence(day);
      const id = `phoenix-work-${key}|${day.date}`;
      items.push({
        activityKind: kind,
        approvalImpact:
          "Phoenix CRM activity evidence is read-only. It does not mutate attendance, leave, deductions, payroll, or compliance decisions — it only stops a day the employee worked being read as a day with no activity.",
        chipLines: [privateCalendarActivityKindLabels[kind], summary],
        description:
          "Work logged in Phoenix CRM on a team that is still counted from iReports360, so the CRM read door does not carry it. Shown here so the day is not read as having no activity.",
        detailLines: [
          `Kind: ${privateCalendarActivityKindLabels[kind]}`,
          ...(day.visits > 0 ? [`Visits: ${day.visits}`] : []),
          ...(day.dayActivities.length > 0 ? [`Logged: ${day.dayActivities.join(" · ")}`] : []),
          ...(day.dayStarts > 0 ? ["Day started in Phoenix CRM"] : []),
        ],
        employeeDepartmentName: null,
        employeeHrId: day.hrId,
        employeeJobTitle: null,
        employeeLineName: null,
        employeeName: null,
        endDate: day.date,
        exceptionFlags: [],
        id,
        managerName: null,
        severity: "success",
        // `field_visit`, like its siblings: this is the employee's own field work, and the engine's
        // per-employee field-visit suppression must treat it identically.
        source: "field_visit",
        sourceLabel: "Phoenix CRM, logged before the team was started",
        sourceRecordId: id,
        sourceSystem: "Phoenix CRM",
        sourceTable: PHOENIX_CRM_VISITS_TABLE,
        startDate: day.date,
        status: "performed",
        time: summary,
        title: summary,
        visitCounts: null,
      });
    }
    return { items, ready: true };
  } catch {
    return { items: [], ready: false };
  }
}
