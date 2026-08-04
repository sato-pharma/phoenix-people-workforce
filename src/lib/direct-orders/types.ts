import type { PhoenixRole } from "@/lib/auth/permissions";

// ─────────────────────────────────────────────────────────────────────────────
// Direct Order Request module — shared types.
//
// A Direct Order Request is a SINGLE line (one product + one pharmacy) submitted
// by a sales/marketing manager and approved up a sequential chain that always
// ends at the CEO. Money-critical: for a BONUS deal `salesValue` is `approvedQty ×
// pharmacyPrice` (bonus units never enter value); the bonus is separately capped, and
// exceeding that cap FLAGS the request rather than blocking it.
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

/**
 * Request lifecycle. `pending_approval` covers every in-chain rung; the active step tells you
 * which. `held` stands OUTSIDE the chain entirely — an order whose pharmacy is not in the master
 * database: submitted and visible, but in no approver's queue, and it can only leave `held` by
 * the pharmacy passing validation (→ `pending_approval` from step 1) or by the 14-day clock
 * (→ `expired`, a terminal dead end that is logged and counted per requester).
 */
export type DirectOrderStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "returned"
  | "reversed"
  | "held"
  | "expired";

export function isTerminalDirectOrderStatus(status: DirectOrderStatus): boolean {
  return status === "approved" || status === "rejected" || status === "reversed" || status === "expired";
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
  /**
   * Distributor customer-code pairs, at most one per distributor. OPTIONAL since 2026-08-04 —
   * a submitter who does not know the distributor or the code registers the pharmacy without
   * them, and the request picks up the System Admin rung instead of being refused.
   */
  distributorCodes: DirectOrderPharmacyDistributorCode[];
  /** Whether an admin has resolved a submitter-brick vs mapped-brick variance. */
  geoVarianceResolved: boolean;
  /**
   * 'pending_review' on every pharmacy registered by hand, until a System Admin approves the
   * acknowledgment rung. It covers all three ways Phoenix ends up not recognising a pharmacy:
   * it is brand new, its customer code is not in the distributor's own list, or no distributor
   * or code was given at all.
   *
   * It never blocks submission — it adds one rung to the chain (SFE → System Admin → the usual
   * line → CEO), because an unconfirmed code is how a different pharmacy's retail sales end up
   * attributed here.
   */
  verificationStatus: "verified" | "pending_review";
  /** 'manual' when the pharmacy was registered by hand; 'catalogue' when it came from the list. */
  entrySource: "catalogue" | "manual";
  verifiedByHrId: string | null;
  verifiedAt: string | null;
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
  /** Kept as a reference even for bonus deals, which now price on `pharmacyPriceSnapshot`. */
  factoryPriceSnapshot: number;
  /**
   * The pharmacy price this BONUS request was actually valued at. NULL means either a discount
   * deal, or a bonus deal that fell back to the factory price because the product had no
   * pharmacy price at submit time — which is exactly what `missingPharmacyPrice` reports.
   * Snapshotted rather than re-read, so it keeps describing THIS row after the master changes.
   */
  pharmacyPriceSnapshot: number | null;
  qty: number;
  bonus: number;
  bonusOverrideReason: string | null;
  /** 'bonus' → value = qty × pharmacyPrice; 'discount' → value = qty × publicPrice × (1−disc%). */
  dealType: DirectOrderDealType;
  discountPct: number | null;
  publicPriceSnapshot: number | null;
  /** Bonus mode: qty × pharmacyPrice. Discount mode: qty × publicPrice × (1−disc%). */
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

/** A code paired with its human name. The UI shows the NAME (owner rule: names, never codes). */
export type DirectOrderCodeName = { code: string; name: string };

/**
 * A pharmacy's geography resolved to NAMES. Each entry is null when the master data has no
 * row for that code — a data gap, never a crash. The wrapper itself is non-nullable so
 * components never write `detail.geo?.brick?.name ?? "—"` chains; the fallback lives in one
 * place (buildDirectOrderDetailFields).
 */
export type DirectOrderPharmacyGeo = {
  brick: DirectOrderCodeName | null;
  area: DirectOrderCodeName | null;
  region: DirectOrderCodeName | null;
};

/**
 * One distributor pairing on the approval window, with its mapped brick already resolved to a
 * NAME. The raw pairs live on `DirectOrderPharmacy.distributorCodes`; this is the display form,
 * so a component never has to reach for a bare `mappedBrickId`.
 */
export type DirectOrderDistributorRow = {
  distributorName: string;
  /** The distributor's own code, e.g. "Direct", "IbnSina". Shown alongside the name, never instead. */
  distributorCode: string;
  /** The code THIS distributor files the pharmacy under (their customer number). */
  customerCode: string;
  /** Where the customer map resolves this code to — names, null when the code is unmapped. */
  mappedBrickName: string | null;
  mappedAreaName: string | null;
  mappedRegionName: string | null;
};

/**
 * One summarized line of a pharmacy's ordering history: what it took of a product, from a
 * distributor, in a month. Aggregated across every request for that pharmacy so an approver
 * can see the pattern before deciding — is this the usual quantity, or ten times it?
 */
/**
 * Where a line of sales came from. The two must never be summed blindly: RETAIL is what the
 * distributor invoiced this pharmacy (uploaded monthly from their file); DIRECT is what Phoenix
 * booked from an approved direct order. They are different channels and are reported separately.
 */
export type DirectOrderSalesSource = "retail" | "direct";

/** One month of retail (distributor-invoiced) sales for a pharmacy, per product and distributor. */
export type DirectOrderRetailHistoryRow = {
  month: string;
  productCode: string;
  productName: string;
  distributorName: string;
  distributorCode: string;
  /** The distributor's own customer code for this pharmacy — how the match was made. */
  customerCode: string;
  qty: number;
  bonus: number;
  salesValue: number;
};

export type DirectOrderPharmacyHistoryRow = {
  /** YYYY-MM. The sales month once final-approved, otherwise the month it was submitted. */
  month: string;
  /** True when `month` came from the submission date because the order is not yet final. */
  monthIsProvisional: boolean;
  productCode: string;
  productName: string;
  distributorName: string;
  distributorCode: string;
  orders: number;
  qty: number;
  bonus: number;
  salesValue: number;
};

/**
 * The medical rep covering a pharmacy's (line, area), resolved LIVE from the seat model at
 * read time. Never stored on the request and never a form field — the org tree is the truth.
 *
 * `resolved` and `isVacant` mean different things and must not be collapsed: no REP seat at all
 * for this (line, area) is "we cannot say" (UI shows "—"), whereas a seat that exists with no
 * occupant is a genuine, reportable vacancy (UI shows "Vacant").
 */
export type DirectOrderAreaRep = {
  resolved: boolean;
  isVacant: boolean;
  repHrId: string | null;
  repName: string | null;
  /** Every occupied rep seat on this (line, area); >1 only on a split area. Never truncated. */
  repNames: string[];
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
  /** 'bonus' → `bonus` is the meaningful number; 'discount' → `discountPct` is. */
  dealType: DirectOrderDealType;
  discountPct: number | null;
  salesValue: number;
  pharmacyName: string;
  pharmacyCode: string;
  /** Geography as NAMES (owner rule). "" when the master data has no name for the code. */
  brickName: string;
  areaName: string;
  regionName: string;
  /** Rep display name; "" when vacant OR unresolved — `medicalRepVacant` distinguishes them. */
  medicalRepName: string;
  medicalRepVacant: boolean;
  /** Distributor NAMES only ("Ibn Sina · Overseas"); the name→code pairs live on the detail. */
  distributorNames: string;
  status: DirectOrderStatus;
  createdAt: string;
  decidedAt: string | null;
  /** The rung currently waiting (empty for terminal requests). */
  activeStepLabel: string;
  activeStepOrder: number | null;
  /** True when the bonus/discount exceeds its product cap — flagged for the approver, NOT blocked. */
  bonusOverCap: boolean;
  /** True when a bonus deal fell back to the factory price because no pharmacy price was set. */
  missingPharmacyPrice: boolean;
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
  /** The pharmacy price a bonus deal was valued at; null = discount deal, or factory fallback. */
  pharmacyPriceSnapshot: number | null;
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
  /** Brick / area / region as NAMES. Non-null wrapper; see DirectOrderPharmacyGeo. */
  geo: DirectOrderPharmacyGeo;
  /** Resolved live from the seat model on every read. Non-null wrapper; see DirectOrderAreaRep. */
  medicalRep: DirectOrderAreaRep;
  /**
   * The product's CURRENT prices, distinct from the snapshots on the request.
   *
   * A snapshot is null whenever that basis did not price THIS deal — a discount order stores no
   * pharmacy price. Reading that as "no pharmacy price exists" is wrong, and was actively
   * misleading: a live discount order displayed "Pharmacy price — not set" for a product whose
   * pharmacy price was 281.688. These fields let the window distinguish "never entered" from
   * "entered, but not the basis for this deal".
   */
  productPharmacyPrice: number | null;
  productPublicPrice: number | null;
  /** "Ibn Sina: 1234567; Overseas: 7654321" — the same projection the report and email use. */
  distributorCodesText: string;
  /** The same pairs as display rows, with codes kept and mapped geography resolved to names. */
  distributors: DirectOrderDistributorRow[];
  /**
   * This pharmacy's ordering history — month x product x distributor — EXCLUDING the request
   * being decided, so the approver reads "what it normally takes" rather than a total that
   * already contains the number they are judging.
   */
  pharmacyHistory: DirectOrderPharmacyHistoryRow[];
  /**
   * Retail sales the DISTRIBUTORS invoiced this pharmacy, kept strictly separate from the
   * direct-order history above. Matched on (distributor code + customer code) together —
   * a customer code alone is not unique across distributors and would attribute another
   * pharmacy's sales to this one.
   */
  retailHistory: DirectOrderRetailHistoryRow[];
  /** True when the pharmacy has no distributor pair that can be matched to retail sales at all. */
  retailUnmatchable: boolean;
  steps: Array<DirectOrderStepState & { approverName: string | null }>;
  availableActions: DirectOrderAvailableActions;
  /** True when the bonus/discount exceeds its product cap — flagged for the approver, NOT blocked. */
  bonusOverCap: boolean;
  /** True when a bonus deal fell back to the factory price because no pharmacy price was set. */
  missingPharmacyPrice: boolean;
  /**
   * Whether THIS viewer may book the order into a sales month. Finance (Ahmed El Maraghy) and
   * Super Admin can; the CEO and SFE Manager see the month but cannot change it.
   */
  canSetSalesMonth: boolean;
};

export type DirectOrderWorkspaceData = {
  awaiting: DirectOrderApprovalListItem[];
  history: DirectOrderApprovalListItem[];
};

// ── Direct-sales reconciliation (manual DIRECT vs module DirectReq) ────────────
/** One (period, line, region, product) bucket where BOTH direct sources have value. */
export type DirectSalesReconciliationOverlap = {
  period: string;
  line: string;
  regionCode: string;
  productCode: string;
  manualValue: number;
  manualQty: number;
  moduleValue: number;
  moduleQty: number;
  /** least(manual, module) — the amount at risk of being counted twice. */
  overlapExposure: number;
};

export type DirectSalesReconciliationPeriod = {
  period: string;
  manualValue: number;
  moduleValue: number;
  overlapExposure: number;
};

export type DirectSalesReconciliationResult = {
  periodFrom: string | null;
  periodTo: string | null;
  groupedRows: number;
  overlapRows: number;
  totalManualDirect: number;
  totalModuleDirect: number;
  overlapExposure: number;
  /** True when there is no overlap between the two direct sources. */
  pass: boolean;
  overlaps: DirectSalesReconciliationOverlap[];
  byPeriod: DirectSalesReconciliationPeriod[];
};
