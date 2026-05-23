import { randomUUID } from "node:crypto";

import {
  canSeeHrScopedRecord,
  resolveEmployeeIdentityId,
  type AccessContext,
} from "@/lib/auth/permissions";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { calculateMarketingRoiPreview } from "@/lib/marketing-requests/roi";
import type {
  MarketingDistributor,
  MarketingControlSetting,
  MarketingControlSettingGroup,
  MarketingControlWorkspace,
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
  MarketingRequestDraftProductInput,
  MarketingRequestPharmacy,
  MarketingRequestProduct,
  MarketingRequestFinanceRequirement,
  MarketingRequestType,
  MarketingValidationInput,
  MarketingValidationReportRow,
  MarketingValidationStatus,
  MarketingValidationWorkspace,
  MarketingWorkflowApprovalScope,
  MarketingWorkflowStep,
} from "@/lib/marketing-requests/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";
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
  approval_scope: MarketingWorkflowApprovalScope;
  assigned_role: string;
  created_at?: string | null;
  default_sla_days: number | string | null;
  id: number | string;
  required: boolean;
  sequence: number | string;
  step_code: string;
  step_name: string;
  updated_at?: string | null;
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
  expected_roi_value: number | string;
  id: string;
  line_id: number | string | null;
  manager_hr_id: string | null;
  notes: string | null;
  other_request_type: string | null;
  pay_date: string | null;
  rejected_at?: string | null;
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

type MarketingRequesterLine = Pick<EmployeeDirectoryRow, "lineId"> & {
  lineName?: string | null;
};

