/**
 * Phoenix CRM — a district manager's week, planned against what happened (owner, 2026-10-16: "a separate
 * report comparing the district manager's actual versus planned", read by "him rsm dsm sfe nsm admin ceo").
 *
 *   - WITH A REP: a ticked customer is DONE when the rep logged a visit on him that day naming this
 *     manager — the double visit's own rule (`countsAsManagersDoubleVisit`, the manager report's), read
 *     from the same countable visits; a product manager's when the visit names him as its product manager
 *     (`countsAsPlannersVisitWithRep`, owner, 2026-10-17). Ticking a rep is not itself a double visit.
 *   - SINGLE VISIT: DONE when he logged it himself (`phoenix_crm_manager_visits`), planned or not.
 *   - ADMIN: never checkable.
 *   - His unplanned single visits are listed APART and never fill a planned row.
 *   - A single visit in a VACANT area shows where it says its customer is — the address, area and brick
 *     he recorded (`visitPlaceText`, owner, 2026-10-19; every single visit since 2026-10-20).
 *   - Only a SENT week (`isManagerPlanSent`) is judged; a draft or a returned week shows its visits apart
 *     and counts nothing planned.
 *
 * A day closes for its visits at 02:00 Cairo the next morning (`viewer.visitDay`), so until then it reads
 * "Today", never "Not done".
 */

