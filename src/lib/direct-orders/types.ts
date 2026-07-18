import type { PhoenixRole } from "@/lib/auth/permissions";

// ─────────────────────────────────────────────────────────────────────────────
// Direct Order Request module — shared types.
//
// A Direct Order Request is a SINGLE line (one product + one pharmacy) submitted
// by a sales/marketing manager and approved up a sequential chain that always
// ends at the CEO. Money-critical: `salesValue` is always `approvedQty ×
// factoryPrice` (bonus units never enter value); the bonus is separately capped.
//
// Requesters (phase 1, managers only): District Manager, Regional Manager,
// National Sales Manager, Product Manager, Group Product Manager.
// Approval ladder (owner-locked):
//   District Manager → Regional Manager → National Sales Manager → CEO
//   Regional Manager → National Sales Manager → CEO
//   National Sales Manager → CEO
//   Product Manager / Group Product Manager → CEO (straight to CEO)
// Each non-CEO rung is the requester's ACTUAL manager (resolved from the live org
// / seat model, vacancy-aware); the final rung is the CEO resolved BY ROLE.
// ─────────────────────────────────────────────────────────────────────────────

/** Roles allowed to submit a direct order in phase 1 (Medical Rep added later). */
export const DIRECT_ORDER_REQUESTER_ROLES: readonly PhoenixRole[] = [
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
] as const;

export function isDirectOrderRequesterRole(role: PhoenixRole | string | null | undefined): boolean {
  return DIRECT_ORDER_REQUESTER_ROLES.includes(String(role ?? "").trim() as PhoenixRole);
}

/** Request lifecycle. `pending_approval` covers every in-chain rung; the active step tells you which. */
export type DirectOrderStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "returned"
  | "reversed";

export function isTerminalDirectOrderStatus(status: DirectOrderStatus): boolean {
  return status === "approved" || status === "rejected" || status === "reversed";
}

/** The three actions an approver can take at their rung. */
export type DirectOrderDecision = "approve" | "reject" | "return";

/** A rung is either a specific person (an actual manager) or a role (the CEO). */
export type DirectOrderApproverKind = "person" | "role";

export type DirectOrderStepStatus = "pending" | "approved" | "rejected";

/** One rung in a request's approval chain. `order` is 1-based and gates sequencing. */
export type DirectOrderStepState = {
  order: number;
  kind: DirectOrderApproverKind;
  /** Populated for role rungs (always "CEO" in phase 1). */
  role: PhoenixRole | null;
  /** Populated for person rungs (the requester's actual manager at this level). */
  approverHrId: string | null;
  /** Job-title / role label for the UI timeline (never hardcode DSM/RM/NSM in components). */
  label: string;
  status: DirectOrderStepStatus;
};

/** Bonus deal (qty × factory) or Discount deal (qty × public × (1−disc%)). */
export type DirectOrderDealType = "bonus" | "discount";

/** One mandatory distributor↔customer-code pair on a pharmacy (≥1 per pharmacy). */
export type DirectOrderPharmacyDistributorCode = {
  distributorCode: string;
  distributorName: string;
  customerCode: string;
  /** Brick/area/region the customer map resolves this code to (null when unmapped). */
  mappedBrickId: string | null;
  mappedAreaCode: string | null;
  mappedRegionCode: string | null;
};

/** The reusable pharmacy registry row (direct-side equivalent of a distributor client_code). */
export type DirectOrderPharmacy = {
  id: string;
  /** Phoenix-generated stable code, e.g. "DOP-000123". */
  phoenixPharmacyCode: string;
  pharmacyName: string;
  brickId: string | null;
  areaCode: string | null;
  regionCode: string | null;
  doctorName: string | null;
  pharmacyAddress: string | null;
  /** Mandatory ≥1 distributor customer-code pairs (Ahmed = ####### @ Ibn Sina, @@@@@@@ @ Overseas). */
  distributorCodes: DirectOrderPharmacyDistributorCode[];
  /** Whether an admin has resolved a submitter-brick vs mapped-brick variance. */
  geoVarianceResolved: boolean;
  createdByHrId: string;
  active: boolean;
};

