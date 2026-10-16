/**
 * Phoenix CRM — the figures the Visit report generator works out from a set of visits, with no I/O.
 *
 * 🔴 NOTHING HERE READS A SAVE TIME AS A POSITION IN TIME (owner, 2026-10-02, asked directly with the
 * evidence). A visit's `captured_at` is when the rep SAVED it; he may log the morning from the car and
 * the day at night. So:
 *   - the ORDER, the visits-that-day count and the GAP are save-order facts, said as such on the field;
 *   - the DISTANCE between two visits is a straight line and carries no time;
 *   - the SPEED is worked out only from the two readings' own phone-clock times (`fixAtMs`) and is
 *     absent when either is missing, never from a save time.
 * No figure here is ever a verdict. The integrity board is where a flag is raised, and it is not here.
 */

import { distanceMeters } from "@/lib/phoenix-crm/geo";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** "Tuesday" for a date-only value — read as UTC midnight and rendered as UTC, so the day cannot shift. */
export function dayOfWeekName(day: string): string {
  const at = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(at.getTime()) ? "" : DAY_NAMES[at.getUTCDay()];
}

/** "October 2026" for a date-only value. */
export function monthLabel(day: string): string {
  const [year, month] = day.split("-");
  const index = Number(month) - 1;
  return index >= 0 && index < 12 ? `${MONTH_NAMES[index]} ${year}` : "";
}

/** "2026-10" for a date-only value. */
export function monthKey(day: string): string {
  return day.slice(0, 7);
}

/** The first day of the month before the month of `day`, which is how far back "days since" looks. */
export function firstDayOfPreviousMonth(day: string): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const previousYear = month === 1 ? year - 1 : year;
  const previousMonth = month === 1 ? 12 : month - 1;
  return `${String(previousYear).padStart(4, "0")}-${String(previousMonth).padStart(2, "0")}-01`;
}

/** The date-only value `count` days after `day` (negative counts go back). */
export function addDays(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + count * 86_400_000).toISOString().slice(0, 10);
}

function dayNumber(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) / 86_400_000;
}

export type SequenceInput = {
  visitId: string;
  /**
   * Whose day the visit belongs to — the rep, or the manager on his own visit (`personOnTheVisit`) — and a
   * day's order is per person and per day. 🔴 NEVER THE SEAT: a district manager's own call on a rep's
   * territory took a place in that rep's day, shifting his order and his gaps (2026-10-16).
   */
  person: string;
  visitDate: string;
  savedAtMs: number;
  /** When the PHONE took the reading, on its own clock; null when the capture never recorded it. */
  fixAtMs: number | null;
  lat: number | null;
  lon: number | null;
  customerId: string | null;
};

export type SequenceFacts = {
  numberInDay: number;
  visitsThatDay: number;
  gapMinutes: number | null;
  distanceFromPreviousKm: number | null;
  speedKmh: number | null;
  customerVisitsThisMonth: number;
  daysSinceCustomerVisit: number | null;
};

function usable(lat: number | null, lon: number | null): lat is number {
  return typeof lat === "number" && typeof lon === "number" && Number.isFinite(lat) && Number.isFinite(lon);
}

/**
 * The sequence facts for every visit in `inputs`.
 *
 * `inputs` is the period PLUS the month before it: the extra visits are only ever a customer's history
 * ("days since", "this month"), and the caller keeps only the rows it was asked for.
 */
export function computeVisitSequence(inputs: ReadonlyArray<SequenceInput>): Map<string, SequenceFacts> {
  const facts = new Map<string, SequenceFacts>();

  const byRepDay = new Map<string, SequenceInput[]>();
  for (const input of inputs) {
    const key = `${input.person}|${input.visitDate}`;
    const day = byRepDay.get(key) ?? [];
    day.push(input);
    byRepDay.set(key, day);
  }

  for (const day of byRepDay.values()) {
    day.sort((left, right) => left.savedAtMs - right.savedAtMs || left.visitId.localeCompare(right.visitId));
    day.forEach((visit, index) => {
      const previous = index > 0 ? day[index - 1] : null;
      let gapMinutes: number | null = null;
      let distanceKm: number | null = null;
      let speedKmh: number | null = null;
      if (previous) {
        gapMinutes = Math.max(0, Math.round((visit.savedAtMs - previous.savedAtMs) / 60_000));
        if (usable(visit.lat, visit.lon) && usable(previous.lat, previous.lon)) {
          const meters = distanceMeters(
            { lat: previous.lat as number, lon: previous.lon as number },
            { lat: visit.lat as number, lon: visit.lon as number },
          );
          distanceKm = Math.round(meters / 100) / 10;
          if (visit.fixAtMs !== null && previous.fixAtMs !== null) {
            const hours = (visit.fixAtMs - previous.fixAtMs) / 3_600_000;
            // A negative or zero span between two phone clocks says nothing about speed — not measured.
            if (hours > 0) speedKmh = Math.round((meters / 1000 / hours) * 10) / 10;
          }
        }
      }
      facts.set(visit.visitId, {
        customerVisitsThisMonth: 0,
        daysSinceCustomerVisit: null,
        distanceFromPreviousKm: distanceKm,
        gapMinutes,
        numberInDay: index + 1,
        speedKmh,
        visitsThatDay: day.length,
      });
    });
  }

  const byCustomer = new Map<string, SequenceInput[]>();
  for (const input of inputs) {
    if (!input.customerId) continue;
    const list = byCustomer.get(input.customerId) ?? [];
    list.push(input);
    byCustomer.set(input.customerId, list);
  }
  for (const visits of byCustomer.values()) {
    visits.sort((left, right) => left.visitDate.localeCompare(right.visitDate) || left.savedAtMs - right.savedAtMs);
    for (const visit of visits) {
      const entry = facts.get(visit.visitId);
      if (!entry) continue;
      entry.customerVisitsThisMonth = visits.filter((other) => monthKey(other.visitDate) === monthKey(visit.visitDate)).length;
      const earlier = visits.filter((other) => other.visitDate < visit.visitDate);
      const last = earlier.length > 0 ? earlier[earlier.length - 1] : null;
      entry.daysSinceCustomerVisit = last ? dayNumber(visit.visitDate) - dayNumber(last.visitDate) : null;
    }
  }

  return facts;
}
