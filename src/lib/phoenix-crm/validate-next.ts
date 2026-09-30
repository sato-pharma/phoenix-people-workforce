/**
 * Phoenix CRM — which customers the rep validates next, with no I/O.
 *
 * Owner, 2026-09-30: "full godmode premium polish … the best-appearing and easiest CRM, yet
 * controlled". A rep carried over from iReports360 starts with dozens of customers under To validate,
 * and the list shows them by brick and name — which says nothing about which one is worth his next
 * stop. This module answers that from what the List view already carries, so the screen can put the
 * three most useful at the top and the rep never has to work it out standing in the street.
 *
 * THE ORDER, and why each key sits where it does:
 *
 *   1. Visits already saved against him. They count in nothing while he is not validated, and every
 *      one of them starts counting the moment he is (owner, 2026-09-22, rule 5). Validating him turns
 *      work the rep has ALREADY done into numbers — nothing else on the list pays back as fast.
 *   2. Grade A, then B, then C, then no grade. The grade sets how often a customer is visited, so an
 *      A customer is the one whose coming visits are worth the most once he counts.
 *   3. The brick with the most customers still to validate. Validating happens at the clinic, so one
 *      trip to a brick of five can validate five; a customer alone in his brick is a trip for one.
 *   4. The name, then the id — the same list always reads in the same order, so a pick that did not
 *      change never jumps about between two reloads.
 *
 * WHO IS NEVER RANKED. Only the To validate section (`section`, decided once by `listSectionOf`) is
 * read: a validated customer (Your list), one waiting outside the list and one in the Archive never
 * appear. Two more are left out on purpose:
 *   - a customer the rep has already asked to drop. The request is with the district manager and SFE;
 *     telling him to go and validate the same customer would contradict his own request;
 *   - a customer with no iReports360 entry. The Validate screen opens on that entry, so a pick without
 *     one would carry a button that opens nothing (`rowActionFor` offers Open there instead).
 *
 * THE REASONS are plain facts about his own work — visits saved, a grade, how many wait in the same
 * brick. Never a distance, a reading or a check (Golden rule #1): nothing here judges the rep, and no
 * word of it may read as if something did.
 */

import { groupOf } from "@/lib/phoenix-crm/customer-list-grouping";
import type { ListCustomer } from "@/lib/phoenix-crm/view-types";

/** How many picks the strip shows. Three fit one row on a desktop and stay a short scroll on a phone. */
export const VALIDATE_NEXT_COUNT = 3;

/** The words for a pick with nothing special about it — still a real customer, simply next in order. */
export const VALIDATE_NEXT_PLAIN_REASON = "Next to validate";

export type ValidateNextPick = {
  customer: ListCustomer;
  /** Visits saved against him this month, waiting to count. */
  visitsSaved: number;
  /** The brick he sits in, by NAME (owner's rule: names, never codes); null when he has no known brick. */
  brickName: string | null;
  /** Other customers still to validate in the same brick — him not included. 0 without a brick. */
  othersInBrick: number;
  /** Why he is here, most important first. Never empty. */
  reasons: string[];
};

/** A, B, C, then no grade: the order an A customer's worth puts them in. */
function gradeRank(customer: ListCustomer): number {
  if (customer.grade === "A") return 0;
  if (customer.grade === "B") return 1;
  if (customer.grade === "C") return 2;
  return 3;
}

/** Waiting to be validated, not asked to drop, and with an entry the Validate screen opens on. */
export function isValidateNextCandidate(customer: ListCustomer): boolean {
  if (customer.section !== "to_validate") return false;
  if (customer.referenceContactCrmId === null) return false;
  if (customer.pendingDropRequestId !== null) return false;
  return !customer.waiting.some((entry) => entry.kind === "drop");
}

/**
 * The brick a customer is grouped under on the board, when it is a REAL brick. The board's own
 * `groupOf` decides it, so the brick a pick names is the heading the rep sees him under below it. An
 * unmapped locality is not a brick, and "3 more waiting in this brick" would be untrue there.
 */
function brickOf(customer: ListCustomer): { key: string; name: string } | null {
  const group = groupOf(customer);
  return group.mapped ? { key: group.key, name: group.heading } : null;
}

function visitsReason(visits: number): string {
  return visits === 1 ? "1 visit saved — it counts once you validate" : `${visits} visits saved — they count once you validate`;
}

/**
 * "Grade A — 3 visits a month". The card already names the grade, so the reason says what the grade
 * is worth, read off his own target — never a claim the settings might not bear out.
 */
function gradeReason(target: number | null): string {
  if (target === null || target <= 0) return "Grade A";
  return `Grade A — ${target === 1 ? "1 visit" : `${target} visits`} a month`;
}

/** The plain reasons for one pick, in the ranking's own order. */
export function validateNextReasons(pick: Pick<ValidateNextPick, "customer" | "visitsSaved" | "othersInBrick">): string[] {
  const reasons: string[] = [];
  if (pick.visitsSaved > 0) reasons.push(visitsReason(pick.visitsSaved));
  if (pick.customer.grade === "A") reasons.push(gradeReason(pick.customer.target));
  if (pick.othersInBrick > 0) reasons.push(`${pick.othersInBrick} more waiting in this brick`);
  return reasons.length > 0 ? reasons : [VALIDATE_NEXT_PLAIN_REASON];
}

