"use client";

/**
 * Phoenix CRM — Place checks: what waits for a decision.
 *
 * One panel, drawn three ways:
 * - the Super Admin's **Ready** lane: the one-press bar, then the rows it would approve;
 * - the Super Admin's **Your call** lane: why these are his, then the rows, ten a page;
 * - a board with no lanes (the SFE Manager's, a district manager's): every waiting place in the one list
 *   it always had, with the sentences it always had.
 *
 * 🔴 EVERY SENTENCE THAT NAMES A DECISION IS BEHIND `team`. A district manager's board says "still being
 * checked" and never whose decision it is.
 */

import { useState } from "react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { BulkPickLineSlot } from "@/components/phoenix-crm/place-check-bulk";
import { PAGE_BUILDINGS, PAGE_LANE, PAGE_ROWS, Paged } from "@/components/phoenix-crm/place-checks/paged";
import { ReadyLaneBar } from "@/components/phoenix-crm/place-checks/ready-lane-bar";
import { PlaceCheckSection } from "@/components/phoenix-crm/place-checks/section";
import type { PlaceCheckBoard } from "@/components/phoenix-crm/place-checks/use-place-check-board";
import { SharedPlaceList } from "@/components/phoenix-crm/shared-place-list";
import { ValidationReviewQueue } from "@/components/phoenix-crm/validation-review-queue";
import { PLACE_CHECK_LANE_LABEL } from "@/lib/phoenix-crm/place-check-lanes";
import { PLACE_APPROVAL_IS_NOT_A_LIST_ADD } from "@/lib/phoenix-crm/validation-feedback";

/** The line above Your call names this many reasons; every row says its own. */
const REASONS_SHOWN = 4;

