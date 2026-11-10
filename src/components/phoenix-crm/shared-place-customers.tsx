"use client";

/**
 * Phoenix CRM — the customers seated in one polyclinic, drawn under the building itself (owner,
 * 2026-10-17: "make sure every polyclinic is grouped with the customers in it, showing … the customers'
 * timetable, and make the option for the admin to reject a customer who is not in the timetable").
 *
 * A seated customer has no sign and no reading of his own — the building holds both — so what stands
 * behind his name is the TIMETABLE inside it, photographed once for everybody. Each row therefore says
 * what the system read beside his name on that timetable (it names him, names somebody else, or there
 * is no timetable in the photo), shows his own copy of the photo only when it is not the building's, and
 * gives the Super Admin the one control the request names: reject him because he is not on it.
 *
 * 🔴 THE REJECT CONTROL IS THE EXISTING REFUSAL, NOT A NEW DECISION PATH. A customer with a review row
 * goes through the review decision route (it keeps the evidence the system held him on); one the system
 * never questioned goes through the refuse route, exactly as the single clinics' list does. Both use the
 * timetable pick-list (`kind="schedule"`), so a timetable refusal is never offered "a photo of paper".
 * The rep is told one closed-list sentence about his photo and never that a person looked at him.
 *
 * 🔴 A MANAGER'S BOARD (`mode="team"`) GETS NO DECISION CONTROL AND NO SENTENCE ABOUT ONE. He reads the
 * evidence and comments; who decides is not on his screen (owner, 2026-10-13).
 *
 * A desktop stacks the customers inside their building's own first cell (the list is one row per
 * building); a phone draws the same customers as cards. Square corners throughout.
 */

import { useState } from "react";

import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { isAlreadyDecided, PlaceCheckSaved, usePlaceCheckDone, useSavedOutcome } from "@/components/phoenix-crm/place-check-done";
import { PlaceCheckNotes, type PlaceCheckNotesMode } from "@/components/phoenix-crm/place-check-notes";
import { RestoreAfterRejection } from "@/components/phoenix-crm/place-check-restore";
import { CrmPhotoThumb } from "@/components/phoenix-crm/photo";
import { RefusalNoteHint, RefusalReasonField } from "@/components/phoenix-crm/refusal-reason-field";
import { SystemAdvice } from "@/components/phoenix-crm/system-advice";
import { CrmButton, CrmCardsOnPhone, CrmNote, CrmPill, crmTextareaClassName } from "@/components/phoenix-crm/ui";
import { decisionStamp } from "@/lib/phoenix-crm/decision-stamp";
import { adviseOnTimetable } from "@/lib/phoenix-crm/place-check-advice";
import { APPROVAL_NEEDS_FULL_NAME, approvalNeedsFullName } from "@/lib/phoenix-crm/pm-name-rules";
import { placeNoteSubjectKey } from "@/lib/phoenix-crm/place-note-rules";
import type { SeatedCustomer, SeatedTimetable } from "@/lib/phoenix-crm/shared-place-groups";
import { VALIDATION_NOTE_LABEL, VALIDATION_REASON_REQUIRED, type ValidationRefusalReason } from "@/lib/phoenix-crm/validation-feedback";
import type { PlaceNoteIndex } from "@/lib/phoenix-crm/view-types";

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
  const dated = customer.state === "sent_back" ? "Sent back" : customer.state === "in_use" ? "Seated" : "Held";
  // Who approved or refused him and when (owner, 2026-10-20) — the company board only. A rejected row
  // that can be taken back already prints the same two facts on its own card (`RestoreSeated`).
  const stamp =
    mode === "team" || (customer.state === "rejected" && customer.restorable)
      ? null
      : customer.state === "in_use"
        ? decisionStamp("Approved", customer.decidedByName, customer.decidedAtText)
        : customer.state === "sent_back" || customer.state === "rejected"
          ? decisionStamp("Refused", customer.decidedByName, customer.decidedAtText)
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
      <div className="flex min-w-0 flex-wrap gap-1">
        {customer.state === "waiting" ? <CrmPill tone="warn">{mode === "team" ? "Still being checked" : "Waiting for you"}</CrmPill> : null}
        {customer.state === "rejected" ? <CrmPill tone="bad">{mode === "team" ? "Settled" : "Rejected"}</CrmPill> : null}
        {customer.state === "sent_back" ? <CrmPill tone="neutral">Waiting to be captured again</CrmPill> : null}
        {customer.state === "in_use" && !customer.reviewed ? <CrmPill tone="info">Never looked at</CrmPill> : null}
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
        <CrmPill tone={customer.timetable.verdict === "match" ? "good" : customer.timetable.verdict === "unjudged" ? "neutral" : "warn"}>
          {TIMETABLE_TEXT[customer.timetable.verdict]}
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
      {own ? <CrmPhotoThumb alt={`Timetable photo for ${customer.customerName}`} className="h-32 w-32" path={own} rotatable /> : null}
      {sameAsBuilding ? <p className="break-words text-xs text-slate-500">The same photograph as the building&apos;s timetable.</p> : null}
    </div>
  );
}

