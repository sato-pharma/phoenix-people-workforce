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

import { CrmSelect } from "@/components/phoenix-crm/ui";
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
  onChange,
  value,
}: {
  id: string;
  /** What the photo is. `schedule` is a seated customer's timetable, `building` a polyclinic's own door; everything else is a signboard. */
  kind?: ValidationPickKind;
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
        {reasonsFor(kind).map((reason) => (
          <option key={reason.key} value={reason.key}>
            {reason.label}
          </option>
        ))}
      </CrmSelect>
    </div>
  );
}

/** Under the note box on both screens, so the split between what he reads and what is kept is stated. */
export function RefusalNoteHint() {
  return <p className="break-words text-xs text-slate-500">{VALIDATION_NOTE_HINT}</p>;
}
