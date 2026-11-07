"use client";

import { Check, ChevronDown, ChevronUp, Loader2, RotateCcw, Sparkles, Undo2, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { adminThumbBarDepthClassName } from "@/components/admin/admin-design-tokens";
import {
  phxButtonApproveClassName,
  phxButtonDangerClassName,
  phxButtonGhostClassName,
  phxFieldClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { formatDateValue, formatNumberValue } from "@/lib/i18n/format";
import { isAdjustedAmount, isRejectedStatus } from "@/lib/outstation/approval-state";
import { idleDayDeductionSuggestions, reasonAfterIdleDayPick } from "@/lib/outstation/idle-day-deduction";
import { approvedAmountFromDeduction, deductionFromApprovedAmount } from "@/lib/outstation/payable";
import { tripSpan, tripSpanLabel } from "@/lib/outstation/trip-span";
import { cn } from "@/lib/utils";

import { type Decision, type LoadedRecord, type TripIdleDays, egp } from "./shared";

/**
 * The decision (owner, 2026-11-07: "put it in the left side, make the full right side for
 * reviewing"): under the trip list in the left column on a desktop; the slim sticky row at the foot
 * of a phone, where there is no left column. Never a fixed band over the trip.
 *
 * ONE ROW: the amount, Approve / Reject (or Undo), "3 unsaved · Save 3". His words the same night,
 * on the first cut that stacked the equation and the reason box in the footer: "the fixed part down
 * makes me not able to clearly see" — so the deduction and the reason fold out under the row only on
 * "Adjust · reason", on a Reject with no reason yet (the cursor lands in the box), or while a changed
 * amount still has no reason. The old page had the decision at the foot of a scroll box AND a second
 * floating Save bar over the list; this is both, once, and slim.
 *
 * Presentation only: every value, rule and callback is exactly what the old panel used. On the
 * By employee view only the Save end shows.
 */
export function DecisionBar({
  canDecide,
  decision,
  dirtyCount,
  idle,
  onApprove,
  onChangeAmount,
  onChangeReason,
  onReject,
  onSave,
  onUnapprove,
  onUnreject,
  placement,
  record,
  saving,
  valuesOnly,
}: {
  canDecide: boolean;
  decision: Decision | null;
  dirtyCount: number;
  /** The open trip's idle days once its field work is read; null until then, or with none to read. */
  idle?: TripIdleDays | null;
  onApprove: () => void;
  onChangeAmount: (value: number) => void;
  onChangeReason: (value: string) => void;
  onReject: () => void;
  onSave: () => void;
  onUnapprove: () => void;
  onUnreject: () => void;
  /**
   * Where it sits (owner, 2026-11-07: "put it in the left side, make the full right side for
   * reviewing"). "rail": under the trip list in the left column on a desktop, nothing fixed over
   * the trip. "bar": the slim sticky row at the foot of a phone, where there is no left column.
   */
  placement: "bar" | "rail";
  /** Null on the By employee view, or with nothing chosen: the bar then holds only Save. */
  record: LoadedRecord | null;
  saving: boolean;
  /** Imported history (trips before July 2026): shown, never decided. See imported-history.ts. */
  valuesOnly: boolean;
}) {
  // Which trip's bar is unfolded (the deduction and the reason box). One row otherwise.
  const [openFor, setOpenFor] = useState<string | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  // The reason box grows with what is in it — WRAPPED lines too, not only typed line breaks — from
  // three rows to ten, then scrolls inside (owner's review, 2026-11-07: a long system sentence sat
  // in a one-line box). Measured from scrollHeight after every change and every unfold.
  const reasonText = decision?.hrComment ?? "";
  useEffect(() => {
    const box = reasonRef.current;
    if (!box) return;
    const style = window.getComputedStyle(box);
    const line = Number.parseFloat(style.lineHeight) || 20;
    const borders = Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
    const chrome = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom) + borders;
    box.style.height = "auto";
    const wanted = box.scrollHeight + borders;
    const ceiling = line * 10 + chrome;
    box.style.height = `${Math.ceil(Math.min(Math.max(wanted, line * 3 + chrome), ceiling))}px`;
    box.style.overflowY = wanted > ceiling ? "auto" : "hidden";
  }, [reasonText, openFor, record?.tripId]);
  // Both placements are mounted at once (CSS picks one per width), so ids must not collide.
  const idPrefix = placement === "rail" ? "rail" : "bar";
  const shellClassName =
    placement === "bar"
      ? cn("sticky bottom-0 z-20 border-t-2 border-slate-900 bg-white lg:hidden", adminThumbBarDepthClassName)
      : "border-t-2 border-slate-900 bg-white";

  if (!record || !decision) {
    if (dirtyCount === 0) return null;
    return (
      <div className={shellClassName} data-decision-bar data-placement={placement}>
        <div className="flex items-center justify-end gap-3 px-4 py-3">
          <SaveCluster dirtyCount={dirtyCount} onSave={onSave} saving={saving} />
        </div>
      </div>
    );
  }

  const adjusted = isAdjustedAmount(decision.approvedAmount, record.total);
  // Derived, never stored: `approvedAmount` stays the single value that gets saved, so the
  // Deduction field cannot introduce a second source of truth for what a trip pays.
  const deduction = deductionFromApprovedAmount(record.total, decision.approvedAmount);
  const reasonMissing = adjusted && !decision.hrComment.trim();
  const isRejected = isRejectedStatus(decision.status);
  // A rejection the employee cannot be given a reason for is not defensible, so it is gated the
  // same way a changed amount is.
  const rejectReasonMissing = !decision.hrComment.trim();
  const span = tripSpan(record.date, record.toDate);
  const locked = valuesOnly || !canDecide;
  // Open for THIS trip only: picking another trip folds the bar back to its one row.
  const open = openFor === record.tripId;
  // A changed amount with no reason cannot be approved, so the box is shown whether or not he
  // opened it — the rose hint under it says why.
  const expanded = open || (reasonMissing && !locked);
  // Owner, 2026-11-07 ~01:50, on how idle days are deducted: "LET ME DECIDE". The box OFFERS the
  // allowance share for the idle days — per idle day, or the whole allowance — and nothing moves
  // until he clicks one; the Deduction it fills stays editable and Approve is still his click.
  // Only an undecided trip is offered one: a decided trip is reopened with Undo first.
  const undecided = !decision.hrApproved && !isRejected;
  const suggestions =
    !locked && undecided && idle
      ? idleDayDeductionSuggestions({ allowance: record.allowance, idleDays: idle.idleDays, total: record.total, tripDays: idle.tripDays })
      : [];
  // The sentence the box opened with: the system's hold reason stored on the trip. An undecided
  // trip's box holds it until he types, so it is labelled as the system's, never read as his.
  const systemText = (record.hrComment ?? "").trim();
  const showsSystemText = undecided && systemText !== "" && decision.hrComment.trim() === systemText;
  const applySuggestion = (suggestion: (typeof suggestions)[number]) => {
    onChangeAmount(approvedAmountFromDeduction(record.total, suggestion.deduction));
    // His own words are never written over; the rule lives in idle-day-deduction.ts.
    const next = reasonAfterIdleDayPick({
      current: decision.hrComment,
      picked: suggestion.reason,
      reasons: suggestions.map((entry) => entry.reason),
      systemText,
    });
    if (next !== null) onChangeReason(next);
  };
  const openPanel = () => {
    setOpenFor(record.tripId);
    window.requestAnimationFrame(() => reasonRef.current?.focus());
  };

  return (
    <div className={shellClassName} data-decision-bar data-placement={placement}>
      {/* ── The one row (owner, 2026-11-07: "the fixed part down makes me not able to clearly
          see"). The amount, the two buttons, Save. Nothing else until he asks for it. ── */}
      <div className="flex flex-col gap-2 px-3 py-2.5 lg:px-4">
        {/* Row 1: the amount, his reason if he wrote one, and the fold toggle at the end. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="font-mono text-sm font-bold tabular-nums text-slate-900">
          {adjusted ? (
            <>
              <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-orange-600">Approved </span>
              {egp(decision.approvedAmount)}
              <span className="ml-2 text-xs font-semibold text-slate-400 line-through">{egp(record.total)}</span>
            </>
          ) : (
            <>
              <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">Claimed </span>
              {egp(record.total)}
            </>
          )}
        </p>
        {decision.hrComment.trim() && !expanded ? (
          <p className="min-w-0 flex-1 basis-40 break-words text-xs text-slate-600" data-folded-reason>
            {showsSystemText ? (
              <span className="mr-1 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">Why it is held ·</span>
            ) : null}
            <bdi dir="auto">{decision.hrComment}</bdi>
          </p>
        ) : null}
        {!locked ? (
          <button
            aria-expanded={expanded}
            className={cn(phxButtonGhostClassName, "ml-auto whitespace-nowrap")}
            onClick={() => (open ? setOpenFor(null) : openPanel())}
            type="button"
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
            {expanded ? "Close" : "Adjust · reason"}
          </button>
        ) : null}
        </div>

        {/* Row 2: the decision itself, Save at the end. */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Hidden entirely for a read-only viewer (the CEO, 2026-08-08) rather than disabled: a
              row of greyed-out buttons invites someone to keep clicking. Presentation only — the
              decision route asserts system-administrator access on its own. */}
          {valuesOnly ? (
            <p className="text-xs font-semibold text-slate-500">Imported before 1 July 2026 · values only, nothing to decide here.</p>
          ) : !canDecide ? (
            <p className="text-xs font-semibold text-slate-500">Read-only access · deciding is reserved for a system administrator.</p>
          ) : decision.hrApproved ? (
            <button className={phxButtonGhostClassName} onClick={onUnapprove} type="button">
              <Undo2 className="h-4 w-4" /> Unapprove
            </button>
          ) : isRejected ? (
            <button className={phxButtonGhostClassName} onClick={onUnreject} type="button">
              <Undo2 className="h-4 w-4" /> Undo rejection
            </button>
          ) : (
            // In the 19rem rail the two buttons share one line as equal halves, and the amount is
            // the row above ("Claimed", or "Approved" once adjusted) rather than in the label.
            // Owner, 2026-11-07 ("FIX BUTTONS", on "Approv" and "Reject" cut off beside "3 unsaved"):
            // in the rail the pair takes the WHOLE width, and Save drops to its own line under it.
            // `flex-1` let the 19rem row squeeze both buttons and Save onto one clipped line.
            <div className={placement === "rail" ? "grid w-full basis-full grid-cols-2 gap-2" : "flex flex-wrap gap-2"}>
              <button
                className={cn(phxButtonApproveClassName, "justify-center whitespace-nowrap")}
                disabled={reasonMissing}
                onClick={onApprove}
                type="button"
              >
                <Check className="h-4 w-4" /> Approve{placement === "bar" ? ` ${egp(decision.approvedAmount)}` : null}
              </button>
              {/* A rejection the employee cannot be given a reason for is not defensible: with no
                  reason yet, Reject opens the box and puts the cursor in it instead of refusing. */}
              <button
                className={cn(phxButtonDangerClassName, "justify-center")}
                onClick={rejectReasonMissing ? openPanel : onReject}
                type="button"
              >
                <XCircle className="h-4 w-4" /> Reject
              </button>
            </div>
          )}
          {dirtyCount > 0 ? (
            <div className={placement === "rail" ? "flex w-full basis-full justify-end" : "ml-auto"} data-save-cluster>
              <SaveCluster dirtyCount={dirtyCount} onSave={onSave} saving={saving} />
            </div>
          ) : null}
        </div>
        {suggestions.length > 0 && !expanded && !adjusted && idle ? (
          <button
            className="self-start text-left text-phx-xs font-bold text-orange-700 underline-offset-2 hover:underline"
            data-idle-deduction-hint
            onClick={openPanel}
            type="button"
          >
            {formatNumberValue(idle.idleDays)} of {formatNumberValue(idle.tripDays)} days with no field activity · see the
            suggested deduction
          </button>
        ) : null}
      </div>

      {expanded ? (
        <div
          className={cn(
            "grid gap-x-6 gap-y-2 border-t border-slate-200 px-4 py-2.5",
            // In the rail everything stacks in its 19rem; at the foot of a phone the row is wide enough for two columns only above lg, where the bar is hidden anyway.
            placement === "bar" ? "lg:grid-cols-[auto_minmax(0,1fr)] lg:items-start lg:py-3" : "",
          )}
        >
          {/* Claimed − Deduction = Approved, written out as the equation it is. HR thinks in "cut
              200 off this", so Deduction is the field to type in and Approved follows; typing
              Approved directly still works and back-fills the deduction (one function, payable.ts). */}
          {/* Three equal columns that fit the 19rem rail — label above, input full width — so
              Approved never drops onto a line of its own (owner's review, 2026-11-07). */}
          <div className="grid grid-cols-3 items-end gap-x-2 gap-y-2" data-amount-equation>
            <div className="min-w-0">
              <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">Claimed</p>
              <p className="mt-1 h-10 break-words font-mono text-sm font-bold leading-10 text-slate-900">{egp(record.total)}</p>
            </div>
            <div className="min-w-0">
              <label
                className="text-phx-2xs font-black uppercase tracking-[0.12em] text-orange-600"
                htmlFor={`${idPrefix}-deduct-${record.tripId}`}
              >
                − Deduction
              </label>
              <input
                className={cn(
                  phxFieldClassName, "mt-1 block w-full min-w-0 text-right font-mono",
                  deduction > 0 ? "border-orange-400 text-orange-700" : "",
                )}
                disabled={locked}
                id={`${idPrefix}-deduct-${record.tripId}`}
                inputMode="decimal"
                max={record.total}
                min={0}
                onChange={(event) =>
                  onChangeAmount(approvedAmountFromDeduction(record.total, Number(event.target.value)))
                }
                type="number"
                value={String(deduction)}
              />
            </div>
            <div className="min-w-0">
              <label className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400" htmlFor={`${idPrefix}-amt-${record.tripId}`}>
                = Approved
              </label>
              <input
                className={cn(
                  phxFieldClassName, "mt-1 block w-full min-w-0 text-right font-mono font-bold",
                  adjusted ? "border-orange-400" : "",
                )}
                disabled={locked}
                id={`${idPrefix}-amt-${record.tripId}`}
                inputMode="decimal"
                max={record.total}
                min={0}
                onChange={(event) =>
                  onChangeAmount(
                    approvedAmountFromDeduction(
                      record.total,
                      deductionFromApprovedAmount(record.total, Number(event.target.value)),
                    ),
                  )
                }
                type="number"
                value={String(decision.approvedAmount)}
              />
            </div>
            {adjusted && !locked ? (
              <button className={cn(phxButtonGhostClassName, "col-span-3 justify-self-start")} onClick={() => onChangeAmount(record.total)} type="button">
                <RotateCcw className="h-3.5 w-3.5" /> Clear
              </button>
            ) : null}
          </div>

          {suggestions.length > 0 && idle ? (
            <div className="min-w-0 border-l-2 border-orange-400 bg-orange-50/60 px-3 py-2" data-idle-deduction>
              <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-orange-700">
                Suggested deduction · {formatNumberValue(idle.idleDays)} of {formatNumberValue(idle.tripDays)} days with no field
                activity
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {suggestions.map((suggestion) => {
                  const chosen = adjusted && Math.abs(deduction - suggestion.deduction) < 0.005;
                  return (
                    <button
                      aria-pressed={chosen}
                      className={cn(
                        "border px-2.5 py-1 text-left text-xs font-bold transition-colors",
                        chosen
                          ? "border-orange-600 bg-orange-600 text-white"
                          : "border-orange-300 bg-white text-orange-800 hover:bg-orange-100",
                      )}
                      data-idle-suggestion={suggestion.key}
                      key={suggestion.key}
                      onClick={() => applySuggestion(suggestion)}
                      type="button"
                    >
                      {suggestion.label} · <span className="font-mono tabular-nums">{egp(suggestion.deduction)}</span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 text-phx-2xs text-slate-500">
                Allowance {egp(record.allowance)} only · travel and tickets are never part of it. Nothing changes until you pick
                one, and the deduction stays editable.
              </p>
            </div>
          ) : null}

          {/* The reason: a box that grows with what he writes, never one cut-off line. */}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400" htmlFor={`${idPrefix}-reason-${record.tripId}`}>
                Reason / comment{" "}
                {adjusted ? (
                  <span className="text-rose-500">(required for a changed amount)</span>
                ) : (
                  <span className="text-slate-400">(required to reject)</span>
                )}
              </label>
              {/* Only the figures already on this screen are offered, so the note can cite the
                  deduction without anything being able to invent one. */}
              <SystemNoteRewriteControl
                disabled={locked}
                facts={[
                  { label: "Claimed total", value: egp(record.total) },
                  { label: "Approved amount", value: egp(decision.approvedAmount) },
                  ...(adjusted ? [{ label: "Deduction", value: egp(deduction) }] : []),
                  { label: "Trip start", value: formatDateValue(record.date) },
                  { label: "Trip end", value: formatDateValue(record.toDate) },
                  { label: "Trip length", value: tripSpanLabel(span) },
                  ...(record.km ? [{ label: "Distance", value: `${formatNumberValue(record.km)} km` }] : []),
                  { label: "Expense type", value: record.requestType || "—" },
                ]}
                onChangeReason={onChangeReason}
                outcome={
                  decision.hrApproved ? (adjusted ? "adjusted" : "approved") : isRejected ? "rejected" : "pending"
                }
                value={decision.hrComment}
              />
            </div>
            <textarea
              className={cn(phxTextareaClassName, "mt-1 resize-none", reasonMissing ? "border-rose-400" : "")}
              disabled={locked}
              dir="auto"
              id={`${idPrefix}-reason-${record.tripId}`}
              onChange={(event) => onChangeReason(event.target.value)}
              placeholder={adjusted ? "Why is the approved amount different?" : "Optional to approve · required to reject"}
              ref={reasonRef}
              rows={3}
              value={decision.hrComment}
            />
            {reasonMissing ? (
              <p className="mt-1 text-xs font-semibold text-rose-600">Add a reason to approve a changed amount.</p>
            ) : !decision.hrApproved && !isRejected && rejectReasonMissing && !locked ? (
              <p className="mt-1 text-xs font-semibold text-slate-500">Add a reason to reject this trip.</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** "3 unsaved · Save 3". Decisions are held locally until this is pressed. */
function SaveCluster({ dirtyCount, onSave, saving }: { dirtyCount: number; onSave: () => void; saving: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2 lg:justify-end">
      <span className="whitespace-nowrap text-xs font-bold text-slate-700">
        {formatNumberValue(dirtyCount)} unsaved
      </span>
      <button
        className="inline-flex items-center gap-1.5 whitespace-nowrap border border-orange-600 bg-orange-500 px-4 py-2 text-sm font-bold text-white transition hover:bg-orange-600 disabled:pointer-events-none disabled:opacity-50"
        disabled={saving}
        onClick={onSave}
        type="button"
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
        Save {formatNumberValue(dirtyCount)}
      </button>
    </div>
  );
}

/**
 * Rewrites the approver's rough comment into the sentence the employee reads.
 *
 * Owner request 2026-08-08: the note must land "as if the system auto replied" — now that HR sits
 * behind the workflow rather than in front of it, a decision should not read as one named person's
 * verdict. The approver writes what he means, in Arabic or English, however roughly; this puts it
 * into the system's own voice.
 *
 * Deliberately not automatic and not hidden: it replaces the field's text in place, the previous
 * wording stays one click away, and nothing is saved until he presses Save as usual. Per the
 * owner's standing rule, no user-facing surface names a model — this is presented as something
 * Phoenix does.
 */
function SystemNoteRewriteControl({
  disabled,
  facts,
  onChangeReason,
  outcome,
  value,
}: {
  disabled: boolean;
  facts: Array<{ label: string; value: string }>;
  onChangeReason: (value: string) => void;
  outcome: "adjusted" | "approved" | "pending" | "rejected";
  value: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The approver's own wording, kept so a rewrite he dislikes costs one click to undo.
  const [previous, setPrevious] = useState<string | null>(null);

  async function rewrite() {
    const draft = value.trim();
    if (!draft || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/outstation/expenses/note-assist", {
        body: JSON.stringify({ draft, facts, outcome }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as { message?: string; note?: string } | null;
      if (!response.ok || typeof payload?.note !== "string" || !payload.note.trim()) {
        setError(payload?.message || "The note could not be rewritten. Try again.");
        return;
      }
      setPrevious(draft);
      onChangeReason(payload.note.trim());
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <button
          className="inline-flex items-center gap-1.5 whitespace-nowrap border border-slate-300 bg-white px-2.5 py-1 text-phx-xs font-bold text-slate-700 transition hover:border-orange-400 hover:text-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled || busy || !value.trim()}
          onClick={() => void rewrite()}
          title="Rewrite this comment as a formal system note for the employee"
          type="button"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {busy ? "Rewriting" : "Rewrite formally"}
        </button>
        {previous ? (
          <button
            className="inline-flex items-center gap-1.5 whitespace-nowrap border border-slate-200 bg-white px-2.5 py-1 text-phx-xs font-bold text-slate-500 transition hover:text-slate-900"
            onClick={() => {
              onChangeReason(previous);
              setPrevious(null);
            }}
            type="button"
          >
            <Undo2 className="h-3.5 w-3.5" /> Restore my wording
          </button>
        ) : null}
      </div>
      {error ? <p className="mt-1 text-phx-xs font-semibold text-rose-600">{error}</p> : null}
    </>
  );
}
