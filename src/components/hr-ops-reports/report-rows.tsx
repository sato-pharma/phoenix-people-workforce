"use client";

// HR Daily & Weekly Reports — the rows of one report section, with her review editor and his
// decision editor.
//
// FITS THE SCREEN: a `w-full table-fixed` table with a `<colgroup>` when THIS block is wide, and
// cards when it is not — switched on the block's own width (`@container`), because the block sits
// in a grid cell beside the report list and a viewport breakpoint would read the wrong width.
// Square edges throughout, and every field wears the house form tokens.

import { useState } from "react";

import { FormError, FormField } from "@/components/ui/form-kit";
import {
  phxButtonAccentClassName,
  phxButtonGhostClassName,
  phxButtonPrimaryClassName,
  phxFieldClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { MAX_DAYS, maxDaysMessage } from "@/lib/hr-ops-reports/rules";
import type { HrOpsLineView } from "@/lib/hr-ops-reports/serialize";
import { cn } from "@/lib/utils";

import { formatDays, formatEgp, formatStamp, formatWorkDay } from "./format";

export type RowMode = "reviewer" | "decider" | "reader";

/** One row's figure from /priced (pricing.ts). Only `priced` carries an amount — never a zero for the rest. */
export type RowPrice = {
  amount: number | null;
  days: number | null;
  lineId: string;
  note: string | null;
  status: "priced" | "nothing" | "not_carried" | "exempt" | "not_priced";
};

/** The editors' own check of the cap, so the refusal reads the same before and after the save. */
function overCap(value: string, what: string): string | null {
  const typed = Number(value);
  return value.trim() !== "" && Number.isFinite(typed) && typed > MAX_DAYS ? maxDaysMessage(what) : null;
}

export type ReviewDraft = { action: "confirm" | "reject" | "recommend_edit" | null; reason: string; comment: string; recommendedDays: string };
export type DecisionDraft = { decision: "approved" | "rejected"; days: string };

type RowsProps = {
  lines: HrOpsLineView[];
  mode: RowMode;
  /** Her answers may change only while the report is with her. */
  reviewOpen: boolean;
  /** His decisions may be taken once she has submitted. */
  decisionOpen: boolean;
  prices: Map<string, RowPrice> | null;
  busy: boolean;
  onReview: (lineId: string, draft: ReviewDraft) => Promise<void>;
  onDecide: (lineId: string, draft: DecisionDraft) => Promise<void>;
};

function FlagList({ line }: { line: HrOpsLineView }) {
  if (line.flags.length === 0) return <span className="text-xs font-semibold text-emerald-700">Nothing flagged</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {line.flags.map((flag) => (
        <span key={flag.code} className="border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-phx-xs font-black uppercase tracking-wide text-rose-700">
          {flag.label}
        </span>
      ))}
    </span>
  );
}

