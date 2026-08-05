import { randomUUID } from "node:crypto";


import {
  canSeeHrScopedRecord,
  parseRoleStrict,
  resolveEmployeeIdentityId,
  type AccessContext,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { writeAuditLog } from "@/lib/admin/audit";
// Pure, JSX-free SLA tone helper (see src/lib/approvals-hub/service.ts, which imports it the same
// way) so the marketing badge graduates to "overdue" on exactly the rule the other badges use.
import { slaTone } from "@/components/approvals-hub/sla-thresholds";
import type { EmailTemplateContext } from "@/lib/email-templates/service";
import { canonicalHrIdKey, hrIdLookupKeys, resolveStoredHrId } from "@/lib/hr-id";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import {
  deleteMarketingEvidencePhotos,
  loadMarketingEvidencePhoto,
  loadMarketingEvidencePhotosByEntityIds,
  parseMarketingEvidencePhotoDataUrl,
  storeMarketingEvidencePhoto,
} from "@/lib/marketing-requests/evidence-photo-storage";
import { marketingRequestNotificationUrl } from "@/lib/marketing-requests/notification-link";
import { calculateMarketingRoiPreview } from "@/lib/marketing-requests/roi";
import {
  assertMarketingWorkflowTransition,
  toMarketingRequestWorkflowStatus,
} from "@/lib/marketing-requests/workflow";
import { createSystemNotification, logNotificationSendFailure } from "@/lib/notifications/system";
import { resolveNotificationRoleEnabled } from "@/lib/notifications/role-recipients";
import { logError, logWarning } from "@/lib/observability/log";
import { MARKETING_CUSTOMER_SPECIALITIES } from "@/lib/marketing-requests/types";
import type {
  MarketingDistributor,
  MarketingControlSetting,
  MarketingControlSettingGroup,
  MarketingControlWorkspace,
  MarketingAllRequestsRow,
  MarketingAllRequestsWorkspace,
  MarketingApprovedRequestRow,
  MarketingCustomer,
  MarketingCustomerDatabaseWorkspace,
  MarketingCustomerPharmacy,
  MarketingCustomerType,
  MarketingEvidenceStatus,
  MarketingPharmacy,
  MarketingPharmacyCodeReferenceStatus,
  MarketingPharmacyDistributorCode,
  MarketingProduct,
  MarketingRequest,
  MarketingRequestCreateDraft,
  MarketingRequestDraftDetail,
  MarketingRequestDraftPharmacyInput,
  MarketingRequestPharmacyOption,
  MarketingRequestDraftProductInput,
  MarketingRequestPharmacy,
  MarketingRequestProduct,
  MarketingRequestFinanceRequirement,
  MarketingRequestApprovalStep,
  MarketingRequestType,
  MarketingOnBehalfEmployee,
  MarketingValidationCustomerInput,
  MarketingValidationInput,
  MarketingValidationPharmacyInput,
  MarketingValidationReportRow,
  MarketingValidationStatus,
  MarketingValidationWorkspace,
  MarketingDecisionLabels,
  MarketingStepKind,
  MarketingWorkflowApprovalScope,
  MarketingWorkflowStep,
} from "@/lib/marketing-requests/types";
import { getUserProductScopeOverride } from "@/lib/auth/scope-visibility";
import {
  describeOverlap,
  findRequestOverlaps,
  windowMonths,
  type OverlapCandidate,
} from "@/lib/marketing-requests/request-overlap";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { pingMarketingRequestSheet } from "@/lib/marketing-requests/sheet-webhook";
import type { SupabaseClient } from "@supabase/supabase-js";

type MarketingProductDbRow = {
  active?: boolean | null;
  created_at?: string | null;
  family?: string | null;
  factory_price: number | string | null;
  id: number | string;
  line: string | null;
  line_id?: number | string | null;
  product_code?: string | null;
  product_name: string;
  normalized_name?: string | null;
  source_company?: string | null;
  source_file?: string | null;
  updated_at?: string | null;
};

type MarketingRequestTypeDbRow = {
  active: boolean;
  code: string;
  created_at?: string | null;
  description: string | null;
  id: number | string;
  name: string;
  requires_description: boolean;
  sort_order: number;
  updated_at?: string | null;
};

type MarketingWorkflowStepDbRow = {
  active: boolean;
  allow_reject?: boolean | null;
  allow_return?: boolean | null;
  approval_scope: MarketingWorkflowApprovalScope;
  assigned_role: string;
  cc_roles?: string[] | null;
  chain_target_role?: string | null;
  created_at?: string | null;
  decision_labels?: Record<string, string> | null;
  default_sla_days: number | string | null;
  id: number | string;
  required: boolean;
  sequence: number | string;
  step_code: string;
  step_kind?: string | null;
  step_name: string;
  terminal_status?: string | null;
  updated_at?: string | null;
};

type MarketingRequestApprovalStepDbRow = {
  allow_reject?: boolean | null;
  allow_return?: boolean | null;
  assigned_hr_id?: string | null;
  assigned_role: string;
  created_at?: string | null;
  decision_at?: string | null;
  decision_by_hr_id?: string | null;
  decision_labels?: Record<string, string> | null;
  decision_note?: string | null;
  executed_at?: string | null;
  id: string;
  is_cc?: boolean | null;
  request_id: string;
  sequence: number | string;
  status: "pending" | "current" | "approved" | "rejected" | "returned" | "skipped";
  step_code: string;
  step_kind?: string | null;
  step_name: string;
  terminal_status?: string | null;
  updated_at?: string | null;
  workflow_step_id?: number | string | null;
};

export type MarketingRequestDecision = "approve" | "reject" | "return";

export type MarketingDecisionChainStep = {
  approverName: string;
  isCurrent: boolean;
  status: MarketingRequestApprovalStep["status"];
  stepName: string;
};

export type MarketingDecisionProductLine = {
  name: string;
  quantity: number;
  value: number;
};

/** One target pharmacy exactly as the requester submitted it — never collapsed to a count. */
export type MarketingDecisionPharmacy = {
  distributorName: string;
  distributorPharmacyCode: string;
  /**
   * Signed URL for this pharmacy's own retained shop-front photo, or null when none was kept.
   *
   * The pharmacy photo is captured and stored on exactly the same rule as the customer's — two of
   * the three rows that historically claimed unretained proof were pharmacies, not customers — so
   * not surfacing it would mean storing evidence nobody can ever look at.
   */
  evidencePhotoUrl: string | null;
  notes: string | null;
  pharmacyCode: string;
  pharmacyName: string;
  /** "matched" | "unverified" | ... — an unverified code is the approver's business. */
  referenceStatus: string;
};

export type MarketingRequestDecisionSummary = {
  allowReject: boolean;
  assignedApproverHrId: string;
  currentStepName: string;
  decision: MarketingRequestDecision;
  decisionLabels: MarketingDecisionLabels;
  payDate: string;
  requestCode: string;
  requestId: string;
  requesterHrId: string;
  requesterName: string;
  requestType: string;
  status: MarketingRequest["status"];
  stepKind: MarketingStepKind | null;
  // ── Rich request context so the approver decides in place (no click-through needed) ──
  chain: MarketingDecisionChainStep[];
  customerName: string | null;
  estimatedCost: number;
  expectedRoiValue: number;
  lineName: string | null;
  pharmacyCount: number;
  products: MarketingDecisionProductLine[];
  requiredRoiValue: number;
  roiDurationMonths: number;
  roiWindow: string | null;
  /**
   * ── Everything else the requester actually submitted (owner instruction, 2026-08-04) ──
   *
   * The approval window previously showed a customer NAME and a pharmacy COUNT. An approver was
   * being asked to commit real money without seeing the customer's code, its address, who the
   * contact is, or which pharmacies the campaign even targets. All of it was captured at
   * submission and simply never carried through to the decision.
   */
  areaName: string | null;
  customerAddress: string | null;
  customerArea: string | null;
  customerCode: string | null;
  customerContactMobile: string | null;
  customerContactName: string | null;
  customerGovernorate: string | null;
  customerSpeciality: string | null;
  customerType: string | null;
  /**
   * The live capture photo's filename.
   *
   * On its own this is NOT proof and must never be presented as such — for every customer created
   * before 2026-08-04 the bytes were discarded in the browser and only this string was kept.
   * `evidencePhotoUrl` is the field that says whether an image actually exists.
   */
  evidencePhotoName: string | null;
  /**
   * Short-lived signed URL for the retained shop-front photo, or null when no image was kept.
   *
   * Minted server-side by the service-role client against the PRIVATE `marketing-evidence` bucket —
   * the bucket is never public because these frames carry a GPS stamp of a real business address.
   * Sourced from `marketing_evidence_files`, which only ever has a row when bytes were genuinely
   * written, so a value here is evidence and a null is an honest absence.
   */
  evidencePhotoUrl: string | null;
  notes: string | null;
  requestDate: string | null;
  roiCoverageRatio: number | null;
  roiStatus: string | null;
  targetPharmacies: MarketingDecisionPharmacy[];
  trackDirectSales: boolean;
  /**
   * Other live requests that would be credited the SAME invoice lines as this one.
   *
   * Surfaced to the approver rather than blocked at submission on purpose: overlapping campaigns
   * are sometimes deliberate, and only a human can tell an intentional double-push from an
   * accidental double-count. The approver is already the control point and already has
   * "Return for edit" — this just makes sure they are not approving it blind.
   */
  contestedBy: MarketingDecisionOverlap[];
};

export type MarketingDecisionOverlap = {
  requestCode: string;
  status: string;
  /** One human sentence naming the consequence — never raw ids. */
  description: string;
};

type MarketingControlSettingDbRow = {
  admin_only: boolean;
  created_at?: string | null;
  setting_group: MarketingControlSettingGroup;
  setting_key: string;
  setting_label: string;
  setting_value: Record<string, unknown> | null;
  updated_at?: string | null;
  updated_by_hr_id?: string | null;
};

type MarketingDistributorDbRow = {
  active: boolean;
  created_at?: string | null;
  display_name: string;
  distributor_code: string;
  id: number | string;
  normalized_name: string;
  source_name: string | null;
  updated_at?: string | null;
};

type MarketingCustomerDbRow = {
  active?: boolean | null;
  area_id: number | string | null;
  captured_accuracy_meters?: number | string | null;
  captured_address?: string | null;
  captured_at?: string | null;
  captured_latitude?: number | string | null;
  captured_longitude?: number | string | null;
  created_at?: string | null;
  created_by_hr_id?: string | null;
  customer_code?: string | null;
  customer_type?: MarketingCustomerType;
  display_name?: string | null;
  evidence_has_timestamp?: boolean | null;
  evidence_photo_captured_at?: string | null;
  evidence_photo_name?: string | null;
  evidence_status?: MarketingEvidenceStatus;
  extracted_area_name?: string | null;
  extracted_governorate_name?: string | null;
  id: string;
  line_id: number | string | null;
  manager_hr_id: string | null;
  normalized_name?: string | null;
  other_type_description?: string | null;
  owner_hr_id: string | null;
  region_name?: string | null;
  updated_at?: string | null;
  updated_by_hr_id?: string | null;
  validated_at?: string | null;
  validated_by_hr_id?: string | null;
  validation_notes?: string | null;
  validation_status?: MarketingValidationStatus;
};

type MarketingPharmacyDbRow = {
  active?: boolean | null;
  area_id: number | string | null;
  captured_accuracy_meters?: number | string | null;
  captured_address?: string | null;
  captured_at?: string | null;
  captured_latitude?: number | string | null;
  captured_longitude?: number | string | null;
  created_at?: string | null;
  created_by_hr_id?: string | null;
  display_name?: string | null;
  evidence_has_timestamp?: boolean | null;
  evidence_photo_captured_at?: string | null;
  evidence_photo_name?: string | null;
  evidence_status?: MarketingEvidenceStatus;
  extracted_area_name?: string | null;
  extracted_governorate_name?: string | null;
  id: string;
  line_id: number | string | null;
  manager_hr_id: string | null;
  normalized_name?: string | null;
  owner_hr_id: string | null;
  pharmacy_code?: string | null;
  region_name?: string | null;
  updated_at?: string | null;
  updated_by_hr_id?: string | null;
  validated_at?: string | null;
  validated_by_hr_id?: string | null;
  validation_notes?: string | null;
  validation_status?: MarketingValidationStatus;
};

type MarketingCustomerContactDbRow = {
  active?: boolean | null;
  contact_name?: string | null;
  customer_id: string;
  id: string;
  mobile_number?: string | null;
};

type MarketingPharmacyDistributorCodeDbRow = {
  active?: boolean | null;
  created_at?: string | null;
  created_by_hr_id?: string | null;
  distributor_id?: number | string | null;
  distributor_pharmacy_code?: string | null;
  id: string;
  normalized_pharmacy_code?: string | null;
  pharmacy_id: string;
  reference_id?: number | string | null;
  reference_match_count?: number | string | null;
  reference_status?: MarketingPharmacyCodeReferenceStatus;
  updated_at?: string | null;
  validated_at?: string | null;
  validated_by_hr_id?: string | null;
  validation_notes?: string | null;
};

type MarketingCustomerPharmacyDbRow = {
  active?: boolean | null;
  created_at?: string | null;
  created_by_hr_id?: string | null;
  customer_id: string;
  distributor_code_id: string;
  id: string;
  pharmacy_id: string;
  updated_at?: string | null;
  updated_by_hr_id?: string | null;
  validation_notes?: string | null;
  validation_status?: MarketingValidationStatus;
};

type MarketingPharmacyCodeReferenceDbRow = {
  id: number | string;
  raw_pharmacy_code: string;
};

type MarketingRequestDbRow = {
  approved_at?: string | null;
  area_id: number | string | null;
  closed_at?: string | null;
  created_at?: string | null;
  created_by_hr_id?: string | null;
  customer_contact_id: string | null;
  customer_id: string;
  estimated_cost: number | string;
  executed_at?: string | null;
  expected_roi_value: number | string;
  id: string;
  line_id: number | string | null;
  manager_hr_id: string | null;
  notes: string | null;
  other_request_type: string | null;
  pay_date: string | null;
  rejected_at?: string | null;
  returned_at?: string | null;
  returned_step_sequence?: number | string | null;
  request_code: string;
  request_date: string;
  request_type_id: number | string;
  requester_hr_id: string;
  required_roi_value?: number | string | null;
  roi_coverage_ratio?: number | string | null;
  roi_duration_months: number | string;
  roi_status: MarketingRequest["roiStatus"];
  status: MarketingRequest["status"];
  submitted_at?: string | null;
  updated_at?: string | null;
  updated_by_hr_id?: string | null;
};

type MarketingRequestProductDbRow = {
  created_at?: string | null;
  expected_value?: number | string | null;
  factory_price_snapshot: number | string;
  forecast_quantity: number | string;
  id: string;
  line_snapshot: string | null;
  product_id: number | string;
  product_name_snapshot: string;
  request_id: string;
  updated_at?: string | null;
  value_share: number | string;
};

type MarketingRequestPharmacyDbRow = {
  created_at?: string | null;
  distributor_code_id: string;
  id: string;
  notes: string | null;
  pharmacy_id: string;
  request_id: string;
  tracking_status: MarketingRequestPharmacy["trackingStatus"];
  updated_at?: string | null;
};

type MarketingRequestFinanceRequirementDbRow = {
  created_at?: string | null;
  finance_reviewer_hr_id?: string | null;
  invoice_deadline_date?: string | null;
  invoice_original_file_name?: string | null;
  invoice_required?: boolean | null;
  invoice_status?: MarketingRequestFinanceRequirement["invoiceStatus"];
  invoice_storage_path?: string | null;
  invoice_uploaded_at?: string | null;
  invoice_uploaded_by_hr_id?: string | null;
  money_transfer_proof_original_file_name?: string | null;
  money_transfer_proof_storage_path?: string | null;
  money_transfer_proof_uploaded_at?: string | null;
  money_transfer_proof_uploaded_by_hr_id?: string | null;
  notes?: string | null;
  request_id: string;
  reviewed_at?: string | null;
  updated_at?: string | null;
};

type MarketingRequesterLine = Pick<EmployeeDirectoryRow, "hrId" | "lineId"> & {
  lineName?: string | null;
};

export type MarketingRequestStepProgress = {
  approvedGatingCount: number;
  currentApproverHrId: string | null;
  currentApproverName: string;
  currentStepName: string;
  returnReason: string | null;
  sequence: number;
  totalGatingSteps: number;
};

export type MarketingRequestTimelineStep = {
  assignedHrId: string | null;
  assignedName: string;
  assignedRole: string;
  decisionAt: string | null;
  decisionByHrId: string | null;
  decisionByName: string;
  decisionNote: string | null;
  isCc: boolean;
  sequence: number;
  status: MarketingRequestApprovalStep["status"];
  stepName: string;
};

export type MarketingRequestDetail = {
  pharmacies: MarketingRequestPharmacy[];
  products: MarketingRequestProduct[];
  progress: MarketingRequestStepProgress | null;
  request: MarketingRequest;
  steps: MarketingRequestTimelineStep[];
  /** True when the viewer is a CC reviewer who may post a non-blocking comment right now. */
  viewerCanComment: boolean;
};

export type MarketingRequestDraftWorkspace = {
  approvedRequests: MarketingApprovedRequestRow[];
  // True when the viewer can create/resubmit drafts (resolvable requester or an
  // unrestricted oversight role). False for company-wide reviewers who are not a
  // directory requester — they still see the request lists in read-only mode.
  canCreateDraft: boolean;
  customers: MarketingCustomer[];
  distributors: MarketingDistributor[];
  drafts: MarketingRequest[];
  /**
   * Selectable target pharmacies keyed by customer id.
   *
   * Without this the form had nothing to offer, so every Phoenix request was saved with zero
   * target pharmacies — and a request with no targets can never attribute a sale, making its ROI
   * permanently zero regardless of how the campaign actually performed.
   */
  pharmaciesByCustomer: Record<string, MarketingRequestPharmacyOption[]>;
  inApproval: MarketingRequest[];
  products: MarketingProduct[];
  requestTypes: MarketingRequestType[];
  requesterLineId: number | null;
  requesterLineName: string | null;
  /** All returned requests visible to this viewer (read-only for monitoring). */
  returned: MarketingRequest[];
  /** Subset of returned where the viewer IS the original requester — the only ones they may edit. */
  returnedToMe: MarketingRequest[];
  stepProgressByRequestId: Record<string, MarketingRequestStepProgress>;
};

/**
 * One rung of the chain as it stands right now, for display on the inbox row.
 *
 * `decision_note` and `decision_at` have always been written by every approver and were never
 * surfaced anywhere: the decision screen's chain is a bare breadcrumb of step names. An approver
 * at the end of the chain could see THAT the three rungs below him said yes, but never WHEN or
 * WHY. The CEO signs last, so he is exactly the person that costs.
 *
 * Free of extra cost: getApproverPendingRequests already loads every non-CC step for every request
 * in one batched query to place the row in its chain, and mapApprovalStep already carries both
 * fields. This only stops throwing them away.
 */
export type MarketingApproverChainRung = {
  approverName: string;
  /** ISO; render in Africa/Cairo. Null while the rung is still pending or current. */
  decisionAt: string | null;
  /** What the approver actually wrote. Null when they approved without comment. */
  decisionNote: string | null;
  isCurrent: boolean;
  /** True for the viewer's own rung, so the row can say "this one is yours". */
  isMine: boolean;
  sequence: number;
  status: MarketingRequestApprovalStep["status"];
  stepName: string;
};

/**
 * The chain as it stands, ordered, with each approver's note and decision time.
 *
 * Exported and pure so the ordering / naming / note rules are testable without a request context;
 * `getApproverPendingRequests` has already batched these steps into memory, so calling this adds
 * no query.
 *
 * `myStepId` marks the viewer's own rung. CC rows are dropped: an advisory comment is not a rung
 * of the decision chain and must never read as one more approval.
 */
export function buildMarketingApproverChain(
  steps: readonly MarketingRequestApprovalStep[],
  employeeRows: EmployeeDirectoryRow[],
  myStepId: string | null,
): MarketingApproverChainRung[] {
  return [...steps]
    .filter((step) => !step.isCc)
    .sort((left, right) => left.sequence - right.sequence)
    .map((step) => ({
      // Whoever actually DECIDED, falling back to the assignee for rungs not yet reached. Using
      // the assignee throughout would credit the current holder for a predecessor's approval on
      // any re-assigned step.
      approverName: employeeNameByHrId(employeeRows, step.decisionByHrId ?? step.assignedHrId),
      decisionAt: step.decisionAt,
      decisionNote: cleanText(step.decisionNote),
      isCurrent: step.status === "current",
      isMine: Boolean(myStepId) && step.id === myStepId,
      sequence: step.sequence,
      status: step.status,
      stepName: step.stepName,
    }));
}

export type MarketingApproverInboxRow = {
  allowReject: boolean;
  allowReturn: boolean;
  /** Every rung, in order, with each approver's note and decision time. */
  approvalHistory: MarketingApproverChainRung[];
  currentStepName: string;
  customerName: string;
  decisionLabels: MarketingDecisionLabels;
  estimatedCost: number;
  id: string;
  payDate: string | null;
  requestCode: string;
  requesterHrId: string;
  requesterName: string;
  requesterRole: PhoenixRole;
  requestType: string;
  status: MarketingRequest["status"];
  stepSequence: number;
  submittedAt: string | null;
};

export type MarketingApproverInboxWorkspace = {
  /** Requests awaiting the actor's gating decision (approve / return / reject). */
  rows: MarketingApproverInboxRow[];
  /** Requests where the actor is a CC reviewer and may post a non-blocking comment. */
  advisoryRows: MarketingApproverInboxRow[];
  /**
   * Requests COMING to the actor — they hold a later step that has not opened yet.
   *
   * Owner instruction, 2026-08-04. Before this, the inbox queried `status = 'current'` only, so an
   * approver saw nothing at all until the request reached their own rung. The CEO sits at step 4
   * of 4: a request could be submitted, approved by the NSM and sit for days at SFE while their
   * inbox read empty — on the hook for something they could not see. These rows are read-only
   * (no decision is theirs to make yet) and carry where the request is stopped and for how long.
   */
  upcomingRows: MarketingApproverUpcomingRow[];
};

/** A request heading toward the actor, with its live position in the chain. */
export type MarketingApproverUpcomingRow = MarketingApproverInboxRow & {
  /** Whole days since submission — the number that makes a stall visible. */
  ageDays: number;
  /** Who is holding it right now (null if the chain has no open step). */
  awaitingApproverName: string | null;
  /** The step it is stopped at right now — NOT the actor's own step. */
  awaitingStepName: string | null;
  /** The actor's own rung, so "yours is step 4 of 4" is answerable. */
  myStepSequence: number;
  totalGatingSteps: number;
};

export type PreparedMarketingRequestDraft = {
  pharmacyRows: Array<{
    distributor_code_id: string;
    notes: string | null;
    pharmacy_id: string;
    request_id?: string;
  }>;
  productRows: Array<{
    factory_price_snapshot: number;
    forecast_quantity: number;
    line_snapshot: string | null;
    product_id: number;
    product_name_snapshot: string;
    request_id?: string;
    value_share: number;
  }>;
  requestRow: {
    area_id: number | null;
    created_by_hr_id: string;
    customer_contact_id: string | null;
    customer_id: string;
    estimated_cost: number;
    expected_roi_value: number;
    line_id: number | null;
    manager_hr_id: string | null;
    notes: string | null;
    other_request_type: string | null;
    pay_date: string | null;
    request_code: string;
    request_date: string;
    request_type_id: number;
    requester_hr_id: string;
    roi_duration_months: number;
    roi_status: MarketingRequest["roiStatus"];
    status: "draft";
    updated_by_hr_id: string;
  };
};

export type MarketingFinanceEvidenceType = "money_transfer_proof" | "invoice";

// NOTE: "archived" is intentionally excluded here. It covers requests whose ROI window
// closed long ago regardless of prior outcome (approved/pending_approval/rejected rows can
// all become archived), so including it would wrongly inflate "approved" dashboard/finance
// totals (home-snapshot.ts's approved-request count, and the counts further down this file
// that filter on this list).
export const approvedMarketingRequestStatuses: MarketingRequest["status"][] = [
  "approved",
  "active",
  "roi_tracking",
  "closed",
  "finance_hold",
];

const marketingFinanceEvidenceBucket = "marketing-finance-evidence";
const marketingFinanceEvidenceMaxBytes = 4 * 1024 * 1024;
const marketingFinanceEvidenceContentTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

type NormalizedMarketingValidationPharmacy = {
  capturedAccuracyMeters: number | null;
  capturedAddress: string | null;
  capturedAt: string | null;
  capturedLatitude: number | null;
  capturedLongitude: number | null;
  displayName: string;
  evidenceHasTimestamp: boolean;
  evidencePhotoCapturedAt: string | null;
  /** Validated JPEG data URL, carried to the post-insert storage write. Never persisted as text. */
  evidencePhotoDataUrl: string | null;
  evidencePhotoName: string | null;
  evidenceStatus: MarketingEvidenceStatus;
  extractedAreaName: string | null;
  extractedGovernorateName: string | null;
  normalizedName: string;
  regionName: string | null;
  vendorCodes: Array<{
    distributorId: number;
    distributorPharmacyCode: string;
    normalizedPharmacyCode: string;
  }>;
  validationStatus: MarketingValidationStatus;
};

type NormalizedMarketingValidationCustomer = {
  capturedAccuracyMeters: number | null;
  capturedAddress: string | null;
  capturedAt: string | null;
  capturedLatitude: number | null;
  capturedLongitude: number | null;
  customerType: MarketingCustomerType;
  displayName: string;
  evidenceHasTimestamp: boolean;
  evidencePhotoCapturedAt: string | null;
  /** Validated JPEG data URL, carried to the post-insert storage write. Never persisted as text. */
  evidencePhotoDataUrl: string | null;
  evidencePhotoName: string | null;
  evidenceStatus: MarketingEvidenceStatus;
  extractedAreaName: string | null;
  extractedGovernorateName: string | null;
  mobileNumber: string | null;
  normalizedName: string;
  otherTypeDescription: string | null;
  /** Each customer keeps its OWN pharmacies — lists are never merged across customers. */
  pharmacies: NormalizedMarketingValidationPharmacy[];
  regionName: string | null;
  speciality: string | null;
  validationStatus: MarketingValidationStatus;
};

type NormalizedMarketingValidationInput = {
  customers: NormalizedMarketingValidationCustomer[];
};

type MarketingSystemValidationInput = {
  customerEvidenceStatus: MarketingEvidenceStatus;
  pharmacyEvidenceStatus: MarketingEvidenceStatus;
  referenceStatus: MarketingPharmacyCodeReferenceStatus;
};

type CreateValidationOptions = {
  /** Unfiltered directory used to name the acting admin; defaults to `employeeRows`. */
  actorRows?: EmployeeDirectoryRow[];
  employeeRows?: EmployeeDirectoryRow[];
  supabase?: SupabaseClient;
};

type CreateDraftOptions = {
  employeeRows?: EmployeeDirectoryRow[];
  supabase?: SupabaseClient;
};

export const marketingCreatorRoles = new Set<AccessContext["role"]>([
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
  "SFE Manager",
  "CEO",
  "Super Admin",
]);

export const companyMarketingRoles = new Set<AccessContext["role"]>([
  "CEO",
  "Finance Manager",
  "Financial Advisor",
  "Marketing Manager",
  "SFE Manager",
  "Super Admin",
]);

function cleanText(value: unknown) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized || null;
}

function normalizeLookupKey(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function nonNegativeNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, parsed);
}

function nullableCoordinate(value: unknown, label: string, min: number, max: number) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw validationError(`${label} is invalid.`);
  }
  return parsed;
}

function nullableIsoTimestamp(value: unknown, label: string) {
  const raw = cleanText(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw validationError(`${label} is invalid.`);
  }
  return parsed.toISOString();
}

function numberId(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw validationError(`${label} is required.`);
  }
  return parsed;
}

function nullableNumberId(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  return numberId(value, "ID");
}

