/**
 * "On an outstation trip to X, dates" on the Phoenix CRM plan boards (owner, 2026-11-07, choosing
 * "Trip on the CRM side" for the Phoenix CRM ↔ Expense link). The rep's own board and the manager's
 * plan review both say when the territory's person claimed a business trip inside the weeks on the
 * screen, so a plan with no visits on those days reads as what it is.
 *
 * Pure: the server reads the trip days (`loadOutstationTripDays`, the one reader every surface
 * uses — a rejected trip is never one of them) and folds them here into one line per trip.
 */

export type PlanOutstationTrip = {
  destination: string | null;
  from: string;
  to: string;
};

const nextDay = (iso: string) => {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};

/** Consecutive days to the same destination become one trip, earliest first. */
export function foldPlanOutstationTrips(days: ReadonlyArray<{ date: string; destination: string | null }>): PlanOutstationTrip[] {
  const byDate = new Map<string, string | null>();
  for (const day of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date)) continue;
    const destination = (day.destination ?? "").trim() || null;
    if (!byDate.has(day.date) || (byDate.get(day.date) === null && destination)) byDate.set(day.date, destination);
  }
  const trips: PlanOutstationTrip[] = [];
  for (const date of [...byDate.keys()].sort()) {
    const destination = byDate.get(date) ?? null;
    const last = trips.at(-1);
    if (last && nextDay(last.to) === date && last.destination === destination) last.to = date;
    else trips.push({ destination, from: date, to: date });
  }
  return trips;
}

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC", weekday: "short" });
const dayLabel = (iso: string) => DAY.format(new Date(`${iso}T00:00:00Z`));

/** "On an outstation trip to Alexandria · Thu 23 Oct to Sun 26 Oct". */
export function planOutstationTripLine(trip: PlanOutstationTrip): string {
  const where = trip.destination ? ` to ${trip.destination}` : "";
  const when = trip.from === trip.to ? dayLabel(trip.from) : `${dayLabel(trip.from)} to ${dayLabel(trip.to)}`;
  return `On an outstation trip${where} · ${when}`;
}
