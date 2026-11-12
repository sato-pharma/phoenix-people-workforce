"use client";

import { useState } from "react";
import { Check, X } from "lucide-react";

import { CrmButton } from "@/components/phoenix-crm/ui";
import { phxTextareaClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";
import { formatNumberValue } from "@/lib/i18n/format";

import { egp } from "./review-parts";

/**
 * Approve several at once, drawn as Place checks draws its own bulk bar: what is ticked, the money
 * behind it, and anything in the selection that CANNOT be approved — so the consequence is read before
 * pressing, not after. Approving here writes the same decision the single Approve writes and saves
 * nothing: Save still commits, so a mis-click stays reversible right up to that point.
 *
 * Reject N (owner, 2026-11-12) is its twin: one written reason for every ticked trip still waiting —
 * the employees read it, so the button asks for it before anything is marked — and it too saves nothing.
 */
export function ReviewBulkBar({
  approvableCount,
  cleanCount,
  needsPreCutCount,
  needsReasonCount,
  onApprove,
  onClear,
  onPickAll,
  onReject,
  rejectableCount,
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
  /** Marks every ticked trip still waiting as rejected, with this one reason. Saves nothing. */
  onReject: (reason: string) => void;
  rejectableCount: number;
  selectableCount: number;
  selectedCount: number;
  selectedValue: number;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  if (selectableCount === 0) return null;
  const confirmReject = () => {
    if (!reason.trim()) return;
    onReject(reason);
    setRejecting(false);
    setReason("");
  };
  return (
    // Rides at the right end of the table's one heading line, never a band of its own (owner,
    // 2026-11-07: "fold the expense table heading into one line"). A warning, when there is one,
    // wraps under the controls.
    <div className="flex min-w-0 flex-1 basis-80 flex-wrap items-center justify-end gap-x-2 gap-y-1" data-bulk-bar>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
        <p className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">
          {selectedCount === 0
            ? `Tick trips to approve or reject together (${formatNumberValue(selectableCount)} here)`
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
            <CrmButton data-bulk-reject disabled={rejectableCount <= 0} onClick={() => setRejecting(true)} size="sm" variant="danger">
              <X aria-hidden className="h-3.5 w-3.5" />
              Reject {formatNumberValue(Math.max(0, rejectableCount))}
            </CrmButton>
          </>
        ) : null}
      </div>
      {rejecting && selectedCount > 0 ? (
        <div className="basis-full space-y-2" data-bulk-reject-reason>
          <label className="block space-y-1 text-left">
            <span className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">
              Reason for rejecting {formatNumberValue(Math.max(0, rejectableCount))} trips — every employee reads it
            </span>
            <textarea
              autoFocus
              className={cn(phxTextareaClassName, "resize-none text-base md:text-sm")}
              onChange={(event) => setReason(event.target.value)}
              rows={2}
              value={reason}
            />
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <CrmButton onClick={() => { setRejecting(false); setReason(""); }} size="sm" variant="ghost">
              Cancel
            </CrmButton>
            <CrmButton data-bulk-reject-confirm disabled={!reason.trim()} onClick={confirmReject} size="sm" variant="danger">
              Reject {formatNumberValue(Math.max(0, rejectableCount))} with this reason
            </CrmButton>
          </div>
        </div>
      ) : null}
      {needsReasonCount > 0 ? (
        <p className="basis-full text-right text-xs font-bold text-rose-700">
          {formatNumberValue(needsReasonCount)} cannot be approved yet — a changed amount needs a written reason
        </p>
      ) : null}
      {needsPreCutCount > 0 ? (
        <p className="basis-full text-right text-xs font-bold text-orange-700" data-bulk-precut>
          {formatNumberValue(needsPreCutCount)} {needsPreCutCount === 1 ? "has" : "have"} days with no visit and no meeting · open each to approve it with
          its pre-cut
        </p>
      ) : null}
    </div>
  );
}
