"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";

import { phxButtonGhostClassName, phxButtonPrimaryClassName, phxTextareaClassName } from "@/components/ui/form-tokens";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { explainReason, type ExplainCaseKind, type ExplainReasonCode } from "@/lib/dispute-center/explain-reasons";

// WAITING FOR YOUR CONFIRMATION (owner, 2026-11-16: "manager first then me"). An employee who explains
// a day names his manager, the manager above, or the Training Manager to confirm it; that person sees
// it here, at the top of his own Disputes page, and answers once for the whole group of days. The
// Super Admin decides afterwards — a confirmation is information, never the decision. Renders nothing
// for anybody nobody named.

type ExplanationGroup = {
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
  calendar: "Calendar day",
  daily: "Daily deduction",
  deduction: "Deduction",
};

function datesLine(dates: string[]): string {
  if (dates.length <= 3) return dates.join(", ");
  return `${dates[0]} to ${dates[dates.length - 1]} (${dates.length} days)`;
}

function ConfirmCard({ group, onAnswered }: { group: ExplanationGroup; onAnswered: () => void }) {
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function answer(value: "confirmed" | "declined") {
    setMessage(null);
    if (value === "declined" && !note.trim()) {
      setMessage("Say in a few words what was not as described.");
      return;
    }
    setBusy(true);
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
      setBusy(false);
    }
  }

  return (
    <li className="px-4 py-3">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-sm font-black text-slate-900">{group.employeeName ?? "Employee"}</span>
        <span className="text-phx-xs font-black uppercase tracking-wide text-slate-400">{CASE_WORDS[group.caseKind]}</span>
        <span className="text-xs text-slate-400">{cairoDateTime(group.createdAt)}</span>
      </p>
      <p className="mt-1 break-words text-sm font-bold text-slate-800">
        {explainReason(group.reasonCode).label} on {datesLine(group.dates)}
      </p>
      {group.detailText ? <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-slate-600">{group.detailText}</p> : null}
      {declining ? (
        <textarea
          className={`${phxTextareaClassName} mt-2`}
          onChange={(event) => setNote(event.target.value)}
          placeholder="What was not as described"
          rows={2}
          value={note}
        />
      ) : null}
      {message ? <p className="mt-1 text-xs font-bold text-red-700">{message}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {declining ? (
          <>
            <button className={phxButtonPrimaryClassName} disabled={busy} onClick={() => answer("declined")} type="button">
              {busy ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <XCircle aria-hidden className="h-3.5 w-3.5" />}
              Send: not confirmed
            </button>
            <button className={phxButtonGhostClassName} disabled={busy} onClick={() => { setDeclining(false); setMessage(null); }} type="button">
              Back
            </button>
          </>
        ) : (
          <>
            <button className={phxButtonPrimaryClassName} disabled={busy} onClick={() => answer("confirmed")} type="button">
              {busy ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 aria-hidden className="h-3.5 w-3.5" />}
              Confirm
            </button>
            <button className={phxButtonGhostClassName} disabled={busy} onClick={() => setDeclining(true)} type="button">
              Not as described
            </button>
          </>
        )}
      </div>
    </li>
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

  return (
    <section className="mb-4 border border-slate-200 bg-white" id="confirm">
      <h2 className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-phx-xs font-black uppercase tracking-wide text-slate-600">
        Waiting for your confirmation · {groups.length}
      </h2>
      <p className="border-b border-slate-100 px-4 py-2 text-xs text-slate-600">
        These people named you to confirm why a day has no record. Your answer goes to the Super Admin, who decides.
      </p>
      <ol className="divide-y divide-slate-100">
        {groups.map((group) => (
          <ConfirmCard group={group} key={group.groupId} onAnswered={() => void load()} />
        ))}
      </ol>
    </section>
  );
}