function normalizeDateOnly(value: unknown, label: string) {
  const raw = String(value ?? "").trim();
  if (!raw) throw validationError(`${label} is required.`);

  const dateOnly = raw.slice(0, 10);
  const parsed = new Date(`${dateOnly}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly) || Number.isNaN(parsed.getTime())) {
    throw validationError(`${label} is invalid.`);
  }
  return dateOnly;
}

function nullableDateOnly(value: unknown, label: string) {
  const raw = cleanText(value);
  return raw ? normalizeDateOnly(raw, label) : null;
}

export function normalizeHrId(value: unknown) {
  return canonicalHrIdKey(value as string | null | undefined);
}

function normalizeScopeText(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function employeeRowByHrId(rows: EmployeeDirectoryRow[]) {
  return new Map(
    rows
      .map((row) => [normalizeHrId(row.hrId), row] as const)
      .filter((entry): entry is [string, EmployeeDirectoryRow] => Boolean(entry[0])),
  );
}

/**
 * Resolve any HR_ID dialect to the exact `employees.hr_id` value (its real stored
 * casing) so it satisfies the case-sensitive `employees(hr_id)` foreign keys on the
 * marketing approval tables (`assigned_hr_id`, `decision_by_hr_id`).
 *
 * `normalizeHrId()` lower-cases for COMPARISON, which is the wrong dialect to STORE
 * into an employees FK: the employee master is upper-cased, so writing "a-9" against
 * a parent row of "A-9" raised a foreign-key violation and aborted every submit /
 * decision. We map the lower-cased key back to the directory row's raw `hrId`; when
 * the directory row is unavailable we fall back to the canonical upper-cased form
 * (the employee master is upper-cased, so this matches for every real employee).
 */
export function resolveStoredEmployeeHrId(
  value: string | null | undefined,
  byHrId?: Map<string, EmployeeDirectoryRow>,
): string | null {
  return resolveStoredHrId(value, byHrId);
}

/**
 * Whether `value` is present in `byHrId` — i.e. currently an ACTIVE employee, since
 * `byHrId` is always built from the active-only directory in production. Distinct from
 * `resolveStoredEmployeeHrId`, which deliberately returns a value even when the id is
 * absent (so a write referencing an already-resigned employee's own historical row still
 * satisfies the employees FK). Use this wherever a NEW assignment specifically requires a
 * currently active employee — `resolveStoredEmployeeHrId`'s return value alone cannot
 * distinguish "found and active" from "resigned, but the FK-safe fallback still applies".
 */
export function isActiveEmployeeHrId(
  value: string | null | undefined,
  byHrId?: Map<string, EmployeeDirectoryRow>,
): boolean {
  const key = normalizeHrId(value);
  return Boolean(key && byHrId?.has(key));
}

export function sameEmployeeDepartment(viewer: EmployeeDirectoryRow | undefined, target: EmployeeDirectoryRow | undefined) {
  if (!viewer || !target) return true;

  if (viewer.departmentId !== null && target.departmentId !== null) {
    return viewer.departmentId === target.departmentId;
  }

  const viewerDepartment = normalizeScopeText(viewer.departmentName);
  const targetDepartment = normalizeScopeText(target.departmentName);
  if (viewerDepartment && targetDepartment) {
    return viewerDepartment === targetDepartment;
  }

  return true;
}

export function reportsUpToViewer(input: {
  employeesByHrId: Map<string, EmployeeDirectoryRow>;
  targetHrId: string | null;
  viewerHrId: string | null;
}) {
  if (!input.targetHrId || !input.viewerHrId) return false;
  if (input.targetHrId === input.viewerHrId) return true;

  const visited = new Set<string>();
  let managerHrId = normalizeHrId(input.employeesByHrId.get(input.targetHrId)?.managerHrId);

  while (managerHrId) {
    if (managerHrId === input.viewerHrId) return true;
    if (visited.has(managerHrId)) return false;
    visited.add(managerHrId);
    managerHrId = normalizeHrId(input.employeesByHrId.get(managerHrId)?.managerHrId);
  }

  return false;
}

export function canSeeMarketingHierarchyRecord(
  access: AccessContext,
  record: {
    employeeHrId?: string | null;
    hrId?: string | null;
    managerHrId?: string | null;
  },
  employeeRows: EmployeeDirectoryRow[],
) {
  // Company-wide marketing oversight roles see every marketing record. This set MUST stay in
  // sync with `companyMarketingRoles` above — the Marketing Manager is a mandatory company-wide
  // approval step (Marketing Review), so it has to see the request queue, customer validation,
  // ROI tracking, and the requests it has already approved, not just its own subtree.
  if (
    access.scope === "system" ||
    access.role === "Super Admin" ||
    access.role === "CEO" ||
    access.role === "Finance Manager" ||
    access.role === "Financial Advisor" ||
    access.role === "Marketing Manager" ||
    access.role === "SFE Manager"
  ) {
    return true;
  }

  const viewerHrId = normalizeHrId(access.hrId);
  const targetHrId = normalizeHrId(record.employeeHrId ?? record.hrId);
  if (!viewerHrId) return false;
  if (targetHrId === viewerHrId) return true;

  const employeesByHrId = employeeRowByHrId(employeeRows);
  const viewer = employeesByHrId.get(viewerHrId);
  const target = targetHrId ? employeesByHrId.get(targetHrId) : undefined;

  if (viewer && target && !sameEmployeeDepartment(viewer, target)) {
    return false;
  }

  if (targetHrId && reportsUpToViewer({ employeesByHrId, targetHrId, viewerHrId })) {
    return true;
  }

  return canSeeHrScopedRecord(access, record);
}

function nowIsoFallback(value: string | null | undefined) {
  return value ? new Date(value).toISOString() : new Date(0).toISOString();
}

function toNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function assertMarketingAccess(access: AccessContext) {
  if (access.scope === "system") return;
  if (!marketingCreatorRoles.has(access.role)) {
    throw forbiddenError(`Forbidden: ${access.role} cannot use marketing requests.`);
  }
}

export function assertMarketingWorkspaceAccess(access: AccessContext) {
  if (access.scope === "system") return;
  if (!marketingCreatorRoles.has(access.role) && !companyMarketingRoles.has(access.role)) {
    throw forbiddenError(`Forbidden: ${access.role} cannot use marketing requests.`);
  }
}

export function assertMarketingRequestAccess(access: AccessContext) {
  assertMarketingAccess(access);
}

/**
 * Must stay in lockstep with canUseEmployeePortalMarketingCustomerDatabase — the nav gate only
 * hides the link, this is the boundary. SFE Manager added on owner instruction (2026-08-03): it
 * owns customer validation and needs sight of every submitted customer, validated or not.
 */
function assertMarketingCustomerDatabaseAccess(access: AccessContext) {
  if (access.scope === "system") return;
  if (access.role !== "Super Admin" && access.role !== "SFE Manager") {
    throw forbiddenError(`Forbidden: ${access.role} cannot view the customer validation database.`);
  }
}

function assertMarketingControlAccess(access: AccessContext) {
  if (access.scope === "system") return;
  if (access.role !== "SFE Manager" && access.role !== "Super Admin") {
    throw forbiddenError("Forbidden: only SFE Manager and Super Admin can manage marketing controls.");
  }
}

function assertMarketingValidationRuleControlAccess(access: AccessContext) {
  if (access.scope === "system") return;
  if (access.role !== "Super Admin") {
    throw forbiddenError("Forbidden: validation settings are Super Admin only.");
  }
}

function canManageMarketingValidationRules(access: AccessContext) {
  return access.scope === "system" || access.role === "Super Admin";
}

function canUseAnyMarketingProductLine(access: AccessContext) {
  return access.scope === "system" || access.role === "Super Admin" || access.role === "SFE Manager";
}

// Maps free-text product line labels → canonical org line names (both normalized).
// Needed because marketing_products.line carries the full name while lines.name is abbreviated.
const PRODUCT_LINE_TEXT_ALIASES: Record<string, string> = {
  "anti infective": "anti inf",
};

function marketingProductMatchesRequesterLine(product: MarketingProductDbRow, requester: MarketingRequesterLine) {
  const requesterLineId = requester.lineId ?? null;
  const productLineId = product.line_id === null || product.line_id === undefined ? null : Number(product.line_id);
  if (requesterLineId !== null && productLineId === requesterLineId) return true;

  const requesterLineName = normalizeScopeText(requester.lineName);
  const productLineName = normalizeScopeText(product.line);
  if (!requesterLineName || !productLineName) return false;
  const resolvedProductLineName = PRODUCT_LINE_TEXT_ALIASES[productLineName] ?? productLineName;
  const resolvedRequesterLineName = PRODUCT_LINE_TEXT_ALIASES[requesterLineName] ?? requesterLineName;
  return resolvedProductLineName === resolvedRequesterLineName;
}

/** True when a product's code is in a per-user product_scope_override allowlist. */
function productCodeInScope(code: string | null | undefined, allowedProductCodes: Set<string> | null): boolean {
  if (!allowedProductCodes) return false;
  const normalized = (code ?? "").trim().toUpperCase();
  return normalized ? allowedProductCodes.has(normalized) : false;
}

/** Build the uppercased product-code allowlist from a raw product_scope_override (null = no restriction). */
function toProductCodeSet(raw: string[] | null): Set<string> | null {
  return raw === null ? null : new Set(raw.map((code) => code.trim().toUpperCase()));
}

// Named, owner-approved exception: B-155 is a Product Manager assigned to two SPECIFIC
// cross-line products (Tigogrow/TG001 on Pedia, Osteosat/OS001 on Anti infective), not to a
// product line. His marketing visibility/submission is hard-clamped to exactly his
// product_scope_override codes, matching the sales-side clamp (applyProductCodeAllowlist),
// instead of the general line + override union below. This is intentionally scoped to this one
// HR_ID — every other requester (including other users with a product_scope_override, e.g.
// A-8/A-10) keeps the union behaviour unchanged.
const PRODUCT_SCOPE_EXCLUSIVE_HR_IDS = new Set(["B-155"].map((id) => normalizeHrId(id)));

// A requester may use a product if it is on their assigned line OR its code is in their
// product_scope_override. The override is additive (a UNION), so it only ever GRANTS extra
// products (e.g. a Product Manager whose one Anti-infective product sits outside their Pedia
// home line) and never narrows the line-based default — existing single-line requesters and
// requesters whose override codes already fall inside their own line are unaffected.
function marketingProductAllowedForRequester(
  product: MarketingProductDbRow,
  requester: MarketingRequesterLine | null,
  allowedProductCodes: Set<string> | null,
): boolean {
  if (requester && PRODUCT_SCOPE_EXCLUSIVE_HR_IDS.has(normalizeHrId(requester.hrId))) {
    return productCodeInScope(product.product_code, allowedProductCodes);
  }
  if (requester && marketingProductMatchesRequesterLine(product, requester)) return true;
  return productCodeInScope(product.product_code, allowedProductCodes);
}

function assertMarketingActor(access: AccessContext) {
  const actorHrId = resolveEmployeeIdentityId(access);
  if (!actorHrId) {
    throw validationError("A linked HR ID is required to create marketing request drafts.", "missing_actor_hr_id");
  }
  return actorHrId;
}

function findRequester(access: AccessContext, rows: EmployeeDirectoryRow[]) {
  const actorHrId = assertMarketingActor(access);
  const requester = rows.find((row) => normalizeHrId(row.hrId) === normalizeHrId(actorHrId));
  if (!requester) {
    throw validationError("Requester was not found in the employee directory.", "requester_not_found");
  }
  return requester;
}

// Non-throwing requester lookup for read surfaces (e.g. the drafts workspace) where a
// viewer can be a legitimate reviewer (Marketing Manager / SFE Manager / Finance Manager
// / CEO) without being a directory requester. Mutating paths (create/submit/resubmit)
// keep using `findRequester`, which still throws `requester_not_found`.
function tryFindRequester(access: AccessContext, rows: EmployeeDirectoryRow[]): EmployeeDirectoryRow | null {
  const actorHrId = resolveEmployeeIdentityId(access);
  if (!actorHrId) return null;
  return rows.find((row) => normalizeHrId(row.hrId) === normalizeHrId(actorHrId)) ?? null;
}

/* ── Super Admin "validate on behalf of an employee" ──────────────────────────────────────────
 *
 * A Super Admin sitting at a desk can validate a customer FOR a field employee: they pick the
 * employee, search the address on a map, and the resulting customer/pharmacy records are OWNED by
 * that employee — which is what puts the customer in that employee's marketing request dropdown
 * (getMarketingRequestDraftWorkspace filters customers through canSeeMarketingCustomer, which reads
 * owner_hr_id / manager_hr_id).
 *
 * Two invariants make this safe to hand to an admin:
 *   1. The role check is on the ACTOR, server-side, before any write. A non-Super-Admin who posts
 *      `onBehalfOfHrId` gets a 403 — the UI hiding the panel is not the boundary.
 *   2. The audit columns stay truthful. created_by_hr_id / updated_by_hr_id / validated_by_hr_id
 *      name the admin, never the employee, so a desk entry can always be told apart from a rep who
 *      physically stood at the door. owner_hr_id is the only column that moves.
 */

export function canValidateMarketingOnBehalf(access: AccessContext) {
  return access.scope === "system" || access.role === "Super Admin";
}

export function assertMarketingOnBehalfAccess(access: AccessContext) {
  if (canValidateMarketingOnBehalf(access)) return;
  throw forbiddenError(
    `Forbidden: ${access.role} cannot validate a customer on behalf of another employee.`,
  );
}

export type MarketingValidationActor = {
  /**
   * Who is physically doing the work — the admin on the on-behalf path, else the owner. Always in
   * the employee master's stored casing, because every *_hr_id column on the marketing validation
   * tables is a case-sensitive FK to employees(hr_id) and the access context's dialect is not.
   */
  actorHrId: string;
  /** False when the actor has no employees row at all — `actorHrId` then cannot satisfy those FKs. */
  actorIsKnownEmployee: boolean;
  actorName: string | null;
  isOnBehalf: boolean;
  /** Whose marketing scope the customer lands in. */
  owner: EmployeeDirectoryRow;
};

/**
 * Resolve who owns the validation records and who is recorded as having created them.
 *
 * Without `onBehalfOfHrId` this is exactly the previous behaviour (`findRequester`), so the field
 * rep path is unchanged. With it, the actor must be Super Admin and the target must be an active
 * employee whose job function is one that can actually raise a marketing request — otherwise the
 * customer would be parked on someone with no marketing screen and could never be used. That job
 * title check classifies the TARGET's usefulness; it grants nobody any permission (the permission
 * decision above is on the actor alone).
 */
export function resolveMarketingValidationActor(params: {
  access: AccessContext;
  employeeRows: EmployeeDirectoryRow[];
  /**
   * Directory slice used to identify the ACTOR, defaulting to `employeeRows`.
   *
   * These are deliberately two different lists. `employeeRows` is the active field directory, which
   * `isActiveDirectoryEmployee` filters by `organogram_visible` and explicitly excludes system-admin
   * accounts from — correctly, since they are not people on an org chart. But the Super Admin who
   * performs a desk validation IS one of those excluded accounts, so looking the actor up in that
   * slice found nothing and silently attributed the row to the employee it was done FOR. Pass the
   * unfiltered directory here so the admin can be named; the TARGET stays restricted to the active
   * slice, because a customer must only ever be parked on a working field employee.
   */
  actorRows?: EmployeeDirectoryRow[];
  onBehalfOfHrId?: string | null;
}): MarketingValidationActor {
  const requestedHrId = cleanText(params.onBehalfOfHrId);
  if (!requestedHrId) {
    const requester = findRequester(params.access, params.employeeRows);
    return {
      actorHrId: String(requester.hrId),
      actorIsKnownEmployee: true,
      actorName: requester.displayName,
      isOnBehalf: false,
      owner: requester,
    };
  }

  assertMarketingOnBehalfAccess(params.access);

  const rawActorHrId = assertMarketingActor(params.access);
  const employeesByHrId = employeeRowByHrId(params.actorRows ?? params.employeeRows);
  const owner = params.employeeRows.find(
    (row) => normalizeHrId(row.hrId) === normalizeHrId(requestedHrId),
  );
  if (!owner) {
    throw validationError(
      "The selected employee was not found in the active employee directory.",
      "on_behalf_employee_not_found",
    );
  }

  if (!marketingCreatorRoles.has(resolveJobFunctionRole(owner.jobTitle))) {
    throw validationError(
      `${owner.displayName} (${owner.jobTitle ?? "no job title"}) cannot raise marketing requests, so a customer cannot be validated for them.`,
      "on_behalf_employee_not_marketing_capable",
    );
  }

  const actorRow = employeesByHrId.get(normalizeHrId(rawActorHrId) ?? "");
  return {
    actorHrId: resolveStoredEmployeeHrId(rawActorHrId, employeesByHrId) ?? String(rawActorHrId),
    actorIsKnownEmployee: Boolean(actorRow),
    actorName: actorRow?.displayName ?? null,
    isOnBehalf: true,
    owner,
  };
}

/** Marketing-capable active employees a Super Admin may validate on behalf of. */
export function buildMarketingOnBehalfEmployees(
  employeeRows: EmployeeDirectoryRow[],
): MarketingOnBehalfEmployee[] {
  return employeeRows
    .filter((row) => marketingCreatorRoles.has(resolveJobFunctionRole(row.jobTitle)))
    .map((row) => ({
      areaName: row.areaName,
      hrId: row.hrId,
      jobTitle: row.jobTitle,
      lineName: row.lineName,
      name: row.displayName,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export type MarketingDraftProductScope = {
  canCreateDraft: boolean;
  products: MarketingProduct[];
  requesterLineId: number | null;
  requesterLineName: string | null;
};

// Resolves the draft-creation product scope for the workspace without hard-failing the
// whole page. An unrestricted oversight role (Super Admin / SFE Manager / system) sees
// every product line; a resolvable requester sees only its own line; a company-wide
// reviewer who is NOT a directory requester degrades to read-only (no creation scope,
// empty product list) instead of throwing `requester_not_found`.
export function buildMarketingDraftProductScope(params: {
  access: AccessContext;
  productRows: MarketingProductDbRow[];
  requester: MarketingRequesterLine | null;
  /** Per-user product_scope_override (uppercased codes). Additive — grants products outside the
   *  requester's line (e.g. a PM's one Anti-infective product) without narrowing the line default. */
  allowedProductCodes?: Set<string> | null;
}): MarketingDraftProductScope {
  const { access, productRows, requester } = params;
  const allowedProductCodes = params.allowedProductCodes ?? null;
  const unrestrictedProductLines = canUseAnyMarketingProductLine(access);
  const canCreateDraft = unrestrictedProductLines || requester !== null || allowedProductCodes !== null;

  let products: MarketingProduct[] = [];
  if (unrestrictedProductLines) {
    products = productRows.map(mapMarketingProduct);
  } else if (requester || allowedProductCodes) {
    products = productRows
      .filter((product) => marketingProductAllowedForRequester(product, requester, allowedProductCodes))
      .map(mapMarketingProduct);
  }

  return {
    canCreateDraft,
    products,
    requesterLineId: requester?.lineId ?? null,
    requesterLineName: unrestrictedProductLines ? "All product lines" : requester?.lineName ?? null,
  };
}

function generateMarketingCode(prefix: string) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${prefix}-${date}-${randomUUID().slice(0, 8).toUpperCase()}`;
}

function normalizeDraftProducts(inputProducts: MarketingRequestDraftProductInput[]) {
  if (!Array.isArray(inputProducts) || inputProducts.length === 0) {
    throw validationError("At least one product is required.");
  }

  const grouped = new Map<number, { productId: number; quantity: number }>();
  for (const product of inputProducts) {
    const productId = numberId(product?.productId, "Product");
    const quantity = nonNegativeNumber(product?.quantity);
    if (quantity <= 0) {
      throw validationError("Product quantity must be greater than zero.");
    }

    const current = grouped.get(productId);
    grouped.set(productId, {
      productId,
      quantity: (current?.quantity ?? 0) + quantity,
    });
  }

  return Array.from(grouped.values());
}

/**
 * Minimum length for an unverified-code justification. A one-word entry ("ok", "yes") is not a
 * reason and would turn the gate into a formality — the repo already treats too-short cleanup
 * reasons as blank elsewhere for the same reason.
 */
const UNVERIFIED_CODE_REASON_MIN_LENGTH = 10;

function normalizeDraftPharmacies(inputPharmacies: MarketingRequestDraftPharmacyInput[] | null | undefined) {
  if (!Array.isArray(inputPharmacies)) return [];

  const seen = new Set<string>();
  const rows: Array<{ distributorCodeId: string; notes: string | null; unverifiedCodeReason: string | null }> = [];
  for (const pharmacy of inputPharmacies) {
    const distributorCodeId = cleanText(pharmacy?.distributorCodeId);
    if (!distributorCodeId) {
      throw validationError("Distributor pharmacy code ID is required.");
    }
    if (seen.has(distributorCodeId)) continue;
    seen.add(distributorCodeId);
    rows.push({
      distributorCodeId,
      notes: cleanText(pharmacy?.notes),
      unverifiedCodeReason: cleanText(pharmacy?.unverifiedCodeReason),
    });
  }
  return rows;
}

export function normalizeMarketingRequestDraftInput(input: MarketingRequestCreateDraft) {
  const requestTypeId = numberId(input.requestTypeId, "Request type");
  const roiDurationMonths = numberId(input.roiDurationMonths, "ROI duration");
  const estimatedCost = Number(nonNegativeNumber(input.estimatedCost).toFixed(2));

  return {
    areaId: nullableNumberId(input.areaId),
    customerContactId: cleanText(input.customerContactId),
    customerId: cleanText(input.customerId),
    estimatedCost,
    lineId: nullableNumberId(input.lineId),
    notes: cleanText(input.notes),
    otherRequestType: cleanText(input.otherRequestType),
    payDate: nullableDateOnly(input.payDate, "Pay date"),
    pharmacies: normalizeDraftPharmacies(input.pharmacies),
    products: normalizeDraftProducts(input.products),
    requestDate: normalizeDateOnly(input.requestDate, "Request date"),
    requestTypeId,
    roiDurationMonths,
  };
}

function normalizeCustomerType(value: unknown) {
  const type = normalizeLookupKey(value) as MarketingCustomerType;
  if (!["hospital", "clinic", "account", "other"].includes(type)) {
    throw validationError("Customer type is required.");
  }
  return type;
}

function hasCapturedLocation(input: {
  capturedAt: string | null;
  capturedLatitude: number | null;
  capturedLongitude: number | null;
}) {
  return input.capturedLatitude !== null && input.capturedLongitude !== null && Boolean(input.capturedAt);
}

/**
 * What `evidence_status` is allowed to claim.
 *
 * `complete` requires the IMAGE, not its filename. Until 2026-08-04 this function reached
 * 'complete' on `evidencePhotoName` alone while the captured bytes were dropped in the browser —
 * so three production records asserted photographic proof of a real shop front that nobody could
 * ever retrieve, and `system_validated` (which is what puts a customer in the marketing request
 * dropdown) was granted on the strength of it.
 *
 * `evidencePhotoDataUrl` is the only input here that cannot be fabricated by a payload edit without
 * also producing a storable JPEG, and `createMarketingValidationRecord` aborts the whole submission
 * if that JPEG then fails to reach the bucket. So 'complete' now means, and only means: the image
 * is in `marketing-evidence` and a signed URL will resolve to it.
 */
export function evidenceStatusFromInput(input: {
  capturedAt: string | null;
  capturedLatitude: number | null;
  capturedLongitude: number | null;
  evidenceHasTimestamp: boolean;
  evidencePhotoCapturedAt: string | null;
  evidencePhotoDataUrl: string | null;
  evidencePhotoName: string | null;
}): MarketingEvidenceStatus {
  if (
    hasCapturedLocation(input) &&
    input.evidenceHasTimestamp &&
    Boolean(input.evidencePhotoCapturedAt) &&
    Boolean(input.evidencePhotoName) &&
    Boolean(input.evidencePhotoDataUrl)
  ) {
    return "complete";
  }

  if (
    hasCapturedLocation(input) ||
    input.evidenceHasTimestamp ||
    Boolean(input.evidencePhotoCapturedAt) ||
    Boolean(input.evidencePhotoName)
  ) {
    return "pending";
  }

  return "missing";
}

/**
 * Refuse a photo NAME that arrives without the photo (owner decision, 2026-08-04).
 *
 * A record with no photo at all is still perfectly legal — that is the desk-mode and
 * partial-capture path, and 155 of the 156 live customers look exactly like that. What is refused
 * is the shape that created the original defect: a filename and a capture timestamp presented as
 * evidence with no retrievable image behind them. Rejecting at normalize time means the caller
 * finds out before anything is written, rather than discovering later that the proof is a string.
 */
function normalizeEvidencePhotoDataUrl(value: unknown, label: string, photoName: string | null) {
  const raw = typeof value === "string" ? value.trim() : "";

  if (!raw) {
    if (photoName) {
      throw validationError(
        `${label} has a live capture photo name but no photo. Take the photo again so it can be stored as evidence.`,
        "evidence_photo_missing",
      );
    }
    return null;
  }

  try {
    // Parsed (not just pattern-matched) so an oversized or empty capture fails here, before the
    // record exists, instead of at upload time when a rollback is already in flight.
    parseMarketingEvidencePhotoDataUrl(raw);
  } catch (error) {
    throw validationError(
      `${label}: ${error instanceof Error ? error.message : "Live capture photo is not a valid image."}`,
      "evidence_photo_invalid",
    );
  }

  return raw;
}

function systemStatusFromEvidence(status: MarketingEvidenceStatus): MarketingValidationStatus {
  return status === "complete" ? "system_validated" : "pending";
}

export function resolveMarketingSystemValidationStatus(
  input: MarketingSystemValidationInput,
): MarketingValidationStatus {
  return input.customerEvidenceStatus === "complete" &&
    input.pharmacyEvidenceStatus === "complete" &&
    input.referenceStatus === "matched"
    ? "system_validated"
    : "pending";
}

/**
 * The single rule deciding what status a validation row is saved with.
 *
 * A Super Admin validating at the desk for another employee has no live GPS fix and no stamped
 * shop-front photo, so `resolveMarketingSystemValidationStatus` would park every desk row on
 * `pending` — and a `pending` row never reaches the marketing request customer dropdown, which is
 * the entire point of the desk flow. `sfe_validated` is the human-authority status the read filters
 * already accept, and routing desk rows there keeps `system_validated` meaning exactly what it has
 * always meant: complete field evidence plus a matched distributor code.
 */
export function resolveMarketingValidationRecordStatus(params: {
  isOnBehalf: boolean;
  systemStatus: MarketingValidationStatus;
}): MarketingValidationStatus {
  return params.isOnBehalf ? "sfe_validated" : params.systemStatus;
}

/**
 * Optional, but constrained to `MARKETING_CUSTOMER_SPECIALITIES` when supplied.
 *
 * Matched case-insensitively and returned in the list's canonical casing, so a payload carrying
 * "cardiology" still stores "Cardiology". Anything outside the list is refused rather than silently
 * stored — otherwise the picker would be decorative and the free-text drift it exists to prevent
 * would come straight back through the API.
 */
function normalizeCustomerSpeciality(value: unknown, label: string) {
  const raw = cleanText(value);
  if (!raw) return null;

  const match = MARKETING_CUSTOMER_SPECIALITIES.find(
    (option) => option.toLowerCase() === raw.toLowerCase(),
  );
  if (!match) {
    throw validationError(`${label} speciality "${raw}" is not a recognised speciality.`, "unknown_speciality");
  }
  return match;
}

function normalizeValidationPharmacy(
  inputPharmacy: MarketingValidationPharmacyInput,
  label: string,
): NormalizedMarketingValidationPharmacy {
  const displayName = cleanText(inputPharmacy?.displayName);
  if (!displayName) throw validationError(`${label} name is required.`);
  if (!Array.isArray(inputPharmacy.vendorCodes) || inputPharmacy.vendorCodes.length === 0) {
    throw validationError(`${label} needs at least one vendor code.`);
  }

  const pharmacyPhotoName = cleanText(inputPharmacy.evidencePhotoName);
  const pharmacy = {
    capturedAccuracyMeters: nonNegativeNumber(inputPharmacy.capturedAccuracyMeters),
    capturedAddress: cleanText(inputPharmacy.capturedAddress),
    capturedAt: nullableIsoTimestamp(inputPharmacy.capturedAt, `${label} capture time`),
    capturedLatitude: nullableCoordinate(inputPharmacy.capturedLatitude, `${label} latitude`, -90, 90),
    capturedLongitude: nullableCoordinate(inputPharmacy.capturedLongitude, `${label} longitude`, -180, 180),
    displayName,
    evidenceHasTimestamp: inputPharmacy.evidenceHasTimestamp === true,
    evidencePhotoCapturedAt: nullableIsoTimestamp(inputPharmacy.evidencePhotoCapturedAt, `${label} photo capture time`),
    evidencePhotoDataUrl: normalizeEvidencePhotoDataUrl(
      inputPharmacy.evidencePhotoDataUrl,
      label,
      pharmacyPhotoName,
    ),
    evidencePhotoName: pharmacyPhotoName,
    extractedAreaName: cleanText(inputPharmacy.extractedAreaName),
    extractedGovernorateName: cleanText(inputPharmacy.extractedGovernorateName),
    normalizedName: normalizeLookupKey(displayName),
    regionName: cleanText(inputPharmacy.regionName),
  };
  const pharmacyEvidenceStatus = evidenceStatusFromInput(pharmacy);
  const seenVendorCodes = new Set<string>();
  const vendorCodes = inputPharmacy.vendorCodes.map((vendorCode, vendorIndex) => {
    const distributorId = numberId(vendorCode.distributorId, `${label} vendor ${vendorIndex + 1}`);
    const distributorPharmacyCode = cleanText(vendorCode.distributorPharmacyCode);
    if (!distributorPharmacyCode) {
      throw validationError(`${label} vendor ${vendorIndex + 1} code is required.`);
    }
    const normalizedPharmacyCode = normalizeLookupKey(distributorPharmacyCode);
    const key = `${distributorId}:${normalizedPharmacyCode}`;
    if (seenVendorCodes.has(key)) {
      throw validationError(`${label} has a duplicate vendor code.`);
    }
    seenVendorCodes.add(key);

    return {
      distributorId,
      distributorPharmacyCode,
      normalizedPharmacyCode,
    };
  });

  return {
    ...pharmacy,
    capturedAccuracyMeters: pharmacy.capturedAccuracyMeters || null,
    evidenceStatus: pharmacyEvidenceStatus,
    validationStatus: systemStatusFromEvidence(pharmacyEvidenceStatus),
    vendorCodes,
  };
}

function normalizeValidationCustomer(
  inputCustomer: MarketingValidationCustomerInput | undefined,
  inputPharmacies: MarketingValidationPharmacyInput[],
  /** "" for a single customer so the existing messages are unchanged; "Customer 2 " when several. */
  prefix: string,
): NormalizedMarketingValidationCustomer {
  const customerLabel = prefix ? prefix.trim() : "Customer";
  const displayName = cleanText(inputCustomer?.displayName);
  if (!displayName) throw validationError(`${customerLabel} name is required.`);

  const customerPhotoName = cleanText(inputCustomer?.evidencePhotoName);
  const customer = {
    capturedAccuracyMeters: nonNegativeNumber(inputCustomer?.capturedAccuracyMeters),
    capturedAddress: cleanText(inputCustomer?.capturedAddress),
    capturedAt: nullableIsoTimestamp(inputCustomer?.capturedAt, `${customerLabel} capture time`),
    capturedLatitude: nullableCoordinate(inputCustomer?.capturedLatitude, `${customerLabel} latitude`, -90, 90),
    capturedLongitude: nullableCoordinate(inputCustomer?.capturedLongitude, `${customerLabel} longitude`, -180, 180),
    customerType: normalizeCustomerType(inputCustomer?.customerType),
    displayName,
    evidenceHasTimestamp: inputCustomer?.evidenceHasTimestamp === true,
    evidencePhotoCapturedAt: nullableIsoTimestamp(inputCustomer?.evidencePhotoCapturedAt, `${customerLabel} photo capture time`),
    evidencePhotoDataUrl: normalizeEvidencePhotoDataUrl(
      inputCustomer?.evidencePhotoDataUrl,
      customerLabel,
      customerPhotoName,
    ),
    evidencePhotoName: customerPhotoName,
    extractedAreaName: cleanText(inputCustomer?.extractedAreaName),
    extractedGovernorateName: cleanText(inputCustomer?.extractedGovernorateName),
    mobileNumber: cleanText(inputCustomer?.mobileNumber),
    normalizedName: normalizeLookupKey(displayName),
    otherTypeDescription: cleanText(inputCustomer?.otherTypeDescription),
    regionName: cleanText(inputCustomer?.regionName),
    speciality: normalizeCustomerSpeciality(inputCustomer?.speciality, customerLabel),
  };
  const customerEvidenceStatus = evidenceStatusFromInput(customer);

  if (inputPharmacies.length === 0) {
    throw validationError(
      prefix ? `${customerLabel} needs at least one pharmacy.` : "At least one pharmacy is required.",
    );
  }

  return {
    ...customer,
    capturedAccuracyMeters: customer.capturedAccuracyMeters || null,
    evidenceStatus: customerEvidenceStatus,
    pharmacies: inputPharmacies.map((inputPharmacy, index) =>
      normalizeValidationPharmacy(inputPharmacy, `${prefix}${prefix ? "p" : "P"}harmacy ${index + 1}`),
    ),
    validationStatus: systemStatusFromEvidence(customerEvidenceStatus),
  };
}

export function normalizeMarketingValidationInput(
  input: MarketingValidationInput,
): NormalizedMarketingValidationInput {
  // One submission can carry several customers, each with its own pharmacies. The legacy
  // single-customer shape still round-trips so an offline replay queued before this shipped, or any
  // caller still posting `customer` + `pharmacies`, keeps working instead of 400-ing.
  const multiCustomerInput = Array.isArray(input.customers) ? input.customers.filter(Boolean) : [];
  if (multiCustomerInput.length > 0) {
    const seenNames = new Set<string>();
    return {
      customers: multiCustomerInput.map((entry, index) => {
        const prefix = multiCustomerInput.length > 1 ? `Customer ${index + 1} ` : "";
        const normalized = normalizeValidationCustomer(
          entry,
          Array.isArray(entry.pharmacies) ? entry.pharmacies : [],
          prefix,
        );
        // Two rows for the same customer in one submission would mint two separate records that
        // then both surface in the request dropdown, indistinguishable to whoever picks one.
        if (seenNames.has(normalized.normalizedName)) {
          throw validationError(
            `"${normalized.displayName}" appears more than once in this submission.`,
            "duplicate_customer",
          );
        }
        seenNames.add(normalized.normalizedName);
        return normalized;
      }),
    };
  }

  const legacyPharmacies = Array.isArray(input.pharmacies) && input.pharmacies.length > 0
    ? input.pharmacies
    : input.pharmacy && input.distributorCode
      ? [{ ...input.pharmacy, vendorCodes: [input.distributorCode] }]
      : [];

  return { customers: [normalizeValidationCustomer(input.customer, legacyPharmacies, "")] };
}

export function prepareMarketingRequestDraft(params: {
  customer: MarketingCustomerDbRow;
  input: MarketingRequestCreateDraft;
  pharmacyCodes?: MarketingPharmacyDistributorCodeDbRow[];
  products: MarketingProductDbRow[];
  requestCode?: string;
  requestType: MarketingRequestTypeDbRow;
  requester: Pick<EmployeeDirectoryRow, "areaId" | "hrId" | "lineId" | "managerHrId"> & { lineName?: string | null };
  unrestrictedProductLines?: boolean;
  /** Additive per-user product allowlist (product_scope_override) — see marketingProductAllowedForRequester. */
  allowedProductCodes?: Set<string> | null;
}): PreparedMarketingRequestDraft {
  const normalized = normalizeMarketingRequestDraftInput(params.input);
  if (!normalized.customerId) throw validationError("Customer is required.");
  if (params.customer.active === false) throw validationError("Customer is inactive.");
  if (String(params.customer.id) !== normalized.customerId) {
    throw validationError("Customer does not match the draft input.");
  }
  if (params.requestType.active === false) throw validationError("Request type is inactive.");
  if (params.requestType.requires_description && !normalized.otherRequestType) {
    throw validationError("Other request type description is required.");
  }

  const productRowsById = new Map(params.products.map((product) => [Number(product.id), product]));
  const missingProduct = normalized.products.find((product) => !productRowsById.has(product.productId));
  if (missingProduct) {
    throw notFoundError(`Product ${missingProduct.productId} was not found or is inactive.`, "product_not_found");
  }
  const allowedProductCodes = params.allowedProductCodes ?? null;
  const requesterLineId = params.requester.lineId ?? null;
  const requesterLineName = normalizeScopeText(params.requester.lineName);
  if (requesterLineId === null && !requesterLineName && !params.unrestrictedProductLines && !allowedProductCodes) {
    throw validationError("Requester product line is not assigned. Please contact HR.", "requester_line_not_assigned");
  }
  const outsideRequesterLine = normalized.products.find((product) => {
    const row = productRowsById.get(product.productId);
    return !params.unrestrictedProductLines && row &&
      !marketingProductAllowedForRequester(row, params.requester, allowedProductCodes);
  });
  if (outsideRequesterLine) {
    throw validationError("Marketing requests can only include products from your assigned line.", "product_line_not_allowed");
  }

  const roiProducts = normalized.products.map((product) => {
    const row = productRowsById.get(product.productId);
    if (!row) throw notFoundError(`Product ${product.productId} was not found or is inactive.`, "product_not_found");

    return {
      factoryPrice: toNumber(row.factory_price),
      productId: Number(row.id),
      productName: row.product_name,
      quantity: product.quantity,
    };
  });
  const roiPreview = calculateMarketingRoiPreview({
    durationMonths: normalized.roiDurationMonths,
    estimatedCost: normalized.estimatedCost,
    products: roiProducts,
  });
  const requesterHrId = String(params.requester.hrId);
  const areaId = (normalized.areaId ?? Number(params.customer.area_id ?? params.requester.areaId ?? 0)) || null;
  // A requester with an additive product override can span lines, so tag the request with the
  // line of its products when they are unambiguously single-line (a request is single-line in
  // practice), falling back to the requester's own line. Guarded to override users, so every
  // existing (non-override) requester keeps the exact requester-line tag as before.
  const requestProductLineId = (() => {
    const lineIds = new Set(
      normalized.products
        .map((product) => productRowsById.get(product.productId)?.line_id)
        .filter((value): value is number | string => value !== null && value !== undefined)
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value)),
    );
    return lineIds.size === 1 ? [...lineIds][0] : null;
  })();
  const lineId = params.unrestrictedProductLines
    ? (normalized.lineId ?? Number(params.customer.line_id ?? requesterLineId ?? 0)) || null
    : allowedProductCodes
      ? (requestProductLineId ?? requesterLineId)
      : requesterLineId;
  const managerHrId = cleanText(params.customer.manager_hr_id) ?? cleanText(params.requester.managerHrId);
  const pharmacyCodesById = new Map((params.pharmacyCodes ?? []).map((code) => [code.id, code]));

  const pharmacyRows = normalized.pharmacies.map((pharmacy) => {
    const code = pharmacyCodesById.get(pharmacy.distributorCodeId);
    if (!code || code.active === false) {
      throw notFoundError("Distributor pharmacy code was not found or is inactive.", "pharmacy_code_not_found");
    }

    // CAPTURE GATE — a pharmacy code the reference database cannot find must not enter a request.
    //
    // Attribution matches on exact distributor + pharmacy code + product + period, so a code that
    // does not exist in the reference data can never attribute a single sale. Measured on
    // production: a `not_found` code has no sales 27.9% of the time versus 1.3% for a matched one
    // — roughly 21x worse. Until now this was only LABELLED (the request was marked "pending"
    // rather than "system_validated") and still allowed through, which is how 122 unusable codes
    // accumulated in the historical set. By the time anyone notices, the ROI window has closed and
    // the evidence cannot be reconstructed — so this has to be refused at write time, not reported
    // at read time.
    //
    // Deliberately scoped to `not_found` only. `ambiguous` (a code registered against more than one
    // distributor) and `pending` (a genuinely new code the matcher has not processed yet) are both
    // recoverable and still attribute; blocking them would stop legitimate submissions the day a
    // new pharmacy is added. Those two stay visible as a warning and via the confidence score.
    //
    // OVERRIDE, added deliberately: a hard block alone was unshippable. 87 of 154 production
    // customers carry at least one `not_found` code, and 112 of them sit under POS and Ibn sina
    // where the reference data is large and healthy — meaning they need individual human
    // verification that will not finish quickly. A blanket refusal would have stopped over half
    // the customer base from submitting at all, and people would route around Phoenix rather than
    // wait. So the code may still be used, but never silently: someone has to write down why, and
    // the reason is stored on the request itself.
    let overrideNote: string | null = null;
    if (code.reference_status === "not_found") {
      const label = code.distributor_pharmacy_code ?? code.normalized_pharmacy_code ?? code.id;
      const reason = pharmacy.unverifiedCodeReason;
      if (!reason || reason.length < UNVERIFIED_CODE_REASON_MIN_LENGTH) {
        throw validationError(
          `Pharmacy code "${label}" is not recognised by the reference database, so no sale can be matched to it. Correct it in Customer Validation, or record why it must be used as-is (at least ${UNVERIFIED_CODE_REASON_MIN_LENGTH} characters).`,
          "pharmacy_code_not_in_reference",
        );
      }
      overrideNote = `Unverified pharmacy code "${label}" accepted — ${reason}`;
    }

    return {
      distributor_code_id: code.id,
      // The override reason is kept alongside any note the requester wrote rather than replacing
      // it, so neither is lost. It lives on the request row, which is what makes the decision
      // auditable after the fact instead of existing only in the moment it was made.
      notes: [pharmacy.notes, overrideNote].filter(Boolean).join(" | ") || null,
      pharmacy_id: code.pharmacy_id,
    };
  });

  return {
    pharmacyRows,
    productRows: roiPreview.products.map((product) => {
      const row = productRowsById.get(Number(product.productId));
      if (!row) throw notFoundError(`Product ${product.productId} was not found or is inactive.`, "product_not_found");

      return {
        factory_price_snapshot: product.factoryPrice,
        forecast_quantity: product.quantity,
        line_snapshot: row.line,
        product_id: Number(row.id),
        product_name_snapshot: row.product_name,
        value_share: product.valueShare,
      };
    }),
    requestRow: {
      area_id: areaId,
      created_by_hr_id: requesterHrId,
      customer_contact_id: normalized.customerContactId,
      customer_id: normalized.customerId,
      estimated_cost: normalized.estimatedCost,
      expected_roi_value: roiPreview.expectedRoiValue,
      line_id: lineId,
      manager_hr_id: managerHrId,
      notes: normalized.notes,
      other_request_type: normalized.otherRequestType,
      pay_date: normalized.payDate,
      request_code: params.requestCode ?? generateMarketingCode("MKT-REQ"),
      request_date: normalized.requestDate,
      request_type_id: normalized.requestTypeId,
      requester_hr_id: requesterHrId,
      roi_duration_months: normalized.roiDurationMonths,
      roi_status: roiPreview.roiStatus,
      status: "draft",
      updated_by_hr_id: requesterHrId,
    },
  };
}

