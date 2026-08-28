"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  requestId: string;
  /** Shown back to the requester so they can see they are withdrawing the right one. */
  productName: string;
  qty: number;
  salesValue: number;
};

const labelClass = "block text-phx-xs font-black uppercase tracking-wider text-slate-500";
const inputClass =
  "mt-1 w-full border border-phx-line px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400";

/**
 * Withdraw a HELD direct order (audit finding F3).
 *
 * Deliberately quieter than the validation capture that sits above it, and collapsed until asked
 * for. Validating the pharmacy is the outcome the business wants — it moves the order into the
 * chain and keeps the sale. Cancelling only exists because a retry leaves a duplicate behind, and a
 * panel competing for attention with the validation capture would push reps toward abandoning
 * orders that were perfectly good.
 *
 * No effects here, deliberately: a setState in a useEffect body is a lint error in this repo, and
 * this component has no state that needs syncing from outside.
 */
export function CancelHeldOrder({ requestId, productName, qty, salesValue }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const trimmed = reason.trim();

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/direct-orders/${encodeURIComponent(requestId)}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: trimmed }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string; success?: boolean };
      if (!res.ok || !data.success) {
        // The server's own sentence, not a generic one. It distinguishes "no longer held" (someone
        // validated the pharmacy a moment ago) from "not yours", and the requester needs to know which.
        setError(data.message ?? "Could not cancel this request.");
        return;
      }
      setDone(true);
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <section className="border border-phx-line bg-white px-4 py-3">
        <p className="text-phx-sm font-bold text-slate-700">
          Withdrawn. This request is now cancelled and no longer counts against your held total.
        </p>
      </section>
    );
  }

  if (!open) {
    return (
      <div className="px-1">
        <button
          type="button"
          className="text-phx-xs font-bold text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-700"
          onClick={() => setOpen(true)}
        >
          Raised this twice by mistake? Withdraw it
        </button>
      </div>
    );
  }

  return (
    <section className="border border-phx-line bg-white">
      <header className="border-b border-phx-line bg-slate-900 px-4 py-2.5">
        <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">Withdraw this request</h3>
      </header>
      <div className="space-y-3 px-4 py-4">
        <p className="border border-amber-300 bg-amber-50 px-3 py-2 text-phx-sm font-semibold text-amber-900">
          You are about to withdraw {productName} — {qty.toLocaleString("en-US")} units,{" "}
          {Math.round(salesValue).toLocaleString("en-US")} EGP. This cannot be undone, and the order will
          not reach an approver. If the pharmacy is real, validate it above instead — that keeps the sale.
        </p>

        <div>
          <label className={labelClass} htmlFor="cancel-reason">
            Why are you withdrawing it? *
          </label>
          <textarea
            id="cancel-reason"
            className={inputClass}
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. duplicate of the order I raised right after this one"
            dir="auto"
          />
        </div>

        {error ? (
          <p className="border border-rose-300 bg-rose-50 px-3 py-2 text-phx-sm font-semibold text-rose-800">{error}</p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="bg-slate-900 px-4 py-2 text-phx-xs font-black uppercase tracking-wider text-white disabled:cursor-not-allowed disabled:bg-slate-300"
            disabled={busy || !trimmed}
            onClick={submit}
          >
            {busy ? "Withdrawing…" : "Withdraw this request"}
          </button>
          <button
            type="button"
            className="px-3 py-2 text-phx-xs font-bold uppercase tracking-wider text-slate-500 hover:text-slate-700"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              setError(null);
            }}
          >
            Keep it
          </button>
          {!trimmed ? (
            <span className="text-phx-xs font-semibold text-slate-400">A reason is required.</span>
          ) : null}
        </div>
      </div>
    </section>
  );
}
