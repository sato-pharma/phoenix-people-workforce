"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { phxTextareaClassName } from "@/components/ui/form-tokens";

/**
 * Call off a marketing request that entered the chain but is no longer wanted.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * `cancelled` became a real status on 2026-09-22, but the only way to set it was hand-written SQL
 * against production — which is how `MKT-REQ-20260825-AADD59CE` was cancelled. A capability
 * reachable only through the database is indistinguishable from one that does not exist, the same
 * lesson the reopen and finance-hold controls record. This is the button.
 *
 * ── WHY THE REASON IS REQUIRED ───────────────────────────────────────────────
 * Cancelling ends a request other people raised and approvers acted on. Without a recorded why, the
 * timeline shows an in-flight request that simply stops, leaving the next reader (often the owner,
 * weeks later) to guess whether it was called off, superseded, or a mistake. Required here and in
 * the service, so no caller can route around it.
 *
 * The control is drawn only when `viewer.can.cancel` is true (Super Admin, a live non-terminal
 * request). That is an affordance — the route and the module both re-run the gate before anything is
 * written. It does not move money: it sets the state, and any real reversal is done on finance.
 */
export function MarketingCancelControl({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const trimmed = reason.trim();
    if (!trimmed) {
      setError("Write the reason first — it is the only record of why this request was called off.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/marketing-requests/${requestId}/cancel`, {
        body: JSON.stringify({ reason: trimmed }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) {
        // The route's own message names the real refusal — a request whose status moved underneath
        // this page, a role that may not cancel — rather than a generic failure.
        setError(payload?.message ?? "The request could not be cancelled. Reload and try again.");
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
      <label className="block text-phx-sm uppercase tracking-wide text-slate-400" htmlFor="marketing-cancel-reason">
        Reason
      </label>
      <textarea
        className={`${phxTextareaClassName} mt-1`}
        disabled={busy}
        id="marketing-cancel-reason"
        onChange={(event) => setReason(event.target.value)}
        placeholder="Why is this being called off? e.g. the activity was dropped and will not run."
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
        {busy ? "Cancelling…" : "Cancel this request"}
      </button>
    </div>
  );
}
