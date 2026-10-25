import { randomUUID } from "node:crypto";

import { unstable_cache } from "next/cache.js";

import {
  canSeeHrScopedRecord,
  parseRoleStrict,
  resolveEmployeeIdentityId,
  type AccessContext,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { isSamePerson } from "@/lib/auth/identity-aliases";
import { canRecordDirectOrderCollection } from "@/lib/direct-orders/finance-authority";
import { loadOffsetsByRequestId } from "@/lib/direct-orders/marketing-offset-service";
import { writeAuditLog, writeRequiredAuditLog } from "@/lib/admin/audit";
// Pure, JSX-free SLA tone helper (see src/lib/approvals-hub/service.ts, which imports it the same
// way) so the marketing badge graduates to "overdue" on exactly the rule the other badges use.
import { slaTone } from "@/components/approvals-hub/sla-thresholds";
import type { EmailTemplateContext } from "@/lib/email-templates/service";
import { canonicalHrIdKey, hrIdForStorage, hrIdLookupKeys, resolveStoredHrId } from "@/lib/hr-id";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { resolveGovernorate } from "@/lib/geo/egypt-locations";
import { afterResponse } from "@/lib/http/after-response";
import { invalidateFinanceDashboardCache } from "@/lib/dashboard/invalidation";
import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { isUuid } from "@/lib/http/uuid";
import { parseCrmContactCode } from "@/lib/crm/contact-code";
// The one definition of "this link was inferred, not field-validated". Imported rather than
// re-implemented so the validation report and the Customer Pharmacy Mapping page can never drift
// into disagreeing about which links the backfill wrote.
import { isDeskValidated, isInferredFromHistory, isSecondCodeBackfill } from "@/lib/customer-pharmacy-mapping/readiness";
import {
  deleteMarketingEvidencePhotos,
  loadMarketingEvidencePhoto,
  loadMarketingPharmacyLicensesByPharmacyIds,
  type MarketingPharmacyLicenseFile,
  parseMarketingEvidencePhotoDataUrl,
  storeMarketingEvidencePhoto,
  storeMarketingPharmacyLicense,
} from "@/lib/marketing-requests/evidence-photo-storage";
import {
  marketingInvoiceDueLabel,
  resolveMarketingInvoiceObligation,
} from "@/lib/marketing-requests/invoice-obligation";
import {
  checkCustomerPharmacyDistance,
  venueTooFarMessage,
} from "@/lib/venues/customer-pharmacy-distance";
import {
  type PharmacyCodeCandidate,
  type RankedPharmacyCode,
  rankPharmacyCodeSuggestions,
} from "@/lib/venues/pharmacy-code-suggestions";
import { marketingRequestNotificationUrl } from "@/lib/marketing-requests/notification-link";
// Moved out of this file (it was 6,000 lines) so the Case File can share the exact same reads
// instead of copying them. Behaviour is unchanged for every caller below.
import {
  loadMarketingDecisionPharmacies,
  loadMarketingRequestOverlaps,
  type MarketingDecisionOverlap,
  type MarketingDecisionPharmacy,
} from "@/lib/marketing-requests/request-loaders";
// Reused rather than re-implemented: this module already owns the "render a recorded instant in
// Cairo, never raw UTC" formatter, and it imports nothing from here, so there is no cycle.
import { cairoDateTime } from "@/lib/marketing-requests/request-report-columns";
// The one list of link statuses that count as validated. Imported, never re-typed: the draft guard
// and the request picker below must agree with each other and with the backfill's precedence.
import {
  findCustomerTargetLink,
  LINK_STATUS_PRECEDENCE,
  requestTargetKind,
  type CustomerTargetLink,
} from "@/lib/marketing-requests/code-link-reach";
import {
  VENUE_WITHOUT_DISTRIBUTOR_CODE,
  venueWithoutDistributorCodeMessage,
} from "@/lib/marketing-requests/coded-venues-only";
import { calculateMarketingRoiPreview } from "@/lib/marketing-requests/roi";
import {
  assertMarketingWorkflowTransition,
  toMarketingRequestWorkflowStatus,
} from "@/lib/marketing-requests/workflow";
import { createSystemNotification, logNotificationSendFailure } from "@/lib/notifications/system";
import { resolveNotificationRoleEnabled } from "@/lib/notifications/role-recipients";
import { logError, logWarning } from "@/lib/observability/log";
import {
  planRestartedApprovalSteps,
  resubmitBasisChanges,
  type ResubmitBasisChange,
} from "@/lib/marketing-requests/resubmit-rule";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import {
  MARKETING_CUSTOMER_SPECIALITIES,
  MARKETING_CUSTOMER_TYPES,
  MARKETING_GOVERNORATE_HOLD_PREFIX,
  MARKETING_MANUAL_HOLD_MARKER,
  UNVERIFIED_CODE_REASON_MIN_LENGTH,
} from "@/lib/marketing-requests/types";
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
  MarketingRequestContactOption,
  MarketingRequestPharmacyOption,
  MarketingRequestDraftProductInput,
  MarketingRequestPharmacy,
  MarketingRequestProduct,
  MarketingRequestFinanceRequirement,
  MarketingRequestApprovalStep,
  MarketingRequestType,
  MarketingOnBehalfEmployee,
  MarketingReusablePharmacy,
  MarketingValidationCustomerInput,
  MarketingValidationInput,
  MarketingValidationExistingPharmacyInput,
  MarketingValidationPharmacyEntry,
  MarketingValidationPharmacyInput,
  MarketingValidationReportRow,
  MarketingValidationStatus,
  MarketingValidationWorkspace,
  MarketingVenueMergeCandidate,
  MarketingVenueMergeResult,
  MarketingDecisionLabels,
  MarketingStepKind,
  MarketingWorkflowApprovalScope,
  MarketingWorkflowStep,
} from "@/lib/marketing-requests/types";
import { resolveMarketingCustomerValidationBadge } from "@/lib/marketing-requests/customer-validation-badge";
import { crmListFlag, UNPICKED_CRM_DOCTOR, type ResolvedCrmDoctorPick } from "@/lib/marketing-requests/crm-doctor-pick";
import type { OrgSeat } from "@/lib/phoenix-crm/scope";
import type { ValidationBadge } from "@/lib/validation/validation-badge";
import { decodeVenueTarget, encodeVenueTarget } from "@/lib/marketing-requests/venue-type";
import {
  DEFAULT_VENUE_TYPE,
  normalizeVenueType,
  parseVenueTypeChoice,
  VENUE_TYPE_UNANSWERED_MESSAGE,
  venueNonAttributableReason,
  venueRequiresDistributorCode,
  venueTypeIsAnswered,
  type VenueType,
} from "@/lib/venues/venue-type";
import {
  isLicenseOnlyPharmacyNote,
  parsePharmacyLicenseDataUrl,
} from "@/lib/venues/pharmacy-license";
import {
  WHOLESALER_VENUE_REFUSED_MESSAGE,
  isCertainWholesalerVenue,
  suspectedWholesalerFlag,
  suspectedWholesalerNote,
} from "@/lib/venues/wholesaler-venue-guard";
import { getUserProductScopeOverride } from "@/lib/auth/scope-visibility";
import { loadAlsoKnownAsBatch } from "@/lib/customer-identity/server/profile";
import { bumpCustomer360Cache } from "@/lib/cache/namespaces";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { resolveMarketingPharmacyCodes } from "@/lib/marketing-requests/master-resolution";
import { resolveCanonicalActorHrId } from "@/lib/auth/canonical-actor";
import { viewerMayReopenMarketingRequests } from "@/lib/marketing-requests/reopen-rule";
import { canCancelMarketingRequest } from "@/lib/marketing-requests/cancel";
import { pingMarketingRequestSheet } from "@/lib/marketing-requests/sheet-webhook";
import { applyMasterTerritoryToVenues } from "@/lib/marketing-requests/venue-territory";
import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyConversationMessage } from "@/lib/conversations/notify";
import {
  insertRecordConversationComment,
  listRecordConversation,
  listRecordConversationAuthors,
  type RecordConversationComment,
} from "@/lib/conversations/comments";

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

// Both now live in request-loaders.ts beside the loader that builds them; re-exported here so every
// existing `import type { ... } from ".../service"` keeps resolving.
export type { MarketingDecisionOverlap, MarketingDecisionPharmacy };

/**
 * A target pharmacy on the approver window, carrying its own "already validated" stamp (owner,
 * 2026-09-22). Computed here rather than in the loader because the honest name of a human validator
 * comes from the same employee directory this summary already loads, and only the approver window
 * needs it — the Case File keeps the plain `MarketingDecisionPharmacy`.
 *
 * The badge is null unless the pharmacy is in a validated state, so a nullish check is the render
 * gate: a badge renders the green "Validated · by whom · when" stamp, a null renders the explicit
 * "Not validated" chip. That pairing is the point — before it, a pending pharmacy with no photo was
 * indistinguishable from a validated one.
 */
export type MarketingDecisionPharmacyWithValidation = MarketingDecisionPharmacy & {
  validationBadge: ValidationBadge | null;
};

export type MarketingRequestDecisionSummary = {
  allowReject: boolean;
  /**
   * The other per-step power, and it must travel with `allowReject` rather than be assumed true.
   * Both live on the step row; `MarketingWorkflowStep` and `MarketingRequestApprovalStep` have
   * carried the pair since the flags shipped, and this summary carried only half of it — so the
   * confirmation page had nothing to gate Return on and painted it on every rung.
   */
  allowReturn: boolean;
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
  /**
   * Set when the customer's name was TYPED at validation because the doctor is not on a rep's Phoenix
   * CRM list (owner, 2026-10-23: "allow typing, but flag, clearly flag in all approval steps"). The
   * sentence itself, from `crmListFlag`; null for a picked doctor and for a customer from before the rule.
   */
  customerCrmListFlag: string | null;
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
  targetPharmacies: MarketingDecisionPharmacyWithValidation[];
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
  /** The customer's uuid, for evidence/history joins. Null when the request carries no customer. */
  customerId: string | null;
  /**
   * The "already validated · by whom · when" stamp for the approver window (owner, 2026-09-22).
   * Null unless the customer is in a validated state — a nullish check is the render gate.
   */
  customerValidation: ValidationBadge | null;
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
  /** Absent on every row written before 2026-08-26 — those venues were never asked the question. */
  license_name_matches_sign?: boolean | null;
  line_id: number | string | null;
  manager_hr_id: string | null;
  /** Absent on every row written before 2026-08-23; a venue that is not a duplicate leaves it null. */
  merged_at?: string | null;
  merged_by_hr_id?: string | null;
  merged_into_pharmacy_id?: string | null;
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
  /** Absent on every row written before 2026-08-23 — `normalizeVenueType` reads those as pharmacies. */
  venue_type?: string | null;
};

type MarketingCustomerContactDbRow = {
  active?: boolean | null;
  contact_name?: string | null;
  crm_code?: string | null;
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
  distributor_code_id: string | null;
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
  raw_pharmacy_address?: string | null;
  raw_region?: string | null;
};

