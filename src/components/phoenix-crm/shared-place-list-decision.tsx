"use client";

/**
 * Phoenix CRM — the administrator's decision on one polyclinic or centre: Approve or Reject with what a
 * rejection costs written above the button, the take-back of a rejection, the declaration that a building
 * has no timetable, and the last column that chooses between them by who is reading.
 *
 * 🔴 REJECTING A BUILDING IS THE HEAVY DECISION ON THIS PAGE. It retires the venue and every customer
 * seated in it, and each of them goes back to To validate. It is the Super Admin's alone: a manager's
 * board is drawn no control from this file and not even the cost (`LastColumn`).
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { PlaceCheckDecisionState, usePlaceCheckDecides } from "@/components/phoenix-crm/place-check-decides";
import { useCanRestoreValidation } from "@/components/phoenix-crm/place-check-restore";
import { isAlreadyDecided, PlaceCheckSaved, usePlaceCheckDone, useSavedOutcome } from "@/components/phoenix-crm/place-check-done";
import { PlaceCheckNotes, type PlaceCheckNotesMode } from "@/components/phoenix-crm/place-check-notes";
import { placeCheckReread } from "@/components/phoenix-crm/place-check-reread";
import { DecisionComment, RefusalReasonField, RefusalReasonPick } from "@/components/phoenix-crm/refusal-reason-field";
import { SystemAdvice } from "@/components/phoenix-crm/system-advice";
import { CrmButton, CrmNote, CrmPill } from "@/components/phoenix-crm/ui";
import { VALIDATION_NOTE_LABEL, type ValidationRefusalReason } from "@/lib/phoenix-crm/validation-feedback";
import {
  NO_TIMETABLE_DECLARE_EXPLAINER,
  NO_TIMETABLE_DECLARE_LABEL,
  NO_TIMETABLE_WITHDRAW_EXPLAINER,
  NO_TIMETABLE_WITHDRAW_LABEL,
} from "@/lib/phoenix-crm/failing-timetable-rules";
import { BUILDING_APPROVE_LABEL, BUILDING_APPROVING_LABEL, buildingApproveVariant } from "@/lib/phoenix-crm/approved-place-words";
import { adviseOnBuilding } from "@/lib/phoenix-crm/place-check-advice";
import { SUPER_ADMIN_APPROVAL_IS_FINAL_TEXT } from "@/lib/phoenix-crm/super-admin-approval-rules";
import { placeNoteSubjectKey } from "@/lib/phoenix-crm/place-note-rules";
import type { PlaceNoteIndex, SharedPlaceBoardRow } from "@/lib/phoenix-crm/view-types";

/**
 * Which layout a venue control is drawn in — the phone block and the table are BOTH in the page, and the
 * one-by-one review draws it a third time above them, so an id must say which.
 */
type VenueScope = "cards" | "table" | "deck";

