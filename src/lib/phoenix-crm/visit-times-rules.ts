/**
 * Phoenix CRM — "Show visit times" on a plan board (owner, 2026-11-05: "make a toggle. If this toggle is turned
 * on, it shows the time of this customer or this doctor when the rep add himself when he is validating …
 * show the timing, the day and time of the last visit that was done to this customer or this doctor. Of
 * course, at the district manager, you will show either this visit was done for him or no, and for the rep
 * and its timing … If on, shows. If off, no show. As it is now, if off.").
 *
 * With the toggle ON, each customer of a manager's plan board shows:
 *   - the DAYS AND HOURS the rep saved on the customer's place when he validated it;
 *   - the REP'S LAST VISIT — its day and its time — and whether the manager was on it ("with you" /
 *     "without you"), by the same rule his month marks use (`countsAsPlannersVisitWithRep`);
 *   - the MANAGER'S OWN LAST VISIT — with the rep, or one of his single visits — or that he has none.
 * On the rep's own day the toggle adds the time to his "Last seen" line; his hours column was always there.
 * OFF, every screen is exactly as it was.
 *
 * 🔴 AN iREPORTS360 COPY HAS NO CLOCK. Copied history is stamped at midnight, so its time is never shown — the
 * day alone, never "12:00 AM".
 *
 * Pure: no database, no React. The reads are `server/manager-visit-times.ts`.
 */

import { countsAsPlannersVisitWithRep } from "@/lib/phoenix-crm/manager-plan-rules";
import type { PhoenixCrmTiming } from "@/lib/phoenix-crm/types";

/** How far back a last visit is looked for: twenty-six weeks, the rep's own "Last seen" window. */
export const VISIT_TIMES_WINDOW_DAYS = 182;

/** One visit's day and, when it has one, its real time. `at` is null for an iReports360 copy. */
export type VisitMoment = { date: string; at: string | null };

export type CustomerVisitTimes = {
  /** Every active place's saved days and hours; empty when the rep saved none. */
  hours: Array<{ label: string | null; timings: PhoenixCrmTiming[] }>;
  /** The rep's newest visit, and whether the manager was on it. Null: none in the window. Absent on his own list. */
  rep?: (VisitMoment & { withYou: boolean }) | null;
  /** The manager's own newest visit — with the rep, or a single visit. Null: none in the window. */
  you: (VisitMoment & { how: "with_rep" | "single" }) | null;
};

export type CustomerVisitTimesView = {
  /** The first day looked at. */
  since: string;
  /** The day planned is a Ramadan day: the Ramadan hours are the ones shown. */
  ramadan: boolean;
  /** Keyed like the month marks: the rep-list customer id, and "m:<id>" for a customer of Manager's own list. */
  customers: Record<string, CustomerVisitTimes>;
};

/** A rep's visit as the read hands it over. */
export type LastVisitRow = {
  customerId: string;
  visitDate: string;
  capturedAt: string | null;
  imported: boolean;
  kind: unknown;
  managerHrId: unknown;
  seniorHrId: unknown;
  productManagerHrId: unknown;
  companionHrIds: unknown;
};

/** A manager's own single visit as the read hands it over. */
export type OwnVisitRow = { customerId: string | null; managerCustomerId: string | null; visitDate: string; capturedAt: string | null };

export type PlaceHoursRow = { customerId: string; label: string | null; timings: PhoenixCrmTiming[] };

function isDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** The visit's day, and its time unless it is a copy with no clock of its own. */
export function momentOf(row: { visitDate: string; capturedAt: string | null; imported?: boolean }): VisitMoment {
  return { date: row.visitDate, at: row.imported || !row.capturedAt ? null : row.capturedAt };
}

/** Positive when `left` is the later visit: the day first, then the time (a visit with no time sorts first). */
export function compareMoments(left: VisitMoment, right: VisitMoment): number {
  if (left.date !== right.date) return left.date > right.date ? 1 : -1;
  const leftAt = left.at ? Date.parse(left.at) : Number.NEGATIVE_INFINITY;
  const rightAt = right.at ? Date.parse(right.at) : Number.NEGATIVE_INFINITY;
  return leftAt === rightAt ? 0 : leftAt > rightAt ? 1 : -1;
}

function newestByCustomer<T extends { customerId: string; visitDate: string; capturedAt: string | null; imported?: boolean }>(rows: ReadonlyArray<T>): Map<string, T> {
  const newest = new Map<string, T>();
  for (const row of rows) {
    if (!row.customerId || !isDay(row.visitDate)) continue;
    const held = newest.get(row.customerId);
    if (!held || compareMoments(momentOf(row), momentOf(held)) > 0) newest.set(row.customerId, row);
  }
  return newest;
}

/**
 * Every customer's visit times. `latest` may hold one row per customer (the database function) or every row
 * of the window: the newest wins either way. `named` is the visits that name the manager anywhere — a loose
 * candidate set; `countsAsPlannersVisitWithRep` decides which of them is his visit with the rep.
 */
export function buildCustomerVisitTimes(input: {
  plannerHrId: string;
  latest: ReadonlyArray<LastVisitRow>;
  named: ReadonlyArray<LastVisitRow>;
  own: ReadonlyArray<OwnVisitRow>;
  hours: ReadonlyArray<PlaceHoursRow>;
}): Record<string, CustomerVisitTimes> {
  const out: Record<string, CustomerVisitTimes> = {};
  // A customer of his own list has no rep, so his entry carries no rep line at all.
  const entry = (key: string): CustomerVisitTimes => (out[key] ??= key.startsWith("m:") ? { hours: [], you: null } : { hours: [], rep: null, you: null });
  const people = (row: LastVisitRow) => ({
    kind: row.kind,
    managerHrId: row.managerHrId,
    seniorHrId: row.seniorHrId,
    productManagerHrId: row.productManagerHrId,
    companionHrIds: row.companionHrIds,
  });

  for (const [customerId, row] of newestByCustomer(input.latest)) {
    entry(customerId).rep = { ...momentOf(row), withYou: countsAsPlannersVisitWithRep(people(row), input.plannerHrId) };
  }

  const withRep = newestByCustomer(input.named.filter((row) => countsAsPlannersVisitWithRep(people(row), input.plannerHrId)));
  for (const [customerId, row] of withRep) entry(customerId).you = { ...momentOf(row), how: "with_rep" };

  for (const row of input.own) {
    if (!isDay(row.visitDate)) continue;
    const key = row.customerId ?? (row.managerCustomerId ? `m:${row.managerCustomerId}` : null);
    if (!key) continue;
    const times = entry(key);
    const moment = momentOf(row);
    if (!times.you || compareMoments(moment, times.you) > 0) times.you = { ...moment, how: "single" };
  }

  for (const row of input.hours) {
    if (!row.customerId || row.timings.length === 0) continue;
    entry(row.customerId).hours.push({ label: row.label, timings: row.timings });
  }
  return out;
}
