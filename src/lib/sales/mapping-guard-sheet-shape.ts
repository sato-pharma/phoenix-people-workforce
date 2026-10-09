// The held-changes workbook — the SHAPE only: the types the screen and the server both use, and the
// words for each answer.
//
// WHY THIS IS ITS OWN FILE. The review screen is a `"use client"` component, and the workbook module
// beside it reaches `node:crypto` and ExcelJS. Webpack refuses a Node builtin in a client bundle, so
// the component may import TYPES from here and nothing else about the sheet.
// `tests/client-bundle-server-leak.test.ts` is what catches a regression.
//
// Nothing here may import anything that is not itself client-safe.

/**
 * Is this mapping row one of HIS decisions? The guard's own test, word for word (the trigger holds a
 * change as "overwrites a mapping decision of yours" when the row's source starts `owner-` or
 * `final-new-`, or is `sheet-verified`) — plus a confidence of 100, which a lock stamps. Reading
 * confidence alone missed every hold the guard itself called a ruling.
 */
export function isOwnerRuling(source: string | null | undefined, confidence: number | string | null | undefined): boolean {
  const text = String(source ?? "");
  if (text.startsWith("owner-") || text.startsWith("final-new-") || text === "sheet-verified") return true;
  return Number(confidence ?? 0) >= 100;
}

/** What he can say about a held change in the sheet. */
export type GuardAnswer = "allow" | "keep" | "move";

/** The words the sheet's Your Answer column offers, and the only ones the reader trusts. */
export const GUARD_ANSWER_LABEL: Record<GuardAnswer, string> = {
  allow: "Allow",
  keep: "Keep as is",
  move: "Move to my brick",
};

/** A brick with the area and governorate it sits in, all as names he reads. */
export type GuardGeo = {
  brickId: string;
  brickName: string;
  areaCode: string;
  areaName: string;
  regionCode: string;
  regionName: string;
};

/** One answered row, as the apply step receives it. The server re-checks every field against live state. */
export type GuardInstruction = {
  holdId: number;
  /** The brick the sheet said the customer sat in when it was exported — the stale-sheet check. */
  nowBrickId: string;
  answer: GuardAnswer;
  moveToBrickId: string;
  lock: boolean;
};

export type GuardPlanRow = GuardInstruction & {
  /** The row of the customer map this hold is about; the server needs it, the screen ignores it. */
  rowId: number;
  customer: string;
  /** "Brick · Area · Governorate", names only. */
  from: string;
  to: string;
  trackedValue: number;
  /** The part of it that sits in months already finished. */
  restatedValue: number;
  /** The mapping carries his own earlier ruling (confidence 100) and this answer replaces it. */
  overridesRuling: boolean;
};

export type GuardProblem = {
  sheetRow: number;
  holdId: number | null;
  customer: string;
  reason: string;
};

export type GuardPlanPage = { digest: string; holdIds: number[] };

export type GuardPlan = {
  rows: GuardPlanRow[];
  problems: GuardProblem[];
  /** Rows he left blank — not an answer, so nothing happens to them. */
  skipped: number;
  counts: { allow: number; keep: number; move: number; locking: number };
  trackedValue: number;
  restatedValue: number;
  overridesRulings: number;
  /**
   * The ready rows in pages the apply step can carry, each with its own digest.
   *
   * The apply request restates the instructions and the server RE-PLANS them against live state; a
   * page whose digest no longer matches is refused, so what he confirmed in the preview is exactly
   * what is written — never something the sheet or the database drifted into since.
   */
  pages: GuardPlanPage[];
};

/** What happened to one answer when it was written. Shaped like the decide route's own outcomes. */
export type GuardApplyOutcome = {
  holdId: number;
  customer: string;
  ok: boolean;
  /** Why it was not written. Absent when it was. */
  reason?: string;
  /** Written, but one part needs a look — for example the original hold could not be closed. */
  warning?: string;
  locked: boolean;
  /** The sales move an approval carried, as the database reported it (parsed by the screen). */
  brickMove: unknown;
};

/** How many answers one apply request carries — each is several round trips to the database. */
export const GUARD_APPLY_PAGE_SIZE = 40;
