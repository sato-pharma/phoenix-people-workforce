/**
 * Phoenix CRM — what the rep wants to know BEFORE the door, for tomorrow's planned stops. No I/O.
 *
 * Owner's shape, Golden rule #1 (the EASY half): "nothing is asked twice". Four facts already exist in
 * the module and all four are reachable only from INSIDE the visit form — once he is standing at the
 * clinic with the form open:
 *
 *   1. when he last saw this customer (his Phoenix visits and iReports360's history together);
 *   2. what the customer pushed back on then;
 *   3. what HE said he would do, still open;
 *   4. what he discussed last time.
 *
 * `today.ts` is explicit that the day screen shows "only what he is going to do today", which is right
 * — and leaves the evening before with nowhere to read any of it. This is that one compact line per
 * planned customer, and nothing more.
 *
 * ## It is READ-ONLY and off the plan-change path, by construction
 *
 * The plan is WEEKLY and a SENT week changes only by request — the district manager, then SFE, then
 * B-10 acknowledges (owner, 2026-10-01). Nothing here writes, nothing here offers an edit, and the
 * stops are read from the plan as it stands. A rep who wants tomorrow changed still goes through "Ask
 * to edit this week"; this screen does not mention it, because mentioning it from a prep list is how a
 * read-only surface grows a second door into the one path that must have exactly one.
 *
 * ## Nothing here judges him (the BLIND half)
 *
 * Every fact is his own work or the customer's own words. There is no distance, no flag, no accuracy,
 * no count of how many stops he kept last time, no readiness figure — and an objection is the DOCTOR's,
 * never a mark against the rep (visit-outcome.ts).
 *
 * ## Absent, never empty
 *
 * A customer he has never seen carries NO facts rather than four blanks: "nothing to prepare" and "he
 * prepared nothing" are different sentences, and the first is the honest one for a doctor carried over
 * from iReports360 whom he has not met yet. Same rule as `pickLastVisitProducts`, for the same reason.
 */

