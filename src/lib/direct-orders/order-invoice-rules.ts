import {
  directOrderInvoiceSlotLabel,
  directOrderInvoiceSlotsFullMessage,
  type DirectOrderInvoiceSlotCount,
} from "@/lib/direct-orders/invoice-evidence";

// ─────────────────────────────────────────────────────────────────────────────
// The invoice a rep used, kept with the order (owner, 2026-09-14).
//
// "When the pharmacies validate by invoices goes to SFE to validate it must clearly show the invoice
// pic used." Reps read the distributor invoice on the order form, and that reader stored nothing —
// so the SFE Manager decided new pharmacies with no invoice in front of them. The invoice is now
// saved on the order, and for a NEW pharmacy it also counts as that pharmacy's invoice validation,
// using 1 of the rep's 5 slots (the owner's answer).
//
// Pure and dependency-free on purpose, like hold-decision.ts: the test runner executes these rules
// rather than reading the source and hoping.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What saving an invoice on an order does for the order's PHARMACY.
 *
 *   file_claim             a HELD order: file an invoice validation claim, which holds a slot and
 *                          is what revives the order once it is approved.
 *   sfe_confirms_on_order  an order already WITH its approvers: the SFE Manager's rung confirms the
 *                          pharmacy, so a second review on the desk would decide the same thing
 *                          twice. The slot is taken when they approve.
 *   slots_full             five pharmacies already stand on the rep's invoices — no sixth. The file
 *                          is still saved, so the approvers still see it.
 *   claim_already_open     a validation for this pharmacy is already waiting for a decision.
 *   no_distributor_account a venue with no distributor has no distributor invoice to validate it.
 *   not_needed             the pharmacy is already confirmed (or was ruled false).
 */
export type DirectOrderInvoiceClaimPlan =
  | "file_claim"
  | "sfe_confirms_on_order"
  | "slots_full"
  | "claim_already_open"
  | "no_distributor_account"
  | "not_needed";

export function planDirectOrderInvoiceClaim(input: {
  requestStatus: string;
  pharmacyVerificationStatus: string;
  venueRequiresDistributorCode: boolean;
  /** Any validation for this pharmacy still `pending`. One open claim per pharmacy, by index. */
  openClaimOnPharmacy: boolean;
  slots: DirectOrderInvoiceSlotCount;
}): DirectOrderInvoiceClaimPlan {
  if (input.pharmacyVerificationStatus !== "pending_review") return "not_needed";
  if (!input.venueRequiresDistributorCode) return "no_distributor_account";
  if (input.openClaimOnPharmacy) return "claim_already_open";
  // THE LIMIT (owner, 2026-09-14): no sixth pharmacy on an invoice alone until a slot opens.
  if (input.slots.used >= input.slots.limit) return "slots_full";
  return input.requestStatus === "held" ? "file_claim" : "sfe_confirms_on_order";
}

/**
 * Should the SFE Manager's approval of this order record the pharmacy as validated by invoice?
 *
 * Only when their approval is what confirmed a NEW pharmacy, the order carries the invoice, and the
 * rep still has a free slot. Over the limit the approval still stands — the system flags, it never
 * blocks — but it is not counted as an invoice validation, because a sixth is exactly what the limit
 * refuses.
 */
export function shouldRecordInvoiceValidationAtSfeRung(input: {
  pharmacyWasPendingReview: boolean;
  orderHasInvoice: boolean;
  venueRequiresDistributorCode: boolean;
  /** The rep already holds an invoice claim for this pharmacy — pending or confirmed. */
  requesterAlreadyHoldsInvoiceClaim: boolean;
  slots: DirectOrderInvoiceSlotCount;
}): boolean {
  return (
    input.pharmacyWasPendingReview &&
    input.orderHasInvoice &&
    input.venueRequiresDistributorCode &&
    !input.requesterAlreadyHoldsInvoiceClaim &&
    input.slots.used < input.slots.limit
  );
}

/**
 * May this viewer attach (or replace) the invoice on this order?
 *
 * The requester only, and only while the invoice can still inform a decision: a held order, or an
 * order whose pharmacy-confirming rung (the SFE Manager) has not decided yet. Once that rung has
 * approved, swapping the file would change what the decision was made on.
 */
export function canAttachDirectOrderInvoice(input: {
  viewerHrKey: string | null | undefined;
  requesterHrKey: string | null | undefined;
  status: string;
  activeStepConfirmsPharmacy: boolean;
}): boolean {
  const viewer = String(input.viewerHrKey ?? "").trim();
  if (!viewer || viewer !== String(input.requesterHrKey ?? "").trim()) return false;
  if (input.status === "held") return true;
  return input.status === "pending_approval" && input.activeStepConfirmsPharmacy;
}

/** A fresh object name per attach, so a replaced invoice never overwrites the file a decision used. */
export function directOrderRequestInvoicePath(requestId: string, extension: string, now: Date): string {
  return `orders/${requestId}/${now.getTime()}.${extension}`;
}

/** The sentence the rep reads after the invoice is saved. Never a bare plan code. */
export function describeDirectOrderInvoiceClaimPlan(
  plan: DirectOrderInvoiceClaimPlan,
  slots: DirectOrderInvoiceSlotCount,
): string {
  switch (plan) {
    case "file_claim":
      return `The invoice is saved with the order and sent for review as this pharmacy's validation. ${directOrderInvoiceSlotLabel({ used: Math.min(slots.used + 1, slots.limit), limit: slots.limit })}.`;
    case "sfe_confirms_on_order":
      return "The invoice is saved with the order. The SFE Manager sees it when they check the pharmacy, and once they approve it counts as 1 of your 5 pharmacies validated by invoice.";
    case "slots_full":
      return `The invoice is saved with the order and your approvers see it, but it cannot validate this pharmacy. ${directOrderInvoiceSlotsFullMessage(slots)}`;
    case "claim_already_open":
      return "The invoice is saved with the order. This pharmacy already has a validation waiting for review.";
    case "no_distributor_account":
    case "not_needed":
    default:
      return "The invoice is saved with the order for your approvers.";
  }
}