/** What rejecting one seated customer costs, in plain words — read before the button, not after. */
function Cost({ customer }: { customer: SeatedCustomer }) {
  const lines = [
    customer.otherPlaces === null
      ? "This retires their seat in the building; when it is their only place they go back to To validate."
      : customer.otherPlaces === 0
        ? "They go back to To validate — this is the customer's only place."
        : `The customer keeps ${customer.otherPlaces === 1 ? "their other place" : `their other ${customer.otherPlaces} places`}, so they stay validated.`,
    "The building and everybody else seated in it are not touched.",
  ];
  if (customer.visits !== null && customer.visits > 0) {
    lines.push(`${customer.visits} ${customer.visits === 1 ? "visit is" : "visits are"} measured against the seat, and ${customer.visits === 1 ? "it loses its distance" : "they lose their distances"}.`);
  }
  return (
    <ul className="space-y-0.5">
      {lines.map((line) => (
        <li key={line} className="break-words text-xs text-slate-600">
          {line}
        </li>
      ))}
    </ul>
  );
}

/**
 * The reject control (owner, 2026-10-17: "the option for the admin to reject a customer who is not in
 * the timetable"). It opens already pointed at the reason the request names — the timetable does not
 * name this customer — and a different timetable reason can still be picked. The note stays optional.
 */
