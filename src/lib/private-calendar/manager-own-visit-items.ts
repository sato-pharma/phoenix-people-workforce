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
// 🔴 THE DAY CARRIES ITS VISITS IN FULL WHEN THE CALLER ASKS (owner, 2026-10-20: the entry said "Visits: 3"
// and nothing else — "I want full details, name, address, brick, type, AM/PM, when, single, double"). The
// detail read is OPT-IN (`details: true`) for the same reason the first one is a count: the company-wide
// pass the Daily Deductions connector adjudicates needs only "did he work", and must stay light. A failed
// detail read leaves the count-only entry, never an unreadable calendar.
//
// 🔴 AND THE DAY COUNTS IN HIS OWN FIGURES (owner, 2026-10-23), AM · PM · Pharmacies apart, by the list of the customer
// he visited — never in a rep's.
//
// Read-only. Never mutates CRM, attendance or deduction data.

import { hrIdLookupKeys } from "@/lib/hr-id";
import type { ManagerDayPlan } from "@/lib/phoenix-crm/manager-day-plan";
import { managerDayFigures, managerDaySummaryLine, managerVisitChipLine, managerVisitLine, type ManagerDayVisit } from "@/lib/phoenix-crm/manager-visit-detail";
import {
  describeManagerOwnVisitDay,
  loadManagerDayPlans,
  loadManagerOwnVisitDays,
  loadManagerOwnVisitDetails,
  type ManagerOwnVisitDay,
} from "@/lib/phoenix-crm/server/manager-plan-readers";
import { privateCalendarActivityKindLabels } from "@/lib/private-calendar/activity-kinds";
import type { PrivateCalendarItem } from "@/lib/private-calendar/logic";
import { personKey } from "@/lib/phoenix-crm/scope";

function normalizedKey(value: string | null | undefined): string | null {
  const keys = hrIdLookupKeys(String(value ?? ""));
  return keys.length > 0 ? keys[0] : null;
}

/**
 * One item per (manager, day) he logged at least one of his own single visits on. With `visits` the entry
 * names every one of them — the count line stays first, so a reader who wanted the number still finds it.
 */
export function managerOwnVisitItem(
  day: ManagerOwnVisitDay,
  visits: readonly ManagerDayVisit[] = [],
  plan: { plan: ManagerDayPlan | null; unread: boolean } = { plan: null, unread: false },
): PrivateCalendarItem {
  const summary = describeManagerOwnVisitDay(day);
  const id = `manager-own-visit-${day.hrId}|${day.date}`;
  const figures = managerDayFigures(visits);
  return {
    activityKind: "single_regular",
    approvalImpact:
      "A manager's own single visits are read-only here. They move no rep's figures and no territory's — they only stop a day that was worked being read as a day with no activity.",
    chipLines: [privateCalendarActivityKindLabels.single_regular, summary, ...visits.map((visit) => managerVisitChipLine(visit))],
    description:
      "Single visits the manager made alone and logged in Phoenix CRM. They are kept in the manager's own record, which the CRM read door does not carry, so they are shown here for the day not to read as having no activity.",
    detailLines: [
      `Kind: ${privateCalendarActivityKindLabels.single_regular}`,
      `Visits: ${day.visits}`,
      ...(visits.length > 0 ? [`Counted: AM ${figures.am} · PM ${figures.pm} · Pharmacies ${figures.pharmacies}, in the manager's own figures only`] : []),
      ...visits.map((visit) => managerVisitLine(visit)),
    ],
    employeeDepartmentName: null,
    employeeHrId: day.hrId,
    employeeJobTitle: null,
    employeeLineName: null,
    endDate: day.date,
    exceptionFlags: [],
    id,
    managerName: null,
    ...(visits.length > 0 ? { managerVisits: [...visits] } : {}),
    ...(visits.length > 0 && plan.plan ? { managerPlan: plan.plan } : {}),
    ...(visits.length > 0 && plan.unread ? { managerPlanUnread: true } : {}),
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
    title: visits.length > 0 ? `${summary}: ${managerDaySummaryLine(figures) || summary}` : summary,
    // 🔴 COUNTED, AND COUNTED APART (owner, 2026-10-23: "any record submitted by himself … must appear … if a manager
    // himself added a visit to a pharmacy, it should be count, but in a different color, and separate"). His own split —
    // AM · PM · Pharmacies by his customer's list — goes into HIS row's figures. It never reaches a rep's: this item is
    // keyed to the manager alone.
    visitCounts: day.split ?? null,
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
  options: { details?: boolean } = {},
): Promise<{ items: PrivateCalendarItem[]; ready: boolean }> {
  try {
    const selected = new Set(employeeHrIds.map((value) => normalizedKey(value)).filter((value): value is string => Boolean(value)));
    if (selected.size === 0) return { items: [], ready: true };

    const days = await loadManagerOwnVisitDays({ end, managerHrIds: employeeHrIds, start });
    const details = options.details && days.length > 0 ? await loadDetailsQuietly(employeeHrIds, start, end) : new Map<string, ManagerDayVisit[]>();
    const plans = options.details && details.size > 0 ? await loadPlansQuietly(employeeHrIds, start, end) : { plans: new Map<string, ManagerDayPlan>(), unread: false };
    const items: PrivateCalendarItem[] = [];
    for (const day of days) {
      const key = normalizedKey(day.hrId);
      if (!key || !selected.has(key)) continue;
      items.push(
        managerOwnVisitItem(day, details.get(`${key}|${day.date}`) ?? [], {
          plan: plans.plans.get(`${personKey(day.hrId)}|${day.date}`) ?? null,
          unread: plans.unread,
        }),
      );
    }
    return { items, ready: true };
  } catch {
    return { items: [], ready: false };
  }
}

/**
 * The visits behind the days, keyed `<manager>|<day>`. Its own failure is swallowed ON PURPOSE and only here:
 * the count above already proves he worked, so a detail read that fails leaves a count-only entry rather than
 * taking the day away — which would be the exact false "No Activity Recorded" this file exists to prevent.
 */
async function loadDetailsQuietly(employeeHrIds: string[], start: string, end: string): Promise<Map<string, ManagerDayVisit[]>> {
  const byDay = new Map<string, ManagerDayVisit[]>();
  try {
    for (const visit of await loadManagerOwnVisitDetails({ end, managerHrIds: employeeHrIds, start })) {
      const key = normalizedKey(visit.managerHrId);
      if (!key) continue;
      const at = `${key}|${visit.date}`;
      const list = byDay.get(at);
      if (list) list.push(visit);
      else byDay.set(at, [visit]);
    }
  } catch {
    return new Map();
  }
  return byDay;
}

/**
 * The plan behind the same days, so the entry can set it beside the visits. Swallowed on purpose and only here, for
 * the reason the detail read is: the count and the visits already prove he worked, so a plan that fails to load
 * says so on the entry (`managerPlanUnread`) and never takes the day away.
 */
async function loadPlansQuietly(employeeHrIds: string[], start: string, end: string): Promise<{ plans: Map<string, ManagerDayPlan>; unread: boolean }> {
  try {
    return { plans: await loadManagerDayPlans({ end, managerHrIds: employeeHrIds, start }), unread: false };
  } catch {
    return { plans: new Map(), unread: true };
  }
}
