"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { phxTextareaClassName } from "@/components/ui/form-tokens";

/**
 * Put a refused marketing request back on the desk of the approver who refused it.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * `rejected` was terminal in the product. Reversing one meant a session writing SQL against
 * production — which is what happened on 2026-09-06 for two requests the CEO had refused three days
 * earlier, and is the reason the owner asked for a button. A capability reachable only through the
 * database is indistinguishable from one that does not exist, which is the same lesson the finance
 * hold control's header records.
 *
 * ── WHY THE REASON IS REQUIRED ───────────────────────────────────────────────
 * This undoes a decision a person actually made and then asks them to make it again. Without a
 * recorded why, the timeline shows a refusal, then the same rung open again, and nothing at all
 * explaining what changed — leaving the next reader (often the owner, weeks later) to guess whether
 * it was a correction, a negotiation, or a mistake. Required in three places on purpose: here, in
 * the service, and in the RPC, so no caller can route around it.
 *
 * The control is drawn only when `viewer.can.reopen` is true (Super Admin, request refused). That
 * is an affordance — the route and the service both re-run the gate before anything is written.
 */
export function MarketingReopenControl({
  /** The rung the request will land back on, so the button never asks for an unnamed action. */
  stepName,
  requestId,
}: {
  requestId: string;
  stepName: string | null;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const trimmed = reason.trim();
    if (!trimmed) {
      setError("Write the reason first — it is the only record of why this refusal was undone.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/marketing-requests/${requestId}/reopen`, {
        body: JSON.stringify({ reason: trimmed }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) {
        // The route's own message names the real refusal — a request already reopened by a parallel
        // admin, a status that moved underneath this page — rather than a generic failure.
        setError(payload?.message ?? "The request could not be reopened. Reload and try again.");
        return;
      }
      setReason("");
      router.refresh();
    } catch {
      setError("The request did not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <label className="block text-phx-sm uppercase tracking-wide text-slate-400" htmlFor="marketing-reopen-reason">
        Reason
      </label>
      <textarea
        className={`${phxTextareaClassName} mt-1`}
        disabled={busy}
        id="marketing-reopen-reason"
        onChange={(event) => setReason(event.target.value)}
        placeholder="Why is this being looked at again? e.g. supplier revised the quote to EGP 800."
        rows={3}
        value={reason}
      />
      {error ? <p className="mt-1.5 text-phx-sm font-medium text-rose-700">{error}</p> : null}
      <button
        className="mt-2 bg-slate-950 px-4 py-2 text-phx-sm font-semibold text-white disabled:opacity-50"
        disabled={busy}
        onClick={submit}
        type="button"
      >
        {busy ? "Reopening…" : stepName ? `Reopen for ${stepName}` : "Reopen this request"}
      </button>
    </div>
  );
}
