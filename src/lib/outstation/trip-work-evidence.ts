/**
 * OUTSTATION TRIP WORK EVIDENCE — "was this person away on company business that day".
 *
 * Owner, 2026-10-12, after the Phoenix CRM half of the same audit: *"check outstation trips as a
 * deduction source too"*. Asked which trip states should count as proof, he ruled **any trip not
 * rejected** — so a submitted claim spares the day, and a trip the admin later rejects puts the day
 * back in scope on the next refresh.
 *
 * The defect this closes, measured on production 1 September – 12 October 2026: NOTHING in the
 * deduction, private-calendar or attendance paths read either trip table. 131 trip-days fell in that
 * window and 65 of them carried no CRM row of any kind and no fingerprint punch — 62 chargeable days
 * worth 69,667.47 EGP across 18 people, almost all District Sales Managers and head-office managers
 * whose travel day has no doctor to visit and no office device to punch. Nothing had been charged:
 * `dsm_no_record` has never produced a candidate on production and `no_records_activity` was new the
 * same day. Account: `docs/deductions-outstation-trip-days.md`.
 *
 * ## Two tables, two date shapes
 *
 *   - `outstation_expense_requests` is the live flow. `trip_start_date` / `trip_end_date` are
 *     `timestamptz`, so the Cairo calendar day is taken through `cairoDateOnly` — Egypt observes DST
 *     again, so a fixed offset would mis-date every evening departure for half the year.
 *   - `outstation_expenses` holds imported and legacy rows. `expense_date` / `to_date` are plain
 *     `date` columns, already the business day, and are read as written.
 *
 * A multi-day trip proves EVERY day from its start to its end, travel days included: the whole point
 * is that those are the days with nothing else to show.
 *
 * THROWS on a failed read. A loader that swallowed the error and answered "no trips" would charge
 * every travelling day it failed to read.
 */

import { cairoDateOnly } from "@/lib/outstation/departure-evidence.ts";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const OUTSTATION_EXPENSE_REQUESTS_TABLE = "outstation_expense_requests";
export const OUTSTATION_EXPENSES_TABLE = "outstation_expenses";

/** One day one person was away on a trip, with the trip state that proves it. */
export type OutstationTripDay = {
  /** The hr id exactly as the trip row stores it — compacting is the suppressor's job. */
  hrId: string;
  date: string;
  /** Which table the day came from. */
  source: "request" | "expense";
  /** The stored status, for the reason line a reviewer reads. */
  status: string;
  /** Where the trip went, when the row says. */
  destination: string | null;
};

type RequestRow = {
  employee_hr_id: string | null;
  status: string | null;
  trip_start_date: string | null;
  trip_end_date: string | null;
  to_label: string | null;
  to_city: string | null;
};

type ExpenseRow = {
  hr_id: string | null;
  status: string | null;
  hr_status: string | null;
  expense_date: string | null;
  to_date: string | null;
  to_location: string | null;
};