export function PlaceChecksWaitingPanel({ board, lane }: { board: PlaceCheckBoard; lane: "ready" | "needs" }) {
  const { anyFilter, callGroups, callReviews, lanes, mode, noteIndex, pageKey, readyGroups, readyReviews, reasons, rowsShown, setRowsShown, showWaiting, team } = board;
  const ready = lane === "ready";
  const reviews = ready ? readyReviews : callReviews;
  const buildings = ready ? readyGroups : callGroups;
  const named = lanes ? PLACE_CHECK_LANE_LABEL[ready ? "ready" : "your_call"] : null;

  const clinicsTitle = named
    ? `${named}: clinics (${reviews.length})`
    : team ? `Still being checked (${reviews.length})` : `Waiting for your decision (${reviews.length})`;
  // 🔴 A LANE SAYS ONE SHORT LINE BESIDE ITS TITLE (`PlaceCheckSection`'s `lane`). What Approve and Reject do
  // is said on each row's own buttons and warnings, so Your call no longer repeats it above the list.
  const clinicsSaid = named
    ? ready
      ? "Held by the system, with evidence of the kind you approve. Approve them together above, or one by one here."
      : "Each row says why it is yours."
    : team
      ? "The places the system could not settle by itself: Google has no listing it is sure is the customer, its pin is far from where the rep stood, or the signboard names somebody else — or nobody. Each one's evidence is below, and the rep knows only that the system is checking."
      : `Approve validates the place in the rep's name, and a customer already on the rep's list starts counting. ${PLACE_APPROVAL_IS_NOT_A_LIST_ADD} Reject retires the place; a customer left without one goes back to To validate. The rep reads either as the system's answer.`;
  const buildingsTitle = named
    ? `${named}: polyclinics (${buildings.length})`
    : team ? `Polyclinics still being checked (${buildings.length})` : `Polyclinics waiting for your decision (${buildings.length})`;
  const buildingsSaid = named
    ? ready
      ? "A building held at its door, or customers waiting behind one, where nothing open is in doubt."
      : "A building held at its door, or a customer in it the timetable could not answer for. Each customer has a row under the building."
    : team
      ? "A building held at its door, or a customer seated in it whose timetable could not answer for them."
      : "A building held at its door, or a customer seated in it whose timetable does not name them or could not be read. Each building is shown whole, with its sign, its timetable and everybody seated in it.";

  // A lane draws a list only when it holds something; a board with no lanes keeps both of its lists, as before.
  const drawClinics = named ? reviews.length > 0 : showWaiting;
  const drawBuildings = named ? buildings.length > 0 : true;
  const nothing = named !== null && !drawClinics && !drawBuildings;
  const rowsPage = lanes ? PAGE_LANE : PAGE_ROWS;
  const buildingsPage = lanes ? PAGE_LANE : PAGE_BUILDINGS;
  // 🔴 A LANE'S "PICK ROWS" LINE STANDS IN ITS SECTION'S TITLE ROW (owner, 23 Nov 2026). As a box of its own
  // it stood 61 px between the title and the first waiting place. Each list's bar draws its line into the
  // slot its section hands it (`BulkPickLineSlot`); a board with no lanes hands none and keeps the bar whole.
  const [clinicsLine, setClinicsLine] = useState<HTMLDivElement | null>(null);
  const [buildingsLine, setBuildingsLine] = useState<HTMLDivElement | null>(null);

  // 🔴 "WHY THESE ARE YOUR CALL" STANDS IN THE FIRST LIST'S OWN HEAD (23 Nov 2026). As a band of its own
  // it stood 38 px, and a gap, above the first waiting place. One line until it is pressed: the commonest
  // reason, then the rest; open, the list drops under the title and each row still says its own.
  const why =
    lanes && !ready && reasons.length > 0 ? (
      <details className="group min-w-0" data-your-call-reasons>
        <summary className="flex min-h-11 min-w-0 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-slate-700 md:min-h-7 [&::-webkit-details-marker]:hidden">
          <span className="font-black text-slate-900">Why these are your call</span>
          {/* On a phone the commonest reason waits for the press with the others: it wrapped to three lines above the first waiting place. */}
          <span className="min-w-0 flex-1 basis-60 break-words group-open:hidden max-sm:hidden">
            <span className="font-black tabular-nums">{reasons[0].count}</span> · {reasons[0].because}
          </span>
          {reasons.length > 1 ? (
            <span className="ml-auto shrink-0 text-xs font-black text-orange-700 sm:ml-0">
              <span className="group-open:hidden">All {reasons.length} reasons</span>
              <span className="hidden group-open:inline">Close</span>
            </span>
          ) : null}
        </summary>
        <ul className="mt-1 space-y-0.5 pb-1 text-sm text-slate-700">
          {reasons.slice(0, REASONS_SHOWN).map(({ because, count }) => (
            <li key={because} className="break-words">
              <span className="font-black tabular-nums">{count}</span> · {because}
            </li>
          ))}
        </ul>
        {reasons.length > REASONS_SHOWN ? (
          <p className="mt-1 break-words pb-1 text-xs text-slate-500">
            And {reasons.length - REASONS_SHOWN} more {reasons.length - REASONS_SHOWN === 1 ? "reason" : "reasons"}. Each row says its own.
          </p>
        ) : null}
      </details>
    ) : null;
  // The fold rides the first list the lane draws; the other list says its own short line.
  const whyOnClinics = why !== null && drawClinics;
  const laneLine = (said: string, withWhy: boolean) => (lanes ? (withWhy ? why : said) : undefined);

  return (
    <>
      {ready ? <ReadyLaneBar board={board} /> : null}

      {nothing ? (
        <AdminCallout tone="success">
          <span>
            {anyFilter
              ? `Nothing in ${named} matches these filters.`
              : ready
                ? "Nothing is ready to approve in one press. What waits is in Your call."
                : "Nothing waits for your call."}
          </span>
        </AdminCallout>
      ) : null}

      {drawClinics ? (
        <PlaceCheckSection
          action={lanes && reviews.length > 0 ? <div className="min-w-0" data-pick-line-slot ref={setClinicsLine} /> : undefined}
          description={clinicsSaid}
          lane={laneLine(clinicsSaid, whyOnClinics)}
          title={clinicsTitle}
        >
          {reviews.length === 0 ? (
            <div className="px-4 py-4">
              <AdminCallout tone="success">
                <span>
                  {anyFilter
                    ? "Nothing waiting matches these filters."
                    : team
                      ? "Nothing of your team's is still being checked — every place has matched its listing, been refused at the door, or been settled."
                      : "Nothing is waiting — every place has matched its listing, been refused at the door, or been decided."}
                </span>
              </AdminCallout>
            </div>
          ) : (
            <BulkPickLineSlot.Provider value={lanes ? clinicsLine : undefined}>
              <Paged key={pageKey} initial={rowsShown} noun="places" onLimit={setRowsShown} rows={reviews} size={rowsPage}>
                {(rows) => <ValidationReviewQueue mode={mode} noteIndex={noteIndex} rows={rows} section="waiting" />}
              </Paged>
            </BulkPickLineSlot.Provider>
          )}
        </PlaceCheckSection>
      ) : null}

      {drawBuildings ? (
        <PlaceCheckSection
          action={lanes && buildings.length > 0 ? <div className="min-w-0" data-pick-line-slot ref={setBuildingsLine} /> : undefined}
          description={buildingsSaid}
          lane={laneLine(buildingsSaid, why !== null && !whyOnClinics)}
          title={buildingsTitle}
        >
          {buildings.length === 0 ? (
            <div className="px-4 py-4">
              <AdminCallout tone="success">
                <span>{anyFilter ? "No polyclinic waiting matches these filters." : "No polyclinic or seated customer is waiting."}</span>
              </AdminCallout>
            </div>
          ) : (
            <BulkPickLineSlot.Provider value={lanes ? buildingsLine : undefined}>
              <Paged key={pageKey} noun="buildings" rows={buildings} size={buildingsPage}>
                {(groups) => <SharedPlaceList groups={groups} mode={mode} noteIndex={noteIndex} />}
              </Paged>
            </BulkPickLineSlot.Provider>
          )}
        </PlaceCheckSection>
      ) : null}
    </>
  );
}
