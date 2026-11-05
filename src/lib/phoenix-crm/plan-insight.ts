/**
 * Phoenix CRM — what the plan board tells the rep about a customer while he plans a day, with no I/O.
 *
 * Owner, 2026-10-02 — three things on each row of the day's list, and in "Suggest this day":
 *
 *   1. LAST SEEN. The latest of his iReports360 history and his own Phoenix visits: "Last seen Tue 29
 *      Sept". A VALIDATED customer carries his month beside it — "· 1 of 3 visits this month" — and a
 *      customer not validated yet shows the day alone: coverage counts validated customers only (owner,
 *      2026-10-02), so a target he does not have is never put beside him.
 *   2. USUALLY SEEN. While he has no saved days and hours (not validated yet), the weekdays his
 *      iReports360 visits fell on at least TWICE over the last thirteen weeks: a quiet "Usually seen
 *      Sun, Tue (iReports360)" on his row, and Suggest offers him on those days before the others. A
 *      single visit, or visits scattered one per weekday, give no hint and no preference at all. NEVER a
 *      refusal and never a filter — he is offered on every day exactly as before, only earlier on his
 *      usual ones. Once his place has real days and hours they win, and the hint is gone.
 *   3. FOLLOW-UP DUE. His LATEST visit's next step, when its date falls inside the week being planned:
 *      "Follow-up due Tue 6 Oct" on his row, and Suggest places him ahead of the normal order — still
 *      within the day's caps, in his own list, on a day he receives, and never over his grade
 *      (coverage.ts: over the grade is a deviation the system never proposes; he can still tick it).
 *
 * No rule here is written twice: the weekdays are read by `planWeekdays` (plan-pattern.ts), the List's
 * own "usually planned" reading, over visit days instead of plan days — with this path's stricter
 * at-least-twice threshold on top (`usualWeekdaysOf`) — and the follow-up is `pickLastNextStep`
 * (visit-outcome.ts), the visit form's own "what he said last time", so the newest visit's answer wins
 * and a later "Nothing to follow" closes an older one.
 *
 * Golden rule #1: all of it is the rep's own history and his own commitments — his to see. None of it
 * judges him.
 */

import { fieldWeekStart, isIsoDay } from "@/lib/phoenix-crm/calendar";
import { planWeekdays } from "@/lib/phoenix-crm/plan-pattern";
import type { PlannerCustomer, PlannerInsight } from "@/lib/phoenix-crm/suggestions";
import { pickLastNextStep, type LastNextStepRow } from "@/lib/phoenix-crm/visit-outcome";

/**
 * How far back iReports360's visits are read for his usual days: THIRTEEN WHOLE WEEKS, so every
 * weekday has had the same number of chances to appear — a window cut at the first of a month gives
 * some weekdays an extra turn and reads that as a habit.
 */
export const USUAL_DAYS_WINDOW_DAYS = 91;

/**
 * How far back his Phoenix visits are read for "last seen" and a follow-up: twenty-six weeks. A
 * follow-up set further back than that is not one he is still carrying, and the read stays small on a
 * territory that has been running for a year.
 */
export const LAST_SEEN_WINDOW_DAYS = 182;

/** The later of two days; a missing or malformed day is skipped. Null when neither is a day. */
export function laterDay(left: string | null | undefined, right: string | null | undefined): string | null {
  const days = [left, right].filter((day): day is string => isIsoDay(day));
  if (days.length === 0) return null;
  return days.reduce((latest, day) => (day > latest ? day : latest));
}

/** At least one of his places carries days and hours — and then they, never iReports360, say when he receives. */
export function placesHaveDays(places: ReadonlyArray<{ timings: ReadonlyArray<unknown> }>): boolean {
  return places.some((place) => place.timings.length > 0);
}

/**
 * 🔴 A WEEKDAY IS "USUAL" ONLY WHEN HE WAS SEEN ON IT ON AT LEAST TWO DIFFERENT DAYS in the window
 * (coordinator's ruling, 2026-10-02). One visit is not "usually", and visits scattered one per weekday
 * would read "Usually seen Sat, Sun, Mon, Tue, Wed, Thu" — a pattern the data does not show.
 */
export const USUAL_DAY_MIN_VISITS = 2;

/**
 * The weekdays his iReports360 visits usually fell on, Saturday first. The weekday reading is
 * `planWeekdays`'s (plan-pattern.ts — the field week's own order); the threshold is this path's own:
 * only a weekday seen on `USUAL_DAY_MIN_VISITS` different days counts, and with none the answer is null —
 * no hint and no order preference. `planWeekdays`'s fall-back to every day when nothing repeats is the
 * List's business and is deliberately NOT taken here. A day recorded twice is one visit, so the days are
 * counted once each.
 */
export function usualWeekdaysOf(visitDays: readonly string[]): number[] | null {
  const usual = planWeekdays([...new Set(visitDays)]).filter((entry) => entry.entries >= USUAL_DAY_MIN_VISITS);
  return usual.length > 0 ? usual.map((entry) => entry.weekday) : null;
}