export type MarketingRequestDraftWorkspace = {
  approvedRequests: MarketingApprovedRequestRow[];
  customers: MarketingCustomer[];
  distributors: MarketingDistributor[];
  drafts: MarketingRequest[];
  products: MarketingProduct[];
  requestTypes: MarketingRequestType[];
  requesterLineId: number | null;
  requesterLineName: string | null;
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

const approvedMarketingRequestStatuses: MarketingRequest["status"][] = [
  "approved",
  "active",
  "roi_tracking",
  "closed",
  "finance_hold",
];

const marketingFinanceEvidenceBucket = "marketing-finance-evidence";
const marketingFinanceEvidenceMaxBytes = 5 * 1024 * 1024;
const marketingFinanceEvidenceContentTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

type NormalizedMarketingValidationInput = {
  customer: {
    capturedAccuracyMeters: number | null;
    capturedAddress: string | null;
    capturedAt: string | null;
    capturedLatitude: number | null;
    capturedLongitude: number | null;
    customerType: MarketingCustomerType;
    displayName: string;
    evidenceHasTimestamp: boolean;
    evidencePhotoCapturedAt: string | null;
    evidencePhotoName: string | null;
    evidenceStatus: MarketingEvidenceStatus;
    extractedAreaName: string | null;
    extractedGovernorateName: string | null;
    mobileNumber: string | null;
    normalizedName: string;
    otherTypeDescription: string | null;
    regionName: string | null;
    validationStatus: MarketingValidationStatus;
  };
  pharmacies: Array<{
    capturedAccuracyMeters: number | null;
    capturedAddress: string | null;
    capturedAt: string | null;
    capturedLatitude: number | null;
    capturedLongitude: number | null;
    displayName: string;
    evidenceHasTimestamp: boolean;
    evidencePhotoCapturedAt: string | null;
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
  }>;
};

type MarketingSystemValidationInput = {
  customerEvidenceStatus: MarketingEvidenceStatus;
  pharmacyEvidenceStatus: MarketingEvidenceStatus;
  referenceStatus: MarketingPharmacyCodeReferenceStatus;
};

type CreateValidationOptions = {
  employeeRows?: EmployeeDirectoryRow[];
  supabase?: SupabaseClient;
};

type CreateDraftOptions = {
  employeeRows?: EmployeeDirectoryRow[];
  supabase?: SupabaseClient;
};

const marketingCreatorRoles = new Set<AccessContext["role"]>([
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

const companyMarketingRoles = new Set<AccessContext["role"]>([
  "CEO",
  "Finance Manager",
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

function normalizeHrId(value: unknown) {
  const normalized = cleanText(value)?.toLowerCase() ?? null;
  return normalized;
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

function sameEmployeeDepartment(viewer: EmployeeDirectoryRow | undefined, target: EmployeeDirectoryRow | undefined) {
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

function reportsUpToViewer(input: {
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

function canSeeMarketingHierarchyRecord(
  access: AccessContext,
  record: {
    employeeHrId?: string | null;
    hrId?: string | null;
    managerHrId?: string | null;
  },
  employeeRows: EmployeeDirectoryRow[],
) {
  if (access.scope === "system" || access.role === "Super Admin" || access.role === "CEO" || access.role === "Finance Manager" || access.role === "SFE Manager") {
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

function assertMarketingWorkspaceAccess(access: AccessContext) {
  if (access.scope === "system") return;
  if (!marketingCreatorRoles.has(access.role) && !companyMarketingRoles.has(access.role)) {
    throw forbiddenError(`Forbidden: ${access.role} cannot use marketing requests.`);
  }
}

export function assertMarketingRequestAccess(access: AccessContext) {
  assertMarketingAccess(access);
}

function assertMarketingCustomerDatabaseAccess(access: AccessContext) {
  if (access.scope === "system") return;
  if (access.role !== "Super Admin") {
    throw forbiddenError("Forbidden: only Super Admin can view the validation dev database.");
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

function marketingProductMatchesRequesterLine(product: MarketingProductDbRow, requester: MarketingRequesterLine) {
  const requesterLineId = requester.lineId ?? null;
  const productLineId = product.line_id === null || product.line_id === undefined ? null : Number(product.line_id);
  if (requesterLineId !== null && productLineId === requesterLineId) return true;

  const requesterLineName = normalizeScopeText(requester.lineName);
  const productLineName = normalizeScopeText(product.line);
  return Boolean(requesterLineName && productLineName && requesterLineName === productLineName);
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
  const rows: Array<{ distributorCodeId: string; notes: string | null }> = [];
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

function evidenceStatusFromInput(input: {
  capturedAt: string | null;
  capturedLatitude: number | null;
  capturedLongitude: number | null;
  evidenceHasTimestamp: boolean;
  evidencePhotoCapturedAt: string | null;
  evidencePhotoName: string | null;
}): MarketingEvidenceStatus {
  if (
    hasCapturedLocation(input) &&
    input.evidenceHasTimestamp &&
    Boolean(input.evidencePhotoCapturedAt) &&
    Boolean(input.evidencePhotoName)
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

export function normalizeMarketingValidationInput(
  input: MarketingValidationInput,
): NormalizedMarketingValidationInput {
  const customerDisplayName = cleanText(input.customer?.displayName);
  if (!customerDisplayName) throw validationError("Customer name is required.");

  const customer = {
    capturedAccuracyMeters: nonNegativeNumber(input.customer?.capturedAccuracyMeters),
    capturedAddress: cleanText(input.customer?.capturedAddress),
    capturedAt: nullableIsoTimestamp(input.customer?.capturedAt, "Customer capture time"),
    capturedLatitude: nullableCoordinate(input.customer?.capturedLatitude, "Customer latitude", -90, 90),
    capturedLongitude: nullableCoordinate(input.customer?.capturedLongitude, "Customer longitude", -180, 180),
    customerType: normalizeCustomerType(input.customer?.customerType),
    displayName: customerDisplayName,
    evidenceHasTimestamp: input.customer?.evidenceHasTimestamp === true,
    evidencePhotoCapturedAt: nullableIsoTimestamp(input.customer?.evidencePhotoCapturedAt, "Customer photo capture time"),
    evidencePhotoName: cleanText(input.customer?.evidencePhotoName),
    extractedAreaName: cleanText(input.customer?.extractedAreaName),
    extractedGovernorateName: cleanText(input.customer?.extractedGovernorateName),
    mobileNumber: cleanText(input.customer?.mobileNumber),
    normalizedName: normalizeLookupKey(customerDisplayName),
    otherTypeDescription: cleanText(input.customer?.otherTypeDescription),
    regionName: cleanText(input.customer?.regionName),
  };
  const customerEvidenceStatus = evidenceStatusFromInput(customer);
  const inputPharmacies = Array.isArray(input.pharmacies) && input.pharmacies.length > 0
    ? input.pharmacies
    : input.pharmacy && input.distributorCode
      ? [{ ...input.pharmacy, vendorCodes: [input.distributorCode] }]
      : [];
  if (inputPharmacies.length === 0) throw validationError("At least one pharmacy is required.");

  const pharmacies = inputPharmacies.map((inputPharmacy, index) => {
    const displayName = cleanText(inputPharmacy?.displayName);
    if (!displayName) throw validationError(`Pharmacy ${index + 1} name is required.`);
    if (!Array.isArray(inputPharmacy.vendorCodes) || inputPharmacy.vendorCodes.length === 0) {
      throw validationError(`Pharmacy ${index + 1} needs at least one vendor code.`);
    }

    const pharmacy = {
      capturedAccuracyMeters: nonNegativeNumber(inputPharmacy.capturedAccuracyMeters),
      capturedAddress: cleanText(inputPharmacy.capturedAddress),
      capturedAt: nullableIsoTimestamp(inputPharmacy.capturedAt, `Pharmacy ${index + 1} capture time`),
      capturedLatitude: nullableCoordinate(inputPharmacy.capturedLatitude, `Pharmacy ${index + 1} latitude`, -90, 90),
      capturedLongitude: nullableCoordinate(inputPharmacy.capturedLongitude, `Pharmacy ${index + 1} longitude`, -180, 180),
      displayName,
      evidenceHasTimestamp: inputPharmacy.evidenceHasTimestamp === true,
      evidencePhotoCapturedAt: nullableIsoTimestamp(inputPharmacy.evidencePhotoCapturedAt, `Pharmacy ${index + 1} photo capture time`),
      evidencePhotoName: cleanText(inputPharmacy.evidencePhotoName),
      extractedAreaName: cleanText(inputPharmacy.extractedAreaName),
      extractedGovernorateName: cleanText(inputPharmacy.extractedGovernorateName),
      normalizedName: normalizeLookupKey(displayName),
      regionName: cleanText(inputPharmacy.regionName),
    };
    const pharmacyEvidenceStatus = evidenceStatusFromInput(pharmacy);
    const seenVendorCodes = new Set<string>();
    const vendorCodes = inputPharmacy.vendorCodes.map((vendorCode, vendorIndex) => {
      const distributorId = numberId(vendorCode.distributorId, `Pharmacy ${index + 1} vendor ${vendorIndex + 1}`);
      const distributorPharmacyCode = cleanText(vendorCode.distributorPharmacyCode);
      if (!distributorPharmacyCode) {
        throw validationError(`Pharmacy ${index + 1} vendor ${vendorIndex + 1} code is required.`);
      }
      const normalizedPharmacyCode = normalizeLookupKey(distributorPharmacyCode);
      const key = `${distributorId}:${normalizedPharmacyCode}`;
      if (seenVendorCodes.has(key)) {
        throw validationError(`Pharmacy ${index + 1} has a duplicate vendor code.`);
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
  });

  return {
    customer: {
      ...customer,
      capturedAccuracyMeters: customer.capturedAccuracyMeters || null,
      evidenceStatus: customerEvidenceStatus,
      validationStatus: systemStatusFromEvidence(customerEvidenceStatus),
    },
    pharmacies,
  };
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
  const requesterLineId = params.requester.lineId ?? null;
  const requesterLineName = normalizeScopeText(params.requester.lineName);
  if (requesterLineId === null && !requesterLineName && !params.unrestrictedProductLines) {
    throw validationError("Requester product line is not assigned. Please contact HR.", "requester_line_not_assigned");
  }
  const outsideRequesterLine = normalized.products.find((product) => {
    const row = productRowsById.get(product.productId);
    return !params.unrestrictedProductLines && row && !marketingProductMatchesRequesterLine(row, params.requester);
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
    estimatedCost: normalized.estimatedCost,
    products: roiProducts,
  });
  const requesterHrId = String(params.requester.hrId);
  const areaId = (normalized.areaId ?? Number(params.customer.area_id ?? params.requester.areaId ?? 0)) || null;
  const lineId = params.unrestrictedProductLines
    ? (normalized.lineId ?? Number(params.customer.line_id ?? requesterLineId ?? 0)) || null
    : requesterLineId;
  const managerHrId = cleanText(params.customer.manager_hr_id) ?? cleanText(params.requester.managerHrId);
  const pharmacyCodesById = new Map((params.pharmacyCodes ?? []).map((code) => [code.id, code]));

  const pharmacyRows = normalized.pharmacies.map((pharmacy) => {
    const code = pharmacyCodesById.get(pharmacy.distributorCodeId);
    if (!code || code.active === false) {
      throw notFoundError("Distributor pharmacy code was not found or is inactive.", "pharmacy_code_not_found");
    }

    return {
      distributor_code_id: code.id,
      notes: pharmacy.notes,
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
    expectedRoiValue: toNumber(row.expected_roi_value),
    id: row.id,
    lineId: row.line_id === null ? null : Number(row.line_id),
    managerHrId: row.manager_hr_id,
    notes: row.notes,
    otherRequestType: row.other_request_type,
    payDate: row.pay_date,
    rejectedAt: row.rejected_at ?? null,
    requestCode: row.request_code,
    requestDate: row.request_date,
    requesterHrId: row.requester_hr_id,
    requestTypeId: Number(row.request_type_id),
    requiredRoiValue: toNumber(row.required_roi_value ?? toNumber(row.estimated_cost) * 10),
    roiCoverageRatio: toNumber(row.roi_coverage_ratio),
    roiDurationMonths: Number(row.roi_duration_months),
    roiStatus: row.roi_status,
    status: row.status,
    submittedAt: row.submitted_at ?? null,
    updatedAt: nowIsoFallback(row.updated_at),
    updatedByHrId: row.updated_by_hr_id ?? null,
  };
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

function mapWorkflowStep(row: MarketingWorkflowStepDbRow): MarketingWorkflowStep {
  return {
    active: row.active,
    approvalScope: row.approval_scope,
    assignedRole: row.assigned_role,
    createdAt: nowIsoFallback(row.created_at),
    defaultSlaDays: row.default_sla_days === null || row.default_sla_days === undefined
      ? null
      : Number(row.default_sla_days),
    id: Number(row.id),
    required: row.required,
    sequence: Number(row.sequence),
    stepCode: row.step_code,
    stepName: row.step_name,
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
      contactForMoneyTransfer: requester?.fullName ?? request.requesterHrId,
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

function canSeeMarketingRequest(access: AccessContext, row: MarketingRequestDbRow, employeeRows: EmployeeDirectoryRow[]) {
  return canSeeMarketingHierarchyRecord(access, {
    employeeHrId: row.requester_hr_id,
    managerHrId: row.manager_hr_id,
  }, employeeRows);
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

function canSeeMarketingCustomer(access: AccessContext, row: MarketingCustomerDbRow, employeeRows: EmployeeDirectoryRow[]) {
  return canSeeMarketingHierarchyRecord(access, {
    employeeHrId: row.owner_hr_id,
    managerHrId: row.manager_hr_id,
  }, employeeRows);
}

async function fetchRowsByIds<T extends { id: string | number }>(
  supabase: SupabaseClient,
  table: string,
  ids: Array<string | number>,
) {
  if (ids.length === 0) return [];
  const { data, error } = await supabase.from(table).select("*").in("id", ids);
  if (error) throw error;
  return (data ?? []) as T[];
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

async function resolvePharmacyCodeReference(params: {
  distributorId: number;
  normalizedPharmacyCode: string;
  supabase: SupabaseClient;
}) {
  const { data, error } = await params.supabase
    .from("marketing_pharmacy_code_references")
    .select("id, raw_pharmacy_code")
    .eq("distributor_id", params.distributorId)
    .limit(20);
  if (error) throw error;

  const matches = ((data ?? []) as MarketingPharmacyCodeReferenceDbRow[]).filter(
    (row) => normalizeLookupKey(row.raw_pharmacy_code) === params.normalizedPharmacyCode,
  );
  const matchCount = matches.length;
  const status: MarketingPharmacyCodeReferenceStatus =
    matchCount === 1 ? "matched" : matchCount > 1 ? "ambiguous" : "not_found";

  return {
    matchCount,
    referenceId: matchCount === 1 ? Number(matches[0].id) : null,
    status,
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
      .limit(200),
  ]);

  if (distributorsResult.error) throw distributorsResult.error;
  if (linksResult.error) throw linksResult.error;

  const distributors = ((distributorsResult.data ?? []) as MarketingDistributorDbRow[]).map(mapDistributor);
  const links = (linksResult.data ?? []) as MarketingCustomerPharmacyDbRow[];
  if (links.length === 0) {
    return {
      distributors,
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
    distributors,
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

  const [customerRows, pharmacyRows, codeRows, contactRows] = await Promise.all([
    fetchRowsByIds<MarketingCustomerDbRow>(supabase, "marketing_customers", customerIds),
    fetchRowsByIds<MarketingPharmacyDbRow>(supabase, "marketing_pharmacies", pharmacyIds),
    fetchRowsByIds<MarketingPharmacyDistributorCodeDbRow>(
      supabase,
      "marketing_pharmacy_distributor_codes",
      distributorCodeIds,
    ),
    supabase
      .from("marketing_customer_contacts")
      .select("id, customer_id, contact_name, mobile_number, active")
      .in("customer_id", customerIds)
      .eq("active", true),
  ]);

  if (contactRows.error) throw contactRows.error;

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
  for (const contact of (contactRows.data ?? []) as MarketingCustomerContactDbRow[]) {
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

  const supabase = options.supabase ?? getSupabaseAdmin();
  const employeeRows = options.employeeRows ?? await loadEmployeeDirectoryRows();
  const requester = findRequester(access, employeeRows);
  const actorHrId = String(requester.hrId);
  const normalized = normalizeMarketingValidationInput(input);
  const distributorIds = Array.from(
    new Set(normalized.pharmacies.flatMap((pharmacy) => pharmacy.vendorCodes.map((code) => code.distributorId))),
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

  let customerId: string | null = null;
  const pharmacyIds: string[] = [];
  try {
    const customerInsert = await supabase
      .from("marketing_customers")
      .insert({
        area_id: requester.areaId ?? null,
        captured_accuracy_meters: normalized.customer.capturedAccuracyMeters,
        captured_address: normalized.customer.capturedAddress,
        captured_at: normalized.customer.capturedAt,
        captured_latitude: normalized.customer.capturedLatitude,
        captured_longitude: normalized.customer.capturedLongitude,
        created_by_hr_id: actorHrId,
        customer_code: generateMarketingCode("MKT-HCP"),
        customer_type: normalized.customer.customerType,
        display_name: normalized.customer.displayName,
        evidence_has_timestamp: normalized.customer.evidenceHasTimestamp,
        evidence_photo_captured_at: normalized.customer.evidencePhotoCapturedAt,
        evidence_photo_name: normalized.customer.evidencePhotoName,
        evidence_status: normalized.customer.evidenceStatus,
        extracted_area_name: normalized.customer.extractedAreaName,
        extracted_governorate_name: normalized.customer.extractedGovernorateName,
        line_id: requester.lineId ?? null,
        manager_hr_id: requester.managerHrId ?? null,
        normalized_name: normalized.customer.normalizedName,
        other_type_description: normalized.customer.otherTypeDescription,
        owner_hr_id: actorHrId,
        region_name: normalized.customer.regionName,
        updated_by_hr_id: actorHrId,
        validation_status: normalized.customer.validationStatus,
      })
      .select("*")
      .single();
    if (customerInsert.error) throw customerInsert.error;
    const customer = mapCustomer(customerInsert.data as MarketingCustomerDbRow);
    customerId = customer.id;

    if (normalized.customer.mobileNumber) {
      const contactInsert = await supabase
        .from("marketing_customer_contacts")
        .insert({
          contact_code: generateMarketingCode("MKT-CON"),
          contact_name: customer.displayName,
          created_by_hr_id: actorHrId,
          customer_id: customer.id,
          mobile_number: normalized.customer.mobileNumber,
        });
      if (contactInsert.error) throw contactInsert.error;
    }

    const rows: MarketingValidationReportRow[] = [];
    for (const normalizedPharmacy of normalized.pharmacies) {
      const pharmacyInsert = await supabase
        .from("marketing_pharmacies")
        .insert({
          area_id: requester.areaId ?? null,
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
          line_id: requester.lineId ?? null,
          manager_hr_id: requester.managerHrId ?? null,
          normalized_name: normalizedPharmacy.normalizedName,
          owner_hr_id: actorHrId,
          pharmacy_code: generateMarketingCode("MKT-PHA"),
          region_name: normalizedPharmacy.regionName,
          updated_by_hr_id: actorHrId,
          validation_status: normalizedPharmacy.validationStatus,
        })
        .select("*")
        .single();
      if (pharmacyInsert.error) throw pharmacyInsert.error;
      const pharmacy = mapMarketingPharmacy(pharmacyInsert.data as MarketingPharmacyDbRow);
      pharmacyIds.push(pharmacy.id);

      for (const vendorCode of normalizedPharmacy.vendorCodes) {
        const reference = await resolvePharmacyCodeReference({
          distributorId: vendorCode.distributorId,
          normalizedPharmacyCode: vendorCode.normalizedPharmacyCode,
          supabase,
        });
        const linkValidationStatus = resolveMarketingSystemValidationStatus({
          customerEvidenceStatus: normalized.customer.evidenceStatus,
          pharmacyEvidenceStatus: normalizedPharmacy.evidenceStatus,
          referenceStatus: reference.status,
        });
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
        validation_notes: linkValidationStatus === "system_validated" ? null : "Waiting for complete evidence or distributor-code match.",
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

    return rows;
  } catch (error) {
    if (customerId) await supabase.from("marketing_customers").delete().eq("id", customerId);
    for (const pharmacyId of pharmacyIds) {
      await supabase.from("marketing_pharmacies").delete().eq("id", pharmacyId);
    }
    throw error;
  }
}

export async function getMarketingRequestDraftWorkspace(access: AccessContext): Promise<MarketingRequestDraftWorkspace> {
  assertMarketingWorkspaceAccess(access);

  const supabase = getSupabaseAdmin();
  const [typesResult, productsResult, distributorsResult, customersResult, validatedLinksResult, draftsResult, approvedRequestsResult] = await Promise.all([
    supabase.from("marketing_request_types").select("*").or("active.is.null,active.eq.true").order("sort_order"),
    supabase.from("marketing_products").select("*").or("active.is.null,active.eq.true").order("product_name"),
    supabase.from("marketing_distributors").select("*").or("active.is.null,active.eq.true").order("display_name"),
    supabase.from("marketing_customers").select("*").or("active.is.null,active.eq.true").order("display_name"),
    supabase
      .from("marketing_customer_pharmacies")
      .select("customer_id")
      .or("active.is.null,active.eq.true")
      .in("validation_status", ["system_validated", "sfe_validated"]),
    supabase.from("marketing_requests").select("*").eq("status", "draft").order("created_at", { ascending: false }).limit(100),
    supabase
      .from("marketing_requests")
      .select("*")
      .in("status", approvedMarketingRequestStatuses)
      .order("pay_date", { ascending: false, nullsFirst: false })
      .limit(100),
  ]);

  if (typesResult.error) throw typesResult.error;
  if (productsResult.error) throw productsResult.error;
  if (distributorsResult.error) throw distributorsResult.error;
  if (customersResult.error) throw customersResult.error;
  if (validatedLinksResult.error) throw validatedLinksResult.error;
  if (draftsResult.error) throw draftsResult.error;
  if (approvedRequestsResult.error) throw approvedRequestsResult.error;

  const employeeRows = await loadEmployeeDirectoryRows();
  const requester = findRequester(access, employeeRows);
  const requesterLineId = requester.lineId ?? null;
  const unrestrictedProductLines = canUseAnyMarketingProductLine(access);
  const drafts = ((draftsResult.data ?? []) as MarketingRequestDbRow[])
    .filter((row) => canSeeMarketingRequest(access, row, employeeRows))
    .map(mapRequest);
  const approvedRequests = ((approvedRequestsResult.data ?? []) as MarketingRequestDbRow[])
    .filter((row) => canSeeMarketingRequest(access, row, employeeRows))
    .map(mapRequest);
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
  const allCustomerRows = (customersResult.data ?? []) as MarketingCustomerDbRow[];
  const allCustomers = allCustomerRows.map(mapCustomer);
  const customers = allCustomerRows
    .filter((row) => validatedCustomerIds.has(row.id))
    .filter((row) => canSeeMarketingCustomer(access, row, employeeRows))
    .map(mapCustomer);
  const products = ((productsResult.data ?? []) as MarketingProductDbRow[])
    .filter((product) => unrestrictedProductLines || marketingProductMatchesRequesterLine(product, requester))
    .map(mapMarketingProduct);

  return {
    approvedRequests: buildMarketingApprovedRequestRows({
      customers: allCustomers,
      employeeRows,
      financeRequirements: ((financeRequirementsResult.data ?? []) as MarketingRequestFinanceRequirementDbRow[]).map(mapFinanceRequirement),
      requests: approvedRequests,
    }),
    customers,
    distributors: ((distributorsResult.data ?? []) as MarketingDistributorDbRow[]).map(mapDistributor),
    drafts,
    products,
    requestTypes: ((typesResult.data ?? []) as MarketingRequestTypeDbRow[]).map(mapRequestType),
    requesterLineId,
    requesterLineName: unrestrictedProductLines ? "All product lines" : requester.lineName,
  };
}

export async function createMarketingRequestDraft(
  input: MarketingRequestCreateDraft,
  access: AccessContext,
  options: CreateDraftOptions = {},
): Promise<MarketingRequestDraftDetail> {
  assertMarketingAccess(access);

  const supabase = options.supabase ?? getSupabaseAdmin();
  const employeeRows = options.employeeRows ?? await loadEmployeeDirectoryRows();
  const requester = findRequester(access, employeeRows);
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
  });

  const requestInsert = await supabase.rpc("phx_create_marketing_request_draft_atomic", {
    p_request: prepared.requestRow,
  });
  if (requestInsert.error) throw requestInsert.error;

  const requestRow = Array.isArray(requestInsert.data)
    ? requestInsert.data[0] as MarketingRequestDbRow | undefined
    : requestInsert.data as MarketingRequestDbRow | null;
  if (!requestRow) throw new Error("Marketing request draft creation failed.");

  const request = mapRequest(requestRow);

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

    return {
      ...request,
      pharmacies,
      products: ((productsInsert.data ?? []) as MarketingRequestProductDbRow[]).map(mapProduct),
    };
  } catch (error) {
    await supabase.from("marketing_requests").delete().eq("id", request.id);
    throw error;
  }
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
    if (params.access.role === "Finance Manager" || params.access.role === "Super Admin") return;
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
    throw validationError("Evidence file must be 5 MB or smaller.");
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

  const actorHrId = assertMarketingActor(params.access);
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
      finance_reviewer_hr_id: actorHrId,
      money_transfer_proof_original_file_name: params.file.name,
      money_transfer_proof_storage_path: storagePath,
      money_transfer_proof_uploaded_at: now,
      money_transfer_proof_uploaded_by_hr_id: actorHrId,
      reviewed_at: now,
      updated_at: now,
    }
    : {
      invoice_original_file_name: params.file.name,
      invoice_required: true,
      invoice_status: "submitted",
      invoice_storage_path: storagePath,
      invoice_uploaded_at: now,
      invoice_uploaded_by_hr_id: actorHrId,
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

  return rows[0];
}

async function loadEmployeeDirectoryRows() {
  const directory = await import("@/lib/employees/employee-directory");
  return directory.getEmployeeDirectoryRows();
}

export function assertMarketingDraftCanBeSubmitted(draft: MarketingRequestDraftDetail) {
  if (draft.products.length === 0) throw conflictError("At least one product is required before submitting.");
  if (draft.pharmacies.length === 0) throw conflictError("At least one pharmacy tracking code is required before submitting.");
  if (draft.roiStatus === "not_calculated") throw conflictError("ROI must be calculated before submitting.");
}