/** What a reference lookup needs back: the row, and the code the sales data actually carries. */
type MarketingPharmacyCodeReferenceRowForMatch = {
  id: number | string;
  normalized_pharmacy_code?: string | null;
  /**
   * The distributor's OWN registered address for this code, and the governorate it files it under.
   * Read only to compare against where the rep actually stood — see `checkCapturedGovernorate`.
   * Both are optional because the reference import leaves them blank for some codes, and the
   * pre-migration fallback query cannot select them at all.
   */
  raw_pharmacy_address?: string | null;
  raw_region?: string | null;
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
  distributor_code_id: string | null;
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

/**
 * The refusal, as a reader needs it: who said no, at which rung, when, and why.
 *
 * `decidedByName` credits `decisionByHrId` over `assignedHrId` so a rung decided by a stand-in is
 * attributed to the person who actually decided it, not to the person it was addressed to.
 */
export type MarketingRequestRejection = {
  /** ISO instant, for machines. */
  decidedAt: string | null;
  /**
   * Africa/Cairo, display-ready — formatted HERE rather than in the component.
   *
   * The existing approval timeline hands the client a raw ISO string
   * ({@link MarketingRequestTimelineStep.decisionAt}, commented "render in Africa/Cairo") and
   * `marketing-approval-timeline.tsx` renders it verbatim, so it shows UTC on screen against the
   * standing rule. Pre-formatting removes the chance to repeat that.
   */
  decidedAtLabel: string | null;
  decidedByName: string;
  /** Null, never "", when no reason was recorded — the two must not render the same. */
  reason: string | null;
  sequence: number;
  stepName: string;
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
  /** Finance (and System Admin) may settle an approved request against a direct order's debt. */
  canSettleAgainstDirectOrder: boolean;
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
  /**
   * Selectable contacts keyed by customer id.
   *
   * `marketing_requests.customer_contact_id` has existed since the table did and NOTHING has ever
   * written it — all 29 Phoenix requests hold null — because the form had no way to offer one. The
   * CRM link was therefore made at CUSTOMER level instead (src/lib/crm/contact-trade.ts), which
   * fans a request out to every linked contact of its customer: two contacts at one clinic both
   * take credit for a request that concerned one of them. Offering the contact here is what lets
   * the requester say which, and the server already validates the choice belongs to the customer.
   */
  contactsByCustomer: Record<string, MarketingRequestContactOption[]>;
  inApproval: MarketingRequest[];
  products: MarketingProduct[];
  /**
   * Refused requests visible to this viewer.
   *
   * Scoped exactly like `returned` — own requests for company-wide roles, the hierarchy subtree for
   * line roles. Before this existed, `rejected` was the one requester-reachable status the workspace
   * never queried, so a refused request appeared in no list at all, not even to its author.
   */
  rejected: MarketingRequest[];
  /** Keyed by request id, for the requests in `rejected`. Absent when the chain could not be read. */
  rejectionByRequestId: Record<string, MarketingRequestRejection>;
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
  /** The "typed by hand, not on a rep's CRM list" flag (`crmListFlag`), shown on the row itself. */
  customerCrmListFlag: string | null;
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
  /**
   * EVERY request still in the approval chain, whoever is holding it — Super Admin only.
   *
   * Owner instruction, 2026-08-18. The three sections above are all scoped to the ACTOR: rungs
   * assigned to them, CC rungs they may comment on, and rungs heading toward them. A Super Admin
   * holds no rung on the live chain (manager → SFE → marketing → CEO → finance), so all three came
   * back empty and the inbox read "no marketing requests involve you right now" while four requests
   * sat pending. That is a true statement about the actor and a useless one about the company.
   *
   * Strictly read-only, and deliberately NOT merged into `rows`: oversight is the right to SEE a
   * queue, not to decide it. `allowReject` / `allowReturn` are forced false on every row here so no
   * decision control can be rendered from one, and the decision API is untouched — it still matches
   * the actor against their own step, which a Super Admin does not have. Requests already sitting in
   * `rows` are excluded so the same request never appears twice.
   *
   * Empty for every other role, so nothing widens for anyone else.
   */
  oversightRows: MarketingApproverOversightRow[];
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

/**
 * A request in the chain that the viewer is watching rather than deciding.
 *
 * Same shape as an upcoming row minus `myStepSequence` — an oversight viewer has no rung of their
 * own, and inventing one (0, or the current holder's) would be a number that means nothing.
 */
export type MarketingApproverOversightRow = Omit<MarketingApproverUpcomingRow, "myStepSequence"> & {
  /**
   * Whether THIS viewer may call the request off from the inbox — Super Admin only, and only while
   * the request is at a cancellable status. Optional so an upcoming row (which never carries it)
   * stays assignable to the shared watch-list component; it is treated as false when absent.
   */
  canCancel?: boolean;
};

export type PreparedMarketingRequestDraft = {
  pharmacyRows: Array<{
    distributor_code_id: string | null;
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
  /**
   * Set only when the rep picked an existing pharmacy off the My Pharmacies tab. Every OTHER field
   * on this object is then meaningless and must not be read — the record is loaded from the
   * database instead, so the reuse path can never overwrite a stored shop with client-supplied
   * text. `createMarketingValidationRecord` branches on this before touching anything else.
   */
  existingPharmacyId: string | null;
  displayName: string;
  evidenceHasTimestamp: boolean;
  /** The shutter's own fix — see `MarketingValidationCustomerInput.evidencePhotoLatitude`. */
  evidencePhotoAccuracyMeters: number | null;
  evidencePhotoCapturedAt: string | null;
  /** Validated JPEG data URL, carried to the post-insert storage write. Never persisted as text. */
  evidencePhotoDataUrl: string | null;
  evidencePhotoLatitude: number | null;
  evidencePhotoLongitude: number | null;
  evidencePhotoName: string | null;
  evidenceStatus: MarketingEvidenceStatus;
  /**
   * Validated pharmacy-licence data URL, carried to the post-insert storage write on BOTH the new
   * and the reuse paths. Never persisted as text.
   *
   * Deliberately absent from `evidenceStatusFromInput`: a licence proves IDENTITY, not presence, so
   * attaching one must not move a venue's `evidence_status` toward `complete` and must not make a
   * customer `system_validated`. Those still turn on the GPS-stamped shop-front capture alone —
   * a licence that could raise a status would be a way to validate a shop nobody visited.
   */
  licenseFileDataUrl: string | null;
  licenseFileName: string | null;
  extractedAreaName: string | null;
  extractedGovernorateName: string | null;
  normalizedName: string;
  regionName: string | null;
  /** Empty only when `venueType` needs no distributor account. */
  vendorCodes: Array<{
    distributorId: number;
    distributorPharmacyCode: string;
    normalizedPharmacyCode: string;
  }>;
  validationStatus: MarketingValidationStatus;
  venueType: VenueType;
};

/**
 * What to iterate when writing a venue's links: one entry per distributor code — and a refusal for
 * a venue that has none.
 *
 * Both write paths below used to loop over `vendorCodes` directly, which meant a venue with zero
 * codes silently produced NO customer link at all — the customer would be created, the shop would
 * be created, and nothing would join them. Until 2026-10-21 this answered `[null]` (one codeless
 * link) for a nursery or a licence-only pharmacy. Marketing now holds only venues that carry a
 * distributor code (owner, 2026-10-21), so a codeless venue is refused HERE too — belt and braces
 * behind the capture gates, which refuse it before anything is written.
 */
function venueCodeSlots<T>(codes: T[], venueName: string | null): Array<T | null> {
  if (codes.length > 0) return codes;
  throw validationError(venueWithoutDistributorCodeMessage(venueName), VENUE_WITHOUT_DISTRIBUTOR_CODE);
}

type NormalizedMarketingValidationCustomer = {
  capturedAccuracyMeters: number | null;
  capturedAddress: string | null;
  capturedAt: string | null;
  capturedLatitude: number | null;
  capturedLongitude: number | null;
  /** The area → doctor pick — see `MarketingValidationCustomerInput.crmAreaSeatId`. */
  crmAreaSeatId: string | null;
  crmCustomerId: string | null;
  customerType: MarketingCustomerType;
  displayName: string;
  evidenceHasTimestamp: boolean;
  /** The shutter's own fix — see `MarketingValidationCustomerInput.evidencePhotoLatitude`. */
  evidencePhotoAccuracyMeters: number | null;
  evidencePhotoCapturedAt: string | null;
  /** Validated JPEG data URL, carried to the post-insert storage write. Never persisted as text. */
  evidencePhotoDataUrl: string | null;
  evidencePhotoLatitude: number | null;
  evidencePhotoLongitude: number | null;
  evidencePhotoName: string | null;
  evidenceStatus: MarketingEvidenceStatus;
  /** Set when this capture completes a customer already on record. See the input type's note. */
  existingCustomerId: string | null;
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
  /**
   * Verdict from `checkCapturedGovernorate`. ONLY `"disagrees"` changes the outcome — omitted,
   * `"agrees"` and `"not_comparable"` all leave the evidence rule exactly as it was, so a blank or
   * unrecognisable reference row can never park a link on `pending`.
   */
  governorateVerdict?: MarketingGovernorateVerdict;
  pharmacyEvidenceStatus: MarketingEvidenceStatus;
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

/**
 * Who may RAISE a marketing request — `marketingCreatorRoles` minus the Medical Rep.
 *
 * Owner instruction 2026-09-18: *"from medical rep accounts hide
 * /employee-portals/marketing-requests/inbox & /employee-portals/marketing-requests but leave
 * /employee-portals/marketing-requests/validation"*. A rep's job in this module is now the FIELD
 * CAPTURE alone — stand at the venue, take the GPS fix and the live photo, validate the customer —
 * and the spend request against that customer is raised by their District Manager, who sees it
 * through the hierarchy route in `canSeeMarketingCustomer`.
 *
 * `marketingCreatorRoles` is deliberately NOT narrowed: it still gates Customer Validation
 * (`assertMarketingAccess`) and, through `assertMarketingWorkspaceAccess`, the ROI Tracker — the
 * two surfaces the rep keeps. Narrowing that set instead would have closed the capture screen on
 * the very people who do the capturing.
 *
 * Must stay in lockstep with `canUseEmployeePortalMarketingRequests`
 * (src/lib/employee-portal/navigation.ts), which is the UX half. This is the boundary.
 */
export const marketingRequestCreatorRoles = new Set<AccessContext["role"]>(
  Array.from(marketingCreatorRoles).filter((role) => role !== "Medical Rep"),
);

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
 * The boundary behind /employee-portals/marketing-requests and its Approval Inbox — the two
 * surfaces the Medical Rep lost on 2026-09-18. See `marketingRequestCreatorRoles`.
 *
 * Read side (the drafts workspace, the approver inbox): the creator roles PLUS the company-wide
 * oversight roles, exactly as `assertMarketingWorkspaceAccess` reads today, minus the rep.
 */
export function assertMarketingDraftWorkspaceAccess(access: AccessContext) {
  if (access.scope === "system") return;
  if (!marketingRequestCreatorRoles.has(access.role) && !companyMarketingRoles.has(access.role)) {
    throw forbiddenError(`Forbidden: ${access.role} cannot use marketing requests.`);
  }
}

/** Write side: who may raise or resubmit a marketing request. */
export function assertMarketingRequestCreationAccess(access: AccessContext) {
  if (access.scope === "system") return;
  if (!marketingRequestCreatorRoles.has(access.role)) {
    throw forbiddenError(`Forbidden: ${access.role} cannot raise a marketing request.`);
  }
}

/**
 * The Approval Inbox boundary.
 *
 * Deliberately a NEGATIVE test rather than an allow-list. This queue has always been scoped to the
 * ACTOR — it returns the rungs assigned to them and nothing else — so a seat holding no rung
 * already saw an empty list, and turning that into a refusal for every seat would change behaviour
 * far beyond what was asked. The only door this closes is the Medical Rep's, which is the one the
 * owner named on 2026-09-18; every other role keeps exactly the answer it had.
 */
export function assertMarketingApprovalInboxAccess(access: AccessContext) {
  if (access.scope === "system") return;
  if (marketingCreatorRoles.has(access.role) && !marketingRequestCreatorRoles.has(access.role)) {
    throw forbiddenError(`Forbidden: ${access.role} cannot open the marketing approval inbox.`);
  }
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

// Named, owner-approved exception: B-155 is a Product Manager assigned to SPECIFIC named
// cross-line products, not to a product line. His marketing visibility/submission is hard-clamped
// to exactly his product_scope_override codes, matching the sales-side clamp
// (applyProductCodeAllowlist), instead of the general line + override union below. This is
// intentionally scoped to this one HR_ID — every other requester (including other users with a
// product_scope_override, e.g. A-8/A-10) keeps the union behaviour unchanged.
//
// The codes themselves are DATA, never a list written here — read
// app_auth_users.product_scope_override. It shipped as Tigogrow/TG001 (Pedia) + Osteosat/OS001
// (Anti Infective); the owner added Guamusin/GU001 + Ivyronc/IV001 on 2026-09-28.
//
// 🔴 Because of this clamp a NULL override means he sees NOTHING here, while on the sales side
// NULL means "no restriction". So clearing his list does not widen his marketing access, it
// empties it: canCreateDraft stays true and the product dropdown comes back with zero rows, no
// error anywhere. That is what happened between 2026-08-10 — the owner cleared the two pre-launch
// codes because both were inactive and every export came back empty — and 2026-09-28. Never clear
// it; give him real codes instead.
//
// And a smaller trap on top: his four assigned codes yield TWO pickable products, because the
// workspace's catalogue query drops `active = false` rows before this predicate ever sees them, and
// Tigogrow and Osteosat are still pre-launch. Two of four is the CORRECT reading, not a
// half-applied assignment. Measured on production 2026-09-28 by executing this path: 21 catalogue
// rows, 2 pickable; with the old {TG001, OS001} list, 0; with the list cleared, 0.
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
 * (getMarketingRequestDraftWorkspace filters customers through canSeeMarketingCustomer). Since the
 * 2026-08-19 territory ruling that filter passes on EITHER the hierarchy (owner_hr_id /
 * manager_hr_id) or the customer's area, so picking the right employee also picks the right area —
 * and the customer stays visible to whoever works that patch after the chosen employee leaves.
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

function normalizeDraftPharmacies(inputPharmacies: MarketingRequestDraftPharmacyInput[] | null | undefined) {
  if (!Array.isArray(inputPharmacies)) return [];

  const seen = new Set<string>();
  const rows: Array<{
    distributorCodeId: string | null;
    notes: string | null;
    pharmacyId: string | null;
    unverifiedCodeReason: string | null;
  }> = [];
  for (const pharmacy of inputPharmacies) {
    // `targetId` first, `distributorCodeId` as the fallback — a draft saved before the venue type
    // existed carries only the second, and for a pharmacy the two are the same string anyway.
    const target = decodeVenueTarget(pharmacy?.targetId ?? pharmacy?.distributorCodeId);
    if (!target) {
      throw validationError("Target pharmacy is required.");
    }
    const key = target.distributorCodeId ?? `venue::${target.pharmacyId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      distributorCodeId: target.distributorCodeId,
      notes: cleanText(pharmacy?.notes),
      pharmacyId: target.pharmacyId,
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
  // Checked against the shared list, never a copy of it. The copy that used to sit here omitted
  // "doctor", which blocked Capture Evidence for 130 of the 160 active customers — the rep is shown
  // the stored type in a locked field, so a doctor customer could only ever submit "doctor" and was
  // rejected every time.
  if (!MARKETING_CUSTOMER_TYPES.includes(type)) {
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

/**
 * Validate a pharmacy licence at normalize time, so a file that cannot be stored is refused before
 * anything is written — the same ordering, and the same reason, as `normalizeEvidencePhotoDataUrl`.
 *
 * Unlike the photo, an absent licence is never suspicious: it is optional on every venue, so a name
 * without a file simply drops both. There is nothing here to mirror the "a photo name with no
 * photo" refusal, because a licence name has never been persisted as a claim on its own.
 */
function normalizePharmacyLicenseDataUrl(value: unknown, label: string): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  try {
    // Parsed, not pattern-matched, so an oversized file or a type nobody can open fails here rather
    // than mid-submission with a rollback already in flight.
    parsePharmacyLicenseDataUrl(raw);
  } catch (error) {
    throw validationError(
      `${label}: ${error instanceof Error ? error.message : "The pharmacy licence file is not valid."}`,
      "pharmacy_license_invalid",
    );
  }
  return raw;
}

function systemStatusFromEvidence(status: MarketingEvidenceStatus): MarketingValidationStatus {
  return status === "complete" ? "system_validated" : "pending";
}

/**
 * Whether a field-captured validation row is auto-usable in the marketing request customer
 * dropdown. Decided on EVIDENCE ALONE.
 *
 * Until 2026-08-12 this also demanded that the pharmacy's distributor code resolve to exactly one
 * row in `marketing_pharmacy_code_references`, and an unmatched code parked the whole customer on
 * `pending` — invisible in the dropdown with no way back for the rep, because releasing a pending
 * link is Super Admin / CEO only (`canAccessCustomerPharmacyMapping`). A code missing from a
 * reference table Phoenix itself owns says nothing about whether the rep stood in front of the
 * shop, so honest field work was being blocked on our own data-quality gap.
 *
 * Owner ruling, 2026-08-12: release it and FLAG it. The reference lookup still runs and is still
 * recorded truthfully on both the link and the distributor code row, because an unmatched code
 * means no sale can ever be attributed to that pharmacy and the request's ROI would read zero
 * forever — `buildUntrackedDistributorCodeNote` says exactly that on the row. This is the trade the
 * desk / on-behalf path has always made; the field path now matches it.
 *
 * Evidence gates: `complete` on BOTH the customer and the pharmacy means a GPS fix plus a
 * timestamped live photo that actually reached the `marketing-evidence` bucket (see
 * `evidenceStatusFromInput`), which is the only proof the visit happened at all.
 *
 * GEOGRAPHY ALSO GATES, since 2026-08-20 at the owner's instruction. Complete evidence proves a
 * photo was taken somewhere; it says nothing about whether that somewhere is where the distributor
 * registers the code. Production had validated a capture in Cairo against a code registered in
 * Alexandria, ~185 km apart, because nothing in Phoenix had ever compared those two addresses. An
 * outright `"disagrees"` from `checkCapturedGovernorate` now holds the link on `pending` for a
 * human to release, and `buildGovernorateMismatchNote` says on the row exactly which two
 * governorates are in conflict so the reviewer is not left guessing.
 *
 * The asymmetry is deliberate and load-bearing: only a positive contradiction blocks. A reference
 * row with a blank or unrecognisable region yields `"not_comparable"` and changes nothing, because
 * the reference database is Phoenix's own point-in-time import and its GAPS must never be read as
 * evidence against a rep — that is the same distinction the 2026-08-12 ruling above draws for an
 * unmatched code, which still only flags.
 */
export function resolveMarketingSystemValidationStatus(
  input: MarketingSystemValidationInput,
): MarketingValidationStatus {
  if (input.governorateVerdict === "disagrees") return "pending";
  return input.customerEvidenceStatus === "complete" && input.pharmacyEvidenceStatus === "complete"
    ? "system_validated"
    : "pending";
}

/**
 * The note stamped on any link whose distributor code is not a unique match in the Phoenix
 * reference database. Returns null when the code matched and there is nothing to warn about.
 *
 * Since 2026-08-12 this rides on VALIDATED rows too, not just pending ones — an unmatched code no
 * longer blocks the customer, so the warning is the only thing left carrying the consequence.
 */
export function buildUntrackedDistributorCodeNote(
  referenceStatus: MarketingPharmacyCodeReferenceStatus,
): string | null {
  return referenceStatus === "matched"
    ? null
    : `Distributor code is ${referenceStatus.replace(/_/g, " ")} in the Phoenix reference database, so sales cannot be tracked for it yet.`;
}

export type MarketingGovernorateVerdict = "agrees" | "disagrees" | "not_comparable";

export type MarketingGovernorateCheck = {
  /** Governorate resolved from the reverse-geocoded GPS address, or null when unrecognisable. */
  capturedGovernorate: string | null;
  /** The distributor's registered street address, carried only so the note can quote it. */
  registeredAddress: string | null;
  /** Governorate resolved from the distributor's own `raw_region`, or null when blank. */
  registeredGovernorate: string | null;
  verdict: MarketingGovernorateVerdict;
};

/**
 * Compares WHERE THE REP STOOD against WHERE THE DISTRIBUTOR SAYS THE CODE LIVES.
 *
 * Until now nothing in Phoenix made this comparison at all: `raw_pharmacy_address` / `raw_region`
 * were written once by the reference importer and read by no code path, so a capture could sit in
 * a different governorate from the code's registered address and still reach `system_validated`.
 * Production carries exactly that — pharmacy `MKT-PHA-20260619-6F50E43C` was captured in Cairo
 * against a code the distributor files in Alexandria, roughly 185 km apart, and validated cleanly.
 *
 * Deliberately compares at GOVERNORATE level and no finer. A street-level or distance comparison
 * is impossible anyway (the reference table stores no coordinates) and would be wrong to attempt:
 * a shop legitimately moves within its city, `raw_pharmacy_address` is free text, and 13 of the 21
 * captured addresses in production resolve only to a Google Plus Code with no street at all. A
 * governorate is coarse enough to be reliable and still catches the failure that matters.
 *
 * `raw_region` is the ONLY registered input, and the reference table's other two location columns
 * are excluded on evidence, not on taste:
 *
 *   - `raw_pharmacy_address` is free-text street data that frequently contains a foreign place
 *     name. Production reference row 9302 reads "16ناصيه هارون والمنصوره" under region القاهرة;
 *     matching that text would resolve Dakahlia (المنصورة) and invent a mismatch.
 *   - `raw_area` drifts from the shop's actual location even when the region is right. Reference
 *     row 8553 (code 0001552116) is filed under area المحلة الكبري while its own address reads
 *     الشين- قطور, ~40 km away — and its region, الغربية, is correct for both. An area-level
 *     comparison would have held that link for a labelling quirk in our own import.
 *
 * On the captured side the rep-supplied `extractedGovernorateName` is ignored too, because it is
 * typed in the workspace UI rather than derived from the GPS fix, so comparing it would only check
 * the rep against himself.
 *
 * Returns `not_comparable` — never `disagrees` — whenever either side is missing or unrecognised,
 * so absent reference data can never be read as evidence of a wrong capture.
 */
export function checkCapturedGovernorate(input: {
  capturedAddress: string | null | undefined;
  registeredAddress?: string | null | undefined;
  registeredRegion: string | null | undefined;
}): MarketingGovernorateCheck {
  const capturedGovernorate = resolveGovernorate(input.capturedAddress);
  const registeredGovernorate = resolveGovernorate(input.registeredRegion);
  const registeredAddress = cleanText(input.registeredAddress);

  if (!capturedGovernorate || !registeredGovernorate) {
    return { capturedGovernorate, registeredAddress, registeredGovernorate, verdict: "not_comparable" };
  }
  return {
    capturedGovernorate,
    registeredAddress,
    registeredGovernorate,
    verdict: capturedGovernorate === registeredGovernorate ? "agrees" : "disagrees",
  };
}

/**
 * The note stamped on a link whose capture sits in a different governorate from the one the
 * distributor registers the code in. Null unless the verdict is an outright disagreement.
 *
 * This note is the REASON THE LINK IS PENDING, not a decoration on a validated one. Owner
 * instruction, 2026-08-20: a governorate contradiction BLOCKS — `resolveMarketingSystemValidationStatus`
 * returns `pending` on `"disagrees"`, and only a Super Admin / CEO can release it
 * (`canAccessCustomerPharmacyMapping`). It therefore has to name both governorates and quote the
 * distributor's own street address, because the person releasing it was not on the visit and has
 * nothing else to judge by.
 *
 * It deliberately does NOT accuse. The reference database is Phoenix's own point-in-time import,
 * and a held link can be a bad reference row just as easily as a bad capture, so the note asks for
 * a decision rather than asserting a fault.
 */
export function buildGovernorateMismatchNote(check: MarketingGovernorateCheck): string | null {
  if (check.verdict !== "disagrees") return null;
  const registered = check.registeredAddress
    ? `${check.registeredGovernorate} (${check.registeredAddress})`
    : check.registeredGovernorate;
  return `${MARKETING_GOVERNORATE_HOLD_PREFIX} captured location is in ${check.capturedGovernorate}, but the distributor registers this code in ${registered}. Confirm the code belongs to this shop before releasing it.`;
}

/** Why a field-captured link is still pending, when what is missing is the evidence itself. */
export const MARKETING_PENDING_EVIDENCE_NOTE =
  "Waiting for a complete live photo and location on both the customer and the pharmacy.";

/** Stamped on a link released because the customer it belongs to was finally captured in the field. */
export const MARKETING_RELEASED_BY_COMPLETION_NOTE =
  "Released after the customer's own evidence was captured in the field.";

/**
 * Stamped on a MANUALLY held link whose customer has since been captured properly.
 *
 * The hold itself stands — see `MARKETING_MANUAL_HOLD_MARKER`. This only records that the evidence
 * half of the reason is now satisfied, so whoever reads the row in Customer Pharmacy Mapping is
 * looking at a decision to make rather than at a row that is simply waiting for a photograph.
 */
export const MARKETING_COMPLETED_CUSTOMER_NOTE =
  "The customer has since been captured in the field, so this hold is now a human decision, not a missing photo.";

/** Stamped on a link released because the SHOP it points at was finally captured in the field. */
export const MARKETING_RELEASED_BY_VENUE_COMPLETION_NOTE =
  "Released after the pharmacy's own evidence was captured in the field.";

/** The venue twin of `MARKETING_COMPLETED_CUSTOMER_NOTE`. The hold itself still stands. */
export const MARKETING_COMPLETED_VENUE_NOTE =
  "The pharmacy has since been captured in the field, so this hold is now a human decision, not a missing photo.";

/**
 * Emits `MARKETING_PENDING_EVIDENCE_NOTE` only when the evidence is genuinely the thing missing.
 *
 * Two things can park a link since 2026-08-20 — incomplete evidence, or a governorate
 * contradiction — and they need different notes. Deriving this from the evidence statuses rather
 * than from `status !== "system_validated"` is the point: a link held purely on geography HAS its
 * photo and its GPS fix, so the old test would have told the reviewer to wait for evidence that had
 * already arrived, and buried the real reason under a false one.
 */
function buildPendingEvidenceNote(input: {
  customerEvidenceStatus: MarketingEvidenceStatus;
  pharmacyEvidenceStatus: MarketingEvidenceStatus;
}): string | null {
  return input.customerEvidenceStatus === "complete" && input.pharmacyEvidenceStatus === "complete"
    ? null
    : MARKETING_PENDING_EVIDENCE_NOTE;
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

/**
 * Drops every key whose value is null or undefined.
 *
 * For `.update()` only, and it exists because of a trap this repo has paid for before: an OPTIONAL
 * column written unconditionally is a SILENT ERASE. A null means "the caller had nothing to say
 * about this column", which on an INSERT is the right starting value and on an UPDATE destroys
 * whatever the row already held.
 */
function definedColumns<T extends Record<string, unknown>>(columns: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(columns).filter(([, value]) => value !== null && value !== undefined),
  ) as Partial<T>;
}

/**
 * A normalized pharmacy carrying the id of the record to reuse, plus whatever evidence the rep
 * captured while standing in front of it.
 *
 * IDENTITY is still placeholder and still never written — `displayName`, `normalizedName`,
 * `vendorCodes` and `venueType` are read from the stored row, so pointing at a record can never
 * rename or re-code it. That is the same split the reused-CUSTOMER path draws: evidence may be
 * supplied for a record that exists, identity may not.
 *
 * Evidence, since 2026-08-23, is normalized exactly as a fresh capture is — same coordinate
 * bounds, same timestamp parsing, same photo rule, same `evidenceStatusFromInput`. With nothing
 * supplied every field lands null and the status falls to "missing" / "pending", which is what
 * this function returned unconditionally before, so the attach-only path is unchanged.
 */
function normalizeReusedValidationPharmacy(
  existingPharmacyId: string,
  inputEntry: MarketingValidationExistingPharmacyInput,
  label: string,
): NormalizedMarketingValidationPharmacy {
  const photoName = cleanText(inputEntry.evidencePhotoName);
  const evidence = {
    capturedAccuracyMeters: nonNegativeNumber(inputEntry.capturedAccuracyMeters) || null,
    capturedAddress: cleanText(inputEntry.capturedAddress),
    capturedAt: nullableIsoTimestamp(inputEntry.capturedAt, `${label} capture time`),
    capturedLatitude: nullableCoordinate(inputEntry.capturedLatitude, `${label} latitude`, -90, 90),
    capturedLongitude: nullableCoordinate(inputEntry.capturedLongitude, `${label} longitude`, -180, 180),
    evidenceHasTimestamp: inputEntry.evidenceHasTimestamp === true,
    evidencePhotoAccuracyMeters: nonNegativeNumber(inputEntry.evidencePhotoAccuracyMeters) || null,
    evidencePhotoCapturedAt: nullableIsoTimestamp(
      inputEntry.evidencePhotoCapturedAt,
      `${label} photo capture time`,
    ),
    evidencePhotoDataUrl: normalizeEvidencePhotoDataUrl(inputEntry.evidencePhotoDataUrl, label, photoName),
    evidencePhotoLatitude: nullableCoordinate(
      inputEntry.evidencePhotoLatitude,
      `${label} photo latitude`,
      -90,
      90,
    ),
    evidencePhotoLongitude: nullableCoordinate(
      inputEntry.evidencePhotoLongitude,
      `${label} photo longitude`,
      -180,
      180,
    ),
    evidencePhotoName: photoName,
    extractedAreaName: cleanText(inputEntry.extractedAreaName),
    licenseFileDataUrl: normalizePharmacyLicenseDataUrl(inputEntry.licenseFileDataUrl, label),
    licenseFileName: cleanText(inputEntry.licenseFileName),
    extractedGovernorateName: cleanText(inputEntry.extractedGovernorateName),
    regionName: cleanText(inputEntry.regionName),
  };
  const evidenceStatus = evidenceStatusFromInput(evidence);
  return {
    ...evidence,
    displayName: "",
    evidenceStatus,
    existingPharmacyId,
    normalizedName: "",
    validationStatus: systemStatusFromEvidence(evidenceStatus),
    vendorCodes: [],
    venueType: DEFAULT_VENUE_TYPE,
  };
}

function normalizeValidationPharmacy(
  inputEntry: MarketingValidationPharmacyEntry,
  label: string,
): NormalizedMarketingValidationPharmacy {
  // The My Pharmacies path: the client points at a record and says nothing else about it.
  if ("existingPharmacyId" in inputEntry && inputEntry.existingPharmacyId !== undefined) {
    const existingPharmacyId = cleanText(inputEntry.existingPharmacyId);
    if (!existingPharmacyId) throw validationError(`${label} did not name which pharmacy to link.`);
    return normalizeReusedValidationPharmacy(existingPharmacyId, inputEntry, label);
  }

  const inputPharmacy = inputEntry as MarketingValidationPharmacyInput;
  const displayName = cleanText(inputPharmacy?.displayName);
  if (!displayName) throw validationError(`${label} name is required.`);
  // NOT `normalizeVenueType` — that reads absent as "pharmacy", which is right for a stored row
  // written before the column existed and wrong for a venue being registered NOW. Registering is
  // the one moment the answer is free, and defaulting here is how a nursery becomes a pharmacy.
  const venueTypeChoice = parseVenueTypeChoice(inputPharmacy.venueType);
  if (!venueTypeIsAnswered(venueTypeChoice)) {
    throw validationError(`${label}: ${VENUE_TYPE_UNANSWERED_MESSAGE}`);
  }
  const venueType = venueTypeChoice;
  const vendorCodeInputs = Array.isArray(inputPharmacy.vendorCodes) ? inputPharmacy.vendorCodes : [];
  const licenseFileDataUrl = normalizePharmacyLicenseDataUrl(inputPharmacy.licenseFileDataUrl, label);
  // MARKETING HOLDS ONLY VENUES THAT CARRY A DISTRIBUTOR CODE (owner, 2026-10-21: "any thing with
  // no distributor code never reach the marketing requests"). A nursery has no distributor account,
  // and a pharmacy with no code — even with its licence attached — is the same case: both are
  // validated in Direct Orders, never here. This replaces the 2026-08-23 nursery route (location +
  // photo alone) and the 2026-10-14 licence route (saved held, released by a Super Admin or the CEO).
  //
  // Asked through the predicate, never as `venueType === "pharmacy"`: that inline re-derivation is
  // exactly what the venue-type module warns lets the next type be added in one place and missed in
  // five. Asked BEFORE the codes are parsed, so a nursery is told where it belongs rather than being
  // told its code is malformed.
  if (!venueRequiresDistributorCode(venueType) || vendorCodeInputs.length === 0) {
    throw validationError(venueWithoutDistributorCodeMessage(displayName), VENUE_WITHOUT_DISTRIBUTOR_CODE);
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
    evidencePhotoAccuracyMeters: nonNegativeNumber(inputPharmacy.evidencePhotoAccuracyMeters) || null,
    evidencePhotoCapturedAt: nullableIsoTimestamp(inputPharmacy.evidencePhotoCapturedAt, `${label} photo capture time`),
    evidencePhotoDataUrl: normalizeEvidencePhotoDataUrl(
      inputPharmacy.evidencePhotoDataUrl,
      label,
      pharmacyPhotoName,
    ),
    evidencePhotoLatitude: nullableCoordinate(
      inputPharmacy.evidencePhotoLatitude,
      `${label} photo latitude`,
      -90,
      90,
    ),
    evidencePhotoLongitude: nullableCoordinate(
      inputPharmacy.evidencePhotoLongitude,
      `${label} photo longitude`,
      -180,
      180,
    ),
    evidencePhotoName: pharmacyPhotoName,
    extractedAreaName: cleanText(inputPharmacy.extractedAreaName),
    extractedGovernorateName: cleanText(inputPharmacy.extractedGovernorateName),
    licenseFileDataUrl,
    licenseFileName: cleanText(inputPharmacy.licenseFileName),
    normalizedName: normalizeLookupKey(displayName),
    regionName: cleanText(inputPharmacy.regionName),
  };
  const pharmacyEvidenceStatus = evidenceStatusFromInput(pharmacy);
  const seenVendorCodes = new Set<string>();
  const vendorCodes = vendorCodeInputs.map((vendorCode, vendorIndex) => {
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
    existingPharmacyId: null,
    validationStatus: systemStatusFromEvidence(pharmacyEvidenceStatus),
    vendorCodes,
    venueType,
  };
}

function normalizeValidationCustomer(
  inputCustomer: MarketingValidationCustomerInput | undefined,
  inputPharmacies: MarketingValidationPharmacyEntry[],
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
    crmAreaSeatId: cleanText(inputCustomer?.crmAreaSeatId),
    crmCustomerId: cleanText(inputCustomer?.crmCustomerId),
    customerType: normalizeCustomerType(inputCustomer?.customerType),
    displayName,
    evidenceHasTimestamp: inputCustomer?.evidenceHasTimestamp === true,
    evidencePhotoAccuracyMeters: nonNegativeNumber(inputCustomer?.evidencePhotoAccuracyMeters) || null,
    evidencePhotoCapturedAt: nullableIsoTimestamp(inputCustomer?.evidencePhotoCapturedAt, `${customerLabel} photo capture time`),
    evidencePhotoDataUrl: normalizeEvidencePhotoDataUrl(
      inputCustomer?.evidencePhotoDataUrl,
      customerLabel,
      customerPhotoName,
    ),
    evidencePhotoLatitude: nullableCoordinate(
      inputCustomer?.evidencePhotoLatitude,
      `${customerLabel} photo latitude`,
      -90,
      90,
    ),
    evidencePhotoLongitude: nullableCoordinate(
      inputCustomer?.evidencePhotoLongitude,
      `${customerLabel} photo longitude`,
      -180,
      180,
    ),
    evidencePhotoName: customerPhotoName,
    existingCustomerId: cleanText(inputCustomer?.existingCustomerId),
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

  const pharmacies = inputPharmacies.map((inputPharmacy, index) =>
    normalizeValidationPharmacy(inputPharmacy, `${prefix}${prefix ? "p" : "P"}harmacy ${index + 1}`),
  );

  // Linking the same existing pharmacy to one customer twice would mint two identical link rows,
  // and the marketing request form would then offer the same shop twice in its target list with no
  // way to tell them apart. Cheap to catch here; impossible to explain later.
  const seenExistingPharmacyIds = new Set<string>();
  for (const pharmacy of pharmacies) {
    if (!pharmacy.existingPharmacyId) continue;
    if (seenExistingPharmacyIds.has(pharmacy.existingPharmacyId)) {
      throw validationError(
        `${customerLabel} has the same existing pharmacy attached twice.`,
        "duplicate_existing_pharmacy",
      );
    }
    seenExistingPharmacyIds.add(pharmacy.existingPharmacyId);
  }

  // THE 4 KM RULE (owner ruling, 2026-09-29). A pharmacy that far from the doctor cannot be where
  // his prescriptions are dispensed, so the request's ROI — which is read from that pharmacy's
  // sales — would be measuring an unrelated shop.
  //
  // Here, in the normalizer, rather than beside the link insert: this runs BEFORE a single row is
  // written, so a refused submission leaves nothing half-created. The insert path's own failure
  // mode is to throw and unwind every customer and pharmacy it has already written, which is a
  // violent way to say "wrong shop".
  //
  // Skipped for an existing pharmacy picked off the My Pharmacies tab: its capture lives in the
  // database and every other field on that input object is meaningless by contract (see
  // `NormalizedMarketingValidationPharmacy.existingPharmacyId`), so comparing against the client's
  // blank coordinates would refuse a reuse that is very probably correct.
  for (const pharmacy of pharmacies) {
    if (pharmacy.existingPharmacyId) continue;
    const distance = checkCustomerPharmacyDistance(
      { latitude: customer.capturedLatitude, longitude: customer.capturedLongitude },
      { latitude: pharmacy.capturedLatitude, longitude: pharmacy.capturedLongitude },
    );
    if (!distance.refused) continue;
    throw validationError(
      venueTooFarMessage({
        customerName: customer.displayName || "this customer",
        distanceMeters: distance.distanceMeters ?? 0,
        pharmacyName: pharmacy.displayName || "That pharmacy",
      }),
      "pharmacy_too_far_from_customer",
    );
  }

  return {
    ...customer,
    capturedAccuracyMeters: customer.capturedAccuracyMeters || null,
    evidenceStatus: customerEvidenceStatus,
    pharmacies,
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
    const seenExistingCustomerIds = new Set<string>();
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
        // The name check above cannot catch this one: two entries spelled DIFFERENTLY may still
        // point at the same existing row, and the second update would silently overwrite the first
        // capture's evidence with no trace that two were sent.
        if (normalized.existingCustomerId) {
          if (seenExistingCustomerIds.has(normalized.existingCustomerId)) {
            throw validationError(
              `"${normalized.displayName}" completes a customer that another entry in this submission already completes.`,
              "duplicate_existing_customer",
            );
          }
          seenExistingCustomerIds.add(normalized.existingCustomerId);
        }
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
  /**
   * This customer's own active, validated venue links (`fetchCustomerTargetLinks`). Every chosen
   * target must be one of them: the draft carries a raw target id from the portal, so without this
   * a request could name another customer's pharmacy code, or a link since unlinked or rejected.
   * Required, not optional, so a caller cannot forget it and quietly lose the guard.
   */
  customerLinks: CustomerTargetLink[];
  input: MarketingRequestCreateDraft;
  pharmacyCodes?: MarketingPharmacyDistributorCodeDbRow[];
  products: MarketingProductDbRow[];
  /** The codeless targets — see `fetchVenuePharmacies`. */
  venuePharmacies?: Array<{ id: string; display_name: string | null; active?: boolean | null; venue_type?: string | null }>;
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
  const venuePharmaciesById = new Map((params.venuePharmacies ?? []).map((venue) => [venue.id, venue]));

  const pharmacyRows = normalized.pharmacies.map((pharmacy) => {
    // A target with no distributor code is never accepted (owner, 2026-10-21: "any thing with no
    // distributor code never reach the marketing requests"). Until then a nursery and a pharmacy
    // released on its licence could be codeless targets — "spend allowed, sales can never be
    // matched". Both are validated in Direct Orders now, and refused here in the one sentence every
    // marketing door uses. The venue is looked up only to NAME it in that sentence.
    if (!pharmacy.distributorCodeId) {
      const venue = pharmacy.pharmacyId ? venuePharmaciesById.get(pharmacy.pharmacyId) : undefined;
      throw validationError(
        venueWithoutDistributorCodeMessage(venue?.display_name ?? null),
        VENUE_WITHOUT_DISTRIBUTOR_CODE,
      );
    }

    const code = pharmacyCodesById.get(pharmacy.distributorCodeId);
    if (!code || code.active === false) {
      throw notFoundError("Distributor pharmacy code was not found or is inactive.", "pharmacy_code_not_found");
    }
    // The code must hang off a venue THIS customer is validated at. `fetchPharmacyCodes` looks a
    // code up by id alone, so before this check any code in the database was a valid target for any
    // customer the requester could see.
    const codedLink = findCustomerTargetLink(params.customerLinks, {
      distributorCodeId: code.id,
      pharmacyId: code.pharmacy_id,
    });
    if (!codedLink || requestTargetKind(codedLink) !== "coded") {
      throw validationError(
        `Pharmacy code "${code.distributor_pharmacy_code ?? code.normalized_pharmacy_code ?? code.id}" is not one of this customer's validated venues.`,
        "target_not_linked_to_customer",
      );
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
 *
 * `rolesGatedLater` is the second stop condition, and it exists because the chain target
 * only ever describes the SALES ladder. A Product Manager reports A-10 → A-9 (Marketing
 * Manager) → AA (CEO); a National Sales Manager is nowhere on that path, so the walk used
 * to run to the top of the company and mint a "Marketing Manager Approval" and a "CEO
 * Approval" rung at sequence 1 and 2 — the exact two seats that `marketing_review` and
 * `ceo_approval` already gate at sequence 4 and 6. Both people were asked twice, and the
 * CEO was asked FIRST, before SFE Validation and Marketing Review had run at all.
 *
 * The walk therefore stops BEFORE the first manager whose role a later dedicated step
 * already gates: everyone above that manager is reached through that step anyway. Stopping
 * (rather than filtering the rung out and carrying on) keeps the chain a ladder — filtering
 * could leap over the Marketing Manager and put the CEO at sequence 1, which is the same
 * inversion this is fixing.
 */
export function buildMarketingManagerChain(params: {
  chainTargetRole: string | null;
  employeeRows: EmployeeDirectoryRow[];
  requester: EmployeeDirectoryRow;
  /**
   * Roles a later, dedicated workflow step already gates. Compared case-insensitively.
   * Omitted (the default) means "nothing downstream" and reproduces the raw walk — used to
   * tell "this requester has no manager at all" apart from "every manager above them is
   * already a formal gate", which are a hard error and a correct empty chain respectively.
   */
  rolesGatedLater?: Iterable<string>;
}): Array<{ assignedHrId: string; assignedRole: string; stepName: string }> {
  const byHrId = employeeRowByHrId(params.employeeRows);
  const gatedLater = new Set(Array.from(params.rolesGatedLater ?? []).map((role) => normalizeLookupKey(role)));
  const chain: Array<{ assignedHrId: string; assignedRole: string; stepName: string }> = [];
  const visited = new Set<string>();
  let currentHrId = normalizeHrId(params.requester.managerHrId);
  let depth = 0;
  while (currentHrId && depth < 8 && !visited.has(currentHrId)) {
    visited.add(currentHrId);
    const managerRow = byHrId.get(currentHrId);
    if (!managerRow) break;
    const roleName = String(resolveJobFunctionRole(managerRow.jobTitle));
    if (gatedLater.has(normalizeLookupKey(roleName))) break;
    chain.push({ assignedHrId: currentHrId, assignedRole: roleName, stepName: marketingChainStepName(roleName) });
    if (params.chainTargetRole && roleName === params.chainTargetRole) break;
    currentHrId = normalizeHrId(managerRow.managerHrId);
    depth += 1;
  }
  return chain;
}

/**
 * Product/Group Product Manager(s) of the request's line, CC-notified (never gate).
 *
 * Each recipient is returned WITH the role that selected them, because a CC rung has to be stamped
 * with the recipient's OWN role, not the reviewer's. Line 1 reviews at Marketing Manager and CCs the
 * line's Product Manager, so reusing the reviewer's role printed
 * `Marketing Review (CC) · Marketing Manager · <the line's Product Manager>` — two rungs reading
 * "Marketing Manager" one under the other, which made the case file look like it had two Marketing
 * Managers and hid which of the two actually decides. Production carried it on both of A-10's open
 * requests. `app_auth_users.role` was already selected here and simply thrown away.
 */
export async function resolveLineCcRecipients(params: {
  ccRoles: string[];
  employeeRows: EmployeeDirectoryRow[];
  request: MarketingRequest;
  supabase: SupabaseClient;
}): Promise<Array<{ hrId: string; role: string }>> {
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
  const requestedRoleByKey = new Map(roles.map((role) => [normalizeLookupKey(role), String(role)]));
  const seen = new Set<string>();
  const recipients: Array<{ hrId: string; role: string }> = [];
  for (const row of (data ?? []) as Array<{ hr_id?: string | null; role?: string | null }>) {
    const hrId = normalizeHrId(row.hr_id);
    if (!hrId || seen.has(hrId)) continue;
    const employeeRow = byHrId.get(hrId);
    if (!sameNullableId(employeeRow?.lineId, params.request.lineId)) continue;
    /**
     * The query filters on `in(roles)`, so `row.role` is normally one of the requested CC roles.
     * The two fallbacks exist so an unrecognised value can never DROP a recipient — a CC row is a
     * notification, and losing one silently is worse than labelling it from the employee master.
     */
    const role =
      requestedRoleByKey.get(normalizeLookupKey(row.role)) ??
      (employeeRow ? String(resolveJobFunctionRole(employeeRow.jobTitle)) : String(roles[0]));
    seen.add(hrId);
    recipients.push({ hrId, role });
  }
  return recipients;
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

  /**
   * Hoisted out of the step loop because the managerial chain — built first — has to know which
   * role will review at `marketing_review` before it can avoid duplicating it, and that role is
   * per-line (line 2 reviews at Group Product Manager, not Marketing Manager). Same single query
   * as before, just read before the loop instead of inside it — the `some(...)` guard keeps it
   * from firing when no `marketing_review` step is active.
   */
  const reviewRouting = requiredSteps.some((step) => step.stepCode === "marketing_review")
    ? await loadMarketingReviewRoutingByLine(params.supabase, params.request.lineId ?? null)
    : null;
  const effectiveStepRole = (step: MarketingWorkflowStep) =>
    step.stepCode === "marketing_review" && reviewRouting ? reviewRouting.reviewerRole : step.assignedRole;

  /**
   * The roles a later, dedicated step already gates (SFE Manager, the line's review role, CEO,
   * Finance Manager). The managerial walk stops before reaching any of them, so no one is asked
   * twice on one request and the dedicated steps keep their designed order behind SFE Validation.
   */
  const rolesGatedLater = requiredSteps
    .filter((step) => step.stepKind !== "managerial_chain" && step.approvalScope !== "direct_manager")
    .map((step) => effectiveStepRole(step));

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

    /**
     * Nobody approves their own spend.
     *
     * A role-resolved rung lands on whoever holds the role, and the requester can BE that person:
     * production carries MKT-REQ-20260811-FF5B0719, raised by A-9 (Marketing Manager) with A-9
     * assigned to its own `marketing_review` rung. Nothing refused it.
     *
     * The rung is kept and marked `skipped` rather than dropped. Dropping it would erase the fact
     * that a gate existed, which is the same "absence reads as benign" failure this module keeps
     * making; and leaving it `pending` would strand the request forever once the RPC refuses a
     * self-decision (see phx_decide_marketing_request_step). `skipped` is already this table's
     * marker for "present but not a gate" — CC rows use it — so the chain stays honest and the
     * request stays decidable.
     */
    const isSelfApproval =
      !input.isCc && isSamePerson(storedHrId, params.request.requesterHrId);

    sequence += 1;
    rows.push({
      allow_reject: input.step.allowReject,
      allow_return: input.step.allowReturn,
      assigned_hr_id: storedHrId,
      assigned_role: input.assignedRole,
      decision_labels: input.step.decisionLabels,
      // Written on a skipped self-approval rung so the timeline says WHY the gate did not apply,
      // instead of showing a silent gap in the chain.
      decision_note: isSelfApproval
        ? "Skipped automatically: the assigned approver raised this request, and nobody approves their own spend."
        : null,
      is_cc: input.isCc,
      request_id: params.request.id,
      sequence,
      status: input.isCc || isSelfApproval ? "skipped" : "pending",
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
      /**
       * Walked twice on purpose, and the two answers are different questions.
       *
       * The raw walk answers "does this requester have ANY manager above them" — an empty raw
       * walk is a genuine configuration error and still fails loudly, exactly as before.
       *
       * The gated walk answers "which of those rungs is not already a dedicated later step". For
       * a marketing-side requester (Product Manager, Group Product Manager, Marketing Manager,
       * SFE Manager — everyone reporting up to A-9 or straight to the CEO) the gated walk is
       * CORRECTLY empty: their managers are the Marketing Review and CEO Approval steps, which
       * still run, in their designed order, behind SFE Validation. An empty gated walk therefore
       * contributes no rung and must NOT be reported as a missing manager.
       *
       * Both walks are in-memory Map hops capped at 8, so the second one costs nothing.
       */
      const rawChain = buildMarketingManagerChain({
        chainTargetRole: step.chainTargetRole,
        employeeRows: params.employeeRows,
        requester: requesterRow,
      });
      if (rawChain.length === 0) {
        throw validationError(`No approving manager could be resolved for ${requesterRow.displayName}.`, "marketing_approver_not_resolved");
      }
      const chain = buildMarketingManagerChain({
        chainTargetRole: step.chainTargetRole,
        employeeRows: params.employeeRows,
        requester: requesterRow,
        rolesGatedLater,
      });
      for (const node of chain) {
        pushRow({ assignedHrId: node.assignedHrId, assignedRole: node.assignedRole, isCc: false, step, stepName: node.stepName });
      }
      continue;
    }

    // Per-line review routing: the post-SFE "Marketing Review" reviewer (and which line PM/GPM are
    // CC'd to comment) is chosen by the request's line. Unmapped lines keep the default Marketing
    // Manager reviewer + the template CC roles. Every other step is unchanged. Read once above the
    // loop (`reviewRouting`) because the managerial chain needs the same answer before this point.
    const effectiveRole = effectiveStepRole(step);
    const effectiveCcRoles = step.stepCode === "marketing_review" && reviewRouting ? reviewRouting.ccRoles : step.ccRoles;

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
      const ccRecipients = await resolveLineCcRecipients({
        ccRoles: effectiveCcRoles,
        employeeRows: params.employeeRows,
        request: params.request,
        supabase: params.supabase,
      });
      for (const { hrId: ccHrId, role: ccRole } of ccRecipients) {
        if (ccHrId === assignedHrId) continue;
        // The requester is never CC'd on their own request. A CC row is a "there is something for
        // you to look at" notification plus a visible rung in the chain; pointed back at the person
        // who raised the spend it is pure noise, and it read as a fourth reviewer on the timeline.
        // The self-approval guard in `pushRow` deliberately covers gating rungs only, so CC rows
        // need their own check — production carried A-10 CC'd on both of her own PM requests.
        if (isSamePerson(ccHrId, params.request.requesterHrId)) continue;
        // `ccRole`, not `effectiveRole`: the rung names the person who was copied, so it must carry
        // THEIR role. See `resolveLineCcRecipients`.
        pushRow({ assignedHrId: ccHrId, assignedRole: ccRole, isCc: true, step, stepName: `${step.stepName} (CC)` });
      }
    }
  }

  // `status === "pending"` matters: a self-approval rung is a non-CC row that is already `skipped`,
  // and opening it as `current` would park the request on a rung its own assignee is forbidden to
  // decide.
  const firstGating = rows.find((row) => row.is_cc === false && row.status === "pending");
  if (firstGating) {
    firstGating.status = "current";
  } else if (rows.some((row) => row.is_cc === false)) {
    // Every gate resolved to the requester. Failing here is the honest outcome: the alternative is
    // a request submitted into `pending_approval` with no rung anyone may act on, which looks like
    // it is progressing and never can.
    throw validationError(
      "You are the only approver on this request, so nobody else could review it. Ask an administrator to assign a different approver before submitting.",
      "marketing_requester_is_sole_approver",
    );
  }

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
  eventType: "request_assigned" | "request_returned" | "request_approved" | "request_rejected" | "request_completed" | "due_date_reminder" | "overdue_reminder";
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

/**
 * The epoch that lets a REOPENED rung tell its approver a second time — and nothing else do so.
 *
 * `notifyMarketingWorkflow` keys `request_assigned` on the step id, and
 * `notification_deliveries.idempotency_key` is UNIQUE, so once a rung has told its approver it can
 * physically never tell them again. That is exactly right for a rung that opened once. It is wrong
 * for one that was returned and then reopened — `MKT-REQ-20260825-AADD59CE` was returned by the CEO
 * at 10:25 Cairo on 2026-08-30 and put back on his own desk an hour later, and the notice he had
 * already received at 10:19 was the only one the system would ever send him.
 *
 * The epoch is the rung's LATEST `step_opened` instant — written by the
 * `marketing_request_steps_capture_event` trigger the moment a rung goes `current`, so it exists
 * however the reopening was recorded, including straight in the database. Deliberately NOT `now()`:
 * a stored instant means calling this twice for the same reopening still yields one notification.
 *
 * A rung opened only once returns `null` and keeps the existing step-id key untouched. That branch
 * is the whole safety of this function — re-keying every rung would make all of them look
 * un-notified and re-send the lot in one sweep.
 */
export function marketingReopenEpoch(openings: ReadonlyArray<string | null | undefined>): string | null {
  const sorted = openings
    .map((value) => cleanText(value))
    .filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value as string)))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  if (sorted.length < 2) return null;
  return sorted[sorted.length - 1];
}

/**
 * The reopen epoch for a rung, read AFTER the write that opened it has committed.
 *
 * A failed read must never fail a decision or a resubmit that already committed - the person would be
 * told it failed, retry, and be refused. So it degrades to `null`: the rung's ordinary step-id key,
 * which at worst swallows the notice, and the daily backfill (which computes the same epoch from the
 * same events) catches the approver up.
 */
async function resolveMarketingStepReopenEpoch(
  supabase: SupabaseClient,
  requestId: string,
  sequence: number,
): Promise<string | null> {
  try {
    return marketingReopenEpoch(await loadMarketingStepOpenings(supabase, requestId, sequence));
  } catch (error) {
    logError("Marketing reopen epoch read failed", {
      error,
      labels: { event: "marketing_reopen_epoch_read_failed", requestId },
    });
    return null;
  }
}

/** Every instant this rung became the live decision, in no particular order — `marketingReopenEpoch` sorts. */
async function loadMarketingStepOpenings(
  supabase: SupabaseClient,
  requestId: string,
  sequence: number,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("marketing_request_events")
    .select("occurred_at")
    .eq("request_id", requestId)
    .eq("kind", "step_opened")
    .eq("step_sequence", sequence);
  if (error) throw error;
  return ((data ?? []) as Array<{ occurred_at?: string | null }>)
    .map((row) => cleanText(row.occurred_at))
    .filter((value): value is string => Boolean(value));
}

/**
 * Send the `request_assigned` notice for whatever rung a request is CURRENTLY sitting on, addressed
 * by request id — the same notification `decideMarketingRequestWorkflow` fires when it advances a
 * step, and therefore the same full-detail email plus the link that opens the request itself.
 * Deliberately mirrors `dispatchDirectOrderApprovedEmail` in the direct-orders module.
 *
 * It exists because a decision recorded OUTSIDE the app never runs the notify path at all.
 * `MKT-REQ-20260818-8C628BF4`'s CEO approval was written straight into the database on 2026-08-19
 * ("Recorded on his behalf"), so the request landed on Finance Execution and Ahmed El Maraghy was
 * never told it existed — no email, no in-app, no push — while its sibling `8E4E42C4`, approved
 * through the UI 22 minutes earlier, reached him on all three channels.
 *
 * **Safe to call repeatedly.** `notifyMarketingWorkflow` keys the notification on the current step
 * id and `notification_deliveries.idempotency_key` is a UNIQUE index claimed conflict-tolerantly,
 * so a rung that has already told its approver cannot tell them twice.
 *
 * A REOPENED rung is the one case where that last sentence would be wrong, and
 * `marketingReopenEpoch` is what keeps it right — see its own comment.
 */
export async function dispatchMarketingAssignmentEmail(requestId: string): Promise<{
  dispatched: boolean;
  reason?: string;
  requestCode?: string;
  stepName?: string;
}> {
  const id = cleanText(requestId);
  if (!id) return { dispatched: false, reason: "missing_request_id" };
  try {
    const supabase = getSupabaseAdmin();
    const request = await loadMarketingRequestById(supabase, id);
    if (!(MARKETING_SLA_PENDING_STATUSES as readonly string[]).includes(request.status)) {
      return { dispatched: false, reason: "request_not_pending", requestCode: request.requestCode };
    }
    const steps = await loadMarketingRequestApprovalSteps(supabase, id);
    const currentStep = steps.find((step) => step.status === "current") ?? null;
    // No current rung means nobody is holding it — there is no one to notify, and inventing a
    // recipient would be worse than staying quiet.
    if (!currentStep?.assignedHrId) {
      return { dispatched: false, reason: "no_current_step", requestCode: request.requestCode };
    }
    const reopenEpoch = marketingReopenEpoch(await loadMarketingStepOpenings(supabase, id, currentStep.sequence));
    /**
     * The unique idempotency key already makes a re-send physically impossible, so this check is
     * about REPORTING, not safety: without it every pending request would be counted as
     * "dispatched" and the backfill would claim it had emailed people it had not.
     *
     * It asks `notification_deliveries`, which is the table the UNIQUE key actually lives on, and
     * for the exact key this call is about to claim. The previous check read
     * `notification_events.metadata->>currentStepId` and answered "never notified" for rungs that
     * demonstrably had been: on 2026-08-30 only 3 of the day's 91 marketing rows carried that key
     * at all, and `MKT-REQ-20260825-AADD59CE`'s CEO rung had none while three delivery rows for it
     * read `sent`. The mis-read was harmless to recipients — the unique index caught it downstream
     * — but it made every run overstate what it had sent.
     */
    const assignmentEventKey = `marketing-request:request_assigned:${request.id}:${reopenEpoch ?? currentStep.id}`;
    const { data: alreadySent } = await supabase
      .from("notification_deliveries")
      .select("id")
      .like("idempotency_key", `${assignmentEventKey}:%`)
      .limit(1);
    if ((alreadySent ?? []).length > 0) {
      return { dispatched: false, reason: "already_notified", requestCode: request.requestCode, stepName: currentStep.stepName };
    }
    const employeeRows = await loadEmployeeDirectoryRows();
    const requestTypeName = await loadMarketingRequestTypeName(supabase, request.requestTypeId);
    const ccHrIds = steps
      .filter((step) => step.isCc && step.stepCode === currentStep.stepCode)
      .map((step) => step.assignedHrId)
      .filter((hrId): hrId is string => Boolean(hrId));
    await notifyMarketingWorkflow({
      actorHrId: null,
      ccHrIds,
      eventType: "request_assigned",
      message: `${request.requestCode} is waiting for ${currentStep.stepName}.`,
      metadata: {
        assignedApproverHrId: currentStep.assignedHrId,
        currentStepId: currentStep.id,
        currentStepName: currentStep.stepName,
        // Present only for a reopened rung, and `notifyMarketingWorkflow` reads it ahead of
        // `currentStepId` — so an ordinary rung's key is byte-for-byte what it always was.
        ...(reopenEpoch ? { idempotencyEpoch: reopenEpoch } : {}),
        workflowApproverHrId: currentStep.assignedHrId,
        ...marketingNotificationVariables({ currentStep, employeeRows, request, requestTypeName }),
      },
      priority: "high",
      request,
      title: "Marketing request assigned",
    });
    return { dispatched: true, requestCode: request.requestCode, stepName: currentStep.stepName };
  } catch (error) {
    logError("Marketing assignment email dispatch failed", {
      labels: { event: "marketing_assignment_email_dispatch_failed", requestId: id },
      error,
    });
    return { dispatched: false, reason: "error" };
  }
}

/**
 * Backstop for the hole above: re-drive the assignment notice for EVERY pending request, so a rung
 * whose approver was never told catches up on the next daily run instead of waiting forever on
 * somebody noticing. Requests that already notified their approver are no-ops at the database's
 * unique idempotency key, so this re-sends nothing that was sent.
 *
 * Deliberately NOT behind the `marketing_sla_reminder` toggle. That switch governs *chasing* an
 * approver who has already been told and is sitting on it — a courtesy the owner can turn off. This
 * is the primary "there is work on your desk" notice that the workflow always intended to send, and
 * suppressing it makes the request invisible rather than merely un-nagged. `marketing_sla_reminder`
 * has been `enabled = false` since 2026-07-23, which is exactly why the miss went unseen for a day.
 */
export async function backfillMissingMarketingAssignmentEmails(): Promise<{
  checked: number;
  dispatched: number;
  requestCodes: string[];
}> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("marketing_requests")
    .select("id")
    .in("status", MARKETING_SLA_PENDING_STATUSES as unknown as string[]);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ id: string }>;
  const requestCodes: string[] = [];
  let dispatched = 0;
  for (const row of rows) {
    const result = await dispatchMarketingAssignmentEmail(row.id);
    if (result.dispatched) {
      dispatched += 1;
      if (result.requestCode) requestCodes.push(result.requestCode);
    }
  }
  return { checked: rows.length, dispatched, requestCodes };
}

// --- Marketing SLA reminders (daily) ---------------------------------------
const MARKETING_SLA_PENDING_STATUSES = ["pending_validation", "pending_approval", "returned"] as const;
const MARKETING_SLA_DUE_SOON_DAYS = 3; // remind when the pay date is within N days

export type MarketingSlaEvent = "due_date_reminder" | "overdue_reminder";

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

/**
 * Key for the step-opened index below. A request can hold two steps sharing one `step_name` (a
 * chain that reviews at CEO twice, say), so the sequence — not the name — is what identifies a rung.
 */
function marketingStepKey(requestId: string, sequence: number) {
  return `${requestId}:${sequence}`;
}

/**
 * When each of these approval steps last became the request's live decision.
 *
 * `step_opened` is written by the `marketing_request_steps_capture_event` trigger the moment a rung
 * goes `current`, so it moves when RESPONSIBILITY moves and at no other time. That is the whole
 * reason it exists here — see `marketingWaitingSince`.
 *
 * Returns the LATEST opening per rung: a returned-then-resubmitted step is opened again, and the
 * clock is meant to restart then rather than count time against someone who was not yet holding it.
 * A step with no recorded opening is simply absent from the map — callers fall back.
 */
export async function loadMarketingStepOpenedAt(
  supabase: SupabaseClient,
  requestIdsInput: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  const opened = new Map<string, string>();
  const requestIds = Array.from(new Set(requestIdsInput.filter(Boolean)));
  if (requestIds.length === 0) return opened;
  for (const batch of chunk(requestIds)) {
    const { data, error } = await supabase
      .from("marketing_request_events")
      .select("request_id, step_sequence, occurred_at")
      .eq("kind", "step_opened")
      .in("request_id", batch);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{
      occurred_at?: string | null;
      request_id?: string | null;
      step_sequence?: number | string | null;
    }>) {
      const requestId = cleanText(row.request_id);
      const occurredAt = cleanText(row.occurred_at);
      if (!requestId || !occurredAt || row.step_sequence === null || row.step_sequence === undefined) continue;
      const sequence = Number(row.step_sequence);
      if (!Number.isFinite(sequence)) continue;
      const key = marketingStepKey(requestId, sequence);
      const existing = opened.get(key);
      if (!existing || Date.parse(occurredAt) > Date.parse(existing)) opened.set(key, occurredAt);
    }
  }
  return opened;
}