function mapRequest(row: MarketingRequestDbRow): MarketingRequest {
  return {
    approvedAt: row.approved_at ?? null,
    areaId: row.area_id === null ? null : Number(row.area_id),
    closedAt: row.closed_at ?? null,
    createdAt: nowIsoFallback(row.created_at),
    createdByHrId: row.created_by_hr_id ?? null,
    customerContactId: row.customer_contact_id,
    customerId: row.customer_id,
    estimatedCost: toNumber(row.estimated_cost),
    executedAt: row.executed_at ?? null,
    expectedRoiValue: toNumber(row.expected_roi_value),
    id: row.id,
    lineId: row.line_id === null ? null : Number(row.line_id),
    managerHrId: row.manager_hr_id,
    notes: row.notes,
    otherRequestType: row.other_request_type,
    payDate: row.pay_date,
    rejectedAt: row.rejected_at ?? null,
    returnedAt: row.returned_at ?? null,
    returnedStepSequence: row.returned_step_sequence === null || row.returned_step_sequence === undefined
      ? null
      : Number(row.returned_step_sequence),
    requestCode: row.request_code,
    requestDate: row.request_date,
    requesterHrId: row.requester_hr_id,
    requestTypeId: Number(row.request_type_id),
    requiredRoiValue: toNumber(
      // Mirrors the generated DB column (marketing_roi_flat_no_duration): required ROI is a FLAT
      // 10× estimated cost — campaign duration does NOT scale the target.
      row.required_roi_value ?? toNumber(row.estimated_cost) * 10,
    ),
    roiCoverageRatio: toNumber(row.roi_coverage_ratio),
    roiDurationMonths: Number(row.roi_duration_months),
    roiStatus: row.roi_status,
    status: row.status,
    submittedAt: row.submitted_at ?? null,
    updatedAt: nowIsoFallback(row.updated_at),
    updatedByHrId: row.updated_by_hr_id ?? null,
  };
}

function mapApprovalStep(row: MarketingRequestApprovalStepDbRow): MarketingRequestApprovalStep {
  return {
    allowReject: row.allow_reject ?? true,
    allowReturn: row.allow_return ?? true,
    assignedHrId: row.assigned_hr_id ?? null,
    assignedRole: row.assigned_role,
    createdAt: nowIsoFallback(row.created_at),
    decisionAt: row.decision_at ?? null,
    decisionByHrId: row.decision_by_hr_id ?? null,
    decisionLabels: row.decision_labels ? normalizeMarketingDecisionLabels(row.decision_labels) : null,
    decisionNote: row.decision_note ?? null,
    executedAt: row.executed_at ?? null,
    id: row.id,
    isCc: row.is_cc ?? false,
    requestId: row.request_id,
    sequence: Number(row.sequence),
    status: row.status,
    stepCode: row.step_code,
    stepKind: row.step_kind ? normalizeMarketingStepKind(row.step_kind) : null,
    stepName: row.step_name,
    terminalStatus: (cleanText(row.terminal_status) as MarketingRequest["status"] | null) ?? null,
    updatedAt: nowIsoFallback(row.updated_at),
    workflowStepId: row.workflow_step_id === null || row.workflow_step_id === undefined ? null : Number(row.workflow_step_id),
  };
}

function sameNullableId(left: number | null | undefined, right: number | null | undefined) {
  return left !== null && left !== undefined && right !== null && right !== undefined && left === right;
}

function employeeMatchesMarketingRequestScope(employee: EmployeeDirectoryRow | undefined, request: MarketingRequest) {
  if (!employee) return false;
  if (sameNullableId(employee.lineId, request.lineId)) return true;
  if (sameNullableId(employee.areaId, request.areaId)) return true;
  return false;
}

async function roleApproverHrId(params: {
  employeeRows: EmployeeDirectoryRow[];
  request: MarketingRequest;
  roleName: string;
  supabase: SupabaseClient;
}) {
  let role: PhoenixRole;
  try {
    role = parseRoleStrict(params.roleName);
  } catch {
    return null;
  }

  const { data, error } = await params.supabase
    .from("app_auth_users")
    .select("hr_id,role,is_active")
    .eq("is_active", true)
    .ilike("role", role);
  if (error) throw error;

  const employeesByHrId = employeeRowByHrId(params.employeeRows);
  const candidates = ((data ?? []) as Array<{ hr_id?: string | null; role?: string | null }>)
    .map((row) => normalizeHrId(row.hr_id))
    .filter((hrId): hrId is string => Boolean(hrId));

  if (candidates.length === 0) return null;
  if (
    role === "CEO" ||
    role === "Finance Manager" ||
    role === "Financial Advisor" ||
    role === "SFE Manager" ||
    role === "Marketing Manager" ||
    role === "Group Product Manager"
  ) {
    // Reviewer roles resolved per request. Prefer an unambiguous line/area match (so a Pedia request
    // routes to the Pedia Group Product Manager, an Anti-Inf request to the Anti-Inf Marketing
    // Manager, etc.); otherwise fall back DETERMINISTICALLY (lowest canonical HR_ID) instead of
    // returning null. Returning null previously stalled EVERY submission whenever two seats existed
    // for a company-wide role (e.g. a second Marketing Manager). Any active holder of these roles can
    // perform the review, so a stable pick is safe; a genuinely empty roster (0 candidates) still
    // fails loudly above.
    const scoped = candidates.filter((hrId) => employeeMatchesMarketingRequestScope(employeesByHrId.get(hrId), params.request));
    if (scoped.length === 1) return scoped[0];
    if (scoped.length > 1) return [...scoped].sort()[0];
    if (candidates.length === 1) return candidates[0];
    return [...candidates].sort()[0];
  }
  return candidates.length === 1 ? candidates[0] : null;
}

async function workflowStepApproverHrId(params: {
  employeeRows: EmployeeDirectoryRow[];
  request: MarketingRequest;
  step: MarketingWorkflowStep;
  supabase: SupabaseClient;
  /** Override the resolved role (used by per-line review routing) — defaults to the step's role. */
  roleNameOverride?: string;
}) {
  if (params.step.approvalScope === "direct_manager") return normalizeHrId(params.request.managerHrId);
  const roleName = params.roleNameOverride ?? params.step.assignedRole;
  const primary = await roleApproverHrId({
    employeeRows: params.employeeRows,
    request: params.request,
    roleName,
    supabase: params.supabase,
  });
  return primary;
}

async function loadActiveMarketingWorkflowSteps(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("marketing_workflow_steps")
    .select("*")
    .eq("active", true)
    .order("sequence", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as MarketingWorkflowStepDbRow[]).map(mapWorkflowStep);
}

/**
 * Per-line override for the post-SFE "Marketing Review" reviewer. Returns `{ reviewerRole, ccRoles }`
 * for the request's line, or null when the line has no routing row (→ keep the default Marketing
 * Manager reviewer + template CC). Requests are single-line, so a single row resolves the reviewer.
 */
