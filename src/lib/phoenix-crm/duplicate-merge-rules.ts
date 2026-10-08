/**
 * Phoenix CRM — which row of a same-person duplicate STAYS, with no I/O.
 *
 * Owner, 2026-10-08: "auto-merge the proven duplicates, with a pre-image and a report". The set is the
 * duplicates board's own (`groupSameRepDuplicates` in server/duplicate-customers.ts — one seat, one
 * list type, one folded name, no speciality conflict), so the merge acts on exactly what he was shown.
 * This file decides, for one such group, which customer ROW is kept; the one-off script
 * scripts/phoenix-crm-merge-same-seat-duplicates.ts reads the rows and writes the report, and
 * `public.phoenix_crm_merge_duplicate_customer` does the write in one transaction.
 *
 * 🔴 IT CHOOSES A ROW, NEVER A DOORWAY. Places are many-to-one on the customer, so the keeper receives
 * every place the others held and nothing is retired. The order, and why each key sits where it does:
 *
 *   1. The row holding an ACTIVE place — a validated doorway is the hardest thing to recreate.
 *   2. A validated row before one never validated.
 *   3. More visits saved — the rep's own work stays on the row he will keep seeing.
 *   4. The older row, then the lower id — the same group always resolves the same way.
 *
 * Measured 2026-10-08 this resolves all 172 groups with no judgement call. Two things still REFUSE a
 * group, and the report names each one: rows that disagree on the list type (the board's key makes it
 * impossible, the guard keeps it so), and a keeper that would cross the five-active-place cap.
 *
 * 🔴 NOTHING IS COPIED FROM A LOSER. Grade, potential, phone, the primary pharmacy and the intake
 * fields stay the keeper's own; a loser's differing value is LISTED (`notCopied`) for the report.
 * Copying a grade would write one nobody set.
 */

/** The five-active-place cap a customer carries everywhere else in the module. */
export const MERGE_ACTIVE_PLACE_CAP = 5;

export type MergeCandidate = {
  customerId: string;
  name: string;
  listType: string;
  activePlaces: number;
  validatedAt: string | null;
  visits: number;
  createdAt: string;
  /** Whether the row has a move on record. The RPC refuses such a loser rather than rewrite history. */
  hasMoves: boolean;
  grade: string | null;
  potentialGrade: string | null;
  phone: string | null;
  primaryPharmacyName: string | null;
};

export type MergeRefusal = "list_type_differs" | "too_many_places" | "loser_has_moves" | "keeper_not_validated";

export type MergeNotCopied = { field: "grade" | "potential" | "phone" | "primary pharmacy"; fromName: string; value: string };

export type MergePlan =
  | { ok: true; keeper: MergeCandidate; losers: MergeCandidate[]; why: string; notCopied: MergeNotCopied[] }
  | { ok: false; refused: MergeRefusal; rows: MergeCandidate[] };

/** The keep order, as a comparator: negative when `left` should be kept over `right`. */
export function keepOrder(left: MergeCandidate, right: MergeCandidate): number {
  return (
    Number(right.activePlaces > 0) - Number(left.activePlaces > 0) ||
    Number(right.validatedAt !== null) - Number(left.validatedAt !== null) ||
    right.visits - left.visits ||
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    left.customerId.localeCompare(right.customerId)
  );
}

/** Why the keeper won, in plain words, read off the first key that separated it from the runner-up. */
export function keepReason(keeper: MergeCandidate, runnerUp: MergeCandidate): string {
  if (keeper.activePlaces > 0 && runnerUp.activePlaces === 0) return "It holds the validated place";
  if (keeper.validatedAt !== null && runnerUp.validatedAt === null) return "It is the validated row";
  if (keeper.visits !== runnerUp.visits) return "It carries more saved visits";
  if (Date.parse(keeper.createdAt) !== Date.parse(runnerUp.createdAt)) return "It was entered first";
  return "Both rows are alike; the first entered is kept";
}

const FIELDS: ReadonlyArray<[MergeNotCopied["field"], (row: MergeCandidate) => string | null]> = [
  ["grade", (row) => row.grade],
  ["potential", (row) => row.potentialGrade],
  ["phone", (row) => row.phone],
  ["primary pharmacy", (row) => row.primaryPharmacyName],
];

/** The merge for ONE group of the board's duplicates. Pure. */
export function planMerge(rows: readonly MergeCandidate[]): MergePlan {
  if (rows.length < 2) throw new Error("phoenix-crm: a merge needs at least two rows");
  if (new Set(rows.map((row) => row.listType)).size > 1) return { ok: false, refused: "list_type_differs", rows: [...rows] };
  const totalActive = rows.reduce((sum, row) => sum + Math.max(0, row.activePlaces), 0);
  if (totalActive > MERGE_ACTIVE_PLACE_CAP) return { ok: false, refused: "too_many_places", rows: [...rows] };

  const ordered = [...rows].sort(keepOrder);
  const [keeper, ...losers] = ordered;
  if (losers.some((row) => row.hasMoves)) return { ok: false, refused: "loser_has_moves", rows: [...rows] };
  // The place key outranks the validated key, so a held (never validated) row with a place can beat a
  // validated row with none. The RPC refuses that shape; refusing it here names it in the report.
  if (keeper.validatedAt === null && losers.some((row) => row.validatedAt !== null)) {
    return { ok: false, refused: "keeper_not_validated", rows: [...rows] };
  }

  const notCopied: MergeNotCopied[] = [];
  for (const loser of losers) {
    for (const [field, read] of FIELDS) {
      const theirs = read(loser);
      if (theirs !== null && theirs !== read(keeper)) notCopied.push({ field, fromName: loser.name, value: theirs });
    }
  }
  return { ok: true, keeper, losers, why: keepReason(keeper, losers[0]), notCopied };
}

/** The refusal, in the report's words. */
export function mergeRefusalText(refused: MergeRefusal): string {
  if (refused === "list_type_differs") return "The rows sit on different lists (AM, PM or pharmacy), so they are not one entry typed twice";
  if (refused === "too_many_places") return `Kept together they would hold more than ${MERGE_ACTIVE_PLACE_CAP} active places`;
  if (refused === "keeper_not_validated") return "The row holding the place is not the validated one, so neither can be kept without a judgement call";
  return "One of the rows was moved between reps, and that history is not rewritten";
}