/**
 * The instant a rung actually landed on its approver's desk, which is what "waiting N days" must be
 * measured from.
 *
 * **Never read `updated_at` for this directly.** It is a generic row-modification stamp, so ANY
 * write to the step resets it — and on 2026-08-19 a config backfill that switched `allow_return`
 * off across every live Finance Execution rung (owner's rule: nothing may block a request once the
 * CEO has approved) set `updated_at = now()` on four in-flight steps as a side effect. One of them
 * had been sitting with Finance since 15 Aug; its waiting clock silently went back to zero, and the
 * stuck-request reminder that exists precisely to catch that case would have stayed quiet for
 * another three days. Nothing was wrong with the backfill — the clock was reading the wrong column.
 *
 * `openedAt` comes from the `step_opened` event and only moves when the rung is opened. The
 * fallbacks are load-bearing, not defensive padding: event capture began 2026-08-15, so requests
 * older than that have no `step_opened` row at all, and returning null for them would drop them out
 * of the waiting rule entirely — making the oldest, most stuck requests the only invisible ones.
 */
export function marketingWaitingSince(step: {
  createdAt?: string | null;
  openedAt?: string | null;
  updatedAt?: string | null;
}): string | null {
  return step.openedAt ?? step.updatedAt ?? step.createdAt ?? null;
}

/**
 * Pure classifier for how long the current approval step has been outstanding.
 *
 * `waitingSince` must come from `marketingWaitingSince`, which prefers the step's `step_opened`
 * event over its row timestamps. Reassigning or resubmitting legitimately restarts the clock rather
 * than counting elapsed time against someone who was not yet responsible for the decision; an
 * unrelated maintenance write to the row must NOT.
 */
export function classifyMarketingWaitingSla(input: {
  waitingSince: string | null;
  now: string;
}): MarketingSlaEvent | null {
  const daysWaiting = marketingDaysWaiting(input.waitingSince, input.now);
  if (daysWaiting === null) return null;
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
  overdue_reminder: { priority: "high", title: "Marketing request overdue", verb: "is past its pay date and still needs a decision" },
};

/**
 * Daily SLA scan for marketing requests. For each still-pending request with a pay date,
 * fire the due/overdue notification (routed by policy to the assigned approver + request
 * owner). Idempotent per day via a date-stamped notification key. Best-effort; never throws.
 */
