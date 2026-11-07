/**
 * One trip day's GPS check-ins as the approver reads them — the route, not the raw rows.
 *
 * Two things the CRM rows say that a route must not (owner, 2026-11-07, on Saad Salama's 6 Sep and
 * Sally Saied's 20 Sep claims):
 *  - A phone that saves every tap: five check-ins at one doctor inside four seconds are ONE stop.
 *    Consecutive rows at the same place, logged the same way, within REPEAT_TAP_WINDOW_SECONDS of the
 *    group's first row fold into one, carrying `taps`.
 *  - A borrowed route: a manager logs no GPS of his own, so his route is the rep's check-ins. Only the
 *    stops the two SHARED are his; the rep's other check-ins that day (`withoutPerson`, flagged by
 *    visit-workload.ts) are listed apart, unnumbered and off the map.
 *
 * Display only. The server list stays whole — the claim checks and the PDF read it as it is.
 */

export const REPEAT_TAP_WINDOW_SECONDS = 120;

export type RouteCheckinRow = {
  address: string | null;
  at: string | null;
  contact: string | null;
  contactCrmId?: number | null;
  lat: number | null;
  lon: number | null;
  /** Number of saved taps this one stop stands for; absent on a raw row (one tap). */
  taps?: number;
  via: string | null;
  /** A borrowed check-in at a place this person was NOT visited with (visit-workload.ts). */
  withoutPerson?: boolean;
};

export type RouteVisitRow = { kind: string; role: string };

export type HiddenBorrowedCheckins = { count: number; via: string };

/** The check-in's place: the contact by id, else by name, else the address, else its GPS to 4 decimals. */
export function checkinPlaceKey(checkin: RouteCheckinRow): string | null {
  if (checkin.contactCrmId != null) return `id:${checkin.contactCrmId}`;
  const name = checkin.contact?.trim().toLowerCase();
  if (name) return `n:${name}`;
  const address = checkin.address?.trim().toLowerCase();
  if (address) return `a:${address}`;
  if (checkin.lat != null && checkin.lon != null) return `g:${checkin.lat.toFixed(4)},${checkin.lon.toFixed(4)}`;
  return null;
}

/** Seconds of a CRM wall-clock stamp, for differences only — the zone never enters a subtraction. */
function stampSeconds(at: string | null): number | null {
  if (!at) return null;
  const ms = Date.parse(`${at.replace(" ", "T").slice(0, 19)}Z`);
  return Number.isNaN(ms) ? null : ms / 1000;
}

/** Folds repeat taps; the input is in time order, as visit-workload.ts returns it. Pure. */
export function foldRepeatCheckins<T extends RouteCheckinRow>(checkins: readonly T[]): Array<T & { taps: number }> {
  const folded: Array<T & { taps: number }> = [];
  let groupStart: number | null = null;
  for (const checkin of checkins) {
    const last = folded[folded.length - 1];
    const key = checkinPlaceKey(checkin);
    const seconds = stampSeconds(checkin.at);
    if (
      last &&
      key !== null &&
      key === checkinPlaceKey(last) &&
      (last.via ?? null) === (checkin.via ?? null) &&
      seconds !== null &&
      groupStart !== null &&
      seconds - groupStart >= 0 &&
      seconds - groupStart <= REPEAT_TAP_WINDOW_SECONDS
    ) {
      last.taps += checkin.taps ?? 1;
      continue;
    }
    folded.push({ ...checkin, taps: checkin.taps ?? 1 });
    groupStart = seconds;
  }
  return folded;
}

type DayShape = { checkins?: RouteCheckinRow[]; visits?: RouteVisitRow[] };
type DayCheckin<D extends DayShape> = NonNullable<D["checkins"]>[number];

export type RoutedTripDay<D extends DayShape> = Omit<D, "checkins"> & {
  checkins: Array<DayCheckin<D> & { taps: number }>;
  /** The borrowed check-ins at places this person was not visited with, folded, counted per rep. */
  hiddenCheckins: HiddenBorrowedCheckins[];
  /** The person's own visits that day when not one of them has a GPS check-in of their own. */
  ownVisitsWithoutGps: number;
};

/** The day as its route: shared stops folded and numbered, the rest counted apart. Pure. */
export function routeTripDay<D extends DayShape>(day: D): RoutedTripDay<D> {
  const all: Array<DayCheckin<D>> = day.checkins ?? [];
  const hiddenByRep = new Map<string, number>();
  for (const checkin of foldRepeatCheckins(all.filter((row) => row.withoutPerson === true))) {
    const via = checkin.via ?? "the rep";
    hiddenByRep.set(via, (hiddenByRep.get(via) ?? 0) + 1);
  }
  const ownCheckins = all.filter((row) => !row.via).length;
  const ownVisits = (day.visits ?? []).filter((visit) => visit.role === "agent" && visit.kind !== "meeting").length;
  return {
    ...day,
    checkins: foldRepeatCheckins(all.filter((row) => row.withoutPerson !== true)),
    hiddenCheckins: [...hiddenByRep].map(([via, count]) => ({ count, via })),
    ownVisitsWithoutGps: ownCheckins === 0 ? ownVisits : 0,
  };
}
