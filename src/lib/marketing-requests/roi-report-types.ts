import type { PhoenixRole } from "@/lib/auth/permissions";
import type {
  MarketingRequestStatus,
  MarketingRoiAttributionQuality,
} from "@/lib/marketing-requests/types";

// ─────────────────────────────────────────────────────────────────────────────
// Marketing ROI Tracking — Filter-Engine executive report.
//
// Pure, shared contracts for the filter-first ROI report rendered on all three
// shells (admin, employee portal, workspace). Nothing here touches the DB or the
// network so the scope + filter-option logic can be unit-tested directly.
//
// Locked design facts (verified read-only against prod 2026-06-20):
//  - Attribution is exact-customer-only → result status ∈ {on_track, behind,
//    no_data, awaiting_data}. (Brick fallback exists in the type forward-compat
//    but is never produced.)
//  - Line is derived from the REQUESTER's employees.line_id, never
//    marketing_requests.line_id (that column is effectively NULL).
//  - Distributors roll up to their parent (ROI-only) via the actuals RPC; the
//    distributor filter therefore offers PARENT codes only.
//  - Confidential products (LA003/LA004/SS001) are masked out of options, rows,
//    KPIs and exports unless a CEO/Super Admin explicitly opts in.
// ─────────────────────────────────────────────────────────────────────────────

/** Realized-ROI result status. `awaiting_data` = the ROI window has months that
 *  have not been uploaded yet (≠ behind). */
export type MarketingRoiResultStatus = "on_track" | "behind" | "no_data" | "awaiting_data";

/** Keys for every filter dimension offered by the Filter Engine. */
export type RoiFilterKey =
  | "dm"
  | "nsm"
  | "rsm"
  | "line"
  | "approvedBy"
  | "requester"
  | "status"
  | "requestType"
  | "region"
  | "distributor"
  | "product"
  | "pharmacy"
  | "roiStatus"
  | "payDate"
  | "duration"
  | "includeRestricted";

/** The full, combinable filter state. Multi-select dimensions are AND-combined
 *  across types and OR-combined within a type. Empty array / null = no constraint. */
export type RoiFilterState = {
  dm: string[];
  nsm: string[];
  rsm: string[];
  line: string[];
  approvedBy: string[];
  requester: string[];
  status: MarketingRequestStatus[];
  requestType: number[];
  region: string[];
  distributor: string[];
  product: string[];
  pharmacy: string[];
  roiStatus: MarketingRoiResultStatus[];
  payDateFrom: string | null;
  payDateTo: string | null;
  durationMin: number | null;
  durationMax: number | null;
  includeRestricted: boolean;
};

export function emptyRoiFilterState(): RoiFilterState {
  return {
    dm: [],
    nsm: [],
    rsm: [],
    line: [],
    approvedBy: [],
    requester: [],
    status: [],
    requestType: [],
    region: [],
    distributor: [],
    product: [],
    pharmacy: [],
    roiStatus: [],
    payDateFrom: null,
    payDateTo: null,
    durationMin: null,
    durationMax: null,
    includeRestricted: false,
  };
}

/** One selectable option in a multi-select dimension, with how many visible
 *  requests carry it (so the UI can show counts and the engine can prove
 *  "never empty"). */
export type RoiFilterOption = {
  value: string;
  label: string;
  count: number;
};

export type RoiFilterDimensionType = "multiselect" | "dateRange" | "numberRange" | "toggle";

/**
 * A single dimension as resolved for one viewer's visible request set.
 *
 * `render` enforces the locked "never show a dead filter" rule: a multi-select
 * renders only when ≥2 live options exist; exactly 1 live value is auto-applied
 * (and the control hidden); 0 hides it. Ranges render only when the bound is
 * meaningful; the confidential toggle renders only when the viewer may reveal AND
 * there is something restricted to reveal.
 */
export type RoiFilterDimension = {
  key: RoiFilterKey;
  label: string;
  type: RoiFilterDimensionType;
  options: RoiFilterOption[];
  render: boolean;
  /** The only live value(s) for this dimension across the viewer's scoped set — shown
   *  read-only as a "scope" chip rather than offered as a choice. Display-only: it is
   *  implicitly satisfied because every visible request already carries this value (the
   *  scope already narrowed to it), so it is NOT separately applied as a filter. Null
   *  when the dimension renders normally. */
  autoApplied: string[] | null;
  /** numberRange bounds (e.g. ROI duration months). */
  min?: number;
  max?: number;
  /** dateRange bounds (YYYY-MM-DD) derived from visible pay dates. */
  earliest?: string | null;
  latest?: string | null;
};

export type MarketingRoiFilterOptions = {
  dimensions: RoiFilterDimension[];
  /** Total requests visible to this viewer before any filter is applied. */
  visibleRequestCount: number;
  /** Whether this viewer may ever reveal confidential products. */
  canRevealRestricted: boolean;
};

