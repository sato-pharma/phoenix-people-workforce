/**
 * Phoenix CRM — doctors who stand at the same address sit together on the plan day, and each such
 * group is ONE colour (owner, 2026-10-31: "make the same color rule when making their weekly plans",
 * the rule he set on the Reps List the same night — "color all drs near to each other by a group color
 * and if another group near each other then another color").
 *
 * "Near" is the Reps List's own: within `NEIGHBOUR_M` (20 m) of each other, found by `findNeighbours`,
 * and a chain of such pairs is one group. Run per BRICK GROUP by the caller, so a group never reaches
 * across a brick heading the page has just drawn.
 *
 * 🔴 THE PLANNER'S ORDER IS KEPT. The day lists the customers who receive first, then by start time,
 * then by name, and the brick's own tick box places them "in the order shown". So this never re-sorts:
 * each group moves up to where its FIRST member already stood, its other members follow straight
 * under it in their own order, and every row with no neighbour stays exactly where it was.
 * (`clusterRows`, the Reps List's gather, sorts by name — right for a list he reads, wrong for a day
 * he builds.)
 *
 * Groups are numbered from 0 in reading order, so the first colour a reader meets is the palette's
 * first. Pure: rows and points in, rows and group numbers out.
 */

import { findNeighbours, NEIGHBOUR_M } from "@/lib/crm/location-confidence";

/** Where a row stands, and its name (the tie-break `findNeighbours` reports with). */
export type NeighbourPoint = { lat: number | null; lon: number | null; name: string };

export type GatheredRow<T> = {
  row: T;
  /** Which group this row stands in, numbered from 0 in reading order. Null when it stands alone. */
  group: number | null;
};

export function gatherNeighbours<T>(
  rows: readonly T[],
  pointOf: (row: T) => NeighbourPoint,
  radius: number = NEIGHBOUR_M,
): Array<GatheredRow<T>> {
  // `findNeighbours` is keyed by a number; the row's place in the list is unique here, which is all
  // it needs. A row with no point (a customer not validated yet has no place) never has a neighbour.
  const found = findNeighbours(
    rows.map((row, index) => {
      const point = pointOf(row);
      return { contactCrmId: index, lat: point.lat, lon: point.lon, name: point.name };
    }),
    radius,
  );

  const out: Array<GatheredRow<T>> = [];
  const gathered = new Set<number>();
  let next = 0;
  for (let index = 0; index < rows.length; index += 1) {
    if (gathered.has(index)) continue;
    if (!found.has(index)) {
      out.push({ group: null, row: rows[index] });
      gathered.add(index);
      continue;
    }
    // Everything reachable through the neighbour pairs is one group, however long the chain.
    const members = new Set<number>([index]);
    const queue = [index];
    while (queue.length > 0) {
      const at = queue.shift() as number;
      for (const near of found.get(at) ?? []) {
        if (members.has(near.contactCrmId)) continue;
        members.add(near.contactCrmId);
        queue.push(near.contactCrmId);
      }
    }
    const group = next;
    next += 1;
    for (const member of [...members].sort((left, right) => left - right)) {
      out.push({ group, row: rows[member] });
      gathered.add(member);
    }
  }
  return out;
}

/**
 * The same, over a list already cut into brick groups: each brick's rows gathered, and every gathered
 * row's group number by `idOf`. The numbering runs ON across the bricks, so two groups on one AM or PM
 * list never share a colour until the palette wraps. A brick with no neighbours comes back unchanged.
 */
export function gatherWithinGroups<T, G extends { rows: readonly T[] }>(
  groups: readonly G[],
  pointOf: (row: T) => NeighbourPoint,
  idOf: (row: T) => string,
): { groups: G[]; groupOf: Map<string, number> } {
  const groupOf = new Map<string, number>();
  let counted = 0;
  const out = groups.map((brick) => {
    const gathered = gatherNeighbours(brick.rows, pointOf);
    let last = -1;
    for (const entry of gathered) {
      if (entry.group === null) continue;
      groupOf.set(idOf(entry.row), counted + entry.group);
      last = Math.max(last, entry.group);
    }
    counted += last + 1;
    return { ...brick, rows: gathered.map((entry) => entry.row) };
  });
  return { groups: out, groupOf };
}
