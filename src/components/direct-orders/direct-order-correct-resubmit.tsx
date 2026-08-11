"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The requester's answer to a return: correct the order and send it back up the SAME chain.
 *
 * WHY THE FORM IS PRE-FILLED AND NARROW. Everything editable is seeded with what the order already
 * says, so a correction is an edit rather than a re-entry — the requester changes the one thing the
 * approver objected to and resubmits. Product and pharmacy are deliberately absent and the panel
 * says so in words: changing either makes it a different order (the product can change the LINE the
 * chain was built for, and the pharmacy re-opens the held decision), so that case is a new order,
 * not a correction. See `reviseDirectOrder`.
 *
 * The approver's reason is rendered ABOVE the fields, not tucked into the timeline, because it is
 * the instruction the requester is acting on. It comes from `direct_order_events` — the decision
 * RPC never stores a return reason on the approval step.
 */
export function DirectOrderCorrectResubmit({
  requestId,
  dealType,
  qty,
  bonus,
  discountPct,
  collectionDate,
  productName,
  pharmacyName,
  returnComment,
}: {
  requestId: string;
  dealType: "bonus" | "discount";
  qty: number;
  bonus: number;
  discountPct: number | null;
  collectionDate: string | null;
  productName: string;
  pharmacyName: string;
  returnComment: { message: string; byName: string | null; at: string } | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [nextQty, setNextQty] = useState(String(qty));
  const [nextDeal, setNextDeal] = useState<"bonus" | "discount">(dealType);
  const [nextBonus, setNextBonus] = useState(String(bonus ?? 0));
  const [nextDiscount, setNextDiscount] = useState(discountPct == null ? "" : String(discountPct));
  const [nextCollectionDate, setNextCollectionDate] = useState(collectionDate ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/direct-orders/${encodeURIComponent(requestId)}/revise`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          qty: Number(nextQty),
          dealType: nextDeal,
          bonus: nextDeal === "bonus" ? Number(nextBonus) : 0,
          discountPct: nextDeal === "discount" ? Number(nextDiscount) : null,
          collectionDate: nextCollectionDate,
          correctionNote: note,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) throw new Error(data.message || "Could not resubmit this order.");
      // Deliberately NOT navigating away: the requester stays on the order they just fixed and
      // watches its status change to In Approval, which is the confirmation.
      setOpen(false);
      router.refresh();
    } catch (submitError) {
      // The entered values are kept on failure — retyping a correction because the server said no
      // is exactly the frustration this flow exists to remove.
      setError(submitError instanceof Error ? submitError.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-amber-200 bg-amber-50/60 px-4 py-3">
      <p className="text-[10px] font-black uppercase tracking-wider text-amber-700">
        Sent back to you for a correction
      </p>

      {returnComment ? (
        <blockquote className="mt-2 border-l-4 border-amber-400 bg-white px-3 py-2">
          <p className="text-sm font-semibold text-slate-900">“{returnComment.message}”</p>
          <p className="mt-1 text-[11px] font-bold text-slate-500">
            {returnComment.byName ? `— ${returnComment.byName}` : "— the approver"}
            {returnComment.at ? ` · ${new Date(returnComment.at).toLocaleDateString("en-GB")}` : ""}
          </p>
        </blockquote>
      ) : (
        <p className="mt-2 text-sm font-semibold text-slate-600">
          The approver did not leave a written reason on this return.
        </p>
      )}

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-3 bg-amber-600 px-4 py-2 text-sm font-black text-white hover:bg-amber-700"
        >
          Correct &amp; Resubmit
        </button>
      ) : (
        <div className="mt-3 space-y-3">
          <p className="text-[11px] font-semibold text-slate-600">
            Correcting <span className="font-black text-slate-900">{productName}</span> for{" "}
            <span className="font-black text-slate-900">{pharmacyName}</span>. This stays the same
            order and goes back to the same approver — it does not start again from the beginning.
            To change the product or the pharmacy, raise a new order instead.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Quantity</span>
              <input
                type="number"
                min={1}
                value={nextQty}
                onChange={(event) => setNextQty(event.target.value)}
                className="mt-1 w-full border border-[#d8dee3] px-2 py-1.5 text-sm font-semibold"
              />
            </label>

            <label className="block">
              <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Deal</span>
              <select
                value={nextDeal}
                onChange={(event) => setNextDeal(event.target.value === "discount" ? "discount" : "bonus")}
                className="mt-1 w-full border border-[#d8dee3] px-2 py-1.5 text-sm font-semibold"
              >
                <option value="bonus">Bonus</option>
                <option value="discount">Discount</option>
              </select>
            </label>

            {nextDeal === "bonus" ? (
              <label className="block">
                <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Bonus units</span>
                <input
                  type="number"
                  min={0}
                  value={nextBonus}
                  onChange={(event) => setNextBonus(event.target.value)}
                  className="mt-1 w-full border border-[#d8dee3] px-2 py-1.5 text-sm font-semibold"
                />
              </label>
            ) : (
              <label className="block">
                <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Discount %</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={nextDiscount}
                  onChange={(event) => setNextDiscount(event.target.value)}
                  className="mt-1 w-full border border-[#d8dee3] px-2 py-1.5 text-sm font-semibold"
                />
              </label>
            )}

            <label className="block">
              <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">
                Money-collection date
              </span>
              <input
                type="date"
                value={nextCollectionDate}
                onChange={(event) => setNextCollectionDate(event.target.value)}
                className="mt-1 w-full border border-[#d8dee3] px-2 py-1.5 text-sm font-semibold"
              />
            </label>
          </div>

          <label className="block">
            <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">
              What did you change? (the approver sees this)
            </span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              className="mt-1 w-full border border-[#d8dee3] px-2 py-1.5 text-sm font-semibold"
              placeholder="e.g. Reduced the bonus to 20 units as requested."
            />
          </label>

          {error ? <p className="text-sm font-bold text-red-600">{error}</p> : null}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={busy || !note.trim()}
              className="bg-amber-600 px-4 py-2 text-sm font-black text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {busy ? "Resubmitting…" : "Resubmit for approval"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={busy}
              className="border border-[#d8dee3] px-4 py-2 text-sm font-black text-slate-700 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
