/**
 * Phoenix CRM — Place checks: the sets the Super Admin's board is handed, made from what was read.
 *
 * 🔴 ONE FUNCTION FOR THE PAGE AND FOR THE READ BEHIND THE CLICK (owner, 23 Nov 2026: "Fix speed next").
 * The page opens on a narrow read — the places waiting, the buildings, the places seated in them and the
 * decisions of the last 14 days — and every figure counted over every place in use is counted by a second
 * read the board asks for once it is on screen (`server/place-checks-wide-read.ts`). Both sort their rows
 * here, so the list he decides from and the numbers on the tabs can never be sorted by two rules: which
 * place waits on this board and which on the SFE recommendations page, which building is still held, and
 * which decision note is already drawn as a comment.
 *
 * Pure and screen-free: the server page and the server read both import it.
 */

import { decisionNoteIsAComment, placeNoteSubjectKey } from "@/lib/phoenix-crm/place-note-rules";
import { withoutDecisionNotesThatAreComments } from "@/lib/phoenix-crm/place-checks-on-demand";
import { sfeRecommendationOf, withoutSfeRecommended } from "@/lib/phoenix-crm/sfe-recommendations";
import type { PlaceNoteIndex, SharedPlaceBoardRow, ValidationReviewRow } from "@/lib/phoenix-crm/view-types";

export type PlaceChecksBoardSets = {
  /** Every review row read, a decision note that is already a comment taken off it. */
  rows: ValidationReviewRow[];
  /** The places waiting on this board. */
  waiting: ValidationReviewRow[];
  decided: ValidationReviewRow[];
  /** Every building on this board. */
  sharedPlaces: SharedPlaceBoardRow[];
  /** The real checks waiting on the SFE recommendations page: the same rule that took them out of here. */
  sfeRecommendedCount: number;
};

export function placeChecksBoardSets(input: {
  /** The Super Admin, who decides. The SFE Manager reads the same board and keeps every row. */
  decides: boolean;
  reviews: ReadonlyArray<ValidationReviewRow>;
  sharedPlaces: ReadonlyArray<SharedPlaceBoardRow>;
  notes: Pick<PlaceNoteIndex, "notes" | "recommendations">;
}): PlaceChecksBoardSets {
  const { decides, notes } = input;
  // A comment written with a decision is on the row as a comment too (`tellDecisionComment`), so it is
  // drawn there, under "The rep can read this", and not a second time beside the decision.
  const rows = withoutDecisionNotesThatAreComments(input.reviews, notes.notes);
  const everySharedPlace = input.sharedPlaces.map((row) =>
    decisionNoteIsAComment(row.decisionNote, notes.notes[placeNoteSubjectKey("shared_place", row.sharedPlaceId)] ?? []) ? { ...row, decisionNote: null } : row,
  );
  // 🔴 WHAT THE SFE MANAGER RECOMMENDED WAITS ON ITS OWN PAGE, NOT HERE (owner, 2026-11-19) — for the Super
  // Admin. The SFE Manager keeps every row, so he can see and change what he recommended.
  const everyWaiting = rows.filter((row) => row.status === "pending");
  const waiting = decides ? withoutSfeRecommended(everyWaiting, (row) => placeNoteSubjectKey("place", row.placeId), notes.recommendations) : everyWaiting;
  const heldVenues = everySharedPlace.filter((row) => row.status === "held");
  const keptHeldVenues = new Set(
    (decides ? withoutSfeRecommended(heldVenues, (row) => placeNoteSubjectKey("shared_place", row.sharedPlaceId), notes.recommendations) : heldVenues).map(
      (row) => row.sharedPlaceId,
    ),
  );
  const sharedPlaces = everySharedPlace.filter((row) => row.status !== "held" || keptHeldVenues.has(row.sharedPlaceId));
  const sfeRecommendedCount =
    everyWaiting.filter((row) => !row.isTest && sfeRecommendationOf(notes.recommendations, placeNoteSubjectKey("place", row.placeId)) !== null).length +
    heldVenues.filter((row) => !row.isTest && sfeRecommendationOf(notes.recommendations, placeNoteSubjectKey("shared_place", row.sharedPlaceId)) !== null).length;
  return { rows, waiting, decided: rows.filter((row) => row.status !== "pending"), sharedPlaces, sfeRecommendedCount };
}