/**
 * Lightweight, role-scoped projection of one marketing request used to (a) compute
 * filter options cheaply (no ROI math) and (b) apply the chosen filters in TS.
 * Built once per request from the request row + its requester's directory entry +
 * its products/pharmacies/approval stages.
 */
export type MarketingRoiRequestIndexEntry = {
  requestId: string;
  requestCode: string;
  /** normalized (lower-cased) requester HR_ID — the join key for scoping. */
  requesterHrId: string;
  requesterName: string | null;
  managerHrId: string | null;
  status: MarketingRequestStatus;
  requestTypeId: number;
  requestTypeName: string | null;
  payDate: string | null;
  roiDurationMonths: number;
  /** derived from the requester's employees.line_id/line_name. */
  lineName: string | null;
  regionName: string | null;
  /** requester's managerial-chain seats, normalized HR_IDs (null if vacant). */
  dmHrId: string | null;
  dmName: string | null;
  nsmHrId: string | null;
  nsmName: string | null;
  rsmHrId: string | null;
  rsmName: string | null;
  /** distinct normalized approval-stage role keys present (native steps +
   *  backfilled CRM stage), e.g. "National Sales Manager", "SFE Manager". */
  approverRoleKeys: string[];
  /** rolled-up PARENT distributor codes targeted by this request. */
  distributorCodes: string[];
  /** promoted product codes (upper-cased). */
  productCodes: string[];
  productNames: string[];
  /** target pharmacy identity keys + display names. */
  pharmacyKeys: string[];
  pharmacyNames: string[];
  /** true when any promoted product is confidential (LA003/LA004/SS001). */
  hasRestrictedProduct: boolean;
};

/** The viewer's resolved data-visibility scope. Pure: derived from AccessContext +
 *  the employee directory once per request. */
export type MarketingRoiScope = {
  role: PhoenixRole;
  /** company-wide marketing oversight (CEO, Finance, Financial Advisor, Marketing
   *  Manager, SFE Manager, Super Admin, system) → sees every request. */
  isCompanyWide: boolean;
  viewerHrId: string | null;
  /** the viewer can only ever see their own requests (Medical Rep / baseline). */
  selfOnly: boolean;
  /** normalized requester HR_IDs whose requests are visible. null = all (company). */
  visibleRequesterHrIds: Set<string> | null;
  /** seats (normalized HR_IDs) classified by job function within the visible set,
   *  excluding the viewer's own seat. Diagnostic/invariant fields (pinned by the scope
   *  unit tests) — the actual per-DM / per-NSM / per-RSM filter OPTIONS are derived from
   *  the already-scoped request index in computeMarketingFilterOptions, not from these. */
  visibleDmHrIds: Set<string>;
  visibleNsmHrIds: Set<string>;
  visibleRsmHrIds: Set<string>;
  /** line names within the visible set. null = all (company). */
  visibleLineNames: Set<string> | null;
  /** product codes the viewer owns (PM/GPM). null = no product restriction. */
  visibleProductCodes: Set<string> | null;
  /** the viewer may opt-in to reveal confidential products. */
  canRevealRestricted: boolean;
};

/** One row of the on-screen results table. Summarized; the XLSX carries every field. */
export type MarketingRoiReportRow = {
  requestId: string;
  requestCode: string;
  requesterHrId: string;
  requesterName: string | null;
  line: string | null;
  region: string | null;
  customerName: string;
  status: MarketingRequestStatus;
  requestTypeName: string | null;
  payDate: string | null;
  roiWindow: string | null;
  roiDurationMonths: number;
  estimatedCost: number;
  expectedRoiValue: number;
  requiredRoiValue: number;
  actualSalesValue: number;
  actualSalesUnits: number;
  actualCoverageRatio: number;
  resultStatus: MarketingRoiResultStatus;
  attributionQuality: MarketingRoiAttributionQuality;
  hasSalesData: boolean;
  salesDataComplete: boolean;
  /** human reason when nothing attributed (e.g. "no pharmacy codes"). */
  attributionGapReason: string | null;
  approverRoleKeys: string[];
  productCodes: string[];
  distributorCodes: string[];
};

/** Executive KPI band + trust signals computed over the filtered, scoped rows. */
export type MarketingRoiKpiBand = {
  requestCount: number;
  totalEstimatedCost: number;
  totalExpectedRoi: number;
  totalRequiredRoi: number;
  totalActualValue: number;
  /** actual / required across the filtered set (0..1+). */
  coverageRatio: number;
  onTrackCount: number;
  behindCount: number;
  awaitingDataCount: number;
  noDataCount: number;
  /** value held in not-yet-approved requests within the filtered set. */
  approvedValue: number;
  pendingValue: number;
  /** latest validated SoS invoice period (YYYY-MM) backing attribution. */
  salesDataAsOf: string | null;
  /** requests whose ROI window extends past salesDataAsOf (incomplete windows). */
  incompleteWindowCount: number;
  restrictedExcludedCount: number;
};

