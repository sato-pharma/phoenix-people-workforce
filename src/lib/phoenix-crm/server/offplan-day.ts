/**
 * Phoenix CRM — the reads behind the moved day (owner, 2026-10-02: "Moved-day reason pre-filled").
 * The rules are offplan-day.ts; nothing here decides anything, and nothing here writes.
 *
 *   - `loadPlannedOtherDays` is the visit form's: for each customer on the rep's list, the OTHER days
 *     of this field week on which he stands on the rep's SENT plan and has not been seen yet. When the
 *     rep picks Out of plan for one of them, the reason box fills itself from it. Read as the plan
 *     stands now, because the form is being filled now.
 *
 *   - `loadMovedFromDays` is the Team tab's: for each off-plan visit waiting for a decision, the days of
 *     its field week on which its customer stood on the sent plan AS OF THE VISIT'S OWN captured_at —
 *     the plan's events say how it stood then, and its items (or the copy its send kept) say who was on
 *     it. The approver reads the plan itself, never what the rep typed.
 *
 * No database change: both are reads of the plan, its items, its events, its edit requests and the
 * territory's visits, batched by territory — never one query per visit.
 */

import { fieldWeekStart, isIsoDay } from "@/lib/phoenix-crm/calendar";
import {
  movedFromDays,
  parseSentCopy,
  plannedDaysAt,
  sentCopyNeeded,
  sentDaysOfWeek,
  type PlanEventFact,
  type PlanItemFact,
} from "@/lib/phoenix-crm/offplan-day";
import { chunk, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadPlanDayFacts, PLAN_DAY_COLUMNS } from "@/lib/phoenix-crm/server/plan-day-status";
import type { PhoenixCrmPlanStatus } from "@/lib/phoenix-crm/types";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";

type Row = Record<string, unknown>;

function planStatusOf(value: unknown): PhoenixCrmPlanStatus | null {
  return value === "draft" || value === "submitted" || value === "approved" || value === "returned" ? value : null;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// ── The visit form: the rep's week as it stands now ─────────────────────────────────────────────

/**
 * Per customer, the other days of this field week on which he stands on the SENT plan and has not been
 * seen yet (offplan-day.ts `movedFromDays`). Customers with no such day are absent.
 *
 * "Sent" is the plan's own day-by-day answer (`loadPlanDayFacts`, then `isPlanDaySent` for each day), so
 * a week returned for one day still offers its other days, and the returned day offers nothing.
 */
export async function loadPlannedOtherDays(seatId: string, isTest: boolean, today: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!isIsoDay(today)) return out;
  const weekStart = fieldWeekStart(today);
  const supabase = getSupabaseAdmin();
  const [planRead, seenRead] = await Promise.all([
    supabase.from("phoenix_crm_plans").select(`id, ${PLAN_DAY_COLUMNS}`).eq("seat_id", seatId).eq("is_test", isTest).eq("week_start", weekStart).maybeSingle(),
    // Who he has already seen this week, before today: a planned day that has passed and on which he
    // DID see the customer is not a day today's visit was moved from.
    supabase
      .from("phoenix_crm_visits")
      .select("customer_id, visit_date")
      .eq("seat_id", seatId)
      .eq("is_test", isTest)
      .gte("visit_date", weekStart)
      .lt("visit_date", today),
  ]);
  throwIfError(planRead.error);
  throwIfError(seenRead.error);
  const plan = planRead.data as Row | null;
  if (!plan) return out;
  const planId = String(plan.id);
  const [facts, itemsRead] = await Promise.all([
    loadPlanDayFacts([plan], isTest),
    supabase.from("phoenix_crm_plan_items").select("plan_date, customer_id").eq("plan_id", planId),
  ]);
  throwIfError(itemsRead.error);
  const stood = facts.get(planId);
  if (!stood) return out;
  const sent = new Set(sentDaysOfWeek(weekStart, stood));
  if (sent.size === 0) return out;

  const planned = new Map<string, string[]>();
  for (const row of (itemsRead.data ?? []) as Row[]) {
    const day = String(row.plan_date);
    if (sent.has(day)) push(planned, String(row.customer_id), day);
  }
  const seen = new Map<string, string[]>();
  for (const row of (seenRead.data ?? []) as Row[]) push(seen, String(row.customer_id), String(row.visit_date));
  for (const [customerId, days] of planned) {
    const moved = movedFromDays({ visitDate: today, plannedDays: days, seenDays: seen.get(customerId) ?? [] });
    if (moved.length > 0) out.set(customerId, moved);
  }
  return out;
}

