"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FormActions, FormBlock, FormError, FormField, FormGrid } from "@/components/ui/form-kit";
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
 *
 * 🔴 EVERY PRODUCT ON THE ORDER IS ON THE FORM (code review, 19 Oct 2026). A Lacto basket holds two
 * lines; this form used to show and send the first alone, and the server rebuilt the order from it —
 * a returned 86,625 EGP order of both concentrations would have gone back at 49,500 with the second
 * line deleted. Each line now has its own quantity and deal, exactly as on the submit form, and the
 * request always names every line after the first (`items`), so the server can refuse a screen
 * that lost one rather than drop it.
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
  extraLines = [],
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
  /** The order's lines after the first, in line order. Empty for a single-product order. */
  extraLines?: ReadonlyArray<{
    productCode: string;
    productName: string;
    qty: number;
    dealType: "bonus" | "discount";
    bonus: number;
    discountPct: number | null;
  }>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [nextQty, setNextQty] = useState(String(qty));
  const [nextDeal, setNextDeal] = useState<"bonus" | "discount">(dealType);
  const [nextBonus, setNextBonus] = useState(String(bonus ?? 0));
  const [nextDiscount, setNextDiscount] = useState(discountPct == null ? "" : String(discountPct));
  const [nextCollectionDate, setNextCollectionDate] = useState(collectionDate ?? "");
  const [nextExtras, setNextExtras] = useState(() =>
    extraLines.map((line) => ({
      productCode: line.productCode,
      productName: line.productName,
      qty: String(line.qty),
      dealType: line.dealType,
      bonus: String(line.bonus ?? 0),
      discount: line.discountPct == null ? "" : String(line.discountPct),
    })),
  );
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isBasket = nextExtras.length > 0;
  const productNames = [productName, ...nextExtras.map((line) => line.productName)];
  const productList =
    productNames.length === 1
      ? productNames[0]
      : `${productNames.slice(0, -1).join(", ")} and ${productNames[productNames.length - 1]}`;

  function updateExtra(index: number, patch: Partial<(typeof nextExtras)[number]>) {
    setNextExtras((previous) => previous.map((line, at) => (at === index ? { ...line, ...patch } : line)));
  }

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
          // Always sent, empty for a single product: the server keeps the order's products and
          // refuses a correction that leaves one out, rather than deleting it.
          items: nextExtras.map((line) => ({
            productCode: line.productCode,
            qty: Number(line.qty),
            dealType: line.dealType,
            bonus: line.dealType === "bonus" ? Number(line.bonus) : 0,
            discountPct: line.dealType === "discount" ? Number(line.discount) : null,
          })),
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
            Correcting <span className="font-black text-slate-900">{productList}</span> for{" "}
            <span className="font-black text-slate-900">{pharmacyName}</span>. This stays the same
            order and goes back to the same approver — it does not start again from the beginning.
            {isBasket
              ? " Each product keeps its own quantity and deal. To add or remove a product, or change the pharmacy, raise a new order instead."
              : " To change the product or the pharmacy, raise a new order instead."}
          </p>

          {isBasket ? (
            <div className="space-y-3">
              <FormBlock label={productNames[0]}>
                <FormGrid className="sm:grid-cols-3">
                  <CorrectionLineFields
                    bonus={nextBonus}
                    deal={nextDeal}
                    discount={nextDiscount}
                    onBonus={setNextBonus}
                    onDeal={setNextDeal}
                    onDiscount={setNextDiscount}
                    onQty={setNextQty}
                    qty={nextQty}
                  />
                </FormGrid>
              </FormBlock>
              {nextExtras.map((line, index) => (
                <FormBlock key={line.productCode} label={line.productName}>
                  <FormGrid className="sm:grid-cols-3">
                    <CorrectionLineFields
                      bonus={line.bonus}
                      deal={line.dealType}
                      discount={line.discount}
                      onBonus={(value) => updateExtra(index, { bonus: value })}
                      onDeal={(value) => updateExtra(index, { dealType: value })}
                      onDiscount={(value) => updateExtra(index, { discount: value })}
                      onQty={(value) => updateExtra(index, { qty: value })}
                      qty={line.qty}
                    />
                  </FormGrid>
                </FormBlock>
              ))}
              <FormGrid className="sm:grid-cols-2">
                <CollectionDateField onChange={setNextCollectionDate} value={nextCollectionDate} />
              </FormGrid>
            </div>
          ) : (
            <FormGrid className="sm:grid-cols-2">
              <CorrectionLineFields
                bonus={nextBonus}
                deal={nextDeal}
                discount={nextDiscount}
                onBonus={setNextBonus}
                onDeal={setNextDeal}
                onDiscount={setNextDiscount}
                onQty={setNextQty}
                qty={nextQty}
              />
              <CollectionDateField onChange={setNextCollectionDate} value={nextCollectionDate} />
            </FormGrid>
          )}

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

/** One line's quantity, deal and bonus-or-discount — the same three boxes for every product on the order. */
function CorrectionLineFields({
  qty,
  deal,
  bonus,
  discount,
  onQty,
  onDeal,
  onBonus,
  onDiscount,
}: {
  qty: string;
  deal: "bonus" | "discount";
  bonus: string;
  discount: string;
  onQty: (value: string) => void;
  onDeal: (value: "bonus" | "discount") => void;
  onBonus: (value: string) => void;
  onDiscount: (value: string) => void;
}) {
  return (
    <>
      <FormField label="Quantity" required>
        <input
          className={phxFieldClassName}
          min={1}
          onChange={(event) => onQty(event.target.value)}
          type="number"
          value={qty}
        />
      </FormField>

      <FormField label="Deal" required>
        <select
          className={phxSelectClassName}
          onChange={(event) => onDeal(event.target.value === "discount" ? "discount" : "bonus")}
          value={deal}
        >
          <option value="bonus">Bonus</option>
          <option value="discount">Discount</option>
        </select>
      </FormField>

      {deal === "bonus" ? (
        <FormField label="Bonus units" required>
          <input
            className={phxFieldClassName}
            min={0}
            onChange={(event) => onBonus(event.target.value)}
            type="number"
            value={bonus}
          />
        </FormField>
      ) : (
        <FormField label="Discount %" required>
          <input
            className={phxFieldClassName}
            max={100}
            min={0}
            onChange={(event) => onDiscount(event.target.value)}
            type="number"
            value={discount}
          />
        </FormField>
      )}
    </>
  );
}

/** The order's one money-collection date — it belongs to the order, not to a line. */
function CollectionDateField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <FormField label="Money-collection date" required>
      <input className={phxFieldClassName} onChange={(event) => onChange(event.target.value)} type="date" value={value} />
    </FormField>
  );
}
