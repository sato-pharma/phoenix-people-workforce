/**
 * Phoenix CRM — the district manager's weekly plan, as the screens OUTSIDE the module read it.
 *
 * Owner, 2026-10-16: the district manager's Phoenix CRM week REPLACES his legacy Weekly/Monthly plan. Six
 * screens showed that legacy plan — the Planning Calendar, his landing page's plan card, the Action Center,
 * the private calendar, "Decided for me" and the company calendar — and each one would go quiet the week
 * he switched if it kept reading `employee_plan_headers` alone. This file is the one door they read the
 * new plan through, so the table shapes stay inside the module.
 *
 * 🔴 NO NOTICE SENDER IS IMPORTED HERE, AND NONE MAY BE. These readers are imported by the weekly-planning,
 * action-center and calendar services, which the notification layer reaches in turn; a sender pulled in
 * here closes an import cycle. The one reader that needs the full report (`managerPlanAdherence`) loads it
 * lazily for exactly that reason.
 *
 * 🔴 THE REP NEVER READS ANY OF IT. Every function here is keyed by the MANAGER (or, for the Visit report,
 * by the rep seats a Super Admin or SFE reader already holds) — nothing here answers a rep's own screen.
 */

import { addDaysIso } from "@/lib/crm/dates";
import { dayActivityLabel, isDayActivity } from "@/lib/phoenix-crm/day-activities";
import { isManagerPlanSent, type ManagerHalf, type ManagerPlanStatus, type ManagerSlotKind } from "@/lib/phoenix-crm/manager-plan-rules";
import { chunk, dedupeIds, textOrNull } from "@/lib/phoenix-crm/server/db";
import { loadManagerSlotCustomers, loadManagerSlotRows, MANAGER_PLAN_COLUMNS, managerPlanRowOf, type ManagerPlanRow } from "@/lib/phoenix-crm/server/manager-plan-rows";
import { personKey } from "@/lib/phoenix-crm/scope";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/** Where one of his weeks opens — the Approvals Hub's plan page answers a Phoenix CRM plan id too. */
export function managerPlanHref(planId: string, surface: "portal" | "admin" = "portal"): string {
  return `${surface === "admin" ? "/admin" : "/employee-portals"}/approvals/plan/${encodeURIComponent(planId)}`;
}

/** "Week of 24 Oct" is built by the caller; the plan's own name for a list line. */
export function managerPlanTitle(weekStart: string): string {
  return `Phoenix CRM weekly plan · ${weekStart}`;
}

/**
 * The legacy plan's activity type a half-day reads as, so a screen built on that list keeps its colours
 * and its rules: with a rep is a Double Visit, a single visit is Field, and the seven day activities map
 * to the five the legacy list had (the rest read as an Event).
 */
export type LegacyPlanActivityType = "Double Visit" | "Field" | "Travel" | "Meeting" | "Training" | "Admin" | "Event";

export function managerHalfLegacyType(kind: ManagerSlotKind, activityType: string | null): LegacyPlanActivityType {
  if (kind === "with_rep") return "Double Visit";
  if (kind === "single_visit") return "Field";
  if (activityType === "travel") return "Travel";
  if (activityType === "meeting") return "Meeting";
  if (activityType === "training") return "Training";
  if (activityType === "admin_work") return "Admin";
  return "Event";
}

/** The plan status in the legacy plan's words, for a screen that colours by them. */
export function managerPlanLegacyStatus(status: ManagerPlanStatus): "draft" | "submitted" | "manager_approved" | "final_approved" | "manager_returned" {
  if (status === "submitted") return "submitted";
  if (status === "first_approved") return "manager_approved";
  if (status === "approved") return "final_approved";
  if (status === "returned") return "manager_returned";
  return "draft";
}

/** One half-day of a district manager's week, as every outside screen reads it. */
export type ManagerPlanHalfDay = {
  slotId: string;
  planId: string;
  managerHrId: string;
  managerSeatId: string;
  weekStart: string;
  status: ManagerPlanStatus;
  date: string;
  half: ManagerHalf;
  kind: ManagerSlotKind;
  repSeatId: string | null;
  repHrId: string | null;
  activityType: string | null;
  /** "Training", "Admin work" — null unless the half-day is Admin. */
  activityLabel: string | null;
  areaName: string | null;
  note: string | null;
  customerCount: number;
  legacyType: LegacyPlanActivityType;
  decidedByHrId: string | null;
  firstApproverHrId: string | null;
  isTest: boolean;
};

