/**
 * Phoenix CRM — Place checks: the wide read, made behind the page and never before it (owner, 23 Nov
 * 2026: "Fix speed next").
 *
 * Every place in use (7,124 that day, 13 MB as read) and every decision ever made (2,377) took 9.75 s to
 * read on production, and the page made both before it drew the first waiting place — 12.2 s to the first
 * row — only to count the figures on the tabs and to leave the rows for a click. The page now opens on
 * what it sends (`loadValidatedPlaces(viewer, { seatedOnly: true })` and the 14-day decisions), and this
 * read is asked for by the board once it is on screen:
 *
 *   · `PLACE_CHECKS_SUMMARY_ROUTE` runs it, answers the figures (`summary`) and leaves the rows for the
 *     click (`server/place-checks-handoff.ts`);
 *   · `PLACE_CHECKS_EVERYTHING_ROUTE` takes those rows, or runs it itself when none are there.
 *
 * 🔴 THE FIGURES ARE COUNTED FROM THE SAME ROWS THE CLICK IS HANDED, by the board's own functions
 * (`placeChecksSummary`), and the rows are sorted by the page's own rule (`placeChecksBoardSets`). So the
 * number on a tab before the click and the rows under it after the click cannot disagree.
 *
 * 🔴 THE NOTES AND THE EVIDENCE COME WITH THE ROWS. The page reads comments, recommendations and integrity
 * cases for the rows it sends and no others, so this read loads them for every row it answers, with the
 * company page's own call (every note kept, the viewer's own recommendation marked).
 *
 * The company board's readers alone: both routes gate on `approve` and `readsCompanyPlaceChecks` before
 * they call it. A district manager's board is drawn whole by its own page and never asks.
 */

import { placeChecksBoardSets } from "@/lib/phoenix-crm/place-checks-board-sets";
import { placeChecksSummary, type PlaceChecksEverything, type PlaceChecksSummary } from "@/lib/phoenix-crm/place-checks-on-demand";
import { DECIDED_SHOWN_DAYS } from "@/lib/phoenix-crm/server/validation-reviews/shared";
import type { PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadPlaceCheckIntegrity } from "@/lib/phoenix-crm/server/integrity-board";
import { loadPlaceNoteIndex } from "@/lib/phoenix-crm/server/place-notes";
import { loadSharedPlaceBoard } from "@/lib/phoenix-crm/server/shared-places";
import {
  canDecideValidationReviews,
  loadReopenedCustomers,
  loadValidatedPlaces,
  loadValidationReviews,
} from "@/lib/phoenix-crm/server/validation-reviews";

export type PlaceChecksWideRead = { everything: PlaceChecksEverything; summary: PlaceChecksSummary };

export async function readPlaceChecksWide(viewer: PhoenixCrmViewer): Promise<PlaceChecksWideRead> {
  const decides = canDecideValidationReviews(viewer);
  const subjectReads = Promise.all([
    // Every decision, so "Decided by" can answer for all of them (owner, 2026-10-26); the board shows the
    // ones outside the 14-day window only while a decider is chosen (`recent`).
    loadValidationReviews(viewer, { everyDecision: true }),
    loadValidatedPlaces(viewer),
    loadSharedPlaceBoard(viewer),
  ]);
  const [[reviews, validatedRead, sharedRead], reopenedRead, [notes, integrity]] = await Promise.all([
    subjectReads,
    loadReopenedCustomers(viewer),
    // The comments and the evidence start the moment the three lists that name the subjects are in.
    subjectReads.then(([reviewRows, validatedRows, sharedRows]) => {
      const subjects = {
        placeIds: [...reviewRows.rows.map((row) => row.placeId), ...validatedRows.rows.map((row) => row.placeId)],
        sharedPlaceIds: sharedRows.rows.map((row) => row.sharedPlaceId),
      };
      return Promise.all([loadPlaceNoteIndex(subjects, { viewerHrId: viewer.hrId }), loadPlaceCheckIntegrity(viewer, subjects)]);
    }),
  ]);
  const validated = validatedRead.rows;
  const capped = { reviews: reviews.capped, validated: validatedRead.capped };
  const sets = placeChecksBoardSets({ decides, reviews: reviews.rows, sharedPlaces: sharedRead.rows, notes });
  // The Figures tab's two decision cards count the last 14 days by the day of the decision. The page counted
  // them from every recent decision it read; it reads only the seated ones now, so they are counted here.
  const decidedSince = Date.now() - DECIDED_SHOWN_DAYS * 86_400_000;
  const summary = placeChecksSummary({ team: false, lanes: decides, pending: sets.waiting, decided: sets.decided, validated, reopened: reopenedRead.rows, sharedPlaces: sets.sharedPlaces, capped, decidedSince });
  return {
    everything: {
      validated,
      // Every building and every customer sent back: the page sends only the buildings that need a decision
      // and the customers seated in them (`venuesSentWithPage`); the Polyclinics tab and History draw these.
      sharedPlaces: sets.sharedPlaces,
      reopened: reopenedRead.rows,
      // Every decision: the board keeps the page's copy of any row the page also sent (`mergeDecided`), so
      // this read needs no knowledge of what the page chose to send.
      olderDecided: reviews.rows.filter((row) => row.status !== "pending"),
      noteIndex: { ...notes, integrity },
      capped,
      // The same two figures the summary answers, so the cards do not move when the rows arrive.
      decisionFigures: summary.decisionFigures,
    },
    summary,
  };
}