export async function runMarketingSlaDaily(): Promise<{
  dataIntegrityIssues: number;
  errors: Array<{ message: string; requestId: string }>;
  overdue: number;
  reminders: number;
  runDate: string;
  scanned: number;
}> {
  const today = marketingTodayCairo();
  const errors: Array<{ message: string; requestId: string }> = [];
  let reminders = 0;
  let overdue = 0;
  let scanned = 0;
  let dataIntegrityIssues = 0;
  const dataIntegrityRequestCodes: string[] = [];
  // True master-off: recipients here are always the specific request's assigned approver and
  // requester, resolved per-request further below — not a role broadcast list — so this admin
  // "enabled" switch (see "marketing_sla_reminder" in role-recipients.ts) is the only real toggle
  // for this reminder, checked before any request is even scanned.
  if (!(await resolveNotificationRoleEnabled("marketing_sla_reminder"))) {
    return { dataIntegrityIssues, errors, overdue, reminders, runDate: today, scanned };
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
    // Every rung's opening in ONE round trip rather than one per request — this runs against
    // Frankfurt from Amsterdam, so a per-request lookup inside the loop below would pay that
    // latency `scanned` times over for data that is a single indexed read.
    const stepOpenedAt = await loadMarketingStepOpenedAt(
      supabase,
      rows.map((row) => row.id),
    );
    for (const row of rows) {
      const request = mapRequest(row);
      try {
        // Current approver — feeds assigned_approver / workflow_step_approver routing.
        const { data: stepData } = await supabase
          .from("marketing_request_approval_steps")
          .select("assigned_hr_id, sequence, updated_at, created_at")
          .eq("request_id", request.id)
          .eq("status", "current")
          .maybeSingle();
        const hasCurrentStep = Boolean(stepData);
        const step = stepData as {
          assigned_hr_id?: string | null;
          created_at?: string | null;
          sequence?: number | string | null;
          updated_at?: string | null;
        } | null;
        const approverHrId = step?.assigned_hr_id ?? null;

        // Two independent clocks, reduced to the single worst signal so one request never
        // produces two competing notifications on the same day.
        // "Waiting since" is the step's `step_opened` event, NOT its `updated_at` — see
        // marketingWaitingSince for the config backfill that silently zeroed this.
        const stepSequence = Number(step?.sequence);
        const openedAt = Number.isFinite(stepSequence)
          ? stepOpenedAt.get(marketingStepKey(request.id, stepSequence)) ?? null
          : null;
        const waitingSince = marketingWaitingSince({
          createdAt: step?.created_at ?? null,
          openedAt,
          updatedAt: step?.updated_at ?? null,
        });
        const payDateEvent = classifyMarketingSla({ payDate: request.payDate, today });
        const waitingEvent = classifyMarketingWaitingSla({ now: nowIso, waitingSince });
        const eventType = mostUrgentMarketingSla(payDateEvent, waitingEvent);
        if (!eventType) continue;

        // Data-integrity guard: a `pending_approval` request always gets exactly one `current`
        // gating step the moment it enters this status (createMarketingApprovalSteps stamps it
        // atomically on submission), and decideMarketingRequestWorkflow hard-requires one before
        // ANY approve/reject/return can happen. So a `pending_approval` row with no `current`
        // step is not a normal in-flight state — it is undecidable by any approver in any role,
        // and firing an "act now" reminder at the requester (the only recipient left
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
            workflowApproverHrId: approverHrId,
          },
          priority: copy.priority,
          request,
          title: `${copy.title} — ${request.requestCode}`,
        });
        if (eventType === "overdue_reminder") overdue += 1;
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
  return { dataIntegrityIssues, errors, overdue, reminders, runDate: today, scanned };
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

/**
 * Turn whatever identifier a link carries into the request's UUID.
 *
 * Every read below this line keys on `marketing_requests.id`, a UUID — but the identifier a HUMAN
 * holds is the request CODE (`MKT-REQ-20260818-D9E88E15`): it is what the report sheet prints, what
 * the owner quotes, and what anyone pastes. Accepting only the UUID meant a link built from the
 * code could not resolve at all, so the code is resolved here once, ahead of the reads.
 *
 * A value already shaped like a UUID is passed straight through — no extra round trip on the path
 * every notification link takes.
 */
export async function resolveMarketingRequestUuid(supabase: SupabaseClient, idOrCode: string) {
  const candidate = String(idOrCode ?? "").trim();
  if (!candidate) throw notFoundError("Marketing request was not found.", "marketing_request_not_found");
  if (isUuid(candidate)) return candidate;

  const { data, error } = await supabase
    .from("marketing_requests")
    .select("id")
    .eq("request_code", candidate.toUpperCase())
    .maybeSingle();
  if (error) throw error;
  if (!data?.id) throw notFoundError("Marketing request was not found.", "marketing_request_not_found");
  return String(data.id);
}

/**
 * One request, mapped. Throws `marketing_request_not_found` when it does not exist.
 *
 * Exported (read-only, and with NO access check of its own) so a composite read surface can load
 * the same row without re-deriving the mapping. Callers own the gate — never call this in place
 * of one.
 */
export async function loadMarketingRequestById(supabase: SupabaseClient, requestId: string) {
  const { data, error } = await supabase
    .from("marketing_requests")
    .select("*")
    .eq("id", requestId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFoundError("Marketing request was not found.", "marketing_request_not_found");
  return mapRequest(data as MarketingRequestDbRow);
}

/**
 * The request's approval steps, mapped — gating AND CC, every status, ordered by sequence.
 *
 * Exported (read-only, no access check of its own) so a composite read surface can feed
 * `buildMarketingApproverChain` without re-deriving the row mapping. Callers own the gate.
 */
export async function loadMarketingRequestApprovalSteps(supabase: SupabaseClient, requestId: string) {
  const { data, error } = await supabase
    .from("marketing_request_approval_steps")
    .select("*")
    .eq("request_id", requestId)
    .order("sequence", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as MarketingRequestApprovalStepDbRow[]).map(mapApprovalStep);
}

/** The request type's display name, falling back to the neutral "Marketing request". */
export async function loadMarketingRequestTypeName(supabase: SupabaseClient, requestTypeId: number) {
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

/**
 * Why a request was refused, and by whom — read off the rung that actually said no.
 *
 * Separate from buildMarketingStepProgress rather than folded into it: a refused request has no
 * `current` rung, so that function's last-step fallback would name whoever happens to sit at the
 * end of the chain as the person holding it. Nobody is holding it. The question a reader has about
 * a rejected request is not "where is it" but "who said no, when, and why".
 *
 * `reason` is null-not-empty when the note is blank. decideMarketingRequestWorkflow makes a note
 * mandatory on reject, so a null here means the row predates that rule or was written by the
 * importer — which is worth showing as "no reason recorded" rather than as an empty line.
 */
export function buildMarketingRejectionSummary(
  steps: MarketingRequestApprovalStep[],
  employeeRows: EmployeeDirectoryRow[],
): MarketingRequestRejection | null {
  const rejectedStep = steps
    .filter((step) => !step.isCc && step.status === "rejected")
    .sort((left, right) => left.sequence - right.sequence)[0];
  if (!rejectedStep) return null;
  const reason = cleanText(rejectedStep.decisionNote);
  return {
    decidedAt: rejectedStep.decisionAt ?? null,
    decidedAtLabel: cairoDateTime(rejectedStep.decisionAt),
    decidedByName: employeeNameByHrId(employeeRows, rejectedStep.decisionByHrId ?? rejectedStep.assignedHrId),
    reason: reason || null,
    sequence: rejectedStep.sequence,
    stepName: rejectedStep.stepName,
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
  if (!isSamePerson(step.assignedHrId, actorHrId)) {
    throw forbiddenError("Forbidden: this marketing request is not assigned to your Phoenix identity.");
  }
}

/**
 * Nobody decides their own request.
 *
 * Both callers of {@link assertMarketingStepAssignedToActor} pair it with this: the decision page
 * and the decide path. Being ASSIGNED a rung is not sufficient — a role-resolved rung lands on
 * whoever holds the role, and the requester can be that person (production: A-9 assigned to its own
 * `marketing_review` rung).
 *
 * The database refuses this too, in phx_decide_marketing_request_step, and that is the real
 * boundary. This exists so the approver is told on the way IN rather than after filling in a
 * decision — the RPC error would otherwise arrive only on submit, after the reviewer had done the
 * work.
 */
export function assertNotDecidingOwnRequest(request: MarketingRequest, actorHrId: string) {
  if (isSamePerson(request.requesterHrId, actorHrId)) {
    throw forbiddenError(
      "Forbidden: you raised this marketing request, so you cannot approve, reject or return it. Ask an administrator to reassign this step.",
    );
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
  // Same reason as the Case File: the identifier in a link may be the request CODE, not the UUID.
  const requestUuid = await resolveMarketingRequestUuid(supabase, cleanRequestId);
  const [request, steps, employeeRows] = await Promise.all([
    loadMarketingRequestById(supabase, requestUuid),
    loadMarketingRequestApprovalSteps(supabase, requestUuid),
    loadEmployeeDirectoryRows(),
  ]);
  const currentStep = steps.find((step) => step.status === "current") ?? null;
  if (!currentStep) throw conflictError("This marketing request has no current approval step.");
  assertMarketingStepAssignedToActor(currentStep, actorHrId);
  assertNotDecidingOwnRequest(request, actorHrId);
  if (request.status !== "pending_approval") {
    throw conflictError("This marketing request is no longer pending approval.");
  }

  // Rich request context so the approver can decide in place (products, financials, the chain).
  const [productsResult, pharmaciesResult, customerResult, contactResult, requestTypeName] = await Promise.all([
    supabase.from("marketing_request_products").select("*").eq("request_id", requestUuid),
    supabase
      .from("marketing_request_pharmacies")
      .select("id, pharmacy_id, distributor_code_id, notes")
      .eq("request_id", requestUuid),
    request.customerId
      ? supabase
        .from("marketing_customers")
        // `speciality` does NOT exist on marketing_customers — naming it here threw
        // "column does not exist" and took the whole approval window down to its safe state.
        // The real column for the free-text qualifier is `other_type_description`.
        .select("display_name, customer_code, customer_type, other_type_description, captured_address, extracted_area_name, extracted_governorate_name, evidence_photo_name, validation_status, validated_at, validated_by_hr_id, evidence_photo_captured_at, crm_list_status")
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

  // The per-pharmacy "already validated · by whom · when" stamp (owner, 2026-09-22). A target
  // pharmacy carries the SAME validation_status vocabulary as a marketing customer and the SAME
  // human/system rule, so the badge is resolved by the customer resolver — the name of a human
  // validator is looked up in the very directory this summary already loaded (`employeeRows`), and
  // never shown for `system_validated`, where the row's id is the capturing owner, not a reviewer.
  const targetPharmaciesWithValidation: MarketingDecisionPharmacyWithValidation[] = targetPharmacies.map(
    (pharmacy) => ({
      ...pharmacy,
      validationBadge: resolveMarketingCustomerValidationBadge({
        status: pharmacy.validationStatus,
        validatedByName: pharmacy.validatedByHrId
          ? employeeNameByHrId(employeeRows, pharmacy.validatedByHrId) || null
          : null,
        validatedAt: pharmacy.validatedAt,
        capturedAt: pharmacy.evidenceCapturedAt,
      }),
    }),
  );

  const customerRow = customerResult.data as {
    captured_address?: string | null;
    customer_code?: string | null;
    customer_type?: string | null;
    display_name?: string | null;
    evidence_photo_name?: string | null;
    evidence_photo_captured_at?: string | null;
    extracted_area_name?: string | null;
    extracted_governorate_name?: string | null;
    other_type_description?: string | null;
    validation_status?: MarketingValidationStatus | null;
    validated_at?: string | null;
    validated_by_hr_id?: string | null;
    crm_list_status?: string | null;
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
    allowReturn: currentStep.allowReturn,
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
    customerCrmListFlag: crmListFlag(customerRow?.crm_list_status),
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
    customerId: request.customerId ?? null,
    // The "already validated · by whom · when" stamp for the approver window (owner, 2026-09-22).
    // Null unless the customer is in a validated state, so a nullish check is the render gate.
    customerValidation: resolveMarketingCustomerValidationBadge({
      status: customerRow?.validation_status ?? null,
      validatedByName: customerRow?.validated_by_hr_id
        ? employeeNameByHrId(employeeRows, customerRow.validated_by_hr_id) || null
        : null,
      validatedAt: customerRow?.validated_at ?? null,
      capturedAt: customerRow?.evidence_photo_captured_at ?? null,
    }),
    notes: cleanText(request.notes),
    requestDate: request.requestDate ?? null,
    roiCoverageRatio: request.roiCoverageRatio ?? null,
    roiStatus: request.roiStatus ?? null,
    targetPharmacies: targetPharmaciesWithValidation,
    // Not carried on the mapped domain object; read defensively rather than widen MarketingRequest
    // for one read-only field on one screen.
    trackDirectSales: (request as { trackDirectSales?: boolean }).trackDirectSales === true,
  };
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
  assertNotDecidingOwnRequest(request, actorHrId);
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
    // The database refused a self-decision. Reaching here means the chain had the requester on a
    // gating rung despite the submit-time guard — a request that predates this change, a hand-edited
    // assignment, or a routing change that re-pointed the rung. Surfaced as a 403 with the reason,
    // not the raw Postgres text.
    if (rpcErr.message?.includes("marketing_self_approval_refused")) {
      throw forbiddenError(
        "You raised this marketing request, so you cannot approve, reject or return it. Ask an administrator to reassign this step.",
      );
    }
    throw rpcErr;
  }
  const rpcData = rpcResult as {
    branch: "reject" | "return" | "approve_next" | "approve_final";
    isExecution: boolean;
    nextStep: MarketingRequestApprovalStepDbRow | null;
    request: MarketingRequestDbRow;
    step: MarketingRequestApprovalStepDbRow;
    /**
     * How many still-waiting rungs the reject closed out.
     *
     * A reject ends the chain, so every `pending` non-CC rung below it is marked `skipped` in the
     * same transaction — otherwise the inbox, the nav badge and every timeline keep reporting work
     * that will never happen. Returned by the RPC so this is recorded rather than inferred.
     * Absent on approve/return.
     */
    terminalised?: number;
  };
  const decidedStep = mapApprovalStep(rpcData.step);
  request = mapRequest(rpcData.request);
  // The finance landing counts requests awaiting a step and approved spend; the decision is saved.
  invalidateFinanceDashboardCache("marketing request step decided");

  // Every notice below goes out AFTER the reply (afterResponse, 2026-10-23 slow-buttons audit): the
  // decision is saved by now, so the approver who pressed the button never waits for the notice to the
  // next approver and the requester (profiles, preferences, event and audit rows, Telegram, the phone
  // push, the templated email). The request type's name is read only to word that notice, so it is
  // read inside the deferred task too. Outside a request (the unit suite, a script) `afterResponse`
  // simply awaits the task, as before.
  if (decision === "reject" || decision === "return") {
    await auditMarketingDecision({
      actorHrId,
      decision,
      request,
      step: decidedStep,
      summary: `Marketing request ${request.requestCode} ${decision === "reject" ? "rejected" : "returned"} at ${decidedStep.stepName}.${
        decision === "reject" && (rpcData.terminalised ?? 0) > 0
          ? ` ${rpcData.terminalised} later approval step${rpcData.terminalised === 1 ? "" : "s"} closed out.`
          : ""
      }`,
    });
    await afterResponse(`marketing_notice:${decision === "reject" ? "request_rejected" : "request_returned"}`, async () => {
      const requestTypeName = await loadMarketingRequestTypeName(supabase, request.requestTypeId);
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
    await afterResponse("marketing_notice:request_assigned", async () => {
      const requestTypeName = await loadMarketingRequestTypeName(supabase, request.requestTypeId);
      // A rung that opens for the second time - a chain restarted by a resubmit, or a request reopened
      // after a reject - must key its notice on that reopening, or the approver is never told again
      // (the delivery key is unique per rung). Read AFTER the decision committed: the step_opened event
      // is written by the trigger inside the RPC's own transaction. Same epoch the daily backfill
      // computes, so the two paths can never both send for one opening.
      const nextStepEpoch = await resolveMarketingStepReopenEpoch(supabase, request.id, currentNextStep.sequence);
      await notifyMarketingWorkflow({
        actorHrId,
        ccHrIds,
        eventType: "request_assigned",
        message: `${request.requestCode} is waiting for ${currentNextStep.stepName}.`,
        metadata: {
          assignedApproverHrId: currentNextStep.assignedHrId,
          currentStepId: currentNextStep.id,
          currentStepName: currentNextStep.stepName,
          ...(nextStepEpoch ? { idempotencyEpoch: nextStepEpoch } : {}),
          workflowApproverHrId: currentNextStep.assignedHrId,
          ...marketingNotificationVariables({ currentStep: currentNextStep, employeeRows, request, requestTypeName }),
        },
        priority: "high",
        request,
        title: "Marketing request assigned",
      });
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
  await afterResponse("marketing_notice:request_approved", async () => {
    const requestTypeName = await loadMarketingRequestTypeName(supabase, request.requestTypeId);
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
    licenseNameMatchesSign: row.license_name_matches_sign == null
      ? null
      : Boolean(row.license_name_matches_sign),
    lineId: row.line_id === null ? null : Number(row.line_id),
    managerHrId: row.manager_hr_id,
    mergedAt: row.merged_at ?? null,
    mergedByHrId: row.merged_by_hr_id ?? null,
    mergedIntoPharmacyId: row.merged_into_pharmacy_id ?? null,
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
    venueType: normalizeVenueType(row.venue_type),
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
  /** Requests settled against a direct order, by request id (direct-orders/marketing-offset-service.ts). */
  offsets?: Map<string, { amount: number; note: string | null; orderLabel: string }>;
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

    // The obligation is resolved here rather than read raw, so the row this table renders and the
    // row the export writes agree about what "Pending" means once the deadline has passed.
    const obligation = resolveMarketingInvoiceObligation({
      invoiceDeadlineDate: finance?.invoiceDeadlineDate ?? null,
      invoiceStatus: finance?.invoiceStatus ?? null,
    });

    return {
      contactForMoneyTransfer: requester?.displayName ?? request.requesterHrId,
      // NEVER the customer id. A raw UUID in this cell is not a degraded name, it is an unreadable
      // one, and the owner's standing rule is that the UI shows human-readable names and never raw
      // codes or ids. The loader resolves deactivated customers by id so this fallback should now
      // only fire when the customer row is genuinely gone; when it does, say so in words.
      customerName: customer?.displayName ?? "Unknown customer",
      directOrderOffset: params.offsets?.get(request.id) ?? null,
      financeProofFileName: finance?.moneyTransferProofOriginalFileName ?? null,
      financeProofStoragePath: finance?.moneyTransferProofStoragePath ?? null,
      id: request.id,
      invoiceDaysOverdue: obligation.daysOverdue,
      invoiceDeadlineDate: finance?.invoiceDeadlineDate ?? null,
      invoiceDueLabel: marketingInvoiceDueLabel({
        invoiceDeadlineDate: finance?.invoiceDeadlineDate ?? null,
        invoiceStatus: finance?.invoiceStatus ?? null,
      }),
      invoiceFileName: finance?.invoiceOriginalFileName ?? null,
      invoiceStatus: obligation.effectiveStatus,
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

/**
 * The distributor codes a draft is targeting.
 *
 * `reference_status`, `distributor_pharmacy_code` and `normalized_pharmacy_code` are NOT optional
 * extras: the CAPTURE GATE in `prepareMarketingRequestDraft` branches on `reference_status` and
 * builds its message from the other two. This selected only `id, pharmacy_id, active` until
 * 2026-08-23, so `code.reference_status` was `undefined` on every draft ever prepared and
 * `undefined === "not_found"` is false — the gate could not fire, and the whole override-reason
 * requirement was unreachable code.
 *
 * It did no damage only by luck. All 22 request targets written to production so far resolve
 * `matched`, so there was never a `not_found` case for the gate to miss. There is one offerable
 * `not_found` target today, and it is the fabricated nursery code this same change exists to
 * retire. Keep every column the gate reads in this select.
 */
async function fetchPharmacyCodes(supabase: SupabaseClient, distributorCodeIds: string[]) {
  if (distributorCodeIds.length === 0) return [];

  const { data, error } = await supabase
    .from("marketing_pharmacy_distributor_codes")
    .select("id, pharmacy_id, active, reference_status, distributor_pharmacy_code, normalized_pharmacy_code")
    .in("id", distributorCodeIds)
    .or("active.is.null,active.eq.true");

  if (error) throw error;
  return (data ?? []) as MarketingPharmacyDistributorCodeDbRow[];
}

/**
 * The customer's own active, validated venue links — the set a request target must come from.
 *
 * Same status list and same `active` rule as the request picker and the validated-venue gate below,
 * so the three can never disagree about which links count. One batched read per draft; a customer
 * holds 1-8 of them in production.
 */
async function fetchCustomerTargetLinks(
  supabase: SupabaseClient,
  customerId: string | null,
): Promise<CustomerTargetLink[]> {
  if (!customerId) return [];
  const { data, error } = await supabase
    .from("marketing_customer_pharmacies")
    .select("distributor_code_id, pharmacy_id, validation_status, validation_notes")
    .eq("customer_id", customerId)
    .or("active.is.null,active.eq.true")
    .in("validation_status", [...LINK_STATUS_PRECEDENCE]);
  if (error) throw error;
  return ((data ?? []) as Array<{
    distributor_code_id: string | null;
    pharmacy_id: string;
    validation_notes: string | null;
    validation_status: string | null;
  }>).map((row) => ({
    distributorCodeId: row.distributor_code_id ?? null,
    notes: row.validation_notes ?? null,
    pharmacyId: row.pharmacy_id,
    status: row.validation_status ?? null,
  }));
}

/**
 * Every marketing request draft must point at a customer that still holds a validated venue link,
 * and must itself name at least one target venue. Shared by the create and the resubmit paths
 * because they are the same decision: a resubmit deletes and re-inserts the products and the
 * targets, so it writes a draft just as much as a create does, and until 2026-09-06 it ran neither
 * of these two checks.
 *
 * The pair is deliberately not one function. They fail for different reasons and a requester can
 * only fix one of them: an unvalidated customer is fixed in the Customer Database, an empty target
 * list is fixed by ticking a box on the form in front of them.
 */
async function assertMarketingCustomerHasValidatedVenue(
  supabase: SupabaseClient,
  // `string | null`, because `normalizeMarketingRequestDraftInput` runs the id through `cleanText`.
  // Null is passed straight to `.eq` rather than guarded, which is exactly what the inline version
  // did: it matches no row and falls into the same refusal below. Both callers have already thrown
  // `customer_not_found` on a null id anyway, so this branch is unreachable in practice — narrowing
  // the parameter instead would only move the failure to a cast at each call site.
  customerId: string | null,
): Promise<void> {
  const validatedCustomerLinkResult = await supabase
    .from("marketing_customer_pharmacies")
    .select("id")
    .eq("customer_id", customerId)
    .eq("active", true)
    .in("validation_status", [...LINK_STATUS_PRECEDENCE])
    // Only a link that names a distributor code counts (owner, 2026-10-21) — the same test the
    // picker applies, so a customer whose only venue has no code is not a requestable customer.
    .not("distributor_code_id", "is", null)
    .limit(1);
  if (validatedCustomerLinkResult.error) throw validatedCustomerLinkResult.error;
  if ((validatedCustomerLinkResult.data ?? []).length === 0) {
    throw validationError("Only validated customers can be used in marketing request drafts.", "customer_not_validated");
  }
}

/**
 * A request naming no venue can never be credited a sale — attribution matches a sale to a request
 * through its target venue's distributor code, so an empty target list is not a lighter request,
 * it is an unmeasurable one. It also has no identity to validate, which is what AGENTS.md 4.1's
 * "GPS + a live picture ALWAYS" rule is written against.
 *
 * Enforced here rather than only in the form because the form's guard is a hint: the portal posts
 * a raw body, and the amber "No pharmacies selected" line it used to show did not stop Save.
 */
function assertMarketingRequestNamesAVenue(pharmacyRowCount: number): void {
  if (pharmacyRowCount > 0) return;
  throw validationError(
    "Select at least one target pharmacy — a request with no target can never be credited a sale.",
    "marketing_request_has_no_venue",
  );
}

/**
 * The codeless venues a draft is targeting, for the half of the picker that has no distributor code
 * to look up. Returns the venue itself rather than a code row, because that is all a nursery has.
 */
async function fetchVenuePharmacies(supabase: SupabaseClient, pharmacyIds: string[]) {
  if (pharmacyIds.length === 0) return [];

  const { data, error } = await supabase
    .from("marketing_pharmacies")
    .select("id, display_name, active, venue_type")
    .in("id", pharmacyIds)
    .or("active.is.null,active.eq.true");

  if (error) throw error;
  return (data ?? []) as Array<{
    id: string;
    display_name: string | null;
    active?: boolean | null;
    venue_type?: string | null;
  }>;
}

function emptyValidationSummary(): Record<MarketingValidationStatus, number> {
  return {
    admin_approved: 0,
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

/**
 * The viewer's own area, used by every territory-scoped marketing rule below.
 *
 * `employees.area_id` is a PATCH for a rep and a REGION for a manager. That asymmetry is deliberate
 * and safe: a rep matches the patch written on the record, a manager matches nothing and falls
 * through to the hierarchy rule, which was already serving managers correctly.
 */
export function viewerAreaIdFor(access: AccessContext, employeeRows: EmployeeDirectoryRow[]) {
  const viewerHrId = normalizeHrId(access.hrId);
  if (!viewerHrId) return null;
  return employeeRowByHrId(employeeRows).get(viewerHrId)?.areaId ?? null;
}

/**
 * A marketing customer belongs to a TERRITORY, not to a person.
 *
 * Owner ruling 2026-08-19, in his words: *"the customers are assigned to people. They must be
 * assigned to areas. Why? Because the employee resigns and another one is hired in his place, he
 * finds his customers automatically."*
 *
 * Before this, visibility read `owner_hr_id`/`manager_hr_id` and nothing else — so a customer was
 * bound to a human being and died with them. When a rep resigned the row kept pointing at the
 * departed employee, the replacement matched neither the identity test nor the hierarchy test, and
 * the customer went invisible to the person actually working the patch. The only repair was a
 * manual ownership backfill, which is exactly the busywork this rule abolishes: nothing is
 * re-stamped when somebody leaves, because the new hire's `employees.area_id` already matches the
 * area on the row.
 *
 * The area test is deliberately **line-agnostic**, the same rule he set for pharmacies earlier the
 * same day (see `canReuseMarketingPharmacy`): one customer is captured once for the whole area,
 * whatever line the colleague who captured them sells. That also settles the cross-line case he
 * calls a "treasure" — a doctor seen by Pedia and Anti Infective in one area becomes visible to
 * both reps with no ownership shifted and nobody's name moved, which is his standing rule there:
 * "never shift, you just select and highlight".
 *
 * `owner_hr_id` is NOT removed and NOT derived away. It stays as the audit record of who actually
 * captured and validated the customer; it simply stops being what grants sight of the row.
 */
export function canSeeMarketingCustomer(
  access: AccessContext,
  row: MarketingCustomerDbRow,
  employeeRows: EmployeeDirectoryRow[],
  viewerAreaId: number | null,
) {
  if (
    canSeeMarketingHierarchyRecord(access, {
      employeeHrId: row.owner_hr_id,
      managerHrId: row.manager_hr_id,
    }, employeeRows)
  ) {
    return true;
  }
  if (viewerAreaId === null || row.area_id === null || row.area_id === undefined) return false;
  return Number(row.area_id) === viewerAreaId;
}

/**
 * The WRITE-side twin of `canSeeMarketingCustomer`, for the two paths that raise a spend request
 * against a customer: `createMarketingRequestDraft` and `resubmitReturnedMarketingRequest`.
 *
 * Until this existed those paths loaded the customer by id and checked only that the row was there
 * and `active !== false` — nothing checked that the requester was allowed to SEE it. The dropdown
 * they pick from is scoped (getMarketingRequestDraftWorkspace filters through
 * `canSeeMarketingCustomer`), but a dropdown is a convenience, not a boundary: the request body
 * carries a raw `customerId`, so any marketing-capable employee who knew or guessed one could raise
 * a spend request against a customer on somebody else's patch, and it would enter the approval
 * chain looking entirely ordinary.
 *
 * Deliberately the SAME predicate as the read rule rather than a stricter one of its own. If you
 * can see a customer in the workspace you may request for it, and if you cannot, you may not —
 * one rule, so the picker and the server can never disagree about what is in scope. That includes
 * the territory route added by the 2026-08-19 ruling, so the rep hired into a resigned rep's patch
 * can raise requests for the customers they inherited without anything being re-stamped.
 *
 * Modelled on the pharmacy guard in `submitMarketingValidation` — same shape, same reasoning:
 * "the picker is a convenience, the visibility rule is the boundary".
 *
 * Measured against production before it shipped: of the 9 marketing_requests then on record, 0
 * would have been refused. Eight were raised by the customer's own owner and one by the Marketing
 * Manager, whose company-wide oversight role passes on the first branch of the rule.
 */
export function assertMarketingCustomerIsInScope(
  access: AccessContext,
  row: MarketingCustomerDbRow,
  employeeRows: EmployeeDirectoryRow[],
) {
  if (!canSeeMarketingCustomer(access, row, employeeRows, viewerAreaIdFor(access, employeeRows))) {
    throw forbiddenError("Forbidden: that customer is not one you can raise a request for.");
  }
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

/**
 * CHUNKS READ TOGETHER, ANSWERED IN ORDER (2026-10-01, "slow to transfer between page and page").
 * Each chunk of an id list is its own read and none needs another's answer, yet they ran one after
 * another. They now run a few at a time — `mapWithConcurrency` caps it, so a long list cannot open
 * dozens of connections at once — and the rows are concatenated in chunk order, as the loop pushed
 * them. A failure throws exactly what the loop threw: the first failed chunk in CHUNK order, whether
 * its read rejected or answered with an error.
 */
const ID_CHUNK_READS_TOGETHER = 6;

/** Exported for its test (tests/marketing-chunk-reads-in-order.test.ts). */
export async function readChunksInOrder<Row, Id>(
  batches: Id[][],
  read: (batch: Id[]) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<Row[]> {
  const outcomes = await mapWithConcurrency(batches, ID_CHUNK_READS_TOGETHER, async (batch) => {
    try {
      return { failed: false as const, result: await read(batch) };
    } catch (reason) {
      return { failed: true as const, reason };
    }
  });
  const rows: Row[] = [];
  for (const outcome of outcomes) {
    if (outcome.failed) throw outcome.reason;
    if (outcome.result.error) throw outcome.result.error;
    rows.push(...((outcome.result.data ?? []) as Row[]));
  }
  return rows;
}

async function fetchRowsByIds<T extends { id: string | number }>(
  supabase: SupabaseClient,
  table: string,
  ids: Array<string | number>,
) {
  if (ids.length === 0) return [];
  return readChunksInOrder<T, string | number>(chunk(ids), (batch) =>
    supabase.from(table).select("*").in("id", batch));
}

/**
 * Re-decide the customer's existing links once its own evidence has just been supplied.
 *
 * Without this the "complete an existing customer" path would be decorative. **The link row is the
 * gate** — the request dropdown and the draft guard both filter on `LINK_STATUS_PRECEDENCE`
 * (`admin_approved`, `sfe_validated`, `system_validated`) — and every link's status was frozen
 * at the moment it was written, from the customer evidence that existed *then*. A customer imported
 * with no photo therefore carries links stamped `pending`, and photographing the customer today
 * changes the customer row alone: the links stay pending, the customer stays unusable, and the rep
 * sees no result from the walk she just made.
 *
 * Three rules keep this from becoming a way to launder rows clean:
 *
 * - **Promotion only.** A link is touched only while it is `pending`. `rejected` is a human verdict
 *   and `system_validated` / `sfe_validated` / `admin_approved` are already better than anything
 *   computed here.
 * - **The pharmacy half still has to hold up.** `resolveMarketingSystemValidationStatus` is re-run
 *   in full, so a shop that was never photographed keeps its link pending exactly as before — the
 *   customer's new photo is not evidence about the shop.
 * - **A hold placed by a person is never lifted by a machine.** The governorate check is re-run from
 *   the shop's own capture against the code's registered region, and any link carrying
 *   `MARKETING_MANUAL_HOLD_MARKER` is skipped outright and annotated instead.
 *
 * Returns the number of links promoted, which the caller reports back to the rep — "your capture
 * released 2 pharmacies" is the only feedback that makes the walk feel worth making.
 */
async function refreshLinksAfterCustomerCompletion(input: {
  actorHrId: string | null;
  customerEvidenceStatus: MarketingEvidenceStatus;
  customerId: string;
  isOnBehalf: boolean;
  supabase: SupabaseClient;
}): Promise<number> {
  const { actorHrId, customerEvidenceStatus, customerId, isOnBehalf, supabase } = input;

  const linkQuery = await supabase
    .from("marketing_customer_pharmacies")
    .select("*")
    .eq("customer_id", customerId)
    .eq("validation_status", "pending")
    .neq("active", false);
  if (linkQuery.error) throw linkQuery.error;
  const links = (linkQuery.data ?? []) as MarketingCustomerPharmacyDbRow[];
  if (links.length === 0) return 0;

  const pharmacyRows = await fetchRowsByIds<MarketingPharmacyDbRow>(
    supabase,
    "marketing_pharmacies",
    Array.from(new Set(links.map((link) => link.pharmacy_id).filter(Boolean))),
  );
  const pharmaciesById = new Map(pharmacyRows.map((row) => [String(row.id), row]));

  const codeRows = await fetchRowsByIds<MarketingPharmacyDistributorCodeDbRow>(
    supabase,
    "marketing_pharmacy_distributor_codes",
    Array.from(new Set(links.map((link) => link.distributor_code_id).filter((id): id is string => Boolean(id)))),
  );
  const codesById = new Map(codeRows.map((row) => [String(row.id), row]));

  const referenceRows = await fetchRowsByIds<MarketingPharmacyCodeReferenceDbRow>(
    supabase,
    "marketing_pharmacy_code_references",
    Array.from(
      new Set(
        codeRows
          .map((row) => Number(row.reference_id ?? 0))
          .filter((referenceId) => Number.isFinite(referenceId) && referenceId > 0),
      ),
    ),
  );
  const referencesById = new Map(referenceRows.map((row) => [Number(row.id), row]));

  const nowIso = new Date().toISOString();
  let promoted = 0;

  for (const link of links) {
    const existingNotes = typeof link.validation_notes === "string" ? link.validation_notes : "";

    // Skipped, not released — and said so on the row, or the next person to read it has no way to
    // know the evidence half of the hold is now satisfied and it is theirs to release.
    if (existingNotes.includes(MARKETING_MANUAL_HOLD_MARKER)) {
      const alreadyAnnotated = existingNotes.includes(MARKETING_COMPLETED_CUSTOMER_NOTE);
      if (!alreadyAnnotated) {
        const annotate = await supabase
          .from("marketing_customer_pharmacies")
          .update({
            updated_at: nowIso,
            updated_by_hr_id: hrIdForStorage(actorHrId),
            validation_notes: `${existingNotes} ${MARKETING_COMPLETED_CUSTOMER_NOTE}`.trim(),
          })
          .eq("id", link.id);
        if (annotate.error) throw annotate.error;
      }
      continue;
    }

    const pharmacyRow = pharmaciesById.get(String(link.pharmacy_id));
    const codeRow = link.distributor_code_id ? codesById.get(String(link.distributor_code_id)) : null;
    // A link whose shop has gone is not something to reason about — leave it exactly as it is and
    // let the mapping screen surface it. A MISSING code is only a defect when the venue is supposed
    // to have one: a nursery link legitimately carries none, and refusing to reason about it here
    // is what would leave it held at "Not Usable Yet" after its customer was fully evidenced.
    // A link with no code is never promoted (owner, 2026-10-21): a venue without a distributor code
    // is not validated in Marketing at all — a nursery's link included. It stays where it is.
    if (!pharmacyRow) continue;
    if (!codeRow) continue;

    const distributorCode = codeRow ? mapDistributorCode(codeRow) : null;
    const reference = referencesById.get(Number(codeRow?.reference_id ?? 0));
    const governorateCheck = checkCapturedGovernorate({
      capturedAddress: pharmacyRow.captured_address,
      registeredAddress: reference?.raw_pharmacy_address,
      registeredRegion: reference?.raw_region,
    });
    const pharmacyEvidenceStatus = (pharmacyRow.evidence_status ?? "missing") as MarketingEvidenceStatus;
    const nextStatus = resolveMarketingValidationRecordStatus({
      isOnBehalf,
      systemStatus: resolveMarketingSystemValidationStatus({
        customerEvidenceStatus,
        governorateVerdict: governorateCheck.verdict,
        pharmacyEvidenceStatus,
      }),
    });
    if (nextStatus === "pending") continue;

    const update = await supabase
      .from("marketing_customer_pharmacies")
      .update({
        updated_at: nowIso,
        updated_by_hr_id: hrIdForStorage(actorHrId),
        validation_notes: [
          distributorCode ? buildUntrackedDistributorCodeNote(distributorCode.referenceStatus) : null,
          // The same sentence the capture path writes, so a link released later reads identically
          // to one released at capture rather than losing the only note that explains its ROI.
          distributorCode ? null : venueNonAttributableReason(normalizeVenueType(pharmacyRow.venue_type)),
          buildGovernorateMismatchNote(governorateCheck),
          MARKETING_RELEASED_BY_COMPLETION_NOTE,
        ].filter(Boolean).join(" ") || null,
        validation_status: nextStatus,
      })
      .eq("id", link.id)
      // Repeats the precondition so a link an admin ruled on while this ran is not overwritten.
      .eq("validation_status", "pending")
      .select("id")
      .maybeSingle();
    if (update.error) throw update.error;
    if (update.data) promoted += 1;
  }

  return promoted;
}

/**
 * The venue twin of `refreshLinksAfterCustomerCompletion`, and the half that makes completing a
 * shop worth anything at all.
 *
 * A link's status is frozen from the evidence that existed when the link was written. Every
 * customer already attached to a shop that had no photo was therefore stamped `pending` and stayed
 * there — so supplying the shop's missing proof would fix the venue row and leave every customer
 * waiting on it exactly as stuck as before. The three production venues this was built for carry
 * four such doctors between them.
 *
 * Deliberately keyed on the PHARMACY, and it re-reads each link's own customer: the customer half
 * of the verdict is whatever that customer's evidence says, which differs link by link and is none
 * of this submission's business. The governorate check is re-run too, against the fix just taken in
 * front of the shop — the previous verdict was computed with no captured address at all.
 *
 * Promotion only. A `rejected` link and a manual hold are human decisions; the hold is annotated so
 * the next reader sees a decision to make rather than a row waiting for a photograph.
 */
async function refreshLinksAfterPharmacyCompletion(input: {
  actorHrId: string | null;
  isOnBehalf: boolean;
  pharmacyRow: MarketingPharmacyDbRow;
  supabase: SupabaseClient;
}): Promise<number> {
  const { actorHrId, isOnBehalf, pharmacyRow, supabase } = input;

  const linkQuery = await supabase
    .from("marketing_customer_pharmacies")
    .select("*")
    .eq("pharmacy_id", pharmacyRow.id)
    .eq("validation_status", "pending")
    .neq("active", false);
  if (linkQuery.error) throw linkQuery.error;
  const links = (linkQuery.data ?? []) as MarketingCustomerPharmacyDbRow[];
  if (links.length === 0) return 0;

  const customerRows = await fetchRowsByIds<MarketingCustomerDbRow>(
    supabase,
    "marketing_customers",
    Array.from(new Set(links.map((link) => link.customer_id).filter(Boolean))),
  );
  const customersById = new Map(customerRows.map((row) => [String(row.id), row]));

  const codeRows = await fetchRowsByIds<MarketingPharmacyDistributorCodeDbRow>(
    supabase,
    "marketing_pharmacy_distributor_codes",
    Array.from(new Set(links.map((link) => link.distributor_code_id).filter((id): id is string => Boolean(id)))),
  );
  const codesById = new Map(codeRows.map((row) => [String(row.id), row]));

  const referenceRows = await fetchRowsByIds<MarketingPharmacyCodeReferenceDbRow>(
    supabase,
    "marketing_pharmacy_code_references",
    Array.from(
      new Set(
        codeRows
          .map((row) => Number(row.reference_id ?? 0))
          .filter((referenceId) => Number.isFinite(referenceId) && referenceId > 0),
      ),
    ),
  );
  const referencesById = new Map(referenceRows.map((row) => [Number(row.id), row]));

  const pharmacyEvidenceStatus = (pharmacyRow.evidence_status ?? "missing") as MarketingEvidenceStatus;
  const venueType = normalizeVenueType(pharmacyRow.venue_type);
  const nowIso = new Date().toISOString();
  let promoted = 0;

  for (const link of links) {
    const existingNotes = typeof link.validation_notes === "string" ? link.validation_notes : "";

    if (existingNotes.includes(MARKETING_MANUAL_HOLD_MARKER)) {
      if (!existingNotes.includes(MARKETING_COMPLETED_VENUE_NOTE)) {
        const annotate = await supabase
          .from("marketing_customer_pharmacies")
          .update({
            updated_at: nowIso,
            updated_by_hr_id: hrIdForStorage(actorHrId),
            validation_notes: `${existingNotes} ${MARKETING_COMPLETED_VENUE_NOTE}`.trim(),
          })
          .eq("id", link.id);
        if (annotate.error) throw annotate.error;
      }
      continue;
    }

    const customerRow = customersById.get(String(link.customer_id));
    const codeRow = link.distributor_code_id ? codesById.get(String(link.distributor_code_id)) : null;
    // Mirrors the customer sweep: a link whose other half has gone is not something to reason
    // about, and a missing code is only a defect on a venue that is supposed to carry one.
    // A link with no code is never promoted (owner, 2026-10-21), whatever the venue is.
    if (!customerRow) continue;
    if (!codeRow) continue;

    const distributorCode = codeRow ? mapDistributorCode(codeRow) : null;
    const reference = referencesById.get(Number(codeRow?.reference_id ?? 0));
    const governorateCheck = checkCapturedGovernorate({
      capturedAddress: pharmacyRow.captured_address,
      registeredAddress: reference?.raw_pharmacy_address,
      registeredRegion: reference?.raw_region,
    });
    const nextStatus = resolveMarketingValidationRecordStatus({
      isOnBehalf,
      systemStatus: resolveMarketingSystemValidationStatus({
        customerEvidenceStatus: (customerRow.evidence_status ?? "missing") as MarketingEvidenceStatus,
        governorateVerdict: governorateCheck.verdict,
        pharmacyEvidenceStatus,
      }),
    });
    if (nextStatus === "pending") continue;

    const update = await supabase
      .from("marketing_customer_pharmacies")
      .update({
        updated_at: nowIso,
        updated_by_hr_id: hrIdForStorage(actorHrId),
        validation_notes: [
          distributorCode ? buildUntrackedDistributorCodeNote(distributorCode.referenceStatus) : null,
          distributorCode ? null : venueNonAttributableReason(venueType),
          buildGovernorateMismatchNote(governorateCheck),
          MARKETING_RELEASED_BY_VENUE_COMPLETION_NOTE,
        ].filter(Boolean).join(" ") || null,
        validation_status: nextStatus,
      })
      .eq("id", link.id)
      // Repeats the precondition so a link an admin ruled on while this ran is not overwritten.
      .eq("validation_status", "pending")
      .select("id")
      .maybeSingle();
    if (update.error) throw update.error;
    if (update.data) promoted += 1;
  }

  return promoted;
}

/**
 * The confirmed names worth printing beside a venue: each one once, and never the venue's own.
 *
 * Pure and named, rather than inline, because both halves were found by reading a real screen
 * rather than the code — and a rule learned that way is the kind that gets quietly dropped the
 * next time this list is touched.
 */
export function uniqueAliasNames(names: readonly string[], ownName: string): string[] {
  const own = (ownName ?? "").trim();
  const seen = new Set<string>();
  for (const raw of names) {
    const name = (raw ?? "").trim();
    if (!name || name === own) continue;
    seen.add(name);
  }
  return [...seen];
}

function mapValidationReportRows(params: {
  /**
   * Confirmed cross-system names, keyed by marketing pharmacy id. Optional and defaulted, so the
   * report builds identically when the identity read failed — the desk's own job does not depend
   * on an annotation from another module.
   */
  aliasesByPharmacyId?: Map<string, string[]>;
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
    const distributorCode = link.distributorCodeId
      ? distributorCodes.get(link.distributorCodeId) ?? null
      : null;
    if (!customer || !pharmacy) continue;
    // A link that NAMES a code we could not load is broken and stays skipped. One that names none
    // is a venue with no distributor account, and belongs on the report like any other.
    if (link.distributorCodeId && !distributorCode) continue;

    summary[link.validationStatus] += 1;
    rows.push({
      customer,
      deskValidated: isDeskValidated(link.validationNotes),
      distributorCode,
      distributorName: distributorCode
        ? distributorNames.get(distributorCode.distributorId) ?? "Unknown distributor"
        : null,
      // Confirmed links only, and never a suggestion: the engine's maybes stay on the Super
      // Admin's own review screen. A maybe printed beside a verdict that cannot be corrected is
      // the worst place in the system to show one.
      //
      // 🔴 DEDUPED, AND THE VENUE'S OWN NAME DROPPED — both caught on production, not in review.
      //    `othersOnMaster` removes the row ASKED ABOUT, by source and id; it cannot know that a
      //    DIFFERENT row on the same master carries the identical spelling. Victoria hospital's
      //    master holds four marketing rows and listed "صيدلية مستشفي فيكتوريا" twice, and
      //    "السيد ابو الفتوح" read as an alias of itself. Neither is bad data — it is what a
      //    human confirmed — but a venue "also known as" its own name reads as a defect and
      //    teaches the desk to distrust the line.
      alsoKnownAs: uniqueAliasNames(params.aliasesByPharmacyId?.get(pharmacy.id) ?? [], pharmacy.displayName),
      id: link.id,
      inferredFromHistory: isInferredFromHistory(link.validationNotes),
      pharmacy,
      secondCodeBackfill: isSecondCodeBackfill(link.validationNotes),
      // Name-based wholesaler suspicion (owner rule, 2026-09-22), name-only — a marketing pharmacy
      // code is a different code space from the SoS override codes the detector keys on. A certain
      // wholesaler is already blocked upstream, so this only warns on the ambiguous فارما tier.
      suspectedWholesaler: suspectedWholesalerFlag(pharmacy.displayName),
      suspectedWholesalerNote: suspectedWholesalerNote(pharmacy.displayName),
      validationNotes: link.validationNotes,
      validationStatus: link.validationStatus,
    });
  }

  return { rows, summary };
}

function buildPharmacyCodeReferenceResult(matches: MarketingPharmacyCodeReferenceRowForMatch[]) {
  const matchCount = matches.length;
  const status: MarketingPharmacyCodeReferenceStatus =
    matchCount === 1 ? "matched" : matchCount > 1 ? "ambiguous" : "not_found";

  return {
    // The code AS THE SALES DATA CARRIES IT. On a single match this is what must be stored, not
    // what the rep typed — see resolvePharmacyCodeReference. Null on 0 or >1 matches, because
    // there is no one canonical row to point at.
    canonicalCode: matchCount === 1 ? normalizeLookupKey(matches[0].normalized_pharmacy_code) || null : null,
    matchCount,
    referenceId: matchCount === 1 ? Number(matches[0].id) : null,
    // Where the DISTRIBUTOR says this code lives. Carried on a single match only, for the same
    // reason as canonicalCode: with 0 or >1 rows there is no one address that describes the code.
    registeredAddress: matchCount === 1 ? cleanText(matches[0].raw_pharmacy_address) : null,
    registeredRegion: matchCount === 1 ? cleanText(matches[0].raw_region) : null,
    status,
  };
}

/**
 * Leading zeros stripped off a purely numeric code. POS — and only POS — exports its customer
 * codes zero-padded to 10 digits, so its reference row for pharmacy 1503246 reads '0001503246'
 * while the rep types what the pharmacy quotes. Mirrors `compact_pharmacy_code` in migration
 * 20260816050358; the two must agree or the indexed lookup silently returns nothing.
 *
 * Returns "" for anything not purely numeric, which the caller reads as "no second pass" — an
 * alphanumeric code that legitimately begins with '0' is never rewritten.
 */
function compactNumericCode(normalizedCode: string) {
  if (!/^[0-9]+$/.test(normalizedCode)) return "";
  return normalizedCode.replace(/^0+/, "") || "0";
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
  // PASS 1 — exact match on the indexed normalized column. `limit(2)` is enough
  // to distinguish not_found (0) / matched (1) / ambiguous (>=2) without scanning the
  // whole distributor.
  const primary = await params.supabase
    .from("marketing_pharmacy_code_references")
    .select("id, normalized_pharmacy_code, raw_pharmacy_address, raw_region")
    .eq("distributor_id", params.distributorId)
    .eq("normalized_pharmacy_code", params.normalizedPharmacyCode)
    .limit(2);

  if (!primary.error) {
    const exact = buildPharmacyCodeReferenceResult(
      (primary.data ?? []) as MarketingPharmacyCodeReferenceRowForMatch[],
    );
    if (exact.matchCount > 0) return exact;

    // PASS 2 — zero-padding-tolerant, and ONLY where pass 1 found nothing, so a code that
    // already matches can never change verdict. POS stores 61% of the reference database
    // zero-padded to 10 digits ('0001503246'), while the rep types what the pharmacy quotes
    // ('1503246'), so before this pass the check could effectively never say "tracked" for
    // the largest distributor.
    //
    // Lossless: verified over all 45,414 production rows, no two distinct codes inside one
    // distributor share a zero-stripped key. Should an import ever create one, this returns
    // 'ambiguous' rather than guessing.
    // Skipped only for a non-numeric code, which is never padding. It is NOT skipped just because
    // the typed code is already compact — that is the whole reported case: the rep types the short
    // form and the STORED row is the padded one, so pass 2 compares compact-to-compact.
    const compactCode = compactNumericCode(params.normalizedPharmacyCode);
    if (!compactCode) return exact;

    const compact = await params.supabase
      .from("marketing_pharmacy_code_references")
      .select("id, normalized_pharmacy_code, raw_pharmacy_address, raw_region")
      .eq("distributor_id", params.distributorId)
      .eq("compact_pharmacy_code", compactCode)
      .limit(2);
    // A database without the compact column yet is not an error worth failing the save for —
    // the exact verdict is still truthful, just stricter.
    if (compact.error) return exact;
    return buildPharmacyCodeReferenceResult(
      (compact.data ?? []) as MarketingPharmacyCodeReferenceRowForMatch[],
    );
  }

  // Fallback for databases where `normalized_pharmacy_code` has not been added yet
  // (e.g. before the accompanying migration is applied). Filters in memory but, unlike
  // the previous implementation, scans every reference for the distributor instead of an
  // arbitrary first 20 rows. Applies the same two passes, in the same order.
  const fallback = await params.supabase
    .from("marketing_pharmacy_code_references")
    .select("id, raw_pharmacy_code, raw_pharmacy_address, raw_region")
    .eq("distributor_id", params.distributorId);
  if (fallback.error) throw fallback.error;

  const rows = ((fallback.data ?? []) as MarketingPharmacyCodeReferenceDbRow[]).map((row) => ({
    id: row.id,
    normalized_pharmacy_code: normalizeLookupKey(row.raw_pharmacy_code),
    raw_pharmacy_address: row.raw_pharmacy_address,
    raw_region: row.raw_region,
  }));
  const exactMatches = rows.filter(
    (row) => row.normalized_pharmacy_code === params.normalizedPharmacyCode,
  );
  if (exactMatches.length > 0) return buildPharmacyCodeReferenceResult(exactMatches);

  const compactCode = compactNumericCode(params.normalizedPharmacyCode);
  if (!compactCode) return buildPharmacyCodeReferenceResult(exactMatches);
  return buildPharmacyCodeReferenceResult(
    rows.filter((row) => compactNumericCode(row.normalized_pharmacy_code) === compactCode),
  );
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

/**
 * The codes to offer the rep while he is typing, ranked by where he is standing.
 *
 * 🔒 RANKED, NEVER FILTERED — owner ruling, 2026-09-29: "build the code picker ranked by gps,
 * nothing filtered out". The place is used to ORDER the candidates and never to remove one, because
 * 25,811 of the 50,936 reference rows carry no area at all: a place filter would make half the
 * database unreachable and a shop with a blank reference row could never be captured. The only
 * narrowing here is the code the rep has actually typed and the distributor he picked — both of
 * which are his own input, not a judgement about him.
 *
 * Advisory. This never gates a submission and never writes; a failure degrades to an empty list and
 * the rep types the code exactly as he does today.
 */
export async function searchMarketingPharmacyCodeSuggestions(
  input: {
    areaName?: string | null;
    distributorId: number | string;
    governorateName?: string | null;
    pharmacyCode: string;
  },
  access: AccessContext,
): Promise<{ suggestions: RankedPharmacyCode[] }> {
  assertMarketingAccess(access);

  const distributorId = numberId(input.distributorId, "Distributor");
  const typed = normalizeLookupKey(input.pharmacyCode);
  // Below three characters every code in the distributor matches, which is a list, not a
  // suggestion. Silence is the honest answer until he has typed enough to mean something.
  if (typed.length < 3) return { suggestions: [] };

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("marketing_pharmacy_code_references")
    .select("raw_pharmacy_code, normalized_pharmacy_code, raw_pharmacy_address, raw_area, raw_region")
    .eq("distributor_id", distributorId)
    .ilike("normalized_pharmacy_code", `%${typed}%`)
    .limit(60);
  if (error) throw error;

  type ReferenceRow = {
    normalized_pharmacy_code?: string | null;
    raw_area?: string | null;
    raw_pharmacy_address?: string | null;
    raw_pharmacy_code?: string | null;
    raw_region?: string | null;
  };
  const rows = (data ?? []) as ReferenceRow[];

  // Names live in the sales master, not in the reference import — the rep recognises "اسعد جديدة"
  // far faster than he checks six digits, and that recognition is the whole value of the list.
  const codes = rows.map((row) => cleanText(row.raw_pharmacy_code)).filter(Boolean) as string[];
  const nameByCode = new Map<string, string>();
  if (codes.length > 0) {
    const named = await supabase
      .from("source_of_sales_customer_map")
      .select("customer_code, customer_name")
      .in("customer_code", codes);
    for (const row of (named.data ?? []) as Array<{ customer_code?: string | null; customer_name?: string | null }>) {
      const code = cleanText(row.customer_code);
      const name = cleanText(row.customer_name);
      if (code && name && !nameByCode.has(code)) nameByCode.set(code, name);
    }
  }

  // The rep's own typing orders the list underneath the ranking: a code that STARTS with what he
  // typed is likelier to be his than one that merely contains it. `rankPharmacyCodeSuggestions` is
  // a stable sort, so this ordering survives beneath the proximity tiers.
  const candidates: PharmacyCodeCandidate[] = rows
    .map((row) => ({
      address: cleanText(row.raw_pharmacy_address),
      areaName: cleanText(row.raw_area),
      code: cleanText(row.raw_pharmacy_code) ?? "",
      governorateName: cleanText(row.raw_region),
      name: nameByCode.get(cleanText(row.raw_pharmacy_code) ?? "") ?? null,
    }))
    .filter((row) => row.code.length > 0)
    .sort((a, b) => {
      const aStarts = normalizeLookupKey(a.code).startsWith(typed) ? 0 : 1;
      const bStarts = normalizeLookupKey(b.code).startsWith(typed) ? 0 : 1;
      return aStarts - bStarts || a.code.localeCompare(b.code);
    });

  return {
    suggestions: rankPharmacyCodeSuggestions(candidates, {
      areaName: input.areaName,
      governorateName: input.governorateName,
    }),
  };
}

async function fetchDistributorCodesByPharmacyIds(
  supabase: SupabaseClient,
  pharmacyIds: string[],
): Promise<MarketingPharmacyDistributorCodeDbRow[]> {
  // Chunks read together, answered in chunk order — see readChunksInOrder.
  return readChunksInOrder<MarketingPharmacyDistributorCodeDbRow, string>(chunk(pharmacyIds), (batch) =>
    supabase
      .from("marketing_pharmacy_distributor_codes")
      .select("*")
      .in("pharmacy_id", batch)
      .or("active.is.null,active.eq.true"));
}

/**
 * Who may attach an already-validated pharmacy to a new customer instead of capturing it again.
 *
 * Owner ruling 2026-08-19: his own, PLUS his team's and his AREA's — one shop is captured once for
 * the whole area, whatever line the colleague who captured it sells, because the shop is the same
 * shop either way. Hierarchy visibility alone was not enough: a Medical Rep has no subtree, so
 * `canSeeMarketingHierarchyRecord` would have limited him to pharmacies he personally validated and
 * left the shared-shop case exactly where it started.
 */
function canReuseMarketingPharmacy(
  access: AccessContext,
  row: MarketingPharmacyDbRow,
  employeeRows: EmployeeDirectoryRow[],
  viewerAreaId: number | null,
) {
  if (
    canSeeMarketingHierarchyRecord(
      access,
      { employeeHrId: row.owner_hr_id, managerHrId: row.manager_hr_id },
      employeeRows,
    )
  ) {
    return true;
  }
  if (viewerAreaId === null || row.area_id === null || row.area_id === undefined) return false;
  return Number(row.area_id) === viewerAreaId;
}

/**
 * The pharmacies the validation form offers back on its "My Pharmacies" tab.
 *
 * Restricted to rows somebody actually validated (`owner_hr_id` set), because linking a venue
 * nobody has ever stood in front of parks the customer that picked it on "Not Usable Yet" for a
 * reason the rep never caused.
 *
 * That filter is the ONLY thing holding the seeded rows back. It is NOT redundant with the area
 * check in `canReuseMarketingPharmacy`, and dropping it is not a tidy-up. Measured in production
 * on 2026-08-24: 280 active seeded venues, every one written by the same 2026-06-20 backfill, all
 * `evidence_status = 'missing'`, none carrying an owner or a manager, and every one carrying a
 * vendor code — so the no-code filter further down does not stop them either.
 *
 * The area is the part an earlier version of this comment had wrong, and it is the load-bearing
 * part: those rows do NOT have a null `area_id`. All 280 carry one, spread over 37 areas, up to 26
 * in a single area (Menoufia 2). Remove the owner filter and `canReuseMarketingPharmacy` admits
 * them on its area branch to every rep in those 37 areas, and admits all 280 to every company-wide
 * role — `canSeeMarketingHierarchyRecord` returns true for Super Admin, CEO, Finance Manager,
 * Financial Advisor, Marketing Manager and SFE Manager before it ever looks at the row.
 *
 * Evidence status still rides on every row returned, because a rep's OWN pharmacy can be short of a
 * photo too — the picker flags that rather than hiding the row (owner's standing rule: the system
 * flags, it does not refuse).
 */
async function buildReusableMarketingPharmacies(params: {
  access: AccessContext;
  distributorRows: MarketingDistributorDbRow[];
  employeeRows: EmployeeDirectoryRow[];
  links: MarketingCustomerPharmacyDbRow[];
  supabase: SupabaseClient;
}): Promise<MarketingReusablePharmacy[]> {
  const { access, distributorRows, employeeRows, links, supabase } = params;

  const pharmaciesResult = await supabase
    .from("marketing_pharmacies")
    .select("*")
    .not("owner_hr_id", "is", null)
    .or("active.is.null,active.eq.true")
    .order("display_name")
    .limit(MARKETING_WORKSPACE_SAFETY_LIMIT);
  if (pharmaciesResult.error) throw pharmaciesResult.error;

  const pharmacyRows = (pharmaciesResult.data ?? []) as MarketingPharmacyDbRow[];
  if (pharmacyRows.length === 0) return [];

  const employeesByHrId = employeeRowByHrId(employeeRows);
  const viewerHrId = normalizeHrId(access.hrId);
  const viewerAreaId = employeesByHrId.get(viewerHrId ?? "")?.areaId ?? null;
  const visible = pharmacyRows.filter((row) =>
    canReuseMarketingPharmacy(access, row, employeeRows, viewerAreaId),
  );
  if (visible.length === 0) return [];

  const codeRows = await fetchDistributorCodesByPharmacyIds(supabase, visible.map((row) => row.id));
  const distributorNameById = new Map(distributorRows.map((row) => [Number(row.id), row.display_name]));
  const codesByPharmacyId = new Map<string, MarketingReusablePharmacy["vendorCodes"]>();
  for (const code of codeRows) {
    const bucket = codesByPharmacyId.get(code.pharmacy_id) ?? [];
    const distributorId = Number(code.distributor_id ?? 0);
    bucket.push({
      distributorCodeId: code.id,
      distributorId,
      distributorName: distributorNameById.get(distributorId) ?? "Unknown distributor",
      distributorPharmacyCode: code.distributor_pharmacy_code ?? "",
      referenceStatus: code.reference_status ?? "pending",
    });
    codesByPharmacyId.set(code.pharmacy_id, bucket);
  }

  const customersByPharmacyId = new Map<string, Set<string>>();
  for (const link of links) {
    const bucket = customersByPharmacyId.get(link.pharmacy_id) ?? new Set<string>();
    bucket.add(link.customer_id);
    customersByPharmacyId.set(link.pharmacy_id, bucket);
  }

  return visible
    // Owner rule 2026-09-22 ("never never never"): a wholesaler / makhzan is never offered as a
    // reusable venue. Name-only here — a marketing pharmacy code is a different code space from the
    // Source-of-Sales override codes the detector reads, so passing it could only mis-key an owner
    // ruling. The two-tier detector still protects owner pharmacy-overrides by NAME.
    .filter((row) => !isCertainWholesalerVenue(row.display_name))
    // A venue with no distributor code is not offered for reuse, a nursery included (owner,
    // 2026-10-21: "any thing with no distributor code never reach the marketing requests") — it is
    // validated in Direct Orders, and the save would refuse it anyway.
    .filter((row) =>
      (codesByPharmacyId.get(row.id) ?? []).length > 0
      && venueRequiresDistributorCode(normalizeVenueType(row.venue_type)))
    .map((row) => {
      const ownerHrId = normalizeHrId(row.owner_hr_id);
      return {
        areaName: row.extracted_area_name ?? null,
        capturedAddress: row.captured_address ?? null,
        displayName: row.display_name ?? "",
        evidenceStatus: row.evidence_status ?? "missing",
        governorateName: row.extracted_governorate_name ?? null,
        id: row.id,
        isOwn: Boolean(viewerHrId) && ownerHrId === viewerHrId,
        linkedCustomerCount: customersByPharmacyId.get(row.id)?.size ?? 0,
        ownerHrId: row.owner_hr_id,
        ownerName: employeesByHrId.get(ownerHrId ?? "")?.displayName ?? null,
        pharmacyCode: row.pharmacy_code ?? "",
        validationStatus: row.validation_status ?? "pending",
        vendorCodes: codesByPharmacyId.get(row.id) ?? [],
        venueType: normalizeVenueType(row.venue_type),
      };
    });
}

export async function getMarketingValidationWorkspace(access: AccessContext): Promise<MarketingValidationWorkspace> {
  assertMarketingAccess(access);

  const supabase = getSupabaseAdmin();
  const [distributorsResult, linksResult, employeeRows] = await Promise.all([
    supabase.from("marketing_distributors").select("*").eq("active", true).order("display_name"),
    supabase
      .from("marketing_customer_pharmacies")
      .select("*")
      .eq("active", true)
      .order("created_at", { ascending: false })
      .limit(MARKETING_WORKSPACE_SAFETY_LIMIT),
    loadEmployeeDirectoryRows(),
  ]);

  if (distributorsResult.error) throw distributorsResult.error;
  if (linksResult.error) throw linksResult.error;

  const distributorRows = (distributorsResult.data ?? []) as MarketingDistributorDbRow[];
  const distributors = distributorRows.map(mapDistributor);
  const canActOnBehalf = canValidateMarketingOnBehalf(access);
  const links = (linksResult.data ?? []) as MarketingCustomerPharmacyDbRow[];

  // Built even when the workspace is otherwise empty: a rep whose only validated customer belongs
  // to a colleague still has that colleague's pharmacies to reuse, and the very first customer he
  // validates is exactly when re-typing a known shop hurts most.
  //
  // STARTED BESIDE THE ROW READS (2026-10-01, "slow to transfer between page and page"): the picker
  // reads nothing the report rows read, so it no longer holds them up. It is still settled FIRST —
  // its failure throws before any row-read failure, as when it ran first.
  const reusablePharmaciesRead = buildReusableMarketingPharmacies({
    access,
    distributorRows,
    employeeRows,
    links,
    supabase,
  });

  if (links.length === 0) {
    const emptyWorkspacePharmacies = await reusablePharmaciesRead;
    // A Super Admin still needs the picker on an empty workspace — validating the very first
    // customer for an employee is exactly when this screen is empty.
    return {
      canValidateOnBehalf: canActOnBehalf,
      distributors,
      onBehalfEmployees: canActOnBehalf ? buildMarketingOnBehalfEmployees(employeeRows) : [],
      reusablePharmacies: emptyWorkspacePharmacies,
      rows: [],
      summary: emptyValidationSummary(),
      viewerHrId: normalizeHrId(access.hrId) ?? "",
    };
  }

  // Each id once. Many links share a customer or a pharmacy, and the repeats only added chunks: the
  // report below looks every row up BY ID (mapValidationReportRows builds id-keyed maps), so a row
  // read twice was the same row twice.
  const [reusableSettled, rowReadsSettled] = await Promise.allSettled([
    reusablePharmaciesRead,
    Promise.all([
      fetchRowsByIds<MarketingCustomerDbRow>(
        supabase,
        "marketing_customers",
        [...new Set(links.map((row) => row.customer_id))],
      ),
      fetchRowsByIds<MarketingPharmacyDbRow>(
        supabase,
        "marketing_pharmacies",
        [...new Set(links.map((row) => row.pharmacy_id))],
      ),
      fetchRowsByIds<MarketingPharmacyDistributorCodeDbRow>(
        supabase,
        "marketing_pharmacy_distributor_codes",
        [...new Set(links.map((row) => row.distributor_code_id).filter((id): id is string => Boolean(id)))],
      ),
    ]),
  ]);
  if (reusableSettled.status === "rejected") throw reusableSettled.reason;
  const reusablePharmacies = reusableSettled.value;
  if (rowReadsSettled.status === "rejected") throw rowReadsSettled.reason;
  const [customerRows, pharmacyRows, codeRows] = rowReadsSettled.value;

  const customerViewerAreaId = viewerAreaIdFor(access, employeeRows);
  const visibleCustomers = customerRows.filter((row) =>
    canSeeMarketingCustomer(access, row, employeeRows, customerViewerAreaId),
  );
  const visibleCustomerIds = new Set(visibleCustomers.map((row) => row.id));
  const visibleLinks = links.filter((row) => visibleCustomerIds.has(row.customer_id));
  // 🔴 READ AFTER THE VISIBILITY FILTER, and only for the pharmacies that survived it. A viewer
  //    who may not see a customer must not learn one of its venues exists because an alias
  //    mentions it — `access.ts`'s own rule, applied to the annotation as well as to the rows.
  //    A failure costs the annotation and nothing else: the desk's job is the verdict.
  const visiblePharmacyIds = [...new Set(visibleLinks.map((row) => row.pharmacy_id).filter(Boolean))];
  const aliasesByPharmacyId = await loadAlsoKnownAsBatch("marketing", visiblePharmacyIds)
    .then((found) => new Map([...found].map(([id, rows]) => [id, rows.map((row) => row.name).filter(Boolean)])))
    .catch(() => new Map<string, string[]>());

  const report = mapValidationReportRows({
    aliasesByPharmacyId,
    customers: visibleCustomers,
    distributorCodes: codeRows,
    distributors: distributorRows,
    links: visibleLinks,
    pharmacies: pharmacyRows,
  });

  return {
    canValidateOnBehalf: canActOnBehalf,
    distributors,
    onBehalfEmployees: canActOnBehalf ? buildMarketingOnBehalfEmployees(employeeRows) : [],
    reusablePharmacies,
    rows: report.rows,
    summary: report.summary,
    viewerHrId: normalizeHrId(access.hrId) ?? "",
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
  const distributorCodeIds = Array.from(
    new Set(links.map((row) => row.distributor_code_id).filter((id): id is string => Boolean(id))),
  );

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
  // The licence photo, signed, for every venue in this register — the reviewers (SFE, admin,
  // marketing, CEO) read it BIG beside the verdict. Same posture as the approver screens: a licence
  // that will not resolve renders as "none attached", never as a page that will not open.
  const licenseByPharmacyId = await loadMarketingPharmacyLicensesByPharmacyIds({
    pharmacyIds,
    supabase,
  }).catch(() => new Map<string, MarketingPharmacyLicenseFile>());
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
    const distributorCode = link.distributor_code_id ? mappedCodes.get(link.distributor_code_id) : null;
    if (!customer || !pharmacy) return [];
    // A missing code is a broken row for a pharmacy and the normal state for a nursery. Dropping
    // the second kind would hide a validated venue from the screen whose whole job is to list them.
    // ...except a pharmacy saved on its licence alone, which is codeless ON PURPOSE and carries the
    // marker in its notes: it must stay in the list so the validation queue can show it and a
    // Super Admin or the CEO can read its licence and release it.
    if (
      !distributorCode
      && venueRequiresDistributorCode(pharmacy.venueType)
      && !isLicenseOnlyPharmacyNote(link.validation_notes)
    ) return [];

    const distributor = distributorCode ? distributors.get(distributorCode.distributorId) : undefined;
    const contact = contactsByCustomer.get(customer.id);
    const customerPhone = cleanText(contact?.mobile_number) ?? null;

    return [{
      createdAt: nowIsoFallback(link.created_at),
      customerAddress: customer.capturedAddress,
      customerArea: customer.extractedAreaName,
      customerCode: customer.customerCode,
      customerEvidenceStatus: customer.evidenceStatus,
      customerGovernorate: customer.extractedGovernorateName,
      customerId: customer.id,
      customerName: customer.displayName,
      customerPhone,
      customerType: customer.customerType,
      customerValidationPhoto: customer.evidencePhotoName,
      deskValidated: isDeskValidated(link.validation_notes),
      distributorCode: distributorCode
        ? distributor?.distributorCode ?? String(distributorCode.distributorId)
        : null,
      distributorId: distributorCode?.distributorId ?? null,
      distributorName: distributorCode ? distributor?.displayName ?? "Unknown distributor" : null,
      inferredFromHistory: isInferredFromHistory(link.validation_notes),
      licenseContentType: licenseByPharmacyId.get(pharmacy.id)?.contentType ?? null,
      licenseNameMatchesSign: pharmacy.licenseNameMatchesSign,
      // The marker stays in the notes for good, so the banner is read from the STATUS too: once a
      // person has released the link it is no longer "not usable yet", and saying so would be wrong.
      licenseOnly: isLicenseOnlyPharmacyNote(link.validation_notes) && link.validation_status === "pending",
      licenseReleased: isLicenseOnlyPharmacyNote(link.validation_notes) && link.validation_status === "admin_approved",
      licenseUrl: licenseByPharmacyId.get(pharmacy.id)?.signedUrl ?? null,
      pharmacyAddress: pharmacy.capturedAddress,
      pharmacyArea: pharmacy.extractedAreaName,
      pharmacyCode: pharmacy.pharmacyCode,
      pharmacyDistributorCodeId: distributorCode?.id ?? null,
      pharmacyEvidenceStatus: pharmacy.evidenceStatus,
      pharmacyGovernorate: pharmacy.extractedGovernorateName,
      pharmacyId: pharmacy.id,
      pharmacyName: pharmacy.displayName,
      rowId: link.id,
      secondCodeBackfill: isSecondCodeBackfill(link.validation_notes),
      validationStatus: link.validation_status ?? "pending",
      vendorPharmacyCode: distributorCode?.distributorPharmacyCode ?? null,
      venueType: pharmacy.venueType,
    }];
  });

  return {
    rows,
    summary: {
      customers: new Set(rows.map((row) => row.customerId)).size,
      pharmacies: new Set(rows.map((row) => row.pharmacyId)).size,
      rows: rows.length,
      vendors: new Set(rows.map((row) => row.distributorId).filter((id) => id !== null)).size,
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

/**
 * The before/after of ONLY the columns a control write touched, for its audit row. `before` is the
 * raw row read just ahead of the write; a column the row did not carry reads as null.
 */
function controlChangeValues(before: Record<string, unknown>, update: Record<string, unknown>) {
  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(update)) {
    if (key === "updated_at") continue;
    oldValues[key] = before[key] ?? null;
    newValues[key] = value;
  }
  return { newValues, oldValues };
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
  // Required: a setting steers how every request is routed and what finance expects, and it was
  // changeable with no record of who did it or what it held before.
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityId: settingKey,
    entityType: "marketing_control",
    newValues: { setting: settingKey, value },
    oldValues: { setting: settingKey, value: existing.value },
    summary: `Marketing control setting "${existing.label}" (${settingKey}) was changed.`,
  });
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
  const beforeResult = await supabase.from("marketing_request_types").select("*").eq("id", id).maybeSingle();
  if (beforeResult.error) throw beforeResult.error;
  if (!beforeResult.data) throw notFoundError("Request type was not found.", "request_type_not_found");
  const result = await supabase
    .from("marketing_request_types")
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (result.error) throw result.error;
  const changed = controlChangeValues(beforeResult.data as Record<string, unknown>, update);
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityId: String(id),
    entityType: "marketing_control",
    newValues: { requestTypeId: id, ...changed.newValues },
    oldValues: { requestTypeId: id, ...changed.oldValues },
    summary:
      `Marketing request type "${(beforeResult.data as { name?: string | null }).name ?? id}" was changed: `
      + `${Object.keys(changed.newValues).join(", ")}.`,
  });
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
  const beforeResult = await supabase.from("marketing_workflow_steps").select("*").eq("id", id).maybeSingle();
  if (beforeResult.error) throw beforeResult.error;
  if (!beforeResult.data) throw notFoundError("Workflow step was not found.", "workflow_step_not_found");
  const result = await supabase
    .from("marketing_workflow_steps")
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (result.error) throw result.error;
  // Required: this decides WHO approves marketing spend, from the next request on - a step turned
  // off or re-pointed at another role changes the chain with nothing else on record.
  const changed = controlChangeValues(beforeResult.data as Record<string, unknown>, update);
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityId: String(id),
    entityType: "marketing_control",
    newValues: { workflowStepId: id, ...changed.newValues },
    oldValues: { workflowStepId: id, ...changed.oldValues },
    summary:
      `Marketing approval step "${(beforeResult.data as { step_name?: string | null }).step_name ?? id}" was changed: `
      + `${Object.keys(changed.newValues).join(", ")}.`,
  });
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

  // --- The area → doctor pick, re-checked for every NEW customer before anything is written ----
  // (owner, 2026-10-23). A picked doctor's name is taken from the rep's CRM list, so the link is
  // true; a typed one ("Not on the list", or an offline capture queued before the rule) is saved as
  // typed and flagged `not_on_list` on every approval step. A customer already on record keeps its
  // identity untouched, so it is never re-picked here.
  // The CRM read is loaded only when something was picked, so a typed-name save never pays for it.
  const doctorPickReach: { reach?: OrgSeat[] } = {};
  const doctorPicks = new Map<NormalizedMarketingValidationCustomer, ResolvedCrmDoctorPick>();
  for (const entry of normalized.customers) {
    if (entry.existingCustomerId) continue;
    const pick = entry.crmAreaSeatId || entry.crmCustomerId
      ? await (await import("@/lib/marketing-requests/crm-doctor-pick-service")).resolveCrmDoctorPick(
        access,
        { areaSeatId: entry.crmAreaSeatId, crmCustomerId: entry.crmCustomerId },
        doctorPickReach,
      )
      : UNPICKED_CRM_DOCTOR;
    if (pick.phoenixCrmCustomerId && [...doctorPicks.values()].some((seen) => seen.phoenixCrmCustomerId === pick.phoenixCrmCustomerId)) {
      throw validationError(`"${pick.displayName ?? entry.displayName}" appears more than once in this submission.`, "duplicate_customer");
    }
    if (pick.displayName && pick.displayName !== entry.displayName) {
      entry.displayName = pick.displayName;
      entry.normalizedName = normalizeLookupKey(pick.displayName);
    }
    doctorPicks.set(entry, pick);
  }

  // --- "My Pharmacies" picks, resolved once for the whole submission -------------------------
  // The client sent ids and nothing else, so the shop's name, location, evidence and distributor
  // codes are read here from the stored rows. Resolving up front also means an unusable pick fails
  // before a single customer is written, rather than half-way through a multi-customer save.
  const reusedPharmacyIds = Array.from(
    new Set(
      normalized.customers.flatMap((entry) =>
        entry.pharmacies
          .map((pharmacy) => pharmacy.existingPharmacyId)
          .filter((value): value is string => Boolean(value)),
      ),
    ),
  );
  const reusedPharmacyRows = new Map<string, MarketingPharmacyDbRow>();
  const reusedCodesByPharmacyId = new Map<string, MarketingPharmacyDistributorCodeDbRow[]>();
  const reusedReferencesById = new Map<number, MarketingPharmacyCodeReferenceDbRow>();
  if (reusedPharmacyIds.length > 0) {
    const rows = await fetchRowsByIds<MarketingPharmacyDbRow>(
      supabase,
      "marketing_pharmacies",
      reusedPharmacyIds,
    );
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    const viewerAreaId = employeeRowByHrId(employeeRows).get(normalizeHrId(access.hrId) ?? "")?.areaId ?? null;
    for (const pharmacyId of reusedPharmacyIds) {
      const row = rowsById.get(pharmacyId);
      if (!row) throw notFoundError("That pharmacy was not found.", "pharmacy_not_found");
      if (row.active === false) {
        throw validationError(`Pharmacy "${row.display_name ?? pharmacyId}" is no longer active.`);
      }
      // Re-checked on the server, never trusted from the payload: the picker is a convenience, the
      // visibility rule is the boundary. Same rule that built the list — own, team, or same area.
      if (!row.owner_hr_id || !canReuseMarketingPharmacy(access, row, employeeRows, viewerAreaId)) {
        throw forbiddenError("Forbidden: that pharmacy is not one you can attach to a customer.");
      }
      // Owner rule 2026-09-22 ("never never never"): a wholesaler / makhzan is never accepted as a
      // venue — including one that was validated before this guard existed and is now being reused.
      // Name-only (a marketing pharmacy code is a different code space from the SoS override codes).
      if (isCertainWholesalerVenue(row.display_name)) {
        throw validationError(WHOLESALER_VENUE_REFUSED_MESSAGE, "venue_is_wholesaler");
      }
      reusedPharmacyRows.set(pharmacyId, row);
    }

    for (const code of await fetchDistributorCodesByPharmacyIds(supabase, reusedPharmacyIds)) {
      const bucket = reusedCodesByPharmacyId.get(code.pharmacy_id) ?? [];
      bucket.push(code);
      reusedCodesByPharmacyId.set(code.pharmacy_id, bucket);
    }
    // A reused venue with no distributor code is refused, whatever it is (owner, 2026-10-21: "any
    // thing with no distributor code never reach the marketing requests"). Until then a nursery
    // reused freely and a codeless pharmacy was accepted on its licence and held; both are validated
    // in Direct Orders now. Refused before a single customer is written.
    for (const pharmacyId of reusedPharmacyIds) {
      const row = reusedPharmacyRows.get(pharmacyId);
      const hasCode = (reusedCodesByPharmacyId.get(pharmacyId) ?? []).length > 0;
      if (!hasCode || !venueRequiresDistributorCode(normalizeVenueType(row?.venue_type))) {
        throw validationError(
          venueWithoutDistributorCodeMessage(row?.display_name ?? pharmacyId),
          VENUE_WITHOUT_DISTRIBUTOR_CODE,
        );
      }
    }

    // The registered address behind each reused code, so attaching an existing shop faces the same
    // governorate check a freshly captured one does. Without this, a pharmacy held on `pending`
    // for a Cairo-vs-Alexandria contradiction could be laundered into a `system_validated` link
    // simply by attaching it to a second customer — the same laundering the evidence rule already
    // refuses to allow for a shop that was never photographed.
    //
    // One batched read for the whole submission, keyed by the code row's stored `reference_id`,
    // rather than re-running `resolvePharmacyCodeReference` per code: the reference was already
    // resolved when the pharmacy was first captured, and its id is on the row. `select("*")` also
    // means a database predating the address columns returns rows without them, which reads as a
    // blank region and therefore `not_comparable` — never a false contradiction.
    const reusedReferenceIds = Array.from(
      new Set(
        Array.from(reusedCodesByPharmacyId.values())
          .flat()
          .map((code) => Number(code.reference_id ?? 0))
          .filter((referenceId) => Number.isFinite(referenceId) && referenceId > 0),
      ),
    );
    for (const row of await fetchRowsByIds<MarketingPharmacyCodeReferenceDbRow>(
      supabase,
      "marketing_pharmacy_code_references",
      reusedReferenceIds,
    )) {
      reusedReferencesById.set(Number(row.id), row);
    }
  }

  const distributorIds = Array.from(
    new Set(
      normalized.customers.flatMap((entry) =>
        entry.pharmacies.flatMap((pharmacy) => pharmacy.vendorCodes.map((code) => code.distributorId)),
      ),
    ),
  );
  // Empty whenever every pharmacy in the submission was attached rather than captured — there is
  // no freshly typed code to check, and an `in.()` against no ids is not worth a round trip.
  const distributorsResult = distributorIds.length > 0
    ? await supabase
      .from("marketing_distributors")
      .select("*")
      .in("id", distributorIds)
      .eq("active", true)
    : { data: [] as MarketingDistributorDbRow[], error: null };
  if (distributorsResult.error) throw distributorsResult.error;

  const distributorRows = (distributorsResult.data ?? []) as MarketingDistributorDbRow[];
  const distributorsById = new Map(distributorRows.map((row) => [Number(row.id), row]));
  for (const distributorId of distributorIds) {
    if (!distributorsById.has(distributorId)) {
      throw notFoundError(`Distributor ${distributorId} was not found.`, "distributor_not_found");
    }
  }

  // A reused pharmacy's distributor is looked up WITHOUT the active filter that guards a freshly
  // typed code. Its code row was accepted when the pharmacy was first validated; a distributor
  // retired since then is a reason to stop offering NEW codes, not a reason to refuse a rep the
  // shop his colleague already proved. Only the display name is taken from it.
  const missingDistributorIds = Array.from(
    new Set(
      Array.from(reusedCodesByPharmacyId.values())
        .flat()
        .map((code) => Number(code.distributor_id ?? 0))
        .filter((distributorId) => distributorId > 0 && !distributorsById.has(distributorId)),
    ),
  );
  if (missingDistributorIds.length > 0) {
    const extraDistributors = await supabase
      .from("marketing_distributors")
      .select("*")
      .in("id", missingDistributorIds);
    if (extraDistributors.error) throw extraDistributors.error;
    for (const row of (extraDistributors.data ?? []) as MarketingDistributorDbRow[]) {
      distributorsById.set(Number(row.id), row);
    }
  }

  // --- "Complete the customer already on record" picks, resolved once for the whole submission --
  // Same reasoning as the pharmacy preload above: an unusable pick fails before a single row is
  // written, rather than half-way through. The scope check is the boundary here — the Pending tab
  // offered the id, but a payload can name ANY customer id, including one on another rep's patch.
  const completedCustomerRows = new Map<string, MarketingCustomerDbRow>();
  // Customers already complete whose VENUE is what this submission completes — see the door left
  // open in the preload below. Their row is never written.
  const venueOnlyCustomerIds = new Set<string>();
  const existingLinksByCustomerAndCode = new Map<string, MarketingCustomerPharmacyDbRow>();
  const existingCustomerIds = Array.from(
    new Set(
      normalized.customers
        .map((entry) => entry.existingCustomerId)
        .filter((value): value is string => Boolean(value)),
    ),
  );
  if (existingCustomerIds.length > 0) {
    const rows = await fetchRowsByIds<MarketingCustomerDbRow>(
      supabase,
      "marketing_customers",
      existingCustomerIds,
    );
    const rowsById = new Map(rows.map((row) => [String(row.id), row]));
    for (const existingCustomerId of existingCustomerIds) {
      const row = rowsById.get(existingCustomerId);
      if (!row) throw notFoundError("That customer was not found.", "customer_not_found");
      assertMarketingCustomerIsInScope(access, row, employeeRows);
      if (row.active === false) {
        throw validationError(`Customer "${row.display_name ?? existingCustomerId}" is no longer active.`);
      }
      // Evidence that already exists is PROOF, and proof is never overwritten by a later capture.
      // Without this, a second submission could quietly replace the photo and GPS standing behind
      // an already-validated customer — the same class of defect `evidenceStatusFromInput` exists
      // to prevent, arriving through a different door.
      //
      // One door stays open: a customer whose OWN evidence is complete but whose venue is not. The
      // Pending tab offers "Capture Evidence" for it too, because the rep can only fix the half that
      // is short, and that half is the venue. It is admitted only when the submission brings no
      // complete customer capture of its own (so nothing on the customer can be replaced) and names
      // at least one venue already on file (so there is something to complete). The customer row is
      // then left exactly as it is and only the venue's evidence is written.
      if (row.evidence_status === "complete") {
        const submitted = normalized.customers.find((entry) => entry.existingCustomerId === existingCustomerId);
        const isVenueOnly = Boolean(
          submitted
          && submitted.evidenceStatus !== "complete"
          && submitted.pharmacies.some((entry) => entry.existingPharmacyId),
        );
        if (!isVenueOnly) {
          throw validationError(
            `Customer "${row.display_name ?? existingCustomerId}" already has complete evidence.`,
            "customer_already_evidenced",
          );
        }
        venueOnlyCustomerIds.add(existingCustomerId);
      }
      completedCustomerRows.set(existingCustomerId, row);
    }

    // The links these customers ALREADY carry, so re-attaching the shop a customer is already
    // linked to updates that row instead of colliding with the unique index on
    // (customer_id, distributor_code_id). Read once for the whole submission — the alternative is
    // a lookup per reused distributor code, per customer.
    const existingLinkQuery = await supabase
      .from("marketing_customer_pharmacies")
      .select("*")
      .in("customer_id", existingCustomerIds);
    if (existingLinkQuery.error) throw existingLinkQuery.error;
    for (const row of (existingLinkQuery.data ?? []) as MarketingCustomerPharmacyDbRow[]) {
      // Keyed on the pharmacy when there is no code. Postgres does not treat two NULLs as equal, so
      // the unique index on (customer_id, distributor_code_id) does NOT stop a codeless venue being
      // linked to the same customer twice — this lookup and the partial index added alongside it in
      // migration 20260823060000 are what do.
      existingLinksByCustomerAndCode.set(
        row.distributor_code_id
          ? `${row.customer_id}::${row.distributor_code_id}`
          : `${row.customer_id}::venue::${row.pharmacy_id}`,
        row,
      );
    }
  }

  // Every customer and pharmacy minted by THIS submission, so a failure part-way through a
  // multi-customer save removes all of them rather than leaving the earlier ones stranded in the
  // owner's book with no pharmacies attached.
  const customerIds: string[] = [];
  const pharmacyIds: string[] = [];
  // The rollback set for the OTHER path. A completed customer predates this submission, so it must
  // never be deleted — but its capture columns were just overwritten, and the rule that a record
  // must never survive its own evidence applies here exactly as it does to a minted one. Undoing
  // means restoring the values that were read at preload time, not removing a row.
  const completedCustomerUndo: Array<{ before: MarketingCustomerDbRow; id: string }> = [];
  // The same idea for venues: a pharmacy this submission COMPLETED rather than created. Like a
  // completed customer it predates the request, so a rollback restores its evidence instead of
  // deleting the row.
  const completedPharmacyUndo: Array<{ before: MarketingPharmacyDbRow; id: string }> = [];
  // Every distributor-code row minted here, so the Source-of-Sales master resolver can be pointed
  // at exactly this submission once the writes are done. Collected rather than re-queried because
  // the ids are already in hand, and because an explicit list is what keeps the resolver off the
  // whole table — see src/lib/marketing-requests/master-resolution.ts.
  const distributorCodeIds: string[] = [];
  // Every distributor code this submission ATTACHED to a venue, minted or already on file. The
  // resolver above must only ever see the minted ones — re-resolving an old code is work nobody
  // asked for — but deciding WHERE a submission stands is a question its reused venues answer just
  // as well: a pharmacy already on file has a registered code, and that code is already resolved.
  const attachedDistributorCodeIds: string[] = [];
  // Storage objects written by THIS submission. Tracked alongside the row ids because a bucket
  // object outlives a rolled-back insert unless it is explicitly removed, and an orphaned photo of
  // a real shop front is exactly the kind of thing that must not linger unreferenced.
  const evidencePhotoPaths: string[] = [];
  try {
    const rows: MarketingValidationReportRow[] = [];
    for (const normalizedCustomer of normalized.customers) {
    const existingCustomerRow = normalizedCustomer.existingCustomerId
      ? completedCustomerRows.get(normalizedCustomer.existingCustomerId) ?? null
      : null;
    // A complete customer being here only for its venue. Its row is never written, and every link
    // verdict below reads the evidence the row ALREADY holds — the submission carries no customer
    // capture, so reading it would stamp a customer that has a complete photo as still short.
    const isVenueOnly = Boolean(existingCustomerRow && venueOnlyCustomerIds.has(existingCustomerRow.id));
    const customerEvidenceStatus: MarketingEvidenceStatus = existingCustomerRow && isVenueOnly
      ? ((existingCustomerRow.evidence_status ?? "missing") as MarketingEvidenceStatus)
      : normalizedCustomer.evidenceStatus;

    // What the rep captured — identical on both paths, because completing a customer runs through
    // exactly the same normalization and the same evidence rule as creating one. What is absent
    // here is IDENTITY (code, name, type, owner, area, line): supplying a customer's missing
    // evidence must not re-label it, or the ROI history would stop pointing at the same record.
    const capturedColumns = {
      captured_accuracy_meters: normalizedCustomer.capturedAccuracyMeters,
      captured_address: normalizedCustomer.capturedAddress,
      captured_at: normalizedCustomer.capturedAt,
      captured_latitude: normalizedCustomer.capturedLatitude,
      captured_longitude: normalizedCustomer.capturedLongitude,
      evidence_has_timestamp: normalizedCustomer.evidenceHasTimestamp,
      evidence_photo_captured_at: normalizedCustomer.evidencePhotoCapturedAt,
      evidence_photo_name: normalizedCustomer.evidencePhotoName,
      evidence_status: normalizedCustomer.evidenceStatus,
      extracted_area_name: normalizedCustomer.extractedAreaName,
      extracted_governorate_name: normalizedCustomer.extractedGovernorateName,
      region_name: normalizedCustomer.regionName,
      updated_by_hr_id: hrIdForStorage(actorHrId),
      validated_at: adminValidatedAt,
      validated_by_hr_id: adminValidatedByHrId,
      validation_notes: adminValidationNote,
      validation_status: resolveMarketingValidationRecordStatus({
        isOnBehalf,
        systemStatus: normalizedCustomer.validationStatus,
      }),
    };

    let customer: MarketingCustomer;
    if (existingCustomerRow && isVenueOnly) {
      // Nothing on the customer is written — no update, no undo entry, no photo, no contact.
      customer = mapCustomer(existingCustomerRow);
    } else if (existingCustomerRow) {
      // The `.neq` repeats the precondition checked at preload time so a concurrent completion
      // loses cleanly rather than overwriting the capture that got there first.
      const customerUpdate = await supabase
        .from("marketing_customers")
        .update({ ...capturedColumns, updated_at: new Date().toISOString() })
        .eq("id", existingCustomerRow.id)
        .neq("evidence_status", "complete")
        .select("*")
        .maybeSingle();
      if (customerUpdate.error) throw customerUpdate.error;
      if (!customerUpdate.data) {
        throw validationError(
          `Customer "${existingCustomerRow.display_name ?? existingCustomerRow.id}" was completed by someone else while this was being saved.`,
          "customer_already_evidenced",
        );
      }
      customer = mapCustomer(customerUpdate.data as MarketingCustomerDbRow);
      // Deliberately NOT pushed to `customerIds`. That list is the rollback set for rows this
      // submission MINTED, and unwinding it deletes them — which on this path would destroy a
      // customer that existed long before the request arrived. It goes on the undo list instead,
      // recorded only once the write has actually landed.
      completedCustomerUndo.push({ before: existingCustomerRow, id: existingCustomerRow.id });
    } else {
      const customerInsert = await supabase
        .from("marketing_customers")
        .insert({
          ...capturedColumns,
          area_id: owner.areaId ?? null,
          // The hand-chosen area sits in its own columns; area_id and the GPS area above are untouched.
          chosen_area_name: doctorPicks.get(normalizedCustomer)?.chosenAreaName ?? null,
          chosen_area_seat_id: doctorPicks.get(normalizedCustomer)?.chosenAreaSeatId ?? null,
          created_by_hr_id: hrIdForStorage(actorHrId),
          crm_list_status: doctorPicks.get(normalizedCustomer)?.crmListStatus ?? "not_on_list",
          customer_code: generateMarketingCode("MKT-HCP"),
          customer_type: normalizedCustomer.customerType,
          display_name: normalizedCustomer.displayName,
          line_id: owner.lineId ?? null,
          manager_hr_id: owner.managerHrId ?? null,
          normalized_name: normalizedCustomer.normalizedName,
          other_type_description: normalizedCustomer.otherTypeDescription,
          owner_hr_id: ownerHrId,
          phoenix_crm_customer_id: doctorPicks.get(normalizedCustomer)?.phoenixCrmCustomerId ?? null,
        })
        .select("*")
        .single();
      if (customerInsert.error) throw customerInsert.error;
      customer = mapCustomer(customerInsert.data as MarketingCustomerDbRow);
      customerIds.push(customer.id);
    }

    // Retain the image itself. Runs AFTER the insert because `marketing_evidence_files.entity_id`
    // points at the customer row that did not exist a moment ago. A failure here throws, which
    // unwinds the whole submission — the record must never survive its own evidence, because
    // `evidence_status` was already set to 'complete' on the promise that this write succeeds.
    if (!isVenueOnly && normalizedCustomer.evidencePhotoDataUrl) {
      evidencePhotoPaths.push(await storeMarketingEvidencePhoto({
        imageDataUrl: normalizedCustomer.evidencePhotoDataUrl,
        record: {
          // THE PHOTO’S OWN FIX, never the location fix. Until 2026-09-29 these three lines read
          // `captured*` off the same normalized record the VENUE row is written from, so the evidence
          // row was a byte-identical copy and the distance between them was structurally zero — see
          // `src/lib/evidence/capture-trust.ts`. A null stays null: “not measured” must never be
          // substituted with the location fix, which would read downstream as “same place”.
          capturedAccuracyMeters: normalizedCustomer.evidencePhotoAccuracyMeters,
          capturedAddress: normalizedCustomer.capturedAddress,
          capturedAt: normalizedCustomer.evidencePhotoCapturedAt ?? normalizedCustomer.capturedAt,
          capturedLatitude: normalizedCustomer.evidencePhotoLatitude,
          capturedLongitude: normalizedCustomer.evidencePhotoLongitude,
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
    if (!isVenueOnly && (normalizedCustomer.mobileNumber || normalizedCustomer.speciality)) {
      const contactInsert = await supabase
        .from("marketing_customer_contacts")
        .insert({
          contact_code: generateMarketingCode("MKT-CON"),
          contact_name: customer.displayName,
          created_by_hr_id: hrIdForStorage(actorHrId),
          customer_id: customer.id,
          mobile_number: normalizedCustomer.mobileNumber,
          specialty: normalizedCustomer.speciality,
        });
      if (contactInsert.error) throw contactInsert.error;
    }

    for (const normalizedPharmacy of normalizedCustomer.pharmacies) {
      // --- "My Pharmacies": link the shop that already exists, mint nothing ---------------------
      // Deliberately creates ONLY the customer↔pharmacy link rows. No second pharmacy record, no
      // second shop-front photo, no re-typed distributor code — that duplication is the entire
      // reason this path exists. The pharmacy's own evidence still decides whether the new link is
      // usable, exactly as a freshly captured one would, so reusing a shop can never launder a
      // pharmacy that was never photographed into a validated customer.
      if (normalizedPharmacy.existingPharmacyId) {
        const storedRow = reusedPharmacyRows.get(normalizedPharmacy.existingPharmacyId);
        if (!storedRow) throw notFoundError("That pharmacy was not found.", "pharmacy_not_found");
        // Supplying the proof a venue never had. Before this the capture columns on
        // `marketing_pharmacies` were writable ONLY by the insert that created the row — the reuse
        // branch wrote the link and returned — so a venue first recorded without a photo could
        // never be completed by anyone, however many reps stood in front of it afterwards.
        //
        // Written only when the new capture is COMPLETE. A venue row is shared by every customer
        // in the area, so replacing one rep's partial capture with another's partial is churn that
        // improves nothing; "complete" is the only state worth taking the write for, and it can
        // never be a downgrade.
        //
        // Evidence ONLY. `validation_status`, `validated_by_hr_id`, `validated_at` and
        // `validation_notes` are deliberately NOT in this update: they record a human's verdict on
        // this shop — including a Super Admin's desk validation — and a rep supplying a missing
        // photo is evidence, not an appeal against that verdict. The columns are omitted rather
        // than written back, so a concurrent edit to any of them survives untouched. What the new
        // evidence DOES move is every link status computed below, which is the point: the customer
        // that was parked on "Not Usable Yet" for want of a shop photo becomes usable.
        const reusedRow = await (async () => {
          if (normalizedPharmacy.evidenceStatus !== "complete") return storedRow;
          if (storedRow.evidence_status === "complete") return storedRow;
          const pharmacyEvidenceUpdate = await supabase
            .from("marketing_pharmacies")
            .update({
              // Guaranteed present: "complete" is only reachable with a coordinate, a capture
              // time, a photo name and the photo's own timestamp (evidenceStatusFromInput).
              captured_at: normalizedPharmacy.capturedAt,
              captured_latitude: normalizedPharmacy.capturedLatitude,
              captured_longitude: normalizedPharmacy.capturedLongitude,
              evidence_has_timestamp: normalizedPharmacy.evidenceHasTimestamp,
              evidence_photo_captured_at: normalizedPharmacy.evidencePhotoCapturedAt,
              evidence_photo_name: normalizedPharmacy.evidencePhotoName,
              evidence_status: normalizedPharmacy.evidenceStatus,
              updated_at: new Date().toISOString(),
              updated_by_hr_id: hrIdForStorage(actorHrId),
              // NOT guaranteed: accuracy and the reverse-geocoded descriptors can all come back
              // empty from a fix that is otherwise perfectly complete. Each is OMITTED rather than
              // written as null, because on an `.update()` a null for "the client had nothing to
              // say" erases what the row already held. They travel with the coordinate rather than
              // being left behind, so the matcher never reads a new GPS fix against a stale
              // governorate.
              ...definedColumns({
                captured_accuracy_meters: normalizedPharmacy.capturedAccuracyMeters,
                captured_address: normalizedPharmacy.capturedAddress,
                extracted_area_name: normalizedPharmacy.extractedAreaName,
                extracted_governorate_name: normalizedPharmacy.extractedGovernorateName,
                region_name: normalizedPharmacy.regionName,
              }),
            })
            .eq("id", storedRow.id)
            // Repeats the precondition above so a rep who lost the race leaves the capture that
            // landed first alone. Unlike the customer path this must NOT throw: completing the
            // venue is a bonus on a submission whose actual purpose is the link, and losing the
            // race is a success for the shop, not a failure for this rep.
            .neq("evidence_status", "complete")
            .select("*")
            .maybeSingle();
          if (pharmacyEvidenceUpdate.error) throw pharmacyEvidenceUpdate.error;
          if (!pharmacyEvidenceUpdate.data) return storedRow;
          const completedRow = pharmacyEvidenceUpdate.data as MarketingPharmacyDbRow;
          completedPharmacyUndo.push({ before: storedRow, id: storedRow.id });
          // So a venue attached to several customers in one submission is completed once, and
          // every later customer in the loop reads the row as it now stands.
          reusedPharmacyRows.set(storedRow.id, completedRow);
          if (normalizedPharmacy.evidencePhotoDataUrl) {
            evidencePhotoPaths.push(await storeMarketingEvidencePhoto({
              imageDataUrl: normalizedPharmacy.evidencePhotoDataUrl,
              record: {
                // THE PHOTO’S OWN FIX, never the location fix. Until 2026-09-29 these three lines read
                // `captured*` off the same normalized record the VENUE row is written from, so the evidence
                // row was a byte-identical copy and the distance between them was structurally zero — see
                // `src/lib/evidence/capture-trust.ts`. A null stays null: “not measured” must never be
                // substituted with the location fix, which would read downstream as “same place”.
                capturedAccuracyMeters: normalizedPharmacy.evidencePhotoAccuracyMeters,
                capturedAddress: normalizedPharmacy.capturedAddress,
                capturedAt: normalizedPharmacy.evidencePhotoCapturedAt ?? normalizedPharmacy.capturedAt,
                capturedLatitude: normalizedPharmacy.evidencePhotoLatitude,
                capturedLongitude: normalizedPharmacy.evidencePhotoLongitude,
                entityId: completedRow.id,
                entityType: "pharmacy",
                hasTimestamp: normalizedPharmacy.evidenceHasTimestamp,
                originalFileName: normalizedPharmacy.evidencePhotoName,
                uploadedByHrId: actorHrId,
              },
              supabase,
            }));
          }
          return completedRow;
        })();

        // The pharmacy licence, on the reuse path. OUTSIDE the evidence branch above on purpose:
        // that branch runs only when a NEW capture completes a venue that was short of proof, and
        // a licence is not a capture. A rep attaching the licence for a codeless shop that already
        // has a perfectly good storefront photo would otherwise have it silently dropped — which is
        // exactly the class of defect (`evidence_status` complete, so skip the write) that left
        // three production venues uncompletable until 2026-08-23.
        if (normalizedPharmacy.licenseFileDataUrl) {
          evidencePhotoPaths.push(await storeMarketingPharmacyLicense({
            fileDataUrl: normalizedPharmacy.licenseFileDataUrl,
            originalFileName: normalizedPharmacy.licenseFileName,
            pharmacyId: reusedRow.id,
            supabase,
            uploadedByHrId: actorHrId,
          }));
        }
        const pharmacy = mapMarketingPharmacy(reusedRow);
        // NOT pushed onto `pharmacyIds`: it predates this submission and must survive a rollback.

        for (const codeRow of venueCodeSlots(
          reusedCodesByPharmacyId.get(reusedRow.id) ?? [],
          pharmacy.displayName,
        )) {
          const distributorCode = codeRow ? mapDistributorCode(codeRow) : null;
          // Compared against the SHOP'S OWN capture, not this customer's: the reuse path
          // deliberately re-captures nothing, so the only GPS fix that ever described this shop is
          // the one taken when it was first created. A shop whose capture contradicts its code is
          // held here too, or attaching it to a second customer would launder it clean.
          const reusedReference = reusedReferencesById.get(Number(codeRow?.reference_id ?? 0));
          const governorateCheck = checkCapturedGovernorate({
            capturedAddress: reusedRow.captured_address,
            registeredAddress: reusedReference?.raw_pharmacy_address,
            registeredRegion: reusedReference?.raw_region,
          });
          const linkValidationStatus: MarketingValidationStatus = resolveMarketingValidationRecordStatus({
            isOnBehalf,
            systemStatus: resolveMarketingSystemValidationStatus({
              customerEvidenceStatus,
              governorateVerdict: governorateCheck.verdict,
              pharmacyEvidenceStatus: pharmacy.evidenceStatus,
            }),
          });
          const linkValidationNotes = [
            isOnBehalf
              ? adminValidationNote
              : buildPendingEvidenceNote({
                customerEvidenceStatus,
                pharmacyEvidenceStatus: pharmacy.evidenceStatus,
              }),
            distributorCode ? buildUntrackedDistributorCodeNote(distributorCode.referenceStatus) : null,
            buildGovernorateMismatchNote(governorateCheck),
            distributorCode ? null : venueNonAttributableReason(pharmacy.venueType),
            // Says on the row itself that this shop was not re-captured for this customer, so an
            // evidence photo dated before the customer is explainable rather than suspicious.
            `Linked from an existing validated pharmacy (${pharmacy.pharmacyCode || pharmacy.displayName}).`,
          ].filter(Boolean).join(" ") || null;

          // `marketing_customer_pharmacies` is unique on (customer_id, distributor_code_id) — NOT
          // on (customer, pharmacy). Completing a customer already on record means re-attaching the
          // shop it is ALREADY linked to, so a plain insert is a straight unique violation that
          // would reach the rep as an opaque 500 at the end of a field visit.
          //
          // Resolved by branching rather than by `upsert`: a blind upsert would also flip `active`
          // back to true on a link somebody retired, and overwrite a `rejected` verdict with a
          // freshly computed one. Both are human decisions, and a rep re-photographing a shop is
          // not an appeal against either.
          const existingLinkRow = existingCustomerRow
            ? existingLinksByCustomerAndCode.get(
              distributorCode
                ? `${customer.id}::${distributorCode.id}`
                : `${customer.id}::venue::${pharmacy.id}`,
            ) ?? null
            : null;
          if (existingLinkRow?.validation_status === "rejected") {
            throw validationError(
              `"${pharmacy.displayName}" was already reviewed and rejected for this customer. Ask a Super Admin or the CEO to reopen it from Customer Pharmacy Mapping.`,
              "link_already_rejected",
            );
          }
          if (existingLinkRow && existingLinkRow.active === false) {
            throw validationError(
              `"${pharmacy.displayName}" was retired from this customer. Ask a Super Admin or the CEO to restore it from Customer Pharmacy Mapping.`,
              "link_retired",
            );
          }

          const reusedLinkInsert = existingLinkRow
            ? await supabase
              .from("marketing_customer_pharmacies")
              .update({
                updated_at: new Date().toISOString(),
                updated_by_hr_id: hrIdForStorage(actorHrId),
                validation_notes: linkValidationNotes,
                validation_status: linkValidationStatus,
              })
              .eq("id", existingLinkRow.id)
              .neq("validation_status", "rejected")
              .select("*")
              .single()
            : await supabase
              .from("marketing_customer_pharmacies")
              .insert({
                created_by_hr_id: hrIdForStorage(actorHrId),
                customer_id: customer.id,
                distributor_code_id: distributorCode?.id ?? null,
                pharmacy_id: pharmacy.id,
                updated_by_hr_id: hrIdForStorage(actorHrId),
                validation_notes: linkValidationNotes,
                validation_status: linkValidationStatus,
              })
              .select("*")
              .single();
          if (reusedLinkInsert.error) throw reusedLinkInsert.error;
          const reusedLink = mapCustomerPharmacy(reusedLinkInsert.data as MarketingCustomerPharmacyDbRow);
          if (distributorCode) attachedDistributorCodeIds.push(distributorCode.id);
          const reusedDistributor = distributorCode
            ? distributorsById.get(distributorCode.distributorId)
            : undefined;

          rows.push({
            // A row the desk has just CREATED. Empty rather than looked up: this is a write path,
            // the note is not part of what the desk decides, and the next workspace load fills it.
            // Empty here can only ever understate — it never asserts a link that was not confirmed.
            alsoKnownAs: [],
            customer,
            // A REUSED link can be a desk validation just as easily as a backfill one.
            deskValidated: isDeskValidated(reusedLink.validationNotes),
            distributorCode,
            distributorName: reusedDistributor
              ? mapDistributor(reusedDistributor).displayName
              : distributorCode ? "Unknown distributor" : null,
            id: reusedLink.id,
            // A REUSED link can be one the backfill wrote, so this is read from its notes rather
            // than assumed false — attaching a fresh pharmacy to an old link does not turn an
            // inferred validation into a field-validated one.
            inferredFromHistory: isInferredFromHistory(reusedLink.validationNotes),
            pharmacy,
            // ...and so can the 2026-09-08 second-code backfill, for the same reason.
            secondCodeBackfill: isSecondCodeBackfill(reusedLink.validationNotes),
            // Name-based wholesaler suspicion (owner rule, 2026-09-22), name-only, advisory tier.
            suspectedWholesaler: suspectedWholesalerFlag(pharmacy.displayName),
            suspectedWholesalerNote: suspectedWholesalerNote(pharmacy.displayName),
            validationNotes: reusedLink.validationNotes,
            validationStatus: reusedLink.validationStatus,
          });
        }
        continue;
      }

      // Owner rule 2026-09-22 ("never never never"): a wholesaler / makhzan is never MINTED as a
      // venue. Only reached on the fresh-capture path (the reuse branch above `continue`d), so this
      // refuses a newly claimed warehouse name before a marketing_pharmacies row is created. The
      // two-tier detector protects owner pharmacy-overrides, so a real pharmacy named like a
      // warehouse is not caught; an ambiguous "X فارما" is flagged elsewhere, never refused here.
      if (isCertainWholesalerVenue(normalizedPharmacy.displayName)) {
        throw validationError(WHOLESALER_VENUE_REFUSED_MESSAGE, "venue_is_wholesaler");
      }

      const pharmacyInsert = await supabase
        .from("marketing_pharmacies")
        .insert({
          area_id: owner.areaId ?? null,
          captured_accuracy_meters: normalizedPharmacy.capturedAccuracyMeters,
          captured_address: normalizedPharmacy.capturedAddress,
          captured_at: normalizedPharmacy.capturedAt,
          captured_latitude: normalizedPharmacy.capturedLatitude,
          captured_longitude: normalizedPharmacy.capturedLongitude,
          created_by_hr_id: hrIdForStorage(actorHrId),
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
          updated_by_hr_id: hrIdForStorage(actorHrId),
          validated_at: adminValidatedAt,
          validated_by_hr_id: adminValidatedByHrId,
          validation_notes: adminValidationNote,
          validation_status: resolveMarketingValidationRecordStatus({
            isOnBehalf,
            systemStatus: normalizedPharmacy.validationStatus,
          }),
          venue_type: normalizedPharmacy.venueType,
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
            // THE PHOTO’S OWN FIX, never the location fix. Until 2026-09-29 these three lines read
            // `captured*` off the same normalized record the VENUE row is written from, so the evidence
            // row was a byte-identical copy and the distance between them was structurally zero — see
            // `src/lib/evidence/capture-trust.ts`. A null stays null: “not measured” must never be
            // substituted with the location fix, which would read downstream as “same place”.
            capturedAccuracyMeters: normalizedPharmacy.evidencePhotoAccuracyMeters,
            capturedAddress: normalizedPharmacy.capturedAddress,
            capturedAt: normalizedPharmacy.evidencePhotoCapturedAt ?? normalizedPharmacy.capturedAt,
            capturedLatitude: normalizedPharmacy.evidencePhotoLatitude,
            capturedLongitude: normalizedPharmacy.evidencePhotoLongitude,
            entityId: pharmacy.id,
            entityType: "pharmacy",
            hasTimestamp: normalizedPharmacy.evidenceHasTimestamp,
            originalFileName: normalizedPharmacy.evidencePhotoName,
            uploadedByHrId: actorHrId,
          },
          supabase,
        }));
      }

      // The pharmacy licence (رخصة الصيدلية). Pushed onto the SAME rollback list as the photos —
      // it lives in its own bucket but the same index table, and `deleteMarketingEvidencePhotos`
      // sweeps both buckets, so it unwinds without knowing it is a different kind of file.
      if (normalizedPharmacy.licenseFileDataUrl) {
        evidencePhotoPaths.push(await storeMarketingPharmacyLicense({
          fileDataUrl: normalizedPharmacy.licenseFileDataUrl,
          originalFileName: normalizedPharmacy.licenseFileName,
          pharmacyId: pharmacy.id,
          supabase,
          uploadedByHrId: actorHrId,
        }));
      }

      // `venueCodeSlots`, not `vendorCodes`: everything below — including the customer↔pharmacy
      // link itself — used to live inside a loop over the codes, so a venue with none produced a
      // customer and a shop with nothing joining them. A venue with no code is refused by it now
      // (owner, 2026-10-21) — the capture gate already refused it before anything was written.
      for (const vendorCode of venueCodeSlots(
        normalizedPharmacy.vendorCodes,
        normalizedPharmacy.displayName,
      )) {
        const reference = vendorCode
          ? await resolvePharmacyCodeReference({
            distributorId: vendorCode.distributorId,
            normalizedPharmacyCode: vendorCode.normalizedPharmacyCode,
            supabase,
          })
          : null;
        // Runs BEFORE the status is decided, because since 2026-08-20 it is part of deciding it.
        // Nothing in Phoenix compared these two addresses before: a code whose registered
        // governorate contradicts the GPS fix used to save and validate silently.
        // A codeless venue has no registered address to contradict, so this returns the same
        // verdict it returns for a code the reference database has never seen — no claim either way.
        const governorateCheck = checkCapturedGovernorate({
          capturedAddress: normalizedPharmacy.capturedAddress,
          registeredAddress: reference?.registeredAddress,
          registeredRegion: reference?.registeredRegion,
        });
        const linkValidationStatus: MarketingValidationStatus = resolveMarketingValidationRecordStatus({
          isOnBehalf,
          systemStatus: resolveMarketingSystemValidationStatus({
            customerEvidenceStatus,
            governorateVerdict: governorateCheck.verdict,
            pharmacyEvidenceStatus: normalizedPharmacy.evidenceStatus,
          }),
        });
        // The reference lookup still runs and is still stored truthfully, because an unmatched code
        // means sales can never be attributed to this pharmacy — the row is usable, but its ROI
        // would read zero forever. Say so on the row rather than letting it look fully healthy.
        // Since the code stopped gating the status (2026-08-12) this warning is the ONLY thing
        // carrying that consequence, so it now rides on validated rows as well as pending ones.
        const untrackedCodeNote = reference ? buildUntrackedDistributorCodeNote(reference.status) : null;
        // On a contradiction this is the REASON the row above came back pending, so it must be on
        // the row — a held link with no stated reason is unreleasable by the Super Admin / CEO who
        // is the only one allowed to release it.
        const governorateNote = buildGovernorateMismatchNote(governorateCheck);
        // Store the code THE SALES DATA CARRIES, not the one the rep typed. ROI attribution
        // joins sales on this column with exact string equality (migration 20260808231742,
        // line 159), so a POS pharmacy saved as '1503246' when the sales rows read '0001503246'
        // would report zero ROI forever — the badge would say tracked and the money would not
        // arrive. The rep's own entry is preserved untouched in distributor_pharmacy_code.
        // Only set on a single unambiguous match; otherwise nothing has been proven.
        const linkValidationNotes = [
          isOnBehalf
            ? adminValidationNote
            : buildPendingEvidenceNote({
              customerEvidenceStatus,
              pharmacyEvidenceStatus: normalizedPharmacy.evidenceStatus,
            }),
          untrackedCodeNote,
          governorateNote,
          // Stated on the row rather than left to be inferred from an empty code column: spend on
          // this venue is real, and its return can never be measured through sales.
          vendorCode ? null : venueNonAttributableReason(normalizedPharmacy.venueType),
        ].filter(Boolean).join(" ") || null;
        // Narrowed in one place: a venue with no distributor account writes no code row at all,
        // so everything below this point can talk about a real code without optional chaining —
        // which is what keeps the canonical-code rule a plain, checkable statement.
        let distributorCode: MarketingPharmacyDistributorCode | null = null;
        if (vendorCode && reference) {
          const storedPharmacyCode = reference.canonicalCode ?? vendorCode.normalizedPharmacyCode;
          const distributorCodeInsert = await supabase
            .from("marketing_pharmacy_distributor_codes")
            .insert({
              created_by_hr_id: hrIdForStorage(actorHrId),
              distributor_id: vendorCode.distributorId,
              distributor_pharmacy_code: vendorCode.distributorPharmacyCode,
              normalized_pharmacy_code: storedPharmacyCode,
              pharmacy_id: pharmacy.id,
              reference_id: reference.referenceId,
              reference_match_count: reference.matchCount,
              reference_status: reference.status,
              validation_notes: reference.status === "matched" ? null : `Reference ${reference.status.replace(/_/g, " ")}.`,
            })
            .select("*")
            .single();
          if (distributorCodeInsert.error) throw distributorCodeInsert.error;
          distributorCode = mapDistributorCode(distributorCodeInsert.data as MarketingPharmacyDistributorCodeDbRow);
          distributorCodeIds.push(distributorCode.id);
          attachedDistributorCodeIds.push(distributorCode.id);
        }

        const linkInsert = await supabase
          .from("marketing_customer_pharmacies")
          .insert({
            created_by_hr_id: hrIdForStorage(actorHrId),
            customer_id: customer.id,
            distributor_code_id: distributorCode?.id ?? null,
            pharmacy_id: pharmacy.id,
            updated_by_hr_id: hrIdForStorage(actorHrId),
            validation_notes: linkValidationNotes,
            validation_status: linkValidationStatus,
          })
          .select("*")
          .single();
        if (linkInsert.error) throw linkInsert.error;
        const link = mapCustomerPharmacy(linkInsert.data as MarketingCustomerPharmacyDbRow);
        const distributorRow = vendorCode ? distributorsById.get(vendorCode.distributorId) : undefined;

        rows.push({
          // A row the desk has just CREATED. Empty rather than looked up: this is a write path,
          // the note is not part of what the desk decides, and the next workspace load fills it.
          // Empty here can only ever understate — it never asserts a link that was not confirmed.
          alsoKnownAs: [],
          customer,
          // Read from the notes for the same reason as `inferredFromHistory` below: one rule, not
          // one rule and one assumption. An on-behalf submission writes the desk marker here.
          deskValidated: isDeskValidated(link.validationNotes),
          distributorCode,
          distributorName: distributorRow ? mapDistributor(distributorRow).displayName : null,
          id: link.id,
          // Written by this submission, from a live capture — never the 2026-07-02 backfill. Read
          // from the notes anyway so there is one rule, not one rule and one assumption.
          inferredFromHistory: isInferredFromHistory(link.validationNotes),
          pharmacy,
          secondCodeBackfill: isSecondCodeBackfill(link.validationNotes),
          // Name-based wholesaler suspicion (owner rule, 2026-09-22), name-only, advisory tier.
          suspectedWholesaler: suspectedWholesalerFlag(pharmacy.displayName),
          suspectedWholesalerNote: suspectedWholesalerNote(pharmacy.displayName),
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

    // Last for this customer, and only on the completing path: every link it already carried was
    // stamped from the evidence that existed when it was written, which for these rows was none.
    // Re-deciding them is what turns the capture into a usable customer — without it the rep walks
    // to the shop, photographs it, and the customer stays exactly as stuck as it was.
    if (existingCustomerRow && !isVenueOnly) {
      await refreshLinksAfterCustomerCompletion({
        actorHrId,
        customerEvidenceStatus: normalizedCustomer.evidenceStatus,
        customerId: customer.id,
        isOnBehalf,
        supabase,
      });
    }
    }

    // Every customer ALREADY waiting on a shop this submission completed. Runs after the customer
    // loop, so this submission's own links exist and are already correct, and once per venue rather
    // than once per customer that attached it. Without this the rep photographs the shop, the venue
    // row goes green, and the doctors who have been stuck on it since the day it was recorded stay
    // exactly where they were — which is the entire reason the shop needed completing.
    for (const undo of completedPharmacyUndo) {
      const completedRow = reusedPharmacyRows.get(undo.id);
      if (!completedRow) continue;
      await refreshLinksAfterPharmacyCompletion({
        actorHrId,
        isOnBehalf,
        pharmacyRow: completedRow,
        supabase,
      });
    }

    // Connect what was just written to the Source-of-Sales customer master, while the ids are in
    // hand and before anyone can look at the row. Awaited rather than fired and forgotten: an
    // unawaited promise here would race the response, and a row left unresolved is invisible —
    // that is precisely how ten days of codes accumulated unnoticed. `resolveMarketingPharmacyCodes`
    // never throws, which is what makes it safe to await INSIDE this try block: the catch below
    // deletes the whole submission, and enrichment must never be able to trigger that.
    await resolveMarketingPharmacyCodes(supabase, distributorCodeIds);

    // Now that the master has spoken, file the venue in the territory it STANDS IN rather than the
    // one its photographer belongs to — but only when that photographer has no territory of their
    // own. A rep's area is their patch and is never touched. Ordered strictly after the resolver:
    // `mapped_area_code` is written by that database function, so reading it any earlier reads the
    // column as it was before this submission existed. Never throws, for the same reason the
    // resolver above never throws — the catch below deletes the whole submission, and enrichment
    // must never be able to trigger that. See src/lib/marketing-requests/venue-territory.ts.
    await applyMasterTerritoryToVenues({
      // Every code attached, not the minted-only list the resolver above was handed: a submission
      // whose venues were all already on file mints nothing, and still knows where it stands.
      attachedDistributorCodeIds,
      // A customer COMPLETED here predates the submission, so it is deliberately absent from
      // `customerIds` (that list is the rollback set, and unwinding it deletes). It still needs
      // re-filing when it is stranded off every selling territory: an admin-created stub inherits
      // the desk's own area, and completing it in the field never touched `area_id` — so the
      // customer whose evidence just landed stayed invisible to the team that has to visit it.
      completedCustomerIds: completedCustomerUndo.map((entry) => entry.id),
      customerIds,
      ownerAreaId: owner.areaId ?? null,
      pharmacyIds,
      supabase,
    });

    // A newly validated customer or pharmacy changes the evidence and validation columns the
    // sheet shows, so it is worth a refresh even though no request row moved.
    pingMarketingRequestSheet("validation_recorded");
    // A customer validated here is validated in the rep's Direct Orders too, and its pharmacies land
    // in his "My venues" (owner, 2026-10-21). Imported lazily — that module imports this one — and
    // quiet: the save above has happened, so a hand-over failure is logged and retried, never thrown.
    const { syncMarketingValidationToDirectOrdersQuietly } = await import(
      "@/lib/marketing-requests/direct-order-venue-sync"
    );
    await syncMarketingValidationToDirectOrdersQuietly(rows.map((row) => String(row.customer.id)));
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
    // A completed customer is restored, never deleted. Only the capture columns are put back — the
    // same set the update wrote — so a concurrent edit to anything else on the row survives.
    for (const undo of completedCustomerUndo) {
      await supabase
        .from("marketing_customers")
        .update({
          captured_accuracy_meters: undo.before.captured_accuracy_meters ?? null,
          captured_address: undo.before.captured_address ?? null,
          captured_at: undo.before.captured_at ?? null,
          captured_latitude: undo.before.captured_latitude ?? null,
          captured_longitude: undo.before.captured_longitude ?? null,
          evidence_has_timestamp: undo.before.evidence_has_timestamp ?? null,
          evidence_photo_captured_at: undo.before.evidence_photo_captured_at ?? null,
          evidence_photo_name: undo.before.evidence_photo_name ?? null,
          evidence_status: undo.before.evidence_status ?? "missing",
          extracted_area_name: undo.before.extracted_area_name ?? null,
          extracted_governorate_name: undo.before.extracted_governorate_name ?? null,
          region_name: undo.before.region_name ?? null,
          validated_at: undo.before.validated_at ?? null,
          validated_by_hr_id: undo.before.validated_by_hr_id ?? null,
          validation_notes: undo.before.validation_notes ?? null,
          validation_status: undo.before.validation_status ?? "pending",
        })
        .eq("id", undo.id);
    }
    // A completed pharmacy is restored, never deleted — same reasoning as the customer above, and
    // the same column set the update wrote, so the verdict columns it deliberately left alone stay
    // untouched on the way back too.
    for (const undo of completedPharmacyUndo) {
      await supabase
        .from("marketing_pharmacies")
        .update({
          captured_accuracy_meters: undo.before.captured_accuracy_meters ?? null,
          captured_address: undo.before.captured_address ?? null,
          captured_at: undo.before.captured_at ?? null,
          captured_latitude: undo.before.captured_latitude ?? null,
          captured_longitude: undo.before.captured_longitude ?? null,
          evidence_has_timestamp: undo.before.evidence_has_timestamp ?? null,
          evidence_photo_captured_at: undo.before.evidence_photo_captured_at ?? null,
          evidence_photo_name: undo.before.evidence_photo_name ?? null,
          evidence_status: undo.before.evidence_status ?? "missing",
          // Restored unconditionally even though the update writes them only when supplied: the
          // before-image is what the row held either way, so putting it back is a no-op when the
          // update skipped them and a real repair when it did not.
          extracted_area_name: undo.before.extracted_area_name ?? null,
          extracted_governorate_name: undo.before.extracted_governorate_name ?? null,
          region_name: undo.before.region_name ?? null,
        })
        .eq("id", undo.id);
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

/**
 * Who may see the company-wide oversight queue inside the approval inbox.
 *
 * Super Admin only — owner instruction, 2026-08-18. Deliberately NARROWER than
 * `marketingRegisterRoles` above: the register is a report, this is an inbox, and putting other
 * people's pending decisions in a Marketing Manager's or an SFE Manager's inbox would blur whose
 * turn it is. `scope === "system"` is included for the same reason every other gate here does it —
 * the system administrator context is not carried on the role label.
 */
export function canViewMarketingOversightQueue(access: AccessContext): boolean {
  return access.scope === "system" || access.role === "Super Admin";
}

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

const MARKETING_DRAFT_REFERENCE_REVALIDATE_SECONDS = 60;

/**
 * The 8 reference/lookup tables getMarketingRequestDraftWorkspace needs — all filtered to active
 * rows, all "small reference sets," none of them request-specific or per-viewer. Cached company-
 * wide for a minute at a time instead of re-fetched fresh on every requester's page load (60s
 * mirrors the revalidate window already used for vacation-report rows, src/lib/vacation/service.ts).
 */
const loadMarketingDraftReferenceDataCached = unstable_cache(
  async () => {
    const supabase = getSupabaseAdmin();
    const [typesResult, productsResult, distributorsResult, customersResult, validatedLinksResult, pharmaciesResult, distributorCodesResult, contactsResult] = await Promise.all([
      supabase.from("marketing_request_types").select("*").or("active.is.null,active.eq.true").order("sort_order"),
      supabase.from("marketing_products").select("*").or("active.is.null,active.eq.true").order("product_name"),
      supabase.from("marketing_distributors").select("*").or("active.is.null,active.eq.true").order("display_name"),
      supabase.from("marketing_customers").select("*").or("active.is.null,active.eq.true").order("display_name"),
      // Also carries the pharmacy detail now, not just customer_id: the request form has to let the
      // requester CHOOSE which pharmacies a campaign targets. A customer has at most 8 linked
      // pharmacies in production (median 1-3), so this is a handful of extra rows, not a second set.
      supabase
        .from("marketing_customer_pharmacies")
        .select("customer_id, distributor_code_id, pharmacy_id, validation_status, validation_notes")
        .or("active.is.null,active.eq.true")
        .in("validation_status", [...LINK_STATUS_PRECEDENCE]),
      // Display data for the target-pharmacy picker. Both tables are small reference sets.
      supabase.from("marketing_pharmacies").select("id, display_name, pharmacy_code, venue_type"),
      supabase
        .from("marketing_pharmacy_distributor_codes")
        .select("id, pharmacy_id, distributor_id, distributor_pharmacy_code, reference_status")
        .or("active.is.null,active.eq.true"),
      // The customers' own contacts, for the request's contact picker. 170 rows in production, so
      // this is a handful of extra rows on an already-cached read, not a second reference set.
      supabase
        .from("marketing_customer_contacts")
        .select("id, customer_id, contact_name, crm_code, mobile_number")
        .or("active.is.null,active.eq.true")
        .order("contact_name"),
    ]);
    if (typesResult.error) throw typesResult.error;
    if (productsResult.error) throw productsResult.error;
    if (distributorsResult.error) throw distributorsResult.error;
    if (customersResult.error) throw customersResult.error;
    if (validatedLinksResult.error) throw validatedLinksResult.error;
    if (pharmaciesResult.error) throw pharmaciesResult.error;
    if (distributorCodesResult.error) throw distributorCodesResult.error;
    if (contactsResult.error) throw contactsResult.error;
    return {
      types: typesResult.data ?? [],
      products: productsResult.data ?? [],
      distributors: distributorsResult.data ?? [],
      customers: customersResult.data ?? [],
      validatedLinks: validatedLinksResult.data ?? [],
      pharmacies: pharmaciesResult.data ?? [],
      distributorCodes: distributorCodesResult.data ?? [],
      contacts: contactsResult.data ?? [],
    };
  },
  ["marketing-draft-reference-data"],
  { revalidate: MARKETING_DRAFT_REFERENCE_REVALIDATE_SECONDS },
);

export async function getMarketingRequestDraftWorkspace(access: AccessContext): Promise<MarketingRequestDraftWorkspace> {
  assertMarketingDraftWorkspaceAccess(access);

  const supabase = getSupabaseAdmin();
  // The first 8 queries below are reference/lookup tables (types, products, distributors,
  // customers, validated customer-pharmacy links, pharmacies, distributor codes, customer
  // contacts) that change
  // rarely — every requester opening this workspace was re-fetching all of them fresh, alongside
  // the 5 genuinely live per-request queries. Reference data goes through the shared 60s cache
  // instead (matches the revalidate window already used for vacation-report rows); the 5 live
  // queries stay direct.
  const [referenceData, draftsResult, approvedRequestsResult, returnedResult, inApprovalResult, rejectedResult] = await Promise.all([
    loadMarketingDraftReferenceDataCached(),
    supabase.from("marketing_requests").select("*").eq("status", "draft").order("created_at", { ascending: false }).limit(MARKETING_WORKSPACE_SAFETY_LIMIT),
    supabase
      .from("marketing_requests")
      .select("*")
      .in("status", approvedMarketingRequestStatuses)
      .order("pay_date", { ascending: false, nullsFirst: false })
      .limit(MARKETING_WORKSPACE_SAFETY_LIMIT),
    supabase.from("marketing_requests").select("*").eq("status", "returned").order("updated_at", { ascending: false }).limit(MARKETING_WORKSPACE_SAFETY_LIMIT),
    supabase.from("marketing_requests").select("*").eq("status", "pending_approval").order("submitted_at", { ascending: false, nullsFirst: false }).limit(MARKETING_WORKSPACE_SAFETY_LIMIT),
    // Rejected. Every other status a requester can reach was already queried above; this one was
    // not, so a refused request appeared in NO list on the workspace — not even to the person who
    // raised it. The rejection note is the single most valuable sentence on the whole record (it is
    // the only place the "why" is written down at all), and it was unreachable from any screen.
    supabase.from("marketing_requests").select("*").eq("status", "rejected").order("rejected_at", { ascending: false, nullsFirst: false }).limit(MARKETING_WORKSPACE_SAFETY_LIMIT),
  ]);
  const typesResult = { data: referenceData.types, error: null as null };
  const productsResult = { data: referenceData.products, error: null as null };
  const distributorsResult = { data: referenceData.distributors, error: null as null };
  const customersResult = { data: referenceData.customers, error: null as null };
  const validatedLinksResult = { data: referenceData.validatedLinks, error: null as null };
  const pharmaciesResult = { data: referenceData.pharmacies, error: null as null };
  const distributorCodesResult = { data: referenceData.distributorCodes, error: null as null };
  const contactsResult = { data: referenceData.contacts, error: null as null };

  if (draftsResult.error) throw draftsResult.error;
  if (approvedRequestsResult.error) throw approvedRequestsResult.error;
  if (returnedResult.error) throw returnedResult.error;
  if (inApprovalResult.error) throw inApprovalResult.error;
  if (rejectedResult.error) throw rejectedResult.error;

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
    isSamePerson(request.requesterHrId, access.hrId);
  const narrowToOwnRequests = (requests: MarketingRequest[]) =>
    scopeTrackingToOwnRequests ? requests.filter(ownsMarketingRequest) : requests;

  /**
   * The Approved list is the ONE exception to the narrowing above, and only for the role that has
   * to act on it.
   *
   * uploadMarketingFinanceEvidence names Finance Manager as the only non-owner allowed to attach the
   * money transfer proof, and `<EvidenceUpload>` — the sole UI for it — renders on this list and
   * nowhere else. Narrowing it to his own submissions made that grant unreachable in the product:
   * he is not in marketingCreatorRoles, so he can never submit a request, so `approvedRequests` was
   * provably ALWAYS empty for him and the proof could only be attached by hand-crafting a POST.
   * He is the terminal `finance_execution` rung (owner, 2026-08-10) — attaching the payment proof is
   * the execution artifact, so this list is his work queue, not a personal history.
   *
   * Deliberately the Approved list ONLY, and deliberately keyed on the role rather than on
   * companyMarketingRoles: Drafts / Returned / In-approval stay personal for him too (he has none by
   * construction), and the CEO / SFE Manager / Marketing Manager keep the personal narrowing that
   * stops every request in the company flooding their own workspace.
   */
  const executesApprovedMarketingRequests = access.role === "Finance Manager";
  const narrowApprovedToActionableRequests = (requests: MarketingRequest[]) =>
    executesApprovedMarketingRequests ? requests : narrowToOwnRequests(requests);

  const passesHierarchyCheck = (row: MarketingRequestDbRow) =>
    canSeeMarketingRequest(access, row, employeeRows);

  const allVisibleRows = [
    ...((draftsResult.data ?? []) as MarketingRequestDbRow[]).filter(passesHierarchyCheck),
    ...((approvedRequestsResult.data ?? []) as MarketingRequestDbRow[]).filter(passesHierarchyCheck),
    ...((returnedResult.data ?? []) as MarketingRequestDbRow[]).filter(passesHierarchyCheck),
    ...((inApprovalResult.data ?? []) as MarketingRequestDbRow[]).filter(passesHierarchyCheck),
    ...((rejectedResult.data ?? []) as MarketingRequestDbRow[]).filter(passesHierarchyCheck),
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
  const approvedRequests = narrowApprovedToActionableRequests(
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
  const rejected = narrowToOwnRequests(
    ((rejectedResult.data ?? []) as MarketingRequestDbRow[])
      .filter(passesHierarchyCheck)
      .filter(passesProductFilter)
      .map(mapRequest),
  );

  // Batch-load approval steps for every in-flight request so the tracking UI can
  // show "currently with <step> — <approver>" without an N+1 query per request.
  //
  // Rejected requests ride the SAME batch — it costs no extra query — but they are deliberately
  // kept out of stepProgressByRequestId: buildMarketingStepProgress falls back to the LAST gating
  // step when there is no `current` and no `returned` rung, which on a refused request would
  // render "Currently with: Finance Execution" for a request nobody is holding. They get their own
  // summary instead, built from the rung that actually said no.
  const rejectedRequestIds = new Set(rejected.map((request) => request.id));
  const trackedRequestIds = Array.from(
    new Set([...inApproval, ...returned, ...rejected].map((request) => request.id)),
  );
  const stepProgressByRequestId: Record<string, MarketingRequestStepProgress> = {};
  const rejectionByRequestId: Record<string, MarketingRequestRejection> = {};
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
      if (rejectedRequestIds.has(requestId)) {
        const rejection = buildMarketingRejectionSummary(requestSteps, employeeRows);
        if (rejection) rejectionByRequestId[requestId] = rejection;
        continue;
      }
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
  const offsetsByRequestId = await loadOffsetsByRequestId(approvedRequestIds);

  // Only a customer with a CODED validated link can be requested for (owner, 2026-10-21): a customer
  // whose only venue has no distributor code would open a request with nothing to target.
  const validatedCustomerIds = new Set(
    ((validatedLinksResult.data ?? []) as Array<{ customer_id: string; distributor_code_id: string | null }>)
      .filter((row) => Boolean(row.distributor_code_id))
      .map((row) => row.customer_id),
  );

  // Target-pharmacy options, grouped by customer, so the form can offer exactly the pharmacies
  // that belong to the customer being requested for. In production a customer has 1-8 of them,
  // which is why this is a short explicit list rather than a search over the 45k-row master.
  if (pharmaciesResult.error) throw pharmaciesResult.error;
  if (distributorCodesResult.error) throw distributorCodesResult.error;
  const pharmacyNameById = new Map(
    ((pharmaciesResult.data ?? []) as Array<{
      id: string; display_name: string | null; pharmacy_code: string | null; venue_type?: string | null;
    }>)
      .map((row) => [row.id, {
        code: row.pharmacy_code ?? "",
        name: row.display_name ?? "",
        venueType: normalizeVenueType(row.venue_type),
      }] as const),
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
    customer_id: string; distributor_code_id: string | null; pharmacy_id: string;
    validation_notes?: string | null; validation_status?: string | null;
  }>) {
    const pharmacy = pharmacyNameById.get(link.pharmacy_id);
    const code = link.distributor_code_id ? codeById.get(link.distributor_code_id) : null;
    // A link with a code that is not in the active-code list is a retired code: not offered.
    if (link.distributor_code_id && !code) continue;
    // Offered only through the SAME test the server applies to the draft (`requestTargetKind`):
    // a link that names a distributor code. A link with no code is never offered (owner,
    // 2026-10-21) — a nursery or a licence-only pharmacy is validated in Direct Orders, and offering
    // it would put a target in the picker the server would then refuse.
    if (!code || requestTargetKind({
      distributorCodeId: link.distributor_code_id,
      status: link.validation_status ?? null,
    }) !== "coded") continue;
    // Owner rule 2026-09-22 ("never never never"): a wholesaler / makhzan is never offered as a
    // target venue, even if one slipped past validation before this guard existed. Name-only — the
    // marketing pharmacy code is a different code space (see buildReusableMarketingPharmacies).
    if (pharmacy && isCertainWholesalerVenue(pharmacy.name)) continue;
    const list = pharmaciesByCustomer[link.customer_id] ?? [];
    list.push({
      distributorCodeId: link.distributor_code_id,
      distributorName: code ? distributorNameById.get(Number(code.distributor_id)) ?? "Unknown distributor" : null,
      pharmacyCode: code?.distributor_pharmacy_code ?? "",
      pharmacyId: link.pharmacy_id,
      pharmacyName: pharmacy?.name || pharmacy?.code || "Unnamed pharmacy",
      // Surfaced so the form can warn BEFORE submission rather than the server refusing after.
      referenceStatus: code?.reference_status ?? "pending",
      targetId: encodeVenueTarget({
        distributorCodeId: link.distributor_code_id,
        pharmacyId: link.pharmacy_id,
      }),
      venueType: pharmacy?.venueType ?? DEFAULT_VENUE_TYPE,
    });
    pharmaciesByCustomer[link.customer_id] = list;
  }

  // Every active contact of every customer, so the form can offer the one a campaign concerns.
  // `crm_code` is stored as text holding a CRM id, parsed by the shared strict parser that
  // src/lib/crm/contact-trade.ts also uses, so a contact reads as CRM-linked on both screens or on
  // neither. That parser's header carries the measurement that matters here: a code counts as
  // linked when it PARSES, never when it appears in `ireports360_contacts` — that table is one
  // agent's contact list, not a registry, and 40 of these 133 contacts are absent from it while
  // carrying real CRM visits. Do not "tighten" this label against it.
  const contactsByCustomer: Record<string, MarketingRequestContactOption[]> = {};
  for (const row of (contactsResult.data ?? []) as MarketingCustomerContactDbRow[]) {
    if (!row.customer_id) continue;
    const parsedCrmId = parseCrmContactCode(row.crm_code);
    const list = contactsByCustomer[row.customer_id] ?? [];
    list.push({
      contactName: cleanText(row.contact_name) ?? "Unnamed contact",
      crmContactId: parsedCrmId,
      id: row.id,
      mobileNumber: cleanText(row.mobile_number) ?? null,
    });
    contactsByCustomer[row.customer_id] = list;
  }
  const allCustomerRows = (customersResult.data ?? []) as MarketingCustomerDbRow[];
  const allCustomers = allCustomerRows.map(mapCustomer);
  // A customer DEACTIVATED after its request was approved falls out of the list above, which is
  // filtered `active.is.null,active.eq.true`. That filter is RIGHT for the create form — nobody
  // should be able to aim a new request at a retired customer — but this same list also labels the
  // finance table, which shows requests approved weeks or months ago. The row then fell back to
  // printing the raw customer UUID at the Finance Manager, breaking the rule that the UI shows
  // human-readable names and never raw ids. Measured on production 2026-08-30: 1 of the 4 rows on
  // his screen, on an EGP 11,200 request.
  //
  // Resolved BY ID, so it costs one extra query only when such a request actually exists, and it
  // cannot widen the picker: `customers` below is still built from allCustomerRows alone. The
  // finance-evidence upload path already resolves its customer this way (see the .eq("id", ...)
  // fetch beside the other buildMarketingApprovedRequestRows call) — which is why uploading a file
  // made the name appear and a reload made it vanish again.
  const knownCustomerIds = new Set(allCustomerRows.map((row) => row.id));
  const approvedOnlyCustomerIds = Array.from(
    new Set(
      approvedRequests
        .map((request) => request.customerId)
        .filter((id): id is string => Boolean(id) && !knownCustomerIds.has(id)),
    ),
  );
  const approvedRowCustomers = approvedOnlyCustomerIds.length > 0
    ? [
      ...allCustomers,
      ...(await fetchRowsByIds<MarketingCustomerDbRow>(
        supabase,
        "marketing_customers",
        approvedOnlyCustomerIds,
      )).map(mapCustomer),
    ]
    : allCustomers;
  const draftViewerAreaId = viewerAreaIdFor(access, employeeRows);
  const customers = allCustomerRows
    .filter((row) => validatedCustomerIds.has(row.id))
    .filter((row) => canSeeMarketingCustomer(access, row, employeeRows, draftViewerAreaId))
    .map(mapCustomer);

  return {
    approvedRequests: buildMarketingApprovedRequestRows({
      customers: approvedRowCustomers,
      employeeRows,
      financeRequirements: ((financeRequirementsResult.data ?? []) as MarketingRequestFinanceRequirementDbRow[]).map(mapFinanceRequirement),
      offsets: offsetsByRequestId,
      requests: approvedRequests,
    }),
    canCreateDraft: productScope.canCreateDraft,
    canSettleAgainstDirectOrder: canRecordDirectOrderCollection(access),
    contactsByCustomer,
    customers,
    pharmaciesByCustomer,
    distributors: ((distributorsResult.data ?? []) as MarketingDistributorDbRow[]).map(mapDistributor),
    drafts,
    inApproval,
    products: productScope.products,
    requestTypes: ((typesResult.data ?? []) as MarketingRequestTypeDbRow[]).map(mapRequestType),
    requesterLineId: productScope.requesterLineId,
    requesterLineName: productScope.requesterLineName,
    rejected,
    rejectionByRequestId,
    returned,
    // Only requests the current user personally submitted may be edited after a return.
    // Managers can see their team's returned requests above (read-only) but must never
    // get an edit button on another employee's submission.
    returnedToMe: returned.filter((req) => isSamePerson(req.requesterHrId, access.hrId)),
    stepProgressByRequestId,
  };
}

export async function createMarketingRequestDraft(
  input: MarketingRequestCreateDraft,
  access: AccessContext,
  options: CreateDraftOptions = {},
): Promise<MarketingRequestDraftDetail> {
  assertMarketingRequestCreationAccess(access);
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

  const [customerResult, requestTypeResult, contactResult, productRows, pharmacyCodes, venuePharmacies, customerLinks] = await Promise.all([
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
    fetchPharmacyCodes(
      supabase,
      normalized.pharmacies.map((pharmacy) => pharmacy.distributorCodeId).filter((id): id is string => Boolean(id)),
    ),
    fetchVenuePharmacies(
      supabase,
      normalized.pharmacies.map((pharmacy) => pharmacy.pharmacyId).filter((id): id is string => Boolean(id)),
    ),
    fetchCustomerTargetLinks(supabase, normalized.customerId),
  ]);

  if (customerResult.error) throw customerResult.error;
  if (requestTypeResult.error) throw requestTypeResult.error;
  if (contactResult.error) throw contactResult.error;
  if (!customerResult.data) throw notFoundError("Customer was not found.", "customer_not_found");
  if (!requestTypeResult.data) throw notFoundError("Request type was not found.", "request_type_not_found");
  // Re-checked on the server, never trusted from the payload: the picker is scoped, but the body
  // carries a raw customerId. Runs before the draft is prepared, so a customer on somebody else's
  // patch fails here rather than at the first insert.
  assertMarketingCustomerIsInScope(access, customerResult.data as MarketingCustomerDbRow, employeeRows);

  const contact = contactResult.data as MarketingCustomerContactDbRow | null;
  if (contact && (contact.active === false || contact.customer_id !== normalized.customerId)) {
    throw validationError("Customer contact does not belong to the selected customer.");
  }

  await assertMarketingCustomerHasValidatedVenue(supabase, normalized.customerId);

  const prepared = prepareMarketingRequestDraft({
    customer: customerResult.data as MarketingCustomerDbRow,
    customerLinks,
    input,
    pharmacyCodes,
    products: productRows,
    requestType: requestTypeResult.data as MarketingRequestTypeDbRow,
    requester,
    venuePharmacies,
    unrestrictedProductLines: canUseAnyMarketingProductLine(access),
    allowedProductCodes,
  });
  assertMarketingRequestNamesAVenue(prepared.pharmacyRows.length);

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
    // Both notices go out AFTER the reply (afterResponse, 2026-10-23 slow-buttons audit): the request is
    // saved by now, so the person who pressed Submit never waits for the approver's and HR's notices.
    // Two tasks, not one, so a failure in the first can never stop the second, and a failed notice can
    // no longer fall into the catch below and delete a request that was saved. Outside a request (the
    // unit suite, a script) `afterResponse` awaits each in turn, as before.
    if (currentStep) {
      await afterResponse("marketing_notice:request_assigned", () =>
        notifyMarketingWorkflow({
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
        }),
      );
    }
    await afterResponse("marketing_notice:request_submitted", async () => {
      const requesterDisplayName = employeeNameByHrId(employeeRows, request.requesterHrId) || request.requesterHrId;
      await createSystemNotification({
        actionUrl: marketingActionUrl(request.id),
        actorId: request.requesterHrId,
        channels: ["in_app", "telegram", "push"],
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
    });

    pingMarketingRequestSheet("request_submitted");
    return draftDetail;
  } catch (error) {
    await supabase.from("marketing_requests").delete().eq("id", request.id);
    throw error;
  }
}

/**
 * Edit a returned marketing request and resubmit it, replacing the products/pharmacies with the
 * edited set.
 *
 * Where it resumes depends on what the requester changed (owner, 2026-10-14). A resubmit that moves
 * the COST, the CUSTOMER or the TARGETS restarts the chain at the first approver - an earlier "yes"
 * was given on the old money, customer and venues, and must not carry over to new ones. A resubmit
 * that changes none of the three resumes at the rung that returned it, earlier approvals kept.
 * `resubmit-rule.ts` holds both decisions as pure functions.
 *
 * Everything it writes is ONE database transaction, `phx_resubmit_marketing_request`: the products and
 * targets are replaced, the planned rungs are rewritten, and the function refuses to commit unless
 * exactly one gating rung is `current`. A client-side claim-and-rollback was tried first and rejected
 * in review: its rollback could not re-insert products (`expected_value` is GENERATED ALWAYS), a
 * second resubmit could claim on top of the first, and a final write that committed but errored to
 * the client was rolled back around. The service decides WHAT to write (the restart rule, the plan,
 * the customer-scope check); the function decides nothing, it makes the writes all-or-nothing.
 */
export async function resubmitReturnedMarketingRequest(
  input: MarketingRequestCreateDraft & { requestId: string },
  access: AccessContext,
): Promise<MarketingRequestDraftDetail> {
  assertMarketingRequestCreationAccess(access);
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
  if (!isSamePerson(existing.requesterHrId, requester.hrId)) {
    throw forbiddenError("Forbidden: only the requester can resubmit this marketing request.");
  }

  const normalized = normalizeMarketingRequestDraftInput(input);
  const [customerResult, requestTypeResult, contactResult, productRows, pharmacyCodes, venuePharmacies, customerLinks] = await Promise.all([
    supabase.from("marketing_customers").select("id, owner_hr_id, manager_hr_id, line_id, area_id, active").eq("id", normalized.customerId).maybeSingle(),
    supabase.from("marketing_request_types").select("id, code, name, description, requires_description, sort_order, active").eq("id", normalized.requestTypeId).maybeSingle(),
    normalized.customerContactId
      ? supabase.from("marketing_customer_contacts").select("id, customer_id, active").eq("id", normalized.customerContactId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    fetchActiveProducts(supabase, normalized.products.map((product) => product.productId)),
    fetchPharmacyCodes(
      supabase,
      normalized.pharmacies.map((pharmacy) => pharmacy.distributorCodeId).filter((id): id is string => Boolean(id)),
    ),
    fetchVenuePharmacies(
      supabase,
      normalized.pharmacies.map((pharmacy) => pharmacy.pharmacyId).filter((id): id is string => Boolean(id)),
    ),
    fetchCustomerTargetLinks(supabase, normalized.customerId),
  ]);
  if (customerResult.error) throw customerResult.error;
  if (requestTypeResult.error) throw requestTypeResult.error;
  if (contactResult.error) throw contactResult.error;
  if (!customerResult.data) throw notFoundError("Customer was not found.", "customer_not_found");
  if (!requestTypeResult.data) throw notFoundError("Request type was not found.", "request_type_not_found");
  // Same guard as the create path, and needed just as much: a resubmit re-reads `customerId` from
  // the edited payload, so the customer can be SWAPPED for one the requester was never allowed to
  // see. Only-the-requester-may-resubmit above proves who is editing, not what they may point at.
  assertMarketingCustomerIsInScope(access, customerResult.data as MarketingCustomerDbRow, employeeRows);
  const contact = contactResult.data as MarketingCustomerContactDbRow | null;
  if (contact && (contact.active === false || contact.customer_id !== normalized.customerId)) {
    throw validationError("Customer contact does not belong to the selected customer.");
  }

  // A returned request can sit for weeks, and its customer can be retired or merged away while it
  // waits — which is exactly what happened to customer MKT-HCP-20260812-A26BF1C7 on 2026-08-21.
  // Create has refused an unvalidated customer since the module shipped; resubmit never did.
  await assertMarketingCustomerHasValidatedVenue(supabase, normalized.customerId);

  const prepared = prepareMarketingRequestDraft({
    customer: customerResult.data as MarketingCustomerDbRow,
    customerLinks,
    input,
    pharmacyCodes,
    products: productRows,
    requestCode: existing.requestCode,
    requestType: requestTypeResult.data as MarketingRequestTypeDbRow,
    requester,
    venuePharmacies,
    unrestrictedProductLines: canUseAnyMarketingProductLine(access),
    allowedProductCodes,
  });
  // Before the delete below, not after: the resubmit replaces the target list wholesale, so an
  // empty edited set would otherwise strip the targets off a request that already had them.
  assertMarketingRequestNamesAVenue(prepared.pharmacyRows.length);

  const steps = await loadMarketingRequestApprovalSteps(supabase, requestId);
  const resumeStep = steps
    .filter((step) => step.status === "returned")
    .sort((left, right) => left.sequence - right.sequence)[0]
    ?? steps.filter((step) => !step.isCc).sort((left, right) => left.sequence - right.sequence)[0]
    ?? null;
  if (!resumeStep) throw conflictError("This marketing request has no approval step to resume.");

  // What the earlier approvals were given ON, read BEFORE anything is replaced. Only the targets are
  // needed: cost and customer are on `existing`, and the products decide nothing about a restart.
  const previousPharmaciesResult = await supabase
    .from("marketing_request_pharmacies")
    .select("distributor_code_id, pharmacy_id")
    .eq("request_id", requestId);
  if (previousPharmaciesResult.error) throw previousPharmaciesResult.error;
  const previousPharmacyRows = (previousPharmaciesResult.data ?? []) as Array<
    Pick<MarketingRequestPharmacyDbRow, "distributor_code_id" | "pharmacy_id">
  >;

  const basisChanges: ResubmitBasisChange[] = resubmitBasisChanges(
    {
      customerId: existing.customerId,
      estimatedCost: existing.estimatedCost,
      targets: previousPharmacyRows.map((row) => ({
        distributorCodeId: row.distributor_code_id ?? null,
        pharmacyId: row.pharmacy_id,
      })),
    },
    {
      customerId: prepared.requestRow.customer_id,
      estimatedCost: prepared.requestRow.estimated_cost,
      targets: prepared.pharmacyRows.map((row) => ({
        distributorCodeId: row.distributor_code_id,
        pharmacyId: row.pharmacy_id,
      })),
    },
  );
  const restartApprovals = basisChanges.length > 0;
  const restartPlan = restartApprovals ? planRestartedApprovalSteps(steps) : [];
  const stepsById = new Map(steps.map((step) => [step.id, step] as const));

  // The rungs the function rewrites. A restart puts the whole chain back to its start (first gate
  // `current`, the rest `pending`, every earlier decision cleared); a plain resume reopens only the
  // rung that returned it. The function applies this list blindly but refuses to commit unless
  // exactly one gating rung is `current` afterwards, so a bad plan strands nothing.
  const stepWrites: Array<{ status: "current" | "pending"; stepId: string }> = restartApprovals
    ? restartPlan
    : [{ status: "current", stepId: resumeStep.id }];
  if (stepWrites.length === 0) {
    throw conflictError("This marketing request has no approval step to restart from.");
  }

  const now = new Date().toISOString();
  const { data: rpcData, error: rpcError } = await supabase.rpc("phx_resubmit_marketing_request", {
    p_pharmacies: prepared.pharmacyRows,
    p_products: prepared.productRows,
    p_request: {
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
      roi_duration_months: prepared.requestRow.roi_duration_months,
      roi_status: prepared.requestRow.roi_status,
    },
    p_request_id: requestId,
    p_resubmitted_at: now,
    p_resubmitted_by: requester.hrId,
    p_steps: stepWrites.map(({ status, stepId }) => ({ status, stepId })),
  });
  if (rpcError) {
    const message = rpcError.message ?? "";
    if (message.includes("marketing_request_not_found")) {
      throw notFoundError("Marketing request was not found.", "marketing_request_not_found");
    }
    // A second tab or a double tap lands here: the first resubmit already took the request off
    // `returned`, and the row lock made this one wait and then find that out.
    if (message.includes("marketing_request_not_returned")) {
      throw conflictError(
        "This marketing request is no longer returned - it may already have been resubmitted. Reload to see where it stands.",
        "marketing_resubmit_conflict",
      );
    }
    if (message.includes("marketing_resubmit_not_requester")) {
      throw forbiddenError("Forbidden: only the requester can resubmit this marketing request.");
    }
    if (message.includes("marketing_resubmit_no_products")) {
      throw validationError("A resubmitted marketing request needs at least one product.", "marketing_resubmit_no_products");
    }
    if (message.includes("marketing_resubmit_no_targets")) {
      throw validationError("A resubmitted marketing request needs at least one target venue.", "marketing_resubmit_no_targets");
    }
    if (message.includes("marketing_resubmit_invalid_steps") || message.includes("marketing_resubmit_no_single_current_step")) {
      throw conflictError(
        "This marketing request's approval chain changed while it was being resubmitted. Reload and try again.",
        "marketing_resubmit_conflict",
      );
    }
    throw rpcError;
  }
  const resubmitResult = rpcData as {
    currentStep: MarketingRequestApprovalStepDbRow;
    pharmacies: MarketingRequestPharmacyDbRow[];
    products: MarketingRequestProductDbRow[];
    request: MarketingRequestDbRow;
  };
  const request: MarketingRequest = mapRequest(resubmitResult.request);
  const openedStep: MarketingRequestApprovalStep = mapApprovalStep(resubmitResult.currentStep);
  const pharmacies: MarketingRequestPharmacy[] = (resubmitResult.pharmacies ?? []).map(mapPharmacy);
  const products = (resubmitResult.products ?? []).map(mapProduct);

  if (restartApprovals) {
    const cleared = restartPlan
      .map((entry) => stepsById.get(entry.stepId))
      .filter((step): step is MarketingRequestApprovalStep => Boolean(step?.decisionByHrId && step.status === "approved"))
      .map((step) => `${step.stepName} (${employeeNameByHrId(employeeRows, step.decisionByHrId) || "unknown"})`);
    await writeAuditLog({
      actorLoginId: access.loginId ?? access.hrId,
      entityId: requestId,
      entityType: "marketing_request",
      newValues: { approvalsRestartedAt: openedStep.stepName, changed: basisChanges },
      oldValues: { approvalsCleared: cleared },
      summary:
        `Marketing request ${request.requestCode} was resubmitted with a changed ${basisChanges.join(", ")}; `
        + `the approval chain restarted at "${openedStep.stepName}".`
        + (cleared.length > 0 ? ` Earlier approvals cleared: ${cleared.join("; ")}.` : ""),
    });
  }

  const requestTypeName = (requestTypeResult.data as MarketingRequestTypeDbRow).name;
  const ccHrIds = steps
    .filter((step) => step.isCc && step.stepCode === openedStep.stepCode)
    .map((step) => step.assignedHrId)
    .filter((hrId): hrId is string => Boolean(hrId));
  // The notice goes out AFTER the reply (afterResponse, 2026-10-23 slow-buttons audit): the resubmit is
  // one committed transaction by now, so the requester never waits for the approver's notice. Outside a
  // request (the unit suite, a script) `afterResponse` simply awaits the task, as before.
  await afterResponse("marketing_notice:request_resubmitted", async () => {
    // The same epoch the decision path and the daily backfill compute from the rung's recorded
    // openings - a clock instant of this call's own would never match theirs, and the approver would
    // be told twice. `now` only stands in when the rung has opened just once.
    const reopenEpoch = (await resolveMarketingStepReopenEpoch(supabase, requestId, openedStep.sequence)) ?? now;
    await notifyMarketingWorkflow({
      actorHrId: requester.hrId,
      ccHrIds,
      eventType: "request_assigned",
      message: restartApprovals
        ? `${request.requestCode} was resubmitted with a changed ${basisChanges.join(", ")} and restarts at ${openedStep.stepName}.`
        : `${request.requestCode} was resubmitted and is waiting for ${openedStep.stepName}.`,
      metadata: {
        assignedApproverHrId: openedStep.assignedHrId,
        currentStepId: openedStep.id,
        currentStepName: openedStep.stepName,
        idempotencyEpoch: reopenEpoch,
        workflowApproverHrId: openedStep.assignedHrId,
        ...marketingNotificationVariables({ currentStep: openedStep, employeeRows, request, requestTypeName }),
      },
      priority: "high",
      request,
      title: "Marketing request resubmitted",
    });
  });

  const resubmitted = {
    ...request,
    pharmacies,
    products,
  };
  pingMarketingRequestSheet("request_resubmitted");
  return resubmitted;
}

/**
 * Reopen a REFUSED request onto the rung that refused it. Super Admin only.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * `rejected` was terminal and no control anywhere reversed it:
 * `resubmitReturnedMarketingRequest` guards on `status !== "returned"`, which is the neighbouring
 * case, not this one. On 2026-09-06 the owner asked for two requests the CEO had refused three days
 * earlier to go back to him, and the only way to do it was hand-written SQL against production.
 *
 * ── THE PART THAT IS EASY TO GET WRONG ───────────────────────────────────────
 * Putting the rung back is not enough. `notifyMarketingWorkflow` keys `request_assigned` on the
 * STEP ID and `notification_deliveries.idempotency_key` is UNIQUE — and the refusing rung has by
 * definition already notified its approver, which is how they knew to refuse it. So a reopen that
 * merely writes the rows leaves the request sitting silently on that person's desk, with the sweep
 * reporting `already_notified`, which reads as "they were told".
 *
 * `dispatchMarketingAssignmentEmail` is what makes it land, and it needs nothing passed to it: the
 * `marketing_request_steps_capture_event` trigger writes a second `step_opened` row for the rung
 * inside the RPC's own transaction, and `marketingReopenEpoch` re-keys the notice off that. The
 * dispatch is called AFTER the RPC has committed, so the second opening is visible to it.
 *
 * The refusal itself is not erased — `marketing_request_events` keeps the `step_decided` row and
 * its note, append-only, and the reason for the reopen is written beside it.
 */
export async function reopenRejectedMarketingRequest(
  access: AccessContext,
  input: { reason?: string | null; requestId: string },
): Promise<{
  notified: boolean;
  reopenedStepName: string;
  requestCode: string;
  restoredRungs: number;
}> {
  const requestId = cleanText(input.requestId);
  if (!requestId) throw validationError("Marketing request ID is required.");

  // The role gate, from the one module buildViewer reads too, so the button and the write can
  // never disagree about who may press it.
  if (!viewerMayReopenMarketingRequests(access.role)) {
    throw forbiddenError(`Forbidden: ${access.role} cannot reopen a rejected marketing request.`);
  }

  const reason = cleanText(input.reason);
  if (!reason) {
    throw validationError(
      "A reason is required to reopen a rejected marketing request.",
      "marketing_reopen_reason_required",
    );
  }

  const identity = resolveEmployeeIdentityId(access);
  if (!identity) {
    throw forbiddenError("Forbidden: a linked Phoenix HR identity is required to reopen a marketing request.");
  }
  /**
   * `updated_by_hr_id` carries a foreign key to `employees(hr_id)`, which is MIXED CASE, and one
   * of this database's two Super Admins is the shared `admin-HR` login whose `hr_id` is NULL —
   * so a normalized id matches nobody and the write is refused outright. This is the same trap
   * that made the finance hold reachable by nobody until it was fixed there; the canonical
   * resolver is the repo's single answer to it and maps a login token to the real employee.
   */
  const actorHrId = await resolveCanonicalActorHrId(String(access.hrId ?? access.loginId ?? identity));

  const supabase = getSupabaseAdmin();
  const reopenedAt = new Date().toISOString();

  // One transaction. A half-applied reopen would leave `pending_approval` with no `current` rung,
  // which the SLA scan flags as actively misleading, and a timed-out client request still commits.
  const { data, error } = await supabase.rpc("phx_reopen_rejected_marketing_request", {
    p_reason: reason,
    p_reopened_at: reopenedAt,
    p_reopened_by: actorHrId,
    p_request_id: requestId,
  });
  if (error) {
    if (error.message?.includes("marketing_request_not_rejected")) {
      throw conflictError(
        "This marketing request is not rejected, so there is nothing to reopen. Refresh Phoenix and try again.",
      );
    }
    if (error.message?.includes("marketing_reopen_no_rejected_step")) {
      throw conflictError("This marketing request carries no refused approval step to reopen.");
    }
    if (error.message?.includes("marketing_reopen_reason_required")) {
      throw validationError(
        "A reason is required to reopen a rejected marketing request.",
        "marketing_reopen_reason_required",
      );
    }
    if (error.message?.includes("marketing_request_not_found")) {
      throw notFoundError("Marketing request was not found.", "marketing_request_not_found");
    }
    throw error;
  }

  const result = data as {
    request: MarketingRequestDbRow;
    restored: number;
    step: MarketingRequestApprovalStepDbRow;
  };
  const request = mapRequest(result.request);
  const step = mapApprovalStep(result.step);
  const restoredRungs = Number(result.restored ?? 0);

  await writeAuditLog({
    actorLoginId: actorHrId,
    entityId: request.id,
    entityType: "marketing_request",
    newValues: {
      reason,
      requestCode: request.requestCode,
      restoredRungs,
      source: "marketing_request_reopen",
      stepCode: step.stepCode,
      stepId: step.id,
    },
    summary:
      `Marketing request ${request.requestCode} reopened onto ${step.stepName}.`
      + (restoredRungs > 0 ? ` ${restoredRungs} later approval step${restoredRungs === 1 ? "" : "s"} restored.` : ""),
  });

  // Tell the approver it is back. See the docblock: without the epoch this is a silent no-op, and
  // the epoch exists because the RPC's step update fired the step_opened trigger a second time.
  const dispatch = await dispatchMarketingAssignmentEmail(requestId);

  pingMarketingRequestSheet("request_reopened");

  return {
    notified: dispatch.dispatched,
    reopenedStepName: step.stepName,
    requestCode: request.requestCode,
    restoredRungs,
  };
}

/** Approver inbox: marketing requests awaiting the current user's decision. */
export async function getApproverPendingRequests(access: AccessContext): Promise<MarketingApproverInboxWorkspace> {
  // The Approval Inbox is one of the two surfaces the Medical Rep lost on 2026-09-18. A rep holds
  // no rung on any chain, so this queue was already empty for them — but an empty page is not a
  // closed door, and the page guard that hides it is UX. This is the boundary.
  assertMarketingApprovalInboxAccess(access);
  const actorHrId = requireMarketingDecisionActor(access);
  const supabase = getSupabaseAdmin();

  // Gating steps the actor must decide, and CC steps the actor may comment on (non-blocking).
  // `assigned_hr_id` is stored in the employee master's real casing, while the session id is
  // lower-cased — match every HR_ID dialect so the inbox is not silently empty for an approver.
  const actorHrKeys = hrIdLookupKeys(actorHrId);
  // Super Admin holds no rung on the chain, so the three actor-scoped queries below return nothing
  // for him and the inbox reads empty while the company has requests in flight. This fourth query
  // is his, and only his — see canViewMarketingOversightQueue and the `oversightRows` doc comment.
  const includeOversight = canViewMarketingOversightQueue(access);
  const [gatingResult, ccResult, upcomingResult, oversightResult] = await Promise.all([
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
    // Bounded by the number of requests actually in flight (one open gating step each), not by the
    // size of the table — a finished or rejected request has no step in `current`.
    includeOversight
      ? supabase
          .from("marketing_request_approval_steps")
          .select("*")
          .eq("status", "current")
          .eq("is_cc", false)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (gatingResult.error) throw gatingResult.error;
  if (ccResult.error) throw ccResult.error;
  if (upcomingResult.error) throw upcomingResult.error;
  if (oversightResult.error) throw oversightResult.error;
  const gatingSteps = ((gatingResult.data ?? []) as MarketingRequestApprovalStepDbRow[]).map(mapApprovalStep);
  const ccSteps = ((ccResult.data ?? []) as MarketingRequestApprovalStepDbRow[]).map(mapApprovalStep);
  const upcomingSteps = ((upcomingResult.data ?? []) as MarketingRequestApprovalStepDbRow[]).map(mapApprovalStep);
  const oversightSteps = ((oversightResult.data ?? []) as MarketingRequestApprovalStepDbRow[]).map(mapApprovalStep);
  if (
    gatingSteps.length === 0 &&
    ccSteps.length === 0 &&
    upcomingSteps.length === 0 &&
    oversightSteps.length === 0
  ) {
    return { advisoryRows: [], oversightRows: [], rows: [], upcomingRows: [] };
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
    new Set([...gatingSteps, ...activeCcSteps, ...upcomingSteps, ...oversightSteps].map((step) => step.requestId)),
  );
  if (requestIds.length === 0) return { advisoryRows: [], oversightRows: [], rows: [], upcomingRows: [] };

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
      ? supabase.from("marketing_customers").select("id, display_name, crm_list_status").in("id", customerIds)
      : Promise.resolve({ data: [], error: null }),
    typeIds.length > 0
      ? supabase.from("marketing_request_types").select("id, name").in("id", typeIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (customersResult.error) throw customersResult.error;
  if (typesResult.error) throw typesResult.error;
  const customerNameById = new Map(((customersResult.data ?? []) as Array<{ id: string; display_name?: string | null }>)
    .map((row) => [row.id, cleanText(row.display_name) ?? row.id] as const));
  const customerCrmFlagById = new Map(((customersResult.data ?? []) as Array<{ id: string; crm_list_status?: string | null }>)
    .map((row) => [row.id, crmListFlag(row.crm_list_status)] as const));
  const typeNameById = new Map(((typesResult.data ?? []) as Array<{ id: number | string; name?: string | null }>)
    .map((row) => [Number(row.id), cleanText(row.name) ?? "Marketing request"] as const));

  // `myStepId` defaults to the step being rendered, which is right for every actor-scoped section.
  // The oversight section passes null: the current holder's rung is somebody else's, and marking it
  // "isMine" would put a Super Admin's name on another approver's decision.
  const buildRow = (
    step: MarketingRequestApprovalStep,
    request: MarketingRequest,
    myStepId: string | null = step.id,
  ): MarketingApproverInboxRow => ({
    allowReject: step.allowReject,
    allowReturn: step.allowReturn,
    approvalHistory: buildMarketingApproverChain(
      allStepsByRequest.get(request.id) ?? [],
      employeeRows,
      myStepId,
    ),
    currentStepName: step.stepName,
    customerName: customerNameById.get(request.customerId) ?? request.customerId,
    customerCrmListFlag: customerCrmFlagById.get(request.customerId) ?? null,
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
  // Age is measured from SUBMISSION, not from when it reached the current holder: the question a
  // reader of a read-only queue is asking is "how long has this been in the system?".
  const ageDaysSinceSubmission = (request: MarketingRequest) => {
    const submittedAtMs = request.submittedAt ? Date.parse(request.submittedAt) : Number.NaN;
    return Number.isFinite(submittedAtMs)
      ? Math.max(0, Math.floor((Date.now() - submittedAtMs) / 86_400_000))
      : 0;
  };

  const upcomingRows: MarketingApproverUpcomingRow[] = [];
  for (const step of upcomingSteps) {
    const request = requestById.get(step.requestId);
    if (!request) continue;
    const chain = (allStepsByRequest.get(step.requestId) ?? []).sort((left, right) => left.sequence - right.sequence);
    const holder = chain.find((chainStep) => chainStep.status === "current") ?? null;
    const ageDays = ageDaysSinceSubmission(request);

    upcomingRows.push({
      ...buildRow(step, request),
      ageDays,
      awaitingApproverName: holder ? employeeNameByHrId(employeeRows, holder.assignedHrId) : null,
      awaitingStepName: holder?.stepName ?? null,
      myStepSequence: step.sequence,
      totalGatingSteps: chain.length,
    });
  }

  // Company-wide watch list. `oversightSteps` is empty for every role but Super Admin, so this loop
  // simply does not run for anyone else.
  const myRequestIds = new Set(rows.map((row) => row.id));
  const oversightRows: MarketingApproverOversightRow[] = [];
  for (const step of oversightSteps) {
    const request = requestById.get(step.requestId);
    if (!request) continue;
    // Anything already awaiting HIS decision belongs in "Requests awaiting my decision", where it
    // is actionable. Listing it twice would make one request read as two.
    if (myRequestIds.has(request.id)) continue;
    const chain = (allStepsByRequest.get(step.requestId) ?? []).sort((left, right) => left.sequence - right.sequence);

    oversightRows.push({
      ...buildRow(step, request, null),
      // Forced, not inherited. These flags come off somebody else's step, and a truthy one here is
      // all it would take for a future edit to render an Approve button on a request that is not
      // his to decide. The API would still refuse it — this makes the UI unable to ask.
      allowReject: false,
      allowReturn: false,
      ageDays: ageDaysSinceSubmission(request),
      awaitingApproverName: employeeNameByHrId(employeeRows, step.assignedHrId),
      awaitingStepName: step.stepName,
      totalGatingSteps: chain.length,
      // The one action an oversight viewer may take on a request that is not his to decide: call it
      // off. Gated by the same rule the case-file and API use, so the button never shows on a status
      // that cannot be cancelled, and never for any role but Super Admin.
      canCancel: canCancelMarketingRequest({ role: access.role, status: request.status }),
    });
  }

  const bySubmittedAt = (left: MarketingApproverInboxRow, right: MarketingApproverInboxRow) =>
    (left.submittedAt ?? "").localeCompare(right.submittedAt ?? "");
  rows.sort(bySubmittedAt);
  advisoryRows.sort(bySubmittedAt);
  // Oldest first — a request that has been sitting longest is the one worth chasing.
  upcomingRows.sort((left, right) => right.ageDays - left.ageDays);
  oversightRows.sort((left, right) => right.ageDays - left.ageDays);
  return { advisoryRows, oversightRows, rows, upcomingRows };
}

/* ────────────────────────────────────────────────────────────────────────────────────────────── */
/* Approval HISTORY — the second tab of the same inbox                                             */
/* ────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Where a request ended up once the chain finished with it.
 *
 * Deliberately COARSER than `MarketingRequestStatus`: the lifecycle carries eleven values and a
 * reader of an approval history is asking one question — did it get a yes, a no, or a send-back.
 * `active` / `roi_tracking` / `finance_hold` are all states a request can only reach by having
 * been APPROVED, so folding them here is not a loss of truth; the live status is still carried on
 * the row for anyone who needs the finer answer.
 */
export type MarketingApproverHistoryOutcome =
  | "approved"
  | "rejected"
  | "returned"
  | "closed"
  | "archived"
  | "cancelled"
  | "in_flight";

/**
 * Pure status → outcome map, so the labelling is testable without a database.
 *
 * `in_flight` is the fail-safe: a status that has NOT left the chain must never be presented as a
 * finished decision. The query below excludes those rows, so this branch is reachable only if the
 * lifecycle grows a new pre-decision status — in which case a row reading "still in approval" is
 * the harmless answer and a row reading "Approved" is the dangerous one.
 */
export function marketingHistoryOutcome(status: MarketingRequest["status"]): MarketingApproverHistoryOutcome {
  switch (status) {
    case "approved":
    case "active":
    case "roi_tracking":
    case "finance_hold":
      return "approved";
    case "rejected":
      return "rejected";
    case "returned":
      return "returned";
    case "closed":
      return "closed";
    case "archived":
      return "archived";
    case "cancelled":
      return "cancelled";
    default:
      return "in_flight";
  }
}

/** Human-readable, because a raw status code is never shown to anyone — owner rule. */
export const MARKETING_HISTORY_OUTCOME_LABEL: Record<MarketingApproverHistoryOutcome, string> = {
  approved: "Approved",
  archived: "Archived",
  cancelled: "Cancelled",
  closed: "Closed",
  in_flight: "Still in approval",
  rejected: "Rejected",
  returned: "Returned to requester",
};

/** The statuses that mean "the chain is no longer waiting on an approver". */
const MARKETING_HISTORY_STATUSES: ReadonlyArray<MarketingRequest["status"]> = [
  "approved",
  "active",
  "roi_tracking",
  "finance_hold",
  "closed",
  "rejected",
  "returned",
  "archived",
  "cancelled",
];

/**
 * How many finished requests the history tab loads at once.
 *
 * Not a page size — it is the ceiling on one read. The register (`getMarketingAllRequestsWorkspace`)
 * is the exhaustive report; this is the tab next to an inbox, and it is ordered newest-decision
 * first so the cap only ever hides the oldest. `truncated` is returned so the UI can SAY that
 * rather than quietly presenting a partial list as the whole history.
 */
const MARKETING_HISTORY_ROW_LIMIT = 300;

/**
 * One finished request, with the entire decision trail attached.
 *
 * Same base shape as a pending inbox row on purpose — the two tabs render the same chain component,
 * so a rung reads identically whether it is being decided or being remembered.
 */
export type MarketingApproverHistoryRow = MarketingApproverInboxRow & {
  /** ISO of the last recorded decision on the chain — what the list is ordered by. */
  decidedAt: string | null;
  /** Who gave the decision that ended it. */
  finalApproverName: string | null;
  /** What that approver actually wrote. Null when they decided without comment. */
  finalDecisionNote: string | null;
  /** The rung it ended at — "CEO Approval", "SFE Validation". */
  finalStepName: string | null;
  /**
   * The viewer's OWN verdict on this request, or null when they never decided it (a rung that was
   * skipped past them, or a request they are only seeing through oversight).
   */
  myDecision: {
    at: string | null;
    note: string | null;
    status: MarketingRequestApprovalStep["status"];
    stepName: string;
  } | null;
  /** True when the viewer RAISED this request. Their own work, whether or not they also approved it. */
  isMyRequest: boolean;
  outcome: MarketingApproverHistoryOutcome;
  outcomeLabel: string;
  totalGatingSteps: number;
  /**
   * True when the ONLY reason this row is visible is company-wide oversight — the viewer neither
   * held a rung on it nor raised it. Rendered as a marker so a Super Admin is never left thinking
   * he decided something he did not. A requester looking at their own request is NOT oversight,
   * which is why this is not simply `myStep === null`.
   */
  viaOversight: boolean;
};

export type MarketingApproverHistoryWorkspace = {
  rows: MarketingApproverHistoryRow[];
  /**
   * Company-wide (oversight), or only what the viewer was personally part of — rungs they held
   * plus requests they raised.
   */
  scope: "company" | "mine";
  /** True when the read hit MARKETING_HISTORY_ROW_LIMIT and older requests exist beyond it. */
  truncated: boolean;
};

/**
 * The approval inbox's second tab: requests that have already been answered.
 *
 * Owner instruction, 2026-08-19. The inbox showed only live work — four sections, all of them
 * requests still moving. The moment a request was approved or rejected it vanished from the one
 * screen the approvers actually open, so "what did we decide on this pharmacy, and why" had no
 * answer anywhere near where the decision was made.
 *
 * SCOPE, which is the part worth getting right:
 *  · An oversight viewer (Super Admin / system scope — `canViewMarketingOversightQueue`, the same
 *    gate as the live oversight section) sees EVERY finished request. Same right, same people,
 *    across both tabs; nothing new is exposed to anyone who could not already watch the queue.
 *  · Everybody else sees only requests they were personally part of — a rung assigned to them, a
 *    rung they decided, or (owner instruction, 2026-08-19) a request they RAISED. All three are
 *    things they have already been shown: a rung on their chain passed through their own inbox,
 *    and their own request is served to them in full, decision notes included, by
 *    getMarketingRequestDetail. This tab moves that record next to the decision, it does not
 *    widen who may read it.
 *
 * Read-only in the strongest sense: no decision control is derivable from these rows, because the
 * request has left `pending_approval` and the decision API matches on an OPEN step the actor holds.
 */
export async function getApproverDecidedRequests(
  access: AccessContext,
): Promise<MarketingApproverHistoryWorkspace> {
  const actorHrId = requireMarketingDecisionActor(access);
  const supabase = getSupabaseAdmin();
  const actorHrKeys = hrIdLookupKeys(actorHrId);
  const includeOversight = canViewMarketingOversightQueue(access);
  const scope = includeOversight ? ("company" as const) : ("mine" as const);

  // Which requests are candidates. The oversight branch reads the REQUESTS table directly — a
  // Super Admin holds no rung, so a step-scoped query would return nothing for him, exactly the
  // hole the live oversight section exists to fill.
  let candidateIds: string[];
  if (includeOversight) {
    const finishedResult = await supabase
      .from("marketing_requests")
      .select("id")
      .in("status", [...MARKETING_HISTORY_STATUSES])
      .order("updated_at", { ascending: false })
      .limit(MARKETING_HISTORY_ROW_LIMIT + 1);
    if (finishedResult.error) throw finishedResult.error;
    candidateIds = ((finishedResult.data ?? []) as Array<{ id: string }>).map((row) => String(row.id));
  } else {
    // Assigned AND decided, separately: a re-assigned step is decided by somebody who is no longer
    // its assignee, and an approver must keep the record of a call they personally made.
    // `is_cc` is NOT filtered out here — a CC reviewer who left a comment on a request has a
    // legitimate reason to find it again.
    //
    // The third query is the REQUESTER's own work (owner instruction, 2026-08-19). Somebody who
    // raised a request and never sat on its chain held no rung at all, so the two step queries
    // return nothing for them — the person with the most reason to ask "what was decided, and
    // why" was the one person the tab answered with an empty page.
    //
    // This exposes nothing new: getMarketingRequestDetail already serves a requester their own
    // request in full, decision notes included, because canSeeMarketingHierarchyRecord returns
    // true the moment the target IS the viewer. Deliberately their OWN requests only, matched on
    // requester_hr_id — not their subtree, which is the register's job.
    const [assignedResult, decidedResult, raisedResult] = await Promise.all([
      supabase.from("marketing_request_approval_steps").select("request_id").in("assigned_hr_id", actorHrKeys),
      supabase.from("marketing_request_approval_steps").select("request_id").in("decision_by_hr_id", actorHrKeys),
      supabase
        .from("marketing_requests")
        .select("id")
        .in("requester_hr_id", actorHrKeys)
        .in("status", [...MARKETING_HISTORY_STATUSES]),
    ]);
    if (assignedResult.error) throw assignedResult.error;
    if (decidedResult.error) throw decidedResult.error;
    if (raisedResult.error) throw raisedResult.error;
    candidateIds = Array.from(
      new Set([
        ...[...(assignedResult.data ?? []), ...(decidedResult.data ?? [])].map((row) =>
          String((row as { request_id: string }).request_id),
        ),
        ...((raisedResult.data ?? []) as Array<{ id: string }>).map((row) => String(row.id)),
      ]),
    );
  }
  if (candidateIds.length === 0) return { rows: [], scope, truncated: false };

  // Batched: PostgREST folds every .in() value into the URL, and an unbatched list of a few hundred
  // ids can push it past undici's header limit.
  const requestRows: MarketingRequestDbRow[] = [];
  for (const batch of chunk(candidateIds)) {
    const requestsResult = await supabase
      .from("marketing_requests")
      .select("*")
      .in("id", batch)
      .in("status", [...MARKETING_HISTORY_STATUSES]);
    if (requestsResult.error) throw requestsResult.error;
    requestRows.push(...((requestsResult.data ?? []) as MarketingRequestDbRow[]));
  }
  const requests = requestRows.map(mapRequest);
  if (requests.length === 0) return { rows: [], scope, truncated: false };

  const requestIds = requests.map((request) => request.id);
  const stepsByRequestId = new Map<string, MarketingRequestApprovalStep[]>();
  for (const batch of chunk(requestIds)) {
    const stepsResult = await supabase
      .from("marketing_request_approval_steps")
      .select("*")
      .in("request_id", batch)
      .eq("is_cc", false);
    if (stepsResult.error) throw stepsResult.error;
    for (const row of (stepsResult.data ?? []) as MarketingRequestApprovalStepDbRow[]) {
      const step = mapApprovalStep(row);
      stepsByRequestId.set(step.requestId, [...(stepsByRequestId.get(step.requestId) ?? []), step]);
    }
  }

  const customerIds = Array.from(new Set(requests.map((request) => request.customerId)));
  const typeIds = Array.from(new Set(requests.map((request) => request.requestTypeId)));
  const [customersResult, typesResult, employeeRows] = await Promise.all([
    customerIds.length > 0
      ? supabase.from("marketing_customers").select("id, display_name, crm_list_status").in("id", customerIds)
      : Promise.resolve({ data: [], error: null }),
    typeIds.length > 0
      ? supabase.from("marketing_request_types").select("id, name").in("id", typeIds)
      : Promise.resolve({ data: [], error: null }),
    loadEmployeeDirectoryRows(),
  ]);
  if (customersResult.error) throw customersResult.error;
  if (typesResult.error) throw typesResult.error;
  const customerNameById = new Map(((customersResult.data ?? []) as Array<{ display_name?: string | null; id: string }>)
    .map((row) => [row.id, cleanText(row.display_name) ?? row.id] as const));
  const customerCrmFlagById = new Map(((customersResult.data ?? []) as Array<{ id: string; crm_list_status?: string | null }>)
    .map((row) => [row.id, crmListFlag(row.crm_list_status)] as const));
  const typeNameById = new Map(((typesResult.data ?? []) as Array<{ id: number | string; name?: string | null }>)
    .map((row) => [Number(row.id), cleanText(row.name) ?? "Marketing request"] as const));

  const actorKeySet = new Set(actorHrKeys.map((key) => key.trim().toLowerCase()));
  const isActor = (hrId: string | null | undefined) =>
    Boolean(hrId) && actorKeySet.has(String(hrId).trim().toLowerCase());

  const rows: MarketingApproverHistoryRow[] = [];
  for (const request of requests) {
    const chain = [...(stepsByRequestId.get(request.id) ?? [])].sort((left, right) => left.sequence - right.sequence);
    // The viewer's own rung: the one they DECIDED if there is one, otherwise the one that was
    // assigned to them. A step decided by somebody else after re-assignment is not theirs to claim.
    const myStep =
      chain.find((step) => isActor(step.decisionByHrId)) ??
      chain.find((step) => isActor(step.assignedHrId)) ??
      null;
    // What ended it: the rung carrying the LATEST decision instant. Taking the highest sequence
    // instead would be wrong on every rejection — a no at rung 2 is the final word even though
    // rungs 3-5 exist, and those rungs are skipped, which records no decision instant at all.
    const finalStep = chain
      .filter((step) => Boolean(step.decisionAt))
      .reduce<MarketingRequestApprovalStep | null>((latest, step) => {
        if (!latest) return step;
        return Date.parse(step.decisionAt ?? "") > Date.parse(latest.decisionAt ?? "") ? step : latest;
      }, null);
    // Fall back to the request's own lifecycle stamps before giving up: a legacy imported request
    // carries a status and a date but may have no decided step at all.
    const decidedAt =
      finalStep?.decisionAt ??
      request.rejectedAt ??
      request.returnedAt ??
      request.approvedAt ??
      request.closedAt ??
      null;
    const outcome = marketingHistoryOutcome(request.status);
    const isMyRequest = isActor(request.requesterHrId);

    rows.push({
      // Forced false, exactly as the live oversight rows do it. The request has left the chain so
      // the API would refuse a decision anyway — this makes the UI unable to ask.
      allowReject: false,
      allowReturn: false,
      approvalHistory: buildMarketingApproverChain(chain, employeeRows, myStep?.id ?? null),
      currentStepName: finalStep?.stepName ?? MARKETING_HISTORY_OUTCOME_LABEL[outcome],
      customerName: customerNameById.get(request.customerId) ?? request.customerId,
      customerCrmListFlag: customerCrmFlagById.get(request.customerId) ?? null,
      decidedAt,
      decisionLabels: normalizeMarketingDecisionLabels(null),
      estimatedCost: request.estimatedCost,
      finalApproverName: finalStep
        ? employeeNameByHrId(employeeRows, finalStep.decisionByHrId ?? finalStep.assignedHrId)
        : null,
      finalDecisionNote: finalStep ? cleanText(finalStep.decisionNote) : null,
      finalStepName: finalStep?.stepName ?? null,
      id: request.id,
      isMyRequest,
      myDecision:
        myStep && myStep.decisionAt
          ? {
              at: myStep.decisionAt,
              note: cleanText(myStep.decisionNote),
              status: myStep.status,
              stepName: myStep.stepName,
            }
          : null,
      outcome,
      outcomeLabel: MARKETING_HISTORY_OUTCOME_LABEL[outcome],
      payDate: request.payDate,
      requestCode: request.requestCode,
      requesterHrId: request.requesterHrId,
      requesterName: employeeNameByHrId(employeeRows, request.requesterHrId),
      requesterRole: employeeRoleByHrId(employeeRows, request.requesterHrId),
      requestType: typeNameById.get(request.requestTypeId) ?? "Marketing request",
      status: request.status,
      stepSequence: finalStep?.sequence ?? chain.length,
      submittedAt: request.submittedAt,
      totalGatingSteps: chain.length,
      viaOversight: myStep === null && !isMyRequest,
    });
  }

  // Newest decision first — "what did we just decide" is the question this tab is opened with.
  rows.sort((left, right) => Date.parse(right.decidedAt ?? "0") - Date.parse(left.decidedAt ?? "0"));
  const truncated = rows.length > MARKETING_HISTORY_ROW_LIMIT;
  return { rows: truncated ? rows.slice(0, MARKETING_HISTORY_ROW_LIMIT) : rows, scope, truncated };
}

// ── Sidebar pending-count badge ──────────────────────────────────────────────
// Marketing is deliberately excluded from the consolidated approvals hub (see the comment in
// src/lib/action-center/service.ts) — it keeps its own dedicated inbox — so "approvals-hub-pending"
// can never count a marketing item. This is the marketing equivalent of getVacationAwaitingBadge /
// getPlanAwaitingBadge in src/lib/approvals-hub/service.ts, feeding the same NavBadge pump.

/** The subset of a gating approval step the badge needs — nothing that would identify a request. */
export type MarketingApproverBadgeStep = {
  createdAt: string | null;
  /** From the step's `step_opened` event; preferred over the row stamps. See marketingWaitingSince. */
  openedAt?: string | null;
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
 * Overdue: each step's own `marketing_workflow_steps.default_sla_days`, measured from when the rung
 * was opened — the same "waiting since" clock the daily SLA scan uses (see marketingWaitingSince,
 * and note it is deliberately NOT the row's `updated_at`). A step whose SLA is null contributes NO
 * overdue signal rather than being treated as 0 days, which would make every request instantly
 * overdue.
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
    const daysWaiting = marketingDaysWaiting(marketingWaitingSince(step), input.now);
    if (daysWaiting === null) return false;
    return slaTone(daysWaiting, slaDays) === "overdue";
  });
  return { count: counted.length, overdue };
}

/**
 * Sidebar badge for the Marketing Approval Inbox: how many marketing requests are stopped at this
 * person's own gating step — or, for a Super Admin, at ANYONE's.
 *
 * Scoped by `assigned_hr_id` for every approver, so they can only ever count their own rung. The one
 * exception is the oversight viewer (canViewMarketingOversightQueue), for whom the filter is dropped
 * and the badge counts every open gating step in the company.
 *
 * Owner instruction, 2026-08-18, made knowingly against the objection that a badge counting other
 * people's work sits permanently lit. The reason it is nonetheless coherent: the badge must never
 * show a number the inbox cannot explain, and since #2187 the inbox CAN explain it — a Super Admin's
 * "Everything in approval" section lists exactly the steps counted here. The two move together, so
 * a future change to one is wrong unless it changes the other.
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

  const gatingQuery = supabase
    .from("marketing_request_approval_steps")
    .select("request_id, step_code, sequence, workflow_step_id, created_at, updated_at")
    .eq("status", "current")
    .eq("is_cc", false);
  // Same gate as the inbox's oversight section, so the badge and that section always agree.
  const gatingResult = await (canViewMarketingOversightQueue(access)
    ? gatingQuery
    : gatingQuery.in("assigned_hr_id", actorHrKeys));
  if (gatingResult.error) throw gatingResult.error;
  const gatingRows = (gatingResult.data ?? []) as Array<{
    created_at?: string | null;
    request_id: string;
    sequence?: number | string | null;
    step_code: string;
    updated_at?: string | null;
    workflow_step_id?: number | string | null;
  }>;
  if (gatingRows.length === 0) return { count: 0, overdue: false };

  // Opened-at drives the overdue colour; a failure here must not suppress the COUNT, which is the
  // point of the badge — so it degrades to the row stamps rather than throwing, exactly as the SLA
  // lookup below does.
  let openedAt = new Map<string, string>();
  try {
    openedAt = await loadMarketingStepOpenedAt(
      supabase,
      gatingRows.map((row) => row.request_id),
    );
  } catch (error) {
    logWarning("Marketing approver badge could not load step openings — count kept, clock falls back", {
      context: { message: error instanceof Error ? error.message : String(error) },
      labels: { event: "marketing_approver_badge_step_opened_unavailable" },
    });
  }

  const gatingSteps: MarketingApproverBadgeStep[] = gatingRows.map((row) => ({
    createdAt: row.created_at ?? null,
    openedAt: openedAt.get(marketingStepKey(row.request_id, Number(row.sequence))) ?? null,
    requestId: row.request_id,
    stepCode: row.step_code,
    updatedAt: row.updated_at ?? null,
    workflowStepId:
      row.workflow_step_id === null || row.workflow_step_id === undefined ? null : Number(row.workflow_step_id),
  }));

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
      () => ({ advisoryRows: [], oversightRows: [], rows: [], upcomingRows: [] }) as MarketingApproverInboxWorkspace,
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
          isSamePerson(step.assignedHrId, actorHrId),
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

  // The mail goes out AFTER the reply (afterResponse, 2026-10-23 slow-buttons audit): the comment is
  // stored by now and `notifyAdvisoryComment` already swallows its own failures, so the reviewer who
  // pressed Post never waits for it. Outside a request (the unit suite, a script) it is awaited, as before.
  await afterResponse("marketing_notice:advisory_comment", () =>
    notifyAdvisoryComment({
      actorHrId,
      comment: text,
      requestId: cleanRequestId,
      steps,
    }),
  );

  return { requestId: cleanRequestId };
}

/**
 * Email an advisory comment out, To the requester and CC the reviewer who wrote it.
 *
 * An advisory comment is a CC reviewer's opinion recorded against a request they cannot block -
 * which, until 2026-09-03, was written into `decision_note` and shown to nobody unless somebody
 * reopened the request. The requester is the thread's owner (`requester_hr_id`), and everyone who
 * has already decided a step on the request is a participant, so a running discussion keeps its
 * audience rather than resetting to two people each time.
 *
 * Best-effort: the comment is already stored, and a mail failure must not undo it.
 *
 * DELIBERATELY NO `messageKey`. Every other conversation in the system inserts a new row per
 * message, so the row's own id makes a stable per-message key (see `conversationMessageIdempotencyKey`
 * in conversations/notify.ts). This thread does not: `postMarketingAdvisoryComment` UPDATES the same
 * `marketing_request_approval_steps` row's `decision_note`/`decision_at` every time the same CC
 * reviewer comments on the same step — there is no append-only history and `ccStep.id` never
 * changes between two advisory comments on that step. So a SECOND advisory comment on one step still
 * collapses onto the first one's notification event and HR/the requester are not re-emailed — the
 * same bug as the other three threads, left unfixed here on purpose rather than "fixed" with a key
 * that cannot be trusted. `decision_at` (freshly generated per call) looked like a candidate but was
 * rejected: it varies on every call INCLUDING a retry of the identical submission, which would
 * re-email on a network retry instead of deduplicating it - the exact failure mode this module's own
 * messageKey doc warns against. The real fix is a schema change - an append-only
 * marketing_request_advisory_comments table mirroring ats_candidate_comments / deductions_comments /
 * employee_plan_comments - which is a product decision (today's design is "one evolving note per
 * reviewer", not a growing thread) and needs the owner's sign-off, not a notification-layer patch.
 */
async function notifyAdvisoryComment(input: {
  actorHrId: string;
  comment: string;
  requestId: string;
  steps: Array<{ assignedHrId: string | null; decisionAt: string | null }>;
}): Promise<void> {
  try {
    const supabase = getSupabaseAdmin();
    const { data } = await supabase
      .from("marketing_requests")
      .select("id,request_code,requester_hr_id,manager_hr_id")
      .eq("id", input.requestId)
      .maybeSingle();
    const request = data as {
      manager_hr_id?: string | null;
      request_code?: string | null;
      requester_hr_id?: string | null;
    } | null;
    if (!request?.requester_hr_id) return;

    const participantHrIds = [
      request.requester_hr_id,
      request.manager_hr_id ?? null,
      // Everyone who has actually acted on the request. An assignee who has not decided yet is not
      // a participant in the conversation, only a name on a future step.
      ...input.steps.filter((step) => step.decisionAt).map((step) => step.assignedHrId),
    ];

    await notifyConversationMessage({
      // The shared helper, not a portal path: a notification actionUrl is stored once for every
      // recipient, and the portal shell redirects admin-shell approvers to /overview.
      actionUrl: marketingActionUrl(input.requestId),
      authorHrId: input.actorHrId,
      authorName: null,
      body: input.comment,
      eventType: "marketing_request_comment",
      metadata: { requestId: input.requestId },
      module: "marketing_requests",
      participantHrIds,
      recordId: input.requestId,
      submitterHrId: request.requester_hr_id,
      subjectLabel: String(request.request_code ?? "").trim() || input.requestId,
      threadLabel: "marketing request",
    });
  } catch (error) {
    logError("Marketing advisory comment failed to notify the thread", {
      labels: { event: "marketing_advisory_comment_notify_failed", requestId: input.requestId },
      error,
    });
  }
}

/**
 * The marketing-request CONVERSATION — a running thread that is open at ANY status.
 *
 * Owner rule, 2026-09-22: the conversation must be available even after a request is rejected /
 * approved / closed / cancelled, so a requester can ask why it was turned down and a reviewer can
 * answer, and everyone on the request is emailed / Telegrammed / pinged for every message.
 *
 * Distinct from `postMarketingAdvisoryComment` above: that is a CC reviewer's on-record note into
 * the approval TIMELINE and is writable only while their step is the active one. This thread has no
 * status gate and no step tie — its authorisation is simply "can you see the request", the exact
 * rule `getMarketingRequestDetail` uses.
 */
/**
 * The one visibility gate for a marketing request: the requester, anyone who can see it under
 * `canSeeMarketingRequest`, an assigned approver on any rung (alias-aware, so a shared identity still
 * matches), or a system-scope caller. Shared by the request-detail loader and the conversation
 * loader so both decide sight exactly the same way. Throws `Forbidden:` otherwise.
 */
function assertCanViewMarketingRequest(
  access: AccessContext,
  requestRow: MarketingRequestDbRow,
  employeeRows: Awaited<ReturnType<typeof loadEmployeeDirectoryRows>>,
  steps: ReturnType<typeof mapApprovalStep>[],
): void {
  const actorHrId = normalizeHrId(access.hrId);
  const isAssignedApprover = actorHrId
    ? steps.some((step) => isSamePerson(step.assignedHrId, access.hrId))
    : false;
  if (!canSeeMarketingRequest(access, requestRow, employeeRows) && !isAssignedApprover && access.scope !== "system") {
    throw forbiddenError("Forbidden: you cannot view this marketing request.");
  }
}

async function loadMarketingRequestForConversation(
  access: AccessContext,
  requestId: string,
): Promise<{ requestRow: MarketingRequestDbRow; steps: ReturnType<typeof mapApprovalStep>[] }> {
  const cleanRequestId = cleanText(requestId);
  if (!cleanRequestId) throw validationError("Marketing request ID is required.");
  if (!isUuid(cleanRequestId)) {
    throw notFoundError("Marketing request was not found.", "marketing_request_not_found");
  }
  const supabase = getSupabaseAdmin();
  const [employeeRows, requestResult, stepsResult] = await Promise.all([
    loadEmployeeDirectoryRows(),
    supabase.from("marketing_requests").select("*").eq("id", cleanRequestId).maybeSingle(),
    supabase
      .from("marketing_request_approval_steps")
      .select("*")
      .eq("request_id", cleanRequestId)
      .order("sequence", { ascending: true }),
  ]);
  if (requestResult.error) throw requestResult.error;
  if (!requestResult.data) throw notFoundError("Marketing request was not found.", "marketing_request_not_found");
  if (stepsResult.error) throw stepsResult.error;
  const requestRow = requestResult.data as MarketingRequestDbRow;
  const steps = ((stepsResult.data ?? []) as MarketingRequestApprovalStepDbRow[]).map(mapApprovalStep);

  assertCanViewMarketingRequest(access, requestRow, employeeRows, steps);
  return { requestRow, steps };
}

/** Every message on a marketing request's conversation, oldest first. */
export async function listMarketingRequestConversation(
  access: AccessContext,
  requestId: string,
): Promise<{ comments: RecordConversationComment[]; schemaReady: boolean }> {
  const { requestRow } = await loadMarketingRequestForConversation(access, requestId);
  return listRecordConversation("marketing_requests", String(requestRow.id));
}

/** Post one message to a marketing request's conversation, then fan it out to everyone on it. */
export async function postMarketingRequestConversationComment(
  access: AccessContext,
  requestId: string,
  body: string,
): Promise<RecordConversationComment> {
  const { requestRow, steps } = await loadMarketingRequestForConversation(access, requestId);
  const actorHrId = normalizeHrId(access.hrId);
  if (!actorHrId) throw forbiddenError("Forbidden: no HR_ID on this session.");

  const employeeRows = await loadEmployeeDirectoryRows();
  const authorName = employeeNameByHrId(employeeRows, access.hrId) || null;
  const comment = await insertRecordConversationComment({
    authorHrId: access.hrId ?? null,
    authorName,
    authorRole: access.role ?? null,
    body,
    module: "marketing_requests",
    recordId: String(requestRow.id),
  });

  // The fan-out goes out AFTER the reply (afterResponse, 2026-10-23 slow-buttons audit): the message is
  // stored by now and `notifyMarketingRequestConversation` already swallows its own failures, so the
  // sender never waits for everyone on the request to be told. Outside a request it is awaited, as before.
  await afterResponse("marketing_notice:conversation_message", () =>
    notifyMarketingRequestConversation({ comment, requestRow, steps }),
  );
  return comment;
}

/**
 * Fan a marketing conversation message out To the requester and CC everyone else on the request.
 *
 * Participants: the requester (the thread's owner), the manager, everyone who has already decided a
 * step (an assignee who has not acted yet is a future name, not a participant), and everyone who has
 * already posted in this thread — so a running discussion keeps its audience. Best-effort: the
 * message is already stored and a delivery failure must not undo it.
 */
async function notifyMarketingRequestConversation(input: {
  comment: RecordConversationComment;
  requestRow: MarketingRequestDbRow;
  steps: ReturnType<typeof mapApprovalStep>[];
}): Promise<void> {
  try {
    const request = input.requestRow;
    if (!request.requester_hr_id) return;
    const priorAuthors = await listRecordConversationAuthors("marketing_requests", String(request.id));
    const participantHrIds = [
      request.requester_hr_id,
      request.manager_hr_id ?? null,
      ...input.steps.filter((step) => step.decisionAt).map((step) => step.assignedHrId),
      ...priorAuthors,
    ];

    await notifyConversationMessage({
      actionUrl: marketingActionUrl(String(request.id)),
      authorHrId: input.comment.authorHrId,
      authorName: input.comment.authorName,
      body: input.comment.body,
      eventType: "marketing_request_comment",
      messageKey: input.comment.id,
      metadata: { requestId: String(request.id) },
      module: "marketing_requests",
      participantHrIds,
      recordId: String(request.id),
      submitterHrId: request.requester_hr_id,
      subjectLabel: String(request.request_code ?? "").trim() || String(request.id),
      threadLabel: "marketing request",
    });
  } catch (error) {
    logError("Marketing request conversation failed to notify the thread", {
      labels: { event: "marketing_request_conversation_notify_failed", requestId: String(input.requestRow.id) },
      error,
    });
  }
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
  // A malformed id is NOT FOUND, not a fault. `id` is a uuid column, and Postgres answers a
  // non-uuid with 22P02 from the WHERE clause rather than with no rows — which leaves here as a
  // 500 telling the caller the system is broken, when the honest answer is that their link is
  // wrong. Same error as an absent row below, so the two stay indistinguishable.
  if (!isUuid(cleanRequestId)) {
    throw notFoundError("Marketing request was not found.", "marketing_request_not_found");
  }

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

  assertCanViewMarketingRequest(access, requestRow, employeeRows, steps);
  const actorHrId = normalizeHrId(access.hrId);

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
          isSamePerson(step.assignedHrId, access.hrId),
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
    offsets: await loadOffsetsByRequestId([requestId]),
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

/**
 * Move every child row of one venue onto another, one row at a time.
 *
 * Row by row rather than a single bulk `update ... where pharmacy_id = loser` on purpose: three
 * partial unique indexes make collisions ordinary here rather than exceptional, and one bulk
 * statement would abort every other move the moment a single row hit one.
 *
 * A collision (Postgres 23505) means the survivor ALREADY holds the equivalent child — which is
 * precisely the end state a merge is reaching for, so it is counted and stepped over, not thrown.
 * The colliding row stays on the losing venue, which is deactivated moments later, so it survives
 * as history and simply stops being reachable.
 */
export async function moveMarketingVenueChildren(
  supabase: SupabaseClient,
  table: string,
  column: string,
  loserId: string,
  survivorId: string,
): Promise<{ alreadyOnSurvivor: number; moved: number }> {
  const { data, error } = await supabase.from(table).select("id").eq(column, loserId);
  if (error) throw error;

  let moved = 0;
  let alreadyOnSurvivor = 0;
  for (const row of (data ?? []) as Array<{ id: string }>) {
    const { error: moveError } = await supabase
      .from(table)
      .update({ [column]: survivorId })
      .eq("id", row.id);
    if (!moveError) {
      moved += 1;
      continue;
    }
    if (String((moveError as { code?: string }).code) !== "23505") throw moveError;
    alreadyOnSurvivor += 1;
  }

  return { alreadyOnSurvivor, moved };
}

/**
 * Every venue a merge could name, for the picker on the Customer Database screen.
 *
 * Reads `marketing_pharmacies` directly rather than reusing the Customer Database rows, which are
 * customer LINKS: a duplicate venue created and never linked to anybody has no link row, so it
 * would be missing from exactly the list that exists to retire it. Inactive venues are included
 * for the same reason — the module deactivates a duplicate as its way of hiding one, and those
 * rows are the merge backlog, not noise.
 *
 * Already-merged venues stay in the list so the caller can SEE that a code resolves to a
 * tombstone; `mergedIntoPharmacyId` is what the UI labels them with, and the service refuses them
 * on either side of a merge regardless.
 */
export async function listMarketingVenueMergeCandidates(
  access: AccessContext,
): Promise<MarketingVenueMergeCandidate[]> {
  assertMarketingControlAccess(access);

  const supabase = getSupabaseAdmin();
  const result = await supabase
    .from("marketing_pharmacies")
    .select("*")
    .order("display_name", { ascending: true })
    .limit(MARKETING_WORKSPACE_SAFETY_LIMIT);
  if (result.error) throw result.error;

  return ((result.data ?? []) as MarketingPharmacyDbRow[]).map((row) => {
    const venue = mapMarketingPharmacy(row);
    return {
      active: venue.active,
      area: venue.extractedAreaName,
      displayName: venue.displayName,
      governorate: venue.extractedGovernorateName,
      id: venue.id,
      mergedIntoPharmacyId: venue.mergedIntoPharmacyId,
      pharmacyCode: venue.pharmacyCode,
      venueType: venue.venueType,
    };
  });
}

/**
 * Fold a duplicate marketing venue into the one that survives.
 *
 * Marketing had no way to express this until 2026-08-23. The only available move was to deactivate
 * the duplicate and write a sentence into `validation_notes`, which is not navigable: a
 * `pharmacy_code` quoted in an older report resolved to a dead row with nothing saying where the
 * live one went, and any pair of same-named rows invited the same investigation over again.
 *
 * Identity is the caller's judgement and the `reason` is the record of it. This function refuses
 * the structurally impossible (a venue merged into itself, into a venue that is itself a merged
 * duplicate, or twice) and nothing else — it deliberately does NOT guess identity from a similar
 * name, which is typed by hand in two languages and proves nothing.
 */
export async function mergeMarketingVenue(
  access: AccessContext,
  input: { loserId: string; reason: string; survivorId: string },
): Promise<MarketingVenueMergeResult> {
  assertMarketingControlAccess(access);

  const survivorId = String(input.survivorId ?? "").trim();
  const loserId = String(input.loserId ?? "").trim();
  const reason = String(input.reason ?? "").trim();

  if (!survivorId || !loserId) throw validationError("Both the surviving venue and the duplicate must be named.");
  // Also enforced by marketing_pharmacies_merged_not_self_check, but refused here so the caller
  // gets a sentence rather than a constraint name.
  if (survivorId === loserId) throw validationError("A venue cannot be merged into itself.");
  if (!reason) {
    throw validationError("A merge needs a written reason — it is the only record of why two rows were judged one place.");
  }

  const supabase = getSupabaseAdmin();
  const venuesResult = await supabase.from("marketing_pharmacies").select("*").in("id", [survivorId, loserId]);
  if (venuesResult.error) throw venuesResult.error;

  const venues = new Map(
    ((venuesResult.data ?? []) as MarketingPharmacyDbRow[]).map((row) => [row.id, mapMarketingPharmacy(row)]),
  );
  const survivor = venues.get(survivorId);
  const loser = venues.get(loserId);
  if (!survivor) throw notFoundError("The surviving venue does not exist.");
  if (!loser) throw notFoundError("The duplicate venue does not exist.");
  if (loser.mergedIntoPharmacyId) {
    throw conflictError(`"${loser.displayName}" was already merged into another venue.`);
  }
  // Merging into a tombstone would build a chain that every reader then has to walk.
  if (survivor.mergedIntoPharmacyId) {
    throw conflictError(
      `"${survivor.displayName}" is itself a merged duplicate — merge into the venue that survived instead.`,
    );
  }

  const customerLinks = await moveMarketingVenueChildren(
    supabase, "marketing_customer_pharmacies", "pharmacy_id", loserId, survivorId,
  );
  const requestTargets = await moveMarketingVenueChildren(
    supabase, "marketing_request_pharmacies", "pharmacy_id", loserId, survivorId,
  );
  const codes = await moveMarketingVenueChildren(
    supabase, "marketing_pharmacy_distributor_codes", "pharmacy_id", loserId, survivorId,
  );
  const transfers = await moveMarketingVenueChildren(
    supabase, "marketing_customer_direct_order_transfers", "marketing_pharmacy_id", loserId, survivorId,
  );

  const mergedAt = new Date().toISOString();
  const actorHrId = access.hrId ?? access.loginId ?? null;
  const markResult = await supabase
    .from("marketing_pharmacies")
    .update({
      // Deactivating is what actually removes it from every screen: the Customer Database, the
      // target picker and the master matcher all filter on `active` or on an active link. A
      // merged-but-active row would be a duplicate the module still offers, which is how second
      // copies get created in the first place.
      active: false,
      merged_at: mergedAt,
      merged_by_hr_id: hrIdForStorage(actorHrId),
      merged_into_pharmacy_id: survivorId,
      updated_at: mergedAt,
    })
    .eq("id", loserId)
    // Idempotence guard, matching Direct Orders: if a parallel session merged it a moment ago,
    // this updates nothing rather than overwriting their survivor with ours.
    .is("merged_into_pharmacy_id", null);
  if (markResult.error) throw markResult.error;

  const result: MarketingVenueMergeResult = {
    alreadyOnSurvivor:
      customerLinks.alreadyOnSurvivor + requestTargets.alreadyOnSurvivor
      + codes.alreadyOnSurvivor + transfers.alreadyOnSurvivor,
    codesMoved: codes.moved,
    customerLinksMoved: customerLinks.moved,
    loserId,
    requestTargetsMoved: requestTargets.moved,
    survivorId,
    transfersMoved: transfers.moved,
  };

  // Required, not best-effort: a structural change that retires one physical place in favour of
  // another must not be able to happen silently.
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityId: loserId,
    entityType: "marketing_pharmacy",
    newValues: { active: false, mergedIntoPharmacyId: survivorId },
    oldValues: { active: loser.active, mergedIntoPharmacyId: null },
    summary:
      `Marketing venue "${loser.displayName}" (${loser.pharmacyCode}) merged into `
      + `"${survivor.displayName}" (${survivor.pharmacyCode}). Moved ${result.customerLinksMoved} customer link(s), `
      + `${result.requestTargetsMoved} request target(s), ${result.codesMoved} distributor code(s), `
      + `${result.transfersMoved} transfer(s); ${result.alreadyOnSurvivor} already on the survivor. `
      + `Reason: ${reason}`,
  });

  bumpCustomer360Cache("marketing venue merged");
  return result;
}
