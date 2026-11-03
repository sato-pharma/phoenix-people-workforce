import { AlertTriangle } from "lucide-react";

import { crmListFlagChip } from "@/lib/marketing-requests/crm-doctor-pick";

/**
 * "This doctor's name was typed by hand — the doctor is not on a rep's Phoenix CRM list."
 *
 * Owner, 2026-10-23: a doctor not on the rep's list may still be typed at Customer Validation, "but
 * flag, clearly flag in all approval steps". ONE component, so every approval surface — the inbox
 * card, the approval window, the decision page — says it in the same words. Renders nothing for a
 * picked doctor or a customer validated before the rule (`flag` null). Since 2026-11-03 the list check
 * speaks here too (`crmListFlag`), so the wording is the flag's own and not always "typed by hand".
 *
 * `compact` is the chip under a card's customer name; the full box leads the approval window.
 */
export function NotOnCrmListFlag({ compact = false, flag }: { compact?: boolean; flag: string | null | undefined }) {
  if (!flag) return null;
  if (compact) {
    return (
      <p
        className="mt-1 inline-flex items-start gap-1 rounded-none border border-amber-300 bg-amber-50 px-2 py-0.5 text-phx-2xs font-black uppercase tracking-wide text-amber-900"
        title={flag}
      >
        <AlertTriangle aria-hidden className="mt-px h-3 w-3 shrink-0" />
        <span>{crmListFlagChip(flag)}</span>
      </p>
    );
  }
  return (
    <div className="rounded-none border border-amber-300 bg-amber-50 px-2.5 py-2" role="note">
      <p className="flex items-start gap-1.5 text-phx-xs font-black text-amber-900">
        <AlertTriangle aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
        <span>{flag}</span>
      </p>
    </div>
  );
}
