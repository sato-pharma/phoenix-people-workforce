"use client";

/**
 * The speciality is PICKED, never typed — one fixed list, and "Other" opens a box (owner, 2026-11-19:
 * *"make the speciality not typable fixed drop list"* / *"add other and under other make him able to
 * type"*). Every screen that adds a customer or corrects one draws this field, so the list lives in
 * one place (`src/lib/phoenix-crm/speciality-list.ts`) and the server folds whatever arrives into the
 * same names.
 *
 * The dropdown is `CrmSelect`, so a rep and a manager get the plain native list and the admin shell
 * gets its combo box — the module's own surface rule, never decided here.
 */

import { useState } from "react";

import { CrmField, CrmSelect, crmInputClassName } from "@/components/phoenix-crm/ui";
import {
  OTHER_SPECIALITY_LABEL,
  SPECIALITY_TEXT_MAX,
  isListedSpeciality,
  specialityChoices,
  type SpecialityListKind,
} from "@/lib/phoenix-crm/speciality-list";

const OTHER_VALUE = "__other__";

export function CrmSpecialityField({
  className,
  disabled,
  id,
  kind,
  onChange,
  value,
}: {
  className?: string;
  disabled?: boolean;
  id: string;
  kind: SpecialityListKind | null;
  onChange: (next: string) => void;
  value: string;
}) {
  // A saved speciality that is not on the list opens as "Other" with its words in the box, so
  // correcting a customer's phone never silently drops what was written before.
  const [otherPicked, setOtherPicked] = useState(() => value.trim() !== "" && !isListedSpeciality(value, kind));
  const groups = specialityChoices(kind);

  return (
    <CrmField
      className={className}
      hint={otherPicked ? "Write the speciality in the box." : "Optional. Pick one from the list."}
      htmlFor={id}
      label="Speciality"
    >
      <CrmSelect
        disabled={disabled}
        id={id}
        onChange={(event) => {
          const next = event.target.value;
          if (next === OTHER_VALUE) {
            setOtherPicked(true);
            onChange("");
            return;
          }
          setOtherPicked(false);
          onChange(next);
        }}
        value={otherPicked ? OTHER_VALUE : value}
      >
        <option value="">No speciality</option>
        {groups.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.items.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </optgroup>
        ))}
        <option value={OTHER_VALUE}>{OTHER_SPECIALITY_LABEL}</option>
      </CrmSelect>
      {otherPicked ? (
        <input
          aria-label="The other speciality"
          autoComplete="off"
          className={crmInputClassName}
          dir="auto"
          disabled={disabled}
          id={`${id}-other`}
          maxLength={SPECIALITY_TEXT_MAX}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Write the speciality"
          value={value}
        />
      ) : null}
    </CrmField>
  );
}
