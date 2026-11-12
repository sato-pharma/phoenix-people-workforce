"use client";

import { useState } from "react";

import { adminSoftPanelClassName } from "@/components/admin/admin-design-tokens";
import {
  phxButtonApproveClassName,
  phxButtonDangerClassName,
  phxButtonGhostClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import type { BulkDecisionModule, BulkDecisionResult, BulkDecisionVerb } from "@/lib/approvals-hub/bulk-decide";
import { cn } from "@/lib/utils";

type SelectedCard = { id: string; employeeName: string; title: string };

type Outcome = { decision: BulkDecisionVerb; decided: number; failures: Array<{ id: string; name: string; message: string }> };

type Props = {
  module: BulkDecisionModule;
  selected: SelectedCard[];
  onClear: () => void;
  // Called with the requests that WERE decided — only those are un-ticked, so a failed one stays
  // selected and one more click retries exactly it.
  onFinished: (decidedIds: string[]) => void;
};

function plural(count: number) {
  return `${count} request${count === 1 ? "" : "s"}`;
}

/**
 * Approve all / Reject all for the ticked requests in the approvals inbox. It asks before it writes,
 * a rejection needs one written reason (the employees read it), and the answer names every request
 * that could not be decided and why. The server decides each one exactly as its own page would
 * (src/lib/approvals-hub/bulk-decide.ts).
 */
export function BulkDecisionBar({ module, selected, onClear, onFinished }: Props) {
  const [mode, setMode] = useState<BulkDecisionVerb | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const count = selected.length;

  async function submit(decision: BulkDecisionVerb) {
    if (decision === "reject" && !reason.trim()) {
      setError("Write the reason for rejecting — the employees read it.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/approvals/bulk-decision", {
        body: JSON.stringify({
          comment: decision === "reject" ? reason.trim() : null,
          decision,
          ids: selected.map((card) => card.id),
          module,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        message?: string;
        results?: BulkDecisionResult[];
        success?: boolean;
      };
      if (!response.ok || !payload.success || !Array.isArray(payload.results)) {
        throw new Error(payload.message || "The bulk decision failed. Nothing was decided.");
      }
      const names = new Map(selected.map((card) => [card.id, card.employeeName]));
      const decidedIds = payload.results.filter((row) => row.ok).map((row) => row.id);
      setOutcome({
        decided: decidedIds.length,
        decision,
        failures: payload.results
          .filter((row) => !row.ok)
          .map((row) => ({ id: row.id, message: row.message ?? "Could not be decided.", name: names.get(row.id) ?? "A request" })),
      });
      setMode(null);
      setReason("");
      onFinished(decidedIds);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The bulk decision failed. Nothing was decided.");
    } finally {
      setBusy(false);
    }
  }

  // The bar is ALWAYS on screen while there is something to tick, never only once a box is ticked:
  // appearing above the list pushed every row down, so a quick second click (or tap) landed on the
  // wrong request. With nothing ticked it keeps the same row, height and buttons, disabled.

  return (
    <div className={`sticky top-0 z-10 space-y-3 ${adminSoftPanelClassName} px-4 py-3`} role="region" aria-label="Decide the ticked requests">
      {outcome ? (
        <div role="status" className="space-y-1">
          <p className="text-sm font-bold text-slate-900">
            {outcome.decided > 0
              ? `${plural(outcome.decided)} ${outcome.decision === "approve" ? "approved" : "rejected"}.`
              : `No request was ${outcome.decision === "approve" ? "approved" : "rejected"}.`}
            {outcome.failures.length > 0 ? ` ${plural(outcome.failures.length)} could not be — still ticked below:` : ""}
          </p>
          {outcome.failures.length > 0 ? (
            <ul className="space-y-0.5">
              {outcome.failures.map((failure) => (
                <li key={failure.id} className="break-words text-xs font-semibold text-rose-700">
                  {failure.name} — {failure.message}
                </li>
              ))}
            </ul>
          ) : null}
          {count === 0 ? (
            <button type="button" className="text-phx-xs font-bold text-slate-500 hover:text-slate-700" onClick={() => setOutcome(null)}>
              Dismiss
            </button>
          ) : null}
        </div>
      ) : null}

      {mode === null || count === 0 ? (
        <div className="flex flex-wrap items-center gap-2" data-bulk-bar-idle={count === 0 ? "" : undefined}>
          <p className={cn("mr-auto text-sm font-bold", count === 0 ? "text-slate-500" : "text-slate-900")}>
            {count === 0 ? "No request ticked" : `${plural(count)} ticked`}
          </p>
          <button type="button" className={phxButtonApproveClassName} disabled={busy || count === 0} onClick={() => { setError(null); setMode("approve"); }}>
            Approve{count > 0 ? ` ${count}` : ""}
          </button>
          <button type="button" className={phxButtonDangerClassName} disabled={busy || count === 0} onClick={() => { setError(null); setMode("reject"); }}>
            Reject{count > 0 ? ` ${count}` : ""}
          </button>
          <button type="button" className={phxButtonGhostClassName} disabled={busy || count === 0} onClick={onClear}>
            Clear
          </button>
        </div>
      ) : null}

      {count > 0 && mode !== null ? (
        <div className="space-y-3">
          <p className="text-sm font-bold text-slate-900">
            {mode === "approve" ? `Approve these ${plural(count)}?` : `Reject these ${plural(count)}?`}
          </p>
          <p className="text-xs text-slate-600">
            Each one is checked exactly as if you opened it and pressed {mode === "approve" ? "Approve" : "Reject"}. One that
            is not yours to decide is left as it is, and named here.
          </p>
          {mode === "reject" ? (
            <label className="block space-y-1">
              <span className="text-phx-2xs font-bold uppercase tracking-wide text-slate-500">Reason (every employee reads it)</span>
              <textarea
                className={cn(phxTextareaClassName, "text-base md:text-sm")}
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
          ) : null}
          {error ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={mode === "approve" ? phxButtonApproveClassName : phxButtonDangerClassName}
              disabled={busy}
              onClick={() => void submit(mode)}
            >
              {busy ? "Deciding…" : mode === "approve" ? `Confirm — approve ${count}` : `Confirm — reject ${count}`}
            </button>
            <button type="button" className={phxButtonGhostClassName} disabled={busy} onClick={() => { setMode(null); setError(null); }}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {error && mode === null ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}
    </div>
  );
}