export type MarketingRoiReport = {
  rows: MarketingRoiReportRow[];
  kpi: MarketingRoiKpiBand;
  appliedFilters: RoiFilterState;
  /** echoed so the client can render "auto-applied" chips it cannot change. */
  autoAppliedByDimension: Partial<Record<RoiFilterKey, string[]>>;
  includedRestricted: boolean;
  generatedAtIso: string;
};

/** A per-user saved Filter-Engine view. */
export type MarketingRoiPreset = {
  id: string;
  name: string;
  filters: RoiFilterState;
  isDefault: boolean;
  updatedAt: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Exhaustive export detail (flattened per-request rows for the XLSX sheets)
// ─────────────────────────────────────────────────────────────────────────────

export type MarketingRoiExportProductRow = {
  requestId: string;
  requestCode: string;
  productCode: string;
  productName: string;
  line: string | null;
  factoryPrice: number;
  forecastQty: number;
  expectedValue: number;
  valueShare: number;
};

export type MarketingRoiExportPharmacyRow = {
  requestId: string;
  requestCode: string;
  pharmacyName: string;
  customerCode: string;
  distributorCode: string | null;
  trackingStatus: string | null;
};

export type MarketingRoiExportApprovalRow = {
  requestId: string;
  requestCode: string;
  sequence: number;
  stepName: string;
  assignedRole: string;
  assignedHrId: string | null;
  status: string;
  decisionByHrId: string | null;
  decisionAt: string | null;
  decisionNote: string | null;
  isCc: boolean;
};

export type MarketingRoiExportDetail = {
  products: MarketingRoiExportProductRow[];
  pharmacies: MarketingRoiExportPharmacyRow[];
  approvals: MarketingRoiExportApprovalRow[];
};

// ─────────────────────────────────────────────────────────────────────────────
// View Sales — per-request drill-down (opens in a new tab)
// ─────────────────────────────────────────────────────────────────────────────

/** One matched Source-of-Sales detail row (rolled-up distributor, customer-code match). */
export type MarketingRoiViewSalesRow = {
  distributorCode: string;
  distributorName: string;
  invoicePeriod: string;
  productCode: string;
  productName: string;
  customerCode: string;
  customerName: string | null;
  regionName: string | null;
  qty: number;
  value: number;
};

export type MarketingRoiViewSalesContext = {
  requestId: string;
  requestCode: string;
  customerName: string;
  requesterHrId: string;
  requesterName: string | null;
  line: string | null;
  status: MarketingRequestStatus;
  requestTypeName: string | null;
  payDate: string | null;
  roiDurationMonths: number;
  /** the request's own ROI window label (pay_date → +duration). */
  roiWindowLabel: string | null;
  estimatedCost: number;
  expectedRoiValue: number;
  requiredRoiValue: number;
  products: Array<{ code: string; name: string }>;
  pharmacies: Array<{ code: string; name: string }>;
  approverRoleKeys: string[];
};

export type MarketingRoiViewSalesAggregate = {
  key: string;
  label: string;
  value: number;
  units: number;
};

/** A request that also targets one of this request's pharmacies (scope-gated). */
export type MarketingRoiReverseLookupRow = {
  requestId: string;
  requestCode: string;
  requesterName: string | null;
  status: MarketingRequestStatus;
  sharedPharmacyCodes: string[];
};

export type MarketingRoiViewSales = {
  context: MarketingRoiViewSalesContext;
  /** the period range actually queried. */
  range: { from: string; to: string; isCustom: boolean };
  rows: MarketingRoiViewSalesRow[];
  totals: { value: number; units: number; rows: number };
  /** actual vs the request's required return over the queried range. */
  actualValue: number;
  coverageRatio: number;
  /** TS-pivoted aggregates for the drill-down charts/tables. */
  byMonth: MarketingRoiViewSalesAggregate[];
  byProduct: MarketingRoiViewSalesAggregate[];
  byPharmacy: MarketingRoiViewSalesAggregate[];
  /** flat pharmacy × product × month cells (the component pivots as needed). */
  matrix: Array<{ customerCode: string; customerName: string | null; productCode: string; productName: string; period: string; value: number; units: number }>;
  /** other visible requests targeting this request's pharmacies. */
  reverseLookup: MarketingRoiReverseLookupRow[];
  includedRestricted: boolean;
  salesDataAsOf: string | null;
  generatedAtIso: string;
};
