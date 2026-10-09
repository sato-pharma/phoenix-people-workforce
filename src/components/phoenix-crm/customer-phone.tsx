"use client";

/**
 * Phoenix CRM — the customer's phone, as the rep types it and as every screen shows it (owner,
 * 2026-09-30: "Add a phone to validation" — optional, corrected later in "Change the details", and only
 * what the rep types; the old list's phones are never used).
 *
 * One field and one link, so validating, "Someone new" on an out-of-list visit and "Change the
 * details" ask for it the same way, and the customer's page and the daily plan print it the same way.
 * The rule for what counts as a phone is pure (`parseCustomerPhone`, entry-rules.ts), shared with the
 * server, so the form refuses exactly what the save would.
 */

import { CrmField, crmInputClassName } from "@/components/phoenix-crm/ui";
import { CUSTOMER_PHONE_INPUT_MAX } from "@/lib/phoenix-crm/entry-rules";

export function CustomerPhoneField({
  className,
  disabled,
  hint = "Optional. Leave it empty if you do not have it.",
  id,
  // A pharmacy's number is its RESPONSIBLE PERSON's, not the pharmacy's own (owner, 2026-10-09), and
  // the label has to say so where that is what is asked for. Unset reads "Phone", exactly as before.
  label = "Phone",
  onChange,
  value,
}: {
  className?: string;
  disabled?: boolean;
  hint?: string;
  id: string;
  label?: string;
  onChange: (next: string) => void;
  value: string;
}) {
  return (
    <CrmField className={className} hint={hint} htmlFor={id} label={label}>
      {/* Left to right whatever the page: a number reads the same way in Arabic and in English. */}
      <input
        autoComplete="off"
        className={crmInputClassName}
        dir="ltr"
        disabled={disabled}
        id={id}
        inputMode="tel"
        maxLength={CUSTOMER_PHONE_INPUT_MAX}
        onChange={(event) => onChange(event.target.value)}
        placeholder="01xxxxxxxxx"
        type="tel"
        value={value}
      />
    </CrmField>
  );
}

/** The phone as a link that dials it on a phone; nothing when there is none. */
export function CustomerPhoneLink({ className, phone }: { className?: string; phone: string | null }) {
  if (!phone) return null;
  return (
    <a className={className ?? "font-bold text-slate-900 underline decoration-slate-300 underline-offset-2"} dir="ltr" href={`tel:${phone}`}>
      {phone}
    </a>
  );
}
