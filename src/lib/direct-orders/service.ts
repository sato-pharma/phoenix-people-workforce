import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { ceoHrIds } from "@/lib/employees/role-lookup";
import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import { assertPermission, normalizeHrId, resolveEmployeeIdentityId, systemAccessContext } from "@/lib/auth/permissions";
import {
  getEmployeeDirectory,
  type EmployeeDirectoryData,
  type EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { validationError } from "@/lib/http/api-errors";
import { createSystemNotification, type SystemNotificationChannel } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { canonicalizeRegionName, resolveSalesAccessScope } from "@/lib/sales/access-scope";
import { listSourceOfSalesProducts, loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { resolveRegionalManagerRegionCodes } from "@/lib/sales/portal-sos-dashboard";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import {
  computeDirectOrderSalesValue,
  computeDiscountSalesValue,
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
  type DirectOrderApprovalDetail,
  type DirectOrderAreaRep,
  type DirectOrderPharmacyGeo,
  type DirectOrderPharmacyHistoryRow,
  type DirectOrderRetailHistoryRow,
  type DirectOrderApprovalListItem,
  type DirectOrderDealType,
  type DirectOrderDecision,
  type DirectOrderPharmacy,
  type DirectOrderPharmacyDistributorCode,
  type DirectOrderReportRow,
  type DirectOrderReportScope,
  type DirectOrderRequest,
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

/**
 * True when a BONUS request's value fell back to the factory price because its product had no
 * pharmacy price at submit time.
 *
 * Deliberately derived from the SNAPSHOT, not from the live product master — the opposite
 * choice to isRequestOverCap above, and for the opposite reason. A cap is config that may
 * legitimately change; this is a fact about how THIS row's sales_value was actually computed.
 * Re-deriving it from the master would silently clear the flag the day the owner sets a
 * pharmacy price, on a row whose stored value was never recomputed.
 */
function isFallbackPricedRequest(
  request: Pick<DirectOrderRequest, "dealType" | "pharmacyPriceSnapshot">,
): boolean {
  return request.dealType === "bonus" && request.pharmacyPriceSnapshot == null;
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
}): Promise<void> {
  const href = input.href ?? `/admin/approvals/direct-orders/${encodeURIComponent(input.requestId)}`;
  const recipientHrIds = Array.from(
    new Map(
      input.recipients
        .map((r) => normalizeHrId(r) ?? "")
        .filter(Boolean)
        .map((hrId) => [canonicalHrIdKey(hrId) ?? hrId, hrId] as const),
    ).values(),
  );
  await Promise.allSettled(
    recipientHrIds.map((recipientHrId) =>
      createSystemNotification({
        channels: NOTIFY_CHANNELS,
        actionUrl: href,
        category: "direct_order_request",
        email: input.metrics?.length ? { metrics: input.metrics } : undefined,
        eventType: input.eventType,
        message: input.message,
        metadata: {
          employeeHrId: input.subjectHrId,
          directOrderId: input.requestId,
          idempotencyKey: `direct_orders:${input.requestId}:${input.eventType}:${recipientHrId}`,
        },
        module: "direct_orders",
        priority: "high",
        recipientHrId,
        subjectHrId: input.subjectHrId,
        title: input.title,
      }),
    ),
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
      rungs.push({
        kind: "person",
        role: null,
        approverHrId: manager?.hrId ?? cursor,
        label: manager?.jobTitle?.trim() || "Manager",
      });
      cursor = manager?.managerHrId ?? null;
      guard += 1;
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
    factoryPriceSnapshot: Number(row.factory_price_snapshot ?? 0),
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
    marketingRequestId: row.marketing_request_id ? String(row.marketing_request_id) : null,
    paymentDate: row.payment_date ? String(row.payment_date) : null,
    paidAmount: row.paid_amount == null ? null : Number(row.paid_amount),
    remainingAmount: row.remaining_amount == null ? null : Number(row.remaining_amount),
    sosBatchId: row.sos_batch_id ? String(row.sos_batch_id) : null,
    reversalOfRequestId: row.reversal_of_request_id ? String(row.reversal_of_request_id) : null,
    reversedByRequestId: row.reversed_by_request_id ? String(row.reversed_by_request_id) : null,
    createdAt: String(row.created_at ?? ""),
    decidedAt: row.decided_at ? String(row.decided_at) : null,
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
    actor_hr_id: input.actorHrId,
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
    .eq("created_by_hr_id", access.hrId)
    .eq("active", true)
    .order("pharmacy_name", { ascending: true });
  if (error) throw error;
  const pharmacies = ((data ?? []) as Array<Record<string, unknown>>).map(mapPharmacyRow);
  await attachDistributorCodes(pharmacies);
  return pharmacies;
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
    distributorCodes: [],
    geoVarianceResolved: row.geo_variance_resolved === true,
    verificationStatus: String(row.verification_status ?? "verified") === "pending_review" ? "pending_review" : "verified",
    entrySource: String(row.entry_source ?? "catalogue") === "manual" ? "manual" : "catalogue",
    verifiedByHrId: row.verified_by_hr_id ? String(row.verified_by_hr_id) : null,
    verifiedAt: row.verified_at ? String(row.verified_at) : null,
    createdByHrId: String(row.created_by_hr_id),
    active: row.active !== false,
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
 * Look each (distributor, customer code) up in the customer map to recover its geography.
 *
 * Skipped entirely when there are no codes: `.in(col, [])` is not a harmless no-op in PostgREST,
 * and there is nothing to resolve anyway. A miss is normal and never an error — it simply means
 * the code is not one the distributor has reported sales against yet.
 */
async function resolveCustomerCodeGeography(
  byDistributor: Map<string, string>,
): Promise<Map<string, { brick: string | null; area: string | null; region: string | null }>> {
  const mapByKey = new Map<string, { brick: string | null; area: string | null; region: string | null }>();
  if (byDistributor.size === 0) return mapByKey;
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("source_of_sales_customer_map")
    .select("distributor_code, customer_code, brick_id, area_code, region_code")
    .in("distributor_code", Array.from(byDistributor.keys()))
    .in("customer_code", Array.from(byDistributor.values()));
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    mapByKey.set(`${row.distributor_code}::${row.customer_code}`, {
      brick: row.brick_id ? String(row.brick_id) : null,
      area: row.area_code ? String(row.area_code) : null,
      region: row.region_code ? String(row.region_code) : null,
    });
  }
  return mapByKey;
}

/** Child rows for a pharmacy's codes, each carrying whatever geography the customer map knew. */
function buildDistributorCodeRows(
  pharmacyId: string,
  byDistributor: Map<string, string>,
  mapByKey: Map<string, { brick: string | null; area: string | null; region: string | null }>,
): Array<Record<string, unknown>> {
  return Array.from(byDistributor.entries()).map(([distributorCode, customerCode]) => {
    const mapped = mapByKey.get(`${distributorCode}::${customerCode}`);
    return {
      pharmacy_id: pharmacyId,
      distributor_code: distributorCode,
      customer_code: customerCode,
      mapped_brick_id: mapped?.brick ?? null,
      mapped_area_code: mapped?.area ?? null,
      mapped_region_code: mapped?.region ?? null,
    };
  });
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
  },
): Promise<DirectOrderPharmacy> {
  await assertPermission(access, "direct_orders", "create");
  const name = input.pharmacyName?.trim();
  if (!name) badRequest("Pharmacy name is required.");
  const doctorName = input.doctorName?.trim();
  if (!doctorName) badRequest("Doctor name is required.");
  const pharmacyAddress = input.pharmacyAddress?.trim();
  if (!pharmacyAddress) badRequest("Pharmacy address is required.");

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
  // Every hand-registered pharmacy starts UNRECOGNISED, and the row says so from the first insert
  // rather than being corrected a moment later (owner rule, 2026-08-04 — "the three situations").
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
  const { data: pharmacyRow, error } = await supabase
    .from("direct_order_pharmacies")
    .insert({
      pharmacy_name: name,
      brick_id: input.brickId ?? null,
      area_code: input.areaCode ?? null,
      region_code: input.regionCode ?? null,
      doctor_name: doctorName,
      pharmacy_address: pharmacyAddress,
      created_by_hr_id: access.hrId,
      verification_status: "pending_review",
      entry_source: "manual",
    })
    .select("*")
    .single();
  if (error) throw error;
  const pharmacyId = String((pharmacyRow as Record<string, unknown>).id);

  // Resolve each (distributor, customer code) → brick via the customer map (best-effort).
  const mapByKey = await resolveCustomerCodeGeography(byDistributor);
  if (byDistributor.size > 0) {
    const { error: childError } = await supabase
      .from("direct_order_pharmacy_distributor_codes")
      .insert(buildDistributorCodeRows(pharmacyId, byDistributor, mapByKey));
    if (childError) throw childError;
  }

  // Record WHY this pharmacy is awaiting review, in the reviewer's own terms. The state itself is
  // already decided (every hand-registered pharmacy waits); this is the audit trail that tells the
  // System Admin what to actually check, which is a different question for each situation.
  const unresolved = Array.from(byDistributor.entries()).filter(
    ([distributorCode, customerCode]) => !mapByKey.has(`${distributorCode}::${customerCode}`),
  );
  const reviewReason =
    byDistributor.size === 0
      ? "no distributor or customer code was given"
      : unresolved.length > 0
        ? `${unresolved.length} customer code(s) are not in the distributor's own list`
        : "the pharmacy was typed in by hand rather than picked from Phoenix";

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: `pharmacy:${pharmacyId}`,
    newValues: {
      verificationStatus: "pending_review",
      entrySource: "manual",
      reviewReason,
      unrecognisedPairs: unresolved.map(([distributorCode, customerCode]) => `${distributorCode}:${customerCode}`),
    },
    summary: `Direct-order pharmacy "${name}" registered by hand — awaiting SFE validation and System Admin acknowledgment (${reviewReason}).`,
  });

  const pharmacy = mapPharmacyRow(pharmacyRow as Record<string, unknown>);
  await attachDistributorCodes([pharmacy]);
  return pharmacy;
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
    throw new Error("Forbidden: only a System Admin can acknowledge a pharmacy.");
  }
  await markDirectOrderPharmacyVerified(access, input);
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
  if (!before) badRequest("Pharmacy not found.");

  const { error } = await supabase
    .from("direct_order_pharmacies")
    .update({
      verification_status: "verified",
      verified_by_hr_id: access.hrId ?? null,
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
    summary: `Direct-order pharmacy acknowledged by ${access.hrId ?? "unknown"}.`,
  });
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

