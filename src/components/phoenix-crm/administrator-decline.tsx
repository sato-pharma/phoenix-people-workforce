"use client";

/**
 * Phoenix CRM — the Administrator's decline, on any approval (owner, 2026-10-08).
 *
 * He is not a step: nothing in the module waits for his approval, and no count of "waiting for you"
 * includes him. What he has is this — on a decision a manager or SFE is taking, or took, he may DECLINE
 * or RETURN it with a comment the rep reads. He is called the Administrator everywhere he is named —
 * never HR, and never an override.
 *
 * One component for every kind of approval (plan edits, list requests, off-plan visits, weekly and
 * monthly plans), so the words and the comment rule are one. The card that hosts it decides WHEN to show
 * it (`canOverride` from the server) and what the press does (`onSubmit`).
 */

import { useId, useState } from "react";

import { messageOf } from "@/components/phoenix-crm/api";
import { CrmButton, CrmField, CrmNote, crmTextareaClassName } from "@/components/phoenix-crm/ui";

export const ADMINISTRATOR_NOTE_MAX = 500;

export function AdministratorDecline({
  verb,
  hint,
  onSubmit,
}: {
  /** The act, as the button says it: "Decline" or "Return with a comment". */
  verb: string;
  /** What the comment is for, in a sentence. */
  hint: string;
  /** Saves the act. Rejects with the server's own words, which are shown as they are. */
  onSubmit: (note: string) => Promise<void>;
}) {
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit() {
    const trimmed = note.trim();
    if (!trimmed) {
      setProblem("Write the comment first. The rep reads it.");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await onSubmit(trimmed);
    } catch (error) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div>
        <CrmButton onClick={() => setOpen(true)}>{`${verb} as Administrator`}</CrmButton>
      </div>
    );
  }

  return (
    <div className="grid min-w-0 gap-2 border-t border-slate-200 pt-3">
      <p className="break-words text-xs font-semibold text-slate-600">Administrator</p>
      <CrmField hint={hint} htmlFor={`${fieldId}-note`} label="Comment">
        <textarea
          className={crmTextareaClassName}
          disabled={busy}
          id={`${fieldId}-note`}
          maxLength={ADMINISTRATOR_NOTE_MAX}
          onChange={(event) => {
            setProblem(null);
            setNote(event.target.value);
          }}
          rows={2}
          value={note}
        />
      </CrmField>
      <div className="flex flex-wrap gap-2">
        <CrmButton disabled={busy} onClick={() => void submit()} variant="primary">
          {busy ? "Saving…" : verb}
        </CrmButton>
        <CrmButton
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setProblem(null);
          }}
        >
          Cancel
        </CrmButton>
      </div>
      {problem ? (
        <CrmNote tone="bad" title="It was not saved">
          {problem}
        </CrmNote>
      ) : null}
    </div>
  );
}
