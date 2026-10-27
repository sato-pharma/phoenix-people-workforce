import { managerOutcomeLabel, type ManagerHalf, type ManagerOutcome, type ManagerSlotKind } from "@/lib/phoenix-crm/manager-plan-rules";
import type { ManagerDayVisit } from "@/lib/phoenix-crm/manager-visit-detail";

/**
 * Phoenix CRM — a manager's day, the PLAN set against the ACTUAL, one row per planned customer and one per visit
 * that was not planned (owner, 2026-10-20: "show a premium table, plan vs actual vs detail per visit in actual").
 *
 * 🔴 NOTHING HERE DECIDES WHAT WAS DONE. Whether a planned customer was visited is the weekly report's own answer
 *    (`computeManagerReports`, the rule every outside reader of the plan already uses); this file only sets that
 *    answer beside the visit that proves it and keeps the visits nobody planned apart, so the page cannot disagree
 *    with the report. The match is by customer key (`c:<id>` / `m:<id>`), never by name, with the name as the
 *    fallback only when a row carries no key.
 * 🔴 A week that was never SENT is not judged: its rows read "No plan sent", the visits still listed in full.
 *
 * Pure: no I/O, no permissions. A client component may import it as freely as a server read.
 */

/** How the plan keys a customer: `c:<id>` on a rep's list, `m:<id>` on the manager's own. Null when neither is known. */
export function planCustomerKey(customerId: unknown, managerCustomerId: unknown): string | null {
  const customer = String(customerId ?? "").trim();
  if (customer) return `c:${customer}`;
  const own = String(managerCustomerId ?? "").trim();
  return own ? `m:${own}` : null;
}

export type ManagerDayPlanCustomer = {
  name: string;
  key: string | null;
  own: boolean;
  flagLabel: string | null;
  outcome: ManagerOutcome;
  outcomeLabel: string;
  /** A single visit in a vacant area: where its customer is said to be. */
  place: string | null;
};

export type ManagerDayPlanHalf = {
  half: ManagerHalf;
  kind: ManagerSlotKind;
  kindLabel: string;
  /** "With Ahmed Ali", "Training", "Single visit · Nasr City". */
  title: string;
  note: string | null;
  customers: ManagerDayPlanCustomer[];
};

export type ManagerDayPlan = {
  /** The week was sent, so its half-days are judged (`isManagerPlanSent`). */
  sent: boolean;
  statusLine: string;
  halves: ManagerDayPlanHalf[];
};

export type PlanRowOutcome = ManagerOutcome | "unplanned" | "no_plan";

export type PlanVsActualRow = {
  id: string;
  half: ManagerHalf;
  /** What was planned; null for a visit nobody planned. */
  plan: {
    title: string;
    kind: ManagerSlotKind;
    kindLabel: string;
    note: string | null;
    customerName: string | null;
    flagLabel: string | null;
    place: string | null;
  } | null;
  outcome: PlanRowOutcome;
  outcomeLabel: string;
  /** The visit that answers the row, in full; null when nothing was logged for it. */
  actual: ManagerDayVisit | null;
};

export type PlanVsActualSummary = { planned: number; done: number; notDone: number; open: number; unplanned: number };

function nameKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function halfOfVisit(visit: ManagerDayVisit): ManagerHalf {
  if (visit.bucket === "AM" || visit.bucket === "PM") return visit.bucket;
  return visit.loggedHalf ?? "PM";
}

/**
 * A with-a-rep half is answered by a rep's visit, a single-visit half by the manager's own alone, a With my manager half
 * by his own visit logged on it — never the other way round.
 */
function sourceFits(kind: ManagerSlotKind, visit: ManagerDayVisit): boolean {
  if (kind === "with_rep") return visit.source === "ride_along";
  if (kind === "single_visit") return visit.source === "own" && visit.kind !== "with_senior";
  // His own visit logged on the With my manager half-day answers that half's customers (owner, 2026-10-27).
  if (kind === "with_senior") return visit.source === "own" && visit.kind === "with_senior";
  return false;
}