function RejectNotOnTimetable({ customer, scope }: { customer: SeatedCustomer; scope: string }) {
  const done = usePlaceCheckDone();
  const { saved, markSaved } = useSavedOutcome(customer);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ValidationRefusalReason | "">(defaultReason(customer));
  const [note, setNote] = useState("");
  const [armed, setArmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function reject() {
    if (saving || reason === "") return;
    setSaving(true);
    setProblem(null);
    try {
      if (decidesOnReview(customer)) {
        await crmPost<unknown>("/api/phoenix-crm/validation-reviews", { reviewId: customer.reviewId, decision: "reject", note, refusalReason: reason }, "decided");
      } else {
        await crmPost<unknown>("/api/phoenix-crm/validation-reviews/refuse", { placeId: customer.placeId, note, refusalReason: reason }, "refused");
      }
      markSaved(done("rejected"));
      setSaving(false);
    } catch (error) {
      if (isAlreadyDecided(error)) {
        markSaved(done("already"));
        setSaving(false);
        return;
      }
      setProblem(messageOf(error));
      setSaving(false);
      setArmed(false);
    }
  }

  if (saved) return <PlaceCheckSaved outcome={saved} />;

  if (!open) {
    return (
      <CrmButton onClick={() => setOpen(true)} variant="danger">
        Reject — not on the timetable
      </CrmButton>
    );
  }

  return (
    <div className="space-y-2">
      <Cost customer={customer} />
      <RefusalReasonField
        disabled={saving}
        id={`seated-reason-${scope}-${customer.key}`}
        kind="schedule"
        onChange={(next) => {
          setReason(next);
          setArmed(false);
        }}
        value={reason}
      />
      <label className="block text-xs font-black uppercase tracking-[0.12em] text-slate-500" htmlFor={`seated-note-${scope}-${customer.key}`}>
        {VALIDATION_NOTE_LABEL}
      </label>
      <textarea
        className={crmTextareaClassName}
        disabled={saving}
        id={`seated-note-${scope}-${customer.key}`}
        maxLength={500}
        onChange={(event) => {
          setNote(event.target.value);
          setArmed(false);
        }}
        rows={2}
        value={note}
      />
      <RefusalNoteHint />
      {armed ? (
        <div className="space-y-2">
          <CrmNote tone="warn">This retires their seat — the rep captures the customer again from their own list. You can approve it after all from this row.</CrmNote>
          <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
            <CrmButton busy={saving} disabled={saving} onClick={() => void reject()} variant="danger">
              {saving ? "Rejecting…" : "Yes, reject them"}
            </CrmButton>
            <CrmButton
              disabled={saving}
              onClick={() => {
                setArmed(false);
                setOpen(false);
              }}
            >
              Keep them
            </CrmButton>
          </div>
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
          <CrmButton disabled={reason === "" || saving} onClick={() => setArmed(true)} variant="danger">
            Reject this customer
          </CrmButton>
          <CrmButton disabled={saving} onClick={() => setOpen(false)}>
            Cancel
          </CrmButton>
        </div>
      )}
      {reason === "" && !armed ? <p className="break-words text-xs text-slate-500">{VALIDATION_REASON_REQUIRED}</p> : null}
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
    </div>
  );
}

/** A customer the system is still checking: approve him, or reject him with a timetable reason. */
function WaitingDecision({ customer, noTimetable, scope }: { customer: SeatedCustomer; noTimetable: boolean; scope: string }) {
  const done = usePlaceCheckDone();
  const { saved, markSaved } = useSavedOutcome(customer);
  const [note, setNote] = useState("");
  // A clinic customer with one or two names is never approved — sent back for all three (owner, 2026-11-07).
  const shortName = approvalNeedsFullName(customer);
  const [reason, setReason] = useState<ValidationRefusalReason | "">(shortName ? "short_name" : evidenceReason(customer, noTimetable));
  const [saving, setSaving] = useState<"approve" | "reject" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject") {
    if (saving || !customer.reviewId) return;
    setSaving(decision);
    setProblem(null);
    try {
      await crmPost<unknown>(
        "/api/phoenix-crm/validation-reviews",
        { reviewId: customer.reviewId, decision, note, ...(decision === "reject" ? { refusalReason: reason } : {}) },
        "decided",
      );
      markSaved(done(decision === "approve" ? "approved" : "rejected"));
      setSaving(null);
    } catch (error) {
      if (isAlreadyDecided(error)) {
        markSaved(done("already"));
        setSaving(null);
        return;
      }
      setProblem(messageOf(error));
      setSaving(null);
    }
  }

  if (saved) return <PlaceCheckSaved outcome={saved} />;

  return (
    <div className="space-y-2">
      <RefusalReasonField disabled={saving !== null} id={`seated-reason-${scope}-${customer.key}`} kind="schedule" onChange={setReason} value={reason} />
      <label className="block text-xs font-black uppercase tracking-[0.12em] text-slate-500" htmlFor={`seated-note-${scope}-${customer.key}`}>
        {VALIDATION_NOTE_LABEL}
      </label>
      <textarea
        className={crmTextareaClassName}
        disabled={saving !== null}
        id={`seated-note-${scope}-${customer.key}`}
        maxLength={500}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        value={note}
      />
      <RefusalNoteHint />
      <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
        <CrmButton disabled={saving !== null || shortName} onClick={() => void decide("approve")} variant="primary">
          {saving === "approve" ? "Approving…" : "Approve"}
        </CrmButton>
        <CrmButton disabled={saving !== null || reason === ""} onClick={() => void decide("reject")} variant="danger">
          {saving === "reject" ? "Rejecting…" : "Reject"}
        </CrmButton>
      </div>
      {shortName ? <p className="break-words text-xs font-semibold text-slate-700">{APPROVAL_NEEDS_FULL_NAME}</p> : null}
      {reason === "" ? <p className="break-words text-xs text-slate-500">{VALIDATION_REASON_REQUIRED} Approve needs no reason.</p> : null}
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
    </div>
  );
}

/** Taking a rejection back — the mirror of the reject, through the review restore route. */
function RestoreSeated({ customer, scope }: { customer: SeatedCustomer; scope: string }) {
  // Who refused them and when stays on the card for every decider; the take-back under it is the Super
  // Admin's alone and never greyed out for a short name (owner, 2026-11-10) — place-check-restore.tsx.
  return (
    <div className="min-w-0 space-y-2">
      <p className="break-words text-xs text-slate-500">{[customer.decidedByName, customer.decidedAtText].filter(Boolean).join(" · ")}</p>
      {customer.decisionNote ? <p className="break-words text-xs text-slate-600">{customer.decisionNote}</p> : null}
      <RestoreAfterRejection
        busyLabel="Bringing them back"
        customerName={customer.customerName}
        idKey={`seated-${scope}-${customer.key}`}
        listType={customer.listType}
        reviewId={customer.reviewId}
        row={customer}
      />
    </div>
  );
}

/** The decision control that fits where this customer stands. */
function Decision({ customer, noTimetable, scope }: { customer: SeatedCustomer; noTimetable: boolean; scope: string }) {
  if (customer.state === "waiting" && customer.reviewId) return <WaitingDecision customer={customer} noTimetable={noTimetable} scope={scope} />;
  if (customer.state === "rejected") return customer.restorable ? <RestoreSeated customer={customer} scope={scope} /> : null;
  // "Reject — not on the timetable" is meaningless where the administrator declared there is none, and
  // its refusal would tell the rep something false about his photograph.
  if (customer.state === "in_use" && customer.placeId && !noTimetable) return <RejectNotOnTimetable customer={customer} scope={scope} />;
  return null;
}

