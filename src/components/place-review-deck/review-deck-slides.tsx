/**
 * Place checks — what each kind of slide in the one-by-one review draws: a held place, a place in use,
 * a polyclinic split in two (the building on its own, then the timetable per customer), an integrity
 * case, and the slide whose row has already left the board.
 *
 * Each one hands the review three things — the photograph's stage, the column of facts, and the footer
 * with the decision — and nothing else: no state lives here, and the review (`review-deck.tsx`) decides
 * which slide is in front of him.
 *
 * 🔴 EVERY BUTTON ON A SLIDE IS THE BOARD'S OWN CONTROL, imported from the list it lives in and posting
 * to the route it always posted to. A slide never builds a decision of its own.
 */

import type { ReactNode } from "react";

import { IntegrityCaseColumn, IntegrityCaseFooter, IntegrityCaseStage } from "@/components/crm-integrity/integrity-review-slide";
import { DeckSection, DeckSplitStage, DeckStageEmpty, DeckStagePhoto, DeckSubjectHeader } from "@/components/place-review-deck/deck-parts";
import { OUTCOME_WORDS, type DeckOutcome } from "@/components/place-review-deck/review-deck-words";
import { PlaceCheckDoneItem } from "@/components/phoenix-crm/place-check-done";
import { PlaceCheckNotes } from "@/components/phoenix-crm/place-check-notes";
import { SeatedLastColumn, SeatedTimetableEvidence, SeatedWho } from "@/components/phoenix-crm/shared-place-customers";
import { VenueDecision, VenueHeader, venueSignboardText, VenueWhere } from "@/components/phoenix-crm/shared-place-list";
import { SystemAdvice } from "@/components/phoenix-crm/system-advice";
import { TimetablePages } from "@/components/phoenix-crm/timetable-pages";
import { CrmPill, type PillTone } from "@/components/phoenix-crm/ui";
import { PlaceInUseApprove, PlaceInUseEvidence, PlaceInUseReject, placeInUsePhotoAlt } from "@/components/phoenix-crm/validated-place-list";
import { ReviewDecision, ReviewEvidence, reviewPhotoAlt } from "@/components/phoenix-crm/validation-review-queue";
import { integrityBoardRow } from "@/lib/crm-integrity/integrity-board-rows";
import { earlierDecisionText } from "@/lib/phoenix-crm/earlier-decision";
import { adviseOnBuilding, adviseOnPlaceInUse, adviseOnReview } from "@/lib/phoenix-crm/place-check-advice";
import { placeNoteAdviceLabel, placeNoteSubjectKey, type PlaceNoteAdvice } from "@/lib/phoenix-crm/place-note-rules";
import { sharedPlaceKindLabel, sharedPlaceKindNoun } from "@/lib/phoenix-crm/shared-place-rules";
import { TRUSTED_POINT_NO_PHOTO } from "@/lib/phoenix-crm/trusted-point-rules";
import type { VenueGroup } from "@/lib/phoenix-crm/shared-place-groups";
import type { IntegrityCase } from "@/lib/phoenix-crm/server/integrity-board";
import type { PlaceNoteIndex, ValidatedPlaceRow, ValidationReviewRow } from "@/lib/phoenix-crm/view-types";
import { adviceOnSubject, deckSeatItem, deckSlideKey } from "@/lib/place-review-deck/slides";
import { cn } from "@/lib/utils";

/**
 * `pinOnPhone`: the footer stays in reach on a phone too. Only a held place has it: its decision is the
 * comment link and Approve beside Reject, about 125 px, since Reject opens its reasons on a press
 * (23 Nov 2026). A place in use keeps its decision under the facts, where it has stood since 2026-10-19.
 */
type SlideView = { stage: ReactNode; column: ReactNode; footer: ReactNode; wideButtons: boolean; pinOnPhone?: boolean };

