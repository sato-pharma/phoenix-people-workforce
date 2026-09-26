/**
 * Phoenix CRM — clustering rows by brick on the phone.
 *
 * The transcription of `src/lib/phoenix-crm/brick-groups.ts`, field for field. `mobile/tsconfig.json`
 * maps `@/*` to `mobile/src/*` only, so nothing here can import the web tree; every shared rule in
 * this app is a second copy kept honest by a test. This one is pinned by
 * `tests/phoenix-crm-brick-groups.test.ts`, which asserts both copies answer the same for the same
 * rows — a drift here is silent and only visible with the two screens side by side.
 *
 * `normalizeArea` is transcribed too, from `src/lib/phoenix-crm/suggestions.ts`. It is the module's
 * one brick comparison key: it folds "Faisal " and "faisal" together, and getting it wrong here would
 * split one brick into two groups in exactly the places a rep would not notice.
 */

export type BrickGroup<T> = {
  key: string;
  label: string;
  rows: T[];
};

export const NO_BRICK_KEY = "__no_brick__";
export const NO_BRICK_LABEL = "No brick";

/** The one brick comparison key — the twin of `normalizeArea` in the web's suggestions.ts. */
export function normalizeArea(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim().toLowerCase() : "";
  return trimmed.length > 0 ? trimmed : null;
}

export function brickLabel(brick: string | null | undefined): string {
  const trimmed = typeof brick === "string" ? brick.trim() : "";
  return trimmed ? `Brick ${trimmed}` : NO_BRICK_LABEL;
}

/**
 * Rows clustered by brick.
 *
 * `"first-appearance"` keeps the caller's order, for a day he is about to DRIVE; `"alphabetical"` is
 * for a list he is SEARCHING. Rows with no brick are always one group and always last — they are the
 * customers whose place has not been captured yet, and they must never be scattered through the
 * geography as if they belonged somewhere.
 */
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

  const placed = out.filter((group) => group.key !== NO_BRICK_KEY);
  const unplaced = out.filter((group) => group.key === NO_BRICK_KEY);
  return [...placed, ...unplaced];
}
