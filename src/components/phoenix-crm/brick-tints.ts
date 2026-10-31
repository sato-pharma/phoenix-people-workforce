/**
 * Phoenix CRM — the brick colours, in ONE place.
 *
 * The same eight hues, in the same order, as the Reps List board (reps-list-tables.tsx). They started
 * on the List tab and now the Visits picker groups a day by brick too, which is the moment a second
 * copy would have been made — and a brick that is teal on one screen and indigo on the next is a brick
 * nobody can learn. Only mapped bricks are tinted; an unmapped locality keeps amber, which is a
 * statement rather than a missing colour.
 *
 * A hue is keyed off the brick's place in the WHOLE list, never the filtered or sorted one: a brick
 * that changes colour as you search or as the order changes is no use as a landmark.
 */

export type BrickTint = { bar: string; fill: string };

export const BRICK_TINTS: readonly BrickTint[] = [
  { bar: "border-l-sky-500", fill: "bg-sky-50" },
  { bar: "border-l-emerald-500", fill: "bg-emerald-50" },
  { bar: "border-l-indigo-500", fill: "bg-indigo-50" },
  { bar: "border-l-teal-500", fill: "bg-teal-50" },
  { bar: "border-l-fuchsia-500", fill: "bg-fuchsia-50" },
  { bar: "border-l-cyan-500", fill: "bg-cyan-50" },
  { bar: "border-l-lime-500", fill: "bg-lime-50" },
  { bar: "border-l-stone-500", fill: "bg-stone-100" },
] as const;

/**
 * A hue per mapped brick, assigned in the order given. Pass the keys of the WHOLE list, mapped ones
 * only and already in their stable order; anything left out simply has no tint.
 */
export function brickTintMap(mappedKeys: ReadonlyArray<string>): Map<string, BrickTint> {
  const tints = new Map<string, BrickTint>();
  let index = 0;
  for (const key of mappedKeys) {
    if (tints.has(key)) continue;
    tints.set(key, BRICK_TINTS[index % BRICK_TINTS.length]);
    index += 1;
  }
  return tints;
}

/**
 * The NEIGHBOURHOOD colours — doctors who stand within 20 m of each other are one group, every row of
 * the group wears its colour, and the next group the next colour (owner, 2026-09-01 on the Reps List;
 * the whole row from 2026-10-31; and the same rule on the weekly plan, the same day).
 *
 * ONE copy, here, for the Reps List (reps-list-tables.tsx), the Phoenix CRM List (customer-list-board.tsx)
 * and the plan day (plan-day-panel.tsx) — three copies of a palette drift, and a group that is sky on
 * one screen and rose on the next tells the reader nothing. Why these five, at `100`, is written out
 * beside the Reps List's row rule: none of them already means something there (violet is the shared
 * customer, emerald and amber the confidence bands, amber also "no brick yet", orange a link or a
 * placed row), and the fill has to carry the hue alone. Groups past the fifth wrap round, which is safe
 * because a repeat can only meet its twin with four other groups between them.
 */
export const NEIGHBOUR_TINTS = [
  { bar: "border-sky-400", fill: "bg-sky-100", ink: "text-sky-800" },
  { bar: "border-rose-400", fill: "bg-rose-100", ink: "text-rose-800" },
  { bar: "border-teal-400", fill: "bg-teal-100", ink: "text-teal-800" },
  { bar: "border-lime-400", fill: "bg-lime-100", ink: "text-lime-800" },
  { bar: "border-indigo-400", fill: "bg-indigo-100", ink: "text-indigo-800" },
] as const;

export type NeighbourTint = (typeof NEIGHBOUR_TINTS)[number];

/** The colour of neighbourhood `cluster` (numbered from 0), or null for a row that stands alone. */
export function neighbourTint(cluster: number | null | undefined): NeighbourTint | null {
  return cluster == null ? null : NEIGHBOUR_TINTS[cluster % NEIGHBOUR_TINTS.length];
}
