"use client";

/**
 * Phoenix CRM — the Super Admin's queue: the decision on one held place. Approve or Reject while it
 * waits, each decision's take-back once it is settled, the settled state a district manager reads, and
 * the last column that chooses between them by who is reading.
 *
 * 🔴 ONE DECISION PATH. Every control here posts to the review's own decision route, or draws the one
 * take-back (`place-check-restore.tsx`), and reports what it saved through `usePlaceCheckDone`. The
 * one-by-one review draws these same controls — never a copy of one.
 */

import { useState } from "react";

import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { PlaceCheckDecisionState, usePlaceCheckDecides } from "@/components/phoenix-crm/place-check-decides";
import { approvalOutcome, isAlreadyDecided, PlaceCheckSaved, usePlaceCheckDone, useSavedOutcome } from "@/components/phoenix-crm/place-check-done";
import { PlaceCheckNotes, type PlaceCheckNotesMode } from "@/components/phoenix-crm/place-check-notes";
import { RestoreAfterRejection } from "@/components/phoenix-crm/place-check-restore";
import { DecisionComment, RefusalReasonField, RefusalReasonPick } from "@/components/phoenix-crm/refusal-reason-field";
import { SystemAdvice } from "@/components/phoenix-crm/system-advice";
import { CrmButton, CrmNote, CrmPill } from "@/components/phoenix-crm/ui";
import { DOOR_CAPTURED_AGAIN_TEXT } from "@/lib/phoenix-crm/door-captured-again";
import { adviseOnReview } from "@/lib/phoenix-crm/place-check-advice";
import { approvalNeedsFullName, SHORT_NAME_APPROVAL_NOTE } from "@/lib/phoenix-crm/pm-name-rules";
import { placeNoteSubjectKey } from "@/lib/phoenix-crm/place-note-rules";
import { SUPER_ADMIN_APPROVAL_IS_FINAL_TEXT } from "@/lib/phoenix-crm/super-admin-approval-rules";
import {
  PLACE_APPROVED_NOT_A_LIST_ADD,
  VALIDATION_NOTE_LABEL,
  VALIDATION_REASON_REQUIRED,
  type ValidationRefusalReason,
} from "@/lib/phoenix-crm/validation-feedback";
import type { PlaceNoteIndex, ValidationReviewRow } from "@/lib/phoenix-crm/view-types";

/**
 * Taking a rejection back (owner, 2026-10-03: "add the option to approve after reject"). Offered only
 * while the place is still retired and nothing newer has been said about it — the same test the
 * database makes. The note is OPTIONAL since 2026-10-15, as it is everywhere on this page.
 */
function Restore({ row, scope }: { row: ValidationReviewRow; scope: string }) {
  // The Super Admin alone, and never greyed out for a short name (owner, 2026-11-10) — place-check-restore.tsx.
  return (
    <RestoreAfterRejection
      busyLabel="Bringing it back…"
      customerName={row.customerName}
      explanation={<>The place comes back and the customer is validated again in {row.repName}&rsquo;s own name. Their visits are measured against it again.</>}
      idKey={`${scope}${row.reviewId}`}
      listType={row.listType}
      reviewId={row.reviewId}
      row={row}
    />
  );
}

/**
 * Taking an APPROVAL back (owner, 2026-10-15: "make admin able to reject validation even if approved
 * before"). The mirror of `Restore` above, offered only while the place that approval let stand is
 * still active — the same test the database makes.
 *
 * 🔴 IT POSTS THE SAME DECISION THE PENDING ROW POSTS, to the same route: the database lets a REJECT
 * through on an approved review since migration 20261015212903, so this is one reject path and one
 * audit shape, and the review row KEEPS the evidence the system originally held it on. The other way
 * round — refusing the same place from "Validations the system did not question" — rewrites the record
 * as `refused_by_admin` and keeps that evidence one level down, under `before` (14 Nov 2026), which is
 * why this control exists here.
 */
