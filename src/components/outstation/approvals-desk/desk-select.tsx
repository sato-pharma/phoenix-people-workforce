"use client";

import { Check, X } from "lucide-react";
import { useId, useState } from "react";

import { approvalActionClassName } from "@/components/approvals-hub/approval-action-kit";
import { CrmField, crmTextareaClassName } from "@/components/phoenix-crm/ui";
import { formatNumberValue } from "@/lib/i18n/format";
import { DESK_WORDS, type DeskSelection, rejectSelection } from "@/lib/outstation/approvals/desk-view";
import type { DeskClaim, DeskDecisionRequest } from "@/lib/outstation/approvals/types";
import { cn } from "@/lib/utils";

import { egp } from "./desk-parts";

/**
 * Several claims in one press — tick them, then "Approve N" or "Reject N".
 *
 * The page it replaces had this and the rebuild keeps it: ten copies of one trip are rejected with
 * ONE written reason, not ten. Only a waiting claim carries a tick, and only for someone who can
 * decide. "Approve N" sends each row's OWN Approve — the figure on the button is the sum of what
 * those buttons say, so a batch never pays an idle day in full. "Reject N" is refused until a
 * reason is written: every one of those employees is told it.
 *
 * Like any other press it goes to `onPress` and waits its six seconds of Undo (use-desk.ts).
 */

/** A row's tick. The label is a 44px-tall target drawn over the row's own padding, so it adds no height. */
export function TickBox({ checked, name, onChange }: { checked: boolean; name: string; onChange: (checked: boolean) => void }) {
  return (
    <label className="-my-3 -ml-2 inline-flex h-11 w-9 shrink-0 cursor-pointer items-center justify-center" data-tick>
      <span className="sr-only">Tick {name || "this employee"}&apos;s claim</span>
      <input checked={checked} className="h-4 w-4 rounded-none accent-orange-600" onChange={(event) => onChange(event.target.checked)} type="checkbox" />
    </label>
  );
}

/** "All 20 shown" — ticks, or clears, every claim drawn in the lane. */
export function TickAll({ checked, count, onChange }: { checked: boolean; count: number; onChange: (checked: boolean) => void }) {
  return (
    <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm font-bold text-slate-700" data-tick-all>
      <input checked={checked} className="h-4 w-4 rounded-none accent-orange-600" onChange={(event) => onChange(event.target.checked)} type="checkbox" />
      All {formatNumberValue(count)} shown
    </label>
  );
}

export function SelectionBar({
  onClear,
  onPress,
  selection,
}: {
  onClear: () => void;
  onPress: (decisions: DeskDecisionRequest[], claims: DeskClaim[]) => void;
  selection: DeskSelection;
}) {
  const id = useId();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const count = formatNumberValue(selection.count);
  const rejections = rejectSelection(selection.claims, reason);

  const send = (decisions: DeskDecisionRequest[]) => {
    if (decisions.length === 0) return;
    onPress(decisions, selection.claims);
    setRejecting(false);
    setReason("");
    onClear();
  };

  return (
    <div className="min-w-0 border-b border-slate-200 bg-slate-50 px-4 py-2" data-selection-bar={selection.count}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 break-words text-sm font-black text-slate-950">
          {count} ticked
          {selection.left > 0 ? <span className="ml-2 font-semibold text-slate-500">{formatNumberValue(selection.left)} more stay ticked for the next press</span> : null}
        </p>
        <button className={approvalActionClassName("approve", "regular")} data-approve-ticked onClick={() => send(selection.approve)} type="button">
          <Check aria-hidden className="h-4 w-4 shrink-0" />
          {DESK_WORDS.approve} {count} · {egp(selection.value)}
        </button>
        <button aria-expanded={rejecting} className={approvalActionClassName("reject", "regular")} data-reject-ticked onClick={() => setRejecting((open) => !open)} type="button">
          <X aria-hidden className="h-4 w-4 shrink-0" />
          {DESK_WORDS.reject} {count}
        </button>
        <button className={approvalActionClassName("neutral", "regular")} data-clear-ticks onClick={onClear} type="button">
          {DESK_WORDS.clearTicks}
        </button>
      </div>
      {rejecting ? (
        <div className="mt-2 grid min-w-0 gap-2" data-reject-ticked-panel>
          <CrmField hint={`Each of the ${count} employees is told this reason.`} htmlFor={`${id}-reason`} label="One reason for all of them">
            <textarea className={cn(crmTextareaClassName, "min-h-16")} dir="auto" id={`${id}-reason`} onChange={(event) => setReason(event.target.value)} value={reason} />
          </CrmField>
          <div className="flex min-w-0 flex-wrap gap-2">
            <button className={approvalActionClassName("reject", "regular")} data-reject-ticked-confirm disabled={rejections.length === 0} onClick={() => send(rejections)} type="button">
              {DESK_WORDS.reject} {count}
            </button>
            <button className={approvalActionClassName("neutral", "regular")} onClick={() => setRejecting(false)} type="button">
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