/** Who may open the registry and register pharmacies (owner's choice, 2026-08-04). */
const PHARMACY_REGISTRY_ROLES = new Set<PhoenixRole>(["Super Admin", "SFE Manager"]);

function canManagePharmacyRegistry(access: AccessContext): boolean {
  return access.scope === "system" || PHARMACY_REGISTRY_ROLES.has(access.role);
}

function assertPharmacyRegistryAccess(access: AccessContext): void {
  if (!canManagePharmacyRegistry(access)) {
    throw new Error("Forbidden: only a System Admin or the SFE Manager can manage the pharmacy registry.");
  }
}

export type DirectOrderRegistryPharmacy = DirectOrderPharmacy & {
  brickName: string | null;
  areaName: string | null;
  regionName: string | null;
  /** Orders already placed against this pharmacy — what is riding on an edit. */
  orderCount: number;
  /** Orders still climbing their chain. Editing a code under one of these moves live money. */
  pendingOrderCount: number;
};

/**
 * Every active pharmacy, with names rather than codes and with what is riding on each one.
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

  const rows = pharmacies.map((pharmacy) => ({
    ...pharmacy,
    brickName: pharmacy.brickId ? brickNameById.get(pharmacy.brickId) ?? null : null,
    areaName: pharmacy.areaCode ? areaNameByCode.get(pharmacy.areaCode) ?? null : null,
    regionName: pharmacy.regionCode ? regionNameByCode.get(pharmacy.regionCode) ?? null : null,
    orderCount: orderCounts.get(pharmacy.id)?.total ?? 0,
    pendingOrderCount: orderCounts.get(pharmacy.id)?.pending ?? 0,
  }));
  return {
    rows,
    canManage: canManagePharmacyRegistry(access),
    canClearReview: access.scope === "system" || access.role === "Super Admin",
  };
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
  },
): Promise<DirectOrderPharmacy> {
  assertPharmacyRegistryAccess(access);
  const name = input.pharmacyName?.trim();
  if (!name) badRequest("Pharmacy name is required.");
  const doctorName = input.doctorName?.trim() || null;
  const pharmacyAddress = input.pharmacyAddress?.trim() || null;
  const byDistributor = normalizeDistributorCodePairs(input.distributorCodes, await distributorNameResolver());

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
      created_by_hr_id: access.hrId,
      verification_status: "verified",
      entry_source: "catalogue",
      verified_by_hr_id: access.hrId ?? null,
      verified_at: now,
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
    },
    summary: `Direct-order pharmacy "${name}" pre-registered and confirmed by ${access.hrId ?? "unknown"} (${access.role}).`,
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
  },
): Promise<void> {
  assertPharmacyRegistryAccess(access);
  const supabase = getSupabaseAdmin();
  const { data: before } = await supabase
    .from("direct_order_pharmacies")
    .select("pharmacy_name, brick_id, area_code, region_code, doctor_name, pharmacy_address")
    .eq("id", input.pharmacyId)
    .maybeSingle();
  if (!before) badRequest("Pharmacy not found.");

  // Patch semantics, not replace: the UI sends only the fields it edited, and an absent key must
  // never blank a column. `null` is a real value here (clear the doctor) and is distinguished from
  // `undefined` (leave it alone) — hence the explicit `in` checks rather than `??`.
  const patch: Record<string, unknown> = {};
  if (input.pharmacyName !== undefined) {
    const name = input.pharmacyName?.trim();
    if (!name) badRequest("Pharmacy name cannot be empty.");
    patch.pharmacy_name = name;
  }
  if (input.brickId !== undefined) patch.brick_id = input.brickId || null;
  if (input.areaCode !== undefined) patch.area_code = input.areaCode || null;
  if (input.regionCode !== undefined) patch.region_code = input.regionCode || null;
  if (input.doctorName !== undefined) patch.doctor_name = input.doctorName?.trim() || null;
  if (input.pharmacyAddress !== undefined) patch.pharmacy_address = input.pharmacyAddress?.trim() || null;
  if (Object.keys(patch).length === 0) return;

  const { error } = await supabase.from("direct_order_pharmacies").update(patch).eq("id", input.pharmacyId);
  if (error) throw error;

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: `pharmacy:${input.pharmacyId}`,
    oldValues: before as Record<string, unknown>,
    newValues: patch,
    summary: `Direct-order pharmacy details updated by ${access.hrId ?? "unknown"}.`,
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
  if (!pharmacy) badRequest("Pharmacy not found.");

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
    summary: `Direct-order pharmacy distributor codes replaced by ${access.hrId ?? "unknown"}.`,
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
  const unrestricted = resolveDirectOrderReportScope(access) === "all";
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
    // Escape PostgREST's pattern metacharacters so a stray % cannot widen the match.
    const escaped = search.replace(/[%_,()]/g, " ").trim();
    if (escaped) query = query.ilike("customer_name", `%${escaped}%`);
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
    .filter((option) => unrestricted || !option.areaCode || allowedAreaCodes.has(option.areaCode.toUpperCase()));
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
};

export async function submitDirectOrder(
  access: AccessContext,
  input: SubmitDirectOrderInput,
): Promise<DirectOrderRequest> {
  await assertPermission(access, "direct_orders", "create");
  // Super Admin may submit (system admin / on-behalf) — matches the workflow-registry
  // submit action's allowedRoles and the page's canSubmit gate.
  if (!isDirectOrderRequesterRole(access.role) && access.role !== "Super Admin") {
    badRequest(`Role "${access.role}" cannot submit direct orders. Allowed: ${DIRECT_ORDER_REQUESTER_ROLES.join(", ")}.`);
  }
  const actorHrId = requireActorHrId(access);

  const qty = Math.floor(Number(input.qty) || 0);
  if (qty <= 0) badRequest("Quantity must be greater than zero.");

  const collectionDate = String(input.collectionDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(collectionDate)) {
    badRequest("A valid money-collection date (YYYY-MM-DD) is required.");
  }

  // Resolve the product from the master (name, line, factory price snapshot).
  const products = await listSourceOfSalesProducts();
  const product = products.find((candidate) => candidate.productCode === input.productCode);
  if (!product) badRequest(`Unknown product code "${input.productCode}".`);
  if ((product.line ?? "").trim().toUpperCase() === "IGNORE") {
    badRequest(`"${product.productName}" is not a submittable Phoenix product.`);
  }
  // Server-side line guard (defense in depth — the submit form's dropdown is already
  // scoped, but this is money-critical: never trust a client-only restriction here).
  const requesterLine = await resolveDirectOrderRequesterLineName(access);
  if (requesterLine !== null && requesterLine.toLowerCase() !== (product.line ?? "").trim().toLowerCase()) {
    badRequest(
      requesterLine
        ? `"${product.productName}" is a ${product.line} product — you can only submit direct orders for your own line (${requesterLine}).`
        : `Your account has no field line on record, so it cannot submit a direct order for "${product.productName}".`,
    );
  }

  const supabase = getSupabaseAdmin();
  const caps = await loadDirectOrderCaps();
  const dealType: DirectOrderDealType = input.dealType === "discount" ? "discount" : "bonus";
  const overrideReason = input.bonusOverrideReason?.trim() || null;

  let bonus = 0;
  let discountPct: number | null = null;
  let publicPrice: number | null = null;
  let pharmacyPrice: number | null = null;
  let salesValue: number;
  // Over-cap does NOT block submission and does NOT restrict who may finalize (owner rule,
  // 2026-08-03). It flags the request: an "over cap" badge on every list and detail view, a
  // tag on the approver's notification, and an event when it is finalized. The chain already
  // always ends at the CEO rung regardless.
  let overCap: boolean;

  // Both money inputs are read FRESH from the table rather than taken off `product`.
  // `listSourceOfSalesProducts()` is unstable_cache'd with a 600s revalidate and no price
  // setter busts that tag, so a price the owner just typed could be up to ten minutes stale.
  // A cached factory price is fine for a dropdown label; it is not fine for a sales value.
  const { data: priceRow } = await supabase
    .from("source_of_sales_products")
    .select("public_price, pharmacy_price")
    .eq("product_code", product.productCode)
    .maybeSingle();
  const prices = priceRow as { public_price?: number | null; pharmacy_price?: number | null } | null;

  if (dealType === "discount") {
    // Discount uses the PUBLIC price; value = qty × public × (1 − disc%). No bonus. UNCHANGED.
    publicPrice = prices?.public_price != null ? Number(prices.public_price) : null;
    // NOTE: discount mode still HARD-BLOCKS on a missing public price, whereas bonus mode below
    // falls back and flags. That asymmetry is deliberate and pre-existing — do not "harmonize"
    // the two paths without the owner deciding which way they should converge.
    if (publicPrice == null || publicPrice <= 0) {
      badRequest(`No public price is set for ${product.productName}. Ask an admin to set it before using discount mode.`);
    }
    discountPct = Math.max(0, Math.min(100, Number(input.discountPct) || 0));
    const capPct = resolveDiscountCapPct(caps, product.productCode);
    overCap = !validateDiscount({ discountPct, capPct }).withinCap;
    salesValue = computeDiscountSalesValue({ qty, publicPrice: publicPrice as number, discountPct });
  } else {
    // Bonus: value = qty × PHARMACY price (bonus units excluded); bonus capped by config.
    // When the product has no pharmacy price yet we fall back to the factory price and FLAG it
    // — never block. `pharmacyPrice` stays null in that case so the stored row records which
    // basis was actually used (see isFallbackPricedRequest).
    bonus = Math.floor(Number(input.bonus) || 0);
    const capPct = resolveBonusCapPct(caps, product.productCode);
    overCap = !validateBonus({ qty, bonus, capPct }).withinCap;
    const rawPharmacyPrice = prices?.pharmacy_price != null ? Number(prices.pharmacy_price) : null;
    pharmacyPrice = rawPharmacyPrice != null && rawPharmacyPrice > 0 ? rawPharmacyPrice : null;
    salesValue = computeDirectOrderSalesValue({ qty, pharmacyPrice: pharmacyPrice ?? product.factoryPrice });
  }

  // Load the pharmacy in full (a missing map entry IS "not found") — the approver's
  // notification names the pharmacy, its geography and its distributors, so the bare
  // existence probe this replaced no longer carries enough.
  const pharmacies = await loadPharmaciesByIds([input.pharmacyId]);
  const pharmacy = pharmacies.get(input.pharmacyId) ?? null;
  if (!pharmacy) badRequest("Pharmacy not found — pick an existing one or add a new pharmacy first.");

  // Governance: the registry validates that this role may submit from draft.
  await assertDirectOrderWorkflowTransition({
    access,
    actionKey: "submit",
    expectedNextStatus: "pending_approval",
    status: "draft",
  });

  const chain = await buildApprovalChain({
    requesterHrId: actorHrId,
    requesterRole: access.role,
  });

  const { data: inserted, error: insertError } = await supabase
    .from("direct_order_requests")
    .insert({
      requester_hr_id: access.hrId,
      requester_role: access.role,
      status: "pending_approval",
      line: product.line,
      product_code: product.productCode,
      product_name: product.productName,
      factory_price_snapshot: product.factoryPrice,
      qty,
      bonus,
      bonus_override_reason: overrideReason,
      deal_type: dealType,
      discount_pct: discountPct,
      public_price_snapshot: publicPrice,
      // NULL on a bonus deal means "fell back to the factory price" — the row stays honest
      // about its own basis even after the product later gets a pharmacy price.
      pharmacy_price_snapshot: dealType === "bonus" ? pharmacyPrice : null,
      sales_value: salesValue,
      pharmacy_id: input.pharmacyId,
      collection_date: collectionDate,
      created_by_login_id: access.loginId ?? null,
      submitted_at: new Date().toISOString(),
    })
    .select("*")
    .single();
  if (insertError) throw insertError;
  const request = mapRequestRow(inserted as Record<string, unknown>);

  // Seed the approval steps.
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

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: request.id,
    newValues: { status: "pending_approval", product: product.productCode, qty, salesValue },
    summary: `Direct order submitted by ${access.hrId} (${product.productName}, ${qty} units).`,
  });
  await insertEvent({
    requestId: request.id,
    actorHrId: access.hrId,
    eventType: "submitted",
    message: `Submitted ${product.productName} × ${qty}.`,
    // Record which price basis produced this sales_value, so the timeline can answer
    // "why is this number what it is" without re-deriving it from a master that has moved on.
    metadata: {
      basis: dealType === "bonus" ? (pharmacyPrice == null ? "factory_price_fallback" : "pharmacy_price") : "public_price",
      pharmacyPriceSnapshot: pharmacyPrice,
      factoryPriceSnapshot: product.factoryPrice,
      publicPriceSnapshot: publicPrice,
      salesValue,
      overCap,
    },
  });

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
  await notifyDirectOrder({
    recipients: [...firstApprovers, ...(await ccRecipients())],
    title: `${tags ? `${tags} ` : ""}Direct order awaiting your approval`,
    message: `${buildDirectOrderNotificationLine(notifyContext)}${capNote}`,
    metrics: buildDirectOrderNotificationMetrics(notifyContext),
    eventType: "submitted",
    requestId: request.id,
    subjectHrId: actorHrId,
  });

  return request;
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
  await assertDirectOrderWorkflowTransition({
    access,
    actionKey: action.actionKey,
    expectedNextStatus: action.expectedNextStatus,
    status: "pending_approval",
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
    p_decided_by_hr_id: access.hrId,
    p_decision_comment: comment,
    p_now: now.toISOString(),
    p_sales_month: salesMonth,
  });
  if (rpcError) throw rpcError;
  const result = mapRequestRow((Array.isArray(updated) ? updated[0] : updated) as Record<string, unknown>);

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
  if (input.decision === "approve" && isPharmacyConfirmingStep(activeStep)) {
    await markDirectOrderPharmacyVerified(access, { pharmacyId: request.pharmacyId });
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

  // Notify the requester on every decision; the next approver when the chain advances.
  const cc = await ccRecipients();
  const recipients: Array<string | null | undefined> = [request.requesterHrId, ...cc];
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
  // Third person, deliberately: this goes to the NEXT approver and the SFE/Super-Admin CC set
  // as well as the requester, so the old "Your direct order …" was wrong for most of the people
  // who received it.
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
  const { data: originalRow, error } = await supabase
    .from("direct_order_requests")
    .select("*")
    .eq("id", input.requestId)
    .maybeSingle();
  if (error) throw error;
  if (!originalRow) badRequest("Direct order request not found.");
  const original = mapRequestRow(originalRow as Record<string, unknown>);
  if (original.status !== "approved") badRequest("Only an approved direct order can be reversed.");
  if (original.reversedByRequestId) badRequest("This direct order already has a reversal in progress.");

  const chain = await buildApprovalChain({
    requesterHrId: actorHrId,
    requesterRole: access.role,
  });

  const { data: inserted, error: insertError } = await supabase
    .from("direct_order_requests")
    .insert({
      requester_hr_id: access.hrId,
      requester_role: access.role,
      status: "pending_approval",
      line: original.line,
      product_code: original.productCode,
      product_name: original.productName,
      factory_price_snapshot: original.factoryPriceSnapshot,
      // A reversal mirrors its original exactly, so it must carry the same pricing basis.
      // KNOWN GAP (pre-existing, separate ticket): deal_type, discount_pct and
      // public_price_snapshot are NOT copied here, so every reversal row reads deal_type
      // 'bonus' by column default even when reversing a discount order. Any query that
      // filters direct_order_requests by deal_type must also exclude reversal rows.
      pharmacy_price_snapshot: original.pharmacyPriceSnapshot,
      qty: original.qty,
      bonus: original.bonus,
      bonus_override_reason: `Reversal of ${original.id}: ${reason}`,
      sales_value: original.salesValue,
      pharmacy_id: original.pharmacyId,
      collection_date: original.collectionDate,
      reversal_of_request_id: original.id,
      created_by_login_id: access.loginId ?? null,
      submitted_at: new Date().toISOString(),
    })
    .select("*")
    .single();
  if (insertError) throw insertError;
  const reversal = mapRequestRow(inserted as Record<string, unknown>);

  await supabase.from("direct_order_requests").update({ reversed_by_request_id: reversal.id }).eq("id", original.id);
  await supabase.from("direct_order_approval_steps").insert(
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
  await notifyDirectOrder({
    recipients: [chain[0].kind === "role" && chain[0].role ? (await hrIdsForRole(chain[0].role)).join(",") : chain[0].approverHrId, ...(await ccRecipients())],
    title: "Direct order reversal awaiting approval",
    message: `A reversal of a direct order (${original.productName} × ${original.qty}) needs approval.`,
    eventType: "reversal_submitted",
    requestId: reversal.id,
    subjectHrId: actorHrId,
  });

  return reversal;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/**
 * May this viewer READ this single request?
 *
 * `direct_orders:read` alone is NOT sufficient: it is held by every requester role, so on its own it
 * would let any District/Regional/Product Manager fetch ANY order company-wide by id — requester,
 * pharmacy, doctor, quantities, factory/public price, bonus/discount and sales value included. This
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
  return (await resolveVisibleRequesterHrIds(access)).has(requesterKey);
}

export async function getDirectOrderRequest(
  access: AccessContext,
  requestId: string,
): Promise<{ request: DirectOrderRequest; steps: DirectOrderStepState[] } | null> {
  await assertPermission(access, "direct_orders", "read");
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
 * `missingPharmacyPrice` is computed here rather than passed in (unlike `bonusOverCap`, which
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
): DirectOrderApprovalListItem {
  const medicalRep = toDirectOrderAreaRep(rep);
  return {
    id: request.id,
    requesterHrId: request.requesterHrId,
    requesterName: requesterName ?? request.requesterHrId,
    requesterRole: request.requesterRole,
    line: request.line,
    productName: request.productName,
    qty: request.qty,
    bonus: request.bonus,
    dealType: request.dealType,
    discountPct: request.discountPct,
    salesValue: request.salesValue,
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
    activeStepLabel: active?.label ?? "",
    activeStepOrder: active?.order ?? null,
    bonusOverCap,
    missingPharmacyPrice: isFallbackPricedRequest(request),
  };
}

/**
 * Geography names + area reps for a batch of requests, loaded ONCE per list page.
 *
 * Both underlying loads are TTL-cached in-process, which is what keeps this affordable on
 * the nav-badge path: countDirectOrderAwaiting → getDirectOrderWorkspaceData runs on every
 * admin render.
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

export async function getDirectOrderWorkspaceData(access: AccessContext): Promise<DirectOrderWorkspaceData> {
  await assertPermission(access, "direct_orders", "read");
  const supabase = getSupabaseAdmin();

  const { data: pendingRows, error: pendingError } = await supabase
    .from("direct_order_requests")
    .select("*")
    .eq("status", "pending_approval")
    .order("created_at", { ascending: true });
  if (pendingError) throw pendingError;
  const pending = ((pendingRows ?? []) as Array<Record<string, unknown>>).map(mapRequestRow);

  const { data: myStepRows } = await supabase
    .from("direct_order_approval_steps")
    .select("request_id")
    .eq("decided_by_hr_id", access.hrId ?? "");
  const historyIds = Array.from(new Set(((myStepRows ?? []) as Array<{ request_id: string }>).map((r) => r.request_id)));
  const { data: historyRows } = historyIds.length
    ? await supabase.from("direct_order_requests").select("*").in("id", historyIds).order("decided_at", { ascending: false })
    : { data: [] as Array<Record<string, unknown>> };
  const historyRequests = ((historyRows ?? []) as Array<Record<string, unknown>>).map(mapRequestRow);

  const allRequests = [...pending, ...historyRequests];
  const stepsByReq = await loadStepsForRequests(allRequests.map((r) => r.id));
  const pharmacies = await loadPharmaciesByIds(allRequests.map((r) => r.pharmacyId));
  const nameOf = await nameLookup();
  const caps = await loadDirectOrderCaps();
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
    ),
  );
  return { awaiting, history };
}

export async function countDirectOrderAwaiting(access: AccessContext): Promise<number> {
  const data = await getDirectOrderWorkspaceData(access);
  return data.awaiting.length;
}

/** The caller's own direct order requests (any status), newest first — for the "My direct orders" list. */
export async function listMyDirectOrders(access: AccessContext): Promise<DirectOrderApprovalListItem[]> {
  await assertPermission(access, "direct_orders", "read");
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("direct_order_requests")
    .select("*")
    .eq("requester_hr_id", access.hrId ?? "")
    .order("created_at", { ascending: false });
  if (error) throw error;
  const requests = ((data ?? []) as Array<Record<string, unknown>>).map(mapRequestRow);
  const stepsByReq = await loadStepsForRequests(requests.map((r) => r.id));
  const pharmacies = await loadPharmaciesByIds(requests.map((r) => r.pharmacyId));
  const nameOf = await nameLookup();
  const caps = await loadDirectOrderCaps();
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
 */
async function resolveDirectOrderRequesterLineName(access: AccessContext): Promise<string | null> {
  if (DIRECT_ORDER_LINE_UNRESTRICTED_ROLES.has(access.role)) return null;
  const key = canonicalHrIdKey(access.hrId);
  if (!key) return "";
  const directory = await getEmployeeDirectory();
  const row = directory.employees.find((employee) => canonicalHrIdKey(employee.hrId) === key);
  return (row?.lineName ?? "").trim();
}

export type DirectOrderProductOption = {
  productCode: string;
  productName: string;
  line: string;
  factoryPrice: number;
  /** Prices discount deals. */
  publicPrice: number | null;
  /** Prices bonus deals. null = not set yet; the submit path falls back to factoryPrice. */
  pharmacyPrice: number | null;
};

/**
 * Field-line products for the submit form (code, name, line, factory + public + pharmacy price).
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
    .select("product_code, product_name, line, factory_price, public_price, pharmacy_price")
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
      line: String(p.line ?? ""),
      factoryPrice: Number(p.factory_price ?? 0),
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
  if (access) {
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
    .filter((area) =>
      areaCodesInScopeOverride
        ? areaCodesInScopeOverride.has(area.areaCode.toUpperCase())
        : !regionCodesInScope || regionCodesInScope.has(area.regionCode.toUpperCase()),
    )
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
): Promise<DirectOrderPharmacyHistoryRow[]> {
  if (!pharmacy) return [];
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("direct_order_requests")
      .select("id, product_code, product_name, qty, bonus, sales_value, sales_month, created_at, status, reversal_of_request_id")
      .eq("pharmacy_id", pharmacy.id)
      .is("reversal_of_request_id", null)
      .neq("status", "rejected")
      .order("created_at", { ascending: false });
    if (error) throw error;

    const distributors = pharmacy.distributorCodes.length
      ? pharmacy.distributorCodes
      : [{ distributorCode: "", distributorName: "—", customerCode: "", mappedBrickId: null, mappedAreaCode: null, mappedRegionCode: null }];

    const byKey = new Map<string, DirectOrderPharmacyHistoryRow>();
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      if (String(row.id) === excludeRequestId) continue;
      const salesMonth = row.sales_month ? String(row.sales_month) : null;
      const month = salesMonth ?? String(row.created_at ?? "").slice(0, 7);
      if (!month) continue;
      for (const distributor of distributors) {
        const key = `${month}|${String(row.product_code)}|${distributor.distributorCode}`;
        const existing = byKey.get(key) ?? {
          month,
          monthIsProvisional: salesMonth == null,
          productCode: String(row.product_code ?? ""),
          productName: String(row.product_name ?? ""),
          distributorName: distributor.distributorName || distributor.distributorCode || "—",
          distributorCode: distributor.distributorCode,
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
    }

    return [...byKey.values()].sort(
      (a, b) =>
        b.month.localeCompare(a.month) ||
        a.productName.localeCompare(b.productName) ||
        a.distributorName.localeCompare(b.distributorName),
    );
  } catch (error) {
    // Best-effort context, never a reason the approval screen fails to open.
    logError("Direct order pharmacy history failed", {
      labels: { event: "direct_order_pharmacy_history_failed", pharmacyId: pharmacy.id },
      error,
    });
    return [];
  }
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
): Promise<{ rows: DirectOrderRetailHistoryRow[]; unmatchable: boolean }> {
  const pairs = (pharmacy?.distributorCodes ?? []).filter((pair) => pair.distributorCode && pair.customerCode);
  if (pairs.length === 0) return { rows: [], unmatchable: true };

  try {
    const supabase = getSupabaseAdmin();
    const customerCodes = [...new Set(pairs.map((pair) => pair.customerCode))];
    const { data, error } = await supabase
      .from("source_of_sales_import_rows")
      .select("client_code, product_code, product_name, qty, bonus_qty, value, batch_id, source_of_sales_import_batches!inner(distributor_code, period)")
      .in("client_code", customerCodes);
    if (error) throw error;

    // (distributor, customer code) is the only safe key — see the note above.
    const allowed = new Set(pairs.map((pair) => `${pair.distributorCode.toLowerCase()}|${pair.customerCode}`));
    const nameByCode = new Map(pairs.map((pair) => [pair.distributorCode.toLowerCase(), pair.distributorName]));

    const byKey = new Map<string, DirectOrderRetailHistoryRow>();
    for (const raw of (data ?? []) as Array<Record<string, unknown>>) {
      const batch = raw.source_of_sales_import_batches as { distributor_code?: string; period?: string } | null;
      const distributorCode = String(batch?.distributor_code ?? "");
      const clientCode = String(raw.client_code ?? "");
      if (!allowed.has(`${distributorCode.toLowerCase()}|${clientCode}`)) continue;
      const month = String(batch?.period ?? "");
      if (!month) continue;

      const productCode = String(raw.product_code ?? "");
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
    return { rows, unmatchable: false };
  } catch (error) {
    // Context only — never a reason the approval screen fails to open.
    logError("Direct order retail history failed", {
      labels: { event: "direct_order_retail_history_failed", pharmacyId: pharmacy?.id ?? "" },
      error,
    });
    return { rows: [], unmatchable: false };
  }
}

export async function getDirectOrderApprovalDetail(
  access: AccessContext,
  requestId: string,
): Promise<DirectOrderApprovalDetail | null> {
  const loaded = await getDirectOrderRequest(access, requestId);
  if (!loaded) return null;
  const { request, steps } = loaded;
  const [nameOf, pharmacies, caps] = await Promise.all([
    nameLookup(),
    loadPharmaciesByIds([request.pharmacyId]),
    loadDirectOrderCaps(),
  ]);
  const pharmacy = pharmacies.get(request.pharmacyId) ?? null;
  // Geography names and the area's medical rep are resolved HERE, at the single choke point
  // every approval surface reads, rather than in the components — which is why both of them
  // used to print raw brick/area codes.
  const [geoMaps, rep, pharmacyHistory, retail, productPrices] = await Promise.all([
    loadDirectOrderGeoNames(),
    resolveAreaRep({ line: request.line, areaCode: pharmacy?.areaCode ?? null }, { nameOf }),
    loadPharmacyOrderHistory(pharmacy, request.id),
    loadPharmacyRetailHistory(pharmacy),
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
  return {
    request,
    requesterName: nameOf(request.requesterHrId) ?? request.requesterHrId,
    pharmacy,
    geo: resolveDirectOrderGeo(pharmacy, geoMaps),
    medicalRep: toDirectOrderAreaRep(rep),
    productPharmacyPrice: priceRow?.pharmacy_price == null ? null : Number(priceRow.pharmacy_price),
    productPublicPrice: priceRow?.public_price == null ? null : Number(priceRow.public_price),
    distributorCodesText: formatDistributorCodesText(pharmacy?.distributorCodes),
    distributors: toDistributorRows(pharmacy?.distributorCodes, geoMaps),
    pharmacyHistory,
    retailHistory: retail.rows,
    retailUnmatchable: retail.unmatchable,
    steps: steps.map((step) => ({ ...step, approverName: step.approverHrId ? nameOf(step.approverHrId) : step.role })),
    availableActions: { approve: canAct, reject: canAct, return: canAct },
    bonusOverCap,
    missingPharmacyPrice: isFallbackPricedRequest(request),
    canSetSalesMonth: canSetDirectOrderSalesMonth(access),
  };
}

// ── Report (premium table + xlsx export), tiered by role/scope ───────────────

// Owner tiering: these roles see EVERY direct order; everyone else sees their own
// management subtree (RM ≈ their region) down to themselves (DSM/PM ≈ own).
const DIRECT_ORDER_REPORT_SEE_ALL_ROLES: PhoenixRole[] = [
  "Super Admin",
  "CEO",
  "SFE Manager",
  "National Sales Manager",
];

export function resolveDirectOrderReportScope(access: AccessContext): DirectOrderReportScope {
  if (access.scope === "system" || DIRECT_ORDER_REPORT_SEE_ALL_ROLES.includes(access.role)) return "all";
  // Regional Managers see their whole subtree ("region"); DSM/PM effectively see own.
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
async function resolveVisibleRequesterHrIds(access: AccessContext): Promise<Set<string>> {
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
  }

  const stepsByReq = await loadStepsForRequests(requests.map((request) => request.id));
  const pharmacies = await loadPharmaciesByIds(requests.map((request) => request.pharmacyId));
  const nameOf = await nameLookup();

  // Resolve brick/area/region CODES → NAMES for display (owner wants both). Shared with the
  // approval detail and the approvals lists — see @/lib/direct-orders/geo-names.
  const { brickNameById, areaNameByCode, regionNameByCode } = await loadDirectOrderGeoNames();

  return requests.map((request) => {
    const active = resolveActiveStep(stepsByReq.get(request.id) ?? []);
    const pharmacy = pharmacies.get(request.pharmacyId) ?? null;
    const distributorCodesText = formatDistributorCodesText(pharmacy?.distributorCodes);
    return {
      id: request.id,
      requesterHrId: request.requesterHrId,
      requesterName: nameOf(request.requesterHrId) ?? request.requesterHrId,
      requesterRole: request.requesterRole,
      status: request.status,
      line: request.line,
      productCode: request.productCode,
      productName: request.productName,
      factoryPriceSnapshot: request.factoryPriceSnapshot,
      pharmacyPriceSnapshot: request.pharmacyPriceSnapshot,
      qty: request.qty,
      bonus: request.bonus,
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
      activeStepLabel: active?.label ?? "",
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
  if (!canViewGeoVariances(access)) throw new Error("Forbidden: you are not allowed to view pharmacy variances.");
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
    summary: `Pharmacy geo variance ${input.action} by ${access.hrId ?? "unknown"}.`,
  });
}

// ── Sales month (Finance-owned) ──────────────────────────────────────────────

/**
 * The one person the owner named to book a direct order into a month (2026-08-03):
 * Ahmed El Maraghy, Finance Manager. Deliberately an HR_ID and not the "Finance Manager" ROLE —
 * this moves money between months, and a second Finance Manager joining later must not inherit
 * that silently. If the duty moves, this constant is the single line to change.
 */
export const DIRECT_ORDER_SALES_MONTH_SETTER_HR_ID = "B-185";

/** Ahmed, or a Super Admin. The CEO and SFE Manager can SEE the month but never set it. */
export function canSetDirectOrderSalesMonth(access: AccessContext): boolean {
  if (access.scope === "system" || access.role === "Super Admin") return true;
  return canonicalHrIdKey(access.hrId) === canonicalHrIdKey(DIRECT_ORDER_SALES_MONTH_SETTER_HR_ID);
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

  const nextMonth = input.salesMonth === null ? null : String(input.salesMonth).trim();
  if (nextMonth !== null && !/^\d{4}-\d{2}$/.test(nextMonth)) {
    badRequest("Pick a month in YYYY-MM form, e.g. 2026-07.");
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
  if (previousMonth === nextMonth) return before;

  const { data: updated, error: updateError } = await supabase
    .from("direct_order_requests")
    .update({ sales_month: nextMonth, updated_at: new Date().toISOString() })
    .eq("id", input.requestId)
    .select("*")
    .single();
  if (updateError) throw updateError;
  const after = mapRequestRow(updated as Record<string, unknown>);

  // Rebuild every period this move touched. Sequential, because the RPC takes a per-period
  // advisory lock; de-duplicated so setting a month for the first time rebuilds once.
  const periods = [...new Set([previousMonth, nextMonth].filter((m): m is string => Boolean(m)))];
  for (const period of periods) {
    const { error: rpcError } = await supabase.rpc("phx_rebuild_direct_order_sos_batch", {
      p_period: period,
      p_actor: access.hrId ?? "finance",
    });
    if (rpcError) throw rpcError;
  }

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: after.id,
    oldValues: { salesMonth: previousMonth },
    newValues: { salesMonth: nextMonth, rebuiltPeriods: periods },
    summary: `Direct order sales month set to ${nextMonth ?? "none"} by ${access.hrId ?? "unknown"}.`,
  });
  await insertEvent({
    requestId: after.id,
    actorHrId: access.hrId,
    eventType: "sales_month_set",
    message: `Sales month ${previousMonth ? `changed from ${previousMonth} ` : "set "}to ${nextMonth ?? "none"}.`,
    metadata: { previousMonth, nextMonth, rebuiltPeriods: periods },
  });

  return after;
}

/**
 * Zero is stored as NULL, deliberately.
 *
 * A product priced "0" would read as "0.00 EGP" in the admin table while the submit path's
 * `> 0` guard treated it as unset and fell back to the factory price — two surfaces disagreeing
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
