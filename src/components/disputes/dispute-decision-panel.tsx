"use client";

import { useState } from "react";
import { Check, RotateCcw, X } from "lucide-react";

import {
  phxButtonApproveClassName,
  phxButtonDangerClassName,
  phxButtonGhostClassName,
  phxFieldClassName,
  phxLabelClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import type { DisputeCase } from "@/lib/dispute-center/types.ts";

// THE DECISION, and the reopen — the reviewer's half of a case.
//
// The words differ per module because the things differ: a calendar claim is accepted or rejected, a
// weekly-review day is upheld or rejected, and a DEDUCTION has a third outcome the owner named
// himself (2026-10-09) — REDUCE, where he types fewer days than were charged.
//
// 🔴 It never says what the money will be. The figure a decision charges is re-derived server-side
// from the deduction the database holds, and the sentence that comes back after the decision is what
// is shown — this panel does not do payroll arithmetic in a browser.

type Outcome = { danger?: boolean; label: string; value: string };

function outcomesFor(dispute: DisputeCase): Outcome[] {
  if (dispute.kind === "calendar") {
    return [
      { label: "Accept — show the correction", value: "accept" },
      { danger: true, label: "Reject — the calendar stands", value: "reject" },
    ];
  }
  if (dispute.kind === "digest") {
    return [
      { label: "Uphold — do not deduct the day", value: "uphold" },
      { danger: true, label: "Reject — the deduction stands", value: "reject" },
    ];
  }
  return [
    { label: "Accept — cancel the deduction", value: "accept" },
    { label: "Reduce — charge less", value: "reduce" },
    { danger: true, label: "Reject — it stands", value: "reject" },
  ];
}

export function DisputeDecisionPanel({ dispute, onDone }: { dispute: DisputeCase; onDone: () => void | Promise<void> }) {
  const reopenRequested = dispute.state === "reopen_requested";
  const [note, setNote] = useState("");
  const [reducedValue, setReducedValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string[] | null>(null);

  const base = `/api/dispute-center/cases/${dispute.kind}/${encodeURIComponent(dispute.ref)}`;
  const unit = dispute.deduction?.unit ?? "days";

  async function post(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${base}${path}`, {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        message?: string;
        result?: { notices?: string[]; moneySentence?: string | null; refundSentence?: string | null };
        success?: boolean;
      };
      if (!response.ok || payload.success !== true) throw new Error(payload.message || "That did not save.");
      const lines = [payload.result?.moneySentence, payload.result?.refundSentence, ...(payload.result?.notices ?? [])].filter(
        (line): line is string => Boolean(line && line.trim()),
      );
      setResult(lines.length > 0 ? lines : null);
      setNote("");
      setReducedValue("");
      await onDone();
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : "That did not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border border-slate-200 bg-white">
      <h3 className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-phx-xs font-black uppercase tracking-wide text-slate-600">
        {dispute.state === "decided" || reopenRequested ? "Decided" : "Your decision"}
      </h3>
      <div className="space-y-4 p-4">
        {dispute.decision ? (
          <div className="border border-slate-200 bg-slate-50 px-3 py-2">
            <p className="text-sm font-bold text-slate-900">{dispute.decision.label}</p>
            {dispute.decision.note ? <p className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-600">{dispute.decision.note}</p> : null}
          </div>
        ) : null}

        {reopenRequested ? (
          <div className="space-y-3 border border-amber-200 bg-amber-50 p-3">
            <p className="text-sm font-bold text-amber-900">
              {dispute.employeeName} asked for this to be looked at again.
            </p>
            <textarea
              className={phxTextareaClassName}
              disabled={busy}
              onChange={(event) => setNote(event.target.value)}
              placeholder="What are you telling them? (optional — they read this)"
              rows={3}
              value={note}
            />
            <div className="flex flex-wrap gap-2">
              <button
                className={phxButtonApproveClassName}
                disabled={busy}
                onClick={() => post("/reopen", { action: "grant", note })}
                type="button"
              >
                <RotateCcw aria-hidden className="h-4 w-4" />
                Reopen it
              </button>
              <button
                className={phxButtonDangerClassName}
                disabled={busy}
                onClick={() => post("/reopen", { action: "decline", note })}
                type="button"
              >
                <X aria-hidden className="h-4 w-4" />
                The decision stands
              </button>
            </div>
          </div>
        ) : null}

        {/* A DECIDED CASE IS DECIDED AGAIN ONLY AFTER A REOPEN — including one whose reopen has been
            ASKED FOR and not yet granted. The decision form used to show beside that request, so a
            second decision could be taken without ever answering it; every module now refuses that
            server-side (deduction.ts, digest.ts), and a form that posts into a refusal is worse than
            no form. Answer the request above, then decide. */}
        {dispute.state === "decided" || reopenRequested ? (
          <p className="text-xs text-slate-500">
            {reopenRequested
              ? "Answer the request above first. Reopening it brings the decision buttons back."
              : "Nothing is waiting on you. The employee can ask for it to be looked at again, and you decide whether to reopen it."}
          </p>
        ) : (
          <div className="space-y-3">
            <div>
              <label className={phxLabelClassName} htmlFor={`note-${dispute.ref}`}>
                What you decided, and why (optional)
              </label>
              <textarea
                className={phxTextareaClassName}
                disabled={busy}
                id={`note-${dispute.ref}`}
                onChange={(event) => setNote(event.target.value)}
                placeholder="The employee reads this."
                rows={3}
                value={note}
              />
            </div>

            {dispute.kind === "deduction" ? (
              <div>
                <label className={phxLabelClassName} htmlFor={`reduced-${dispute.ref}`}>
                  {unit === "days" ? "If you are reducing it — days to charge" : "If you are reducing it — amount to charge (EGP)"}
                </label>
                <input
                  className={phxFieldClassName}
                  disabled={busy}
                  id={`reduced-${dispute.ref}`}
                  inputMode="decimal"
                  onChange={(event) => setReducedValue(event.target.value)}
                  placeholder={
                    dispute.deduction
                      ? `Less than ${dispute.deduction.chargedValue}${unit === "days" ? " day(s)" : " EGP"} charged now`
                      : undefined
                  }
                  value={reducedValue}
                />
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              {outcomesFor(dispute).map((outcome) => (
                <button
                  className={outcome.danger ? phxButtonDangerClassName : outcome.value === "reduce" ? phxButtonGhostClassName : phxButtonApproveClassName}
                  disabled={busy || (outcome.value === "reduce" && !reducedValue.trim())}
                  key={outcome.value}
                  onClick={() =>
                    post("/decide", {
                      note,
                      outcome: outcome.value,
                      ...(outcome.value === "reduce" ? { reducedValue: Number(reducedValue) } : {}),
                    })
                  }
                  type="button"
                >
                  {outcome.danger ? <X aria-hidden className="h-4 w-4" /> : <Check aria-hidden className="h-4 w-4" />}
                  {outcome.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {result ? (
          <ul className="space-y-1 border border-slate-200 bg-slate-50 px-3 py-2">
            {result.map((line) => (
              <li className="break-words text-xs text-slate-700" key={line}>
                {line}
              </li>
            ))}
          </ul>
        ) : null}
        {error ? <p className="text-xs font-bold text-rose-700">{error}</p> : null}
      </div>
    </section>
  );
}