/**
 * The last column, both modes together.
 *
 * 🔴 A MANAGER GETS NO `Decision` AND NOT EVEN THE `Cost` WARNING INSIDE IT. Rejecting a seated customer
 * retires his seat and can send him back to To validate — the Super Admin's alone. A manager reads the
 * timetable evidence, comments on it and recommends.
 */
function LastColumn({
  customer,
  mode,
  noTimetable,
  noteIndex,
  scope,
}: {
  customer: SeatedCustomer;
  mode: PlaceCheckNotesMode;
  noTimetable: boolean;
  noteIndex: PlaceNoteIndex;
  scope: string;
}) {
  const key = customer.placeId ? placeNoteSubjectKey("place", customer.placeId) : null;
  return (
    <div className="min-w-0 space-y-2">
      {/* The system's recommendation and its reason (owner, 2026-10-17) — the Super Admin's board only,
          and never on a customer already sent back, where there is nothing left to decide. */}
      {mode === "team" || customer.state === "sent_back" || (noTimetable && customer.state !== "waiting") ? null : <SystemAdvice advice={adviseOnTimetable(customer.timetable, noTimetable)} />}
      {mode === "team" ? null : <Decision customer={customer} noTimetable={noTimetable} scope={scope} />}
      {customer.placeId && key ? (
        <PlaceCheckNotes
          integrity={noteIndex.integrity[key] ?? []}
          mode={mode}
          notes={noteIndex.notes[key] ?? []}
          recommendations={noteIndex.recommendations[key] ?? []}
          subjectId={customer.placeId}
          subjectKind="place"
        />
      ) : null}
    </div>
  );
}

export function SeatedCustomers({
  customers,
  layout = "both",
  mode,
  noTimetable,
  noteIndex,
  total,
  venueTimetablePath,
}: {
  customers: SeatedCustomer[];
  /**
   * Which of the two layouts to draw. The polyclinic list already draws a phone block and a desktop
   * block, and hands each one the matching layout, so a customer is on the page once per screen size
   * and a control's label always points at the control the reader can see.
   */
  layout?: "both" | "cards" | "table";
  mode: PlaceCheckNotesMode;
  /** The administrator declared this building has no timetable — see `SharedPlaceBoardRow.timetableExempt`. */
  noTimetable: boolean;
  noteIndex: PlaceNoteIndex;
  /** How many are seated in the building before the filters, so a narrowed list says so. */
  total: number;
  /** The building's one timetable, so a customer's own copy is drawn only when it is a different photograph. */
  venueTimetablePath: string | null;
}) {
  if (customers.length === 0) {
    return (
      <p className="break-words px-4 py-3 text-xs text-slate-500">
        {total === 0 ? "Nobody is seated in this building yet." : `${total} ${total === 1 ? "customer is" : "customers are"} seated here; none match these filters.`}
      </p>
    );
  }
  return (
    <div className="min-w-0">
      <p className="break-words px-4 pt-3 text-xs font-black uppercase tracking-[0.12em] text-slate-500">
        {customers.length === total ? `Customers seated here (${total})` : `Customers seated here (${customers.length} of ${total})`}
      </p>
      {layout !== "table" ? (
        <CrmCardsOnPhone>
          {customers.map((customer) => (
            <div key={customer.key} className="space-y-3 px-4 py-4">
              <Who customer={customer} mode={mode} />
              <Timetable customer={customer} mode={mode} noTimetable={noTimetable} venueTimetablePath={venueTimetablePath} />
              <LastColumn customer={customer} mode={mode} noTimetable={noTimetable} noteIndex={noteIndex} scope="cards" />
            </div>
          ))}
        </CrmCardsOnPhone>
      ) : null}
      {/* On a desktop the customers sit in their building's own first cell, one block each: a table
          inside a table cell would be a second row for the same building. */}
      {layout !== "cards" ? (
        <div className="hidden min-w-0 md:block">
          {customers.map((customer) => (
            <div key={customer.key} className="space-y-3 border-t border-slate-100 px-4 py-3 first:border-t-0">
              <Who customer={customer} mode={mode} />
              <Timetable customer={customer} mode={mode} noTimetable={noTimetable} venueTimetablePath={venueTimetablePath} />
              <LastColumn customer={customer} mode={mode} noTimetable={noTimetable} noteIndex={noteIndex} scope="table" />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The pieces the one-by-one review draws each seated customer with (owner, 2026-10-18: "approve or
 * reject the timetable or schedule alone … per customer"), exported as they are — the same evidence and
 * the same controls, never a copy.
 */
export { LastColumn as SeatedLastColumn, Timetable as SeatedTimetableEvidence, Who as SeatedWho };
