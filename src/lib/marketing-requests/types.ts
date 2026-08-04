export type MarketingCustomerType =
  | "doctor"
  | "hospital"
  | "clinic"
  | "account"
  | "other";

export type MarketingEvidenceStatus = "missing" | "pending" | "complete";

export type MarketingValidationStatus =
  | "pending"
  | "system_validated"
  | "sfe_validated"
  | "rejected";

export type MarketingPharmacyCodeReferenceStatus =
  | "pending"
  | "matched"
  | "ambiguous"
  | "not_found"
  | "manual_approved"
  | "rejected";

export type MarketingRequestStatus =
  | "draft"
  | "pending_validation"
  | "pending_approval"
  | "returned"
  | "rejected"
  | "approved"
  | "active"
  | "roi_tracking"
  | "closed"
  | "finance_hold"
  | "archived";

export type MarketingRoiStatus =
  | "not_calculated"
  | "covers_required"
  | "under_target";

export type MarketingWorkflowApprovalScope =
  | "direct_manager"
  | "role"
  | "finance"
  | "final";

export type MarketingStepKind = "managerial_chain" | "role" | "finance";

export type MarketingDecisionLabels = {
  approve: string;
  reject: string;
  return: string;
};

export type MarketingApprovalStepStatus =
  | "pending"
  | "current"
  | "approved"
  | "rejected"
  | "returned"
  | "skipped";

export type MarketingRequestPharmacyTrackingStatus =
  | "pending_validation"
  | "active"
  | "inactive";

export type MarketingInvoiceStatus =
  | "not_required"
  | "pending"
  | "submitted"
  | "cleared"
  | "overdue"
  | "hold";

export type MarketingEvidenceEntityType = "customer" | "pharmacy";
export type MarketingEvidenceType = "location_photo" | "sign_photo" | "other";

export type MarketingRequestType = {
  active: boolean;
  code: string;
  createdAt: string;
  description: string | null;
  id: number;
  name: string;
  requiresDescription: boolean;
  sortOrder: number;
  updatedAt: string;
};

export type MarketingWorkflowStep = {
  active: boolean;
  allowReject: boolean;
  allowReturn: boolean;
  approvalScope: MarketingWorkflowApprovalScope;
  assignedRole: string;
  ccRoles: string[];
  chainTargetRole: string | null;
  createdAt: string;
  decisionLabels: MarketingDecisionLabels;
  defaultSlaDays: number | null;
  id: number;
  required: boolean;
  sequence: number;
  stepCode: string;
  stepKind: MarketingStepKind;
  stepName: string;
  terminalStatus: MarketingRequestStatus | null;
  updatedAt: string;
};

export type MarketingControlSettingGroup = "roi" | "finance" | "validation";

export type MarketingControlSetting = {
  adminOnly: boolean;
  createdAt: string;
  key: string;
  label: string;
  group: MarketingControlSettingGroup;
  updatedAt: string;
  updatedByHrId: string | null;
  value: Record<string, unknown>;
};

export type MarketingControlWorkspace = {
  canManageValidationRules: boolean;
  requestTypes: MarketingRequestType[];
  settings: MarketingControlSetting[];
  workflowSteps: MarketingWorkflowStep[];
};

export type MarketingDistributor = {
  active: boolean;
  createdAt: string;
  displayName: string;
  distributorCode: string;
  id: number;
  normalizedName: string;
  sourceName: string | null;
  updatedAt: string;
};

export type MarketingProduct = {
  active: boolean;
  createdAt: string;
  factoryPrice: number;
  family: string | null;
  id: number;
  line: string | null;
  lineId: number | null;
  normalizedName: string;
  productCode: string;
  productName: string;
  sourceCompany: string | null;
  sourceFile: string | null;
  updatedAt: string;
};

export type MarketingPharmacyCodeReference = {
  createdAt: string;
  distributorId: number | null;
  id: number;
  importBatchId: string | null;
  normalizedDistributorName: string;
  rawArea: string | null;
  rawDistributorName: string;
  rawPharmacyAddress: string | null;
  rawPharmacyCode: string;
  rawRegion: string | null;
  sourceFile: string;
  sourceRow: number;
};

export type MarketingCapturedLocation = {
  capturedAccuracyMeters: number | null;
  capturedAddress: string | null;
  capturedAt: string | null;
  capturedLatitude: number | null;
  capturedLongitude: number | null;
};

export type MarketingEvidenceCapture = {
  evidenceHasTimestamp: boolean;
  evidencePhotoCapturedAt: string | null;
  evidencePhotoName: string | null;
};

