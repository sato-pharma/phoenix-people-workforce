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
