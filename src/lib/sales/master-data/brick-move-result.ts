// Pure: the shapes the brick-move database functions hand back (sos_relocate_brick,
// sos_move_brick_sales and the Mapping guard decision), read defensively, and the plain words the
// screens show for them. No database access here, so client components and the tests import it.

/** Tabs that moved a brick or rebuilt a moved file tell every other open tab to reload its lists. */
export const BRICK_MOVES_CHANNEL = "phoenix.sales.brick-moves";

/** What sos_move_brick_sales reports: the sales rows that followed a moved brick. */
export type BrickSalesMove = {
  toBrickId: string;
  /** Rows re-stamped onto the brick the old one moved to. */
  movedRows: number;
  /** Files those rows sit in. */
  movedFiles: number;
  /** Rows left on the old brick because their file includes a published month. */
  publishedRows: number;
  /** Rows left on the old brick because their pharmacy waits on the Mapping guard. */
  waitingRows: number;
  /** Files of the old brick whose totals still need rebuilding. */
  pendingFiles: number;
};

/** What sos_relocate_brick reports: the move itself, then the sales that followed it. */
export type BrickRelocation = BrickSalesMove & {
  newBrickId: string;
  newBrickName: string;
  historicalName: string;
  fromAreaName: string;
  toAreaName: string;
  toBlockLabel: string;
  customersMoved: number;
  switchedOffMoved: number;
  customersHeld: number;
  aliasesMoved: number;
  directPharmaciesMoved: number;
  directCodesMoved: number;
  aiAnswersMoved: number;
};

/** What one pass of rebuilding moved files reports. */
export type BrickMoveRefresh = {
  refreshed: number;
  remaining: number;
  failure: string | null;
};

function count(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

export function parseBrickSalesMove(value: unknown): BrickSalesMove | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  return {
    movedFiles: count(v.movedFiles),
    movedRows: count(v.movedRows),
    pendingFiles: count(v.pendingFiles),
    publishedRows: count(v.publishedRows),
    toBrickId: text(v.toBrickId),
    waitingRows: count(v.waitingRows),
  };
}

export function parseBrickRelocation(value: unknown): BrickRelocation | null {
  const sales = parseBrickSalesMove(value);
  if (!sales) return null;
  const v = value as Record<string, unknown>;
  const newBrickId = text(v.newBrickId);
  if (!newBrickId) return null;
  return {
    ...sales,
    aiAnswersMoved: count(v.aiAnswersMoved),
    aliasesMoved: count(v.aliasesMoved),
    customersHeld: count(v.customersHeld),
    customersMoved: count(v.customersMoved),
    directCodesMoved: count(v.directCodesMoved),
    directPharmaciesMoved: count(v.directPharmaciesMoved),
    fromAreaName: text(v.fromAreaName),
    historicalName: text(v.historicalName),
    newBrickId,
    newBrickName: text(v.newBrickName),
    switchedOffMoved: count(v.switchedOffMoved),
    toAreaName: text(v.toAreaName),
    toBlockLabel: text(v.toBlockLabel),
  };
}