/** These managers' plans whose week touches [from, to]. Real world unless asked otherwise. */
export async function loadManagerPlansInRange(input: {
  from: string;
  to: string;
  managerHrIds?: ReadonlyArray<string> | null;
  statuses?: ReadonlyArray<ManagerPlanStatus>;
  isTest?: boolean;
}): Promise<ManagerPlanRow[]> {
  const isTest = input.isTest ?? false;
  const read = (part: string[] | null) =>
    fetchAllRowsKeyset<Row>(
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let query: any = getSupabaseAdmin()
          .from("phoenix_crm_manager_plans")
          .select(MANAGER_PLAN_COLUMNS)
          .gte("week_start", addDaysIso(input.from, -6))
          .lte("week_start", input.to)
          .eq("is_test", isTest);
        if (part) query = query.in("manager_hr_id", part);
        if (input.statuses && input.statuses.length > 0) query = query.in("status", [...input.statuses]);
        return query;
      },
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
  const rows: Row[] = [];
  if (input.managerHrIds) {
    const keys = dedupeIds(input.managerHrIds.map((hrId) => personKey(hrId)));
    for (const part of chunk(keys, 100)) rows.push(...(await read(part)));
  } else {
    rows.push(...(await read(null)));
  }
  return rows.map(managerPlanRowOf).filter((plan): plan is ManagerPlanRow => plan !== null);
}

/**
 * The half-days of these managers' weeks inside [from, to], each carrying its plan's status. Only weeks
 * gone for review or approved unless `sentOnly` is false — a draft is an intention nobody was asked about.
 */
export async function loadManagerPlanHalfDays(input: {
  from: string;
  to: string;
  managerHrIds?: ReadonlyArray<string> | null;
  statuses?: ReadonlyArray<ManagerPlanStatus>;
  sentOnly?: boolean;
  isTest?: boolean;
}): Promise<ManagerPlanHalfDay[]> {
  if (input.managerHrIds && input.managerHrIds.length === 0) return [];
  const plans = (await loadManagerPlansInRange(input)).filter((plan) => input.sentOnly === false || isManagerPlanSent(plan.status));
  if (plans.length === 0) return [];
  const planById = new Map(plans.map((plan) => [plan.planId, plan]));
  const slots = (await loadManagerSlotRows(plans.map((plan) => plan.planId))).filter((slot) => slot.date >= input.from && slot.date <= input.to);
  const customers = await loadManagerSlotCustomers(slots.filter((slot) => slot.kind !== "admin").map((slot) => slot.slotId));
  const countBySlot = new Map<string, number>();
  for (const row of customers) countBySlot.set(row.slotId, (countBySlot.get(row.slotId) ?? 0) + 1);
  const out: ManagerPlanHalfDay[] = [];
  for (const slot of slots) {
    const plan = planById.get(slot.planId);
    if (!plan) continue;
    out.push({
      slotId: slot.slotId,
      planId: plan.planId,
      managerHrId: plan.managerHrId,
      managerSeatId: plan.managerSeatId,
      weekStart: plan.weekStart,
      status: plan.status,
      date: slot.date,
      half: slot.half,
      kind: slot.kind,
      repSeatId: slot.repSeatId,
      repHrId: slot.repHrId,
      activityType: slot.activityType,
      activityLabel: slot.kind === "admin" ? (isDayActivity(slot.activityType) ? dayActivityLabel(slot.activityType) : "Admin") : null,
      areaName: slot.areaName,
      note: slot.note,
      customerCount: countBySlot.get(slot.slotId) ?? 0,
      legacyType: managerHalfLegacyType(slot.kind, slot.activityType),
      decidedByHrId: plan.decidedByHrId ?? plan.firstDecidedByHrId,
      firstApproverHrId: plan.firstApproverHrId,
      isTest: plan.isTest,
    });
  }
  return out.sort((left, right) => left.date.localeCompare(right.date) || left.half.localeCompare(right.half));
}

