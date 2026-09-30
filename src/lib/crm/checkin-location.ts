import { metresBetween, type CheckinPoint } from "@/lib/crm/location-confidence";

/**
 * Where a doctor ACTUALLY IS, averaged from the check-ins iReports360 holds on him.
 *
 * 🔴 THE OWNER, 2026-09-30: "you will get the location of the doctor from the CHECK-IN — from the
 * check-ins taken for this doctor you will grab it and you will put it in the location here", and
 * "make an average". His List was showing a customer not yet validated at the vendor's typed address
 * — "أشمون · Monofia III · Delta West" — which is a region, not a place, and whose Maps link is a
 * text search that resolves almost anywhere. The reps have been standing in front of these doctors
 * for months; their own fixes are the better answer, and they are already in the mirror.
 *
 * 🔴 NOTHING HERE IS NEW EXCEPT THE AVERAGE. He also said, in the same breath: "don't duplicate this
 * work, it was already done in the module before — check it to avoid duplication." So the reading is
 * `loadCheckins` (reps-list.ts) and the distance is `metresBetween` (location-confidence.ts), both
 * reused as they stand. This file holds one function and one decision.
 *
 * ═══ THE DECISION, STATED PLAINLY BECAUSE IT IS A JUDGEMENT ═══
 *
 * A PLAIN mean of every check-in is not safe. One fix taken from a rep's car on the ring road, or
 * from home, drags the average a kilometre into open ground — and the whole point of this is a rep
 * driving to a place. The average is therefore taken over the check-ins that AGREE WITH EACH OTHER:
 * the largest group of fixes standing within `TOGETHER_M` of one another wins, and the mean of that
 * group is the answer. With no outliers the two are identical, which is the ordinary case.
 *
 * If the owner wants the arithmetic mean of every fix regardless, that is a one-line change here and
 * the test below says which line.
 */

/**
 * How close two fixes have to be to count as the same place. 150m is the width of a city block here
 * and comfortably wider than a phone's own error on a street; it is the figure the confidence
 * scoring already treats as "near".
 */
export const TOGETHER_M = 150;

export type ObservedPoint = {
  lat: number;
  lon: number;
  /** How many check-ins agreed on it — what the average is actually made of. */
  agreed: number;
  /** How many were considered in all. `agreed < total` means outliers were dropped. */
  total: number;
  /** The newest check-in in the agreeing group, so a reader can see how stale the answer is. */
  at: string | null;
  /**
   * The address iReports360 resolved for the most recent check-in, when it has one. It is an
   * OBSERVATION — where a rep actually stood — which is why it is preferred to the vendor's typed
   * record but never to a place the rep captured and confirmed himself.
   */
  address: string | null;
};

/**
 * The doctor's place, or null when nobody has ever checked in on him.
 *
 * Pure, and O(n²) on purpose: a doctor's check-ins are counted in tens, and a clustering that a
 * reader cannot follow is worse here than one that costs a hundred comparisons.
 */
export function averageCheckinPoint(points: readonly CheckinPoint[]): ObservedPoint | null {
  const usable = points.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon));
  if (usable.length === 0) return null;
  if (usable.length === 1) {
    const [only] = usable;
    return { address: null, agreed: 1, at: only.at, lat: only.lat, lon: only.lon, total: 1 };
  }

  // The largest group of fixes that stand together. Each point is tried as the group's anchor, which
  // is the honest version of "which of these places do most of the check-ins agree on".
  let best: CheckinPoint[] = [];
  for (const anchor of usable) {
    const near = usable.filter((point) => metresBetween(anchor.lat, anchor.lon, point.lat, point.lon) <= TOGETHER_M);
    if (near.length > best.length) best = near;
  }
  // Every fix disagreed with every other: no group is bigger than one, so there is nothing to
  // average — the NEWEST is the best single answer, and `agreed: 1` says so on the row.
  const group = best.length > 1 ? best : [newestOf(usable)];

  const lat = group.reduce((sum, point) => sum + point.lat, 0) / group.length;
  const lon = group.reduce((sum, point) => sum + point.lon, 0) / group.length;
  return { address: null, agreed: group.length, at: newestOf(group).at, lat, lon, total: usable.length };
}

function newestOf(points: readonly CheckinPoint[]): CheckinPoint {
  return points.reduce((newest, point) => ((point.at ?? "") > (newest.at ?? "") ? point : newest), points[0]);
}