function Facts({ line }: { line: HrOpsLineView }) {
  const metrics = line.metrics;
  if (metrics.kind === "office") {
    const minutes = [
      metrics.lateMinutes ? `${metrics.lateMinutes} min late` : null,
      metrics.earlyLeaveMinutes ? `left ${metrics.earlyLeaveMinutes} min early` : null,
    ].filter(Boolean);
    return (
      <div className="space-y-0.5 text-xs text-slate-700">
        <p className="font-bold text-slate-900">
          In {metrics.firstPunch ?? "—"} · Out {metrics.lastPunch ?? "—"}
          {metrics.workedTime ? ` · ${metrics.workedTime}` : ""}
        </p>
        {metrics.scheduledStart || metrics.scheduledEnd ? (
          <p>Shift {metrics.scheduledStart ?? "—"} to {metrics.scheduledEnd ?? "—"}</p>
        ) : null}
        <p>
          {metrics.status}
          {minutes.length ? ` · ${minutes.join(" · ")}` : ""}
        </p>
        {metrics.recommendedAction ? <p className="text-slate-500">Policy: {metrics.recommendedAction}</p> : null}
        {metrics.notes.map((note) => (
          <p key={note} className="text-slate-500">{note}</p>
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-0.5 text-xs text-slate-700">
      <p className="font-bold text-slate-900">
        AM {metrics.am} · PM {metrics.pm} · Pharmacies {metrics.pharmacies} · Total {metrics.total}
      </p>
      {metrics.ownVisits > 0 ? (
        <p>{metrics.ownVisits === metrics.total ? "All" : `${metrics.ownVisits} of these are`} their own {metrics.ownVisits === 1 ? "visit" : "visits"}</p>
      ) : null}
      <p>First visit {metrics.firstVisit ?? "—"} · Last visit {metrics.lastVisit ?? "—"}</p>
      <p>
        Month to date {metrics.monthToDate}
        {metrics.monthToDateFrom ? ` since ${formatWorkDay(metrics.monthToDateFrom)}` : ""}
      </p>
      {metrics.seenAs ? <p>Recorded as {metrics.seenAs}</p> : null}
      {metrics.notes.map((note) => (
        <p key={note} className="text-slate-500">{note}</p>
      ))}
    </div>
  );
}

function Person({ line }: { line: HrOpsLineView }) {
  const tier = line.metrics.kind === "field" ? line.metrics.tierLabel : null;
  return (
    <div className="space-y-0.5 text-xs text-slate-600">
      <p className="text-sm font-black text-slate-900">{line.employeeName}</p>
      <p>{[tier, line.jobTitle].filter(Boolean).join(" · ") || "—"}</p>
      {line.lineName || line.areaName ? <p>{[line.lineName, line.areaName].filter(Boolean).join(" · ")}</p> : null}
      {line.managerName ? <p className="text-slate-500">Reports to {line.managerName}</p> : null}
    </div>
  );
}

function AnswerSummary({ line, mode, price }: { line: HrOpsLineView; mode: RowMode; price: RowPrice | null }) {
  return (
    <div className="space-y-1 text-xs text-slate-700">
      {line.carried ? <p className="font-semibold text-slate-500">{line.carriedLabel ?? "Decided in another report"}</p> : null}
      {line.notCarried && line.decision?.decision !== "rejected" && line.notCarriedNote ? (
        <p className="text-slate-500">{line.notCarriedNote}</p>
      ) : null}
      {line.review ? (
        <p>
          <span className="font-black text-slate-900">HR: {line.review.actionLabel}</span>
          {line.review.action === "recommend_edit" ? ` · ${formatDays(line.review.recommendedDays)}` : ""}
          {line.review.reason ? <span className="block text-slate-500">{line.review.reason}</span> : null}
          {line.review.comment ? <span className="block text-slate-500">{line.review.comment}</span> : null}
        </p>
      ) : line.needsReview ? (
        <p className="font-semibold text-amber-700">Waiting for HR&apos;s answer</p>
      ) : null}
      {line.decision ? (
        <p>
          <span className={cn("font-black", line.decision.decision === "approved" ? "text-slate-900" : "text-slate-500")}>
            {line.decision.label}
            {line.decision.decision === "approved" ? ` · ${formatDays(line.decision.days)}` : ""}
          </span>
          <span className="block text-slate-500">{line.bridge.label}</span>
          {line.bridge.message ? <span className="block text-rose-700">{line.bridge.message}</span> : null}
        </p>
      ) : null}
      {mode === "decider" && price?.status === "priced" && price.amount !== null ? (
        <p className="font-bold text-slate-900">{formatEgp(price.amount)} for {formatDays(price.days)}</p>
      ) : null}
      {mode === "decider" && price?.status === "not_carried" ? <p className="font-bold text-slate-500">Not carried</p> : null}
      {mode === "decider" && price?.status === "not_priced" ? <p className="font-bold text-rose-700">Not priced</p> : null}
      {/* The not-carried sentence is already drawn above from the row itself. */}
      {mode === "decider" && price?.note && price.status !== "not_carried" ? <p className="text-slate-500">{price.note}</p> : null}
    </div>
  );
}

function initialReview(line: HrOpsLineView): ReviewDraft {
  return {
    action: line.review?.action ?? null,
    comment: line.review?.comment ?? "",
    reason: line.review?.reason ?? "",
    recommendedDays: line.review?.recommendedDays !== null && line.review?.recommendedDays !== undefined ? String(line.review.recommendedDays) : line.suggestedDays !== null ? String(line.suggestedDays) : "",
  };
}

function initialDecision(line: HrOpsLineView): DecisionDraft {
  if (line.decision) {
    return { days: line.decision.days !== null ? String(line.decision.days) : "0", decision: line.decision.decision };
  }
  return { days: line.defaultDecisionDays !== null ? String(line.defaultDecisionDays) : "0", decision: "approved" };
}

const REVIEW_CHOICES: Array<{ value: NonNullable<ReviewDraft["action"]>; label: string }> = [
  { label: "Confirm", value: "confirm" },
  { label: "Reject", value: "reject" },
  { label: "Recommend an edit", value: "recommend_edit" },
];

function ReviewEditor({ line, busy, onSave, onClose }: { line: HrOpsLineView; busy: boolean; onSave: (draft: ReviewDraft) => Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState<ReviewDraft>(() => initialReview(line));
  const [error, setError] = useState<string | null>(null);
  const save = async (next: ReviewDraft) => {
    setError(null);
    const capped = next.action === "recommend_edit" ? overCap(next.recommendedDays, "The recommended days") : null;
    if (capped) {
      setError(capped);
      return;
    }
    try {
      await onSave(next);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Your answer could not be saved.");
    }
  };
  return (
    <div className="space-y-3 border-l-4 border-orange-500 bg-white p-4">
      <p className="text-xs text-slate-600">
        The policy suggests <span className="font-black text-slate-900">{formatDays(line.suggestedDays)}</span> for this day. You recommend; the HR Manager decides.
      </p>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Your answer">
        {REVIEW_CHOICES.map((choice) => (
          <button
            key={choice.value}
            type="button"
            aria-pressed={draft.action === choice.value}
            className={cn(phxButtonGhostClassName, draft.action === choice.value && "border-orange-500 bg-orange-50 text-orange-800")}
            onClick={() => setDraft((current) => ({ ...current, action: choice.value }))}
          >
            {choice.label}
          </button>
        ))}
      </div>
      {draft.action === "recommend_edit" ? (
        <FormField label="Recommended days" required hint={`Days only — a half day is 0.5, and one day's row takes at most ${MAX_DAYS}.`}>
          <input
            className={phxFieldClassName}
            inputMode="decimal"
            max={MAX_DAYS}
            min={0}
            step={0.25}
            type="number"
            value={draft.recommendedDays}
            onChange={(event) => setDraft((current) => ({ ...current, recommendedDays: event.target.value }))}
          />
        </FormField>
      ) : null}
      {draft.action ? (
        <FormField label="Reason" required={draft.action !== "confirm"}>
          <textarea
            className={phxTextareaClassName}
            maxLength={500}
            rows={2}
            value={draft.reason}
            onChange={(event) => setDraft((current) => ({ ...current, reason: event.target.value }))}
          />
        </FormField>
      ) : null}
      {draft.action ? (
        <FormField label="Comment" hint="Optional — anything the HR Manager should know.">
          <textarea
            className={phxTextareaClassName}
            maxLength={1000}
            rows={2}
            value={draft.comment}
            onChange={(event) => setDraft((current) => ({ ...current, comment: event.target.value }))}
          />
        </FormField>
      ) : null}
      <FormError>{error}</FormError>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={phxButtonPrimaryClassName} disabled={busy || !draft.action} onClick={() => void save(draft)}>
          Save answer
        </button>
        {line.review ? (
          <button type="button" className={phxButtonGhostClassName} disabled={busy} onClick={() => void save({ action: null, comment: "", reason: "", recommendedDays: "" })}>
            Withdraw answer
          </button>
        ) : null}
        <button type="button" className={phxButtonGhostClassName} disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function DecisionEditor({ line, price, busy, onSave, onClose }: { line: HrOpsLineView; price: RowPrice | null; busy: boolean; onSave: (draft: DecisionDraft) => Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState<DecisionDraft>(() => initialDecision(line));
  const [error, setError] = useState<string | null>(null);
  const perDay = price && price.status === "priced" && price.amount !== null && price.days && price.days > 0 ? price.amount / price.days : null;
  const typed = Number(draft.days);
  const preview =
    perDay !== null && draft.decision === "approved" && Number.isFinite(typed) && typed <= MAX_DAYS ? Math.round(perDay * typed * 100) / 100 : null;
  const hint = line.notCarried
    ? "Saved for the record only: the weekly attendance review never lists this day, so nothing of it is carried to payroll."
    : preview !== null
      ? `${formatEgp(preview)} at this person's day rate.`
      : `Zero approves the row with no deduction. At most ${MAX_DAYS} days for one day's row.`;
  const save = async () => {
    setError(null);
    const capped = draft.decision === "approved" ? overCap(draft.days, "The approved days") : null;
    if (capped) {
      setError(capped);
      return;
    }
    try {
      await onSave(draft);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The decision could not be saved.");
    }
  };
  return (
    <div className="space-y-3 border-l-4 border-slate-900 bg-white p-4">
      <p className="text-xs text-slate-600">
        Policy: <span className="font-black text-slate-900">{formatDays(line.suggestedDays)}</span>
        {line.review ? (
          <>
            {" "}· HR: <span className="font-black text-slate-900">{line.review.actionLabel}</span>
            {line.review.action === "recommend_edit" ? ` ${formatDays(line.review.recommendedDays)}` : ""}
          </>
        ) : null}
      </p>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Your decision">
        {(["approved", "rejected"] as const).map((choice) => (
          <button
            key={choice}
            type="button"
            aria-pressed={draft.decision === choice}
            className={cn(phxButtonGhostClassName, draft.decision === choice && "border-orange-500 bg-orange-50 text-orange-800")}
            onClick={() => setDraft((current) => ({ ...current, decision: choice }))}
          >
            {choice === "approved" ? "Approve" : "Reject"}
          </button>
        ))}
      </div>
      {draft.decision === "approved" ? (
        <FormField label="Days that stand" required hint={hint}>
          <input
            className={phxFieldClassName}
            inputMode="decimal"
            max={MAX_DAYS}
            min={0}
            step={0.25}
            type="number"
            value={draft.days}
            onChange={(event) => setDraft((current) => ({ ...current, days: event.target.value }))}
          />
        </FormField>
      ) : null}
      <FormError>{error}</FormError>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={phxButtonAccentClassName} disabled={busy} onClick={() => void save()}>
          Save decision
        </button>
        <button type="button" className={phxButtonGhostClassName} disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function canReviewRow(line: HrOpsLineView, props: RowsProps): boolean {
  return props.mode === "reviewer" && props.reviewOpen && !line.carried;
}

function canDecideRow(line: HrOpsLineView, props: RowsProps): boolean {
  if (props.mode !== "decider" || !props.decisionOpen || !line.decidable) return false;
  // The server's own rule (rules.ts decisionIsOpen), carried on the row: once the weekly attendance
  // review holds the day, it is changed there.
  return !line.decision || !line.bridge.locked;
}

function RowAction({ line, props, open, onToggle }: { line: HrOpsLineView; props: RowsProps; open: boolean; onToggle: () => void }) {
  const review = canReviewRow(line, props);
  const decide = canDecideRow(line, props);
  if (!review && !decide) return null;
  const label = review ? (line.review ? "Change answer" : "Answer") : line.decision ? "Change decision" : "Decide";
  return (
    <button type="button" className={cn(phxButtonGhostClassName, "px-3 py-1.5 text-xs")} aria-expanded={open} onClick={onToggle}>
      {open ? "Close" : label}
    </button>
  );
}

function Editor({ line, props, onClose }: { line: HrOpsLineView; props: RowsProps; onClose: () => void }) {
  if (canReviewRow(line, props)) {
    return <ReviewEditor busy={props.busy} line={line} onClose={onClose} onSave={(draft) => props.onReview(line.id, draft)} />;
  }
  if (canDecideRow(line, props)) {
    return (
      <DecisionEditor
        busy={props.busy}
        line={line}
        price={props.prices?.get(line.id) ?? null}
        onClose={onClose}
        onSave={(draft) => props.onDecide(line.id, draft)}
      />
    );
  }
  return null;
}

export function ReportRows(props: RowsProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const toggle = (id: string) => setOpenId((current) => (current === id ? null : id));

  if (props.lines.length === 0) {
    return <p className="border border-slate-200 bg-white p-5 text-sm font-semibold text-slate-600">No row here.</p>;
  }

  return (
    <div className="@container">
      {/* Wide block: a table. */}
      <table className="hidden w-full table-fixed border-collapse border border-slate-200 bg-white text-left @min-[760px]:table">
        <colgroup>
          <col className="w-[22%]" />
          <col className="w-[30%]" />
          <col className="w-[15%]" />
          <col className="w-[10%]" />
          <col className="w-[23%]" />
        </colgroup>
        <thead className="bg-slate-50">
          <tr className="border-b border-slate-200 text-phx-xs font-black uppercase tracking-wide text-slate-500">
            <th className="px-3 py-2">Person</th>
            <th className="px-3 py-2">The day</th>
            <th className="px-3 py-2">Issue</th>
            <th className="px-3 py-2">Policy</th>
            <th className="px-3 py-2">Answer</th>
          </tr>
        </thead>
        <tbody>
          {props.lines.map((line) => (
            <RowPair key={line.id} line={line} open={openId === line.id} props={props} onToggle={() => toggle(line.id)} onClose={() => setOpenId(null)} />
          ))}
        </tbody>
      </table>

      {/* Narrow block: cards. */}
      <ul className="space-y-3 @min-[760px]:hidden">
        {props.lines.map((line) => (
          <li key={line.id} className={cn("space-y-3 border bg-white p-4", line.needsReview || line.decidable ? "border-slate-300" : "border-slate-200")}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <Person line={line} />
              <span className="text-xs font-bold text-slate-500">{formatWorkDay(line.workDate)}</span>
            </div>
            <Facts line={line} />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <FlagList line={line} />
              <span className="text-xs text-slate-600">Policy {formatDays(line.suggestedDays)}</span>
            </div>
            <AnswerSummary line={line} mode={props.mode} price={props.prices?.get(line.id) ?? null} />
            <RowAction line={line} open={openId === line.id} props={props} onToggle={() => toggle(line.id)} />
            {openId === line.id ? <Editor line={line} props={props} onClose={() => setOpenId(null)} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RowPair({ line, open, props, onToggle, onClose }: { line: HrOpsLineView; open: boolean; props: RowsProps; onToggle: () => void; onClose: () => void }) {
  return (
    <>
      <tr className={cn("border-b border-slate-100 align-top [overflow-wrap:anywhere]", (line.needsReview && !line.review) || (props.mode === "decider" && line.decidable && !line.decision) ? "bg-amber-50/40" : "")}>
        <td className="px-3 py-3">
          <Person line={line} />
        </td>
        <td className="px-3 py-3">
          <p className="mb-1 text-xs font-bold text-slate-500">{formatWorkDay(line.workDate)}</p>
          <Facts line={line} />
        </td>
        <td className="px-3 py-3">
          <FlagList line={line} />
        </td>
        <td className="px-3 py-3 text-xs font-bold text-slate-900">{formatDays(line.suggestedDays)}</td>
        <td className="space-y-2 px-3 py-3">
          <AnswerSummary line={line} mode={props.mode} price={props.prices?.get(line.id) ?? null} />
          <RowAction line={line} open={open} props={props} onToggle={onToggle} />
          {line.review?.reviewedAt ? <p className="text-phx-xs text-slate-400">Answered {formatStamp(line.review.reviewedAt)}</p> : null}
        </td>
      </tr>
      {open ? (
        <tr className="border-b border-slate-200 bg-slate-50">
          <td className="px-3 py-3" colSpan={5}>
            <Editor line={line} props={props} onClose={onClose} />
          </td>
        </tr>
      ) : null}
    </>
  );
}
