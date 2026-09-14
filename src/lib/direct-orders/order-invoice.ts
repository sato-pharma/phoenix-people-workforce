import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import { assertPermission } from "@/lib/auth/permissions";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { isPharmacyConfirmingStep } from "@/lib/direct-orders/approval-flow";
import {
  DIRECT_ORDER_INVOICE_BUCKET,
  parseDirectOrderInvoiceDataUrl,
  type ParsedDirectOrderInvoiceFile,
} from "@/lib/direct-orders/invoice-evidence";
import {
  canAttachDirectOrderInvoice,
  describeDirectOrderInvoiceClaimPlan,
  directOrderRequestInvoicePath,
  planDirectOrderInvoiceClaim,
  shouldRecordInvoiceValidationAtSfeRung,
} from "@/lib/direct-orders/order-invoice-rules";
import {
  getDirectOrderInvoiceSlotCountForRequester,
  requestDirectOrderPharmacyValidation,
} from "@/lib/direct-orders/pharmacy-validation";
import type { DirectOrderPharmacy, DirectOrderRequest, DirectOrderRequestInvoice } from "@/lib/direct-orders/types";
import { forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { canonicalHrIdKey, hrIdForStorage, hrIdLookupKeys } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeVenueType, venueRequiresDistributorCode } from "@/lib/venues/venue-type";

// ─────────────────────────────────────────────────────────────────────────────
// The invoice a rep used, kept with the order (owner, 2026-09-14).
//
// "When the pharmacies validate by invoices goes to SFE to validate it must clearly show the invoice
// pic used." Three doors write it and one screen reads it:
//
//   submit   the photo read on the order form ("Fill from the invoice") is sent with the order.
//   attach   the rep attaches it to an order already sent — held, or still with the SFE Manager.
//            This is how the orders raised before today get their invoice (owner's answer).
//   SFE rung the SFE Manager's approval of a NEW pharmacy counts as that pharmacy's invoice
//            validation, using 1 of the rep's 5 slots (owner's answer).
//
// The decisions themselves are pure, in order-invoice-rules.ts. This module only does the I/O.
// ─────────────────────────────────────────────────────────────────────────────

/** One review sitting, the same lifetime as every other evidence link. */
const ORDER_INVOICE_SIGNED_URL_TTL_SECONDS = 60 * 60;

/** The reason a claim filed from an order's invoice carries. The reviewer reads it on the desk. */
export const DIRECT_ORDER_INVOICE_CLAIM_REASON = "Filed with the distributor invoice attached to the direct order.";