function isoDay(value: string | null | undefined): string | null {
  const day = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function storedHrId(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

/**
 * His ruling, mechanically: a trip counts unless it was REJECTED.
 *
 * A deny-list, not an allow-list, deliberately — "any trip not rejected" is what he said, and a
 * status nobody has taught this function would otherwise start charging the day silently. The
 * reverse default is the one that costs someone money.
 */
export function outstationTripStateProvesWork(status: string | null | undefined): boolean {
  const text = String(status ?? "").trim().toLowerCase();
  if (text.length === 0) return false;
  return !text.startsWith("reject") && !text.startsWith("cancel") && !text.startsWith("withdraw");
}

/** Every Cairo day from start to end inclusive, capped so one malformed row cannot run away. */
function daysBetween(start: string, end: string): string[] {
  if (end < start) return [];
  const days: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last && days.length < 400) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/**
 * Fold both reads into one row per (hr id as stored, day). Pure, so the state rule, the Cairo dating
 * and the multi-day expansion are all pinned by a test with no database.
 */
export function foldOutstationTripDays(input: {
  end: string;
  expenses: readonly ExpenseRow[];
  requests: readonly RequestRow[];
  start: string;
}): OutstationTripDay[] {
  const windowStart = isoDay(input.start);
  const windowEnd = isoDay(input.end);
  if (!windowStart || !windowEnd || windowEnd < windowStart) return [];

  const byKey = new Map<string, OutstationTripDay>();
  const add = (day: OutstationTripDay) => {
    if (day.date < windowStart || day.date > windowEnd) return;
    const key = `${day.hrId}|${day.date}`;
    const existing = byKey.get(key);
    // An accepted trip outranks a pending one on the same day: the reason line should say the
    // stronger thing when both exist.
    if (!existing || (existing.status.toLowerCase() === "submitted" && day.status.toLowerCase() !== "submitted")) {
      byKey.set(key, day);
    }
  };

  for (const row of input.requests) {
    const hrId = storedHrId(row.employee_hr_id);
    const status = String(row.status ?? "").trim();
    if (!hrId || !outstationTripStateProvesWork(status)) continue;
    const start = cairoDateOnly(row.trip_start_date);
    if (!start) continue;
    const end = cairoDateOnly(row.trip_end_date) ?? start;
    for (const date of daysBetween(start, end)) {
      add({
        date,
        destination: storedHrId(row.to_label) ?? storedHrId(row.to_city),
        hrId,
        source: "request",
        status,
      });
    }
  }

  for (const row of input.expenses) {
    const hrId = storedHrId(row.hr_id);
    // Either column can hold the refusal on a legacy row, so both have to pass.
    const status = String(row.status ?? row.hr_status ?? "").trim();
    if (
      !hrId
      || !outstationTripStateProvesWork(row.status)
      || (storedHrId(row.hr_status) !== null && !outstationTripStateProvesWork(row.hr_status))
    ) {
      continue;
    }
    const start = isoDay(row.expense_date);
    if (!start) continue;
    const end = isoDay(row.to_date) ?? start;
    for (const date of daysBetween(start, end)) {
      add({ date, destination: storedHrId(row.to_location), hrId, source: "expense", status });
    }
  }

  return [...byKey.values()].sort(
    (left, right) => left.date.localeCompare(right.date) || left.hrId.localeCompare(right.hrId),
  );
}

/** The reason line a suppressed trip day carries into a connector's evidence. */
export function describeOutstationTripDay(day: OutstationTripDay): string {
  const where = day.destination ? ` to ${day.destination}` : "";
  const pending = day.status.toLowerCase() === "submitted" ? ", awaiting its decision" : "";
  return `Outstation trip${where} (${day.status}${pending})`;
}

/**
 * Every trip day in the window, company-wide.
 *
 * The timestamptz window is widened by a day on each side before the Cairo date is taken: a trip
 * leaving at 23:00 Cairo on the last day of the window is stored as the next UTC day, and the
 * reverse at the start. The fold then drops anything outside the real window.
 */
export async function loadOutstationTripDays(input: { end: string; start: string }): Promise<OutstationTripDay[]> {
  const start = isoDay(input.start);
  const end = isoDay(input.end);
  if (!start || !end || end < start) return [];

  const widen = (day: string, deltaDays: number) => {
    const date = new Date(`${day}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + deltaDays);
    return date.toISOString().slice(0, 10);
  };

  // Paged: PostgREST stops a response at 1,000 rows, and a dropped trip is a travelling day charged.
  const supabase = getSupabaseAdmin();
  const read = async <T>(label: string, buildQuery: () => unknown): Promise<T[]> => {
    try {
      return await fetchAllRows<T>(buildQuery, "id");
    } catch (error) {
      const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error);
      throw new Error(
        `Failed to read outstation ${label} for trip work evidence: ${message}. `
          + "Without them a day someone spent travelling on company business would be charged a deduction.",
      );
    }
  };
  const [requests, expenses] = await Promise.all([
    read<RequestRow>("expense requests", () =>
      supabase
        .from(OUTSTATION_EXPENSE_REQUESTS_TABLE)
        .select("id,employee_hr_id,status,trip_start_date,trip_end_date,to_label,to_city")
        // A multi-day trip can START before the window and still cover days inside it.
        .gte("trip_end_date", `${widen(start, -31)}T00:00:00Z`)
        .lte("trip_start_date", `${widen(end, 1)}T23:59:59Z`),
    ),
    read<ExpenseRow>("expense rows", () =>
      supabase
        .from(OUTSTATION_EXPENSES_TABLE)
        .select("id,hr_id,status,hr_status,expense_date,to_date,to_location")
        .gte("expense_date", widen(start, -31))
        .lte("expense_date", widen(end, 1)),
    ),
  ]);

  return foldOutstationTripDays({ end, expenses, requests, start });
}
