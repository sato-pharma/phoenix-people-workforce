"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FormActions, FormError, FormField, FormGrid } from "@/components/ui/form-kit";
import {
  phxButtonAccentClassName,
  phxButtonGhostClassName,
  phxFieldClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";

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
 *
 * 🔒 THE ONE FORM DESIGN (owner, 2026-10-06), and deliberately NOT the step wizard. This is an
 * INLINE panel inside an order's own card — four pre-filled boxes answering one objection — so the
 * Adverse Drug Reaction form's 244px step rail would be a second frame around a correction that is
 * over in one screen. It wears the design the way an inline form does: every label, field, hint and
 * button comes from `form-kit.tsx` / `form-tokens.ts` instead of a hand-written near-copy of the
 * same classes, which is what it carried until 2026-10-07.
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
      <p className="text-phx-2xs font-black uppercase tracking-wider text-amber-700">
        Sent back to you for a correction
      </p>

      {returnComment ? (
        <blockquote className="mt-2 border-l-4 border-amber-400 bg-white px-3 py-2">
          <p className="text-sm font-semibold text-slate-900">“{returnComment.message}”</p>
          <p className="mt-1 text-phx-xs font-bold text-slate-500">
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
        <button className={`${phxButtonAccentClassName} mt-3`} onClick={() => setOpen(true)} type="button">
          Correct &amp; Resubmit
        </button>
      ) : (
        <div className="mt-3 space-y-3">
          <p className="text-phx-xs font-semibold text-slate-600">
            Correcting <span className="font-black text-slate-900">{productName}</span> for{" "}
            <span className="font-black text-slate-900">{pharmacyName}</span>. This stays the same
            order and goes back to the same approver — it does not start again from the beginning.
            To change the product or the pharmacy, raise a new order instead.
          </p>

          <FormGrid className="sm:grid-cols-2">
            <FormField label="Quantity" required>
              <input
                className={phxFieldClassName}
                min={1}
                onChange={(event) => setNextQty(event.target.value)}
                type="number"
                value={nextQty}
              />
            </FormField>

            <FormField label="Deal" required>
              <select
                className={phxSelectClassName}
                onChange={(event) => setNextDeal(event.target.value === "discount" ? "discount" : "bonus")}
                value={nextDeal}
              >
                <option value="bonus">Bonus</option>
                <option value="discount">Discount</option>
              </select>
            </FormField>

            {nextDeal === "bonus" ? (
              <FormField label="Bonus units" required>
                <input
                  className={phxFieldClassName}
                  min={0}
                  onChange={(event) => setNextBonus(event.target.value)}
                  type="number"
                  value={nextBonus}
                />
              </FormField>
            ) : (
              <FormField label="Discount %" required>
                <input
                  className={phxFieldClassName}
                  max={100}
                  min={0}
                  onChange={(event) => setNextDiscount(event.target.value)}
                  type="number"
                  value={nextDiscount}
                />
              </FormField>
            )}

            <FormField label="Money-collection date" required>
              <input
                className={phxFieldClassName}
                onChange={(event) => setNextCollectionDate(event.target.value)}
                type="date"
                value={nextCollectionDate}
              />
            </FormField>
          </FormGrid>

          <FormField hint="The approver sees this beside your correction." label="What did you change?" required>
            <textarea
              className={phxTextareaClassName}
              onChange={(event) => setNote(event.target.value)}
              placeholder="e.g. Reduced the bonus to 20 units as requested."
              rows={2}
              value={note}
            />
          </FormField>

          <FormError>{error}</FormError>

          <FormActions
            left={
              <button className={phxButtonGhostClassName} disabled={busy} onClick={() => setOpen(false)} type="button">
                Cancel
              </button>
            }
            right={
              <button
                className={phxButtonAccentClassName}
                disabled={busy || !note.trim()}
                onClick={submit}
                type="button"
              >
                {busy ? "Resubmitting…" : "Resubmit for approval"}
              </button>
            }
          />
        </div>
      )}
    </div>
  );
}