export type MarketingCustomer = MarketingCapturedLocation & MarketingEvidenceCapture & {
  active: boolean;
  areaId: number | null;
  createdAt: string;
  createdByHrId: string | null;
  customerCode: string;
  customerType: MarketingCustomerType;
  displayName: string;
  evidenceStatus: MarketingEvidenceStatus;
  extractedAreaName: string | null;
  extractedGovernorateName: string | null;
  id: string;
  lineId: number | null;
  managerHrId: string | null;
  normalizedName: string;
  otherTypeDescription: string | null;
  ownerHrId: string | null;
  regionName: string | null;
  updatedAt: string;
  updatedByHrId: string | null;
  validatedAt: string | null;
  validatedByHrId: string | null;
  validationNotes: string | null;
  validationStatus: MarketingValidationStatus;
};

export type MarketingCustomerContact = {
  active: boolean;
  contactCode: string;
  contactName: string;
  createdAt: string;
  createdByHrId: string | null;
  crmCode: string | null;
  customerId: string;
  id: string;
  mobileNumber: string | null;
  notes: string | null;
  specialty: string | null;
  updatedAt: string;
};

export type MarketingPharmacy = MarketingCapturedLocation & MarketingEvidenceCapture & {
  active: boolean;
  areaId: number | null;
  createdAt: string;
  createdByHrId: string | null;
  displayName: string;
  evidenceStatus: MarketingEvidenceStatus;
  extractedAreaName: string | null;
  extractedGovernorateName: string | null;
  id: string;
  lineId: number | null;
  managerHrId: string | null;
  normalizedName: string;
  ownerHrId: string | null;
  pharmacyCode: string;
  regionName: string | null;
  updatedAt: string;
  updatedByHrId: string | null;
  validatedAt: string | null;
  validatedByHrId: string | null;
  validationNotes: string | null;
  validationStatus: MarketingValidationStatus;
};

export type MarketingPharmacyDistributorCode = {
  active: boolean;
  createdAt: string;
  createdByHrId: string | null;
  distributorId: number;
  distributorPharmacyCode: string;
  id: string;
  normalizedPharmacyCode: string;
  pharmacyId: string;
  referenceId: number | null;
  referenceMatchCount: number;
  referenceStatus: MarketingPharmacyCodeReferenceStatus;
  updatedAt: string;
  validatedAt: string | null;
  validatedByHrId: string | null;
  validationNotes: string | null;
};

/** One selectable target pharmacy, already resolved to what the picker needs to show. */
export type MarketingRequestPharmacyOption = {
  /** The value the form submits — attribution is keyed on this, not on the pharmacy id. */
  distributorCodeId: string;
  pharmacyName: string;
  pharmacyCode: string;
  distributorName: string;
  /** Lets the form warn about an unverified code before submitting, not after being refused. */
  referenceStatus: MarketingPharmacyCodeReferenceStatus;
};

export type MarketingCustomerPharmacy = {
  active: boolean;
  createdAt: string;
  createdByHrId: string | null;
  customerId: string;
  distributorCodeId: string;
  id: string;
  pharmacyId: string;
  updatedAt: string;
  updatedByHrId: string | null;
  validationNotes: string | null;
  validationStatus: MarketingValidationStatus;
};

/**
 * The speciality options offered on a validated customer.
 *
 * Deliberately a fixed list rather than the raw `speciality` text iReports360 syncs onto
 * `crm_visits`: that vendor field is free text with inconsistent casing and near-duplicates, and
 * feeding it into a picker would reproduce the mess it already contains. A closed list keeps the
 * spelling stable so these can ever be grouped or counted. Server-validated in
 * `normalizeMarketingValidationInput` — a value outside this list is rejected, so the dropdown is
 * a real constraint and not just a UI convenience.
 */
export const MARKETING_CUSTOMER_SPECIALITIES = [
  "General Practitioner",
  "Internal Medicine",
  "Cardiology",
  "Chest",
  "Dermatology",
  "Endocrinology",
  "ENT",
  "Gastroenterology",
  "General Surgery",
  "Nephrology",
  "Neurology",
  "Obstetrics & Gynaecology",
  "Oncology",
  "Ophthalmology",
  "Orthopaedics",
  "Paediatrics",
  "Psychiatry",
  "Rheumatology",
  "Urology",
] as const;

export type MarketingCustomerSpeciality = (typeof MARKETING_CUSTOMER_SPECIALITIES)[number];