async function loadMarketingReviewRoutingByLine(
  supabase: SupabaseClient,
  lineId: number | null,
): Promise<{ ccRoles: string[]; reviewerRole: string } | null> {
  if (lineId === null || lineId === undefined) return null;
  const { data, error } = await supabase
    .from("marketing_review_routing")
    .select("reviewer_role, cc_roles")
    .eq("active", true)
    .eq("line_id", lineId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { cc_roles?: string[] | null; reviewer_role?: string | null };
  const reviewerRole = cleanText(row.reviewer_role);
  if (!reviewerRole) return null;
  const ccRoles = (row.cc_roles ?? [])
    .map((value) => cleanText(value))
    .filter((value): value is string => Boolean(value));
  return { ccRoles, reviewerRole };
}

function marketingChainStepName(roleName: string) {
  return `${roleName} Approval`;
}

/**
 * Expand the managerial chain into one approval step per manager above the requester,
 * walking up manager_hr_id and stopping after the chain target role (National Sales
 * Manager). Starting at the requester's manager means the requester's own level is
 * skipped automatically (a District Manager submitter starts at the NSM). manager_hr_id
 * is the live, seat-continuity-connected edge, so vacant seats already point upward.
 */
export function buildMarketingManagerChain(params: {
  chainTargetRole: string | null;
  employeeRows: EmployeeDirectoryRow[];
  requester: EmployeeDirectoryRow;
}): Array<{ assignedHrId: string; assignedRole: string; stepName: string }> {
  const byHrId = employeeRowByHrId(params.employeeRows);
  const chain: Array<{ assignedHrId: string; assignedRole: string; stepName: string }> = [];
  const visited = new Set<string>();
  let currentHrId = normalizeHrId(params.requester.managerHrId);
  let depth = 0;
  while (currentHrId && depth < 8 && !visited.has(currentHrId)) {
    visited.add(currentHrId);
    const managerRow = byHrId.get(currentHrId);
    if (!managerRow) break;
    const roleName = String(resolveJobFunctionRole(managerRow.jobTitle));
    chain.push({ assignedHrId: currentHrId, assignedRole: roleName, stepName: marketingChainStepName(roleName) });
    if (params.chainTargetRole && roleName === params.chainTargetRole) break;
    currentHrId = normalizeHrId(managerRow.managerHrId);
    depth += 1;
  }
  return chain;
}

/** Product/Group Product Manager(s) of the request's line, CC-notified (never gate). */
export async function resolveLineCcHrIds(params: {
  ccRoles: string[];
  employeeRows: EmployeeDirectoryRow[];
  request: MarketingRequest;
  supabase: SupabaseClient;
}): Promise<string[]> {
  if (params.ccRoles.length === 0) return [];
  const roles: PhoenixRole[] = [];
  for (const raw of params.ccRoles) {
    try {
      roles.push(parseRoleStrict(raw));
    } catch {
      // ignore unknown cc role
    }
  }
  if (roles.length === 0) return [];

  const { data, error } = await params.supabase
    .from("app_auth_users")
    .select("hr_id,role,is_active")
    .eq("is_active", true)
    .in("role", roles);
  if (error) throw error;

  const byHrId = employeeRowByHrId(params.employeeRows);
  const ccHrIds = new Set<string>();
  for (const row of (data ?? []) as Array<{ hr_id?: string | null }>) {
    const hrId = normalizeHrId(row.hr_id);
    if (!hrId) continue;
    if (sameNullableId(byHrId.get(hrId)?.lineId, params.request.lineId)) ccHrIds.add(hrId);
  }
  return Array.from(ccHrIds);
}

async function createMarketingApprovalSteps(params: {
  employeeRows: EmployeeDirectoryRow[];
  request: MarketingRequest;
  supabase: SupabaseClient;
}) {
  const workflowSteps = await loadActiveMarketingWorkflowSteps(params.supabase);
  const requiredSteps = workflowSteps.filter((step) => step.required);
  if (requiredSteps.length === 0) {
    throw validationError("Marketing workflow has no active required approval steps.", "marketing_workflow_missing");
  }

  const byHrId = employeeRowByHrId(params.employeeRows);
  const requesterRow = byHrId.get(normalizeHrId(params.request.requesterHrId) ?? "");
  const rows: Array<Record<string, unknown>> = [];
  let sequence = 0;
  const pushRow = (input: {
    assignedHrId: string;
    assignedRole: string;
    isCc: boolean;
    step: MarketingWorkflowStep;
    stepName: string;
  }) => {
    // Store the approver against the employee master's real casing — the
    // `assigned_hr_id` FK to employees(hr_id) is case-sensitive. A gating approver that
    // is not a CURRENT (active) employee is a hard configuration error (fail loudly,
    // before the generic FK violation); a non-employee CC reviewer is advisory, so
    // silently skip it. `resolveStoredEmployeeHrId` alone can't detect "resigned": it
    // deliberately still returns a display-cased HR_ID when the id is absent from
    // `byHrId` (e.g. a stale `direct_manager` scope pointing at someone who has since
    // resigned), so active status is checked separately via `isActiveEmployeeHrId`.
    const storedHrId = resolveStoredEmployeeHrId(input.assignedHrId, byHrId);
    if (!isActiveEmployeeHrId(input.assignedHrId, byHrId) || !storedHrId) {
      if (input.isCc) return;
      throw validationError(
        `The approver for the "${input.stepName}" step is not a current employee. Ask an administrator to assign an active employee to the ${input.assignedRole} role before submitting this marketing request.`,
        "marketing_approver_not_employee",
      );
    }
    sequence += 1;
    rows.push({
      allow_reject: input.step.allowReject,
      allow_return: input.step.allowReturn,
      assigned_hr_id: storedHrId,
      assigned_role: input.assignedRole,
      decision_labels: input.step.decisionLabels,
      is_cc: input.isCc,
      request_id: params.request.id,
      sequence,
      status: input.isCc ? "skipped" : "pending",
      step_code: input.step.stepCode,
      step_kind: input.step.stepKind,
      step_name: input.stepName,
      terminal_status: input.step.terminalStatus,
      workflow_step_id: input.step.id,
    });
  };

  for (const step of requiredSteps) {
    if (step.stepKind === "managerial_chain") {
      if (!requesterRow) {
        throw validationError("Requester was not found in the employee directory.", "requester_not_found");
      }
      const chain = buildMarketingManagerChain({
        chainTargetRole: step.chainTargetRole,
        employeeRows: params.employeeRows,
        requester: requesterRow,
      });
      if (chain.length === 0) {
        throw validationError(`No approving manager could be resolved for ${requesterRow.displayName}.`, "marketing_approver_not_resolved");
      }
      for (const node of chain) {
        pushRow({ assignedHrId: node.assignedHrId, assignedRole: node.assignedRole, isCc: false, step, stepName: node.stepName });
      }
      continue;
    }

    // Per-line review routing: the post-SFE "Marketing Review" reviewer (and which line PM/GPM are
    // CC'd to comment) is chosen by the request's line. Unmapped lines keep the default Marketing
    // Manager reviewer + the template CC roles. Every other step is unchanged.
    let effectiveRole = step.assignedRole;
    let effectiveCcRoles = step.ccRoles;
    if (step.stepCode === "marketing_review") {
      const routing = await loadMarketingReviewRoutingByLine(params.supabase, params.request.lineId ?? null);
      if (routing) {
        effectiveRole = routing.reviewerRole;
        effectiveCcRoles = routing.ccRoles;
      }
    }

    const assignedHrId = await workflowStepApproverHrId({
      employeeRows: params.employeeRows,
      request: params.request,
      roleNameOverride: effectiveRole,
      step,
      supabase: params.supabase,
    });
    if (!assignedHrId) {
      throw validationError(
        `No active ${effectiveRole} is configured to handle the "${step.stepName}" step. Ask an administrator to assign an active ${effectiveRole} before submitting this marketing request.`,
        "marketing_approver_not_resolved",
      );
    }
    pushRow({ assignedHrId, assignedRole: effectiveRole, isCc: false, step, stepName: step.stepName });

    if (effectiveCcRoles.length > 0) {
      const ccHrIds = await resolveLineCcHrIds({
        ccRoles: effectiveCcRoles,
        employeeRows: params.employeeRows,
        request: params.request,
        supabase: params.supabase,
      });
      for (const ccHrId of ccHrIds) {
        if (ccHrId === assignedHrId) continue;
        pushRow({ assignedHrId: ccHrId, assignedRole: effectiveRole, isCc: true, step, stepName: `${step.stepName} (CC)` });
      }
    }
  }

  const firstGating = rows.find((row) => row.is_cc === false);
  if (firstGating) firstGating.status = "current";

  const { data, error } = await params.supabase
    .from("marketing_request_approval_steps")
    .insert(rows)
    .select("*")
    .order("sequence", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as MarketingRequestApprovalStepDbRow[]).map(mapApprovalStep);
}

/**
 * Both branches used to hardcode a shell, and both were wrong for half the approver chain.
 *
 * The view link pointed at `/admin/approvals-hub`, which excludes marketing BY DESIGN (see
 * src/lib/action-center/service.ts: "Marketing is intentionally excluded everywhere — it keeps its
 * own dedicated inbox"), so it could never show the request. The decision links pointed at the
 * portal, which redirects admin-shell approvers to /overview. A notification's actionUrl is stored
 * once and shared by every recipient, so the link has to be shell-neutral and resolve per viewer.
 */
function marketingActionUrl(requestId: string, decision?: "approve" | "reject" | "return") {
  return marketingRequestNotificationUrl(requestId, decision);
}

function marketingTelegramButtons(requestId: string) {
  return [
    { label: "View Details", type: "view", url: marketingActionUrl(requestId) },
    { label: "Approve in Phoenix", type: "approve", url: marketingActionUrl(requestId, "approve") },
    { label: "Reject in Phoenix", type: "reject", url: marketingActionUrl(requestId, "reject") },
    { label: "Return in Phoenix", type: "return", url: marketingActionUrl(requestId, "return") },
  ];
}

async function notifyMarketingWorkflow(params: {
  actorHrId: string | null;
  ccHrIds?: string[];
  eventType: "request_assigned" | "request_returned" | "request_approved" | "request_rejected" | "request_completed" | "due_date_reminder" | "overdue_reminder" | "escalation";
  message: string;
  metadata?: Record<string, unknown>;
  priority?: "normal" | "high" | "critical";
  request: MarketingRequest;
  title: string;
}) {
  const isAssigned = params.eventType === "request_assigned";
  const ccHrIds = Array.from(new Set((params.ccHrIds ?? []).filter((hrId): hrId is string => Boolean(hrId))));
  const existingParticipants = Array.isArray(params.metadata?.workflowParticipantHrIds)
    ? (params.metadata.workflowParticipantHrIds as string[])
    : [];

  // Editable-template token values for the email (products table, financials, return reason).
  const supabase = getSupabaseAdmin();
  const [productsResult, customerResult] = await Promise.all([
    supabase.from("marketing_request_products").select("*").eq("request_id", params.request.id),
    params.request.customerId
      ? supabase.from("marketing_customers").select("display_name").eq("id", params.request.customerId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const products = ((productsResult.data ?? []) as MarketingRequestProductDbRow[]).map(mapProduct);
  const emailContext = buildMarketingEmailContext({
    currentStepName:
      cleanText(params.metadata?.currentStepName as string | null | undefined) ??
      cleanText(params.metadata?.approvalStep as string | null | undefined),
    customerName: cleanText((customerResult.data as { display_name?: string | null } | null)?.display_name),
    noteHeading: params.eventType === "request_rejected" ? "Rejected" : "Returned",
    products,
    request: params.request,
    returnNote: cleanText(params.metadata?.returnNote as string | null | undefined),
    returnedByName: cleanText(params.metadata?.returnedByName as string | null | undefined),
  });

  await createSystemNotification({
    actionUrl: marketingActionUrl(params.request.id),
    actorId: params.actorHrId,
    email: {
      templateContext: emailContext,
    },
    eventType: params.eventType,
    message: params.message,
    metadata: {
      requestCode: params.request.requestCode,
      requestId: params.request.id,
      requestOwnerHrId: params.request.requesterHrId,
      status: params.request.status,
      ...(params.metadata ?? {}),
      ...(ccHrIds.length > 0
        ? { ccHrIds, workflowParticipantHrIds: Array.from(new Set([...existingParticipants, ...ccHrIds])) }
        : {}),
      idempotencyKey: `marketing-request:${params.eventType}:${params.request.id}:${params.metadata?.idempotencyEpoch ?? params.metadata?.currentStepId ?? params.metadata?.decisionAt ?? "event"}`,
    },
    module: "marketing_requests",
    priority: params.priority ?? "high",
    recordId: params.request.id,
    subjectHrId: params.request.requesterHrId,
    telegram: isAssigned ? { buttons: marketingTelegramButtons(params.request.id) } : undefined,
    title: params.title,
  }).catch((error) => {
    // Best-effort, but no longer silent — surface so a broken marketing notification is visible.
    logError("Marketing workflow notification failed", {
      labels: { event: "marketing_notification_failed", eventType: params.eventType, requestId: params.request.id },
      error,
    });
  });
}

// --- Marketing SLA reminders (daily) ---------------------------------------
const MARKETING_SLA_PENDING_STATUSES = ["pending_validation", "pending_approval", "returned"] as const;
const MARKETING_SLA_DUE_SOON_DAYS = 3; // remind when the pay date is within N days
const MARKETING_SLA_ESCALATION_DAYS = 2; // escalate when overdue by more than N days

export type MarketingSlaEvent = "due_date_reminder" | "overdue_reminder" | "escalation";

/**
 * Pure SLA classifier from a request's pay date relative to today (both YYYY-MM-DD,
 * Africa/Cairo). Returns the event to fire, or null when comfortably before the due date.
 */
export function classifyMarketingSla(input: { payDate: string | null; today: string }): MarketingSlaEvent | null {
  if (!input.payDate) return null;
  const due = Date.parse(`${input.payDate}T00:00:00Z`);
  const today = Date.parse(`${input.today}T00:00:00Z`);
  if (!Number.isFinite(due) || !Number.isFinite(today)) return null;
  const daysUntilDue = Math.round((due - today) / 86_400_000);
  if (daysUntilDue < -MARKETING_SLA_ESCALATION_DAYS) return "escalation";
  if (daysUntilDue < 0) return "overdue_reminder";
  if (daysUntilDue <= MARKETING_SLA_DUE_SOON_DAYS) return "due_date_reminder";
  return null;
}

// --- Waiting-time SLA ---------------------------------------------------------------------
// The pay-date rule above catches a request running out of runway. It cannot catch a request that
// is simply STUCK: one submitted with a pay date three months out produces no signal at all,
// however long an approver sits on it, and only starts alerting once the pay date is nearly on
// top of it — by which point the delay has already happened. These thresholds measure the other
// axis: how long the CURRENT approval step has been waiting for a decision.
const MARKETING_WAITING_DUE_SOON_DAYS = 3;
const MARKETING_WAITING_OVERDUE_DAYS = 7;
const MARKETING_WAITING_ESCALATION_DAYS = 14;

/**
 * Pure classifier for how long the current approval step has been outstanding.
 *
 * `waitingSince` is the step's last status change — a step's `updated_at` is stamped when it is
 * made `current`, including when a returned request is resumed. So reassigning or resubmitting
 * legitimately restarts the clock rather than counting elapsed time against someone who was not
 * yet responsible for the decision.
 */
export function classifyMarketingWaitingSla(input: {
  waitingSince: string | null;
  now: string;
}): MarketingSlaEvent | null {
  const daysWaiting = marketingDaysWaiting(input.waitingSince, input.now);
  if (daysWaiting === null) return null;
  if (daysWaiting >= MARKETING_WAITING_ESCALATION_DAYS) return "escalation";
  if (daysWaiting >= MARKETING_WAITING_OVERDUE_DAYS) return "overdue_reminder";
  if (daysWaiting >= MARKETING_WAITING_DUE_SOON_DAYS) return "due_date_reminder";
  return null;
}

/** Whole days the current step has been waiting, so the message states it rather than implying it. */
export function marketingDaysWaiting(waitingSince: string | null, now: string): number | null {
  if (!waitingSince) return null;
  const since = Date.parse(waitingSince);
  const parsedNow = Date.parse(now);
  if (!Number.isFinite(since) || !Number.isFinite(parsedNow)) return null;
  return Math.max(0, Math.floor((parsedNow - since) / 86_400_000));
}

/** Severity order, so the two independent signals reduce to the single worst one. */
const MARKETING_SLA_SEVERITY: Record<MarketingSlaEvent, number> = {
  due_date_reminder: 1,
  escalation: 3,
  overdue_reminder: 2,
};

export function mostUrgentMarketingSla(...events: Array<MarketingSlaEvent | null>): MarketingSlaEvent | null {
  let worst: MarketingSlaEvent | null = null;
  for (const event of events) {
    if (!event) continue;
    if (!worst || MARKETING_SLA_SEVERITY[event] > MARKETING_SLA_SEVERITY[worst]) worst = event;
  }
  return worst;
}

function marketingTodayCairo(): string {
  // YYYY-MM-DD in Africa/Cairo (the platform-wide convention).
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

const MARKETING_SLA_EVENT_COPY: Record<MarketingSlaEvent, { priority: "critical" | "high"; title: string; verb: string }> = {
  due_date_reminder: { priority: "high", title: "Marketing request due soon", verb: "is approaching its pay date" },
  escalation: { priority: "critical", title: "Marketing request escalation", verb: "is significantly overdue and requires immediate action" },
  overdue_reminder: { priority: "high", title: "Marketing request overdue", verb: "is past its pay date and still needs a decision" },
};

/**
 * Daily SLA scan for marketing requests. For each still-pending request with a pay date,
 * fire the due/overdue/escalation notification (routed by policy to the assigned approver
 * + request owner, or the workflow approver for escalation). Idempotent per day via a
 * date-stamped notification key. Best-effort; never throws.
 */
export async function runMarketingSlaDaily(): Promise<{
  dataIntegrityIssues: number;
  errors: Array<{ message: string; requestId: string }>;
  escalations: number;
  overdue: number;
  reminders: number;
  runDate: string;
  scanned: number;
}> {
  const today = marketingTodayCairo();
  const errors: Array<{ message: string; requestId: string }> = [];
  let reminders = 0;
  let overdue = 0;
  let escalations = 0;
  let scanned = 0;
  let dataIntegrityIssues = 0;
  const dataIntegrityRequestCodes: string[] = [];
  // True master-off: recipients here are always the specific request's assigned approver and
  // requester, resolved per-request further below — not a role broadcast list — so this admin
  // "enabled" switch (see "marketing_sla_reminder" in role-recipients.ts) is the only real toggle
  // for this reminder, checked before any request is even scanned.
  if (!(await resolveNotificationRoleEnabled("marketing_sla_reminder"))) {
    return { dataIntegrityIssues, errors, escalations, overdue, reminders, runDate: today, scanned };
  }
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("marketing_requests")
      .select("*")
      // No longer requires a pay date. A request without one cannot trigger the pay-date rule,
      // but it can still sit unapproved for weeks — which is exactly what the waiting-time rule
      // below exists to catch. Excluding these rows made the stalest requests the least visible.
      .in("status", MARKETING_SLA_PENDING_STATUSES as unknown as string[]);
    if (error) throw error;
    const rows = (data ?? []) as MarketingRequestDbRow[];
    scanned = rows.length;
    const nowIso = new Date().toISOString();
    for (const row of rows) {
      const request = mapRequest(row);
      try {
        // Current approver — feeds assigned_approver / workflow_step_approver routing.
        // `updated_at` is stamped when a step is made `current`, so it doubles as "waiting since".
        const { data: stepData } = await supabase
          .from("marketing_request_approval_steps")
          .select("assigned_hr_id, updated_at, created_at")
          .eq("request_id", request.id)
          .eq("status", "current")
          .maybeSingle();
        const hasCurrentStep = Boolean(stepData);
        const step = stepData as { assigned_hr_id?: string | null; created_at?: string | null; updated_at?: string | null } | null;
        const approverHrId = step?.assigned_hr_id ?? null;

        // Two independent clocks, reduced to the single worst signal so one request never
        // produces two competing notifications on the same day.
        const waitingSince = step?.updated_at ?? step?.created_at ?? null;
        const payDateEvent = classifyMarketingSla({ payDate: request.payDate, today });
        const waitingEvent = classifyMarketingWaitingSla({ now: nowIso, waitingSince });
        const eventType = mostUrgentMarketingSla(payDateEvent, waitingEvent);
        if (!eventType) continue;

        // Data-integrity guard: a `pending_approval` request always gets exactly one `current`
        // gating step the moment it enters this status (createMarketingApprovalSteps stamps it
        // atomically on submission), and decideMarketingRequestWorkflow hard-requires one before
        // ANY approve/reject/return can happen. So a `pending_approval` row with no `current`
        // step is not a normal in-flight state — it is undecidable by any approver in any role,
        // and firing an "act now" reminder/escalation at the requester (the only recipient left
        // once approverHrId is null) is actively misleading. Scoped to `pending_approval` ONLY:
        // `pending_validation` and `returned` rows legitimately have zero `current` steps by
        // design (steps don't exist until a request enters `pending_approval` — see
        // createMarketingApprovalSteps — and the decision RPC's "return" branch resets the step
        // to `returned` with no replacement `current` step until resubmission), so a missing
        // current step there is expected, not a defect — their reminders continue firing
        // unchanged below.
        if (request.status === "pending_approval" && !hasCurrentStep) {
          dataIntegrityIssues += 1;
          dataIntegrityRequestCodes.push(request.requestCode);
          continue;
        }

        const copy = MARKETING_SLA_EVENT_COPY[eventType];
        // The message must name the reason that actually fired. Saying "is approaching its pay
        // date" about a request whose pay date is three months out — reached purely because an
        // approver has held it for two weeks — would be untrue and would teach people to ignore
        // the alert. Pay date wins the wording when it is the more urgent of the two, because
        // that is the harder deadline.
        const daysWaiting = marketingDaysWaiting(waitingSince, nowIso);
        const drivenByPayDate =
          payDateEvent !== null && mostUrgentMarketingSla(payDateEvent, waitingEvent) === payDateEvent;
        const message = drivenByPayDate
          ? `Marketing request ${request.requestCode} ${copy.verb} (pay date ${request.payDate}).`
          : `Marketing request ${request.requestCode} has been waiting ${daysWaiting} day(s) for a decision${
              request.payDate ? ` (pay date ${request.payDate})` : ""
            }.`;
        await notifyMarketingWorkflow({
          actorHrId: "system",
          eventType,
          message,
          metadata: {
            assignedApproverHrId: approverHrId,
            // Date-stamps the idempotency key so each reminder fires at most once per day
            // (notifyMarketingWorkflow keys off metadata.decisionAt).
            decisionAt: `sla:${today}`,
            dueDate: request.payDate,
            escalationOwnerHrId: approverHrId,
            workflowApproverHrId: approverHrId,
          },
          priority: copy.priority,
          request,
          title: `${copy.title} — ${request.requestCode}`,
        });
        if (eventType === "escalation") escalations += 1;
        else if (eventType === "overdue_reminder") overdue += 1;
        else reminders += 1;
      } catch (rowError) {
        errors.push({ message: rowError instanceof Error ? rowError.message : "Marketing SLA notify failed.", requestId: request.id });
      }
    }
    if (dataIntegrityRequestCodes.length > 0) {
      // One aggregate line per run (not one per row) — the cron runs once daily, so this alone
      // satisfies "surface it at most once a day" with no separate dedup key needed.
      logWarning("Marketing SLA scan found pending_approval requests with no current approval step", {
        context: { requestCodes: dataIntegrityRequestCodes },
        labels: {
          count: dataIntegrityRequestCodes.length,
          event: "marketing_pending_approval_missing_current_step",
        },
      });
    }
  } catch (error) {
    logError("Marketing SLA daily scan failed", {
      labels: { event: "marketing_sla_scan_failed" },
      error,
    });
    errors.push({ message: error instanceof Error ? error.message : "Marketing SLA scan failed.", requestId: "scan" });
  }
  return { dataIntegrityIssues, errors, escalations, overdue, reminders, runDate: today, scanned };
}

export function parseMarketingRequestDecision(value: unknown): MarketingRequestDecision | null {
  const normalized = (cleanText(value) ?? "").toLowerCase();
  return normalized === "approve" || normalized === "reject" || normalized === "return"
    ? normalized
    : null;
}

function requireMarketingDecisionActor(access: AccessContext) {
  const actorHrId = resolveEmployeeIdentityId(access);
  if (!actorHrId) {
    throw forbiddenError("Forbidden: a linked Phoenix HR identity is required to decide this marketing request.");
  }
  return actorHrId;
}

async function loadMarketingRequestById(supabase: SupabaseClient, requestId: string) {
  const { data, error } = await supabase
    .from("marketing_requests")
    .select("*")
    .eq("id", requestId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFoundError("Marketing request was not found.", "marketing_request_not_found");
  return mapRequest(data as MarketingRequestDbRow);
}

async function loadMarketingRequestApprovalSteps(supabase: SupabaseClient, requestId: string) {
  const { data, error } = await supabase
    .from("marketing_request_approval_steps")
    .select("*")
    .eq("request_id", requestId)
    .order("sequence", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as MarketingRequestApprovalStepDbRow[]).map(mapApprovalStep);
}

async function loadMarketingRequestTypeName(supabase: SupabaseClient, requestTypeId: number) {
  const { data, error } = await supabase
    .from("marketing_request_types")
    .select("name")
    .eq("id", requestTypeId)
    .maybeSingle();
  if (error) throw error;
  return cleanText((data as { name?: string | null } | null)?.name) ?? "Marketing request";
}

function employeeNameByHrId(employeeRows: EmployeeDirectoryRow[], hrId: string | null | undefined) {
  const normalized = normalizeHrId(hrId);
  if (!normalized) return "";
  return employeeRowByHrId(employeeRows).get(normalized)?.displayName ?? normalized;
}

/** Display-only role classification (job title → PhoenixRole) — never for permissions. */
function employeeRoleByHrId(employeeRows: EmployeeDirectoryRow[], hrId: string | null | undefined): PhoenixRole {
  const normalized = normalizeHrId(hrId);
  if (!normalized) return "Employee";
  return resolveJobFunctionRole(employeeRowByHrId(employeeRows).get(normalized)?.jobTitle);
}

/**
 * Compact "where is this request now" summary from its approval steps.
 * CC rows are excluded from the gating count so the progress strip reflects
 * the real decision chain (DM → NSM → SFE → Marketing → CEO → Finance).
 */
function buildMarketingStepProgress(
  steps: MarketingRequestApprovalStep[],
  employeeRows: EmployeeDirectoryRow[],
): MarketingRequestStepProgress | null {
  const gating = steps.filter((step) => !step.isCc).sort((left, right) => left.sequence - right.sequence);
  if (gating.length === 0) return null;
  const current = gating.find((step) => step.status === "current") ?? null;
  const returnedStep = gating.find((step) => step.status === "returned") ?? null;
  const anchor = current ?? returnedStep ?? gating[gating.length - 1];
  return {
    approvedGatingCount: gating.filter((step) => step.status === "approved").length,
    currentApproverHrId: anchor.assignedHrId ?? null,
    currentApproverName: employeeNameByHrId(employeeRows, anchor.assignedHrId),
    currentStepName: anchor.stepName,
    returnReason: returnedStep?.decisionNote ?? null,
    sequence: anchor.sequence,
    totalGatingSteps: gating.length,
  };
}

/** Ordered, display-ready timeline of every approval step (gating + CC). */
function buildMarketingTimeline(
  steps: MarketingRequestApprovalStep[],
  employeeRows: EmployeeDirectoryRow[],
): MarketingRequestTimelineStep[] {
  return steps
    .slice()
    .sort((left, right) => left.sequence - right.sequence)
    .map((step) => ({
      assignedHrId: step.assignedHrId,
      assignedName: employeeNameByHrId(employeeRows, step.assignedHrId),
      assignedRole: step.assignedRole,
      decisionAt: step.decisionAt,
      decisionByHrId: step.decisionByHrId,
      decisionByName: employeeNameByHrId(employeeRows, step.decisionByHrId),
      decisionNote: step.decisionNote,
      isCc: step.isCc,
      sequence: step.sequence,
      status: step.status,
      stepName: step.stepName,
    }));
}

function marketingNotificationVariables(params: {
  currentStep?: MarketingRequestApprovalStep | null;
  employeeRows: EmployeeDirectoryRow[];
  request: MarketingRequest;
  requestTypeName: string;
}) {
  const requesterHrId = normalizeHrId(params.request.requesterHrId);
  const requester = requesterHrId ? employeeRowByHrId(params.employeeRows).get(requesterHrId) : undefined;
  const managerName = employeeNameByHrId(params.employeeRows, params.request.managerHrId);
  return {
    actionUrl: marketingActionUrl(params.request.id),
    approvalStep: params.currentStep?.stepName ?? "",
    approveUrl: marketingActionUrl(params.request.id, "approve"),
    approverName: employeeNameByHrId(params.employeeRows, params.currentStep?.assignedHrId),
    area: requester?.areaName ?? String(params.request.areaId ?? ""),
    department: requester?.departmentName ?? "",
    dueDate: params.request.payDate,
    employeeHrId: params.request.requesterHrId,
    employeeName: requester?.displayName ?? params.request.requesterHrId,
    employeePortalUrl: "/employee-portals/marketing-requests",
    eventDate: new Date().toISOString().slice(0, 10),
    line: requester?.lineName ?? String(params.request.lineId ?? ""),
    managerName,
    moduleName: "Marketing Requests",
    priority: "High",
    reason: params.request.notes ?? "",
    recipientHrId: params.currentStep?.assignedHrId ?? "",
    recipientName: employeeNameByHrId(params.employeeRows, params.currentStep?.assignedHrId),
    requesterHrId: params.request.requesterHrId,
    requesterName: requester?.displayName ?? params.request.requesterHrId,
    rejectUrl: marketingActionUrl(params.request.id, "reject"),
    requestCode: params.request.requestCode,
    requestId: params.request.requestCode,
    requestUrl: marketingActionUrl(params.request.id),
    requestType: params.requestTypeName,
    returnUrl: marketingActionUrl(params.request.id, "return"),
    role: params.currentStep?.assignedRole ?? "",
    status: params.request.status.replace(/_/g, " "),
    submittedAt: params.request.submittedAt ?? params.request.createdAt,
    team: requester?.teamName ?? "",
    updatedAt: params.request.updatedAt,
    workflowName: "Marketing request approval",
  };
}

function assertMarketingStepAssignedToActor(step: MarketingRequestApprovalStep, actorHrId: string) {
  const assignedHrId = normalizeHrId(step.assignedHrId);
  if (!assignedHrId || assignedHrId !== normalizeHrId(actorHrId)) {
    throw forbiddenError("Forbidden: this marketing request is not assigned to your Phoenix identity.");
  }
}

function marketingEgp(value: unknown): string {
  return `EGP ${Math.round(toNumber(value)).toLocaleString("en-US")}`;
}

function escapeMarketingHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Editable-template token values for a marketing email. The premium layout lives in the
 * /admin/email-templates `marketing_request` body using these tokens; this only supplies the
 * VALUES. `productsTable` and `returnCallout` are pre-rendered HTML blocks (the only parts that
 * can't be hand-typed) — table-based with whitelisted inline styles only, since the email
 * sanitizer drops `div`, `border-radius`, `box-shadow` and `margin` (src/lib/email/email-safety.ts).
 */
export function buildMarketingEmailContext(params: {
  currentStepName?: string | null;
  customerName?: string | null;
  noteHeading?: string | null;
  products: MarketingRequestProduct[];
  request: MarketingRequest;
  returnNote?: string | null;
  returnedByName?: string | null;
}): Partial<EmailTemplateContext> {
  const { request } = params;
  const headCell = "background-color:#0f172a;color:#ffffff;border:1px solid #0f172a;padding:8px 10px;font-size:12px;text-align:left";
  const headCellR = `${headCell};text-align:right`;
  const cell = "border:1px solid #fce7cf;padding:8px 10px;font-size:13px;text-align:left;color:#0f172a";
  const cellR = `${cell};text-align:right`;

  let productsTable = "";
  let productsTableText = "";
  if (params.products.length > 0) {
    const rows = params.products
      .map(
        (product) =>
          `<tr><td style="${cell}">${escapeMarketingHtml(product.productNameSnapshot)}</td>` +
          `<td style="${cellR}">${Math.round(product.forecastQuantity).toLocaleString("en-US")}</td>` +
          `<td style="${cellR}">${marketingEgp(product.expectedValue)}</td></tr>`,
      )
      .join("");
    productsTable =
      `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%">` +
      `<thead><tr><th style="${headCell}">Product</th><th style="${headCellR}">Qty</th><th style="${headCellR}">Value</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>`;
    productsTableText = params.products
      .map((product) => `- ${product.productNameSnapshot} | ${Math.round(product.forecastQuantity)} | ${marketingEgp(product.expectedValue)}`)
      .join("\n");
  }

  let returnCallout = "";
  let returnCalloutText = "";
  const returnNote = cleanText(params.returnNote);
  if (returnNote) {
    const heading = cleanText(params.noteHeading) ?? "Returned";
    const by = cleanText(params.returnedByName);
    returnCallout =
      `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%">` +
      `<tr><td style="background-color:#fff7ed;border:1px solid #fed7aa;padding:12px 14px">` +
      `<span style="color:#9a3412;font-size:12px;font-weight:600">${escapeMarketingHtml(heading)}${by ? ` by ${escapeMarketingHtml(by)}` : ""} · reason</span><br />` +
      `<span style="color:#7c2d12;font-size:14px;line-height:1.5">${escapeMarketingHtml(returnNote)}</span>` +
      `</td></tr></table>`;
    returnCalloutText = `${heading}${by ? ` by ${by}` : ""} — reason: ${returnNote}\n\n`;
  }

  return {
    currentStep: cleanText(params.currentStepName) ?? "—",
    customerName: cleanText(params.customerName) ?? "—",
    estimatedCost: marketingEgp(request.estimatedCost),
    payDate: request.payDate ?? "—",
    productsTable,
    productsTableText,
    requestCode: request.requestCode,
    requiredRoi: marketingEgp(request.requiredRoiValue),
    returnCallout,
    returnCalloutText,
    roiWindow: buildRoiWindowLabel(request.payDate, request.roiDurationMonths) ?? "—",
  };
}

async function auditMarketingDecision(input: {
  actorHrId: string;
  decision: MarketingRequestDecision;
  request: MarketingRequest;
  step: MarketingRequestApprovalStep;
  summary: string;
}) {
  await writeAuditLog({
    actorLoginId: input.actorHrId,
    entityId: input.request.id,
    entityType: "marketing_request",
    newValues: {
      decision: input.decision,
      requestCode: input.request.requestCode,
      source: "marketing_request_phoenix_decision",
      stepCode: input.step.stepCode,
      stepId: input.step.id,
    },
    summary: input.summary,
  });
}

export async function getMarketingRequestDecisionSummary(
  requestId: string,
  decision: MarketingRequestDecision,
  access: AccessContext,
): Promise<MarketingRequestDecisionSummary> {
  const cleanRequestId = cleanText(requestId);
  if (!cleanRequestId) throw validationError("Marketing request ID is required.");
  const actorHrId = requireMarketingDecisionActor(access);
  const supabase = getSupabaseAdmin();
  const [request, steps, employeeRows] = await Promise.all([
    loadMarketingRequestById(supabase, cleanRequestId),
    loadMarketingRequestApprovalSteps(supabase, cleanRequestId),
    loadEmployeeDirectoryRows(),
  ]);
  const currentStep = steps.find((step) => step.status === "current") ?? null;
  if (!currentStep) throw conflictError("This marketing request has no current approval step.");
  assertMarketingStepAssignedToActor(currentStep, actorHrId);
  if (request.status !== "pending_approval") {
    throw conflictError("This marketing request is no longer pending approval.");
  }

  // Rich request context so the approver can decide in place (products, financials, the chain).
  const [productsResult, pharmaciesResult, customerResult, contactResult, requestTypeName] = await Promise.all([
    supabase.from("marketing_request_products").select("*").eq("request_id", cleanRequestId),
    supabase
      .from("marketing_request_pharmacies")
      .select("id, pharmacy_id, distributor_code_id, notes")
      .eq("request_id", cleanRequestId),
    request.customerId
      ? supabase
        .from("marketing_customers")
        // `speciality` does NOT exist on marketing_customers — naming it here threw
        // "column does not exist" and took the whole approval window down to its safe state.
        // The real column for the free-text qualifier is `other_type_description`.
        .select("display_name, customer_code, customer_type, other_type_description, captured_address, extracted_area_name, extracted_governorate_name, evidence_photo_name")
        .eq("id", request.customerId)
        .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    request.customerContactId
      ? supabase
        .from("marketing_customer_contacts")
        .select("contact_name, mobile_number")
        .eq("id", request.customerContactId)
        .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    loadMarketingRequestTypeName(supabase, request.requestTypeId),
  ]);
  if (productsResult.error) throw productsResult.error;
  if (pharmaciesResult.error) throw pharmaciesResult.error;

  const products: MarketingDecisionProductLine[] = ((productsResult.data ?? []) as MarketingRequestProductDbRow[])
    .map(mapProduct)
    .map((product) => ({
      name: product.productNameSnapshot,
      quantity: product.forecastQuantity,
      value: product.expectedValue,
    }));
  type RequestPharmacyRow = {
    distributor_code_id: string | null;
    id: string;
    notes: string | null;
    pharmacy_id: string | null;
  };
  const requestPharmacyRows = (pharmaciesResult.data ?? []) as RequestPharmacyRow[];
  const pharmacyCount = requestPharmacyRows.length;

  // Resolve each target pharmacy to display names + codes. An approver reading "3 pharmacies"
  // cannot tell an intended campaign from a mis-picked one — they need the actual names, the
  // distributor, and whether each vendor code was ever matched.
  const targetPharmacies = await loadMarketingDecisionPharmacies(supabase, requestPharmacyRows);

  const customerRow = customerResult.data as {
    captured_address?: string | null;
    customer_code?: string | null;
    customer_type?: string | null;
    display_name?: string | null;
    evidence_photo_name?: string | null;
    extracted_area_name?: string | null;
    extracted_governorate_name?: string | null;
    other_type_description?: string | null;
  } | null;
  const contactRow = contactResult.data as { contact_name?: string | null; mobile_number?: string | null } | null;
  const customerName = cleanText(customerRow?.display_name);

  // The retained shop-front photo, signed for this sitting. Same never-break-the-screen rule as
  // the overlap check below: an unreachable image degrades to "no photo retained", which is the
  // honest reading anyway, rather than taking the approval window down.
  const evidencePhoto = await loadMarketingEvidencePhoto({
    entityId: request.customerId,
    entityType: "customer",
    supabase,
  }).catch(() => null);

  // Double-count check. Never allowed to break the approval screen: an approver must always be
  // able to decide, so a failure here degrades to "no overlaps known" rather than a dead page.
  const contestedBy = await loadMarketingRequestOverlaps(supabase, request).catch(() => [] as MarketingDecisionOverlap[]);
  const requester = employeeRowByHrId(employeeRows).get(normalizeHrId(request.requesterHrId) ?? "");
  const chain: MarketingDecisionChainStep[] = steps
    .filter((step) => !step.isCc)
    .sort((left, right) => left.sequence - right.sequence)
    .map((step) => ({
      approverName: employeeNameByHrId(employeeRows, step.assignedHrId),
      isCurrent: step.status === "current",
      status: step.status,
      stepName: step.stepName,
    }));

  return {
    allowReject: currentStep.allowReject,
    assignedApproverHrId: currentStep.assignedHrId ?? "",
    currentStepName: currentStep.stepName,
    decisionLabels: currentStep.decisionLabels ?? normalizeMarketingDecisionLabels(null),
    stepKind: currentStep.stepKind,
    decision,
    payDate: request.payDate ?? "Not set",
    requestCode: request.requestCode,
    requestId: request.id,
    requesterHrId: request.requesterHrId,
    requesterName: employeeNameByHrId(employeeRows, request.requesterHrId),
    requestType: requestTypeName,
    status: request.status,
    chain,
    customerName: customerName ?? null,
    estimatedCost: request.estimatedCost,
    expectedRoiValue: request.expectedRoiValue,
    lineName: requester?.lineName ?? null,
    pharmacyCount,
    products,
    requiredRoiValue: request.requiredRoiValue,
    roiDurationMonths: request.roiDurationMonths,
    roiWindow: buildRoiWindowLabel(request.payDate, request.roiDurationMonths),
    contestedBy,
    areaName: requester?.areaName ?? null,
    customerAddress: cleanText(customerRow?.captured_address),
    customerArea: cleanText(customerRow?.extracted_area_name),
    customerCode: cleanText(customerRow?.customer_code),
    customerContactMobile: cleanText(contactRow?.mobile_number),
    customerContactName: cleanText(contactRow?.contact_name),
    customerGovernorate: cleanText(customerRow?.extracted_governorate_name),
    customerSpeciality: cleanText(customerRow?.other_type_description),
    customerType: cleanText(customerRow?.customer_type),
    evidencePhotoName: cleanText(customerRow?.evidence_photo_name),
    evidencePhotoUrl: evidencePhoto?.signedUrl ?? null,
    notes: cleanText(request.notes),
    requestDate: request.requestDate ?? null,
    roiCoverageRatio: request.roiCoverageRatio ?? null,
    roiStatus: request.roiStatus ?? null,
    targetPharmacies,
    // Not carried on the mapped domain object; read defensively rather than widen MarketingRequest
    // for one read-only field on one screen.
    trackDirectSales: (request as { trackDirectSales?: boolean }).trackDirectSales === true,
  };
}

/**
 * Resolve request→pharmacy links into display rows.
 *
 * Best-effort by design: a decision screen must never fail to open because a reference lookup
 * missed. A link that cannot be resolved still returns a row carrying whatever is known, so the
 * approver sees "N pharmacies, one unresolved" rather than silently seeing N-1.
 */
async function loadMarketingDecisionPharmacies(
  supabase: SupabaseClient,
  rows: Array<{ distributor_code_id: string | null; notes: string | null; pharmacy_id: string | null }>,
): Promise<MarketingDecisionPharmacy[]> {
  if (rows.length === 0) return [];

  const pharmacyIds = [...new Set(rows.map((row) => row.pharmacy_id).filter((id): id is string => Boolean(id)))];
  const codeIds = [...new Set(rows.map((row) => row.distributor_code_id).filter((id): id is string => Boolean(id)))];

  const [pharmacyRows, codeRows] = await Promise.all([
    fetchRowsByIds<{ display_name: string | null; id: string; pharmacy_code: string | null }>(
      supabase,
      "marketing_pharmacies",
      pharmacyIds,
    ).catch(() => []),
    fetchRowsByIds<{
      distributor_id: number | string | null;
      distributor_pharmacy_code: string | null;
      id: string;
      reference_status: string | null;
    }>(supabase, "marketing_pharmacy_distributor_codes", codeIds).catch(() => []),
  ]);

  const distributorIds = [...new Set(codeRows.map((row) => row.distributor_id).filter((id) => id !== null && id !== undefined))];
  const distributorRows = distributorIds.length > 0
    ? await fetchRowsByIds<{ display_name: string | null; id: number | string }>(
      supabase,
      "marketing_distributors",
      distributorIds as Array<string | number>,
    ).catch(() => [])
    : [];

  const pharmacyById = new Map(pharmacyRows.map((row) => [String(row.id), row]));
  const codeById = new Map(codeRows.map((row) => [String(row.id), row]));
  const distributorById = new Map(distributorRows.map((row) => [String(row.id), row]));

  // One index read + one batch signing call for every target pharmacy, rather than a pair per row.
  // Same never-break-the-screen rule as everything else here: a failure yields an empty map, and
  // each pharmacy then renders as having no retained image.
  const evidenceByPharmacyId = await loadMarketingEvidencePhotosByEntityIds({
    entityIds: pharmacyIds,
    entityType: "pharmacy",
    supabase,
  }).catch(() => new Map<string, { capturedAt: string | null; signedUrl: string }>());

  return rows.map((row) => {
    const pharmacy = row.pharmacy_id ? pharmacyById.get(String(row.pharmacy_id)) : undefined;
    const code = row.distributor_code_id ? codeById.get(String(row.distributor_code_id)) : undefined;
    const distributor = code?.distributor_id !== null && code?.distributor_id !== undefined
      ? distributorById.get(String(code.distributor_id))
      : undefined;

    return {
      distributorName: cleanText(distributor?.display_name) ?? "Unknown distributor",
      distributorPharmacyCode: cleanText(code?.distributor_pharmacy_code) ?? "-",
      evidencePhotoUrl: row.pharmacy_id
        ? evidenceByPharmacyId.get(String(row.pharmacy_id))?.signedUrl ?? null
        : null,
      notes: cleanText(row.notes),
      pharmacyCode: cleanText(pharmacy?.pharmacy_code) ?? "-",
      pharmacyName: cleanText(pharmacy?.display_name) ?? "Unresolved pharmacy",
      referenceStatus: cleanText(code?.reference_status) ?? "pending",
    };
  });
}

/**
 * Load the pharmacy/product/window footprint of every other live request and return those that
 * would be credited the same invoice lines as `request`.
 *
 * Bounded deliberately: only requests whose window can possibly touch this one's are considered,
 * and inert statuses are dropped by findRequestOverlaps. Attribution matches on exact distributor
 * + pharmacy code + product + period with nothing exclusive about it, so without this check two
 * campaigns can each report the same sale as their own return.
 */
async function loadMarketingRequestOverlaps(
  supabase: SupabaseClient,
  request: MarketingRequest,
): Promise<MarketingDecisionOverlap[]> {
  const subjectMonths = windowMonths(request.payDate, request.roiDurationMonths);
  if (subjectMonths.length === 0) return [];

  const [ownPharmacies, ownProducts] = await Promise.all([
    supabase.from("marketing_request_pharmacies").select("pharmacy_id").eq("request_id", request.id),
    supabase.from("marketing_request_products").select("product_id").eq("request_id", request.id),
  ]);
  if (ownPharmacies.error) throw ownPharmacies.error;
  if (ownProducts.error) throw ownProducts.error;

  const pharmacyIds = Array.from(
    new Set(((ownPharmacies.data ?? []) as Array<{ pharmacy_id: string }>).map((row) => String(row.pharmacy_id ?? "").trim()).filter(Boolean)),
  );
  const productIds = Array.from(
    new Set(((ownProducts.data ?? []) as Array<{ product_id: number | string }>).map((row) => Number(row.product_id))),
  ).filter((id) => Number.isFinite(id));
  if (pharmacyIds.length === 0 || productIds.length === 0) return [];

  // Only requests sharing at least one pharmacy can contest — that narrows the candidate set to a
  // handful before any window maths.
  const sharedPharmacyLinks = await supabase
    .from("marketing_request_pharmacies")
    .select("request_id, pharmacy_id")
    .in("pharmacy_id", pharmacyIds);
  if (sharedPharmacyLinks.error) throw sharedPharmacyLinks.error;

  const pharmaciesByRequest = new Map<string, string[]>();
  for (const row of (sharedPharmacyLinks.data ?? []) as Array<{ request_id: string; pharmacy_id: string }>) {
    if (row.request_id === request.id) continue;
    const list = pharmaciesByRequest.get(row.request_id) ?? [];
    list.push(row.pharmacy_id);
    pharmaciesByRequest.set(row.request_id, list);
  }
  const candidateIds = Array.from(pharmaciesByRequest.keys());
  if (candidateIds.length === 0) return [];

  const [candidateRows, candidateProducts] = await Promise.all([
    supabase.from("marketing_requests").select("id, request_code, status, pay_date, roi_duration_months").in("id", candidateIds),
    supabase.from("marketing_request_products").select("request_id, product_id").in("request_id", candidateIds),
  ]);
  if (candidateRows.error) throw candidateRows.error;
  if (candidateProducts.error) throw candidateProducts.error;

  const productsByRequest = new Map<string, number[]>();
  for (const row of (candidateProducts.data ?? []) as Array<{ request_id: string; product_id: number | string }>) {
    const list = productsByRequest.get(row.request_id) ?? [];
    list.push(Number(row.product_id));
    productsByRequest.set(row.request_id, list);
  }

  const others: OverlapCandidate[] = ((candidateRows.data ?? []) as Array<{
    id: string; request_code: string; status: string; pay_date: string | null; roi_duration_months: number | string;
  }>).map((row) => ({
    payDate: row.pay_date,
    pharmacyIds: pharmaciesByRequest.get(row.id) ?? [],
    productIds: productsByRequest.get(row.id) ?? [],
    requestCode: row.request_code,
    requestId: row.id,
    roiDurationMonths: Number(row.roi_duration_months) || 1,
    status: row.status,
  }));

  return findRequestOverlaps(
    {
      payDate: request.payDate,
      pharmacyIds,
      productIds,
      requestCode: request.requestCode,
      requestId: request.id,
      roiDurationMonths: request.roiDurationMonths,
      status: request.status,
    },
    others,
  ).map((overlap) => ({
    description: describeOverlap(overlap),
    requestCode: overlap.requestCode,
    status: overlap.status,
  }));
}

export async function decideMarketingRequestWorkflow(
  access: AccessContext,
  input: {
    comment?: string | null;
    decision: MarketingRequestDecision;
    requestId: string;
  },
) {
  const requestId = cleanText(input.requestId);
  if (!requestId) throw validationError("Marketing request ID is required.");
  const decision = parseMarketingRequestDecision(input.decision);
  if (!decision) throw validationError("Marketing request decision is invalid.", "invalid_marketing_decision");
  const comment = cleanText(input.comment);
  if ((decision === "reject" || decision === "return") && !comment) {
    throw validationError(`${decision === "reject" ? "Rejection" : "Return"} reason is required.`);
  }

  const actorHrId = requireMarketingDecisionActor(access);
  const supabase = getSupabaseAdmin();
  const employeeRows = await loadEmployeeDirectoryRows();
  // Every employees(hr_id) FK column written below (decision_by_hr_id, updated_by_hr_id) is
  // case-sensitive — store the decider's real employee casing, resolved once for the whole flow.
  const storedActorHrId = resolveStoredEmployeeHrId(actorHrId, employeeRowByHrId(employeeRows)) ?? actorHrId;
  let request = await loadMarketingRequestById(supabase, requestId);
  const steps = await loadMarketingRequestApprovalSteps(supabase, requestId);
  const currentStep = steps.find((step) => step.status === "current") ?? null;
  if (!currentStep) throw conflictError("This marketing request has no current approval step.");
  assertMarketingStepAssignedToActor(currentStep, actorHrId);
  if (request.status !== "pending_approval") {
    throw conflictError("This marketing request is no longer pending approval.");
  }
  if (decision === "reject" && currentStep.allowReject === false) {
    throw validationError("This step cannot reject the request; return it with a note instead.", "marketing_reject_not_allowed");
  }
  if (decision === "return" && currentStep.allowReturn === false) {
    throw validationError("This step cannot return the request for edit.", "marketing_return_not_allowed");
  }

  const decidedAt = new Date().toISOString();

  // All table writes happen atomically inside one Postgres transaction via RPC,
  // eliminating the corrupt half-state risk of the previous sequential-write pattern.
  const { data: rpcResult, error: rpcErr } = await supabase.rpc("phx_decide_marketing_request_step", {
    p_decided_at: decidedAt,
    p_decided_by: storedActorHrId,
    p_decision: decision,
    p_decision_note: comment || null,
    p_request_id: requestId,
    p_step_id: currentStep.id,
  });
  if (rpcErr) {
    if (rpcErr.message?.includes("marketing_step_already_decided")) {
      throw conflictError("This marketing approval step was already decided. Refresh Phoenix and try again.");
    }
    throw rpcErr;
  }
  const rpcData = rpcResult as {
    branch: "reject" | "return" | "approve_next" | "approve_final";
    isExecution: boolean;
    nextStep: MarketingRequestApprovalStepDbRow | null;
    request: MarketingRequestDbRow;
    step: MarketingRequestApprovalStepDbRow;
  };
  const decidedStep = mapApprovalStep(rpcData.step);
  request = mapRequest(rpcData.request);

  // Load the request type name for notification messages (separate read, non-mutating).
  const requestTypeName = await loadMarketingRequestTypeName(supabase, request.requestTypeId);

  if (decision === "reject" || decision === "return") {
    await auditMarketingDecision({
      actorHrId,
      decision,
      request,
      step: decidedStep,
      summary: `Marketing request ${request.requestCode} ${decision === "reject" ? "rejected" : "returned"} at ${decidedStep.stepName}.`,
    });
    await notifyMarketingWorkflow({
      actorHrId,
      eventType: decision === "reject" ? "request_rejected" : "request_returned",
      message: `${request.requestCode} was ${decision === "reject" ? "rejected" : "returned"} at ${decidedStep.stepName}.`,
      metadata: {
        decision,
        decisionAt: decidedAt,
        decisionByHrId: actorHrId,
        returnNote: comment,
        returnedByName: employeeNameByHrId(employeeRows, actorHrId),
        ...marketingNotificationVariables({ currentStep: decidedStep, employeeRows, request, requestTypeName }),
      },
      priority: "high",
      request,
      title: decision === "reject" ? "Marketing request rejected" : "Marketing request returned",
    });
    return { decision, request, step: decidedStep };
  }

  if (rpcData.branch === "approve_next") {
    const currentNextStep = mapApprovalStep(rpcData.nextStep!);
    const ccHrIds = steps
      .filter((step) => step.isCc && step.stepCode === currentNextStep.stepCode)
      .map((step) => step.assignedHrId)
      .filter((hrId): hrId is string => Boolean(hrId));
    await auditMarketingDecision({
      actorHrId,
      decision,
      request,
      step: decidedStep,
      summary: `Marketing request ${request.requestCode} approved at ${decidedStep.stepName}; moved to ${currentNextStep.stepName}.`,
    });
    await notifyMarketingWorkflow({
      actorHrId,
      ccHrIds,
      eventType: "request_assigned",
      message: `${request.requestCode} is waiting for ${currentNextStep.stepName}.`,
      metadata: {
        assignedApproverHrId: currentNextStep.assignedHrId,
        currentStepId: currentNextStep.id,
        currentStepName: currentNextStep.stepName,
        workflowApproverHrId: currentNextStep.assignedHrId,
        ...marketingNotificationVariables({ currentStep: currentNextStep, employeeRows, request, requestTypeName }),
      },
      priority: "high",
      request,
      title: "Marketing request assigned",
    });
    return { decision, nextStep: currentNextStep, request, step: decidedStep };
  }

  // approve_final
  const isExecution = rpcData.isExecution ?? false;
  await auditMarketingDecision({
    actorHrId,
    decision,
    request,
    step: decidedStep,
    summary: isExecution
      ? `Marketing request ${request.requestCode} executed by finance and is now active.`
      : `Marketing request ${request.requestCode} fully approved.`,
  });
  await notifyMarketingWorkflow({
    actorHrId,
    eventType: "request_approved",
    message: isExecution
      ? `${request.requestCode} has been executed by finance and is now active.`
      : `${request.requestCode} has been fully approved.`,
    metadata: {
      decision,
      decisionAt: decidedAt,
      decisionByHrId: actorHrId,
      executed: isExecution,
      workflowParticipantHrIds: steps.map((step) => step.assignedHrId).filter(Boolean),
      ...marketingNotificationVariables({ currentStep: decidedStep, employeeRows, request, requestTypeName }),
    },
    priority: "high",
    request,
    title: isExecution ? "Marketing request executed" : "Marketing request approved",
  });
  // After the decision has committed, so the ping cannot sit between the approval and the money.
  pingMarketingRequestSheet("request_decided");
  return { decision, request, step: decidedStep };
}

function mapCustomer(row: MarketingCustomerDbRow): MarketingCustomer {
  return {
    active: row.active !== false,
    areaId: row.area_id === null ? null : Number(row.area_id),
    capturedAccuracyMeters: row.captured_accuracy_meters === null || row.captured_accuracy_meters === undefined
      ? null
      : toNumber(row.captured_accuracy_meters),
    capturedAddress: row.captured_address ?? null,
    capturedAt: row.captured_at ?? null,
    capturedLatitude: row.captured_latitude === null || row.captured_latitude === undefined
      ? null
      : toNumber(row.captured_latitude),
    capturedLongitude: row.captured_longitude === null || row.captured_longitude === undefined
      ? null
      : toNumber(row.captured_longitude),
    createdAt: nowIsoFallback(row.created_at),
    createdByHrId: row.created_by_hr_id ?? null,
    customerCode: row.customer_code ?? row.id,
    customerType: row.customer_type ?? "other",
    displayName: row.display_name ?? row.id,
    evidenceHasTimestamp: row.evidence_has_timestamp === true,
    evidencePhotoCapturedAt: row.evidence_photo_captured_at ?? null,
    evidencePhotoName: row.evidence_photo_name ?? null,
    evidenceStatus: row.evidence_status ?? "missing",
    extractedAreaName: row.extracted_area_name ?? null,
    extractedGovernorateName: row.extracted_governorate_name ?? null,
    id: row.id,
    lineId: row.line_id === null ? null : Number(row.line_id),
    managerHrId: row.manager_hr_id,
    normalizedName: row.normalized_name ?? String(row.display_name ?? row.id).trim().toLowerCase(),
    otherTypeDescription: row.other_type_description ?? null,
    ownerHrId: row.owner_hr_id,
    regionName: row.region_name ?? null,
    updatedAt: nowIsoFallback(row.updated_at),
    updatedByHrId: row.updated_by_hr_id ?? null,
    validatedAt: row.validated_at ?? null,
    validatedByHrId: row.validated_by_hr_id ?? null,
    validationNotes: row.validation_notes ?? null,
    validationStatus: row.validation_status ?? "pending",
  };
}

function mapMarketingPharmacy(row: MarketingPharmacyDbRow): MarketingPharmacy {
  return {
    active: row.active !== false,
    areaId: row.area_id === null ? null : Number(row.area_id),
    capturedAccuracyMeters: row.captured_accuracy_meters === null || row.captured_accuracy_meters === undefined
      ? null
      : toNumber(row.captured_accuracy_meters),
    capturedAddress: row.captured_address ?? null,
    capturedAt: row.captured_at ?? null,
    capturedLatitude: row.captured_latitude === null || row.captured_latitude === undefined
      ? null
      : toNumber(row.captured_latitude),
    capturedLongitude: row.captured_longitude === null || row.captured_longitude === undefined
      ? null
      : toNumber(row.captured_longitude),
    createdAt: nowIsoFallback(row.created_at),
    createdByHrId: row.created_by_hr_id ?? null,
    displayName: row.display_name ?? row.id,
    evidenceHasTimestamp: row.evidence_has_timestamp === true,
    evidencePhotoCapturedAt: row.evidence_photo_captured_at ?? null,
    evidencePhotoName: row.evidence_photo_name ?? null,
    evidenceStatus: row.evidence_status ?? "missing",
    extractedAreaName: row.extracted_area_name ?? null,
    extractedGovernorateName: row.extracted_governorate_name ?? null,
    id: row.id,
    lineId: row.line_id === null ? null : Number(row.line_id),
    managerHrId: row.manager_hr_id,
    normalizedName: row.normalized_name ?? String(row.display_name ?? row.id).trim().toLowerCase(),
    ownerHrId: row.owner_hr_id,
    pharmacyCode: row.pharmacy_code ?? row.id,
    regionName: row.region_name ?? null,
    updatedAt: nowIsoFallback(row.updated_at),
    updatedByHrId: row.updated_by_hr_id ?? null,
    validatedAt: row.validated_at ?? null,
    validatedByHrId: row.validated_by_hr_id ?? null,
    validationNotes: row.validation_notes ?? null,
    validationStatus: row.validation_status ?? "pending",
  };
}

function mapDistributorCode(row: MarketingPharmacyDistributorCodeDbRow): MarketingPharmacyDistributorCode {
  return {
    active: row.active !== false,
    createdAt: nowIsoFallback(row.created_at),
    createdByHrId: row.created_by_hr_id ?? null,
    distributorId: Number(row.distributor_id ?? 0),
    distributorPharmacyCode: row.distributor_pharmacy_code ?? "",
    id: row.id,
    normalizedPharmacyCode: row.normalized_pharmacy_code ?? normalizeLookupKey(row.distributor_pharmacy_code),
    pharmacyId: row.pharmacy_id,
    referenceId: row.reference_id === null || row.reference_id === undefined ? null : Number(row.reference_id),
    referenceMatchCount: Number(row.reference_match_count ?? 0),
    referenceStatus: row.reference_status ?? "pending",
    updatedAt: nowIsoFallback(row.updated_at),
    validatedAt: row.validated_at ?? null,
    validatedByHrId: row.validated_by_hr_id ?? null,
    validationNotes: row.validation_notes ?? null,
  };
}

function mapCustomerPharmacy(row: MarketingCustomerPharmacyDbRow): MarketingCustomerPharmacy {
  return {
    active: row.active !== false,
    createdAt: nowIsoFallback(row.created_at),
    createdByHrId: row.created_by_hr_id ?? null,
    customerId: row.customer_id,
    distributorCodeId: row.distributor_code_id,
    id: row.id,
    pharmacyId: row.pharmacy_id,
    updatedAt: nowIsoFallback(row.updated_at),
    updatedByHrId: row.updated_by_hr_id ?? null,
    validationNotes: row.validation_notes ?? null,
    validationStatus: row.validation_status ?? "pending",
  };
}

function mapRequestType(row: MarketingRequestTypeDbRow): MarketingRequestType {
  return {
    active: row.active,
    code: row.code,
    createdAt: nowIsoFallback(row.created_at),
    description: row.description,
    id: Number(row.id),
    name: row.name,
    requiresDescription: row.requires_description,
    sortOrder: Number(row.sort_order),
    updatedAt: nowIsoFallback(row.updated_at),
  };
}

function normalizeMarketingDecisionLabels(raw: Record<string, string> | null | undefined): MarketingDecisionLabels {
  return {
    approve: cleanText(raw?.approve) ?? "Approve",
    reject: cleanText(raw?.reject) ?? "Reject",
    return: cleanText(raw?.return) ?? "Return",
  };
}

function normalizeMarketingStepKind(value: string | null | undefined): MarketingStepKind {
  return value === "managerial_chain" || value === "finance" ? value : "role";
}

function mapWorkflowStep(row: MarketingWorkflowStepDbRow): MarketingWorkflowStep {
  return {
    active: row.active,
    allowReject: row.allow_reject ?? true,
    allowReturn: row.allow_return ?? true,
    approvalScope: row.approval_scope,
    assignedRole: row.assigned_role,
    ccRoles: Array.isArray(row.cc_roles) ? row.cc_roles.filter((value): value is string => Boolean(value)) : [],
    chainTargetRole: cleanText(row.chain_target_role),
    createdAt: nowIsoFallback(row.created_at),
    decisionLabels: normalizeMarketingDecisionLabels(row.decision_labels),
    defaultSlaDays: row.default_sla_days === null || row.default_sla_days === undefined
      ? null
      : Number(row.default_sla_days),
    id: Number(row.id),
    required: row.required,
    sequence: Number(row.sequence),
    stepCode: row.step_code,
    stepKind: normalizeMarketingStepKind(row.step_kind),
    stepName: row.step_name,
    terminalStatus: (cleanText(row.terminal_status) as MarketingRequest["status"] | null) ?? null,
    updatedAt: nowIsoFallback(row.updated_at),
  };
}

function mapControlSetting(row: MarketingControlSettingDbRow): MarketingControlSetting {
  return {
    adminOnly: row.admin_only,
    createdAt: nowIsoFallback(row.created_at),
    group: row.setting_group,
    key: row.setting_key,
    label: row.setting_label,
    updatedAt: nowIsoFallback(row.updated_at),
    updatedByHrId: row.updated_by_hr_id ?? null,
    value: row.setting_value ?? {},
  };
}

function mapDistributor(row: MarketingDistributorDbRow): MarketingDistributor {
  return {
    active: row.active,
    createdAt: nowIsoFallback(row.created_at),
    displayName: row.display_name,
    distributorCode: row.distributor_code,
    id: Number(row.id),
    normalizedName: row.normalized_name,
    sourceName: row.source_name,
    updatedAt: nowIsoFallback(row.updated_at),
  };
}

function mapMarketingProduct(row: MarketingProductDbRow): MarketingProduct {
  return {
    active: row.active !== false,
    createdAt: nowIsoFallback(row.created_at),
    factoryPrice: toNumber(row.factory_price),
    family: row.family ?? null,
    id: Number(row.id),
    line: row.line,
    lineId: row.line_id === null || row.line_id === undefined ? null : Number(row.line_id),
    normalizedName: row.normalized_name ?? row.product_name.trim().toLowerCase(),
    productCode: row.product_code ?? String(row.id),
    productName: row.product_name,
    sourceCompany: row.source_company ?? null,
    sourceFile: row.source_file ?? null,
    updatedAt: nowIsoFallback(row.updated_at),
  };
}

function mapProduct(row: MarketingRequestProductDbRow): MarketingRequestProduct {
  return {
    createdAt: nowIsoFallback(row.created_at),
    expectedValue: toNumber(row.expected_value ?? toNumber(row.factory_price_snapshot) * toNumber(row.forecast_quantity)),
    factoryPriceSnapshot: toNumber(row.factory_price_snapshot),
    forecastQuantity: toNumber(row.forecast_quantity),
    id: row.id,
    lineSnapshot: row.line_snapshot,
    productId: Number(row.product_id),
    productNameSnapshot: row.product_name_snapshot,
    requestId: row.request_id,
    updatedAt: nowIsoFallback(row.updated_at),
    valueShare: toNumber(row.value_share),
  };
}

function mapPharmacy(row: MarketingRequestPharmacyDbRow): MarketingRequestPharmacy {
  return {
    createdAt: nowIsoFallback(row.created_at),
    distributorCodeId: row.distributor_code_id,
    id: row.id,
    notes: row.notes,
    pharmacyId: row.pharmacy_id,
    requestId: row.request_id,
    trackingStatus: row.tracking_status,
    updatedAt: nowIsoFallback(row.updated_at),
  };
}

function mapFinanceRequirement(row: MarketingRequestFinanceRequirementDbRow): MarketingRequestFinanceRequirement {
  return {
    createdAt: nowIsoFallback(row.created_at),
    financeReviewerHrId: row.finance_reviewer_hr_id ?? null,
    invoiceDeadlineDate: row.invoice_deadline_date ?? null,
    invoiceOriginalFileName: row.invoice_original_file_name ?? null,
    invoiceRequired: row.invoice_required === true,
    invoiceStatus: row.invoice_status ?? "not_required",
    invoiceStoragePath: row.invoice_storage_path ?? null,
    invoiceUploadedAt: row.invoice_uploaded_at ?? null,
    invoiceUploadedByHrId: row.invoice_uploaded_by_hr_id ?? null,
    moneyTransferProofOriginalFileName: row.money_transfer_proof_original_file_name ?? null,
    moneyTransferProofStoragePath: row.money_transfer_proof_storage_path ?? null,
    moneyTransferProofUploadedAt: row.money_transfer_proof_uploaded_at ?? null,
    moneyTransferProofUploadedByHrId: row.money_transfer_proof_uploaded_by_hr_id ?? null,
    notes: row.notes ?? null,
    requestId: row.request_id,
    reviewedAt: row.reviewed_at ?? null,
    updatedAt: nowIsoFallback(row.updated_at),
  };
}

export function buildMarketingApprovedRequestRows(params: {
  customers: MarketingCustomer[];
  employeeRows: EmployeeDirectoryRow[];
  financeRequirements: MarketingRequestFinanceRequirement[];
  requests: MarketingRequest[];
}): MarketingApprovedRequestRow[] {
  const customersById = new Map(params.customers.map((customer) => [customer.id, customer]));
  const employeesByHrId = new Map(
    params.employeeRows.map((employee) => [normalizeHrId(employee.hrId), employee]),
  );
  const financeByRequestId = new Map(
    params.financeRequirements.map((requirement) => [requirement.requestId, requirement]),
  );

  return params.requests.map((request) => {
    const requester = employeesByHrId.get(normalizeHrId(request.requesterHrId));
    const customer = customersById.get(request.customerId);
    const finance = financeByRequestId.get(request.id);

    return {
      contactForMoneyTransfer: requester?.displayName ?? request.requesterHrId,
      customerName: customer?.displayName ?? request.customerId,
      financeProofFileName: finance?.moneyTransferProofOriginalFileName ?? null,
      financeProofStoragePath: finance?.moneyTransferProofStoragePath ?? null,
      id: request.id,
      invoiceFileName: finance?.invoiceOriginalFileName ?? null,
      invoiceStoragePath: finance?.invoiceStoragePath ?? null,
      line: requester?.lineName ?? null,
      moneyTransferDate: request.payDate,
      notes: request.notes,
      requestCode: request.requestCode,
      requesterHrId: request.requesterHrId,
      status: request.status,
      sumOfAmount: request.estimatedCost,
    };
  });
}

function buildRoiWindowLabel(payDate: string | null, months: number): string | null {
  if (!payDate) return null;
  const match = /^(\d{4})-(\d{2})/.exec(payDate);
  if (!match) return null;

  const startLabel = `${match[1]}-${match[2]}`;
  const span = Math.max(1, Math.round(months));
  if (span <= 1) return startLabel;

  const startIndex = Number(match[1]) * 12 + (Number(match[2]) - 1);
  const endIndex = startIndex + (span - 1);
  const endLabel = `${Math.floor(endIndex / 12)}-${String((endIndex % 12) + 1).padStart(2, "0")}`;
  return `${startLabel} → ${endLabel}`;
}

function canSeeMarketingRequest(access: AccessContext, row: MarketingRequestDbRow, employeeRows: EmployeeDirectoryRow[]) {
  return canSeeMarketingHierarchyRecord(access, {
    employeeHrId: row.requester_hr_id,
    managerHrId: row.manager_hr_id,
  }, employeeRows);
}

/** Load a map of request_id → Set<productCode> for the given request IDs. Used to apply
 *  product_scope_override filtering when a viewer's access is restricted to specific codes. */
async function loadProductCodesByRequestId(
  supabase: SupabaseClient,
  requestIds: string[],
): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  if (requestIds.length === 0) return map;
  for (const batch of chunk(requestIds)) {
    const { data } = await supabase
      .from("marketing_request_products")
      .select("request_id, marketing_products(product_code)")
      .in("request_id", batch);
    for (const row of (data ?? []) as Array<{ request_id: string; marketing_products?: { product_code?: string | null } | null }>) {
      const code = row.marketing_products?.product_code;
      if (!row.request_id || !code) continue;
      const bucket = map.get(row.request_id) ?? new Set<string>();
      bucket.add(code.trim().toUpperCase());
      map.set(row.request_id, bucket);
    }
  }
  return map;
}

/** Return a filter that drops requests whose products don't include any of the viewer's
 *  allowed product codes. When allowedProductCodes is null, all requests pass. */
function makeProductCodeFilter(allowedProductCodes: Set<string> | null) {
  return (requestId: string, productCodesByRequestId: Map<string, Set<string>>) => {
    if (!allowedProductCodes) return true;
    if (allowedProductCodes.size === 0) return false;
    const codes = productCodesByRequestId.get(requestId);
    if (!codes || codes.size === 0) return false;
    for (const code of codes) {
      if (allowedProductCodes.has(code)) return true;
    }
    return false;
  };
}

async function fetchActiveProducts(supabase: SupabaseClient, productIds: number[]) {
  const { data, error } = await supabase
    .from("marketing_products")
    .select("id, product_code, product_name, factory_price, line, line_id, active")
    .in("id", productIds)
    .or("active.is.null,active.eq.true");

  if (error) throw error;
  return (data ?? []) as MarketingProductDbRow[];
}

async function fetchPharmacyCodes(supabase: SupabaseClient, distributorCodeIds: string[]) {
  if (distributorCodeIds.length === 0) return [];

  const { data, error } = await supabase
    .from("marketing_pharmacy_distributor_codes")
    .select("id, pharmacy_id, active")
    .in("id", distributorCodeIds)
    .or("active.is.null,active.eq.true");

  if (error) throw error;
  return (data ?? []) as MarketingPharmacyDistributorCodeDbRow[];
}

function emptyValidationSummary(): Record<MarketingValidationStatus, number> {
  return {
    pending: 0,
    rejected: 0,
    sfe_validated: 0,
    system_validated: 0,
  };
}

/**
 * Safety bound for the scoped marketing workspaces — NOT a page size.
 *
 * These queries fetch COMPANY-WIDE and the viewer's hierarchy filter is applied afterwards, in
 * memory (canSeeMarketingRequest / canSeeMarketingCustomer). Any cap below the table size therefore
 * truncates the wrong end: rows are dropped before the viewer's own rows are selected, so a Regional
 * Manager's own draft could vanish from his own Drafts tab and the Customer Validation summary could
 * report zero while his region had pending work — silently, looking exactly like "nothing to do".
 *
 * It was live, not theoretical: at the time of this fix production held 303 marketing_customer_pharmacies
 * against a .limit(200) (≈34% dropped) and 217 marketing_requests against a .limit(200).
 *
 * The bound exists only so a pathological table can never become an unbounded scan; it must stay well
 * above the real row counts (hundreds). If these tables ever approach it, the fix is to push the scope
 * filter into the query (scope-then-limit), not to raise this number again.
 */
const MARKETING_WORKSPACE_SAFETY_LIMIT = 10000;

function canSeeMarketingCustomer(access: AccessContext, row: MarketingCustomerDbRow, employeeRows: EmployeeDirectoryRow[]) {
  return canSeeMarketingHierarchyRecord(access, {
    employeeHrId: row.owner_hr_id,
    managerHrId: row.manager_hr_id,
  }, employeeRows);
}

// PostgREST folds every .in() value into the request URL; an unbatched array of a few hundred ids
// can push the URL past undici's ~16KB header limit and throw "TypeError: fetch failed" /
// HeadersOverflowError (the Customer Database workspace dedupes ids from an org-wide, .limit(1000)
// links query, well past that threshold). Batch instead of passing the whole array in one .in().
function chunk<T>(items: T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function fetchCustomerContactsByCustomerIds(
  supabase: SupabaseClient,
  customerIds: Array<string | number>,
): Promise<MarketingCustomerContactDbRow[]> {
  const rows: MarketingCustomerContactDbRow[] = [];
  for (const batch of chunk(customerIds)) {
    const { data, error } = await supabase
      .from("marketing_customer_contacts")
      .select("id, customer_id, contact_name, mobile_number, active")
      .in("customer_id", batch)
      .eq("active", true);
    if (error) throw error;
    rows.push(...((data ?? []) as MarketingCustomerContactDbRow[]));
  }
  return rows;
}

async function fetchRowsByIds<T extends { id: string | number }>(
  supabase: SupabaseClient,
  table: string,
  ids: Array<string | number>,
) {
  if (ids.length === 0) return [];
  const rows: T[] = [];
  for (const batch of chunk(ids)) {
    const { data, error } = await supabase.from(table).select("*").in("id", batch);
    if (error) throw error;
    rows.push(...((data ?? []) as T[]));
  }
  return rows;
}

function mapValidationReportRows(params: {
  customers: MarketingCustomerDbRow[];
  distributorCodes: MarketingPharmacyDistributorCodeDbRow[];
  distributors: MarketingDistributorDbRow[];
  links: MarketingCustomerPharmacyDbRow[];
  pharmacies: MarketingPharmacyDbRow[];
}) {
  const customers = new Map(params.customers.map((row) => [row.id, mapCustomer(row)]));
  const pharmacies = new Map(params.pharmacies.map((row) => [row.id, mapMarketingPharmacy(row)]));
  const distributorCodes = new Map(params.distributorCodes.map((row) => [row.id, mapDistributorCode(row)]));
  const distributorNames = new Map(params.distributors.map((row) => [Number(row.id), row.display_name]));
  const summary = emptyValidationSummary();
  const rows: MarketingValidationReportRow[] = [];

  for (const linkRow of params.links) {
    const link = mapCustomerPharmacy(linkRow);
    const customer = customers.get(link.customerId);
    const pharmacy = pharmacies.get(link.pharmacyId);
    const distributorCode = distributorCodes.get(link.distributorCodeId);
    if (!customer || !pharmacy || !distributorCode) continue;

    summary[link.validationStatus] += 1;
    rows.push({
      customer,
      distributorCode,
      distributorName: distributorNames.get(distributorCode.distributorId) ?? "Unknown distributor",
      id: link.id,
      pharmacy,
      validationNotes: link.validationNotes,
      validationStatus: link.validationStatus,
    });
  }

  return { rows, summary };
}

function buildPharmacyCodeReferenceResult(matches: Array<{ id: number | string }>) {
  const matchCount = matches.length;
  const status: MarketingPharmacyCodeReferenceStatus =
    matchCount === 1 ? "matched" : matchCount > 1 ? "ambiguous" : "not_found";

  return {
    matchCount,
    referenceId: matchCount === 1 ? Number(matches[0].id) : null,
    status,
  };
}

/**
 * Looks a (distributor, normalized pharmacy code) pair up in the marketing pharmacy code
 * reference database and reports matched / ambiguous / not_found.
 *
 * Exported so the bulk ROI sheet importer can run the SAME check the Customer Validation UI
 * runs. It previously hardcoded `reference_status: "pending"` and never called this, which is
 * why 286 of 287 links in production carry `pending` with `reference_match_count = 0` — the
 * reference database has 20,097 rows and had effectively never been consulted.
 */
export async function resolvePharmacyCodeReference(params: {
  distributorId: number;
  normalizedPharmacyCode: string;
  supabase: SupabaseClient;
}) {
  // Preferred path: exact match on the indexed normalized column. `limit(2)` is enough
  // to distinguish not_found (0) / matched (1) / ambiguous (>=2) without scanning the
  // whole distributor.
  const primary = await params.supabase
    .from("marketing_pharmacy_code_references")
    .select("id")
    .eq("distributor_id", params.distributorId)
    .eq("normalized_pharmacy_code", params.normalizedPharmacyCode)
    .limit(2);
  if (!primary.error) {
    return buildPharmacyCodeReferenceResult((primary.data ?? []) as Array<{ id: number | string }>);
  }

  // Fallback for databases where `normalized_pharmacy_code` has not been added yet
  // (e.g. before the accompanying migration is applied). Filters in memory but, unlike
  // the previous implementation, scans every reference for the distributor instead of an
  // arbitrary first 20 rows.
  const fallback = await params.supabase
    .from("marketing_pharmacy_code_references")
    .select("id, raw_pharmacy_code")
    .eq("distributor_id", params.distributorId);
  if (fallback.error) throw fallback.error;

  const matches = ((fallback.data ?? []) as MarketingPharmacyCodeReferenceDbRow[]).filter(
    (row) => normalizeLookupKey(row.raw_pharmacy_code) === params.normalizedPharmacyCode,
  );
  return buildPharmacyCodeReferenceResult(matches);
}

/**
 * Non-blocking lookup powering the "is this pharmacy code already in our Phoenix
 * database?" flag on the Customer Validation page. Returns whether the (distributor,
 * pharmacy code) pair is known so the rep can see whether sales for it can be tracked.
 */
export async function getMarketingPharmacyCodeReferenceStatus(
  input: { distributorId: number | string; pharmacyCode: string },
  access: AccessContext,
): Promise<{ matchCount: number; status: MarketingPharmacyCodeReferenceStatus; tracked: boolean }> {
  assertMarketingAccess(access);

  const distributorId = numberId(input.distributorId, "Distributor");
  const normalizedPharmacyCode = normalizeLookupKey(input.pharmacyCode);
  if (!normalizedPharmacyCode) {
    return { matchCount: 0, status: "not_found", tracked: false };
  }

  const reference = await resolvePharmacyCodeReference({
    distributorId,
    normalizedPharmacyCode,
    supabase: getSupabaseAdmin(),
  });
  return {
    matchCount: reference.matchCount,
    status: reference.status,
    tracked: reference.matchCount > 0,
  };
}

export async function getMarketingValidationWorkspace(access: AccessContext): Promise<MarketingValidationWorkspace> {
  assertMarketingAccess(access);

  const supabase = getSupabaseAdmin();
  const [distributorsResult, linksResult] = await Promise.all([
    supabase.from("marketing_distributors").select("*").eq("active", true).order("display_name"),
    supabase
      .from("marketing_customer_pharmacies")
      .select("*")
      .eq("active", true)
      .order("created_at", { ascending: false })
      .limit(MARKETING_WORKSPACE_SAFETY_LIMIT),
  ]);

  if (distributorsResult.error) throw distributorsResult.error;
  if (linksResult.error) throw linksResult.error;

  const distributors = ((distributorsResult.data ?? []) as MarketingDistributorDbRow[]).map(mapDistributor);
  const canActOnBehalf = canValidateMarketingOnBehalf(access);
  const links = (linksResult.data ?? []) as MarketingCustomerPharmacyDbRow[];
  if (links.length === 0) {
    // A Super Admin still needs the picker on an empty workspace — validating the very first
    // customer for an employee is exactly when this screen is empty.
    return {
      canValidateOnBehalf: canActOnBehalf,
      distributors,
      onBehalfEmployees: canActOnBehalf
        ? buildMarketingOnBehalfEmployees(await loadEmployeeDirectoryRows())
        : [],
      rows: [],
      summary: emptyValidationSummary(),
    };
  }

  const [customerRows, pharmacyRows, codeRows, employeeRows] = await Promise.all([
    fetchRowsByIds<MarketingCustomerDbRow>(
      supabase,
      "marketing_customers",
      links.map((row) => row.customer_id),
    ),
    fetchRowsByIds<MarketingPharmacyDbRow>(
      supabase,
      "marketing_pharmacies",
      links.map((row) => row.pharmacy_id),
    ),
    fetchRowsByIds<MarketingPharmacyDistributorCodeDbRow>(
      supabase,
      "marketing_pharmacy_distributor_codes",
      links.map((row) => row.distributor_code_id),
    ),
    loadEmployeeDirectoryRows(),
  ]);

  const visibleCustomers = customerRows.filter((row) => canSeeMarketingCustomer(access, row, employeeRows));
  const visibleCustomerIds = new Set(visibleCustomers.map((row) => row.id));
  const visibleLinks = links.filter((row) => visibleCustomerIds.has(row.customer_id));
  const report = mapValidationReportRows({
    customers: visibleCustomers,
    distributorCodes: codeRows,
    distributors: (distributorsResult.data ?? []) as MarketingDistributorDbRow[],
    links: visibleLinks,
    pharmacies: pharmacyRows,
  });

  return {
    canValidateOnBehalf: canActOnBehalf,
    distributors,
    onBehalfEmployees: canActOnBehalf ? buildMarketingOnBehalfEmployees(employeeRows) : [],
    rows: report.rows,
    summary: report.summary,
  };
}

export async function getMarketingCustomerDatabaseWorkspace(
  access: AccessContext,
): Promise<MarketingCustomerDatabaseWorkspace> {
  assertMarketingCustomerDatabaseAccess(access);

  const supabase = getSupabaseAdmin();
  const [distributorsResult, linksResult] = await Promise.all([
    supabase.from("marketing_distributors").select("*").eq("active", true).order("display_name"),
    supabase
      .from("marketing_customer_pharmacies")
      .select("*")
      .eq("active", true)
      .order("created_at", { ascending: false })
      .limit(1000),
  ]);

  if (distributorsResult.error) throw distributorsResult.error;
  if (linksResult.error) throw linksResult.error;

  const links = (linksResult.data ?? []) as MarketingCustomerPharmacyDbRow[];
  if (links.length === 0) {
    return {
      rows: [],
      summary: {
        customers: 0,
        pharmacies: 0,
        rows: 0,
        vendors: 0,
      },
    };
  }

  const customerIds = Array.from(new Set(links.map((row) => row.customer_id)));
  const pharmacyIds = Array.from(new Set(links.map((row) => row.pharmacy_id)));
  const distributorCodeIds = Array.from(new Set(links.map((row) => row.distributor_code_id)));

  const [customerRows, pharmacyRows, codeRows, contactDataRows] = await Promise.all([
    fetchRowsByIds<MarketingCustomerDbRow>(supabase, "marketing_customers", customerIds),
    fetchRowsByIds<MarketingPharmacyDbRow>(supabase, "marketing_pharmacies", pharmacyIds),
    fetchRowsByIds<MarketingPharmacyDistributorCodeDbRow>(
      supabase,
      "marketing_pharmacy_distributor_codes",
      distributorCodeIds,
    ),
    fetchCustomerContactsByCustomerIds(supabase, customerIds),
  ]);

  const mappedCustomers = new Map(customerRows.map((row) => [row.id, mapCustomer(row)]));
  const mappedPharmacies = new Map(pharmacyRows.map((row) => [row.id, mapMarketingPharmacy(row)]));
  const mappedCodes = new Map(codeRows.map((row) => [row.id, mapDistributorCode(row)]));
  const distributors = new Map(
    ((distributorsResult.data ?? []) as MarketingDistributorDbRow[]).map((row) => [
      Number(row.id),
      mapDistributor(row),
    ]),
  );
  const contactsByCustomer = new Map<string, MarketingCustomerContactDbRow>();
  for (const contact of contactDataRows) {
    if (!contactsByCustomer.has(contact.customer_id)) {
      contactsByCustomer.set(contact.customer_id, contact);
    }
  }

  const rows = links.flatMap((link) => {
    const customer = mappedCustomers.get(link.customer_id);
    const pharmacy = mappedPharmacies.get(link.pharmacy_id);
    const distributorCode = mappedCodes.get(link.distributor_code_id);
    if (!customer || !pharmacy || !distributorCode) return [];

    const distributor = distributors.get(distributorCode.distributorId);
    const contact = contactsByCustomer.get(customer.id);
    const customerPhone = cleanText(contact?.mobile_number) ?? null;

    return [{
      createdAt: nowIsoFallback(link.created_at),
      customerAddress: customer.capturedAddress,
      customerArea: customer.extractedAreaName,
      customerCode: customer.customerCode,
      customerGovernorate: customer.extractedGovernorateName,
      customerId: customer.id,
      customerName: customer.displayName,
      customerPhone,
      customerType: customer.customerType,
      customerValidationPhoto: customer.evidencePhotoName,
      distributorCode: distributor?.distributorCode ?? String(distributorCode.distributorId),
      distributorId: distributorCode.distributorId,
      distributorName: distributor?.displayName ?? "Unknown distributor",
      pharmacyAddress: pharmacy.capturedAddress,
      pharmacyArea: pharmacy.extractedAreaName,
      pharmacyCode: pharmacy.pharmacyCode,
      pharmacyDistributorCodeId: distributorCode.id,
      pharmacyGovernorate: pharmacy.extractedGovernorateName,
      pharmacyId: pharmacy.id,
      pharmacyName: pharmacy.displayName,
      rowId: link.id,
      validationStatus: link.validation_status ?? "pending",
      vendorPharmacyCode: distributorCode.distributorPharmacyCode,
    }];
  });

  return {
    rows,
    summary: {
      customers: new Set(rows.map((row) => row.customerId)).size,
      pharmacies: new Set(rows.map((row) => row.pharmacyId)).size,
      rows: rows.length,
      vendors: new Set(rows.map((row) => row.distributorId)).size,
    },
  };
}

export async function getMarketingControlWorkspace(
  access: AccessContext,
): Promise<MarketingControlWorkspace> {
  assertMarketingControlAccess(access);

  const supabase = getSupabaseAdmin();
  const canManageValidationRules = canManageMarketingValidationRules(access);
  const [typesResult, workflowResult, settingsResult] = await Promise.all([
    supabase.from("marketing_request_types").select("*").order("sort_order"),
    supabase.from("marketing_workflow_steps").select("*").order("sequence"),
    supabase.from("marketing_control_settings").select("*").order("setting_group").order("setting_key"),
  ]);

  if (typesResult.error) throw typesResult.error;
  if (workflowResult.error) throw workflowResult.error;
  if (settingsResult.error) throw settingsResult.error;

  const settings = ((settingsResult.data ?? []) as MarketingControlSettingDbRow[])
    .map(mapControlSetting)
    .filter((setting) => canManageValidationRules || !setting.adminOnly);

  return {
    canManageValidationRules,
    requestTypes: ((typesResult.data ?? []) as MarketingRequestTypeDbRow[]).map(mapRequestType),
    settings,
    workflowSteps: ((workflowResult.data ?? []) as MarketingWorkflowStepDbRow[]).map(mapWorkflowStep),
  };
}

function parseBooleanPatch(value: unknown, label: string) {
  if (typeof value !== "boolean") {
    throw validationError(`${label} must be true or false.`);
  }
  return value;
}

function parseIntegerPatch(value: unknown, label: string, options: { allowNull?: boolean } = {}) {
  if ((value === null || value === "") && options.allowNull) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw validationError(`${label} must be a whole number.`);
  }
  return parsed;
}

function parseRequiredIntegerPatch(value: unknown, label: string) {
  const parsed = parseIntegerPatch(value, label);
  if (parsed === null) throw validationError(`${label} is required.`);
  return parsed;
}

function parseRequiredTextPatch(value: unknown, label: string) {
  const normalized = cleanText(value);
  if (!normalized) throw validationError(`${label} is required.`);
  return normalized;
}

export async function updateMarketingControlSetting(
  input: {
    settingKey: unknown;
    value: unknown;
  },
  access: AccessContext,
): Promise<MarketingControlSetting> {
  assertMarketingControlAccess(access);

  const settingKey = parseRequiredTextPatch(input.settingKey, "Setting key");
  const value = input.value && typeof input.value === "object" && !Array.isArray(input.value)
    ? input.value as Record<string, unknown>
    : null;
  if (!value) throw validationError("Setting value is required.");

  const supabase = getSupabaseAdmin();
  const existingResult = await supabase
    .from("marketing_control_settings")
    .select("*")
    .eq("setting_key", settingKey)
    .maybeSingle();
  if (existingResult.error) throw existingResult.error;
  if (!existingResult.data) throw notFoundError("Control setting was not found.", "control_setting_not_found");

  const existing = mapControlSetting(existingResult.data as MarketingControlSettingDbRow);
  if (existing.adminOnly || existing.group === "validation") {
    assertMarketingValidationRuleControlAccess(access);
  }

  const updateResult = await supabase
    .from("marketing_control_settings")
    .update({
      setting_value: value,
      updated_at: new Date().toISOString(),
      updated_by_hr_id: resolveEmployeeIdentityId(access),
    })
    .eq("setting_key", settingKey)
    .select("*")
    .single();
  if (updateResult.error) throw updateResult.error;
  return mapControlSetting(updateResult.data as MarketingControlSettingDbRow);
}

export async function updateMarketingControlRequestType(
  input: {
    id: unknown;
    patch: Record<string, unknown>;
  },
  access: AccessContext,
): Promise<MarketingRequestType> {
  assertMarketingControlAccess(access);
  const id = numberId(input.id, "Request type");
  const patch = input.patch ?? {};
  const update: Partial<{
    active: boolean;
    description: string | null;
    name: string;
    requires_description: boolean;
    sort_order: number;
  }> = {};

  if ("active" in patch) update.active = parseBooleanPatch(patch.active, "Active");
  if ("description" in patch) update.description = cleanText(patch.description);
  if ("name" in patch) update.name = parseRequiredTextPatch(patch.name, "Request type name");
  if ("requiresDescription" in patch) {
    update.requires_description = parseBooleanPatch(patch.requiresDescription, "Requires description");
  }
  if ("sortOrder" in patch) update.sort_order = parseRequiredIntegerPatch(patch.sortOrder, "Sort order");
  if (Object.keys(update).length === 0) throw validationError("No request type changes were provided.");

  const supabase = getSupabaseAdmin();
  const result = await supabase
    .from("marketing_request_types")
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (result.error) throw result.error;
  return mapRequestType(result.data as MarketingRequestTypeDbRow);
}

export async function updateMarketingControlWorkflowStep(
  input: {
    id: unknown;
    patch: Record<string, unknown>;
  },
  access: AccessContext,
): Promise<MarketingWorkflowStep> {
  assertMarketingControlAccess(access);
  const id = numberId(input.id, "Workflow step");
  const patch = input.patch ?? {};
  const update: Partial<{
    active: boolean;
    approval_scope: MarketingWorkflowApprovalScope;
    assigned_role: string;
    default_sla_days: number | null;
    required: boolean;
    sequence: number;
    step_name: string;
  }> = {};

  if ("active" in patch) update.active = parseBooleanPatch(patch.active, "Active");
  if ("approvalScope" in patch) {
    const approvalScope = parseRequiredTextPatch(patch.approvalScope, "Approval scope");
    if (!["direct_manager", "role", "finance", "final"].includes(approvalScope)) {
      throw validationError("Approval scope is invalid.");
    }
    update.approval_scope = approvalScope as MarketingWorkflowApprovalScope;
  }
  if ("assignedRole" in patch) update.assigned_role = parseRequiredTextPatch(patch.assignedRole, "Assigned role");
  if ("defaultSlaDays" in patch) {
    const days = parseIntegerPatch(patch.defaultSlaDays, "Default SLA days", { allowNull: true });
    update.default_sla_days = days === 0 ? null : days;
  }
  if ("required" in patch) update.required = parseBooleanPatch(patch.required, "Required");
  if ("sequence" in patch) {
    const sequence = parseRequiredIntegerPatch(patch.sequence, "Sequence");
    if (sequence <= 0) throw validationError("Sequence must be greater than zero.");
    update.sequence = sequence;
  }
  if ("stepName" in patch) update.step_name = parseRequiredTextPatch(patch.stepName, "Step name");
  if (Object.keys(update).length === 0) throw validationError("No workflow changes were provided.");

  await assertMarketingWorkflowTransition({
    access,
    actionKey: "update_control_step",
    status: "control_active",
  });

  const supabase = getSupabaseAdmin();
  const result = await supabase
    .from("marketing_workflow_steps")
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (result.error) throw result.error;
  return mapWorkflowStep(result.data as MarketingWorkflowStepDbRow);
}

export async function createMarketingValidationRecord(
  input: MarketingValidationInput,
  access: AccessContext,
  options: CreateValidationOptions = {},
): Promise<MarketingValidationReportRow[]> {
  assertMarketingAccess(access);
  await assertMarketingWorkflowTransition({
    access,
    actionKey: "create_validation_record",
    status: "validation_pending",
  });

  const supabase = options.supabase ?? getSupabaseAdmin();
  const employeeRows = options.employeeRows ?? await loadEmployeeDirectoryRows();
  // Only the desk path needs the unfiltered directory, and only to name the admin — so the extra
  // load never runs for a field rep. Injected rows (tests) serve both roles.
  const actorRows = cleanText(input.onBehalfOfHrId) && !options.employeeRows
    ? await loadActorDirectoryRows()
    : options.actorRows ?? employeeRows;
  const {
    actorHrId: resolvedActorHrId,
    actorIsKnownEmployee,
    actorName,
    isOnBehalf,
    owner,
  } = resolveMarketingValidationActor({
    access,
    actorRows,
    employeeRows,
    onBehalfOfHrId: input.onBehalfOfHrId,
  });

  // An actor with no employees row at all cannot satisfy the employees(hr_id) FKs on these tables.
  // Only then do the audit columns fall back to the owner so the insert still succeeds; `validated_at`
  // has no FK and stays set either way, so the row is always identifiable as a desk entry.
  const ownerHrId = String(owner.hrId);
  const actorHrId = actorIsKnownEmployee ? resolvedActorHrId : ownerHrId;
  const adminValidatedByHrId = isOnBehalf && actorIsKnownEmployee ? actorHrId : null;
  const adminValidatedAt = isOnBehalf ? new Date().toISOString() : null;
  const adminValidationNote = isOnBehalf
    ? `Validated at the desk by ${actorName ?? "Super Admin"} on behalf of ${owner.displayName}. Location chosen from map search — no field GPS or live photo.`
    : null;

  const normalized = normalizeMarketingValidationInput(input);
  const distributorIds = Array.from(
    new Set(
      normalized.customers.flatMap((entry) =>
        entry.pharmacies.flatMap((pharmacy) => pharmacy.vendorCodes.map((code) => code.distributorId)),
      ),
    ),
  );
  const distributorsResult = await supabase
    .from("marketing_distributors")
    .select("*")
    .in("id", distributorIds)
    .eq("active", true);
  if (distributorsResult.error) throw distributorsResult.error;

  const distributorRows = (distributorsResult.data ?? []) as MarketingDistributorDbRow[];
  const distributorsById = new Map(distributorRows.map((row) => [Number(row.id), row]));
  for (const distributorId of distributorIds) {
    if (!distributorsById.has(distributorId)) {
      throw notFoundError(`Distributor ${distributorId} was not found.`, "distributor_not_found");
    }
  }

  // Every customer and pharmacy minted by THIS submission, so a failure part-way through a
  // multi-customer save removes all of them rather than leaving the earlier ones stranded in the
  // owner's book with no pharmacies attached.
  const customerIds: string[] = [];
  const pharmacyIds: string[] = [];
  // Storage objects written by THIS submission. Tracked alongside the row ids because a bucket
  // object outlives a rolled-back insert unless it is explicitly removed, and an orphaned photo of
  // a real shop front is exactly the kind of thing that must not linger unreferenced.
  const evidencePhotoPaths: string[] = [];
  try {
    const rows: MarketingValidationReportRow[] = [];
    for (const normalizedCustomer of normalized.customers) {
    const customerInsert = await supabase
      .from("marketing_customers")
      .insert({
        area_id: owner.areaId ?? null,
        captured_accuracy_meters: normalizedCustomer.capturedAccuracyMeters,
        captured_address: normalizedCustomer.capturedAddress,
        captured_at: normalizedCustomer.capturedAt,
        captured_latitude: normalizedCustomer.capturedLatitude,
        captured_longitude: normalizedCustomer.capturedLongitude,
        created_by_hr_id: actorHrId,
        customer_code: generateMarketingCode("MKT-HCP"),
        customer_type: normalizedCustomer.customerType,
        display_name: normalizedCustomer.displayName,
        evidence_has_timestamp: normalizedCustomer.evidenceHasTimestamp,
        evidence_photo_captured_at: normalizedCustomer.evidencePhotoCapturedAt,
        evidence_photo_name: normalizedCustomer.evidencePhotoName,
        evidence_status: normalizedCustomer.evidenceStatus,
        extracted_area_name: normalizedCustomer.extractedAreaName,
        extracted_governorate_name: normalizedCustomer.extractedGovernorateName,
        line_id: owner.lineId ?? null,
        manager_hr_id: owner.managerHrId ?? null,
        normalized_name: normalizedCustomer.normalizedName,
        other_type_description: normalizedCustomer.otherTypeDescription,
        owner_hr_id: ownerHrId,
        region_name: normalizedCustomer.regionName,
        updated_by_hr_id: actorHrId,
        validated_at: adminValidatedAt,
        validated_by_hr_id: adminValidatedByHrId,
        validation_notes: adminValidationNote,
        validation_status: resolveMarketingValidationRecordStatus({
          isOnBehalf,
          systemStatus: normalizedCustomer.validationStatus,
        }),
      })
      .select("*")
      .single();
    if (customerInsert.error) throw customerInsert.error;
    const customer = mapCustomer(customerInsert.data as MarketingCustomerDbRow);
    customerIds.push(customer.id);

    // Retain the image itself. Runs AFTER the insert because `marketing_evidence_files.entity_id`
    // points at the customer row that did not exist a moment ago. A failure here throws, which
    // unwinds the whole submission — the record must never survive its own evidence, because
    // `evidence_status` was already set to 'complete' on the promise that this write succeeds.
    if (normalizedCustomer.evidencePhotoDataUrl) {
      evidencePhotoPaths.push(await storeMarketingEvidencePhoto({
        imageDataUrl: normalizedCustomer.evidencePhotoDataUrl,
        record: {
          capturedAccuracyMeters: normalizedCustomer.capturedAccuracyMeters,
          capturedAddress: normalizedCustomer.capturedAddress,
          capturedAt: normalizedCustomer.evidencePhotoCapturedAt ?? normalizedCustomer.capturedAt,
          capturedLatitude: normalizedCustomer.capturedLatitude,
          capturedLongitude: normalizedCustomer.capturedLongitude,
          entityId: customer.id,
          entityType: "customer",
          hasTimestamp: normalizedCustomer.evidenceHasTimestamp,
          originalFileName: normalizedCustomer.evidencePhotoName,
          uploadedByHrId: actorHrId,
        },
        supabase,
      }));
    }

    // Speciality lives on the contact row (marketing_customers has no such column), so the contact
    // is now written whenever EITHER a speciality or a phone was given — previously a customer with
    // a speciality but no phone would have had nowhere to record it.
    if (normalizedCustomer.mobileNumber || normalizedCustomer.speciality) {
      const contactInsert = await supabase
        .from("marketing_customer_contacts")
        .insert({
          contact_code: generateMarketingCode("MKT-CON"),
          contact_name: customer.displayName,
          created_by_hr_id: actorHrId,
          customer_id: customer.id,
          mobile_number: normalizedCustomer.mobileNumber,
          specialty: normalizedCustomer.speciality,
        });
      if (contactInsert.error) throw contactInsert.error;
    }

    for (const normalizedPharmacy of normalizedCustomer.pharmacies) {
      const pharmacyInsert = await supabase
        .from("marketing_pharmacies")
        .insert({
          area_id: owner.areaId ?? null,
          captured_accuracy_meters: normalizedPharmacy.capturedAccuracyMeters,
          captured_address: normalizedPharmacy.capturedAddress,
          captured_at: normalizedPharmacy.capturedAt,
          captured_latitude: normalizedPharmacy.capturedLatitude,
          captured_longitude: normalizedPharmacy.capturedLongitude,
          created_by_hr_id: actorHrId,
          display_name: normalizedPharmacy.displayName,
          evidence_has_timestamp: normalizedPharmacy.evidenceHasTimestamp,
          evidence_photo_captured_at: normalizedPharmacy.evidencePhotoCapturedAt,
          evidence_photo_name: normalizedPharmacy.evidencePhotoName,
          evidence_status: normalizedPharmacy.evidenceStatus,
          extracted_area_name: normalizedPharmacy.extractedAreaName,
          extracted_governorate_name: normalizedPharmacy.extractedGovernorateName,
          line_id: owner.lineId ?? null,
          manager_hr_id: owner.managerHrId ?? null,
          normalized_name: normalizedPharmacy.normalizedName,
          owner_hr_id: ownerHrId,
          pharmacy_code: generateMarketingCode("MKT-PHA"),
          region_name: normalizedPharmacy.regionName,
          updated_by_hr_id: actorHrId,
          validated_at: adminValidatedAt,
          validated_by_hr_id: adminValidatedByHrId,
          validation_notes: adminValidationNote,
          validation_status: resolveMarketingValidationRecordStatus({
            isOnBehalf,
            systemStatus: normalizedPharmacy.validationStatus,
          }),
        })
        .select("*")
        .single();
      if (pharmacyInsert.error) throw pharmacyInsert.error;
      const pharmacy = mapMarketingPharmacy(pharmacyInsert.data as MarketingPharmacyDbRow);
      pharmacyIds.push(pharmacy.id);

      // A pharmacy's shop front is photographed on the same rule as its customer's — two of the
      // three production rows that claimed unretained proof were pharmacies, not customers.
      if (normalizedPharmacy.evidencePhotoDataUrl) {
        evidencePhotoPaths.push(await storeMarketingEvidencePhoto({
          imageDataUrl: normalizedPharmacy.evidencePhotoDataUrl,
          record: {
            capturedAccuracyMeters: normalizedPharmacy.capturedAccuracyMeters,
            capturedAddress: normalizedPharmacy.capturedAddress,
            capturedAt: normalizedPharmacy.evidencePhotoCapturedAt ?? normalizedPharmacy.capturedAt,
            capturedLatitude: normalizedPharmacy.capturedLatitude,
            capturedLongitude: normalizedPharmacy.capturedLongitude,
            entityId: pharmacy.id,
            entityType: "pharmacy",
            hasTimestamp: normalizedPharmacy.evidenceHasTimestamp,
            originalFileName: normalizedPharmacy.evidencePhotoName,
            uploadedByHrId: actorHrId,
          },
          supabase,
        }));
      }

      for (const vendorCode of normalizedPharmacy.vendorCodes) {
        const reference = await resolvePharmacyCodeReference({
          distributorId: vendorCode.distributorId,
          normalizedPharmacyCode: vendorCode.normalizedPharmacyCode,
          supabase,
        });
        const linkValidationStatus = resolveMarketingValidationRecordStatus({
          isOnBehalf,
          systemStatus: resolveMarketingSystemValidationStatus({
            customerEvidenceStatus: normalizedCustomer.evidenceStatus,
            pharmacyEvidenceStatus: normalizedPharmacy.evidenceStatus,
            referenceStatus: reference.status,
          }),
        });
        // The reference lookup still runs and is still stored truthfully, because an unmatched code
        // means sales can never be attributed to this pharmacy — the row is usable, but its ROI
        // would read zero forever. Say so on the row rather than letting it look fully healthy.
        const linkValidationNotes = isOnBehalf
          ? reference.status === "matched"
            ? adminValidationNote
            : `${adminValidationNote} Distributor code is ${reference.status.replace(/_/g, " ")} in the Phoenix reference database, so sales cannot be tracked for it yet.`
          : linkValidationStatus === "system_validated"
            ? null
            : "Waiting for complete evidence or distributor-code match.";
        const distributorCodeInsert = await supabase
          .from("marketing_pharmacy_distributor_codes")
          .insert({
            created_by_hr_id: actorHrId,
            distributor_id: vendorCode.distributorId,
            distributor_pharmacy_code: vendorCode.distributorPharmacyCode,
            normalized_pharmacy_code: vendorCode.normalizedPharmacyCode,
            pharmacy_id: pharmacy.id,
            reference_id: reference.referenceId,
            reference_match_count: reference.matchCount,
            reference_status: reference.status,
            validation_notes: reference.status === "matched" ? null : `Reference ${reference.status.replace(/_/g, " ")}.`,
          })
          .select("*")
          .single();
        if (distributorCodeInsert.error) throw distributorCodeInsert.error;
        const distributorCode = mapDistributorCode(distributorCodeInsert.data as MarketingPharmacyDistributorCodeDbRow);

        const linkInsert = await supabase
          .from("marketing_customer_pharmacies")
          .insert({
            created_by_hr_id: actorHrId,
            customer_id: customer.id,
            distributor_code_id: distributorCode.id,
            pharmacy_id: pharmacy.id,
            updated_by_hr_id: actorHrId,
            validation_notes: linkValidationNotes,
            validation_status: linkValidationStatus,
          })
          .select("*")
          .single();
        if (linkInsert.error) throw linkInsert.error;
        const link = mapCustomerPharmacy(linkInsert.data as MarketingCustomerPharmacyDbRow);
        const distributor = mapDistributor(distributorsById.get(vendorCode.distributorId) as MarketingDistributorDbRow);

        rows.push({
          customer,
          distributorCode,
          distributorName: distributor.displayName,
          id: link.id,
          pharmacy,
          validationNotes: link.validationNotes,
          validationStatus: link.validationStatus,
        });
      }
    }

    if (isOnBehalf) {
      // An admin moving a customer into another employee's book is exactly the kind of act that has
      // to be reconstructable later — the row itself only shows the end state. One entry per
      // customer, so a multi-customer submission is not collapsed into a single unreadable record.
      await writeAuditLog({
        actorLoginId: resolvedActorHrId,
        entityId: customer.id,
        entityType: "marketing_customer",
        newValues: {
          customerCode: customer.customerCode,
          customerName: customer.displayName,
          customersInSubmission: normalized.customers.length,
          onBehalfOfHrId: ownerHrId,
          onBehalfOfName: owner.displayName,
          pharmacyCount: normalizedCustomer.pharmacies.length,
          source: "marketing_validation_admin_on_behalf",
          speciality: normalizedCustomer.speciality,
          validationStatus: "sfe_validated",
        },
        summary: `Customer ${customer.displayName} validated at the desk on behalf of ${owner.displayName} (${ownerHrId})`,
      });
    }
    }

    // A newly validated customer or pharmacy changes the evidence and validation columns the
    // sheet shows, so it is worth a refresh even though no request row moved.
    pingMarketingRequestSheet("validation_recorded");
    return rows;
  } catch (error) {
    // Order matters: the link rows FK to both, and pharmacies are deleted before customers so a
    // partially-built submission unwinds cleanly instead of tripping a foreign-key violation that
    // would mask the real error.
    for (const pharmacyId of pharmacyIds) {
      await supabase.from("marketing_pharmacies").delete().eq("id", pharmacyId);
    }
    for (const rollbackCustomerId of customerIds) {
      await supabase.from("marketing_customers").delete().eq("id", rollbackCustomerId);
    }
    // Last, and best-effort: the photos this submission uploaded. Their index rows FK to nothing
    // that was just deleted, so they would otherwise survive as evidence of records that no longer
    // exist. A failure to clean up must not replace the error the caller actually needs to see.
    await deleteMarketingEvidencePhotos(evidencePhotoPaths, supabase).catch(() => undefined);
    throw error;
  }
}

/**
 * Company-wide register of EVERY marketing request, at every status, with live tracking.
 *
 * Deliberately not folded into the personal draft workspace: that surface narrows company-wide
 * roles to their own requests (scopeTrackingToOwnRequests) so a Marketing Manager's Drafts tab is
 * not flooded with all 200+ company requests. Widening it there would break the personal view, so
 * oversight gets its own surface — owner instruction, 2026-08-03.
 *
 * Also distinct from ROI Tracking, which only covers approvedMarketingRequestStatuses and so can
 * never show a request that is stuck in approval — exactly the case this register exists for.
 */
const marketingRegisterRoles = new Set<AccessContext["role"]>([
  "Marketing Manager",
  "SFE Manager",
  "Super Admin",
]);

function assertMarketingRegisterAccess(access: AccessContext) {
  if (access.scope === "system") return;
  if (!marketingRegisterRoles.has(access.role)) {
    throw forbiddenError(`Forbidden: ${access.role} cannot view the company marketing request register.`);
  }
}

/**
 * Whether a request was actually raised in Phoenix, as opposed to loaded by the legacy
 * spreadsheet import.
 *
 * Fail-safe direction matters: anything that is NOT explicitly a Phoenix origin counts as
 * imported. A future import that forgets to set `origin` then lands in the archive rather than
 * silently padding the live register — the failure mode the owner asked to remove.
 */
export function isPhoenixOriginatedRequest(origin: string | null | undefined): boolean {
  return String(origin ?? "").trim().toLowerCase() === "phoenix";
}

export async function getMarketingAllRequestsWorkspace(
  access: AccessContext,
): Promise<MarketingAllRequestsWorkspace> {
  assertMarketingRegisterAccess(access);

  const supabase = getSupabaseAdmin();
  const [requestsResult, customersResult, employeeRows] = await Promise.all([
    supabase
      .from("marketing_requests")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(MARKETING_WORKSPACE_SAFETY_LIMIT),
    supabase.from("marketing_customers").select("id, display_name"),
    loadEmployeeDirectoryRows(),
  ]);
  if (requestsResult.error) throw requestsResult.error;
  if (customersResult.error) throw customersResult.error;

  const requestDbRows = (requestsResult.data ?? []) as MarketingRequestDbRow[];
  const requests = requestDbRows.map(mapRequest);
  // `origin` is not carried on the mapped domain object, and the register splits on it — so read
  // it from the raw rows rather than widening MarketingRequest for one caller.
  const originByRequestId = new Map(
    requestDbRows.map((row) => [String(row.id), (row as { origin?: string | null }).origin ?? null] as const),
  );
  const customerNameById = new Map(
    ((customersResult.data ?? []) as Array<{ display_name: string | null; id: string }>)
      .map((row) => [row.id, row.display_name ?? ""] as const),
  );
  const requesterByHrId = new Map(
    employeeRows.map((row) => [normalizeHrId(row.hrId), row] as const),
  );

  // Batched: PostgREST folds every .in() value into the URL, and an unbatched list of a few
  // hundred request ids can push it past undici's header limit.
  const stepsByRequestId = new Map<string, MarketingRequestApprovalStep[]>();
  for (const batch of chunk(requests.map((request) => request.id))) {
    const stepsResult = await supabase
      .from("marketing_request_approval_steps")
      .select("*")
      .in("request_id", batch)
      .order("sequence", { ascending: true });
    if (stepsResult.error) throw stepsResult.error;
    for (const row of (stepsResult.data ?? []) as MarketingRequestApprovalStepDbRow[]) {
      const step = mapApprovalStep(row);
      stepsByRequestId.set(step.requestId, [...(stepsByRequestId.get(step.requestId) ?? []), step]);
    }
  }

  const rows: MarketingAllRequestsRow[] = requests.map((request) => {
    const progress = buildMarketingStepProgress(stepsByRequestId.get(request.id) ?? [], employeeRows);
    const requester = requesterByHrId.get(normalizeHrId(request.requesterHrId)) ?? null;

    return {
      // Line/area come from the requester's directory row rather than the request's own ids so the
      // register shows human-readable names without two more joins (owner rule: never raw codes).
      areaName: requester?.areaName ?? null,
      currentApproverName: progress?.currentApproverName ?? null,
      currentStepName: progress?.currentStepName ?? null,
      customerName: customerNameById.get(request.customerId) || "Unknown customer",
      estimatedCost: toNumber(request.estimatedCost),
      id: request.id,
      isPhoenixSubmission: isPhoenixOriginatedRequest(originByRequestId.get(request.id)),
      lineName: requester?.lineName ?? null,
      origin: originByRequestId.get(request.id) ?? null,
      payDate: request.payDate,
      requestCode: request.requestCode,
      requesterName: employeeNameByHrId(employeeRows, request.requesterHrId),
      roiCoverageRatio: request.roiCoverageRatio ?? null,
      roiStatus: request.roiStatus ?? null,
      status: request.status,
      stepSequence: progress?.sequence ?? null,
      submittedAt: request.submittedAt,
      totalGatingSteps: progress?.totalGatingSteps ?? null,
    };
  });

  // Status counts describe the PHOENIX side only. Counting them across all 218 rows would report
  // "101 approved" from a June spreadsheet import as if it were live Phoenix work.
  const phoenixRows = rows.filter((row) => row.isPhoenixSubmission);

  return {
    rows,
    summary: {
      approved: phoenixRows.filter((row) => approvedMarketingRequestStatuses.includes(row.status)).length,
      imported: rows.length - phoenixRows.length,
      inApproval: phoenixRows.filter((row) => row.status === "pending_approval").length,
      phoenix: phoenixRows.length,
      returned: phoenixRows.filter((row) => row.status === "returned").length,
      total: rows.length,
    },
  };
}

export async function getMarketingRequestDraftWorkspace(access: AccessContext): Promise<MarketingRequestDraftWorkspace> {
  assertMarketingWorkspaceAccess(access);

  const supabase = getSupabaseAdmin();
  const [typesResult, productsResult, distributorsResult, customersResult, validatedLinksResult, draftsResult, approvedRequestsResult, pharmaciesResult, distributorCodesResult, returnedResult, inApprovalResult] = await Promise.all([
    supabase.from("marketing_request_types").select("*").or("active.is.null,active.eq.true").order("sort_order"),
    supabase.from("marketing_products").select("*").or("active.is.null,active.eq.true").order("product_name"),
    supabase.from("marketing_distributors").select("*").or("active.is.null,active.eq.true").order("display_name"),
    supabase.from("marketing_customers").select("*").or("active.is.null,active.eq.true").order("display_name"),
    // Also carries the pharmacy detail now, not just customer_id: the request form has to let the
    // requester CHOOSE which pharmacies a campaign targets. Until it could, every Phoenix request
    // was saved with no targets at all — and a request with no target pharmacies can never
    // attribute a single sale, so its ROI would read zero forever no matter how well it performed.
    // A customer has at most 8 linked pharmacies in production (median 1-3), so this is a handful
    // of extra rows, not a second data set.
    supabase
      .from("marketing_customer_pharmacies")
      .select("customer_id, distributor_code_id, pharmacy_id")
      .or("active.is.null,active.eq.true")
      .in("validation_status", ["system_validated", "sfe_validated"]),
    supabase.from("marketing_requests").select("*").eq("status", "draft").order("created_at", { ascending: false }).limit(MARKETING_WORKSPACE_SAFETY_LIMIT),
    supabase
      .from("marketing_requests")
      .select("*")
      .in("status", approvedMarketingRequestStatuses)
      .order("pay_date", { ascending: false, nullsFirst: false })
      .limit(MARKETING_WORKSPACE_SAFETY_LIMIT),
    // Display data for the target-pharmacy picker. Both tables are small reference sets.
    supabase.from("marketing_pharmacies").select("id, display_name, pharmacy_code"),
    supabase
      .from("marketing_pharmacy_distributor_codes")
      .select("id, pharmacy_id, distributor_id, distributor_pharmacy_code, reference_status")
      .or("active.is.null,active.eq.true"),
    supabase.from("marketing_requests").select("*").eq("status", "returned").order("updated_at", { ascending: false }).limit(MARKETING_WORKSPACE_SAFETY_LIMIT),
    supabase.from("marketing_requests").select("*").eq("status", "pending_approval").order("submitted_at", { ascending: false, nullsFirst: false }).limit(MARKETING_WORKSPACE_SAFETY_LIMIT),
  ]);

  if (typesResult.error) throw typesResult.error;
  if (productsResult.error) throw productsResult.error;
  if (distributorsResult.error) throw distributorsResult.error;
  if (customersResult.error) throw customersResult.error;
  if (validatedLinksResult.error) throw validatedLinksResult.error;
  if (draftsResult.error) throw draftsResult.error;
  if (approvedRequestsResult.error) throw approvedRequestsResult.error;
  if (returnedResult.error) throw returnedResult.error;
  if (inApprovalResult.error) throw inApprovalResult.error;

  const [employeeRows, rawProductOverride] = await Promise.all([
    loadEmployeeDirectoryRows(),
    getUserProductScopeOverride(access.loginId ?? ""),
  ]);
  const allowedProductCodes: Set<string> | null = rawProductOverride === null
    ? null
    : new Set(rawProductOverride.map((c) => c.trim().toUpperCase()));

  // Read-only surface: a valid reviewer may not be a directory requester. Degrade the
  // creation affordance gracefully instead of failing the whole workspace with a 400.
  const requester = tryFindRequester(access, employeeRows);
  const productScope = buildMarketingDraftProductScope({
    access,
    productRows: (productsResult.data ?? []) as MarketingProductDbRow[],
    requester,
    allowedProductCodes,
  });
  // The personal "Marketing Requests" workspace (Create / Approved / Tracking tabs) is a
  // *my own requests* surface. Company-wide oversight roles (Marketing Manager, SFE Manager,
  // CEO, Finance, Super Admin) have unbounded visibility, which would otherwise flood their
  // personal Drafts / In-approval / Returned / Approved lists with EVERY request in the
  // company. Company-wide monitoring belongs on Control / Inbox / ROI Tracking — so here we
  // narrow these personal lists to the requests the viewer personally submitted. Line/team
  // roles keep their existing bounded subtree visibility.
  const scopeTrackingToOwnRequests =
    companyMarketingRoles.has(access.role) || access.scope === "system";
  const ownsMarketingRequest = (request: MarketingRequest) =>
    normalizeHrId(request.requesterHrId) === normalizeHrId(access.hrId);
  const narrowToOwnRequests = (requests: MarketingRequest[]) =>
    scopeTrackingToOwnRequests ? requests.filter(ownsMarketingRequest) : requests;

  const passesHierarchyCheck = (row: MarketingRequestDbRow) =>
    canSeeMarketingRequest(access, row, employeeRows);

  const allVisibleRows = [
    ...((draftsResult.data ?? []) as MarketingRequestDbRow[]).filter(passesHierarchyCheck),
    ...((approvedRequestsResult.data ?? []) as MarketingRequestDbRow[]).filter(passesHierarchyCheck),
    ...((returnedResult.data ?? []) as MarketingRequestDbRow[]).filter(passesHierarchyCheck),
    ...((inApprovalResult.data ?? []) as MarketingRequestDbRow[]).filter(passesHierarchyCheck),
  ];
  // Batch-load product codes for product-code-restricted viewers (e.g. Ahmed Sharaf).
  const productCodeFilter = makeProductCodeFilter(allowedProductCodes);
  let productCodesByRequestId = new Map<string, Set<string>>();
  if (allowedProductCodes !== null) {
    const allIds = [...new Set(allVisibleRows.map((r) => r.id))];
    productCodesByRequestId = await loadProductCodesByRequestId(supabase, allIds);
  }
  const passesProductFilter = (row: MarketingRequestDbRow) =>
    productCodeFilter(row.id, productCodesByRequestId);

  const drafts = narrowToOwnRequests(
    ((draftsResult.data ?? []) as MarketingRequestDbRow[])
      .filter(passesHierarchyCheck)
      .filter(passesProductFilter)
      .map(mapRequest),
  );
  const approvedRequests = narrowToOwnRequests(
    ((approvedRequestsResult.data ?? []) as MarketingRequestDbRow[])
      .filter(passesHierarchyCheck)
      .filter(passesProductFilter)
      .map(mapRequest),
  );
  const returned = narrowToOwnRequests(
    ((returnedResult.data ?? []) as MarketingRequestDbRow[])
      .filter(passesHierarchyCheck)
      .filter(passesProductFilter)
      .map(mapRequest),
  );
  const inApproval = narrowToOwnRequests(
    ((inApprovalResult.data ?? []) as MarketingRequestDbRow[])
      .filter(passesHierarchyCheck)
      .filter(passesProductFilter)
      .map(mapRequest),
  );

  // Batch-load approval steps for every in-flight request so the tracking UI can
  // show "currently with <step> — <approver>" without an N+1 query per request.
  const trackedRequestIds = Array.from(new Set([...inApproval, ...returned].map((request) => request.id)));
  const stepProgressByRequestId: Record<string, MarketingRequestStepProgress> = {};
  if (trackedRequestIds.length > 0) {
    const stepsByRequest = new Map<string, MarketingRequestApprovalStep[]>();
    for (const batch of chunk(trackedRequestIds)) {
      const trackedStepsResult = await supabase
        .from("marketing_request_approval_steps")
        .select("*")
        .in("request_id", batch)
        .order("sequence", { ascending: true });
      if (trackedStepsResult.error) throw trackedStepsResult.error;
      for (const row of (trackedStepsResult.data ?? []) as MarketingRequestApprovalStepDbRow[]) {
        const step = mapApprovalStep(row);
        const bucket = stepsByRequest.get(step.requestId) ?? [];
        bucket.push(step);
        stepsByRequest.set(step.requestId, bucket);
      }
    }
    for (const [requestId, requestSteps] of stepsByRequest) {
      const progress = buildMarketingStepProgress(requestSteps, employeeRows);
      if (progress) stepProgressByRequestId[requestId] = progress;
    }
  }
  const approvedRequestIds = approvedRequests.map((request) => request.id);
  const financeRequirementsResult = approvedRequestIds.length > 0
    ? await supabase
      .from("marketing_request_finance_requirements")
      .select("*")
      .in("request_id", approvedRequestIds)
    : { data: [], error: null };
  if (financeRequirementsResult.error) throw financeRequirementsResult.error;

  const validatedCustomerIds = new Set(
    ((validatedLinksResult.data ?? []) as Array<{ customer_id: string }>).map((row) => row.customer_id),
  );

  // Target-pharmacy options, grouped by customer, so the form can offer exactly the pharmacies
  // that belong to the customer being requested for. In production a customer has 1-8 of them,
  // which is why this is a short explicit list rather than a search over the 45k-row master.
  if (pharmaciesResult.error) throw pharmaciesResult.error;
  if (distributorCodesResult.error) throw distributorCodesResult.error;
  const pharmacyNameById = new Map(
    ((pharmaciesResult.data ?? []) as Array<{ id: string; display_name: string | null; pharmacy_code: string | null }>)
      .map((row) => [row.id, { code: row.pharmacy_code ?? "", name: row.display_name ?? "" }] as const),
  );
  const distributorNameById = new Map(
    ((distributorsResult.data ?? []) as MarketingDistributorDbRow[]).map((row) => [Number(row.id), row.display_name]),
  );
  const codeById = new Map(
    ((distributorCodesResult.data ?? []) as Array<{
      id: string; pharmacy_id: string; distributor_id: number | string;
      distributor_pharmacy_code: string | null; reference_status: MarketingPharmacyCodeReferenceStatus | null;
    }>).map((row) => [row.id, row] as const),
  );

  const pharmaciesByCustomer: Record<string, MarketingRequestPharmacyOption[]> = {};
  for (const link of (validatedLinksResult.data ?? []) as Array<{
    customer_id: string; distributor_code_id: string; pharmacy_id: string;
  }>) {
    const code = codeById.get(link.distributor_code_id);
    if (!code) continue;
    const pharmacy = pharmacyNameById.get(link.pharmacy_id);
    const list = pharmaciesByCustomer[link.customer_id] ?? [];
    list.push({
      distributorCodeId: link.distributor_code_id,
      distributorName: distributorNameById.get(Number(code.distributor_id)) ?? "Unknown distributor",
      pharmacyCode: code.distributor_pharmacy_code ?? "",
      pharmacyName: pharmacy?.name || pharmacy?.code || "Unnamed pharmacy",
      // Surfaced so the form can warn BEFORE submission rather than the server refusing after.
      referenceStatus: code.reference_status ?? "pending",
    });
    pharmaciesByCustomer[link.customer_id] = list;
  }
  const allCustomerRows = (customersResult.data ?? []) as MarketingCustomerDbRow[];
  const allCustomers = allCustomerRows.map(mapCustomer);
  const customers = allCustomerRows
    .filter((row) => validatedCustomerIds.has(row.id))
    .filter((row) => canSeeMarketingCustomer(access, row, employeeRows))
    .map(mapCustomer);

  return {
    approvedRequests: buildMarketingApprovedRequestRows({
      customers: allCustomers,
      employeeRows,
      financeRequirements: ((financeRequirementsResult.data ?? []) as MarketingRequestFinanceRequirementDbRow[]).map(mapFinanceRequirement),
      requests: approvedRequests,
    }),
    canCreateDraft: productScope.canCreateDraft,
    customers,
    pharmaciesByCustomer,
    distributors: ((distributorsResult.data ?? []) as MarketingDistributorDbRow[]).map(mapDistributor),
    drafts,
    inApproval,
    products: productScope.products,
    requestTypes: ((typesResult.data ?? []) as MarketingRequestTypeDbRow[]).map(mapRequestType),
    requesterLineId: productScope.requesterLineId,
    requesterLineName: productScope.requesterLineName,
    returned,
    // Only requests the current user personally submitted may be edited after a return.
    // Managers can see their team's returned requests above (read-only) but must never
    // get an edit button on another employee's submission.
    returnedToMe: returned.filter((req) => normalizeHrId(req.requesterHrId) === normalizeHrId(access.hrId)),
    stepProgressByRequestId,
  };
}

export async function createMarketingRequestDraft(
  input: MarketingRequestCreateDraft,
  access: AccessContext,
  options: CreateDraftOptions = {},
): Promise<MarketingRequestDraftDetail> {
  assertMarketingAccess(access);
  await assertMarketingWorkflowTransition({
    access,
    actionKey: "create_draft",
    expectedNextStatus: "draft",
    status: "draft",
  });

  const supabase = options.supabase ?? getSupabaseAdmin();
  const employeeRows = options.employeeRows ?? await loadEmployeeDirectoryRows();
  const requester = findRequester(access, employeeRows);
  const allowedProductCodes = toProductCodeSet(await getUserProductScopeOverride(access.loginId ?? ""));
  const normalized = normalizeMarketingRequestDraftInput(input);

  const [customerResult, requestTypeResult, contactResult, productRows, pharmacyCodes] = await Promise.all([
    supabase
      .from("marketing_customers")
      .select("id, owner_hr_id, manager_hr_id, line_id, area_id, active")
      .eq("id", normalized.customerId)
      .maybeSingle(),
    supabase
      .from("marketing_request_types")
      .select("id, code, name, description, requires_description, sort_order, active")
      .eq("id", normalized.requestTypeId)
      .maybeSingle(),
    normalized.customerContactId
      ? supabase
        .from("marketing_customer_contacts")
        .select("id, customer_id, active")
        .eq("id", normalized.customerContactId)
        .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    fetchActiveProducts(supabase, normalized.products.map((product) => product.productId)),
    fetchPharmacyCodes(supabase, normalized.pharmacies.map((pharmacy) => pharmacy.distributorCodeId)),
  ]);

  if (customerResult.error) throw customerResult.error;
  if (requestTypeResult.error) throw requestTypeResult.error;
  if (contactResult.error) throw contactResult.error;
  if (!customerResult.data) throw notFoundError("Customer was not found.", "customer_not_found");
  if (!requestTypeResult.data) throw notFoundError("Request type was not found.", "request_type_not_found");

  const contact = contactResult.data as MarketingCustomerContactDbRow | null;
  if (contact && (contact.active === false || contact.customer_id !== normalized.customerId)) {
    throw validationError("Customer contact does not belong to the selected customer.");
  }

  const validatedCustomerLinkResult = await supabase
    .from("marketing_customer_pharmacies")
    .select("id")
    .eq("customer_id", normalized.customerId)
    .eq("active", true)
    .in("validation_status", ["system_validated", "sfe_validated"])
    .limit(1);
  if (validatedCustomerLinkResult.error) throw validatedCustomerLinkResult.error;
  if ((validatedCustomerLinkResult.data ?? []).length === 0) {
    throw validationError("Only validated customers can be used in marketing request drafts.", "customer_not_validated");
  }

  const prepared = prepareMarketingRequestDraft({
    customer: customerResult.data as MarketingCustomerDbRow,
    input,
    pharmacyCodes,
    products: productRows,
    requestType: requestTypeResult.data as MarketingRequestTypeDbRow,
    requester,
    unrestrictedProductLines: canUseAnyMarketingProductLine(access),
    allowedProductCodes,
  });

  const requestInsert = await supabase
    .from("marketing_requests")
    .insert(prepared.requestRow)
    .select("*")
    .single();
  if (requestInsert.error) throw requestInsert.error;

  let request = mapRequest(requestInsert.data as MarketingRequestDbRow);

  try {
    const productInsertRows = prepared.productRows.map((row) => ({
      ...row,
      request_id: request.id,
    }));
    const productsInsert = await supabase
      .from("marketing_request_products")
      .insert(productInsertRows)
      .select("*");
    if (productsInsert.error) throw productsInsert.error;

    const pharmacyInsertRows = prepared.pharmacyRows.map((row) => ({
      ...row,
      request_id: request.id,
    }));
    let pharmacies: MarketingRequestPharmacy[] = [];
    if (pharmacyInsertRows.length > 0) {
      const pharmaciesInsert = await supabase
        .from("marketing_request_pharmacies")
        .insert(pharmacyInsertRows)
        .select("*");
      if (pharmaciesInsert.error) throw pharmaciesInsert.error;
      pharmacies = ((pharmaciesInsert.data ?? []) as MarketingRequestPharmacyDbRow[]).map(mapPharmacy);
    }

    const steps = await createMarketingApprovalSteps({ employeeRows, request, supabase });
    const now = new Date().toISOString();
    const requestUpdate = await supabase
      .from("marketing_requests")
      .update({
        status: "pending_approval",
        submitted_at: now,
        updated_at: now,
        updated_by_hr_id: request.requesterHrId,
      })
      .eq("id", request.id)
      .select("*")
      .single();
    if (requestUpdate.error) throw requestUpdate.error;
    request = mapRequest(requestUpdate.data as MarketingRequestDbRow);

    const draftDetail = {
      ...request,
      pharmacies,
      products: ((productsInsert.data ?? []) as MarketingRequestProductDbRow[]).map(mapProduct),
    };
    const requestType = requestTypeResult.data as MarketingRequestTypeDbRow;
    const currentStep = steps.find((step) => step.status === "current");
    if (currentStep) {
      await notifyMarketingWorkflow({
        actorHrId: request.requesterHrId,
        eventType: "request_assigned",
        message: `${request.requestCode} is waiting for ${currentStep.stepName}.`,
        metadata: {
          assignedApproverHrId: currentStep.assignedHrId,
          currentStepId: currentStep.id,
          currentStepName: currentStep.stepName,
          customerId: request.customerId,
          requestType: requestType.name,
          workflowApproverHrId: currentStep.assignedHrId,
        },
        request,
        title: "Marketing request assigned",
      });
    }
    const submittedContext = buildMarketingEmailContext({
      currentStepName: currentStep?.stepName ?? null,
      customerName: cleanText((customerResult.data as { display_name?: string | null } | null)?.display_name),
      products: draftDetail.products,
      request,
    });
    const requesterDisplayName = employeeNameByHrId(employeeRows, request.requesterHrId) || request.requesterHrId;
    await createSystemNotification({
      actionUrl: marketingActionUrl(request.id),
      actorId: request.requesterHrId,
      email: {
        metrics: [
          { label: "Employee", value: `${requesterDisplayName} (${request.requesterHrId})` },
        ],
        templateContext: submittedContext,
      },
      eventType: "request_submitted",
      message: `${request.requestCode} was submitted by ${requesterDisplayName}.`,
      metadata: {
        customerId: request.customerId,
        idempotencyKey: `marketing-request-submitted:${request.id}`,
        requestOwnerHrId: request.requesterHrId,
        workflowApproverHrId: currentStep?.assignedHrId ?? null,
        ...marketingNotificationVariables({ currentStep, employeeRows, request, requestTypeName: requestType.name }),
      },
      module: "marketing_requests",
      priority: "high",
      recordId: request.id,
      subjectHrId: request.requesterHrId,
      title: "Marketing request submitted",
    }).catch((error: unknown) => logNotificationSendFailure("marketingRequests.createMarketingRequestDraft.submitted", error));

    pingMarketingRequestSheet("request_submitted");
    return draftDetail;
  } catch (error) {
    await supabase.from("marketing_requests").delete().eq("id", request.id);
    throw error;
  }
}

/**
 * Edit a returned marketing request and resubmit it. Resumes at the step that returned
 * it (earlier approvals preserved), replacing the products/pharmacies with the edited set.
 */
export async function resubmitReturnedMarketingRequest(
  input: MarketingRequestCreateDraft & { requestId: string },
  access: AccessContext,
): Promise<MarketingRequestDraftDetail> {
  assertMarketingAccess(access);
  const requestId = cleanText(input.requestId);
  if (!requestId) throw validationError("Marketing request ID is required.");

  const supabase = getSupabaseAdmin();
  const employeeRows = await loadEmployeeDirectoryRows();
  const requester = findRequester(access, employeeRows);
  const allowedProductCodes = toProductCodeSet(await getUserProductScopeOverride(access.loginId ?? ""));

  const existing = await loadMarketingRequestById(supabase, requestId);
  if (existing.status !== "returned") {
    throw conflictError("Only a returned marketing request can be resubmitted.");
  }
  if (normalizeHrId(existing.requesterHrId) !== normalizeHrId(requester.hrId)) {
    throw forbiddenError("Forbidden: only the requester can resubmit this marketing request.");
  }

  const normalized = normalizeMarketingRequestDraftInput(input);
  const [customerResult, requestTypeResult, contactResult, productRows, pharmacyCodes] = await Promise.all([
    supabase.from("marketing_customers").select("id, owner_hr_id, manager_hr_id, line_id, area_id, active").eq("id", normalized.customerId).maybeSingle(),
    supabase.from("marketing_request_types").select("id, code, name, description, requires_description, sort_order, active").eq("id", normalized.requestTypeId).maybeSingle(),
    normalized.customerContactId
      ? supabase.from("marketing_customer_contacts").select("id, customer_id, active").eq("id", normalized.customerContactId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    fetchActiveProducts(supabase, normalized.products.map((product) => product.productId)),
    fetchPharmacyCodes(supabase, normalized.pharmacies.map((pharmacy) => pharmacy.distributorCodeId)),
  ]);
  if (customerResult.error) throw customerResult.error;
  if (requestTypeResult.error) throw requestTypeResult.error;
  if (contactResult.error) throw contactResult.error;
  if (!customerResult.data) throw notFoundError("Customer was not found.", "customer_not_found");
  if (!requestTypeResult.data) throw notFoundError("Request type was not found.", "request_type_not_found");
  const contact = contactResult.data as MarketingCustomerContactDbRow | null;
  if (contact && (contact.active === false || contact.customer_id !== normalized.customerId)) {
    throw validationError("Customer contact does not belong to the selected customer.");
  }

  const prepared = prepareMarketingRequestDraft({
    customer: customerResult.data as MarketingCustomerDbRow,
    input,
    pharmacyCodes,
    products: productRows,
    requestCode: existing.requestCode,
    requestType: requestTypeResult.data as MarketingRequestTypeDbRow,
    requester,
    unrestrictedProductLines: canUseAnyMarketingProductLine(access),
    allowedProductCodes,
  });

  const steps = await loadMarketingRequestApprovalSteps(supabase, requestId);
  const resumeStep = steps
    .filter((step) => step.status === "returned")
    .sort((left, right) => left.sequence - right.sequence)[0]
    ?? steps.filter((step) => !step.isCc).sort((left, right) => left.sequence - right.sequence)[0]
    ?? null;
  if (!resumeStep) throw conflictError("This marketing request has no approval step to resume.");

  const now = new Date().toISOString();

  const deleteProducts = await supabase.from("marketing_request_products").delete().eq("request_id", requestId);
  if (deleteProducts.error) throw deleteProducts.error;
  const productsInsert = await supabase
    .from("marketing_request_products")
    .insert(prepared.productRows.map((row) => ({ ...row, request_id: requestId })))
    .select("*");
  if (productsInsert.error) throw productsInsert.error;

  const deletePharmacies = await supabase.from("marketing_request_pharmacies").delete().eq("request_id", requestId);
  if (deletePharmacies.error) throw deletePharmacies.error;
  let pharmacies: MarketingRequestPharmacy[] = [];
  const pharmacyInsertRows = prepared.pharmacyRows.map((row) => ({ ...row, request_id: requestId }));
  if (pharmacyInsertRows.length > 0) {
    const pharmaciesInsert = await supabase.from("marketing_request_pharmacies").insert(pharmacyInsertRows).select("*");
    if (pharmaciesInsert.error) throw pharmaciesInsert.error;
    pharmacies = ((pharmaciesInsert.data ?? []) as MarketingRequestPharmacyDbRow[]).map(mapPharmacy);
  }

  const reopen = await supabase
    .from("marketing_request_approval_steps")
    .update({ decision_at: null, decision_by_hr_id: null, decision_note: null, status: "current", updated_at: now })
    .eq("id", resumeStep.id)
    .select("*")
    .single();
  if (reopen.error) throw reopen.error;
  const currentStep = mapApprovalStep(reopen.data as MarketingRequestApprovalStepDbRow);

  const requestUpdate = await supabase
    .from("marketing_requests")
    .update({
      area_id: prepared.requestRow.area_id,
      customer_contact_id: prepared.requestRow.customer_contact_id,
      customer_id: prepared.requestRow.customer_id,
      estimated_cost: prepared.requestRow.estimated_cost,
      expected_roi_value: prepared.requestRow.expected_roi_value,
      line_id: prepared.requestRow.line_id,
      notes: prepared.requestRow.notes,
      other_request_type: prepared.requestRow.other_request_type,
      pay_date: prepared.requestRow.pay_date,
      request_type_id: prepared.requestRow.request_type_id,
      returned_at: null,
      returned_step_sequence: null,
      roi_duration_months: prepared.requestRow.roi_duration_months,
      roi_status: prepared.requestRow.roi_status,
      status: "pending_approval",
      submitted_at: now,
      updated_at: now,
      updated_by_hr_id: requester.hrId,
    })
    .eq("id", requestId)
    .select("*")
    .single();
  if (requestUpdate.error) throw requestUpdate.error;
  const request = mapRequest(requestUpdate.data as MarketingRequestDbRow);

  const requestTypeName = (requestTypeResult.data as MarketingRequestTypeDbRow).name;
  const ccHrIds = steps
    .filter((step) => step.isCc && step.stepCode === currentStep.stepCode)
    .map((step) => step.assignedHrId)
    .filter((hrId): hrId is string => Boolean(hrId));
  await notifyMarketingWorkflow({
    actorHrId: requester.hrId,
    ccHrIds,
    eventType: "request_assigned",
    message: `${request.requestCode} was resubmitted and is waiting for ${currentStep.stepName}.`,
    metadata: {
      assignedApproverHrId: currentStep.assignedHrId,
      currentStepId: currentStep.id,
      currentStepName: currentStep.stepName,
      idempotencyEpoch: now,
      workflowApproverHrId: currentStep.assignedHrId,
      ...marketingNotificationVariables({ currentStep, employeeRows, request, requestTypeName }),
    },
    priority: "high",
    request,
    title: "Marketing request resubmitted",
  });

  const resubmitted = {
    ...request,
    pharmacies,
    products: ((productsInsert.data ?? []) as MarketingRequestProductDbRow[]).map(mapProduct),
  };
  pingMarketingRequestSheet("request_resubmitted");
  return resubmitted;
}

/** Approver inbox: marketing requests awaiting the current user's decision. */
export async function getApproverPendingRequests(access: AccessContext): Promise<MarketingApproverInboxWorkspace> {
  const actorHrId = requireMarketingDecisionActor(access);
  const supabase = getSupabaseAdmin();

  // Gating steps the actor must decide, and CC steps the actor may comment on (non-blocking).
  // `assigned_hr_id` is stored in the employee master's real casing, while the session id is
  // lower-cased — match every HR_ID dialect so the inbox is not silently empty for an approver.
  const actorHrKeys = hrIdLookupKeys(actorHrId);
  const [gatingResult, ccResult, upcomingResult] = await Promise.all([
    supabase
      .from("marketing_request_approval_steps")
      .select("*")
      .eq("status", "current")
      .eq("is_cc", false)
      .in("assigned_hr_id", actorHrKeys),
    supabase
      .from("marketing_request_approval_steps")
      .select("*")
      .eq("is_cc", true)
      .in("assigned_hr_id", actorHrKeys),
    // Steps that are MINE but have not opened yet — the request is heading toward me. Without
    // this the inbox is blank for every approver above rung 1 until the moment they are needed,
    // which is exactly when it is too late to have been watching.
    supabase
      .from("marketing_request_approval_steps")
      .select("*")
      .eq("status", "pending")
      .eq("is_cc", false)
      .in("assigned_hr_id", actorHrKeys),
  ]);
  if (gatingResult.error) throw gatingResult.error;
  if (ccResult.error) throw ccResult.error;
  if (upcomingResult.error) throw upcomingResult.error;
  const gatingSteps = ((gatingResult.data ?? []) as MarketingRequestApprovalStepDbRow[]).map(mapApprovalStep);
  const ccSteps = ((ccResult.data ?? []) as MarketingRequestApprovalStepDbRow[]).map(mapApprovalStep);
  const upcomingSteps = ((upcomingResult.data ?? []) as MarketingRequestApprovalStepDbRow[]).map(mapApprovalStep);
  if (gatingSteps.length === 0 && ccSteps.length === 0 && upcomingSteps.length === 0) {
    return { advisoryRows: [], rows: [], upcomingRows: [] };
  }

  // A CC reviewer may comment only while the gating step it is attached to is the current one.
  const ccRequestIds = Array.from(new Set(ccSteps.map((step) => step.requestId)));
  const currentStepCodeByRequest = new Map<string, string>();
  if (ccRequestIds.length > 0) {
    const currentResult = await supabase
      .from("marketing_request_approval_steps")
      .select("request_id, step_code")
      .in("request_id", ccRequestIds)
      .eq("status", "current")
      .eq("is_cc", false);
    if (currentResult.error) throw currentResult.error;
    for (const row of (currentResult.data ?? []) as Array<{ request_id: string; step_code: string }>) {
      currentStepCodeByRequest.set(row.request_id, row.step_code);
    }
  }
  const activeCcSteps = ccSteps.filter((step) => currentStepCodeByRequest.get(step.requestId) === step.stepCode);

  const requestIds = Array.from(
    new Set([...gatingSteps, ...activeCcSteps, ...upcomingSteps].map((step) => step.requestId)),
  );
  if (requestIds.length === 0) return { advisoryRows: [], rows: [], upcomingRows: [] };

  // Every gating step of the upcoming requests, so each row can name WHERE it is stopped and how
  // far along it is. Loaded once for the whole set rather than per request.
  const allStepsByRequest = new Map<string, MarketingRequestApprovalStep[]>();
  for (const batch of chunk(requestIds)) {
    const stepsResult = await supabase
      .from("marketing_request_approval_steps")
      .select("*")
      .in("request_id", batch)
      .eq("is_cc", false);
    if (stepsResult.error) throw stepsResult.error;
    for (const row of (stepsResult.data ?? []) as MarketingRequestApprovalStepDbRow[]) {
      const step = mapApprovalStep(row);
      allStepsByRequest.set(step.requestId, [...(allStepsByRequest.get(step.requestId) ?? []), step]);
    }
  }
  const [requestsResult, employeeRows] = await Promise.all([
    supabase.from("marketing_requests").select("*").in("id", requestIds).eq("status", "pending_approval"),
    loadEmployeeDirectoryRows(),
  ]);
  if (requestsResult.error) throw requestsResult.error;
  const requestById = new Map(((requestsResult.data ?? []) as MarketingRequestDbRow[]).map((row) => {
    const request = mapRequest(row);
    return [request.id, request] as const;
  }));

  const requests = Array.from(requestById.values());
  const customerIds = Array.from(new Set(requests.map((request) => request.customerId)));
  const typeIds = Array.from(new Set(requests.map((request) => request.requestTypeId)));
  const [customersResult, typesResult] = await Promise.all([
    customerIds.length > 0
      ? supabase.from("marketing_customers").select("id, display_name").in("id", customerIds)
      : Promise.resolve({ data: [], error: null }),
    typeIds.length > 0
      ? supabase.from("marketing_request_types").select("id, name").in("id", typeIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (customersResult.error) throw customersResult.error;
  if (typesResult.error) throw typesResult.error;
  const customerNameById = new Map(((customersResult.data ?? []) as Array<{ id: string; display_name?: string | null }>)
    .map((row) => [row.id, cleanText(row.display_name) ?? row.id] as const));
  const typeNameById = new Map(((typesResult.data ?? []) as Array<{ id: number | string; name?: string | null }>)
    .map((row) => [Number(row.id), cleanText(row.name) ?? "Marketing request"] as const));

  const buildRow = (step: MarketingRequestApprovalStep, request: MarketingRequest): MarketingApproverInboxRow => ({
    allowReject: step.allowReject,
    allowReturn: step.allowReturn,
    approvalHistory: buildMarketingApproverChain(
      allStepsByRequest.get(request.id) ?? [],
      employeeRows,
      step.id,
    ),
    currentStepName: step.stepName,
    customerName: customerNameById.get(request.customerId) ?? request.customerId,
    decisionLabels: step.decisionLabels ?? normalizeMarketingDecisionLabels(null),
    estimatedCost: request.estimatedCost,
    id: request.id,
    payDate: request.payDate,
    requestCode: request.requestCode,
    requesterHrId: request.requesterHrId,
    requesterName: employeeNameByHrId(employeeRows, request.requesterHrId),
    requesterRole: employeeRoleByHrId(employeeRows, request.requesterHrId),
    requestType: typeNameById.get(request.requestTypeId) ?? "Marketing request",
    status: request.status,
    stepSequence: step.sequence,
    submittedAt: request.submittedAt,
  });

  const rows: MarketingApproverInboxRow[] = [];
  for (const step of gatingSteps) {
    const request = requestById.get(step.requestId);
    if (request) rows.push(buildRow(step, request));
  }
  const advisoryRows: MarketingApproverInboxRow[] = [];
  for (const step of activeCcSteps) {
    const request = requestById.get(step.requestId);
    if (request) advisoryRows.push(buildRow(step, request));
  }
  const upcomingRows: MarketingApproverUpcomingRow[] = [];
  for (const step of upcomingSteps) {
    const request = requestById.get(step.requestId);
    if (!request) continue;
    const chain = (allStepsByRequest.get(step.requestId) ?? []).sort((left, right) => left.sequence - right.sequence);
    const holder = chain.find((chainStep) => chainStep.status === "current") ?? null;
    // Age is measured from SUBMISSION, not from when it reached the current holder: the question
    // an approver waiting downstream is asking is "how long has this been in the system?".
    const submittedAtMs = request.submittedAt ? Date.parse(request.submittedAt) : Number.NaN;
    const ageDays = Number.isFinite(submittedAtMs)
      ? Math.max(0, Math.floor((Date.now() - submittedAtMs) / 86_400_000))
      : 0;

    upcomingRows.push({
      ...buildRow(step, request),
      ageDays,
      awaitingApproverName: holder ? employeeNameByHrId(employeeRows, holder.assignedHrId) : null,
      awaitingStepName: holder?.stepName ?? null,
      myStepSequence: step.sequence,
      totalGatingSteps: chain.length,
    });
  }

  const bySubmittedAt = (left: MarketingApproverInboxRow, right: MarketingApproverInboxRow) =>
    (left.submittedAt ?? "").localeCompare(right.submittedAt ?? "");
  rows.sort(bySubmittedAt);
  advisoryRows.sort(bySubmittedAt);
  // Oldest first — a request that has been sitting longest is the one worth chasing.
  upcomingRows.sort((left, right) => right.ageDays - left.ageDays);
  return { advisoryRows, rows, upcomingRows };
}

// ── Sidebar pending-count badge ──────────────────────────────────────────────
// Marketing is deliberately excluded from the consolidated approvals hub (see the comment in
// src/lib/action-center/service.ts) — it keeps its own dedicated inbox — so "approvals-hub-pending"
// can never count a marketing item. This is the marketing equivalent of getVacationAwaitingBadge /
// getPlanAwaitingBadge in src/lib/approvals-hub/service.ts, feeding the same NavBadge pump.

/** The subset of a gating approval step the badge needs — nothing that would identify a request. */
export type MarketingApproverBadgeStep = {
  createdAt: string | null;
  requestId: string;
  stepCode: string;
  updatedAt: string | null;
  workflowStepId: number | null;
};

export type MarketingApproverBadge = { count: number; overdue: boolean };

/**
 * Pure badge reducer, split out from the query so the counting rule is unit-testable without a
 * database. Two things it must get right, both of which the inbox itself already enforces:
 *
 *  - ONLY gating steps count. CC/advisory steps are non-blocking comments and upcoming steps are
 *    not yet this person's decision, so neither is "action required" — a badge that counted them
 *    would pump orange at someone with nothing to do.
 *  - A gating step whose request has left `pending_approval` does NOT count. getApproverPendingRequests
 *    drops exactly these rows (its request lookup filters on that status), so counting them here
 *    would show a number the inbox cannot explain.
 *
 * Overdue: each step's own `marketing_workflow_steps.default_sla_days`, measured from the step's
 * last status change — the same "waiting since" clock the daily SLA scan uses (see
 * classifyMarketingWaitingSla). A step whose SLA is null contributes NO overdue signal rather than
 * being treated as 0 days, which would make every request instantly overdue.
 */
export function summarizeMarketingApproverBadge(input: {
  gatingSteps: MarketingApproverBadgeStep[];
  liveRequestIds: Iterable<string>;
  now: string;
  slaDaysByStepCode?: ReadonlyMap<string, number | null>;
  slaDaysByWorkflowStepId?: ReadonlyMap<number, number | null>;
}): MarketingApproverBadge {
  const live = input.liveRequestIds instanceof Set ? input.liveRequestIds : new Set(input.liveRequestIds);
  const counted = input.gatingSteps.filter((step) => live.has(step.requestId));
  const overdue = counted.some((step) => {
    const slaDays =
      (step.workflowStepId === null ? undefined : input.slaDaysByWorkflowStepId?.get(step.workflowStepId)) ??
      input.slaDaysByStepCode?.get(step.stepCode) ??
      null;
    if (slaDays === null || !Number.isFinite(slaDays) || slaDays <= 0) return false;
    const daysWaiting = marketingDaysWaiting(step.updatedAt ?? step.createdAt, input.now);
    if (daysWaiting === null) return false;
    return slaTone(daysWaiting, slaDays) === "overdue";
  });
  return { count: counted.length, overdue };
}

/**
 * Sidebar badge for the Marketing Approval Inbox: how many marketing requests are stopped at THIS
 * person's own gating step. Scoped entirely by `assigned_hr_id`, so it needs no separate permission
 * gate beyond a linked HR identity — an approver can only ever count their own rung.
 *
 * Deliberately does NOT call getApproverPendingRequests: that builds full display rows (employee
 * directory, customers, request types, the whole upcoming chain) for a number that is polled every
 * 30 seconds by every open tab.
 */
export async function getMarketingApproverBadge(access: AccessContext): Promise<MarketingApproverBadge> {
  const actorHrId = requireMarketingDecisionActor(access);
  const supabase = getSupabaseAdmin();
  // Same HR_ID dialect expansion as the inbox — `assigned_hr_id` carries the employee master's real
  // casing while the session id is lower-cased, so an exact match silently returns nothing.
  const actorHrKeys = hrIdLookupKeys(actorHrId);

  const gatingResult = await supabase
    .from("marketing_request_approval_steps")
    .select("request_id, step_code, workflow_step_id, created_at, updated_at")
    .eq("status", "current")
    .eq("is_cc", false)
    .in("assigned_hr_id", actorHrKeys);
  if (gatingResult.error) throw gatingResult.error;
  const gatingSteps: MarketingApproverBadgeStep[] = (
    (gatingResult.data ?? []) as Array<{
      created_at?: string | null;
      request_id: string;
      step_code: string;
      updated_at?: string | null;
      workflow_step_id?: number | string | null;
    }>
  ).map((row) => ({
    createdAt: row.created_at ?? null,
    requestId: row.request_id,
    stepCode: row.step_code,
    updatedAt: row.updated_at ?? null,
    workflowStepId:
      row.workflow_step_id === null || row.workflow_step_id === undefined ? null : Number(row.workflow_step_id),
  }));
  if (gatingSteps.length === 0) return { count: 0, overdue: false };

  const requestIds = Array.from(new Set(gatingSteps.map((step) => step.requestId)));
  const liveRequestIds = new Set<string>();
  for (const batch of chunk(requestIds)) {
    const liveResult = await supabase
      .from("marketing_requests")
      .select("id")
      .in("id", batch)
      .eq("status", "pending_approval");
    if (liveResult.error) throw liveResult.error;
    for (const row of (liveResult.data ?? []) as Array<{ id: string }>) liveRequestIds.add(row.id);
  }
  if (liveRequestIds.size === 0) return { count: 0, overdue: false };

  // Inactive steps are loaded too: a request already sitting on a step that was later deactivated
  // still has an SLA. A failure here must never suppress the count — the number is the point of the
  // badge, the colour is the refinement — so it degrades to "not overdue" and says so in the log.
  const slaDaysByWorkflowStepId = new Map<number, number | null>();
  const slaDaysByStepCode = new Map<string, number | null>();
  const slaResult = await supabase.from("marketing_workflow_steps").select("id, step_code, default_sla_days");
  if (slaResult.error) {
    logWarning("Marketing approver badge could not load step SLAs — count kept, overdue state suppressed", {
      context: { message: slaResult.error.message },
      labels: { event: "marketing_approver_badge_sla_unavailable" },
    });
  } else {
    for (const row of (slaResult.data ?? []) as Array<{
      default_sla_days?: number | string | null;
      id: number | string;
      step_code: string;
    }>) {
      const slaDays =
        row.default_sla_days === null || row.default_sla_days === undefined ? null : Number(row.default_sla_days);
      slaDaysByWorkflowStepId.set(Number(row.id), slaDays);
      slaDaysByStepCode.set(row.step_code, slaDays);
    }
  }

  return summarizeMarketingApproverBadge({
    gatingSteps,
    liveRequestIds,
    now: new Date().toISOString(),
    slaDaysByStepCode,
    slaDaysByWorkflowStepId,
  });
}

export type MarketingOverviewMetrics = {
  /** Requests at the viewer's own gating step (approve / return / reject). */
  awaitingMyDecision: number;
  /** Requests where the viewer is a CC reviewer and may post a non-blocking comment. */
  awaitingMyComment: number;
  /** All marketing requests currently moving through the approval chain (company-wide). */
  inApprovalTotal: number;
  /** Requests returned to their submitter for edits (company-wide). */
  returnedTotal: number;
  /** Active customer/pharmacy links still awaiting validation (company-wide). */
  validationPending: number;
  /** Requests that completed approval (company-wide). */
  approvedTotal: number;
  /** Up to five requests awaiting the viewer's decision, for an inline preview. */
  topPendingForMe: MarketingApproverInboxRow[];
};

/**
 * Landing-page metrics for a marketing approver / oversight role (e.g. Marketing Manager).
 * Reuses the approver-inbox logic for the "awaiting me" figures and a few cheap COUNT-only
 * queries for the company-wide totals. Deliberately light (no ROI engine) so the overview
 * stays fast. The inbox call is made resilient so a non-decision workspace role still gets a
 * valid (zeroed) overview rather than an error.
 */
export async function getMarketingOverview(access: AccessContext): Promise<MarketingOverviewMetrics> {
  assertMarketingWorkspaceAccess(access);
  const supabase = getSupabaseAdmin();

  const [inbox, inApprovalResult, returnedResult, validationPendingResult, approvedResult] = await Promise.all([
    getApproverPendingRequests(access).catch(
      () => ({ advisoryRows: [], rows: [], upcomingRows: [] }) as MarketingApproverInboxWorkspace,
    ),
    supabase.from("marketing_requests").select("id", { count: "exact", head: true }).eq("status", "pending_approval"),
    supabase.from("marketing_requests").select("id", { count: "exact", head: true }).eq("status", "returned"),
    supabase
      .from("marketing_customer_pharmacies")
      .select("id", { count: "exact", head: true })
      .eq("active", true)
      .eq("validation_status", "pending"),
    supabase.from("marketing_requests").select("id", { count: "exact", head: true }).in("status", approvedMarketingRequestStatuses),
  ]);
  if (inApprovalResult.error) throw inApprovalResult.error;
  if (returnedResult.error) throw returnedResult.error;
  if (validationPendingResult.error) throw validationPendingResult.error;
  if (approvedResult.error) throw approvedResult.error;

  return {
    approvedTotal: approvedResult.count ?? 0,
    awaitingMyComment: inbox.advisoryRows.length,
    awaitingMyDecision: inbox.rows.length,
    inApprovalTotal: inApprovalResult.count ?? 0,
    returnedTotal: returnedResult.count ?? 0,
    topPendingForMe: inbox.rows.slice(0, 5),
    validationPending: validationPendingResult.count ?? 0,
  };
}

/**
 * Non-blocking advisory comment from a CC reviewer (e.g. the line Product Manager on an Anti Inf
 * request). Records the comment on the actor's CC step while the gating step it is attached to is
 * current. NEVER changes the request status or advances the chain.
 */
export async function postMarketingAdvisoryComment(
  access: AccessContext,
  requestId: string,
  comment: string,
): Promise<{ requestId: string }> {
  const actorHrId = requireMarketingDecisionActor(access);
  const cleanRequestId = cleanText(requestId);
  if (!cleanRequestId) throw validationError("Marketing request ID is required.");
  const text = cleanText(comment);
  if (!text) throw validationError("A comment is required.", "comment_required");

  const supabase = getSupabaseAdmin();
  const stepsResult = await supabase
    .from("marketing_request_approval_steps")
    .select("*")
    .eq("request_id", cleanRequestId);
  if (stepsResult.error) throw stepsResult.error;
  const steps = ((stepsResult.data ?? []) as MarketingRequestApprovalStepDbRow[]).map(mapApprovalStep);

  const currentGating = steps.find((step) => step.status === "current" && !step.isCc) ?? null;
  const ccStep = currentGating
    ? steps.find(
        (step) =>
          step.isCc &&
          step.stepCode === currentGating.stepCode &&
          normalizeHrId(step.assignedHrId) === normalizeHrId(actorHrId),
      ) ?? null
    : null;
  if (!ccStep) {
    throw forbiddenError("Forbidden: you are not an active reviewer who can comment on this request.");
  }

  const nowIso = new Date().toISOString();
  const update = await supabase
    .from("marketing_request_approval_steps")
    .update({
      decision_at: nowIso,
      // employees(hr_id) FK is case-sensitive. The CC step's assigned_hr_id is already stored in
      // the employee master's real casing (it satisfied the same FK at creation), so reuse it.
      decision_by_hr_id: ccStep.assignedHrId ?? resolveStoredEmployeeHrId(actorHrId) ?? actorHrId,
      decision_note: text,
      updated_at: nowIso,
    })
    .eq("id", ccStep.id)
    .eq("is_cc", true)
    .select("*")
    .single();
  if (update.error) throw update.error;

  await writeAuditLog({
    actorLoginId: actorHrId,
    entityId: cleanRequestId,
    entityType: "marketing_request",
    newValues: {
      source: "marketing_request_advisory_comment",
      stepCode: ccStep.stepCode,
      stepId: ccStep.id,
    },
    summary: `Advisory comment posted on ${cleanRequestId}`,
  });

  return { requestId: cleanRequestId };
}

/**
 * Full detail for a single marketing request: header, products, pharmacies, and the
 * ordered approval timeline with assignee display names. Used by the tracking timeline
 * and the "Returned to me → Edit & Resubmit" prefill. Visible to anyone who can see the
 * request (requester / hierarchy / scope) or who is assigned to one of its steps.
 */
export async function getMarketingRequestDetail(
  requestId: string,
  access: AccessContext,
): Promise<MarketingRequestDetail> {
  const cleanRequestId = cleanText(requestId);
  if (!cleanRequestId) throw validationError("Marketing request ID is required.");

  const supabase = getSupabaseAdmin();
  const employeeRows = await loadEmployeeDirectoryRows();
  const requestResult = await supabase
    .from("marketing_requests")
    .select("*")
    .eq("id", cleanRequestId)
    .maybeSingle();
  if (requestResult.error) throw requestResult.error;
  if (!requestResult.data) throw notFoundError("Marketing request was not found.", "marketing_request_not_found");
  const requestRow = requestResult.data as MarketingRequestDbRow;

  const [stepsResult, productsResult, pharmaciesResult] = await Promise.all([
    supabase
      .from("marketing_request_approval_steps")
      .select("*")
      .eq("request_id", cleanRequestId)
      .order("sequence", { ascending: true }),
    supabase.from("marketing_request_products").select("*").eq("request_id", cleanRequestId),
    supabase.from("marketing_request_pharmacies").select("*").eq("request_id", cleanRequestId),
  ]);
  if (stepsResult.error) throw stepsResult.error;
  if (productsResult.error) throw productsResult.error;
  if (pharmaciesResult.error) throw pharmaciesResult.error;

  const steps = ((stepsResult.data ?? []) as MarketingRequestApprovalStepDbRow[]).map(mapApprovalStep);

  const actorHrId = normalizeHrId(access.hrId);
  const isAssignedApprover = actorHrId
    ? steps.some((step) => normalizeHrId(step.assignedHrId) === actorHrId)
    : false;
  if (!canSeeMarketingRequest(access, requestRow, employeeRows) && !isAssignedApprover && access.scope !== "system") {
    throw forbiddenError("Forbidden: you cannot view this marketing request.");
  }

  // The viewer may post a non-blocking comment when they are a CC reviewer on the step that is
  // currently active (mirrors postMarketingAdvisoryComment's eligibility rule).
  const currentGating = steps.find((step) => step.status === "current" && !step.isCc) ?? null;
  const viewerCanComment = Boolean(
    actorHrId &&
      currentGating &&
      steps.some(
        (step) =>
          step.isCc &&
          step.stepCode === currentGating.stepCode &&
          normalizeHrId(step.assignedHrId) === actorHrId,
      ),
  );

  return {
    pharmacies: ((pharmaciesResult.data ?? []) as MarketingRequestPharmacyDbRow[]).map(mapPharmacy),
    products: ((productsResult.data ?? []) as MarketingRequestProductDbRow[]).map(mapProduct),
    progress: buildMarketingStepProgress(steps, employeeRows),
    request: mapRequest(requestRow),
    steps: buildMarketingTimeline(steps, employeeRows),
    viewerCanComment,
  };
}

function sanitizeStorageSegment(value: string | null | undefined, fallback: string) {
  const sanitized = String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90);
  return sanitized || fallback;
}

function assertMarketingFinanceEvidenceAccess(params: {
  access: AccessContext;
  evidenceType: MarketingFinanceEvidenceType;
  employeeRows: EmployeeDirectoryRow[];
  request: MarketingRequestDbRow;
}) {
  if (params.access.scope === "system") return;

  if (params.evidenceType === "money_transfer_proof") {
    if (
      params.access.role === "Finance Manager" ||
      params.access.role === "Financial Advisor" ||
      params.access.role === "Super Admin"
    ) {
      return;
    }
    throw forbiddenError("Forbidden: only Finance and Super Admin can upload money transfer proof.");
  }

  if (canSeeMarketingRequest(params.access, params.request, params.employeeRows)) return;
  throw forbiddenError("Forbidden: this invoice can only be uploaded by the responsible request owner or manager.");
}

export async function uploadMarketingFinanceEvidence(params: {
  access: AccessContext;
  evidenceType: MarketingFinanceEvidenceType;
  file: File;
  requestId: string;
}): Promise<MarketingApprovedRequestRow> {
  if (
    params.access.scope !== "system" &&
    !marketingCreatorRoles.has(params.access.role) &&
    params.access.role !== "Finance Manager"
  ) {
    throw forbiddenError(`Forbidden: ${params.access.role} cannot upload marketing finance evidence.`);
  }

  const requestId = cleanText(params.requestId);
  if (!requestId) throw validationError("Request ID is required.");
  if (params.evidenceType !== "money_transfer_proof" && params.evidenceType !== "invoice") {
    throw validationError("Evidence type is invalid.");
  }
  if (!params.file || params.file.size <= 0) throw validationError("Evidence file is required.");
  if (params.file.size > marketingFinanceEvidenceMaxBytes) {
    throw validationError("Evidence file must be 4 MB or smaller.");
  }
  if (!marketingFinanceEvidenceContentTypes.has(params.file.type)) {
    throw validationError("Evidence file must be JPG, PNG, WEBP, or PDF.");
  }

  const supabase = getSupabaseAdmin();
  const requestResult = await supabase
    .from("marketing_requests")
    .select("*")
    .eq("id", requestId)
    .maybeSingle();
  if (requestResult.error) throw requestResult.error;
  if (!requestResult.data) throw notFoundError("Marketing request was not found.", "request_not_found");

  const requestRow = requestResult.data as MarketingRequestDbRow;
  const employeeRows = await loadEmployeeDirectoryRows();
  assertMarketingFinanceEvidenceAccess({
    access: params.access,
    evidenceType: params.evidenceType,
    employeeRows,
    request: requestRow,
  });
  await assertMarketingWorkflowTransition({
    access: params.access,
    actionKey: "upload_finance_evidence",
    status: toMarketingRequestWorkflowStatus(requestRow.status),
  });

  const actorHrId = assertMarketingActor(params.access);
  // finance_reviewer_hr_id / *_uploaded_by_hr_id all FK to employees(hr_id) (case-sensitive).
  const storedActorHrId = resolveStoredEmployeeHrId(actorHrId, employeeRowByHrId(employeeRows)) ?? actorHrId;
  const originalFileName = sanitizeStorageSegment(params.file.name, `${params.evidenceType}-evidence`);
  const storagePath = [
    sanitizeStorageSegment(requestId, "request"),
    params.evidenceType,
    `${Date.now()}-${originalFileName}`,
  ].join("/");
  const bytes = Buffer.from(await params.file.arrayBuffer());
  const upload = await supabase.storage
    .from(marketingFinanceEvidenceBucket)
    .upload(storagePath, bytes, {
      contentType: params.file.type,
      upsert: false,
    });
  if (upload.error) throw upload.error;

  const now = new Date().toISOString();
  const patch = params.evidenceType === "money_transfer_proof"
    ? {
      finance_reviewer_hr_id: storedActorHrId,
      money_transfer_proof_original_file_name: params.file.name,
      money_transfer_proof_storage_path: storagePath,
      money_transfer_proof_uploaded_at: now,
      money_transfer_proof_uploaded_by_hr_id: storedActorHrId,
      reviewed_at: now,
      updated_at: now,
    }
    : {
      invoice_original_file_name: params.file.name,
      invoice_required: true,
      invoice_status: "submitted",
      invoice_storage_path: storagePath,
      invoice_uploaded_by_hr_id: storedActorHrId,
      invoice_uploaded_at: now,
      updated_at: now,
    };

  const financeUpsert = await supabase
    .from("marketing_request_finance_requirements")
    .upsert({
      request_id: requestId,
      ...patch,
    }, { onConflict: "request_id" })
    .select("*")
    .single();
  if (financeUpsert.error) throw financeUpsert.error;

  const customerResult = await supabase
    .from("marketing_customers")
    .select("*")
    .eq("id", requestRow.customer_id);
  if (customerResult.error) throw customerResult.error;

  const rows = buildMarketingApprovedRequestRows({
    customers: ((customerResult.data ?? []) as MarketingCustomerDbRow[]).map(mapCustomer),
    employeeRows,
    financeRequirements: [mapFinanceRequirement(financeUpsert.data as MarketingRequestFinanceRequirementDbRow)],
    requests: [mapRequest(requestRow)],
  });

  // A finance file landing is exactly when the sheet's "Open invoice" cell becomes clickable.
  pingMarketingRequestSheet("finance_evidence_uploaded");
  return rows[0];
}

async function loadEmployeeDirectoryRows() {
  const directory = await import("@/lib/employees/employee-directory");
  return directory.getEmployeeDirectoryRows();
}

/**
 * The unfiltered directory, used ONLY to put a name to the person acting.
 *
 * `loadEmployeeDirectoryRows` above returns the active field slice, which deliberately drops
 * `organogram_visible = false` rows and system-admin accounts. The Super Admin performing a desk
 * validation is exactly such an account, so it has to be resolved from the unfiltered list or the
 * row ends up attributed to the employee it was created for. Never use this to widen who a customer
 * may be owned by.
 */
async function loadActorDirectoryRows() {
  const directory = await import("@/lib/employees/employee-directory");
  return directory.getEmployeeDirectoryRows({ includeInactive: true });
}

export function assertMarketingDraftCanBeSubmitted(draft: MarketingRequestDraftDetail) {
  if (draft.products.length === 0) throw conflictError("At least one product is required before submitting.");
  if (draft.pharmacies.length === 0) throw conflictError("At least one pharmacy tracking code is required before submitting.");
  if (draft.roiStatus === "not_calculated") throw conflictError("ROI must be calculated before submitting.");
}
