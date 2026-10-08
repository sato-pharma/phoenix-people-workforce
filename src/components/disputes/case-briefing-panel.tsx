"use client";

import { useState } from "react";
import { FileSearch, HelpCircle } from "lucide-react";

import {
  phxButtonGhostClassName,
  phxButtonPrimaryClassName,
  phxFieldClassName,
  phxLabelTextClassName,
} from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";
import { cairoDateTime } from "@/lib/format/cairo-datetime";
import type { AssistAnswer } from "@/lib/dispute-center/assist.ts";
import type { DisputeCase } from "@/lib/dispute-center/types.ts";

// THE CASE BRIEFING — what the records say about one dispute, in statements that each name the
// records they rest on, and a box to ask a further question about the same case. Super Admin only.
//
// Every statement is shown WITH the records it cites, because that is the only honest way to read
// one: a statement whose numbers were not in its records has already been dropped before this
// renders, and the count of those is shown too rather than hidden.

function Statements({ answer }: { answer: AssistAnswer }) {
  return (
    <div className="space-y-3">
      {answer.question ? (
        <p className="text-sm font-bold text-slate-900">
          {answer.question}
          <span className="ml-2 text-xs font-bold text-slate-400">{cairoDateTime(answer.createdAt)}</span>
        </p>
      ) : null}
      {answer.stale ? (
        <p className="border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">
          The case has changed since this was written. Read it again for the current record.
        </p>
      ) : null}
      {answer.statements.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing could be stated from the records on file.</p>
      ) : (
        <ol className="space-y-3">
          {answer.statements.map((statement, index) => (
            <li className="border-l-2 border-l-slate-300 pl-3" key={`${answer.id ?? "live"}-${index}`}>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-800">{statement.text}</p>
              <ul className="mt-1.5 space-y-0.5">
                {statement.cited.map((fact) => (
                  <li className="break-words text-xs text-slate-500" key={`${fact.id}-${fact.label}`}>
                    <span className="font-bold text-slate-600">{fact.label}:</span> {fact.value}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
      {answer.dropped.length > 0 ? (
        <details className="border border-slate-200 bg-slate-50 px-3 py-2">
          <summary className="cursor-pointer text-xs font-black uppercase tracking-wide text-slate-500">
            {answer.dropped.length} statement{answer.dropped.length === 1 ? "" : "s"} left out — the records did not support them
          </summary>
          <ul className="mt-2 space-y-1.5">
            {answer.dropped.map((dropped, index) => (
              <li className="break-words text-xs text-slate-500" key={`${index}-${dropped.reason}`}>
                “{dropped.text}” — left out because {dropped.reason}.
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export function CaseBriefingPanel({ dispute }: { dispute: DisputeCase }) {
  const [entries, setEntries] = useState<AssistAnswer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState<"briefing" | "question" | "history" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const base = `/api/dispute-center/cases/${dispute.kind}/${encodeURIComponent(dispute.ref)}/assist`;

  async function loadHistory() {
    setBusy("history");
    setError(null);
    try {
      const response = await fetch(base);
      const payload = (await response.json().catch(() => ({}))) as { entries?: AssistAnswer[]; message?: string; success?: boolean };
      if (!response.ok || payload.success !== true) throw new Error(payload.message || "Could not read what was written before.");
      setEntries(payload.entries ?? []);
      setLoaded(true);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not read what was written before.");
    } finally {
      setBusy(null);
    }
  }

  async function run(kind: "briefing" | "question") {
    setBusy(kind);
    setError(null);
    try {
      const response = await fetch(base, {
        body: JSON.stringify(kind === "question" ? { question } : {}),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as { answer?: AssistAnswer; message?: string; success?: boolean };
      if (!response.ok || payload.success !== true || !payload.answer) {
        throw new Error(payload.message || "The case could not be read right now.");
      }
      setEntries((current) => [payload.answer as AssistAnswer, ...current]);
      setLoaded(true);
      if (kind === "question") setQuestion("");
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "The case could not be read right now.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="border border-slate-200 bg-white">
      <h3 className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-phx-xs font-black uppercase tracking-wide text-slate-600">
        Case briefing
      </h3>
      <div className="space-y-4 p-4">
        <p className="text-xs leading-relaxed text-slate-500">
          Reads this case&apos;s own records — the day&apos;s calendar, the figures, the whole conversation — and states what they
          show, each statement with the records it rests on. Anything the records do not support is left out.
        </p>
        <div className="flex flex-wrap gap-2">
          <button className={phxButtonPrimaryClassName} disabled={busy !== null} onClick={() => run("briefing")} type="button">
            <FileSearch aria-hidden className="h-4 w-4" />
            {busy === "briefing" ? "Reading the case…" : "Brief me on this case"}
          </button>
          {loaded ? null : (
            <button className={phxButtonGhostClassName} disabled={busy !== null} onClick={loadHistory} type="button">
              {busy === "history" ? "Opening…" : "Show what was written before"}
            </button>
          )}
        </div>

        <div className="space-y-2">
          <label className={phxLabelTextClassName} htmlFor={`ask-${dispute.ref}`}>
            Ask about this case
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              className={cn(phxFieldClassName, "min-w-0 flex-1")}
              disabled={busy !== null}
              id={`ask-${dispute.ref}`}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && question.trim() && busy === null) void run("question");
              }}
              placeholder="Where was the first punch?"
              value={question}
            />
            <button className={phxButtonGhostClassName} disabled={busy !== null || !question.trim()} onClick={() => run("question")} type="button">
              <HelpCircle aria-hidden className="h-4 w-4" />
              {busy === "question" ? "Reading…" : "Ask"}
            </button>
          </div>
        </div>

        {error ? <p className="text-xs font-bold text-rose-700">{error}</p> : null}

        {entries.length > 0 ? (
          <div className="space-y-5 border-t border-slate-200 pt-4">
            {entries.map((entry, index) => (
              <Statements answer={entry} key={entry.id ?? `live-${index}`} />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
