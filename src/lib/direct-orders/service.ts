import { countOf } from "@/lib/i18n/format";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
// Pure, JSX-free threshold module (it says so at the top of the file, and the plain-TS test loader
// imports it directly) — so a server service can use it without dragging a component in.
import { APPROVALS_SLA_THRESHOLDS, slaTone } from "@/components/approvals-hub/sla-thresholds";
import { loadAlsoKnownAsBatch } from "@/lib/customer-identity/server/profile";
import { ceoHrIds } from "@/lib/employees/role-lookup";
import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import {
  assertPermission,
  normalizeHrId,
  resolveEmployeeIdentityId,
  resolveNavigationMode,
  systemAccessContext,
} from "@/lib/auth/permissions";
import {
  getEmployeeDirectory,
  getEmployeeDirectoryRows,
  isActiveLifecycleStatus,
  type EmployeeDirectoryData,
  type EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import { canonicalHrIdKey, hrIdForStorage, hrIdLookupKeys } from "@/lib/hr-id";
import { ApiError, conflictError, validationError } from "@/lib/http/api-errors";
import { isUuid } from "@/lib/http/uuid";
import { notifyConversationMessage } from "@/lib/conversations/notify";
import {
  insertRecordConversationComment,
  listRecordConversation,
  listRecordConversationAuthors,
  type RecordConversationComment,
} from "@/lib/conversations/comments";
import { assertPharmacyRegistryAccess, canManagePharmacyRegistry } from "@/lib/direct-orders/registry-access";
import {
  assertVenueContactInScope,
  describeVenueContacts,
  parseVenueContactId,
  type VenueContactOption,
} from "@/lib/direct-orders/venue-contact-options";
import { createSystemNotificationForRecipients, type SystemNotificationChannel } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { canonicalizeRegionName, resolveSalesAccessScope } from "@/lib/sales/access-scope";
import { customerGeographyKey, resolveCustomerGeography } from "@/lib/sales/customer-geography";
import { listSourceOfSalesProducts, loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import {
  isSalesPeriodReleasedCompanyWide,
  loadSalesReleaseKeys,
  readsUnpublishedSalesTools,
} from "@/lib/sales/unpublished-sales-access";
import { resolveRegionalManagerRegionCodes } from "@/lib/sales/portal-sos-dashboard";
import {
  ilikeAnyFilter,
  ilikeContainsPattern,
  ilikeContainsValue,
  quotedInList,
} from "@/lib/supabase/search-filter";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  normalizeVenueType,
  parseVenueTypeChoice,
  VENUE_TYPE_UNANSWERED_MESSAGE,
  venueRequiresDistributorCode,
  venueTypeIsAnswered,
  venueTypeLabel,
} from "@/lib/venues/venue-type";
import { resolveSubmittedCampaignId } from "@/lib/direct-orders/campaign-link";
import { pingDirectOrderSheet } from "@/lib/direct-orders/sheet-webhook";
import { afterResponse } from "@/lib/http/after-response";
import { invalidateFinanceDashboardCache } from "@/lib/dashboard/invalidation";
import { loadOffsetTotalForOrder } from "@/lib/direct-orders/marketing-offset-service";
import { deriveRemainingWhenCollectionCleared } from "@/lib/direct-orders/offset-rules";
import {
  joinDirectOrderBasketUnits,
  summarizeDirectOrderBasket,
  type DirectOrderBasketLine,
} from "@/lib/direct-orders/basket-label";
import { resolveCorrectionExtraLines } from "@/lib/direct-orders/correction-lines";
import { canCancelHeldDirectOrder } from "@/lib/direct-orders/cancel-visibility";
import {
  canViewDirectOrderEvidenceAiNote,
  canViewDirectOrderFieldEvidenceGap,
} from "@/lib/direct-orders/validation-visibility";
import {
  getDirectOrderPharmacyValidationForRequest,
  loadDirectOrderVenueFieldEvidence,
} from "@/lib/direct-orders/pharmacy-validation";
import { loadDirectOrderVenueValidationPhotos } from "@/lib/direct-orders/venue-validation-photos";
import { loadSamePharmacyFlagForDirectOrder } from "@/lib/direct-orders/same-pharmacy-cross-use-loader";
import { directOrderFieldEvidenceGap } from "@/lib/direct-orders/field-evidence-gap";
import { isCertainWholesalerVenue } from "@/lib/venues/wholesaler-venue-guard";
import { resolveDirectOrderPharmacyValidationBadge } from "@/lib/direct-orders/pharmacy-validation-badge";
import { isDirectOrderInvoiceContentType } from "@/lib/direct-orders/invoice-evidence";
import {
  loadDirectOrderRequestInvoice,
  parseDirectOrderRequestInvoice,
  recordDirectOrderInvoiceValidationAtSfeRung,
  saveSubmittedDirectOrderInvoice,
} from "@/lib/direct-orders/order-invoice";
import { canAttachDirectOrderInvoice } from "@/lib/direct-orders/order-invoice-rules";
import { daysWaitingSince, pickLatestReturnPerRequest } from "@/lib/direct-orders/returned-ageing";
import {
  canonicalPharmacyMap,
  DEDUPE_OPEN_STATUSES,
  findDuplicateRequestGroups,
  findLookAlikeVenues,
  groupDuplicatePharmacies,
  type PharmacyMergeEvidence,
  type VenueLookAlikeBlocker,
} from "@/lib/direct-orders/duplicate-resolution";
import {
  customerCodesMatch,
  decideDirectOrderAutoLink,
  decideDirectOrderHold,
  describeDirectOrderHoldGround,
  isDirectOrderHistoryProductVisible,
  type DirectOrderAutoLinkRefusal,
  type DirectOrderHoldCandidateCode,
  type DirectOrderHoldConflict,
  type DirectOrderHoldGround,
} from "@/lib/direct-orders/hold-decision";
import { checkDirectOrderGeography, type DirectOrderPhotoTerritory } from "@/lib/direct-orders/geography-check";
import { loadBrickCentroids, resolveBrickForPoint } from "@/lib/crm/brick-geo";
import { refreshSharedTradeCounterparties } from "@/lib/crm/shared-windows";
import { extraDirectOrderAreaCodes } from "@/lib/direct-orders/extra-area-grants";
import {
  canRecordDirectOrderCollection,
  deriveDirectOrderCollection,
  DIRECT_ORDER_FINANCE_HR_ID,
  todayInCairo,
} from "@/lib/direct-orders/collection-rules";
import {
  canAssignDirectOrderSalesMonth,
  canSettleServiceFeeAsAdministrator,
  deriveDirectOrderSalesMonthChange,
} from "@/lib/direct-orders/finance-authority";
import {
  assertSalesMonthBookingAllowed,
  describeSalesMonthShift,
  periodsTouchedBySalesMonthChange,
  resolveSalesMonthBooking,
} from "@/lib/direct-orders/sales-month-lock-guard";
import { listLockedPeriodsForLine } from "@/lib/sales/monthly-closing-lock";
import { describeDirectOrderStatus, describeReturnedDirectOrderWait } from "@/lib/direct-orders/status-labels";
import type { DirectOrderQueueRow } from "@/lib/direct-orders/needs-action";
import {
  clampDirectOrderPage,
  clampDirectOrderPageSize,
  looksLikeDirectOrderId,
  requesterCandidatesExceedUrlBudget,
  resolveDirectOrderScopePredicate,
  resolveDirectOrderStatusGroup,
  resolveDirectOrderStatusGroupFilter,
  type DirectOrderOperationalFilters,
  type DirectOrderOperationalPage,
} from "@/lib/direct-orders/operational-query";
import { isHeadOfficeLine, RESTRICTED_PRODUCT_CODES } from "@/lib/sales/access-scope";
import {
  familyKey,
  validateDirectOrderBasket,
} from "@/lib/direct-orders/product-family";
import { fetchAllRows } from "@/lib/supabase/paginated";
import {
  describeDirectOrderPharmacyStanding,
  normalizeDirectOrderTrustState,
} from "@/lib/direct-orders/pharmacy-standing";

import {
  computeDirectOrderSalesValue,
  computeDiscountSalesValue,
  decidedStatusPatch,
  directOrderChainMissingManagementLine,
  directOrderRoleRequiresManagementLine,
  evaluateStepAction,
  SFE_VALIDATION_ROLE,
  isPharmacyConfirmingStep,
  maxBonusUnits,
  resolveActiveStep,
  validateBonus,
  validateDiscount,
} from "@/lib/direct-orders/approval-flow";
import {
  loadDirectOrderCaps,
  resolveBonusCapPct,
  resolveDiscountCapPct,
  type DirectOrderCaps,
} from "@/lib/direct-orders/caps";
import {
  buildDirectOrderNotificationLine,
  buildDirectOrderNotificationMetrics,
  type DirectOrderNotifyContext,
} from "@/lib/direct-orders/approval-fields";
import {
  codeNameLabel,
  formatDistributorCodesText,
  formatDistributorNames,
  loadDirectOrderGeoNames,
  resolveDirectOrderGeo,
  toDistributorRows,
} from "@/lib/direct-orders/geo-names";
import { resolveAreaRep, resolveAreaRepsForLineAreas, areaRepKey, type AreaRepAssignment } from "@/lib/employees/area-rep-resolver";
import {
  DIRECT_ORDER_REQUESTER_ROLES,
  isDirectOrderRequesterRole,
  normalizePharmacyVerificationStatus,
  type DirectOrderApprovalDetail,
  type DirectOrderAreaRep,
  type DirectOrderPharmacyGeo,
  type DirectOrderPharmacyHistoryRow,
  type DirectOrderRetailHistoryRow,
  type DirectOrderApprovalListItem,
  type DirectOrderPossibleDistributorMatch,
  type DirectOrderDealType,
  type DirectOrderDecision,
  type DirectOrderContestedCodeClaim,
  type DirectOrderPharmacy,
  type DirectOrderPharmacyDistributorCode,
  type DirectOrderPharmacyPreflight,
  type DirectOrderReportRow,
  type DirectOrderReportScope,
  type DirectOrderRequest,
  type DirectOrderRequestItem,
  type DirectOrderStatus,
  type DirectSalesReconciliationResult,
  type DirectOrderStepState,
  type DirectOrderWorkspaceData,
} from "@/lib/direct-orders/types";
import { assertDirectOrderWorkflowTransition, directOrderDecisionAction } from "@/lib/direct-orders/workflow";
import { sendDirectOrderApprovedEmail } from "@/lib/direct-orders/approved-email";

const NOTIFY_CHANNELS: SystemNotificationChannel[] = ["in_app", "email", "telegram"];
const CHAIN_DEPTH_CAP = 6;

function badRequest(message: string): never {
  throw validationError(message);
}

/** The acting user's HR_ID, guaranteed non-null (authenticated requester/approver). */
function requireActorHrId(access: AccessContext): string {
  const hrId = access.hrId;
  if (!hrId) badRequest("Your account has no HR ID; cannot act on direct orders.");
  return hrId;
}

/**
 * True when a request's bonus (or discount) exceeds its product's configured cap.
 *
 * This is a FLAG, never a gate (owner rule, 2026-08-03): it surfaces as "over cap" in every
 * list and detail view, tags the approver's notification, and is recorded as an event when
 * such a request is finalized — but it never blocks submission and never blocks a decision.
 * The chain already always ends at the CEO rung regardless.
 *
 * Derived on read rather than persisted, because a cap is CONFIG: re-reading it means the
 * badge always reflects today's cap rather than the cap that happened to apply at submit time.
 */
function isRequestOverCap(
  request: Pick<DirectOrderRequest, "dealType" | "discountPct" | "bonus" | "qty" | "productCode">,
  caps: DirectOrderCaps,
): boolean {
  return request.dealType === "discount"
    ? (request.discountPct ?? 0) > resolveDiscountCapPct(caps, request.productCode)
    : request.bonus > maxBonusUnits({ qty: request.qty, capPct: resolveBonusCapPct(caps, request.productCode) });
}

/** Convert the resolver's assignment into the view-model shape (null = no seat, "we cannot say"). */
function toDirectOrderAreaRep(assignment: AreaRepAssignment | null | undefined): DirectOrderAreaRep {
  if (!assignment) return { resolved: false, isVacant: false, repHrId: null, repName: null, repNames: [] };
  return {
    resolved: true,
    isVacant: assignment.isVacant,
    repHrId: assignment.repHrId,
    repName: assignment.repName,
    repNames: assignment.repNames,
  };
}

/**
 * Assemble everything the approver's notification names: pharmacy, geography as NAMES, the
 * area's medical rep and the distributor pairs. Best-effort — every lookup inside fails soft,
 * because a notification must never be the reason a submission or a decision fails.
 */
async function buildNotifyContext(
  request: DirectOrderRequest,
  requesterName: string,
  pharmacy: DirectOrderPharmacy | null,
): Promise<DirectOrderNotifyContext> {
  // `nameOf` is REQUIRED, not optional polish: without it selectAreaRepsFromSeats falls back to
  // the raw HR_ID, and a real notification went out reading "Medical rep pd-0005" instead of the
  // rep's name. The approval WINDOW always passed a lookup in, so the two paths disagreed and
  // only the notification leaked an id.
  const nameOf = await nameLookup();
  const [geoMaps, rep] = await Promise.all([
    loadDirectOrderGeoNames(),
    resolveAreaRep({ line: request.line, areaCode: pharmacy?.areaCode ?? null }, { nameOf }),
  ]);
  return {
    request,
    requesterName,
    pharmacyName: pharmacy?.pharmacyName ?? "",
    pharmacyCode: pharmacy?.phoenixPharmacyCode ?? "",
    geo: resolveDirectOrderGeo(pharmacy, geoMaps),
    medicalRep: toDirectOrderAreaRep(rep),
    distributorCodesText: formatDistributorCodesText(pharmacy?.distributorCodes),
    distributorNames: formatDistributorNames(pharmacy?.distributorCodes),
  };
}

// ── Recipient resolution ──────────────────────────────────────────────────────

/** All HR_IDs holding a given role (from app_auth_users). */
async function hrIdsForRole(role: PhoenixRole): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("app_auth_users").select("hr_id").eq("role", role);
  if (error) return [];
  return ((data ?? []) as Array<{ hr_id: string | null }>)
    .map((row) => normalizeHrId(row.hr_id))
    .filter((id): id is string => Boolean(id));
}

/** SFE Manager + Super Admin are CC'd on every direct-order transition. */
async function ccRecipients(): Promise<string[]> {
  const [sfe, admins] = await Promise.all([hrIdsForRole("SFE Manager"), hrIdsForRole("Super Admin")]);
  return [...sfe, ...admins];
}

async function notifyDirectOrder(input: {
  recipients: Array<string | null | undefined>;
  title: string;
  message: string;
  eventType: string;
  requestId: string;
  subjectHrId: string;
  href?: string;
  /**
   * Label/value rows for the notification EMAIL's details table. The `message` string has to
   * survive Telegram's 900-char hard slice, so the full pharmacy / geography / distributor
   * picture rides here instead of being crammed into the body.
   */
  metrics?: Array<{ label: string; value: string }>;
  /**
   * Extra qualifier on the idempotency key, for events that legitimately REPEAT.
   *
   * The key is otherwise `requestId + eventType`, which is right for once-per-request events
   * (submitted, approved) — a retry must not double-send. But a held notice is a reminder the
   * System Admin may fire again next week, and with the bare key that second send would be
   * silently swallowed as a duplicate: the desk would report "sent" and the rep would receive
   * nothing. Callers that repeat pass a qualifier (the date) so each round is its own event.
   */
  idempotencySuffix?: string;
  /**
   * Overrides NOTIFY_CHANNELS for events where in-app/Telegram should still reach the usual
   * recipients but an email is not warranted (e.g. cancelling one's own held order) — dropping
   * "email" here, not the recipients, is what keeps that distinction possible.
   */
  channels?: SystemNotificationChannel[];
}): Promise<void> {
  // The LIVE order route, not the retired approvals one.
  //
  // `/admin/approvals/direct-orders/:id` still resolves — next.config.ts redirects it permanently —
  // so this was working. But it minted a retired URL into every notification row and every email,
  // and an email is the one artefact that outlives the redirect that rescues it. resolveHref()
  // still remaps this to the reader's own shell; it now has a current path to remap.
  const href = input.href ?? `/admin/direct-orders/${encodeURIComponent(input.requestId)}`;
  // Order matters: the FIRST recipient is the concerned person and becomes the email's To;
  // everyone after is Cc (owner rule, 2026-08-04: one email per event, never N copies). Call
  // sites already lead with the requester / the acting approver. In-app and Telegram remain
  // per-person — those are each recipient's own inbox items, not duplicate copies.
  const recipientHrIds = Array.from(
    new Map(
      input.recipients
        .map((r) => normalizeHrId(r) ?? "")
        .filter(Boolean)
        .map((hrId) => [canonicalHrIdKey(hrId) ?? hrId, hrId] as const),
    ).values(),
  );
  if (recipientHrIds.length === 0) return;
  // createSystemNotificationForRecipients consolidates email into ONE To/Cc envelope and
  // suffixes the idempotency key per recipient itself — looping createSystemNotification here
  // is exactly the per-recipient-copies bug it was built to close (2026-07-22).
  await createSystemNotificationForRecipients(
    {
      channels: input.channels ?? NOTIFY_CHANNELS,
      actionUrl: href,
      category: "direct_order_request",
      email: input.metrics?.length ? { metrics: input.metrics } : undefined,
      eventType: input.eventType,
      message: input.message,
      metadata: {
        employeeHrId: input.subjectHrId,
        directOrderId: input.requestId,
        // A lone recipient gets the per-person suffix createSystemNotificationForRecipients puts on
        // every key of a group. Without it each approval rung's single-recipient call upserted the
        // SAME event row, so the next rung rewrote employee_hr_id/recipients and the previous
        // approver's notice lost its owner: 234 in-app deliveries by 2026-10-23 that no bell could open.
        idempotencyKey: `direct_orders:${input.requestId}:${input.eventType}${input.idempotencySuffix ? `:${input.idempotencySuffix}` : ""}${recipientHrIds.length === 1 ? `:${recipientHrIds[0]}` : ""}`,
      },
      module: "direct_orders",
      priority: "high",
      subjectHrId: input.subjectHrId,
      title: input.title,
    },
    recipientHrIds,
  );
}

// ── Approval chain resolution (requester's actual managers → CEO) ─────────────

function directoryLookup(directory: EmployeeDirectoryData) {
  const byHr = new Map<string, EmployeeDirectoryRow>();
  for (const employee of directory.employees) {
    const key = canonicalHrIdKey(employee.hrId);
    if (key) byHr.set(key, employee);
  }
  return (hrId: string | null | undefined) => {
    const key = canonicalHrIdKey(hrId ?? "");
    return key ? byHr.get(key) ?? null : null;
  };
}

/**
 * Build the ordered approval chain. Sales roles climb their ACTUAL manager chain
 * (managerHrId) up to — but not including — the CEO; Product/Group-Product Managers
 * go straight to the CEO. The final rung is always the CEO resolved by role.
 */
async function buildApprovalChain(input: {
  requesterHrId: string;
  requesterRole: PhoenixRole;
}): Promise<Array<Omit<DirectOrderStepState, "status">>> {
  const directory = await getEmployeeDirectory();
  const lookup = directoryLookup(directory);
  const ceoKeys = new Set((await ceoHrIds()).map((id) => canonicalHrIdKey(id)).filter(Boolean) as string[]);
  const isCeo = (hrId: string | null | undefined) => {
    const key = canonicalHrIdKey(hrId ?? "");
    return key ? ceoKeys.has(key) : false;
  };

  const rungs: Array<Omit<DirectOrderStepState, "status" | "order">> = [];
  // SFE Manager validates FIRST, ahead of the sales line (owner rule, 2026-08-03). A ROLE rung
  // like the CEO's — whoever currently holds SFE Manager acts on it — so it survives a change of
  // post-holder without touching any in-flight request.
  rungs.push({ kind: "role", role: SFE_VALIDATION_ROLE, approverHrId: null, label: "SFE Manager" });

  // An unrecognised pharmacy adds NO rung (owner rule, 2026-08-04: "remove the super admin from
  // the approval workflow of the direct orders"). SFE was always the one who could say whether the
  // pharmacy should exist at all, so confirming its codes rides on the rung above rather than
  // waiting for a second person — see `isPharmacyConfirmingStep` in approval-flow.ts.

  const straightToCeo =
    input.requesterRole === "Product Manager" || input.requesterRole === "Group Product Manager";

  if (!straightToCeo) {
    const me = lookup(input.requesterHrId);
    let cursor = me?.managerHrId ?? null;
    const seen = new Set<string>();
    let guard = 0;
    while (cursor && guard < CHAIN_DEPTH_CAP) {
      const key = canonicalHrIdKey(cursor);
      if (!key || seen.has(key)) break; // cycle guard
      seen.add(key);
      if (isCeo(cursor)) break; // stop before the CEO — added as the final role rung
      const manager = lookup(cursor);

      // CREATE AND FLAG (owner decision, 2026-08-12). `manager` is undefined when someone's
      // manager_hr_id points at an HR_ID the employee directory does not carry — a departed or
      // mistyped record. Two things used to happen here, both silently:
      //
      //   1. the rung was still created, bound to that raw HR_ID and labelled "Manager", so it was
      //      indistinguishable from a healthy rung — and NOBODY can act on it, because no session
      //      ever resolves to an HR_ID that is not in the directory;
      //   2. `cursor` became null, so every rung ABOVE the break vanished and the request jumped
      //      straight to the CEO having skipped its management line.
      //
      // The rung is still created (refusing would block a requester over someone else's missing
      // record), but it now SAYS it is broken, in the label the order detail and Needs Action
      // render, and it is logged so a directory repair can be scheduled rather than discovered
      // when an order stalls.
      //
      // THE TRUNCATION IS NOT FIXABLE HERE. Without that record there is no next manager_hr_id to
      // climb to, so the rungs above cannot be reconstructed — flagging makes the break visible,
      // it does not repair the chain. That is why the log names the request's requester too.
      //
      // NOT hierarchy-resolver.ts: `resolveReportingSeatHrId` prefers `pendingManagerReplacementForHrId`,
      // the DEPARTED manager's HR_ID, because it exists for org-chart GROUPING. Using it here would
      // address the rung to someone who has resigned. The resignation trigger reassigns
      // `manager_hr_id` upward precisely so an ACTIVE person can act, so raw `managerHrId` is right.
      if (!manager) {
        logError("Direct order approval chain hit an unresolvable manager; the chain is short", {
          labels: {
            event: "direct_order_chain_unresolved_manager",
            requesterHrId: input.requesterHrId,
            unresolvedManagerHrId: cursor,
          },
        });
      }

      rungs.push({
        kind: "person",
        role: null,
        approverHrId: manager?.hrId ?? cursor,
        label: manager?.jobTitle?.trim() || (manager ? "Manager" : `Unresolved manager (${cursor})`),
      });
      cursor = manager?.managerHrId ?? null;
      guard += 1;
    }

    // The climb produced NOTHING for a requester who is owed a management rung — the request is
    // about to go SFE -> CEO with no sales manager on it at all. This is the one case the loop
    // above cannot report: its "unresolvable manager" log lives INSIDE the loop, so it only fires
    // when a chain breaks part-way up. When the requester has no manager_hr_id at all the loop
    // never runs, and until 2026-08-19 that produced a CEO-only chain in complete silence — six
    // requests were built that way on 3-4 August 2026, and one of them was approved.
    //
    // Logged, not blocked (owner decision, 2026-08-19): refusing the submission would stop a
    // requester working over somebody else's missing HR record. The flag then rides on the request
    // for the approver to see — see directOrderChainMissingManagementLine.
    if (directOrderRoleRequiresManagementLine(input.requesterRole) && !rungs.some((rung) => rung.kind === "person")) {
      logError("Direct order approval chain has no management line; it will climb straight to the CEO", {
        labels: {
          event: "direct_order_chain_missing_management_line",
          requesterHrId: input.requesterHrId,
          requesterRole: input.requesterRole,
        },
      });
    }
  }
  rungs.push({ kind: "role", role: "CEO", approverHrId: null, label: "CEO" });
  return rungs.map((rung, index) => ({ ...rung, order: index + 1 }));
}

// ── Row mappers ───────────────────────────────────────────────────────────────

function mapRequestRow(row: Record<string, unknown>): DirectOrderRequest {
  return {
    id: String(row.id),
    requesterHrId: String(row.requester_hr_id),
    requesterRole: String(row.requester_role) as PhoenixRole,
    status: String(row.status) as DirectOrderRequest["status"],
    line: String(row.line ?? ""),
    productCode: String(row.product_code ?? ""),
    productName: String(row.product_name ?? ""),
    familyCode: String(row.family_code ?? ""),
    pharmacyPriceSnapshot: row.pharmacy_price_snapshot == null ? null : Number(row.pharmacy_price_snapshot),
    qty: Number(row.qty ?? 0),
    bonus: Number(row.bonus ?? 0),
    bonusOverrideReason: row.bonus_override_reason ? String(row.bonus_override_reason) : null,
    dealType: String(row.deal_type ?? "bonus") === "discount" ? "discount" : "bonus",
    discountPct: row.discount_pct == null ? null : Number(row.discount_pct),
    publicPriceSnapshot: row.public_price_snapshot == null ? null : Number(row.public_price_snapshot),
    salesValue: Number(row.sales_value ?? 0),
    pharmacyId: String(row.pharmacy_id),
    salesMonth: row.sales_month ? String(row.sales_month) : null,
    collectionDate: row.collection_date ? String(row.collection_date) : null,
    heldAt: row.held_at ? String(row.held_at) : null,
    marketingRequestId: row.marketing_request_id ? String(row.marketing_request_id) : null,
    paymentDate: row.payment_date ? String(row.payment_date) : null,
    paidAmount: row.paid_amount == null ? null : Number(row.paid_amount),
    remainingAmount: row.remaining_amount == null ? null : Number(row.remaining_amount),
    sosBatchId: row.sos_batch_id ? String(row.sos_batch_id) : null,
    reversalOfRequestId: row.reversal_of_request_id ? String(row.reversal_of_request_id) : null,
    reversedByRequestId: row.reversed_by_request_id ? String(row.reversed_by_request_id) : null,
    createdAt: String(row.created_at ?? ""),
    decidedAt: row.decided_at ? String(row.decided_at) : null,
    invoiceStoragePath: row.invoice_storage_path ? String(row.invoice_storage_path) : null,
    invoiceContentType: isDirectOrderInvoiceContentType(row.invoice_content_type) ? row.invoice_content_type : null,
    invoiceUploadedAt: row.invoice_uploaded_at ? String(row.invoice_uploaded_at) : null,
  };
}

function mapStepRow(row: Record<string, unknown>): DirectOrderStepState {
  return {
    order: Number(row.step_order ?? 0),
    kind: String(row.approver_kind ?? "person") === "role" ? "role" : "person",
    role: row.approver_role ? (String(row.approver_role) as PhoenixRole) : null,
    approverHrId: row.approver_hr_id ? String(row.approver_hr_id) : null,
    label: String(row.label ?? ""),
    status: (["pending", "approved", "rejected"].includes(String(row.status))
      ? String(row.status)
      : "pending") as DirectOrderStepState["status"],
    decidedByHrId: row.decided_by_hr_id ? String(row.decided_by_hr_id) : null,
    decidedAt: row.decided_at ? String(row.decided_at) : null,
    decisionComment: row.decision_comment ? String(row.decision_comment) : null,
  };
}

async function loadSteps(requestId: string): Promise<DirectOrderStepState[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("direct_order_approval_steps")
    .select("*")
    .eq("request_id", requestId)
    .order("step_order", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map(mapStepRow);
}

/**
 * Every line of a request, in entry order.
 *
 * Mirrors `loadSteps`: one focused read, ordered, mapped once. Always returns at least one row for
 * any request written since the items migration backfilled every existing request to a single line —
 * an empty result means the request predates that and something is wrong, which is why callers that
 * must show the money treat it as such rather than rendering an empty basket.
 */
async function loadDirectOrderItems(requestId: string): Promise<DirectOrderRequestItem[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("direct_order_request_items")
    .select("*")
    .eq("request_id", requestId)
    .order("line_no", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    lineNo: Number(row.line_no ?? 0),
    productCode: String(row.product_code ?? ""),
    productName: String(row.product_name ?? ""),
    familyCode: String(row.family_code ?? ""),
    dealType: String(row.deal_type ?? "bonus") === "discount" ? "discount" : "bonus",
    qty: Number(row.qty ?? 0),
    bonus: Number(row.bonus ?? 0),
    discountPct: row.discount_pct == null ? null : Number(row.discount_pct),
    publicPriceSnapshot: row.public_price_snapshot == null ? null : Number(row.public_price_snapshot),
    pharmacyPriceSnapshot: row.pharmacy_price_snapshot == null ? null : Number(row.pharmacy_price_snapshot),
    salesValue: Number(row.sales_value ?? 0),
    overCap: row.over_cap === true,
  }));
}

/**
 * The same lines for MANY requests in one read.
 *
 * The cleanup pass compares every open request against every other, so asking per request would be
 * one round trip per order on a page that already reads the whole open set. `fetchAllRows` pages it,
 * because "every open request" is not a number this can assume stays small.
 */
async function loadDirectOrderItemsForRequests(requestIds: readonly string[]): Promise<Map<string, DirectOrderRequestItem[]>> {
  const byRequest = new Map<string, DirectOrderRequestItem[]>();
  if (requestIds.length === 0) return byRequest;
  const supabase = getSupabaseAdmin();
  const rows = await fetchAllRows<Record<string, unknown>>(
    () => supabase.from("direct_order_request_items").select("*").in("request_id", [...requestIds]),
    "id",
  );
  for (const row of rows) {
    const key = String(row.request_id ?? "");
    const bucket = byRequest.get(key) ?? [];
    bucket.push({
      lineNo: Number(row.line_no ?? 0),
      productCode: String(row.product_code ?? ""),
      productName: String(row.product_name ?? ""),
      familyCode: String(row.family_code ?? ""),
      dealType: String(row.deal_type ?? "bonus") === "discount" ? "discount" : "bonus",
      qty: Number(row.qty ?? 0),
      bonus: Number(row.bonus ?? 0),
      discountPct: row.discount_pct == null ? null : Number(row.discount_pct),
      publicPriceSnapshot: row.public_price_snapshot == null ? null : Number(row.public_price_snapshot),
      pharmacyPriceSnapshot: row.pharmacy_price_snapshot == null ? null : Number(row.pharmacy_price_snapshot),
      salesValue: Number(row.sales_value ?? 0),
      overCap: row.over_cap === true,
    });
    byRequest.set(key, bucket);
  }
  for (const bucket of byRequest.values()) bucket.sort((a, b) => a.lineNo - b.lineNo);
  return byRequest;
}

async function insertEvent(input: {
  requestId: string;
  actorHrId: string | null;
  eventType: string;
  message: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  await supabase.from("direct_order_events").insert({
    request_id: input.requestId,
    // Canonical on the way in. Fourteen call sites in this file pass `actorHrId: access.hrId`,
    // which is the LOWERCASE comparison key - a FOURTH shape of the actor bug, matching none of
    // the three the repo-wide sweep knows: the column is not named in the call (the field is
    // camelCase `actorHrId`), there is no resolveEmployeeIdentityId, and there is no `?? loginId`
    // chain to grep for. Seven rows were written lowercase by real users on 2026-09-05 alone.
    // Stamping it HERE rather than at the fourteen callers is what makes the fifteenth caller safe.
    actor_hr_id: hrIdForStorage(input.actorHrId),
    event_type: input.eventType,
    message: input.message,
    metadata: input.metadata ?? {},
  });
}

// ── Pharmacy registry ─────────────────────────────────────────────────────────

export async function listMyDirectOrderPharmacies(access: AccessContext): Promise<DirectOrderPharmacy[]> {
  await assertPermission(access, "direct_orders", "read");
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("direct_order_pharmacies")
    .select("*")
    .in("created_by_hr_id", hrIdLookupKeys(access.hrId))
    .eq("active", true)
    .order("pharmacy_name", { ascending: true });
  if (error) throw error;
  const pharmacies = ((data ?? []) as Array<Record<string, unknown>>).map(mapPharmacyRow);
  await attachDistributorCodes(pharmacies);
  return pharmacies;
}

/**
 * Read the contested-claim notes off a pharmacy row.
 *
 * Defensive on every field because this column is jsonb: it is one `execute_sql` away from holding
 * whatever a future hand-repair puts there, and a malformed note must degrade to "no claim" rather
 * than crash the pharmacy picker for everyone. A claim missing either half of its code pair says
 * nothing and is dropped.
 */
function normalizeContestedCodeClaims(value: unknown): DirectOrderContestedCodeClaim[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const claim = entry as Record<string, unknown>;
    const distributorCode = String(claim.distributorCode ?? "").trim();
    const customerCode = String(claim.customerCode ?? "").trim();
    if (!distributorCode || !customerCode) return [];
    return [
      {
        distributorCode,
        customerCode,
        heldByPharmacyId: String(claim.heldByPharmacyId ?? "").trim(),
        heldByPharmacyCode: String(claim.heldByPharmacyCode ?? "").trim(),
        heldByPharmacyName: String(claim.heldByPharmacyName ?? "").trim(),
        claimedAt: String(claim.claimedAt ?? "").trim(),
      },
    ];
  });
}

function mapPharmacyRow(row: Record<string, unknown>): DirectOrderPharmacy {
  return {
    id: String(row.id),
    phoenixPharmacyCode: String(row.phoenix_pharmacy_code),
    pharmacyName: String(row.pharmacy_name),
    brickId: row.brick_id ? String(row.brick_id) : null,
    areaCode: row.area_code ? String(row.area_code) : null,
    regionCode: row.region_code ? String(row.region_code) : null,
    doctorName: row.doctor_name ? String(row.doctor_name) : null,
    pharmacyAddress: row.pharmacy_address ? String(row.pharmacy_address) : null,
    venueType: normalizeVenueType(row.venue_type),
    // A declared CRM contact. Absent before the 2026-09-03 migration reaches an environment, so a
    // missing column reads as "not declared" rather than throwing on every venue read.
    crmContactId: parseVenueContactId(row.crm_contact_id),
    crmContactLinkedByHrId: row.crm_contact_linked_by_hr_id ? String(row.crm_contact_linked_by_hr_id) : null,
    crmContactLinkedAt: row.crm_contact_linked_at ? String(row.crm_contact_linked_at) : null,
    distributorCodes: [],
    contestedCodeClaims: normalizeContestedCodeClaims(row.contested_code_claims),
    geoVarianceResolved: row.geo_variance_resolved === true,
    verificationStatus: normalizePharmacyVerificationStatus(row.verification_status),
    entrySource: String(row.entry_source ?? "catalogue") === "manual" ? "manual" : "catalogue",
    verifiedByHrId: row.verified_by_hr_id ? String(row.verified_by_hr_id) : null,
    verifiedAt: row.verified_at ? String(row.verified_at) : null,
    createdByHrId: String(row.created_by_hr_id),
    active: row.active !== false,
    trustState: normalizeDirectOrderTrustState(row.trust_state),
    probationStartedAt: row.probation_started_at ? String(row.probation_started_at) : null,
    // Only the two rulings are honoured; anything else in the column reads as "nobody has ruled",
    // which is the safe direction — an unrecognised value must never release an order.
    holdReleaseGround:
      row.hold_release_ground === "admin_released" || row.hold_release_ground === "kept_held"
        ? row.hold_release_ground
        : null,
    holdReleaseReason: row.hold_release_reason ? String(row.hold_release_reason) : null,
    holdReleaseDecidedByHrId: row.hold_release_decided_by_hr_id ? String(row.hold_release_decided_by_hr_id) : null,
    holdReleaseDecidedAt: row.hold_release_decided_at ? String(row.hold_release_decided_at) : null,
  };
}

/**
 * A `code → name` resolver for the code validators, so a refusal names the distributor the
 * submitter actually chose from the dropdown rather than its internal code.
 */
async function distributorNameResolver(): Promise<(code: string) => string> {
  const names = await loadDistributorNames();
  return (code: string) => names.get(code) ?? code;
}

/**
 * Does this pharmacy's own NAME happen to be a real distributor customer code? Found live,
 * 2026-08-08: a hand-registered pharmacy had "1573270" as its name — a genuinely valid PS
 * distributor customer code (the master directory stores it padded, "0001573270"), typed into the
 * name field by mistake. Only worth the query when the pharmacy has NO code on file at all — the
 * common, well-coded case never reaches this. Purely informational (spec-consistent with the
 * validation desk's own rule: a match is a human's call, never an automatic one) — this makes an
 * otherwise-invisible real match visible, it does not link anything.
 *
 * Matched on digits-only equality after stripping leading zeros from both sides, not a text
 * `.eq()`: the directory stores the same customer under differently-zero-padded codes depending on
 * distributor (confirmed live: "0001573270" for PS, "350599" for IS-family codes).
 */
async function findPossibleDistributorMatchesByPharmacyName(
  pharmacyName: string | null | undefined,
): Promise<DirectOrderPossibleDistributorMatch[]> {
  const typed = String(pharmacyName ?? "").trim();
  // A real pharmacy name is never purely digits — this is the one shape worth checking at all.
  if (!/^\d{4,}$/.test(typed)) return [];
  const bare = typed.replace(/^0+/, "") || "0";

  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("source_of_sales_customer_directory_rollup")
    // brick_id matters as much as area_code: sales attribution follows the BRICK, so a comparison
    // that can only check the area answers the less important half of the question.
    .select("distributor_code, client_code, client_name, area_code, brick_id")
    .ilike("client_code", `%${bare}`)
    .limit(50);
  const rows = (data ?? []) as Array<{
    distributor_code: string | null;
    client_code: string | null;
    client_name: string | null;
    area_code: string | null;
    brick_id: string | null;
  }>;

  const nameOfDistributor = await distributorNameResolver();
  const byDistributor = new Map<string, DirectOrderPossibleDistributorMatch>();
  for (const row of rows) {
    const code = String(row.client_code ?? "");
    // Suffix-matched by the query above; require the FULL digit string to agree once both sides
    // are stripped of leading zeros, or "31573270" would wrongly match "1573270".
    if (code.replace(/^0+/, "") !== bare) continue;
    const distributorCode = String(row.distributor_code ?? "");
    if (!distributorCode || byDistributor.has(distributorCode)) continue;
    byDistributor.set(distributorCode, {
      distributorCode,
      distributorName: nameOfDistributor(distributorCode),
      customerCode: code,
      customerName: row.client_name ?? code,
      areaCode: row.area_code,
      brickId: row.brick_id,
      // Unresolved here on purpose — this function only searches the DISTRIBUTOR master and knows
      // nothing about Phoenix's own pharmacies. attachCandidateOwnership fills it in, and every
      // surface that offers a link must call it, or it offers a link the rule would refuse.
      ownedByPharmacyCode: null,
      ownedByPharmacyName: null,
    });
  }
  return Array.from(byDistributor.values());
}

/**
 * Fill in `ownedByPharmacyCode` / `ownedByPharmacyName` on name-code candidates.
 *
 * Every screen that shows a candidate must run this. A candidate rendered with ownership unresolved
 * reads as free to link when it may already belong to another Phoenix pharmacy — which is how one
 * real pharmacy ends up registered twice with its sales split between the two records.
 */
async function attachCandidateOwnership(
  pharmacyId: string,
  matches: DirectOrderPossibleDistributorMatch[],
): Promise<DirectOrderPossibleDistributorMatch[]> {
  return Promise.all(
    matches.map(async (match) => {
      const ownerId = await findOtherPharmacyHoldingCode(pharmacyId, match.distributorCode, match.customerCode);
      if (!ownerId) return match;
      // "unknown" = the check itself failed. Surfaced as-is so the rule can fail closed on it.
      if (ownerId === "unknown") return { ...match, ownedByPharmacyCode: "unknown", ownedByPharmacyName: null };
      const owner = (await loadPharmaciesByIds([ownerId])).get(ownerId) ?? null;
      return {
        ...match,
        ownedByPharmacyCode: owner?.phoenixPharmacyCode ?? ownerId,
        ownedByPharmacyName: owner?.pharmacyName ?? null,
      };
    }),
  );
}

/**
 * The pharmacy's code pairs, each annotated with whether ANOTHER Phoenix pharmacy already claims it.
 *
 * The release rule needs this and the pharmacy row cannot supply it. Two Phoenix pharmacies pointing
 * at one distributor customer is a code collision in its purest form — exactly the case the 2026-08-04
 * comment on createDirectOrderPharmacy warns about — so a contested pair must never count as proof.
 */
async function attachCodeOwnership(pharmacy: DirectOrderPharmacy): Promise<DirectOrderHoldCandidateCode[]> {
  const pairs = pharmacy.distributorCodes ?? [];
  if (pairs.length === 0) return [];
  try {
    const supabase = getSupabaseAdmin();
    const { data } = await supabase
      .from("direct_order_pharmacy_distributor_codes")
      .select("pharmacy_id, distributor_code, customer_code")
      .in("customer_code", [...new Set(pairs.map((pair) => pair.customerCode))])
      .neq("pharmacy_id", pharmacy.id);
    const owners = new Map<string, string>();
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      owners.set(`${String(row.distributor_code ?? "").toLowerCase()}|${String(row.customer_code ?? "")}`, String(row.pharmacy_id));
    }
    return pairs.map((pair) => ({
      ...pair,
      ownedByOtherPharmacyId: owners.get(`${pair.distributorCode.toLowerCase()}|${pair.customerCode}`) ?? null,
    }));
  } catch (error) {
    // FAIL CLOSED: if we cannot prove a pair is unclaimed, we do not treat it as proof. An
    // unavailable check must never be the reason an order skips the held lane.
    logError("Direct order code-ownership check failed", {
      labels: { event: "direct_order_code_ownership_check_failed", pharmacyId: pharmacy.id },
      error,
    });
    return pairs.map((pair) => ({ ...pair, ownedByOtherPharmacyId: "unknown" }));
  }
}

/** distributor_code → distributor_name, for display. */
async function loadDistributorNames(): Promise<Map<string, string>> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("source_of_sales_distributors").select("distributor_code, distributor_name");
  const map = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ distributor_code: string; distributor_name: string | null }>) {
    if (row.distributor_code) map.set(row.distributor_code, row.distributor_name ?? row.distributor_code);
  }
  return map;
}

/** Populate `distributorCodes` on each pharmacy from the child table (+ distributor names). */
async function attachDistributorCodes(pharmacies: DirectOrderPharmacy[]): Promise<void> {
  const ids = pharmacies.map((pharmacy) => pharmacy.id);
  if (ids.length === 0) return;
  const supabase = getSupabaseAdmin();
  // PostgREST folds every .in() value into the request URL; an unbatched array of a few hundred
  // ids can push the URL past undici's ~16KB header limit and throw "TypeError: fetch failed" /
  // HeadersOverflowError — company-wide report/pending scopes can reach that scale, so batch.
  const codeRows: Array<Record<string, unknown>> = [];
  const [, distNames] = await Promise.all([
    (async () => {
      for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100);
        const { data } = await supabase.from("direct_order_pharmacy_distributor_codes").select("*").in("pharmacy_id", batch);
        codeRows.push(...((data ?? []) as Array<Record<string, unknown>>));
      }
    })(),
    loadDistributorNames(),
  ]);
  const byPharmacy = new Map<string, DirectOrderPharmacyDistributorCode[]>();
  for (const row of codeRows) {
    const pharmacyId = String(row.pharmacy_id);
    const list = byPharmacy.get(pharmacyId) ?? [];
    const distributorCode = String(row.distributor_code);
    list.push({
      distributorCode,
      distributorName: distNames.get(distributorCode) ?? distributorCode,
      customerCode: String(row.customer_code ?? ""),
      mappedBrickId: row.mapped_brick_id ? String(row.mapped_brick_id) : null,
      mappedAreaCode: row.mapped_area_code ? String(row.mapped_area_code) : null,
      mappedRegionCode: row.mapped_region_code ? String(row.mapped_region_code) : null,
    });
    byPharmacy.set(pharmacyId, list);
  }
  for (const pharmacy of pharmacies) pharmacy.distributorCodes = byPharmacy.get(pharmacy.id) ?? [];
}

/**
 * Separators someone reaches for when they want to put TWO codes in a box built for one.
 *
 * This is not hypothetical tidying. A live pharmacy was registered with `829575 \ 1533576` —
 * two real-looking codes crammed into one field, which the form accepted. That single string is
 * then matched against the distributor catalogue as a whole, so it can never equal either code:
 * the pharmacy silently matches NOTHING and its retail sales never appear.
 *
 * A customer code is one opaque token. Anything with a separator inside is two answers to a
 * question that has one, so it is refused rather than stored and quietly ignored.
 */
const CUSTOMER_CODE_SEPARATORS = /[\\/,;|\s]/;

function assertSingleCustomerCode(customerCode: string): void {
  if (CUSTOMER_CODE_SEPARATORS.test(customerCode)) {
    badRequest(
      `"${customerCode}" looks like more than one code. Enter ONE customer code per distributor — ` +
        "no spaces, slashes, commas or semicolons. Add a second distributor row for another code.",
    );
  }
}

/**
 * Fold submitted (distributor, customer code) pairs into one validated map.
 *
 * Shared by the order form and the pharmacy registry deliberately. These two paths write the same
 * child table, and a rule enforced in one but not the other is a rule that does not exist — the
 * registry would happily store the second code the order form refuses.
 *
 * A row where BOTH halves are blank is skipped, and that is not carelessness: the form always
 * renders one empty row, and leaving it alone is the legitimate "I do not know the code" answer.
 * Codes are OPTIONAL overall (owner rule, 2026-08-04) — an unknown code costs an extra approval
 * rung, not a refusal.
 *
 * A row where only ONE half is filled is refused. It used to be skipped alongside the blank ones,
 * and that was wrong for a reason that took a live investigation to surface: a submitter who picks
 * a distributor, searches, finds nothing and moves on has visibly started filling the row. The
 * server discarded it without a word, and the pharmacy was then recorded as "no distributor or
 * customer code was given" — a statement the submitter would have disputed, and both of them right.
 * Two pharmacies reached approval that way (Ibrahim pharmacy and محمد ميجا, 2026-08-04).
 *
 * `distributorName` keeps the refusal readable — an approver should never be shown a raw code.
 */
function normalizeDistributorCodePairs(
  pairs: Array<{ distributorCode: string; customerCode: string }> | undefined,
  distributorName?: (code: string) => string,
): Map<string, string> {
  const nameOf = (code: string) => distributorName?.(code)?.trim() || code;
  const byDistributor = new Map<string, string>();
  for (const pair of pairs ?? []) {
    const distributorCode = String(pair.distributorCode ?? "").trim();
    const customerCode = String(pair.customerCode ?? "").trim();
    if (!distributorCode && !customerCode) continue; // untouched row — the legitimate empty answer
    if (distributorCode && !customerCode) {
      badRequest(
        `You picked ${nameOf(distributorCode)} but did not choose a customer for it. ` +
          "Search that distributor's list for the pharmacy, or use \"Not listed? Enter the code manually\" — " +
          "or remove the row with ✕ if you do not know its code. Leaving it half-filled would drop it silently.",
      );
    }
    if (!distributorCode && customerCode) {
      badRequest(
        `The customer code "${customerCode}" has no distributor. A code only means anything alongside ` +
          "the distributor that issued it — pick the distributor, or remove the row.",
      );
    }
    assertSingleCustomerCode(customerCode);
    if (byDistributor.has(distributorCode)) {
      // UNIQUE (pharmacy_id, distributor_code) would reject this anyway, but as an opaque
      // database error. Say plainly what is wrong instead.
      badRequest(
        `${distributorCode} appears twice. A pharmacy holds ONE customer code per distributor — ` +
          "add the second code under the distributor it actually belongs to.",
      );
    }
    byDistributor.set(distributorCode, customerCode);
  }
  return byDistributor;
}

/**
 * Territory for this pharmacy's codes, from the SHARED customer-map resolver.
 *
 * The lookup itself now lives in src/lib/sales/customer-geography.ts, so marketing, Source of Sales
 * and direct orders ask the customer map one question one way. This stays as a thin adapter because
 * the row builder below speaks {brick, area, region} while the resolver speaks
 * {brickId, areaCode, regionCode}; keeping the local vocabulary means the migration is the query
 * and nothing else, and the three call sites are untouched.
 *
 * Keys stay exactly what callers already build — the raw `${distributor}::${customer}` of the map
 * passed in — so nothing downstream has to know the shared key helper exists.
 *
 * What actually changed: pairs are matched EXACTLY. The two `.in()` filters this used to pass are
 * independent, so they also matched pairs nobody asked about — 53 rows returned for 45 wanted,
 * measured on production 2026-09-03. With no paging behind it, that over-match would silently
 * truncate at PostgREST's 1000-row cap once it grew, and a real pharmacy would come back with a
 * null area, which reads as "no territory" rather than as a query that got cut off.
 *
 * A miss is still normal and never an error — it simply means the code is not one the distributor
 * has reported sales against yet.
 */
async function resolveCustomerCodeGeography(
  byDistributor: Map<string, string>,
): Promise<Map<string, { brick: string | null; area: string | null; region: string | null }>> {
  const mapByKey = new Map<string, { brick: string | null; area: string | null; region: string | null }>();
  if (byDistributor.size === 0) return mapByKey;

  const entries = Array.from(byDistributor.entries());
  const resolved = await resolveCustomerGeography(
    entries.map(([distributorCode, customerCode]) => ({ customerCode, distributorCode })),
  );
  for (const [distributorCode, customerCode] of entries) {
    const geography = resolved.get(customerGeographyKey(distributorCode, customerCode));
    if (!geography) continue;
    mapByKey.set(`${distributorCode}::${customerCode}`, {
      area: geography.areaCode,
      brick: geography.brickId,
      region: geography.regionCode,
    });
  }
  return mapByKey;
}

/**
 * Child rows for a pharmacy's codes, each carrying whatever geography the customer map knew.
 *
 * `pharmacyId` is nullable because creation no longer knows it: the pharmacy and its codes are now
 * written by one transactional RPC that assigns the id itself, so the create path builds these rows
 * BEFORE the pharmacy exists. Every other caller is updating a pharmacy that already does, and
 * passes its id as before. Building the rows in one place matters more than the null — the
 * geography mapping below is the part that must never be written twice.
 */
function buildDistributorCodeRows(
  pharmacyId: string | null,
  byDistributor: Map<string, string>,
  mapByKey: Map<string, { brick: string | null; area: string | null; region: string | null }>,
): Array<Record<string, unknown>> {
  return Array.from(byDistributor.entries()).map(([distributorCode, customerCode]) => {
    const mapped = mapByKey.get(`${distributorCode}::${customerCode}`);
    return {
      ...(pharmacyId === null ? {} : { pharmacy_id: pharmacyId }),
      distributor_code: distributorCode,
      customer_code: customerCode,
      mapped_brick_id: mapped?.brick ?? null,
      mapped_area_code: mapped?.area ?? null,
      mapped_region_code: mapped?.region ?? null,
    };
  });
}

export type DirectOrderCodeOwner = {
  id: string;
  phoenixPharmacyCode: string;
  pharmacyName: string;
  areaCode: string | null;
  regionCode: string | null;
  pharmacyAddress: string | null;
  verificationStatus: DirectOrderPharmacy["verificationStatus"];
};

/**
 * Keep only the rows that are an EXACT (distributor, customer code) pair from the request.
 *
 * Split out of the query below so it can be tested without a database, because getting it wrong is
 * silent and expensive in the one direction that matters. PostgREST's two `.in()` filters are
 * INDEPENDENT — `.in(distributor, [PS, IBN])` and `.in(customer, [111, 222])` also match PS/222 and
 * IBN/111, which are pairs nobody asked about. Treating those as conflicts would refuse a code that
 * is completely free, and the rep would be told her code belongs to a pharmacy that does not hold
 * it. She would then invent one, which is exactly how "000000" reached production.
 *
 * Exported for the regression test only; the query is the sole caller.
 */
export function selectExactCodePairOwners(
  byDistributor: Map<string, string>,
  rows: Array<Record<string, unknown>>,
): Map<string, DirectOrderCodeOwner> {
  const owners = new Map<string, DirectOrderCodeOwner>();
  for (const row of rows) {
    const distributorCode = String(row.distributor_code ?? "");
    const customerCode = String(row.customer_code ?? "");
    if (byDistributor.get(distributorCode) !== customerCode) continue;
    // PostgREST returns an embedded row as an object, but returns an ARRAY when it cannot prove the
    // relationship is to-one. Both shapes have appeared here across schema-cache reloads, and the
    // array shape used to read as "no owner" — which silently turns a real collision back into the
    // failed insert this whole change exists to remove.
    const embedded = row.direct_order_pharmacies;
    const joined = (Array.isArray(embedded) ? embedded[0] : embedded) as Record<string, unknown> | null | undefined;
    if (!joined?.id) continue;
    owners.set(`${distributorCode}::${customerCode}`, {
      id: String(joined.id),
      phoenixPharmacyCode: String(joined.phoenix_pharmacy_code ?? ""),
      pharmacyName: String(joined.pharmacy_name ?? ""),
      areaCode: joined.area_code ? String(joined.area_code) : null,
      regionCode: joined.region_code ? String(joined.region_code) : null,
      pharmacyAddress: joined.pharmacy_address ? String(joined.pharmacy_address) : null,
      verificationStatus: normalizePharmacyVerificationStatus(joined.verification_status),
    });
  }
  return owners;
}

/**
 * Which of these (distributor, customer code) pairs does another pharmacy already hold?
 *
 * The unique index on (distributor_code, customer_code) is the real guarantee; this is the lookup
 * that lets us ASK about a collision instead of discovering it as a failed insert. That distinction
 * is the whole fix: the insert used to fail after the parent row had already committed, leaving a
 * codeless duplicate behind and telling the rep nothing had been created.
 */
async function findOwnedDistributorCodes(byDistributor: Map<string, string>): Promise<Map<string, DirectOrderCodeOwner>> {
  if (byDistributor.size === 0) return new Map();

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("direct_order_pharmacy_distributor_codes")
    .select(
      "distributor_code, customer_code, pharmacy_id, direct_order_pharmacies!inner(id, phoenix_pharmacy_code, pharmacy_name, area_code, region_code, pharmacy_address, verification_status)",
    )
    .in("distributor_code", Array.from(byDistributor.keys()))
    .in("customer_code", Array.from(byDistributor.values()));
  if (error) throw error;

  return selectExactCodePairOwners(byDistributor, (data ?? []) as Array<Record<string, unknown>>);
}

export async function createDirectOrderPharmacy(
  access: AccessContext,
  input: {
    pharmacyName: string;
    brickId?: string | null;
    areaCode?: string | null;
    regionCode?: string | null;
    doctorName?: string | null;
    pharmacyAddress?: string | null;
    distributorCodes: Array<{ distributorCode: string; customerCode: string }>;
    /** Defaults to `pharmacy`. A nursery may not carry a distributor code — see below. */
    venueType?: string | null;
    /**
     * The CRM contact the submitter says this venue IS. OPTIONAL, and a malformed value degrades to
     * "not declared" rather than failing the registration — same rule as the distributor codes
     * (2026-08-04): refusing a field the submitter cannot answer produces an invented value.
     *
     * It is checked against the submitter's OWN scope before it is stored. Skipping that would make
     * the picker decoration: the form would offer one district's contacts while the route accepted
     * any id in the CRM, and a wrong id puts a "1 direct order" badge on the contact list of a rep
     * who never sold to them.
     */
    crmContactId?: number | string | null;
    /**
     * The submitter was shown the pharmacy that already holds a code they typed, and answered that
     * theirs is a DIFFERENT pharmacy.
     *
     * Without this the call is refused (by name, naming the incumbent) so the question is always
     * asked before a second pharmacy is registered against a code. With it the pharmacy is created
     * and the contested code is recorded — but never claimed. See the fork below.
     */
    acknowledgedCodeConflict?: boolean;
  },
): Promise<DirectOrderPharmacy> {
  await assertPermission(access, "direct_orders", "create");
  const name = input.pharmacyName?.trim();
  if (!name) badRequest("Venue name is required.");
  // NOT `normalizeVenueType`: absent means unanswered here, not "pharmacy". Reads keep the
  // forgiving version for rows written before the column existed — a REGISTRATION does not get it.
  const venueTypeChoice = parseVenueTypeChoice(input.venueType);
  if (!venueTypeIsAnswered(venueTypeChoice)) badRequest(VENUE_TYPE_UNANSWERED_MESSAGE);
  const venueType = venueTypeChoice;
  // The whole reason the column exists. A venue with no distributor account has no code to give, so
  // accepting one here would just re-open the door to an invented one under a new label.
  if (!venueRequiresDistributorCode(venueType) && (input.distributorCodes ?? []).length > 0) {
    badRequest(
      `A ${venueTypeLabel(venueType).toLowerCase()} has no distributor account, so it cannot carry a distributor code. ` +
        "Register it without one.",
    );
  }
  const doctorName = input.doctorName?.trim();
  if (!doctorName) badRequest("Doctor name is required.");
  const pharmacyAddress = input.pharmacyAddress?.trim();
  if (!pharmacyAddress) badRequest("Venue address is required.");

  // Distributor + customer code are OPTIONAL (owner rule, 2026-08-04). A submitter who does not
  // know the distributor, or the code, or either, can still register the pharmacy and keep
  // working. What it costs is one extra rung: the request waits for SFE validation and then a
  // System Admin acknowledgment before it rejoins the ordinary chain.
  //
  // Refusing here was the worse option: it does not produce a correct code, it produces an
  // invented one. That is exactly how "829575 \ 1533576" reached production — a required field
  // with nothing valid to put in it.
  //
  // When codes ARE supplied they are still validated: one per distributor, one code per field.
  const byDistributor = normalizeDistributorCodePairs(input.distributorCodes, await distributorNameResolver());

  const supabase = getSupabaseAdmin();

  // ── The code-collision fork (owner, 2026-08-13) ──────────────────────────────────────────────
  //
  // ASK before writing, instead of discovering the collision as a failed insert. The old order of
  // events was: insert the pharmacy (commits), insert the codes (23505), throw. The rep was told
  // "Could not create the pharmacy." while a codeless duplicate of it sat in the table — and that
  // orphan is invisible to BOTH dedupe passes, because the code pass needs a code on each side and
  // the name pass only considers pharmacies with none on either. Staging DOP-000014 is the proof.
  //
  // What follows deliberately does NOT relax the unique index. One customer code belongs to one
  // pharmacy; that is what keeps a distributor's customer from being attributed twice, and it is
  // the only reason this was catchable at all.
  const owners = await findOwnedDistributorCodes(byDistributor);
  const distributorNameOf = await distributorNameResolver();
  if (owners.size > 0 && input.acknowledgedCodeConflict !== true) {
    // Refuse BY NAME, not with the generic fallback. The API is reachable directly, so this
    // message is the only thing a caller outside the form ever sees — it has to say which code,
    // which pharmacy holds it, and what the two possible answers are.
    const described = Array.from(owners.entries())
      .map(([key, owner]) => {
        const [distributorCode, customerCode] = key.split("::");
        return `${distributorNameOf(distributorCode)} ${customerCode} already belongs to ${owner.phoenixPharmacyCode} ("${owner.pharmacyName}")`;
      })
      .join("; ");
    badRequest(
      `${described}. If that is the same pharmacy, use it instead of registering a second one. ` +
        "If it is genuinely a different pharmacy, confirm that and it will be registered without " +
        "the code, for a reviewer to settle.",
    );
  }

  // The submitter said "different pharmacy". Keep the claim as EVIDENCE and register without it.
  //
  // Refusing instead was the option already known to be wrong here: it does not produce a correct
  // code, it produces an invented one (owner rule, 2026-08-04). Production carries the proof —
  // "حضانه زمزم" holds "000000" on one row and "00000" on another, which are two different strings
  // to the unique index and therefore never collided with anything.
  const contestedCodeClaims: DirectOrderContestedCodeClaim[] = Array.from(owners.entries()).map(([key, owner]) => {
    const [distributorCode, customerCode] = key.split("::");
    return {
      distributorCode,
      customerCode,
      heldByPharmacyId: owner.id,
      heldByPharmacyCode: owner.phoenixPharmacyCode,
      heldByPharmacyName: owner.pharmacyName,
      claimedAt: new Date().toISOString(),
    };
  });
  // Only the free codes are actually claimed. A contested pair is dropped from the insert entirely,
  // so the incumbent keeps it and the unique index is never even tested.
  const claimablePairs = new Map(
    Array.from(byDistributor.entries()).filter(([distributorCode, customerCode]) => !owners.has(`${distributorCode}::${customerCode}`)),
  );

  // Resolve each (distributor, customer code) → brick via the customer map (best-effort).
  const mapByKey = await resolveCustomerCodeGeography(claimablePairs);

  // Every hand-registered pharmacy starts UNRECOGNISED, and the row says so from the first insert
  // rather than being corrected a moment later (owner rule, 2026-08-04 — "the three situations").
  // The RPC pins `pending_review`/`manual` itself so no caller can register a pre-approved
  // pharmacy by passing different values.
  //
  // This is the whole rule in one line, and it is stricter than deriving the state from the codes
  // alone on purpose. Reaching this function AT ALL means the submitter could not find the
  // pharmacy in Phoenix and typed it in, which is situation 1. Situations 2 and 3 — a code the
  // distributor's list does not contain, and no code at all — are then just narrower cases of it.
  // Deriving from the codes would have let a hand-typed pharmacy whose code happened to collide
  // with a real one skip review entirely, which is the exact mis-attribution the review exists
  // to catch.
  //
  // Picking an existing pharmacy from the list never calls this function, so an ordinary request
  // is unaffected: it keeps the plain SFE → management → CEO chain.
  //
  // ONE TRANSACTION. phx_create_direct_order_pharmacy writes the pharmacy and its code rows in a
  // single plpgsql body, so a failure on the codes rolls the pharmacy back with it. Two client
  // inserts could not do that, and the half-success is what created the orphan.
  //
  // A DECLARED CRM contact is checked against the submitter's own reach before it is written. The
  // picker offers self UNION org subtree; this refuses anything outside it, so the read scope and
  // the write scope are one answer rather than two that can drift. A wrong id here is not a cosmetic
  // mistake — it puts "1 direct order" on the contact list of a rep who never sold to them, and a
  // false trade record is the one direction that is not recoverable by looking again later.
  const crmContactId = parseVenueContactId(input.crmContactId);
  await assertVenueContactInScope(access, crmContactId);

  const { data: created, error } = await supabase.rpc("phx_create_direct_order_pharmacy", {
    p_pharmacy: {
      pharmacy_name: name,
      brick_id: input.brickId ?? null,
      area_code: input.areaCode ?? null,
      region_code: input.regionCode ?? null,
      doctor_name: doctorName,
      pharmacy_address: pharmacyAddress,
      created_by_hr_id: hrIdForStorage(access.hrId),
      contested_code_claims: contestedCodeClaims,
      venue_type: venueType,
      crm_contact_id: crmContactId,
    },
    p_codes: buildDistributorCodeRows(null, claimablePairs, mapByKey),
  });
  if (error) throw error;
  const pharmacyRow = (Array.isArray(created) ? created[0] : created) as Record<string, unknown> | null;
  // Not a user mistake — the RPC reported no error, so an empty/malformed row is a backend anomaly.
  // ApiError instances pass through toApiError untouched, so this reaches the caller as an honest
  // 500 rather than one that only happens to classify that way because no keyword pattern matched.
  if (!pharmacyRow?.id) {
    throw new ApiError(500, "internal_error", "phx_create_direct_order_pharmacy returned no pharmacy row.");
  }
  const pharmacyId = String(pharmacyRow.id);

  // Record WHY this pharmacy is awaiting review, in the reviewer's own terms. The state itself is
  // already decided (every hand-registered pharmacy waits); this is the audit trail that tells the
  // System Admin what to actually check, which is a different question for each situation.
  const unresolved = Array.from(claimablePairs.entries()).filter(
    ([distributorCode, customerCode]) => !mapByKey.has(`${distributorCode}::${customerCode}`),
  );
  // A contested claim outranks the other reasons in the reviewer's queue: the other two say a code
  // could not be confirmed, this one says a human looked at the pharmacy holding it and disagreed.
  // That is a decision waiting to be made, not a gap waiting to be filled.
  const reviewReason =
    contestedCodeClaims.length > 0
      ? `${contestedCodeClaims.length} code(s) are claimed by another pharmacy and the submitter says this is a different one`
      : claimablePairs.size === 0
        ? "no distributor or customer code was given"
        : unresolved.length > 0
          ? `${unresolved.length} customer code(s) are not in the distributor's own list`
          : "the venue was typed in by hand rather than picked from Phoenix";

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: `pharmacy:${pharmacyId}`,
    newValues: {
      verificationStatus: "pending_review",
      entrySource: "manual",
      reviewReason,
      unrecognisedPairs: unresolved.map(([distributorCode, customerCode]) => `${distributorCode}:${customerCode}`),
      contestedCodeClaims: contestedCodeClaims.map(
        (claim) => `${claim.distributorCode}:${claim.customerCode} held by ${claim.heldByPharmacyCode}`,
      ),
    },
    summary: `Direct-order venue "${name}" registered by hand — awaiting SFE validation and System Admin acknowledgment (${reviewReason}).`,
  });

  // Catch the wrong-box case at the source (owner rule, 2026-08-08). If the name that was just typed
  // is really a distributor customer code, and it matches exactly one customer, move it to the column
  // it belongs in now — before the pharmacy's first order is ever submitted against a broken record.
  //
  // This does NOT touch verification_status: the row still reads `pending_review` and the chain still
  // starts at SFE Manager. Auto-linking changes what the record SAYS, never whether a human checked
  // it. The 2026-08-04 safety comment above stands untouched.
  await autoLinkDirectOrderPharmacyCode(pharmacyId, { actorLoginId: access.loginId ?? access.hrId });

  const pharmacy = mapPharmacyRow(pharmacyRow as Record<string, unknown>);
  await attachDistributorCodes([pharmacy]);
  // Re-read the name: the auto-link may have replaced a digit-string name with the master's own.
  const { data: afterRow } = await supabase
    .from("direct_order_pharmacies")
    .select("pharmacy_name")
    .eq("id", pharmacyId)
    .maybeSingle();
  const correctedName = String((afterRow as { pharmacy_name?: string } | null)?.pharmacy_name ?? "").trim();
  if (correctedName) pharmacy.pharmacyName = correctedName;
  return pharmacy;
}

/**
 * What the form asks BEFORE registering a pharmacy by hand (owner, 2026-08-13).
 *
 * Two questions, and neither is a block:
 *
 *  1. CODE ALREADY OWNED. The pair they typed belongs to another pharmacy. Until now this surfaced
 *     as a failed insert AFTER the pharmacy row had committed, so the rep read "Could not create
 *     the pharmacy" and retried — leaving a codeless duplicate behind on every attempt.
 *
 *  2. SAME NAME IN THEIR REGION. Asked when they gave NO code, which is precisely when nothing
 *     else can catch a duplicate: `groupDuplicatePharmacies` matches on codes, so a pharmacy with
 *     none is invisible to it, and the name+area pass only fires when BOTH sides are codeless.
 *     Production shows what that costs — "السيد ابوالفتوح" exists twice in D11, once codeless and
 *     once holding PS/0001556836, and no pass will ever propose the pair.
 *
 * The name search covers the master DIRECTORY as well as Phoenix's own pharmacies, which is the
 * half the client-side suggestion was missing. In the staging case that started this, the real
 * pharmacy was sitting in the directory the whole time as PS/0001544640 in the rep's own area —
 * she could not see it, so she typed a code by hand. Showing the distributor and its code is what
 * makes the answer decidable: a name alone does not tell anyone which pharmacy this is.
 *
 * Scoped to REGION rather than area on the owner's instruction. A rep works one area but a
 * pharmacy sits wherever the brick says, and an over-broad suggestion costs nothing — it is a
 * question, and "no" is always available.
 */
export async function checkDirectOrderPharmacyBeforeCreate(
  access: AccessContext,
  input: {
    pharmacyName: string;
    areaCode?: string | null;
    regionCode?: string | null;
    distributorCodes: Array<{ distributorCode: string; customerCode: string }>;
  },
): Promise<DirectOrderPharmacyPreflight> {
  await assertPermission(access, "direct_orders", "create");
  const name = String(input.pharmacyName ?? "").trim();
  const distributorNameOf = await distributorNameResolver();
  const geoMaps = await loadDirectOrderGeoNames();

  // Only well-formed pairs are checked. A half-filled row is the normalizer's refusal to make, not
  // this function's — running it here would refuse during type-ahead, before the rep has finished.
  const pairs = (input.distributorCodes ?? [])
    .map((pair) => ({
      distributorCode: String(pair.distributorCode ?? "").trim(),
      customerCode: String(pair.customerCode ?? "").trim(),
    }))
    .filter((pair) => pair.distributorCode && pair.customerCode);
  const byDistributor = new Map(pairs.map((pair) => [pair.distributorCode, pair.customerCode]));

  const owners = await findOwnedDistributorCodes(byDistributor);
  const codeConflicts: DirectOrderPharmacyPreflight["codeConflicts"] = Array.from(owners.entries()).map(([key, owner]) => {
    const [distributorCode, customerCode] = key.split("::");
    return {
      distributorCode,
      customerCode,
      distributorName: distributorNameOf(distributorCode),
      heldBy: {
        id: owner.id,
        phoenixPharmacyCode: owner.phoenixPharmacyCode,
        pharmacyName: owner.pharmacyName,
        areaCode: owner.areaCode,
        areaName: owner.areaCode ? geoMaps.areaNameByCode.get(owner.areaCode) ?? "" : "",
        regionCode: owner.regionCode,
        regionName: owner.regionCode ? geoMaps.regionNameByCode.get(owner.regionCode) ?? "" : "",
        pharmacyAddress: owner.pharmacyAddress,
        verificationStatus: owner.verificationStatus,
      },
    };
  });

  // The name question is only worth asking when there is no code to answer it with. A pharmacy that
  // came with a code has already been identified by the strongest evidence there is.
  if (name.length < 2 || byDistributor.size > 0) return { codeConflicts, nameMatches: [] };

  // Resolve the rep's region from whatever the form has so far: the region it sent, else the region
  // that owns the area it sent. Without either there is nothing to scope to, and an unscoped name
  // search across the country would suggest strangers.
  const { areas } = await listDirectOrderAreaAndBrickOptions(access);
  const areaCode = String(input.areaCode ?? "").trim().toUpperCase();
  const regionCode =
    String(input.regionCode ?? "").trim().toUpperCase() ||
    (areaCode ? String(areas.find((area) => area.areaCode.toUpperCase() === areaCode)?.regionCode ?? "").toUpperCase() : "");
  if (!regionCode) return { codeConflicts, nameMatches: [] };

  const hits = await searchDirectOrderPharmacyDirectory(access, { query: name, limit: 60 });
  const nameMatches = hits
    .filter((hit) => String(hit.regionCode ?? "").toUpperCase() === regionCode)
    .map((hit) => ({
      source: hit.source,
      pharmacyName: hit.customerName ?? hit.phoenixPharmacyCode ?? hit.customerCode ?? "",
      distributorCode: hit.distributorCode,
      distributorName: hit.distributorCode ? distributorNameOf(hit.distributorCode) : "",
      customerCode: hit.customerCode,
      phoenixPharmacyCode: hit.phoenixPharmacyCode,
      areaCode: hit.areaCode,
      areaName: hit.areaName,
      regionCode: hit.regionCode,
      regionName: hit.regionName,
      pharmacyAddress: hit.address,
    }))
    .slice(0, 8);

  return { codeConflicts, nameMatches };
}

/**
 * The rep's own pharmacies, ready to pick again (owner, 2026-08-13).
 *
 * "Previously approved" reads two ways and both are the same intent — a pharmacy this person has
 * already put through successfully — so both count: one they registered that a reviewer has since
 * VERIFIED, or any pharmacy carrying an APPROVED order of theirs (including ones they picked from
 * the catalogue, which they never "created" at all and which `listMyDirectOrderPharmacies` cannot
 * see because it filters on created_by_hr_id).
 *
 * The point is to remove the reason duplicates get typed in the first place. Every duplicate in
 * production was a rep re-entering a pharmacy they had already used — often the same day.
 *
 * Deliberately excludes `pending_review` and `rejected`: offering an unsettled pharmacy as a
 * one-click choice would spread the very records the cleanup desk is trying to resolve.
 */
export async function listMyApprovedDirectOrderPharmacies(access: AccessContext): Promise<DirectOrderPharmacy[]> {
  await assertPermission(access, "direct_orders", "read");
  const supabase = getSupabaseAdmin();

  // No HR_ID means no "mine" to answer with. Returning early also keeps the .or() below from being
  // built with an empty in-list (`created_by_hr_id.in.()`), which PostgREST rejects as a syntax
  // error rather than simply matching nothing.
  const myHrIdKeys = hrIdLookupKeys(access.hrId);
  if (myHrIdKeys.length === 0) return [];

  const { data: orderRows, error: orderError } = await supabase
    .from("direct_order_requests")
    .select("pharmacy_id")
    .in("requester_hr_id", myHrIdKeys)
    .eq("status", "approved");
  if (orderError) throw orderError;
  const fromApprovedOrders = new Set(
    ((orderRows ?? []) as Array<Record<string, unknown>>).map((row) => String(row.pharmacy_id ?? "")).filter(Boolean),
  );
  // And every venue his own MARKETING validations brought across (owner, 2026-10-21): a customer he
  // validated for marketing requests is validated here too, so its pharmacies are his to pick in one
  // click. The loader syncs his validated customers first and never fails this list.
  try {
    const { listDirectOrderVenueIdsFromMyMarketingValidations } = await import(
      "@/lib/marketing-requests/direct-order-venue-sync"
    );
    for (const id of await listDirectOrderVenueIdsFromMyMarketingValidations(access.hrId)) fromApprovedOrders.add(id);
  } catch (error) {
    logError("My venues could not read the rep's marketing-validated venues", {
      labels: { event: "my_venues_marketing_read_failed" },
      error,
    });
  }

  const { data: mineRows, error: mineError } = await supabase
    .from("direct_order_pharmacies")
    .select("*")
    .eq("active", true)
    .eq("verification_status", "verified")
    .or(
      fromApprovedOrders.size > 0
        ? `created_by_hr_id.in.(${quoteInList(myHrIdKeys)}),id.in.(${Array.from(fromApprovedOrders).join(",")})`
        : `created_by_hr_id.in.(${quoteInList(myHrIdKeys)})`,
    )
    .order("pharmacy_name", { ascending: true });
  if (mineError) throw mineError;

  const pharmacies = ((mineRows ?? []) as Array<Record<string, unknown>>).map(mapPharmacyRow);
  await attachDistributorCodes(pharmacies);
  return pharmacies;
}

/**
 * Acknowledge a hand-entered pharmacy: a Super Admin confirms its distributor codes are real.
 *
 * This is the release valve on the "never block" rule. The order flows the whole time; this just
 * records that somebody with authority has checked the codes actually belong to this pharmacy,
 * which is what stops a mistyped code quietly mis-attributing retail sales forever.
 */
export async function acknowledgeDirectOrderPharmacy(
  access: AccessContext,
  input: { pharmacyId: string },
): Promise<void> {
  if (!(access.scope === "system" || access.role === "Super Admin")) {
    throw new Error("Forbidden: only a System Admin can acknowledge a venue.");
  }
  await markDirectOrderPharmacyVerified(access, input);
  pingDirectOrderSheet("pharmacy_verified");
}

/**
 * Confirm a pharmacy from its just-decided INVOICE validation (owner, 2026-09-14).
 *
 * The SFE Manager decides invoice validations, but the standalone acknowledge above is a System
 * Admin's action and must stay one. This is the narrow door: it admits the confirming write ONLY for a
 * pharmacy whose invoice-route claim is already approved or matched, so it cannot be used to confirm
 * an arbitrary pharmacy — which is why `markDirectOrderPharmacyVerified` itself stays private.
 */
export async function confirmDirectOrderPharmacyFromInvoiceValidation(
  access: AccessContext,
  input: { pharmacyId: string; validationId: string },
): Promise<void> {
  if (!(access.scope === "system" || access.role === "Super Admin" || access.role === "SFE Manager")) {
    throw new Error("Forbidden: only a System Admin or an SFE Manager can confirm a pharmacy from an invoice.");
  }
  const { data: validation, error } = await getSupabaseAdmin()
    .from("direct_order_pharmacy_validations")
    .select("pharmacy_id, validation_route, status")
    .eq("id", input.validationId)
    .maybeSingle();
  if (error) throw error;
  const claim = validation as { pharmacy_id?: string; validation_route?: string; status?: string } | null;
  if (
    !claim ||
    String(claim.pharmacy_id ?? "") !== input.pharmacyId ||
    claim.validation_route !== "invoice" ||
    !["approved_new", "matched_existing"].includes(String(claim.status ?? ""))
  ) {
    throw new Error("Forbidden: this pharmacy has no decided invoice validation to confirm it from.");
  }
  await markDirectOrderPharmacyVerified(access, { pharmacyId: input.pharmacyId });
  pingDirectOrderSheet("pharmacy_verified");
}

/**
 * Mark a pharmacy REJECTED — examined and found not to be real.
 *
 * A separate, deliberate act, and specifically NOT a consequence of rejecting a validation.
 * `decideDirectOrderPharmacyValidation("reject")` says "this evidence does not convince me" and
 * deliberately leaves the door open for the rep to try again; that comment is in the code and the
 * behaviour is correct. This says something much stronger and final: the pharmacy does not exist.
 *
 * Until 2026-08-05 there was no way to say it. Ten pharmacies the owner ruled false could only be
 * recorded as `pending_review` — "awaiting a look" — because the schema had no other word, and the
 * work had to be done in raw SQL against production.
 *
 * Rejecting also refuses every order still OPEN on the pharmacy. Leaving them behind would strand
 * orders on a pharmacy nobody can ever confirm: `held` has no exit but the 14-day clock once
 * validation is impossible, and `pending_approval` would keep asking approvers to judge an order
 * whose customer has already been ruled fictional.
 *
 * It does NOT touch an APPROVED order (owner, 2026-08-29). Those are returned in
 * `approvedOrdersKept` so the caller can say so out loud. See the comment on the update itself.
 */
export async function rejectDirectOrderPharmacy(
  access: AccessContext,
  input: { pharmacyId: string; reason: string },
): Promise<{
  pharmacyId: string;
  ordersRejected: number;
  /** Approved orders deliberately left standing — money committed, reversible only by a person. */
  approvedOrdersKept: number;
  approvedValueKept: number;
}> {
  if (!(access.scope === "system" || access.role === "Super Admin")) {
    throw new Error("Forbidden: only a System Admin can reject a venue as false.");
  }
  const reason = input.reason?.trim();
  if (!reason) badRequest("Say why this venue is being rejected — the reason is the record.");

  const supabase = getSupabaseAdmin();
  const { data: before } = await supabase
    .from("direct_order_pharmacies")
    .select("id, pharmacy_name, phoenix_pharmacy_code, verification_status, active")
    .eq("id", input.pharmacyId)
    .maybeSingle();
  if (!before) badRequest("Venue not found.");
  const previous = String((before as { verification_status?: string }).verification_status ?? "");
  if (previous === "rejected") badRequest("This venue is already rejected.");

  // Deactivating is what actually removes it from the picker, the directory search and the
  // probation sweep — twelve query sites filter on `active` and none filter on verification_status.
  // A rejected-but-active row would be a refusal the rest of the module ignores, so the database
  // carries a CHECK constraint enforcing the pair; this write simply honours it.
  const { error: updateError } = await supabase
    .from("direct_order_pharmacies")
    .update({ verification_status: "rejected", active: false, updated_at: new Date().toISOString() })
    .eq("id", input.pharmacyId);
  if (updateError) throw updateError;

  // AN APPROVED ORDER IS NOT TOUCHED. Owner's rule, 2026-08-29: "I don't want any confirmed order
  // and accepted from our workflow to be lost." `approved` was in this list until then, so the
  // first venue rejection carrying committed money would have reversed it automatically — from a
  // button whose subject is the VENUE, with no human ever deciding to reverse the ORDER, and with
  // the order's own approval surviving only as an event. That is the same shape the module already
  // refuses elsewhere: the system flags, a person decides.
  //
  // The other four stay, because leaving THOSE behind is what strands them: `held` has no exit but
  // the 14-day clock once validation is impossible, and `pending_approval` would keep asking
  // approvers to judge an order whose customer has been ruled fictional. None of the four is a
  // decision already taken — `approved` is the only one that is.
  const { data: openOrders, error: ordersError } = await supabase
    .from("direct_order_requests")
    .update(decidedStatusPatch("rejected"))
    .eq("pharmacy_id", input.pharmacyId)
    .in("status", ["held", "pending_approval", "returned", "draft"])
    .select("id");
  if (ordersError) throw ordersError;
  const affected = (openOrders ?? []) as Array<{ id: string }>;
  // The finance landing counts held and awaiting orders; these just closed.
  if (affected.length > 0) invalidateFinanceDashboardCache("direct orders rejected with their venue");

  // What is still standing, read AFTER the refusal above so it cannot count anything this call just
  // closed. Returned rather than merely skipped: a venue ruled false while carrying approved orders
  // is the case that most needs a person to look, and silence would leave the admin to discover it.
  const { data: standing, error: standingError } = await supabase
    .from("direct_order_requests")
    .select("id, sales_value")
    .eq("pharmacy_id", input.pharmacyId)
    .eq("status", "approved");
  if (standingError) throw standingError;
  const approvedKept = (standing ?? []) as Array<{ id: string; sales_value: number | null }>;
  const approvedValueKept = approvedKept.reduce((sum, row) => sum + Number(row.sales_value ?? 0), 0);

  for (const order of affected) {
    await insertEvent({
      requestId: order.id,
      actorHrId: access.hrId,
      eventType: "rejected",
      message: `Venue rejected as false: ${reason}`,
    });
  }

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: `pharmacy:${input.pharmacyId}`,
    oldValues: { verificationStatus: previous, active: true },
    newValues: {
      verificationStatus: "rejected",
      active: false,
      ordersRejected: affected.length,
      approvedOrdersKept: approvedKept.length,
    },
    summary:
      `Direct-order pharmacy ${String((before as { phoenix_pharmacy_code?: string }).phoenix_pharmacy_code ?? "")} ` +
      `rejected as FALSE by ${access.hrId ?? "unknown"} — ${reason}. ${affected.length} order(s) refused with it.` +
      (approvedKept.length > 0
        ? ` ${approvedKept.length} APPROVED order(s) worth ${approvedValueKept.toFixed(2)} EGP were NOT refused ` +
          "and are still standing — approved money is reversed by a person, never by rejecting the venue."
        : ""),
  });

  pingDirectOrderSheet("pharmacy_rejected");
  return {
    pharmacyId: input.pharmacyId,
    ordersRejected: affected.length,
    approvedOrdersKept: approvedKept.length,
    approvedValueKept,
  };
}

/**
 * The pharmacy write itself, with NO role check of its own.
 *
 * Two callers, authorized two different ways, which is exactly why the check cannot live in here:
 * {@link acknowledgeDirectOrderPharmacy} (the standalone registry action) gates on holding Super
 * Admin, while the approval flow gates on *being the assigned approver of the confirming rung* —
 * a District Manager can never reach it, but the SFE Manager whose rung this is must.
 *
 * Not exported: keeping it module-private is what stops a future caller from acquiring an
 * unauthenticated pharmacy write by importing the convenient-looking function.
 */
async function markDirectOrderPharmacyVerified(
  access: AccessContext,
  input: { pharmacyId: string },
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: before } = await supabase
    .from("direct_order_pharmacies")
    .select("pharmacy_name, verification_status")
    .eq("id", input.pharmacyId)
    .maybeSingle();
  if (!before) badRequest("Venue not found.");

  // A pharmacy that was examined and found false cannot be confirmed back into existence. Without
  // this, acknowledging one would flip it to `verified` AND revive every order parked on it —
  // undoing a refusal in a single click, from a screen whose button says only "confirm".
  if (String((before as { verification_status?: string }).verification_status ?? "") === "rejected") {
    badRequest(
      "This pharmacy was rejected as false and cannot be confirmed. If that decision was wrong, it has to be reversed deliberately, not by confirming.",
    );
  }

  const { error } = await supabase
    .from("direct_order_pharmacies")
    .update({
      verification_status: "verified",
      verified_by_hr_id: hrIdForStorage(access.hrId),
      verified_at: new Date().toISOString(),
    })
    .eq("id", input.pharmacyId);
  if (error) throw error;

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: `pharmacy:${input.pharmacyId}`,
    oldValues: { verificationStatus: (before as { verification_status?: string }).verification_status ?? null },
    newValues: { verificationStatus: "verified" },
    summary: `Direct-order venue acknowledged by ${access.hrId ?? "unknown"}.`,
  });

  // Validation is the ONE door out of `held` (spec B6). Every order parked on this pharmacy
  // revives the moment somebody with authority confirms the identity — no separate button,
  // no second decision to forget.
  await reviveHeldDirectOrdersForPharmacy(access, input.pharmacyId);
}

/**
 * Revive every held order of a just-validated pharmacy: seed its chain FRESH (built at revival,
 * so it names today's managers, not the managers of the day it was parked) and move it to
 * `pending_approval` at step 1.
 *
 * Registry-gated per order with `revive_held` — if the registry says the actor's role cannot
 * revive, the order stays held and says so, rather than sliding into the chain unchecked.
 */
type MoveHeldIntoChainOptions = {
  /** Registry action gating each request. */
  actionKey: "revive_held" | "release_held";
  eventType: string;
  /** Words for the audit line, the event, and the notification — they differ per door. */
  auditSummary: (actorHrId: string) => string;
  eventMessage: string;
  noticeTitle: string;
  noticeSuffix: string;
};

/**
 * Move a pharmacy's held orders into the approval chain — the shared core behind BOTH doors.
 *
 * `revive_held` is "the pharmacy passed validation". `release_held` is "the distributor code proves
 * it, or a System Admin judged it" — a different authority with a different audit line, which is
 * exactly why it is a separate registry action and not a reuse of revive (the same reasoning that
 * made `cancel_held` its own action rather than a reuse of `rejected`).
 *
 * Everything here was written against a real incident and is shared rather than copied: the
 * per-request failure aggregation, the stale-step wipe, the chain rebuilt fresh so it names today's
 * managers, the `.eq("status","held")` race guard AND the check that it matched a row.
 */
async function moveHeldDirectOrdersIntoChain(
  access: AccessContext,
  pharmacyId: string,
  opts: MoveHeldIntoChainOptions,
): Promise<number> {
  const supabase = getSupabaseAdmin();
  const { data: heldRows, error } = await supabase
    .from("direct_order_requests")
    .select("*")
    .eq("pharmacy_id", pharmacyId)
    .eq("status", "held");
  if (error) throw error;
  const requests = ((heldRows ?? []) as Array<Record<string, unknown>>).map(mapRequestRow);
  if (requests.length === 0) return 0;

  const pharmacy = (await loadPharmaciesByIds([pharmacyId])).get(pharmacyId) ?? null;
  const resolveName = await nameLookup();

  // Each request is revived independently and the loop is RE-RUNNABLE, which is what makes a
  // single wrapping transaction unnecessary here (raised by the automated review on PR #1738).
  //
  // The unit of consistency is one request, not the batch: its steps are seeded before its status
  // moves, and the status update is guarded on `.eq("status", "held")`. So a failure part-way
  // through leaves earlier requests correctly revived and later ones still held — never a
  // half-revived request. Re-running (the pharmacy is confirmed again, or the Held Desk retries)
  // picks up exactly the ones still held and finishes the job.
  //
  // The deliberate trade-off: one failing request must not strand its siblings, so a per-request
  // failure is recorded and the loop continues rather than aborting the whole batch.
  const failures: Array<{ requestId: string; error: unknown }> = [];
  for (const request of requests) {
    try {
    // The row's REAL status, not a constant (audit F6). The query above filters on
    // `.eq("status","held")`, so a literal would only re-state what that filter already guaranteed
    // — two checks with one buckle. Reading the row means the gate can still catch a request whose
    // status moved between the fetch and this loop, which is exactly the anomaly it exists for.
    await assertDirectOrderWorkflowTransition({
      access,
      actionKey: opts.actionKey,
      expectedNextStatus: "pending_approval",
      status: request.status,
    });

    const chain = await buildApprovalChain({
      requesterHrId: request.requesterHrId,
      requesterRole: request.requesterRole,
    });

    // Replace any stale steps defensively — a held order should have none, but a partial revival
    // that died between writes must not leave two chains behind.
    const { error: wipeError } = await supabase
      .from("direct_order_approval_steps")
      .delete()
      .eq("request_id", request.id);
    if (wipeError) throw wipeError;
    const { error: seedError } = await supabase.from("direct_order_approval_steps").insert(
      chain.map((step) => ({
        request_id: request.id,
        step_order: step.order,
        approver_kind: step.kind,
        approver_role: step.role,
        approver_hr_id: step.approverHrId,
        label: step.label,
        status: "pending",
      })),
    );
    if (seedError) throw seedError;

    const { data: updatedRows, error: updateError } = await supabase
      .from("direct_order_requests")
      .update({ status: "pending_approval", held_at: null })
      .eq("id", request.id)
      .eq("status", "held")
      .select("id");
    if (updateError) throw updateError;
    // The `.eq("status","held")` guard is a race guard, and until now nothing checked whether it
    // actually matched. If the 14-day expiry cron fires between seeding the steps above and this
    // update, the request is already `expired` — the update quietly matches zero rows, and the
    // caller is told the revive succeeded while an expired request now carries a full pending
    // chain. cancelHeldDirectOrder already checks this exact case; this is the same guard.
    if ((updatedRows ?? []).length === 0) {
      throw new Error(
        `Request ${request.id} was no longer held when the chain was seeded (most likely expired or cancelled in the meantime).`,
      );
    }
    // Held → awaiting approval moves the finance landing's held and awaiting counts.
    invalidateFinanceDashboardCache("held direct order revived");

    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? access.hrId,
      entityType: "direct_order_request",
      entityId: request.id,
      oldValues: { status: "held" },
      newValues: { status: "pending_approval" },
      summary: opts.auditSummary(access.hrId ?? "unknown"),
    });
    await insertEvent({
      requestId: request.id,
      actorHrId: access.hrId,
      eventType: opts.eventType,
      message: opts.eventMessage,
    });

    // After the reply (afterResponse): every caller is a button (pharmacy validation, the Held Desk
    // release, the cleanup), the order has already moved, and a failed notice must not turn a moved
    // order into a reported "could not be revived".
    await afterResponse("direct_order_notice:held_released", async () => {
      const requesterDisplayName = resolveName(request.requesterHrId) ?? request.requesterHrId;
      const notifyContext = await buildNotifyContext(request, requesterDisplayName, pharmacy);
      const firstStep = chain[0];
      const firstApprovers = firstStep.kind === "role" && firstStep.role ? await hrIdsForRole(firstStep.role) : [firstStep.approverHrId];
      // The requester already knows their order moved (they either just passed pharmacy validation
      // or asked the Held Desk to release it) — only the approver who must now act needs telling.
      await notifyDirectOrder({
        recipients: firstApprovers,
        title: opts.noticeTitle,
        message: `${buildDirectOrderNotificationLine(notifyContext)} ${opts.noticeSuffix}`,
        metrics: buildDirectOrderNotificationMetrics(notifyContext),
        eventType: opts.eventType,
        requestId: request.id,
        subjectHrId: request.requesterHrId,
      });
    });
    } catch (reviveError) {
      failures.push({ requestId: request.id, error: reviveError });
      logError("Moving a held direct order into the chain failed; its siblings were unaffected", {
        labels: { event: "direct_order_revive_failed", requestId: request.id, actionKey: opts.actionKey },
        error: reviveError,
      });
    }
  }

  // Surfaced, never swallowed: the caller (pharmacy validation) must learn that some orders are
  // still held, or a rep would be told their pharmacy is confirmed while their order sits frozen.
  if (failures.length > 0) {
    throw new Error(
      `${failures.length} of ${requests.length} held order(s) could not be revived and remain held: ` +
        failures.map((f) => f.requestId).join(", "),
    );
  }
  return requests.length;
}

/** Door 1: the pharmacy passed validation. Unchanged behaviour — now a thin wrapper. */
async function reviveHeldDirectOrdersForPharmacy(access: AccessContext, pharmacyId: string): Promise<void> {
  await moveHeldDirectOrdersIntoChain(access, pharmacyId, {
    actionKey: "revive_held",
    eventType: "revived",
    auditSummary: (actor) => `Direct order revived after pharmacy validation by ${actor} — entering the chain at step 1.`,
    eventMessage: "Pharmacy validated — request entered the approval chain at step 1.",
    noticeTitle: "Direct order released — pharmacy validated",
    noticeSuffix: "The pharmacy passed validation; the request is now with its first approver.",
  });
}

/**
 * Door 2 (owner rule, 2026-08-08): release without a validation decision.
 *
 * Two grounds, and they are NOT interchangeable:
 *   - `code_proven`     — the distributor customer code resolves in the master database and its
 *                         brick agrees with the request. Evidence, not judgement.
 *   - `admin_released`  — no code proves anything (the live case is a placeholder like PS/000000),
 *                         so a System Admin looked and took responsibility. Judgement, recorded.
 *
 * NEVER writes `verification_status`. The pharmacy stays unconfirmed and the chain's first rung is
 * still the SFE Manager — this changes WHERE the order sits, never whether it was reviewed.
 */
export async function releaseHeldDirectOrdersForPharmacy(
  access: AccessContext,
  input: { pharmacyId: string; ground: "code_proven" | "admin_released"; reason?: string | null },
): Promise<{ pharmacyId: string; released: number }> {
  assertHeldDeskAccess(access);
  const reason = String(input.reason ?? "").trim();
  if (input.ground === "admin_released" && !reason) {
    badRequest("A reason is required when a System Admin releases a held request.");
  }

  // Written BEFORE the orders move, so a later submit on this pharmacy is consistent with the
  // orders already released rather than re-freezing behind them.
  if (input.ground === "admin_released") {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from("direct_order_pharmacies")
      .update({
        hold_release_ground: "admin_released",
        hold_release_reason: reason,
        hold_release_decided_by_hr_id: hrIdForStorage(access.hrId),
        hold_release_decided_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", input.pharmacyId);
    if (error) throw error;
  }

  const released = await moveHeldDirectOrdersIntoChain(access, input.pharmacyId, {
    actionKey: "release_held",
    eventType: "released",
    auditSummary: (actor) =>
      input.ground === "code_proven"
        ? `Direct order released by ${actor}: the distributor customer code is in the master database and its brick matches the request. The pharmacy remains unconfirmed and still faces the SFE rung.`
        : `Direct order released by ${actor} on their own judgement (no code proves the pharmacy). Reason: ${reason}`,
    eventMessage:
      input.ground === "code_proven"
        ? "Distributor code verified against the master database — request entered the approval chain at step 1."
        : `Released by a System Admin — request entered the approval chain at step 1. Reason: ${reason}`,
    noticeTitle: "Direct order released into the approval chain",
    noticeSuffix: "It is now with its first approver; the pharmacy itself still has to be confirmed at the SFE rung.",
  });

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: `pharmacy:${input.pharmacyId}`,
    newValues: { holdReleaseGround: input.ground, released },
    summary: `${released} held order(s) released into the approval chain (${input.ground}).`,
  });
  pingDirectOrderSheet("held_released");
  return { pharmacyId: input.pharmacyId, released };
}

/**
 * Door 3: a System Admin looked at an unprovable pharmacy and ruled its orders STAY held.
 *
 * Changes no status — the value is the recorded decision. Without it, "nobody has looked yet" and
 * "somebody looked and said no" are the same empty state, which is how a request sits untouched
 * until the 14-day clock kills it and nobody can say whether that was intended.
 */
export async function keepDirectOrderHeld(
  access: AccessContext,
  input: { pharmacyId: string; reason: string },
): Promise<{ pharmacyId: string; ordersHeld: number }> {
  assertHeldDeskAccess(access);
  const reason = String(input.reason ?? "").trim();
  if (!reason) badRequest("A reason is required to record that a request stays held.");

  const supabase = getSupabaseAdmin();
  const { data: heldRows, error } = await supabase
    .from("direct_order_requests")
    .select("*")
    .eq("pharmacy_id", input.pharmacyId)
    .eq("status", "held");
  if (error) throw error;
  const requests = ((heldRows ?? []) as Array<Record<string, unknown>>).map(mapRequestRow);

  for (const request of requests) {
    // Gated on the row's REAL status (audit F6), and `to: 'held'` — the registry knows this action
    // deliberately does not move anything.
    await assertDirectOrderWorkflowTransition({
      access,
      actionKey: "keep_held",
      expectedNextStatus: "held",
      status: request.status,
    });
  }

  const { error: updateError } = await supabase
    .from("direct_order_pharmacies")
    .update({
      hold_release_ground: "kept_held",
      hold_release_reason: reason,
      hold_release_decided_by_hr_id: hrIdForStorage(access.hrId),
      hold_release_decided_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.pharmacyId);
  if (updateError) throw updateError;

  for (const request of requests) {
    await insertEvent({
      requestId: request.id,
      actorHrId: access.hrId,
      eventType: "held_decision_recorded",
      message: `A System Admin reviewed this held request and decided it stays held. Reason: ${reason}`,
    });
  }

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: `pharmacy:${input.pharmacyId}`,
    newValues: { holdReleaseGround: "kept_held", reason, ordersHeld: requests.length },
    summary: `${requests.length} held order(s) deliberately kept held by a System Admin. Reason: ${reason}`,
  });
  return { pharmacyId: input.pharmacyId, ordersHeld: requests.length };
}

/**
 * Door 4 (Task B): link the code that was typed into the WRONG FIELD.
 *
 * The live case: pharmacy DOP-000017 was registered with the name "1573270" — a real PS customer
 * code — and no code linked at all. Verifying it did not fix that: with no code row,
 * loadPharmacyRetailHistory reports `unmatchable` forever and its retail sales attach to nobody.
 *
 * So this writes the link (the durable repair), optionally corrects the name, and only then
 * re-evaluates the hold. Auto-releasing without linking would put the order in the chain while SFE
 * still reads "no code on file" — which is why the owner chose surface-and-confirm over automatic.
 */
/**
 * Who else already holds this exact (distributor, customer code) pair?
 *
 * The auto-link twin of attachCodeOwnership, for a pair that is NOT yet on the pharmacy. Same
 * fail-closed contract: an unavailable check returns "unknown", which the rule treats as owned, so a
 * database hiccup can never be the reason two pharmacies end up pointing at one customer.
 */
async function findOtherPharmacyHoldingCode(
  pharmacyId: string,
  distributorCode: string,
  customerCode: string,
): Promise<string | null> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("direct_order_pharmacy_distributor_codes")
      .select("pharmacy_id")
      .eq("distributor_code", distributorCode)
      .eq("customer_code", customerCode)
      .neq("pharmacy_id", pharmacyId)
      .limit(1);
    if (error) throw error;
    const row = (data ?? [])[0] as { pharmacy_id?: string } | undefined;
    return row?.pharmacy_id ? String(row.pharmacy_id) : null;
  } catch (error) {
    logError("Direct order auto-link ownership check failed", {
      labels: { event: "direct_order_auto_link_ownership_check_failed", pharmacyId },
      error,
    });
    return "unknown";
  }
}

export type DirectOrderAutoLinkOutcome = {
  linked: boolean;
  distributorCode: string | null;
  customerCode: string | null;
  renamedTo: string | null;
  refusal: DirectOrderAutoLinkRefusal | null;
};

/**
 * Link a misplaced distributor code automatically (owner rule, 2026-08-08 — "if the pharmacy matches
 * automatic link").
 *
 * SYSTEM action, not a user action: it runs at registration and at submit, where the actor is a
 * District Manager with no Held Desk rights. That is why it takes no AccessContext and never calls
 * assertHeldDeskAccess — the authority comes from `decideDirectOrderAutoLink` refusing everything
 * ambiguous, not from the caller's role. `actorLoginId` is recorded as the submitter when known so
 * the audit trail still names a human, with the summary stating the write was automatic.
 *
 * FAIL SOFT, ALWAYS. Registration and submission must never break because a convenience repair could
 * not run. Every failure path logs and returns `linked: false`; nothing here throws.
 */
export async function autoLinkDirectOrderPharmacyCode(
  pharmacyId: string,
  options: { actorLoginId?: string | null } = {},
): Promise<DirectOrderAutoLinkOutcome> {
  const nothing: DirectOrderAutoLinkOutcome = {
    linked: false,
    distributorCode: null,
    customerCode: null,
    renamedTo: null,
    refusal: null,
  };
  try {
    const pharmacy = (await loadPharmaciesByIds([pharmacyId])).get(pharmacyId) ?? null;
    if (!pharmacy) return nothing;

    // Cheap gate first: the candidate search hits the directory rollup, so do not run it for a
    // pharmacy whose name is a name, or one that already carries a code.
    const preflight = decideDirectOrderAutoLink({
      pharmacyName: pharmacy.pharmacyName,
      existingCodes: pharmacy.distributorCodes ?? [],
      candidates: [],
    });
    if (!preflight.link && preflight.refusal !== "no_candidate") {
      return { ...nothing, refusal: preflight.refusal };
    }

    const found = await findPossibleDistributorMatchesByPharmacyName(pharmacy.pharmacyName);
    const candidates = await Promise.all(
      found.map(async (match) => ({
        ...match,
        ownedByOtherPharmacyId: await findOtherPharmacyHoldingCode(pharmacyId, match.distributorCode, match.customerCode),
      })),
    );

    const decision = decideDirectOrderAutoLink({
      pharmacyName: pharmacy.pharmacyName,
      existingCodes: pharmacy.distributorCodes ?? [],
      candidates,
    });
    if (!decision.link) return { ...nothing, refusal: decision.refusal };

    // Re-read the authoritative row before writing. The candidate came from the directory rollup,
    // which carries no region_code and is a derived view — customer_map is the record of truth, and
    // it is what the manual link path already trusts.
    const supabase = getSupabaseAdmin();
    const { data: masterRow } = await supabase
      .from("source_of_sales_customer_map")
      .select("distributor_code, customer_code, customer_name, brick_id, area_code, region_code")
      .eq("distributor_code", decision.candidate.distributorCode)
      .eq("customer_code", decision.candidate.customerCode)
      .eq("active", true)
      .maybeSingle();
    if (!masterRow) return { ...nothing, refusal: "no_candidate" };
    const master = masterRow as Record<string, unknown>;

    const distributorCode = String(master.distributor_code ?? decision.candidate.distributorCode);
    // The MASTER's own spelling, padding included — retail matching compares these as strings.
    const customerCode = String(master.customer_code ?? decision.candidate.customerCode);

    const { error: insertError } = await supabase.from("direct_order_pharmacy_distributor_codes").insert({
      pharmacy_id: pharmacyId,
      distributor_code: distributorCode,
      customer_code: customerCode,
      mapped_brick_id: master.brick_id ?? null,
      mapped_area_code: master.area_code ?? null,
      mapped_region_code: master.region_code ?? null,
    });
    if (insertError) {
      // 23505 = another writer got there first. That is the desired end state, not a failure.
      if (String((insertError as { code?: string }).code) !== "23505") throw insertError;
      return { ...nothing, refusal: "already_linked" };
    }

    let renamedTo: string | null = null;
    const masterName = String(master.customer_name ?? "").trim();
    if (decision.renameTo && masterName) {
      const { error: renameError } = await supabase
        .from("direct_order_pharmacies")
        .update({ pharmacy_name: masterName, updated_at: new Date().toISOString() })
        .eq("id", pharmacyId);
      if (renameError) throw renameError;
      renamedTo = masterName;
    }

    await writeRequiredAuditLog({
      actorLoginId: options.actorLoginId ?? "system",
      entityType: "direct_order_request",
      entityId: `pharmacy:${pharmacyId}`,
      oldValues: { pharmacyName: pharmacy.pharmacyName, distributorCode: null, customerCode: null },
      newValues: { pharmacyName: renamedTo ?? pharmacy.pharmacyName, distributorCode, customerCode },
      summary: `AUTOMATIC: distributor customer code ${distributorCode}/${customerCode} linked to this pharmacy — the code had been typed into the pharmacy NAME field, and it matched exactly one distributor customer.${renamedTo ? ` Name corrected to "${renamedTo}" (was "${pharmacy.pharmacyName}").` : ""}`,
    });

    return { linked: true, distributorCode, customerCode, renamedTo, refusal: null };
  } catch (error) {
    // Never break a registration or a submission over a convenience repair.
    logError("Direct order auto-link failed", {
      labels: { event: "direct_order_auto_link_failed", pharmacyId },
      error,
    });
    return nothing;
  }
}

export async function linkDirectOrderPharmacyCode(
  access: AccessContext,
  input: { pharmacyId: string; distributorCode: string; customerCode: string; renameToCustomerName?: boolean },
): Promise<{ pharmacyId: string; released: number; renamedTo: string | null }> {
  assertHeldDeskAccess(access);
  const supabase = getSupabaseAdmin();

  // Re-read the pair from the master rather than trusting the client — fail closed if it is gone,
  // exactly as decideDirectOrderPharmacyValidation does before it acts on a match.
  const { data: masterRow } = await supabase
    .from("source_of_sales_customer_map")
    .select("distributor_code, customer_code, customer_name, brick_id, area_code, region_code")
    .eq("distributor_code", input.distributorCode)
    .eq("customer_code", input.customerCode)
    .eq("active", true)
    .maybeSingle();
  if (!masterRow) {
    badRequest("That distributor customer code is no longer in the master database — nothing was linked.");
  }
  const master = masterRow as Record<string, unknown>;

  const { error: insertError } = await supabase.from("direct_order_pharmacy_distributor_codes").insert({
    pharmacy_id: input.pharmacyId,
    distributor_code: String(master.distributor_code ?? input.distributorCode),
    // The MASTER's own spelling, padding included — retail matching compares these as strings.
    customer_code: String(master.customer_code ?? input.customerCode),
    mapped_brick_id: master.brick_id ?? null,
    mapped_area_code: master.area_code ?? null,
    mapped_region_code: master.region_code ?? null,
  });
  if (insertError) {
    if (String((insertError as { code?: string }).code) === "23505") {
      badRequest("This pharmacy already holds a customer code for that distributor.");
    }
    throw insertError;
  }

  let renamedTo: string | null = null;
  const masterName = String(master.customer_name ?? "").trim();
  if (input.renameToCustomerName && masterName) {
    const { data: before } = await supabase
      .from("direct_order_pharmacies")
      .select("pharmacy_name")
      .eq("id", input.pharmacyId)
      .maybeSingle();
    const { error: renameError } = await supabase
      .from("direct_order_pharmacies")
      .update({ pharmacy_name: masterName, updated_at: new Date().toISOString() })
      .eq("id", input.pharmacyId);
    if (renameError) throw renameError;
    renamedTo = masterName;
    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? access.hrId,
      entityType: "direct_order_request",
      entityId: `pharmacy:${input.pharmacyId}`,
      oldValues: { pharmacyName: (before as { pharmacy_name?: string } | null)?.pharmacy_name ?? null },
      newValues: { pharmacyName: masterName },
      summary: `Pharmacy renamed to its master-database customer name after a code was found in the name field.`,
    });
  }

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: `pharmacy:${input.pharmacyId}`,
    newValues: { distributorCode: input.distributorCode, customerCode: input.customerCode },
    summary: `Distributor customer code ${input.distributorCode}/${input.customerCode} linked to this pharmacy (it had been typed into the pharmacy NAME field).`,
  });

  // Now re-evaluate. Linking a code that resolves in the declared brick makes the pharmacy proven,
  // so its held orders can join the chain — through the same shared rule the submit fork uses.
  const pharmacy = (await loadPharmaciesByIds([input.pharmacyId])).get(input.pharmacyId) ?? null;
  let released = 0;
  if (pharmacy) {
    const decision = decideDirectOrderHold({
      verificationStatus: pharmacy.verificationStatus,
      declaredBrickId: pharmacy.brickId,
      distributorCodes: await attachCodeOwnership(pharmacy),
      holdReleaseGround: pharmacy.holdReleaseGround,
    });
    if (!decision.hold && decision.ground === "code_proven") {
      ({ released } = await releaseHeldDirectOrdersForPharmacy(access, {
        pharmacyId: input.pharmacyId,
        ground: "code_proven",
      }));
    }
  }
  return { pharmacyId: input.pharmacyId, released, renamedTo };
}

/**
 * The 14-day clock (spec B6): expire every held order whose `held_at` is past the deadline.
 * Called by the cron sweep with the system context; each expiry is logged, evented, counted —
 * a held order never just disappears, it dies with a record and a name.
 */
export async function expireStaleHeldDirectOrders(
  access: AccessContext,
  input?: { now?: Date; holdDays?: number },
): Promise<{ expired: number }> {
  if (!(access.scope === "system" || access.role === "Super Admin")) {
    throw new Error("Forbidden: only the system or a Super Admin can expire held orders.");
  }
  const holdDays = input?.holdDays ?? 14;
  const now = input?.now ?? new Date();
  const deadline = new Date(now.getTime() - holdDays * 24 * 60 * 60 * 1000).toISOString();

  const supabase = getSupabaseAdmin();
  const { data: stale, error } = await supabase
    .from("direct_order_requests")
    .select("*")
    .eq("status", "held")
    .not("held_at", "is", null)
    .lte("held_at", deadline);
  if (error) throw error;
  const requests = ((stale ?? []) as Array<Record<string, unknown>>).map(mapRequestRow);

  const resolveName = await nameLookup();
  let expired = 0;
  for (const request of requests) {
    // The row's REAL status (audit F6). The sweep fetches on `.eq("status","held")` and then
    // iterates; a request revived by a validation in between must be refused here rather than
    // expired against a constant that says "held" because the code assumed it.
    await assertDirectOrderWorkflowTransition({
      access,
      actionKey: "expire_held",
      expectedNextStatus: "expired",
      status: request.status,
    });
    const { error: updateError } = await supabase
      .from("direct_order_requests")
      .update(decidedStatusPatch("expired"))
      .eq("id", request.id)
      .eq("status", "held");
    if (updateError) throw updateError;
    expired += 1;

    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? access.hrId,
      entityType: "direct_order_request",
      entityId: request.id,
      oldValues: { status: "held" },
      newValues: { status: "expired" },
      summary: `Direct order expired — held ${holdDays} days without a valid venue (requester ${request.requesterHrId}).`,
    });
    await insertEvent({
      requestId: request.id,
      actorHrId: null,
      eventType: "expired",
      message: `Held ${holdDays} days without venue validation — expired automatically.`,
    });

    const requesterDisplayName = resolveName(request.requesterHrId) ?? request.requesterHrId;
    const pharmacy = (await loadPharmaciesByIds([request.pharmacyId])).get(request.pharmacyId) ?? null;
    const notifyContext = await buildNotifyContext(request, requesterDisplayName, pharmacy);
    await notifyDirectOrder({
      recipients: [request.requesterHrId, ...(await ccRecipients())],
      title: "Direct order expired — the venue was never validated",
      message:
        `${buildDirectOrderNotificationLine(notifyContext)} ` +
        `This request stayed held for ${holdDays} days without the pharmacy passing validation, so it expired. ` +
        "Submit it again with a pharmacy from the master database.",
      metrics: buildDirectOrderNotificationMetrics(notifyContext),
      eventType: "expired",
      requestId: request.id,
      subjectHrId: request.requesterHrId,
    });
  }
  if (expired > 0) pingDirectOrderSheet("held_expired");
  return { expired };
}

/**
 * Cancel a HELD direct order — the requester withdrawing a duplicate, or one raised in error
 * (deep workflow audit, finding F3).
 *
 * `held` used to have exactly two exits: the pharmacy passing validation, and the 14-day clock.
 * A requester who submitted the same order twice — which is what happens when the first attempt
 * cannot find a valid pharmacy code, and did happen on 2026-08-04, 22 minutes apart — had no way to
 * retire the duplicate. Retiring one required raw SQL against production, which bypassed the
 * registry precisely because the registry had no word for it.
 *
 * The result is `cancelled`, never `rejected`. A duplicate its author tidied up is not an order an
 * approver turned down, and merging the two would inflate every rejection rate and per-rep counter
 * that groups by status.
 */
export async function cancelHeldDirectOrder(
  access: AccessContext,
  input: { requestId: string; reason: string },
): Promise<{ requestId: string; status: "cancelled" }> {
  await assertPermission(access, "direct_orders", "create");
  const actorHrId = requireActorHrId(access);
  const reason = input.reason?.trim();
  if (!reason) badRequest("A reason is required to cancel a held direct order.");

  // Read through getDirectOrderRequest, never a raw admin query. The scope guard lives at that
  // choke point, and it returns null for out-of-scope as well as for missing — so an id cannot be
  // used to probe which requests exist. Reading the row directly is the exact hole that let any
  // `direct_orders:create` holder reverse any approved order in the company (F5).
  const detail = await getDirectOrderRequest(access, input.requestId);
  if (!detail) badRequest("Direct order request not found.");

  // Wrong STATE and wrong PERSON are different answers and must not collapse into one. Telling a
  // requester "forbidden" when the real problem is that their order already left the held lane
  // sends them to ask for permissions they already have.
  if (detail.request.status !== "held") {
    badRequest(
      `Only a held direct order can be cancelled — this one is ${detail.request.status}. ` +
        "An order already in the approval chain is withdrawn by an approver returning or rejecting it.",
    );
  }
  // Narrower than "can view": viewing is granted to chain members and managers, cancelling is not.
  // Same predicate the two pages call, so the button and the server cannot drift apart.
  if (!canCancelHeldDirectOrder({ hrId: access.hrId, role: access.role }, detail)) {
    throw new Error(
      "Forbidden: only the requester of a held direct order, or a Super Admin, can cancel it.",
    );
  }

  // The row's ACTUAL status, not a literal. The other gate sites pass a constant, which makes the
  // registry check validate what the code expects rather than what the database holds — so it can
  // never catch an anomaly (F6). Passing the real value keeps the two checks independent.
  await assertDirectOrderWorkflowTransition({
    access,
    actionKey: "cancel_held",
    expectedNextStatus: "cancelled",
    status: detail.request.status,
  });

  const supabase = getSupabaseAdmin();
  const { data: updated, error: updateError } = await supabase
    .from("direct_order_requests")
    .update(decidedStatusPatch("cancelled"))
    .eq("id", detail.request.id)
    .eq("status", "held")
    .select("id");
  if (updateError) throw updateError;
  // The `.eq("status","held")` guard is a real race, not a formality: a pharmacy validating at this
  // moment revives the order to `pending_approval`, and this update then matches NOTHING. Reporting
  // success there would tell the requester their duplicate was withdrawn while it actually sat in
  // an approver's queue — so an empty result is an error, not a no-op.
  if (!updated || updated.length === 0) {
    badRequest(
      "This request is no longer held — it was revived or expired a moment ago. Reload it and check its current state.",
    );
  }
  invalidateFinanceDashboardCache("held direct order cancelled");

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: detail.request.id,
    oldValues: { status: "held" },
    newValues: { status: "cancelled" },
    summary: `Direct order cancelled while held by ${actorHrId} — ${reason}`,
  });
  await insertEvent({
    requestId: detail.request.id,
    actorHrId,
    eventType: "cancelled",
    message: `Withdrawn while held: ${reason}`,
  });

  // The requester is told even when they cancelled it themselves — a Super Admin tidying up on
  // their behalf is the case that matters, and one rule covers both. In-app and Telegram still
  // reach requester + SFE + Super Admin; email is dropped entirely — withdrawing one's own
  // duplicate is not news worth an inbox entry.
  // After the reply (afterResponse): the order is saved, and this notice's reads and fan-out used to be
  // awaited before the answer left — seconds on production. A failed notice is logged, never thrown.
  await afterResponse("direct_order_notice:cancelled_held", async () => {
    const resolveName = await nameLookup();
    const requesterDisplayName = resolveName(detail.request.requesterHrId) ?? detail.request.requesterHrId;
    // getDirectOrderRequest returns { request, steps } — it does not carry the pharmacy, so it is
    // loaded here the same way every other notification in this file does it.
    const pharmacy =
      (await loadPharmaciesByIds([detail.request.pharmacyId])).get(detail.request.pharmacyId) ?? null;
    const notifyContext = await buildNotifyContext(detail.request, requesterDisplayName, pharmacy);
    await notifyDirectOrder({
      recipients: [detail.request.requesterHrId, ...(await ccRecipients())],
      channels: ["in_app", "telegram"],
      title: "Direct order cancelled while held",
      message:
        `${buildDirectOrderNotificationLine(notifyContext)} ` +
        `It was withdrawn from the held lane by ${resolveName(actorHrId) ?? actorHrId}. Reason: ${reason}`,
      metrics: buildDirectOrderNotificationMetrics(notifyContext),
      eventType: "cancelled",
      requestId: detail.request.id,
      subjectHrId: detail.request.requesterHrId,
    });
  });

  pingDirectOrderSheet("held_cancelled");
  return { requestId: detail.request.id, status: "cancelled" };
}

// ── The Held Desk (spec C3) ───────────────────────────────────────────────────


const HELD_ORDER_LIFETIME_DAYS = 14;

export type HeldDirectOrderRow = {
  id: string;
  requesterHrId: string;
  requesterName: string;
  requesterRole: PhoenixRole;
  /** Every product joined with " + " on a basket; the one product's name otherwise. */
  productName: string;
  /** The one product's units; NULL on a basket — units of different products are never added. */
  qty: number | null;
  /** One entry per product, each with ITS OWN units. What the desk prints. */
  items: DirectOrderBasketLine[];
  salesValue: number;
  pharmacyId: string;
  pharmacyName: string;
  phoenixPharmacyCode: string;
  heldAt: string | null;
  /** Whole days until the 14-day expiry sweep takes it (0 = expiring today). */
  daysRemaining: number;
  /** When the last held-notice email went out for this request, if ever. */
  lastNoticeAt: string | null;
  // ── Why it is held, and what the admin needs to decide (added 2026-08-08) ──────────────────
  // The desk previously showed a name, a date and a countdown, and nothing about the CODE — the
  // one fact that determines whether the order should be held at all. An admin had to leave the
  // page to find out anything actionable.
  /** From the shared rule: unproven | code_conflict | pharmacy_rejected | admin_released | … */
  holdGround: DirectOrderHoldGround;
  holdGroundNote: string;
  declaredBrickId: string | null;
  declaredAreaCode: string | null;
  /** Every code on file, with what the master database maps it to. */
  distributorCodes: Array<{
    distributorCode: string;
    distributorName: string;
    customerCode: string;
    mappedBrickId: string | null;
    mappedAreaCode: string | null;
  }>;
  /** Resolving codes that nonetheless failed the release test, and why. */
  conflicts: DirectOrderHoldConflict[];
  /**
   * Only when NO code is linked: real customers whose code equals this pharmacy's stored NAME.
   * This is the "typed into the wrong field" repair, surfaced for one click rather than applied.
   */
  nameCodeCandidates: DirectOrderPossibleDistributorMatch[];
  /** A System Admin's standing ruling on this pharmacy, if one was recorded. */
  holdReleaseGround: "admin_released" | "kept_held" | null;
  holdReleaseReason: string | null;
  holdReleaseDecidedAt: string | null;
};

function assertHeldDeskAccess(access: AccessContext): void {
  if (!(access.scope === "system" || access.role === "Super Admin")) {
    throw new Error("Forbidden: the Held Desk is System Admin only.");
  }
}

/** One returned order, with its age and the comment the rep still has to answer. */
export type ReturnedDirectOrderAgeingRow = {
  id: string;
  requesterHrId: string;
  requesterName: string;
  /** Every product joined with " + " on a basket; the one product's name otherwise. */
  productName: string;
  /** The one product's units; NULL on a basket — units of different products are never added. */
  qty: number | null;
  /** One entry per product, each with ITS OWN units. What the desk and Stuck Approvals print. */
  items: DirectOrderBasketLine[];
  salesValue: number;
  pharmacyId: string;
  pharmacyName: string;
  phoenixPharmacyCode: string;
  /** Codes on the venue — several returns turn on the venue being on the wrong distributor. */
  distributorCodes: string[];
  /** The last `returned` event, falling back to submission when none was recorded. */
  returnedAt: string | null;
  /** Whole days since it was returned. `returned` has no expiry clock, so this only grows. */
  daysWaiting: number;
  /** The approver's own words. NEVER truncated — it IS the question the rep must answer. */
  returnReason: string | null;
};

/**
 * Every order sitting in `returned`, oldest first.
 *
 * WHY THIS DESK EXISTS. `returned` is the one queue with no clock and no chaser. `held` expires
 * after 14 days and has a notice button; `pending_approval` sits in an approver's inbox. A
 * returned order goes back to the rep and then nothing happens to it again — it is on nobody's
 * screen, so it ages in silence. Measured on production 2026-09-08: 13 orders, 105,939 EGP, the
 * oldest 27 days, and EVERY ONE had zero activity since the day it was returned.
 *
 * NO EXPIRY IS ADDED HERE, deliberately. Killing an order the rep may never have seen would
 * destroy real work to tidy a queue; the answer to "nobody looked" is to make it visible.
 *
 * The reason comes from the last `returned` EVENT rather than a column, because that is where the
 * approver actually types it, and it is the only text that tells the rep what to change.
 */
export async function listReturnedDirectOrdersAgeing(
  access: AccessContext,
): Promise<ReturnedDirectOrderAgeingRow[]> {
  await assertPermission(access, "direct_orders", "read");
  assertHeldDeskAccess(access);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("direct_order_requests")
    .select("*")
    .eq("status", "returned")
    .order("created_at", { ascending: true });
  if (error) throw error;
  const requests = ((data ?? []) as Array<Record<string, unknown>>).map(mapRequestRow);
  if (requests.length === 0) return [];

  const [pharmacies, resolveName, itemsByRequest, eventResult] = await Promise.all([
    loadPharmaciesByIds(requests.map((request) => request.pharmacyId)),
    nameLookup(),
    // Every product on every returned order. Without it a basket named line 1 alone beside the
    // whole basket's value — on this desk and on Stuck Approvals, which reads these same rows.
    loadDirectOrderItemsForRequests(requests.map((request) => request.id)),
    // Newest first, so the FIRST row seen per request is its latest return — an order can be
    // returned, corrected and returned again, and only the last comment is still open.
    supabase
      .from("direct_order_events")
      .select("request_id, created_at, message, event_type")
      .in("event_type", ["returned", "return"])
      .in("request_id", requests.map((request) => request.id))
      .order("created_at", { ascending: false }),
  ]);
  if (eventResult.error) throw eventResult.error;

  const lastReturn = pickLatestReturnPerRequest(
    ((eventResult.data ?? []) as Array<{ request_id: string; created_at: string; message: string | null }>).map(
      (row) => ({ requestId: row.request_id, createdAt: row.created_at, message: row.message }),
    ),
  );

  const now = new Date();

  return requests.map((request) => {
    const pharmacy = pharmacies.get(request.pharmacyId) ?? null;
    const event = lastReturn.get(request.id) ?? null;
    // Fall back to submission: a row with no `returned` event is still genuinely waiting, and
    // dropping it would hide exactly the case most likely to be a defect.
    const returnedAt = event?.createdAt ?? request.createdAt ?? null;
    const daysWaiting = daysWaitingSince(returnedAt, now);
    const basket = summarizeDirectOrderBasket(request, itemsByRequest.get(request.id));
    return {
      id: request.id,
      requesterHrId: request.requesterHrId,
      requesterName: resolveName(request.requesterHrId) || request.requesterHrId,
      productName: basket.productName,
      qty: basket.qty,
      items: basket.lines,
      salesValue: request.salesValue,
      pharmacyId: request.pharmacyId,
      pharmacyName: pharmacy?.pharmacyName ?? "—",
      phoenixPharmacyCode: pharmacy?.phoenixPharmacyCode ?? "—",
      distributorCodes: (pharmacy?.distributorCodes ?? []).map(
        (pair) => `${pair.distributorCode} ${pair.customerCode}`,
      ),
      returnedAt,
      daysWaiting,
      returnReason: event?.message ?? null,
    };
  });
}

// ── Stranded returned orders — the requester has left, so nobody can answer ───
//
// WHY THIS EXISTS (2026-10-08). `returned` is answerable by exactly one person: `reviseDirectOrder`
// refuses anyone whose canonical HR_ID is not the requester's, because a return is a question
// addressed to the person who raised the order. When that person resigns their login is disabled and
// the question can never be answered — the order is not terminal, so nothing expires it, and it is
// in nobody's queue, so nothing chases it.
//
// `src/lib/approvals/orphaned-requests.ts` already FINDS these and the Needs You board already shows
// the count. What did not exist was any way to clear one. `cancelHeldDirectOrder` takes `held` only,
// and the Stuck Approvals screen reassigns weekly plans and excuses and nothing else — so on
// 2026-10-08 five of them (66,475.20 EGP, 52-56 days old, requesters B-23 and PD-0010, both resigned
// District Sales Managers) had to be closed by hand-written SQL against production. That is what
// this removes: the board named a remedy the product could not perform.
//
// WHY CLOSING AND NOT REASSIGNING. Reassigning looks kinder and is not. A resubmit reprices the
// basket on TODAY's basis and resumes at the lowest still-pending rung — which for a CEO-returned
// order is the CEO's own rung — so handing one to a live manager hands them a money edit, not an
// administrative tidy. Four of those five had been returned by the CEO cutting the discount ("only
// 15%", "only 17%"). If that volume is still wanted it is raised fresh, by the manager who holds
// that territory now, at the percentage the CEO asked for. Closing retires the dead question; it
// does not decide the business.
//
// WHAT IT IS NOT. Not an expiry. `listReturnedDirectOrdersAgeing`'s own note refuses to add one
// deliberately — "killing an order the rep may never have seen would destroy real work to tidy a
// queue". Nothing here touches an order whose requester can still log in; that guard is the whole
// difference between clearing a dead end and deleting someone's work.

/**
 * A returned order whose requester the employee master reports as no longer active.
 *
 * Carries everything the returned desk carries, plus the one fact that puts it on this list. The
 * same definition of "left" as the Needs You board: `isActiveLifecycleStatus`, which counts ONLY
 * `active` and `on_leave` — a looser test returns an empty list for the wrong reason and reads
 * exactly like a real all-clear.
 */
export type StrandedDirectOrderRow = ReturnedDirectOrderAgeingRow & {
  /** What the employee master says about the requester — the whole reason this row is here. */
  requesterEmploymentStatus: string | null;
};

/**
 * Every returned order whose requester has left the company, oldest first.
 *
 * Super Admin / system scope only, inherited from `listReturnedDirectOrdersAgeing`.
 *
 * An actor the employee master does not hold AT ALL is left alone, matching
 * `selectOrphanedRequests`: this surfaces a known resignation, never every odd id, because a false
 * "stranded" invites a cleanup that is not needed.
 */
export async function listStrandedDirectOrders(access: AccessContext): Promise<StrandedDirectOrderRow[]> {
  const returned = await listReturnedDirectOrdersAgeing(access);
  if (returned.length === 0) return [];

  // includeInactive — the people this list is ABOUT are the ones the default directory drops.
  const directory = await getEmployeeDirectoryRows({ includeInactive: true });
  // Keyed canonically, never by raw string: `requester_hr_id` holds whichever case the submitting
  // session had, and an exact match once hid 28% of reps' own orders
  // (`direct-order-hr-id-columns-are-mixed-case-and-access-hrid-is-lowercase`).
  const byKey = new Map<string, EmployeeDirectoryRow>();
  for (const employee of directory) {
    const key = canonicalHrIdKey(employee.hrId);
    if (key) byKey.set(key, employee);
  }

  const stranded: StrandedDirectOrderRow[] = [];
  for (const order of returned) {
    const employee = byKey.get(canonicalHrIdKey(order.requesterHrId) ?? "");
    if (!employee) continue;
    if (isActiveLifecycleStatus(employee.employmentStatus)) continue;
    stranded.push({ ...order, requesterEmploymentStatus: employee.employmentStatus });
  }
  return stranded;
}

/**
 * Close one returned order whose requester has left — the way out that did not exist.
 *
 * The result is `cancelled`, never `rejected`, for the reason `cancelHeldDirectOrder` states: no
 * approver turned this down, and merging the two would inflate every rejection rate and per-status
 * counter that groups by status. Four of the five closed on 2026-10-08 had in fact been APPROVED by
 * the SFE Manager and the National Sales Manager; only the requester's step was dead.
 *
 * The approval steps are deliberately left exactly as they are. An approver can only act when the
 * request is `pending_approval`, so the untouched `pending` rungs on a cancelled order reach nobody,
 * and the record of who approved what — and who returned it, and in whose words — stays readable.
 *
 * Nothing downstream moves. `trg_direct_order_weekly_sync_upd` does fire on a status change, but
 * `phx_direct_order_weekly_sync` loops over the OLD and NEW `sales_month` filtered `where p is not
 * null`, and an order that was never approved carries no month — so no weekly rebuild runs and no
 * published closing ever contained it. Finance owns the month and this never writes one.
 */
export async function closeOrphanedDirectOrder(
  access: AccessContext,
  input: { requestId: string; reason: string },
): Promise<{ requestId: string; status: "cancelled" }> {
  await assertPermission(access, "direct_orders", "read");
  // Super Admin / system scope, matching `repair_approval_rung`'s migration note: repair work must
  // never widen access. A terminal decision on somebody else's sales request is further from a
  // repair than that one was, so it does not get a wider gate than the rung repair did.
  assertHeldDeskAccess(access);
  const actorHrId = requireActorHrId(access);

  const reason = input.reason?.trim();
  if (!reason) {
    // Symmetric with every other decision in this module, and this one needs it more: the order
    // dies here, and this sentence is the only account of why that was right.
    badRequest("Say why this order is being closed — it is the only record of the decision.");
  }

  // Read through getDirectOrderRequest, never a raw admin query. The scope guard lives at that
  // choke point and it returns null for out-of-scope as well as for missing, so an id cannot be
  // used to probe which requests exist.
  const detail = await getDirectOrderRequest(access, input.requestId);
  if (!detail) badRequest("Direct order request not found.");

  if (detail.request.status !== "returned") {
    badRequest(
      `Only an order an approver sent back can be closed this way — this one is ` +
        `${describeDirectOrderStatus(detail.request.status, detail.request.salesMonth).label.toLowerCase()}. ` +
        "A held order is withdrawn from the Held Desk; one in the approval chain is decided by its approver.",
    );
  }

  // THE GATE, and the only thing separating this from a delete button. The requester must actually
  // be gone: while they can still log in, the return is theirs to answer and nobody else's.
  const directory = await getEmployeeDirectoryRows({ includeInactive: true });
  const requesterKey = canonicalHrIdKey(detail.request.requesterHrId);
  const requester = directory.find((employee) => canonicalHrIdKey(employee.hrId) === requesterKey) ?? null;
  // `requesterLabel` is written into the audit summary and the event message below, which are stored
  // text, so it stays the full name. What this screen answers with reads the display name.
  const requesterLabel = requester?.fullName.trim() || detail.request.requesterHrId;
  const requesterShownName = requester?.displayName?.trim() || requesterLabel;
  if (!requester) {
    // An id the master does not hold is NOT read as a departure — same rule as
    // `selectOrphanedRequests`. It is a directory problem, and closing a real order over one would
    // destroy work to paper over a missing HR record.
    badRequest(
      `${detail.request.requesterHrId} is not in the employee master at all, so this is a directory ` +
        "problem rather than a departure. Fix the employee record first; this action only clears an " +
        "order whose requester the master reports as having left.",
    );
  }
  if (isActiveLifecycleStatus(requester.employmentStatus)) {
    badRequest(
      `${requesterShownName} is still employed, so this return is theirs to answer — they can correct ` +
        "and resubmit it themselves. This action only clears an order whose requester has left the company.",
    );
  }

  // The row's ACTUAL status, not a literal — the F6 lesson. Passing the real value keeps the
  // registry check independent of what this code believes.
  await assertDirectOrderWorkflowTransition({
    access,
    actionKey: "close_orphaned",
    expectedNextStatus: "cancelled",
    status: detail.request.status,
  });

  const supabase = getSupabaseAdmin();
  const { data: updated, error: updateError } = await supabase
    .from("direct_order_requests")
    .update(decidedStatusPatch("cancelled"))
    .eq("id", detail.request.id)
    .eq("status", "returned")
    .select("id");
  if (updateError) throw updateError;
  // The `.eq("status","returned")` guard is a real race, not a formality: a Super Admin may correct
  // and resubmit on the departed requester's behalf at this moment, which moves the order to
  // `pending_approval` and makes this update match NOTHING. Reporting success there would say an
  // order was closed while it actually sat in an approver's queue — so an empty result is an error.
  if (!updated || updated.length === 0) {
    badRequest(
      "This order is no longer in the returned lane — it was corrected and resubmitted a moment ago. " +
        "Reload the list and check its current state.",
    );
  }

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: detail.request.id,
    oldValues: { requesterHrId: detail.request.requesterHrId, status: "returned" },
    newValues: { status: "cancelled" },
    summary:
      `Direct order closed as stranded by ${actorHrId} — its requester ${requesterLabel} ` +
      `(${requester.employmentStatus ?? "not active"}) can no longer answer the return — ${reason}`,
  });
  await insertEvent({
    requestId: detail.request.id,
    actorHrId,
    eventType: "cancelled",
    message:
      `Closed as stranded: ${reason} ` +
      `The order was sent back for correction, and ${requesterLabel}, who raised it, has left the ` +
      "company — a return can only be answered by the person who raised it, so it could never be " +
      "corrected or resubmitted. It was not rejected by any approver.",
    metadata: {
      closedReason: "requester_left_cannot_resubmit",
      previousStatus: "returned",
      requesterEmploymentStatus: requester.employmentStatus ?? null,
      salesValueAtClose: detail.request.salesValue,
      strandedRequesterHrId: detail.request.requesterHrId,
    },
  });

  // The SFE Manager is told, and nobody else. The requester has left — a notification addressed to
  // a disabled login reaches no one — and the person who closed it does not need telling they did.
  // In-app and Telegram only, never email: this is a queue being tidied, not news for an inbox.
  // After the reply (afterResponse): the order is closed; telling the SFE Manager follows.
  await afterResponse("direct_order_notice:closed_orphaned", async () => {
    const resolveName = await nameLookup();
    const pharmacy =
      (await loadPharmaciesByIds([detail.request.pharmacyId])).get(detail.request.pharmacyId) ?? null;
    const notifyContext = await buildNotifyContext(detail.request, requesterLabel, pharmacy);
    await notifyDirectOrder({
      recipients: await hrIdsForRole("SFE Manager"),
      channels: ["in_app", "telegram"],
      title: "Direct order closed — its requester had left",
      message:
        `${buildDirectOrderNotificationLine(notifyContext)} ` +
        `${requesterLabel} raised it and has since left the company, so the return could never be ` +
        `answered. Closed by ${resolveName(actorHrId) ?? actorHrId}. Reason: ${reason}`,
      metrics: buildDirectOrderNotificationMetrics(notifyContext),
      eventType: "cancelled",
      requestId: detail.request.id,
      subjectHrId: detail.request.requesterHrId,
    });
  });

  pingDirectOrderSheet("stranded_closed");
  return { requestId: detail.request.id, status: "cancelled" };
}

/** Every held order, oldest first — the System Admin's queue (spec C3). */
export async function listHeldDirectOrders(access: AccessContext): Promise<HeldDirectOrderRow[]> {
  assertHeldDeskAccess(access);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("direct_order_requests")
    .select("*")
    .eq("status", "held")
    .order("held_at", { ascending: true });
  if (error) throw error;
  const requests = ((data ?? []) as Array<Record<string, unknown>>).map(mapRequestRow);
  if (requests.length === 0) return [];

  // Three independent reads — none needs another's result — run together instead of in sequence.
  const [pharmacies, resolveName, noticeResult] = await Promise.all([
    loadPharmaciesByIds(requests.map((request) => request.pharmacyId)),
    nameLookup(),
    // Latest notice per request, so the admin can see "already told, twice" vs "never told".
    supabase
      .from("direct_order_events")
      .select("request_id, created_at")
      .eq("event_type", "held_notice_sent")
      .in("request_id", requests.map((request) => request.id))
      .order("created_at", { ascending: false }),
  ]);
  const noticeRows = noticeResult.data;
  const lastNoticeByRequest = new Map<string, string>();
  for (const row of (noticeRows ?? []) as Array<{ request_id: string; created_at: string }>) {
    if (!lastNoticeByRequest.has(row.request_id)) lastNoticeByRequest.set(row.request_id, row.created_at);
  }

  // WHY each one is held, computed with the SAME rule the submit fork uses — never a second copy.
  // A desk that re-implemented "is this provable" would eventually disagree with the fork, and the
  // admin would be deciding against a different rule than the one that parked the order.
  const uniquePharmacies = [...new Set(requests.map((request) => request.pharmacyId))];
  const decisionByPharmacy = new Map<string, ReturnType<typeof decideDirectOrderHold>>();
  const candidatesByPharmacy = new Map<string, DirectOrderPossibleDistributorMatch[]>();
  for (const pharmacyId of uniquePharmacies) {
    const pharmacy = pharmacies.get(pharmacyId) ?? null;
    if (!pharmacy) continue;
    decisionByPharmacy.set(
      pharmacyId,
      decideDirectOrderHold({
        verificationStatus: pharmacy.verificationStatus,
        declaredBrickId: pharmacy.brickId,
        distributorCodes: await attachCodeOwnership(pharmacy),
        holdReleaseGround: pharmacy.holdReleaseGround,
      }),
    );
    // Only worth asking when there is no code at all — that is the "typed into the wrong field"
    // shape, and it is the one case where the repair is a single click. Ownership is attached
    // because this desk is where that click happens: offering a Link on a code another pharmacy
    // already holds is offering an action the rule will refuse.
    if ((pharmacy.distributorCodes ?? []).length === 0) {
      candidatesByPharmacy.set(
        pharmacyId,
        await attachCandidateOwnership(pharmacyId, await findPossibleDistributorMatchesByPharmacyName(pharmacy.pharmacyName)),
      );
    }
  }

  const now = Date.now();
  const itemsByRequest = await loadDirectOrderItemsForRequests(requests.map((r) => r.id));
  return requests.map((request) => {
    const pharmacy = pharmacies.get(request.pharmacyId) ?? null;
    const heldAtMs = request.heldAt ? Date.parse(request.heldAt) : now;
    const elapsedDays = Math.floor((now - heldAtMs) / (24 * 60 * 60 * 1000));
    const decision = decisionByPharmacy.get(request.pharmacyId) ?? null;
    const basket = summarizeDirectOrderBasket(request, itemsByRequest.get(request.id));
    return {
      id: request.id,
      requesterHrId: request.requesterHrId,
      requesterName: resolveName(request.requesterHrId) ?? request.requesterHrId,
      requesterRole: request.requesterRole,
      productName: basket.productName,
      qty: basket.qty,
      items: basket.lines,
      salesValue: request.salesValue,
      pharmacyId: request.pharmacyId,
      pharmacyName: pharmacy?.pharmacyName ?? "(pharmacy missing)",
      phoenixPharmacyCode: pharmacy?.phoenixPharmacyCode ?? "—",
      heldAt: request.heldAt ?? null,
      daysRemaining: Math.max(0, HELD_ORDER_LIFETIME_DAYS - elapsedDays),
      lastNoticeAt: lastNoticeByRequest.get(request.id) ?? null,
      holdGround: decision?.ground ?? "unproven",
      holdGroundNote: decision ? describeDirectOrderHoldGround(decision) : "This request has no pharmacy on file.",
      declaredBrickId: pharmacy?.brickId ?? null,
      declaredAreaCode: pharmacy?.areaCode ?? null,
      distributorCodes: (pharmacy?.distributorCodes ?? []).map((pair) => ({
        distributorCode: pair.distributorCode,
        distributorName: pair.distributorName,
        customerCode: pair.customerCode,
        mappedBrickId: pair.mappedBrickId,
        mappedAreaCode: pair.mappedAreaCode,
      })),
      conflicts: decision?.conflicts ?? [],
      nameCodeCandidates: candidatesByPharmacy.get(request.pharmacyId) ?? [],
      holdReleaseGround: pharmacy?.holdReleaseGround ?? null,
      holdReleaseReason: pharmacy?.holdReleaseReason ?? null,
      holdReleaseDecidedAt: pharmacy?.holdReleaseDecidedAt ?? null,
    };
  });
}

/**
 * The bulk notice button (spec C3, owner's words): the System Admin selects requests and one
 * email per request goes out — To the requester BY NAME (never a code), CC the SFE Manager,
 * the requester's direct manager, and the CEO: held until you bring a valid pharmacy code,
 * because your pharmacy is not in the master database.
 *
 * One email per REQUEST (not per person): notifyDirectOrder consolidates to a single To/Cc
 * envelope, so four people see one message — the owner's one-email rule (spec C4).
 */
export async function sendHeldDirectOrderNotices(
  access: AccessContext,
  input: { requestIds: string[] },
): Promise<{ sent: number; skipped: Array<{ requestId: string; reason: string }> }> {
  assertHeldDeskAccess(access);
  const ids = Array.from(new Set((input.requestIds ?? []).map((id) => String(id).trim()).filter(Boolean)));
  if (ids.length === 0) badRequest("Select at least one held request.");

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("direct_order_requests").select("*").in("id", ids);
  if (error) throw error;
  const byId = new Map(((data ?? []) as Array<Record<string, unknown>>).map((row) => {
    const request = mapRequestRow(row);
    return [request.id, request] as const;
  }));

  // Four independent reads — none needs another's result (getEmployeeDirectory is TTL-cached and
  // in-flight-deduped, so calling it here and again inside nameLookup() shares one fetch, not two).
  const [directory, resolveName, sfeHolders, ceoHolders] = await Promise.all([
    getEmployeeDirectory(),
    nameLookup(),
    hrIdsForRole(SFE_VALIDATION_ROLE),
    ceoHrIds(),
  ]);
  const lookup = directoryLookup(directory);

  let sent = 0;
  const skipped: Array<{ requestId: string; reason: string }> = [];
  for (const requestId of ids) {
    const request = byId.get(requestId);
    if (!request) {
      skipped.push({ requestId, reason: "not found" });
      continue;
    }
    // Only a held request gets a held notice — a revived or expired one telling its requester
    // to "bring a code" would be a lie about the system's own state.
    if (request.status !== "held") {
      skipped.push({ requestId, reason: `is ${request.status}, not held` });
      continue;
    }

    const requesterName = resolveName(request.requesterHrId) ?? request.requesterHrId;
    const managerHrId = lookup(request.requesterHrId)?.managerHrId ?? null;
    // A requester with no manager on file is a REAL state (a top-of-line role, or a broken
    // reporting link), and the CC list quietly drops the null either way. Silence is the problem:
    // the owner asked for the direct manager to be copied, so when that cannot happen it is
    // recorded rather than assumed. The notice still goes out — telling the requester nothing
    // because their manager link is missing would punish them for a data gap.
    if (!managerHrId) {
      logError("Held notice sent without a direct-manager CC — no manager on file for the requester", {
        labels: { event: "direct_order_held_notice_no_manager", requestId: request.id },
        error: new Error(`No manager_hr_id for requester ${request.requesterHrId}`),
      });
    }
    const pharmacy = (await loadPharmaciesByIds([request.pharmacyId])).get(request.pharmacyId) ?? null;
    const notifyContext = await buildNotifyContext(request, requesterName, pharmacy);

    await notifyDirectOrder({
      // To the requester; CC SFE + direct manager + CEO (the envelope keeps this ONE email).
      recipients: [request.requesterHrId, ...sfeHolders, managerHrId, ...ceoHolders],
      title: "Direct order held — the venue must be validated",
      message:
        `${requesterName}, your direct order — ${request.productName} × ${request.qty} — is held ` +
        "and has not entered the approval flow, because your pharmacy is not in the master " +
        "database of the system. It will move only when you provide a valid pharmacy code " +
        `(or the pharmacy passes validation). A held request expires after ${HELD_ORDER_LIFETIME_DAYS} days.`,
      metrics: buildDirectOrderNotificationMetrics(notifyContext),
      eventType: "held_notice_sent",
      requestId: request.id,
      subjectHrId: request.requesterHrId,
      // A reminder is meant to be repeatable: one notice per request PER DAY. Without this the
      // second reminder is deduped away and the desk reports a send that never happened.
      idempotencySuffix: new Date().toISOString().slice(0, 10),
    });
    await insertEvent({
      requestId: request.id,
      actorHrId: access.hrId,
      eventType: "held_notice_sent",
      message: `Held notice sent to ${requesterName} (CC: SFE Manager, direct manager, CEO).`,
    });
    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? access.hrId,
      entityType: "direct_order_request",
      entityId: request.id,
      newValues: { notice: "held_notice_sent", requester: request.requesterHrId },
      summary: `Held notice sent by ${access.hrId ?? "system"} to ${requesterName}.`,
    });
    sent += 1;
  }
  return { sent, skipped };
}

// ── Pharmacy registry — set a pharmacy up BEFORE an order arrives ─────────────
//
// Owner request, 2026-08-04: "I want to set up this pharmacy in case a direct order is submitted
// and has its code, the system recognizes it."
//
// Until now a pharmacy could only be born inside an order form, which meant the FIRST order for
// any pharmacy always paid the review cost — even one the company has traded with for years and
// whose distributor code is sitting in the customer map. The registry lets that setup happen in
// advance, so the order that arrives later is recognised and takes the ordinary chain.

// The roles and the two gate helpers now live in ./registry-access, because the CRM contact picker
// needs the SAME predicate and importing it back out of this module would close a cycle (this file
// already imports assertVenueContactInScope from venue-contact-options).

export type DirectOrderRegistryPharmacy = DirectOrderPharmacy & {
  brickName: string | null;
  areaName: string | null;
  regionName: string | null;
  /** Orders already placed against this pharmacy — what is riding on an edit. */
  orderCount: number;
  /** Orders still climbing their chain. Editing a code under one of these moves live money. */
  pendingOrderCount: number;
  /**
   * The CRM contact this venue is declared to be, NAMED — never the bare id the column holds
   * (owner rule). `null` when nothing is declared, and also when the link points at a contact
   * outside the viewer's own CRM reach; the board tells those two apart by reading `crmContactId`
   * beside this, so an unnameable link is reported rather than rendered as "not linked".
   */
  crmContact: VenueContactOption | null;
  /** Who declared the link, as a name. */
  crmContactLinkedByName: string | null;
};

/**
 * Every REACHABLE venue, with names rather than codes and with what is riding on each one.
 *
 * Reachable means active and not merged away — a user can open it, edit it, and place an order on
 * it. That definition lives HERE and nowhere else: the board's summary chips (venue total, waiting
 * for a System Admin, no distributor code, not linked to the CRM) are all derived from this list,
 * so re-filtering them in the component would give the backlog two definitions that drift apart.
 * A chip's whole job is to size the outstanding work, and a tombstone counted into it overstates
 * that work with no way for the reader to tell.
 *
 * `canClearReview` is deliberately NARROWER than `canManage`. The SFE Manager may register and
 * edit pharmacies, but clearing one that is already holding an order is the System Admin rung the
 * owner asked for — and SFE sits on the rung immediately before it. Letting SFE clear it would let
 * the first approver dissolve the second approver's step on a request they are about to sign.
 */
export async function listDirectOrderPharmacyRegistry(access: AccessContext): Promise<{
  rows: DirectOrderRegistryPharmacy[];
  canManage: boolean;
  canClearReview: boolean;
}> {
  assertPharmacyRegistryAccess(access);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("direct_order_pharmacies")
    .select("*")
    .eq("active", true)
    // Merged-away rows are finished business: the row IS the survivor now, and re-offering it here
    // would put a tombstone in the board's counts and in its edit form. They are deactivated by the
    // same write that merges them, so this changes NO row today (production 2026-09-03: 10 merged,
    // 10 of them inactive) — it says the rule instead of borrowing it from a co-writer. The merge
    // is the ONLY thing maintaining that pairing: there is no constraint tying the two columns, and
    // AGENTS.md sends a stranded desk validation to hand SQL, which is exactly the writer that
    // would set one without the other. The sibling read getDirectOrderCleanupPlan already filters
    // on this column for the same reason.
    .is("merged_into_pharmacy_id", null)
    .order("pharmacy_name", { ascending: true });
  if (error) throw error;
  const pharmacies = ((data ?? []) as Array<Record<string, unknown>>).map(mapPharmacyRow);
  await attachDistributorCodes(pharmacies);

  const [{ brickNameById, areaNameByCode, regionNameByCode }, orderRows] = await Promise.all([
    loadDirectOrderGeoNames(),
    (async () => {
      const { data: rows } = await supabase.from("direct_order_requests").select("pharmacy_id, status");
      return (rows ?? []) as Array<{ pharmacy_id: string | null; status: string | null }>;
    })(),
  ]);
  const orderCounts = new Map<string, { total: number; pending: number }>();
  for (const row of orderRows) {
    if (!row.pharmacy_id) continue;
    const bucket = orderCounts.get(row.pharmacy_id) ?? { total: 0, pending: 0 };
    bucket.total += 1;
    if (String(row.status ?? "") === "pending_approval") bucket.pending += 1;
    orderCounts.set(row.pharmacy_id, bucket);
  }

  // Resolved AFTER the rows are known, in one batched read for the whole board rather than one per
  // venue — most venues carry no link at all, and an empty set costs nothing.
  const [contactsById, resolveName] = await Promise.all([
    describeVenueContacts(
      access,
      pharmacies.map((pharmacy) => pharmacy.crmContactId).filter((id): id is number => id !== null),
    ),
    nameLookup(),
  ]);

  const rows = pharmacies.map((pharmacy) => ({
    ...pharmacy,
    brickName: pharmacy.brickId ? brickNameById.get(pharmacy.brickId) ?? null : null,
    areaName: pharmacy.areaCode ? areaNameByCode.get(pharmacy.areaCode) ?? null : null,
    regionName: pharmacy.regionCode ? regionNameByCode.get(pharmacy.regionCode) ?? null : null,
    orderCount: orderCounts.get(pharmacy.id)?.total ?? 0,
    pendingOrderCount: orderCounts.get(pharmacy.id)?.pending ?? 0,
    crmContact: pharmacy.crmContactId === null ? null : contactsById.get(pharmacy.crmContactId) ?? null,
    crmContactLinkedByName: resolveName(pharmacy.crmContactLinkedByHrId),
  }));
  return {
    rows,
    canManage: canManagePharmacyRegistry(access),
    canClearReview: access.scope === "system" || access.role === "Super Admin",
  };
}

/**
 * Ensure a pharmacy exists for a directory selection from the submit form's combo box
 * (spec B1/B3 — docs/specs/direct-orders-v2.md).
 *
 * The rep never types an identity here — they POINT at one. Either at a pharmacy Phoenix already
 * holds (`phoenixPharmacyCode`), or at a distributor-directory customer
 * (`distributorCode` + `customerCode`), in which case every field of the created pharmacy is
 * copied from the CATALOGUE row — name, address, brick, area, region — and nothing from the
 * caller. That is why it may be born `verified`/`catalogue` even though a rep triggered it: the
 * distributor sheets are the confirming authority, not the rep (owner rule: only distributor
 * sales sheets create trusted customers).
 *
 * Reuse before create, keyed on (distributor_code, customer_code): the same directory customer
 * picked twice must resolve to ONE pharmacy, or every reorder would mint a duplicate — the
 * failure the hand-typed era demonstrated within ten records.
 */
export async function ensureDirectOrderPharmacyFromDirectory(
  access: AccessContext,
  input: { phoenixPharmacyCode?: string | null; distributorCode?: string | null; customerCode?: string | null },
): Promise<DirectOrderPharmacy> {
  await assertPermission(access, "direct_orders", "create");
  const supabase = getSupabaseAdmin();

  const phoenixCode = String(input.phoenixPharmacyCode ?? "").trim();
  if (phoenixCode) {
    const { data: existing, error } = await supabase
      .from("direct_order_pharmacies")
      .select("*")
      .eq("phoenix_pharmacy_code", phoenixCode)
      .eq("active", true)
      .maybeSingle();
    if (error) throw error;
    if (!existing) badRequest("That venue is no longer active in Phoenix — search again.");
    return mapPharmacyRow(existing as Record<string, unknown>);
  }

  const distributorCode = String(input.distributorCode ?? "").trim();
  const customerCode = String(input.customerCode ?? "").trim();
  if (!distributorCode || !customerCode) {
    badRequest("Pick a venue from the list — by its Phoenix code, or a distributor customer.");
  }

  // The map row is the source of truth for every field. Fail closed if it is not there: the UI
  // only offers rows the search returned, so a miss here means a stale or forged request.
  const { data: mapRow, error: mapError } = await supabase
    .from("source_of_sales_customer_map")
    .select("distributor_code, customer_code, customer_name, address, brick_id, area_code, region_code")
    .eq("active", true)
    .eq("distributor_code", distributorCode)
    .eq("customer_code", customerCode)
    .maybeSingle();
  if (mapError) throw mapError;
  if (!mapRow) badRequest("That customer is not in the master database. Search again and pick from the list.");

  // Reuse: this directory customer may already be a Phoenix pharmacy.
  const { data: link, error: linkError } = await supabase
    .from("direct_order_pharmacy_distributor_codes")
    .select("pharmacy_id")
    .eq("distributor_code", distributorCode)
    .eq("customer_code", customerCode)
    .limit(1)
    .maybeSingle();
  if (linkError) throw linkError;
  if (link?.pharmacy_id) {
    const { data: existing } = await supabase
      .from("direct_order_pharmacies")
      .select("*")
      .eq("id", String(link.pharmacy_id))
      .eq("active", true)
      .maybeSingle();
    if (existing) return mapPharmacyRow(existing as Record<string, unknown>);
  }

  const row = mapRow as Record<string, unknown>;
  const catalogueName = String(row.customer_name ?? "").trim();
  const pharmacyName = catalogueName || customerCode;

  const { data: pharmacyIdRow, error: rpcError } = await supabase.rpc("phx_resolve_directory_pharmacy", {
    p_distributor_code: distributorCode,
    p_customer_code: customerCode,
    p_pharmacy_name: pharmacyName,
    p_brick_id: row.brick_id ? String(row.brick_id) : null,
    p_area_code: row.area_code ? String(row.area_code) : null,
    p_region_code: row.region_code ? String(row.region_code) : null,
    p_address: row.address ? String(row.address) : null,
    p_hr_id: hrIdForStorage(access.hrId),
  });

  if (rpcError) throw rpcError;
  const pharmacyId = String(pharmacyIdRow);

  const { data: pharmacyRow, error: fetchError } = await supabase
    .from("direct_order_pharmacies")
    .select("*")
    .eq("id", pharmacyId)
    .single();
  if (fetchError) throw fetchError;

  const pharmacy = mapPharmacyRow(pharmacyRow as Record<string, unknown>);

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: `pharmacy:${pharmacy.id}`,
    oldValues: null,
    newValues: { distributorCode, customerCode, source: "directory_combo" },
    summary: `Direct-order venue materialized from the distributor directory (${distributorCode}/${customerCode}) by ${access.hrId ?? "unknown"}.`,
  });

  return pharmacy;
}

/**
 * Register a pharmacy ahead of any order — and mark it CONFIRMED.
 *
 * This is the one place a pharmacy is born already verified, and the reason is that the person
 * registering it IS the confirming authority. A Super Admin or the SFE Manager working through
 * the registry, with no order in front of them and no deadline, is doing exactly the check the
 * System Admin rung exists to force. Making them then approve their own entry on a later order
 * would be theatre, and would defeat the whole point of setting the pharmacy up in advance.
 *
 * The order form is unchanged and still flags everything it creates — see
 * createDirectOrderPharmacy. The difference is not the fields, it is who is typing and whether an
 * order is waiting on the answer.
 */
export async function registerDirectOrderPharmacy(
  access: AccessContext,
  input: {
    pharmacyName: string;
    brickId?: string | null;
    areaCode?: string | null;
    regionCode?: string | null;
    doctorName?: string | null;
    pharmacyAddress?: string | null;
    distributorCodes: Array<{ distributorCode: string; customerCode: string }>;
    /** REQUIRED — see createDirectOrderPharmacy. This form posted nothing at all until 2026-08-26. */
    venueType?: string | null;
    /** Optional CRM contact this venue IS. Same declaration the submit form carries (2026-09-03). */
    crmContactId?: number | string | null;
  },
): Promise<DirectOrderPharmacy> {
  assertPharmacyRegistryAccess(access);
  const name = input.pharmacyName?.trim();
  if (!name) badRequest("Venue name is required.");
  // The admin registry never sent a venue type, so every pharmacy registered here was defaulted
  // into being a pharmacy without anyone being asked. Being the System Admin is authority over the
  // approval chain, not knowledge of whether a given address is a nursery.
  const venueTypeChoice = parseVenueTypeChoice(input.venueType);
  if (!venueTypeIsAnswered(venueTypeChoice)) badRequest(VENUE_TYPE_UNANSWERED_MESSAGE);
  const venueType = venueTypeChoice;
  if (!venueRequiresDistributorCode(venueType) && (input.distributorCodes ?? []).length > 0) {
    badRequest(
      `A ${venueTypeLabel(venueType).toLowerCase()} has no distributor account, so it cannot carry a distributor code. ` +
        "Register it without one.",
    );
  }
  const doctorName = input.doctorName?.trim() || null;
  const pharmacyAddress = input.pharmacyAddress?.trim() || null;
  const byDistributor = normalizeDistributorCodePairs(input.distributorCodes, await distributorNameResolver());

  // Checked even though this door is Super Admin / SFE Manager: the gate is what makes the id real
  // rather than merely well-formed. For a registry role the scope resolves to `company`, so this
  // refuses an id that exists on NO rep's list at all — a typo, or a contact the CRM has dropped.
  const crmContactId = parseVenueContactId(input.crmContactId);
  await assertVenueContactInScope(access, crmContactId);

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { data: pharmacyRow, error } = await supabase
    .from("direct_order_pharmacies")
    .insert({
      pharmacy_name: name,
      brick_id: input.brickId ?? null,
      area_code: input.areaCode ?? null,
      region_code: input.regionCode ?? null,
      doctor_name: doctorName,
      pharmacy_address: pharmacyAddress,
      created_by_hr_id: hrIdForStorage(access.hrId),
      verification_status: "verified",
      entry_source: "catalogue",
      verified_by_hr_id: hrIdForStorage(access.hrId),
      verified_at: now,
      venue_type: venueType,
      crm_contact_id: crmContactId,
      // Stamped only when something was declared, so an author without a link cannot exist. This
      // path inserts directly rather than through phx_create_direct_order_pharmacy, so the RPC's
      // equivalent guard does not cover it and the condition is repeated here on purpose.
      crm_contact_linked_by_hr_id: crmContactId === null ? null : hrIdForStorage(access.hrId),
      crm_contact_linked_at: crmContactId === null ? null : now,
    })
    .select("*")
    .single();
  if (error) throw error;
  const pharmacyId = String((pharmacyRow as Record<string, unknown>).id);

  const mapByKey = await resolveCustomerCodeGeography(byDistributor);
  if (byDistributor.size > 0) {
    const { error: childError } = await supabase
      .from("direct_order_pharmacy_distributor_codes")
      .insert(buildDistributorCodeRows(pharmacyId, byDistributor, mapByKey));
    if (childError) throw childError;
  }

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: `pharmacy:${pharmacyId}`,
    newValues: {
      verificationStatus: "verified",
      entrySource: "catalogue",
      registeredBy: access.role,
      distributorCodes: Array.from(byDistributor.entries()).map(([d, c]) => `${d}:${c}`),
      crmContactId,
    },
    summary: `Direct-order venue "${name}" pre-registered and confirmed by ${access.hrId ?? "unknown"} (${access.role}).`,
  });

  const pharmacy = mapPharmacyRow(pharmacyRow as Record<string, unknown>);
  await attachDistributorCodes([pharmacy]);
  return pharmacy;
}

/** Editable identity/geography fields. Anything absent is left exactly as it was. */
export async function updateDirectOrderPharmacyDetails(
  access: AccessContext,
  input: {
    pharmacyId: string;
    pharmacyName?: string | null;
    brickId?: string | null;
    areaCode?: string | null;
    regionCode?: string | null;
    doctorName?: string | null;
    pharmacyAddress?: string | null;
    /**
     * The CRM contact this venue IS.
     *
     * THE RETROACTIVE DOOR. Every venue registered before 2026-09-03 carries no declaration, and
     * the submit form can only declare one at creation — so without this, the existing venues stay
     * unlinked forever and the trade badge never reaches their rep's contact list.
     *
     * Patch semantics, three-way like the fields above: `undefined` leaves it exactly as it was,
     * `null` clears it, a value sets it. That distinction is the whole safety of this function —
     * the registry form edits a few fields at a time, and an optional field written
     * UNCONDITIONALLY is a silent erase.
     */
    crmContactId?: number | string | null;
  },
): Promise<void> {
  assertPharmacyRegistryAccess(access);
  const supabase = getSupabaseAdmin();
  const { data: before } = await supabase
    .from("direct_order_pharmacies")
    // ONE string literal, never a concatenation. supabase-js infers the row type by parsing this
    // argument as a literal type; `"a, b, " + "c"` is not one, so the whole row degrades to
    // GenericStringError and the `before as Record<string, unknown>` cast below stops compiling.
    // The error names the CAST, three dozen lines away, not the select that caused it.
    .select("pharmacy_name, brick_id, area_code, region_code, doctor_name, pharmacy_address, crm_contact_id, crm_contact_linked_by_hr_id, crm_contact_linked_at")
    .eq("id", input.pharmacyId)
    .maybeSingle();
  if (!before) badRequest("Venue not found.");

  // Patch semantics, not replace: the UI sends only the fields it edited, and an absent key must
  // never blank a column. `null` is a real value here (clear the doctor) and is distinguished from
  // `undefined` (leave it alone) — hence the explicit `in` checks rather than `??`.
  const patch: Record<string, unknown> = {};
  if (input.pharmacyName !== undefined) {
    const name = input.pharmacyName?.trim();
    if (!name) badRequest("Venue name cannot be empty.");
    patch.pharmacy_name = name;
  }
  if (input.brickId !== undefined) patch.brick_id = input.brickId || null;
  if (input.areaCode !== undefined) patch.area_code = input.areaCode || null;
  if (input.regionCode !== undefined) patch.region_code = input.regionCode || null;
  if (input.doctorName !== undefined) patch.doctor_name = input.doctorName?.trim() || null;
  if (input.pharmacyAddress !== undefined) patch.pharmacy_address = input.pharmacyAddress?.trim() || null;
  if (input.crmContactId !== undefined) {
    const crmContactId = parseVenueContactId(input.crmContactId);
    // Validated on the way IN, exactly like the submit path. An admin resolves to `company` scope,
    // so what this actually refuses is an id on nobody's list — and the check runs before the write
    // rather than after it, so a rejected id leaves the row untouched.
    await assertVenueContactInScope(access, crmContactId);
    patch.crm_contact_id = crmContactId;
    // All three move together or none do. Leaving a stale author beside a cleared link would be a
    // row that claims someone declared nothing, and `updated_by_hr_id` elsewhere in this database
    // has already proved how badly a mismatched author column reads later.
    patch.crm_contact_linked_by_hr_id = crmContactId === null ? null : hrIdForStorage(access.hrId);
    patch.crm_contact_linked_at = crmContactId === null ? null : new Date().toISOString();
  }
  if (Object.keys(patch).length === 0) return;

  const { error } = await supabase.from("direct_order_pharmacies").update(patch).eq("id", input.pharmacyId);
  if (error) throw error;

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: `pharmacy:${input.pharmacyId}`,
    oldValues: before as Record<string, unknown>,
    newValues: patch,
    summary: `Direct-order venue details updated by ${access.hrId ?? "unknown"}.`,
  });
}

/**
 * Replace a pharmacy's whole set of distributor codes.
 *
 * Replace rather than merge, because the common case is FIXING one: مستشفى زمزم carries
 * `829575 \ 1533576`, a single field holding two codes, matching nothing at the distributor. A
 * merge would leave the broken pair in place beside the corrected one and the pharmacy would still
 * match nothing. Sending the full intended set is unambiguous — what you see is what it becomes.
 *
 * Verification status is deliberately NOT touched. Correcting a code is not the same act as
 * confirming a pharmacy, and folding them together would let an SFE Manager clear a pending
 * pharmacy by editing a character. Clearing stays acknowledgeDirectOrderPharmacy, Super Admin only.
 */
export async function replaceDirectOrderPharmacyCodes(
  access: AccessContext,
  input: { pharmacyId: string; distributorCodes: Array<{ distributorCode: string; customerCode: string }> },
): Promise<void> {
  assertPharmacyRegistryAccess(access);
  const supabase = getSupabaseAdmin();
  const { data: pharmacy } = await supabase
    .from("direct_order_pharmacies")
    .select("id, pharmacy_name")
    .eq("id", input.pharmacyId)
    .maybeSingle();
  if (!pharmacy) badRequest("Venue not found.");

  const byDistributor = normalizeDistributorCodePairs(input.distributorCodes, await distributorNameResolver());
  const { data: previous } = await supabase
    .from("direct_order_pharmacy_distributor_codes")
    .select("distributor_code, customer_code")
    .eq("pharmacy_id", input.pharmacyId);

  const { error: deleteError } = await supabase
    .from("direct_order_pharmacy_distributor_codes")
    .delete()
    .eq("pharmacy_id", input.pharmacyId);
  if (deleteError) throw deleteError;

  const mapByKey = await resolveCustomerCodeGeography(byDistributor);
  if (byDistributor.size > 0) {
    const { error: insertError } = await supabase
      .from("direct_order_pharmacy_distributor_codes")
      .insert(buildDistributorCodeRows(input.pharmacyId, byDistributor, mapByKey));
    if (insertError) throw insertError;
  }

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: `pharmacy:${input.pharmacyId}`,
    oldValues: {
      distributorCodes: ((previous ?? []) as Array<{ distributor_code: string; customer_code: string }>).map(
        (row) => `${row.distributor_code}:${row.customer_code}`,
      ),
    },
    newValues: {
      distributorCodes: Array.from(byDistributor.entries()).map(([d, c]) => `${d}:${c}`),
      resolvedAgainstCustomerMap: Array.from(byDistributor.entries()).filter(([d, c]) =>
        mapByKey.has(`${d}::${c}`),
      ).length,
    },
    summary: `Direct-order venue distributor codes replaced by ${access.hrId ?? "unknown"}.`,
  });
}

/** List distributors for the pharmacy form (by name). */
/**
 * Distributor codes that must never be OFFERED when registering a pharmacy.
 *
 * `DirectReq` is the reserved pseudo-distributor the module injects approved orders into Source
 * of Sales under — it is bookkeeping, never a real trading partner. `Direct` is the company's own
 * direct channel, excluded on the owner's instruction (2026-08-03): a direct-order pharmacy must
 * be registered against the distributor that actually supplies it.
 *
 * This filters the PICKER only. Pharmacies already saved against one of these keep their pairs
 * and still display them on the approval window — removing an option must never rewrite history.
 */
const DIRECT_ORDER_EXCLUDED_DISTRIBUTOR_CODES = new Set(["direct", "directreq"]);

export type DirectOrderCustomerOption = {
  customerCode: string;
  customerName: string;
  address: string | null;
  /** Geography as NAMES — the owner's rule applies to the picker too, not just the read views. */
  brickId: string | null;
  brickName: string;
  areaCode: string | null;
  areaName: string;
  regionCode: string | null;
  regionName: string;
};

/**
 * The distributor's OWN customers, searched by name, bounded to the submitter's territory.
 *
 * This exists because a submitter had to type the distributor's customer code from memory.
 * Nobody knows those codes, and a wrong one is not a harmless typo: retail sales match on
 * (distributor_code, customer_code), so a mistyped code attributes a different pharmacy's sales
 * to this one on the screen where money gets approved.
 *
 * SCOPE IS A SECURITY BOUNDARY, not a convenience filter. `resolveSalesAccessScope` already
 * decides which areas a caller may see everywhere else in Sales; reusing it means a District
 * Manager cannot enumerate another region's customer list by crafting a request. An unscoped
 * role (Super Admin / CEO / SFE) searches everything, exactly as they can elsewhere.
 *
 * `areaCode` narrows within that scope — the owner wants region by default with an area filter
 * on top — but it can only ever narrow, never widen: an area outside the caller's scope returns
 * nothing rather than being honoured.
 */
export async function searchDistributorCustomers(
  access: AccessContext,
  input: { distributorCode: string; regionCode?: string | null; areaCode?: string | null; query?: string | null; limit?: number },
): Promise<DirectOrderCustomerOption[]> {
  await assertPermission(access, "direct_orders", "read");
  const distributorCode = String(input.distributorCode ?? "").trim();
  if (!distributorCode) return [];
  if (DIRECT_ORDER_EXCLUDED_DISTRIBUTOR_CODES.has(distributorCode.toLowerCase())) return [];

  // The areas this caller may see at all. null = unrestricted (company-tier role).
  const { areas } = await listDirectOrderAreaAndBrickOptions(access);
  const allowedAreaCodes = new Set(areas.map((area) => area.areaCode.toUpperCase()));
  // "line" (National Sales Manager) counts as unrestricted HERE too: per
  // listDirectOrderAreaAndBrickOptions's own note, Direct Orders gates NSM on the PRODUCT line
  // (resolveDirectOrderRequesterLineName), never on geography — an NSM stays nationwide for
  // customer/pharmacy search even though the report itself narrows to their line.
  const reportScope = resolveDirectOrderReportScope(access);
  const unrestricted = reportScope === "all" || reportScope === "line";
  if (!unrestricted && allowedAreaCodes.size === 0) return [];

  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("source_of_sales_customer_map")
    .select("customer_code, customer_name, address, brick_id, area_code, region_code")
    .eq("active", true)
    .eq("distributor_code", distributorCode);

  const wantedArea = String(input.areaCode ?? "").trim();
  const wantedRegion = String(input.regionCode ?? "").trim();
  if (wantedArea) {
    // Narrowing only: an area the caller may not see yields nothing rather than being honoured.
    if (!unrestricted && !allowedAreaCodes.has(wantedArea.toUpperCase())) return [];
    query = query.eq("area_code", wantedArea);
  } else if (wantedRegion) {
    query = query.eq("region_code", wantedRegion);
  }

  const search = String(input.query ?? "").trim();
  if (search) {
    // A stray `%` must not widen the match — but `,` `(` `)` were never dangerous here. This is
    // `.ilike()`, the client's own method: the pattern is one URL-encoded query parameter, not an
    // expression PostgREST parses. Blanking a parenthesis made this customer picker unable to find
    // the 787 mapped customers whose name holds one (`ابن القيم(حسام حسن)` returned 0 rows on
    // production), which is the same unfindable-row half of B04-01 seen from the other side.
    const pattern = ilikeContainsPattern(search);
    if (pattern) query = query.ilike("customer_name", pattern);
  }

  const { data, error } = await query.order("customer_name", { ascending: true }).limit(Math.min(input.limit ?? 50, 200));
  if (error) throw error;

  const geoMaps = await loadDirectOrderGeoNames();
  return ((data ?? []) as Array<Record<string, unknown>>)
    .map((row) => {
      const areaCode = row.area_code ? String(row.area_code) : null;
      const regionCode = row.region_code ? String(row.region_code) : null;
      const brickId = row.brick_id ? String(row.brick_id) : null;
      return {
        customerCode: String(row.customer_code ?? ""),
        customerName: String(row.customer_name ?? "").trim(),
        address: row.address ? String(row.address) : null,
        brickId,
        brickName: brickId ? geoMaps.brickNameById.get(brickId) ?? "" : "",
        areaCode,
        areaName: areaCode ? geoMaps.areaNameByCode.get(areaCode) ?? "" : "",
        regionCode,
        regionName: regionCode ? geoMaps.regionNameByCode.get(regionCode) ?? "" : "",
      };
    })
    // A customer with no name cannot be picked by name — ~12% of the catalogue is unnamed, and
    // offering a blank row would just be a code the submitter still cannot identify.
    .filter((option) => option.customerName.length > 0)
    // Belt and braces: the query is already scoped, but never return a row outside the caller's
    // areas even if the catalogue holds an area the scope resolver does not know about.
    .filter((option) => unrestricted || !option.areaCode || allowedAreaCodes.has(option.areaCode.toUpperCase()))
    // Owner rule 2026-09-22 ("never never never"): a wholesaler / makhzan is a distributor's own
    // warehouse, not an end customer — it is never offered as a matchable venue in this picker.
    .filter((option) => !isCertainWholesalerVenue(option.customerName, option.customerCode, distributorCode));
}

/** One hit from the pharmacy combo box (spec B1/B2 — docs/specs/direct-orders-v2.md). */
export type DirectOrderPharmacySearchHit = {
  /** 'directory' = distributor customer map row; 'phoenix' = validated Phoenix pharmacy. */
  source: "directory" | "phoenix";
  distributorCode: string | null;
  customerCode: string | null;
  /** null = the distributor lists no name for this code — render "(no name on file)", never blank. */
  customerName: string | null;
  address: string | null;
  brickId: string | null;
  areaCode: string | null;
  areaName: string;
  regionCode: string | null;
  regionName: string;
  phoenixPharmacyCode: string | null;
  verificationStatus: string | null;
  /**
   * What else this shop is called, where the Super Admin has CONFIRMED that two rows are one
   * customer. Empty for every hit nobody has been asked about, which today is almost all of them.
   *
   * 🔴 IT IS A LABEL, NOT A FILTER. The picker offers exactly the hits it offered before, in the
   * same order — a confirmed link adds a line of text and removes nothing. Letting it collapse
   * two hits into one would be a merge performed by a search box, and the treasure rule puts that
   * decision in a person's hands.
   */
  alsoKnownAs: string[];
};

/**
 * The combo-box search behind the submit form (spec B1/B2/B3).
 *
 * All matching happens in SQL (`phx_search_direct_order_customers`): customer CODE (prefix, then
 * contains) OR Arabic-normalized NAME, across the live union of the distributor customer
 * directory and Phoenix-validated pharmacies — so a pharmacy admitted by any route is findable
 * the moment it exists, with no cached list to go stale.
 *
 * Unnamed customers (6,089 of 51,192) ARE returned — hiding them was one of the two defects that
 * made staff hand-type pharmacies on launch day. The UI labels them by code.
 *
 * Same scope boundary as `searchDistributorCustomers` above: results are filtered to the
 * caller's visible areas, and an area-less row is only shown to unrestricted (company-tier)
 * viewers. Scope can only narrow what SQL returned, never widen it.
 */
export async function searchDirectOrderPharmacyDirectory(
  access: AccessContext,
  input: { query: string; distributorCode?: string | null; limit?: number },
): Promise<DirectOrderPharmacySearchHit[]> {
  await assertPermission(access, "direct_orders", "read");
  const query = String(input.query ?? "").trim();
  // One character would scan half the catalogue and help nobody; the UI debounces to 2+ anyway.
  if (query.length < 2) return [];

  const distributorCode = String(input.distributorCode ?? "").trim() || null;
  if (distributorCode && DIRECT_ORDER_EXCLUDED_DISTRIBUTOR_CODES.has(distributorCode.toLowerCase())) return [];

  const { areas } = await listDirectOrderAreaAndBrickOptions(access);
  const allowedAreaCodes = new Set(areas.map((area) => area.areaCode.toUpperCase()));
  // "line" (National Sales Manager) counts as unrestricted HERE too: per
  // listDirectOrderAreaAndBrickOptions's own note, Direct Orders gates NSM on the PRODUCT line
  // (resolveDirectOrderRequesterLineName), never on geography — an NSM stays nationwide for
  // customer/pharmacy search even though the report itself narrows to their line.
  const reportScope = resolveDirectOrderReportScope(access);
  const unrestricted = reportScope === "all" || reportScope === "line";
  if (!unrestricted && allowedAreaCodes.size === 0) return [];

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_search_direct_order_customers", {
    p_query: query,
    p_distributor_code: distributorCode,
    p_limit: Math.min(Math.max(input.limit ?? 30, 1), 100),
  });
  if (error) throw error;

  const geoMaps = await loadDirectOrderGeoNames();
  const hits = ((data ?? []) as Array<Record<string, unknown>>)
    .map((row): DirectOrderPharmacySearchHit => {
      const areaCode = row.area_code ? String(row.area_code) : null;
      const regionCode = row.region_code ? String(row.region_code) : null;
      const name = String(row.customer_name ?? "").trim();
      return {
        source: row.source === "phoenix" ? "phoenix" : "directory",
        distributorCode: row.distributor_code ? String(row.distributor_code) : null,
        customerCode: row.customer_code ? String(row.customer_code) : null,
        customerName: name.length > 0 ? name : null,
        address: row.address ? String(row.address) : null,
        brickId: row.brick_id ? String(row.brick_id) : null,
        areaCode,
        areaName: areaCode ? geoMaps.areaNameByCode.get(areaCode) ?? "" : "",
        regionCode,
        regionName: regionCode ? geoMaps.regionNameByCode.get(regionCode) ?? "" : "",
        phoenixPharmacyCode: row.phoenix_pharmacy_code ? String(row.phoenix_pharmacy_code) : null,
        verificationStatus: row.verification_status ? String(row.verification_status) : null,
        alsoKnownAs: [],
      };
    })
    .filter((hit) => (hit.areaCode ? unrestricted || allowedAreaCodes.has(hit.areaCode.toUpperCase()) : unrestricted))
    // Owner rule 2026-09-22 ("never never never"): a wholesaler / makhzan is never offered as a
    // matchable venue in the submit-form combo box, on either the directory or the Phoenix side.
    .filter((hit) => !isCertainWholesalerVenue(hit.customerName, hit.customerCode, hit.distributorCode));

  return attachConfirmedAliases(hits);
}

/**
 * Hangs the confirmed "also known as" names on the hits the picker is about to show.
 *
 * 🔴 IT RUNS AFTER THE FILTERS, NEVER BEFORE, so it cannot change which hits exist — a label that
 * could alter a result set is a filter wearing a label's clothes.
 *
 * 🔴 IT NEVER FAILS THE SEARCH. The identity module is an annotation on this picker, not a
 * dependency of it: a submitter typing a pharmacy name needs the list far more than he needs the
 * footnote, so a failure here costs the footnote and nothing else.
 *
 * Only the Phoenix side can be linked. A directory row is a distributor's own customer record
 * with no Phoenix pharmacy behind it, so there is no id for a master to hold — which is also why
 * the lookup is keyed on `phoenix_pharmacy_code` rather than on the name.
 */
async function attachConfirmedAliases(
  hits: DirectOrderPharmacySearchHit[],
): Promise<DirectOrderPharmacySearchHit[]> {
  const phoenixCodes = [...new Set(hits.map((hit) => hit.phoenixPharmacyCode).filter((code): code is string => Boolean(code)))];
  const customerCodes = [...new Set(hits.map((hit) => hit.customerCode).filter((code): code is string => Boolean(code)))];
  if (phoenixCodes.length === 0 && customerCodes.length === 0) return hits;

  try {
    const supabase = getSupabaseAdmin();
    const [phoenixRows, marketingRows] = await Promise.all([
      phoenixCodes.length === 0
        ? Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null })
        : supabase.from("direct_order_pharmacies").select("id, phoenix_pharmacy_code").in("phoenix_pharmacy_code", phoenixCodes),
      // 🔴 THE RESOLVED PAIR, NOT THE RAW TYPED CODE. `mapped_*` is what the capture-time resolver
      //    agreed the code means; the raw `distributor_pharmacy_code` beside it is whatever a
      //    person typed, and §4.1 is explicit that nothing may key on it.
      customerCodes.length === 0
        ? Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null })
        : supabase
            .from("marketing_pharmacy_distributor_codes")
            .select("pharmacy_id, mapped_distributor_code, mapped_customer_code")
            .in("mapped_customer_code", customerCodes),
    ]);
    if (phoenixRows.error) throw phoenixRows.error;
    if (marketingRows.error) throw marketingRows.error;

    const directIdByCode = new Map<string, string>();
    for (const row of (phoenixRows.data ?? []) as Array<Record<string, unknown>>) {
      const code = String(row.phoenix_pharmacy_code ?? "").trim();
      const id = String(row.id ?? "").trim();
      if (code && id) directIdByCode.set(code, id);
    }

    // 🔴 KEYED ON THE PAIR, NEVER ON THE CUSTOMER CODE ALONE. Every distributor numbers its own
    //    customers, so the same code means a different shop at a different distributor — the
    //    standing rule that a shared customer code cannot prove two venues are the same. The `.in()`
    //    above can only filter one column, so the second half of the key is matched here.
    const marketingIdByPair = new Map<string, string>();
    for (const row of (marketingRows.data ?? []) as Array<Record<string, unknown>>) {
      const distributor = String(row.mapped_distributor_code ?? "").trim().toUpperCase();
      const customer = String(row.mapped_customer_code ?? "").trim().toUpperCase();
      const id = String(row.pharmacy_id ?? "").trim();
      if (distributor && customer && id) marketingIdByPair.set(`${distributor}::${customer}`, id);
    }

    if (directIdByCode.size === 0 && marketingIdByPair.size === 0) return hits;

    const [directAliases, marketingAliases] = await Promise.all([
      loadAlsoKnownAsBatch("direct_order", [...directIdByCode.values()]),
      loadAlsoKnownAsBatch("marketing", [...marketingIdByPair.values()]),
    ]);
    if (directAliases.size === 0 && marketingAliases.size === 0) return hits;

    return hits.map((hit) => {
      const directId = hit.phoenixPharmacyCode ? directIdByCode.get(hit.phoenixPharmacyCode) : null;
      const pair =
        hit.distributorCode && hit.customerCode
          ? `${hit.distributorCode.trim().toUpperCase()}::${hit.customerCode.trim().toUpperCase()}`
          : null;
      const marketingId = pair ? marketingIdByPair.get(pair) : null;

      // A hit can be both — a Phoenix pharmacy that marketing also holds under the same code —
      // and then the two masters' members are one list. Deduped by NAME rather than by source id
      // because that is what the reader sees: the same shop named twice reads as a mistake.
      const names = new Set<string>();
      const own = (hit.customerName ?? "").trim();
      for (const row of [...(directId ? directAliases.get(directId) ?? [] : []), ...(marketingId ? marketingAliases.get(marketingId) ?? [] : [])]) {
        const name = (row.name ?? "").trim();
        // Its own name is not an alias of itself, and the directory's spelling very often equals
        // one of the linked rows' — which is how a hit ends up "also known as" itself.
        if (!name || name === own) continue;
        names.add(name);
      }
      if (names.size === 0) return hit;
      return { ...hit, alsoKnownAs: [...names] };
    });
  } catch {
    return hits;
  }
}

export async function listDirectOrderDistributorOptions(): Promise<Array<{ distributorCode: string; distributorName: string }>> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("source_of_sales_distributors")
    .select("distributor_code, distributor_name")
    .eq("active", true)
    .order("distributor_name", { ascending: true });
  return ((data ?? []) as Array<{ distributor_code: string; distributor_name: string | null }>)
    .filter((row) => row.distributor_code)
    .filter((row) => !DIRECT_ORDER_EXCLUDED_DISTRIBUTOR_CODES.has(row.distributor_code.trim().toLowerCase()))
    .map((row) => ({ distributorCode: row.distributor_code, distributorName: row.distributor_name ?? row.distributor_code }));
}

// ── Submit ────────────────────────────────────────────────────────────────────

export type SubmitDirectOrderInput = {
  productCode: string;
  pharmacyId: string;
  qty: number;
  /** 'bonus' (default) or 'discount'. */
  dealType?: DirectOrderDealType;
  bonus?: number;
  /** Discount % (0–100), required when dealType = 'discount'. */
  discountPct?: number | null;
  /** CEO-override reason when bonus or discount exceeds its (config) cap. */
  bonusOverrideReason?: string | null;
  /** Expected money-collection date (YYYY-MM-DD), required — entered by the requester. */
  collectionDate?: string | null;
  /**
   * The marketing campaign this order came from, DECLARED by the requester (owner's rule: the rep
   * picks it when raising the order). OPTIONAL and must stay so — most direct orders are not
   * campaign-driven, and 93 of 93 in production carry none. Validated server-side against this
   * order's own line by `resolveSubmittedCampaignId`; the picker is a convenience, not the boundary.
   */
  marketingRequestId?: string | null;
  /**
   * The distributor invoice the requester read on the form, as a data URL (owner, 2026-09-14). OPTIONAL:
   * it is kept with the order so the SFE Manager sees the invoice that was used, and for a new pharmacy
   * it counts as its invoice validation. Never required to raise an order.
   */
  invoiceDataUrl?: string | null;
  /**
   * EXTRA lines beyond the one described by the fields above, for a family basket.
   *
   * Additive on purpose. Every existing caller — the submit API route, the tests, anything holding
   * a saved payload — sends the singular fields and no `items`, and gets exactly the one-product
   * request it always got. A Lacto basket sends the second concentration here.
   *
   * The alternative, replacing the singular fields with an `items` array, would have been cleaner
   * to read and would have broken every caller at once for a feature only Lacto can use.
   */
  items?: DirectOrderItemInput[];
};

/** One line a caller wants on a request. `productCode` identifies it; everything else prices it. */
export type DirectOrderItemInput = {
  productCode: string;
  qty: number;
  dealType?: DirectOrderDealType;
  bonus?: number;
  discountPct?: number | null;
};

/** A line, priced and checked, ready to be written. */
export type ResolvedDirectOrderLine = {
  lineNo: number;
  productCode: string;
  productName: string;
  familyCode: string;
  line: string;
  dealType: DirectOrderDealType;
  qty: number;
  bonus: number;
  discountPct: number | null;
  publicPrice: number | null;
  pharmacyPrice: number | null;
  salesValue: number;
  overCap: boolean;
};

/**
 * Turn what a caller asked for into priced, validated lines — the ONE definition both
 * `submitDirectOrder` and `reviseDirectOrder` use.
 *
 * A request used to be one product. It can now carry several, but only from ONE family and only
 * from a family allowed to combine (today Lacto alone — see product-family.ts). Everything else
 * about a line is unchanged: same catalogue lookup, same line guard, same pricing helper, same
 * flag-never-block cap behaviour.
 *
 * SHARED FOR THE SAME REASON `resolveDirectOrderPricing` IS. A correction is repriced from scratch
 * on resubmission; a second copy of these rules is precisely how a correction ends up valued — or
 * validated — differently from the order it corrects.
 *
 * THE LINE GUARD RUNS PER ITEM, not once for the basket. A single-family basket cannot span product
 * lines today (every family sits on one line once confidential products are excluded), so this is
 * defence in depth rather than a live case — but "cannot today" is a property of the data, and this
 * is money.
 */
async function resolveDirectOrderBasket(input: {
  access: AccessContext;
  items: readonly DirectOrderItemInput[];
  caps: Awaited<ReturnType<typeof loadDirectOrderCaps>>;
}): Promise<{ lines: ResolvedDirectOrderLine[]; familyCode: string; totalSalesValue: number }> {
  const { access, items, caps } = input;
  if (items.length === 0) badRequest("A direct order needs at least one product.");

  const products = await listSourceOfSalesProducts();
  const requesterLine = await resolveDirectOrderRequesterLineName(access);

  type Candidate = { item: DirectOrderItemInput; product: (typeof products)[number]; qty: number };
  const candidates: Candidate[] = [];

  for (const item of items) {
    const qty = Math.floor(Number(item.qty) || 0);
    if (qty <= 0) badRequest("Quantity must be greater than zero.");

    const product = products.find((candidate) => candidate.productCode === item.productCode);
    if (!product) badRequest(`Unknown product code "${item.productCode}".`);
    if ((product.line ?? "").trim().toUpperCase() === "IGNORE") {
      badRequest(`"${product.productName}" is not a submittable Phoenix product.`);
    }
    // Server-side line guard (defence in depth — the submit form's dropdown is already scoped, but
    // this is money-critical: never trust a client-only restriction here).
    if (requesterLine !== null && requesterLine.toLowerCase() !== (product.line ?? "").trim().toLowerCase()) {
      badRequest(
        requesterLine
          ? `"${product.productName}" is a ${product.line} product — you can only submit direct orders for your own line (${requesterLine}).`
          : `Your account has no field line on record, so it cannot submit a direct order for "${product.productName}".`,
      );
    }
    candidates.push({ item, product, qty });
  }

  // The family rule, from the one module that owns it. Checked BEFORE pricing: refusing a mixed
  // basket after reading prices for it would be work done to reach a foregone conclusion.
  const verdict = validateDirectOrderBasket(
    candidates.map((candidate) => ({
      productCode: candidate.product.productCode,
      familyCode: familyKey(candidate.product.familyCode),
    })),
  );
  if (!verdict.ok) badRequest(verdict.message);

  const lines: ResolvedDirectOrderLine[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const dealType: DirectOrderDealType = candidate.item.dealType === "discount" ? "discount" : "bonus";
    const priced = await resolveDirectOrderPricing({
      product: candidate.product,
      dealType,
      qty: candidate.qty,
      bonus: candidate.item.bonus,
      discountPct: candidate.item.discountPct,
      caps,
    });
    lines.push({
      lineNo: index + 1,
      productCode: candidate.product.productCode,
      productName: candidate.product.productName,
      familyCode: familyKey(candidate.product.familyCode),
      line: candidate.product.line,
      dealType,
      qty: candidate.qty,
      bonus: priced.bonus,
      discountPct: priced.discountPct,
      publicPrice: priced.publicPrice,
      pharmacyPrice: priced.pharmacyPrice,
      salesValue: priced.salesValue,
      overCap: priced.overCap,
    });
  }

  return {
    lines,
    familyCode: lines[0].familyCode,
    // The request's stored sales_value. Rounded once, at the end: summing pre-rounded lines and
    // rounding again would let a half-piastre drift in and out of the collection remainder.
    totalSalesValue: Math.round(lines.reduce((sum, line) => sum + line.salesValue, 0) * 100) / 100,
  };
}

/**
 * Replace a request's lines with exactly these.
 *
 * Delete-then-insert rather than diffing: a correction can drop a line, and reconciling an edited
 * basket line-by-line is a lot of code to arrive at the same three rows. The unique constraint on
 * (request_id, line_no) makes a partial failure loud rather than silently duplicating a line.
 */
async function writeDirectOrderItems(requestId: string, lines: readonly ResolvedDirectOrderLine[]): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error: deleteError } = await supabase
    .from("direct_order_request_items")
    .delete()
    .eq("request_id", requestId);
  if (deleteError) throw deleteError;

  const { error: insertError } = await supabase.from("direct_order_request_items").insert(
    lines.map((line) => ({
      request_id: requestId,
      line_no: line.lineNo,
      product_code: line.productCode,
      product_name: line.productName,
      family_code: line.familyCode,
      public_price_snapshot: line.publicPrice,
      pharmacy_price_snapshot: line.dealType === "bonus" ? line.pharmacyPrice : null,
      deal_type: line.dealType,
      qty: line.qty,
      bonus: line.bonus,
      discount_pct: line.discountPct,
      sales_value: line.salesValue,
      over_cap: line.overCap,
    })),
  );
  if (insertError) throw insertError;
}

/**
 * Resolve the money for a direct order: which price basis applies, whether it is over cap, and the
 * resulting sales value. ONE definition, called by both `submitDirectOrder` and `reviseDirectOrder`.
 *
 * EXTRACTED 2026-08-11, when returned-order correction was implemented (second-review finding 1).
 * A corrected order is repriced from scratch on resubmission, and a second copy of these rules is
 * precisely how a correction ends up valued on a basis the business does not sell at — the exact
 * failure the no-factory-price ruling below exists to prevent. Both callers must price identically
 * or the correction is a silent repricing.
 */
async function resolveDirectOrderPricing(input: {
  product: { productCode: string; productName: string };
  dealType: DirectOrderDealType;
  qty: number;
  bonus: number | null | undefined;
  discountPct: number | null | undefined;
  caps: Awaited<ReturnType<typeof loadDirectOrderCaps>>;
}): Promise<{
  bonus: number;
  discountPct: number | null;
  publicPrice: number | null;
  pharmacyPrice: number | null;
  salesValue: number;
  /**
   * Over-cap does NOT block and does NOT restrict who may finalize (owner rule, 2026-08-03). It
   * flags the request: an "over cap" badge on every list and detail view, a tag on the approver's
   * notification, and an event when it is finalized. The chain always ends at the CEO regardless.
   */
  overCap: boolean;
}> {
  const supabase = getSupabaseAdmin();
  const { product, dealType, qty, caps } = input;

  // Both money inputs are read FRESH from the table rather than taken off `product`.
  // `listSourceOfSalesProducts()` is unstable_cache'd with a 600s revalidate and no price
  // setter busts that tag, so a price the owner just typed could be up to ten minutes stale.
  // A stale price is fine for a dropdown label; it is not fine for a sales value.
  const { data: priceRow } = await supabase
    .from("source_of_sales_products")
    .select("public_price, pharmacy_price")
    .eq("product_code", product.productCode)
    .maybeSingle();
  const prices = priceRow as { public_price?: number | null; pharmacy_price?: number | null } | null;

  if (dealType === "discount") {
    // Discount uses the PUBLIC price; value = qty × public × (1 − disc%). No bonus. UNCHANGED.
    const publicPrice = prices?.public_price != null ? Number(prices.public_price) : null;
    // NOTE: discount mode still HARD-BLOCKS on a missing public price, whereas bonus mode below
    // falls back and flags. That asymmetry is deliberate and pre-existing — do not "harmonize"
    // the two paths without the owner deciding which way they should converge.
    if (publicPrice == null || publicPrice <= 0) {
      badRequest(`No public price is set for ${product.productName}. Ask an admin to set it before using discount mode.`);
    }
    const discountPct = Math.max(0, Math.min(100, Number(input.discountPct) || 0));
    const capPct = resolveDiscountCapPct(caps, product.productCode);
    return {
      bonus: 0,
      discountPct,
      publicPrice,
      pharmacyPrice: null,
      salesValue: computeDiscountSalesValue({ qty, publicPrice: publicPrice as number, discountPct }),
      overCap: !validateDiscount({ discountPct, capPct }).withinCap,
    };
  }

  // Bonus: value = qty × PHARMACY price (bonus units excluded); bonus capped by config.
  //
  // There is NO factory-price fallback (owner ruling, 2026-08-04): a direct order is priced on
  // the pharmacy price or the public price and never on the factory price. The old fallback
  // silently repriced a bonus order onto a basis the business does not sell at, and when the
  // factory price was missing too it produced a real order worth 0 EGP that climbed the whole
  // chain to the CEO — Tigogrow (TG001) and Osteosat (OS001) are both in that state today.
  // A missing pharmacy price is now REFUSED, exactly as the discount branch above refuses a
  // missing public price. This deliberately replaces the earlier "flag, never block" rule.
  const bonus = Math.floor(Number(input.bonus) || 0);
  const capPct = resolveBonusCapPct(caps, product.productCode);
  const rawPharmacyPrice = prices?.pharmacy_price != null ? Number(prices.pharmacy_price) : null;
  const pharmacyPrice = rawPharmacyPrice != null && rawPharmacyPrice > 0 ? rawPharmacyPrice : null;
  if (pharmacyPrice == null) {
    badRequest(
      `No pharmacy price is set for ${product.productName}. A bonus deal is valued on the pharmacy ` +
        "price, so ask an admin to set it before submitting this order.",
    );
  }
  // `pharmacyPrice` is non-null past the guard above, so the pharmacy price is the ONLY basis a
  // bonus deal can ever be valued on. The product's factory price is deliberately not referenced
  // here, and a test asserts this branch never names it again.
  return {
    bonus,
    discountPct: null,
    publicPrice: null,
    pharmacyPrice,
    salesValue: computeDirectOrderSalesValue({ qty, pharmacyPrice }),
    overCap: !validateBonus({ qty, bonus, capPct }).withinCap,
  };
}

export async function submitDirectOrder(
  access: AccessContext,
  input: SubmitDirectOrderInput,
): Promise<DirectOrderRequest & { invoiceNote?: string | null }> {
  await assertPermission(access, "direct_orders", "create");
  // Super Admin may submit (system admin / on-behalf) — matches the workflow-registry
  // submit action's allowedRoles and the page's canSubmit gate.
  if (!isDirectOrderRequesterRole(access.role) && access.role !== "Super Admin") {
    badRequest(`Role "${access.role}" cannot submit direct orders. Allowed: ${DIRECT_ORDER_REQUESTER_ROLES.join(", ")}.`);
  }
  const actorHrId = requireActorHrId(access);

  const collectionDate = String(input.collectionDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(collectionDate)) {
    badRequest("A valid money-collection date (YYYY-MM-DD) is required.");
  }
  // The invoice read on the form — parsed BEFORE anything is written, so a bad file is refused with
  // nothing half-saved. Saved after the order exists, below.
  const orderInvoice = parseDirectOrderRequestInvoice(
    input.invoiceDataUrl,
    "Remove the invoice photo or read the invoice again.",
  );

  const supabase = getSupabaseAdmin();
  const caps = await loadDirectOrderCaps();
  const overrideReason = input.bonusOverrideReason?.trim() || null;

  // The basket. The singular fields are line 1; `items` adds the rest. Product lookup, the
  // IGNORE-line check, the server-side line guard, the family rule and pricing all live in
  // resolveDirectOrderBasket, which reviseDirectOrder calls identically.
  const { lines, familyCode, totalSalesValue } = await resolveDirectOrderBasket({
    access,
    caps,
    items: [
      {
        productCode: input.productCode,
        qty: input.qty,
        dealType: input.dealType,
        bonus: input.bonus,
        discountPct: input.discountPct,
      },
      ...(input.items ?? []),
    ],
  });

  // Line 1 populates the request's singular columns, which roughly thirty files still read. For a
  // one-item request — every order raised before today, and every non-Lacto order after it — those
  // columns are the whole truth exactly as before. `sales_value` is the basket TOTAL either way,
  // because collection's remaining_amount derives from it and must never under-count a basket.
  const headLine = lines[0];
  const product = { productCode: headLine.productCode, productName: headLine.productName, line: headLine.line };
  const dealType = headLine.dealType;
  const qty = headLine.qty;
  const { bonus, discountPct, publicPrice, pharmacyPrice } = headLine;
  const overCap = lines.some((line) => line.overCap);
  const salesValue = totalSalesValue;

  // Load the pharmacy in full (a missing map entry IS "not found") — the approver's
  // notification names the pharmacy, its geography and its distributors, so the bare
  // existence probe this replaced no longer carries enough.
  let pharmacies = await loadPharmaciesByIds([input.pharmacyId]);
  let pharmacy = pharmacies.get(input.pharmacyId) ?? null;
  if (!pharmacy) badRequest("Venue not found — pick an existing one or add a new venue first.");

  // Repair BEFORE deciding (owner rule, 2026-08-08). Pharmacies registered before auto-link exists
  // still carry their code in the name field; without this they would keep failing the hold test on
  // every future order for a code that is sitting right there. Running it here means the repair and
  // the release happen in ONE submission rather than needing a second order to benefit.
  //
  // Order matters: the auto-link must precede decideDirectOrderHold, and the pharmacy must be
  // re-read afterwards, or the decision would run against the stale pre-link row.
  const autoLink = await autoLinkDirectOrderPharmacyCode(input.pharmacyId, {
    actorLoginId: access.loginId ?? access.hrId,
  });
  if (autoLink.linked) {
    pharmacies = await loadPharmaciesByIds([input.pharmacyId]);
    pharmacy = pharmacies.get(input.pharmacyId) ?? pharmacy;
  }

  // The HELD fork (spec B6, reworked 2026-08-08). A pharmacy nothing vouches for parks the order
  // OUTSIDE the approval flow: status 'held', no steps seeded, no approver ever sees it as work,
  // dead in 14 days.
  //
  // What changed: `verification_status` used to be the SOLE input, so a hand-typed pharmacy whose
  // distributor code resolved perfectly and one with no code at all were frozen identically. The
  // DISTRIBUTOR code is the real evidence — a code the master database recognises, in the brick this
  // request declares, proves the pharmacy exists. Releasing does NOT skip review: the chain's first
  // rung is the SFE Manager either way, and the final-approval backstop still refuses while the
  // pharmacy is `pending_review`. It only stops freezing a provable pharmacy outside the chain.
  const holdDecision = decideDirectOrderHold({
    verificationStatus: pharmacy.verificationStatus,
    declaredBrickId: pharmacy.brickId,
    distributorCodes: await attachCodeOwnership(pharmacy),
    holdReleaseGround: pharmacy.holdReleaseGround,
  });
  const submitAsHeld = holdDecision.hold;

  // Governance: the registry validates that this role may submit from draft, and that the
  // destination status is the one this code expects.
  await assertDirectOrderWorkflowTransition({
    access,
    actionKey: submitAsHeld ? "submit_held" : "submit",
    expectedNextStatus: submitAsHeld ? "held" : "pending_approval",
    status: "draft",
  });

  const chain = submitAsHeld
    ? [] // seeded at revival instead — a chain built today could name yesterday's managers
    : await buildApprovalChain({
        requesterHrId: actorHrId,
        requesterRole: access.role,
      });

  // The campaign this order came from, as declared by the requester. Re-validated here rather than
  // trusted from the body: a hand-posted request must not be able to attach an order to a rejected
  // campaign, to another line's campaign, or to an id that does not exist. It runs AFTER the basket
  // because `product.line` is what the campaign has to match, and that is only known once the
  // basket has resolved. Throws with a readable reason; null means "no campaign", the normal case.
  const marketingRequestId = await resolveSubmittedCampaignId(access, input.marketingRequestId, product.line);

  const { data: inserted, error: insertError } = await supabase
    .from("direct_order_requests")
    .insert({
      requester_hr_id: hrIdForStorage(access.hrId),
      requester_role: access.role,
      status: submitAsHeld ? "held" : "pending_approval",
      held_at: submitAsHeld ? new Date().toISOString() : null,
      line: product.line,
      product_code: product.productCode,
      product_name: product.productName,
      family_code: familyCode,
      qty,
      bonus,
      bonus_override_reason: overrideReason,
      deal_type: dealType,
      discount_pct: discountPct,
      public_price_snapshot: publicPrice,
      pharmacy_price_snapshot: dealType === "bonus" ? pharmacyPrice : null,
      sales_value: salesValue,
      pharmacy_id: input.pharmacyId,
      collection_date: collectionDate,
      marketing_request_id: marketingRequestId,
      created_by_login_id: access.loginId ?? null,
      submitted_at: new Date().toISOString(),
    })
    .select("*")
    .single();
  if (insertError) throw insertError;
  const request = mapRequestRow(inserted as Record<string, unknown>);

  // The lines. Written immediately after the request so a basket can never exist without them —
  // the Source-of-Sales injection reads items, so a request with no items would inject nothing and
  // the money would simply be absent rather than wrong, which is harder to notice.
  await writeDirectOrderItems(request.id, lines);

  // Seed the approval steps — never for a held order, whose chain is built at revival.
  if (chain.length > 0) {
    const { error: stepsError } = await supabase.from("direct_order_approval_steps").insert(
      chain.map((step) => ({
        request_id: request.id,
        step_order: step.order,
        approver_kind: step.kind,
        approver_role: step.role,
        approver_hr_id: step.approverHrId,
        label: step.label,
        status: "pending",
      })),
    );
    if (stepsError) throw stepsError;
  }
  // A new order is a new held or awaiting count on the finance landing.
  invalidateFinanceDashboardCache("direct order submitted");
  // The Reps List's trade counts (src/lib/crm/contact-trade.ts) include this venue's orders from now on.
  refreshSharedTradeCounterparties("direct order submitted");

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: request.id,
    newValues: { status: request.status, product: product.productCode, qty, salesValue },
    summary: submitAsHeld
      ? `Direct order submitted HELD by ${access.hrId} (${product.productName}, ${qty} units) — pharmacy awaiting validation.`
      : `Direct order submitted by ${access.hrId} (${product.productName}, ${qty} units).`,
  });
  await insertEvent({
    requestId: request.id,
    actorHrId: access.hrId,
    eventType: "submitted",
    message: `Submitted ${product.productName} × ${qty}.`,
    // Record which price basis produced this sales_value, so the timeline can answer
    // "why is this number what it is" without re-deriving it from a master that has moved on.
    metadata: {
      basis: dealType === "bonus" ? "pharmacy_price" : "public_price",
      pharmacyPriceSnapshot: pharmacyPrice,
      publicPriceSnapshot: publicPrice,
      salesValue,
      overCap,
      // WHY this order is (or is not) in the held lane, decided at this instant. Re-deriving it later
      // reads today's pharmacy, which the repair below may have changed — so it must be recorded now.
      holdGround: holdDecision.ground,
      // And whether the system repaired the pharmacy on the way in. An order that skipped the held
      // lane because a code was auto-linked seconds earlier must say so, or the timeline reads as
      // though the pharmacy had been proven all along.
      autoLinkedCode: autoLink.linked ? `${autoLink.distributorCode}/${autoLink.customerCode}` : null,
      autoLinkedRenameTo: autoLink.renamedTo,
    },
  });

  // The order is written; its invoice can no longer fail it. saveSubmittedDirectOrderInvoice never
  // throws — a failure is recorded on the order and said to the rep, who attaches it again.
  const invoiceNote = orderInvoice
    ? await saveSubmittedDirectOrderInvoice(access, {
        requestId: request.id,
        requestStatus: request.status,
        pharmacyId: request.pharmacyId,
        invoice: orderInvoice,
      })
    : null;

  // The notice goes out AFTER the reply (afterResponse): on production a decision took 7.8 s at the
  // median and 22 s at the 95th percentile, of which the decision itself was 0.8 s — the rest was this
  // notice's reads and its fan-out to every recipient, awaited before the answer left. The order is
  // already saved; a failed notice is logged and never changes the answer.
  if (submitAsHeld) {
    await afterResponse("direct_order_notice:submitted_held", async () => {
      const requesterDisplayName = (await nameLookup())(actorHrId) ?? actorHrId;
      const notifyContext = await buildNotifyContext(request, requesterDisplayName, pharmacy);

      // Nobody is asked to approve a held order — that is the point. The requester learns the
      // state and the way out; the Held Desk (and its bulk notice button) is the pressure valve.
      await notifyDirectOrder({
        recipients: [actorHrId],
        title: "Direct order held — venue not in the master database",
        message:
          `${buildDirectOrderNotificationLine(notifyContext)} ` +
          "This request is HELD and has not entered the approval flow. It will move only after the " +
          "pharmacy passes validation; an untouched held request expires after 14 days.",
        metrics: buildDirectOrderNotificationMetrics(notifyContext),
        eventType: "submitted",
        requestId: request.id,
        subjectHrId: actorHrId,
      });
    });
    return { ...request, invoiceNote };
  }
  await afterResponse("direct_order_notice:submitted", async () => {
    const requesterDisplayName = (await nameLookup())(actorHrId) ?? actorHrId;
    const notifyContext = await buildNotifyContext(request, requesterDisplayName, pharmacy);

    const firstStep = chain[0];
    const firstApprovers = firstStep.kind === "role" && firstStep.role ? await hrIdsForRole(firstStep.role) : [firstStep.approverHrId];
    // Tags compose — an over-cap order on a product with no pharmacy price must show BOTH.
    const tags = [
      overCap ? (dealType === "discount" ? "[High Discount]" : "[High Bonus]") : null,
      dealType === "bonus" && pharmacyPrice == null ? "[No pharmacy price]" : null,
    ]
      .filter(Boolean)
      .join(" ");
    const capNote = overCap ? ` This ${dealType} exceeds the cap — flagged, not blocked.` : "";
    // Only whoever must actually act — SFE Manager and Super Admin no longer ride along by
    // default. When the first rung IS the SFE Manager (the common case), they still appear here,
    // because they ARE firstApprovers; this only drops the blanket copy to people who aren't.
    await notifyDirectOrder({
      recipients: firstApprovers,
      title: `${tags ? `${tags} ` : ""}Direct order awaiting your approval`,
      message: `${buildDirectOrderNotificationLine(notifyContext)}${capNote}`,
      metrics: buildDirectOrderNotificationMetrics(notifyContext),
      eventType: "submitted",
      requestId: request.id,
      subjectHrId: actorHrId,
    });
  });

  pingDirectOrderSheet("order_submitted");
  return { ...request, invoiceNote };
}

// ── Correct & resubmit a returned order ──────────────────────────────────────

/**
 * The fields a requester may change when correcting a RETURNED order.
 *
 * PRODUCT AND PHARMACY ARE DELIBERATELY ABSENT. Both are identity, not detail:
 *   - changing the product can change the LINE, and the approval chain was built for the original
 *     requester's line — a corrected order on a different line would climb a chain that no longer
 *     matches it;
 *   - changing the pharmacy re-opens the held decision (`decideDirectOrderHold`), which is taken at
 *     submit time and determines whether the order belongs in the approval flow at all.
 * A correction that needs either is a DIFFERENT order, and the product asks for a new one. This is
 * a business rule, not a technical limitation, and the UI says so in those words.
 */
export type ReviseDirectOrderInput = {
  requestId: string;
  qty: number;
  dealType?: DirectOrderDealType;
  bonus?: number;
  discountPct?: number | null;
  bonusOverrideReason?: string | null;
  collectionDate?: string | null;
  /** The requester's note back to the approver saying what they changed. Required. */
  correctionNote?: string | null;
  /**
   * The corrected values of every line AFTER the one described above — one per product already on
   * the order, never a new product. ABSENT keeps every stored extra line exactly as it is.
   *
   * 🔴 It used to mean "a single-line order", and no screen or route ever sent it, so correcting a
   * returned basket deleted its second line (code review, 19 Oct 2026). The rule now lives in
   * `resolveCorrectionExtraLines` (correction-lines.ts): the products are the order's identity, and
   * only their quantities and deals are corrected.
   */
  items?: DirectOrderItemInput[];
};

/** One line as the correction's audit row and timeline record it, before and after. */
function auditLine(line: {
  productCode: string;
  productName: string;
  qty: number;
  dealType: DirectOrderDealType;
  bonus: number;
  discountPct: number | null;
  salesValue: number;
}) {
  return {
    productCode: line.productCode,
    productName: line.productName,
    qty: line.qty,
    dealType: line.dealType,
    bonus: line.bonus,
    discountPct: line.discountPct,
    salesValue: line.salesValue,
  };
}

/**
 * Correct a returned direct order and put it back in front of the SAME approver.
 *
 * WHY THIS EXISTS (second-review finding 1, 2026-08-11). The workflow registry has declared
 * `submit` as `from: ["draft","returned"] → pending_approval` since the module's foundation
 * migration, Needs Action offers "Fix and resubmit", and `resolveActionAvailability` tells the
 * approver "Waiting for the requester to resubmit". None of it was reachable: `submitDirectOrder`
 * accepts no request id, always INSERTs, and hard-codes `status: "draft"` in its registry check, so
 * the registry's `"returned"` entry had never once been exercised. A returned order was a dead end
 * — the requester's only recourse was to raise a second, unrelated order, orphaning the original
 * and every approval already recorded against it.
 *
 * WHY IT UPDATES RATHER THAN INSERTS. The whole point of a return is that the request survives: its
 * id, its history, and the approvals already given. So this writes to the SAME row and never touches
 * `direct_order_approval_steps`.
 *
 * WHY THE CHAIN IS NOT REBUILT. It does not need to be. `phx_apply_direct_order_decision` only
 * updates a step when `p_step_next_status in ('approved','rejected')` — a `return` therefore leaves
 * the returning rung `pending`, with every rung above it untouched and every rung below it already
 * `approved`. `resolveActiveStep` takes the lowest-order pending rung, so flipping the request back
 * to `pending_approval` resumes at exactly the rung that returned it. Rebuilding would restart at
 * SFE and discard real decisions; that is explicitly not the business rule.
 */
export async function reviseDirectOrder(
  access: AccessContext,
  input: ReviseDirectOrderInput,
): Promise<DirectOrderRequest> {
  await assertPermission(access, "direct_orders", "create");
  if (!isDirectOrderRequesterRole(access.role) && access.role !== "Super Admin") {
    badRequest(`Role "${access.role}" cannot submit direct orders. Allowed: ${DIRECT_ORDER_REQUESTER_ROLES.join(", ")}.`);
  }
  const actorHrId = requireActorHrId(access);

  const supabase = getSupabaseAdmin();
  const { data: current, error: loadError } = await supabase
    .from("direct_order_requests")
    .select("*")
    .eq("id", input.requestId)
    .maybeSingle();
  if (loadError) throw loadError;
  if (!current) badRequest("Direct order request not found.");
  const before = mapRequestRow(current as Record<string, unknown>);

  if (before.status !== "returned") {
    badRequest(
      `Only an order that an approver sent back can be corrected. This one is ${describeDirectOrderStatus(before.status, before.salesMonth).label.toLowerCase()}.`,
    );
  }

  // OWNERSHIP. A return is addressed to the person who raised the order; nobody else may answer it.
  // Super Admin may act on their behalf, matching every other requester-side action in this module.
  const isSuperAdmin = access.role === "Super Admin" || access.scope === "system";
  if (!isSuperAdmin && canonicalHrIdKey(before.requesterHrId) !== canonicalHrIdKey(actorHrId)) {
    badRequest("Only the person who raised this order can correct and resubmit it.");
  }

  const correctionNote = input.correctionNote?.trim() || null;
  if (!correctionNote) {
    // Symmetric with the approver, who cannot return without a written reason. A silent
    // resubmission gives them no way to see what changed without diffing the row by hand.
    badRequest("Say what you changed, so the approver can see why this is different.");
  }

  const qty = Math.floor(Number(input.qty) || 0);
  if (qty <= 0) badRequest("Quantity must be greater than zero.");

  const collectionDate = String(input.collectionDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(collectionDate)) {
    badRequest("A valid money-collection date (YYYY-MM-DD) is required.");
  }

  // The product is NOT taken from the caller — see ReviseDirectOrderInput. It is re-resolved from
  // the stored code so a correction cannot silently move the order to another product or line.
  const products = await listSourceOfSalesProducts();
  const product = products.find((candidate) => candidate.productCode === before.productCode);
  if (!product) {
    badRequest(`This order's product (${before.productCode}) is no longer in the product master, so it cannot be resubmitted.`);
  }

  const caps = await loadDirectOrderCaps();
  const overrideReason = input.bonusOverrideReason?.trim() || null;

  // Every line the order holds now, read BEFORE anything is written: the lines after the first are
  // kept (or corrected) rather than dropped, and the audit row records the basket on both sides.
  const storedLines = await loadDirectOrderItems(before.id);
  const extraLines = resolveCorrectionExtraLines({
    headProductCode: before.productCode,
    storedExtras: storedLines.slice(1),
    sent: input.items,
  });
  if (!extraLines.ok) badRequest(extraLines.message);

  // Repriced from scratch through the SAME helper `submitDirectOrder` uses, basket and all. A
  // correction submitted a week later must be valued on today's price basis, and validated by the
  // same family rule, exactly as a fresh order would be.
  const { lines, familyCode, totalSalesValue } = await resolveDirectOrderBasket({
    access,
    caps,
    items: [
      {
        productCode: before.productCode,
        qty: input.qty,
        dealType: input.dealType,
        bonus: input.bonus,
        discountPct: input.discountPct,
      },
      ...extraLines.items,
    ],
  });

  const headLine = lines[0];
  const dealType = headLine.dealType;
  const { bonus, discountPct, publicPrice, pharmacyPrice } = headLine;
  const overCap = lines.some((line) => line.overCap);
  const salesValue = totalSalesValue;

  const steps = await loadSteps(before.id);
  const activeStep = resolveActiveStep(steps);
  if (!activeStep) {
    // Defensive: a returned order should always carry the returning rung as still-pending. If it
    // does not, the chain is malformed and resubmitting would send it to nobody.
    badRequest(
      "This order has no approver waiting on it, so it cannot be resubmitted. Ask a system administrator to check its approval chain.",
    );
  }

  // Governance: the registry's `submit` action has always declared `returned` as a legal origin.
  // Passing the row's REAL status (not a literal) is what finally exercises it.
  await assertDirectOrderWorkflowTransition({
    access,
    actionKey: "submit",
    expectedNextStatus: "pending_approval",
    status: before.status,
  });

  const { data: updated, error: updateError } = await supabase
    .from("direct_order_requests")
    .update({
      status: "pending_approval",
      family_code: familyCode,
      qty: headLine.qty,
      bonus,
      bonus_override_reason: overrideReason,
      deal_type: dealType,
      discount_pct: discountPct,
      public_price_snapshot: publicPrice,
      pharmacy_price_snapshot: dealType === "bonus" ? pharmacyPrice : null,
      sales_value: salesValue,
      collection_date: collectionDate,
      submitted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", before.id)
    // Compare-and-swap on the status we validated against, so two tabs cannot both resubmit.
    .eq("status", "returned")
    .select("*")
    .single();
  if (updateError) throw updateError;
  const after = mapRequestRow(updated as Record<string, unknown>);

  // Replace the lines. AFTER the compare-and-swap on status='returned' succeeded, so a losing
  // second tab cannot rewrite the basket of an order it did not resubmit.
  await writeDirectOrderItems(after.id, lines);

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: after.id,
    oldValues: {
      status: before.status,
      qty: before.qty,
      bonus: before.bonus,
      dealType: before.dealType,
      discountPct: before.discountPct,
      salesValue: before.salesValue,
      collectionDate: before.collectionDate,
      lines: storedLines.map(auditLine),
    },
    newValues: {
      status: after.status,
      qty,
      bonus,
      dealType,
      discountPct,
      salesValue,
      collectionDate,
      lines: lines.map(auditLine),
    },
    // Each product with its own units — units of different products are never added together.
    summary: `Direct order corrected and resubmitted by ${access.hrId} (${lines
      .map((line) => `${line.productName}, ${line.qty} units`)
      .join("; ")}).`,
  });
  await insertEvent({
    requestId: after.id,
    actorHrId: access.hrId,
    eventType: "resubmitted",
    message: `Corrected and resubmitted: ${correctionNote}`,
    metadata: {
      correctionNote,
      // The exact before/after of every editable field, so the timeline answers "what changed"
      // without anyone reconstructing it from two audit rows.
      changed: {
        qty: { from: before.qty, to: qty },
        bonus: { from: before.bonus, to: bonus },
        dealType: { from: before.dealType, to: dealType },
        discountPct: { from: before.discountPct, to: discountPct },
        salesValue: { from: before.salesValue, to: salesValue },
        collectionDate: { from: before.collectionDate, to: collectionDate },
        lines: { from: storedLines.map(auditLine), to: lines.map(auditLine) },
      },
      basis: dealType === "bonus" ? "pharmacy_price" : "public_price",
      overCap,
      resumedAtStepOrder: activeStep.order,
      resumedAtLabel: activeStep.label,
    },
  });

  // After the reply (afterResponse): the order is saved, and this notice's reads and fan-out used to be
  // awaited before the answer left — seconds on production. A failed notice is logged, never thrown.
  await afterResponse("direct_order_notice:resubmitted", async () => {
    // Straight back to the rung that returned it — not to the front of the chain.
    const pharmacy = (await loadPharmaciesByIds([after.pharmacyId])).get(after.pharmacyId) ?? null;
    const requesterDisplayName = (await nameLookup())(before.requesterHrId) ?? before.requesterHrId;
    const notifyContext = await buildNotifyContext(after, requesterDisplayName, pharmacy);
    const approvers = activeStep.kind === "role" && activeStep.role
      ? await hrIdsForRole(activeStep.role)
      : [activeStep.approverHrId];
    const tags = [
      overCap ? (dealType === "discount" ? "[High Discount]" : "[High Bonus]") : null,
    ]
      .filter(Boolean)
      .join(" ");
    await notifyDirectOrder({
      recipients: [...approvers.filter((id): id is string => Boolean(id)), ...(await ccRecipients())],
      title: `${tags ? `${tags} ` : ""}Corrected direct order back for your approval`,
      message: `${buildDirectOrderNotificationLine(notifyContext)} The requester says: ${correctionNote}`,
      metrics: buildDirectOrderNotificationMetrics(notifyContext),
      eventType: "resubmitted",
      requestId: after.id,
      subjectHrId: before.requesterHrId,
    });
  });

  pingDirectOrderSheet("order_resubmitted");
  return after;
}

// ── Decide (approve / reject / return) ────────────────────────────────────────

export async function decideDirectOrder(
  access: AccessContext,
  input: { requestId: string; decision: DirectOrderDecision; comment?: string | null },
): Promise<DirectOrderRequest> {
  await assertPermission(access, "direct_orders", "approve");
  const supabase = getSupabaseAdmin();

  const { data: current, error: loadError } = await supabase
    .from("direct_order_requests")
    .select("*")
    .eq("id", input.requestId)
    .maybeSingle();
  if (loadError) throw loadError;
  if (!current) badRequest("Direct order request not found.");
  const request = mapRequestRow(current as Record<string, unknown>);
  if (request.status !== "pending_approval") {
    badRequest(`This request is ${request.status} and can no longer be actioned.`);
  }

  const steps = await loadSteps(request.id);
  const activeStep = resolveActiveStep(steps);
  if (!activeStep) badRequest("There is no pending approval step on this request.");

  // Fine authorization: the caller must be the assigned approver of the active step.
  // Matched on `kind`, not on the CEO specifically — the chain now opens with an SFE Manager
  // role rung, and a CEO-only special case would leave that rung actionable by nobody.
  const isSuperAdmin = access.role === "Super Admin" || access.scope === "system";
  const isAssigned = activeStep.kind === "role"
    ? Boolean(activeStep.role) && access.role === activeStep.role
    : canonicalHrIdKey(access.hrId) === canonicalHrIdKey(activeStep.approverHrId ?? "");
  if (!isSuperAdmin && !isAssigned) {
    badRequest("Only the current assigned approver can act on this request.");
  }

  const comment = input.comment?.trim() || null;
  if ((input.decision === "reject" || input.decision === "return") && !comment) {
    badRequest("A reason is required to reject or return a request.");
  }
  // NOTE: there is deliberately NO cap gate here. An over-cap bonus or discount is FLAGGED,
  // never blocked (owner rule, 2026-08-03) — it climbs the ordinary chain and any assigned
  // approver may finalize it. The accountability lives in the over_cap_finalized event and
  // the audit entry written below, not in a refusal.

  const evaluation = evaluateStepAction({ steps, actorOrder: activeStep.order, decision: input.decision });
  if (!evaluation.allowed) badRequest(evaluation.reason ?? "This action is not allowed right now.");

  // Backstop: nothing reaches `approved` against a pharmacy nobody confirmed.
  //
  // On a current chain the SFE rung has already confirmed the pharmacy long before the CEO sees
  // it, so this never fires. It still refuses for a chain that somehow carries no confirming rung
  // at all, because the last approval is the moment money enters Source of Sales against a
  // distributor code nobody checked. Confirming the pharmacy in the registry clears it.
  if (input.decision === "approve" && evaluation.isFinal) {
    const pharmacyForGate = (await loadPharmaciesByIds([request.pharmacyId])).get(request.pharmacyId) ?? null;
    if (pharmacyForGate?.verificationStatus === "pending_review") {
      badRequest(
        `${pharmacyForGate.pharmacyName} (${pharmacyForGate.phoenixPharmacyCode}) is a new pharmacy that Phoenix ` +
          "has not confirmed yet, so this order cannot be finalized. The SFE Manager has to check it first. " +
          "Every approval already given on this request stands.",
      );
    }
  }

  const action = directOrderDecisionAction({ decision: input.decision, isFinal: evaluation.isFinal });
  // The row's REAL status (audit F6). decideDirectOrder checks the status itself further up, so a
  // literal here made the registry gate a copy of that check rather than an independent one — if
  // the service's own guard were ever removed, this would not have caught it.
  await assertDirectOrderWorkflowTransition({
    access,
    actionKey: action.actionKey,
    expectedNextStatus: action.expectedNextStatus,
    status: request.status,
  });

  const now = new Date();
  const stepNextStatus = input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : null;
  // The sales month is NO LONGER derived from the approval date (owner rule, 2026-08-03).
  // Finance chooses it per order — see setDirectOrderSalesMonth — because the month an order is
  // signed off in is frequently not the month it should be booked into. Passing null leaves the
  // stored month untouched, so approving never overwrites a month Finance already picked.
  const salesMonth = null;

  const { data: updated, error: rpcError } = await supabase.rpc("phx_apply_direct_order_decision", {
    p_request_id: request.id,
    p_step_order: activeStep.order,
    p_expected_status: "pending_approval",
    p_next_status: evaluation.nextStatus,
    p_step_next_status: stepNextStatus,
    p_decided_by_hr_id: hrIdForStorage(access.hrId),
    p_decision_comment: comment,
    p_now: now.toISOString(),
    p_sales_month: salesMonth,
  });
  if (rpcError) throw rpcError;
  const result = mapRequestRow((Array.isArray(updated) ? updated[0] : updated) as Record<string, unknown>);
  // The finance landing counts awaiting and approved orders; this decision just moved one.
  invalidateFinanceDashboardCache("direct order decided");
  refreshSharedTradeCounterparties("direct order decided");

  const caps = await loadDirectOrderCaps();
  const overCap = isRequestOverCap(request, caps);

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: request.id,
    oldValues: { status: request.status },
    newValues: { status: result.status, decision: input.decision, step: activeStep.order, overCap },
    summary: `Direct order ${input.decision} by ${access.hrId} → ${result.status}.`,
  });
  await insertEvent({
    requestId: request.id,
    actorHrId: access.hrId,
    eventType: input.decision,
    message: comment ?? `${input.decision} at step ${activeStep.order}.`,
  });

  // Approving the confirming rung IS the acknowledgment — there is no second button to press.
  //
  // Keeping them separate is what made the original design fail: the approver could approve the
  // request and still leave the pharmacy unverified, so the CEO hit the block anyway and nobody
  // could tell which of the two actions was outstanding. One rung, one decision, one state change.
  //
  // That rung is SFE on every current chain, and a legacy Super Admin rung on requests chained
  // before it was retired — `isPharmacyConfirmingStep` covers both, so an in-flight old request
  // still clears its pharmacy instead of stranding it.
  //
  // Only on approve: rejecting or returning must leave the pharmacy unconfirmed, because the
  // reason for the rejection may well BE that the pharmacy is wrong.
  // POST-COMMIT SIDE EFFECT — must never fail the decision that already committed.
  //
  // The decision itself is applied by the RPC above and is durable by the time we get here. If
  // confirming the pharmacy (or reviving its held orders) throws, the approver would receive an
  // error for an approval that actually succeeded, and would reasonably click again. So failures
  // are recorded — event + log — and the caller still gets its result. The Held Desk keeps
  // showing anything that stayed held, so nothing is lost silently.
  // Read BEFORE the confirmation below changes it: whether this approval confirmed a NEW pharmacy on the
  // order's invoice is a fact about the pharmacy as the SFE Manager found it (owner, 2026-09-14). Only
  // read when the order carries an invoice at all; a failed read just counts no slot.
  const pharmacyBeforeApproval =
    input.decision === "approve" && request.invoiceStoragePath && isPharmacyConfirmingStep(activeStep)
      ? await loadPharmaciesByIds([request.pharmacyId])
          .then((byId) => byId.get(request.pharmacyId) ?? null)
          .catch(() => null)
      : null;
  if (input.decision === "approve" && isPharmacyConfirmingStep(activeStep)) {
    try {
      await markDirectOrderPharmacyVerified(access, { pharmacyId: request.pharmacyId });
      // Owner, 2026-09-14: that approval counts as the pharmacy's invoice validation — 1 of the rep's 5.
      // Swallows its own failures; the approval stands whatever happens here.
      if (pharmacyBeforeApproval) {
        await recordDirectOrderInvoiceValidationAtSfeRung(access, { request, pharmacyBeforeApproval });
      }
    } catch (confirmError) {
      logError("Pharmacy confirmation after an approved decision failed; the approval stands", {
        labels: { event: "direct_order_pharmacy_confirm_failed", requestId: request.id },
        error: confirmError,
      });
      await insertEvent({
        requestId: request.id,
        actorHrId: access.hrId,
        eventType: "pharmacy_confirm_failed",
        message:
          "The approval was recorded, but confirming the pharmacy failed. Its held orders stay on the Held Desk until a System Admin confirms it.",
      });
    }
  }

  // An over-cap order that reaches final approval is recorded explicitly. This is what
  // replaced the old CEO-only gate: the answer to "who let this through" is an event, not
  // a refusal — and it is the first time that has been recorded at all.
  if (input.decision === "approve" && evaluation.isFinal && overCap) {
    await insertEvent({
      requestId: request.id,
      actorHrId: access.hrId,
      eventType: "over_cap_finalized",
      message: `Finalized while over cap by ${access.role}.`,
      metadata: {
        actorRole: access.role,
        isSuperAdmin,
        dealType: request.dealType,
        qty: request.qty,
        bonus: request.bonus,
        discountPct: request.discountPct,
        salesValue: request.salesValue,
        overrideReason: request.bonusOverrideReason,
      },
    });
  }

  // Reject/return are bad news the requester must act on, so they (and the usual CC set) are
  // told exactly as before. An approve notifies only whoever is next in the chain — or nobody
  // through this path when it was the final step, since nothing is left to act on and the
  // separate Finance/CEO notice (dispatchDirectOrderApprovedEmail, below) covers that case.
  // The notice goes out AFTER the reply (afterResponse): on production a decision took 7.8 s at the
  // median and 22 s at the 95th percentile, of which the decision itself was 0.8 s — the rest was this
  // notice's reads and its fan-out to every recipient, awaited before the answer left. The order is
  // already saved; a failed notice is logged and never changes the answer.
  await afterResponse("direct_order_notice:decision", async () => {
    const recipients: Array<string | null | undefined> =
      input.decision === "approve" ? [] : [request.requesterHrId, ...(await ccRecipients())];
    let nextLabel: string | null = null;
    if (result.status === "pending_approval") {
      const nextSteps = await loadSteps(request.id);
      const next = resolveActiveStep(nextSteps);
      if (next) {
        const nextApprovers = next.kind === "role" && next.role ? await hrIdsForRole(next.role) : [next.approverHrId];
        recipients.push(...nextApprovers);
        nextLabel = next.label;
      }
    }

    const nameOf = await nameLookup();
    const pharmacyForNotice = (await loadPharmaciesByIds([request.pharmacyId])).get(request.pharmacyId) ?? null;
    const decisionContext = await buildNotifyContext(
      request,
      nameOf(request.requesterHrId) ?? request.requesterHrId,
      pharmacyForNotice,
    );
    // Third person, deliberately: who this reaches varies by decision (reject/return: requester +
    // CC; a continuing approve: only the next approver) — "Your direct order …" would be wrong for
    // whichever of those audiences it was not written for.
    const actorName = nameOf(access.hrId) ?? access.hrId ?? access.role;
    const decisionSentence =
      `${decisionContext.requesterName}'s direct order for ` +
      `${codeNameLabel(decisionContext.pharmacyName, decisionContext.pharmacyCode)} — ` +
      `${request.productName} × ${request.qty} — was ${input.decision}d by ${actorName}` +
      `${comment ? `: ${comment}` : "."}` +
      `${nextLabel ? ` Now awaiting ${nextLabel}.` : ""}`;
    await notifyDirectOrder({
      recipients,
      title: `Direct order ${result.status.replace("_", " ")}`,
      message: decisionSentence,
      metrics: buildDirectOrderNotificationMetrics(decisionContext),
      eventType: input.decision,
      requestId: request.id,
      subjectHrId: request.requesterHrId,
    });
  });

  // On FINAL approval of a normal order, the polished "approved" email (To Ahmed, CC
  // CEO + system admin) is dispatched by the decision route via Next.js after() — AFTER
  // the response is sent — so a synchronous email send never adds latency to, or blocks,
  // the approver's action. See dispatchDirectOrderApprovedEmail below.

  // Phase C: SoS injection runs ATOMICALLY inside phx_apply_direct_order_decision on
  // final approval (rebuild-from-truth via phx_rebuild_direct_order_sos_batch), so a
  // failed injection rolls the decision back rather than leaving it un-injected. A
  // reversal's final approval likewise retires its original in the same transaction.
  // This is the money-critical path: it feeds au.f_monthly_attribution Branch B1 and
  // credits the pharmacy-area rep in au.f_monthly_achievement.

  // The decision has already committed by here, so the ping cannot affect it. Deliberately after
  // the injection comment above: a sheet refresh must never sit between the decision and the money.
  pingDirectOrderSheet("order_decided");
  return result;
}

// ── Approval-chain backfill (re-seed an untouched chain onto today's ladder) ──

/**
 * Rebuild a pending request's approval chain using the CURRENT ladder.
 *
 * Approval steps are written once, at submission, and never rebuilt — so an order submitted
 * before a ladder change keeps the old chain forever. When SFE Manager validation was added as
 * the opening rung (2026-08-03), every in-flight order still routed straight past it. This
 * re-seeds those chains so they run the normal workflow.
 *
 * REFUSES when any step has already been DECIDED. Deleting a decided step would erase a real
 * person's approval or rejection — an audit record, not scaffolding. Only a chain where nobody
 * has acted yet can be safely replaced, and that check is the whole safety of this function.
 *
 * The rebuild uses buildApprovalChain, the same function submit uses, so a backfilled chain is
 * identical to one the requester would get by resubmitting today — no second definition of the
 * ladder to drift.
 */
export async function rebuildDirectOrderApprovalChain(
  access: AccessContext,
  input: { requestId: string },
): Promise<{ requestId: string; previousLabels: string[]; nextLabels: string[] }> {
  if (!(access.scope === "system" || access.role === "Super Admin")) {
    throw new Error("Forbidden: only a System Admin can rebuild an approval chain.");
  }
  const supabase = getSupabaseAdmin();

  const { data: current, error: loadError } = await supabase
    .from("direct_order_requests")
    .select("*")
    .eq("id", input.requestId)
    .maybeSingle();
  if (loadError) throw loadError;
  if (!current) badRequest("Direct order request not found.");
  const request = mapRequestRow(current as Record<string, unknown>);
  if (request.status !== "pending_approval") {
    badRequest(`Only a pending request can have its chain rebuilt; this one is ${request.status}.`);
  }

  const { data: stepRows, error: stepsError } = await supabase
    .from("direct_order_approval_steps")
    .select("*")
    .eq("request_id", request.id)
    .order("step_order", { ascending: true });
  if (stepsError) throw stepsError;
  const existing = (stepRows ?? []) as Array<Record<string, unknown>>;

  // The safety gate. A decided step is somebody's recorded decision.
  const decided = existing.filter(
    (row) => String(row.status ?? "pending") !== "pending" || row.decided_by_hr_id || row.decided_at,
  );
  if (decided.length > 0) {
    badRequest(
      `This chain already has ${decided.length} decided step(s); rebuilding would erase a real approval. ` +
        "Return the request to the requester and have them resubmit instead.",
    );
  }

  const previousLabels = existing.map((row) => String(row.label ?? ""));
  const chain = await buildApprovalChain({
    requesterHrId: request.requesterHrId,
    requesterRole: request.requesterRole,
  });
  const nextLabels = chain.map((step) => step.label);

  const { error: deleteError } = await supabase
    .from("direct_order_approval_steps")
    .delete()
    .eq("request_id", request.id);
  if (deleteError) throw deleteError;

  const { error: insertError } = await supabase.from("direct_order_approval_steps").insert(
    chain.map((step) => ({
      request_id: request.id,
      step_order: step.order,
      approver_kind: step.kind,
      approver_role: step.role,
      approver_hr_id: step.approverHrId,
      label: step.label,
      status: "pending",
    })),
  );
  if (insertError) throw insertError;

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: request.id,
    oldValues: { steps: previousLabels },
    newValues: { steps: nextLabels },
    summary: `Direct order approval chain rebuilt by ${access.hrId ?? "unknown"}.`,
  });
  await insertEvent({
    requestId: request.id,
    actorHrId: access.hrId,
    eventType: "chain_rebuilt",
    message: `Approval chain rebuilt: ${previousLabels.join(" → ") || "(none)"} → ${nextLabels.join(" → ")}.`,
    metadata: { previousLabels, nextLabels },
  });

  // Tell the NEW first rung it is waiting on them — a rebuilt chain that nobody is told about
  // is a request that silently stalls.
  const [firstStep] = chain;
  if (firstStep) {
    const firstApprovers =
      firstStep.kind === "role" && firstStep.role ? await hrIdsForRole(firstStep.role) : [firstStep.approverHrId];
    const nameOf = await nameLookup();
    const pharmacy = (await loadPharmaciesByIds([request.pharmacyId])).get(request.pharmacyId) ?? null;
    const ctx = await buildNotifyContext(request, nameOf(request.requesterHrId) ?? request.requesterHrId, pharmacy);
    await notifyDirectOrder({
      recipients: [...firstApprovers, ...(await ccRecipients())],
      title: "Direct order awaiting your approval",
      message: buildDirectOrderNotificationLine(ctx),
      metrics: buildDirectOrderNotificationMetrics(ctx),
      eventType: "submitted",
      requestId: request.id,
      subjectHrId: request.requesterHrId,
    });
  }

  return { requestId: request.id, previousLabels, nextLabels };
}

// ── Reversal (create a reversing request that re-enters approval) ─────────────

export async function reverseDirectOrder(
  access: AccessContext,
  input: { requestId: string; reason: string },
): Promise<DirectOrderRequest> {
  await assertPermission(access, "direct_orders", "create");
  const actorHrId = requireActorHrId(access);
  const reason = input.reason?.trim();
  if (!reason) badRequest("A reason is required to reverse a direct order.");

  const supabase = getSupabaseAdmin();
  // Read through getDirectOrderRequest, NOT a raw admin query. This used to select the row
  // directly, which walked straight past canViewDirectOrderRequest — the scope guard that lives at
  // that choke point precisely so "every current and future caller inherits it". The effect was
  // that any holder of direct_orders:create could reverse ANY approved order in the company given
  // its id: no requester check, no chain membership, no area. It returns null for out-of-scope as
  // well as missing, so an id cannot be used to probe which requests exist.
  const found = await getDirectOrderRequest(access, input.requestId);
  if (!found) badRequest("Direct order request not found.");
  const original = found.request;
  if (original.status !== "approved") badRequest("Only an approved direct order can be reversed.");
  if (original.reversedByRequestId) badRequest("This direct order already has a reversal in progress.");

  // Reverse was the one declared registry action with no gate, so its role list was whatever
  // `direct_orders:create` happens to grant — which includes Medical Rep and Financial Advisor,
  // neither of whom the registry lists for this action. Reversing retires an order's Source-of-Sales
  // injection, so the two must agree.
  //
  // expectedNextStatus is "reversed" to match the registry, though the transition is two-phase in
  // practice: this call creates a reversing request that must itself be approved, and only that
  // final approval retires the original. The registry describes the outcome, not the initiation.
  await assertDirectOrderWorkflowTransition({
    access,
    actionKey: "reverse",
    expectedNextStatus: "reversed",
    status: original.status,
  });

  const chain = await buildApprovalChain({
    requesterHrId: actorHrId,
    requesterRole: access.role,
  });

  const { data: inserted, error: insertError } = await supabase
    .from("direct_order_requests")
    .insert({
      requester_hr_id: hrIdForStorage(access.hrId),
      requester_role: access.role,
      status: "pending_approval",
      line: original.line,
      product_code: original.productCode,
      product_name: original.productName,
      // The family this basket belongs to. Omitted here until 2026-09-03, and the column is
      // nullable, so a reversal was written with NO family at all — the one thing that says which
      // basket allow-list the row answers to (Lacto Advanced and Lacto Basic share `LA` precisely
      // so they combine). It never self-heals: a reversal is a header-only insert with no
      // direct_order_request_items row, so the trigger that back-fills a request's family from its
      // first line never fires for one. Worse than blank — phx_direct_order_item_family_guard
      // reads a null request family as "adopt the first line's", so the reversal would take
      // whatever family a later line brought instead of refusing a mismatched one.
      //
      // `|| null` because mapRequestRow reads the null a historic request carries as "", and an
      // empty string is not the same value to the guard: null means "adopt", "" is a REAL family
      // that matches nothing, so `'' <> 'LA'` raises and no line could ever be added. Mirroring
      // means an original with no family yields a reversal with no family.
      family_code: original.familyCode || null,
      // A reversal mirrors its original exactly, so it must carry the same pricing basis.
      // These three used to be omitted, and `deal_type` defaults to 'bonus' in the column
      // definition — so reversing a DISCOUNT order silently produced a 'bonus' row whose
      // sales_value had been computed from the public price. It mislabelled the deal in every
      // list, report and export. Copied explicitly so the row stays consistent with its value.
      deal_type: original.dealType,
      discount_pct: original.discountPct,
      public_price_snapshot: original.publicPriceSnapshot,
      pharmacy_price_snapshot: original.pharmacyPriceSnapshot,
      qty: original.qty,
      bonus: original.bonus,
      bonus_override_reason: `Reversal of ${original.id}: ${reason}`,
      sales_value: original.salesValue,
      pharmacy_id: original.pharmacyId,
      collection_date: original.collectionDate,
      // Mirrored for exactly the reason the three pricing fields above are: a field the original
      // carries and the reversal drops makes the pair disagree, silently. This one is the link back
      // to the campaign that produced the order, so a reversal that loses it detaches the money
      // from the request it reverses — the original would still count against the campaign's ROI
      // while its reversal counted against nothing.
      marketing_request_id: original.marketingRequestId,
      reversal_of_request_id: original.id,
      created_by_login_id: access.loginId ?? null,
      submitted_at: new Date().toISOString(),
    })
    .select("*")
    .single();
  if (insertError) throw insertError;
  const reversal = mapRequestRow(inserted as Record<string, unknown>);

  // Both of these used to discard their error, unlike every other write in this file. A failed
  // steps insert therefore returned `{ success: true }` on a reversal that has NO approval chain —
  // and a request with no pending step can never be approved, rejected or returned again
  // (decideDirectOrder refuses at "There is no pending approval step on this request"), so it
  // sticks forever and only a Super Admin rebuild can free it. Surfacing the error at least makes
  // the caller see the failure instead of being told it worked.
  const { error: linkError } = await supabase
    .from("direct_order_requests")
    .update({ reversed_by_request_id: reversal.id })
    .eq("id", original.id);
  if (linkError) throw linkError;
  const { error: reversalStepsError } = await supabase.from("direct_order_approval_steps").insert(
    chain.map((step) => ({
      request_id: reversal.id,
      step_order: step.order,
      approver_kind: step.kind,
      approver_role: step.role,
      approver_hr_id: step.approverHrId,
      label: step.label,
      status: "pending",
    })),
  );
  if (reversalStepsError) throw reversalStepsError;

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: reversal.id,
    newValues: { status: "pending_approval", reversalOf: original.id },
    summary: `Reversal of direct order ${original.id} submitted by ${access.hrId}.`,
  });
  await insertEvent({
    requestId: reversal.id,
    actorHrId: access.hrId,
    eventType: "reversal_submitted",
    message: `Reversal of ${original.id}: ${reason}`,
  });
  // SPREAD, never join: `.join(",")` collapsed every holder of the first rung's role into one
  // string, and canonicalHrIdKey happily returns "hr-001,hr-002" as a truthy key — so the
  // reversal's first approver was addressed as a single recipient who does not exist. It went
  // unnoticed because the opening rung is SFE Manager, who is also in the CC set below; the
  // moment the chain opens with anyone else, nobody would be told at all. Mirrors submit.
  // After the reply (afterResponse): the order is saved, and this notice's reads and fan-out used to be
  // awaited before the answer left — seconds on production. A failed notice is logged, never thrown.
  await afterResponse("direct_order_notice:reversal_submitted", async () => {
    const reversalFirstStep = chain[0];
    const reversalFirstApprovers =
      reversalFirstStep.kind === "role" && reversalFirstStep.role
        ? await hrIdsForRole(reversalFirstStep.role)
        : [reversalFirstStep.approverHrId];
    await notifyDirectOrder({
      recipients: [...reversalFirstApprovers, ...(await ccRecipients())],
      title: "Direct order reversal awaiting approval",
      message: `A reversal of a direct order (${original.productName} × ${original.qty}) needs approval.`,
      eventType: "reversal_submitted",
      requestId: reversal.id,
      subjectHrId: actorHrId,
    });
  });

  pingDirectOrderSheet("order_reversed");
  return reversal;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/**
 * May this viewer READ this single request?
 *
 * `direct_orders:read` alone is NOT sufficient: it is held by every requester role, so on its own it
 * would let any District/Regional/Product Manager fetch ANY order company-wide by id — requester,
 * pharmacy, doctor, quantities, pharmacy/public price, bonus/discount and sales value included. This
 * mirrors the tiering the report already applies (resolveDirectOrderReportScope) and additionally
 * always admits an assigned approver, since someone who must decide a request has to be able to open
 * it even when the requester sits outside their own reporting subtree.
 */
async function canViewDirectOrderRequest(
  access: AccessContext,
  request: DirectOrderRequest,
  steps: DirectOrderStepState[],
): Promise<boolean> {
  if (resolveDirectOrderReportScope(access) === "all") return true;

  // An assigned approver may always open the request — whether their rung names them personally
  // or names their ROLE (SFE Manager validation, CEO final).
  const viewerKey = canonicalHrIdKey(access.hrId ?? "");
  if (viewerKey && steps.some((step) => canonicalHrIdKey(step.approverHrId ?? "") === viewerKey)) return true;
  if (steps.some((step) => step.kind === "role" && step.role && step.role === access.role)) return true;

  const requesterKey = canonicalHrIdKey(request.requesterHrId ?? "");
  if (!requesterKey || !viewerKey) return false;
  if (resolveDirectOrderReportScope(access) === "own") return requesterKey === viewerKey;
  if (resolveDirectOrderReportScope(access) === "line") {
    const viewerLine = ((await resolveDirectOrderRequesterLineName(access)) ?? "").trim().toLowerCase();
    return Boolean(viewerLine) && (request.line ?? "").trim().toLowerCase() === viewerLine;
  }
  return (await resolveVisibleRequesterHrIds(access)).has(requesterKey);
}

export async function getDirectOrderRequest(
  access: AccessContext,
  requestId: string,
): Promise<{ request: DirectOrderRequest; steps: DirectOrderStepState[] } | null> {
  await assertPermission(access, "direct_orders", "read");
  // An address that is not an order id at all (`/admin/direct-orders/validations]` — a stray bracket,
  // 20 Oct 2026) is the same answer as an unknown id: no such request. Sent to the database it was a
  // 22P02 invalid-uuid error and a crashed page (System Audit APP-518F5E21 / APP-39BE50BC).
  if (!isUuid(requestId)) return null;
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("direct_order_requests").select("*").eq("id", requestId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const request = mapRequestRow(data as Record<string, unknown>);
  const steps = await loadSteps(request.id);
  // Scope guard lives here, at the single read choke point, so every current and future caller
  // inherits it. Returns null (same as "no such request") rather than throwing, so an out-of-scope
  // id cannot be used to probe which request ids exist.
  if (!(await canViewDirectOrderRequest(access, request, steps))) return null;
  return { request, steps };
}

// ── Direct-order conversation (open at ANY status) ───────────────────────────
//
// Owner rule, 2026-09-22: the conversation must be available at any status, including rejected /
// cancelled / expired, so a requester can ask why an order was turned down and an approver can
// answer — and everyone on the order is emailed, cc'd, and pinged in-app / Telegram / push for
// every message. Authorisation is `getDirectOrderRequest`, the same scope choke point every approval
// surface already reads; there is deliberately NO status gate. The storage and the addressing are
// the two shared helpers every conversation type in the system uses.

async function loadDirectOrderForConversation(
  access: AccessContext,
  orderId: string,
): Promise<{ request: DirectOrderRequest; steps: DirectOrderStepState[] }> {
  const cleanId = String(orderId ?? "").trim();
  if (!cleanId) throw validationError("Direct order ID is required.");
  const loaded = await getDirectOrderRequest(access, cleanId);
  // null is "absent OR out of scope", kept indistinguishable so an id cannot be probed — a 403
  // either way, which is what the leading "Forbidden:" makes the route return.
  if (!loaded) throw new Error("Forbidden: you cannot view this direct order.");
  return loaded;
}

/** Every message on a direct order's conversation, oldest first. */
export async function listDirectOrderConversation(
  access: AccessContext,
  orderId: string,
): Promise<{ comments: RecordConversationComment[]; schemaReady: boolean }> {
  const { request } = await loadDirectOrderForConversation(access, orderId);
  return listRecordConversation("direct_orders", request.id);
}

/** Post one message to a direct order's conversation, then fan it out to everyone on the order. */
export async function postDirectOrderConversationComment(
  access: AccessContext,
  orderId: string,
  body: string,
): Promise<RecordConversationComment> {
  const { request, steps } = await loadDirectOrderForConversation(access, orderId);
  if (!normalizeHrId(access.hrId)) throw new Error("Forbidden: no HR_ID on this session.");

  const authorName = directoryLookup(await getEmployeeDirectory())(access.hrId)?.displayName ?? null;
  const comment = await insertRecordConversationComment({
    authorHrId: access.hrId ?? null,
    authorName,
    authorRole: access.role ?? null,
    body,
    module: "direct_orders",
    recordId: request.id,
  });

  // The message is stored; fanning it out to the thread happens after the reply (afterResponse).
  await afterResponse("direct_order_notice:conversation", () => notifyDirectOrderConversation({ comment, request, steps }));
  return comment;
}

/**
 * Fan a direct-order conversation message out To the requester and CC everyone on the order.
 *
 * Participants: the requester (the thread's owner), every person rung in the chain (the requester's
 * managers), everyone who has actually decided a rung — which is how a role rung such as the CEO
 * joins once it has acted, rather than being pinged on every message before it — and everyone who
 * has already posted in this thread. Best-effort: the message is stored and a delivery failure must
 * not undo it.
 */
async function notifyDirectOrderConversation(input: {
  comment: RecordConversationComment;
  request: DirectOrderRequest;
  steps: DirectOrderStepState[];
}): Promise<void> {
  try {
    const { comment, request, steps } = input;
    const priorAuthors = await listRecordConversationAuthors("direct_orders", request.id);
    const pharmacy = (await loadPharmaciesByIds([request.pharmacyId])).get(request.pharmacyId) ?? null;
    const participantHrIds = [
      request.requesterHrId,
      ...steps.map((step) => step.approverHrId),
      ...steps.map((step) => step.decidedByHrId ?? null),
      ...priorAuthors,
    ];

    await notifyConversationMessage({
      // The live order route; the notification pipeline remaps it to each reader's own shell.
      actionUrl: `/admin/direct-orders/${encodeURIComponent(request.id)}`,
      authorHrId: comment.authorHrId,
      authorName: comment.authorName,
      body: comment.body,
      eventType: "direct_order_comment",
      messageKey: comment.id,
      metadata: { directOrderId: request.id },
      module: "direct_orders",
      participantHrIds,
      recordId: request.id,
      submitterHrId: request.requesterHrId,
      subjectLabel: pharmacy?.pharmacyName?.trim() || request.productName || request.id,
      threadLabel: "direct order",
    });
  } catch (error) {
    logError("Direct order conversation failed to notify the thread", {
      labels: { event: "direct_order_conversation_notify_failed", directOrderId: input.request.id },
      error,
    });
  }
}

// ── Approvals-hub reads (this hub surface is the SOLE approval gate) ──────────

/** Can the viewer act on `step` right now? Super Admin/system can act on any step. */
/**
 * Whether the viewer may act on this rung.
 *
 * A ROLE rung is matched by role, a PERSON rung by HR_ID. This is written against `kind`
 * rather than against the CEO specifically: the chain now opens with an SFE Manager role rung
 * too, and a CEO-only special case would have left that rung actionable by nobody.
 */
function viewerCanActOnStep(access: AccessContext, step: DirectOrderStepState | null): boolean {
  if (!step) return false;
  if (access.role === "Super Admin" || access.scope === "system") return true;
  return step.kind === "role"
    ? Boolean(step.role) && access.role === step.role
    : canonicalHrIdKey(access.hrId) === canonicalHrIdKey(step.approverHrId ?? "");
}

async function loadStepsForRequests(requestIds: string[]): Promise<Map<string, DirectOrderStepState[]>> {
  const map = new Map<string, DirectOrderStepState[]>();
  const ids = Array.from(new Set(requestIds));
  if (ids.length === 0) return map;
  const supabase = getSupabaseAdmin();
  // PostgREST folds every .in() value into the request URL; batch since `ids` can be every
  // pending/company-wide request with no fixed cap.
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const { data, error } = await supabase
      .from("direct_order_approval_steps")
      .select("*")
      .in("request_id", batch)
      .order("step_order", { ascending: true });
    if (error) throw error;
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const requestId = String(row.request_id);
      const list = map.get(requestId) ?? [];
      list.push(mapStepRow(row));
      map.set(requestId, list);
    }
  }
  return map;
}

async function loadPharmaciesByIds(pharmacyIds: string[]): Promise<Map<string, DirectOrderPharmacy>> {
  const map = new Map<string, DirectOrderPharmacy>();
  const ids = Array.from(new Set(pharmacyIds.filter(Boolean)));
  if (ids.length === 0) return map;
  const supabase = getSupabaseAdmin();
  const data: Array<Record<string, unknown>> = [];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const { data: rows, error } = await supabase.from("direct_order_pharmacies").select("*").in("id", batch);
    if (error) throw error;
    data.push(...((rows ?? []) as Array<Record<string, unknown>>));
  }
  const pharmacies = data.map(mapPharmacyRow);
  await attachDistributorCodes(pharmacies);
  for (const pharmacy of pharmacies) map.set(pharmacy.id, pharmacy);
  return map;
}

function nameLookup(): Promise<(hrId: string | null | undefined) => string | null> {
  return getEmployeeDirectory().then((directory) => {
    const byHr = new Map<string, string>();
    for (const employee of directory.employees) {
      const key = canonicalHrIdKey(employee.hrId);
      if (key) byHr.set(key, employee.displayName || employee.fullName);
    }
    return (hrId: string | null | undefined) => {
      const key = canonicalHrIdKey(hrId ?? "");
      return key ? byHr.get(key) ?? null : null;
    };
  });
}

/**
 * (`missingPharmacyPrice` used to be computed here; a bonus deal with no pharmacy price is now
 * refused at submit, so the flag could never be true and was removed.)
 * (`bonusOverCap` is passed in, because it
 * needs the caps config): it is a pure function of the request row, so the call sites stay
 * untouched instead of growing a sixth positional boolean.
 */
function toApprovalListItem(
  request: DirectOrderRequest,
  active: DirectOrderStepState | null,
  requesterName: string | null,
  pharmacy: DirectOrderPharmacy | null,
  bonusOverCap: boolean,
  geo: DirectOrderPharmacyGeo,
  rep: AreaRepAssignment | null,
  items?: readonly DirectOrderRequestItem[],
): DirectOrderApprovalListItem {
  const medicalRep = toDirectOrderAreaRep(rep);
  // A basket's `salesValue` covers every line, so naming only line 1 puts one product's name beside
  // two products' money — reported by the owner 2026-08-13 against an approved LA001+LA002 order
  // that read "Lacto Advanced 1 × 72" beside 25,344 EGP. Callers that do not load items still get
  // exactly the old single-product output.
  const basket = summarizeDirectOrderBasket(request, items);
  return {
    id: request.id,
    requesterHrId: request.requesterHrId,
    requesterName: requesterName ?? request.requesterHrId,
    requesterRole: request.requesterRole,
    line: request.line,
    productName: basket.productName,
    qty: basket.qty,
    items: basket.lines,
    bonus: request.bonus,
    dealType: request.dealType,
    discountPct: request.discountPct,
    salesValue: request.salesValue,
    // Carried straight off the mapped request — both queries feeding this use select("*"), so the
    // column is already in hand and this costs nothing. Without it, every surface showing an
    // approval list item can only say "Approved" (spec C2).
    salesMonth: request.salesMonth,
    pharmacyName: pharmacy?.pharmacyName ?? "—",
    pharmacyCode: pharmacy?.phoenixPharmacyCode ?? "—",
    // Names, never codes — but fall back to the code rather than showing nothing when the
    // master data has no name for it.
    brickName: geo.brick?.name || geo.brick?.code || "",
    areaName: geo.area?.name || geo.area?.code || "",
    regionName: geo.region?.name || geo.region?.code || "",
    medicalRepName: medicalRep.repName ?? "",
    medicalRepVacant: medicalRep.resolved && medicalRep.isVacant,
    distributorNames: formatDistributorNames(pharmacy?.distributorCodes),
    status: request.status,
    createdAt: request.createdAt,
    decidedAt: request.decidedAt,
    // A returned order's open rung stays `pending` so a resubmission resumes there, but the order is
    // waiting on its requester, not on that approver (owner, 2026-09-14).
    activeStepLabel:
      request.status === "returned"
        ? describeReturnedDirectOrderWait(requesterName ?? request.requesterHrId)
        : active?.label ?? "",
    activeStepOrder: active?.order ?? null,
    bonusOverCap,
  };
}

/**
 * Geography names + area reps for a batch of requests, loaded ONCE per list page.
 *
 * Both underlying loads are TTL-cached in-process, which keeps this affordable on every
 * workspace render. It is no longer on the nav-badge path: the badge moved to
 * `countDirectOrderAwaitingFast` on 2026-08-11 precisely because resolving geography names and
 * walking the seat model to produce one integer, every 30 seconds, was never worth it.
 */
async function loadListDecorations(
  requests: DirectOrderRequest[],
  pharmacies: Map<string, DirectOrderPharmacy>,
  nameOf: (hrId: string | null | undefined) => string | null,
) {
  const pairs = requests.map((request) => ({
    line: request.line,
    areaCode: pharmacies.get(request.pharmacyId)?.areaCode ?? null,
  }));
  const [geoMaps, reps] = await Promise.all([
    loadDirectOrderGeoNames(),
    resolveAreaRepsForLineAreas(pairs, { nameOf }),
  ]);
  return {
    geoFor: (request: DirectOrderRequest) =>
      resolveDirectOrderGeo(pharmacies.get(request.pharmacyId) ?? null, geoMaps),
    repFor: (request: DirectOrderRequest) =>
      reps.get(areaRepKey(request.line, pharmacies.get(request.pharmacyId)?.areaCode ?? null)) ?? null,
  };
}

export async function getDirectOrderWorkspaceData(
  access: AccessContext,
  options: {
    /**
     * Build `awaiting` alone: `history` and `held` come back empty and are never read. The workspace
     * page draws only `awaiting` (its Needs Action inbox), so it was reading every held and expired
     * order and the viewer's whole decision history only to throw them away (2026-10-31, "fix the
     * slowest five pages").
     */
    awaitingOnly?: boolean;
  } = {},
): Promise<DirectOrderWorkspaceData> {
  await assertPermission(access, "direct_orders", "read");
  const supabase = getSupabaseAdmin();
  const awaitingOnly = options.awaitingOnly === true;

  // The three lists are read TOGETHER (2026-10-31): none needs another's rows, and awaiting them in
  // turn made the page sit through five round trips before the decorations could start.
  const pendingRead = (async () => {
    const { data: pendingRows, error: pendingError } = await supabase
      .from("direct_order_requests")
      .select("*")
      .eq("status", "pending_approval")
      .order("created_at", { ascending: true });
    if (pendingError) throw pendingError;
    return ((pendingRows ?? []) as Array<Record<string, unknown>>).map(mapRequestRow);
  })();

  const historyRead = awaitingOnly
    ? Promise.resolve([] as DirectOrderRequest[])
    : (async () => {
        const { data: myStepRows } = await supabase
          .from("direct_order_approval_steps")
          .select("request_id")
          // Both casings on purpose. decided_by_hr_id holds whatever access.hrId was at decision time:
          // the LOWERCASE comparison key for most rows, but the canonical uppercase form for others (10 of
          // 223 rows in production on 2026-09-02, all one approver's). A bare .eq on the session key
          // therefore returned NOTHING for that person rather than something wrong, and an empty decision
          // history reads as "you have never approved anything" instead of as a bug.
          .in("decided_by_hr_id", hrIdLookupKeys(access.hrId));
        const historyIds = Array.from(new Set(((myStepRows ?? []) as Array<{ request_id: string }>).map((r) => r.request_id)));
        const { data: historyRows } = historyIds.length
          ? await supabase.from("direct_order_requests").select("*").in("id", historyIds).order("decided_at", { ascending: false })
          : { data: [] as Array<Record<string, unknown>> };
        return ((historyRows ?? []) as Array<Record<string, unknown>>).map(mapRequestRow);
      })();

  // Held/expired requests within the VIEWER'S OWN scope (owner rule, 2026-08-08 — see the
  // DirectOrderWorkspaceData.held doc comment). Same tiering as the report/rep-counters, reused
  // rather than re-derived: `resolveDirectOrderReportScope`/`resolveVisibleRequesterHrIds` are the
  // one definition of "which requesters can this viewer see" this module already has. This is READ
  // visibility only — the Held Desk's own management actions stay Super-Admin-only, untouched.
  const heldRead = awaitingOnly
    ? Promise.resolve([] as DirectOrderRequest[])
    : (async () => {
        const { data: heldRows } = await supabase
          .from("direct_order_requests")
          .select("*")
          .in("status", ["held", "expired"])
          .order("held_at", { ascending: true });
        let heldRequests = ((heldRows ?? []) as Array<Record<string, unknown>>).map(mapRequestRow);
        const heldScope = resolveDirectOrderReportScope(access);
        if (heldScope === "own") {
          const viewer = canonicalHrIdKey(access.hrId ?? "");
          heldRequests = heldRequests.filter((request) => canonicalHrIdKey(request.requesterHrId) === viewer);
        } else if (heldScope === "line") {
          const viewerLine = ((await resolveDirectOrderRequesterLineName(access)) ?? "").trim().toLowerCase();
          heldRequests = viewerLine
            ? heldRequests.filter((request) => (request.line ?? "").trim().toLowerCase() === viewerLine)
            : [];
        } else if (heldScope === "hierarchy") {
          const visible = await resolveVisibleRequesterHrIds(access);
          heldRequests = heldRequests.filter((request) => visible.has(canonicalHrIdKey(request.requesterHrId) ?? ""));
        }
        return heldRequests;
      })();

  const [pending, historyRequests, heldRequests] = await Promise.all([pendingRead, historyRead, heldRead]);

  const allRequests = [...pending, ...historyRequests, ...heldRequests];
  // Five independent reads — none consumes another's result — batched together instead of run
  // one after another. `decorations` is the one genuine dependency (needs `pharmacies` + `nameOf`),
  // so it waits for those alone rather than for all five.
  const [stepsByReq, pharmacies, nameOf, caps, itemsByRequest] = await Promise.all([
    loadStepsForRequests(allRequests.map((r) => r.id)),
    loadPharmaciesByIds(allRequests.map((r) => r.pharmacyId)),
    nameLookup(),
    loadDirectOrderCaps(),
    // One batched read for all three lists, alongside the four others. Without it every basket on
    // this screen names line 1 only against the whole basket's value.
    loadDirectOrderItemsForRequests(allRequests.map((r) => r.id)),
  ]);
  const decorations = await loadListDecorations(allRequests, pharmacies, nameOf);

  const awaiting: DirectOrderApprovalListItem[] = [];
  for (const request of pending) {
    const active = resolveActiveStep(stepsByReq.get(request.id) ?? []);
    if (!viewerCanActOnStep(access, active)) continue;
    awaiting.push(
      toApprovalListItem(
        request,
        active,
        nameOf(request.requesterHrId),
        pharmacies.get(request.pharmacyId) ?? null,
        isRequestOverCap(request, caps),
        decorations.geoFor(request),
        decorations.repFor(request),
        itemsByRequest.get(request.id),
      ),
    );
  }
  const history: DirectOrderApprovalListItem[] = historyRequests.map((request) =>
    toApprovalListItem(
      request,
      resolveActiveStep(stepsByReq.get(request.id) ?? []),
      nameOf(request.requesterHrId),
      pharmacies.get(request.pharmacyId) ?? null,
      isRequestOverCap(request, caps),
      decorations.geoFor(request),
      decorations.repFor(request),
      itemsByRequest.get(request.id),
    ),
  );
  // A held/expired request has no chain yet (it enters at step 1 only after its pharmacy passes
  // validation), so its active step is always null here — never resolveActiveStep, which would
  // read an empty steps array and return the same null anyway, less directly.
  const held: DirectOrderApprovalListItem[] = heldRequests.map((request) =>
    toApprovalListItem(
      request,
      null,
      nameOf(request.requesterHrId),
      pharmacies.get(request.pharmacyId) ?? null,
      isRequestOverCap(request, caps),
      decorations.geoFor(request),
      decorations.repFor(request),
      itemsByRequest.get(request.id),
    ),
  );
  return { awaiting, history, held };
}

/**
 * How many pending requests this viewer can decide right now — WITHOUT building the workspace.
 *
 * WHY THIS EXISTS. `countDirectOrderAwaiting` (deleted with this change) answered the same
 * question by calling
 * `getDirectOrderWorkspaceData` and reading `.length`. That function is the right shape for a page
 * and the wrong shape for a badge: to produce one integer it also runs a `select("*")` over every
 * held/expired row, a decision-history query, a pharmacy load, a caps load, an employee-directory
 * name lookup, and `loadListDecorations` — which resolves geography names AND walks the live seat
 * model for the covering rep of every (line, area) pair.
 *
 * None of that changes the number. All of it ran every 30 seconds, for every user with a sidebar
 * open, because NavBadge polls — and after the 2026-08-10 consolidation the single Direct Orders
 * row's badge sums this count, so the poll reaches more people than before, not fewer.
 *
 * This path reads two tables and only the columns the decision actually needs:
 * `viewerCanActOnStep` looks at a step's kind, role and approver; `resolveActiveStep` looks at its
 * order and status. Nothing else is loaded.
 *
 * THE ELIGIBILITY RULE IS NOT REIMPLEMENTED. It still goes through `resolveActiveStep` and
 * `viewerCanActOnStep`, the same two functions the workspace uses, so the badge and the screen
 * cannot drift apart — which is the failure this whole module keeps relearning (audit F5). A test
 * asserts the two agree on the same fixture.
 */
export async function countDirectOrderAwaitingFast(access: AccessContext): Promise<number> {
  await assertPermission(access, "direct_orders", "read");
  const supabase = getSupabaseAdmin();

  const { data: pendingRows, error: pendingError } = await supabase
    .from("direct_order_requests")
    .select("id")
    .eq("status", "pending_approval");
  if (pendingError) throw pendingError;

  const ids = ((pendingRows ?? []) as Array<{ id: string }>).map((row) => String(row.id));
  if (ids.length === 0) return 0;

  // Same 100-id batching as loadStepsForRequests, and for the same reason: PostgREST folds every
  // .in() value into the request URL and this list is company-wide with no fixed cap.
  const stepsByRequest = new Map<string, DirectOrderStepState[]>();
  for (let index = 0; index < ids.length; index += 100) {
    const batch = ids.slice(index, index + 100);
    const { data, error } = await supabase
      .from("direct_order_approval_steps")
      .select("request_id, step_order, approver_kind, approver_role, approver_hr_id, status")
      .in("request_id", batch)
      .order("step_order", { ascending: true });
    if (error) throw error;
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const requestId = String(row.request_id);
      const list = stepsByRequest.get(requestId) ?? [];
      // mapStepRow tolerates the missing label/decision columns (they default), and none of them
      // feed resolveActiveStep or viewerCanActOnStep.
      list.push(mapStepRow(row));
      stepsByRequest.set(requestId, list);
    }
  }

  let count = 0;
  for (const id of ids) {
    if (viewerCanActOnStep(access, resolveActiveStep(stepsByRequest.get(id) ?? []))) count += 1;
  }
  return count;
}

/** The caller's own direct order requests (any status), newest first — for the "My direct orders" list. */
export async function listMyDirectOrders(access: AccessContext): Promise<DirectOrderApprovalListItem[]> {
  await assertPermission(access, "direct_orders", "read");
  // .in(hrIdLookupKeys(...)) not .eq(access.hrId): access.hrId is lower-cased by
  // canonicalHrIdKey, but these columns hold whatever case the submitting session had. 36 of 50
  // request rows and 40 of 41 pharmacy rows are lower-case in production, the rest upper — the
  // SAME person appears both ways. An exact match therefore hides part of a rep's own history.
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("direct_order_requests")
    .select("*")
    .in("requester_hr_id", hrIdLookupKeys(access.hrId))
    .order("created_at", { ascending: false });
  if (error) throw error;
  const requests = ((data ?? []) as Array<Record<string, unknown>>).map(mapRequestRow);
  // Five independent reads, batched — see the identical pattern (and its rationale) in
  // getDirectOrderWorkspaceData above.
  const [stepsByReq, pharmacies, nameOf, caps, itemsByRequest] = await Promise.all([
    loadStepsForRequests(requests.map((r) => r.id)),
    loadPharmaciesByIds(requests.map((r) => r.pharmacyId)),
    nameLookup(),
    loadDirectOrderCaps(),
    loadDirectOrderItemsForRequests(requests.map((r) => r.id)),
  ]);
  const decorations = await loadListDecorations(requests, pharmacies, nameOf);
  return requests.map((request) =>
    toApprovalListItem(
      request,
      resolveActiveStep(stepsByReq.get(request.id) ?? []),
      nameOf(request.requesterHrId),
      pharmacies.get(request.pharmacyId) ?? null,
      isRequestOverCap(request, caps),
      decorations.geoFor(request),
      decorations.repFor(request),
      itemsByRequest.get(request.id),
    ),
  );
}

/** Roles with no single field line of their own — see every product, unrestricted
 *  (matches the direct_orders permission matrix: CEO/SFE Manager never submit their
 *  own field orders, and Super Admin submits on-behalf without a fixed line). */
const DIRECT_ORDER_LINE_UNRESTRICTED_ROLES = new Set<PhoenixRole>(["Super Admin", "SFE Manager", "CEO"]);

/**
 * The requester's own field line (org `lines.name`, e.g. "CNS"/"Pedia"/"Anti Infective"),
 * or null for an unrestricted role (no line filter — see every product). Fails CLOSED:
 * a restricted role with no resolvable line returns "" (matches nothing), never "see all".
 *
 * Two sources, tried in order:
 *   1. `employees.line_id` (via the directory) — the normal case, for every field role that sits
 *      inside the line-organized org structure (Medical Rep, District Manager, Regional Manager).
 *   2. `app_auth_users.line` — National Sales Manager / Product Manager / Group Product Manager sit
 *      ABOVE that structure, so `employees.line_id` is never set for them; their line lives only on
 *      the login record. Confirmed live 2026-08-09: all 6 active NSM/PM/GPM accounts had a null
 *      employee line and a correct `app_auth_users.line` (Pedia/CNS/Anti Infective). Without this
 *      fallback every one of them failed closed to "" — not "see all", "see nothing" — which meant
 *      an empty product dropdown (`listDirectOrderProductOptions`) and a blank pharmacy history
 *      panel (`resolveHistoryVisibility`) on every approval they opened. Neither read as a scope
 *      bug from the screen; both looked like "there is nothing here".
 */
async function resolveDirectOrderRequesterLineName(access: AccessContext): Promise<string | null> {
  if (DIRECT_ORDER_LINE_UNRESTRICTED_ROLES.has(access.role)) return null;
  const key = canonicalHrIdKey(access.hrId);
  if (!key) return "";
  const directory = await getEmployeeDirectory();
  const row = directory.employees.find((employee) => canonicalHrIdKey(employee.hrId) === key);
  const employeeLine = (row?.lineName ?? "").trim();
  if (employeeLine) return employeeLine;

  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("app_auth_users")
    .select("line")
    .ilike("hr_id", access.hrId ?? "")
    .maybeSingle();
  return String((data as { line?: string | null } | null)?.line ?? "").trim();
}

export type DirectOrderProductOption = {
  productCode: string;
  productName: string;
  /**
   * The catalogue's own family grouping — LA covers the Lacto concentrations, TE the Tebofortins.
   *
   * Carried so the submit form can offer the rest of a family without a second round trip, and so
   * the rule the server enforces and the choice the form offers come from the SAME field. Deriving
   * siblings from name prefixes in the component would be a second definition of a grouping the
   * master data already owns, and the two would disagree the first time a product was renamed.
   */
  familyCode: string;
  line: string;
  /** Prices discount deals. */
  publicPrice: number | null;
  /** Prices bonus deals. null = not set; a bonus submission is then refused. */
  pharmacyPrice: number | null;
};

/**
 * Field-line products for the submit form (code, name, line, public + pharmacy price).
 * The factory price is deliberately NOT selected: a direct order never uses it.
 * Scoped to the caller's own line when `access` is given — a CNS rep must never be
 * offered a Pedia/Anti Infective product. Omit `access` for an unscoped admin listing
 * (e.g. the price/caps editor, which manages every product regardless of line).
 */
export async function listDirectOrderProductOptions(
  access?: AccessContext,
): Promise<DirectOrderProductOption[]> {
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("source_of_sales_products")
    .select("product_code, product_name, family_code, line, public_price, pharmacy_price")
    .eq("active", true)
    .neq("line", "IGNORE");
  if (access) {
    const lineName = await resolveDirectOrderRequesterLineName(access);
    if (lineName !== null) query = query.ilike("line", lineName);
  }
  const { data } = await query;
  return ((data ?? []) as Array<Record<string, unknown>>)
    .map((p) => ({
      productCode: String(p.product_code),
      productName: String(p.product_name ?? ""),
      familyCode: String(p.family_code ?? ""),
      line: String(p.line ?? ""),
      publicPrice: p.public_price == null ? null : Number(p.public_price),
      pharmacyPrice: p.pharmacy_price == null ? null : Number(p.pharmacy_price),
    }))
    .sort((a, b) => a.productName.localeCompare(b.productName));
}

/**
 * Areas + bricks for the new-pharmacy form (picking a brick auto-derives its area + region).
 * Region-scoped to the requester when `access` is given — District/Regional Manager see only
 * their own region's areas+bricks (the same region-level granularity resolveSalesAccessScope
 * already applies everywhere else in Sales); National Sales Manager/Product Manager/Group
 * Product Manager are LINE-scoped (nationwide, no region restriction) since Direct Orders'
 * line restriction already gates the PRODUCT (resolveDirectOrderRequesterLineName), not the
 * pharmacy's geography. Omit `access` for an unscoped listing.
 */
export async function listDirectOrderAreaAndBrickOptions(access?: AccessContext): Promise<{
  areas: Array<{ areaCode: string; areaName: string; regionCode: string; regionName: string }>;
  bricks: Array<{
    brickId: string;
    brickName: string;
    areaCode: string;
    // Area and region NAMES ride along so the submit forms can label a picked brick with
    // names instead of codes — ref.bricks already carries them, they were simply dropped here.
    areaName: string;
    regionCode: string;
    regionName: string;
  }>;
}> {
  const ref = await loadSalesReferenceData({ includeCustomerBricks: false });

  let regionCodesInScope: Set<string> | null = null;
  // A District / Regional Manager's own areas come from the organogram seat map and can sit outside
  // their region label (see src/lib/sales/seat-area-scope.ts) — so when that seat resolved, bound the
  // picker by AREA. Region-based trimming would drop such an area from the requester's own options.
  let areaCodesInScopeOverride: Set<string> | null = null;
  // Hand-listed extra areas, Direct Orders ONLY (see extra-area-grants.ts). Empty for almost
  // everyone. Applied as a union in the filter below rather than folded into the scope sets
  // here, so the seat/region bound stays byte-for-byte what it was and this can only ever add.
  let extraAreaCodes = new Set<string>();
  if (access) {
    extraAreaCodes = extraDirectOrderAreaCodes(resolveEmployeeIdentityId(access) ?? access.hrId);
    const salesScope = await resolveSalesAccessScope(access);
    if (salesScope.allowedAreaCodes) {
      areaCodesInScopeOverride = salesScope.allowedAreaCodes;
    } else if (salesScope.allowedRegionNames) {
      regionCodesInScope =
        access.role === "Regional Manager"
          ? new Set(
              [...(await resolveRegionalManagerRegionCodes(access, salesScope, ref))].map((code) => code.toUpperCase()),
            )
          : new Set(
              (ref.regions ?? [])
                .filter((region) => salesScope.allowedRegionNames!.has(canonicalizeRegionName(region.regionName)))
                .map((region) => region.regionCode.toUpperCase()),
            );
    }
  }

  const regionNameByCode = new Map((ref.regions ?? []).map((region) => [region.regionCode, region.regionName]));
  const areas = (ref.areas ?? [])
    .filter((area) => {
      const areaCode = area.areaCode.toUpperCase();
      if (extraAreaCodes.has(areaCode)) return true;
      return areaCodesInScopeOverride
        ? areaCodesInScopeOverride.has(areaCode)
        : !regionCodesInScope || regionCodesInScope.has(area.regionCode.toUpperCase());
    })
    .map((area) => ({
      areaCode: area.areaCode,
      areaName: area.areaName,
      regionCode: area.regionCode,
      regionName: regionNameByCode.get(area.regionCode) ?? "",
    }))
    .sort((a, b) => a.areaName.localeCompare(b.areaName));
  const areaCodesInScope = new Set(areas.map((area) => area.areaCode.toUpperCase()));

  const bricks = (ref.bricks ?? [])
    .filter((brick) => areaCodesInScope.has(brick.areaCode.toUpperCase()))
    .map((brick) => ({
      brickId: brick.brickId,
      brickName: brick.brickName,
      areaCode: brick.areaCode,
      areaName: brick.areaName,
      regionCode: brick.regionCode,
      regionName: brick.regionName,
    }))
    .sort((a, b) => (a.brickName || a.brickId).localeCompare(b.brickName || b.brickId));

  return { areas, bricks };
}

/**
 * A pharmacy's ordering history, summarized month x product x distributor.
 *
 * Answers the question an approver actually has in front of a number: is this the quantity this
 * pharmacy normally takes of this product, or a multiple of it? The request being decided is
 * EXCLUDED — including it would fold the figure under judgement into the baseline used to judge it.
 *
 * Month is the sales month once an order is final-approved; before that there is no sales month,
 * so the submission month stands in and is marked provisional rather than silently mixed in.
 *
 * Distributor comes from the pharmacy's registered pairs (a request carries no distributor of its
 * own), so a pharmacy supplied by two distributors yields a row per distributor per month/product.
 * Reversals are excluded: they mirror their original and would double the picture.
 */
async function loadPharmacyOrderHistory(
  pharmacy: DirectOrderPharmacy | null,
  excludeRequestId: string,
  visibility: DirectOrderHistoryVisibility,
): Promise<{ rows: DirectOrderPharmacyHistoryRow[]; hiddenConfidentialCount: number; loadFailed: boolean }> {
  if (!pharmacy) return { rows: [], hiddenConfidentialCount: 0, loadFailed: false };
  try {
    const supabase = getSupabaseAdmin();
    const rowsRaw = await fetchAllRows<Record<string, unknown>>(
      () =>
        supabase
          .from("direct_order_requests")
          .select("id, product_code, product_name, qty, bonus, sales_value, sales_month, created_at, status, reversal_of_request_id")
          .eq("pharmacy_id", pharmacy.id)
          .is("reversal_of_request_id", null)
          .neq("status", "rejected"),
      "id",
    );

    let hiddenConfidentialCount = 0;
    const hiddenProducts = new Set<string>();
    const byKey = new Map<string, DirectOrderPharmacyHistoryRow>();
    for (const row of rowsRaw) {
      if (String(row.id) === excludeRequestId) continue;
      const productCode = String(row.product_code ?? "");
      // Confidentiality and line scoping (owner rule, 2026-08-08) — applied HERE rather than in the
      // component, so no surface can render what this filter removed. See resolveHistoryVisibility.
      if (!visibility.allowsProduct(productCode)) {
        if (productCode && !hiddenProducts.has(productCode)) {
          hiddenProducts.add(productCode);
          hiddenConfidentialCount += 1;
        }
        continue;
      }
      const salesMonth = row.sales_month ? String(row.sales_month) : null;
      const month = salesMonth ?? String(row.created_at ?? "").slice(0, 7);
      if (!month) continue;
      // ONE bucket per (month, product) — NEVER one per distributor pair.
      //
      // This used to loop the pharmacy's distributor pairs and add the FULL qty/value/orders to each
      // of them, so a pharmacy with three linked codes reported every order three times at full
      // value. The distributor was invented in the first place: a direct order carries no
      // distributor of its own (see this function's own doc comment), so any per-distributor
      // attribution on this side is fabricated. Retail history is where distributor attribution is
      // real; this side reports the pharmacy's own direct orders and nothing more.
      const key = `${month}|${productCode}`;
      const existing = byKey.get(key) ?? {
        month,
        monthIsProvisional: salesMonth == null,
        productCode,
        productName: String(row.product_name ?? ""),
        distributorName: "—",
        distributorCode: "",
        orders: 0,
        qty: 0,
        bonus: 0,
        salesValue: 0,
      };
      existing.orders += 1;
      existing.qty += Number(row.qty ?? 0);
      existing.bonus += Number(row.bonus ?? 0);
      existing.salesValue += Number(row.sales_value ?? 0);
      // A bucket is only firm once EVERY order in it has a real sales month.
      if (salesMonth == null) existing.monthIsProvisional = true;
      byKey.set(key, existing);
    }

    const rows = [...byKey.values()].sort(
      (a, b) => b.month.localeCompare(a.month) || a.productName.localeCompare(b.productName),
    );
    return { rows, hiddenConfidentialCount, loadFailed: false };
  } catch (error) {
    // Context only — never a reason the approval screen fails to open. But `loadFailed` MUST travel
    // with the empty result: a failed read and "this pharmacy bought nothing" are opposite facts,
    // and returning a bare [] let the screen print the confident trusted sentence for both.
    logError("Direct order pharmacy history failed", {
      labels: { event: "direct_order_pharmacy_history_failed", pharmacyId: pharmacy.id },
      error,
    });
    return { rows: [], hiddenConfidentialCount: 0, loadFailed: true };
  }
}

/**
 * Which products may this viewer see in a pharmacy's sales history? (owner rule, 2026-08-08)
 *
 * Closes a real leak: neither history loader took an AccessContext at all, so every approver — a
 * District Manager on one line, a Medical Rep, anyone — saw that pharmacy's ENTIRE product history,
 * including the restricted codes and the Head Office line. `RY001` had already reached an SFE
 * Manager's screen once through the same class of gap.
 *
 * TWO exclusions, because the codebase has two independent confidentiality mechanisms and NEITHER
 * subsumes the other (pinned by tests/sos-import-dashboard-head-office-lock.test.ts):
 *   - RESTRICTED_PRODUCT_CODES — LA003 / LA004 / SS001, by product code.
 *   - the Head Office LINE — hides a whole line, which carries RY001, a product that is NOT in the
 *     restricted list. A restricted code can also sit on a non-Head-Office line. Apply both.
 *
 * Both are applied UNCONDITIONALLY, for every role including CEO and Super Admin (owner decision).
 * That is deliberately stricter than `canViewRestrictedProducts`, which would re-admit those two —
 * so this must never be routed through that helper.
 *
 * The LINE filter uses resolveDirectOrderRequesterLineName, whose unrestricted set is exactly
 * {Super Admin, SFE Manager, CEO} — matching the owner's spec. `resolveSalesAccessScope` is NOT used
 * for it: its District Manager mapping is TEAM, additionally narrowed by region and seat areas, so a
 * DM would see less than their own line.
 */
export type DirectOrderHistoryVisibility = {
  allowsProduct: (productCode: string) => boolean;
  /**
   * Whether the DISTRIBUTORS' retail sales of this month may be shown. The orders themselves are a
   * work record and stay; the retail feed is raw sales, so it waits for the closing (owner,
   * 2026-11-04). Every line, because one pharmacy's rows span lines.
   */
  allowsRetailMonth: (month: string) => boolean;
  /** Null when the viewer sees every line. */
  lineName: string | null;
};

async function resolveHistoryVisibility(access: AccessContext): Promise<DirectOrderHistoryVisibility> {
  const lineName = await resolveDirectOrderRequesterLineName(access);
  const products = await listSourceOfSalesProducts();
  const publishedKeys = readsUnpublishedSalesTools(access) ? null : await loadSalesReleaseKeys();
  const lineByCode = new Map<string, string>();
  for (const product of products) {
    const code = String((product as { productCode?: string }).productCode ?? "").trim();
    if (code) lineByCode.set(code.toUpperCase(), String((product as { line?: string }).line ?? ""));
  }
  const restricted = new Set(RESTRICTED_PRODUCT_CODES.map((code) => code.toUpperCase()));
  const wantedLine = lineName === null ? null : lineName.trim().toLowerCase();

  return {
    lineName,
    allowsRetailMonth: (month: string) => !publishedKeys || isSalesPeriodReleasedCompanyWide(month, publishedKeys),
    // The rule itself is pure and lives in hold-decision.ts so a test can EXECUTE it. Keeping it
    // inline here meant a source-text assertion was the only possible guard, and prove-it-fails
    // showed that guard survived the logic being disabled outright.
    allowsProduct: (productCode: string) =>
      isDirectOrderHistoryProductVisible({
        productCode,
        line: lineByCode.get(String(productCode ?? "").trim().toUpperCase()) ?? "",
        restrictedCodes: restricted,
        isHeadOfficeLine,
        viewerLine: wantedLine,
      }),
  };
}

/**
 * Retail sales the DISTRIBUTORS invoiced this pharmacy — the other half of the picture next to
 * its Phoenix direct orders, and deliberately never merged with them.
 *
 * The match is on (distributor_code AND client_code) TOGETHER. A customer code is not unique
 * across distributors: in live data, code "124" belongs to one pharmacy at distributor EG and a
 * different pharmacy in the direct-order registry. Matching on the code alone would quietly
 * attribute a stranger's sales to this pharmacy on the screen where money is approved.
 *
 * A pharmacy registered only against the company's own `Direct` channel cannot be matched at all
 * — those uploaded rows carry no client code — which is reported as `retailUnmatchable` rather
 * than shown as a misleading zero.
 */
async function loadPharmacyRetailHistory(
  pharmacy: DirectOrderPharmacy | null,
  visibility: DirectOrderHistoryVisibility,
): Promise<{
  rows: DirectOrderRetailHistoryRow[];
  unmatchable: boolean;
  hiddenConfidentialCount: number;
  loadFailed: boolean;
  matchedPairs: number;
}> {
  const pairs = (pharmacy?.distributorCodes ?? []).filter((pair) => pair.distributorCode && pair.customerCode);
  if (pairs.length === 0) {
    return { rows: [], unmatchable: true, hiddenConfidentialCount: 0, loadFailed: false, matchedPairs: 0 };
  }

  try {
    const supabase = getSupabaseAdmin();
    const customerCodes = [...new Set(pairs.map((pair) => pair.customerCode))];
    const distributorCodes = [...new Set(pairs.map((pair) => pair.distributorCode))];
    // BOTH halves of the key are pushed into the QUERY, and the read is fully paged.
    //
    // It previously filtered on `client_code` alone and applied the distributor half in TypeScript
    // afterwards, unordered and unpaged against a 1000-row ceiling. A pharmacy whose code collides
    // with a busy customer at another distributor could therefore receive 1000 foreign rows, discard
    // every one of them, and render the trusted sentence "it has not bought in the months on record"
    // — a confident falsehood on the screen where money is approved. Filtering both halves shrinks
    // the set to (our codes AND our distributors), and fetchAllRows removes the ceiling entirely;
    // the exact-pair check below still runs, because that intersection is a superset of the pairs.
    const rowsRaw = await fetchAllRows<Record<string, unknown>>(
      () =>
        supabase
          .from("source_of_sales_import_rows")
          .select(
            "id, client_code, product_code, product_name, qty, bonus_qty, value, batch_id, source_of_sales_import_batches!inner(distributor_code, period)",
          )
          .in("client_code", customerCodes)
          .in("source_of_sales_import_batches.distributor_code", distributorCodes),
      "id",
    );

    // (distributor, customer code) is the only safe key — see the note above.
    const allowed = new Set(pairs.map((pair) => `${pair.distributorCode.toLowerCase()}|${pair.customerCode}`));
    const nameByCode = new Map(pairs.map((pair) => [pair.distributorCode.toLowerCase(), pair.distributorName]));

    let hiddenConfidentialCount = 0;
    const hiddenProducts = new Set<string>();
    const byKey = new Map<string, DirectOrderRetailHistoryRow>();
    for (const raw of rowsRaw) {
      const batch = raw.source_of_sales_import_batches as { distributor_code?: string; period?: string } | null;
      const distributorCode = String(batch?.distributor_code ?? "");
      const clientCode = String(raw.client_code ?? "");
      if (!allowed.has(`${distributorCode.toLowerCase()}|${clientCode}`)) continue;
      const month = String(batch?.period ?? "");
      if (!month) continue;
      if (!visibility.allowsRetailMonth(month)) continue;

      const productCode = String(raw.product_code ?? "");
      // Confidentiality + line scoping, server-side. This loader reads the raw distributor invoice
      // feed, so before this filter existed every approver of any line saw every product this
      // pharmacy ever bought — including the restricted codes and the Head Office line.
      if (!visibility.allowsProduct(productCode)) {
        if (productCode && !hiddenProducts.has(productCode)) {
          hiddenProducts.add(productCode);
          hiddenConfidentialCount += 1;
        }
        continue;
      }

      const key = `${month}|${productCode}|${distributorCode}`;
      const existing = byKey.get(key) ?? {
        month,
        productCode,
        productName: String(raw.product_name ?? ""),
        distributorName: nameByCode.get(distributorCode.toLowerCase()) || distributorCode,
        distributorCode,
        customerCode: clientCode,
        qty: 0,
        bonus: 0,
        salesValue: 0,
      };
      existing.qty += Number(raw.qty ?? 0);
      existing.bonus += Number(raw.bonus_qty ?? 0);
      existing.salesValue += Number(raw.value ?? 0);
      byKey.set(key, existing);
    }

    const rows = [...byKey.values()].sort(
      (a, b) =>
        b.month.localeCompare(a.month) ||
        a.productName.localeCompare(b.productName) ||
        a.distributorName.localeCompare(b.distributorName),
    );
    return { rows, unmatchable: false, hiddenConfidentialCount, loadFailed: false, matchedPairs: pairs.length };
  } catch (error) {
    // Context only — never a reason the approval screen fails to open. `loadFailed` rides with the
    // empty result so a failed read can never be rendered as "this pharmacy has not bought".
    logError("Direct order retail history failed", {
      labels: { event: "direct_order_retail_history_failed", pharmacyId: pharmacy?.id ?? "" },
      error,
    });
    return { rows: [], unmatchable: false, hiddenConfidentialCount: 0, loadFailed: true, matchedPairs: pairs.length };
  }
}

export async function getDirectOrderApprovalDetail(
  access: AccessContext,
  requestId: string,
): Promise<DirectOrderApprovalDetail | null> {
  const loaded = await getDirectOrderRequest(access, requestId);
  if (!loaded) return null;
  const { request, steps } = loaded;
  const [nameOf, pharmacies, caps, items] = await Promise.all([
    nameLookup(),
    loadPharmaciesByIds([request.pharmacyId]),
    loadDirectOrderCaps(),
    // In the same round trip as the rest — an approver cannot decide without the lines, so
    // fetching them later would only move the wait.
    loadDirectOrderItems(request.id),
  ]);
  const pharmacy = pharmacies.get(request.pharmacyId) ?? null;
  // Confidentiality + line scoping for THIS viewer, resolved once and handed to both history
  // loaders. Server-side by design: a component filter would leave the data in the payload.
  const historyVisibility = await resolveHistoryVisibility(access);
  // Geography names and the area's medical rep are resolved HERE, at the single choke point
  // every approval surface reads, rather than in the components — which is why both of them
  // used to print raw brick/area codes.
  const [geoMaps, rep, pharmacyHistory, retail, productPrices] = await Promise.all([
    loadDirectOrderGeoNames(),
    resolveAreaRep({ line: request.line, areaCode: pharmacy?.areaCode ?? null }, { nameOf }),
    loadPharmacyOrderHistory(pharmacy, request.id, historyVisibility),
    loadPharmacyRetailHistory(pharmacy, historyVisibility),
    // The product's CURRENT prices, so the window can distinguish "never entered" from
    // "entered, but not the basis for this deal" — a discount order otherwise reported a
    // pharmacy price of "not set" for a product that had one.
    getSupabaseAdmin()
      .from("source_of_sales_products")
      .select("pharmacy_price, public_price")
      .eq("product_code", request.productCode)
      .maybeSingle(),
  ]);
  const priceRow = productPrices.data as { pharmacy_price?: number | null; public_price?: number | null } | null;
  const active = resolveActiveStep(steps);
  const canAct = request.status === "pending_approval" && viewerCanActOnStep(access, active);
  const bonusOverCap = isRequestOverCap(request, caps);
  // Derived from the chain that was actually built, plus the role AS STORED ON THE REQUEST — never
  // from today's org. The two live cases were built while their manager did not yet exist, and
  // re-deriving from the current directory would now clear the flag on the very requests it exists
  // to expose.
  const missingManagementLine = directOrderChainMissingManagementLine({
    requesterRole: request.requesterRole,
    steps,
  });

  // Fetched AFTER the block above, deliberately: a fixed-window source-text test
  // (direct-orders-approval-detail-names.test.ts) looks for loadDirectOrderGeoNames(/
  // resolveAreaRep( within the first ~2200 characters of this function's body, and inserting
  // earlier would push those past it for no reason. Null for the common case — most orders never
  // touch the held/validation lane. AI note stripped for the requester's own view (owner rule,
  // 2026-08-08): they see their own photo/GPS, not the adjudicator-facing reading of it.
  const rawEvidence = await getDirectOrderPharmacyValidationForRequest(request.id, request.pharmacyId);
  const pharmacyEvidence =
    rawEvidence && !canViewDirectOrderEvidenceAiNote(access.hrId, request)
      ? { ...rawEvidence, evidenceCheck: null }
      : rawEvidence;
  // Whether anyone ever stood in front of this venue (owner, 2026-09-29). Asked of the VENUE, not of
  // the single row above — that one is the most recent claim, and a venue captured in the field
  // earlier would read as uncaptured. Never the render gate on `pharmacyEvidence`: the loudest case
  // in production is a venue with no validation row at all.
  //
  // APPROVER-ONLY, never the portal and never the order's own requester (his ruling the same day).
  // Decided BEFORE the read, so a withheld line costs the rep's page nothing and the fact never
  // enters his payload — withheld here, not hidden on the screen.
  const showFieldEvidenceGap = canViewDirectOrderFieldEvidenceGap({
    viewerHrId: access.hrId,
    requesterHrId: request.requesterHrId,
    navigationMode: resolveNavigationMode(access),
  });
  const pharmacyFieldEvidenceGap = showFieldEvidenceGap
    ? directOrderFieldEvidenceGap(await loadDirectOrderVenueFieldEvidence(request.pharmacyId))
    : null;
  // EVERY validation photo of the venue — its Direct Order claims, its marketing pharmacy and the
  // marketing customers validated there — each with its full captured details (owner, 2026-10-21:
  // "never hide a picture if available"). Ungated like pharmacyEvidence above: anyone who may open
  // the order is deciding on the same venue. Never throws.
  // Same pharmacy, same person, BOTH modules (owner, 2026-10-28): the requester's live marketing
  // requests for this venue, flagged to every rung of the chain, the CEO included — a direct order
  // already carries its bonus or discount, so a marketing request on top pays the pharmacy twice.
  // Only when a line is above its product's normal deal (Ivyronc over 20% bonus, Lacto Advanced over
  // 15% discount, Guamusin over 10% bonus) — a normal order reads nothing. Flagged, never blocked.
  // Never throws.
  const [venueValidationPhotos, samePharmacyMarketingRequests] = await Promise.all([
    loadDirectOrderVenueValidationPhotos(request.pharmacyId),
    loadSamePharmacyFlagForDirectOrder({
      orderId: request.id,
      lines: items,
      marketingRequestId: request.marketingRequestId,
      pharmacyId: request.pharmacyId,
      pharmacyName: pharmacy?.pharmacyName ?? null,
      requesterHrId: request.requesterHrId,
      requesterName: nameOf(request.requesterHrId) ?? null,
    }),
  ]);
  // The invoice the rep used (owner, 2026-09-14). "Expected" is a NEW pharmacy with a distributor
  // account — exactly what the SFE Manager confirms on this order — so a missing invoice is said out
  // loud there instead of reading as nothing to see.
  const invoiceExpected = pharmacy?.verificationStatus === "pending_review" && venueRequiresDistributorCode(pharmacy.venueType);
  const orderInvoice = await loadDirectOrderRequestInvoice(request, { countRequesterSlots: invoiceExpected });
  // Mirrors attachDirectOrderInvoice's own guard — if these disagree, the control appears for someone
  // the server refuses, or (as happened) is withheld from someone the server accepts. NOT gated on
  // invoiceExpected (owner, 2026-09-14): Samaa's order stood on a pharmacy verified days earlier, so
  // her order had no invoice box at all and the invoice she used could never reach her approvers. The
  // server already saves such an invoice "for your approvers" without taking a validation slot.
  const canAttachInvoice =
    canAttachDirectOrderInvoice({
      viewerHrKey: canonicalHrIdKey(access.hrId),
      requesterHrKey: canonicalHrIdKey(request.requesterHrId),
      status: request.status,
      activeStepConfirmsPharmacy: active ? isPharmacyConfirmingStep(active) : false,
    });

  // The approver's reason for sending it back. Loaded ONLY for a returned order, and read from the
  // events table rather than the approval step: the decision RPC writes `decision_comment` only
  // when the step moves to approved/rejected, so a RETURN leaves no reason on the step at all.
  // Without this the requester is told to "fix and resubmit" with no way to see what to fix.
  let returnEvent: { message: string; actorHrId: string | null; createdAt: string } | null = null;
  if (request.status === "returned") {
    const { data: returnRow } = await getSupabaseAdmin()
      .from("direct_order_events")
      .select("message, actor_hr_id, created_at")
      .eq("request_id", request.id)
      .eq("event_type", "return")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const row = returnRow as { message?: string | null; actor_hr_id?: string | null; created_at?: string } | null;
    if (row?.message) {
      returnEvent = {
        message: row.message,
        actorHrId: row.actor_hr_id ?? null,
        createdAt: row.created_at ?? "",
      };
    }
  }
  const rawMatches =
    (pharmacy?.distributorCodes?.length ?? 0) === 0
      ? await findPossibleDistributorMatchesByPharmacyName(pharmacy?.pharmacyName)
      : [];
  // Ownership MUST be resolved here, not skipped as a read-path economy. Auto-link runs at
  // registration and at submit, so a candidate still sitting unlinked was refused on purpose — and
  // "owned by another Phoenix pharmacy" is both the most likely refusal and the only one invisible
  // from the row itself. Without it the panel prints "Phoenix did not link it automatically" and
  // then cannot say why, which is exactly the "Not flagged" failure this screen was rewritten to
  // kill. Naming the holder is also the finding: it is how the duplicate registration surfaces.
  const possibleDistributorMatches = pharmacy ? await attachCandidateOwnership(pharmacy.id, rawMatches) : rawMatches;
  const autoLinkRefusal =
    possibleDistributorMatches.length > 0
      ? (() => {
          const decision = decideDirectOrderAutoLink({
            pharmacyName: pharmacy?.pharmacyName ?? null,
            existingCodes: pharmacy?.distributorCodes ?? [],
            candidates: possibleDistributorMatches.map((match) => ({
              ...match,
              ownedByOtherPharmacyId: match.ownedByPharmacyCode,
            })),
          });
          return decision.link ? null : decision.refusal;
        })()
      : null;

  // The three-way geography comparison. The master side comes from whichever linked code actually
  // resolved (or, when none is linked, the possible-match candidate) — that is the distributor's own
  // statement about where this customer is, and it is what the declared brick must agree with.
  const geo = resolveDirectOrderGeo(pharmacy, geoMaps);
  const resolvedPair = (pharmacy?.distributorCodes ?? []).find((pair) => pair.mappedBrickId || pair.mappedAreaCode);
  const candidate = possibleDistributorMatches[0] ?? null;
  // Both halves fall back to the possible-match candidate, not just the area. Before brickId was
  // carried, this panel reported "area agrees" and "brick: nothing to check" for the SAME customer
  // — answering the less important half of the question and hiding that the brick agrees too.
  const masterBrickId = resolvedPair?.mappedBrickId ?? candidate?.brickId ?? null;
  const masterAreaCode = resolvedPair?.mappedAreaCode ?? candidate?.areaCode ?? null;
  // THE PHOTO IS THE PRIMARY SOURCE OF TRUST (owner, 2026-10-18). The territory the live evidence
  // photo's own pin falls in is read from the SAME brick centres the evidence stamp uses, so the
  // panel can never disagree with the words printed on the photo. Read from the raw row — the
  // adjudicator-facing note is stripped for some viewers, the coordinates are not that note.
  let photoTerritory: DirectOrderPhotoTerritory | null = null;
  let photoPinUnresolved: "brick_map_unavailable" | "no_brick_near" | null = null;
  const photoLat = rawEvidence?.capturedLatitude ?? null;
  const photoLon = rawEvidence?.capturedLongitude ?? null;
  if (photoLat !== null && photoLon !== null) {
    // `loadBrickCentroids` answers [] when the read fails, and about 700 bricks carry a centre, so an
    // empty list is the map not loading — said as such, never as a request with no GPS photo.
    const centroids = await loadBrickCentroids();
    const point = centroids.length > 0 ? resolveBrickForPoint(photoLat, photoLon, centroids) : null;
    if (!point) photoPinUnresolved = centroids.length === 0 ? "brick_map_unavailable" : "no_brick_near";
    if (point) {
      photoTerritory = {
        brickId: point.brickId,
        brickName: point.brickName,
        areaCode: point.areaCode,
        areaName: point.areaName,
        distanceKm: point.distanceKm,
      };
    }
  }
  const geographyCheck = pharmacy
    ? checkDirectOrderGeography({
        photoTerritory,
        photoPinUnresolved,
        noDistributorAccountVenueLabel: venueRequiresDistributorCode(pharmacy.venueType) ? null : venueTypeLabel(pharmacy.venueType),
        declaredBrickId: pharmacy.brickId,
        declaredBrickName: geo.brick?.name ?? null,
        declaredAreaCode: pharmacy.areaCode,
        declaredAreaName: geo.area?.name ?? null,
        masterBrickId,
        masterBrickName: masterBrickId ? geoMaps.brickNameById.get(masterBrickId) ?? null : null,
        masterAreaCode,
        masterAreaName: masterAreaCode ? geoMaps.areaNameByCode.get(masterAreaCode) ?? null : null,
        address: pharmacy.pharmacyAddress,
        // Every BRICK and AREA name in the master data. Bricks matter as much as areas here: a
        // typed address usually names a town ("كفر شكر"), which is brick-grained, so an
        // area-only list left most addresses unresolved — and the golden rule is that this column
        // always answers. More names also make the longest-match rule meaningful.
        knownPlaces: [
          ...[...geoMaps.brickNameById.entries()].map(([brickId, name]) => ({ name, brickId })),
          ...[...geoMaps.areaNameByCode.entries()].map(([areaCode, name]) => ({ name, areaCode })),
        ],
      })
    : null;

  return {
    request,
    // Every line, always — one for a normal order, several for a family basket. An approver decides
    // a number and must see every line that adds up to it.
    items,
    requesterName: nameOf(request.requesterHrId) ?? request.requesterHrId,
    pharmacyRegisteredByName: pharmacy?.createdByHrId ? nameOf(pharmacy.createdByHrId) : null,
    pharmacy,
    geo,
    medicalRep: toDirectOrderAreaRep(rep),
    productPharmacyPrice: priceRow?.pharmacy_price == null ? null : Number(priceRow.pharmacy_price),
    productPublicPrice: priceRow?.public_price == null ? null : Number(priceRow.public_price),
    distributorCodesText: formatDistributorCodesText(pharmacy?.distributorCodes),
    distributors: toDistributorRows(pharmacy?.distributorCodes, geoMaps),
    pharmacyHistory: pharmacyHistory.rows,
    retailHistory: retail.rows,
    retailUnmatchable: retail.unmatchable,
    // A failed read and "this pharmacy bought nothing" are opposite facts. Before these flags the
    // catch path returned a bare empty list, so a timeout rendered the confident trusted sentence.
    retailLoadFailed: retail.loadFailed,
    directLoadFailed: pharmacyHistory.loadFailed,
    /** How many distinct products this viewer is not allowed to see (owner rule: say so, show nothing). */
    hiddenConfidentialCount: retail.hiddenConfidentialCount + pharmacyHistory.hiddenConfidentialCount,
    /** How many (distributor, code) pairs the retail match ran against — a partial view must not read as complete. */
    retailMatchedPairs: retail.matchedPairs,
    // Spec D2: the reason an empty retail table is empty. Computed here, server-side, so the
    // window renders prose it cannot contradict — and so a provisional pharmacy never looks like
    // an established one that merely had a quiet quarter.
    pharmacyStanding: pharmacy
      ? describeDirectOrderPharmacyStanding({
          trustState: pharmacy.trustState,
          probationStartedAt: pharmacy.probationStartedAt,
        })
      : null,
    steps: steps.map((step) => ({
      ...step,
      approverName: step.approverHrId ? nameOf(step.approverHrId) : step.role,
      // WHO actually decided, by name — on a role rung this is how the window answers "which of
      // the two Super Admins approved it", which the rung's own label never can.
      decidedByName: step.decidedByHrId ? nameOf(step.decidedByHrId) ?? step.decidedByHrId : null,
    })),
    availableActions: { approve: canAct, reject: canAct, return: canAct },
    bonusOverCap,
    missingManagementLine,
    canSetSalesMonth: canSetDirectOrderSalesMonth(access),
    canRecordCollection: canRecordDirectOrderCollection(access),
    canSettleServiceFee: canSettleServiceFeeAsAdministrator(access),
    serviceFeeDefaults: canSettleServiceFeeAsAdministrator(access)
      ? {
          beneficiaryName: pharmacy?.doctorName?.trim() ?? "",
          requesterName: nameOf(request.requesterHrId) ?? request.requesterHrId,
        }
      : null,
    // Correcting a return is the requester's own action, so this is an OWNERSHIP flag, not a role
    // one. Mirrors reviseDirectOrder's guard exactly — if these ever disagree, the button appears
    // for someone the server will refuse.
    canCorrectAndResubmit:
      request.status === "returned" &&
      (access.role === "Super Admin" ||
        access.scope === "system" ||
        canonicalHrIdKey(request.requesterHrId) === canonicalHrIdKey(access.hrId)),
    returnComment: returnEvent
      ? {
          message: returnEvent.message,
          byName: returnEvent.actorHrId ? nameOf(returnEvent.actorHrId) ?? returnEvent.actorHrId : null,
          at: returnEvent.createdAt,
        }
      : null,
    pharmacyEvidence,
    // The "already validated · by whom · when" stamp for the approver window (owner, 2026-09-22).
    // Resolved from the SAME evidence + pharmacy the panel below already renders, so the badge and
    // the evidence it jumps to can never disagree.
    pharmacyValidation: resolveDirectOrderPharmacyValidationBadge(pharmacy, pharmacyEvidence, nameOf),
    pharmacyFieldEvidenceGap,
    venueValidationPhotos,
    samePharmacyMarketingRequests,
    orderInvoice,
    invoiceExpected,
    canAttachInvoice,
    possibleDistributorMatches,
    autoLinkRefusal,
    geographyCheck,
  };
}

// ── Report (premium table + xlsx export), tiered by role/scope ───────────────

// Owner tiering, restated explicitly 2026-08-09 after the previous cut left National Sales
// Manager lumped in with the company-wide roles: EVERY ONE sees their own orders only, except —
//   National Sales Manager sees his LINE, company-wide (every region, only his product line).
//   Regional Manager sees his SCOPE (their whole management subtree — "region").
// District Manager / Product Manager / Group Product Manager stay in the default "own" bucket —
// deliberately: District Manager maps to "team" in the general sales-scope model
// (getSalesScope/scopeForRole), but the owner confirmed direct orders stays stricter than that
// here, matching resolveDirectOrderRequesterLineName's own note on why it can't reuse
// resolveSalesAccessScope either.
//
// Super Admin / CEO / SFE Manager / Finance Manager see EVERY direct order — untouched by the
// 2026-08-09 change, the owner named only NSM and RM.
//
// Finance Manager is here for a structural reason, not as a convenience (owner approved,
// 2026-08-04). Finance OWNS the sales month — canSetDirectOrderSalesMonth admits B-185 and
// nobody else — but B-185 is never a requester and never an approver, so without a company-wide
// tier this scope resolved to "own", every list returned nothing, and canViewDirectOrderRequest
// refused every id. The one person allowed to book a direct order into a month could not open a
// single one, and 177,124.80 EGP of approved orders sat in no month, no rep, and no report.
// Removing this entry silently strands that money again.
const DIRECT_ORDER_REPORT_SEE_ALL_ROLES: PhoenixRole[] = [
  "Super Admin",
  "CEO",
  "SFE Manager",
  "Finance Manager",
];

/**
 * The OPERATIONAL Orders page — scoped, filtered and paginated IN THE DATABASE.
 *
 * This is deliberately not `getDirectOrderReport`. That function selects every request in scope and
 * decorates all of them, which is right for a report and wrong for the list screen: the client then
 * showed 25 rows out of however many were loaded. Here the database returns 25 rows and one count.
 *
 * ORDER OF OPERATIONS IS THE WHOLE POINT:
 *   1. resolve the scope tier   (resolveDirectOrderReportScope — not re-derived here)
 *   2. turn it into a predicate (fails closed at every tier)
 *   3. apply it to the query    ← authorization is a WHERE clause, not a post-filter
 *   4. apply the user's filters
 *   5. count + range            ← the count reflects the SCOPED, FILTERED set
 *
 * Steps 3 and 5 must never swap. Paginating first and trimming after gives short pages and a total
 * that describes rows the viewer may not see.
 */
/**
 * How many pharmacies / people a search term may resolve to before it stops being a search.
 *
 * NOT a silent truncation. Overflow is reported to the person as "narrow this down", because a
 * quietly capped list looks exactly like "your order is not here" — and the whole point of moving
 * this query server-side was to stop the list lying about what it contains.
 */
const DIRECT_ORDER_SEARCH_MATCH_LIMIT = 400;

type SearchMatches = { values: string[]; overflowed: boolean };

/** PostgREST needs `in.()` members quoted once a value can hold a comma, a space or a paren.
 *
 * The escaping itself belongs to the shared helper, not here. PostgREST escapes a `"` inside a
 * quoted filter value with a BACKSLASH; the SQL-style doubling this used to do (`""`) is a
 * different grammar, and a backslash in a member went through unescaped — which closes the value
 * one character early. Nothing was broken in practice only because every member here is a uuid or
 * an HR-id key, and those carry neither character: a divergence held latent by the shape of
 * today's data rather than by anything in the code. */
const quoteInList = quotedInList;

/**
 * Pharmacies whose NAME or CUSTOMER CODE matches, as ids this table can be filtered by.
 *
 * `direct_order_requests` holds `pharmacy_id` and nothing else about the pharmacy, so searching by
 * name means resolving ids first. One indexed query, bounded — still far cheaper than the
 * full-table report read that used to back this search.
 */
async function findPharmacyIdsMatchingSearch(term: string): Promise<SearchMatches> {
  // The term goes through the shared helper, which double-quotes it. Spliced in raw, a name
  // holding a comma split the two conditions this asks for into four fragments — two of them
  // carrying no operator at all — and PostgREST answered 400, so the search box simply stopped
  // working for `El Salam, Nasr City`. The helper returns "" when the term has no searchable
  // content left, and `.or("")` is itself a 400: that case is no pharmacy match, which is what
  // the caller already handles (it only pushes `pharmacy_id.in.(…)` for a non-empty list).
  const filter = ilikeAnyFilter(["pharmacy_name", "phoenix_pharmacy_code"], term);
  if (!filter) return { values: [], overflowed: false };
  const { data, error } = await getSupabaseAdmin()
    .from("direct_order_pharmacies")
    .select("id")
    .or(filter)
    // One over the limit, so overflow is DETECTED rather than assumed from a full page.
    .limit(DIRECT_ORDER_SEARCH_MATCH_LIMIT + 1);
  if (error) throw error;
  const ids = ((data ?? []) as Array<{ id: string }>).map((row) => String(row.id));
  return { values: ids.slice(0, DIRECT_ORDER_SEARCH_MATCH_LIMIT), overflowed: ids.length > DIRECT_ORDER_SEARCH_MATCH_LIMIT };
}

/**
 * People whose name matches, as the requester_hr_id values actually stored on the row.
 *
 * Costs no query: `getEmployeeDirectory` is cached and every other path here already warms it.
 * Each match is expanded through `hrIdLookupKeys` for the same reason the scope predicate is —
 * the column's casing is not guaranteed, and an exact match would silently lose rows.
 */
async function findRequesterHrIdsMatchingSearch(term: string): Promise<SearchMatches> {
  const needle = term.trim().toLowerCase();
  const directory = await getEmployeeDirectory();
  const keys = new Set<string>();
  let matched = 0;
  for (const employee of directory.employees) {
    const haystack = `${employee.displayName ?? ""} ${employee.fullName ?? ""}`.toLowerCase();
    if (!haystack.includes(needle)) continue;
    matched += 1;
    if (matched > DIRECT_ORDER_SEARCH_MATCH_LIMIT) break;
    for (const key of hrIdLookupKeys(employee.hrId)) keys.add(key);
  }
  return { values: Array.from(keys), overflowed: matched > DIRECT_ORDER_SEARCH_MATCH_LIMIT };
}

export async function listDirectOrderOperationalPage(
  access: AccessContext,
  input: {
    page?: number | null;
    pageSize?: number | null;
    filters?: DirectOrderOperationalFilters | null;
  } = {},
): Promise<DirectOrderOperationalPage<DirectOrderQueueRow>> {
  await assertPermission(access, "direct_orders", "read");

  const filters = input.filters ?? {};
  const page = clampDirectOrderPage(input.page);
  const pageSize = clampDirectOrderPageSize(input.pageSize);
  const scope = resolveDirectOrderReportScope(access);

  // Only pay for the subtree walk / line lookup the tier actually needs.
  const needsRequesterSet = scope === "own" || scope === "hierarchy";
  const [visibleKeys, viewerLine] = await Promise.all([
    needsRequesterSet && filters.scopeFilter !== "mine"
      ? resolveVisibleRequesterHrIds(access)
      : Promise.resolve(null),
    scope === "line" && filters.scopeFilter !== "mine"
      ? resolveDirectOrderRequesterLineName(access)
      : Promise.resolve(null),
  ]);

  const predicate = resolveDirectOrderScopePredicate({
    scope,
    viewerHrId: resolveEmployeeIdentityId(access) ?? access.hrId ?? null,
    visibleRequesterKeys: visibleKeys,
    viewerLine,
    scopeFilter: filters.scopeFilter ?? null,
  });

  const appliedFilters = { ...filters, scope };

  // FAIL CLOSED. An unresolvable tier returns an empty page, never an unfiltered one — and it costs
  // no query at all.
  if (predicate.kind === "none") {
    return { rows: [], totalCount: 0, page, pageSize, appliedFilters };
  }

  // The chip's grouping, turned into buckets a query can apply. Resolved here rather than inline
  // below so the "matches no status at all" case can return an empty page instead of being
  // expressed as a never-true predicate — see the group clause further down.
  const statusGroup = resolveDirectOrderStatusGroupFilter(
    resolveDirectOrderStatusGroup(filters.statusGroup),
  );
  const statusGroupClauses = statusGroup
    ? [
        ...(statusGroup.statuses.length ? [`status.in.(${statusGroup.statuses.join(",")})`] : []),
        ...statusGroup.unbookedStatuses.map((s) => `and(status.eq.${s},sales_month.is.null)`),
        ...statusGroup.bookedStatuses.map((s) => `and(status.eq.${s},sales_month.not.is.null)`),
      ]
    : [];
  if (statusGroup && statusGroupClauses.length === 0) {
    // Only reachable if the status vocabulary changes so a chip covers nothing. Showing an empty
    // list is the honest answer; omitting the predicate would show EVERYTHING under a chip that
    // matches nothing, which is the failure direction that actually hurts.
    return { rows: [], totalCount: 0, page, pageSize, appliedFilters };
  }
  if (predicate.kind === "requesters" && requesterCandidatesExceedUrlBudget(predicate.hrIdCandidates)) {
    // Truncating the list would silently shrink the manager's visible set. Refusing is loud, and a
    // subtree this deep is a real signal rather than a routine case.
    throw new Error(
      `Direct order scope resolved to ${predicate.hrIdCandidates.length} requester keys, beyond the ` +
        "safe URL budget for a single query. This needs the RPC path rather than a silently truncated list.",
    );
  }

  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("direct_order_requests")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false });

  // ── 3. AUTHORIZATION, as a predicate on the query ──────────────────────────
  if (predicate.kind === "requesters") {
    query = query.in("requester_hr_id", predicate.hrIdCandidates);
  } else if (predicate.kind === "line") {
    // ilike with no wildcard is an exact, case-insensitive match — the SQL equivalent of the
    // trim+lowercase comparison the report does in JavaScript.
    query = query.ilike("line", predicate.line);
  }

  // ── 4. The user's own filters ──────────────────────────────────────────────
  // A separate `.or()` from the free-text one below — PostgREST ANDs repeated `or=` params, so
  // "In Progress" AND "matches el salam" narrows correctly instead of one clause eating the other.
  if (statusGroupClauses.length > 0) query = query.or(statusGroupClauses.join(","));
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.requesterHrId) query = query.in("requester_hr_id", hrIdLookupKeys(filters.requesterHrId));
  if (filters.pharmacyId) query = query.eq("pharmacy_id", filters.pharmacyId);
  if (filters.productCode) query = query.eq("product_code", filters.productCode);
  if (filters.line) query = query.ilike("line", filters.line);
  if (filters.createdFrom) query = query.gte("created_at", filters.createdFrom);
  // Inclusive of the whole end day, not midnight at its start.
  if (filters.createdTo) query = query.lte("created_at", `${filters.createdTo}T23:59:59.999Z`);
  if (filters.salesMonth === "none") {
    // The Finance queue: approved with no month booked. See the GOLDEN RULE.
    query = query.eq("status", "approved").is("sales_month", null);
  } else if (filters.salesMonth) {
    query = query.eq("sales_month", filters.salesMonth);
  }

  // Free text over the columns this table actually holds. Pharmacy name/code, area and region live
  // on joined tables and are resolved for display AFTER the page is fetched, so they are not
  // searchable here yet — see the note in the Orders view. Promising a field the query cannot match
  // is worse than omitting it.
  const q = (filters.q ?? "").trim();
  if (q) {
    // Quoted by the shared helper for the same reason as the pharmacy lookup above: `,` and `()`
    // are structural in this grammar, so a product name carrying one used to split the expression
    // into fragments PostgREST rejects. Null means the term had no searchable content left — it
    // was nothing but wildcards — and the product columns are then left out rather than matched
    // through a bare `%`, which would have returned every row the viewer can see.
    const like = ilikeContainsValue(q);
    // `id.eq.` is added ONLY for something actually shaped like a uuid.
    //
    // This replaced an unconditional `id.eq.${q}` plus a retry-on-cast-error fallback, and the
    // fallback was a SCOPE LEAK: Postgres rejects `id.eq.el salam` before it evaluates anything,
    // so every non-uuid search errored into a retry that built a FRESH query — one with no scope
    // predicate and none of the filters above. An own-scope viewer typing any ordinary word got a
    // page drawn from the whole table. Introduced by me in 94579054; never pushed or deployed.
    //
    // Testing the shape first means the error path does not exist, so there is no second query
    // builder that can drift out of sync with this one. That is the actual fix — a corrected copy
    // of the predicates would have been one more place to forget them.
    const clauses: string[] = [];
    if (like) clauses.push(`product_name.ilike.${like}`, `product_code.ilike.${like}`);
    if (looksLikeDirectOrderId(q)) clauses.push(`id.eq.${q}`);

    // Pharmacy and person are what people actually search by, and neither is a column on this
    // table — so they are resolved to ids first and matched here. Without this the server search
    // would be NARROWER than the client-side one it replaces: a regression dressed as an
    // optimisation, and one nobody would report as a bug. They would just stop trusting the box.
    const [pharmacies, requesters] = await Promise.all([
      findPharmacyIdsMatchingSearch(q),
      findRequesterHrIdsMatchingSearch(q),
    ]);
    if (pharmacies.overflowed || requesters.overflowed) {
      badRequest(
        `"${q}" matches too many pharmacies or people to search by. Add a few more letters — a ` +
          "partial list would look exactly like the order not being there.",
      );
    }
    if (pharmacies.values.length) clauses.push(`pharmacy_id.in.(${quoteInList(pharmacies.values)})`);
    if (requesters.values.length) clauses.push(`requester_hr_id.in.(${quoteInList(requesters.values)})`);

    // A term that resolved to nothing searchable and matched no pharmacy or person leaves no
    // clause at all, and `.or("")` is a 400 — so the page falls back to the SCOPED, unfiltered
    // set, exactly what the old bare-`%` pattern returned. The scope predicate above is applied
    // separately and is untouched by this.
    if (clauses.length) query = query.or(clauses.join(","));
  }

  // ── 5. Count + page, in that order ─────────────────────────────────────────
  const from = (page - 1) * pageSize;
  const { data, error, count } = await query.range(from, from + pageSize - 1);
  // No retry-on-error path. A query error is a real fault and is thrown — the previous fallback
  // silently answered from an unscoped query, which is strictly worse than an error page.
  if (error) throw error;

  return {
    rows: await decorateDirectOrderPage(((data ?? []) as Array<Record<string, unknown>>).map(mapRequestRow)),
    totalCount: count ?? 0,
    page,
    pageSize,
    appliedFilters,
  };
}

/**
 * Turn ONE PAGE of raw requests into the rows the Orders list renders.
 *
 * This is where the saving actually lands. The list shows pharmacy name and code, area, region and
 * requester name — all of which live on other tables. `getDirectOrderReport` resolves them for
 * EVERY request in scope; here the joins are bounded by the page size, so the cost is 25 rows'
 * worth of lookups regardless of how many orders the company has.
 *
 * `bonusOverCap` is deliberately false, matching `reportRowToQueueRow`'s existing reasoning: the
 * flag only ever ADDS a warning chip, so false reads as "nothing flagged", never as "checked and
 * clear" — and the chip is still shown on the order's own page, where the decision is taken.
 */
async function decorateDirectOrderPage(requests: DirectOrderRequest[]): Promise<DirectOrderQueueRow[]> {
  if (requests.length === 0) return [];
  const [pharmacies, nameOf, geo, itemsByRequest] = await Promise.all([
    loadPharmaciesByIds(requests.map((r) => r.pharmacyId)),
    nameLookup(),
    loadDirectOrderGeoNames(),
    loadDirectOrderItemsForRequests(requests.map((r) => r.id)),
  ]);
  return requests.map((request) => {
    const pharmacy = pharmacies.get(request.pharmacyId) ?? null;
    // Same rule as the report and the approvals list — one page's worth of items, read in the same
    // parallel batch as the other three, so a basket names every product it charged for.
    const basket = summarizeDirectOrderBasket(request, itemsByRequest.get(request.id));
    return {
      id: request.id,
      requesterHrId: request.requesterHrId,
      requesterName: nameOf(request.requesterHrId) ?? request.requesterHrId,
      productName: basket.productName,
      qty: basket.qty,
      items: basket.lines,
      pharmacyName: pharmacy?.pharmacyName ?? "—",
      pharmacyCode: pharmacy?.phoenixPharmacyCode ?? "—",
      // `medicalRepName` is deliberately LEFT UNSET, not set to a placeholder. Resolving the
      // covering rep needs a live seat-model walk, which was removed from hot paths for its cost —
      // and the workspace's search placeholder is already worded per-tab precisely so it never
      // promises a field the rows on that tab cannot match.
      areaName: (pharmacy?.areaCode ? geo.areaNameByCode.get(pharmacy.areaCode) : null) ?? "—",
      regionName: (pharmacy?.regionCode ? geo.regionNameByCode.get(pharmacy.regionCode) : null) ?? "—",
      salesValue: request.salesValue,
      createdAt: request.createdAt,
      status: request.status,
      salesMonth: request.salesMonth,
      bonusOverCap: false,
    } satisfies DirectOrderQueueRow;
  });
}

/**
 * Overview's three order counters, as COUNT queries instead of a full-table read.
 *
 * WHAT THIS REPLACES. `buildDirectOrderWorkspaceSummary` walked every row the viewer could see and
 * tallied them in JavaScript, which meant Overview — four numbers on a landing screen — paid for
 * the entire Direct Orders population. These are `count: exact, head: true` reads: Postgres returns
 * the number and no rows at all.
 *
 * THE STATUS→STAGE MAPPING IS COPIED FROM status-labels.ts, NOT INVENTED. Getting it wrong would
 * silently misreport, so it is spelled out:
 *   returned                          → counted as `returned`
 *   pending_approval | held           → `inProgress`  (stages approval / customer_check)
 *   approved AND sales_month IS NULL  → `inProgress`  (stage finance — "Waiting for Finance")
 *   approved AND sales_month = <this> → `completedThisMonth`
 *   draft                             → counted nowhere (stage draft)
 *   rejected|expired|cancelled|reversed → counted nowhere (stage stopped)
 *
 * THE SUBTLETY THAT MATTERS: `returned` maps to stage "approval" in status-labels, but the original
 * JavaScript tested it FIRST and `continue`d, so a returned order counts as returned and never also
 * as in-progress. These queries reproduce that exactly — `inProgress` names its statuses explicitly
 * rather than selecting "everything at the approval stage", which would have double-counted.
 *
 * SCOPE IS THE SAME PREDICATE the Orders list uses, from the same resolver. Overview's counters
 * must span the viewer's whole permitted scope, which is precisely why they could not simply be
 * derived from `myOrders`.
 */
export async function countDirectOrderWorkspaceTotals(
  access: AccessContext,
  currentSalesMonth: string,
): Promise<{ inProgress: number; returned: number; completedThisMonth: number }> {
  await assertPermission(access, "direct_orders", "read");

  const scope = resolveDirectOrderReportScope(access);
  const [visibleKeys, viewerLine] = await Promise.all([
    scope === "own" || scope === "hierarchy" ? resolveVisibleRequesterHrIds(access) : Promise.resolve(null),
    scope === "line" ? resolveDirectOrderRequesterLineName(access) : Promise.resolve(null),
  ]);
  const predicate = resolveDirectOrderScopePredicate({
    scope,
    viewerHrId: resolveEmployeeIdentityId(access) ?? access.hrId ?? null,
    visibleRequesterKeys: visibleKeys,
    viewerLine,
  });

  // Fails closed, and costs nothing: an unresolvable tier counts zero rather than counting the
  // company. Same rule as the Orders page.
  if (predicate.kind === "none") return { inProgress: 0, returned: 0, completedThisMonth: 0 };
  if (predicate.kind === "requesters" && requesterCandidatesExceedUrlBudget(predicate.hrIdCandidates)) {
    throw new Error(
      `Direct order summary scope resolved to ${predicate.hrIdCandidates.length} requester keys, beyond ` +
        "the safe URL budget for a single query. This needs the RPC path rather than a truncated list.",
    );
  }

  const supabase = getSupabaseAdmin();
  // head: true — Postgres returns the count and NO rows. This is the whole point.
  const scoped = () => {
    let q = supabase.from("direct_order_requests").select("id", { count: "exact", head: true });
    if (predicate.kind === "requesters") q = q.in("requester_hr_id", predicate.hrIdCandidates);
    else if (predicate.kind === "line") q = q.ilike("line", predicate.line);
    return q;
  };

  const [returnedRes, activeRes, awaitingFinanceRes, completedRes] = await Promise.all([
    scoped().eq("status", "returned"),
    scoped().in("status", ["pending_approval", "held"]),
    scoped().eq("status", "approved").is("sales_month", null),
    scoped().eq("status", "approved").eq("sales_month", currentSalesMonth),
  ]);
  for (const res of [returnedRes, activeRes, awaitingFinanceRes, completedRes]) {
    if (res.error) throw res.error;
  }

  return {
    returned: returnedRes.count ?? 0,
    inProgress: (activeRes.count ?? 0) + (awaitingFinanceRes.count ?? 0),
    completedThisMonth: completedRes.count ?? 0,
  };
}

/**
 * The Finance inbox: approved orders carrying no sales month.
 *
 * WHAT THIS REPLACES. Needs Action derived this by loading the ENTIRE report and filtering it in
 * JavaScript for `status === "approved" && !salesMonth`. Opening the inbox therefore cost the whole
 * Direct Orders population to find, typically, a handful of rows.
 *
 * GATED ON THE ABILITY TO CLEAR IT, not merely on being able to read orders. Returning this queue
 * to a sales manager would light a red count on a job they are structurally forbidden from doing —
 * `canAssignDirectOrderSalesMonth` admits B-185 and Super Admin and nobody else — and a queue you
 * cannot clear is what teaches people to ignore queues. Same rule `getDirectOrderUnbookedBadge`
 * already applies to the sidebar badge; this is that rule, applied to the inbox it summarises, so
 * the two cannot disagree.
 *
 * NO SCOPE PREDICATE, deliberately. Finance's report scope is already "all" by explicit exception
 * (see DIRECT_ORDER_REPORT_SEE_ALL_ROLES and the incident recorded there: without it the one person
 * allowed to book a month could not open a single order, and 177,124.80 EGP sat unbooked). Adding a
 * requester filter here would re-create that bug. The capability gate above IS the boundary.
 *
 * PRESERVES THE GOLDEN RULE. This only READS. Injection still happens nowhere but
 * `setDirectOrderSalesMonth`, and approval still passes `p_sales_month: null`.
 */
export async function listDirectOrderAwaitingFinanceMonth(
  access: AccessContext,
  options: { limit?: number } = {},
): Promise<DirectOrderQueueRow[]> {
  await assertPermission(access, "direct_orders", "read");
  if (!canSetDirectOrderSalesMonth(access)) return [];

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("direct_order_requests")
    .select("*")
    .eq("status", "approved")
    .is("sales_month", null)
    // Oldest first: the money that has been waiting longest is the money to book next.
    .order("decided_at", { ascending: true, nullsFirst: false })
    .limit(options.limit ?? 200);
  if (error) throw error;

  return decorateDirectOrderPage(((data ?? []) as Array<Record<string, unknown>>).map(mapRequestRow));
}

export function resolveDirectOrderReportScope(access: AccessContext): DirectOrderReportScope {
  if (access.scope === "system" || DIRECT_ORDER_REPORT_SEE_ALL_ROLES.includes(access.role)) return "all";
  if (access.role === "National Sales Manager") return "line";
  // Regional Managers see their whole subtree ("region"); DSM/PM/GPM/everyone else see own.
  return access.role === "Regional Manager" ? "hierarchy" : "own";
}

/**
 * hrIds visible to the viewer: self + everyone below them in the reporting tree.
 *
 * Seat-continuity aware: a report whose own manager resigned is reassigned UPWARD by
 * `phx_release_terminal_manager_ownership` and stamped with `pending_manager_replacement_for_hr_id`
 * (the departed manager's HR_ID). Walking `manager_hr_id` alone would therefore drop a whole district
 * mid-replacement — the orders would silently vanish from the RM's report. Both edges are followed,
 * matching `isWithinManagerHierarchy` in src/lib/workforce/hierarchy-resolver.ts.
 */
/**
 * Exported so the per-rep counters (spec E1) can scope themselves with the SAME subtree rule the
 * report uses. A second copy of a visibility rule is exactly how `reverse` ended up reachable by
 * every rep in the company (audit C6.2 / F5) — one definition, many callers.
 */
export async function resolveVisibleRequesterHrIds(access: AccessContext): Promise<Set<string>> {
  const directory = await getEmployeeDirectory();
  const children = new Map<string, string[]>();
  const addEdge = (parentKey: string | null, childKey: string | null) => {
    if (!parentKey || !childKey) return;
    const list = children.get(parentKey) ?? [];
    if (!list.includes(childKey)) list.push(childKey);
    children.set(parentKey, list);
  };
  for (const employee of directory.employees) {
    const selfKey = canonicalHrIdKey(employee.hrId);
    addEdge(canonicalHrIdKey(employee.managerHrId ?? ""), selfKey);
    addEdge(canonicalHrIdKey(employee.pendingManagerReplacementForHrId ?? ""), selfKey);
  }
  // resolveEmployeeIdentityId, not access.hrId: a session whose login id differs from the employee
  // HR_ID would otherwise resolve to an empty subtree and see only their own orders.
  const viewer = canonicalHrIdKey(resolveEmployeeIdentityId(access) ?? access.hrId ?? "");
  const visible = new Set<string>();
  if (!viewer) return visible;
  visible.add(viewer);
  const queue = [viewer];
  let guard = 0;
  while (queue.length && guard < 20000) {
    const current = queue.shift() as string;
    guard += 1;
    for (const child of children.get(current) ?? []) {
      if (!visible.has(child)) {
        visible.add(child);
        queue.push(child);
      }
    }
  }
  return visible;
}

/** All direct orders visible to the caller (tiered), fully denormalized, newest first. */
/**
 * Who actually put each request into the state it is in now.
 *
 * NOT `approval_steps.decided_by_hr_id`: a decision can bypass the step chain entirely. On
 * 2026-08-05 a script rejected fourteen orders — nine of them already fully approved — writing
 * `status` directly and leaving every step untouched. The steps still said "approved by the CEO"
 * while the order read rejected, so the steps are the wrong source for this question.
 *
 * The events log is the right one: it records every transition including the ones no approver made.
 * A null actor there means no human took the action, which is exactly the thing worth seeing.
 */
async function loadDecidingActors(requestIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (requestIds.length === 0) return out;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("direct_order_events")
    .select("request_id, actor_hr_id, event_type, created_at")
    .in("request_id", requestIds)
    .in("event_type", ["approve", "rejected", "held", "expired", "reversed", "return"])
    .order("created_at", { ascending: true });
  if (error) throw error;

  // Ascending, so the last write per request wins and the map ends up holding the MOST RECENT
  // decision. A null actor is stored as null deliberately rather than skipped — "decided by nobody"
  // is a fact, not a missing value, and the report renders it as "(system)".
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const id = String(row.request_id ?? "");
    if (!id) continue;
    const actor = row.actor_hr_id ? String(row.actor_hr_id) : null;
    out.set(id, actor);
  }
  return out;
}

export async function getDirectOrderReport(
  access: AccessContext,
  options?: { requestId?: string },
): Promise<DirectOrderReportRow[]> {
  await assertPermission(access, "direct_orders", "read");
  const supabase = getSupabaseAdmin();
  let query = supabase.from("direct_order_requests").select("*").order("created_at", { ascending: false });
  if (options?.requestId) query = query.eq("id", options.requestId);
  const { data, error } = await query;
  if (error) throw error;
  let requests = ((data ?? []) as Array<Record<string, unknown>>).map(mapRequestRow);

  const scope = resolveDirectOrderReportScope(access);
  if (scope === "own") {
    const viewer = canonicalHrIdKey(access.hrId ?? "");
    requests = requests.filter((request) => canonicalHrIdKey(request.requesterHrId) === viewer);
  } else if (scope === "hierarchy") {
    const visible = await resolveVisibleRequesterHrIds(access);
    requests = requests.filter((request) => visible.has(canonicalHrIdKey(request.requesterHrId) ?? ""));
  } else if (scope === "line") {
    // National Sales Manager: every region, only their own product line. Fails CLOSED like every
    // other tier here — a line that cannot be resolved (see resolveDirectOrderRequesterLineName)
    // means zero rows, never the whole company.
    const viewerLine = ((await resolveDirectOrderRequesterLineName(access)) ?? "").trim().toLowerCase();
    requests = viewerLine
      ? requests.filter((request) => (request.line ?? "").trim().toLowerCase() === viewerLine)
      : [];
  }

  // Six independent lookups, none depending on another's result — parallelized rather than
  // stacked as sequential round trips (was ~6 serial awaits; measured as a real latency cost on
  // every report load regardless of table size, see src/lib/finance/command-center.ts:17).
  const requestIds = requests.map((request) => request.id);
  const [stepsByReq, pharmacies, nameOf, decidedByReq, itemsByRequest, geoNames] = await Promise.all([
    loadStepsForRequests(requestIds),
    loadPharmaciesByIds(requests.map((request) => request.pharmacyId)),
    nameLookup(),
    loadDecidingActors(requestIds),
    // Every product on every request. One paged read alongside the others — the report's product
    // and unit columns would otherwise show the FIRST line against a sales value that is the whole
    // basket, which on the sheet Finance books from is the report understating what was ordered.
    loadDirectOrderItemsForRequests(requestIds),
    // Resolve brick/area/region CODES → NAMES for display (owner wants both). Shared with the
    // approval detail and the approvals lists — see @/lib/direct-orders/geo-names.
    loadDirectOrderGeoNames(),
  ]);
  const { brickNameById, areaNameByCode, regionNameByCode } = geoNames;

  return requests.map((request) => {
    const active = resolveActiveStep(stepsByReq.get(request.id) ?? []);
    const pharmacy = pharmacies.get(request.pharmacyId) ?? null;
    const distributorCodesText = formatDistributorCodesText(pharmacy?.distributorCodes);
    // A basket ONLY. One-product orders — every order raised before this feature, and most raised
    // after — take the identical path they always took, straight off the request's own columns.
    //
    // No column is ADDED. The 39 columns are positional twins consumed by the owner's Google Sheet
    // every 60 seconds, so an insert would shift live formulas. Instead the existing columns are
    // made truthful: names and codes joined the same way the approval detail joins them, and the
    // units kept PER PRODUCT. A basket's Qty and Bonus cells are text ("72 + 24") — never a sum,
    // because units of different products are never added (owner, 2026-10-19: "Per product as
    // text"). They keep their column, so no position moves; the sheet's totals skip a text cell.
    // For a single line both are what they were: the request's own numbers.
    //
    // Prices and deal terms stay the FIRST line's. Averaging two prices would invent a number, and
    // a mixed-deal basket has no single discount to report — the order's own screen shows each line.
    const items = itemsByRequest.get(request.id) ?? [];
    // The composition rule itself lives in basket-label.ts — the report defined it first, and the
    // approvals list, Orders list, Held Desk and exception desk now read the same function rather
    // than each carrying a copy.
    const basket = summarizeDirectOrderBasket(request, items);
    return {
      id: request.id,
      requesterHrId: request.requesterHrId,
      requesterName: nameOf(request.requesterHrId) ?? request.requesterHrId,
      requesterRole: request.requesterRole,
      status: request.status,
      line: request.line,
      productCode: basket.productCode,
      productName: basket.productName,
      pharmacyPriceSnapshot: request.pharmacyPriceSnapshot,
      qty: basket.qty,
      bonus: basket.isBasket ? null : request.bonus,
      basketUnits: basket.isBasket
        ? {
            qty: joinDirectOrderBasketUnits(items.map((item) => item.qty)),
            bonus: joinDirectOrderBasketUnits(items.map((item) => item.bonus)),
          }
        : null,
      bonusOverrideReason: request.bonusOverrideReason,
      dealType: request.dealType,
      discountPct: request.discountPct,
      publicPriceSnapshot: request.publicPriceSnapshot,
      salesValue: request.salesValue,
      collectionDate: request.collectionDate,
      salesMonth: request.salesMonth,
      marketingRequestId: request.marketingRequestId,
      paymentDate: request.paymentDate,
      paidAmount: request.paidAmount,
      remainingAmount: request.remainingAmount,
      reversalOfRequestId: request.reversalOfRequestId,
      reversedByRequestId: request.reversedByRequestId,
      sosBatchId: request.sosBatchId,
      createdAt: request.createdAt,
      decidedAt: request.decidedAt,
      heldAt: request.heldAt,
      // "(system)" where the events log records the transition with no actor — a script decision,
      // not a person's. Undefined (no decision event at all) stays blank rather than claiming one.
      decidedByName: decidedByReq.has(request.id)
        ? (decidedByReq.get(request.id)
          // Fall back to the raw HR id rather than blanking: an actor we cannot name is still an
          // actor, and blanking would make it indistinguishable from "(system)".
          ? (nameOf(decidedByReq.get(request.id) as string) ?? String(decidedByReq.get(request.id)))
          : "(system)")
        : "",
      // Same rule as the approvals list: a returned order is waiting on its requester (the report's
      // "Awaiting" column read the SFE Manager for it, 2026-09-14).
      activeStepLabel:
        request.status === "returned"
          ? describeReturnedDirectOrderWait(nameOf(request.requesterHrId) ?? request.requesterHrId)
          : active?.label ?? "",
      activeStepOrder: active?.order ?? null,
      pharmacyCode: pharmacy?.phoenixPharmacyCode ?? "",
      pharmacyName: pharmacy?.pharmacyName ?? "",
      pharmacyAddress: pharmacy?.pharmacyAddress ?? "",
      brickId: pharmacy?.brickId ?? "",
      brickName: pharmacy?.brickId ? brickNameById.get(pharmacy.brickId) ?? "" : "",
      areaCode: pharmacy?.areaCode ?? "",
      areaName: pharmacy?.areaCode ? areaNameByCode.get(pharmacy.areaCode) ?? "" : "",
      regionCode: pharmacy?.regionCode ?? "",
      regionName: pharmacy?.regionCode ? regionNameByCode.get(pharmacy.regionCode) ?? "" : "",
      doctorName: pharmacy?.doctorName ?? "",
      distributorCodesText,
    };
  });
}

/**
 * Resolve the fully-denormalized approved order (names, pharmacy, geography) and email
 * its polished details table — To the fixed recipient, CC the CEO + system admin. Fired
 * by the decision route via Next.js after(), so it runs AFTER the response is sent and
 * never adds latency to the approval. Best-effort: failures are logged and swallowed.
 */
export async function dispatchDirectOrderApprovedEmail(requestId: string): Promise<void> {
  try {
    const [row] = await getDirectOrderReport(systemAccessContext, { requestId });
    if (row) await sendDirectOrderApprovedEmail(row);
  } catch (error) {
    logError("Direct order approved-email dispatch failed", { labels: { event: "direct_order_approved_email_dispatch_failed", requestId }, error });
  }
}

// ── Direct-sales reconciliation (manual DIRECT vs module DirectReq double-count) ──
const RECONCILIATION_VIEW_ROLES = new Set<PhoenixRole>(["Super Admin", "SFE Manager", "CEO"]);

function normalizeReconciliationPeriod(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return /^\d{4}-\d{2}$/.test(trimmed) ? trimmed : null;
}

/**
 * Company-oversight report: where do the legacy manual `DIRECT` upload and the
 * module's `DirectReq` injection BOTH carry direct sales for the same
 * (period, line, region, product)? Those buckets are the double-count exposure during
 * the parallel run. Read-only; Super Admin / SFE Manager / CEO only (caps/variances
 * audience). Delegates the money math to phx_direct_sales_reconciliation.
 */
export async function getDirectSalesReconciliation(
  access: AccessContext,
  input?: { periodFrom?: string | null; periodTo?: string | null },
): Promise<DirectSalesReconciliationResult> {
  await assertPermission(access, "direct_orders", "read");
  if (access.scope !== "system" && !RECONCILIATION_VIEW_ROLES.has(access.role)) {
    throw new Error("Forbidden: you are not allowed to view direct-sales reconciliation.");
  }
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_direct_sales_reconciliation", {
    p_period_from: normalizeReconciliationPeriod(input?.periodFrom),
    p_period_to: normalizeReconciliationPeriod(input?.periodTo),
  });
  if (error) throw error;
  const v = (data ?? {}) as Record<string, unknown>;
  const num = (x: unknown): number => Number(x ?? 0);
  const overlaps = Array.isArray(v.overlaps) ? (v.overlaps as Array<Record<string, unknown>>) : [];
  const byPeriod = Array.isArray(v.byPeriod) ? (v.byPeriod as Array<Record<string, unknown>>) : [];
  return {
    periodFrom: typeof v.periodFrom === "string" ? v.periodFrom : null,
    periodTo: typeof v.periodTo === "string" ? v.periodTo : null,
    groupedRows: num(v.groupedRows),
    overlapRows: num(v.overlapRows),
    totalManualDirect: num(v.totalManualDirect),
    totalModuleDirect: num(v.totalModuleDirect),
    overlapExposure: num(v.overlapExposure),
    pass: v.pass !== false,
    overlaps: overlaps.map((o) => ({
      period: String(o.period ?? ""),
      line: String(o.line ?? ""),
      regionCode: String(o.regionCode ?? ""),
      productCode: String(o.productCode ?? ""),
      manualValue: num(o.manualValue),
      manualQty: num(o.manualQty),
      moduleValue: num(o.moduleValue),
      moduleQty: num(o.moduleQty),
      overlapExposure: num(o.overlapExposure),
    })),
    byPeriod: byPeriod.map((p) => ({
      period: String(p.period ?? ""),
      manualValue: num(p.manualValue),
      moduleValue: num(p.moduleValue),
      overlapExposure: num(p.overlapExposure),
    })),
  };
}

// ── Pharmacy geo variances + public price (admin) ─────────────────────────────
const GEO_VIEW_ROLES = new Set<PhoenixRole>(["Super Admin", "SFE Manager", "CEO"]);
function canViewGeoVariances(access: AccessContext): boolean {
  return access.scope === "system" || GEO_VIEW_ROLES.has(access.role);
}
function canResolveGeoVariances(access: AccessContext): boolean {
  return access.scope === "system" || access.role === "Super Admin";
}

export type PharmacyGeoVariance = {
  pharmacyId: string;
  phoenixPharmacyCode: string;
  pharmacyName: string;
  createdByHrId: string;
  submittedBrickId: string | null;
  submittedBrickName: string | null;
  mappedBrickId: string | null;
  mappedBrickName: string | null;
  codes: Array<{ distributorName: string; customerCode: string; mappedBrickId: string | null; mappedBrickName: string | null }>;
};

/** Pharmacies where the submitter's manual brick differs from a customer-map brick (unresolved). */
export async function listPharmacyGeoVariances(
  access: AccessContext,
): Promise<{ rows: PharmacyGeoVariance[]; canResolve: boolean }> {
  if (!canViewGeoVariances(access)) throw new Error("Forbidden: you are not allowed to view venue variances.");
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("direct_order_pharmacies")
    .select("*")
    .eq("active", true)
    .eq("geo_variance_resolved", false);
  const pharmacies = ((data ?? []) as Array<Record<string, unknown>>).map(mapPharmacyRow);
  await attachDistributorCodes(pharmacies);
  const { brickNameById: brickName } = await loadDirectOrderGeoNames();

  const rows: PharmacyGeoVariance[] = [];
  for (const pharmacy of pharmacies) {
    const mapped = pharmacy.distributorCodes.map((code) => code.mappedBrickId).filter((x): x is string => !!x);
    const differing = mapped.find((brick) => brick !== pharmacy.brickId);
    if (!differing) continue; // no variance (unmapped or already matches the submitter brick)
    rows.push({
      pharmacyId: pharmacy.id,
      phoenixPharmacyCode: pharmacy.phoenixPharmacyCode,
      pharmacyName: pharmacy.pharmacyName,
      createdByHrId: pharmacy.createdByHrId,
      submittedBrickId: pharmacy.brickId,
      submittedBrickName: pharmacy.brickId ? brickName.get(pharmacy.brickId) ?? null : null,
      mappedBrickId: differing,
      mappedBrickName: brickName.get(differing) ?? null,
      codes: pharmacy.distributorCodes.map((code) => ({
        distributorName: code.distributorName,
        customerCode: code.customerCode,
        mappedBrickId: code.mappedBrickId,
        mappedBrickName: code.mappedBrickId ? brickName.get(code.mappedBrickId) ?? null : null,
      })),
    });
  }
  return { rows, canResolve: canResolveGeoVariances(access) };
}

/** Resolve a variance: keep the submitter's brick, or apply the customer-map brick. */
export async function resolvePharmacyGeoVariance(
  access: AccessContext,
  input: { pharmacyId: string; action: "keep" | "apply" },
): Promise<void> {
  if (!canResolveGeoVariances(access)) throw new Error("Forbidden: only a System Admin can resolve variances.");
  const supabase = getSupabaseAdmin();
  const patch: Record<string, unknown> = {
    geo_variance_resolved: true,
    geo_variance_resolution: input.action === "apply" ? "applied" : "kept",
    geo_variance_resolved_by: access.hrId ?? null,
    geo_variance_resolved_at: new Date().toISOString(),
  };
  if (input.action === "apply") {
    const { data: codeRows } = await supabase
      .from("direct_order_pharmacy_distributor_codes")
      .select("mapped_brick_id, mapped_area_code, mapped_region_code")
      .eq("pharmacy_id", input.pharmacyId);
    const mapped = ((codeRows ?? []) as Array<Record<string, unknown>>).find((row) => row.mapped_brick_id);
    if (mapped) {
      patch.brick_id = mapped.mapped_brick_id;
      patch.area_code = mapped.mapped_area_code ?? null;
      patch.region_code = mapped.mapped_region_code ?? null;
    }
  }
  const { error } = await supabase.from("direct_order_pharmacies").update(patch).eq("id", input.pharmacyId);
  if (error) throw error;
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: `pharmacy-variance:${input.pharmacyId}`,
    newValues: { action: input.action },
    summary: `Venue geo variance ${input.action} by ${access.hrId ?? "unknown"}.`,
  });
}

// ── Sales month (Finance-owned) ──────────────────────────────────────────────

/**
 * The one person the owner named to book a direct order into a month (2026-08-03):
 * Ahmed El Maraghy, Finance Manager. Deliberately an HR_ID and not the "Finance Manager" ROLE —
 * this moves money between months, and a second Finance Manager joining later must not inherit
 * that silently. If the duty moves, this constant is the single line to change.
 */
export const DIRECT_ORDER_SALES_MONTH_SETTER_HR_ID = DIRECT_ORDER_FINANCE_HR_ID;

/**
 * Ahmed, or a Super Admin. The CEO and SFE Manager can SEE the month but never set it.
 *
 * Delegates to `finance-authority.ts` rather than re-deriving the rule — that module is the single
 * place Finance's direct-order authority is defined, so reassigning the duty is a one-file change.
 */
export function canSetDirectOrderSalesMonth(access: AccessContext): boolean {
  return canAssignDirectOrderSalesMonth(access);
}

/**
 * Sidebar badge for the unbooked queue: approved orders carrying no sales month.
 *
 * WHY THIS EXISTS. The approved-order email fires once, at CEO approval, and then nothing ever
 * mentions the order again — direct orders is the only queue-bearing module with no SLA chaser
 * (there are 16 notification keys; none is a direct-order one). The owner does not want another
 * email, so the chase has to be ambient: a count that follows him onto every page and does not
 * clear itself. Measured on 2026-08-10 production: 43,925.50 EGP had been approved and unbooked
 * for 7 days with nothing on any screen he was not already looking at.
 *
 * GATED ON THE ABILITY TO CLEAR IT. The Direct Orders sidebar row is shared with every role
 * holding `direct_orders:read` — sales managers, SFE, CEO. Returning a count to them would light a
 * red badge on a job they are structurally forbidden from doing (canSetDirectOrderSalesMonth admits
 * B-185 and Super Admin, nobody else), and a badge you cannot clear is noise that teaches people to
 * ignore badges. So this returns 0 for everyone who is not the setter.
 *
 * CHEAP BY CONSTRUCTION. NavBadge polls every 30s, so this must never grow into a workspace
 * load. Two scalar columns, filtered in Postgres. Its sibling on the same badge,
 * `countDirectOrderAwaitingFast`, is held to the same standard for the same reason.
 *
 * The predicate is the same one `showsAwaitingFinanceMonth` uses in types.ts and
 * `phx_finance_command_center` uses in SQL — status approved AND no month. Three languages, one
 * rule; if this ever disagrees with the dashboard the badge is lying about the dashboard's own
 * number.
 */
export async function getDirectOrderUnbookedBadge(
  access: AccessContext,
): Promise<{ count: number; overdue: boolean }> {
  await assertPermission(access, "direct_orders", "read");
  if (!canSetDirectOrderSalesMonth(access)) return { count: 0, overdue: false };

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("direct_order_requests")
    .select("decided_at")
    .eq("status", "approved")
    .is("sales_month", null);
  if (error) throw error;

  const rows = (data ?? []) as Array<{ decided_at: string | null }>;
  if (rows.length === 0) return { count: 0, overdue: false };

  // Age from the APPROVAL, not from submission: the clock on Finance only starts once the order
  // is his to act on. A request that sat three weeks in the approval chain is not his backlog.
  let oldest = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const at = row.decided_at ? new Date(row.decided_at).getTime() : Number.NaN;
    if (Number.isFinite(at) && at < oldest) oldest = at;
  }
  const ageDays = Number.isFinite(oldest)
    ? Math.max(0, Math.floor((Date.now() - oldest) / 86_400_000))
    : 0;

  return {
    count: rows.length,
    overdue: slaTone(ageDays, APPROVALS_SLA_THRESHOLDS.directOrderMonth) === "overdue",
  };
}

/**
 * Book a direct order into a sales month — or un-book it by passing null.
 *
 * The month decides which month's Source-of-Sales the order lands in, so a CHANGE has to rebuild
 * BOTH periods: the old one to take the value out, the new one to put it in. Rebuilding only the
 * new month would leave the sales counted twice; only the old, and they would vanish. The rebuild
 * is idempotent (rebuild-from-truth) and each call is its own transaction, so a partial failure
 * leaves a period consistent rather than half-written.
 *
 * Only an APPROVED order injects; a month set earlier simply waits for the approval to land.
 */
export async function setDirectOrderSalesMonth(
  access: AccessContext,
  input: { requestId: string; salesMonth: string | null },
): Promise<DirectOrderRequest> {
  await assertPermission(access, "direct_orders", "read");
  if (!canSetDirectOrderSalesMonth(access)) {
    throw new Error("Forbidden: only Finance (Ahmed El Maraghy) or a System Admin can set the sales month.");
  }

  const supabase = getSupabaseAdmin();
  const { data: current, error: loadError } = await supabase
    .from("direct_order_requests")
    .select("*")
    .eq("id", input.requestId)
    .maybeSingle();
  if (loadError) throw loadError;
  if (!current) badRequest("Direct order request not found.");
  const before = mapRequestRow(current as Record<string, unknown>);
  const previousMonth = before.salesMonth;

  // SERVER-SIDE STATUS GUARD (second-review finding 5, 2026-08-11). The month's FORMAT and the
  // caller's identity were checked before this; the order's STATE was not. Booking a month is a
  // Finance decision about an order the chain has already authorised, so the server — not the
  // absence of a button — is what refuses it on an unapproved row. See finance-authority.ts.
  const monthChange = deriveDirectOrderSalesMonthChange({
    status: before.status,
    currentMonth: previousMonth,
    requestedMonth: input.salesMonth === null ? null : String(input.salesMonth).trim(),
  });
  if (!monthChange.ok) badRequest(monthChange.message);
  const nextMonth = monthChange.nextMonth;
  if (previousMonth === nextMonth) return before;

  // FROZEN-CLOSING RULE. A published closing never changes again (owner, 2026-09-07), so booking
  // into one is CARRIED FORWARD to the first open month rather than refused, and moving an order
  // OUT of one is refused outright. Decided here, before anything is written, so Finance gets a
  // sentence instead of a half-applied booking — the month and the sales move in two steps that are
  // not one transaction. See sales-month-lock-guard.ts for the rule and why it is asymmetric.
  const lockedPeriods = await listLockedPeriodsForLine(before.line);
  const booking = resolveSalesMonthBooking({
    isPeriodFrozen: (period) => lockedPeriods.has(period),
    line: before.line,
    previousMonth,
    requestedMonth: nextMonth,
  });
  assertSalesMonthBookingAllowed(booking);

  // What Finance asked for is `nextMonth`; what the order is actually written to is `bookedMonth`,
  // and from here ONLY the latter may be used. Every remaining step — the update, the rebuild, the
  // rollback and the audit row — has to agree on the month, or the sales and the booking part ways
  // again, which is the whole failure this guard exists to prevent.
  const bookedMonth = booking.ok ? booking.bookedMonth : nextMonth;
  const shiftNote = booking.ok ? describeSalesMonthShift(booking) : null;
  if (previousMonth === bookedMonth) return before;

  const { data: updated, error: updateError } = await supabase
    .from("direct_order_requests")
    .update({ sales_month: bookedMonth, updated_at: new Date().toISOString() })
    .eq("id", input.requestId)
    .select("*")
    .single();
  if (updateError) throw updateError;
  const after = mapRequestRow(updated as Record<string, unknown>);

  // Rebuild every period this move touched. Sequential, because the RPC takes a per-period
  // advisory lock; de-duplicated so setting a month for the first time rebuilds once.
  //
  // If one fails anyway — a closing locked in the gap since the guard above, or any other rebuild
  // failure — PUT THE MONTH BACK. The guard makes this near-unreachable; this is what makes the
  // invariant hold rather than merely be likely. Only the periods that actually rebuilt are
  // replayed: a period the trigger refused was never changed, and the RPC rebuilds from truth, so
  // replaying it after the month is restored reproduces exactly the state before this call.
  const periods = periodsTouchedBySalesMonthChange(previousMonth, bookedMonth);
  const rebuilt: string[] = [];
  for (const period of periods) {
    const { error: rpcError } = await supabase.rpc("phx_rebuild_direct_order_sos_batch", {
      p_period: period,
      p_actor: access.hrId ?? "finance",
    });
    if (!rpcError) {
      rebuilt.push(period);
      continue;
    }
    await supabase
      .from("direct_order_requests")
      .update({ sales_month: previousMonth, updated_at: new Date().toISOString() })
      .eq("id", input.requestId);
    const stuck: string[] = [];
    for (const replay of rebuilt) {
      const { error: replayError } = await supabase.rpc("phx_rebuild_direct_order_sos_batch", {
        p_period: replay,
        p_actor: access.hrId ?? "finance",
      });
      if (replayError) stuck.push(replay);
    }
    logError("Direct order sales month rolled back: Source of Sales refused the rebuild", {
      context: { period, periods, requestId: input.requestId, restoredMonth: previousMonth, stuck },
      error: rpcError,
    });
    if (stuck.length > 0) {
      throw conflictError(
        `The sales month was put back to ${previousMonth ?? "none"}, but ${stuck.join(" and ")} ` +
          `could not be rebuilt. Run phx_rebuild_direct_order_sos_batch for ${stuck.join(" and ")} ` +
          `before trusting that month's closing.`,
        "closing_rebuild_stuck",
      );
    }
    throw conflictError(
      `Source of Sales refused to move this order into ${period}, so the sales month was left as ` +
        `${previousMonth ?? "none"} rather than saved without its sales. ${rpcError.message ?? ""}`.trim(),
      "closing_locked",
    );
  }
  // Booking is the finance manager's own hop on the finance landing: show it on their next read.
  invalidateFinanceDashboardCache("direct order sales month set");

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: after.id,
    oldValues: { salesMonth: previousMonth },
    newValues: {
      salesMonth: bookedMonth,
      rebuiltPeriods: periods,
      ...(shiftNote ? { requestedMonth: nextMonth, shiftedOverFrozenClosings: true } : {}),
    },
    summary:
      `Direct order sales month set to ${bookedMonth ?? "none"} by ${access.hrId ?? "unknown"}.`
      + (shiftNote ? ` ${shiftNote}` : ""),
  });
  await insertEvent({
    requestId: after.id,
    actorHrId: access.hrId,
    eventType: "sales_month_set",
    // The timeline says the month that was SAVED, and says so when it is not the month that was
    // picked. Printing the request instead would leave the order's own history disagreeing with
    // the closing it lands in.
    message:
      `Sales month ${previousMonth ? `changed from ${previousMonth} ` : "set "}to ${bookedMonth ?? "none"}.`
      + (shiftNote ? ` ${shiftNote}` : ""),
    metadata: {
      previousMonth,
      nextMonth: bookedMonth,
      rebuiltPeriods: periods,
      ...(shiftNote ? { requestedMonth: nextMonth } : {}),
    },
  });

  pingDirectOrderSheet("sales_month_set");
  return after;
}

// ── Collections (Finance-owned) ──────────────────────────────────────────────

/**
 * Record (or clear) the money collected against an approved direct order.
 *
 * THIS IS NOT A SALES EVENT, and the separation is the whole point. Booking a sales month moves
 * the order's VALUE between Source-of-Sales periods; recording a collection only says how much of
 * that value has been paid. So this function deliberately does NOT touch `sales_month` and does
 * NOT call phx_rebuild_direct_order_sos_batch — a payment landing in September must never drag
 * July's sales into September. If a future change makes this write sales_month, the two events
 * have been collapsed and the month is no longer Finance's explicit decision.
 *
 * `remaining_amount` is DERIVED here (sales_value − paid), never accepted from the caller. A
 * client-supplied remainder is a second source of truth for the same money, and the two drift the
 * first time someone edits one field.
 *
 * Approved-only: a draft, rejected, held or reversed order has no debt to collect against, so
 * accepting money on one would record a receivable for stock that was never agreed.
 */
export async function recordDirectOrderCollection(
  access: AccessContext,
  input: { requestId: string; paidAmount: number | null; paymentDate: string | null },
): Promise<DirectOrderRequest> {
  await assertPermission(access, "direct_orders", "read");
  if (!canRecordDirectOrderCollection(access)) {
    throw new Error("Forbidden: only Finance (Ahmed El Maraghy) or a System Admin can record a collection.");
  }

  const supabase = getSupabaseAdmin();
  const { data: current, error: loadError } = await supabase
    .from("direct_order_requests")
    .select("*")
    .eq("id", input.requestId)
    .maybeSingle();
  if (loadError) throw loadError;
  if (!current) badRequest("Direct order request not found.");
  const before = mapRequestRow(current as Record<string, unknown>);

  // Clearing: one explicit "nothing collected" state, so a mistake is undoable. All three columns
  // reset together — a payment date left behind with no amount is what makes the phantom-pharmacy
  // check (pharmacy-probation.ts) treat an unpaid order as proof the pharmacy is real.
  const clearing = input.paidAmount == null;

  // Debt already paid off by settling marketing requests against this order (offset-rules.ts). It is
  // not cash, so `paid_amount` never carries it, but the remainder is net of it - otherwise recording
  // or clearing a collection would silently put a settled amount back on the order.
  const offsetTotal = await loadOffsetTotalForOrder(input.requestId);

  let patch: Record<string, string | number | null>;
  let summary: string;
  let eventType: string;
  let eventMessage: string;

  if (clearing) {
    if (before.paidAmount == null && before.paymentDate == null) return before;
    patch = {
      payment_date: null,
      paid_amount: null,
      remaining_amount: deriveRemainingWhenCollectionCleared({ offsetTotal, salesValue: before.salesValue }),
    };
    summary = `Direct order collection cleared by ${access.hrId ?? "unknown"}.`;
    eventType = "collection_cleared";
    eventMessage = "Collection cleared — nothing is recorded as paid against this order.";
  } else {
    // Every guard and the remainder itself live in collection-rules.ts, pure and unit-tested.
    const outcome = deriveDirectOrderCollection({
      status: before.status,
      salesValue: before.salesValue,
      paidAmount: input.paidAmount,
      paymentDate: input.paymentDate,
      todayCairo: todayInCairo(),
      offsetTotal,
    });
    if (!outcome.ok) badRequest(outcome.message);

    patch = {
      payment_date: outcome.paymentDate,
      paid_amount: outcome.paidAmount,
      remaining_amount: outcome.remainingAmount,
    };
    summary = `Direct order collection of ${outcome.paidAmount} EGP recorded by ${access.hrId ?? "unknown"}.`;
    eventType = "collection_recorded";
    eventMessage =
      outcome.remainingAmount > 0
        ? `Collected ${outcome.paidAmount} EGP on ${outcome.paymentDate}; ${outcome.remainingAmount} EGP still outstanding.`
        : `Collected ${outcome.paidAmount} EGP on ${outcome.paymentDate} — paid in full.`;
  }

  const { data: updated, error: updateError } = await supabase
    .from("direct_order_requests")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", input.requestId)
    .select("*")
    .single();
  if (updateError) throw updateError;
  const after = mapRequestRow(updated as Record<string, unknown>);

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: after.id,
    oldValues: {
      paidAmount: before.paidAmount,
      paymentDate: before.paymentDate,
      remainingAmount: before.remainingAmount,
    },
    newValues: {
      paidAmount: after.paidAmount,
      paymentDate: after.paymentDate,
      remainingAmount: after.remainingAmount,
    },
    summary,
  });
  await insertEvent({
    requestId: after.id,
    actorHrId: access.hrId,
    eventType,
    message: eventMessage,
    metadata: {
      previousPaidAmount: before.paidAmount,
      paidAmount: after.paidAmount,
      remainingAmount: after.remainingAmount,
      paymentDate: after.paymentDate,
      // Recorded so the trail proves the month was untouched, not merely that we intended it.
      salesMonthUnchanged: after.salesMonth,
    },
  });

  pingDirectOrderSheet("collection_recorded");
  return after;
}

/**
 * Zero is stored as NULL, deliberately.
 *
 * A product priced "0" would read as "0.00 EGP" in the admin table while the submit path's
 * `> 0` guard treated it as unset and refused the submission — two surfaces disagreeing
 * about the same product. Collapsing 0 to NULL makes the table, the missing-price flag and the
 * fallback agree on one meaning: "not set".
 */
function normalizeProductPrice(value: number | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Set a product's public price (discount deals) and/or its pharmacy price (bonus deals).
 * Super Admin only.
 *
 * One write, not two: the admin table's per-row Save edits both cells, and two sequential
 * requests could leave a row half-saved. Patch semantics — a key absent from `input` is left
 * untouched, so a partial save never nulls the other price.
 *
 * Audited, unlike the setter it replaces. That was arguably tolerable when public price only
 * affected discount deals; pharmacy price now determines `sales_value` directly, hence
 * achievement and incentives, so an unlogged edit here is an unlogged money change.
 */
export async function setDirectOrderProductPrices(
  access: AccessContext,
  input: { productCode: string; publicPrice?: number | null; pharmacyPrice?: number | null },
): Promise<void> {
  if (!(access.scope === "system" || access.role === "Super Admin")) {
    throw new Error("Forbidden: only a System Admin can set public prices.");
  }
  const productCode = String(input.productCode ?? "").trim();
  if (!productCode) badRequest("A product code is required.");

  const patch: Record<string, number | null> = {};
  if (Object.prototype.hasOwnProperty.call(input, "publicPrice")) {
    patch.public_price = normalizeProductPrice(input.publicPrice);
  }
  if (Object.prototype.hasOwnProperty.call(input, "pharmacyPrice")) {
    patch.pharmacy_price = normalizeProductPrice(input.pharmacyPrice);
  }
  if (Object.keys(patch).length === 0) return;

  const supabase = getSupabaseAdmin();
  // Read first so the audit entry can answer "what was it before" — an audit without the
  // prior value cannot reconstruct a mispriced month.
  const { data: before } = await supabase
    .from("source_of_sales_products")
    .select("public_price, pharmacy_price")
    .eq("product_code", productCode)
    .maybeSingle();

  const { error } = await supabase.from("source_of_sales_products").update(patch).eq("product_code", productCode);
  if (error) throw error;

  const priorRow = before as { public_price?: number | null; pharmacy_price?: number | null } | null;
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: `product-price:${productCode}`,
    oldValues: {
      publicPrice: priorRow?.public_price ?? null,
      pharmacyPrice: priorRow?.pharmacy_price ?? null,
    },
    newValues: patch,
    summary: `Direct-order product prices updated for ${productCode} by ${access.hrId ?? "unknown"}.`,
  });
}

/** Back-compat wrapper for the existing "publicPrice" API action. */
export async function setProductPublicPrice(
  access: AccessContext,
  input: { productCode: string; publicPrice: number | null },
): Promise<void> {
  await setDirectOrderProductPrices(access, { productCode: input.productCode, publicPrice: input.publicPrice });
}

// ── Automated duplicate cleanup, reviewed and confirmed by an SFE Manager ────────────────────
//
// Owner rules 1-5 (2026-08-09), in one flow:
//   1. repair the records that already exist, not only the ones submitted from now on
//   2. resolving a pharmacy resolves EVERY request on it
//   3. duplicate requests are flagged as duplicates and cancelled
//   4. when the system can prove two records are one pharmacy, merge them instead of blocking the
//      employee and making them fix their own mistake
//   5. the system prepares the whole cleanup; an SFE Manager reviews, edits and confirms it
//
// Nothing here writes until confirmDirectOrderCleanup is called. getDirectOrderCleanupPlan is a
// READ: it computes what should happen and says why, in words, for every single change.

/**
 * Cleanup is SFE Manager + Super Admin, deliberately wider than the Held Desk.
 *
 * The Held Desk is System Admin only because it rules on evidence. This is different work: the
 * system has already decided what is duplicated and only needs a human to agree — and the owner put
 * SFE in that seat. Both roles are also the registry's `allowedRoles` for cancel_duplicate and
 * release_held, so this gate and the workflow gate cannot drift apart.
 */
function assertDirectOrderCleanupAccess(access: AccessContext): void {
  if (!(access.scope === "system" || access.role === "Super Admin" || access.role === "SFE Manager")) {
    throw new Error("Forbidden: direct-order cleanup is for a Super Admin or an SFE Manager.");
  }
}

export type DirectOrderCleanupRequestSummary = {
  requestId: string;
  status: DirectOrderStatus;
  productCode: string;
  productName: string;
  qty: number;
  bonus: number;
  dealType: string;
  discountPct: number | null;
  salesValue: number;
  collectionDate: string | null;
  requesterHrId: string;
  requesterName: string;
  submittedAt: string | null;
  approvedStepCount: number;
  pharmacyId: string;
  pharmacyCode: string;
  pharmacyName: string;
};

export type DirectOrderCleanupPharmacySummary = {
  pharmacyId: string;
  pharmacyCode: string;
  pharmacyName: string;
  brickId: string | null;
  areaCode: string | null;
  verificationStatus: string;
  active: boolean;
  createdAt: string | null;
  createdByName: string;
  linkedCodes: string[];
  openRequestCount: number;
  /**
   * Approved orders sitting on this record, and what they are worth.
   *
   * Counted SEPARATELY from `openRequestCount` because the two are governed by different rules and
   * the screen must not blur them. `openRequestCount` comes from `loadCleanupRequestSummaries`,
   * which is filtered to `DEDUPE_OPEN_STATUSES` — so before this field existed the desk could say
   * "0 open request(s)" about a record carrying a quarter of a million EGP of approved business,
   * while `confirmDirectOrderCleanup` repoints requests with NO status filter and would move every
   * one of them. A reviewer has to be able to see what a merge actually touches (owner's rule,
   * 2026-08-29: a row with confirmed orders is never touched).
   */
  approvedRequestCount: number;
  approvedRequestValue: number;
};

export type DirectOrderCleanupMerge = {
  survivor: DirectOrderCleanupPharmacySummary;
  merged: DirectOrderCleanupPharmacySummary[];
  /** A shared distributor code (a fact), or a codeless name+area match (a strong resemblance). */
  provenBy: PharmacyMergeEvidence;
  reason: string;
  /** Requests that would move onto the survivor. */
  requestsMoved: DirectOrderCleanupRequestSummary[];
};

export type DirectOrderCleanupDuplicate = {
  keeper: DirectOrderCleanupRequestSummary;
  duplicates: DirectOrderCleanupRequestSummary[];
  reason: string;
};

export type DirectOrderCleanupRepair = {
  pharmacyId: string;
  pharmacyCode: string;
  pharmacyName: string;
  distributorCode: string;
  distributorName: string;
  customerCode: string;
  renameTo: string | null;
};

export type DirectOrderCleanupRelease = {
  pharmacyId: string;
  pharmacyCode: string;
  pharmacyName: string;
  requests: DirectOrderCleanupRequestSummary[];
};

/**
 * Two venue records that look like one another and that the merge rule will NOT rule on.
 *
 * Review-only, and deliberately shaped so it cannot become a write: it carries no survivor, no
 * `mergedIds`, and nothing on the confirm payload reads it. See `findLookAlikeVenues` for why —
 * every group it can produce has approved orders on at least one side.
 */
export type DirectOrderCleanupLookAlike = {
  normalizedName: string;
  areaCode: string;
  blocker: VenueLookAlikeBlocker;
  explanation: string;
  members: DirectOrderCleanupPharmacySummary[];
};

export type DirectOrderCleanupPlan = {
  /** Pharmacy records proven to be one real pharmacy (owner rule 4). */
  merges: DirectOrderCleanupMerge[];
  /** One order entered more than once (owner rule 3). */
  duplicates: DirectOrderCleanupDuplicate[];
  /** Codes sitting in the wrong field that the repair pass can move (owner rule 1). */
  repairs: DirectOrderCleanupRepair[];
  /** Held requests that resolution would release (owner rule 2). */
  releases: DirectOrderCleanupRelease[];
  /** Same name, same area, not provable — shown for a human to judge, never applied. */
  lookAlikes: DirectOrderCleanupLookAlike[];
  /** Empty when there is nothing to do — the screen says so rather than showing a blank page. */
  isEmpty: boolean;
};

/** Open requests as plan summaries, keyed by the pharmacy they currently sit on. */
async function loadCleanupRequestSummaries(): Promise<DirectOrderCleanupRequestSummary[]> {
  const supabase = getSupabaseAdmin();
  const rows = await fetchAllRows<Record<string, unknown>>(
    () => supabase.from("direct_order_requests").select("*").in("status", [...DEDUPE_OPEN_STATUSES]),
    "id",
  );
  const requests = rows.map(mapRequestRow);
  if (requests.length === 0) return [];

  // Decided rungs per request — the measure of how much human work a cancellation would discard.
  const stepCounts = new Map<string, number>();
  const stepRows = await fetchAllRows<Record<string, unknown>>(
    () =>
      supabase
        .from("direct_order_approval_steps")
        .select("id, request_id, status")
        .in(
          "request_id",
          requests.map((request) => request.id),
        ),
    "id",
  );
  for (const row of stepRows) {
    if (String(row.status ?? "") !== "approved") continue;
    const key = String(row.request_id ?? "");
    stepCounts.set(key, (stepCounts.get(key) ?? 0) + 1);
  }

  const [nameOf, pharmacies] = await Promise.all([
    nameLookup(),
    loadPharmaciesByIds([...new Set(requests.map((request) => request.pharmacyId))]),
  ]);

  return requests.map((request) => {
    const pharmacy = pharmacies.get(request.pharmacyId) ?? null;
    return {
      requestId: request.id,
      status: request.status,
      productCode: request.productCode,
      productName: request.productName,
      qty: request.qty,
      bonus: request.bonus,
      dealType: request.dealType,
      discountPct: request.discountPct,
      salesValue: request.salesValue,
      collectionDate: request.collectionDate,
      requesterHrId: request.requesterHrId,
      requesterName: nameOf(request.requesterHrId) ?? request.requesterHrId,
      // The row has no submittedAt on the mapped type; createdAt is the submission moment for
      // every direct order (the insert sets both together), and it is what orders the plan.
      submittedAt: request.createdAt,
      approvedStepCount: stepCounts.get(request.id) ?? 0,
      pharmacyId: request.pharmacyId,
      pharmacyCode: pharmacy?.phoenixPharmacyCode ?? "—",
      pharmacyName: pharmacy?.pharmacyName ?? "—",
    };
  });
}

/**
 * Approved orders per venue record — count and value.
 *
 * A second query rather than a widening of `loadCleanupRequestSummaries`, because that function
 * feeds the duplicate-cancel proposal and MUST stay filtered to `DEDUPE_OPEN_STATUSES`: an approved
 * order is money committed and is never a cancellation candidate. What the screen needs is the
 * opposite thing — to SHOW the approved orders it must never offer to touch.
 */
async function loadApprovedTotalsByPharmacy(): Promise<Map<string, { count: number; value: number }>> {
  const supabase = getSupabaseAdmin();
  const rows = await fetchAllRows<Record<string, unknown>>(
    () => supabase.from("direct_order_requests").select("id, pharmacy_id, sales_value").eq("status", "approved"),
    "id",
  );
  const totals = new Map<string, { count: number; value: number }>();
  for (const row of rows) {
    const pharmacyId = String(row.pharmacy_id ?? "");
    if (!pharmacyId) continue;
    const current = totals.get(pharmacyId) ?? { count: 0, value: 0 };
    current.count += 1;
    current.value += Number(row.sales_value ?? 0);
    totals.set(pharmacyId, current);
  }
  return totals;
}

/**
 * What the cleanup would do, and why — computed fresh, never stored.
 *
 * Storing proposals would let a stale plan be confirmed against data that has since moved: a request
 * approved in the meantime, a pharmacy already merged by somebody else. Recomputing on every read
 * makes that impossible, and the apply path re-derives the plan again before it writes anything.
 */
export async function getDirectOrderCleanupPlan(access: AccessContext): Promise<DirectOrderCleanupPlan> {
  assertDirectOrderCleanupAccess(access);
  const supabase = getSupabaseAdmin();

  const pharmacyRows = await fetchAllRows<Record<string, unknown>>(
    () =>
      supabase
        .from("direct_order_pharmacies")
        .select("*")
        // A record already merged away is finished business. Re-proposing it would offer the same
        // merge forever and the screen could never reach empty.
        .is("merged_into_pharmacy_id", null),
    "id",
  );
  const pharmacies = pharmacyRows.map(mapPharmacyRow);
  await attachDistributorCodes(pharmacies);
  const createdAtById = new Map(
    pharmacyRows.map((row) => [String(row.id), row.created_at ? String(row.created_at) : null]),
  );
  const byId = new Map(pharmacies.map((pharmacy) => [pharmacy.id, pharmacy]));

  // Name-code candidates only for the digit-named records — the wrong-box shape. Anything else
  // cannot contribute a name-derived identity key, so searching for it would spend a round trip
  // across the Atlantic per pharmacy for a guaranteed empty result.
  const digitNamed = pharmacies.filter((pharmacy) => /^\d{4,}$/.test(pharmacy.pharmacyName.trim()));
  const candidatesById = new Map<string, DirectOrderPossibleDistributorMatch[]>();
  for (const pharmacy of digitNamed) {
    candidatesById.set(pharmacy.id, await findPossibleDistributorMatchesByPharmacyName(pharmacy.pharmacyName));
  }

  const [nameOf, allRequests, approvedTotals] = await Promise.all([
    nameLookup(),
    loadCleanupRequestSummaries(),
    loadApprovedTotalsByPharmacy(),
  ]);
  const requestsByPharmacy = new Map<string, DirectOrderCleanupRequestSummary[]>();
  for (const request of allRequests) {
    const bucket = requestsByPharmacy.get(request.pharmacyId) ?? [];
    bucket.push(request);
    requestsByPharmacy.set(request.pharmacyId, bucket);
  }

  const summarize = (pharmacy: DirectOrderPharmacy): DirectOrderCleanupPharmacySummary => ({
    pharmacyId: pharmacy.id,
    pharmacyCode: pharmacy.phoenixPharmacyCode,
    pharmacyName: pharmacy.pharmacyName,
    brickId: pharmacy.brickId,
    areaCode: pharmacy.areaCode,
    verificationStatus: pharmacy.verificationStatus,
    active: pharmacy.active,
    createdAt: createdAtById.get(pharmacy.id) ?? null,
    createdByName: nameOf(pharmacy.createdByHrId) ?? pharmacy.createdByHrId,
    linkedCodes: (pharmacy.distributorCodes ?? []).map((pair) => `${pair.distributorName}: ${pair.customerCode}`),
    openRequestCount: (requestsByPharmacy.get(pharmacy.id) ?? []).length,
    approvedRequestCount: approvedTotals.get(pharmacy.id)?.count ?? 0,
    approvedRequestValue: approvedTotals.get(pharmacy.id)?.value ?? 0,
  });

  // Arabic-normalized names for the name+area fallback (owner, 2026-08-13) — computed via
  // phx_normalize_arabic on the server, not reimplemented here, so this can never drift from the
  // one normalization the search box itself already relies on. Fetched for every pharmacy rather
  // than only the codeless subset: at today's row counts (tens, not thousands) the simplicity is
  // worth more than the saved round trip, and groupDuplicatePharmacies ignores the field for any
  // pharmacy that carries even one identity key.
  const { data: normalizedRows, error: normalizeError } = await supabase.rpc(
    "phx_direct_order_pharmacy_normalized_names",
    { p_ids: pharmacies.map((pharmacy) => pharmacy.id) },
  );
  if (normalizeError) throw normalizeError;
  const normalizedNameById = new Map(
    ((normalizedRows ?? []) as Array<{ id: string; normalized_name: string | null }>).map((row) => [
      row.id,
      row.normalized_name ?? "",
    ]),
  );

  // ── 4. Which records are one pharmacy? ──────────────────────────────────────────────────
  // Built once and shared: `findLookAlikeVenues` below must judge the SAME rows against the SAME
  // identity keys the merge pass used, or it could report a pair as unprovable that the merge pass
  // had in fact already clustered.
  const dedupeInput = pharmacies.map((pharmacy) => ({
    id: pharmacy.id,
    phoenixPharmacyCode: pharmacy.phoenixPharmacyCode,
    pharmacyName: pharmacy.pharmacyName,
    brickId: pharmacy.brickId,
    areaCode: pharmacy.areaCode,
    verificationStatus: pharmacy.verificationStatus,
    active: pharmacy.active,
    createdAt: createdAtById.get(pharmacy.id) ?? null,
    linkedCodes: (pharmacy.distributorCodes ?? []).map((pair) => ({
      distributorCode: pair.distributorCode,
      customerCode: pair.customerCode,
    })),
    nameCodeCandidates: (candidatesById.get(pharmacy.id) ?? []).map((match) => ({
      distributorCode: match.distributorCode,
      customerCode: match.customerCode,
    })),
    normalizedName: normalizedNameById.get(pharmacy.id) ?? "",
  }));
  const mergeProposals = groupDuplicatePharmacies(dedupeInput);

  const merges: DirectOrderCleanupMerge[] = [];
  for (const proposal of mergeProposals) {
    const survivor = byId.get(proposal.survivorId);
    if (!survivor) continue;
    const merged = proposal.mergedIds
      .map((id) => byId.get(id))
      .filter((pharmacy): pharmacy is DirectOrderPharmacy => Boolean(pharmacy))
      .map(summarize);
    if (merged.length === 0) continue;
    merges.push({
      survivor: summarize(survivor),
      merged,
      provenBy: proposal.provenBy,
      reason: proposal.reason,
      requestsMoved: proposal.mergedIds.flatMap((id) => requestsByPharmacy.get(id) ?? []),
    });
  }

  // ── 3. Which orders are the same order? Merges fold FIRST, so a duplicate split across two
  //       pharmacy records is still seen as one order — which is exactly how the live pair hid.
  const canonical = canonicalPharmacyMap(mergeProposals);
  const requestById = new Map(allRequests.map((request) => [request.requestId, request]));
  // Every product on every open request. Without these the dedupe key falls back to the request's
  // FIRST line, and two different baskets that happen to start the same would be proposed for
  // cancellation as one order.
  const linesByRequest = await loadDirectOrderItemsForRequests(allRequests.map((request) => request.requestId));
  const duplicateProposals = findDuplicateRequestGroups(
    allRequests.map((request) => ({
      id: request.requestId,
      pharmacyId: request.pharmacyId,
      status: request.status,
      productCode: request.productCode,
      qty: request.qty,
      bonus: request.bonus,
      dealType: request.dealType,
      discountPct: request.discountPct,
      collectionDate: request.collectionDate,
      requesterHrId: request.requesterHrId,
      submittedAt: request.submittedAt,
      approvedStepCount: request.approvedStepCount,
      lines: linesByRequest.get(request.requestId) ?? [],
    })),
    canonical,
  );
  const duplicates: DirectOrderCleanupDuplicate[] = [];
  for (const proposal of duplicateProposals) {
    const keeper = requestById.get(proposal.keeperId);
    if (!keeper) continue;
    const copies = proposal.duplicateIds
      .map((id) => requestById.get(id))
      .filter((request): request is DirectOrderCleanupRequestSummary => Boolean(request));
    if (copies.length === 0) continue;
    duplicates.push({ keeper, duplicates: copies, reason: proposal.reason });
  }

  // ── 1. Codes in the wrong field that the repair pass can move. Runs the SAME
  //       decideDirectOrderAutoLink the live paths run, with ownership resolved, so the plan can
  //       never offer a link the writer would refuse.
  const repairs: DirectOrderCleanupRepair[] = [];
  for (const pharmacy of digitNamed) {
    if ((pharmacy.distributorCodes ?? []).length > 0) continue;
    const owned = await attachCandidateOwnership(pharmacy.id, candidatesById.get(pharmacy.id) ?? []);
    const decision = decideDirectOrderAutoLink({
      pharmacyName: pharmacy.pharmacyName,
      existingCodes: pharmacy.distributorCodes ?? [],
      candidates: owned.map((match) => ({ ...match, ownedByOtherPharmacyId: match.ownedByPharmacyCode })),
    });
    if (!decision.link) continue;
    repairs.push({
      pharmacyId: pharmacy.id,
      pharmacyCode: pharmacy.phoenixPharmacyCode,
      pharmacyName: pharmacy.pharmacyName,
      distributorCode: decision.candidate.distributorCode,
      distributorName: decision.candidate.distributorName,
      customerCode: decision.candidate.customerCode,
      renameTo: decision.renameTo,
    });
  }

  // ── 2. Every held request on a pharmacy the cleanup resolves. Pharmacy-level, never
  //       request-level: resolving the pharmacy resolves ALL of its requests.
  const cancelledIds = new Set(duplicates.flatMap((group) => group.duplicates.map((request) => request.requestId)));
  const resolvedPharmacyIds = new Set<string>([
    ...merges.map((merge) => merge.survivor.pharmacyId),
    ...repairs.map((repair) => repair.pharmacyId),
  ]);
  const releases: DirectOrderCleanupRelease[] = [];
  for (const pharmacyId of resolvedPharmacyIds) {
    const pharmacy = byId.get(pharmacyId);
    // Held requests on the survivor AND on every record folding into it — after the merge they all
    // belong to the survivor, so they all release together.
    const merge = merges.find((entry) => entry.survivor.pharmacyId === pharmacyId);
    const sourceIds = [pharmacyId, ...(merge?.merged ?? []).map((entry) => entry.pharmacyId)];
    const held = sourceIds
      .flatMap((id) => requestsByPharmacy.get(id) ?? [])
      .filter((request) => request.status === "held" && !cancelledIds.has(request.requestId));
    if (held.length === 0) continue;
    releases.push({
      pharmacyId,
      pharmacyCode: pharmacy?.phoenixPharmacyCode ?? "—",
      pharmacyName: pharmacy?.pharmacyName ?? "—",
      requests: held,
    });
  }

  // ── Same name, same area, and NOT provable. Shown, never proposed. ──────────────────────
  const lookAlikes: DirectOrderCleanupLookAlike[] = findLookAlikeVenues(dedupeInput, mergeProposals).map(
    (group) => ({
      normalizedName: group.normalizedName,
      areaCode: group.areaCode,
      blocker: group.blocker,
      explanation: group.explanation,
      members: group.memberIds
        .map((id) => byId.get(id))
        .filter((pharmacy): pharmacy is DirectOrderPharmacy => Boolean(pharmacy))
        .map(summarize),
    }),
  );

  return {
    merges,
    duplicates,
    repairs,
    releases,
    lookAlikes,
    // `lookAlikes` is deliberately NOT part of this. "Empty" means there is nothing to APPLY, and a
    // look-alike is never applied — a page showing only look-alikes still renders (the component
    // checks both), but the confirm bar must not offer to write nothing.
    isEmpty: merges.length === 0 && duplicates.length === 0 && repairs.length === 0 && releases.length === 0,
  };
}

/** What an SFE Manager confirmed, after any edits they made to the proposal. */
export type DirectOrderCleanupConfirmation = {
  /** survivorId → the ids to fold into it. An empty list, or an absent survivor, skips the merge. */
  merges?: Array<{ survivorId: string; mergedIds: string[] }>;
  /** keeperId → the ids to cancel as duplicates of it. */
  duplicates?: Array<{ keeperId: string; duplicateIds: string[] }>;
  /** Pharmacy ids whose wrong-box code should be moved into its column. */
  repairPharmacyIds?: string[];
  /** Pharmacy ids whose held requests should be released. */
  releasePharmacyIds?: string[];
  reason: string;
};

export type DirectOrderCleanupResult = {
  pharmaciesMerged: number;
  requestsMoved: number;
  requestsCancelled: number;
  codesRepaired: number;
  requestsReleased: number;
};

/**
 * Apply the cleanup an SFE Manager confirmed.
 *
 * ORDER MATTERS and is not arbitrary:
 *   1. merge pharmacies   — moves requests onto the survivor
 *   2. repair codes       — the survivor may be the record that still needs its code moved
 *   3. cancel duplicates  — after the merge, so both copies are visible on one pharmacy
 *   4. release held       — last, once the pharmacy is finally resolved (owner rule 2)
 *
 * Every step is re-validated against live data rather than trusting the submitted ids: the plan the
 * reviewer read may be minutes old, and in that time an order can be approved or a pharmacy merged
 * by somebody else. A step whose precondition no longer holds is SKIPPED and counted, never forced.
 */
export async function confirmDirectOrderCleanup(
  access: AccessContext,
  input: DirectOrderCleanupConfirmation,
): Promise<DirectOrderCleanupResult> {
  assertDirectOrderCleanupAccess(access);
  const reason = String(input.reason ?? "").trim();
  if (!reason) badRequest("Say why this cleanup is being applied — the reason is the record.");
  const supabase = getSupabaseAdmin();
  const actorHrId = requireActorHrId(access);
  const result: DirectOrderCleanupResult = {
    pharmaciesMerged: 0,
    requestsMoved: 0,
    requestsCancelled: 0,
    codesRepaired: 0,
    requestsReleased: 0,
  };

  // ── 1. Merge pharmacies ────────────────────────────────────────────────────────────────
  for (const merge of input.merges ?? []) {
    const ids = (merge.mergedIds ?? []).filter((id) => id && id !== merge.survivorId);
    if (!merge.survivorId || ids.length === 0) continue;
    const loaded = await loadPharmaciesByIds([merge.survivorId, ...ids]);
    const survivor = loaded.get(merge.survivorId);
    if (!survivor) continue;

    for (const mergedId of ids) {
      const loser = loaded.get(mergedId);
      if (!loser) continue;

      // Move the requests. Guarded on the losing pharmacy so a request that moved in the meantime
      // is not dragged back.
      const { data: moved, error: moveError } = await supabase
        .from("direct_order_requests")
        .update({ pharmacy_id: merge.survivorId })
        .eq("pharmacy_id", mergedId)
        .select("id");
      if (moveError) throw moveError;
      result.requestsMoved += (moved ?? []).length;

      // Carry over any distributor code the loser holds and the survivor does not. Rare — usually
      // the loser is the record with NO code — but dropping one would lose the link that proved the
      // merge in the first place.
      for (const pair of loser.distributorCodes ?? []) {
        const alreadyOnSurvivor = (survivor.distributorCodes ?? []).some(
          (existing) =>
            existing.distributorCode.toUpperCase() === pair.distributorCode.toUpperCase() &&
            customerCodesMatch(existing.customerCode, pair.customerCode),
        );
        if (alreadyOnSurvivor) continue;
        const { error: moveCodeError } = await supabase
          .from("direct_order_pharmacy_distributor_codes")
          .update({ pharmacy_id: merge.survivorId })
          .eq("pharmacy_id", mergedId)
          .eq("distributor_code", pair.distributorCode)
          .eq("customer_code", pair.customerCode);
        // A unique-violation here means the survivor already holds it — the desired end state.
        if (moveCodeError && String((moveCodeError as { code?: string }).code) !== "23505") throw moveCodeError;
      }

      const { error: markError } = await supabase
        .from("direct_order_pharmacies")
        .update({
          merged_into_pharmacy_id: merge.survivorId,
          merged_at: new Date().toISOString(),
          merged_by_hr_id: actorHrId,
          // Deactivating is what actually removes it from the picker and the directory search —
          // twelve query sites filter on `active`. A merged-but-active row would be a duplicate the
          // rest of the module still offers, which is how the second copy got created.
          active: false,
          updated_at: new Date().toISOString(),
        })
        .eq("id", mergedId)
        .is("merged_into_pharmacy_id", null);
      if (markError) throw markError;
      result.pharmaciesMerged += 1;

      await writeRequiredAuditLog({
        actorLoginId: access.loginId ?? access.hrId,
        entityType: "direct_order_request",
        entityId: `pharmacy:${mergedId}`,
        oldValues: { pharmacyName: loser.pharmacyName, active: true, mergedIntoPharmacyId: null },
        newValues: { mergedIntoPharmacyId: merge.survivorId, active: false },
        summary:
          `Pharmacy "${loser.pharmacyName}" (${loser.phoenixPharmacyCode}) merged into ` +
          `"${survivor.pharmacyName}" (${survivor.phoenixPharmacyCode}) — the same distributor customer ` +
          `proves they are one pharmacy. ${countOf((moved ?? []).length, "request")} moved. Reason: ${reason}`,
      });
    }
  }

  // ── 2. Repair codes sitting in the wrong field ─────────────────────────────────────────
  for (const pharmacyId of input.repairPharmacyIds ?? []) {
    const outcome = await autoLinkDirectOrderPharmacyCode(pharmacyId, { actorLoginId: access.loginId ?? access.hrId });
    if (outcome.linked) result.codesRepaired += 1;
  }

  // ── 3. Cancel duplicates ───────────────────────────────────────────────────────────────
  for (const group of input.duplicates ?? []) {
    if (!group.keeperId) continue;
    for (const duplicateId of group.duplicateIds ?? []) {
      if (!duplicateId || duplicateId === group.keeperId) continue;
      const { data: row } = await supabase
        .from("direct_order_requests")
        // The whole row, not `id, status`. The notification below needs the requester and the
        // pharmacy, and a narrowed select would hand it `undefined` for both rather than fail —
        // the notice would still "send", addressed to nobody.
        .select("*")
        .eq("id", duplicateId)
        .maybeSingle();
      const status = String((row as { status?: string } | null)?.status ?? "");
      // Re-validated against LIVE status, not the plan's. An order approved since the plan was read
      // is money committed and must be reversed, never quietly cancelled as a duplicate.
      if (!(DEDUPE_OPEN_STATUSES as readonly string[]).includes(status)) continue;

      await assertDirectOrderWorkflowTransition({
        access,
        actionKey: "cancel_duplicate",
        expectedNextStatus: "cancelled",
        status,
      });

      const { data: updated, error: cancelError } = await supabase
        .from("direct_order_requests")
        .update({ ...decidedStatusPatch("cancelled"), duplicate_of_request_id: group.keeperId })
        .eq("id", duplicateId)
        .eq("status", status)
        .select("id");
      if (cancelError) throw cancelError;
      // An empty result means the status moved between the read and the write. Skipping is correct;
      // reporting it as cancelled would tell the reviewer a live order had been closed.
      if (!updated || updated.length === 0) continue;
      result.requestsCancelled += 1;

      await insertEvent({
        requestId: duplicateId,
        actorHrId,
        eventType: "cancelled",
        message: `Cancelled as a duplicate of ${group.keeperId}.`,
        metadata: { duplicateOfRequestId: group.keeperId, confirmedBy: actorHrId, reason },
      });
      await writeRequiredAuditLog({
        actorLoginId: access.loginId ?? access.hrId,
        entityType: "direct_order_request",
        entityId: duplicateId,
        oldValues: { status },
        newValues: { status: "cancelled", duplicateOfRequestId: group.keeperId },
        summary:
          `Direct order cancelled as a confirmed duplicate of ${group.keeperId} — same pharmacy, product, ` +
          `quantity, deal terms and collection date. Reason: ${reason}`,
      });

      // The workflow registry has declared `notify requester + CC` for this action since it was
      // added (2026-08-09), and nothing here ever sent it: the event row and the audit row are both
      // admin-side, so an order was closed under its requester without a word reaching them. The
      // gap is invisible from the registry screen, which shows the DECLARATION, not the behaviour.
      //
      // `cancel_held` — the sibling that also ends at `cancelled` and declares the same recipients —
      // has always notified, so this is that notice, with its channel choice kept deliberately:
      // in-app and Telegram reach requester + SFE + Super Admin, and email is dropped, because
      // having one's own superseded duplicate tidied away is not news worth an inbox entry.
      const duplicateRequest = mapRequestRow(row as Record<string, unknown>);
      const resolveName = await nameLookup();
      const requesterDisplayName =
        resolveName(duplicateRequest.requesterHrId) ?? duplicateRequest.requesterHrId;
      const duplicatePharmacy =
        (await loadPharmaciesByIds([duplicateRequest.pharmacyId])).get(duplicateRequest.pharmacyId) ?? null;
      const notifyContext = await buildNotifyContext(duplicateRequest, requesterDisplayName, duplicatePharmacy);
      await notifyDirectOrder({
        recipients: [duplicateRequest.requesterHrId, ...(await ccRecipients())],
        channels: ["in_app", "telegram"],
        title: "Direct order cancelled as a duplicate",
        message:
          `${buildDirectOrderNotificationLine(notifyContext)} ` +
          `It was cancelled as a duplicate of the request that was kept, confirmed by ` +
          `${resolveName(actorHrId) ?? actorHrId}. Reason: ${reason}`,
        metrics: buildDirectOrderNotificationMetrics(notifyContext),
        eventType: "cancelled",
        requestId: duplicateId,
        subjectHrId: duplicateRequest.requesterHrId,
      });
    }
  }

  // ── 4. Release every held request on each resolved pharmacy (owner rule 2) ─────────────
  for (const pharmacyId of input.releasePharmacyIds ?? []) {
    const pharmacy = (await loadPharmaciesByIds([pharmacyId])).get(pharmacyId) ?? null;
    if (!pharmacy) continue;
    // Re-run the SAME hold rule the submit fork runs. A pharmacy the cleanup did not actually manage
    // to prove must stay held — the cleanup releases what it fixed, never everything it touched.
    const decision = decideDirectOrderHold({
      verificationStatus: pharmacy.verificationStatus,
      declaredBrickId: pharmacy.brickId,
      distributorCodes: await attachCodeOwnership(pharmacy),
      holdReleaseGround: pharmacy.holdReleaseGround,
    });
    if (decision.hold) continue;
    result.requestsReleased += await moveHeldDirectOrdersIntoChain(access, pharmacyId, {
      actionKey: "release_held",
      eventType: "released",
      auditSummary: (releasedBy: string) =>
        `Direct order released from the held lane by the duplicate cleanup, confirmed by ${releasedBy}. Reason: ${reason}`,
      eventMessage: "Released after the duplicate cleanup resolved this pharmacy.",
      noticeTitle: "Direct order released — the pharmacy has been resolved",
      noticeSuffix:
        "The duplicate cleanup resolved this pharmacy, so this request has entered the approval chain " +
        "at step 1 (SFE Manager).",
    });
  }

  pingDirectOrderSheet("cleanup_applied");
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// APPROVAL EXCEPTIONS — orders stuck on a rung nobody can act on.
//
// THE FAILURE. `buildApprovalChain` climbs `manager_hr_id` from the requester upward. When a link
// points at an HR_ID the employee directory does not carry — someone departed, or the field was
// mistyped — the rung is still created, bound to that raw HR_ID. Nobody can ever act on it: a
// session's HR_ID always comes FROM the directory, so it can never equal one that is not in it. The
// order sits at `pending_approval` indefinitely, and the only symptom is a requester eventually
// asking why nothing has happened.
//
// fe60edc0 made the break VISIBLE — the rung is labelled `Unresolved manager (<hr_id>)` and a
// `direct_order_chain_unresolved_manager` line is logged. This is the other half: a way to FIND
// them without reading logs, and a way OUT that weakens nothing.
//
// WHY A REBIND AND NOT AN OVERRIDE. The tempting fix is "let a System Admin approve on their
// behalf". That silently deletes an approval the business asked for, at the exact moment nobody is
// watching closely. Re-addressing the rung keeps every approval the chain demanded — the order
// still owes the same number of yeses, from the same seats — and changes only the fact that the
// person it is addressed to exists.
// ─────────────────────────────────────────────────────────────────────────────

export type DirectOrderApprovalExceptionRow = {
  requestId: string;
  stepId: string;
  stepOrder: number;
  /** The HR_ID on the rung — the one the directory has no record of. Shown so it can be fixed at source too. */
  unresolvedApproverHrId: string;
  stepLabel: string;
  requesterHrId: string;
  requesterName: string;
  requesterRole: PhoenixRole;
  /** Every product joined with " + " on a basket; the one product's name otherwise. */
  productName: string;
  /** The one product's units; NULL on a basket — units of different products are never added. */
  qty: number | null;
  /** One entry per product, each with ITS OWN units. What the desk prints. */
  items: DirectOrderBasketLine[];
  salesValue: number;
  pharmacyName: string;
  createdAt: string | null;
  /** Whole days this order has been waiting on a rung nobody can act on. */
  daysStuck: number;
  /**
   * The requester's manager AS THE DIRECTORY READS IT TODAY, where that resolves.
   *
   * A SUGGESTION, never an automatic action. The directory is the thing that was wrong, so a System
   * Admin confirms the person rather than the system quietly picking one. Null means even today's
   * chain cannot resolve a manager, and the repair needs a name typed in.
   */
  suggestedApproverHrId: string | null;
  suggestedApproverName: string | null;
  suggestedApproverJobTitle: string | null;
};

/** Super Admin only, exactly like the Held Desk — the desk's action is a repair, and its gate says so. */
function assertApprovalExceptionDeskAccess(access: AccessContext): void {
  if (!(access.scope === "system" || access.role === "Super Admin")) {
    throw new Error("Forbidden: the Approval Exceptions desk is System Admin only.");
  }
}

/**
 * Every in-flight order whose PENDING rung is addressed to somebody the directory does not know.
 *
 * Deliberately NOT scoped to the viewer's line. This is a system-integrity desk, not a management
 * view: a District Manager's departed manager is precisely the record a System Admin has to see,
 * and the gate above already decides who reaches it.
 *
 * Role rungs (SFE Manager, CEO) cannot appear here by construction — they carry no
 * `approver_hr_id` and resolve to whoever holds the post today, which is why they can never strand
 * an order.
 */
export async function listDirectOrderApprovalExceptions(
  access: AccessContext,
): Promise<DirectOrderApprovalExceptionRow[]> {
  assertApprovalExceptionDeskAccess(access);
  const supabase = getSupabaseAdmin();

  // Pending PERSON rungs. `approver_hr_id is not null` excludes the role rungs without depending on
  // `approver_kind`, and a role rung with a stray HR_ID would still be worth surfacing.
  const { data: stepRows, error: stepError } = await supabase
    .from("direct_order_approval_steps")
    .select("id, request_id, step_order, approver_hr_id, label, status")
    .eq("status", "pending")
    .not("approver_hr_id", "is", null);
  if (stepError) throw stepError;

  const steps = (stepRows ?? []) as Array<Record<string, unknown>>;
  if (steps.length === 0) return [];

  const directory = await getEmployeeDirectory();
  const lookup = directoryLookup(directory);

  // THE TEST IS DIRECTORY MEMBERSHIP, and that is not a shortcut: getEmployeeDirectory returns
  // `activeEmployees`, so "not in the directory" already means "not an active employee". A separate
  // liveness check would be a SECOND rule that could disagree with the one buildApprovalChain uses,
  // and disagreeing copies of one rule is the failure mode this module keeps re-learning.
  const broken = steps.filter((step) => !lookup(String(step.approver_hr_id ?? "")));
  if (broken.length === 0) return [];

  // Only the affected requests, and only those still IN FLIGHT. A pending step survives on a
  // rejected or cancelled order; listing those would be a queue of work nobody needs to do.
  const requestIds = Array.from(new Set(broken.map((step) => String(step.request_id))));
  const { data: requestRows, error: requestError } = await supabase
    .from("direct_order_requests")
    .select("*")
    .in("id", requestIds)
    .eq("status", "pending_approval");
  if (requestError) throw requestError;

  const requests = new Map(
    ((requestRows ?? []) as Array<Record<string, unknown>>)
      .map(mapRequestRow)
      .map((request) => [request.id, request] as const),
  );
  if (requests.size === 0) return [];

  // Three independent reads — none needs another's result — batched together.
  const [pharmacies, resolveName, itemsByRequest] = await Promise.all([
    loadPharmaciesByIds(Array.from(requests.values()).map((request) => request.pharmacyId)),
    nameLookup(),
    loadDirectOrderItemsForRequests(Array.from(requests.values()).map((request) => request.id)),
  ]);
  const now = Date.now();

  const rows: DirectOrderApprovalExceptionRow[] = [];
  for (const step of broken) {
    const request = requests.get(String(step.request_id));
    if (!request) continue;

    // Today's answer to "who is this person's manager", offered as a starting point. The requester
    // is looked up FRESH rather than read off the stored chain — the stored chain is the thing
    // that is wrong.
    const requester = lookup(request.requesterHrId);
    const suggested = requester?.managerHrId ? lookup(requester.managerHrId) : null;

    const createdAt = request.createdAt ? new Date(request.createdAt).getTime() : null;
    const basket = summarizeDirectOrderBasket(request, itemsByRequest.get(request.id));
    rows.push({
      requestId: request.id,
      stepId: String(step.id),
      stepOrder: Number(step.step_order ?? 0),
      unresolvedApproverHrId: String(step.approver_hr_id ?? ""),
      stepLabel: String(step.label ?? ""),
      requesterHrId: request.requesterHrId,
      requesterName: resolveName(request.requesterHrId) ?? request.requesterHrId,
      requesterRole: request.requesterRole,
      productName: basket.productName,
      qty: basket.qty,
      items: basket.lines,
      salesValue: request.salesValue,
      pharmacyName: pharmacies.get(request.pharmacyId)?.pharmacyName ?? "—",
      createdAt: request.createdAt,
      daysStuck: createdAt ? Math.max(0, Math.floor((now - createdAt) / 86_400_000)) : 0,
      suggestedApproverHrId: suggested?.hrId ?? null,
      suggestedApproverName: suggested ? resolveName(suggested.hrId) ?? suggested.hrId : null,
      suggestedApproverJobTitle: suggested?.jobTitle?.trim() || null,
    });
  }

  // Longest-stuck first: these are orders somebody has already been waiting on.
  rows.sort((a, b) => b.daysStuck - a.daysStuck);
  return rows;
}

/**
 * Re-address ONE stuck rung to a person who exists. The order itself does not move.
 *
 * EVERY GUARD BELOW IS THE DIFFERENCE BETWEEN A REPAIR AND AN OVERRIDE, so none of them is
 * defensive boilerplate:
 *
 *   - Super Admin only, matching the registry row and the desk's own gate.
 *   - The registry transition is asserted, so this is governed like every other action in the
 *     module rather than being its one hand-rolled exception.
 *   - THE RUNG MUST ACTUALLY BE BROKEN. Repairing a healthy rung is not repairing anything — it
 *     is choosing somebody else's approver, which IS the approval chain. This is the guard that
 *     stops the desk becoming a way around an approver who keeps saying no.
 *   - The new approver must resolve in the directory, or the repair recreates the fault it fixes.
 *   - The new approver may not be the requester. Nobody approves their own order, and a repair path
 *     is exactly where that would slip in unnoticed.
 *   - Compare-and-swap on the status AND the broken HR_ID, so two admins acting at once cannot
 *     overwrite a decision that landed in between.
 *   - A reason is required and recorded — the registry declares requiresReason, and the next
 *     person to read this order needs to know why its chain changed.
 */
export async function repairDirectOrderApprovalRung(
  access: AccessContext,
  input: { requestId: string; stepId: string; newApproverHrId: string; reason: string },
): Promise<{ stepId: string; approverHrId: string; label: string }> {
  assertApprovalExceptionDeskAccess(access);

  const reason = String(input.reason ?? "").trim();
  if (!reason) badRequest("A reason is required: this changes who an in-flight order is waiting on.");

  const supabase = getSupabaseAdmin();

  const { data: requestRow, error: requestError } = await supabase
    .from("direct_order_requests")
    .select("*")
    .eq("id", input.requestId)
    .maybeSingle();
  if (requestError) throw requestError;
  if (!requestRow) badRequest("That direct order no longer exists.");
  const request = mapRequestRow(requestRow as Record<string, unknown>);

  // Gated on the ROW'S REAL STATUS (audit F6), never a constant. A request approved or rejected
  // while this desk sat open must be refused here rather than repaired against an assumption.
  await assertDirectOrderWorkflowTransition({
    access,
    actionKey: "repair_approval_rung",
    expectedNextStatus: "pending_approval",
    status: request.status,
  });

  const { data: stepRow, error: stepError } = await supabase
    .from("direct_order_approval_steps")
    .select("id, request_id, step_order, approver_hr_id, label, status")
    .eq("id", input.stepId)
    .maybeSingle();
  if (stepError) throw stepError;
  if (!stepRow) badRequest("That approval step no longer exists.");
  const step = stepRow as Record<string, unknown>;

  if (String(step.request_id) !== request.id) {
    badRequest("That approval step belongs to a different direct order.");
  }
  if (String(step.status) !== "pending") {
    badRequest("That rung has already been decided — there is nothing stuck to repair.");
  }

  const currentApproverHrId = step.approver_hr_id ? String(step.approver_hr_id) : "";
  if (!currentApproverHrId) {
    badRequest(
      "That rung is a ROLE rung — it resolves to whoever holds the post today and cannot strand an order.",
    );
  }

  const directory = await getEmployeeDirectory();
  const lookup = directoryLookup(directory);

  if (lookup(currentApproverHrId)) {
    badRequest(
      `${currentApproverHrId} is a current employee, so this rung is not stuck. This desk repairs ` +
        "chains addressed to records the directory has lost; it is not a way to change who approves an order.",
    );
  }

  const nextApprover = lookup(input.newApproverHrId);
  if (!nextApprover) {
    badRequest(
      `${input.newApproverHrId} is not an active employee, so addressing the rung to them would leave ` +
        "the order exactly as stuck as it is now.",
    );
  }
  if (canonicalHrIdKey(nextApprover.hrId) === canonicalHrIdKey(request.requesterHrId)) {
    badRequest("The person who raised an order cannot be made its approver.");
  }

  const label = nextApprover.jobTitle?.trim() || "Manager";
  const { data: updated, error: updateError } = await supabase
    .from("direct_order_approval_steps")
    .update({ approver_hr_id: nextApprover.hrId, label })
    .eq("id", input.stepId)
    .eq("status", "pending")
    .eq("approver_hr_id", currentApproverHrId)
    .select("id");
  if (updateError) throw updateError;
  if ((updated ?? []).length === 0) {
    badRequest("That rung changed a moment ago — reload the desk and check its current state.");
  }

  const resolveName = await nameLookup();
  const requesterName = resolveName(request.requesterHrId) ?? request.requesterHrId;
  const newApproverName = resolveName(nextApprover.hrId) ?? nextApprover.hrId;

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    // Namespaced on the STEP, following the `pharmacy:<id>` convention already used here: the row
    // that changed is the step, and an audit line pointing at the request alone would not say which.
    entityId: `approval_step:${String(step.id)}`,
    oldValues: { approverHrId: currentApproverHrId, label: String(step.label ?? "") },
    newValues: { approverHrId: nextApprover.hrId, label, reason, requestId: request.id },
    summary:
      `Direct order approval rung ${Number(step.step_order ?? 0)} re-addressed from unresolvable ` +
      `${currentApproverHrId} to ${newApproverName}`,
  });

  await insertEvent({
    requestId: request.id,
    actorHrId: access.hrId,
    eventType: "approval_rung_repaired",
    message:
      `Step ${Number(step.step_order ?? 0)} was addressed to ${currentApproverHrId}, who is not in the ` +
      `employee directory, so nobody could act on it. Re-addressed to ${newApproverName}. Reason: ${reason}`,
    metadata: {
      stepId: String(step.id),
      previousApproverHrId: currentApproverHrId,
      newApproverHrId: nextApprover.hrId,
      reason,
    },
  });

  // The new approver has inherited a queue item they never saw arrive, and the requester has been
  // waiting without being told why. Both are told — after the reply (afterResponse): the rung is repaired.
  await afterResponse("direct_order_notice:rung_repaired", () =>
    notifyDirectOrder({
      requestId: request.id,
      subjectHrId: request.requesterHrId,
      eventType: "approval_rung_repaired",
      recipients: [nextApprover.hrId, request.requesterHrId],
      title: "A direct order is now waiting on you",
      message:
        `${request.productName} × ${request.qty} for ${requesterName} was stuck: its next approval was ` +
        "addressed to an employee record that no longer exists. It is now with you.",
      metrics: [
        { label: "Reason", value: reason },
        { label: "Previously addressed to", value: currentApproverHrId },
      ],
    }),
  );

  return { stepId: String(step.id), approverHrId: nextApprover.hrId, label };
}
