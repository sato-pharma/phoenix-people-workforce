"use client";

/**
 * Phoenix CRM — the Visits tab: a territory's visits of a day, and Add visit.
 *
 * Owner, 2026-09-16: the rep enters visits; a district manager normally goes out on a double visit that
 * the rep enters, and it counts for the manager too; a chain visit adds a senior manager (regional or
 * national); both count straight away, with no confirmation step.
 *
 * Owner, 2026-09-29 — the rep's flow rebuilt:
 *   - Add visit starts on ONE question with nine answers (visit-start.tsx): a planned visit, an
 *     unplanned one (out of plan, or out of list), or the day's activity.
 *   - The visit form is one tap, Log visit (visit-log-form.tsx): no photo, no date, no AM/PM picker.
 *     The server stamps the time and the location is read in silence.
 *   - Only today's visits are logged, until 02:00 the next morning. Earlier days are read only.
 *   - GOLDEN RULE #1: the rep never sees a distance, a flag or a check. This tab shows none, to anyone
 *     — a manager reads the place-against-actual report, never the rep's day.
 *
 * AM and PM are counted apart on every figure and never added together (the call-rate rule).
 */

import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";

import { AddPharmacyScreen } from "@/components/phoenix-crm/add-pharmacy";
import { crmUrl, useCrmAction, useCrmGet } from "@/components/phoenix-crm/api";
import { CallPrepPanel } from "@/components/phoenix-crm/call-prep-panel";
import { CommitmentsPanel } from "@/components/phoenix-crm/commitments-panel";
import { DayStartBlock } from "@/components/phoenix-crm/day-start-button";
import { canStartDay } from "@/lib/phoenix-crm/day-start-rules";
import { cairoClock, dayLabel, dayLabelLong, plural, shiftIsoDay } from "@/components/phoenix-crm/format";
import { listText, territoryLine } from "@/components/phoenix-crm/labels";
import type { CapturedPhoto } from "@/components/phoenix-crm/live-photo-capture";
import { OutOfListEntry } from "@/components/phoenix-crm/out-of-list-entry";
import { PharmacyDetailsScreen } from "@/components/phoenix-crm/pharmacy-details";
import {
  CrmBackBar,
  CrmBlock,
  CrmButton,
  CrmCard,
  CrmCardsOnPhone,
  CrmEmpty,
  CrmLoadError,
  CrmLoading,
  CrmNote,
  CrmPanel,
  CrmPill,
  CrmSaveError,
  CrmSelect,
  CrmStat,
  CrmStatGrid,
  CrmTable,
  crmInputClassName,
  crmPanelClassName,
  crmTdClassName,
  crmThClassName,
  type PillTone,
} from "@/components/phoenix-crm/ui";
import { VisitDetailEdit, visitDetailEditedText } from "@/components/phoenix-crm/visit-detail-panel";
import { customersFor, OutOfPlanReason, VisitCustomerPicker } from "@/components/phoenix-crm/visit-customer-picker";
import { CrmStepFooter, CrmStepForm, CrmStepFrame, type CrmStep } from "@/components/phoenix-crm/step-form";
import { decidersText, logVisitTypeLabel, VisitLogForm, type LogVisitType, type VisitFormPart } from "@/components/phoenix-crm/visit-log-form";
import { saveDayActivity, UnplannedChoice, VisitStart } from "@/components/phoenix-crm/visit-start";
import { VisitRecordingGate } from "@/components/phoenix-crm/visit-recording-gate";
import { useSentVisitRecording } from "@/components/phoenix-crm/visit-recording-store";
import { CrmVisitRecordingPlayer, CrmVoiceNotePlayer } from "@/components/phoenix-crm/voice-playback";
import { isIsoDay } from "@/lib/phoenix-crm/calendar";
import { isDayActivity, PHOENIX_CRM_DAY_ACTIVITIES } from "@/lib/phoenix-crm/day-activities";
import type { ProductAvailability } from "@/lib/phoenix-crm/entry-rules";
import { MANAGER_OWN_VISIT_ON_VACANT_SAVED } from "@/lib/phoenix-crm/manager-plan-rules";
import { MISSED_RECORD_MARK } from "@/lib/phoenix-crm/missed-records";
import { movedDayReason } from "@/lib/phoenix-crm/offplan-day";
import { isPharmacyListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";
import { offPlanBlock } from "@/lib/phoenix-crm/offplan-cap-rules";
import { outOfListVisitNote, unplannedKindLabel } from "@/lib/phoenix-crm/unplanned-rules";
import type { DayActivityRow, SavedVisit, VisitCustomerOption, VisitDayView, VisitFormView, VisitRow } from "@/lib/phoenix-crm/view-types";
import { recordingReviewRepLabel } from "@/lib/phoenix-crm/visit-recording-rules";
import { cn } from "@/lib/utils";

/**
 * A visit to open straight on one customer — Today's tap on a planned stop. Since 2026-09-29 it only
 * means "open the form on this customer": a visit takes no photo, so `photo` is always null now and is
 * kept only because the page still hands one over and frees it.
 */
export type PendingVisit = {
  seatId: string;
  test: boolean;
  customerId: string;
  customerName: string;
  /** No longer used: a visit takes no photo (2026-09-29). */
  photo: CapturedPhoto | null;
  /** The phone's Date.now() when the hand-off was made. */
  validatedAtMs: number;
};

/**
 * The List tab's Validate hand-off: a customer to open the Validate screen on. Kept for the List tab,
 * which still accepts one; this tab no longer offers "Validate now" after a visit — validating happens
 * on the List.
 */
export type PendingValidate = {
  seatId: string;
  test: boolean;
  /** His entry on the territory's iReports360 list: what the Validate screen opens on. */
  contactCrmId: number;
  customerName: string;
};

// ── A day's visits ──────────────────────────────────────────────────────────────────────────────

/**
 * Who was on the visit, each under his REAL JOB TITLE as the organogram states it — "Medical
 * Representative", "District Sales Manager", "National Sales Manager" (owner, 2026-10-01: *"put
 * actual titles from the organogram"*).
 *
 * The three slots behind these people — the rep, a manager on a double visit, a senior manager on a
 * chain visit — are the VISIT's shape, not anybody's job, and labelling a national sales manager
 * "Senior manager" on his own call reads as a demotion beside the organogram's own wording. The
 * server resolves the title from the tree (`personSeatTitle`); the slot survives only as the fallback
 * for somebody the SALES-only tree has no seat for, where it is still a true sentence about the visit.
 */
function visitPeople(visit: VisitRow): Array<{ name: string; role: string }> {
  const people: Array<{ name: string; role: string }> = [];
  if (visit.repName) people.push({ name: visit.repName, role: visit.repTitle ?? "Rep" });
  if (visit.managerName) people.push({ name: visit.managerName, role: visit.managerTitle ?? "Manager" });
  if (visit.seniorName) people.push({ name: visit.seniorName, role: visit.seniorTitle ?? "Senior manager" });
  // A product manager holds no seat in the sales-only tree, so his APP ROLE is his title and the slot
  // word is the fallback — the same shape as the three above, for the one person the tree cannot name.
  if (visit.productManagerName) people.push({ name: visit.productManagerName, role: visit.productManagerTitle ?? "Product manager" });
  return people;
}

/** A visit a manager entered for the rep's territory says so; the rep's own entries need no line. */
function enteredByOther(visit: VisitRow): boolean {
  return visit.repName !== null && visit.enteredByName !== visit.repName;
}

/**
 * The line saying who entered a visit, when it was not the rep. A visit the Super Admin entered because
 * the rep missed logging it says so in the owner's own words (2026-10-01, "marked as entered by
 * admin"); a manager's says his name, as before.
 */
function enteredByLine(visit: VisitRow): string | null {
  if (visit.enteredByAdmin) return MISSED_RECORD_MARK;
  return enteredByOther(visit) ? `Entered by ${visit.enteredByName}` : null;
}

function dayFigures(visits: ReadonlyArray<VisitRow>) {
  const count = (listType: PhoenixCrmListType, match: (visit: VisitRow) => boolean) =>
    visits.filter((visit) => visit.listType === listType && match(visit)).length;
  const any = () => true;
  const paired = (visit: VisitRow) => visit.kind !== "single";

  return {
    pm: count("PM", any),
    am: count("AM", any),
    pairedPm: count("PM", paired),
    pairedAm: count("AM", paired),
  };
}

const OUT_OF_LIST_ADDED = outOfListVisitNote("active").label;
const OUT_OF_LIST_NOT_ADDED = outOfListVisitNote("dropped").label;

/**
 * Where an off-plan visit has got to — HIS OWN approval, which he is shown so he can chase it. Out of
 * plan waits on its manager and SFE; out of list waits on its CUSTOMER being added to his list.
 */
function offPlanStanding(visit: VisitRow): { label: string; tone: PillTone } | null {
  if (visit.outOfList) {
    const label = visit.outOfList.label;
    return { label, tone: label === OUT_OF_LIST_ADDED ? "good" : label === OUT_OF_LIST_NOT_ADDED ? "warn" : "orange" };
  }
  if (visit.unplanned) {
    const status = visit.unplanned.status;
    return { label: visit.unplanned.statusLabel, tone: status === "approved" ? "good" : status === "refused" ? "warn" : "orange" };
  }
  return null;
}

/**
 * Where a RECORDED visit's approval has got to (owner, 2026-10-16: "show here ur visit is pending admin
 * approval"). An out-of-plan visit already carries it in its own step pill, so it is not said twice.
 */
function recordingStanding(visit: VisitRow): { label: string; tone: PillTone } | null {
  if (!visit.recordingReview || visit.unplanned) return null;
  const status = visit.recordingReview;
  return { label: recordingReviewRepLabel(status), tone: status === "approved" ? "good" : status === "refused" ? "warn" : "orange" };
}

function StandingPills({ visit }: { visit: VisitRow }) {
  const standing = offPlanStanding(visit);
  const recording = recordingStanding(visit);
  return (
    <>
      <CrmPill tone={visit.unplannedKind ? "orange" : "neutral"}>{visit.unplannedKind ? unplannedKindLabel(visit.unplannedKind) : "Planned"}</CrmPill>
      {standing ? <CrmPill tone={standing.tone}>{standing.label}</CrmPill> : null}
      {recording ? <CrmPill tone={recording.tone}>{recording.label}</CrmPill> : null}
    </>
  );
}

function availabilitySplit(map: Record<string, ProductAvailability>): { has: string[]; missing: string[] } {
  const has: string[] = [];
  const missing: string[] = [];
  for (const [product, answer] of Object.entries(map)) (answer === "has" ? has : missing).push(product);
  return { has, missing };
}

function PharmacyLines({ visit }: { visit: VisitRow }) {
  const { has, missing } = availabilitySplit(visit.productAvailability);
  if (!visit.pharmacyName && has.length === 0 && missing.length === 0) return null;
  return (
    <>
      {visit.pharmacyName ? (
        <p className="break-words">
          <span className="font-black text-slate-800">Pharmacy: </span>
          {visit.pharmacyName}
        </p>
      ) : null}
      {has.length > 0 ? (
        <p className="break-words">
          <span className="font-black text-slate-800">Has: </span>
          {has.join(", ")}
        </p>
      ) : null}
      {missing.length > 0 ? (
        <p className="break-words">
          <span className="font-black text-slate-800">Doesn&apos;t have: </span>
          {missing.join(", ")}
        </p>
      ) : null}
    </>
  );
}

/** What he handed over. Absent on a visit that left nothing, so no card grows an empty row. */
function SampleLine({ visit }: { visit: VisitRow }) {
  if (visit.samples.length === 0) return null;
  return (
    <p className="break-words">
      <span className="font-black text-slate-800">Left behind: </span>
      {visit.samples.map((item) => `${item.label} × ${item.quantity}`).join(", ")}
    </p>
  );
}

/**
 * What the customer pushed back on, and what the rep said he would do next. His own, shown without
 * hedging: an objection is the CUSTOMER's, never a mark against him.
 */
function OutcomeLines({ visit }: { visit: VisitRow }) {
  const outcome = visit.outcome;
  if (!outcome) return null;
  return (
    <>
      {outcome.objectionLabel ? (
        <p className="break-words">
          <span className="font-black text-slate-800">Objection: </span>
          {outcome.objectionLabel}
          {outcome.objectionNote ? (
            <span className="block" dir="auto">
              {outcome.objectionNote}
            </span>
          ) : null}
        </p>
      ) : null}
      {outcome.nextStepLabel ? (
        <p className="break-words">
          <span className="font-black text-slate-800">Next: </span>
          {outcome.nextStepLabel}
          {outcome.nextStepOn ? ` · by ${dayLabel(outcome.nextStepOn)}` : ""}
        </p>
      ) : null}
    </>
  );
}

/** Off the plan: what he wrote, and what it waits on. His own visit, so he is told. */
function OffPlanLines({ visit }: { visit: VisitRow }) {
  if (visit.unplanned) {
    return (
      <p className="break-words">
        <span className="font-black text-slate-800">Off the plan: </span>
        <span dir="auto">{visit.unplanned.clarification}</span>
        <span className="block">{visit.unplanned.note}</span>
      </p>
    );
  }
  if (visit.outOfList) {
    return (
      <p className="break-words">
        <span className="font-black text-slate-800">Out of your list: </span>
        {visit.outOfList.note}
      </p>
    );
  }
  return null;
}

/**
 * The write-up he came back and added, and the marker that says when (owner, 2026-10-15: *"anything
 * edited, it should appear that this is edited in the date and time"*).
 *
 * The door comment stays above it, unchanged — they are two different things said at two different
 * moments, and the card prints both rather than replacing one with the other.
 */
function DetailLines({ visit }: { visit: VisitRow }) {
  const edited = visitDetailEditedText(visit.detailEditedAt);
  if (!visit.detailComment && !edited) return null;
  return (
    <>
      {visit.detailComment ? (
        <p className="whitespace-pre-line break-words">
          <span className="font-black text-slate-800">The visit in full: </span>
          <span dir="auto">{visit.detailComment}</span>
        </p>
      ) : null}
      {edited ? <p className="break-words text-slate-500">{edited}</p> : null}
    </>
  );
}

/**
 * Whose seat and which world, for the rep's own write-up door, and how to re-read the day once he has
 * written one up. Null for every other reader.
 */
type DetailDoor = { seatId: string; isTest: boolean; reload: () => void } | null;

function VisitDetails({ visit }: { visit: VisitRow }) {
  const people = visitPeople(visit);
  return (
    <div className="grid min-w-0 gap-1.5 text-xs font-semibold leading-5 text-slate-600">
      {people.length > 0 ? (
        <p className="break-words">
          <span className="font-black text-slate-800">On the visit: </span>
          {people.map((person) => `${person.name} (${person.role})`).join(", ")}
        </p>
      ) : null}
      <p className="break-words">
        <span className="font-black text-slate-800">Products: </span>
        {visit.products.join(", ") || "—"}
      </p>
      <PharmacyLines visit={visit} />
      {visit.comment ? (
        <p className="whitespace-pre-line break-words">
          <span className="font-black text-slate-800">Comment: </span>
          {/* The label stays left-to-right; only the comment itself takes the reader's direction. */}
          <span dir="auto">{visit.comment}</span>
        </p>
      ) : null}
      {/* The note sits beside the comment because that is what it is — the same thing said rather than
          typed. A recording can be made in a car afterwards and proves nothing about anybody's day. */}
      {visit.voiceNotePath ? <CrmVoiceNotePlayer path={visit.voiceNotePath} seconds={visit.voiceNoteSeconds} /> : null}
      {/* The visit's recording (owner, 2026-10-16): present only for a reader the server lets hear it. */}
      {typeof visit.recordingSeconds === "number" ? <CrmVisitRecordingPlayer seconds={visit.recordingSeconds} visitId={visit.visitId} /> : null}
      <DetailLines visit={visit} />
      <SampleLine visit={visit} />
      <OutcomeLines visit={visit} />
      <OffPlanLines visit={visit} />
      {enteredByLine(visit) ? <p className="break-words">{enteredByLine(visit)}</p> : null}
    </div>
  );
}

function VisitCard({ detail, visit }: { detail: DetailDoor; visit: VisitRow }) {
  return (
    <CrmCard
      accent="border-l-orange-500"
      meta={`${cairoClock(visit.capturedAt)} · ${listText(visit.listType)} · ${visit.kindLabel}`}
      status={<StandingPills visit={visit} />}
      title={visit.customerName}
    >
      <VisitDetails visit={visit} />
      {detail && visit.detailEditable ? (
        <div className="mt-2">
          <VisitDetailEdit hasDetail={visit.detailComment !== null} isTest={detail.isTest} onWrittenUp={detail.reload} seatId={detail.seatId} visitId={visit.visitId} />
        </div>
      ) : null}
    </CrmCard>
  );
}

/** Five columns totalling 100%. No location column: nobody reads a distance on this tab. */
function VisitTable({ detail, visits }: { detail: DetailDoor; visits: ReadonlyArray<VisitRow> }) {
  return (
    <CrmTable columns={["12%", "22%", "20%", "30%", "16%"]}>
      <thead>
        <tr>
          <th className={crmThClassName} scope="col">
            Time
          </th>
          <th className={crmThClassName} scope="col">
            Customer
          </th>
          <th className={crmThClassName} scope="col">
            On the visit
          </th>
          <th className={crmThClassName} scope="col">
            Products and comment
          </th>
          <th className={crmThClassName} scope="col">
            Standing
          </th>
        </tr>
      </thead>
      <tbody>
        {visits.map((visit) => {
          const people = visitPeople(visit);
          const { has, missing } = availabilitySplit(visit.productAvailability);
          return (
            <tr key={visit.visitId}>
              <td className={crmTdClassName}>
                <span className="block font-black text-slate-900">{cairoClock(visit.capturedAt)}</span>
                <span className="mt-0.5 block text-xs text-slate-500">{visit.kindLabel}</span>
              </td>
              <td className={crmTdClassName}>
                <span className="block font-black text-slate-900">{visit.customerName}</span>
                <span className="mt-0.5 block text-xs text-slate-500">{listText(visit.listType)}</span>
              </td>
              <td className={crmTdClassName}>
                {people.map((person) => (
                  <span className="block" key={`${person.role}-${person.name}`}>
                    {person.name}
                    <span className="text-xs text-slate-500"> · {person.role}</span>
                  </span>
                ))}
                {enteredByLine(visit) ? <span className="mt-1 block text-xs text-slate-500">{enteredByLine(visit)}</span> : null}
              </td>
              <td className={crmTdClassName}>
                <span className="block">{visit.products.join(", ") || "—"}</span>
                {visit.pharmacyName ? <span className="mt-1 block text-xs text-slate-600">Pharmacy: {visit.pharmacyName}</span> : null}
                {has.length > 0 ? <span className="mt-1 block text-xs text-slate-500">Has: {has.join(", ")}</span> : null}
                {missing.length > 0 ? <span className="block text-xs text-slate-500">Doesn&apos;t have: {missing.join(", ")}</span> : null}
                {visit.comment ? (
                  <span className="mt-1 block whitespace-pre-line text-xs text-slate-500" dir="auto">
                    {visit.comment}
                  </span>
                ) : null}
                {visit.voiceNotePath ? (
                  <div className="mt-1.5">
                    <CrmVoiceNotePlayer path={visit.voiceNotePath} seconds={visit.voiceNoteSeconds} />
                  </div>
                ) : null}
                {typeof visit.recordingSeconds === "number" ? (
                  <div className="mt-1.5">
                    <CrmVisitRecordingPlayer seconds={visit.recordingSeconds} visitId={visit.visitId} />
                  </div>
                ) : null}
                {visit.samples.length > 0 ? (
                  <span className="mt-1 block text-xs text-slate-600">
                    Left behind: {visit.samples.map((item) => `${item.label} × ${item.quantity}`).join(", ")}
                  </span>
                ) : null}
                {visit.outcome?.objectionLabel ? (
                  <span className="mt-1 block text-xs text-slate-600">
                    Objection: {visit.outcome.objectionLabel}
                    {visit.outcome.objectionNote ? (
                      <span className="block" dir="auto">
                        {visit.outcome.objectionNote}
                      </span>
                    ) : null}
                  </span>
                ) : null}
                {visit.outcome?.nextStepLabel ? (
                  <span className="mt-1 block text-xs text-slate-600">
                    Next: {visit.outcome.nextStepLabel}
                    {visit.outcome.nextStepOn ? ` · by ${dayLabel(visit.outcome.nextStepOn)}` : ""}
                  </span>
                ) : null}
                {/* The write-up and its marker, the same two facts the phone card prints. */}
                {visit.detailComment ? (
                  <span className="mt-1 block whitespace-pre-line text-xs text-slate-600" dir="auto">
                    The visit in full: {visit.detailComment}
                  </span>
                ) : null}
                {visitDetailEditedText(visit.detailEditedAt) ? (
                  <span className="mt-1 block text-xs text-slate-500">{visitDetailEditedText(visit.detailEditedAt)}</span>
                ) : null}
                {detail && visit.detailEditable ? (
                  <span className="mt-1.5 block">
                    <VisitDetailEdit hasDetail={visit.detailComment !== null} isTest={detail.isTest} onWrittenUp={detail.reload} seatId={detail.seatId} visitId={visit.visitId} />
                  </span>
                ) : null}
              </td>
              <td className={crmTdClassName}>
                <span className="flex flex-wrap gap-1">
                  <StandingPills visit={visit} />
                </span>
                {visit.unplanned ? (
                  <>
                    <span className="mt-1 block text-xs text-slate-500" dir="auto">
                      {visit.unplanned.clarification}
                    </span>
                    {/* What the approval waits on — the phone card prints it, so the table does too. */}
                    {visit.unplanned.note ? <span className="mt-0.5 block text-xs text-slate-500">{visit.unplanned.note}</span> : null}
                  </>
                ) : null}
                {visit.outOfList ? <span className="mt-1 block text-xs text-slate-500">{visit.outOfList.note}</span> : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </CrmTable>
  );
}

/** What the day screen says after a save. */
type SavedState = { kind: "visit"; visit: SavedVisit; customerName: string } | { kind: "activity"; label: string; halfDay: boolean };

function SavedNote({ onOpenList, saved }: { onOpenList?: () => void; saved: SavedState }) {
  if (saved.kind === "activity") {
    return (
      <CrmNote title={`Recorded: ${saved.label}${saved.halfDay ? " · half day" : ""}`} tone="good">
        Your manager can see the day. It changes none of your figures.
      </CrmNote>
    );
  }
  const { customerName, visit } = saved;
  if (visit.duplicate) {
    return (
      <CrmNote title={customerName} tone="info">
        This visit was already saved, at {cairoClock(visit.capturedAt)}.
      </CrmNote>
    );
  }
  return (
    <CrmNote title={`Visit saved · ${cairoClock(visit.capturedAt)}`} tone="good">
      <span className="block break-words">{customerName}</span>
      {/* A district manager's own visit on a VACANT territory went into his own single visits, not this
          territory's (owner, 2026-10-19) — so he is told where to look for it. */}
      {visit.filedAsOwnSingleVisit ? <span className="mt-1 block">{MANAGER_OWN_VISIT_ON_VACANT_SAVED}</span> : null}
      {/* The server's own verdict, not what he chose on the first step — so a rep who picked Planned
          for a customer his plan no longer holds finds out here rather than a month later. */}
      {visit.unplannedNote ? <span className="mt-1 block">{visit.unplannedNote}</span> : null}
      {/* A recorded visit counts once it is approved (owner, 2026-10-16). An off-plan one already says so above. */}
      {visit.recordingNote && visit.unplannedKind !== "out_of_plan" ? <span className="mt-1 block">{visit.recordingNote}</span> : null}
      {/* "Arrange a double visit" asked his manager by itself (owner, 2026-10-02) — his own request. */}
      {visit.visitAskNote ? <span className="mt-1 block break-words">{visit.visitAskNote}</span> : null}
      {/* The LAST question: the people asked for a double visit (owner, 2026-10-16). Their answers show on the customer's page. */}
      {visit.doubleVisitNote ? <span className="mt-1 block break-words">{visit.doubleVisitNote}</span> : null}
      {/* A pharmacy's own visit needs no plan and no approval; a pharmacy he named is logged too. */}
      {visit.pharmacyNote ? (
        <span className="mt-1 block break-words" dir="auto">
          {visit.pharmacyNote}
        </span>
      ) : null}
      {visit.unplannedKind === "out_of_list" && onOpenList ? (
        <span className="mt-2 block">
          <span className="block">On the List, choose Request to add or Drop for this customer.</span>
          <CrmButton className="mt-2" onClick={onOpenList} size="sm" variant="primary">
            Open the List
          </CrmButton>
        </span>
      ) : null}
    </CrmNote>
  );
}

/**
 * What this day was, when it was not a call — a meeting, training, a conference, admin work, travel,
 * a health day, a sales day (owner, 2026-09-26; sales day 2026-09-29).
 *
 * A RECORD ONLY: it changes no call rate, no coverage and no plan-against-actual. There is no leave
 * here: HR's vacation module is the only leave record. It writes through `saveDayActivity`, the one
 * write Add visit's first screen uses too.
 */
function DayActivityBlock({ onChanged, view }: { onChanged: () => void; view: VisitDayView }) {
  const action = useCrmAction();
  const current = view.dayActivity;

  async function choose(next: string) {
    if (next !== "" && !isDayActivity(next)) return;
    const choice = isDayActivity(next) ? { activityType: next, halfDay: false, note: null } : null;
    await action.run("day-activity", () => saveDayActivity(view.territory.seatId, view.isTest, choice), () => onChanged());
  }

  const details = current ? (
    <>
      {current.halfDay ? <p className="mt-1 text-xs font-semibold text-slate-500">Half day</p> : null}
      {current.note ? (
        <p className="mt-1 whitespace-pre-line break-words text-xs font-semibold text-slate-600" dir="auto">
          {current.note}
        </p>
      ) : null}
      {/* A day the rep missed recording, entered for him by the Super Admin (owner, 2026-10-01). */}
      {current.enteredByAdmin ? <p className="mt-1 text-xs font-semibold text-slate-500">{MISSED_RECORD_MARK}</p> : null}
    </>
  ) : null;

  if (!view.canSetDayActivity) {
    return current ? (
      <CrmBlock className="border-t border-slate-100" title="This day">
        <p className="text-sm font-semibold text-slate-700">{current.activityLabel}</p>
        {details}
      </CrmBlock>
    ) : null;
  }

  return (
    <CrmBlock className="border-t border-slate-100" title="Was today a field day?">
      <CrmSelect
        aria-label="What today was"
        disabled={action.busy !== null}
        onChange={(event) => void choose(event.target.value)}
        value={current?.activityType ?? ""}
      >
        <option value="">A field day — visits only</option>
        {PHOENIX_CRM_DAY_ACTIVITIES.map((entry) => (
          <option key={entry.key} value={entry.key}>
            {entry.label}
          </option>
        ))}
      </CrmSelect>
      {details}
      <p className="mt-2 text-xs font-semibold text-slate-500">Recorded so your manager can see the day. It changes none of your figures.</p>
      {action.error ? <CrmSaveError message={action.error} onRetry={action.retry} tone="warn" /> : null}
    </CrmBlock>
  );
}

// ── Add visit ───────────────────────────────────────────────────────────────────────────────────

/** Where Add visit is. `back` is where Back leads; null closes Add visit. */
type AddStep =
  | { name: "start" }
  /** Opened straight on one customer (Today's tap): routed once the form's customers are read. */
  | { name: "open"; customerId: string; customerName: string }
  | { name: "planned" }
  | { name: "unplanned" }
  | { name: "out_of_plan" }
  | { name: "out_of_list" }
  | { name: "pharmacy" }
  /** Pharmacy visit → Add a pharmacy: one not on his list yet, by its name, with no approval. */
  | { name: "pharmacy_new" }
  /**
   * Pharmacy visit → its location and its responsible person's phone, both optional (owner,
   * 2026-10-09: "VISITING pharmacy or adding a new pharmacy"). It is reached from the pharmacy's own
   * row and leads back to it — never a step inside the visit form, which adds no step for anyone.
   */
  | { name: "pharmacy_details"; customerId: string }
  | { name: "reason"; customerId: string; reason: string; back: AddStep | null }
  | { name: "form"; customerId: string; visitType: LogVisitType; reason: string | null; back: AddStep | null; part?: VisitFormPart };

/**
 * Add visit as the step form (owner, 2026-10-02 — Report It's form for visits and plans alike): 1 the
 * visit type, 2 the customer (and, off plan, why), 3 the products and the comment, 4 the visit read
 * back with the ONE Log visit. A tap on a type or a customer moves him on by itself — no Next for a
 * step whose answer is a choice.
 */
const VISIT_STEPS: ReadonlyArray<CrmStep> = [
  { label: "Visit type", description: "Planned, unplanned or a pharmacy", title: "What kind of visit" },
  { label: "Customer", description: "Who you visited", title: "Choose the customer" },
  { label: "Products and comment", description: "What you discussed", title: "Products and comment" },
  { label: "Log the visit", description: "Check it, then log it", title: "Log the visit" },
];

function visitStepOf(step: AddStep): number {
  if (step.name === "start" || step.name === "unplanned") return 1;
  if (step.name === "form") return step.part === "log" ? 4 : 3;
  return 2;
}

function visitChip(step: AddStep): string {
  switch (step.name) {
    case "planned":
      return "Planned visit";
    case "unplanned":
      return "Unplanned visit";
    case "out_of_plan":
    case "reason":
      return "Out of plan";
    case "out_of_list":
      return "Out of list";
    case "pharmacy":
    case "pharmacy_new":
    case "pharmacy_details":
      return "Pharmacy visit";
    case "form":
      return logVisitTypeLabel(step.visitType);
    default:
      return "Add visit";
  }
}

/** Steps holding something he has started: a hand-off from Today never replaces them. */
function holdsWork(step: AddStep | null): boolean {
  return (
    step !== null &&
    (step.name === "form" ||
      step.name === "open" ||
      step.name === "reason" ||
      step.name === "out_of_list" ||
      step.name === "pharmacy_new" ||
      // He may be standing in the shop with a location captured and not saved yet.
      step.name === "pharmacy_details")
  );
}

/**
 * Where a customer opened straight from Today goes: on today's sent plan, the form as planned; waiting
 * outside the list, the form as out of list; anyone else on the list, the reason first.
 *
 * 🔴 IT CANNOT LAND A PLANNED CUSTOMER ON THE REASON SCREEN ANY MORE, and that is a consequence of the
 * owner's own ruling of 2026-09-30 rather than a special case here: Today shows the APPROVED plan only,
 * and every approved customer is inside the set the server counts as planned. The screen that offered
 * to send an unapproved week from inside Add visit was built that day and removed the same day.
 */
function routeFor(customer: VisitCustomerOption): AddStep {
  // A pharmacy is never planned, never off plan and never approved (owner, 2026-10-02/03): straight to
  // the form, wherever he opened it from.
  if (isPharmacyListType(customer.listType)) return { name: "form", customerId: customer.customerId, visitType: "pharmacy", reason: null, back: null };
  if (customer.outside) return { name: "form", customerId: customer.customerId, visitType: "out_of_list", reason: null, back: null };
  if (customer.plannedToday) return { name: "form", customerId: customer.customerId, visitType: "planned", reason: null, back: null };
  return { name: "reason", customerId: customer.customerId, reason: filledReason(customer), back: null };
}

/**
 * Where the reason starts when he picks Out of plan (owner, 2026-10-02: "Moved-day reason pre-filled").
 * A customer on his SENT plan for another day of this week starts with that day written for him —
 * "Planned for Tuesday 6 Oct; seen today instead." — which he can change; anyone else starts empty, as
 * every reason always has. No step is added: it is the same screen, with the typing already done.
 */
function filledReason(customer: Pick<VisitCustomerOption, "plannedOtherDays"> | null): string {
  return (customer ? movedDayReason(customer.plannedOtherDays) : null) ?? "";
}

function AddFlow({
  canSetDayActivity,
  dayActivity,
  onActivitySaved,
  onClose,
  onSaved,
  onStep,
  seatId,
  step,
  test,
}: {
  /** Null while the day is still loading (see VisitStart). */
  canSetDayActivity: boolean | null;
  dayActivity: DayActivityRow | null;
  onActivitySaved: (activity: DayActivityRow | null, label: string) => void;
  onClose: () => void;
  onSaved: (visit: SavedVisit, customerName: string) => void;
  onStep: (next: AddStep) => void;
  seatId: string;
  step: AddStep;
  test: boolean;
}) {
  const resource = useCrmGet<VisitFormView>(crmUrl("/api/phoenix-crm/visits/form", { seatId, test }), "form");
  const form = resource.data;
  // The visit recording a chosen rep sends before logging (owner, 2026-10-16), kept until the visit saves.
  const sent = useSentVisitRecording(seatId, test);
  // Why the recorder is back in front of the rep, when a save refused the recording it carried.
  const [recordingNotice, setRecordingNotice] = useState<string | null>(null);

  /**
   * One screen of Add visit inside the step form. Steps 1 and 2 take the form's own foot (Back — a tap
   * on a choice is what moves him on); steps 3 and 4 are the visit form, whose bar under his thumb is
   * the foot. The rail goes back, never forward: forward is only ever by answering the step.
   */
  function shell(current: AddStep, content: ReactNode, back: () => void) {
    const n = visitStepOf(current);
    return (
      <section className={cn(crmPanelClassName, "min-w-0")}>
        <CrmStepForm
          aside="The visit is saved only when you press Log visit."
          canJump={(target) => target < n && (n < 3 || target >= 3)}
          chip={visitChip(current)}
          footer={n >= 3 ? undefined : <CrmStepFooter back={back} />}
          onJump={(target) => {
            if (target === 3 && current.name === "form") onStep({ ...current, part: "details" });
            else if (target === 1) onStep({ name: "start" });
          }}
          step={n}
          steps={VISIT_STEPS}
        >
          <CrmStepFrame>{content}</CrmStepFrame>
        </CrmStepForm>
      </section>
    );
  }

  if (step.name === "start") {
    return shell(
      step,
      <VisitStart
        canSetDayActivity={canSetDayActivity}
        dayActivity={dayActivity}
        onActivitySaved={onActivitySaved}
        onBack={onClose}
        onPharmacy={() => onStep({ name: "pharmacy" })}
        onPlanned={() => onStep({ name: "planned" })}
        onUnplanned={() => onStep({ name: "unplanned" })}
        pharmacyCount={form ? customersFor("pharmacy", form.customers).length : null}
        planToday={form ? form.planToday : null}
        plannedCount={form ? customersFor("planned", form.customers).length : null}
        seatId={seatId}
        test={test}
      />,
      onClose,
    );
  }

  const back = <CrmBackBar backLabel="Visits" onBack={onClose} title="Add visit" />;

  if (!form) {
    return (
      <CrmPanel>
        {back}
        {resource.error ? <CrmLoadError message={resource.error} onRetry={resource.reload} /> : <CrmLoading label="Opening Add visit" />}
      </CrmPanel>
    );
  }

  if (form.blockedReason) {
    return (
      <CrmPanel>
        {back}
        <CrmBlock>
          <CrmNote title="A visit cannot be added here yet" tone="warn">
            {form.blockedReason}
          </CrmNote>
        </CrmBlock>
      </CrmPanel>
    );
  }

  const loaded = form;
  const find = (customerId: string) => loaded.customers.find((customer) => customer.customerId === customerId) ?? null;
  // A customer just validated arrives with the form's next read; until then this is loading, not gone.
  const missing = (name: string | null) => (
    <CrmPanel>
      {back}
      {resource.loading ? (
        <CrmLoading label="Opening the visit form" />
      ) : (
        <CrmBlock>
          <CrmNote tone="warn">{`${name ?? "This customer"} is not on the list of customers to visit. Reload the page, or start again.`}</CrmNote>
        </CrmBlock>
      )}
    </CrmPanel>
  );

  // 🔴 A REP THE SUPER ADMIN SWITCHED ON RECORDS THE VISIT BEFORE ANY STEP OF LOGGING IT (owner,
  // 2026-10-16). The first screen stays reachable — it also carries the day's activity, which is not a
  // visit — and every road from it to a customer or the form passes through the recorder first. A rep
  // who is not on the list never reaches this branch: `recordingRequired` is false.
  if (loaded.recordingRequired && !sent.recording) {
    return shell(
      { name: "start" },
      <VisitRecordingGate
        notice={recordingNotice}
        onBack={() => onStep({ name: "start" })}
        onRecorded={(value) => {
          setRecordingNotice(null);
          sent.keep(value);
        }}
        seatId={seatId}
        test={test}
      />,
      () => onStep({ name: "start" }),
    );
  }

  let current: AddStep = step;
  if (step.name === "open") {
    const customer = find(step.customerId);
    if (!customer) return missing(step.customerName);
    current = routeFor(customer);
  }

  switch (current.name) {
    case "planned":
      return shell(
        current,
        <VisitCustomerPicker
          allCustomers={loaded.customers}
          mode="planned"
          onBack={() => onStep({ name: "start" })}
          onChooseUnplanned={() => onStep({ name: "unplanned" })}
          onPick={(customerId) => onStep({ name: "form", customerId, visitType: "planned", reason: null, back: { name: "planned" } })}
        />,
        () => onStep({ name: "start" }),
      );
    case "unplanned":
      return shell(
        current,
        <UnplannedChoice
          onBack={() => onStep({ name: "start" })}
          onOutOfList={() => onStep({ name: "out_of_list" })}
          offPlan={loaded.offPlan}
          onOutOfPlan={() => onStep({ name: "out_of_plan" })}
          outOfPlanCount={customersFor("out_of_plan", loaded.customers).length}
          outOfPlanOpenCount={customersFor("out_of_plan", loaded.customers).filter((customer) => offPlanBlock(loaded.offPlan, customer.customerId) === null).length}
          voice={loaded.enteredAs === "rep" ? "rep" : "manager"}
          waitingCount={loaded.customers.filter((customer) => customer.outside).length}
        />,
        () => onStep({ name: "start" }),
      );
    case "out_of_plan":
      return shell(
        current,
        <VisitCustomerPicker
          allCustomers={loaded.customers}
          mode="out_of_plan"
          offPlan={loaded.offPlan}
          onBack={() => onStep({ name: "unplanned" })}
          onPick={(customerId) => onStep({ name: "reason", customerId, reason: filledReason(find(customerId)), back: { name: "out_of_plan" } })}
          voice={loaded.enteredAs === "rep" ? "rep" : "manager"}
        />,
        () => onStep({ name: "unplanned" }),
      );
    case "pharmacy":
      return shell(
        current,
        <VisitCustomerPicker
          allCustomers={loaded.customers}
          mode="pharmacy"
          // The territory's own rep adds one (owner, 2026-10-03); a manager entering a visit picks from his list.
          onAddPharmacy={loaded.enteredAs === "rep" ? () => onStep({ name: "pharmacy_new" }) : undefined}
          onBack={() => onStep({ name: "start" })}
          // Its location and phone, from its own row (owner, 2026-10-09). The rep's alone, like the add.
          onPharmacyDetails={loaded.enteredAs === "rep" ? (customerId) => onStep({ name: "pharmacy_details", customerId }) : undefined}
          onPick={(customerId) => onStep({ name: "form", customerId, visitType: "pharmacy", reason: null, back: { name: "pharmacy" } })}
        />,
        () => onStep({ name: "start" }),
      );
    case "pharmacy_new":
      return shell(
        current,
        <AddPharmacyScreen
          backLabel="Pharmacy visit"
          from="visit"
          onAdded={(added) => {
            // On the form's customers from its next read — `missing` reads as loading until then.
            resource.reload();
            onStep({ name: "form", customerId: added.customerId, visitType: "pharmacy", reason: null, back: { name: "pharmacy" } });
          }}
          onBack={() => onStep({ name: "pharmacy" })}
          seatId={seatId}
          test={test}
        />,
        () => onStep({ name: "pharmacy" }),
      );
    case "pharmacy_details": {
      const pharmacy = find(current.customerId);
      if (!pharmacy) return missing(null);
      return shell(
        current,
        <PharmacyDetailsScreen
          backLabel="Pharmacy visit"
          onBack={() => onStep({ name: "pharmacy" })}
          onSaved={() => {
            // Back to the pharmacies, with the row carrying what he just saved on the next read.
            resource.reload();
            onStep({ name: "pharmacy" });
          }}
          pharmacy={{
            customerId: pharmacy.customerId,
            name: pharmacy.name,
            phone: pharmacy.pharmacyPhone,
            pin: pharmacy.pharmacyPin,
          }}
          seatId={seatId}
          test={test}
        />,
        () => onStep({ name: "pharmacy" }),
      );
    }
    case "out_of_list":
      return shell(
        current,
        <OutOfListEntry
          canAddNew={loaded.enteredAs === "rep"}
          customers={loaded.customers}
          onBack={() => onStep({ name: "unplanned" })}
          onPick={(customerId) => onStep({ name: "form", customerId, visitType: "out_of_list", reason: null, back: { name: "out_of_list" } })}
          onValidated={(customerId) => {
            // He is on the form's customers from its next read, waiting outside the list.
            resource.reload();
            onStep({ name: "form", customerId, visitType: "out_of_list", reason: null, back: { name: "out_of_list" } });
          }}
          seatId={seatId}
          test={test}
        />,
        () => onStep({ name: "unplanned" }),
      );
    case "reason": {
      const reasonStep = current;
      const customer = find(reasonStep.customerId);
      if (!customer) return missing(null);
      return shell(
        reasonStep,
        <OutOfPlanReason
          customer={customer}
          deciders={decidersText(loaded)}
          initialReason={reasonStep.reason}
          key={reasonStep.customerId}
          offPlan={loaded.offPlan}
          voice={loaded.enteredAs === "rep" ? "rep" : "manager"}
          onBack={() => (reasonStep.back ? onStep(reasonStep.back) : onClose())}
          onContinue={(reason) =>
            onStep({ name: "form", customerId: customer.customerId, visitType: "out_of_plan", reason, back: { ...reasonStep, reason } })
          }
        />,
        () => (reasonStep.back ? onStep(reasonStep.back) : onClose()),
      );
    }
    case "form": {
      const formStep = current;
      const customer = find(formStep.customerId);
      if (!customer) return missing(null);
      return shell(
        formStep,
        <VisitLogForm
          customer={customer}
          form={loaded}
          initialReason={formStep.reason}
          initialVisitType={formStep.visitType}
          key={formStep.customerId}
          onBack={() => (formStep.back ? onStep(formStep.back) : onClose())}
          onPart={(part) => onStep({ ...formStep, part })}
          onReload={resource.reload}
          onRecordingRefused={(message) => {
            setRecordingNotice(message);
            sent.clear();
          }}
          onSaved={(visit, customerName) => {
            sent.clear();
            onSaved(visit, customerName);
          }}
          part={formStep.part ?? "details"}
          visitRecording={loaded.recordingRequired ? sent.recording : null}
          seatId={seatId}
          test={test}
        />,
        () => (formStep.back ? onStep(formStep.back) : onClose()),
      );
    }
    default:
      return null;
  }
}

// ── The tab ─────────────────────────────────────────────────────────────────────────────────────

export function VisitsTab({
  addNonce,
  onAddHandled,
  onOpenList,
  onOwnSingleVisitSaved,
  onPendingVisitDone,
  onWorkChange,
  openingDay,
  pendingVisit,
  seatId,
  test,
}: {
  /**
   * The portal's "+ Add visit": each new positive value opens Add visit's first screen — unless Add
   * visit is already open, which is never replaced or reset.
   */
  addNonce?: number;
  /** Called once a new `addNonce` has been taken, so the page can set it back and a remount does not reopen Add visit. */
  onAddHandled?: () => void;
  /** An out-of-list visit saved: open the List, where he chooses Request to add or Drop. */
  onOpenList?: () => void;
  /**
   * A district manager's own visit on a VACANT territory went into My single visits, not this day
   * (owner, 2026-10-19) — the panel above this tab is the one holding it, so it is the one to reload.
   */
  onOwnSingleVisitSaved?: () => void;
  /** The hand-off from Today was used or abandoned. */
  onPendingVisitDone: () => void;
  /** Accepted for the page, which still passes it; this tab no longer offers "Validate now". */
  onStartValidate?: (validate: PendingValidate) => void;
  /** Add visit opened or closed: the page keeps this tab as it is while another tab is open. */
  onWorkChange?: (working: boolean) => void;
  /**
   * The visit day as the page learned it — never the calendar date, which runs ahead of it between
   * midnight and 02:00. Shown only until this tab's own day has answered.
   */
  openingDay: string;
  pendingVisit: PendingVisit | null;
  seatId: string;
  test: boolean;
}) {
  // Null is the visit day itself — the server's own, which runs until 02:00 the next morning. A past
  // day is read only.
  const [date, setDate] = useState<string | null>(null);
  const [visitDay, setVisitDay] = useState<string | null>(null);
  const [step, setStep] = useState<AddStep | null>(null);
  const [saved, setSaved] = useState<SavedState | null>(null);
  const day = useCrmGet<VisitDayView>(crmUrl("/api/phoenix-crm/visits", { date, seatId, test }), "day");
  const view = day.data;

  // The visit day, learned from the server's own answer rather than from the phone's clock.
  if (date === null && view && view.date !== visitDay) setVisitDay(view.date);

  // Today's tap on a stop: the form opens on that customer. Work already under way is never replaced.
  const handoff = pendingVisit && pendingVisit.seatId === seatId && pendingVisit.test === test ? pendingVisit : null;
  const [handoffSeen, setHandoffSeen] = useState<PendingVisit | null>(null);
  if (handoff !== handoffSeen) {
    setHandoffSeen(handoff);
    if (handoff && !holdsWork(step)) {
      setSaved(null);
      setDate(null);
      setStep({ name: "open", customerId: handoff.customerId, customerName: handoff.customerName });
    }
  }

  // The portal's "+": answered while rendering, from what it said last time — never an effect and
  // never a remount, so a visit under way is never dropped.
  const nonce = addNonce ?? 0;
  const [seenNonce, setSeenNonce] = useState(0);
  if (nonce !== seenNonce) {
    setSeenNonce(nonce);
    if (nonce > 0 && step === null) {
      setSaved(null);
      setDate(null);
      setStep({ name: "start" });
    }
  }
  useEffect(() => {
    if (seenNonce > 0) onAddHandled?.();
  }, [onAddHandled, seenNonce]);

  const working = step !== null;
  useEffect(() => {
    onWorkChange?.(working);
  }, [onWorkChange, working]);

  function closeFlow() {
    setStep(null);
    if (handoff) onPendingVisitDone();
  }

  if (step) {
    return (
      <AddFlow
        canSetDayActivity={date !== null ? false : view ? view.canSetDayActivity || view.canSetOwnDayActivity : null}
        dayActivity={date === null && view ? (view.canSetOwnDayActivity ? view.ownDayActivity : view.dayActivity) : null}
        onActivitySaved={(activity, label) => {
          closeFlow();
          setSaved({ kind: "activity", label, halfDay: activity?.halfDay ?? false });
          setDate(null);
          day.reload();
        }}
        onClose={closeFlow}
        onSaved={(visit, customerName) => {
          closeFlow();
          setSaved({ kind: "visit", visit, customerName });
          setDate(null);
          day.reload();
          // It is not on this day at all — it is in My single visits, which is a sibling panel.
          if (visit.filedAsOwnSingleVisit) onOwnSingleVisitSaved?.();
        }}
        onStep={setStep}
        seatId={seatId}
        step={step}
        test={test}
      />
    );
  }

  const latest = visitDay ?? openingDay;
  const shownDate = view?.date ?? date ?? latest;
  const isToday = date === null;
  const visits = view?.visits ?? [];
  const figures = dayFigures(visits);

  function moveTo(next: string) {
    if (!isIsoDay(next)) return;
    setSaved(null);
    setDate(next >= latest ? null : next);
  }

  function openAdd() {
    setSaved(null);
    setStep({ name: "start" });
  }

  const addButton =
    isToday && view?.canAdd ? (
      <CrmButton onClick={openAdd} variant="primary">
        <Plus aria-hidden className="h-4 w-4" />
        Add visit
      </CrmButton>
    ) : null;

  // 🔴 THE TWO READ-ONLY PANELS BELOW ARE THE REP'S OWN, AND THE GATE IS `canSetDayActivity`.
  //
  // That flag is `date === today && canWriteAsRep(viewer, seat, isTest)` — exactly "this is my own
  // territory and my own current day", which is the boundary Golden rule #1 draws (WHOSE WORK IT IS).
  // His managers, the SFE Manager and the Super Admin outside test mode read neither: a
  // manager-readable list of a rep's open promises is a judgement of him, which the rule keeps off
  // this module, and the server refuses both reads for them anyway (`territoryForRepWrite`). A past
  // day draws neither either — both are about now and next.
  const ownDay = isToday && view?.canSetDayActivity === true;

  // 🔴 THE WRITE-UP DOOR CARRIES NO DAY CONDITION, unlike `ownDay` above: the owner was asked and
  // answered "any time", so a visit he logged last week is still his to write up. Which visits offer
  // it is the row's own `detailEditable` — his own visit, and not the pharmacy visit another filed.
  const detailDoor = view?.canAddVisitDetail === true ? { seatId: view.territory.seatId, isTest: view.isTest, reload: day.reload } : null;

  return (
    <div className="grid min-w-0 gap-4">
      <CrmPanel
        actions={addButton}
        description={view ? territoryLine(view.territory) : null}
        eyebrow="Visits"
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span>{dayLabelLong(shownDate)}</span>
            {isToday ? <CrmPill tone="orange">Today</CrmPill> : null}
          </span>
        }
      >
        <CrmBlock className="border-b border-slate-100">
          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 sm:max-w-md">
            <CrmButton aria-label="Previous day" onClick={() => moveTo(shiftIsoDay(shownDate, -1))}>
              <ChevronLeft aria-hidden className="h-4 w-4" />
            </CrmButton>
            <input
              aria-label="Day"
              className={cn(crmInputClassName, "appearance-none")}
              max={latest}
              onChange={(event) => moveTo(event.target.value)}
              type="date"
              value={shownDate}
            />
            <CrmButton aria-label="Next day" disabled={isToday} onClick={() => moveTo(shiftIsoDay(shownDate, 1))}>
              <ChevronRight aria-hidden className="h-4 w-4" />
            </CrmButton>
          </div>
          {isToday ? null : (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <CrmButton
                onClick={() => {
                  setSaved(null);
                  setDate(null);
                }}
                size="sm"
              >
                Back to today
              </CrmButton>
              <span className="text-xs font-semibold text-slate-500">Visits are logged on the day they happen.</span>
            </div>
          )}
        </CrmBlock>

        {saved ? (
          <div className="px-4 pt-4 sm:px-5">
            <SavedNote onOpenList={onOpenList} saved={saved} />
          </div>
        ) : null}

        {!view && day.error ? <CrmLoadError message={day.error} onRetry={day.reload} /> : null}
        {!view && !day.error ? <CrmLoading label="Loading the day's visits" /> : null}

        {view ? (
          <>
            {day.error ? <CrmLoadError message={day.error} onRetry={day.reload} /> : null}
            {/* 🔴 FIRST ON THE DAY, AND ONLY BEFORE THE FIRST AM VISIT (owner, 2026-10-03). It sits above
                the day's record and the counters because it is the one thing he is asked to do BEFORE he
                works — "press here before doing only the first AM visit … before not after". `canStartDay`
                is the same rule the server applies, so the button is never offered where the save refuses. */}
            <DayStartBlock
              dayStart={view.dayStart}
              onStarted={day.reload}
              seatId={view.territory.seatId}
              show={canStartDay({
                viewerIsRep: view.canSetDayActivity,
                isToday,
                amVisits: figures.am,
                alreadyStarted: view.dayStart !== null,
              })}
              test={view.isTest}
            />
            <DayActivityBlock onChanged={day.reload} view={view} />
            <CrmBlock>
              {/* AM first, as every sentence and the Day screen say it. Two figures, never a total. */}
              <CrmStatGrid>
                <CrmStat label="AM visited" note={plural(figures.pairedAm, "double or chain visit", "double or chain visits")} value={figures.am} />
                <CrmStat label="PM visited" note={plural(figures.pairedPm, "double or chain visit", "double or chain visits")} value={figures.pm} />
              </CrmStatGrid>
            </CrmBlock>
            {visits.length === 0 ? (
              <CrmEmpty
                action={addButton}
                message={isToday && view.canAdd ? "Log each visit at the customer — one tap on Log visit." : null}
                title={isToday ? "No visits yet today" : "No visits this day"}
              />
            ) : (
              <div className="border-t border-slate-100">
                <CrmCardsOnPhone>
                  {visits.map((visit) => (
                    <VisitCard detail={detailDoor} key={visit.visitId} visit={visit} />
                  ))}
                </CrmCardsOnPhone>
                <VisitTable detail={detailDoor} visits={visits} />
              </div>
            )}
          </>
        ) : null}
      </CrmPanel>
      {ownDay ? (
        <>
          {/* What he said he would do, and has not been back for. His own notes, never a score. */}
          <CommitmentsPanel seatId={seatId} test={test} />
          {/* The four continuity facts for his next planned day — read-only, off the plan-change path. */}
          <CallPrepPanel seatId={seatId} test={test} />
        </>
      ) : null}
    </div>
  );
}