function Comments({ kind, noteIndex, subjectId }: { kind: "place" | "shared_place"; noteIndex: PlaceNoteIndex; subjectId: string }) {
  const key = placeNoteSubjectKey(kind, subjectId);
  return (
    <DeckSection title="Comments">
      <PlaceCheckNotes
        integrity={noteIndex.integrity[key] ?? []}
        mode="company"
        notes={noteIndex.notes[key] ?? []}
        recommendations={noteIndex.recommendations[key] ?? []}
        subjectId={subjectId}
        subjectKind={kind}
      />
    </DeckSection>
  );
}

const ADVICE_TONES: Record<PlaceNoteAdvice, PillTone> = { approve: "good", your_call: "info", new_photo: "warn", reject: "bad" };

/**
 * The by-eye advice, as a coloured tag beside the buttons it is about (owner, 2026-10-19: "Show my
 * advice by the buttons"). It decides nothing: the buttons under it are his.
 */
function AdviceTag({ advice }: { advice: PlaceNoteAdvice | null }) {
  if (!advice) return null;
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-2 text-xs font-black text-slate-500">
      <span className="break-words">Looked at by eye</span>
      <CrmPill tone={ADVICE_TONES[advice]}>{placeNoteAdviceLabel(advice)}</CrmPill>
    </p>
  );
}

function photoWord(kind: "signboard" | "schedule"): string {
  return kind === "schedule" ? "The timetable" : "The signboard";
}

function reviewSlide(row: ValidationReviewRow, noteIndex: PlaceNoteIndex): SlideView {
  const where = row.status === "pending" ? "Held for your decision" : row.status === "approved" ? "Decided · approved" : "Decided · rejected";
  return {
    stage: (
      <DeckStagePhoto
        alt={reviewPhotoAlt(row)}
        caption={`${row.customerName} · captured ${row.createdAtText} · ${row.repName}`}
        label={photoWord(row.photoKind)}
        path={row.photoPath}
      />
    ),
    column: (
      <>
        <DeckSubjectHeader
          eyebrow={where}
          lines={[
            `${row.repName} · ${row.territory}`,
            `Captured ${row.createdAtText}`,
            ...(row.earlierDecision ? [earlierDecisionText(row.earlierDecision)] : []),
          ]}
          pills={
            <>
              {row.listType ? <CrmPill>{row.listType}</CrmPill> : null}
              {row.speciality ? <CrmPill>{row.speciality}</CrmPill> : null}
              {row.kind === "added_place" ? <CrmPill tone="info">Another clinic</CrmPill> : null}
              {row.systemStillReading ? <CrmPill tone="info">The system is still reading this sign</CrmPill> : null}
              {row.isTest ? <CrmPill>Test entry</CrmPill> : null}
            </>
          }
          title={row.customerName}
        />
        <DeckSection title="The system's advice">
          <SystemAdvice advice={adviseOnReview(row)} />
        </DeckSection>
        <DeckSection title="Where they stood, and what the photo says">
          <ReviewEvidence row={row} />
        </DeckSection>
        <Comments kind="place" noteIndex={noteIndex} subjectId={row.placeId} />
      </>
    ),
    footer: (
      <div className="space-y-2">
        <AdviceTag advice={adviceOnSubject(noteIndex, "place", row.placeId)} />
        <ReviewDecision row={row} scope="deck-" />
      </div>
    ),
    wideButtons: true,
    pinOnPhone: row.status === "pending",
  };
}