/** A half-day in a line of text: "With Ahmed Ali", "Training", "Single visit · Nasr City". */
export function managerHalfDayText(halfDay: Pick<ManagerPlanHalfDay, "kind" | "activityLabel" | "areaName">, repName: string | null): string {
  if (halfDay.kind === "with_rep") return `With ${repName ?? "a rep"}`;
  if (halfDay.kind === "admin") return halfDay.activityLabel ?? "Admin";
  return `Single visit · ${halfDay.areaName ?? "an area"}`;
}

/**
 * The Visit report generator's "planned double visit" rows from the new plan (2026-10-16), in the shape the
 * old double-visit planner's rows had — `{ id, seat_id, plan_date, half, manager_hr_id }` — so the report
 * reads both, side by side. A half-day "with a rep" on a week gone for review or approved; a day returned to
 * him is not a plan until he sends it again. `seat_id` is the REP's seat.
 */
export async function readManagerWithRepSlotsForReport(
  seatIds: readonly string[],
  window: { from: string; to: string },
  includeTest: boolean,
): Promise<Row[]> {
  const slotRows: Row[] = [];
  // The slot names the rep's seat `rep_seat_id`, so the seat scope is applied here, chunked.
  for (const part of chunk(dedupeIds([...seatIds]), 100)) {
    slotRows.push(
      ...(await fetchAllRowsKeyset<Row>(
        () =>
          getSupabaseAdmin()
            .from("phoenix_crm_manager_plan_slots")
            .select("id, plan_id, rep_seat_id, plan_date, half")
            .eq("kind", "with_rep")
            .in("rep_seat_id", part)
            .gte("plan_date", window.from)
            .lte("plan_date", window.to),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      )),
    );
  }
  if (slotRows.length === 0) return [];
  const plans: ManagerPlanRow[] = [];
  for (const part of chunk(dedupeIds(slotRows.map((row) => textOrNull(row.plan_id))), 100)) {
    const rows = await fetchAllRowsKeyset<Row>(
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let query: any = getSupabaseAdmin().from("phoenix_crm_manager_plans").select(MANAGER_PLAN_COLUMNS).in("id", part);
        if (!includeTest) query = query.eq("is_test", false);
        return query;
      },
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
    for (const row of rows) {
      const plan = managerPlanRowOf(row);
      if (plan) plans.push(plan);
    }
  }
  const planById = new Map(plans.map((plan) => [plan.planId, plan]));
  const out: Row[] = [];
  for (const row of slotRows) {
    const plan = planById.get(String(row.plan_id));
    const date = textOrNull(row.plan_date)?.slice(0, 10) ?? null;
    if (!plan || !date || !isManagerPlanSent(plan.status)) continue;
    out.push({ id: `manager-plan:${String(row.id)}`, seat_id: row.rep_seat_id, plan_date: date, half: row.half, manager_hr_id: plan.managerHrId });
  }
  return out;
}

/** One sent week of his, scored the way the legacy plan card scores a week. */
export type ManagerPlanAdherenceWeek = {
  planId: string;
  weekStart: string;
  weekEnd: string;
  status: ManagerPlanStatus;
  /** Customers whose day has closed: done or not done. */
  checkable: number;
  kept: number;
  scorePct: number | null;
};

/**
 * His last few sent weeks against what happened, newest first — for his landing page's plan card. A
 * customer counts once his day has closed (02:00 Cairo the next morning); a week with no closed customer
 * yet is listed but not measured. Empty for anyone who never sent one.
 */
