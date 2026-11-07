"use client";

import { CrmField, crmInputClassName } from "@/components/phoenix-crm/ui";
import { DOCTOR_NAME_FIELDS, type DoctorNameParts } from "@/lib/phoenix-crm/pm-name-rules";

/** One box holds one name; a compound (عبد العزيز) still fits. */
const PART_MAX = 40;

/**
 * A clinic doctor's name as three required boxes, first, middle and last (owner, 2026-11-07,
 * pm-name-rules.ts). An AM account and a pharmacy keep their one name box.
 */
export function DoctorNameFields({
  disabled,
  idPrefix,
  onChange,
  value,
}: {
  disabled?: boolean;
  idPrefix: string;
  onChange: (next: DoctorNameParts) => void;
  value: DoctorNameParts;
}) {
  return (
    <div className="grid min-w-0 gap-3 sm:col-span-2 sm:grid-cols-3">
      {DOCTOR_NAME_FIELDS.map((field) => (
        <CrmField htmlFor={`${idPrefix}-${field.key}`} key={field.key} label={field.label}>
          <input
            autoComplete="off"
            className={crmInputClassName}
            dir="auto"
            disabled={disabled}
            id={`${idPrefix}-${field.key}`}
            maxLength={PART_MAX}
            onChange={(event) => onChange({ ...value, [field.key]: event.target.value })}
            required
            value={value[field.key]}
          />
        </CrmField>
      ))}
      <p className="text-xs font-medium leading-5 text-slate-500 sm:col-span-3">
        The customer&apos;s own three names, as the signboard shows them. No Dr or د.
      </p>
    </div>
  );
}
