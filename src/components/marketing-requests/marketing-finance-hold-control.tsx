"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { phxTextareaClassName } from "@/components/ui/form-tokens";

/**
 * Place or release the finance hold, from the one screen that reads a request whole.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * The hold shipped with an API route and NO caller. `finance_hold` appeared in six components and
 * in every one of them it was a status LABEL being displayed — nothing anywhere posted to the
 * endpoint. So the feature could only ever be operated by someone with database access, and the
 * first real hold in production was placed by running the domain code by hand.
 *
 * That is the same shape as the bug underneath it: the actor was being lowercased, so the write
 * failed the `employees` foreign key for 178 of 179 people. Green tests, green CI and a clean
 * deploy all reported success on a feature reachable by nobody. A capability with no control is
 * indistinguishable from one that does not work.
 *
 * ── WHY THE REASON IS REQUIRED ───────────────────────────────────────────────
 * Freezing committed money with no recorded why leaves the next reader — often the owner at 4am,
 * weeks later — with a frozen request and nothing to explain it. The server orders the write
 * reason-first for exactly this reason; requiring it here means the ordering has something to
 * order. Release takes one too: "why did this become payable again" is the harder question.
 */
export function MarketingFinanceHoldControl({
  held,
  requestId,
}: {
  /** Whether the request is currently on hold — decides which action is offered. */
  held: boolean;
  requestId: string;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const action = held ? "release" : "hold";
  const verb = held ? "Release" : "Place hold";

  async function submit() {
    const trimmed = reason.trim();
    if (!trimmed) {
      setError("Write the reason first — it is the only record of why this happened.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/marketing-requests/finance-hold", {
        body: JSON.stringify({ action, reason: trimmed, requestId }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) {
        // The route's own message is the useful one — it names the real refusal (a settled invoice,
        // a status that moved under a parallel admin) rather than a generic failure.
        setError(payload?.message ?? "The hold could not be changed. Reload and try again.");
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
      <label className="block text-phx-sm uppercase tracking-wide text-slate-400" htmlFor="finance-hold-reason">
        Reason
      </label>
      <textarea
        className={`${phxTextareaClassName} mt-1`}
        disabled={busy}
        id="finance-hold-reason"
        onChange={(event) => setReason(event.target.value)}
        placeholder={held
          ? "Why is this payable again? e.g. invoice received 2026-09-02."
          : "Why is this being frozen? e.g. invoice 18 days late and still not delivered."}
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
        {busy ? "Working…" : verb}
      </button>
    </div>
  );
}