// ── The Team tab: each waiting visit, as its plan stood when he logged it ───────────────────────

/** What the Team tab's read needs of one off-plan visit. */
export type OffPlanVisitRef = {
  visitId: string;
  seatId: string;
  customerId: string;
  visitDate: string;
  /** The visit's own server-issued time; null when the embed did not come back. */
  capturedAt: string | null;
};

/**
 * Territories per batch. A batch reads its plans, then their events, edit requests, items and the
 * territories' visits beside each other — every one filtered to the batch's customers, and every one
 * paged on its key, so no reply can be cut short at the database's 1,000-row cap.
 */
const SEAT_BATCH = 20;

/** Customers named in one request line: their ids are long, and a waiting queue can grow. */
const CUSTOMER_BATCH = 100;

function eventFact(row: Row): PlanEventFact {
  const returnedDay = textOrNull(row.returned_day);
  return {
    id: Number(row.id),
    eventType: String(row.event_type ?? ""),
    toStatus: planStatusOf(row.to_status),
    createdAt: String(row.created_at ?? ""),
    returnedDay: returnedDay && isIsoDay(returnedDay) ? returnedDay : null,
  };
}

async function movedFromDaysOfBatch(visits: ReadonlyArray<OffPlanVisitRef & { capturedAt: string }>, isTest: boolean): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const supabase = getSupabaseAdmin();
  const seatIds = [...new Set(visits.map((visit) => visit.seatId))];
  const weeks = [...new Set(visits.map((visit) => fieldWeekStart(visit.visitDate)))].sort();
  const customerIds = [...new Set(visits.map((visit) => visit.customerId))];
  const lastDay = visits.map((visit) => visit.visitDate).sort()[visits.length - 1] ?? weeks[0];

  const plansRead = await supabase.from("phoenix_crm_plans").select("id, seat_id, week_start").in("seat_id", seatIds).eq("is_test", isTest).in("week_start", weeks);
  throwIfError(plansRead.error);
  const planOf = new Map<string, string>();
  for (const row of (plansRead.data ?? []) as Row[]) planOf.set(`${row.seat_id}|${row.week_start}`, String(row.id));
  const planIds = [...new Set(planOf.values())];
  if (planIds.length === 0) return out;

  // The customers are named in groups, so no request line grows with a queue that was left to pile up.
  const customerGroups = chunk(customerIds, CUSTOMER_BATCH);
  const [eventRows, requestRows, itemGroups, seenGroups] = await Promise.all([
    // Every event that SETS a status. Saves are left out at the source: a board that saves itself writes
    // dozens of them, and they set nothing (offplan-day.ts `statusEventsUpTo`). The returned day is read
    // out of the details alone — the copy a send kept is fetched below, only where it is needed.
    fetchAllRowsKeyset<Row>(
      () =>
        supabase
          .from("phoenix_crm_plan_events")
          .select("id, plan_id, event_type, to_status, created_at, returned_day:details->>returned_day")
          .in("plan_id", planIds)
          .neq("event_type", "saved")
          .not("to_status", "is", null),
      { cursorColumn: "id", cursorOf: (row) => Number(row.id) },
    ),
    fetchAllRowsKeyset<Row>(
      () => supabase.from("phoenix_crm_plan_edit_requests").select("id, plan_id, hr_acknowledged_at").in("plan_id", planIds).not("hr_acknowledged_at", "is", null),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
    Promise.all(
      customerGroups.map((group) =>
        fetchAllRowsKeyset<Row>(
          () => supabase.from("phoenix_crm_plan_items").select("id, plan_id, plan_date, customer_id").in("plan_id", planIds).in("customer_id", group),
          { cursorColumn: "id", cursorOf: (row) => String(row.id) },
        ),
      ),
    ),
    Promise.all(
      customerGroups.map((group) =>
        fetchAllRowsKeyset<Row>(
          () =>
            supabase
              .from("phoenix_crm_visits")
              .select("id, seat_id, customer_id, visit_date")
              .in("seat_id", seatIds)
              .eq("is_test", isTest)
              .in("customer_id", group)
              .gte("visit_date", weeks[0])
              .lte("visit_date", lastDay),
          { cursorColumn: "id", cursorOf: (row) => String(row.id) },
        ),
      ),
    ),
  ]);
  const itemRows = itemGroups.flat();
  const seenRows = seenGroups.flat();

  const eventsOf = new Map<string, PlanEventFact[]>();
  for (const row of eventRows) push(eventsOf, String(row.plan_id), eventFact(row));
  const acknowledgedOf = new Map<string, string[]>();
  for (const row of requestRows) {
    const stamp = textOrNull(row.hr_acknowledged_at);
    if (stamp) push(acknowledgedOf, String(row.plan_id), stamp);
  }
  const itemsOf = new Map<string, PlanItemFact[]>();
  for (const row of itemRows) push(itemsOf, String(row.plan_id), { date: String(row.plan_date), customerId: String(row.customer_id) });
  const seenOf = new Map<string, string[]>();
  for (const row of seenRows) push(seenOf, `${row.seat_id}|${row.customer_id}`, String(row.visit_date));

  // The copy a send kept is read only for a plan opened to the rep AFTER the visit — the one case in
  // which its items may have moved since he logged it. A copy is a whole week, so this stays rare.
  const planned = visits.map((visit) => {
    const planId = planOf.get(`${visit.seatId}|${fieldWeekStart(visit.visitDate)}`) ?? null;
    const facts = { events: planId ? (eventsOf.get(planId) ?? []) : [], acknowledgedAt: planId ? (acknowledgedOf.get(planId) ?? []) : [], at: visit.capturedAt };
    return { visit, planId, facts, copyId: planId ? sentCopyNeeded(facts) : null };
  });
  const copyIds = [...new Set(planned.flatMap((entry) => (entry.copyId === null ? [] : [entry.copyId])))];
  const copies = new Map<number, PlanItemFact[] | null>();
  // Four chunks at a time, merged in chunk order (2026-10-31, "fix the slowest five pages"): on a wide scope the chunks
  // were read one after another.
  const answers = await mapWithConcurrency(chunk(copyIds, 50), 4, async (batch) =>
    supabase.from("phoenix_crm_plan_events").select("id, items:details->items").in("id", batch),
  );
  for (const { data, error } of answers) {
    throwIfError(error);
    for (const row of (data ?? []) as Row[]) copies.set(Number(row.id), parseSentCopy(row.items));
  }

  for (const { visit, planId, facts, copyId } of planned) {
    if (!planId) continue;
    const plannedDays = plannedDaysAt({
      ...facts,
      weekStart: fieldWeekStart(visit.visitDate),
      customerId: visit.customerId,
      items: itemsOf.get(planId) ?? [],
      sentCopy: copyId === null ? null : (copies.get(copyId) ?? null),
    });
    const moved = movedFromDays({ visitDate: visit.visitDate, plannedDays, seenDays: seenOf.get(`${visit.seatId}|${visit.customerId}`) ?? [] });
    if (moved.length > 0) out.set(visit.visitId, moved);
  }
  return out;
}

/**
 * Per visit id, the days its customer stood on the sent plan for another day of the visit's field week,
 * as the plan stood at the visit's captured_at (and was not seen on, when the day had passed). Visits
 * moved from no day are absent.
 */
export async function loadMovedFromDays(visits: ReadonlyArray<OffPlanVisitRef>, isTest: boolean): Promise<Map<string, string[]>> {
  const usable = visits.flatMap((visit) =>
    isIsoDay(visit.visitDate) && visit.capturedAt !== null && Number.isFinite(Date.parse(visit.capturedAt)) && visit.customerId
      ? [{ ...visit, capturedAt: visit.capturedAt }]
      : [],
  );
  const out = new Map<string, string[]>();
  if (usable.length === 0) return out;
  const seatIds = [...new Set(usable.map((visit) => visit.seatId))];
  const batches = chunk(seatIds, SEAT_BATCH).map((part) => {
    const inPart = new Set(part);
    return usable.filter((visit) => inPart.has(visit.seatId));
  });
  for (const moved of await Promise.all(batches.map((batch) => movedFromDaysOfBatch(batch, isTest)))) {
    for (const [visitId, days] of moved) out.set(visitId, days);
  }
  return out;
}