import { addDaysIso } from "@/lib/crm/dates";
import { validationError } from "@/lib/http/api-errors";
import { formatPhoenixLongDate } from "@/lib/i18n/format";
import { fieldWeekStart, repPlanWeek } from "@/lib/phoenix-crm/calendar";
import {
  countManagerOutcomes,
  countsAsPlannersVisitWithRep,
  isManagerPlanSent,
  managerAdminActivityLabel,
  managerCustomerFlagLabel,
  managerEvidenceKey,
  managerOutcome,
  managerOutcomeLabel,
  managerPlanStatusLine,
  managerPlanSummaryText,
  managerSlotKindLabel,
  managerVisitWindow,
  type ManagerCountRow,
  type ManagerHalf,
  type ManagerOutcome,
  type ManagerPlanStatus,
  type ManagerPlanSummary,
  type ManagerSlotKind,
} from "@/lib/phoenix-crm/manager-plan-rules";
import { planCustomerKey } from "@/lib/phoenix-crm/manager-day-plan";
import { personKey } from "@/lib/phoenix-crm/scope";
import { testModeFor, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { chunk, dedupeIds, textOrNull } from "@/lib/phoenix-crm/server/db";
import { managerPlace, managerPlanChoices, managerPlanWriterFor, resolveManagerPlanReader } from "@/lib/phoenix-crm/server/manager-plan-reach";
import {
  loadManagerSlotCustomers,
  loadManagerSlotRows,
  MANAGER_PLAN_COLUMNS,
  managerPlanRowOf,
  type ManagerPlanRow,
} from "@/lib/phoenix-crm/server/manager-plan-rows";
import { loadManagerVisits } from "@/lib/phoenix-crm/server/manager-visits";
import { loadPeopleNames, nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/** Last week, this week and the coming week. */
export function managerReportWeeks(cairoToday: string): string[] {
  const thisWeek = fieldWeekStart(cairoToday);
  return [...new Set([addDaysIso(thisWeek, -7), thisWeek, repPlanWeek(cairoToday)])];
}

function reportWeekName(weekStart: string, cairoToday: string): string {
  const thisWeek = fieldWeekStart(cairoToday);
  if (weekStart === thisWeek) return "This week";
  if (weekStart < thisWeek) return "Last week";
  return "Coming week";
}

export type ManagerReportCustomer = {
  name: string;
  /** `c:<id>` / `m:<id>` — what the day page sets a planned customer against the visit that answers it by. */
  key: string | null;
  own: boolean;
  flagLabel: string | null;
  outcome: ManagerOutcome;
  outcomeLabel: string;
  /** His single visit was in a vacant area: where it says the customer is. Null otherwise. */
  place: string | null;
};

export type ManagerReportHalf = {
  half: ManagerHalf;
  kind: ManagerSlotKind;
  kindLabel: string;
  /** "With Ahmed Ali", "Training", "Single visit · Nasr City". */
  title: string;
  note: string | null;
  customers: ManagerReportCustomer[];
};

export type ManagerReportDay = { date: string; dateText: string; halves: ManagerReportHalf[] };

export type ManagerReportUnplanned = { date: string; dateText: string; name: string; own: boolean; place: string | null };

export type ManagerReport = {
  managerHrId: string;
  status: ManagerPlanStatus | null;
  statusLine: string;
  summary: ManagerPlanSummary;
  summaryText: string;
  days: ManagerReportDay[];
  unplanned: ManagerReportUnplanned[];
};

export type ManagerReportView = {
  isTest: boolean;
  mode: "own" | "pick";
  weekStart: string;
  weeks: Array<{ weekStart: string; name: string }>;
  /**
   * The managers to choose between, each with the week in two numbers — himself first when he plans a week
   * too (`managerPlanChoices`). Null when there is nobody to choose: a district manager reading his own.
   */
  managers: Array<{ hrId: string; name: string; place: string; summaryText: string }> | null;
  manager: { hrId: string; name: string; place: string } | null;
  report: ManagerReport | null;
};

/** The half-days each manager stood with a rep on a visit — "<seat>|<date>|<customer>" keys. */
async function loadWithRepDone(
  managerHrIds: ReadonlyArray<string>,
  seatIds: ReadonlyArray<string>,
  weekStart: string,
  isTest: boolean,
  productManagerHrIds: ReadonlyArray<string> = [],
): Promise<Map<string, Set<string>>> {
  const done = new Map<string, Set<string>>();
  const managers = dedupeIds(managerHrIds);
  if (managers.length === 0 || seatIds.length === 0) return done;
  const productManagers = dedupeIds(productManagerHrIds);
  const weekEnd = managerVisitWindow(weekStart).to;
  const readBy = (column: "manager_hr_id" | "senior_hr_id" | "product_manager_hr_id", part: string[]): Promise<Row[]> => {
    // The product manager's own slot is asked of the managers who plan as one, and not at all when none does.
    const ids = column === "product_manager_hr_id" ? productManagers : managers;
    if (ids.length === 0) return Promise.resolve([]);
    return fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_countable_visits")
          .select("id, seat_id, customer_id, visit_date, kind, manager_hr_id, senior_hr_id, product_manager_hr_id")
          .in("seat_id", part)
          .eq("is_test", isTest)
          .gte("visit_date", weekStart)
          .lte("visit_date", weekEnd)
          .in(column, ids),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
  };
  for (const part of chunk(dedupeIds(seatIds), 100)) {
    // A product manager is on a visit in its own slot (owner, 2026-10-17), so it is read too.
    const [asManager, asSenior, asProductManager] = await Promise.all([
      readBy("manager_hr_id", part),
      readBy("senior_hr_id", part),
      readBy("product_manager_hr_id", part),
    ]);
    for (const row of [...asManager, ...asSenior, ...asProductManager]) {
      const seatId = textOrNull(row.seat_id);
      const customerId = textOrNull(row.customer_id);
      const date = textOrNull(row.visit_date)?.slice(0, 10) ?? null;
      if (!seatId || !customerId || !date) continue;
      const visit = { kind: row.kind, managerHrId: row.manager_hr_id, seniorHrId: row.senior_hr_id, productManagerHrId: row.product_manager_hr_id };
      for (const manager of managers) {
        if (!countsAsPlannersVisitWithRep(visit, manager)) continue;
        const keys = done.get(manager) ?? new Set<string>();
        keys.add(`${seatId}|${date}|${customerId}`);
        done.set(manager, keys);
      }
    }
  }
  return done;
}

/** The reports of these managers for one week, each computed the same way. */
export async function computeManagerReports(
  viewer: Pick<PhoenixCrmViewer, "cairoToday" | "visitDay">,
  managerHrIds: ReadonlyArray<string>,
  weekStart: string,
  isTest: boolean,
  names: PeopleNames,
): Promise<Map<string, ManagerReport>> {
  const managers = dedupeIds(managerHrIds);
  const reports = new Map<string, ManagerReport>();
  if (managers.length === 0) return reports;
  const planRows: ManagerPlanRow[] = [];
  for (const part of chunk(managers, 100)) {
    const rows = await fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_manager_plans")
          .select(MANAGER_PLAN_COLUMNS)
          .in("manager_hr_id", part)
          .eq("week_start", weekStart)
          .eq("is_test", isTest),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
    for (const row of rows) {
      const plan = managerPlanRowOf(row);
      if (plan) planRows.push(plan);
    }
  }
  const planOf = new Map(planRows.map((plan) => [plan.managerHrId, plan]));
  const managerOfPlan = new Map(planRows.map((plan) => [plan.planId, plan.managerHrId]));
  // 🔴 ONLY A WEEK HE SENT IS A PLAN TO JUDGE: a draft, or a week returned to him, is still his to change,
  // so its half-days are neither planned nor missed (every outside reader's rule, `isManagerPlanSent`).
  // The visits he logged that week are still shown — apart, with the unplanned ones.
  const slots = await loadManagerSlotRows(planRows.filter((plan) => isManagerPlanSent(plan.status)).map((plan) => plan.planId));
  const [slotCustomers, visits, withRepDone] = await Promise.all([
    loadManagerSlotCustomers(slots.map((slot) => slot.slotId)),
    loadManagerVisits(managers, managerVisitWindow(weekStart), isTest),
    loadWithRepDone(
      managers,
      slots.flatMap((slot) => (slot.kind === "with_rep" && slot.repSeatId ? [slot.repSeatId] : [])),
      weekStart,
      isTest,
      planRows.filter((plan) => plan.plannerKind === "pm").map((plan) => plan.managerHrId),
    ),
  ]);
  const customersBySlot = new Map<string, typeof slotCustomers>();
  for (const row of slotCustomers) customersBySlot.set(row.slotId, [...(customersBySlot.get(row.slotId) ?? []), row]);
  const visitedBy = new Map<string, Map<string, (typeof visits)[number]>>();
  for (const visit of visits) {
    const keys = visitedBy.get(visit.managerHrId) ?? new Map<string, (typeof visits)[number]>();
    keys.set(`${visit.visitDate}|${visit.customerId ? `c:${visit.customerId}` : `m:${visit.managerCustomerId}`}`, visit);
    visitedBy.set(visit.managerHrId, keys);
  }
  const [repNames, deciderNames] = await Promise.all([
    loadPeopleNames(slots.map((slot) => slot.repHrId)),
    loadPeopleNames(planRows.flatMap((plan) => [plan.firstApproverHrId, plan.secondApproverHrId, plan.decidedByHrId])),
  ]);
  const personName = (hrId: string) => (deciderNames.has(hrId) ? nameOf(deciderNames, hrId) : nameOf(names, hrId));

  // The customer names of his unplanned visits.
  const unplannedRep = visits.filter((visit) => visit.isUnplanned && visit.customerId).map((visit) => String(visit.customerId));
  const unplannedOwn = visits.filter((visit) => visit.isUnplanned && visit.managerCustomerId).map((visit) => String(visit.managerCustomerId));
  const [repCustomerRows, ownCustomerRows] = await Promise.all([
    unplannedRep.length === 0
      ? Promise.resolve([] as Row[])
      : fetchAllRowsKeyset<Row>(() => getSupabaseAdmin().from("phoenix_crm_customers").select("id, name").in("id", dedupeIds(unplannedRep)), {
          cursorColumn: "id",
          cursorOf: (row) => String(row.id),
        }),
    unplannedOwn.length === 0
      ? Promise.resolve([] as Row[])
      : fetchAllRowsKeyset<Row>(() => getSupabaseAdmin().from("phoenix_crm_manager_customers").select("id, name").in("id", dedupeIds(unplannedOwn)), {
          cursorColumn: "id",
          cursorOf: (row) => String(row.id),
        }),
  ]);
  const customerName = new Map([...repCustomerRows, ...ownCustomerRows].map((row) => [String(row.id), textOrNull(row.name) ?? "Customer"]));

  for (const managerHrId of managers) {
    const plan = planOf.get(managerHrId) ?? null;
    const countRows: ManagerCountRow[] = [];
    const daysByDate = new Map<string, ManagerReportHalf[]>();
    const plannedKeys = new Set<string>();
    const mySlots = slots
      .filter((slot) => managerOfPlan.get(slot.planId) === managerHrId)
      .sort((left, right) => left.date.localeCompare(right.date) || left.half.localeCompare(right.half));
    for (const slot of mySlots) {
      const customers = (customersBySlot.get(slot.slotId) ?? []).map((row): ManagerReportCustomer => {
        let done = false;
        let place: string | null = null;
        if (slot.kind === "with_rep" && row.customerId && slot.repSeatId) {
          done = withRepDone.get(managerHrId)?.has(`${slot.repSeatId}|${slot.date}|${row.customerId}`) ?? false;
        } else if (slot.kind === "single_visit") {
          const key = `${slot.date}|${row.customerId ? `c:${row.customerId}` : `m:${row.managerCustomerId}`}`;
          plannedKeys.add(key);
          const visit = visitedBy.get(managerHrId)?.get(key);
          done = visit !== undefined;
          place = visit?.placeText ?? null;
        }
        const outcome = managerOutcome({ kind: slot.kind, date: slot.date, done, cairoToday: viewer.cairoToday, visitDay: viewer.visitDay });
        // Every row is listed; `countManagerOutcomes` decides what it adds to the counts (a customer who has left
        // the list adds nothing, and one visit answers a customer once however many halves he is ticked in).
        countRows.push({
          outcome,
          gone: row.gone,
          evidenceKey: managerEvidenceKey({
            kind: slot.kind,
            repSeatId: slot.repSeatId,
            date: slot.date,
            customerId: row.customerId,
            managerCustomerId: row.managerCustomerId,
          }),
        });
        return {
          key: planCustomerKey(row.customerId, row.managerCustomerId),
          name: row.name,
          own: row.managerCustomerId !== null,
          flagLabel: row.gone ? managerCustomerFlagLabel("dropped") : null,
          outcome,
          outcomeLabel: managerOutcomeLabel(outcome),
          place,
        };
      });
      const activity = managerAdminActivityLabel(slot.activityType) ?? "Admin";
      const title =
        slot.kind === "with_rep"
          ? `With ${slot.repHrId ? nameOf(repNames, slot.repHrId) : "a vacant territory"}`
          : slot.kind === "admin"
            ? activity
            : `Single visit · ${slot.areaName ?? "an area"}`;
      const halves = daysByDate.get(slot.date) ?? [];
      halves.push({ half: slot.half, kind: slot.kind, kindLabel: managerSlotKindLabel(slot.kind), title, note: slot.note, customers });
      daysByDate.set(slot.date, halves);
    }
    const weekSent = isManagerPlanSent(plan?.status ?? null);
    const unplanned = visits
      .filter((visit) => visit.managerHrId === managerHrId && (visit.isUnplanned || !weekSent))
      .filter((visit) => !plannedKeys.has(`${visit.visitDate}|${visit.customerId ? `c:${visit.customerId}` : `m:${visit.managerCustomerId}`}`))
      .map((visit): ManagerReportUnplanned => ({
        date: visit.visitDate,
        dateText: formatPhoenixLongDate(visit.visitDate),
        name: customerName.get(String(visit.customerId ?? visit.managerCustomerId)) ?? "Customer",
        own: visit.managerCustomerId !== null,
        place: visit.placeText,
      }))
      .sort((left, right) => left.date.localeCompare(right.date) || left.name.localeCompare(right.name));
    const summary: ManagerPlanSummary = { ...countManagerOutcomes(countRows), unplanned: unplanned.length };
    reports.set(managerHrId, {
      managerHrId,
      status: plan?.status ?? null,
      statusLine: managerPlanStatusLine({
        status: plan?.status ?? null,
        managerName: nameOf(names, managerHrId),
        firstName: plan?.firstApproverHrId ? personName(plan.firstApproverHrId) : null,
        secondName: plan?.secondApproverHrId ? personName(plan.secondApproverHrId) : null,
        deciderName: plan?.decidedByHrId ? personName(plan.decidedByHrId) : null,
        byAdministrator: plan?.decidedByRole === "administrator",
        hrAcknowledged: plan?.hrAcknowledgedAt != null,
      }),
      summary,
      summaryText: managerPlanSummaryText(summary),
      days: [...daysByDate.entries()].map(([date, halves]) => ({ date, dateText: formatPhoenixLongDate(date), halves })),
      unplanned,
    });
  }
  return reports;
}

/** GET: one week of a district manager's plan against what happened — his own, or one a reader picked. */
export async function loadManagerPlanReport(
  viewer: PhoenixCrmViewer,
  raw: { week: unknown; manager: unknown; test: unknown },
): Promise<ManagerReportView> {
  const isTest = testModeFor(viewer, raw.test);
  const reader = resolveManagerPlanReader(viewer, raw.manager);
  const weeks = managerReportWeeks(viewer.cairoToday);
  const asked = typeof raw.week === "string" && raw.week.trim() ? raw.week.trim() : null;
  const weekStart = asked ?? fieldWeekStart(viewer.cairoToday);
  if (!weeks.includes(weekStart)) throw validationError("Choose one of the weeks shown. Reload the page.");

  const choices = managerPlanChoices(viewer, reader);
  const pickIds = (choices ?? []).map((entry) => entry.hrId);
  // He is listed first when he plans a week too.
  const selfHrId = personKey(viewer.hrId);
  const chosen = reader.managerHrId;
  const all = dedupeIds([...pickIds, chosen]);
  const writers = new Map(all.map((hrId) => [hrId, managerPlanWriterFor(viewer, hrId)]));
  const names = await loadPeopleNames(all);
  const reports = await computeManagerReports(viewer, all, weekStart, isTest, names);

  return {
    isTest,
    mode: reader.mode,
    weekStart,
    weeks: weeks.map((week) => ({ weekStart: week, name: reportWeekName(week, viewer.cairoToday) })),
    managers: choices
      ? choices
          .map((entry) => ({
            hrId: entry.hrId,
            name: nameOf(names, entry.hrId),
            place: managerPlace(entry.seat, entry.kind),
            summaryText: reports.get(entry.hrId)?.summaryText ?? managerPlanSummaryText({ planned: 0, done: 0, notDone: 0, unplanned: 0 }),
          }))
          .sort(
            (left, right) =>
              Number(right.hrId === selfHrId) - Number(left.hrId === selfHrId) || left.place.localeCompare(right.place) || left.name.localeCompare(right.name),
          )
      : null,
    manager: chosen
      ? { hrId: chosen, name: nameOf(names, chosen), place: managerPlace(writers.get(chosen)?.seat ?? null, writers.get(chosen)?.kind ?? "dm") }
      : null,
    report: chosen ? (reports.get(personKey(chosen) ?? chosen) ?? null) : null,
  };
}
