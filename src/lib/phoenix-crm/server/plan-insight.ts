/**
 * Phoenix CRM — the reads behind what the plan board tells the rep about each customer: when he was
 * last seen, the days iReports360 usually saw him on, and a follow-up his latest visit left due
 * (owner, 2026-10-02; the rules are plan-insight.ts).
 *
 * Two reads, each started the moment it can be — never a wave of their own:
 *
 *   - his Phoenix visits of the last twenty-six weeks. The newest is when he was last seen in Phoenix,
 *     and its next step is the follow-up (`pickLastNextStep`, the visit form's own rule). They name no
 *     customer minted a moment ago, so this read starts AT ONCE, beside the reference mint, exactly as
 *     the month's visit counts do. The RAW table, like the visit form's "what he said last time": a
 *     visit waiting for its approval is still a visit he made, and "last seen" is not a KPI — the month
 *     figure beside it is `visitsThisMonth`, which stays on the countable view;
 *   - his iReports360 history, through the read door (`loadVisitHistoryFor` → reads.ts, the same read
 *     the List's "14 visits in iReports360 · last Tue 29 Sept" comes from): the last visit, and the days
 *     of the last thirteen weeks. It is keyed on the reference contact behind each customer, so it
 *     follows the customer list.
 *
 * 🔴 A NICETY NEVER TAKES THE PLAN DOWN, AND NEVER SAYS SOMETHING UNTRUE. Either read failing is logged
 * and answers NO insight at all, so every row shows what it showed before — never a half-read one: the
 * Phoenix read alone would print "No visit recorded" over a visit iReports360 holds.
 */

import { addDaysIso } from "@/lib/crm/dates";
import { loadVisitHistoryFor, type VisitHistory } from "@/lib/crm/shared-customers";
import { logError } from "@/lib/observability/log";
import { buildPlannerInsights, LAST_SEEN_WINDOW_DAYS, placesHaveDays, USUAL_DAYS_WINDOW_DAYS, type InsightCustomer } from "@/lib/phoenix-crm/plan-insight";
import { numberOrNull, textOrNull } from "@/lib/phoenix-crm/server/db";
import type { ListPlace } from "@/lib/phoenix-crm/server/list";
import type { PlannerInsight } from "@/lib/phoenix-crm/suggestions";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/**
 * Every on-list customer's insight, by customer id. `customersRead` is the planner's own customer read,
 * handed over as a PROMISE (the visit form's `loadLastVisits` takes its products the same way): the
 * Phoenix visits are asked for before it lands, and only the iReports360 half waits for it.
 *
 * `options.visitsRead` is for a caller that already reads this seat's raw visits with these columns,
 * with NO upper bound and from a day at or before this window's first (call prep, whose "what was said
 * last time" reads the same table — 2026-10-16 Phoenix CRM performance audit). Its rows are cut back
 * to this window here, so the answer is exactly the one this read's own query gives, from one read
 * instead of two.
 */
export async function loadPlannerInsights(
  seatId: string,
  isTest: boolean,
  today: string,
  customersRead: Promise<{ customers: Row[]; placesByCustomer: Map<string, ListPlace[]> }>,
  options: { visitsRead?: Promise<Row[]> } = {},
): Promise<Map<string, PlannerInsight>> {
  const lastSeenSince = addDaysIso(today, -LAST_SEEN_WINDOW_DAYS);
  const visitsRead = options.visitsRead
    ? // The `.gte` below, applied to the rows the caller read: an ISO day compares as text exactly as
      // the date column does, and a row with no day is one `.gte` would never have returned.
      options.visitsRead.then((rows) => rows.filter((row) => String(row.visit_date ?? "") >= lastSeenSince))
    : fetchAllRowsKeyset<Row>(
        () =>
          getSupabaseAdmin()
            .from("phoenix_crm_visits")
            .select("id, customer_id, visit_date, captured_at, next_step, next_step_on")
            .eq("seat_id", seatId)
            .eq("is_test", isTest)
            .gte("visit_date", addDaysIso(today, -LAST_SEEN_WINDOW_DAYS)),
        { cursorColumn: "id", cursorOf: (row) => String(row.id) },
      );
  // Handled the moment it starts: it is awaited only once the customer list is in, and a failure
  // landing first must never be an UNHANDLED rejection. The `await` below still receives it.
  visitsRead.catch(() => undefined);
  // The customer list failing is the PLANNER's failure, and it surfaces from the planner's own read of
  // it — so it is left to throw here rather than being logged as one of ours.
  const { customers, placesByCustomer } = await customersRead;
  try {
    const insightCustomers: InsightCustomer[] = customers.map((row) => ({
      customerId: String(row.id),
      savedDays: placesHaveDays(placesByCustomer.get(String(row.id)) ?? []),
      referenceContactCrmId: numberOrNull(row.reference_contact_crm_id),
    }));
    const contactIds = [
      ...new Set(insightCustomers.map((customer) => customer.referenceContactCrmId).filter((id): id is number => typeof id === "number")),
    ];
    const [visitRows, history] = await Promise.all([
      visitsRead,
      contactIds.length > 0
        ? loadVisitHistoryFor(contactIds, { daysSince: addDaysIso(today, -USUAL_DAYS_WINDOW_DAYS) })
        : Promise.resolve(new Map<number, VisitHistory>()),
    ]);
    return buildPlannerInsights({
      customers: insightCustomers,
      visits: visitRows.map((row) => ({
        customerId: String(row.customer_id ?? ""),
        visitDate: String(row.visit_date ?? ""),
        capturedAt: String(row.captured_at ?? ""),
        nextStep: textOrNull(row.next_step),
        nextStepOn: textOrNull(row.next_step_on),
      })),
      history,
    });
  } catch (error) {
    logError("Phoenix CRM planner: the last-seen, usual-days and follow-up reads could not run", {
      error,
      labels: { event: "phoenix_crm_plan_insight_failed" },
    });
    return new Map();
  }
}
