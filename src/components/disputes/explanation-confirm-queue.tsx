"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, X } from "lucide-react";

import {
  phxButtonApproveClassName,
  phxButtonDangerClassName,
  phxButtonGhostClassName,
  phxFieldMessageClassName,
  phxLabelClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { FormBlockHeader } from "@/components/ui/form-kit";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import {
  explainDatesPhrase,
  explainReason,
  explainReasonPhrase,
  type ExplainCaseKind,
  type ExplainReasonCode,
} from "@/lib/dispute-center/explain-reasons";

// WAITING FOR YOUR CONFIRMATION (owner, 2026-11-16: "manager first then me"). An employee who explains
// a day names their manager, the manager above, or the Training Manager to confirm it; that person
// sees it here, at the top of their own Disputes page, and answers once for the whole group of days.
// The Super Admin decides afterwards — a confirmation is information, never the decision. Renders
// nothing for anybody nobody named.

export type ExplanationGroup = {
  caseKind: ExplainCaseKind;
  createdAt: string;
  dates: string[];
  detailText: string;
  employeeHrId: string;
  employeeName: string | null;
  groupId: string;
  reasonCode: ExplainReasonCode;
};

const CASE_WORDS: Record<ExplainCaseKind, string> = {
  calendar: "Calendar",
  daily: "Daily deduction",
  deduction: "Monthly deduction",
};

/** One group of days, and the one answer it needs. Exported for the screen's own preview. */
export function ConfirmCard({ group, onAnswered }: { group: ExplanationGroup; onAnswered: () => void }) {
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"confirmed" | "declined" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const reason = explainReason(group.reasonCode).label;
  const dayCount = new Set(group.dates).size;
  const noteId = `confirm-note-${group.groupId}`;

  async function answer(value: "confirmed" | "declined") {
    setMessage(null);
    if (value === "declined" && !note.trim()) {
      setMessage("Say in a few words what was not as described.");
      return;
    }
    setBusy(value);
    try {
      const response = await fetch(`/api/dispute-center/explanations/${encodeURIComponent(group.groupId)}/answer`, {
        body: JSON.stringify({ answer: value, note }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.message || "Unable to save your answer.");
      onAnswered();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to save your answer.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="grid gap-4 px-4 py-4 sm:px-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
      <div className="min-w-0">
        <p className="text-phx-xs font-black uppercase tracking-wide text-slate-400">
          <span className="text-orange-600">{reason}</span> · {CASE_WORDS[group.caseKind]} · sent {cairoDateTime(group.createdAt)}
        </p>
        <p className="mt-1 break-words text-base font-bold leading-snug text-slate-900">
          {group.employeeName ?? "An employee"} says they were {explainReasonPhrase(group.reasonCode)} on{" "}
          <span className="whitespace-nowrap">{explainDatesPhrase(group.dates)}</span>
          {dayCount > 1 ? <span className="font-semibold text-slate-500"> · {dayCount} days</span> : null}
        </p>
        {group.detailText ? (
          <p className="mt-2 whitespace-pre-wrap break-words border-l-2 border-slate-200 pl-3 text-sm text-slate-600">{group.detailText}</p>
        ) : null}
        {declining ? (
          <div className="mt-3">
            <label className={phxLabelClassName} htmlFor={noteId}>
              What was not as described
            </label>
            <textarea
              autoFocus
              className={phxTextareaClassName}
              id={noteId}
              onChange={(event) => setNote(event.target.value)}
              placeholder="For example: there was no meeting that day"
              rows={2}
              value={note}
            />
          </div>
        ) : null}
        {message ? <p className={phxFieldMessageClassName}>{message}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 md:justify-end">
        {declining ? (
          <>
            <button className={phxButtonGhostClassName} disabled={busy !== null} onClick={() => { setDeclining(false); setMessage(null); }} type="button">
              Back
            </button>
            <button className={phxButtonDangerClassName} disabled={busy !== null} onClick={() => answer("declined")} type="button">
              {busy === "declined" ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <X aria-hidden className="h-3.5 w-3.5" />}
              Send: not confirmed
            </button>
          </>
        ) : (
          <>
            <button className={phxButtonGhostClassName} disabled={busy !== null} onClick={() => setDeclining(true)} type="button">
              Not as described
            </button>
            <button className={phxButtonApproveClassName} disabled={busy !== null} onClick={() => answer("confirmed")} type="button">
              {busy === "confirmed" ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <Check aria-hidden className="h-3.5 w-3.5" />}
              Confirm
            </button>
          </>
        )}
      </div>
    </li>
  );
}

/** The panel itself, given the groups — split from the loader so the look can be previewed. */
export function ExplanationConfirmPanel({ groups, onAnswered }: { groups: ExplanationGroup[]; onAnswered: () => void }) {
  return (
    <section className="mb-4 border border-slate-200 bg-white" id="confirm">
      <FormBlockHeader
        action={<span className="text-xs font-black tabular-nums text-slate-500">{groups.length}</span>}
        label="Waiting for your confirmation"
      />
      <p className="border-b border-slate-100 px-4 py-2.5 text-sm text-slate-600 sm:px-5">
        These people named you to confirm why a day has no record. You confirm what you know; the Super Admin decides.
      </p>
      <ol className="divide-y divide-slate-100">
        {groups.map((group) => (
          <ConfirmCard group={group} key={group.groupId} onAnswered={onAnswered} />
        ))}
      </ol>
    </section>
  );
}

export function ExplanationConfirmQueue() {
  const [groups, setGroups] = useState<ExplanationGroup[] | null>(null);
  const [failed, setFailed] = useState(false);

  // A request number, bumped after each answer; the effect re-reads the list when it changes. The
  // state is set only in the fetch's own callbacks, never in the effect body.
  const [reload, setReload] = useState(0);
  const load = useCallback(() => setReload((current) => current + 1), []);

  useEffect(() => {
    let live = true;
    fetch("/api/dispute-center/explanations", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok || !payload.success) throw new Error(payload.message || "Unable to load.");
        if (!live) return;
        setGroups(Array.isArray(payload.data) ? payload.data : []);
        setFailed(false);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [reload]);

  if (failed) {
    return (
      <p className="mb-4 border border-amber-200 bg-amber-50 px-4 py-2 text-xs font-bold text-amber-800" id="confirm">
        What is waiting for your confirmation could not be loaded. Refresh the page to try again.
      </p>
    );
  }
  if (!groups || groups.length === 0) return null;
  return <ExplanationConfirmPanel groups={groups} onAnswered={load} />;
}