import { addDaysIso } from "@/lib/crm/dates";
import { planDayListTypes } from "@/lib/phoenix-crm/calendar";
import type { LastVisitProducts } from "@/lib/phoenix-crm/last-visit-products";
import { doctorListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import type { PhoenixCrmDoctorListType } from "@/lib/phoenix-crm/types";
import {
  isVisitObjection,
  visitObjectionLabel,
  type LastNextStep,
  type VisitObjection,
} from "@/lib/phoenix-crm/visit-outcome";

/**
 * TOMORROW, in Phoenix's own field calendar: the next day that can hold a plan at all.
 *
 * `planDayListTypes` is the one rule for that (calendar.ts): Friday holds nothing, so Thursday's
 * tomorrow is Saturday. The view carries the day it resolved to and the screen NAMES it, so a rep
 * reading this on a Thursday evening is never shown "tomorrow" over the Saturday's stops.
 */
export function nextFieldDayAfter(day: string): string {
  for (let step = 1; step <= 7; step += 1) {
    const next = addDaysIso(day, step);
    if (planDayListTypes(next).length > 0) return next;
  }
  // Unreachable: a field week always holds five days. Kept total rather than throwing on a nicety.
  return addDaysIso(day, 1);
}

/** One earlier visit's objection, as the server reads it back. */
export type LastObjectionRow = {
  customerId: string;
  /** The Cairo day, `YYYY-MM-DD`. */
  visitDate: string;
  /** The server's own capture time — the tiebreaker when a day holds two. */
  capturedAt: string;
  objection: string | null;
};

/**
 * The NEWEST visit's objection per customer — never the newest visit that happens to carry one.
 *
 * Deliberately the same rule as `pickLastNextStep` (visit-outcome.ts) and for the same reason: a doctor
 * who objected on price in July and raised nothing at the last visit must not be presented as
 * objecting. "No objection" is a real answer and is STORED as `none`, so it closes an older one here
 * exactly as a later "Nothing to follow" closes an older promise — and it is then ABSENT from the line,
 * because there is nothing to prepare for.
 */
export function pickLastObjection(rows: readonly LastObjectionRow[]): Map<string, VisitObjection> {
  const newest = new Map<string, LastObjectionRow>();
  for (const row of rows) {
    if (!row.customerId || !row.visitDate) continue;
    const held = newest.get(row.customerId);
    if (!held || row.visitDate > held.visitDate || (row.visitDate === held.visitDate && row.capturedAt > held.capturedAt)) {
      newest.set(row.customerId, row);
    }
  }
  const out = new Map<string, VisitObjection>();
  for (const [customerId, row] of newest) {
    if (!isVisitObjection(row.objection) || row.objection === "none") continue;
    out.set(customerId, row.objection);
  }
  return out;
}

/** A planned stop as the read hands it over. A pharmacy is never planned, so one never arrives here. */
export type CallPrepStop = {
  customerId: string;
  customerName: string;
  /** `AM` or `PM` — read through `doctorListType`, so a pharmacy row is dropped rather than filed as a doctor. */
  listType: unknown;
};

export type CallPrepLine = {
  customerId: string;
  customerName: string;
  listType: PhoenixCrmDoctorListType;
  /** The day he last saw him — his Phoenix visits and iReports360's history together. Null when never. */
  lastSeenOn: string | null;
  /** What the customer pushed back on at that last visit, in words. Null when there was nothing. */
  objectionLabel: string | null;
  /** What HE said he would do and has not been back for, in words. Null when nothing is open. */
  nextStepLabel: string | null;
  /** The day he set for it, when he set one. */
  nextStepDueOn: string | null;
  /** What he discussed last time — newest visit, products retired from the line dropped. */
  products: string[];
  /** True when none of the four facts is known: a customer he has not met yet. */
  firstTime: boolean;
};

/**
 * AM before PM, then by name. AM first is how every sentence and every figure in this module reads
 * them (the call-rate rule keeps the two apart and never adds them), and a prep list is read in the
 * order the day is driven.
 */
function compareLines(left: CallPrepLine, right: CallPrepLine): number {
  if (left.listType !== right.listType) return left.listType === "AM" ? -1 : 1;
  return left.customerName.localeCompare(right.customerName);
}

/**
 * One line per planned stop, from the four reads behind it.
 *
 * Each input is a MAP keyed by customer id and each is independently absent: a customer missing from
 * all four is `firstTime`, and one missing from some of them simply carries fewer facts. Nothing is
 * defaulted to a zero or an empty string.
 */
export function buildCallPrep(input: {
  stops: readonly CallPrepStop[];
  lastSeen: ReadonlyMap<string, { lastSeenOn: string | null }>;
  products: ReadonlyMap<string, LastVisitProducts>;
  openNextSteps: ReadonlyMap<string, LastNextStep>;
  objections: ReadonlyMap<string, VisitObjection>;
}): CallPrepLine[] {
  const lines: CallPrepLine[] = [];
  const seen = new Set<string>();
  for (const stop of input.stops) {
    // A pharmacy carries no KPI and is never planned or approved (owner, 2026-10-02). `doctorListType`
    // answers null for one, and the row is DROPPED — never widened into the AM/PM union, which is how
    // 26 readers filed a pharmacy among the doctors while the typechecker stayed green.
    const listType = doctorListType(stop.listType);
    if (listType === null || !stop.customerId || !stop.customerName) continue;
    // A customer planned twice in one day is one line. The plan's own caps make it unlikely; two lines
    // about the same doctor would read as two calls to make.
    if (seen.has(stop.customerId)) continue;
    seen.add(stop.customerId);

    const lastSeenOn = input.lastSeen.get(stop.customerId)?.lastSeenOn ?? null;
    const objection = input.objections.get(stop.customerId) ?? null;
    const nextStep = input.openNextSteps.get(stop.customerId) ?? null;
    const products = input.products.get(stop.customerId)?.products ?? [];
    lines.push({
      customerId: stop.customerId,
      customerName: stop.customerName,
      listType,
      lastSeenOn,
      objectionLabel: objection === null ? null : visitObjectionLabel(objection),
      nextStepLabel: nextStep?.label ?? null,
      nextStepDueOn: nextStep?.dueOn ?? null,
      products,
      firstTime: lastSeenOn === null && objection === null && nextStep === null && products.length === 0,
    });
  }
  return lines.sort(compareLines);
}

/**
 * Why there is nothing to prepare, in ONE sentence — or null when there are stops to show.
 *
 * `planSent` is the day's own standing (`isPlanDaySent`, never the week's status: a week returned for
 * one OTHER day still stands as sent on this one). The two empty cases are different sentences on
 * purpose: "the week is not sent yet" sends him to the Plan screen, and "nobody is planned" does not.
 */
export function callPrepEmptyNote(input: { planSent: boolean; stops: number }): string | null {
  if (input.stops > 0) return null;
  if (!input.planSent) return "Your week is not sent yet, so there is nothing planned for that day.";
  return "Nobody is planned for that day.";
}