export function parseBrickMoveRefresh(value: unknown): BrickMoveRefresh {
  const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const failure = text(v.failure);
  return { failure: failure || null, refreshed: count(v.refreshed), remaining: count(v.remaining) };
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** The pieces of the sales move, in the owner's words. Empty when no sales row was touched. */
export function describeBrickSalesMove(move: BrickSalesMove, toAreaName?: string): string[] {
  const lines: string[] = [];
  const where = toAreaName ? ` now ${move.movedRows === 1 ? "credits" : "credit"} ${toAreaName}` : " moved with it";
  if (move.movedRows > 0) {
    lines.push(`${plural(move.movedRows, "sales row", "sales rows")} in ${plural(move.movedFiles, "file", "files")}${where}.`);
  }
  if (move.publishedRows > 0) {
    lines.push(
      `${plural(move.publishedRows, "sales row stays", "sales rows stay")} where ${move.publishedRows === 1 ? "it was" : "they were"}: ${move.publishedRows === 1 ? "its file includes" : "their files include"} a published month, which never changes.`,
    );
  }
  if (move.waitingRows > 0) {
    lines.push(
      `${plural(move.waitingRows, "sales row waits", "sales rows wait")} with the pharmacies on the Mapping guard, and ${move.waitingRows === 1 ? "moves" : "move"} when you approve them.`,
    );
  }
  if (move.pendingFiles > 0) {
    lines.push(`${plural(move.pendingFiles, "file still needs its", "files still need their")} totals rebuilt. This page does that now.`);
  }
  return lines;
}

/** A finished move, headline first, in names and counts. */
export function describeBrickRelocation(result: BrickRelocation): string[] {
  const lines: string[] = [];
  const from = result.fromAreaName ? ` from ${result.fromAreaName}` : "";
  const block = result.toBlockLabel ? ` (block ${result.toBlockLabel})` : "";
  lines.push(`${result.newBrickName} moved${from} to ${result.toAreaName}${block}.`);
  lines.push(`The old brick stays as history under the name ${result.historicalName}, so published months keep their numbers.`);

  const followed: string[] = [];
  if (result.customersMoved > 0) followed.push(plural(result.customersMoved, "pharmacy", "pharmacies"));
  if (result.switchedOffMoved > 0) followed.push(plural(result.switchedOffMoved, "switched-off pharmacy", "switched-off pharmacies"));
  if (result.directPharmaciesMoved > 0) followed.push(plural(result.directPharmaciesMoved, "direct-order pharmacy", "direct-order pharmacies"));
  if (result.directCodesMoved > 0) followed.push(plural(result.directCodesMoved, "direct-order distributor code", "direct-order distributor codes"));
  if (result.aliasesMoved > 0) followed.push(plural(result.aliasesMoved, "territory name", "territory names"));
  if (result.aiAnswersMoved > 0) followed.push(plural(result.aiAnswersMoved, "saved AI answer", "saved AI answers"));
  if (followed.length > 0) lines.push(`Moved with it: ${followed.join(", ")}.`);

  if (result.customersHeld > 0) {
    lines.push(
      `${plural(result.customersHeld, "pharmacy waits", "pharmacies wait")} for you on the Mapping guard and ${result.customersHeld === 1 ? "stays" : "stay"} on the old brick until you approve ${result.customersHeld === 1 ? "it" : "them"}.`,
    );
  }
  lines.push(...describeBrickSalesMove(result, result.toAreaName));
  return lines;
}

/** One pass of rebuilding moved files, for a progress line. */
export function describeBrickMoveRefresh(result: BrickMoveRefresh): string {
  if (result.failure) {
    const done = result.refreshed > 0 ? `Rebuilt ${plural(result.refreshed, "moved file", "moved files")}. ` : "";
    return `${done}${result.failure} ${plural(result.remaining, "file is", "files are")} still waiting; a file that failed is tried again after five minutes.`;
  }
  if (result.remaining > 0 && result.refreshed === 0) {
    return `${plural(result.remaining, "moved file waits", "moved files wait")} to be rebuilt. Another open page may be rebuilding ${result.remaining === 1 ? "it" : "them"} now; a file that failed is tried again after five minutes.`;
  }
  if (result.remaining > 0) {
    return `Rebuilt ${plural(result.refreshed, "moved file", "moved files")}; ${plural(result.remaining, "is", "are")} still waiting.`;
  }
  return result.refreshed > 0
    ? `Rebuilt ${plural(result.refreshed, "moved file", "moved files")}. Every total is up to date.`
    : "Every moved file's totals are up to date.";
}

/**
 * Why the bin must not switch a brick off, or null when it may. A count that could not be read
 * refuses too: the brick stays on, which is the side nothing is lost on.
 */
export function brickSwitchOffRefusal(activePharmacies: {
  count: number | null;
  error: { message: string } | null;
}): string | null {
  if (activePharmacies.error || activePharmacies.count === null) {
    return "Could not check this brick for active pharmacies, so it stays switched on. Try again.";
  }
  if (activePharmacies.count === 0) return null;
  return `${plural(activePharmacies.count, "active pharmacy still sits", "active pharmacies still sit")} on this brick, so it stays switched on. Move ${activePharmacies.count === 1 ? "it" : "them"} on SoS Mapping first.`;
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The names the old brick may keep as its history, best first: "<name> - <old area>", then the same
 * with the move date, then a counter. A candidate that would equal the moved brick's own name is
 * skipped (the database refuses the pair).
 */
export function historicalNameCandidates(input: {
  brickName: string;
  fromAreaName: string;
  movedOn: string;
  newBrickName: string;
}): string[] {
  const name = input.brickName.trim().replace(/\s+/g, " ");
  const area = input.fromAreaName.trim().replace(/\s+/g, " ");
  const base = area ? `${name} - ${area}` : `${name} (history)`;
  const candidates = [base, `${base} (moved ${input.movedOn})`];
  for (let n = 2; n <= 20; n += 1) candidates.push(`${base} (moved ${input.movedOn}, ${n})`);
  const taken = normalizeName(input.newBrickName);
  return candidates.filter((candidate) => normalizeName(candidate) !== taken);
}