function placeSlide(row: ValidatedPlaceRow, noteIndex: PlaceNoteIndex): SlideView {
  return {
    // A trusted point (owner, 2026-11-10) has no photograph: the stage says so in words.
    stage:
      row.trustedPoint && !row.photoPath ? (
        <DeckStageEmpty
          label="Trusted point"
          lines={["Validated by the Super Admin on the point the reps' own readings agree on."]}
          title={TRUSTED_POINT_NO_PHOTO}
        />
      ) : (
        <DeckStagePhoto
          alt={placeInUsePhotoAlt(row)}
          caption={`${row.customerName} · validated ${row.validatedAtText} · ${row.repName}`}
          label={photoWord(row.photoKind)}
          path={row.photoPath}
        />
      ),
    column: (
      <>
        <DeckSubjectHeader
          eyebrow={row.reviewed ? "In use · looked at before" : "In use · not confirmed"}
          lines={[`${row.repName} · ${row.territory}`, `Validated ${row.validatedAtText}`]}
          pills={
            <>
              {row.listType ? <CrmPill>{row.listType}</CrmPill> : null}
              {row.speciality ? <CrmPill>{row.speciality}</CrmPill> : null}
              {row.reviewed ? null : <CrmPill tone="info">Never looked at</CrmPill>}
              {row.isTest ? <CrmPill>Test entry</CrmPill> : null}
            </>
          }
          title={row.customerName}
        />
        <DeckSection title="The system's advice">
          <SystemAdvice advice={adviseOnPlaceInUse(row)} />
        </DeckSection>
        <DeckSection title="The place they saved">
          <PlaceInUseEvidence row={row} />
        </DeckSection>
        <Comments kind="place" noteIndex={noteIndex} subjectId={row.placeId} />
      </>
    ),
    footer: (
      <div className="space-y-2">
        <AdviceTag advice={adviceOnSubject(noteIndex, "place", row.placeId)} />
        <PlaceInUseApprove row={row} />
        <PlaceInUseReject row={row} scope="deck-" />
      </div>
    ),
    wideButtons: true,
  };
}

/** The timetable half of a polyclinic's stage: the photograph, or what is missing, in words. */
function timetableStage(group: VenueGroup): ReactNode {
  const { venue } = group;
  if (venue.timetableExempt) {
    return (
      <DeckStageEmpty
        label="The timetable inside"
        lines={["Its customers are validated by the administrator as an exception.", `Set by ${venue.timetableExempt.byName}, ${venue.timetableExempt.atText}`]}
        title="This building has no timetable."
      />
    );
  }
  if (!venue.schedulePhotoPath) {
    return (
      <DeckStageEmpty
        label="The timetable inside"
        lines={venue.seated > 0 ? ["Every customer seated here is judged against the building's one timetable, and none is on file."] : ["The first customer seated here brings it."]}
        title={venue.seated > 0 ? `No timetable on file, and ${venue.seated === 1 ? "1 customer is" : `${venue.seated} customers are`} seated here.` : "No timetable yet."}
        tone={venue.seated > 0 ? "bad" : "neutral"}
      />
    );
  }
  return (
    <DeckStagePhoto
      alt={`Timetable photo for ${venue.name}`}
      caption={venue.schedulePhotoCapturedAtText ? `${venue.name} · photographed ${venue.schedulePhotoCapturedAtText}` : venue.name}
      below={<TimetablePages firstPath={venue.schedulePhotoPath} name={venue.name} thumbClassName="h-16 w-16" tone="dark" />}
      label="The timetable inside"
      path={venue.schedulePhotoPath}
    />
  );
}

