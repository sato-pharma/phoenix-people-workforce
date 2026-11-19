"use client";

/**
 * The customer's TYPE and his SPECIALITY, picked, never typed — two fixed lists, and "Other" on each opens
 * a box (owner, 2026-11-19: *"make the speciality not typable fixed drop list"* / *"add other and under
 * other make him able to type"*, then *"separate the speciality and the type — hospital is not a
 * speciality … clinic, example pedia"*). Every screen that adds a customer or corrects one draws this
 * pair, so the lists live in one place (`src/lib/phoenix-crm/speciality-list.ts`) and the server folds
 * whatever arrives into the same names.
 *
 *   - A pharmacy draws nothing: it is a pharmacy, with no speciality.
 *   - The speciality shows only for a Clinic or a Polyclinic, and is then required (his choice: "only
 *     clinics need one"). Picking a hospital or a contract empties it.
 *
 * Each dropdown is `CrmSelect`, so a rep and a manager get the plain native list and the admin shell gets
 * its combo box — the module's own surface rule, never decided here.
 */

import { useState } from "react";

import { CrmField, CrmSelect, crmInputClassName } from "@/components/phoenix-crm/ui";
import {
  OTHER_SPECIALITY_LABEL,
  OTHER_TYPE_LABEL,
  SPECIALITY_TEXT_MAX,
  TYPES_WITH_SPECIALITY,
  customerTypeChoices,
  isListedCustomerType,
  isListedSpeciality,
  specialityChoices,
  type SpecialityGroup,
  type SpecialityListKind,
} from "@/lib/phoenix-crm/speciality-list";

const OTHER_VALUE = "__other__";

/** One fixed list with an "Other" that opens a box. */
function PickOrWrite({
  className,
  disabled,
  emptyLabel,
  groups,
  hint,
  id,
  isListed,
  label,
  onChange,
  otherLabel,
  placeholder,
  value,
}: {
  className?: string;
  disabled?: boolean;
  emptyLabel: string;
  groups: SpecialityGroup[];
  hint: string;
  id: string;
  isListed: (value: string) => boolean;
  label: string;
  onChange: (next: string) => void;
  otherLabel: string;
  placeholder: string;
  value: string;
}) {
  // A saved value that is not on the list opens as "Other" with its words in the box, so correcting a
  // customer's phone never silently drops what was written before.
  const [otherPicked, setOtherPicked] = useState(() => value.trim() !== "" && !isListed(value));

  return (
    <CrmField className={className} hint={otherPicked ? `Write the ${label.toLowerCase()} in the box.` : hint} htmlFor={id} label={label}>
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
        <option value="">{emptyLabel}</option>
        {groups.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.items.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </optgroup>
        ))}
        <option value={OTHER_VALUE}>{otherLabel}</option>
      </CrmSelect>
      {otherPicked ? (
        <input
          aria-label={`The other ${label.toLowerCase()}`}
          autoComplete="off"
          className={crmInputClassName}
          dir="auto"
          disabled={disabled}
          id={`${id}-other`}
          maxLength={SPECIALITY_TEXT_MAX}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          value={value}
        />
      ) : null}
    </CrmField>
  );
}

export function CrmCustomerKindField({
  customerType,
  disabled,
  idPrefix,
  kind,
  onSpecialityChange,
  onTypeChange,
  speciality,
}: {
  customerType: string;
  disabled?: boolean;
  idPrefix: string;
  kind: SpecialityListKind | null;
  onSpecialityChange: (next: string) => void;
  onTypeChange: (next: string) => void;
  speciality: string;
}) {
  if (kind === "Pharmacy") return null;
  const needsSpeciality = TYPES_WITH_SPECIALITY.includes(customerType);

  return (
    <>
      <PickOrWrite
        className={needsSpeciality ? undefined : "sm:col-span-2"}
        disabled={disabled}
        emptyLabel="Pick the type"
        groups={customerTypeChoices(kind)}
        hint="A clinic, a hospital, a contract."
        id={`${idPrefix}-type`}
        isListed={(value) => isListedCustomerType(value, kind)}
        label="Type"
        onChange={(next) => {
          onTypeChange(next);
          // Only a clinic or a polyclinic carries a speciality; a hospital's is emptied with the pick.
          if (!TYPES_WITH_SPECIALITY.includes(next)) onSpecialityChange("");
        }}
        otherLabel={OTHER_TYPE_LABEL}
        placeholder="Write the type"
        value={customerType}
      />
      {needsSpeciality ? (
        <PickOrWrite
          disabled={disabled}
          emptyLabel="Pick the speciality"
          groups={specialityChoices(kind)}
          hint="Required for a clinic."
          id={`${idPrefix}-speciality`}
          isListed={(value) => isListedSpeciality(value, kind)}
          label="Speciality"
          onChange={onSpecialityChange}
          otherLabel={OTHER_SPECIALITY_LABEL}
          placeholder="Write the speciality"
          value={speciality}
        />
      ) : null}
    </>
  );
}