export type MarketingValidationCustomerInput = {
  capturedAccuracyMeters?: number | null;
  capturedAddress?: string | null;
  capturedAt?: string | null;
  capturedLatitude?: number | null;
  capturedLongitude?: number | null;
  customerType: MarketingCustomerType;
  displayName: string;
  evidenceHasTimestamp?: boolean;
  evidencePhotoCapturedAt?: string | null;
  /**
   * The captured JPEG itself, as `data:image/jpeg;base64,…`.
   *
   * Until 2026-08-04 the browser sent only `evidencePhotoName` and dropped the bytes, so
   * `evidence_status` could reach 'complete' on a filename alone. The image is now carried to the
   * server, written to the `marketing-evidence` bucket, and indexed in `marketing_evidence_files` —
   * a name arriving WITHOUT this field is refused rather than saved as proof.
   */
  evidencePhotoDataUrl?: string | null;
  evidencePhotoName?: string | null;
  extractedAreaName?: string | null;
  extractedGovernorateName?: string | null;
  mobileNumber?: string | null;
  otherTypeDescription?: string | null;
  regionName?: string | null;
  /** Optional — a hospital or chain account often has no single speciality. */
  speciality?: string | null;
};

export type MarketingValidationInput = {
  /**
   * Super-Admin-only: validate this customer FOR another employee. The records are owned by the
   * named employee (so the customer reaches their marketing request dropdown) while the audit
   * columns keep naming the admin who actually typed it. Rejected with 403 for every other role —
   * see `assertMarketingOnBehalfAccess`. Omit for the normal field-rep flow.
   */
  onBehalfOfHrId?: string | null;
  /**
   * One submission may validate several customers, each carrying ITS OWN pharmacies — two doctors
   * in the same building are not assumed to dispense through the same pharmacy, so the lists never
   * merge. Takes precedence over the single-customer fields below when present.
   */
  customers?: Array<MarketingValidationCustomerInput & {
    pharmacies?: MarketingValidationPharmacyInput[];
  }>;
  /** Legacy single-customer shape. Still accepted so an in-flight offline replay cannot 400. */
  customer?: MarketingValidationCustomerInput;
  distributorCode?: {
    distributorId: number | string;
    distributorPharmacyCode: string;
  };
  pharmacies?: MarketingValidationPharmacyInput[];
  pharmacy?: Omit<MarketingValidationPharmacyInput, "vendorCodes">;
};

export type MarketingValidationPharmacyInput = {
  capturedAccuracyMeters?: number | null;
  capturedAddress?: string | null;
  capturedAt?: string | null;
  capturedLatitude?: number | null;
  capturedLongitude?: number | null;
  displayName: string;
  evidenceHasTimestamp?: boolean;
  evidencePhotoCapturedAt?: string | null;
  /** See `MarketingValidationCustomerInput.evidencePhotoDataUrl`. */
  evidencePhotoDataUrl?: string | null;
  evidencePhotoName?: string | null;
  extractedAreaName?: string | null;
  extractedGovernorateName?: string | null;
  regionName?: string | null;
  vendorCodes: Array<{
    distributorId: number | string;
    distributorPharmacyCode: string;
  }>;
};

export type MarketingValidationLegacyPharmacyInput = {
    capturedAccuracyMeters?: number | null;
    capturedAddress?: string | null;
    capturedAt?: string | null;
    capturedLatitude?: number | null;
    capturedLongitude?: number | null;
    displayName: string;
    evidenceHasTimestamp?: boolean;
  evidencePhotoCapturedAt?: string | null;
  /** See `MarketingValidationCustomerInput.evidencePhotoDataUrl`. */
  evidencePhotoDataUrl?: string | null;
  evidencePhotoName?: string | null;
  extractedAreaName?: string | null;
  extractedGovernorateName?: string | null;
  regionName?: string | null;
};

export type MarketingValidationReportRow = {
  customer: MarketingCustomer;
  distributorCode: MarketingPharmacyDistributorCode;
  distributorName: string;
  id: string;
  pharmacy: MarketingPharmacy;
  validationNotes: string | null;
  validationStatus: MarketingValidationStatus;
};

/** One selectable target in the Super Admin "validate on behalf of" picker. */
export type MarketingOnBehalfEmployee = {
  areaName: string | null;
  hrId: string;
  jobTitle: string | null;
  lineName: string | null;
  name: string;
};

