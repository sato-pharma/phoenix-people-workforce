/**
 * Place checks — the rows each section of the page reads.
 * Moved out of `validation-reviews.ts` unchanged on 23 Nov 2026, so no file of Place checks is over 400
 * lines; that file re-exports everything here that it exported, so import from it.
 */

import type { EarlierDecision } from "@/lib/phoenix-crm/earlier-decision";
import type { GoogleListing } from "@/lib/phoenix-crm/google-place-rules";
import type { ScheduleHeldBecause, ScheduleLegibility, ScheduleProblem } from "@/lib/phoenix-crm/schedule-rules";
import type { SignboardPhotoProblem } from "@/lib/phoenix-crm/signboard-rules";
import type { ValidationPhotoKind } from "@/lib/phoenix-crm/validation-feedback";

// ── The Super Admin's page ──────────────────────────────────────────────────────────────────────

export type ValidationReviewReading = { lat: number; lon: number; accuracyMeters: number | null };

export type ValidationReviewRow = {
  reviewId: string;
  /**
   * The PLACE this review is about. Carried since 2026-10-13 because a comment and a recommendation
   * hang off the place, not off the review: a place has exactly one review row for all time
   * (`phoenix_crm_validation_reviews_place_idx`), while most of the places a manager comments on have
   * no review row at all — 598 of the module's first 643 had never been looked at by anybody.
   */
  placeId: string;
  status: "pending" | "approved" | "rejected";
  kind: "validation" | "added_place";
  isTest: boolean;
  createdAt: string;
  createdAtText: string;
  /** A waiting review only: how long it has waited for a decision, in the board's words. Null once decided. */
  waitingText?: string | null;
  /** A waiting review only: it has waited `WAITING_LONG_HOURS` or more. */
  waitingLong?: boolean;
  repName: string;
  territory: string;
  /** The seat's line and region, carried apart from `territory` so the page can filter by each. */
  line: string | null;
  region: string | null;
  customerName: string;
  listType: string;
  speciality: string | null;
  placeLabel: string | null;
  address: string | null;
  brickName: string | null;
  areaName: string | null;
  point: { lat: number; lon: number };
  mapsLink: string;
  pin: ValidationReviewReading | null;
  photo: ValidationReviewReading | null;
  /** The signboard photo, signed on the page by the CRM's own photo link (the Super Admin reads all). */
  photoPath: string | null;
  /**
   * Why the system held it, and every listing Google returned for the name. Since 2026-10-08 a place
   * can also be held for what its SIGNBOARD says (`sign_other_name` / `sign_no_name`), and since
   * 2026-10-09 for what the TIMETABLE inside a polyclinic says (`schedule_other_name` /
   * `schedule_missing`); the record sits in the same `google` column either way — see
   * `signboardHoldRecord` for why that column's name is the wrong one rather than the code.
   */
  reason:
    | "no_confident_listing"
    | "lookup_failed"
    | "listing_far"
    | "listing_off"
    | "refused_by_admin"
    | "sign_other_name"
    | "sign_no_name"
    | "schedule_other_name"
    | "schedule_missing"
    | null;
  /**
   * WHICH PHOTO this row is about, so the Super Admin is offered only the refusal reasons that can
   * honestly be said about it (`reasonsFor`): a timetable is paper on purpose, so "a photo of paper,
   * not a building" must never be offered on one.
   */
  photoKind: ValidationPhotoKind;
  /** The polyclinic or centre the customer is seated in — set on a timetable hold only. */
  sharedPlaceName: string | null;
  /**
   * The venue this place is seated in, read off the PLACE row and so set whatever the hold was about
   * (owner, 2026-10-17: group every polyclinic with the customers in it). `sharedPlaceName` above
   * rides the hold's record and is null on a review that is not a timetable hold; this is how the
   * Place checks board files every such row under its building instead of among the single clinics.
   */
  sharedPlaceId: string | null;
  /** The hours read beside this customer's name on the timetable, as written. Evidence, never parsed. */
  hoursRead: string | null;
  /**
   * The evidence the system's RECOMMENDATION is built from (owner, 2026-10-17: "add system
   * recommendations to approve or no on every validation … and the reason"): the record's own reason
   * as written (`unreadable`, `call_failed` …, which the narrower `reason` above drops), why the
   * timetable scanner held it and how much of the board it could read, and what was read on the
   * place's own signboard — a Google hold carries no reading of the sign in its record, but the place
   * row does. See `place-check-advice.ts`.
   */
  evidence: {
    checkReason: string | null;
    heldBecause: ScheduleHeldBecause | null;
    legibility: ScheduleLegibility | null;
    problem: ScheduleProblem | null;
    uploaded?: boolean;
    signboard: {
      verdict: "match" | "other_name" | "no_name" | "unjudged";
      reason: string | null;
      signText: string | null;
      problem?: SignboardPhotoProblem | null;
    } | null;
  };
  /** What the system read on the signboard — or on the timetable — verbatim. */
  signText: string | null;
  /** The names the system read on it, people and places together, for the Super Admin's eye. */
  signNames: string[];
  /**
   * The OTHER signs that were in the same photograph, as read — the clothes shop beside the practice,
   * the room number, the pharmacy next door.
   *
   * 🔴 IT IS WHY THE VERDICT IS WHAT IT IS. Four of the five holds of 2026-10-09 were a second sign in
   * the frame, and the board showed only the one that had been judged, so nothing on the screen could
   * tell him that the sign quoted to him was a clothes shop. Empty for a timetable hold and for a hold
   * recorded before the reader returned a list.
   */
  otherSigns: string[];
  /** What was wrong with the photo, as the Super Admin chose it on a rejection — his label, not the rep's sentence. */
  refusalLabel: string | null;
  query: string | null;
  listings: Array<GoogleListing & { distanceMeters: number }>;
  /** Who decided it. 🔴 Null for a viewer who decides nothing: a field a browser receives counts as shown (owner, 2026-10-13). */
  decidedByName: string | null;
  /**
   * The rule the system approved this place under by itself (`sign-wins-rules.ts`), while that approval
   * stands. Null when a person decided it, when it still waits, and once he has taken it back.
   */
  approvedByRule?: string | null;
  decidedAtText: string | null;
  /** The raw instant, for the reads and filters that compare it. `decidedAtText` is for the screen. */
  decidedAt: string | null;
  /**
   * What the decider wrote. 🔴 Null for a viewer who decides nothing: a comment reaches a manager as a
   * place note, by role (`tellDecisionComment`, and for the older ones the copy of 2026-11-01), never
   * through this field.
   */
  decisionNote: string | null;
  /**
   * Whether this rejection can still be taken back (owner, 2026-10-03: "add the option to approve
   * after reject"): the place is still retired, and nothing newer has been said about it.
   */
  restorable: boolean;
  /**
   * A rejection whose place is still retired, but the customer was captured again at the same door since
   * (another active place of his in the same building or within 150 m): the database refuses the take-back
   * (`restore_door_captured_again`), so `restorable` is false and the row says why instead (19 Nov 2026).
   */
  capturedAgain?: boolean;
  /**
   * A WAITING review only: the customer's latest decision made before this capture, when there is one
   * (owner, 22 Nov 2026: "the same place that I accepted or rejected is as it is"). A rep told "Validate
   * again" often captures the same door at once, and the new row read exactly like the one just decided.
   * Absent on a decided row, on a customer never decided, and when the read of the earlier ones failed.
   */
  earlierDecision?: EarlierDecision | null;
  /**
   * Whether this APPROVAL can still be taken back (owner, 2026-10-15: "make admin able to reject
   * validation even if approved before"): the place it approved is still active, so rejecting it now
   * has something to retire. The mirror image of `restorable`, and the same test the database makes.
   */
  refusable: boolean;
  /**
   * 🔴 The Super Admin approved this (or created the place himself), so nobody else may reject it (owner,
   * 2026-11-16). Always false for a Super Admin viewer; when true, `refusable` is false too.
   */
  lockedBySuperAdmin?: boolean;
  /**
   * A door signboard hold the system is still re-reading (owner, 2026-10-17: "Hold; re-read; else you
   * decide"). He may still decide it now; the row says the system has not finished with it.
   */
  systemStillReading: boolean;
  /**
   * Whether the board shows this row with no decider chosen: waiting, decided in the last 14 days, or a
   * rejection still taken back within 90. Always true unless the read asked for `everyDecision`.
   */
  recent: boolean;
};