/** Same row shape as service.ts's private insertEvent, canonical actor id included. */
async function insertOrderEvent(input: {
  requestId: string;
  actorHrId: string | null | undefined;
  eventType: string;
  message: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await getSupabaseAdmin()
    .from("direct_order_events")
    .insert({
      request_id: input.requestId,
      actor_hr_id: hrIdForStorage(input.actorHrId),
      event_type: input.eventType,
      message: input.message,
      metadata: input.metadata ?? {},
    });
}

/**
 * Parse the order's invoice, as a 400 the rep can act on. Null when none was sent — an invoice is
 * never required on an order.
 */
export function parseDirectOrderRequestInvoice(dataUrl: unknown, remedy: string): ParsedDirectOrderInvoiceFile | null {
  if (!String(dataUrl ?? "").trim()) return null;
  try {
    return parseDirectOrderInvoiceDataUrl(dataUrl);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "The distributor invoice file is not valid.";
    throw validationError(`${reason} ${remedy}`.trim());
  }
}

/**
 * Store the file and point the order at it.
 *
 * A NEW object per attach, never an overwrite: a replaced invoice must not change the file an
 * earlier decision was made on. A failed row update removes the object it just wrote, so the bucket
 * never holds an invoice no order points at.
 */
async function storeOrderInvoice(
  requestId: string,
  invoice: ParsedDirectOrderInvoiceFile,
): Promise<{ path: string; uploadedAt: string }> {
  const supabase = getSupabaseAdmin();
  const now = new Date();
  const path = directOrderRequestInvoicePath(requestId, invoice.extension, now);
  const { error: uploadError } = await supabase.storage
    .from(DIRECT_ORDER_INVOICE_BUCKET)
    .upload(path, invoice.bytes, { contentType: invoice.contentType, upsert: false });
  if (uploadError) throw uploadError;
  const uploadedAt = now.toISOString();
  const { error: updateError } = await supabase
    .from("direct_order_requests")
    .update({
      invoice_storage_path: path,
      invoice_content_type: invoice.contentType,
      invoice_uploaded_at: uploadedAt,
    })
    .eq("id", requestId);
  if (updateError) {
    await supabase.storage.from(DIRECT_ORDER_INVOICE_BUCKET).remove([path]).catch(() => undefined);
    throw updateError;
  }
  return { path, uploadedAt };
}

/**
 * Store the invoice, record it, and do what it means for the pharmacy. Returns the sentence the rep
 * reads. Storage failures throw; a claim that cannot be filed does NOT — the invoice is already saved
 * and the approvers see it, so the rep is told what did not happen instead of being told nothing did.
 */
async function applyOrderInvoice(
  access: AccessContext,
  input: {
    requestId: string;
    requestStatus: string;
    pharmacyId: string;
    invoice: ParsedDirectOrderInvoiceFile;
    replacing: boolean;
    source: "submit" | "attach";
  },
): Promise<string> {
  const stored = await storeOrderInvoice(input.requestId, input.invoice);
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: input.requestId,
    newValues: {
      invoiceStoragePath: stored.path,
      invoiceContentType: input.invoice.contentType,
      source: input.source,
    },
    summary: `Distributor invoice ${input.replacing ? "replaced" : "attached"} on a direct order by ${access.hrId ?? "unknown"}.`,
  });
  await insertOrderEvent({
    requestId: input.requestId,
    actorHrId: access.hrId,
    eventType: "invoice_attached",
    message: input.replacing
      ? "Replaced the distributor invoice on this order."
      : input.source === "submit"
        ? "Sent the distributor invoice with this order."
        : "Attached the distributor invoice to this order.",
    metadata: { contentType: input.invoice.contentType, source: input.source },
  });

  const supabase = getSupabaseAdmin();
  const [{ data: pharmacyRow }, { count: openClaims, error: openClaimsError }, slots] = await Promise.all([
    supabase
      .from("direct_order_pharmacies")
      .select("pharmacy_name, verification_status, venue_type")
      .eq("id", input.pharmacyId)
      .maybeSingle(),
    supabase
      .from("direct_order_pharmacy_validations")
      .select("id", { count: "exact", head: true })
      .eq("pharmacy_id", input.pharmacyId)
      .eq("status", "pending"),
    getDirectOrderInvoiceSlotCountForRequester(access.hrId ?? ""),
  ]);
  if (openClaimsError) throw openClaimsError;
  const pharmacy = pharmacyRow as { pharmacy_name?: string | null; verification_status?: string | null; venue_type?: string | null } | null;
  if (!pharmacy) return describeDirectOrderInvoiceClaimPlan("not_needed", slots);

  const plan = planDirectOrderInvoiceClaim({
    requestStatus: input.requestStatus,
    pharmacyVerificationStatus: String(pharmacy.verification_status ?? ""),
    venueRequiresDistributorCode: venueRequiresDistributorCode(normalizeVenueType(pharmacy.venue_type)),
    openClaimOnPharmacy: (openClaims ?? 0) > 0,
    slots,
  });
  if (plan !== "file_claim") return describeDirectOrderInvoiceClaimPlan(plan, slots);

  // A HELD order: the invoice is filed as the pharmacy's validation, through the one door every
  // claim uses — its guards (ownership, held status, the five-slot limit) run exactly as they do on
  // the validation screen.
  try {
    await requestDirectOrderPharmacyValidation(access, {
      pharmacyId: input.pharmacyId,
      requestId: input.requestId,
      claimedPharmacyName: String(pharmacy.pharmacy_name ?? "").trim() || "Pharmacy",
      claimedReason: DIRECT_ORDER_INVOICE_CLAIM_REASON,
      photoDataUrl: "",
      validationRoute: "invoice",
      invoiceDataUrl: `data:${input.invoice.contentType};base64,${input.invoice.bytes.toString("base64")}`,
    });
    return describeDirectOrderInvoiceClaimPlan("file_claim", slots);
  } catch (claimError) {
    logError("An order's invoice was saved but could not be filed as the pharmacy's validation", {
      labels: { event: "direct_order_invoice_claim_failed", requestId: input.requestId },
      error: claimError instanceof Error ? claimError : new Error(String(claimError)),
    });
    const reason = claimError instanceof Error ? claimError.message : "the review could not be started";
    return `The invoice is saved with the order, but it could not be sent for review as this pharmacy's validation: ${reason}`;
  }
}

/**
 * The submit door. NEVER throws: the order is already written by the time this runs, and a rep told
 * "could not submit" for an order that went through would submit it twice. A failure is recorded on
 * the order and said to the rep, who can attach the invoice again from the order itself.
 */