/** Every customer still to validate, most useful first. */
export function rankValidateNext(customers: readonly ListCustomer[]): ValidateNextPick[] {
  const candidates = customers.filter(isValidateNextCandidate);

  // Counted over the candidates only: a customer already validated, or one he asked to drop, is not a
  // reason to make the trip.
  const perBrick = new Map<string, number>();
  for (const customer of candidates) {
    const brick = brickOf(customer);
    if (brick) perBrick.set(brick.key, (perBrick.get(brick.key) ?? 0) + 1);
  }

  const picks = candidates.map((customer) => {
    const brick = brickOf(customer);
    const visitsSaved = Math.max(0, customer.visitsThisMonth);
    const othersInBrick = brick ? (perBrick.get(brick.key) ?? 1) - 1 : 0;
    return { customer, visitsSaved, brickName: brick?.name ?? null, othersInBrick };
  });

  picks.sort(
    (left, right) =>
      Number(right.visitsSaved > 0) - Number(left.visitsSaved > 0) ||
      gradeRank(left.customer) - gradeRank(right.customer) ||
      right.othersInBrick - left.othersInBrick ||
      left.customer.name.localeCompare(right.customer.name) ||
      left.customer.customerId.localeCompare(right.customer.customerId),
  );

  return picks.map((pick) => ({ ...pick, reasons: validateNextReasons(pick) }));
}

/** The first `count` of the ranking. */
export function validateNextTop(customers: readonly ListCustomer[], count = VALIDATE_NEXT_COUNT): ValidateNextPick[] {
  return rankValidateNext(customers).slice(0, Math.max(0, count));
}

/**
 * 🔴 VISITS ALREADY SAVED AGAINST A CUSTOMER NOBODY HAS VALIDATED YET (owner, 2026-09-30: "in To
 * validate, put the already-visited first and highlight them").
 *
 * This is the ranking's FIRST key, on its own, because the List's rows need it one customer at a
 * time rather than as a sorted three. Those visits count in nothing while he is unvalidated and all
 * of them start counting the moment he is — so validating him turns work the rep has ALREADY done
 * into numbers, and nothing else on the list pays back as fast.
 */
export function hasVisitsWaitingToCount(customer: ListCustomer): boolean {
  return (customer.referenceHistory?.visits ?? 0) > 0;
}

/** How many customers a brick marks. Three is a morning's validating, not a wall of colour. */
export const VALIDATE_FIRST_PER_BRICK = 3;

/** One brick's rows in the order they are drawn, and which of them carry the mark. */
export type VisitsWaitingOrder = { rows: ListCustomer[]; marked: ReadonlySet<string> };

/**
 * The brick's rows with the few that pay back MOST first, and only those marked.
 *
 * 🔴 ONLY THE MOST, NEVER ALL OF THEM (owner, 2026-09-30: "mark only the ones with the most visits
 * waiting, not all 88"). The first build marked every customer with any saved visit — and on the
 * territory it was measured against that was 88 of 88, so the whole list went amber and the mark
 * told the rep nothing. A highlight everything carries is not a highlight.
 *
 * 🔴 AND IT REFUSES TO MARK WHEN THE COUNT DOES NOT DISTINGUISH. If every candidate in the brick has
 * the SAME number of visits waiting, there is no "most" — marking three of them would be picking
 * names out of a hat and dressing it as a recommendation. The brick then marks none, which is the
 * honest answer and the guard against the 88-of-88 failure coming back in a new shape.
 *
 * 🔴 PER BRICK, APPLIED AFTER THE NEIGHBOURHOOD PASS. It is handed ONE group's rows, so it can never
 * lift a customer out from under his brick heading: validating happens at the clinic, and a list that
 * sent the rep between towns to chase a highlight would cost him the trip it is trying to save. Each
 * brick marks its own best, so wherever he is working today, the marks there are the ones worth doing
 * first.
 *
 * Inside the marked few the order IS by visits waiting, most first — that is what he asked to see.
 * Everyone else keeps the order the neighbourhood pass gave them, so a block of people who stand
 * together stays together behind them.
 */
export function visitsWaitingFirst(rows: readonly ListCustomer[]): VisitsWaitingOrder {
  const waiting = (customer: ListCustomer): number => customer.referenceHistory?.visits ?? 0;
  const candidates = rows.filter((customer) => hasVisitsWaitingToCount(customer));
  const counts = new Set(candidates.map((customer) => waiting(customer)));
  // Nothing waiting, or every candidate carrying the same count: there is no "most" to point at.
  if (candidates.length === 0 || counts.size < 2) return { marked: new Set(), rows: [...rows] };

  const ranked = [...candidates].sort((left, right) => waiting(right) - waiting(left));
  const top = ranked.slice(0, VALIDATE_FIRST_PER_BRICK);
  const marked = new Set(top.map((customer) => customer.customerId));
  return { marked, rows: [...top, ...rows.filter((customer) => !marked.has(customer.customerId))] };
}
