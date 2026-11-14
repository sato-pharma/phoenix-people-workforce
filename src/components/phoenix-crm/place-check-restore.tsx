"use client";

/**
 * Phoenix CRM — approving a validation AFTER it was rejected, on Place checks.
 *
 * Owner, 2026-11-10: "make the administrator able to approve a rejected validation from the SFE in place
 * checks but the SFE cannot; the administrator is never blocked". Asked what should happen to a clinic
 * doctor written with only one or two names, he answered "Both": his approval goes through as it stands,
 * and beside it an optional Edit name opens the rep's own three boxes and approves with the corrected name
 * in one press.
 *
 * 🔴 WHO SEES IT IS `PlaceCheckRestoreProvider`, WHOSE DEFAULT IS FALSE — the page passes
 * `canRestoreValidation(viewer)` (the Super Admin alone), so the SFE Manager's board, a district manager's
 * board and any screen that forgets the provider draw no take-back at all. The route refuses everybody
 * else too; this is the screen half of the same rule.
 */

import { createContext, useContext, useState, type ReactNode } from "react";

import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { approvalOutcome, isAlreadyDecided, PlaceCheckSaved, usePlaceCheckDone, useSavedOutcome } from "@/components/phoenix-crm/place-check-done";
import { DoctorNameFields } from "@/components/phoenix-crm/pm-name-fields";
import { CrmButton, CrmNote, crmTextareaClassName } from "@/components/phoenix-crm/ui";
import { phxButtonGhostClassName } from "@/components/ui/form-tokens";
import { approvalNeedsFullName, doctorFullNameProblem, splitDoctorName, type DoctorNameParts } from "@/lib/phoenix-crm/pm-name-rules";
import { VALIDATION_NOTE_LABEL } from "@/lib/phoenix-crm/validation-feedback";

const RestoreContext = createContext(false);

/** Says whether this viewer takes a rejection back — the page's `canRestoreValidation(viewer)`. */
export function PlaceCheckRestoreProvider({ canRestore, children }: { canRestore: boolean; children: ReactNode }) {
  return <RestoreContext.Provider value={canRestore}>{children}</RestoreContext.Provider>;
}

/** Whether this board draws "Approve it after all". False outside the provider. */
export function useCanRestoreValidation(): boolean {
  return useContext(RestoreContext);
}

/** The request the take-back sends: the note, and the corrected three names when he edited them. */
export function restoreRequest(reviewId: string, note: string, nameParts?: DoctorNameParts | null): Record<string, unknown> {
  return nameParts ? { reviewId, note, nameParts } : { reviewId, note };
}

/**
 * The take-back itself, on a place row and on a customer seated in a polyclinic alike. Never disabled for
 * a short name: a clinic doctor with one or two names gets Edit name beside the approval, never a grey button.
 * Edit name is offered only to that doctor — his question was about short names, and an account's name is
 * not three boxes.
 */
export function RestoreAfterRejection({
  busyLabel,
  customerName,
  explanation,
  idKey,
  listType,
  reviewId,
  row,
}: {
  busyLabel: string;
  customerName: string;
  /** One sentence under the button saying what bringing it back does. */
  explanation?: ReactNode;
  idKey: string;
  listType: string;
  reviewId: string | null;
  /** The row as the server drew it — what `useSavedOutcome` compares to know the decision is still showing. */
  row: object;
}) {
  const done = usePlaceCheckDone();
  const canRestore = useCanRestoreValidation();
  const { saved, markSaved } = useSavedOutcome(row);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState<"as-is" | "corrected" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The corrected name, open only while he edits it; null is the plain approval.
  const [editing, setEditing] = useState<DoctorNameParts | null>(null);

  if (!canRestore || !reviewId) return null;
  if (saved) return <PlaceCheckSaved outcome={saved} />;

  // A clinic doctor who is still short of his three names: the approval stands, and Edit name sits beside it.
  const shortName = approvalNeedsFullName({ listType, customerName });

  async function restore(nameParts: DoctorNameParts | null) {
    if (saving || !reviewId) return;
    if (nameParts) {
      const wrong = doctorFullNameProblem(nameParts);
      if (wrong) {
        setProblem(wrong);
        return;
      }
    }
    setSaving(nameParts ? "corrected" : "as-is");
    setProblem(null);
    try {
      const restored = await crmPost<unknown>("/api/phoenix-crm/validation-reviews/restore", restoreRequest(reviewId, note, nameParts), "restored");
      markSaved(done(approvalOutcome(restored, "restored")));
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

  return (
    <div className="min-w-0 space-y-2 border-t border-slate-100 pt-2">
      <label className="block text-xs font-black uppercase tracking-[0.12em] text-slate-500" htmlFor={`restore-note-${idKey}`}>
        {VALIDATION_NOTE_LABEL}
      </label>
      <textarea
        className={crmTextareaClassName}
        disabled={saving !== null}
        id={`restore-note-${idKey}`}
        maxLength={500}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        value={note}
      />
      {editing ? (
        <form
          className="min-w-0 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void restore(editing);
          }}
        >
          <DoctorNameFields disabled={saving !== null} idPrefix={`restore-name-${idKey}`} onChange={setEditing} stacked value={editing} />
          <div className="flex flex-wrap gap-2">
            <CrmButton busy={saving === "corrected"} disabled={saving !== null} type="submit" variant="primary">
              {saving === "corrected" ? busyLabel : "Save name and approve"}
            </CrmButton>
            <button
              className={phxButtonGhostClassName}
              disabled={saving !== null}
              onClick={() => {
                setEditing(null);
                setProblem(null);
              }}
              type="button"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <CrmButton busy={saving === "as-is"} disabled={saving !== null} onClick={() => void restore(null)} variant="primary">
            {saving === "as-is" ? busyLabel : "Approve it after all"}
          </CrmButton>
          {shortName ? (
            <button
              className={phxButtonGhostClassName}
              disabled={saving !== null}
              onClick={() => {
                setEditing(splitDoctorName(customerName));
                setProblem(null);
              }}
              type="button"
            >
              Edit name
            </button>
          ) : null}
        </div>
      )}
      {shortName && !editing ? (
        <p className="break-words text-xs font-semibold text-slate-700">
          This customer has only one or two names. You can approve as it stands, or use Edit name to write the first, middle and last name. Until
          all three are written, the rep cannot save a visit to this customer.
        </p>
      ) : null}
      {explanation ? <p className="break-words text-xs text-slate-500">{explanation}</p> : null}
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
    </div>
  );
}
