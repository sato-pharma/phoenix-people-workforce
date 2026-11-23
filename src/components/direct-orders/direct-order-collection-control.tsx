"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { todayInCairo } from "@/lib/date-only";
import type { DirectOrderCollectionHistoryEntry } from "@/lib/direct-orders/collection-rules";
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
 *
 * TWO MODES, NAMED (owner, 19 Nov 2026: "understand what he wants and tailor it in the system").
 * Finance records instalments as they arrive and had been adding them up by hand. So once anything is
 * recorded the control opens on "Add a payment" — he types THIS payment and its date, and the server
 * adds it to the total this screen loaded. "Correct the total" is the second mode, pre-filled, and
 * REPLACES the total, so a typo is still fixed by editing it. The two never share one field: that
 * sharing is what made the withdrawn accumulate-on-edit store 700 for a typo corrected from 200 to 500.
 */
const money = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  return Number.isFinite(n)
    ? `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EGP`
    : "—";
};

type CollectionMode = "add" | "correct";

export function DirectOrderCollectionControl({
  requestId,
  salesValue,
  paidAmount,
  paymentDate,
  remainingAmount,
  canEdit,
  status,
  history = [],
}: {
  requestId: string;
  salesValue: number;
  paidAmount: number | null;
  paymentDate: string | null;
  remainingAmount: number | null;
  canEdit: boolean;
  status: string;
  /** The order's payment history, oldest first. */
  history?: Array<DirectOrderCollectionHistoryEntry & { byName: string | null }>;
}) {
  const router = useRouter();
  const recorded = paidAmount != null;
  // Nothing recorded yet: the first payment IS the total, so the add mode covers it too.
  const [mode, setMode] = useState<CollectionMode>("add");
  const [payment, setPayment] = useState("");
  const [paymentOn, setPaymentOn] = useState(() => todayInCairo());
  const [amount, setAmount] = useState(paidAmount == null ? "" : String(paidAmount));
  const [date, setDate] = useState(paymentDate ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const isApproved = status === "approved";
  // What is still owed as this screen loaded it. Before anything is recorded it is the order value.
  const outstanding = remainingAmount ?? (recorded ? null : salesValue);

  // Preview only. The server derives the stored remainder from the order value on every write —
  // this figure is never sent, so a tampered client cannot invent what is still owed.
  const typedPayment = Number(payment);
  const paymentPreview =
    payment.trim() !== "" && Number.isFinite(typedPayment) && typedPayment > 0 && outstanding != null
      ? Math.round((outstanding - typedPayment) * 100) / 100
      : null;
  const typed = Number(amount);
  const preview =
    amount.trim() !== "" && Number.isFinite(typed) && typed > 0 && typed <= salesValue
      ? Math.round((salesValue - typed) * 100) / 100
      : null;

  async function save(next: { paidAmount?: number | null; addAmount?: number; paymentDate: string | null }) {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await fetch(`/api/direct-orders/${encodeURIComponent(requestId)}/collection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The collection this screen LOADED goes with the save, so a save from a page opened
        // before someone else's is refused (409) instead of silently replacing it — and a payment
        // added on a stale page is refused instead of being added to a total that has moved.
        body: JSON.stringify({ ...next, expectedPaidAmount: paidAmount, expectedPaymentDate: paymentDate }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        message?: string;
        paidAmount?: number | null;
        remainingAmount?: number | null;
      };
      if (!res.ok || !data.success) throw new Error(data.message || "Could not record the collection.");
      const cleared = next.addAmount == null && next.paidAmount == null;
      const lead = next.addAmount != null ? `Payment of ${money(next.addAmount)} recorded. ` : "Recorded. ";
      setOk(
        cleared
          ? "Collection cleared — nothing is recorded as paid against this order."
          : data.remainingAmount && data.remainingAmount > 0
            ? `${lead}${money(data.paidAmount)} collected in total, ${money(data.remainingAmount)} still outstanding.`
            : `${lead}Paid in full.`,
      );
      setPayment("");
      router.refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const tabClass = (active: boolean) =>
    cn(
      "px-3 py-1 text-phx-xs font-bold disabled:opacity-50",
      active ? "bg-slate-900 text-white" : `border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 ${adminSoftDepthClassName}`,
    );

  return (
    <div className="border-t border-[#eef1f3] px-4 py-3">
      <p className="text-phx-xs font-black uppercase tracking-wider text-slate-500">Total collected (Finance)</p>

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
          {paymentDate ? <span className="text-phx-xs text-slate-500">last payment {paymentDate}</span> : null}
        </div>
      ) : (
        <p className="mt-0.5 text-sm font-semibold text-slate-900">
          {canEdit || isApproved ? "— nothing collected yet" : "— no collection recorded"}
        </p>
      )}

      {history.length > 0 ? (
        <div className="mt-2">
          <p className="text-phx-xs font-black uppercase tracking-wider text-slate-500">Payment history</p>
          <ol className="mt-1 divide-y divide-[#eef1f3] border border-[#eef1f3]">
            {history.map((entry, index) => (
              <li
                key={`${entry.recordedAt}-${index}`}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-2.5 py-1.5 text-phx-xs"
              >
                <span className="font-semibold text-slate-900">
                  {entry.kind === "cleared"
                    ? "Cleared — nothing recorded"
                    : entry.kind === "payment"
                      ? `Payment ${money(entry.amount)}`
                      : `Total corrected${entry.amount ? ` by ${money(entry.amount)}` : ""}`}
                  {entry.paymentDate ? <span className="font-normal text-slate-500"> · received {entry.paymentDate}</span> : null}
                </span>
                <span className="text-slate-500">
                  {entry.total != null ? `${money(entry.total)} in total` : null}
                  {entry.byName ? ` · by ${entry.byName}` : null}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {canEdit ? (
        !isApproved ? (
          <p className="mt-1.5 text-phx-xs text-slate-500">
            A collection can only be recorded once the order is approved.
          </p>
        ) : (
          <div className="mt-2 space-y-2">
            {recorded ? (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="What this save does">
                <button
                  type="button"
                  aria-pressed={mode === "add"}
                  disabled={busy}
                  className={tabClass(mode === "add")}
                  onClick={() => setMode("add")}
                >
                  Add a payment
                </button>
                <button
                  type="button"
                  aria-pressed={mode === "correct"}
                  disabled={busy}
                  className={tabClass(mode === "correct")}
                  onClick={() => {
                    setAmount(paidAmount == null ? "" : String(paidAmount));
                    setDate(paymentDate ?? "");
                    setMode("correct");
                  }}
                >
                  Correct the total
                </button>
              </div>
            ) : null}

            {mode === "add" ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    aria-label="This payment, in EGP — added to the total already recorded"
                    placeholder="This payment (EGP)"
                    className={cn(phxFieldClassName, "w-40 tabular-nums")}
                    value={payment}
                    onChange={(event) => setPayment(event.target.value)}
                    disabled={busy}
                  />
                  <input
                    type="date"
                    aria-label="Date this payment was received"
                    className={phxFieldClassName}
                    value={paymentOn}
                    onChange={(event) => setPaymentOn(event.target.value)}
                    disabled={busy}
                  />
                  {outstanding != null && outstanding > 0 ? (
                    <button
                      type="button"
                      disabled={busy}
                      className={`border border-slate-300 bg-white px-2.5 py-1.5 text-phx-xs font-bold text-slate-700 hover:bg-slate-100 disabled:opacity-50 disabled:shadow-none ${adminSoftDepthClassName}`}
                      onClick={() => setPayment(String(outstanding))}
                    >
                      Remaining {money(outstanding)}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={busy || !payment.trim() || !paymentOn}
                    className="bg-slate-800 px-3 py-1.5 text-sm font-bold text-white hover:bg-slate-900 disabled:opacity-50"
                    onClick={() => save({ addAmount: Number(payment), paymentDate: paymentOn })}
                  >
                    Add payment
                  </button>
                </div>
                <p className="text-phx-xs text-slate-500">
                  {paymentPreview !== null
                    ? paymentPreview > 0
                      ? `Adds to the ${money(paidAmount ?? 0)} already recorded — leaves ${money(paymentPreview)} outstanding.`
                      : paymentPreview === 0
                        ? `Adds to the ${money(paidAmount ?? 0)} already recorded — the order is then paid in full.`
                        : `More than the ${money(outstanding)} still outstanding.`
                    : `Type only the payment received — Phoenix adds it to the total. Order value ${money(salesValue)}. This records the money only; it does not change the sales month.`}
                </p>
              </>
            ) : (
              <>
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
                    Save corrected total
                  </button>
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
                </div>
                <p className="text-phx-xs text-slate-500">
                  {preview !== null
                    ? `Order value ${money(salesValue)} — this leaves ${money(preview)} outstanding.`
                    : `Order value ${money(salesValue)}. This records the money only; it does not change the sales month.`}
                </p>
                {/* Named explicitly. Telling someone the field is a total is weaker than telling them
                    which number they are about to replace. */}
                <p className="text-phx-xs font-semibold text-amber-700">
                  This is the RUNNING TOTAL, not a new payment: saving replaces the {money(paidAmount)} already
                  recorded. To record a new instalment, use Add a payment instead.
                </p>
              </>
            )}
          </div>
        )
      ) : null}

      {error ? <p className="mt-1.5 text-phx-sm font-semibold text-rose-600">{error}</p> : null}
      {ok ? <p className="mt-1.5 text-phx-sm font-semibold text-emerald-600">{ok}</p> : null}
    </div>
  );
}
