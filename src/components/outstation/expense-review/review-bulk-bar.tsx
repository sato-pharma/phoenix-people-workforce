"use client";

import { Check, X } from "lucide-react";

import { CrmButton } from "@/components/phoenix-crm/ui";
import { formatNumberValue } from "@/lib/i18n/format";

import { egp } from "./review-parts";

/**
 * Approve several at once, drawn as Place checks draws its own bulk bar: what is ticked, the money
 * behind it, and anything in the selection that CANNOT be approved — so the consequence is read before
 * pressing, not after. Approving here writes the same decision the single Approve writes and saves
 * nothing: Save still commits, so a mis-click stays reversible right up to that point.
 */
export function ReviewBulkBar({
  approvableCount,
  cleanCount,
  needsPreCutCount,
  needsReasonCount,
  onApprove,
  onClear,
  onPickAll,
  selectableCount,
  selectedCount,
  selectedValue,
}: {
  approvableCount: number;
  /** How many waiting rows in this tab the system found nothing on — offered as one pick. */
  cleanCount: number;
  /** Ticked trips with idle days: a batch cannot show their pre-cut, so each is opened instead. */
  needsPreCutCount: number;
  needsReasonCount: number;
  onApprove: () => void;
  onClear: () => void;
  onPickAll: () => void;
  selectableCount: number;
  selectedCount: number;
  selectedValue: number;
}) {
  if (selectableCount === 0) return null;
  return (
    <div className="min-w-0 space-y-2 border-b border-slate-200 bg-slate-50 px-4 py-3" data-bulk-bar>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-500">
          {selectedCount === 0
            ? `Tick trips to approve together (${formatNumberValue(selectableCount)} here)`
            : `${formatNumberValue(selectedCount)} ticked · ${egp(selectedValue)}`}
        </p>
        {selectedCount < selectableCount ? (
          <CrmButton onClick={onPickAll} size="sm" variant="ghost">
            Tick all {formatNumberValue(selectableCount)}
            {cleanCount === selectableCount && cleanCount > 0 ? " clean" : ""}
          </CrmButton>
        ) : null}
        {selectedCount > 0 ? (
          <>
            <CrmButton onClick={onClear} size="sm" variant="ghost">
              <X aria-hidden className="h-3.5 w-3.5" /> Clear the ticks
            </CrmButton>
            <CrmButton data-bulk-approve disabled={approvableCount === 0} onClick={onApprove} size="sm" variant="success">
              <Check aria-hidden className="h-3.5 w-3.5" />
              Approve {formatNumberValue(approvableCount)}
            </CrmButton>
          </>
        ) : null}
      </div>
      {needsReasonCount > 0 ? (
        <p className="text-xs font-bold text-rose-700">
          {formatNumberValue(needsReasonCount)} cannot be approved yet — a changed amount needs a written reason
        </p>
      ) : null}
      {needsPreCutCount > 0 ? (
        <p className="text-xs font-bold text-orange-700" data-bulk-precut>
          {formatNumberValue(needsPreCutCount)} {needsPreCutCount === 1 ? "has" : "have"} days with no visit and no meeting · open each to approve it with
          its pre-cut
        </p>
      ) : null}
    </div>
  );
}