/** A read the page presents, and whether it stopped at its ceiling so the page can say so honestly. */
export type ValidationBoardRead<T> = { rows: T[]; capped: boolean };

// ── Refusing a validation the system never held ─────────────────────────────────────────────────

/**
 * Only AM customers are checked against Google (`googleCheckApplies`), so a DOCTOR's validation — and
 * any AM one that matched its listing — is never held and never reaches the queue above. There was no
 * way to undo one: on 2026-10-03 a rep's validation had to be refused by hand in SQL.
 *
 * This is that, as a button. It writes the SAME review row the automatic check would have written —
 * `refused_by_admin`, in the rep's name, decided by the Super Admin — and then runs the SAME
 * `phoenix_crm_decide_validation_review` reject. So there is one reject path, one audit shape, and the
 * rep's own list reads `not_confirmed` in the system's automated wording either way (golden rule #1:
 * "do not show the rep that a person is accepting or rejecting").
 */

export type ValidatedPlaceRow = {
  placeId: string;
  customerId: string;
  customerName: string;
  listType: string;
  speciality: string | null;
  isTest: boolean;
  repName: string;
  territory: string;
  /** The seat's line and region, carried apart from `territory` so the page can filter by each. */
  line: string | null;
  region: string | null;
  validatedAt: string;
  validatedAtText: string;
  placeLabel: string | null;
  address: string | null;
  brickName: string | null;
  areaName: string | null;
  point: { lat: number; lon: number };
  mapsLink: string;
  pin: ValidationReviewReading | null;
  photo: ValidationReviewReading | null;
  photoPath: string | null;
  /**
   * Validated by the Super Admin on a trusted point (owner, 2026-11-10): no photograph exists, and the
   * screen says so in words rather than drawing a missing file.
   */
  trustedPoint?: boolean;
  /**
   * 🔴 The Super Admin approved this place (or created it himself — a trusted point), so nobody else may
   * refuse it (owner, 2026-11-16). Always false for a Super Admin viewer.
   */
  lockedBySuperAdmin?: boolean;
  /**
   * 🔴 Approved, and still under To validate: his building is still being checked, and its approval
   * validates him (migration 20261114062049). The board reads "Approved, waits for the building" —
   * never a decision still owed on HIM (owner, 2026-11-23, the Place checks audit).
   */
  waitsForBuilding?: boolean;
  /** Visits already measured against this place — refusing it un-places every one of them. */
  visits: number;
  /** Other active places this customer has: when there are none, refusing sends him back to To validate. */
  otherPlaces: number;
  /**
   * Whether ANY review row exists for this place, whatever its status. False is "never looked at by
   * anybody" — 598 of the first 643 places, which nothing on this page could say until 2026-10-08.
   */
  reviewed: boolean;
  /**
   * Who approved this place and when, from its one review row (owner, 2026-10-20). Null for a place
   * nobody has decided, and for a decision that predates the record. 🔴 The name is also null for a
   * viewer who decides nothing; the time stays, because the board's outcome filters read it.
   */
  decidedByName: string | null;
  decidedAtText: string | null;
  /**
   * What the system read on this place's signboard: null when it has not been read yet. A verdict,
   * never a decision — the Super Admin decides each one himself (owner, 2026-10-08).
   */
  /**
   * 🔴 `reason` IS CARRIED BECAUSE `unjudged` IS FOUR DIFFERENT ANSWERS SINCE 2026-10-09, and one
   * sentence for all four would be wrong for three of them: a frame that will be read again, one
   * that has had every attempt it gets, a verdict two readings disagreed about, and a place there is
   * nothing to compare at all. Before the re-read existed they were one state and one sentence.
   */
  signboard: {
    verdict: "match" | "other_name" | "no_name" | "unjudged";
    reason: string | null;
    signText: string | null;
    /** The photo shows no readable name and the rep has been asked for a new one (2026-10-18). */
    retake?: boolean;
    /** What the reader said stops the name being read; `none` is a legible sign that did not confirm. */
    problem?: SignboardPhotoProblem | null;
  } | null;
  /**
   * Which photo this place's evidence IS — the sign on a building, or the timetable of a polyclinic —
   * so the refusal pick-list offered here matches the one the hold queue offers (`reasonsFor`).
   *
   * Read from `shared_place_id`, not from `point_source`: a seated place the Super Admin later MOVES
   * becomes `point_source = 'moved'`, and its evidence is still a timetable.
   */
  photoKind: ValidationPhotoKind;
  /** The polyclinic or centre this place sits in, when it is seated in one. */
  sharedPlaceName: string | null;
  /** That venue's id, so the board files this place under its building (owner, 2026-10-17). */
  sharedPlaceId: string | null;
  /**
   * What the system read on the timetable: null when this place is not seated or was not read. The
   * reason, legibility and problem are the recommendation's evidence (`place-check-advice.ts`).
   */
  schedule: {
    verdict: "match" | "other_name" | "no_schedule" | "unjudged";
    scheduleText: string | null;
    hoursRead: string | null;
    reason?: string | null;
    legibility?: ScheduleLegibility | null;
    problem?: ScheduleProblem | null;
    uploaded?: boolean;
  } | null;
};
