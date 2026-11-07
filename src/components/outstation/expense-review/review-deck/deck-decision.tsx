"use client";

import { Check, Loader2, PenLine, RotateCcw, Undo2, XCircle } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";

import { CrmButton, CrmPill } from "@/components/phoenix-crm/ui";
import { phxFieldClassName, phxTextareaClassName } from "@/components/ui/form-tokens";
import { formatDateValue, formatNumberValue } from "@/lib/i18n/format";
import { isAdjustedAmount, isRejectedStatus } from "@/lib/outstation/approval-state";
import { idleDayDeductionSuggestions, reasonAfterIdleDayPick } from "@/lib/outstation/idle-day-deduction";
import { approvedAmountFromDeduction, deductionFromApprovedAmount } from "@/lib/outstation/payable";
import { tripSpan, tripSpanLabel } from "@/lib/outstation/trip-span";
import { cn } from "@/lib/utils";

import { type Decision, type LoadedRecord, type TripIdleDays, decisionStateLabel, reasonAfterChip, reasonChipsFor } from "../review-model";
import { egp } from "../review-parts";

/** What both halves of the decision share: the trip, its decision, and who may change it. */
type DecisionInput = {
  decision: Decision;
  /** False for a read-only viewer (the CEO) — the controls are hidden, never greyed. */
  canDecide: boolean;
  record: LoadedRecord;
  /** Imported history (trips before July 2026): shown, never decided. See imported-history.ts. */
  valuesOnly: boolean;
};

function readDecision({ canDecide, decision, record, valuesOnly }: DecisionInput) {
  const adjusted = isAdjustedAmount(decision.approvedAmount, record.total);
  const isRejected = isRejectedStatus(decision.status);
  return {
    adjusted,
    // Derived, never stored: `approvedAmount` stays the single value that gets saved, so the Deduction
    // field cannot introduce a second source of truth for what a trip pays.
    deduction: deductionFromApprovedAmount(record.total, decision.approvedAmount),
    isRejected,
    locked: valuesOnly || !canDecide,
    // A changed amount with no reason cannot be approved.
    reasonMissing: adjusted && !decision.hrComment.trim(),
    // A rejection the employee cannot be given a reason for is not defensible.
    rejectReasonMissing: !decision.hrComment.trim(),
    undecided: !decision.hrApproved && !isRejected,
  };
}

/**
 * "Your decision" — in the white column, under what the system found: Claimed − Deduction = Approved,
 * the idle-day share OFFERED for the days with no field activity, the reasons as one-click chips, and
 * the reason box. Everything here only prepares the decision; Approve and Reject are the pinned bar's.
 *
 * Owner, 2026-11-07 ~01:50, on how idle days are deducted: "LET ME DECIDE". The share is offered — per
 * idle day, or the whole allowance — and nothing moves until he clicks one; the Deduction it fills stays
 * editable and Approve is still his click. Only an undecided trip is offered one.
 */
