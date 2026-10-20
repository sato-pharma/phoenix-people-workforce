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

/** Whether the request's ROI window is fully / partly / not backed by validated SoS data.
 *  `partial_pending` = some window months are not yet uploaded; `no_validated_data` = the
 *  window is entirely outside the validated range (or nothing is validated yet). */
export type MarketingRoiDataCoverage = "complete" | "partial_pending" | "no_validated_data";

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
 * The role-scoped request index shipped to the client so it can compute SMART,
 * dependent (faceted) filter options live — each dimension recomputed from the
 * requests matching the current selection in all other dimensions. The entries are
 * already scoped + confidential-masked for the viewer (so shipping them cannot leak).
 */
export type MarketingRoiFilterFacets = {
  entries: MarketingRoiRequestIndexEntry[];
  canRevealRestricted: boolean;
  totalCount: number;
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
  /**
   * Area ids whose requests the viewer may see whatever seat raised them — a TERRITORY route
   * beside the requester route above, matched against the target customer's `area_id`.
   *
   * Empty for every seat but the Medical Rep. Owner instruction 2026-09-18: a rep keeps the ROI
   * Tracker "to be able to track roi of requests his manager did in his area". A rep raises no
   * requests of their own any more, so the requester route alone leaves the page blank; this is
   * what puts their District Manager's spend on their own patch in front of them, and nothing
   * wider — a request the DM raised on a SIBLING rep's area carries that area's id and stays out.
   *
   * Same territorial rule the owner set for marketing customers on 2026-08-19 ("they must be
   * assigned to areas"), applied to the report that reads them.
   *
   * NOT sufficient on its own — see `visibleAreaLineNames` below, which is the other half.
   */
  visibleAreaIds: Set<number>;
  /**
   * The viewer's OWN line names, lower-cased — the second half of the territory route above, and
   * the half that was missing until 2026-09-30.
   *
   * AN AREA IS NOT PER LINE. `public.areas` holds the Source-of-Sales area codes with `line_id`
   * NULL (the old per-line rows, ids 76/77, are inactive), so "Gharbia 2 (Mahalla)" is ONE row,
   * id 1104, carried at once by the Pedia rep, the CNS rep and the Anti Infective rep on that
   * patch. Matching on `area_id` alone therefore handed every rep on an area every OTHER line's
   * spend on it: measured on production 2026-09-30, 46 of the 82 rep×request pairs the territory
   * route admitted were another line's campaign, reaching 28 of the 72 active reps — and the Pedia
   * rep on Gharbia 2 saw exactly one row, the CNS District Manager's, which is the report the owner
   * called a fatal mistake.
   *
   * So the route is area AND line: a request reaches a rep only when it is also demonstrably HIS
   * line, read from the requester's own line and the promoted products' lines (the two never
   * disagree on production — 45 of 45 requests with a pay date). A request whose line cannot be
   * established at all is NOT admitted here; the requester route is untouched, so nothing the
   * hierarchy already granted him is lost.
   *
   * Empty for every seat but the Medical Rep, exactly like `visibleAreaIds`.
   */
  visibleAreaLineNames: Set<string>;
  /**
   * The LINE route, National Sales Manager only (owner, 2026-10-20: "He sees every campaign on his
   * line, whoever ran it") — the viewer's own line plus every line on his `line_scope_override`,
   * lower-cased.
   *
   * The requester route above walks the manager chain, and the Product Managers, Group Product
   * Managers and the Marketing Manager sit in the Marketing department under the Marketing
   * Manager, so not one of their campaigns ever reached the NSM whose line they were spent on. This
   * is the second door beside it: a request is ALSO his when it is on one of these lines, whoever
   * raised it. A request's lines are the requester's seat line plus every promoted product's line
   * (all of them, never the confidential-masked list), so a request spanning two lines reaches the
   * NSM of each. An unknown line is never his. The decision is `lineRouteAdmitsRequest`.
   *
   * It widens WHICH requests he sees, never which product names are revealed — `canRevealRestricted`
   * is untouched. Empty for every other seat, so the route is inert for them.
   */
  visibleLineRouteNames: Set<string>;
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
  /** forecast coverage = expected_roi_value / required_roi_value (forecast, not actual). */
  forecastCoverageRatio: number;
  /** whether the ROI window is fully / partly / not backed by validated SoS data. */
  dataCoverage: MarketingRoiDataCoverage;
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

/** One invoice line as claimed by ONE request — the detail behind that request's actuals.
 *
 * Lives here rather than in roi-report-service.ts (which re-exports it) so that
 * {@link MarketingRoiReport} can carry the ledger without the types module importing the service
 * module that already imports it. */
export type RoiAttributionLine = {
  customerCode: string;
  distributorCode: string;
  invoicePeriod: string;
  productCode: string;
  qty: number;
  requestId: string;
  value: number;
};

export type MarketingRoiReport = {
  rows: MarketingRoiReportRow[];
  kpi: MarketingRoiKpiBand;
  appliedFilters: RoiFilterState;
  /** echoed so the client can render "auto-applied" chips it cannot change. */
  autoAppliedByDimension: Partial<Record<RoiFilterKey, string[]>>;
  includedRestricted: boolean;
  generatedAtIso: string;
  /** The claimed invoice lines behind `rows`. Carried on the result so any caller that REBUILDS
   * the KPI band over a narrowed row set (the ROI Tracker's per-origin split, the Coverage Report)
   * can pass it to buildKpiBand and count a sale claimed by several campaigns exactly once.
   * Without it those pages re-sum the per-request figures and read ~52% high — the defect this
   * ledger exists to close, on the very screens it is read from. */
  attributionLines: RoiAttributionLine[];
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

/** One matched sale (product + invoice month + pharmacy) for the Coverage Report export's
 *  "Sales Detail" sheet — the bulk, many-request equivalent of MarketingRoiViewSalesRow.
 *  Coverage-report-scoped only (see loadMarketingCoverageExportSalesDetail); NOT part of
 *  MarketingRoiExportDetail, which is shared with the ROI Tracking export and must not pay
 *  for this extra RPC when it doesn't need it. */
export type MarketingCoverageExportSalesDetailRow = {
  requestId: string;
  requestCode: string;
  customerCode: string;
  distributorCode: string | null;
  distributorName: string | null;
  productCode: string;
  productName: string;
  invoicePeriod: string;
  qty: number;
  value: number;
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
  /**
   * Units for this bucket — `null` when its rows span more than one product code. Units of
   * different products are never added (owner golden rule); such a bucket is read by value.
   */
  units: number | null;
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
  /** `units` is null when the matched rows span more than one product code (never add units across products). */
  totals: { value: number; units: number | null; rows: number };
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

// ─────────────────────────────────────────────────────────────────────────────
// Marketing Coverage Report — composed extensions.
//
// A separate, broader-access report over the same underlying requests. Everything
// here is COMPOSED on top of the ROI Tracking types above (never a union-edit of
// them), so ROI Tracking's contract can never drift because of this report:
//  - company-wide visibility is narrower (CEO / Super Admin / SFE Manager /
//    Marketing Manager only — Finance Manager/Financial Advisor are scoped here,
//    unlike ROI Tracking);
//  - two extra filter dimensions (area, requester tier);
//  - two extra KPI counts (distinct target pharmacies, distinct customers).
// ─────────────────────────────────────────────────────────────────────────────

/** Keys for the 2 filter dimensions this report adds on top of the shared RoiFilterKey set. */
export type MarketingCoverageFilterKey = RoiFilterKey | "area" | "requesterTier";

export type MarketingCoverageFilterState = RoiFilterState & {
  /** requester's employees.area (via areas.name), not a marketing_requests column. */
  area: string[];
  /** requester's OWN job-function classification (Medical Rep / District Manager /
   *  Regional Manager / National Sales Manager / …), not the downstream DM/NSM/RSM
   *  chain seats the shared `dm`/`nsm`/`rsm` dimensions already filter by. */
  requesterTier: string[];
};

export function emptyMarketingCoverageFilterState(): MarketingCoverageFilterState {
  return { ...emptyRoiFilterState(), area: [], requesterTier: [] };
}

/** Same dimension shape as RoiFilterDimension, keyed by the wider coverage key set. */
export type CoverageFilterDimension = Omit<RoiFilterDimension, "key"> & { key: MarketingCoverageFilterKey };

export type MarketingCoverageFilterOptions = {
  dimensions: CoverageFilterDimension[];
  visibleRequestCount: number;
  canRevealRestricted: boolean;
};

/** MarketingRoiRequestIndexEntry + the 2 extra facet fields this report filters by. */
export type MarketingCoverageRequestIndexEntry = MarketingRoiRequestIndexEntry & {
  areaName: string | null;
  requesterTier: string | null;
  /** Per-distributor share of this request's target pharmacies — e.g. a request
   *  targeting 3 pharmacies at distributor A and 2 at B gets [{A, 0.6}, {B, 0.4}].
   *  Mirrors phx_refresh_marketing_roi_facts' own `1 / target_count` pharmacy-share
   *  weighting exactly (not an invented formula) so the coverage-breakdown's
   *  distributor cost/required-ROI roll-up is a real allocation, not a guess.
   *  Pharmacies with no resolvable parent distributor code count toward neither the
   *  numerator nor denominator. A request with zero resolvable targets gets `[]` —
   *  it contributes to no distributor bucket, rather than being split evenly. */
  distributorWeights: Array<{ distributorCode: string; weight: number }>;
  /** Display name per `distributorCodes` entry (same order) — the code itself when no name is on file. */
  distributorNames: string[];
  /** Distinct marketing_pharmacies ids targeted. One pharmacy can carry a code at several
   *  distributors, so `pharmacyKeys` (codes) over-counts pharmacies — 55 codes for 49 pharmacies
   *  on production, 2026-10-09. The distinct-pharmacy KPI counts these. */
  pharmacyIds: string[];
};

/** Governance surface — who last exported this report, and when. Read-only, best-effort
 *  (marketing_roi_export_audit is an append-only audit trail, not load-bearing for the
 *  report itself) — null when no export has happened yet or the audit read fails. */
export type MarketingCoverageLastExport = {
  exportedByName: string;
  exportedAt: string;
};

export type MarketingCoverageFilterFacets = {
  entries: MarketingCoverageRequestIndexEntry[];
  canRevealRestricted: boolean;
  totalCount: number;
  lastExport: MarketingCoverageLastExport | null;
};

/** MarketingRoiReportRow + the fields this report's KPI/detail layer needs:
 *  areaName/requesterTier (display + already-applied filter context), customerId
 *  (identity key for the distinct-customer KPI, display name alone can collide),
 *  pharmacyKeys (identity keys for the distinct-pharmacy KPI). */
export type MarketingCoverageReportRow = MarketingRoiReportRow & {
  areaName: string | null;
  requesterTier: string | null;
  customerId: string;
  pharmacyKeys: string[];
  /** Distinct pharmacy ids targeted — the identity the distinct-pharmacy KPI counts. */
  pharmacyIds: string[];
  /** Display name per `productCodes` entry (same order) — the code itself when no name is on file. */
  productNames: string[];
  /** Display name per `distributorCodes` entry (same order) — the code itself when no name is on file. */
  distributorNames: string[];
};

/** MarketingRoiKpiBand + the 2 counts unique to this report. */
export type MarketingCoverageKpiBand = MarketingRoiKpiBand & {
  distinctPharmacyCount: number;
  distinctCustomerCount: number;
  /** Requests whose actuals had to fall back to the slow live-RPC path (no
   *  marketing_roi_request_facts row yet — e.g. never refreshed). Always present,
   *  zero-count when everything hit the fast path — never fabricated, never silent
   *  about a real degradation. */
  actualsDegraded: { count: number; requestIds: string[] };
};

/** One distributor's slice of the currently filtered request set, weighted by
 *  MarketingCoverageRequestIndexEntry.distributorWeights. Deliberately carries NO
 *  actualSalesValue / coverage-ratio field: a real per-distributor sales split would
 *  require re-deriving live attribution for every filtered request — the exact slow
 *  path the fact-table reliability work exists to eliminate. Once that work exposes
 *  marketing_roi_request_geo_facts (grain: request × distributor × region, already
 *  holding real per-distributor sales) to this report, add it there — never show a
 *  coverage number here that isn't real. */
export type MarketingCoverageDistributorRollupRow = {
  distributorCode: string;
  distributorName: string | null;
  /** Count of distinct requests that target this distributor at all — a real
   *  yes/no fact per request, not weighted. */
  requestCount: number;
  /** Sum of estimatedCost * distributorWeights[thisCode] across matching rows. */
  allocatedCost: number;
  /** Sum of requiredRoiValue * distributorWeights[thisCode] across matching rows. */
  allocatedRequiredRoi: number;
};

/** Display label per SELECTED filter value, keyed by dimension — read off the viewer's own index
 *  by the same extractors the filter panel uses, so the export's "Applied filters" line names the
 *  people, request types and pharmacies the viewer picked, never an HR id or a code. Only the
 *  selected values are carried, never the whole index. */
export type MarketingCoverageFilterLabels = Partial<Record<MarketingCoverageFilterKey, Record<string, string>>>;

export type MarketingCoverageReport = {
  rows: MarketingCoverageReportRow[];
  kpi: MarketingCoverageKpiBand;
  appliedFilters: MarketingCoverageFilterState;
  filterLabels: MarketingCoverageFilterLabels;
  autoAppliedByDimension: Partial<Record<MarketingCoverageFilterKey, string[]>>;
  includedRestricted: boolean;
  generatedAtIso: string;
  distributorRollup: MarketingCoverageDistributorRollupRow[];
  /** The claimed invoice lines behind `rows` (withheld rows excluded) — the ledger the KPI band
   *  deducts shared sales from, shipped so the breakdown, trend and workbook dedupe the same way. */
  attributionLines: RoiAttributionLine[];
};

export type MarketingCoveragePreset = {
  id: string;
  name: string;
  filters: MarketingCoverageFilterState;
  isDefault: boolean;
  updatedAt: string;
};

/** One matched sale for a pharmacy, broken out by product and invoice month —
 *  the second-level accordion detail under a target pharmacy. */
export type MarketingCoveragePharmacySaleRow = {
  productCode: string;
  productName: string;
  invoicePeriod: string;
  qty: number;
  value: number;
};

/** One target pharmacy row in a request's accordion detail. Always present for
 *  every pharmacy the request targets — `hasSalesRows: false` + zero value/units
 *  when nothing matched, never omitted. `salesDetail` is the same underlying
 *  sales rows already fetched for `salesValue`/`salesUnits`, just broken out by
 *  product + month instead of summed — never a second RPC call. */
export type MarketingCoveragePharmacyRow = {
  pharmacyCode: string;
  pharmacyName: string;
  distributorName: string | null;
  parentDistributorCode: string | null;
  salesValue: number;
  /** Null when this pharmacy bought more than one product code — units of different products are never added. */
  salesUnits: number | null;
  hasSalesRows: boolean;
  salesDetail: MarketingCoveragePharmacySaleRow[];
};
