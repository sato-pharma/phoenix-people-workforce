"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

/**
 * Finance's collection control — what has actually been PAID against the order.
 *
 * Deliberately a separate control from DirectOrderSalesMonthControl, sitting beside it rather than
 * inside it. Booking a sales month decides which month's sales the order counts in; collecting the
 * cash is a different event that must never move that month. Two controls make that visible to the
 * person using them, not just true in the service.
 *
 * Only Finance (Ahmed El Maraghy) and Super Admin get the form; everyone else — the CEO, the
 * requesting rep, the SFE Manager — sees the figures read-only, which is why a rep can see whether
 * their own order has been settled without being able to claim it has.
 */
const money = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  return Number.isFinite(n)
    ? `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EGP`
    : "—";
};

export function DirectOrderCollectionControl({
  requestId,
  salesValue,
  paidAmount,
  paymentDate,
  remainingAmount,
  canEdit,
  status,
}: {
  requestId: string;
  salesValue: number;
  paidAmount: number | null;
  paymentDate: string | null;
  remainingAmount: number | null;
  canEdit: boolean;
  status: string;
}) {
  const router = useRouter();
  const [amount, setAmount] = useState(paidAmount == null ? "" : String(paidAmount));
  const [date, setDate] = useState(paymentDate ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const isApproved = status === "approved";
  const recorded = paidAmount != null;

  // Preview only. The server derives the stored remainder from the order value on every write —
  // this figure is never sent, so a tampered client cannot invent what is still owed.
  const typed = Number(amount);
  const preview =
    amount.trim() !== "" && Number.isFinite(typed) && typed > 0 && typed <= salesValue
      ? Math.round((salesValue - typed) * 100) / 100
      : null;

  async function save(next: { paidAmount: number | null; paymentDate: string | null }) {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await fetch(`/api/direct-orders/${encodeURIComponent(requestId)}/collection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The collection this screen LOADED goes with the save, so a save from a page opened
        // before someone else's is refused (409) instead of silently replacing it.
        body: JSON.stringify({ ...next, expectedPaidAmount: paidAmount, expectedPaymentDate: paymentDate }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        message?: string;
        remainingAmount?: number | null;
      };
      if (!res.ok || !data.success) throw new Error(data.message || "Could not record the collection.");
      setOk(
        next.paidAmount == null
          ? "Collection cleared — nothing is recorded as paid against this order."
          : data.remainingAmount && data.remainingAmount > 0
            ? `Recorded. ${money(data.remainingAmount)} still outstanding.`
            : "Recorded — paid in full.",
      );
      router.refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-[#eef1f3] px-4 py-3">
      {/* TOTAL COLLECTED, said in every label on this control.

          The field is pre-filled with what is already stored and REPLACES it on save — it is a
          running total, and the arithmetic is right. But it used to be labelled "Amount
          collected", which reads just as easily as "the amount collected THIS TIME". Finance
          looking at 200 already collected, typing 300 for a second instalment, would store 300
          and lose 100. Nothing in the control said otherwise.

          The fix is the WORDS, not the arithmetic. An earlier review called this a bug and
          proposed accumulating the input instead; that was withdrawn, and rightly — it would
          have stored 700 the moment Finance corrected a typo from 200 to 500. */}
      <p className="text-phx-2xs font-black uppercase tracking-wider text-slate-400">Total collected (Finance)</p>

      {recorded ? (
        <div className="mt-1 flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <span className="text-sm font-semibold text-slate-900">{money(paidAmount)} collected in total</span>
          <span
            className={`text-sm font-semibold ${
              (remainingAmount ?? 0) > 0 ? "text-amber-700" : "text-emerald-700"
            }`}
          >
            {(remainingAmount ?? 0) > 0 ? `${money(remainingAmount)} outstanding` : "Paid in full"}
          </span>
          {paymentDate ? <span className="text-phx-xs text-slate-500">on {paymentDate}</span> : null}
        </div>
      ) : (
        <p className="mt-0.5 text-sm font-semibold text-slate-900">
          {canEdit || isApproved ? "— nothing collected yet" : "— no collection recorded"}
        </p>
      )}

      {canEdit ? (
        !isApproved ? (
          <p className="mt-1.5 text-phx-xs text-slate-500">
            A collection can only be recorded once the order is approved.
          </p>
        ) : (
          <div className="mt-1.5 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                aria-label="Total collected to date, in EGP — replaces any amount already recorded"
                placeholder="Total collected (EGP)"
                className={cn(phxFieldClassName, "w-40 tabular-nums")}
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                disabled={busy}
              />
              <input
                type="date"
                aria-label="Date the money was collected"
                className={phxFieldClassName}
                value={date}
                onChange={(event) => setDate(event.target.value)}
                disabled={busy}
              />
              <button
                type="button"
                disabled={busy || !amount.trim() || !date}
                className="bg-slate-800 px-3 py-1.5 text-sm font-bold text-white hover:bg-slate-900 disabled:opacity-50"
                onClick={() => save({ paidAmount: Number(amount), paymentDate: date })}
              >
                {recorded ? "Update collection" : "Record collection"}
              </button>
              {recorded ? (
                <button
                  type="button"
                  disabled={busy}
                  className="px-2 py-1.5 text-sm font-bold text-rose-600 hover:text-rose-700 disabled:opacity-50"
                  onClick={() => {
                    setAmount("");
                    setDate("");
                    void save({ paidAmount: null, paymentDate: null });
                  }}
                >
                  Clear
                </button>
              ) : null}
            </div>
            <p className="text-phx-xs text-slate-500">
              {preview !== null
                ? `Order value ${money(salesValue)} — this leaves ${money(preview)} outstanding.`
                : `Order value ${money(salesValue)}. This records the money only; it does not change the sales month.`}
            </p>
            {/* Named explicitly, and only when there is something to overwrite. Telling someone the
                field is a total is weaker than telling them which number they are about to replace. */}
            {recorded ? (
              <p className="text-phx-xs font-semibold text-amber-700">
                This is the RUNNING TOTAL, not a new payment: saving replaces the {money(paidAmount)} already
                recorded. For a second instalment, enter the two added together.
              </p>
            ) : null}
          </div>
        )
      ) : null}

      {error ? <p className="mt-1.5 text-phx-sm font-semibold text-rose-600">{error}</p> : null}
      {ok ? <p className="mt-1.5 text-phx-sm font-semibold text-emerald-600">{ok}</p> : null}
    </div>
  );
}
