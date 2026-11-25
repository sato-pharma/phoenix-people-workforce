"use client";

/**
 * Phoenix CRM — one customer seated in a polyclinic, as he is read: who he is and where his check
 * stands, and what the system read beside his name on the building's timetable, with his own copy of
 * the photograph. The three small rules the decision starts from live here too, because they are read
 * off the same evidence: the reason a reject opens on, and which route keeps that evidence.
 *
 * Nothing here decides or posts. The controls are in `shared-place-customers-decision.tsx`; the block
 * drawn under each building is in `shared-place-customers.tsx`.
 *
 * 🔴 WHAT THE SYSTEM READ IS A VERDICT, NEVER A DECISION. An approved customer is drawn approved, and a
 * manager's board (`mode="team"`) reads the fact and never who decides it (owner, 2026-10-13).
 */

import { usePlaceCheckDecides } from "@/components/phoenix-crm/place-check-decides";
import type { PlaceCheckNotesMode } from "@/components/phoenix-crm/place-check-notes";
import { CrmPhotoThumb } from "@/components/phoenix-crm/photo";
import { TimetablePages } from "@/components/phoenix-crm/timetable-pages";
import { CrmPill } from "@/components/phoenix-crm/ui";
import { seatedTimetablePill } from "@/lib/phoenix-crm/approved-place-words";
import { decisionStamp } from "@/lib/phoenix-crm/decision-stamp";
import { earlierDecisionText } from "@/lib/phoenix-crm/earlier-decision";
import { adviseOnTimetable } from "@/lib/phoenix-crm/place-check-advice";
import type { SeatedCustomer, SeatedTimetable } from "@/lib/phoenix-crm/shared-place-groups";
import type { ValidationRefusalReason } from "@/lib/phoenix-crm/validation-feedback";

/** What the system read beside this customer's name on the building's timetable. A verdict, never a decision. */
const TIMETABLE_TEXT: Record<SeatedTimetable["verdict"], string> = {
  match: "The timetable names this customer",
  other_name: "The timetable does not name this customer",
  no_schedule: "No timetable in the photo",
  unjudged: "The timetable could not be read",
};

/** The reason the reject control starts on: the one the request names — he is not on the timetable. */
function defaultReason(customer: SeatedCustomer): ValidationRefusalReason {
  return customer.timetable?.verdict === "no_schedule" ? "schedule_missing" : "schedule_other_name";
}

/**
 * The reason a waiting row starts on: only what the system itself read. A row the timetable named
 * (or one with no timetable in the photo) opens on that reason; a customer the system could not read,
 * or read as named, opens on NOTHING, so a reject is never one click away from telling a rep that
 * the timetable does not name him when it may have.
 */
function evidenceReason(customer: SeatedCustomer, noTimetable: boolean): ValidationRefusalReason | "" {
  // The recommendation's own refusal, which is set ONLY on a confident reading — the same rule, one home.
  return adviseOnTimetable(customer.timetable, noTimetable).refusal ?? "";
}

/** Whether a decision can be made on this customer's review row — the route that keeps the evidence. */
function decidesOnReview(customer: SeatedCustomer): boolean {
  return customer.reviewId !== null && (customer.state === "waiting" || customer.refusable);
}

function Who({ customer, mode }: { customer: SeatedCustomer; mode: PlaceCheckNotesMode }) {
  const decides = usePlaceCheckDecides();
  const dated = customer.state === "sent_back" ? "Sent back" : customer.state === "in_use" ? "Seated" : "Held";
  // Who approved or refused him and when (owner, 2026-10-20) — the company board only. A rejected row
  // that can be taken back already prints the same two facts on its own card (`RestoreSeated`).
  const stamp =
    mode === "team" || (customer.state === "rejected" && customer.restorable)
      ? null
      : customer.state === "in_use"
        ? decisionStamp("Approved", customer.decidedByName, customer.decidedAtText)
        : customer.state === "sent_back" || customer.state === "rejected"
          ? decisionStamp("Rejected", customer.decidedByName, customer.decidedAtText)
          : null;
  return (
    <div className="min-w-0 space-y-1">
      <p className="break-words text-sm font-black text-slate-900" dir="auto">
        {customer.customerName}
      </p>
      <p className="break-words text-xs font-semibold text-slate-500">{[customer.listType, customer.speciality].filter(Boolean).join(" · ")}</p>
      <p className="break-words text-sm text-slate-700">{customer.repName}</p>
      <p className="break-words text-xs text-slate-500">{customer.territory}</p>
      <p className="break-words text-xs text-slate-500">
        {dated} {customer.atText}
      </p>
      {stamp ? <p className="break-words text-xs font-semibold text-slate-700">{stamp}</p> : null}
      {customer.earlierDecision ? <p className="break-words text-xs font-semibold text-slate-700">{earlierDecisionText(customer.earlierDecision)}</p> : null}
      <div className="flex min-w-0 flex-wrap gap-1">
        {customer.state === "waiting" ? <CrmPill tone="warn">{mode === "team" ? "Still being checked" : decides ? "Waiting for you" : "Waiting for the administrator"}</CrmPill> : null}
        {customer.waitingText ? <CrmPill tone={customer.waitingLong ? "warn" : "neutral"}>{customer.waitingText}</CrmPill> : null}
        {customer.state === "rejected" ? <CrmPill tone="bad">{mode === "team" ? "Settled" : "Rejected"}</CrmPill> : null}
        {customer.state === "sent_back" ? <CrmPill tone="neutral">Waiting to be captured again</CrmPill> : null}
        {customer.state === "in_use" && !customer.reviewed ? <CrmPill tone="info">Never looked at</CrmPill> : null}
        {customer.state === "in_use" && customer.reviewStatus === "approved" && mode !== "team" ? (
          // 🔴 Owner, 2026-11-23 (the Place checks audit): approved behind a building still being checked, he
          // is no decision still owed — the building's approval validates him.
          <CrmPill tone="good">{customer.waitsForBuilding ? "Approved, waits for the building" : "Approved"}</CrmPill>
        ) : null}
        {customer.isTest ? <CrmPill>Test entry</CrmPill> : null}
      </div>
    </div>
  );
}

