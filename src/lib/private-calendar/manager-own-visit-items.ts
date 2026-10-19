// Private calendar: a manager's OWN single visits, which no other reader here can see.
//
// Why this exists: since 2026-10-16 a district manager's own visit is no longer logged under a rep's
// seat — it goes to `phoenix_crm_manager_visits`, a table of its own, deliberately kept out of every
// KPI, coverage, call-rate, frequency and target reader so that his own work never moves a rep's
// figures or a territory's. Nothing in that ruling was about whether he WORKED, but the two questions
// share a source, and when his visit left `phoenix_crm_visits` it left this calendar with it.
//
// Measured on production 2026-10-19: Mina Farouk Nawar Rizkallah and Mohamed Alaa Eleiwa Abozaid each
// logged a day of their own single visits and held NO other record — no row in the visits door, no
// fingerprint punch, no vacation, no business trip. Both would have read as "No Activity Recorded",
// which is exactly the exception the Daily Deductions no-records connector adjudicates.
//
// Owner, the same day, asked in so many words whether his own single visit should count on the Field
// Absence Calendar and in the no-activity engine behind the deduction: **count it on both.**
//
// It adds days and never removes one, it reads his week through the one adapter every outside screen
// reads it through, and it is the SAME reader the deduction suppression map consults
// (src/lib/deductions/proven-worked-days.ts), so the day this calendar shows as worked and the day no
// connector charges are one day by construction.
//
// Read-only. Never mutates CRM, attendance or deduction data.

import { hrIdLookupKeys } from "@/lib/hr-id";
import {
  describeManagerOwnVisitDay,
  loadManagerOwnVisitDays,
  type ManagerOwnVisitDay,
} from "@/lib/phoenix-crm/server/manager-plan-readers";
import { privateCalendarActivityKindLabels } from "@/lib/private-calendar/activity-kinds";
import type { PrivateCalendarItem } from "@/lib/private-calendar/logic";

function normalizedKey(value: string | null | undefined): string | null {
  const keys = hrIdLookupKeys(String(value ?? ""));
  return keys.length > 0 ? keys[0] : null;
}

/** One item per (manager, day) he logged at least one of his own single visits on. */
export function managerOwnVisitItem(day: ManagerOwnVisitDay): PrivateCalendarItem {
  const summary = describeManagerOwnVisitDay(day);
  const id = `manager-own-visit-${day.hrId}|${day.date}`;
  return {
    activityKind: "single_regular",
    approvalImpact:
      "A manager's own single visits are read-only here. They move no rep's figures and no territory's — they only stop a day that was worked being read as a day with no activity.",
    chipLines: [privateCalendarActivityKindLabels.single_regular, summary],
    description:
      "Single visits the manager made alone and logged in Phoenix CRM. They are kept in the manager's own record, which the CRM read door does not carry, so they are shown here for the day not to read as having no activity.",
    detailLines: [`Kind: ${privateCalendarActivityKindLabels.single_regular}`, `Visits: ${day.visits}`],
    employeeDepartmentName: null,
    employeeHrId: day.hrId,
    employeeJobTitle: null,
    employeeLineName: null,
    endDate: day.date,
    exceptionFlags: [],
    id,
    managerName: null,
    employeeName: null,
    severity: "success",
    // `field_visit`, like its siblings: this is his own field work, and the engine's per-employee
    // field-visit suppression must treat it identically.
    source: "field_visit",
    sourceLabel: "Phoenix CRM, the manager's own single visits",
    sourceRecordId: id,
    sourceSystem: "Phoenix CRM",
    sourceTable: "phoenix_crm_manager_visits",
    startDate: day.date,
    status: "performed",
    time: summary,
    title: summary,
    visitCounts: null,
  };
}

/**
 * Best-effort, mirroring its siblings: a failed read returns nothing rather than throwing, because one
 * unreadable source must not take the whole private calendar down. Note the direction — losing this
 * coverage can only ever ADD a "No Activity Recorded" flag, never remove one, and the deduction
 * connectors read the same days themselves through a loader that FAILS CLOSED, so a degraded run here
 * over-reports on a calendar rather than charging anybody.
 */
export async function loadManagerOwnVisitPrivateCalendarItems(
  employeeHrIds: string[],
  start: string,
  end: string,
): Promise<{ items: PrivateCalendarItem[]; ready: boolean }> {
  try {
    const selected = new Set(employeeHrIds.map((value) => normalizedKey(value)).filter((value): value is string => Boolean(value)));
    if (selected.size === 0) return { items: [], ready: true };

    const days = await loadManagerOwnVisitDays({ end, managerHrIds: employeeHrIds, start });
    const items: PrivateCalendarItem[] = [];
    for (const day of days) {
      const key = normalizedKey(day.hrId);
      if (!key || !selected.has(key)) continue;
      items.push(managerOwnVisitItem(day));
    }
    return { items, ready: true };
  } catch {
    return { items: [], ready: false };
  }
}
