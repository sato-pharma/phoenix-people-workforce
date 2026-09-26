/**
 * Phoenix CRM — the brick colours on the phone, the twin of
 * `src/components/phoenix-crm/brick-tints.ts`.
 *
 * Owner, 2026-09-26: "every brick be highlighted, the doctors in the same bricks are highlighted with
 * the same colour". A brick that is teal in the browser and indigo on the phone is a brick nobody can
 * learn, so this list is the SAME EIGHT HUES IN THE SAME ORDER — Tailwind's sky, emerald, indigo,
 * teal, fuchsia, cyan, lime and stone, at the 500 and 50 steps the web file uses.
 *
 * A hex copy rather than an import: `mobile/tsconfig.json` maps `@/*` to `mobile/src/*` only, so
 * nothing here can reach the web tree, and React Native has no Tailwind class names to resolve. The
 * copy is kept honest by `tests/phoenix-crm-brick-groups.test.ts`, which asserts the two lists are the
 * same length — the failure a drift would otherwise cause is silent and only visible side by side.
 *
 * A hue is keyed off the brick's place in the WHOLE list, never the filtered one: a brick that
 * changes colour as he searches is no use as a landmark.
 */

export type BrickTintColors = { bar: string; fill: string };

export const BRICK_TINT_COLORS: readonly BrickTintColors[] = [
  { bar: "#0ea5e9", fill: "#f0f9ff" }, // sky
  { bar: "#10b981", fill: "#ecfdf5" }, // emerald
  { bar: "#6366f1", fill: "#eef2ff" }, // indigo
  { bar: "#14b8a6", fill: "#f0fdfa" }, // teal
  { bar: "#d946ef", fill: "#fdf4ff" }, // fuchsia
  { bar: "#06b6d4", fill: "#ecfeff" }, // cyan
  { bar: "#84cc16", fill: "#f7fee7" }, // lime
  { bar: "#78716c", fill: "#f5f5f4" }, // stone
] as const;

/** A hue per mapped brick, assigned in the order given — the web `brickTintMap`, in hex. */
export function brickTintColorMap(mappedKeys: ReadonlyArray<string>): Map<string, BrickTintColors> {
  const tints = new Map<string, BrickTintColors>();
  let index = 0;
  for (const key of mappedKeys) {
    if (tints.has(key)) continue;
    tints.set(key, BRICK_TINT_COLORS[index % BRICK_TINT_COLORS.length]);
    index += 1;
  }
  return tints;
}