export type MarketingValidationWorkspace = {
  /** True only for Super Admin — drives whether the on-behalf panel renders at all. */
  canValidateOnBehalf: boolean;
  distributors: MarketingDistributor[];
  /** Empty unless `canValidateOnBehalf`; active employees holding a marketing-capable role. */
  onBehalfEmployees: MarketingOnBehalfEmployee[];
  rows: MarketingValidationReportRow[];
  summary: Record<MarketingValidationStatus, number>;
};

export type MarketingCustomerDatabaseRow = {
  createdAt: string;
  customerAddress: string | null;
  customerArea: string | null;
  customerCode: string;
  customerGovernorate: string | null;
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  customerType: MarketingCustomerType;
  customerValidationPhoto: string | null;
  distributorCode: string;
  distributorId: number;
  distributorName: string;
  pharmacyAddress: string | null;
  pharmacyArea: string | null;
  pharmacyCode: string;
  pharmacyDistributorCodeId: string;
  pharmacyGovernorate: string | null;
  pharmacyId: string;
  pharmacyName: string;
  rowId: string;
  validationStatus: MarketingValidationStatus;
  vendorPharmacyCode: string;
};

export type MarketingCustomerDatabaseWorkspace = {
  rows: MarketingCustomerDatabaseRow[];
  summary: {
    customers: number;
    pharmacies: number;
    rows: number;
    vendors: number;
  };
};

/**
 * One row of the company-wide request register (Marketing Manager / SFE Manager / Super Admin).
 *
 * Distinct from MarketingApprovedRequestRow (approved-and-later only) and from the personal
 * workspace, which deliberately narrows company-wide roles to their OWN requests so their Drafts
 * tab is not flooded. This register is the opposite: every request at every status, each carrying
 * where it is stopped and who it is pending with right now.
 */
export type MarketingAllRequestsRow = {
  areaName: string | null;
  /** Null only while a request has no approval chain yet (a draft). */
  currentApproverName: string | null;
  currentStepName: string | null;
  customerName: string;
  estimatedCost: number;
  id: string;
  /**
   * True when the request was raised in Phoenix; false when it came from the legacy spreadsheet
   * import. This is the axis the register splits on — deliberately NOT `status`. In production 217
   * of 218 rows are `xlsx_import`, and only 106 of those are `archived`; the other 111 are
   * approved/rejected imports. Splitting on status alone would leave those 111 legacy rows sitting
   * in the live view. Owner instruction, 2026-08-03: separate the archived from what was submitted
   * on Phoenix.
   */
  isPhoenixSubmission: boolean;
  lineName: string | null;
  origin: string | null;
  payDate: string | null;
  requestCode: string;
  requesterName: string;
  roiCoverageRatio: number | null;
  roiStatus: string | null;
  status: MarketingRequest["status"];
  /** "step 2 of 4" — sequence is null for a request with no chain. */
  stepSequence: number | null;
  submittedAt: string | null;
  totalGatingSteps: number | null;
};

export type MarketingAllRequestsWorkspace = {
  rows: MarketingAllRequestsRow[];
  summary: {
    approved: number;
    /** Everything not raised in Phoenix — the legacy import, whatever its status. */
    imported: number;
    inApproval: number;
    /** Raised in Phoenix, at any status. */
    phoenix: number;
    returned: number;
    total: number;
  };
};

export type MarketingApprovedRequestRow = {
  contactForMoneyTransfer: string;
  customerName: string;
  financeProofFileName: string | null;
  financeProofStoragePath: string | null;
  id: string;
  invoiceFileName: string | null;
  invoiceStoragePath: string | null;
  line: string | null;
  moneyTransferDate: string | null;
  notes: string | null;
  requestCode: string;
  requesterHrId: string;
  status: MarketingRequestStatus;
  sumOfAmount: number;
};

export type MarketingRoiAttributionQuality = "exact_customer" | "brick_fallback" | "mixed" | "no_sales";

export type MarketingRequest = {
  approvedAt: string | null;
  areaId: number | null;
  closedAt: string | null;
  createdAt: string;
  createdByHrId: string | null;
  customerContactId: string | null;
  customerId: string;
  estimatedCost: number;
  executedAt: string | null;
  expectedRoiValue: number;
  id: string;
  lineId: number | null;
  managerHrId: string | null;
  notes: string | null;
  otherRequestType: string | null;
  payDate: string | null;
  rejectedAt: string | null;
  returnedAt: string | null;
  returnedStepSequence: number | null;
  requestCode: string;
  requestDate: string;
  requestTypeId: number;
  requesterHrId: string;
  requiredRoiValue: number;
  roiCoverageRatio: number;
  roiDurationMonths: number;
  roiStatus: MarketingRoiStatus;
  status: MarketingRequestStatus;
  submittedAt: string | null;
  updatedAt: string;
  updatedByHrId: string | null;
};

