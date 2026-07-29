import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { ceoHrIds } from "@/lib/employees/role-lookup";
import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import { assertPermission, normalizeHrId, systemAccessContext } from "@/lib/auth/permissions";
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
  isCeoStep,
  maxBonusUnits,
  resolveActiveStep,
  validateBonus,
  validateDiscount,
} from "@/lib/direct-orders/approval-flow";
import {
  loadDirectOrderCaps,
  resolveBonusCapPct,
  resolveDiscountCapPct,
} from "@/lib/direct-orders/caps";
import {
  DIRECT_ORDER_REQUESTER_ROLES,
  isDirectOrderRequesterRole,
  type DirectOrderApprovalDetail,
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
    createdByHrId: String(row.created_by_hr_id),
    active: row.active !== false,
  };
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

  // ≥1 distributor + customer code is now mandatory; one code per distributor.
  const byDistributor = new Map<string, string>();
  for (const pair of input.distributorCodes ?? []) {
    const distributorCode = String(pair.distributorCode ?? "").trim();
    const customerCode = String(pair.customerCode ?? "").trim();
    if (distributorCode && customerCode) byDistributor.set(distributorCode, customerCode);
  }
  if (byDistributor.size === 0) {
    badRequest("Add at least one distributor and its customer code for this pharmacy.");
  }

  const supabase = getSupabaseAdmin();
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
    })
    .select("*")
    .single();
  if (error) throw error;
  const pharmacyId = String((pharmacyRow as Record<string, unknown>).id);

  // Resolve each (distributor, customer code) → brick via the customer map (best-effort).
  const distributorCodes = Array.from(byDistributor.keys());
  const customerCodes = Array.from(byDistributor.values());
  const { data: mapRows } = await supabase
    .from("source_of_sales_customer_map")
    .select("distributor_code, customer_code, brick_id, area_code, region_code")
    .in("distributor_code", distributorCodes)
    .in("customer_code", customerCodes);
  const mapByKey = new Map<string, { brick: string | null; area: string | null; region: string | null }>();
  for (const row of (mapRows ?? []) as Array<Record<string, unknown>>) {
    mapByKey.set(`${row.distributor_code}::${row.customer_code}`, {
      brick: row.brick_id ? String(row.brick_id) : null,
      area: row.area_code ? String(row.area_code) : null,
      region: row.region_code ? String(row.region_code) : null,
    });
  }

  const childRows = Array.from(byDistributor.entries()).map(([distributorCode, customerCode]) => {
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
  const { error: childError } = await supabase.from("direct_order_pharmacy_distributor_codes").insert(childRows);
  if (childError) throw childError;

  const pharmacy = mapPharmacyRow(pharmacyRow as Record<string, unknown>);
  await attachDistributorCodes([pharmacy]);
  return pharmacy;
}

/** List distributors for the pharmacy form (by name). */
export async function listDirectOrderDistributorOptions(): Promise<Array<{ distributorCode: string; distributorName: string }>> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("source_of_sales_distributors")
    .select("distributor_code, distributor_name")
    .eq("active", true)
    .order("distributor_name", { ascending: true });
  return ((data ?? []) as Array<{ distributor_code: string; distributor_name: string | null }>)
    .filter((row) => row.distributor_code)
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
  let salesValue: number;

  if (dealType === "discount") {
    // Discount uses the PUBLIC price; value = qty × public × (1 − disc%). No bonus.
    const { data: priceRow } = await supabase
      .from("source_of_sales_products")
      .select("public_price")
      .eq("product_code", product.productCode)
      .maybeSingle();
    publicPrice = (priceRow as { public_price?: number | null } | null)?.public_price != null
      ? Number((priceRow as { public_price?: number | null }).public_price)
      : null;
    if (publicPrice == null || publicPrice <= 0) {
      badRequest(`No public price is set for ${product.productName}. Ask an admin to set it before using discount mode.`);
    }
    discountPct = Math.max(0, Math.min(100, Number(input.discountPct) || 0));
    const capPct = resolveDiscountCapPct(caps, product.productCode);
    const check = validateDiscount({ discountPct, capPct });
    if (!check.withinCap && !overrideReason) {
      badRequest(`Discount ${discountPct}% exceeds the cap of ${capPct}%. A CEO override with a reason is required to exceed it.`);
    }
    salesValue = computeDiscountSalesValue({ qty, publicPrice: publicPrice as number, discountPct });
  } else {
    // Bonus: value = qty × factory price (bonus excluded); bonus capped by config.
    bonus = Math.floor(Number(input.bonus) || 0);
    const capPct = resolveBonusCapPct(caps, product.productCode);
    const check = validateBonus({ qty, bonus, capPct });
    if (!check.withinCap && !overrideReason) {
      badRequest(`Bonus ${bonus} exceeds the cap of ${check.maxBonus} (${capPct}% of ${qty}). A CEO override with a reason is required to exceed it.`);
    }
    salesValue = computeDirectOrderSalesValue({ qty, factoryPrice: product.factoryPrice });
  }

  // Validate the pharmacy belongs to a real registry row.
  const { data: pharmacyRow, error: pharmacyError } = await supabase
    .from("direct_order_pharmacies")
    .select("id")
    .eq("id", input.pharmacyId)
    .maybeSingle();
  if (pharmacyError) throw pharmacyError;
  if (!pharmacyRow) badRequest("Pharmacy not found — pick an existing one or add a new pharmacy first.");

  // Governance: the registry validates that this role may submit from draft.
  await assertDirectOrderWorkflowTransition({
    access,
    actionKey: "submit",
    expectedNextStatus: "pending_approval",
    status: "draft",
  });

  const chain = await buildApprovalChain({ requesterHrId: actorHrId, requesterRole: access.role });

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
  });

  const firstStep = chain[0];
  const firstApprovers = firstStep.kind === "role" && firstStep.role ? await hrIdsForRole(firstStep.role) : [firstStep.approverHrId];
  await notifyDirectOrder({
    recipients: [...firstApprovers, ...(await ccRecipients())],
    title: "Direct order awaiting your approval",
    message: `A direct order (${product.productName} × ${qty}) needs your approval.`,
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
  const isSuperAdmin = access.role === "Super Admin" || access.scope === "system";
  const isAssigned = isCeoStep(activeStep)
    ? access.role === "CEO"
    : canonicalHrIdKey(access.hrId) === canonicalHrIdKey(activeStep.approverHrId ?? "");
  if (!isSuperAdmin && !isAssigned) {
    badRequest("Only the current assigned approver can act on this request.");
  }

  const comment = input.comment?.trim() || null;
  if ((input.decision === "reject" || input.decision === "return") && !comment) {
    badRequest("A reason is required to reject or return a request.");
  }
  // Over-cap (bonus OR discount) can only be finalized by a CEO override.
  if (input.decision === "approve" && isCeoStep(activeStep)) {
    const caps = await loadDirectOrderCaps();
    const overCap =
      request.dealType === "discount"
        ? (request.discountPct ?? 0) > resolveDiscountCapPct(caps, request.productCode)
        : request.bonus > maxBonusUnits({ qty: request.qty, capPct: resolveBonusCapPct(caps, request.productCode) });
    if (overCap && access.role !== "CEO" && !isSuperAdmin) {
      badRequest("This order's bonus/discount exceeds the cap; only the CEO can approve it.");
    }
  }

  const evaluation = evaluateStepAction({ steps, actorOrder: activeStep.order, decision: input.decision });
  if (!evaluation.allowed) badRequest(evaluation.reason ?? "This action is not allowed right now.");

  const action = directOrderDecisionAction({ decision: input.decision, isFinal: evaluation.isFinal });
  await assertDirectOrderWorkflowTransition({
    access,
    actionKey: action.actionKey,
    expectedNextStatus: action.expectedNextStatus,
    status: "pending_approval",
  });

  const now = new Date();
  const stepNextStatus = input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : null;
  const salesMonth = input.decision === "approve" && evaluation.isFinal ? now.toISOString().slice(0, 7) : null;

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

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: request.id,
    oldValues: { status: request.status },
    newValues: { status: result.status, decision: input.decision, step: activeStep.order },
    summary: `Direct order ${input.decision} by ${access.hrId} → ${result.status}.`,
  });
  await insertEvent({
    requestId: request.id,
    actorHrId: access.hrId,
    eventType: input.decision,
    message: comment ?? `${input.decision} at step ${activeStep.order}.`,
  });

  // Notify the requester on every decision; the next approver when the chain advances.
  const cc = await ccRecipients();
  const recipients: Array<string | null | undefined> = [request.requesterHrId, ...cc];
  if (result.status === "pending_approval") {
    const nextSteps = await loadSteps(request.id);
    const next = resolveActiveStep(nextSteps);
    if (next) {
      const nextApprovers = next.kind === "role" && next.role ? await hrIdsForRole(next.role) : [next.approverHrId];
      recipients.push(...nextApprovers);
    }
  }
  await notifyDirectOrder({
    recipients,
    title: `Direct order ${result.status.replace("_", " ")}`,
    message: `Your direct order (${request.productName} × ${request.qty}) was ${input.decision}d${comment ? `: ${comment}` : "."}`,
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

  const chain = await buildApprovalChain({ requesterHrId: actorHrId, requesterRole: access.role });

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
  return { request, steps };
}

// ── Approvals-hub reads (this hub surface is the SOLE approval gate) ──────────

/** Can the viewer act on `step` right now? Super Admin/system can act on any step. */
function viewerCanActOnStep(access: AccessContext, step: DirectOrderStepState | null): boolean {
  if (!step) return false;
  if (access.role === "Super Admin" || access.scope === "system") return true;
  return isCeoStep(step)
    ? access.role === "CEO"
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

function toApprovalListItem(
  request: DirectOrderRequest,
  active: DirectOrderStepState | null,
  requesterName: string | null,
  pharmacy: DirectOrderPharmacy | null,
): DirectOrderApprovalListItem {
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
    status: request.status,
    createdAt: request.createdAt,
    decidedAt: request.decidedAt,
    activeStepLabel: active?.label ?? "",
    activeStepOrder: active?.order ?? null,
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

  const stepsByReq = await loadStepsForRequests([...pending, ...historyRequests].map((r) => r.id));
  const pharmacies = await loadPharmaciesByIds([...pending, ...historyRequests].map((r) => r.pharmacyId));
  const nameOf = await nameLookup();

  const awaiting: DirectOrderApprovalListItem[] = [];
  for (const request of pending) {
    const active = resolveActiveStep(stepsByReq.get(request.id) ?? []);
    if (!viewerCanActOnStep(access, active)) continue;
    awaiting.push(toApprovalListItem(request, active, nameOf(request.requesterHrId), pharmacies.get(request.pharmacyId) ?? null));
  }
  const history: DirectOrderApprovalListItem[] = historyRequests.map((request) =>
    toApprovalListItem(
      request,
      resolveActiveStep(stepsByReq.get(request.id) ?? []),
      nameOf(request.requesterHrId),
      pharmacies.get(request.pharmacyId) ?? null,
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
  return requests.map((request) =>
    toApprovalListItem(
      request,
      resolveActiveStep(stepsByReq.get(request.id) ?? []),
      nameOf(request.requesterHrId),
      pharmacies.get(request.pharmacyId) ?? null,
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

/**
 * Field-line products for the submit form (code, name, line, factory + public price).
 * Scoped to the caller's own line when `access` is given — a CNS rep must never be
 * offered a Pedia/Anti Infective product. Omit `access` for an unscoped admin listing
 * (e.g. the caps editor, which manages caps across every product regardless of line).
 */
export async function listDirectOrderProductOptions(access?: AccessContext): Promise<
  Array<{ productCode: string; productName: string; line: string; factoryPrice: number; publicPrice: number | null }>
> {
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from("source_of_sales_products")
    .select("product_code, product_name, line, factory_price, public_price")
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
  areas: Array<{ areaCode: string; areaName: string; regionCode: string }>;
  bricks: Array<{ brickId: string; brickName: string; areaCode: string; regionCode: string }>;
}> {
  const ref = await loadSalesReferenceData({ includeCustomerBricks: false });

  let regionCodesInScope: Set<string> | null = null;
  if (access) {
    const salesScope = await resolveSalesAccessScope(access);
    if (salesScope.allowedRegionNames) {
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

  const areas = (ref.areas ?? [])
    .filter((area) => !regionCodesInScope || regionCodesInScope.has(area.regionCode.toUpperCase()))
    .map((area) => ({ areaCode: area.areaCode, areaName: area.areaName, regionCode: area.regionCode }))
    .sort((a, b) => a.areaName.localeCompare(b.areaName));
  const areaCodesInScope = new Set(areas.map((area) => area.areaCode.toUpperCase()));

  const bricks = (ref.bricks ?? [])
    .filter((brick) => areaCodesInScope.has(brick.areaCode.toUpperCase()))
    .map((brick) => ({ brickId: brick.brickId, brickName: brick.brickName, areaCode: brick.areaCode, regionCode: brick.regionCode }))
    .sort((a, b) => (a.brickName || a.brickId).localeCompare(b.brickName || b.brickId));

  return { areas, bricks };
}

export async function getDirectOrderApprovalDetail(
  access: AccessContext,
  requestId: string,
): Promise<DirectOrderApprovalDetail | null> {
  const loaded = await getDirectOrderRequest(access, requestId);
  if (!loaded) return null;
  const { request, steps } = loaded;
  const nameOf = await nameLookup();
  const pharmacies = await loadPharmaciesByIds([request.pharmacyId]);
  const active = resolveActiveStep(steps);
  const canAct = request.status === "pending_approval" && viewerCanActOnStep(access, active);
  const caps = await loadDirectOrderCaps();
  const bonusOverCap =
    request.dealType === "discount"
      ? (request.discountPct ?? 0) > resolveDiscountCapPct(caps, request.productCode)
      : request.bonus > maxBonusUnits({ qty: request.qty, capPct: resolveBonusCapPct(caps, request.productCode) });
  return {
    request,
    requesterName: nameOf(request.requesterHrId) ?? request.requesterHrId,
    pharmacy: pharmacies.get(request.pharmacyId) ?? null,
    steps: steps.map((step) => ({ ...step, approverName: step.approverHrId ? nameOf(step.approverHrId) : step.role })),
    availableActions: { approve: canAct, reject: canAct, return: canAct },
    bonusOverCap,
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

/** hrIds visible to the viewer: self + everyone below them in the reporting tree. */
async function resolveVisibleRequesterHrIds(access: AccessContext): Promise<Set<string>> {
  const directory = await getEmployeeDirectory();
  const children = new Map<string, string[]>();
  for (const employee of directory.employees) {
    const managerKey = canonicalHrIdKey(employee.managerHrId ?? "");
    const selfKey = canonicalHrIdKey(employee.hrId);
    if (managerKey && selfKey) {
      const list = children.get(managerKey) ?? [];
      list.push(selfKey);
      children.set(managerKey, list);
    }
  }
  const viewer = canonicalHrIdKey(access.hrId ?? "");
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

  // Resolve brick/area/region CODES → NAMES for display (owner wants both).
  const ref = await loadSalesReferenceData({ includeCustomerBricks: false });
  const brickNameById = new Map<string, string>();
  const areaNameByCode = new Map<string, string>();
  const regionNameByCode = new Map<string, string>();
  for (const brick of ref.bricks ?? []) {
    if (brick.brickId) brickNameById.set(brick.brickId, brick.brickName);
    if (brick.areaCode) areaNameByCode.set(brick.areaCode, brick.areaName);
    if (brick.regionCode) regionNameByCode.set(brick.regionCode, brick.regionName);
  }
  for (const area of ref.areas ?? []) if (area.areaCode) areaNameByCode.set(area.areaCode, area.areaName);
  for (const region of ref.regions ?? []) if (region.regionCode) regionNameByCode.set(region.regionCode, region.regionName);

  return requests.map((request) => {
    const active = resolveActiveStep(stepsByReq.get(request.id) ?? []);
    const pharmacy = pharmacies.get(request.pharmacyId) ?? null;
    const distributorCodesText = (pharmacy?.distributorCodes ?? [])
      .map((code) => `${code.distributorName}: ${code.customerCode}`)
      .join("; ");
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
  const ref = await loadSalesReferenceData({ includeCustomerBricks: false });
  const brickName = new Map<string, string>();
  for (const brick of ref.bricks ?? []) if (brick.brickId) brickName.set(brick.brickId, brick.brickName);

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

/** Set a product's public price (used by discount deals). Super Admin only. */
export async function setProductPublicPrice(
  access: AccessContext,
  input: { productCode: string; publicPrice: number | null },
): Promise<void> {
  if (!(access.scope === "system" || access.role === "Super Admin")) {
    throw new Error("Forbidden: only a System Admin can set public prices.");
  }
  const supabase = getSupabaseAdmin();
  const price = input.publicPrice == null ? null : Math.max(0, Number(input.publicPrice));
  const { error } = await supabase.from("source_of_sales_products").update({ public_price: price }).eq("product_code", input.productCode);
  if (error) throw error;
}
