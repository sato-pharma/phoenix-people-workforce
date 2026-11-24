"use client";

/**
 * Phoenix CRM — the decision on one place in use: the Super Admin's Approve of a place the system could
 * not read, his Reject with what it costs written above the button, and the last column that draws both
 * for a decider only.
 *
 * 🔴 REFUSING A PLACE THAT WAS APPROVED IN THE QUEUE ABOVE IS BETTER DONE THERE. This path rewrites the
 * review row's `google` column as `refused_by_admin`; since the validation audit of 14 Nov 2026 the
 * evidence the system held it on is kept under `before` (`evidenceToKeep`), one level deep, where the
 * queue's own "Reject it after all" leaves the record untouched. This control is for the places that
 * never reached the queue at all, which is what it was built for.
 */

import { useId, useState } from "react";

import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { usePlaceCheckDecides } from "@/components/phoenix-crm/place-check-decides";
import { isAlreadyDecided, PlaceCheckSaved, usePlaceCheckDone, useSavedOutcome } from "@/components/phoenix-crm/place-check-done";
import { PlaceCheckNotes, type PlaceCheckNotesMode } from "@/components/phoenix-crm/place-check-notes";
import { useCanRestoreValidation } from "@/components/phoenix-crm/place-check-restore";
import { DecisionComment, RefusalReasonField } from "@/components/phoenix-crm/refusal-reason-field";
import { SystemAdvice } from "@/components/phoenix-crm/system-advice";
import { CrmButton, CrmNote } from "@/components/phoenix-crm/ui";
import { adviseOnPlaceInUse } from "@/lib/phoenix-crm/place-check-advice";
import { PLACE_CHECK_VERBS } from "@/lib/phoenix-crm/place-check-lanes";
import { placeNoteSubjectKey } from "@/lib/phoenix-crm/place-note-rules";
import { approvalNeedsFullName, SHORT_NAME_APPROVAL_NOTE } from "@/lib/phoenix-crm/pm-name-rules";
import { SUPER_ADMIN_APPROVAL_IS_FINAL_TEXT } from "@/lib/phoenix-crm/super-admin-approval-rules";
import { PLACE_APPROVED_NOT_A_LIST_ADD, refusalTakeBack, VALIDATION_NOTE_LABEL, type ValidationRefusalReason } from "@/lib/phoenix-crm/validation-feedback";
import type { PlaceNoteIndex, ValidatedPlaceRow } from "@/lib/phoenix-crm/view-types";