export type MarketingRequestProduct = {
  createdAt: string;
  expectedValue: number;
  factoryPriceSnapshot: number;
  forecastQuantity: number;
  id: string;
  lineSnapshot: string | null;
  productId: number;
  productNameSnapshot: string;
  requestId: string;
  updatedAt: string;
  valueShare: number;
};

export type MarketingRequestPharmacy = {
  createdAt: string;
  distributorCodeId: string;
  id: string;
  notes: string | null;
  pharmacyId: string;
  requestId: string;
  trackingStatus: MarketingRequestPharmacyTrackingStatus;
  updatedAt: string;
};

export type MarketingRequestApprovalStep = {
  allowReject: boolean;
  allowReturn: boolean;
  assignedHrId: string | null;
  assignedRole: string;
  createdAt: string;
  decisionAt: string | null;
  decisionByHrId: string | null;
  decisionLabels: MarketingDecisionLabels | null;
  decisionNote: string | null;
  executedAt: string | null;
  id: string;
  isCc: boolean;
  requestId: string;
  sequence: number;
  status: MarketingApprovalStepStatus;
  stepCode: string;
  stepKind: MarketingStepKind | null;
  stepName: string;
  terminalStatus: MarketingRequestStatus | null;
  updatedAt: string;
  workflowStepId: number | null;
};

export type MarketingRequestFinanceRequirement = {
  createdAt: string;
  financeReviewerHrId: string | null;
  invoiceDeadlineDate: string | null;
  invoiceOriginalFileName: string | null;
  invoiceRequired: boolean;
  invoiceStatus: MarketingInvoiceStatus;
  invoiceStoragePath: string | null;
  invoiceUploadedAt: string | null;
  invoiceUploadedByHrId: string | null;
  moneyTransferProofOriginalFileName: string | null;
  moneyTransferProofStoragePath: string | null;
  moneyTransferProofUploadedAt: string | null;
  moneyTransferProofUploadedByHrId: string | null;
  notes: string | null;
  requestId: string;
  reviewedAt: string | null;
  updatedAt: string;
};

export type MarketingEvidenceFile = {
  capturedAccuracyMeters: number | null;
  capturedAddress: string | null;
  capturedAt: string | null;
  capturedLatitude: number | null;
  capturedLongitude: number | null;
  contentType: string | null;
  createdAt: string;
  entityId: string;
  entityType: MarketingEvidenceEntityType;
  evidenceType: MarketingEvidenceType;
  hasTimestamp: boolean;
  id: string;
  originalFileName: string | null;
  storageBucket: string;
  storagePath: string;
  uploadedByHrId: string | null;
};

export type MarketingRoiInputProduct = {
  factoryPrice: number;
  productId?: number | string | null;
  productName?: string | null;
  quantity: number;
};

export type MarketingRoiPreview = {
  expectedRoiValue: number;
  products: Array<MarketingRoiInputProduct & {
    expectedValue: number;
    valueShare: number;
  }>;
  requiredRoiValue: number;
  roiCoverageRatio: number;
  roiStatus: MarketingRoiStatus;
};

export type MarketingRequestCreateDraft = {
  areaId?: number | null;
  customerContactId?: string | null;
  customerId: string;
  estimatedCost: number;
  lineId?: number | null;
  notes?: string | null;
  otherRequestType?: string | null;
  payDate?: string | null;
  pharmacies?: MarketingRequestDraftPharmacyInput[];
  products: MarketingRequestDraftProductInput[];
  requestDate: string;
  requestTypeId: number;
  roiDurationMonths: number;
};

export type MarketingRequestDraftProductInput = {
  productId: number | string;
  quantity: number;
};

export type MarketingRequestDraftPharmacyInput = {
  distributorCodeId: string;
  notes?: string | null;
  /**
   * Written justification for using a pharmacy code the reference database cannot find.
   *
   * Required — and only consulted — when that specific code is `not_found`. Per-pharmacy rather
   * than per-request on purpose: a request may target five pharmacies where only one code is bad,
   * and a single request-level reason would say nothing about which.
   */
  unverifiedCodeReason?: string | null;
};

export type MarketingRequestDraftDetail = MarketingRequest & {
  pharmacies: MarketingRequestPharmacy[];
  products: MarketingRequestProduct[];
};