export async function saveSubmittedDirectOrderInvoice(
  access: AccessContext,
  input: { requestId: string; requestStatus: string; pharmacyId: string; invoice: ParsedDirectOrderInvoiceFile },
): Promise<string> {
  try {
    return await applyOrderInvoice(access, { ...input, replacing: false, source: "submit" });
  } catch (error) {
    logError("A submitted direct order's invoice could not be saved; the order stands", {
      labels: { event: "direct_order_invoice_save_failed", requestId: input.requestId },
      error: error instanceof Error ? error : new Error(String(error)),
    });
    await insertOrderEvent({
      requestId: input.requestId,
      actorHrId: access.hrId,
      eventType: "invoice_attach_failed",
      message: "The order was submitted, but its distributor invoice could not be saved.",
    }).catch(() => undefined);
    return "The order was submitted, but its invoice could not be saved. Open the order and attach the invoice again.";
  }
}

/**
 * The attach door — the requester adds (or replaces) the invoice on an order already sent.
 *
 * Server-side guards, whatever the screen shows: the permission, OWNERSHIP, and the rule that the
 * invoice can still inform a decision (a held order, or one whose SFE rung has not decided).
 */
export async function attachDirectOrderInvoice(
  access: AccessContext,
  input: { requestId: string; invoiceDataUrl: unknown },
): Promise<{ message: string }> {
  await assertPermission(access, "direct_orders", "create");
  const requestId = String(input.requestId ?? "").trim();
  if (!requestId) throw validationError("The direct order is required.");

  const supabase = getSupabaseAdmin();
  const { data: row, error } = await supabase
    .from("direct_order_requests")
    .select("id, requester_hr_id, status, pharmacy_id, invoice_storage_path")
    .eq("id", requestId)
    .maybeSingle();
  if (error) throw error;
  if (!row) throw notFoundError("That direct order was not found.");
  const order = row as {
    requester_hr_id?: string | null;
    status?: string | null;
    pharmacy_id?: string | null;
    invoice_storage_path?: string | null;
  };
  const requesterKey = canonicalHrIdKey(String(order.requester_hr_id ?? ""));
  if (!requesterKey || requesterKey !== canonicalHrIdKey(access.hrId ?? "")) {
    throw forbiddenError("Forbidden: only the person who raised this order can attach its invoice.");
  }

  const { data: stepRow, error: stepError } = await supabase
    .from("direct_order_approval_steps")
    .select("approver_kind, approver_role")
    .eq("request_id", requestId)
    .eq("status", "pending")
    .order("step_order", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (stepError) throw stepError;
  const step = stepRow as { approver_kind?: string | null; approver_role?: string | null } | null;
  const activeStepConfirmsPharmacy = step
    ? isPharmacyConfirmingStep({
        kind: step.approver_kind === "role" ? "role" : "person",
        role: step.approver_role ? (step.approver_role as PhoenixRole) : null,
      })
    : false;
  const status = String(order.status ?? "");
  if (!canAttachDirectOrderInvoice({ viewerHrKey: canonicalHrIdKey(access.hrId ?? ""), requesterHrKey: requesterKey, status, activeStepConfirmsPharmacy })) {
    throw validationError(
      "The invoice can only be attached while the order is held or still waiting for the SFE Manager. After that, the decision has already been made on what the order carried.",
    );
  }

  const invoice = parseDirectOrderRequestInvoice(input.invoiceDataUrl, "");
  if (!invoice) throw validationError("Attach the distributor invoice.");

  const message = await applyOrderInvoice(access, {
    requestId,
    requestStatus: status,
    pharmacyId: String(order.pharmacy_id ?? ""),
    invoice,
    replacing: Boolean(order.invoice_storage_path),
    source: "attach",
  });
  return { message };
}

/** The order's invoice as an approver sees it: a signed link, and the requester's slot count when it matters. */
export async function loadDirectOrderRequestInvoice(
  request: DirectOrderRequest,
  options: { countRequesterSlots: boolean },
): Promise<DirectOrderRequestInvoice | null> {
  const path = request.invoiceStoragePath;
  const contentType = request.invoiceContentType;
  if (!path || !contentType) return null;
  const [signed, requesterSlots] = await Promise.all([
    getSupabaseAdmin().storage.from(DIRECT_ORDER_INVOICE_BUCKET).createSignedUrl(path, ORDER_INVOICE_SIGNED_URL_TTL_SECONDS),
    options.countRequesterSlots
      ? getDirectOrderInvoiceSlotCountForRequester(request.requesterHrId).catch(() => null)
      : Promise.resolve(null),
  ]);
  return {
    url: signed.data?.signedUrl ?? null,
    contentType,
    uploadedAt: request.invoiceUploadedAt ?? null,
    requesterSlots,
  };
}

/**
 * The SFE rung door. Called after the SFE Manager's approval confirmed the order's pharmacy, with the
 * pharmacy AS IT WAS BEFORE that approval.
 *
 * Records the pharmacy as validated on the order's invoice — decided by the SFE Manager who actually
 * approved it, never by the system — so it holds 1 of the rep's 5 slots exactly like a claim decided
 * on the desk. Over the limit nothing is counted and the order says so: the approval stands, because
 * the system flags and never blocks.
 *
 * POST-COMMIT, like the confirmation it follows: every failure is logged and swallowed, never
 * reported as a failed approval.
 */
export async function recordDirectOrderInvoiceValidationAtSfeRung(
  access: AccessContext,
  input: { request: DirectOrderRequest; pharmacyBeforeApproval: DirectOrderPharmacy | null },
): Promise<void> {
  const { request, pharmacyBeforeApproval: pharmacy } = input;
  try {
    if (!pharmacy || pharmacy.verificationStatus !== "pending_review") return;
    if (!request.invoiceStoragePath || !request.invoiceContentType) return;

    const supabase = getSupabaseAdmin();
    const requesterKeys = hrIdLookupKeys(request.requesterHrId).filter(Boolean);
    const [{ count: heldClaims, error: heldClaimsError }, slots] = await Promise.all([
      supabase
        .from("direct_order_pharmacy_validations")
        .select("id", { count: "exact", head: true })
        .eq("pharmacy_id", pharmacy.id)
        .eq("validation_route", "invoice")
        .in("status", ["pending", "approved_new", "matched_existing"])
        .in("requested_by_hr_id", requesterKeys.length > 0 ? requesterKeys : [""]),
      getDirectOrderInvoiceSlotCountForRequester(request.requesterHrId),
    ]);
    if (heldClaimsError) throw heldClaimsError;

    const distributorVenue = venueRequiresDistributorCode(pharmacy.venueType);
    const record = shouldRecordInvoiceValidationAtSfeRung({
      pharmacyWasPendingReview: true,
      orderHasInvoice: true,
      venueRequiresDistributorCode: distributorVenue,
      requesterAlreadyHoldsInvoiceClaim: (heldClaims ?? 0) > 0,
      slots,
    });
    if (!record) {
      if (distributorVenue && (heldClaims ?? 0) === 0 && slots.used >= slots.limit) {
        await insertOrderEvent({
          requestId: request.id,
          actorHrId: access.hrId,
          eventType: "invoice_slot_not_counted",
          message: `The pharmacy was confirmed with this order's invoice, but the requester already had ${slots.used} of ${slots.limit} pharmacies validated by invoice, so it was not counted as one.`,
          metadata: { slotsUsed: slots.used, slotLimit: slots.limit },
        });
      }
      return;
    }

    const decidedAt = new Date().toISOString();
    const { data: inserted, error: insertError } = await supabase
      .from("direct_order_pharmacy_validations")
      .insert({
        pharmacy_id: pharmacy.id,
        request_id: request.id,
        requested_by_hr_id: hrIdForStorage(request.requesterHrId),
        claimed_pharmacy_name: pharmacy.pharmacyName,
        claimed_reason: DIRECT_ORDER_INVOICE_CLAIM_REASON,
        requester_area_code: pharmacy.areaCode,
        validation_route: "invoice",
        status: "approved_new",
        decided_by_hr_id: hrIdForStorage(access.hrId),
        decided_at: decidedAt,
        decision_notes: "Confirmed by approving the direct order that carried this invoice.",
        invoice_storage_path: request.invoiceStoragePath,
        invoice_content_type: request.invoiceContentType,
        invoice_uploaded_at: request.invoiceUploadedAt ?? decidedAt,
      })
      .select("id")
      .single();
    if (insertError) throw insertError;

    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? access.hrId,
      entityType: "direct_order_request",
      entityId: `validation:${String((inserted as { id: string }).id)}`,
      newValues: { pharmacyId: pharmacy.id, status: "approved_new", validationRoute: "invoice", requestId: request.id },
      summary: `${pharmacy.pharmacyName} recorded as validated by invoice when ${access.hrId ?? "unknown"} approved the direct order that carried it.`,
    });
    await insertOrderEvent({
      requestId: request.id,
      actorHrId: access.hrId,
      eventType: "invoice_slot_counted",
      message: `Counted as ${slots.used + 1} of ${slots.limit} pharmacies the requester validated by invoice — the pharmacy was confirmed with the invoice on this order.`,
      metadata: { slotsUsed: slots.used + 1, slotLimit: slots.limit },
    });
  } catch (error) {
    logError("Recording an order's invoice as the pharmacy's validation failed; the approval stands", {
      labels: { event: "direct_order_invoice_slot_record_failed", requestId: request.id },
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
}