function RejectAfterApproval({ row, scope }: { row: ValidationReviewRow; scope: string }) {
  const done = usePlaceCheckDone();
  const { saved, markSaved } = useSavedOutcome(row);
  const [note, setNote] = useState("");
  // Opens on the reason the system's own confident reading gives, and on nothing otherwise.
  const [reason, setReason] = useState<ValidationRefusalReason | "">(() => adviseOnReview(row).refusal ?? "");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function reject() {
    if (saving || reason === "") return;
    setSaving(true);
    setProblem(null);
    try {
      await crmPost<unknown>(
        "/api/phoenix-crm/validation-reviews",
        { reviewId: row.reviewId, decision: "reject", note, refusalReason: reason },
        "decided",
      );
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
    }
  }

  if (saved) return <PlaceCheckSaved outcome={saved} />;

  return (
    <div className="space-y-2 border-t border-slate-100 pt-2">
      <RefusalReasonField
        disabled={saving}
        id={`reject-again-reason-${scope}${row.reviewId}`}
        kind={row.photoKind}
        onChange={setReason}
        value={reason}
      />
      <DecisionComment disabled={saving} id={`reject-again-note-${scope}${row.reviewId}`} label={VALIDATION_NOTE_LABEL} onChange={setNote} value={note} />
      <CrmButton disabled={saving || reason === ""} onClick={() => void reject()} variant="danger">
        {saving ? "Rejecting…" : "Reject it after all"}
      </CrmButton>
      <p className="break-words text-xs text-slate-500">
        This retires the place the approval let stand; when it is the customer&rsquo;s only one, they go back to To validate and{" "}
        {row.repName} is told what is wrong with the photo.
      </p>
      {reason === "" ? <p className="break-words text-xs text-slate-500">{VALIDATION_REASON_REQUIRED}</p> : null}
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
    </div>
  );
}

/**
 * A settled row, as the DISTRICT MANAGER reads it (owner, 2026-10-13).
 *
 * 🔴 IT NAMES NOBODY AND CARRIES NO NOTE. `decidedByName` is the Super Admin, and `decisionNote` may be
 * a note written before 2026-11-01 under the promise that nobody else reads it, so neither appears here.
 * A comment written with a decision since then reaches him as a comment, in `PlaceCheckNotes` under this,
 * by role alone. What appears here is the one sentence the rep himself was told about his photograph.
 * There is no "approve it after all" either: taking a decision back is not his.
 */
function Settled({ row }: { row: ValidationReviewRow }) {
  if (row.status === "pending") return null;
  return (
    <div className="min-w-0 space-y-1">
      <CrmPill tone={row.status === "approved" ? "good" : "warn"}>{row.status === "approved" ? "Validated" : "Sent back"}</CrmPill>
      {row.status === "approved" ? <p className="break-words text-xs text-slate-500">{PLACE_APPROVED_NOT_A_LIST_ADD}</p> : null}
      {row.decidedAtText ? <p className="break-words text-xs text-slate-500">{row.decidedAtText}</p> : null}
      {row.refusalLabel ? <p className="break-words text-xs font-semibold text-slate-700">The rep was told: {row.refusalLabel}</p> : null}
    </div>
  );
}