/** What rejecting this venue costs, in plain words — read before the button, not after. */
function Cost({ row }: { row: SharedPlaceBoardRow }) {
  const lines = [
    row.seated === 0
      ? "Nobody is seated in it yet, so no customer is affected."
      : `${row.seated === 1 ? "The 1 customer seated in it is retired with it and goes" : `All ${row.seated} customers seated in it are retired with it and go`} back to To validate.`,
    "The rep captures it again from their own list, and is told what is wrong with the photo and nothing else.",
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
 * Approving a venue after rejecting it (owner, 2026-10-15: "make me able to approve validation after
 * rejection"). The mirror of the rejected place's `Approve it after all`, and until this existed it
 * was the one decision on this page with no undo anywhere: 35 buildings on production were retired
 * with every doctor behind each one sent back to To validate, and the row was not even drawn.
 *
 * What comes back is the DATABASE's rule, not this screen's: the venue, the places that rejection
 * retired, and each of those customers confirmed only under the three holds approving a held venue
 * already keeps. So the sentence under the button states what will happen and promises nothing the
 * server might not do — a customer whose timetable still cannot answer for him stays under To
 * validate, and the answer says so by name.
 */
function RestoreVenue({ row, scope }: { row: SharedPlaceBoardRow; scope: VenueScope }) {
  // Taking a rejection back is the Super Admin's alone (owner, 2026-11-10: "the SFE cannot"); the SFE
  // Manager reads who rejected it and why, and no button.
  const canRestore = useCanRestoreValidation();
  const done = usePlaceCheckDone();
  const { saved, markSaved } = useSavedOutcome(row);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function restore() {
    if (saving) return;
    setSaving(true);
    setProblem(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/validation-reviews/shared-place/restore", { sharedPlaceId: row.sharedPlaceId, note }, "restored");
      markSaved(done("restored"));
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
    <div className="min-w-0 space-y-2">
      <CrmPill tone="bad">Rejected</CrmPill>
      <p className="break-words text-xs text-slate-500">{[row.decidedByName, row.decidedAtText].filter(Boolean).join(" · ")}</p>
      {row.decisionNote ? <p className="break-words text-xs text-slate-600">{row.decisionNote}</p> : null}
      {canRestore ? (
        <>
      <p className="break-words text-xs text-slate-600">
        Bringing it back makes the building live again and gives every customer it retired their place back. One whose timetable still cannot
        answer for them stays under To validate.
      </p>
      <DecisionComment disabled={saving} id={`restore-venue-note-${scope}-${row.sharedPlaceId}`} label={VALIDATION_NOTE_LABEL} onChange={setNote} value={note} />
      <CrmButton busy={saving} disabled={saving} onClick={() => void restore()} variant="primary">
        {saving ? "Bringing it back" : "Approve it after all"}
      </CrmButton>
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
        </>
      ) : null}
    </div>
  );
}

function Decision({ row, scope }: { row: SharedPlaceBoardRow; scope: VenueScope }) {
  const done = usePlaceCheckDone();
  const { saved, markSaved } = useSavedOutcome(row);
  const [note, setNote] = useState("");
  // Opens on the reason the system's own confident reading gives, and on nothing otherwise.
  const [reason, setReason] = useState<ValidationRefusalReason | "">(() => adviseOnBuilding(row).refusal ?? "");
  const [saving, setSaving] = useState<"approve" | "reject" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Reject with no reason chosen opens the list of reasons; pressing one sends it (RefusalReasonPick).
  const [picking, setPicking] = useState(false);

  async function decide(decision: "approve" | "reject", why: ValidationRefusalReason | "" = reason) {
    if (saving) return;
    setSaving(decision);
    setProblem(null);
    try {
      await crmPost<unknown>(
        "/api/phoenix-crm/validation-reviews/shared-place",
        { sharedPlaceId: row.sharedPlaceId, decision, note, ...(decision === "reject" ? { refusalReason: why } : {}) },
        "decided",
      );
      // Approving a building is "Approved" on screen whether it was held or already standing (owner, 21 Nov
      // 2026): it used to read "Keep it" and then "Kept", which looked like nothing had been approved.
      markSaved(done(decision === "reject" ? "rejected" : "approved"));
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

  // 🔴 A REJECTED VENUE IS DECIDED, NOT GONE (owner, 2026-10-15: "make me able to approve validation
  // after rejection"). Its row shows what was said about it and ONE control — the undo — never the
  // approve/reject pair again: rejecting a retired venue is what the database refuses, and the Cost
  // lines below describe a cost that has already been paid.
  if (row.restorable) {
    return <RestoreVenue row={row} scope={scope} />;
  }

  return (
    <div className="space-y-2">
      {row.decidedAtText ? (
        <div className="space-y-0.5">
          <CrmPill tone="good">Approved</CrmPill>
          <p className="break-words text-xs text-slate-500">{[row.decidedByName, row.decidedAtText].filter(Boolean).join(" · ")}</p>
          {row.decisionNote ? <p className="break-words text-xs text-slate-600">{row.decisionNote}</p> : null}
        </div>
      ) : null}
      {/* What the administrator approved, only he rejects (owner, 2026-11-16). Approve-again stays: it changes nothing. */}
      {row.lockedBySuperAdmin ? <CrmNote tone="neutral">{SUPER_ADMIN_APPROVAL_IS_FINAL_TEXT}</CrmNote> : null}
      {row.lockedBySuperAdmin ? null : <Cost row={row} />}
      {/* Reject is one press on a reason already chosen and two otherwise (owner, 23 Nov 2026): with none
          chosen, Reject opens the reasons and the reason pressed sends it. */}
      {row.lockedBySuperAdmin || reason === "" || picking ? null : <RefusalReasonField
        disabled={saving !== null}
        id={`shared-place-reason-${scope}-${row.sharedPlaceId}`}
        kind="building"
        onChange={setReason}
        value={reason}
      />}
      <DecisionComment disabled={saving !== null} id={`shared-place-note-${scope}-${row.sharedPlaceId}`} label={VALIDATION_NOTE_LABEL} onChange={setNote} value={note} />
      {picking ? (
        <RefusalReasonPick
          disabled={saving !== null}
          kind="building"
          onBack={() => setPicking(false)}
          onPick={(next) => {
            setReason(next);
            setPicking(false);
            void decide("reject", next);
          }}
        />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
          <CrmButton disabled={saving !== null} onClick={() => void decide("approve")} variant={buildingApproveVariant(row.decidedAtText)}>
            {saving === "approve" ? BUILDING_APPROVING_LABEL : BUILDING_APPROVE_LABEL}
          </CrmButton>
          {row.lockedBySuperAdmin ? null : (
            <CrmButton disabled={saving !== null} onClick={() => (reason === "" ? setPicking(true) : void decide("reject"))} variant="danger">
              {saving === "reject" ? "Rejecting…" : "Reject"}
            </CrmButton>
          )}
        </div>
      )}
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
    </div>
  );
}

/**
 * The Super Admin's declaration that this building has no timetable, or taking it back (owner, 14 Nov
 * 2026, "List + declare"). Until then the marker was set by hand on one building.
 *
 * 🔴 TWO CLICKS, AND THE FIRST ONE SAYS WHAT THE SECOND DOES NOT DO. It validates nobody: the customers
 * seated here still wait for his Approve, each on his own row. The row says which of the two the viewer
 * may do (`noTimetableControl`), so nobody else is drawn a button, and a rejected building has none.
 */
function NoTimetableDeclaration({ row }: { row: SharedPlaceBoardRow }) {
  const router = useRouter();
  const control = row.noTimetableControl ?? null;
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // The control that was saved. Once the page is read again the row offers the other one, and the note goes.
  const [savedAs, setSavedAs] = useState<"declare" | "withdraw" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (!control) return null;

  async function save() {
    if (saving || !control) return;
    setSaving(true);
    setProblem(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/validation-reviews/shared-place/no-timetable", { sharedPlaceId: row.sharedPlaceId, declared: control === "declare" }, "declaration");
      setSavedAs(control);
      setOpen(false);
      // Through the one re-read, so a decision's timer still waiting is not a second build of the page.
      placeCheckReread.refreshNow(() => router.refresh());
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setSaving(false);
    }
  }

  if (savedAs === control) {
    return <CrmNote tone="good">{control === "declare" ? "Saved. This building is declared to have no timetable." : "Saved. The board reads this building's timetable again."}</CrmNote>;
  }
  return (
    <div className="min-w-0 space-y-2 border-t border-slate-200 pt-2">
      {open ? (
        <>
          <p className="break-words text-xs text-slate-600">{control === "declare" ? NO_TIMETABLE_DECLARE_EXPLAINER : NO_TIMETABLE_WITHDRAW_EXPLAINER}</p>
          <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
            <CrmButton disabled={saving} onClick={() => void save()} variant="primary">
              {saving ? "Saving…" : "Confirm"}
            </CrmButton>
            <CrmButton disabled={saving} onClick={() => setOpen(false)}>
              Cancel
            </CrmButton>
          </div>
        </>
      ) : (
        <CrmButton onClick={() => setOpen(true)}>{control === "declare" ? NO_TIMETABLE_DECLARE_LABEL : NO_TIMETABLE_WITHDRAW_LABEL}</CrmButton>
      )}
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
    </div>
  );
}

/**
 * The last column, both modes together.
 *
 * 🔴 A MANAGER GETS NO `Decision` AND NOT EVEN THE `Cost` WARNING INSIDE IT. Rejecting a venue retires
 * it, retires every customer seated in it and sends each of them back to To validate — the heaviest
 * decision on this page, and the Super Admin's alone. A manager reads the venue, comments on it and
 * recommends; whether it was already approved, and by whom, is not on his screen (owner, 2026-10-13).
 */
function LastColumn({ mode, noteIndex, row, scope }: { mode: PlaceCheckNotesMode; noteIndex: PlaceNoteIndex; row: SharedPlaceBoardRow; scope: VenueScope }) {
  const key = placeNoteSubjectKey("shared_place", row.sharedPlaceId);
  // The SFE Manager reads the building's state and recommends; the decision and the no-timetable
  // declaration are the Super Admin's alone (owner, 2026-11-19).
  const decides = usePlaceCheckDecides();
  return (
    <div className="min-w-0 space-y-2">
      {/* The system's recommendation and its reason (owner, 2026-10-17) — the company board only. */}
      {mode === "team" ? null : <SystemAdvice advice={adviseOnBuilding(row)} />}
      {mode === "team" ? null : decides ? (
        <Decision row={row} scope={scope} />
      ) : (
        <PlaceCheckDecisionState
          by={row.decidedByName}
          decided={
            row.status === "held" ? null : row.status === "retired" ? { label: "Rejected", tone: "bad" } : row.decidedAtText ? { label: "Approved", tone: "good" } : null
          }
          note={row.decisionNote}
          when={row.decidedAtText}
        />
      )}
      {mode === "team" || !decides ? null : <NoTimetableDeclaration row={row} />}
      <PlaceCheckNotes
        integrity={noteIndex.integrity[key] ?? []}
        mode={mode}
        notes={noteIndex.notes[key] ?? []}
        recommendations={noteIndex.recommendations[key] ?? []}
        subjectId={row.sharedPlaceId}
        subjectKind="shared_place"
      />
    </div>
  );
}

export { Decision, LastColumn };
