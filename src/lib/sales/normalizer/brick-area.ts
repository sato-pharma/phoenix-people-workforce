// The area beside every brick the Source Normalizer maps a code to (owner request 2026-09-18: "another
// column will be added for the area ... will auto populate. But I will not be able to edit the area in
// this page"), and the way to the page where a wrong one is corrected ("Correct in database").
//
// Pure — no database — so the server page, the client workspace and the tests share one definition.

export type MappingBrickReference = {
  id: string;
  name: string;
  /** The area the brick credits today: its block's area. Empty when the master names none. */
  areaName: string;
  regionName: string;
};

export type MappingReferences = {
  /** Bricks a new mapping may pick. A brick kept only as history after a move is not one of them. */
  bricks: MappingBrickReference[];
  products: { code: string; name: string }[];
  /**
   * Each brick kept only as history after a move, pointing at the brick that replaced it. A pick made
   * before the move, or a place-based suggestion (a cluster's nearest bricks), can still name one; it
   * is shown, and saved, as the brick it moved to.
   */
  movedBricks?: Record<string, string>;
};

// "Correct in database": the Database Mapping page's Bricks tab, opened on this brick's correction.
export function brickCorrectionHref(brickId: string): string {
  return `/sales/database-mapping?tab=bricks&brick=${encodeURIComponent(brickId)}`;
}

// The database refuses a move history that loops (a brick cannot supersede itself, and each move
// needs a live brick), so 50 is a guard against bad data, not a real limit.
const MAX_MOVE_HOPS = 50;

// The brick a brick id stands for today: itself, or — for a brick kept as history — the brick it
// moved to, following every later move too.
export function followMovedBrick(brickId: string, movedBricks: Record<string, string> | undefined): string {
  if (!brickId || !movedBricks) return brickId;
  let current = brickId;
  for (let hop = 0; hop < MAX_MOVE_HOPS; hop += 1) {
    const next = movedBricks[current];
    if (!next || next === current) return current;
    current = next;
  }
  return current;
}

// The brick a pick maps to today, with its area and region names — or null when nothing is picked or
// the brick is not in the master.
export function pickedBrick(
  pick: string | undefined,
  bricksById: ReadonlyMap<string, MappingBrickReference>,
  movedBricks: Record<string, string> | undefined,
): MappingBrickReference | null {
  if (!pick) return null;
  return bricksById.get(followMovedBrick(pick, movedBricks)) ?? null;
}

// Every pick that names a brick kept as history, re-pointed at the brick it moved to. Returns the
// same object when nothing changed, so a React state update can bail out.
export function followMovedPicks(
  picks: Record<string, string>,
  movedBricks: Record<string, string> | undefined,
  isBrickKey: (key: string) => boolean,
): Record<string, string> {
  if (!movedBricks || Object.keys(movedBricks).length === 0) return picks;
  let next: Record<string, string> | null = null;
  for (const [key, value] of Object.entries(picks)) {
    if (!isBrickKey(key)) continue;
    const live = followMovedBrick(value, movedBricks);
    if (live === value) continue;
    next ??= { ...picks };
    next[key] = live;
  }
  return next ?? picks;
}