/** What refusing this row costs, in plain words — read before the button, not after. */
function Cost({ row }: { row: ValidatedPlaceRow }) {
  const lines = [
    row.otherPlaces === 0
      ? "They go back to To validate — this is the customer's only place."
      : `The customer keeps ${row.otherPlaces === 1 ? "their other place" : `their other ${row.otherPlaces} places`}, so they stay validated.`,
    row.visits === 0 ? "No visit is measured against it yet." : `${row.visits} ${row.visits === 1 ? "visit is" : "visits are"} measured against it, and ${row.visits === 1 ? "it loses its distance" : "they lose their distances"}.`,
  ];
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
 * 🔴 FOLDED UNTIL HE PRESSES IT (owner, 2026-10-17: "make me see what is the unreadable — the photos, I
 * must be able to see the photos"). The reason list, the note and the cost stood open on every row, so
 * the form was most of the row and the photograph a 113-pixel square beside it. Closed, a row is the
 * photo, who took it, what the reader saw, the system's advice and one button.
 */
function RejectInUse({ row, scope = "" }: { row: ValidatedPlaceRow; scope?: string }) {
  const done = usePlaceCheckDone();
  const canRestore = useCanRestoreValidation();
  const { saved, markSaved } = useSavedOutcome(row);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  // Opens on the reason the system's own confident reading gives, and on nothing otherwise.
  const [reason, setReason] = useState<ValidationRefusalReason | "">(() => adviseOnPlaceInUse(row).refusal ?? "");
  const [armed, setArmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function refuse() {
    if (saving) return;
    setSaving(true);
    setProblem(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/validation-reviews/refuse", { placeId: row.placeId, note, refusalReason: reason }, "refused");
      markSaved(done("refused"));
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

  // Approve, drawn beside this control on every row, reads the same saved mark and draws it once; drawn here
  // too, one press showed its outcome twice (17 Nov 2026).
  if (saved) return null;

  // 🔴 What the administrator approved — a trusted point included — only he refuses (owner, 2026-11-16).
  if (row.lockedBySuperAdmin) return <CrmNote tone="neutral">{SUPER_ADMIN_APPROVAL_IS_FINAL_TEXT}</CrmNote>;

  if (!open) {
    return (
      <CrmButton onClick={() => setOpen(true)} variant="danger">
        {PLACE_CHECK_VERBS.reject}
      </CrmButton>
    );
  }

  return (
    <div className="space-y-2">
      <Cost row={row} />
      <RefusalReasonField
        disabled={saving}
        id={`refuse-reason-${scope}${row.placeId}`}
        kind={row.photoKind}
        onChange={(next) => {
          setReason(next);
          setArmed(false);
        }}
        value={reason}
      />
      <DecisionComment
        disabled={saving}
        id={`refuse-note-${scope}${row.placeId}`}
        label={VALIDATION_NOTE_LABEL}
        onChange={(next) => {
          setNote(next);
          setArmed(false);
        }}
        value={note}
      />
      {armed ? (
        <div className="space-y-2">
          <CrmNote tone="warn">This retires the place — they validate the customer again from their own list. {refusalTakeBack(canRestore)}</CrmNote>
          <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
            <CrmButton disabled={saving} onClick={() => void refuse()} variant="danger">
              {saving ? "Rejecting…" : "Yes, reject it"}
            </CrmButton>
            <CrmButton disabled={saving} onClick={() => setArmed(false)}>
              Keep it
            </CrmButton>
          </div>
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
          <CrmButton disabled={reason === ""} onClick={() => setArmed(true)} variant="danger">
            Reject it
          </CrmButton>
          <CrmButton disabled={saving} onClick={() => setOpen(false)}>
            Cancel
          </CrmButton>
        </div>
      )}
      {reason === "" && !armed ? <p className="text-xs text-slate-500">Choose what is wrong with the photo first.</p> : null}
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
    </div>
  );
}

/**
 * Confirm it himself (owner, 2026-10-17: *"make me able to approve"* — "I can read them. So why you
 * cannot?"). One press: the customer is already validated, so approving changes nothing the rep sees;
 * it records that the Super Admin looked and confirmed, and the place leaves Not confirmed.
 *
 * The comment box stays folded so a row is still the photo and one button, and a comment written in it
 * reaches the rep and their manager (owner, 2026-11-01).
 */
function Approve({ row }: { row: ValidatedPlaceRow }) {
  const done = usePlaceCheckDone();
  const { saved, markSaved } = useSavedOutcome(row);
  const noteFieldId = useId();
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A clinic customer with one or two names: said beside Approve, never a refusal — the Super Admin is never
  // blocked (owner, 24 Nov 2026).
  const shortName = approvalNeedsFullName(row);

  async function approve() {
    if (saving) return;
    setSaving(true);
    setProblem(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/validation-reviews/approve", { placeId: row.placeId, note }, "approved");
      markSaved(done("approved"));
      setSaving(false);
    } catch (error) {
      if (isAlreadyDecided(error)) {
        markSaved(done("already"));
        setSaving(false);
        return;
      }
      setProblem(messageOf(error));
      setSaving(false);
    }
  }

  if (saved) return <PlaceCheckSaved outcome={saved} />;

  return (
    <div className="space-y-2">
      <DecisionComment disabled={saving} id={noteFieldId} label={VALIDATION_NOTE_LABEL} onChange={setNote} value={note} />
      <CrmButton disabled={saving} onClick={() => void approve()} variant="primary">
        {saving ? "Approving…" : PLACE_CHECK_VERBS.approve}
      </CrmButton>
      {shortName ? <p className="break-words text-xs font-semibold text-slate-700">{SHORT_NAME_APPROVAL_NOTE}</p> : null}
      <p className="break-words text-xs text-slate-500">{PLACE_APPROVED_NOT_A_LIST_ADD}</p>
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
    </div>
  );
}

/**
 * The last column, both modes together.
 *
 * 🔴 `RejectInUse` IS NOT RENDERED FOR A MANAGER, AND NEITHER IS ITS WARNING. Rejecting a validation retires
 * the place and can send the customer back to To validate — it is a decision, and the decision is the
 * deciders' alone (the Super Admin and the SFE Manager). A manager comments and recommends, and the
 * owner's instruction on 2026-10-13 was that his screen does not say who makes the call.
 *
 * `scope` keeps the phone cards' field ids apart from the table's (17 Nov 2026, the audit): both are on the
 * page at once, one of them hidden, and the same id twice sent a label's tap to the hidden copy.
 */
function LastColumn({ mode, noteIndex, row, scope }: { mode: PlaceCheckNotesMode; noteIndex: PlaceNoteIndex; row: ValidatedPlaceRow; scope: string }) {
  const key = placeNoteSubjectKey("place", row.placeId);
  // Approve and Reject are decisions — the Super Admin's alone since 2026-11-19, never the SFE Manager's.
  const decides = usePlaceCheckDecides();
  const decider = mode !== "team" && decides;
  return (
    <div className="min-w-0 space-y-2">
      {/* The system's recommendation and its reason (owner, 2026-10-17) — the company board only. */}
      {mode === "team" ? null : <SystemAdvice advice={adviseOnPlaceInUse(row)} />}
      {decider ? <Approve row={row} /> : null}
      {decider ? <RejectInUse row={row} scope={scope} /> : null}
      <PlaceCheckNotes
        integrity={noteIndex.integrity[key] ?? []}
        mode={mode}
        notes={noteIndex.notes[key] ?? []}
        recommendations={noteIndex.recommendations[key] ?? []}
        subjectId={row.placeId}
        subjectKind="place"
      />
    </div>
  );
}

export { Approve, LastColumn, RejectInUse };