function Decision({ row, scope = "" }: { row: ValidationReviewRow; scope?: string }) {
  const done = usePlaceCheckDone();
  const { saved, markSaved } = useSavedOutcome(row);
  const [note, setNote] = useState("");
  // A clinic customer with only one or two names: the reason opens on short_name, so Reject sends him back
  // for all three (owner, 2026-11-07). Approve stays open — the Super Admin is never blocked (24 Nov 2026).
  const shortName = approvalNeedsFullName(row);
  // Opens on the reason the system's own confident reading gives, and on nothing otherwise.
  const [reason, setReason] = useState<ValidationRefusalReason | "">(() => (shortName ? "short_name" : (adviseOnReview(row).refusal ?? "")));
  const [saving, setSaving] = useState<"approve" | "reject" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Reject with no reason chosen opens the list of reasons; pressing one sends it (RefusalReasonPick).
  const [picking, setPicking] = useState(false);

  if (saved) return <PlaceCheckSaved outcome={saved} />;

  if (row.status !== "pending") {
    return (
      <div className="space-y-1">
        <CrmPill tone={row.status === "approved" ? "good" : "warn"}>{row.status === "approved" ? "Approved" : "Rejected"}</CrmPill>
        {row.status === "approved" ? <p className="break-words text-xs text-slate-500">{PLACE_APPROVED_NOT_A_LIST_ADD}</p> : null}
        <p className="break-words text-xs text-slate-500">{[row.decidedByName, row.decidedAtText].filter(Boolean).join(" · ")}</p>
        {row.refusalLabel ? <p className="break-words text-xs font-semibold text-slate-700">The rep was told: {row.refusalLabel}</p> : null}
        {row.decisionNote ? <p className="break-words text-xs text-slate-600">{row.decisionNote}</p> : null}
        {row.restorable ? <Restore row={row} scope={scope} /> : null}
        {/* Captured again since (19 Nov 2026): a fact beside the button, which stays (owner, 24 Nov 2026). */}
        {row.capturedAgain ? <CrmNote tone="neutral">{DOOR_CAPTURED_AGAIN_TEXT}</CrmNote> : null}
        {row.refusable ? <RejectAfterApproval row={row} scope={scope} /> : null}
        {/* What the administrator approved, only he rejects (owner, 2026-11-16). */}
        {row.status === "approved" && row.lockedBySuperAdmin ? <CrmNote tone="neutral">{SUPER_ADMIN_APPROVAL_IS_FINAL_TEXT}</CrmNote> : null}
      </div>
    );
  }

  async function decide(decision: "approve" | "reject", why: ValidationRefusalReason | "" = reason) {
    if (saving) return;
    setSaving(decision);
    setProblem(null);
    try {
      const decided = await crmPost<unknown>(
        "/api/phoenix-crm/validation-reviews",
        { reviewId: row.reviewId, decision, note, ...(decision === "reject" ? { refusalReason: why } : {}) },
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

  // 🔴 THE DECISION READS TOP TO BOTTOM, THEN THE PRESS (owner, 17 Nov 2026: "simple to decide"): what the
  // rep is told when the system is confident of it, an optional comment folded behind one link, the two
  // buttons. 🔴 REJECT IS ONE PRESS ON A REASON ALREADY CHOSEN AND TWO OTHERWISE (owner, 23 Nov 2026):
  // with none chosen, Reject opens the reasons and the reason pressed sends it. The "does not add to the
  // list" sentence is the lane's own, once, not every row's.
  return (
    <div className="space-y-2.5">
      {reason === "" || picking ? null : (
        <RefusalReasonField
          disabled={saving !== null}
          id={`review-reason-${scope}${row.reviewId}`}
          kind={row.photoKind}
          onChange={setReason}
          value={reason}
        />
      )}
      <DecisionComment disabled={saving !== null} id={`review-note-${scope}${row.reviewId}`} label={VALIDATION_NOTE_LABEL} onChange={setNote} value={note} />
      {picking ? (
        <RefusalReasonPick
          disabled={saving !== null}
          kind={row.photoKind}
          onBack={() => setPicking(false)}
          onPick={(next) => {
            setReason(next);
            setPicking(false);
            void decide("reject", next);
          }}
        />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2" data-decide-pair>
          <CrmButton disabled={saving !== null} onClick={() => void decide("approve")} variant="primary">
            {saving === "approve" ? "Approving…" : "Approve"}
          </CrmButton>
          <CrmButton disabled={saving !== null} onClick={() => (reason === "" ? setPicking(true) : void decide("reject"))} variant="danger">
            {saving === "reject" ? "Rejecting…" : "Reject"}
          </CrmButton>
        </div>
      )}
      {shortName ? <p className="break-words text-xs font-semibold text-slate-700">{SHORT_NAME_APPROVAL_NOTE}</p> : null}
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
    </div>
  );
}

/**
 * The last column, both modes in one place so the two can never disagree about what a manager sees:
 * the Super Admin keeps every control he has had since 2026-10-03 and reads what the manager wrote
 * under it; the manager gets the settled state, his comments and his two recommendation buttons, and
 * no decision control of any kind.
 *
 * `scope` keeps the phone cards' field ids apart from the table's (17 Nov 2026, the audit): both are on the
 * page at once, one of them hidden, and the same id twice sent a label's tap to the hidden copy.
 */
function LastColumn({ mode, noteIndex, row, scope }: { mode: PlaceCheckNotesMode; noteIndex: PlaceNoteIndex; row: ValidationReviewRow; scope: string }) {
  const key = placeNoteSubjectKey("place", row.placeId);
  // The SFE Manager reads the company board and decides nothing on it (owner, 2026-11-19).
  const decides = usePlaceCheckDecides();
  return (
    <div className="min-w-0 space-y-2">
      {/* The system's recommendation and its reason (owner, 2026-10-17) — the company board only. */}
      {mode === "team" ? null : <SystemAdvice advice={adviseOnReview(row)} />}
      {mode === "team" ? (
        <Settled row={row} />
      ) : decides ? (
        <Decision row={row} scope={scope} />
      ) : (
        <PlaceCheckDecisionState
          by={row.decidedByName}
          decided={row.status === "pending" ? null : row.status === "approved" ? { label: "Approved", tone: "good" } : { label: "Rejected", tone: "bad" }}
          note={row.decisionNote}
          repWasTold={row.refusalLabel}
          when={row.decidedAtText}
        />
      )}
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

export { Decision, LastColumn };