/** What iReports360 holds on him, as the read door answers it (reads.ts `readContactVisitHistory`). */
export type InsightHistory = {
  lastVisitedOn: string | null;
  /** His visit days inside the usual-days window, when the read was asked for them. */
  days?: readonly string[];
};

/** One customer's insight from what was read about him. */
export function plannerInsightOf(input: {
  /** His places carry days and hours (`placesHaveDays`): they win, and iReports360's days are not read. */
  savedDays: boolean;
  /** His newest Phoenix visit, of any kind. */
  phoenixLastOn: string | null;
  /** That visit's capture time — null for an iReports360 copy, which has no clock. */
  phoenixLastAt?: string | null;
  /** iReports360's history on the contact behind him; null for a customer the rep added himself. */
  reference: InsightHistory | null;
  /** The date his latest visit's next step is due (`pickLastNextStep`). */
  followUpOn: string | null;
}): PlannerInsight {
  const lastSeenOn = laterDay(input.phoenixLastOn, input.reference?.lastVisitedOn ?? null);
  return {
    lastSeenOn,
    // The time belongs to the visit "last seen" names: his Phoenix visit, when it is the latest.
    lastVisitAt: lastSeenOn !== null && lastSeenOn === input.phoenixLastOn ? (input.phoenixLastAt ?? null) : null,
    usualWeekdays: input.savedDays ? null : usualWeekdaysOf(input.reference?.days ?? []),
    followUpOn: isIsoDay(input.followUpOn) ? input.followUpOn : null,
  };
}

/** A customer as the insight builder needs him. */
export type InsightCustomer = { customerId: string; savedDays: boolean; referenceContactCrmId: number | null };

/**
 * Every customer's insight, from the two reads behind it: his Phoenix visits (newest = last seen there,
 * and the follow-up through `pickLastNextStep`) and iReports360's history on his reference contact.
 */
export function buildPlannerInsights(input: {
  customers: ReadonlyArray<InsightCustomer>;
  /** `imported`: an iReports360 copy, which has a day and no clock. */
  visits: ReadonlyArray<LastNextStepRow & { imported?: boolean }>;
  history: ReadonlyMap<number, InsightHistory>;
}): Map<string, PlannerInsight> {
  // The newest visit per customer: the day first, then its capture time.
  const lastVisit = new Map<string, { day: string; at: string | null }>();
  for (const visit of input.visits) {
    if (!visit.customerId || !isIsoDay(visit.visitDate)) continue;
    const at = visit.imported || !visit.capturedAt ? null : visit.capturedAt;
    const held = lastVisit.get(visit.customerId);
    if (!held || visit.visitDate > held.day || (visit.visitDate === held.day && (at ?? "") > (held.at ?? ""))) {
      lastVisit.set(visit.customerId, { day: visit.visitDate, at });
    }
  }
  const nextSteps = pickLastNextStep(input.visits);
  const insights = new Map<string, PlannerInsight>();
  for (const customer of input.customers) {
    const reference = customer.referenceContactCrmId === null ? null : (input.history.get(customer.referenceContactCrmId) ?? null);
    insights.set(
      customer.customerId,
      plannerInsightOf({
        savedDays: customer.savedDays,
        phoenixLastOn: lastVisit.get(customer.customerId)?.day ?? null,
        phoenixLastAt: lastVisit.get(customer.customerId)?.at ?? null,
        reference,
        followUpOn: nextSteps.get(customer.customerId)?.dueOn ?? null,
      }),
    );
  }
  return insights;
}

// ── On the board ────────────────────────────────────────────────────────────────────────────────

/**
 * The weekdays to hint and to prefer for him: iReports360's usual days while he has no days and hours
 * of his own. Null once his places carry them — his real days win — and when nothing is known.
 */
export function usualDaysOf(customer: Pick<PlannerCustomer, "places" | "insight">): number[] | null {
  if (placesHaveDays(customer.places)) return null;
  const days = customer.insight?.usualWeekdays ?? null;
  return days && days.length > 0 ? days : null;
}

/**
 * How a weekday suits him by iReports360's usual days: 0 one of them · 1 nothing known (or his own days
 * and hours decide) · 2 he is usually seen on other days. An ORDER, never a filter: all three are offered.
 */
export function usualDayRank(customer: Pick<PlannerCustomer, "places" | "insight">, weekday: number): 0 | 1 | 2 {
  const days = usualDaysOf(customer);
  if (!days) return 1;
  return days.includes(weekday) ? 0 : 2;
}

/**
 * His follow-up, when it falls inside the field week starting `weekStart` — Phoenix's own week model
 * (calendar.ts `fieldWeekStart`): Saturday to Thursday, and a Friday belongs to the week before it.
 * Null otherwise.
 */
export function followUpInWeek(customer: Pick<PlannerCustomer, "insight">, weekStart: string): string | null {
  const due = customer.insight?.followUpOn ?? null;
  return due !== null && isIsoDay(due) && fieldWeekStart(due) === weekStart ? due : null;
}