/** A single direct order request (header + its one line, since grain = single line). */
export type DirectOrderRequest = {
  id: string;
  requesterHrId: string;
  requesterRole: PhoenixRole;
  status: DirectOrderStatus;
  line: string;
  productCode: string;
  productName: string;
  factoryPriceSnapshot: number;
  qty: number;
  bonus: number;
  bonusOverrideReason: string | null;
  /** 'bonus' → value = qty × factoryPrice; 'discount' → value = qty × publicPrice × (1−disc%). */
  dealType: DirectOrderDealType;
  discountPct: number | null;
  publicPriceSnapshot: number | null;
  /** Bonus mode: qty × factoryPrice. Discount mode: qty × publicPrice × (1−disc%). */
  salesValue: number;
  pharmacyId: string;
  /** YYYY-MM; set to the CEO-final-approval month on final approval. */
  salesMonth: string | null;
  /** Expected money-collection date (YYYY-MM-DD), entered by the requester at submit. */
  collectionDate: string | null;
  marketingRequestId: string | null;
  /** Post-approval, Finance-editable collections fields (outside the approval gate). */
  paymentDate: string | null;
  paidAmount: number | null;
  remainingAmount: number | null;
  /** Injection + reversal bookkeeping (phase C). */
  sosBatchId: string | null;
  reversalOfRequestId: string | null;
  reversedByRequestId: string | null;
  createdAt: string;
  decidedAt: string | null;
};

export const DIRECT_ORDER_WORKFLOW_MODULE_KEY = "direct_orders" as const;

// ─── Approvals-hub view models ───────────────────────────────────────────────

/** Which response buttons the current viewer may use on a request (the hub page is the ONLY approval gate). */
export type DirectOrderAvailableActions = {
  approve: boolean;
  reject: boolean;
  return: boolean;
};

/** A row in the "Direct Orders Approvals" list (awaiting or history). Names, never bare codes. */
export type DirectOrderApprovalListItem = {
  id: string;
  requesterHrId: string;
  requesterName: string;
  requesterRole: PhoenixRole;
  line: string;
  productName: string;
  qty: number;
  bonus: number;
  salesValue: number;
  pharmacyName: string;
  pharmacyCode: string;
  status: DirectOrderStatus;
  createdAt: string;
  decidedAt: string | null;
  /** The rung currently waiting (empty for terminal requests). */
  activeStepLabel: string;
  activeStepOrder: number | null;
};

/** Everything the detail page needs, including the viewer's allowed actions. */
/**
 * One fully-denormalized row for the Direct Orders report page + xlsx export.
 * Carries EVERY field (request + pharmacy + requester + approval progress) — the
 * owner's requirement is "do not minus even one field".
 */
export type DirectOrderReportRow = {
  id: string;
  requesterHrId: string;
  requesterName: string;
  requesterRole: PhoenixRole;
  status: DirectOrderStatus;
  line: string;
  productCode: string;
  productName: string;
  factoryPriceSnapshot: number;
  qty: number;
  bonus: number;
  bonusOverrideReason: string | null;
  dealType: DirectOrderDealType;
  discountPct: number | null;
  publicPriceSnapshot: number | null;
  salesValue: number;
  collectionDate: string | null;
  salesMonth: string | null;
  marketingRequestId: string | null;
  paymentDate: string | null;
  paidAmount: number | null;
  remainingAmount: number | null;
  reversalOfRequestId: string | null;
  reversedByRequestId: string | null;
  sosBatchId: string | null;
  createdAt: string;
  decidedAt: string | null;
  activeStepLabel: string;
  activeStepOrder: number | null;
  // pharmacy (from the registry)
  pharmacyCode: string;
  pharmacyName: string;
  pharmacyAddress: string;
  brickId: string;
  brickName: string;
  areaCode: string;
  areaName: string;
  regionCode: string;
  regionName: string;
  doctorName: string;
  /** All distributor customer-code pairs, joined: "Ibn Sina: #####; Overseas: @@@@@". */
  distributorCodesText: string;
};

/** How much of the report the viewer may see (owner-tiered). */
export type DirectOrderReportScope = "all" | "hierarchy" | "own";

export type DirectOrderApprovalDetail = {
  request: DirectOrderRequest;
  requesterName: string;
  pharmacy: DirectOrderPharmacy | null;
  steps: Array<DirectOrderStepState & { approverName: string | null }>;
  availableActions: DirectOrderAvailableActions;
  /** True when the bonus exceeds its product cap (only the CEO may finalize it). */
  bonusOverCap: boolean;
};

export type DirectOrderWorkspaceData = {
  awaiting: DirectOrderApprovalListItem[];
  history: DirectOrderApprovalListItem[];
};
