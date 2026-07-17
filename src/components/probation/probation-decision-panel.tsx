"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Final-decision panel (Phase 10). Rendered on the report only for authorized deciders
// (CEO / Super Admin / in-scope NSM). Records Pass or Terminate via the decision route. The system
// never decides — this is the human action. Requires an evidence acknowledgement, and an override
// reason when the case is not decision-ready.

type Props = {
  caseId: string;
  employeeName: string;
  decisionReady: boolean;
  alreadyDecided: boolean;
  decision?: string | null;
};

export function ProbationDecisionPanel({ caseId, employeeName, decisionReady, alreadyDecided, decision }: Props) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<"" | "pass" | "terminate">("");
  const [comment, setComment] = useState("");
  const [ack, setAck] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (alreadyDecided || done) {
    return (
      <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
        <h2 className="text-sm font-semibold text-emerald-800">Decision recorded</h2>
        <p className="mt-1 text-sm text-emerald-700">
          {employeeName}: <strong>{(decision ?? outcome) === "pass" ? "Continue / Pass" : "Do not continue / Terminate"}</strong>. This case is locked.
        </p>
      </section>
    );
  }

  async function submit() {
    if (!outcome || !comment.trim() || !ack) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/probation/cases/${caseId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome, comment, evidenceAcknowledged: ack, overrideReason: overrideReason || undefined }),
      });
      if (res.ok) {
        setDone(true);
        // Revalidate the server report so the sibling panels reflect the now-locked/decided case
        // (mirrors the other capture components).
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to record the decision.");
      }
    } finally {
      setBusy(false);
    }
  }

  const needsOverride = !decisionReady;

  return (
    <section className="rounded-lg border border-slate-300 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">Final decision</h2>
      <p className="mt-0.5 text-xs text-slate-500">
        Authorized human decision. The system does not decide. {needsOverride && "This case is not yet decision-ready."}
      </p>

      <div className="mt-3 flex gap-2">
        <button
          onClick={() => setOutcome("pass")}
          className={`rounded border px-3 py-1.5 text-sm ${outcome === "pass" ? "border-emerald-600 bg-emerald-50 text-emerald-700" : "border-slate-200 text-slate-600"}`}
        >
          Continue / Pass
        </button>
        <button
          onClick={() => setOutcome("terminate")}
          className={`rounded border px-3 py-1.5 text-sm ${outcome === "terminate" ? "border-rose-600 bg-rose-50 text-rose-700" : "border-slate-200 text-slate-600"}`}
        >
          Do not continue / Terminate
        </button>
      </div>

      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Decision comment (required)…"
        rows={3}
        className="mt-3 w-full rounded border border-slate-200 px-3 py-2 text-sm"
      />

      {needsOverride && (
        <textarea
          value={overrideReason}
          onChange={(e) => setOverrideReason(e.target.value)}
          placeholder="Override reason — required because the case is not decision-ready…"
          rows={2}
          className="mt-2 w-full rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm"
        />
      )}

      <label className="mt-3 flex items-start gap-2 text-xs text-slate-600">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
        I have reviewed the consolidated evidence for {employeeName} and acknowledge it is complete enough for this decision.
      </label>

      {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}

      <button
        disabled={busy || !outcome || comment.trim().length < 3 || !ack || (needsOverride && overrideReason.trim().length < 3)}
        onClick={submit}
        className="mt-3 rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? "Recording…" : "Record decision"}
      </button>
      {outcome === "terminate" && (
        <p className="mt-2 text-[11px] text-rose-500">Terminate opens the resignation/vacancy flow. This runs once and cannot be undone here.</p>
      )}
    </section>
  );
}
