"use client";

/**
 * Phoenix CRM — the decision on one customer seated in a polyclinic: what rejecting him costs, the
 * reject that opens on the timetable reason, the approve-or-reject of one still being checked, the
 * take-back of a rejection, and the last column that draws the right one for a decider only.
 *
 * 🔴 THE REJECT CONTROL IS THE EXISTING REFUSAL, NOT A NEW DECISION PATH. A customer with a review row
 * goes through the review decision route (it keeps the evidence the system held him on); one the system
 * never questioned goes through the refuse route, exactly as the single clinics' list does. Both use the
 * timetable pick-list (`kind="schedule"`), so a timetable refusal is never offered "a photo of paper".
 * The rep is told one closed-list sentence about his photo and never that a person looked at him.
 *
 * 🔴 A MANAGER'S BOARD (`mode="team"`) GETS NO DECISION CONTROL AND NO SENTENCE ABOUT ONE. He reads the
 * evidence and comments; who decides is not on his screen (owner, 2026-10-13).
 */

import { useState } from "react";

import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { usePlaceCheckDecides } from "@/components/phoenix-crm/place-check-decides";
import { approvalOutcome, isAlreadyDecided, PlaceCheckSaved, usePlaceCheckDone, useSavedOutcome } from "@/components/phoenix-crm/place-check-done";
import { PlaceCheckNotes, type PlaceCheckNotesMode } from "@/components/phoenix-crm/place-check-notes";
import { RestoreAfterRejection, useCanRestoreValidation } from "@/components/phoenix-crm/place-check-restore";
import { DecisionComment, RefusalReasonField } from "@/components/phoenix-crm/refusal-reason-field";
import { decidesOnReview, defaultReason, evidenceReason } from "@/components/phoenix-crm/shared-place-customers-evidence";
import { SystemAdvice } from "@/components/phoenix-crm/system-advice";
import { CrmButton, CrmNote } from "@/components/phoenix-crm/ui";
import { SUPER_ADMIN_APPROVAL_IS_FINAL_TEXT } from "@/lib/phoenix-crm/super-admin-approval-rules";
import { DOOR_CAPTURED_AGAIN_TEXT } from "@/lib/phoenix-crm/door-captured-again";
import { adviseOnTimetable } from "@/lib/phoenix-crm/place-check-advice";
import { PLACE_CHECK_VERBS } from "@/lib/phoenix-crm/place-check-lanes";
import { APPROVAL_NEEDS_FULL_NAME, approvalNeedsFullName } from "@/lib/phoenix-crm/pm-name-rules";
import { placeNoteSubjectKey } from "@/lib/phoenix-crm/place-note-rules";
import type { SeatedCustomer } from "@/lib/phoenix-crm/shared-place-groups";
import { seatedRejectWarning, VALIDATION_NOTE_LABEL, VALIDATION_REASON_REQUIRED, type ValidationRefusalReason } from "@/lib/phoenix-crm/validation-feedback";
import type { PlaceNoteIndex } from "@/lib/phoenix-crm/view-types";

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
  // Only the Super Admin approves after a rejection, so only he is told he can (owner, 2026-11-10).
  const canRestore = useCanRestoreValidation();
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
      <DecisionComment
        disabled={saving}
        id={`seated-note-${scope}-${customer.key}`}
        label={VALIDATION_NOTE_LABEL}
        onChange={(next) => {
          setNote(next);
          setArmed(false);
        }}
        value={note}
      />
      {armed ? (
        <div className="space-y-2">
          <CrmNote tone="warn">{seatedRejectWarning(canRestore)}</CrmNote>
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
            {PLACE_CHECK_VERBS.reject}
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
      const decided = await crmPost<unknown>(
        "/api/phoenix-crm/validation-reviews",
        { reviewId: customer.reviewId, decision, note, ...(decision === "reject" ? { refusalReason: reason } : {}) },
        "decided",
      );
      markSaved(done(decision === "approve" ? approvalOutcome(decided, "approved") : "rejected"));
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
      <RefusalReasonField buildingHasNoTimetable={noTimetable} disabled={saving !== null} id={`seated-reason-${scope}-${customer.key}`} kind="schedule" onChange={setReason} value={reason} />
      <DecisionComment disabled={saving !== null} id={`seated-note-${scope}-${customer.key}`} label={VALIDATION_NOTE_LABEL} onChange={setNote} value={note} />
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
  if (customer.state === "rejected") {
    if (customer.restorable) return <RestoreSeated customer={customer} scope={scope} />;
    // The database would refuse the take-back (19 Nov 2026), so the card says why and offers nothing.
    return customer.capturedAgain ? <CrmNote tone="neutral">{DOOR_CAPTURED_AGAIN_TEXT}</CrmNote> : null;
  }
  // "Reject — not on the timetable" is meaningless where the administrator declared there is none, and
  // its refusal would tell the rep something false about his photograph.
  // 🔴 What the administrator approved, only he rejects (owner, 2026-11-16).
  if (customer.state === "in_use" && customer.lockedBySuperAdmin) return <CrmNote tone="neutral">{SUPER_ADMIN_APPROVAL_IS_FINAL_TEXT}</CrmNote>;
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
  // A seated customer's decision is the Super Admin's alone (owner, 2026-11-19); the SFE Manager reads
  // where it stands in the pill beside the name and recommends below.
  const decides = usePlaceCheckDecides();
  return (
    <div className="min-w-0 space-y-2">
      {/* The system's recommendation and its reason (owner, 2026-10-17) — the Super Admin's board only,
          and never on a customer already sent back, where there is nothing left to decide. */}
      {mode === "team" || customer.state === "sent_back" || (noTimetable && customer.state !== "waiting") ? null : <SystemAdvice advice={adviseOnTimetable(customer.timetable, noTimetable)} />}
      {mode === "team" || !decides ? null : <Decision customer={customer} noTimetable={noTimetable} scope={scope} />}
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

export { LastColumn };
