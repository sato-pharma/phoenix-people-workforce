/**
 * Phoenix CRM — Place checks: what the board is handed, and the tabs it has.
 *
 * Types and one pure switch, so every file of the board can name them without importing a component.
 */

import type { ReactNode } from "react";

import type { PlaceCheckNotesMode } from "@/components/phoenix-crm/place-check-notes";
import type { ScoreTarget } from "@/components/phoenix-crm/place-check-scorecard";
import type { PlaceChecksSummary, UnconfirmedChip } from "@/lib/phoenix-crm/place-checks-on-demand";
import type { PlaceCheckAgreement } from "@/lib/phoenix-crm/place-check-stored-advice";
import type { SignWinsSwitch } from "@/lib/phoenix-crm/sign-wins-rules";
import type { FailingTimetablesView, PlaceNoteIndex, ReopenedCustomerRow, SharedPlaceBoardRow, ValidatedPlaceRow, ValidationReviewRow } from "@/lib/phoenix-crm/view-types";
// Types only: this board is also a district manager's portal page, and the review is not his.
import type { PlaceReviewDeckInput } from "@/lib/place-review-deck/slides";

/**
 * The tabs, in the order the work is done (the rebuild, 23 Nov 2026; the first five were the owner's of
 * 2026-10-17):
 * - `ready`       — the Super Admin's alone: the open decisions whose evidence is the kind he approves 19
 *                   times in 20. One press approves the lane; nothing is approved until he presses;
 * - `needs`       — everything else waiting for a decision. On his board it is "Your call", each row with
 *                   the one reason it is his; on the SFE Manager's and a district manager's board, which
 *                   have no lanes, it is every waiting place in one list;
 * - `history`     — what was decided in the last 14 days, and who is waiting to be captured again;
 * - `bySystem`    — the Super Admin's alone: what the system approved by itself (`sign-wins-rules.ts`), each
 *                   with its take-back;
 * - `unconfirmed` — clinics in use that the reader never confirmed and nobody has looked at — the
 *                   unreadable photographs;
 * - `polyclinics` — every building, one card each, with its sign, its timetable and the customers in it;
 * - `samePlace`   — the same place seen by two or more reps, the company board's alone, read when first
 *                   opened (owner, 2026-10-17: "a place validated by more than a rep");
 * - `sameCustomer` — one customer validated by two or more reps at places that do not agree, read when
 *                   first opened (owner, 2026-10-26, "Build the check");
 * - `lineLookalikes` — the same customer on another rep's list, same area, another line, written another
 *                   way — the Super Admin confirms each pair, his alone (owner, 2026-11-16);
 * - `scorecard`   — each rep's captures, and how often his decisions matched the system's advice. It
 *                   headed the company board until the rebuild; a district manager's board still opens
 *                   with it;
 * - `slot:<key>`  — a tab the PAGE hands in (the Super Admin's page: the held full names, the figures).
 */
export type PlaceCheckView =
  | "ready"
  | "needs"
  | "history"
  | "bySystem"
  | "unconfirmed"
  | "polyclinics"
  | "samePlace"
  | "sameCustomer"
  | "lineLookalikes"
  | "scorecard"
  | `slot:${string}`;

/** A tab whose content the page draws itself, so the board carries none of it into the portal's bundle. */
export type PlaceCheckSlot = {
  /** Letters, digits and dashes: it is the tab's key in the address, behind `slot:`. */
  key: string;
  label: string;
  /** A count beside the label, or null for none. */
  count: number | null;
  content: ReactNode;
};

export type PlaceCheckBoardProps = {
  /** Whose board this is — see the header. "company" is the Super Admin's and the SFE Manager's, "team" a district manager's. */
  mode: PlaceCheckNotesMode;
  /** Every comment and recommendation on this page's subjects, keyed by `placeNoteSubjectKey`. */
  noteIndex: PlaceNoteIndex;
  pending: ValidationReviewRow[];
  decided: ValidationReviewRow[];
  validated: ValidatedPlaceRow[];
  /** Customers sent back to To validate and not captured again since — oldest wait first. */
  reopened: ReopenedCustomerRow[];
  /** Every polyclinic and centre in use, waiting for a decision, or rejected and still restorable. */
  sharedPlaces: SharedPlaceBoardRow[];
  /**
   * The buildings whose timetable keeps being refused (owner, 14 Nov 2026), drawn above the Polyclinics
   * list. The deciders' page alone hands it in; a district manager's board never does.
   */
  failingTimetables?: FailingTimetablesView;
  /** Which reads stopped at their ceiling, so the page says "showing the newest" instead of lying. */
  capped: { reviews: boolean; validated: boolean; reopened: boolean; sharedPlaces: boolean };
  /**
   * 🔴 THE SUPER ADMIN'S PAGE SENDS WHAT NEEDS YOU DRAWS, AND THE REST WAITS FOR THE CLICK (owner,
   * 2026-11-14, "Load lists on demand"; `place-checks-on-demand.ts`). With it, `validated` is only the
   * places seated in a building and `decided` only the last 14 days; `summary` holds every opening figure
   * counted on the server, and every place in use and every older decision are read from
   * `PLACE_CHECKS_EVERYTHING_ROUTE` on the first click that needs them. Without it (a manager's page) the
   * board is handed every row, as it always was.
   */
  onDemand?: { summary: PlaceChecksSummary; readAt: string };
  /**
   * The one-by-one review (owner, 2026-10-18), handed in by the Super Admin's page and drawn on his
   * board alone. It is a render prop rather than an import so the review is in none of the portal's
   * bundles; the board hands it what each of its tabs holds right now, filters applied, and whether it
   * holds every row yet — the review asks for them (`want`) and opens once they are in (`ready`).
   */
  reviewDeck?: (input: PlaceReviewDeckInput, everything: { ready: boolean; want: () => void; error: string | null; retry: () => void }) => ReactNode;
  /**
   * The rule that approves by itself (`sign-wins-rules.ts`), as the page read it. Null is "could not be
   * read", and the header says so; a board that is not the Super Admin's is never handed it.
   */
  signWins?: SignWinsSwitch | null;
  /** How often his decisions matched the advice over the last 30 days. Null is "could not be read". */
  agreement?: PlaceCheckAgreement | null;
  /** The checks waiting on the SFE recommendations page, and where that page is. The Super Admin's alone. */
  sfeRecommended?: { count: number; href: string };
  /** Tabs the page draws itself, after the board's own. */
  slots?: ReadonlyArray<PlaceCheckSlot>;
};

/** One tab of the strip. `open` is the "N waiting" pill, drawn only on a board with no lanes. */
export type PlaceCheckTab = { key: PlaceCheckView; label: string; count: number | null; open?: number };

/** Every narrowing of Not confirmed, in the order its chips are drawn. */
export const UNCONFIRMED_CHIPS: ReadonlyArray<UnconfirmedChip> = ["open", "notReadable", "wrongPhoto", "anotherName", "notRead", "all"];

/**
 * Where a scorecard count's own rows are (owner, 2026-10-17: "make me see what is the unreadable — the
 * photos"): a photo problem or a sign never read is that standing's narrowing of Not confirmed, a place
 * waiting is Needs you, a customer sent back is History, and the timetable count is the buildings.
 */
export function placeOfTarget(target: ScoreTarget): { view: PlaceCheckView; chip: UnconfirmedChip | null } {
  switch (target) {
    case "waiting":
      return { view: "needs", chip: null };
    case "sentBack":
      return { view: "history", chip: null };
    case "timetable":
      return { view: "polyclinics", chip: null };
    default:
      return { view: "unconfirmed", chip: target };
  }
}