function Timetable({
  customer,
  mode,
  noTimetable,
  venueTimetablePath,
}: {
  customer: SeatedCustomer;
  mode: PlaceCheckNotesMode;
  noTimetable: boolean;
  venueTimetablePath: string | null;
}) {
  // The photograph THIS customer's rep took is always on their row — what the checker called unreadable or
  // empty must be seen with his own eyes, and it can be the very photograph the building shows above.
  const own = customer.photoPath;
  const sameAsBuilding = own !== null && own === venueTimetablePath;
  if (noTimetable && customer.state !== "sent_back") {
    // The administrator's exception (owner, 2026-10-18): this building has no timetable, so there is no
    // verdict to draw and no photograph to show as one — the door photo on file is not a timetable.
    // 🔴 A manager's board states the fact and not who decides it (owner, 2026-10-13).
    return (
      <div className="min-w-0 space-y-1 text-sm text-slate-700">
        <CrmPill tone="neutral">This building has no timetable</CrmPill>
        {mode === "team" ? null : customer.state === "in_use" && customer.reviewStatus === "approved" ? (
          <p className="break-words text-xs text-slate-700">Validated by the administrator as an exception.</p>
        ) : customer.state === "waiting" ? (
          <p className="break-words text-xs text-slate-700">Waits for the administrator, who validates this building&apos;s customers as an exception.</p>
        ) : null}
        {customer.state === "rejected" && customer.reasonLabel ? <p className="break-words text-xs text-slate-600">The rep was told: {customer.reasonLabel}.</p> : null}
      </div>
    );
  }
  if (customer.state === "sent_back") {
    return (
      <div className="min-w-0 space-y-0.5 text-sm text-slate-700">
        <p className="break-words text-xs text-slate-700">
          {customer.reasonLabel ? `The rep was told: ${customer.reasonLabel}.` : "The rep was told what is wrong with the building's photo."}
        </p>
        {customer.waitingHours !== null ? (
          <p className="break-words text-xs text-slate-500">
            Waiting {customer.waitingHours} {customer.waitingHours === 1 ? "hour" : "hours"} so far.
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div className="min-w-0 space-y-1 text-sm text-slate-700">
      {customer.timetable ? (
        // An approved customer is drawn approved: what the system read is kept as information, never a
        // warning over a decision already taken (owner, 21 Nov 2026: "it kept not approved").
        <CrmPill tone={seatedTimetablePill(customer, customer.timetable.verdict, TIMETABLE_TEXT).tone}>
          {seatedTimetablePill(customer, customer.timetable.verdict, TIMETABLE_TEXT).text}
        </CrmPill>
      ) : (
        <p className="text-xs text-slate-500">The timetable has not been read for this customer yet.</p>
      )}
      {customer.timetable?.hoursRead ? (
        <p className="break-words text-xs text-slate-700" dir="auto">
          Hours read: {customer.timetable.hoursRead}
        </p>
      ) : null}
      {customer.timetable?.scheduleText ? (
        <p className="break-words text-xs text-slate-700" dir="auto">
          {customer.timetable.scheduleText}
        </p>
      ) : null}
      {customer.state === "rejected" && customer.reasonLabel ? <p className="break-words text-xs text-slate-600">The rep was told: {customer.reasonLabel}.</p> : null}
      {own ? <CrmPhotoThumb alt={`Timetable photo for ${customer.customerName}`} className="h-32 w-32" lazy path={own} rotatable /> : null}
      {own ? <TimetablePages firstPath={own} name={customer.customerName} rotatable thumbClassName="h-32 w-32" /> : null}
      {sameAsBuilding ? <p className="break-words text-xs text-slate-500">The same photograph as the building&apos;s timetable.</p> : null}
    </div>
  );
}

export { decidesOnReview, defaultReason, evidenceReason, Timetable, Who };
