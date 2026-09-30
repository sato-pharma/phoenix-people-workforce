import { normalizeArea } from "@/lib/phoenix-crm/suggestions";

/**
 * Phoenix CRM — one way to cluster rows by brick.
 *
 * GOLDEN RULE #1, the EASY half (owner, 2026-09-26): "I want everything to be highlighted, every
 * brick be highlighted, the doctors in the same bricks are highlighted with the same colour … I want
 * the thing to be as easiest as it could be."
 *
 * Named `clusterByBrick` because the retired plan-tab.tsx owned a `groupByBrick` UI toggle of its own
 * (the rep's switch for grouping the candidate list), and two things with one name in one file is how
 * a later edit picks the wrong one.
 *
 * This was a closure inside `AddCustomers` in the retired plan-tab.tsx and could not be reached by the
 * other screens that need it, so the rep's day read alphabetically while his candidates read
 * geographically. Lifted here so the plan board's days (plan-day-panel.tsx), the visit picker and the
 * phone all group the same way, from the same normaliser — `normalizeArea`, which is the module's one
 * brick comparison key and folds "Faisal " and "faisal" together.
 *
 * ## Why the order is a parameter
 *
 * Two callers want opposite things and both are right:
 *
 * - **A day he is going to WORK** is a route. `"first-appearance"` keeps whatever order the caller
 *   already sorted into — AM before PM, then the receiving hour — so the groups come out in the
 *   order he will drive them, and the brick headings simply mark where one cluster ends.
 * - **A list he is SEARCHING** is an index. `"alphabetical"` puts "Brick D14" where he expects to
 *   find it, which is what `AddCustomers` has always done.
 *
 * Rows with no brick are always one group, always last. They are the customers whose place has not
 * been captured yet, and they must never be scattered through the geography as if they belonged
 * somewhere.
 */

export type BrickGroup<T> = {
  /** The normalised brick, or `NO_BRICK_KEY`. Stable, so a tint keyed on it never moves. */
  key: string;
  /** "Brick D14", or "No brick". */
  label: string;
  rows: T[];
};

export const NO_BRICK_KEY = "__no_brick__";
export const NO_BRICK_LABEL = "No brick";

export function brickLabel(brick: string | null | undefined): string {
  const trimmed = typeof brick === "string" ? brick.trim() : "";
  return trimmed ? `Brick ${trimmed}` : NO_BRICK_LABEL;
}

export function clusterByBrick<T>(
  rows: readonly T[],
  brickOf: (row: T) => string | null | undefined,
  order: "first-appearance" | "alphabetical",
): Array<BrickGroup<T>> {
  const groups = new Map<string, BrickGroup<T>>();

  for (const row of rows) {
    const brick = brickOf(row);
    const key = normalizeArea(brick ?? null) ?? NO_BRICK_KEY;
    const group = groups.get(key) ?? { key, label: brickLabel(brick), rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }

  const out = [...groups.values()];
  if (order === "alphabetical") out.sort((left, right) => left.label.localeCompare(right.label));

  // Whatever the order, the customers with no place yet come last — never scattered through the
  // geography as if they sat somewhere.
  const placed = out.filter((group) => group.key !== NO_BRICK_KEY);
  const unplaced = out.filter((group) => group.key === NO_BRICK_KEY);
  return [...placed, ...unplaced];
}
