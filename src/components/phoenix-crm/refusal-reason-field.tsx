"use client";

/**
 * Phoenix CRM — "what is wrong with the photo", the one thing a rep is told about a refusal.
 *
 * Owner, 2026-10-08: tell the rep why, from a fixed pick-list, worded about his own photo and never
 * naming a person. Both Super Admin decision screens use this one field — the queue of held places and
 * the list of validations the system never questioned — so the two can never offer different lists.
 * The reasons themselves live in `@/lib/phoenix-crm/validation-feedback`, closed at nine.
 *
 * It is required to refuse and never asked to approve. The free-text note beside it stays the
 * record's, and the rep never reads it — which is why its label says so in words.
 */

import { useState } from "react";
import { Plus } from "lucide-react";

import { CrmSelect, crmTextareaClassName } from "@/components/phoenix-crm/ui";
import {
  reasonsFor,
  VALIDATION_NOTE_HINT,
  VALIDATION_REASON_LABEL,
  VALIDATION_REASON_PLACEHOLDER,
  type ValidationPickKind,
  type ValidationRefusalReason,
} from "@/lib/phoenix-crm/validation-feedback";

/**
 * 🔴 WHICH OF THE NINE ARE OFFERED DEPENDS ON WHAT THE PHOTO IS (owner, 2026-10-09). A customer
 * seated in a polyclinic is photographed at his TIMETABLE, not at a signboard — so "a photo of paper,
 * not a building" is wrong by construction about him, and "the timetable does not name this customer"
 * is meaningless about a signboard. `reasonsFor` keeps the two lists apart; the default is `signboard`,
 * so every call site that existed before is unchanged.
 */
export function RefusalReasonField({
  disabled,
  id,
  kind = "signboard",
  buildingHasNoTimetable = false,
  onChange,
  value,
}: {
  id: string;
  /** What the photo is. `schedule` is a seated customer's timetable, `building` a polyclinic's own door; everything else is a signboard. */
  kind?: ValidationPickKind;
  /** The building has no timetable (the administrator's exception): "No timetable in the photo" is not offered. */
  buildingHasNoTimetable?: boolean;
  value: ValidationRefusalReason | "";
  onChange: (next: ValidationRefusalReason | "") => void;
  disabled?: boolean;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <label className="block text-xs font-black uppercase tracking-[0.12em] text-slate-500" htmlFor={id}>
        {VALIDATION_REASON_LABEL}
      </label>
      <CrmSelect
        disabled={disabled}
        id={id}
        onChange={(event) => onChange((event.target.value as ValidationRefusalReason | "") ?? "")}
        value={value}
      >
        <option value="">{VALIDATION_REASON_PLACEHOLDER}</option>
        {reasonsFor(kind, { buildingHasNoTimetable }).map((reason) => (
          <option key={reason.key} value={reason.key}>
            {reason.label}
          </option>
        ))}
      </CrmSelect>
    </div>
  );
}

/** Said over the list of reasons: a press on one is the rejection itself. */
export const REFUSAL_PICK_HINT = "Press what is wrong. That rejects it and tells the rep.";

/**
 * The same closed list, drawn as a list to PRESS: choosing a reason IS the rejection.
 *
 * 🔴 REJECT IS TWO PRESSES, NEVER THREE (owner, 23 Nov 2026: "Fix them", after the re-score counted
 * them). A waiting row with no confident reason used to need the pick-list opened, a reason chosen and
 * then Reject. Reject now opens this list and the reason sends it. A row whose reason the system is
 * confident of still rejects in ONE press, on the reason already in `RefusalReasonField`. Only the
 * three WAITING decisions use it (a held place, a building, a customer seated in one); rejecting a
 * validation already in use still arms first, because that one costs visits.
 */
export function RefusalReasonPick({
  buildingHasNoTimetable = false,
  disabled,
  kind = "signboard",
  onBack,
  onPick,
}: {
  kind?: ValidationPickKind;
  buildingHasNoTimetable?: boolean;
  disabled?: boolean;
  /** Close the list with nothing rejected. */
  onBack: () => void;
  onPick: (reason: ValidationRefusalReason) => void;
}) {
  return (
    <div className="min-w-0 space-y-1.5" data-reason-pick>
      <p className="break-words text-xs font-black uppercase tracking-[0.12em] text-slate-500">{VALIDATION_REASON_LABEL}</p>
      <p className="break-words text-xs text-slate-600">{REFUSAL_PICK_HINT}</p>
      <ul className="min-w-0 space-y-1">
        {reasonsFor(kind, { buildingHasNoTimetable }).map((reason) => (
          <li key={reason.key}>
            <button
              className="flex min-h-10 w-full min-w-0 items-center rounded-none border border-rose-200 bg-white px-3 py-1.5 text-left text-sm font-semibold text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 md:min-h-9"
              disabled={disabled}
              onClick={() => onPick(reason.key)}
              type="button"
            >
              <span className="min-w-0 break-words">{reason.label}</span>
            </button>
          </li>
        ))}
      </ul>
      <button
        className="inline-flex min-h-9 items-center rounded-none text-xs font-black text-slate-600 underline-offset-2 hover:underline disabled:text-slate-400"
        disabled={disabled}
        onClick={onBack}
        type="button"
      >
        Back, reject nothing
      </button>
    </div>
  );
}

/** Under the note box on both screens, so the split between what he reads and what is kept is stated. */
export function RefusalNoteHint() {
  return <p className="break-words text-xs text-slate-500">{VALIDATION_NOTE_HINT}</p>;
}

/**
 * The optional comment sent with a decision, folded until it is asked for.
 *
 * 🔴 FOLDED, NEVER DROPPED (owner, 17 Nov 2026: "make it easier to use, simple to decide"). An empty box
 * under every row was the tallest thing in Place checks' decision column — twenty of them on a page — and
 * most decisions go without one. The link opens the same box, label and hint as before, it stays open
 * while it holds text, and whatever is typed is still posted with the press. The label is passed in, so
 * each screen keeps naming `VALIDATION_NOTE_LABEL` where it draws the box.
 */
export function DecisionComment({
  disabled,
  id,
  label,
  onChange,
  value,
}: {
  disabled?: boolean;
  id: string;
  label: string;
  onChange: (next: string) => void;
  value: string;
}) {
  const [open, setOpen] = useState(value !== "");
  const [focus, setFocus] = useState(false);
  if (!open && value === "") {
    return (
      <button
        aria-expanded={false}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-none text-xs font-black text-orange-700 underline-offset-2 hover:underline disabled:text-slate-400"
        disabled={disabled}
        onClick={() => {
          setOpen(true);
          setFocus(true);
        }}
        type="button"
      >
        <Plus aria-hidden className="h-3.5 w-3.5" />
        Add a comment for the rep and their manager (optional)
      </button>
    );
  }
  return (
    <div className="min-w-0 space-y-1">
      <label className="block text-xs font-black uppercase tracking-[0.12em] text-slate-500" htmlFor={id}>
        {label}
      </label>
      <textarea
        autoFocus={focus}
        className={crmTextareaClassName}
        disabled={disabled}
        id={id}
        maxLength={500}
        onChange={(event) => onChange(event.target.value)}
        rows={2}
        value={value}
      />
      <RefusalNoteHint />
    </div>
  );
}