function venueSlide(group: VenueGroup, noteIndex: PlaceNoteIndex): SlideView {
  const { venue, customers } = group;
  const noTimetable = venue.timetableExempt !== null;
  const read = customers.find((customer) => customer.timetable?.scheduleText)?.timetable?.scheduleText ?? null;
  const waiting = customers.filter((customer) => customer.state === "waiting").length;
  return {
    stage: (
      <DeckSplitStage
        first={
          <DeckStagePhoto
            alt={`Sign photo for ${venue.name}`}
            caption={`${venue.name} · captured ${venue.capturedAtText} · ${venue.repName}`}
            label="The sign on the building"
            path={venue.photoPath}
          />
        }
        second={timetableStage(group)}
      />
    ),
    column: (
      <>
        <header className="min-w-0 space-y-2 border-b border-slate-200 px-5 pb-4 pt-5">
          <p className="break-words text-phx-2xs font-black uppercase tracking-[0.16em] text-orange-600">
            {sharedPlaceKindLabel(venue.kind) ?? "Building"} · {venue.status === "held" ? "held for your decision" : venue.status === "retired" ? "rejected" : "in use"}
          </p>
          <VenueHeader mode="company" row={venue} />
        </header>

        {/* Part 1 — the building's own validation, decided on its own. */}
        <DeckSection title={`1 · The ${sharedPlaceKindNoun(venue.kind)} itself`}>
          {venue.signboard ? (
            <CrmPill tone={venue.signboard.verdict === "match" ? "good" : venue.signboard.verdict === "unjudged" ? "neutral" : "warn"}>
              {venueSignboardText(venue.signboard, venue.kind)}
            </CrmPill>
          ) : (
            <p className="break-words text-xs text-slate-500">The sign has not been read yet.</p>
          )}
          {venue.signboard?.signText ? (
            <p className="break-words text-sm text-slate-700" dir="auto">
              Read on it: {venue.signboard.signText}
            </p>
          ) : null}
          <VenueWhere row={venue} />
          <SystemAdvice advice={adviseOnBuilding(venue)} />
          <div className="space-y-2 border-t border-slate-100 pt-3 [&_button]:w-full">
            <AdviceTag advice={adviceOnSubject(noteIndex, "shared_place", venue.sharedPlaceId)} />
            <PlaceCheckDoneItem item={deckSlideKey("venue", venue.sharedPlaceId)}>
              <VenueDecision row={venue} scope="deck" />
            </PlaceCheckDoneItem>
          </div>
        </DeckSection>
        <Comments kind="shared_place" noteIndex={noteIndex} subjectId={venue.sharedPlaceId} />

        {/* Part 2 — the timetable, approved or rejected per customer, each on his own. */}
        <DeckSection title={`2 · The timetable, per customer (${customers.length}${waiting > 0 ? `, ${waiting} waiting` : ""})`}>
          {read ? (
            <p className="break-words text-sm text-slate-700" dir="auto">
              Read on it: {read}
            </p>
          ) : null}
          {customers.length === 0 ? <p className="break-words text-sm text-slate-500">Nobody is seated in this building yet.</p> : null}
          <ul className="min-w-0 space-y-3">
            {customers.map((customer) => (
              <li
                key={customer.key}
                className={cn(
                  "min-w-0 space-y-3 border bg-white px-4 py-3",
                  customer.state === "waiting" ? "border-orange-300 shadow-[inset_3px_0_0_0_rgb(249_115_22)]" : "border-slate-200",
                )}
              >
                <PlaceCheckDoneItem item={deckSeatItem(customer.key)}>
                  <SeatedWho customer={customer} mode="company" />
                  <SeatedTimetableEvidence customer={customer} mode="company" noTimetable={noTimetable} venueTimetablePath={venue.schedulePhotoPath} />
                  <div className="space-y-2 [&_button]:w-full">
                    <AdviceTag advice={adviceOnSubject(noteIndex, "place", customer.placeId)} />
                    <SeatedLastColumn customer={customer} mode="company" noTimetable={noTimetable} noteIndex={noteIndex} scope="deck" />
                  </div>
                </PlaceCheckDoneItem>
              </li>
            ))}
          </ul>
        </DeckSection>
      </>
    ),
    footer: null,
    wideButtons: false,
  };
}

function caseSlide(entry: IntegrityCase, canSettle: boolean): SlideView {
  const row = integrityBoardRow(entry, "open");
  return {
    stage: <IntegrityCaseStage row={row} />,
    column: <IntegrityCaseColumn row={row} />,
    footer: <IntegrityCaseFooter canSettle={canSettle} row={row} />,
    wideButtons: false,
  };
}

/** A slide whose row has left every list the board holds — answered here, or elsewhere since it opened. */
function answeredSlide(outcome: DeckOutcome | undefined): SlideView {
  const said = outcome ? OUTCOME_WORDS[outcome.outcome] : null;
  return {
    stage: (
      <DeckStageEmpty
        label="Answered"
        lines={[said ? "It has left this list, so there is nothing more to decide on it here." : "It was answered elsewhere, or has aged out of the board, since this review opened."]}
        title={said ? `${said}.` : "No longer on the board."}
      />
    ),
    column: (
      <DeckSection title="This one">
        <p className="break-words text-sm text-slate-700">{said ? `${said} in this review. Press Next for the one after it.` : "Press Next for the one after it."}</p>
      </DeckSection>
    ),
    footer: null,
    wideButtons: false,
  };
}

export { answeredSlide, caseSlide, placeSlide, reviewSlide, venueSlide };
export type { SlideView };