export async function managerPlanAdherence(
  managerHrId: string | null | undefined,
  day: { cairoToday: string; visitDay: string },
  limit = 4,
): Promise<ManagerPlanAdherenceWeek[]> {
  const key = personKey(managerHrId);
  if (!key) return [];
  const rows = await fetchAllRowsKeyset<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_manager_plans")
        .select(MANAGER_PLAN_COLUMNS)
        .eq("manager_hr_id", key)
        .eq("is_test", false)
        .in("status", ["submitted", "first_approved", "approved"])
        .lte("week_start", day.cairoToday),
    { cursorColumn: "id", cursorOf: (row) => String(row.id) },
  );
  const plans = rows
    .map(managerPlanRowOf)
    .filter((plan): plan is ManagerPlanRow => plan !== null)
    .sort((left, right) => right.weekStart.localeCompare(left.weekStart))
    .slice(0, limit);
  if (plans.length === 0) return [];
  // Loaded here, not at the top: the report reaches the visit and customer services, which send notices.
  const { computeManagerReports } = await import("@/lib/phoenix-crm/server/manager-plan-report");
  const reports = await Promise.all(plans.map((plan) => computeManagerReports(day, [key], plan.weekStart, false, new Map())));
  return plans.map((plan, index) => {
    const summary = reports[index].get(key)?.summary ?? { planned: 0, done: 0, notDone: 0, unplanned: 0 };
    const checkable = summary.done + summary.notDone;
    return {
      planId: plan.planId,
      weekStart: plan.weekStart,
      weekEnd: addDaysIso(plan.weekStart, 5),
      status: plan.status,
      checkable,
      kept: summary.done,
      scorePct: checkable > 0 ? Math.round((summary.done / checkable) * 100) : null,
    };
  });
}

/**
 * Decisions on these managers' weeks since a moment — for "Decided for me": who decided which stage, and
 * when. One line per decided stage; the Administrator acting in place of the holder is a decision too.
 */
export type ManagerPlanDecision = {
  planId: string;
  managerHrId: string;
  weekStart: string;
  stage: "first" | "final";
  /** Whose step it was: his first approver's (RSM/NSM) or the second approver's. */
  approverStage: "first" | "second";
  decision: "approved" | "returned";
  decidedAt: string;
  decidedByHrId: string;
  decidedRole: string | null;
  note: string | null;
};

export async function loadManagerPlanDecisions(managerHrIds: ReadonlyArray<string>, sinceIso: string): Promise<ManagerPlanDecision[]> {
  const keys = dedupeIds(managerHrIds.map((hrId) => personKey(hrId)));
  if (keys.length === 0) return [];
  const out: ManagerPlanDecision[] = [];
  for (const part of chunk(keys, 100)) {
    const rows = await fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_manager_plans")
          .select(MANAGER_PLAN_COLUMNS)
          .in("manager_hr_id", part)
          .eq("is_test", false)
          .or(`first_decided_at.gte.${sinceIso},decided_at.gte.${sinceIso}`),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    );
    for (const raw of rows) {
      const plan = managerPlanRowOf(raw);
      if (!plan) continue;
      if (plan.firstDecidedAt && plan.firstDecidedByHrId && plan.firstDecidedAt >= sinceIso) {
        out.push({
          planId: plan.planId,
          managerHrId: plan.managerHrId,
          weekStart: plan.weekStart,
          stage: "first",
          approverStage: "first",
          decision: "approved",
          decidedAt: plan.firstDecidedAt,
          decidedByHrId: plan.firstDecidedByHrId,
          decidedRole: plan.firstDecidedRole,
          note: plan.firstDecisionNote,
        });
      }
      // A week with one stage stamps both columns with the same approval — one decision, one line.
      const sameAsFirst = plan.status !== "returned" && plan.decidedAt === plan.firstDecidedAt && plan.decidedByHrId === plan.firstDecidedByHrId;
      if (plan.decidedAt && plan.decidedByHrId && plan.decidedAt >= sinceIso && !sameAsFirst) {
        out.push({
          planId: plan.planId,
          managerHrId: plan.managerHrId,
          weekStart: plan.weekStart,
          stage: "final",
          approverStage: !plan.secondApproverHrId ? "first" : plan.status === "returned" ? (plan.returnedStage ?? "second") : "second",
          decision: plan.status === "returned" ? "returned" : "approved",
          decidedAt: plan.decidedAt,
          decidedByHrId: plan.decidedByHrId,
          decidedRole: plan.decidedByRole,
          note: plan.decisionNote,
        });
      }
    }
  }
  return out.sort((left, right) => right.decidedAt.localeCompare(left.decidedAt));
}