export function DeckAdjust({
  idle,
  duplicateOf,
  onChangeAmount,
  onChangeReason,
  reasonRef,
  ...input
}: DecisionInput & {
  duplicateOf?: string[];
  /** The trip's idle days once its field work is read; null until then, or with none to read. */
  idle: TripIdleDays | null;
  onChangeAmount: (value: number) => void;
  onChangeReason: (value: string) => void;
  reasonRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const { decision, record } = input;
  const { adjusted, deduction, isRejected, locked, reasonMissing, rejectReasonMissing, undecided } = readDecision(input);
  const span = tripSpan(record.date, record.toDate);
  const suggestions =
    !locked && undecided && idle ? idleDayDeductionSuggestions({ allowance: record.allowance, idleDays: idle.idleDays, total: record.total, tripDays: idle.tripDays }) : [];
  const chips = locked ? [] : reasonChipsFor({ duplicateOf, idle, record });
  // The sentence the box opened with: the system's hold reason stored on the trip. An undecided trip's
  // box holds it until he types, so it is labelled as the system's, never read as his.
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

  // The reason box grows with what is in it — WRAPPED lines too — from three rows to ten, then scrolls
  // inside (owner's review, 2026-11-07: a long system sentence sat in a one-line box).
  const reasonText = decision.hrComment;
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
  }, [reasonText, reasonRef, record.tripId]);

  if (locked) {
    return decision.hrComment.trim() ? (
      <section className="min-w-0 space-y-1.5 px-5 py-4" data-deck-adjust>
        <h4 className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">The reason on file</h4>
        <p className="min-w-0 whitespace-pre-wrap break-words text-sm text-slate-700" dir="auto">
          {decision.hrComment}
        </p>
      </section>
    ) : null;
  }

  return (
    <section className="min-w-0 space-y-4 px-5 py-4" data-deck-adjust>
      <h4 className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">Your decision</h4>

      {/* Claimed − Deduction = Approved, written out as the equation it is. HR thinks in "cut 200 off
          this", so Deduction is the field to type in and Approved follows; typing Approved directly
          still works and back-fills the deduction (one function, payable.ts). */}
      <div className="grid min-w-0 grid-cols-3 items-end gap-x-2 gap-y-2" data-amount-equation>
        <div className="min-w-0">
          <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">Claimed</p>
          <p className="mt-1 h-10 break-words text-sm font-black leading-10 tabular-nums text-slate-900">{egp(record.total)}</p>
        </div>
        <div className="min-w-0">
          <label className="text-phx-2xs font-black uppercase tracking-[0.12em] text-orange-600" htmlFor={`deck-deduct-${record.tripId}`}>
            − Deduction
          </label>
          <input
            className={cn(phxFieldClassName, "mt-1 block w-full min-w-0 text-right tabular-nums", deduction > 0 ? "border-orange-400 text-orange-700" : "")}
            id={`deck-deduct-${record.tripId}`}
            inputMode="decimal"
            max={record.total}
            min={0}
            onChange={(event) => onChangeAmount(approvedAmountFromDeduction(record.total, Number(event.target.value)))}
            type="number"
            value={String(deduction)}
          />
        </div>
        <div className="min-w-0">
          <label className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400" htmlFor={`deck-amt-${record.tripId}`}>
            = Approved
          </label>
          <input
            className={cn(phxFieldClassName, "mt-1 block w-full min-w-0 text-right font-bold tabular-nums", adjusted ? "border-orange-400" : "")}
            id={`deck-amt-${record.tripId}`}
            inputMode="decimal"
            max={record.total}
            min={0}
            onChange={(event) =>
              onChangeAmount(approvedAmountFromDeduction(record.total, deductionFromApprovedAmount(record.total, Number(event.target.value))))
            }
            type="number"
            value={String(decision.approvedAmount)}
          />
        </div>
        {adjusted ? (
          <div className="col-span-3">
            <CrmButton onClick={() => onChangeAmount(record.total)} size="sm" variant="ghost">
              <RotateCcw aria-hidden className="h-3.5 w-3.5" /> Back to the claimed amount
            </CrmButton>
          </div>
        ) : null}
      </div>

      {suggestions.length > 0 && idle ? (
        <div className="min-w-0 border-l-[3px] border-orange-500 bg-orange-50 px-3 py-2.5" data-idle-deduction>
          <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-orange-700">
            Suggested deduction · {formatNumberValue(idle.idleDays)} of {formatNumberValue(idle.tripDays)} days with no field activity
          </p>
          <div className="mt-1.5 flex min-w-0 flex-wrap gap-1.5">
            {suggestions.map((suggestion) => {
              const chosen = adjusted && Math.abs(deduction - suggestion.deduction) < 0.005;
              return (
                <button
                  aria-pressed={chosen}
                  className={cn(
                    "min-h-9 border px-2.5 py-1 text-left text-xs font-bold transition-colors",
                    chosen ? "border-orange-600 bg-orange-600 text-white" : "border-orange-300 bg-white text-orange-800 hover:bg-orange-100",
                  )}
                  data-idle-suggestion={suggestion.key}
                  key={suggestion.key}
                  onClick={() => applySuggestion(suggestion)}
                  type="button"
                >
                  {suggestion.label} · <span className="tabular-nums">{egp(suggestion.deduction)}</span>
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-phx-2xs text-slate-600">
            Allowance {egp(record.allowance)} only · travel and tickets are never part of it. Nothing changes until you pick one, and the deduction
            stays editable.
          </p>
        </div>
      ) : null}

      <div className="min-w-0 space-y-1.5">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <label className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500" htmlFor={`deck-reason-${record.tripId}`}>
            Reason{" "}
            {adjusted ? <span className="text-rose-600">· required for a changed amount</span> : <span className="text-slate-400">· required to reject</span>}
          </label>
          {/* Only the figures already on this screen are offered, so the note can cite the deduction
              without anything being able to invent one. */}
          <SystemNoteRewriteControl
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
            outcome={decision.hrApproved ? (adjusted ? "adjusted" : "approved") : isRejected ? "rejected" : "pending"}
            value={decision.hrComment}
          />
        </div>
        {chips.length > 0 ? (
          <div className="flex min-w-0 flex-wrap gap-1.5" data-reason-chips>
            {chips.map((chip) => {
              const used = decision.hrComment.includes(chip.text);
              return (
                <button
                  aria-pressed={used}
                  className={cn(
                    "min-h-9 border px-2.5 py-1 text-left text-xs font-bold transition-colors",
                    used ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700 hover:border-orange-400 hover:text-orange-800",
                  )}
                  data-reason-chip={chip.key}
                  key={chip.key}
                  onClick={() => onChangeReason(reasonAfterChip({ chips, current: decision.hrComment, picked: chip, systemText }))}
                  title={chip.text}
                  type="button"
                >
                  {chip.label}
                </button>
              );
            })}
          </div>
        ) : null}
        {showsSystemText ? (
          <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">Why it is held · the system&rsquo;s sentence until you write your own</p>
        ) : null}
        <textarea
          className={cn(phxTextareaClassName, "resize-none", reasonMissing ? "border-rose-400" : "")}
          dir="auto"
          id={`deck-reason-${record.tripId}`}
          onChange={(event) => onChangeReason(event.target.value)}
          placeholder={adjusted ? "Why is the approved amount different?" : "Optional to approve · required to reject"}
          ref={reasonRef}
          rows={3}
          value={decision.hrComment}
        />
        {reasonMissing ? (
          <p className="text-xs font-semibold text-rose-600">Add a reason to approve a changed amount.</p>
        ) : undecided && rejectReasonMissing ? (
          <p className="text-xs font-semibold text-slate-500">Add a reason to reject this trip.</p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The decision itself, pinned at the foot of the white column on a wide screen (it follows the column
 * on a phone, where only Back / Next is pinned): the amount that will be paid, Approve and Reject — or
 * Unapprove / Undo rejection once decided — and "N unsaved · Save N". 🔴 It is ONE short band, so at
 * the top of the trip Approve is on screen without a scroll (live review, 2026-11-07: Approve sat 57px
 * under the fold).
 *
 * Presentation only: every value, rule and callback is exactly what the hook hands it. A read-only
 * viewer sees a sentence instead of the buttons — never a row of greyed-out ones.
 */
export function DeckDecisionBar({
  dirtyCount,
  onApprove,
  onReject,
  onSave,
  onUnapprove,
  onUnreject,
  reasonRef,
  saving,
  ...input
}: DecisionInput & {
  dirtyCount: number;
  onApprove: () => void;
  onReject: () => void;
  onSave: () => void;
  onUnapprove: () => void;
  onUnreject: () => void;
  reasonRef: RefObject<HTMLTextAreaElement | null>;
  saving: boolean;
}) {
  const { decision, record, valuesOnly, canDecide } = input;
  const { adjusted, isRejected, reasonMissing, rejectReasonMissing } = readDecision(input);
  const state = decisionStateLabel(decision, record);
  // With no reason yet, Reject puts the cursor in the reason box instead of refusing.
  const askForReason = () => {
    const box = reasonRef.current;
    if (!box) return;
    box.scrollIntoView({ behavior: "smooth", block: "center" });
    window.requestAnimationFrame(() => box.focus());
  };
  return (
    <div className="min-w-0 space-y-2.5" data-deck-decision>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 text-sm font-bold tabular-nums text-slate-900">
          <span className={cn("text-phx-2xs font-black uppercase tracking-[0.12em]", adjusted ? "text-orange-600" : "text-slate-400")}>
            {adjusted ? "Pays " : "Claimed "}
          </span>
          {egp(decision.approvedAmount)}
          {adjusted ? <span className="ml-2 text-xs font-semibold text-slate-400 line-through">{egp(record.total)}</span> : null}
        </p>
        <CrmPill tone={state.tone}>{state.label}</CrmPill>
      </div>
      {valuesOnly ? (
        <p className="text-xs font-semibold text-slate-500">Imported before 1 July 2026 · values only, nothing to decide here.</p>
      ) : !canDecide ? (
        <p className="text-xs font-semibold text-slate-500">Read-only access · deciding is reserved for a system administrator.</p>
      ) : decision.hrApproved ? (
        <CrmButton className="w-full" onClick={onUnapprove}>
          <Undo2 aria-hidden className="h-4 w-4" /> Unapprove
        </CrmButton>
      ) : isRejected ? (
        <CrmButton className="w-full" onClick={onUnreject}>
          <Undo2 aria-hidden className="h-4 w-4" /> Undo rejection
        </CrmButton>
      ) : (
        <div className="grid min-w-0 grid-cols-2 gap-2">
          <CrmButton data-deck-approve disabled={reasonMissing} onClick={onApprove} title={reasonMissing ? "Add a reason for the changed amount first" : undefined} variant="success">
            <Check aria-hidden className="h-4 w-4" /> Approve
          </CrmButton>
          <CrmButton data-deck-reject onClick={rejectReasonMissing ? askForReason : onReject} variant="danger">
            <XCircle aria-hidden className="h-4 w-4" /> Reject
          </CrmButton>
        </div>
      )}
      {dirtyCount > 0 ? (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2.5" data-save-cluster>
          <span className="text-xs font-bold text-slate-700">
            {formatNumberValue(dirtyCount)} unsaved · nothing is written until you save
          </span>
          <CrmButton busy={saving} onClick={onSave} size="sm" variant="primary">
            {saving ? null : <Check aria-hidden className="h-4 w-4" />}
            Save {formatNumberValue(dirtyCount)}
          </CrmButton>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Rewrites the approver's rough comment into the sentence the employee reads.
 *
 * Owner request 2026-08-08: the note must land "as if the system auto replied" — a decision should not
 * read as one named person's verdict. The approver writes what they mean, in Arabic or English, however
 * roughly; this puts it into the system's own voice.
 *
 * Deliberately not automatic and not hidden: it replaces the box's text in place, the previous wording
 * stays one click away, and nothing is saved until Save. Per the owner's standing rule, no user-facing
 * surface names a model — this is presented as something Phoenix does.
 */
function SystemNoteRewriteControl({
  facts,
  onChangeReason,
  outcome,
  value,
}: {
  facts: Array<{ label: string; value: string }>;
  onChangeReason: (value: string) => void;
  outcome: "adjusted" | "approved" | "pending" | "rejected";
  value: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The approver's own wording, kept so a rewrite they dislike costs one click to undo.
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
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <button
        className="inline-flex min-h-8 items-center gap-1.5 border border-slate-300 bg-white px-2.5 py-1 text-phx-xs font-bold text-slate-700 transition hover:border-orange-400 hover:text-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={busy || !value.trim()}
        onClick={() => void rewrite()}
        title="Rewrite this comment as a formal system note for the employee"
        type="button"
      >
        {busy ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <PenLine aria-hidden className="h-3.5 w-3.5" />}
        {busy ? "Rewriting" : "Rewrite formally"}
      </button>
      {previous ? (
        <button
          className="inline-flex min-h-8 items-center gap-1.5 border border-slate-200 bg-white px-2.5 py-1 text-phx-xs font-bold text-slate-500 transition hover:text-slate-900"
          onClick={() => {
            onChangeReason(previous);
            setPrevious(null);
          }}
          type="button"
        >
          <Undo2 aria-hidden className="h-3.5 w-3.5" /> Restore my wording
        </button>
      ) : null}
      {error ? <p className="basis-full text-phx-xs font-semibold text-rose-600">{error}</p> : null}
    </div>
  );
}
