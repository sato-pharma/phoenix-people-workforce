"use client";

import { XCircle } from "lucide-react";
import { useState } from "react";
import { phxTextareaClassName } from "@/components/ui/form-tokens";

/**
 * Call off a marketing request straight from the Super-Admin oversight inbox.
 *
 * ── WHY A SECOND CONTROL ─────────────────────────────────────────────────────
 * `MarketingCancelControl` already cancels from the case file, and the case file is where a reader
 * who opened one request acts. But the oversight queue ("Everything in approval") is where the owner
 * SEES a request he wants stopped — one row among dozens moving through the chain. Making him open
 * each record first to call it off is the friction this removes; the button lives on the row.
 *
 * It shares the case file's endpoint, gate and required reason exactly — `canCancel` on the row is
 * the same `canCancelMarketingRequest` verdict, and the route re-runs it before writing, so this is
 * only an affordance. It does not move money: it sets the state, and any real reversal is finance's.
 *
 * ── WHY IT RELOADS RATHER THAN ROUTER.REFRESH ────────────────────────────────
 * The inbox rows are fetched client-side (`loadInbox`), so a Next.js `router.refresh()` would leave
 * the cancelled row on screen. The caller passes `onCancelled` (= the inbox's own reload) so the
 * row drops the moment the cancel lands.
 */
export function MarketingInboxCancelButton({
  onCancelled,
  requestCode,
  requestId,
}: {
  onCancelled: () => void;
  requestCode: string;
  requestId: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const trimmed = reason.trim();
    if (!trimmed) {
      setError("Write the reason first — it is the only record of why this was called off.");
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
        // The route names the real refusal — a status that moved underneath the inbox, a role that
        // may not cancel — rather than a generic failure.
        setError(payload?.message ?? "The request could not be cancelled. Reload and try again.");
        return;
      }
      onCancelled();
    } catch {
      setError("The request did not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        className="inline-flex min-h-9 items-center gap-1.5 rounded-sm border border-rose-200 bg-white px-3 text-phx-sm font-bold text-rose-700 shadow-sm transition hover:border-rose-300 hover:bg-rose-50"
        onClick={() => setOpen(true)}
        type="button"
      >
        <XCircle className="h-3.5 w-3.5" />
        Cancel request
      </button>
    );
  }

  return (
    <div className="w-full max-w-xs rounded-sm border border-rose-200 bg-rose-50/40 p-2.5 text-left">
      <p className="text-phx-sm font-black uppercase tracking-wide text-rose-700">Call off {requestCode}</p>
      <textarea
        className={`${phxTextareaClassName} mt-1.5`}
        disabled={busy}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Why is this being called off?"
        rows={2}
        value={reason}
      />
      {error ? <p className="mt-1 text-phx-xs font-medium text-rose-700">{error}</p> : null}
      <div className="mt-2 flex items-center gap-2">
        <button
          className="min-h-9 rounded-sm bg-rose-700 px-3 text-phx-sm font-bold text-white transition hover:bg-rose-800 disabled:opacity-50"
          disabled={busy}
          onClick={submit}
          type="button"
        >
          {busy ? "Cancelling…" : "Confirm cancel"}
        </button>
        <button
          className="min-h-9 rounded-sm border border-slate-300 bg-white px-3 text-phx-sm font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setReason("");
            setError(null);
          }}
          type="button"
        >
          Keep it
        </button>
      </div>
    </div>
  );
}