export function buildPlanVsActual(
  plan: ManagerDayPlan | null,
  visits: readonly ManagerDayVisit[],
): { rows: PlanVsActualRow[]; summary: PlanVsActualSummary } {
  const used = new Set<string>();
  const rows: PlanVsActualRow[] = [];
  const summary: PlanVsActualSummary = { planned: 0, done: 0, notDone: 0, open: 0, unplanned: 0 };
  const sent = plan?.sent === true;

  const findVisit = (kind: ManagerSlotKind, customer: ManagerDayPlanCustomer): ManagerDayVisit | null => {
    const byKey = customer.key
      ? visits.find((visit) => !used.has(visit.id) && sourceFits(kind, visit) && visit.customerKey === customer.key)
      : undefined;
    const found =
      byKey ?? (customer.key ? undefined : visits.find((visit) => !used.has(visit.id) && sourceFits(kind, visit) && nameKey(visit.customerName) === nameKey(customer.name)));
    if (found) used.add(found.id);
    return found ?? null;
  };

  const halves = sent && plan ? [...plan.halves].sort((left, right) => left.half.localeCompare(right.half)) : [];
  for (const half of halves) {
    if (half.customers.length === 0) {
      rows.push({
        actual: null,
        half: half.half,
        id: `plan:${half.half}:${half.title}`,
        outcome: "not_checkable",
        outcomeLabel: half.kind === "admin" ? managerOutcomeLabel("not_checkable") : "Nothing ticked",
        plan: { customerName: null, flagLabel: null, kind: half.kind, kindLabel: half.kindLabel, note: half.note, place: null, title: half.title },
      });
      continue;
    }
    half.customers.forEach((customer, index) => {
      const actual = findVisit(half.kind, customer);
      summary.planned += 1;
      if (customer.outcome === "done") summary.done += 1;
      else if (customer.outcome === "not_done") summary.notDone += 1;
      else summary.open += 1;
      rows.push({
        actual,
        half: half.half,
        id: `plan:${half.half}:${half.title}:${customer.key ?? customer.name}:${index}`,
        outcome: customer.outcome,
        outcomeLabel: customer.outcomeLabel,
        plan: {
          customerName: customer.name,
          flagLabel: customer.flagLabel,
          kind: half.kind,
          kindLabel: half.kindLabel,
          note: half.note,
          place: customer.place,
          title: half.title,
        },
      });
    });
  }

  for (const visit of visits) {
    if (used.has(visit.id)) continue;
    // 🔴 A REP'S OWN VISIT CARRIES ITS OWN ANSWER (owner, 2026-10-21: every visit in full, "exactly as Mina Farouk").
    //    His week is not the manager's plan, so nothing above can match it; the row says what the visit itself
    //    recorded — on his plan or not (`is_unplanned`) — and never "No plan sent" about a rep who sent one.
    if (visit.source === "rep") {
      rows.push({
        actual: visit,
        half: halfOfVisit(visit),
        id: `visit:${visit.id}`,
        outcome: visit.planned ? "done" : "unplanned",
        outcomeLabel: visit.planned ? "On the plan" : "Not on the plan",
        plan: null,
      });
      continue;
    }
    summary.unplanned += sent ? 1 : 0;
    rows.push({
      actual: visit,
      half: halfOfVisit(visit),
      id: `visit:${visit.id}`,
      outcome: sent ? "unplanned" : "no_plan",
      outcomeLabel: sent ? "Not on the plan" : "No plan sent",
      plan: null,
    });
  }

  // AM before PM; inside a half the planned rows first (the order the plan gave), then the unplanned visits as they happened.
  const order = new Map(rows.map((row, index) => [row.id, index]));
  rows.sort((left, right) => left.half.localeCompare(right.half) || (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
  return { rows, summary };
}
