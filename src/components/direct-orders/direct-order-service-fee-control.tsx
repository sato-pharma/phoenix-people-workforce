"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  phxButtonAccentClassName,
  phxButtonGhostClassName,
  phxFieldClassName,
  phxLabelTextClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";
import { SERVICE_FEE_REQUEST_TYPES } from "@/lib/direct-orders/offset-rules";
import { cn } from "@/lib/utils";

/**
 * The Administrator's one-click service-fee settlement.
 *
 * Shown to the Administrator only (the server decides; this flag only hides the control). A hospital
 * that pays an order net of a fee it owes its own doctor leaves that sum outstanding on the order.
 * One confirmed click here raises the marketing request under the order's own requester, records
 * every rung of its chain as decided by the Administrator, and settles the amount against the
 * order. No cash moves and nobody is notified. It takes two steps on purpose — review, then
 * confirm — because the confirm line says in words exactly what will be recorded under his name.
 */
const money = (value: number): string =>
  `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EGP`;

export function DirectOrderServiceFeeControl({
  requestId,
  beneficiaryName,
  requesterName,
  outstanding,
  status,
}: {
  requestId: string;
  beneficiaryName: string;
  requesterName: string;
  outstanding: number;
  status: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(beneficiaryName);
  const [typeCode, setTypeCode] = useState<string>(SERVICE_FEE_REQUEST_TYPES[0].code);
  const [amount, setAmount] = useState(outstanding > 0 ? String(outstanding) : "");
  const [note, setNote] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  if (status !== "approved" || (outstanding <= 0 && !ok)) return null;

  const typed = Number(amount);
  const amountOk = amount.trim() !== "" && Number.isFinite(typed) && typed > 0 && typed <= outstanding;
  const typeLabel = SERVICE_FEE_REQUEST_TYPES.find((type) => type.code === typeCode)?.label ?? "";
  const canReview = !busy && name.trim() !== "" && amountOk && (typeCode !== "other" || note.trim() !== "");

  async function record() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/direct-orders/${encodeURIComponent(requestId)}/service-fee`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: typed, beneficiaryName: name, note, requestTypeCode: typeCode }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
        remainingAmount?: number;
        requestCode?: string;
        success?: boolean;
      };
      if (!res.ok || !data.success) throw new Error(data.message || "Could not record the service fee.");
      setOk(`Recorded as ${data.requestCode ?? "a marketing request"}. ${money(data.remainingAmount ?? 0)} still outstanding.`);
      setReviewing(false);
      router.refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Something went wrong.");
      setReviewing(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-[#eef1f3] px-4 py-3">
      <p className="text-phx-2xs font-black uppercase tracking-wider text-slate-400">
        Service fee kept by the pharmacy (Administrator)
      </p>
      {ok ? (
        <p className="mt-1.5 text-phx-sm font-semibold text-emerald-600">{ok}</p>
      ) : (
        <div className="mt-1.5 space-y-2">
          <p className="text-phx-xs text-slate-500">
            For a fee the pharmacy kept out of its payment because the company owes it to the pharmacy&apos;s
            doctor. One confirmed click raises the marketing request, records its whole approval chain as
            decided by you, and lowers this order&apos;s outstanding amount. No cash moves.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="block">
              <span className={phxLabelTextClassName}>Owed to</span>
              <input
                aria-label="Who the fee is owed to"
                className={cn(phxFieldClassName, "w-56")}
                disabled={busy || reviewing}
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </label>
            <label className="block">
              <span className={phxLabelTextClassName}>Request type</span>
              <select
                aria-label="Request type"
                className={cn(phxSelectClassName, "w-44")}
                disabled={busy || reviewing}
                onChange={(event) => setTypeCode(event.target.value)}
                value={typeCode}
              >
                {SERVICE_FEE_REQUEST_TYPES.map((type) => (
                  <option key={type.code} value={type.code}>
                    {type.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className={phxLabelTextClassName}>Amount (EGP)</span>
              <input
                aria-label="Amount of the fee, in EGP"
                className={cn(phxFieldClassName, "w-36 tabular-nums")}
                disabled={busy || reviewing}
                inputMode="decimal"
                min="0"
                onChange={(event) => setAmount(event.target.value)}
                step="0.01"
                type="number"
                value={amount}
              />
            </label>
            <label className="block">
              <span className={phxLabelTextClassName}>Note</span>
              <input
                aria-label="Note"
                className={cn(phxFieldClassName, "w-64")}
                disabled={busy || reviewing}
                onChange={(event) => setNote(event.target.value)}
                placeholder={typeCode === "other" ? "Describe the fee (required)" : "Optional"}
                value={note}
              />
            </label>
          </div>
          {reviewing ? (
            <div className="space-y-2">
              <p className="text-phx-sm font-semibold text-slate-900">
                This raises a {typeLabel.toLowerCase()} of {money(typed)} for {name.trim()} under {requesterName},
                records every approval step as decided by you, and settles it against this order. No cash moves.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  className={cn(phxButtonAccentClassName, "shrink-0")}
                  disabled={busy}
                  onClick={() => void record()}
                  type="button"
                >
                  {busy ? "Recording..." : "Confirm and record"}
                </button>
                <button
                  className={phxButtonGhostClassName}
                  disabled={busy}
                  onClick={() => setReviewing(false)}
                  type="button"
                >
                  Back
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button
                className={cn(phxButtonAccentClassName, "shrink-0")}
                disabled={!canReview}
                onClick={() => {
                  setError(null);
                  setReviewing(true);
                }}
                type="button"
              >
                Review
              </button>
              <span className="text-phx-xs text-slate-500">
                {amountOk
                  ? `This leaves ${money(Math.round((outstanding - typed) * 100) / 100)} outstanding.`
                  : `Outstanding on this order: ${money(outstanding)}.`}
              </span>
            </div>
          )}
        </div>
      )}
      {error ? <p className="mt-1.5 text-phx-sm font-semibold text-rose-600">{error}</p> : null}
    </div>
  );
}
