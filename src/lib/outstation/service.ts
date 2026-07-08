import * as Sentry from "@sentry/nextjs";

import {
  normalizeHrIdForAccess,
  normalizeRole,
  resolveEmployeeIdentityId,
  systemAccessContext,
  type AccessContext,
} from "@/lib/auth/permissions";
import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { randomUUID } from "node:crypto";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import { getDoubleVisitExpenseWorkloadEvidence } from "@/lib/double-visit-analytics/service";
import type { DoubleVisitExpenseWorkloadEvidence } from "@/lib/double-visit-analytics/types";
import { validateLiveCarEvidence } from "@/lib/outstation/car-evidence";
import {
  createOutstationCarEvidenceSignedUrl,
  deleteOutstationCarEvidenceImage,
  deleteOutstationTicketAttachments,
  uploadOutstationCarEvidenceImage,
  uploadOutstationTicketAttachments,
} from "@/lib/outstation/car-evidence-storage";
import { classifyOutstationExpenseEligibility } from "@/lib/outstation/classification";
import { isHighRiskRequest } from "@/lib/outstation/expense-risk";
import { getEmployeeDirectory, type EmployeeDirectoryData, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { pickDeliverableEmail } from "@/lib/email/email-safety";
import { createSystemNotification } from "@/lib/notifications/system";
import { isPayrollExpensesSchemaMissing, savePayrollExpenseApprovals } from "@/lib/payroll/expenses";
import {
  mapOutstationRequestToPayrollExpenseRecord,
  outstationPayrollTripId,
} from "@/lib/outstation/payroll-expense-mapping";
import { assertOutstationExpenseWorkflowTransition } from "@/lib/outstation/workflow";
import {
  validateMedicalRepSimpleExpenseInput,
  type MedicalRepSimpleExpenseInput,
} from "@/lib/outstation/medical-rep-expenses";
import {
  googleDirectionsRoute,
  googleDistanceMatrix,
  googleGeocodeAddress,
  googleReverseGeocode,
} from "@/lib/google-maps/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type {
  EmployeeResidenceLocation,
  ManagerExpenseAdminInput,
  OutstationAllowanceBreakdown,
  OutstationApprovalRecommendation,
  OutstationCarEvidenceMetadata,
  OutstationCalculationInput,
  OutstationCalculationResult,
  OutstationCaptureResult,
  OutstationTicketAttachmentMetadata,
  OutstationEligibilityStatus,
  OutstationExpenseType,
  OutstationExpenseRequest,
  OutstationFraudFlag,
  OutstationHeatmapData,
  OutstationHeatmapMarker,
  OutstationPolicyRule,
  OutstationRouteAlternative,
  OutstationTerritoryValidationStatus,
  OutstationTransportationType,
} from "@/lib/outstation/types";

type ValidationSignal = {
  capturedAt: string | null;
  capturedLatitude: number | null;
  capturedLongitude: number | null;
};

type ValidationContext = {
  access: AccessContext;
  capturedAccuracyMeters: number;
  capturedAt?: string | null;
  capturedLatitude: number;
  capturedLongitude: number;
  hasTicketAttachments?: boolean;
  offlineCaptured?: boolean;
};

type ValidatedLocationBundle = {
  employee: EmployeeDirectoryRow | null;
  identity: {
    employeeArea: string | null;
    employeeHrId: string;
    employeeLine: string | null;
    employeeName: string;
    employeeRole: string;
  };
  policy: OutstationPolicyRule;
  residence: EmployeeResidenceLocation | null;
  result: OutstationCaptureResult;
};

function text(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function cleanText(value: unknown) {
  const normalized = text(value);
  return normalized.length > 0 ? normalized : null;
}

function appendCarEvidenceNote(
  notes: string | null,
  metadata: OutstationCarEvidenceMetadata | null | undefined,
) {
  if (!metadata) return notes;

  const evidenceLine = [
    "Car live evidence:",
    `source=${metadata.source}`,
    `hr_id=${metadata.employeeHrId}`,
    `captured_at=${metadata.capturedAt}`,
    `location=${metadata.capturedLocationLabel ?? ""}`,
    `gps=${metadata.capturedLatitude},${metadata.capturedLongitude}`,
    `draft_id=${metadata.requestDraftId ?? ""}`,
    `request_id=${metadata.requestId ?? ""}`,
  ].join(" ");

  return [notes, evidenceLine].filter(Boolean).join("\n");
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoString(value: unknown) {
  const raw = text(value);
  if (!raw) return "";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toISOString();
}

function roundCoordinate(value: number) {
  return Math.round(value * 100000) / 100000;
}

function roundMoney(value: number) {
  return Number(value.toFixed(2));
}

// Outstation expenses are reviewed/approved by HR, not Finance. Map any legacy
// "finance_review" rows persisted before that rename onto the current value so
// the UI shows "HR review" consistently without a data migration.
function normalizeApprovalRecommendation(value: string): OutstationApprovalRecommendation {
  if (value === "finance_review") return "hr_review";
  return value as OutstationApprovalRecommendation;
}

function minutesFromSeconds(value: number | null | undefined) {
  return value != null ? Number((value / 60).toFixed(1)) : null;
}

function normalizeArea(value: string | null | undefined) {
  return text(value).toLowerCase();
}

function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "object") return value as T;
  const raw = text(value);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function fallbackWorkloadEvidence(params: {
  sourceLabel: string;
  tripEndDate: string;
  tripStartDate: string;
}): DoubleVisitExpenseWorkloadEvidence {
  const start = params.tripStartDate.slice(0, 10);
  const end = params.tripEndDate.slice(0, 10);
  return {
    amWorkload: 0,
    dateBreakdown: [{ am: 0, date: start, evidenceRows: 0, pm: 0, total: 0 }],
    importId: null,
    matchedDates: [],
    matchStatus: "stale_import",
    missingDates: start && end ? [start, end].filter((value, index, list) => value && list.indexOf(value) === index) : [],
    pmWorkload: 0,
    source: "manual",
    sourceLabel: params.sourceLabel,
  };
}

async function resolveOutstationWorkloadPayload(params: {
  employeeHrId: string | null;
  tripEndDate: string;
  tripStartDate: string;
}) {
  const evidence = await getDoubleVisitExpenseWorkloadEvidence(params).catch((error) =>
    fallbackWorkloadEvidence({
      sourceLabel: error instanceof Error
        ? `Double Visit evidence unavailable: ${error.message}`
        : "Double Visit evidence unavailable.",
      tripEndDate: params.tripEndDate,
      tripStartDate: params.tripStartDate,
    }),
  );
  return {
    am_workload: evidence.amWorkload,
    pm_workload: evidence.pmWorkload,
    workload_evidence_snapshot: evidence,
    workload_match_status: evidence.matchStatus,
    workload_matched_at: new Date().toISOString(),
    workload_source: evidence.source,
    workload_source_import_id: evidence.importId,
  };
}

function isMissingSupabaseRelation(error: { code?: string; message?: string } | null) {
  if (!error) return false;
  const message = error.message ?? "";
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    message.includes("Could not find the table") ||
    message.includes("schema cache")
  );
}

function isMissingTolerancePolicyColumn(
  error: { code?: string; message?: string } | null,
) {
  if (!error) return false;
  const message = error.message ?? "";
  return (
    error.code === "42703" ||
    (message.includes("column") &&
      message.includes("does not exist") &&
      message.includes("tolerance_minimum_distance_km"))
  );
}

function hoursBetween(previousIso: string, currentIso: string) {
  const previous = new Date(previousIso).getTime();
  const current = new Date(currentIso).getTime();
  if (!Number.isFinite(previous) || !Number.isFinite(current) || current <= previous) {
    return null;
  }
  return (current - previous) / 3600000;
}

function daysBetween(startIso: string, endIso: string) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return 0;
  }

  const startUtc = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endUtc = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return Math.max(0, Math.round((endUtc - startUtc) / 86400000));
}

function calculateAllowanceBreakdown(
  tripStartDate: string,
  tripEndDate: string,
  policy: OutstationPolicyRule,
) {
  const overnightDays = daysBetween(tripStartDate, tripEndDate);
  const sameDayTrip = overnightDays === 0;
  const rows: OutstationAllowanceBreakdown["rows"] = [];

  if (sameDayTrip) {
    rows.push({
      amount: policy.sameDayAllowance,
      label: "Same day allowance",
      type: "same_day",
    });
  } else {
    for (let index = 0; index < overnightDays; index += 1) {
      rows.push({
        amount: policy.overnightAllowance,
        label: `Overnight allowance day ${index + 1}`,
        type: "overnight",
      });
    }
    rows.push({
      amount: policy.returnDayAllowance,
      label: "Return day allowance",
      type: "return_day",
    });
  }

  const allowanceAmount = roundMoney(rows.reduce((sum, row) => sum + row.amount, 0));
  return {
    allowanceAmount,
    breakdown: {
      overnightDays,
      returnDayApplied: !sameDayTrip,
      rows,
      sameDayTrip,
    } satisfies OutstationAllowanceBreakdown,
    overnightDays,
    sameDayTrip,
  };
}

function positiveMoney(value: unknown) {
  return roundMoney(Math.max(0, numberValue(value)));
}

function optionalPositiveMoney(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  return positiveMoney(value);
}

function reportTripTypeLabel(input: {
  override?: string | null;
  overnightDays: number;
  sameDayTrip: boolean;
}) {
  const override = cleanText(input.override);
  if (override) return override;
  return input.sameDayTrip
    ? "Return same day"
    : `Overnight / ${input.overnightDays + 1} days`;
}

function reportExpectedTotal(input: {
  allowanceAmount: number;
  eligibilityStatus: OutstationEligibilityStatus;
  meetingAmount: number;
  otherAmount: number;
  travelCost: number;
}) {
  if (input.eligibilityStatus === "not_eligible") return 0;
  return roundMoney(
    input.travelCost +
      input.meetingAmount +
      input.allowanceAmount +
      input.otherAmount,
  );
}

function recommendationForResult(params: {
  eligibilityStatus: OutstationEligibilityStatus;
  fraudFlags: OutstationFraudFlag[];
  hasTicketAttachments: boolean;
  policy: OutstationPolicyRule;
  suspiciousLocationScore: number;
  territoryValidationStatus: OutstationTerritoryValidationStatus;
  transportationType: OutstationTransportationType;
  variancePercent: number;
}) {
  if (params.eligibilityStatus === "not_eligible") {
    return {
      approvalReason:
        "Request is below policy distance or otherwise fails the minimum eligibility rules.",
      approvalRecommendation: "reject" as OutstationApprovalRecommendation,
    };
  }

  if (
    (params.transportationType === "train" || params.transportationType === "bus") &&
    params.policy.requiresTicketAttachment &&
    !params.hasTicketAttachments
  ) {
    return {
      approvalReason:
        "Train or bus requests require ticket evidence before HR can approve the claim.",
      approvalRecommendation: "hr_review" as OutstationApprovalRecommendation,
    };
  }

  if (params.suspiciousLocationScore >= 70) {
    return {
      approvalReason:
        "Suspicious location score is too high for automatic approval and requires manual intervention.",
      approvalRecommendation: "reject" as OutstationApprovalRecommendation,
    };
  }

  if (Math.abs(params.variancePercent) > 50) {
    return {
      approvalReason:
        "Claimed amount materially exceeds the expected amount and should be reviewed by HR.",
      approvalRecommendation: "hr_review" as OutstationApprovalRecommendation,
    };
  }

  if (
    params.eligibilityStatus === "needs_review" ||
    params.suspiciousLocationScore >= 25 ||
    params.fraudFlags.length > 0 ||
    params.territoryValidationStatus === "outside_expected_territory"
  ) {
    return {
      approvalReason:
        "Location, territory, or timing checks require manager review before the request can move forward.",
      approvalRecommendation: "manager_review" as OutstationApprovalRecommendation,
    };
  }

  return {
    approvalReason:
      "Distance, location, and policy checks are clean enough for automatic approval recommendation.",
    approvalRecommendation: "auto_approve" as OutstationApprovalRecommendation,
  };
}

async function getEmployeeIdentity(access: AccessContext) {
  const identityHrId = resolveEmployeeIdentityId(access);
  if (!identityHrId) {
    throw new Error("Your employee profile is not linked yet. Please contact HR.");
  }

  const directory = await getEmployeeDirectory();
  const employee =
    directory.employees.find(
      (row) => normalizeHrIdForAccess(row.hrId) === normalizeHrIdForAccess(identityHrId),
    ) ?? null;

  if (!employee?.hrId) {
    throw new Error("Your employee profile is not available in the employee directory. Please contact HR before submitting an outstation request.");
  }

  return {
    employee,
    employeeArea: employee?.areaName ?? null,
    employeeHrId: employee.hrId,
    employeeLine: employee?.lineName ?? null,
    employeeName: employee?.fullName ?? employee.hrId,
    employeeRole: resolveJobFunctionRole(employee?.jobTitle ?? access.role),
  };
}

export async function getOutstationEmployeeContext(access: AccessContext) {
  const identity = await getEmployeeIdentity(access);
  const residence = await getResidenceLocationForEmployee(identity.employeeHrId);

  return {
    employeeArea: identity.employeeArea,
    employeeHrId: identity.employeeHrId,
    employeeLine: identity.employeeLine,
    employeeName: identity.employeeName,
    employeeRole: identity.employeeRole,
    residence,
  };
}

function residenceSummary(parts: {
  residenceAddress: string | null;
  residenceArea: string | null;
  residenceCity: string | null;
}) {
  return [
    parts.residenceAddress,
    parts.residenceCity,
    parts.residenceArea,
  ]
    .map((value) => text(value))
    .filter(Boolean)
    .join(" - ");
}

function fallbackResidenceFromEmployee(employee: EmployeeDirectoryRow): EmployeeResidenceLocation | null {
  const hasResidenceText = Boolean(
    text(employee.residenceAddress) ||
      text(employee.residenceCity) ||
      text(employee.residenceArea),
  );
  const hasCoordinates =
    employee.residenceLatitude != null && employee.residenceLongitude != null;

  if (!hasResidenceText && !hasCoordinates) {
    return null;
  }

  return {
    employeeHrId: employee.hrId,
    geocodeStatus: employee.residenceGeocodeStatus,
    residenceAddress: text(employee.residenceAddress) || null,
    residenceArea: text(employee.residenceArea) || null,
    residenceCity: text(employee.residenceCity) || null,
    residenceLatitude: employee.residenceLatitude,
    residenceLongitude: employee.residenceLongitude,
  };
}

function assertMedicalRepRole(role: string | null | undefined) {
  if (normalizeRole(role) !== "Medical Rep") {
    throw new Error("Forbidden: only Medical Rep users can use simple expense submission.");
  }
}

async function getMedicalRepExpenseIdentity(access: AccessContext) {
  const identity = await getEmployeeIdentity(access);
  assertMedicalRepRole(identity.employeeRole);
  const residence =
    (await getResidenceLocationForEmployee(identity.employeeHrId)) ??
    fallbackResidenceFromEmployee(identity.employee);
  const fromLocation = residence ? residenceSummary(residence) : "";

  return {
    ...identity,
    fromLocation,
    residence,
  };
}

export async function getMedicalRepExpenseContext(access: AccessContext) {
  const identity = await getMedicalRepExpenseIdentity(access);

  return {
    employeeArea: identity.employeeArea,
    employeeHrId: identity.employeeHrId,
    employeeLine: identity.employeeLine,
    employeeName: identity.employeeName,
    employeeRole: identity.employeeRole,
    fromLocation: identity.fromLocation,
    residence: identity.residence,
  };
}

export async function getResidenceLocationForEmployee(employeeHrId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employee_locations")
    .select("*")
    .ilike("employee_hr_id", employeeHrId)
    .maybeSingle();

  if (error) {
    if (isMissingSupabaseRelation(error)) {
      return null;
    }
    throw new Error(error.message);
  }

  if (!data) {
    return null;
  }

  const residence: EmployeeResidenceLocation = {
    employeeHrId: text(data.employee_hr_id),
    geocodeStatus: text(data.geocode_status) || null,
    residenceAddress: text(data.residence_address) || null,
    residenceArea: text(data.residence_area) || null,
    residenceCity: text(data.residence_city) || null,
    residenceLatitude: nullableNumber(data.residence_latitude),
    residenceLongitude: nullableNumber(data.residence_longitude),
  };

  if (
    (residence.residenceLatitude == null || residence.residenceLongitude == null) &&
    residence.residenceAddress
  ) {
    const geocoded = await googleGeocodeAddress(
      [
        residence.residenceAddress,
        residence.residenceArea,
        residence.residenceCity,
        "Egypt",
      ]
        .filter(Boolean)
        .join(", "),
    ).catch(() => null);

    if (geocoded) {
      await supabase
        .from("employee_locations")
        .update({
          geocode_status: "success",
          residence_latitude: geocoded.lat,
          residence_longitude: geocoded.lng,
          updated_at: new Date().toISOString(),
        })
        .ilike("employee_hr_id", employeeHrId);
      residence.residenceLatitude = geocoded.lat;
      residence.residenceLongitude = geocoded.lng;
      residence.geocodeStatus = "success";
    }
  }

  return residence;
}

export async function getOutstationPolicies() {
  const supabase = getSupabaseAdmin();
  const queryColumns =
    "active,created_at,fuel_rate_per_km,gps_accuracy_threshold_meters,id,max_offline_sync_delay_hours,minimum_distance_km,overnight_allowance,requires_ticket_attachment,return_day_allowance,role_name,same_day_allowance,updated_at";

  const executePolicyQuery = async (includeTolerance: boolean) =>
    includeTolerance
      ? supabase
          .from("outstation_policy_rules")
          .select("*")
          .order("role_name", { ascending: true })
      : supabase
          .from("outstation_policy_rules")
          .select(queryColumns)
          .order("role_name", { ascending: true });

  let includeTolerance = true;
  let { data, error } = await executePolicyQuery(true);

  if (error && isMissingTolerancePolicyColumn(error)) {
    ({ data, error } = await executePolicyQuery(false));
    includeTolerance = false;
  }

  if (error) {
    throw new Error(error.message);
  }

  return ((data ?? []) as Array<Record<string, unknown>>).map<OutstationPolicyRule>((row) => ({
    active: Boolean(row.active),
    createdAt: isoString(row.created_at),
    fuelRatePerKm: numberValue(row.fuel_rate_per_km),
    gpsAccuracyThresholdMeters: numberValue(row.gps_accuracy_threshold_meters || 100),
    id: Number(row.id),
    maxOfflineSyncDelayHours: numberValue(row.max_offline_sync_delay_hours || 8),
    minimumDistanceKm: numberValue(row.minimum_distance_km),
    toleranceMinimumDistanceKm: includeTolerance
      ? nullableNumber(row.tolerance_minimum_distance_km)
      : null,
    overnightAllowance: numberValue(row.overnight_allowance),
    requiresTicketAttachment: Boolean(row.requires_ticket_attachment),
    returnDayAllowance: numberValue(row.return_day_allowance),
    roleName: text(row.role_name),
    sameDayAllowance: numberValue(row.same_day_allowance),
    updatedAt: isoString(row.updated_at),
  }));
}

async function getActivePolicyForRole(roleName: string) {
  const policies = await getOutstationPolicies();
  const exact = policies.find(
    (policy) => policy.active && policy.roleName.toLowerCase() === roleName.toLowerCase(),
  );
  if (exact) return exact;

  const fallback = policies.find(
    (policy) =>
      policy.active &&
      (policy.roleName.toLowerCase() === "employee" ||
        policy.roleName.toLowerCase() === "medical rep"),
  );

  if (!fallback) {
    throw new Error(`No active outstation policy was found for role ${roleName}.`);
  }

  return fallback;
}

async function getLatestValidationSignal(employeeHrId: string): Promise<ValidationSignal | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outstation_location_audit_logs")
    .select("captured_latitude,captured_longitude,previous_captured_at,created_at")
    .ilike("employee_hr_id", employeeHrId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  return {
    capturedAt: isoString(data.previous_captured_at || data.created_at) || null,
    capturedLatitude: nullableNumber(data.captured_latitude),
    capturedLongitude: nullableNumber(data.captured_longitude),
  };
}

async function getCachedRoute(params: {
  capturedLatitude: number;
  capturedLongitude: number;
  employeeHrId: string;
  residenceLatitude: number;
  residenceLongitude: number;
}) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .select("distance_km,duration_minutes,route_polyline")
    .ilike("employee_hr_id", params.employeeHrId)
    .eq("residence_latitude", roundCoordinate(params.residenceLatitude))
    .eq("residence_longitude", roundCoordinate(params.residenceLongitude))
    .eq("captured_latitude", roundCoordinate(params.capturedLatitude))
    .eq("captured_longitude", roundCoordinate(params.capturedLongitude))
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return {
    distanceKm: nullableNumber(data.distance_km),
    durationMinutes: nullableNumber(data.duration_minutes),
    routePolyline: text(data.route_polyline) || null,
  };
}

async function validateTerritory(input: {
  capturedArea: string | null;
  capturedCity: string | null;
  employeeArea: string | null;
}) {
  const normalizedCapturedArea = normalizeArea(input.capturedArea);
  const employeeAreaKey = normalizeArea(input.employeeArea);

  if (employeeAreaKey && normalizedCapturedArea && employeeAreaKey === normalizedCapturedArea) {
    return {
      reason: "Captured destination matches the employee area assignment.",
      status: "matched" as OutstationTerritoryValidationStatus,
    };
  }

  if (employeeAreaKey && normalizedCapturedArea && employeeAreaKey !== normalizedCapturedArea) {
    return {
      reason:
        "Captured destination is outside the employee's assigned area and should be reviewed manually.",
      status: "outside_expected_territory" as OutstationTerritoryValidationStatus,
    };
  }

  return {
    reason: "Employee area or captured destination area is not available for territory validation.",
    status: "not_available" as OutstationTerritoryValidationStatus,
  };
}

function buildSuspiciousScore(flags: OutstationFraudFlag[]) {
  const weights: Record<OutstationFraudFlag, number> = {
    distance_below_policy: 90,
    impossible_speed: 50,
    location_permission_denied: 80,
    missing_residence_location: 90,
    missing_ticket_attachments: 25,
    offline_delay: 25,
    outside_expected_territory: 20,
    poor_accuracy: 20,
    repeated_same_coordinates: 15,
    timestamp_mismatch: 25,
  };

  return Math.min(
    100,
    flags.reduce((sum, flag) => sum + (weights[flag] ?? 0), 0),
  );
}

async function insertAuditLog(input: {
  capturedAccuracyMeters: number;
  capturedLatitude: number;
  capturedLongitude: number;
  distanceKm: number | null;
  durationMinutes: number | null;
  employeeHrId: string;
  expenseRequestId?: number | null;
  fraudFlags: OutstationFraudFlag[];
  previousCapturedAt: string | null;
  previousLatitude: number | null;
  previousLongitude: number | null;
  residenceLatitude: number | null;
  residenceLongitude: number | null;
  speedCheckResult: string;
  suspiciousLocationScore: number;
  territoryCheckResult: string;
  timestampCheckResult: string;
  validationReason: string;
  validationResult: OutstationEligibilityStatus | "error";
}) {
  const supabase = getSupabaseAdmin();
  await supabase.from("outstation_location_audit_logs").insert({
    accuracy_check_result: input.fraudFlags.includes("poor_accuracy") ? "poor_accuracy" : "ok",
    calculated_distance_km: input.distanceKm,
    captured_accuracy_meters: input.capturedAccuracyMeters,
    captured_latitude: roundCoordinate(input.capturedLatitude),
    captured_longitude: roundCoordinate(input.capturedLongitude),
    created_at: new Date().toISOString(),
    distance_km: input.distanceKm,
    duration_minutes: input.durationMinutes,
    employee_hr_id: input.employeeHrId,
    expense_request_id: input.expenseRequestId ?? null,
    fraud_flags_json: JSON.stringify(input.fraudFlags),
    previous_captured_at: input.previousCapturedAt,
    previous_latitude:
      input.previousLatitude != null ? roundCoordinate(input.previousLatitude) : null,
    previous_longitude:
      input.previousLongitude != null ? roundCoordinate(input.previousLongitude) : null,
    residence_latitude:
      input.residenceLatitude != null ? roundCoordinate(input.residenceLatitude) : null,
    residence_longitude:
      input.residenceLongitude != null ? roundCoordinate(input.residenceLongitude) : null,
    speed_check_result: input.speedCheckResult,
    suspicious_location_score: input.suspiciousLocationScore,
    territory_check_result: input.territoryCheckResult,
    timestamp_check_result: input.timestampCheckResult,
    validation_reason: input.validationReason,
    validation_result: input.validationResult,
  });
}

async function validateCapturedLocation(
  params: ValidationContext,
): Promise<ValidatedLocationBundle> {
  const identity = await getEmployeeIdentity(params.access);
  const policy = await getActivePolicyForRole(identity.employeeRole);
  const residence = await getResidenceLocationForEmployee(identity.employeeHrId);
  const fraudFlags: OutstationFraudFlag[] = [];
  const submittedAt = new Date().toISOString();

  if (
    !residence ||
    residence.residenceLatitude == null ||
    residence.residenceLongitude == null
  ) {
    fraudFlags.push("missing_residence_location");
    const reason =
      "Your registered residence location is missing or invalid. Please contact HR before submitting an outstation request.";
    const score = buildSuspiciousScore(fraudFlags);
    await insertAuditLog({
      capturedAccuracyMeters: params.capturedAccuracyMeters,
      capturedLatitude: params.capturedLatitude,
      capturedLongitude: params.capturedLongitude,
      distanceKm: null,
      durationMinutes: null,
      employeeHrId: identity.employeeHrId,
      fraudFlags,
      previousCapturedAt: null,
      previousLatitude: null,
      previousLongitude: null,
      residenceLatitude: residence?.residenceLatitude ?? null,
      residenceLongitude: residence?.residenceLongitude ?? null,
      speedCheckResult: "missing_residence_location",
      suspiciousLocationScore: score,
      territoryCheckResult: "not_available",
      timestampCheckResult: "missing_residence_location",
      validationReason: reason,
      validationResult: "error",
    });
    throw new Error(reason);
  }

  let eligibilityStatus: OutstationEligibilityStatus = "eligible";
  let eligibilityReason = "Captured location is eligible for outstation calculation.";

  if (params.capturedAccuracyMeters > policy.gpsAccuracyThresholdMeters) {
    fraudFlags.push("poor_accuracy");
    eligibilityStatus = "needs_review";
    eligibilityReason =
      "Captured GPS accuracy is weaker than the policy threshold and requires manager review.";
  }

  const capturedAt = isoString(params.capturedAt) || submittedAt;
  const capturedAgeHours = hoursBetween(capturedAt, submittedAt);
  if (capturedAgeHours != null) {
    if (params.offlineCaptured && capturedAgeHours > policy.maxOfflineSyncDelayHours) {
      fraudFlags.push("offline_delay");
      eligibilityStatus = "needs_review";
      eligibilityReason =
        "Offline-captured trip was synced too late and now requires manual review.";
    } else if (!params.offlineCaptured && capturedAgeHours > 0.25) {
      fraudFlags.push("timestamp_mismatch");
      eligibilityStatus = "needs_review";
      eligibilityReason =
        "Captured timestamp differs materially from the server timestamp and needs review.";
    }
  }

  const latestSignal = await getLatestValidationSignal(identity.employeeHrId);
  if (
    latestSignal?.capturedLatitude != null &&
    latestSignal?.capturedLongitude != null &&
    latestSignal.capturedAt !== capturedAt &&
    roundCoordinate(latestSignal.capturedLatitude) === roundCoordinate(params.capturedLatitude) &&
    roundCoordinate(latestSignal.capturedLongitude) === roundCoordinate(params.capturedLongitude)
  ) {
    fraudFlags.push("repeated_same_coordinates");
  }

  let polyline: string | null = null;
  let durationMinutes: number | null = null;
  let distanceKm: number | null = null;
  let routeAlternatives: OutstationRouteAlternative[] = [];
  let selectedRouteIndex: number | null = null;
  let selectedRouteReason: "fastest_duration" | null = null;
  let routeError: string | null = null;

  try {
    const directions = await googleDirectionsRoute(
      {
        lat: residence.residenceLatitude,
        lng: residence.residenceLongitude,
      },
      {
        lat: params.capturedLatitude,
        lng: params.capturedLongitude,
      },
    );
    if (directions.distanceMeters != null) {
      distanceKm = Number((directions.distanceMeters / 1000).toFixed(2));
    }
    durationMinutes =
      minutesFromSeconds(directions.durationInTrafficSeconds) ??
      minutesFromSeconds(directions.durationSeconds);
    polyline = directions.polyline;
    selectedRouteIndex = directions.selectedRouteIndex;
    selectedRouteReason = directions.selectedRouteIndex != null ? "fastest_duration" : null;
    routeAlternatives = directions.alternatives.map((route) => ({
      distanceKm:
        route.distanceMeters != null ? Number((route.distanceMeters / 1000).toFixed(2)) : null,
      durationInTrafficMinutes: minutesFromSeconds(route.durationInTrafficSeconds),
      durationMinutes: minutesFromSeconds(route.durationSeconds),
      encodedPolyline: route.encodedPolyline,
      index: route.index,
      isSelected: route.isSelected,
      summary: route.summary,
    }));
  } catch (error) {
    routeError =
      error instanceof Error
        ? error.message
        : "Google Routes API failed to calculate the driving route.";
  }

  if (distanceKm == null || durationMinutes == null || polyline == null) {
    const route = await getCachedRoute({
      capturedLatitude: params.capturedLatitude,
      capturedLongitude: params.capturedLongitude,
      employeeHrId: identity.employeeHrId,
      residenceLatitude: residence.residenceLatitude,
      residenceLongitude: residence.residenceLongitude,
    });

    polyline = polyline ?? route?.routePolyline ?? null;
    durationMinutes = durationMinutes ?? route?.durationMinutes ?? null;
    distanceKm = distanceKm ?? route?.distanceKm ?? null;

    if (distanceKm != null || durationMinutes != null || polyline != null) {
      routeError = null;
    }
  }

  let speedCheckResult = "no_previous_signal";
  if (
    latestSignal?.capturedAt &&
    latestSignal.capturedAt !== capturedAt &&
    latestSignal.capturedLatitude != null &&
    latestSignal.capturedLongitude != null
  ) {
    const previousDistance = await googleDistanceMatrix(
      {
        lat: latestSignal.capturedLatitude,
        lng: latestSignal.capturedLongitude,
      },
      {
        lat: params.capturedLatitude,
        lng: params.capturedLongitude,
      },
    );
    const hours = hoursBetween(latestSignal.capturedAt, capturedAt);
    const previousDistanceKm =
      previousDistance.distanceMeters != null ? previousDistance.distanceMeters / 1000 : null;
    const speedKmPerHour =
      previousDistanceKm != null && hours && hours > 0 ? previousDistanceKm / hours : null;
    if (speedKmPerHour != null && speedKmPerHour > 180) {
      fraudFlags.push("impossible_speed");
      eligibilityStatus = "needs_review";
      eligibilityReason =
        "Movement speed between captured points is too high to trust automatically.";
      speedCheckResult = `impossible_speed:${speedKmPerHour.toFixed(1)}kmh`;
    } else if (speedKmPerHour != null) {
      speedCheckResult = `ok:${speedKmPerHour.toFixed(1)}kmh`;
    }
  }

  const distanceEligibility = classifyOutstationExpenseEligibility({
    actualDistanceKm: distanceKm,
    policy: {
      officialMinimumDistanceKm: policy.minimumDistanceKm,
      toleranceMinimumDistanceKm: policy.toleranceMinimumDistanceKm,
    },
  });
  const distanceReason =
    distanceEligibility.classification === "missing_distance" && routeError
      ? `Distance could not be validated against Google Maps. ${routeError}`
      : distanceEligibility.reason;

  if (distanceEligibility.classification === "not_eligible") {
    fraudFlags.push("distance_below_policy");
    eligibilityStatus = "not_eligible";
    eligibilityReason = distanceReason;
  } else if (distanceEligibility.classification === "tolerance_eligible") {
    eligibilityReason =
      eligibilityStatus === "eligible"
        ? distanceReason
        : `${eligibilityReason} ${distanceReason}`;
    eligibilityStatus = "needs_review";
  } else if (
    distanceEligibility.classification === "missing_distance" ||
    distanceEligibility.classification === "invalid_distance" ||
    distanceEligibility.classification === "manual_exception"
  ) {
    eligibilityReason =
      eligibilityStatus === "eligible"
        ? distanceReason
        : `${eligibilityReason} ${distanceReason}`;
    eligibilityStatus = "needs_review";
  }

  const reverse = await googleReverseGeocode({
    lat: params.capturedLatitude,
    lng: params.capturedLongitude,
  }).catch(() => null);

  const territory = await validateTerritory({
    capturedArea: reverse?.area ?? null,
    capturedCity: reverse?.city ?? null,
    employeeArea: identity.employeeArea,
  });

  if (territory.status === "outside_expected_territory") {
    fraudFlags.push("outside_expected_territory");
    if (eligibilityStatus === "eligible") {
      eligibilityStatus = "needs_review";
      eligibilityReason =
        "Captured destination is outside the expected territory and needs manager review.";
    }
  }

  const suspiciousLocationScore = buildSuspiciousScore(fraudFlags);
  const result: OutstationCaptureResult = {
    capturedAccuracyMeters: params.capturedAccuracyMeters,
    capturedAt,
    capturedLatitude: params.capturedLatitude,
    capturedLocationSource: "browser_gps",
    capturedLongitude: params.capturedLongitude,
    distanceFromResidenceKm: distanceKm,
    durationMinutes,
    eligibilityReason,
    eligibilityStatus,
    employeeArea: identity.employeeArea,
    employeeHrId: identity.employeeHrId,
    employeeLine: identity.employeeLine,
    employeeName: identity.employeeName,
    employeeRole: identity.employeeRole,
    fraudFlags,
    minimumRequiredDistanceKm: policy.minimumDistanceKm,
    residenceLatitude: residence.residenceLatitude,
    residenceLongitude: residence.residenceLongitude,
    routeAlternatives,
    routePolyline: polyline,
    routeProvider: "google_maps",
    routeError,
    selectedRouteIndex,
    selectedRouteReason,
    submittedAt,
    suspiciousLocationScore,
    territoryValidationReason: territory.reason,
    territoryValidationStatus: territory.status,
    toArea: reverse?.area ?? null,
    toCity: reverse?.city ?? null,
    toLabel: reverse?.formattedAddress ?? null,
  };

  await insertAuditLog({
    capturedAccuracyMeters: params.capturedAccuracyMeters,
    capturedLatitude: params.capturedLatitude,
    capturedLongitude: params.capturedLongitude,
    distanceKm,
    durationMinutes,
    employeeHrId: identity.employeeHrId,
    fraudFlags,
    previousCapturedAt: latestSignal?.capturedAt ?? null,
    previousLatitude: latestSignal?.capturedLatitude ?? null,
    previousLongitude: latestSignal?.capturedLongitude ?? null,
    residenceLatitude: residence.residenceLatitude,
    residenceLongitude: residence.residenceLongitude,
    speedCheckResult,
    suspiciousLocationScore,
    territoryCheckResult: territory.status,
    timestampCheckResult:
      fraudFlags.includes("offline_delay") || fraudFlags.includes("timestamp_mismatch")
        ? "review_required"
        : "ok",
    validationReason: eligibilityReason,
    validationResult: eligibilityStatus,
  });

  return {
    employee: identity.employee,
    identity,
    policy,
    residence,
    result,
  };
}

export async function captureOutstationLocation(
  access: AccessContext,
  input: {
    capturedAccuracyMeters: number;
    capturedAt?: string;
    capturedLatitude: number;
    capturedLongitude: number;
    offlineCaptured?: boolean;
  },
) {
  const validated = await validateCapturedLocation({ access, ...input });
  return validated.result;
}

export async function calculateOutstationExpense(
  access: AccessContext,
  input: OutstationCalculationInput,
) {
  const validated = await validateCapturedLocation({
    access,
    capturedAccuracyMeters: input.capturedAccuracyMeters,
    capturedAt: input.capturedAt,
    capturedLatitude: input.capturedLatitude,
    capturedLongitude: input.capturedLongitude,
    hasTicketAttachments: input.hasTicketAttachments,
    offlineCaptured: input.offlineCaptured,
  });
  const { policy, result } = validated;

  if (!input.tripStartDate || !input.tripEndDate) {
    throw new Error("Trip start and end dates are required.");
  }

  const tripStartDate = isoString(input.tripStartDate);
  const tripEndDate = isoString(input.tripEndDate);
  if (!tripStartDate || !tripEndDate) {
    throw new Error("Trip dates are invalid.");
  }

  const allowance = calculateAllowanceBreakdown(tripStartDate, tripEndDate, policy);
  let fuelAmount = 0;
  let ticketAmount = 0;
  if (input.transportationType === "car") {
    const distanceKm = result.distanceFromResidenceKm ?? 0;
    fuelAmount = roundMoney(distanceKm * 2 * policy.fuelRatePerKm);
  } else if (input.transportationType === "train" || input.transportationType === "bus") {
    ticketAmount = roundMoney(
      numberValue(input.goTicketAmount) + numberValue(input.returnTicketAmount),
    );
    if (policy.requiresTicketAttachment && !input.hasTicketAttachments) {
      if (!result.fraudFlags.includes("missing_ticket_attachments")) {
        result.fraudFlags.push("missing_ticket_attachments");
      }
      if (result.eligibilityStatus === "eligible") {
        result.eligibilityStatus = "needs_review";
        result.eligibilityReason =
          "Ticket-based trips require attachment evidence before the request can move forward.";
      }
    }
  }

  const computedTravelCost = roundMoney(fuelAmount + ticketAmount);
  const reportTravelCost = optionalPositiveMoney(input.travelCostAmount) ?? computedTravelCost;
  const reportMeetingAmount = positiveMoney(input.meetingAmount);
  const reportOtherAmount = positiveMoney(input.otherAmount);
  const expectedTotalAmount =
    reportExpectedTotal({
      allowanceAmount: allowance.allowanceAmount,
      eligibilityStatus: result.eligibilityStatus,
      meetingAmount: reportMeetingAmount,
      otherAmount: reportOtherAmount,
      travelCost: reportTravelCost,
    });
  const inputClaimedTotalAmount = numberValue(input.claimedTotalAmount);
  const claimedTotalAmount =
    inputClaimedTotalAmount > 0 ? inputClaimedTotalAmount : expectedTotalAmount;
  const varianceAmount = roundMoney(claimedTotalAmount - expectedTotalAmount);
  const variancePercent =
    expectedTotalAmount > 0
      ? roundMoney((varianceAmount / expectedTotalAmount) * 100)
      : 0;
  const calculationStatus =
    result.eligibilityStatus === "not_eligible" ? "blocked" : "calculated";
  const recommendation = recommendationForResult({
    eligibilityStatus: result.eligibilityStatus,
    fraudFlags: result.fraudFlags,
    hasTicketAttachments: Boolean(input.hasTicketAttachments),
    policy,
    suspiciousLocationScore: buildSuspiciousScore(result.fraudFlags),
    territoryValidationStatus: result.territoryValidationStatus,
    transportationType: input.transportationType,
    variancePercent,
  });

  const calculation: OutstationCalculationResult = {
    ...result,
    allowanceAmount: allowance.allowanceAmount,
    allowanceBreakdown: allowance.breakdown,
    attachmentCount: Math.max(0, Math.trunc(numberValue(input.attachmentCount))),
    approvalReason: recommendation.approvalReason,
    approvalRecommendation: recommendation.approvalRecommendation,
    calculationStatus,
    claimedTotalAmount,
    expenseType: input.expenseType,
    expectedTotalAmount,
    fuelAmount,
    kilometerReading:
      input.kilometerReading == null ? null : numberValue(input.kilometerReading),
    medicalTripHrId: cleanText(input.medicalTripHrId) ?? null,
    medicalTripName: cleanText(input.medicalTripName) ?? null,
    notes: cleanText(input.notes) ?? null,
    offlineCaptured: Boolean(input.offlineCaptured),
    overnightDays: allowance.overnightDays,
    reportAmWorkload: positiveMoney(input.amWorkload),
    reportHrNotes: cleanText(input.hrNotes),
    reportHrStatus: cleanText(input.hrStatus),
    reportMeetingAmount,
    reportOtherAmount,
    reportPmWorkload: positiveMoney(input.pmWorkload),
    reportTravelCost,
    reportTripType: reportTripTypeLabel({
      override: input.tripType,
      overnightDays: allowance.overnightDays,
      sameDayTrip: allowance.sameDayTrip,
    }),
    sameDayTrip: allowance.sameDayTrip,
    suspiciousLocationScore: buildSuspiciousScore(result.fraudFlags),
    ticketAmount,
    carEvidenceImagePath: null,
    carEvidenceMetadata: input.carEvidenceMetadata,
    transportationType: input.transportationType,
    tripEndDate,
    tripStartDate,
    varianceAmount,
    variancePercent,
  };

  return calculation;
}

// ── Approval notifications ────────────────────────────────────────────────────
// The expenses/outstation workflow historically sent NO notifications (a confirmed
// gap in the workflow map). These best-effort dispatch helpers close that gap:
// on submit we alert the submitter's direct manager + HR manager(s) ("approval
// needed"); on a decision we tell the submitting employee the outcome. Every send
// is wrapped so a notification failure can never roll back or fail the underlying
// submit/approve/reject. We use module "outstation" (already Telegram-enabled, maps
// to the in-app "general" bell category and the "general" email type) with explicit
// recipients + channels, so no notification policy/governance changes are needed.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function outstationActionCenterUrl(requestId: number | string) {
  return `/admin/approvals-hub?module=outstation&id=${encodeURIComponent(String(requestId))}`;
}
const OUTSTATION_EMPLOYEE_PORTAL_URL = "/employee-portals/expenses";

function formatEgp(value: number) {
  return `${Number(value || 0).toLocaleString("en-EG", { maximumFractionDigits: 2 })} EGP`;
}

type OutstationNotifyRecipient = { email: string | null; hrId: string; name: string; role: "direct_manager" | "hr" };

// Resolve who must act when an expense/outstation request is submitted: the
// submitter's direct manager + the approver(s) (Super Admin accounts, e.g. the B-10 HR
// manager). A-16 is intentionally excluded because it has no
// outstation "approve" authority, so an "approval needed" alert there is a dead end.
// Best-effort: a missing manager or a failed approver lookup is logged and skipped,
// never thrown — notifications must not block a submit.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function resolveOutstationApprovalRecipients(
  directory: EmployeeDirectoryData,
  employee: EmployeeDirectoryRow,
): Promise<OutstationNotifyRecipient[]> {
  const byHrId = (hrId: string | null | undefined) =>
    hrId
      ? directory.employees.find(
          (row) => normalizeHrIdForAccess(row.hrId) === normalizeHrIdForAccess(hrId),
        ) ?? null
      : null;

  const recipients = new Map<string, OutstationNotifyRecipient>();
  const add = (hrId: string | null | undefined, name: string | null | undefined, email: string | null | undefined, role: OutstationNotifyRecipient["role"]) => {
    const key = normalizeHrIdForAccess(hrId);
    if (!key || recipients.has(key)) return;
    recipients.set(key, { email: pickDeliverableEmail(email), hrId: String(hrId), name: name?.trim() || String(hrId), role });
  };

  // 1. Direct manager of the submitter.
  if (employee.managerHrId) {
    const manager = byHrId(employee.managerHrId);
    if (manager?.hrId) add(manager.hrId, manager.fullName, manager.workEmail, "direct_manager");
    else console.warn("[outstation] direct manager unresolved; manager notification skipped", { employeeHrId: employee.hrId, managerHrId: employee.managerHrId });
  }

  // 2. Approver(s): Super Admin accounts only. A-16 is
  //    deliberately NOT included: A-16 is HR review/follow-up and holds NO outstation
  //    "approve" permission (see 20260522203000_hr_manager_approval_authority.sql), so an
  //    "approval needed" alert to A-16 would be a dead end. B-10 is the Super Admin HR
  //    approver and is covered by this query.
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("app_auth_users")
      .select("hr_id,role,is_active")
      .eq("is_active", true)
      .eq("role", "Super Admin");
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ hr_id?: string | null; role?: string | null }>) {
      const hrId = text(row.hr_id);
      if (!hrId || text(row.role) !== "Super Admin") continue;
      const directoryRow = byHrId(hrId);
      add(directoryRow?.hrId ?? hrId, directoryRow?.fullName ?? hrId, directoryRow?.workEmail, "hr");
    }
  } catch (error) {
    console.error("[outstation] approver lookup failed; approval alert may be incomplete", error);
  }

  return [...recipients.values()];
}

// Rejection notification to the submitting employee. This is the ONLY email sent for
// outstation/expenses — HR Manager rejects violations; approvals are silent (auto-approve).
async function notifyOutstationDecision(input: {
  comment?: string | null;
  decision: "reject";
  request: OutstationExpenseRequest;
}) {
  try {
    const r = input.request;
    const amount = formatEgp(r.claimedTotalAmount || r.expectedTotalAmount);
    const reason = text(input.comment);
    await Promise.allSettled([
      createSystemNotification({
        actionUrl: OUTSTATION_EMPLOYEE_PORTAL_URL,
        category: "general",
        channels: ["in_app", "email", "telegram"],
        email: {
          metrics: [
            { label: "Employee", value: r.employeeName },
            { label: "Amount", value: amount },
            { label: "Destination", value: text(r.toLabel) },
            { label: "Trip start", value: r.tripStartDate },
            { label: "Trip end", value: r.tripEndDate },
          ],
        },
        eventType: "request_rejected",
        message: `Your expense request for ${amount} (${r.tripStartDate} to ${r.tripEndDate}) was rejected. Reason: ${reason}`,
        metadata: {
          actionUrl: OUTSTATION_EMPLOYEE_PORTAL_URL,
          amount,
          decision: input.decision,
          employeeHrId: r.employeeHrId,
          employeeName: r.employeeName,
          idempotencyKey: `outstation:${r.id}:request_rejected:${r.employeeHrId.toUpperCase()}`,
          rejectionReason: reason,
          requestId: String(r.id),
          requestUrl: OUTSTATION_EMPLOYEE_PORTAL_URL,
          status: "Rejected",
        },
        module: "outstation",
        priority: "normal",
        recipientHrId: r.employeeHrId,
        recordId: String(r.id),
        subjectHrId: r.employeeHrId,
        telegram: { buttons: [{ label: "Open Phoenix", url: OUTSTATION_EMPLOYEE_PORTAL_URL }] },
        title: "Your expense request was rejected",
      }),
    ]);
  } catch (error) {
    console.error("[outstation] decision notification dispatch failed (non-blocking)", error);
  }
}

export async function submitOutstationRequest(
  access: AccessContext,
  input: OutstationCalculationInput,
) {
  const calculation = await calculateOutstationExpense(access, input);
  const evidenceValidation = validateLiveCarEvidence({
    carEvidenceMetadata: input.carEvidenceMetadata,
    transportationType: input.transportationType,
  });

  if (!evidenceValidation.isValid) {
    throw new Error(evidenceValidation.message);
  }

  if (calculation.eligibilityStatus === "not_eligible") {
    throw new Error(calculation.eligibilityReason);
  }

  await assertOutstationExpenseWorkflowTransition({
    access,
    actionKey: "submit",
    expectedNextStatus: "pending",
    status: "draft",
  });

  const identity = await getEmployeeIdentity(access);
  const residence = await getResidenceLocationForEmployee(identity.employeeHrId);
  const supabase = getSupabaseAdmin();
  const storedCarEvidenceMetadata =
    calculation.transportationType === "car" && input.carEvidenceMetadata
      ? {
          ...input.carEvidenceMetadata,
          employeeHrId: calculation.employeeHrId,
          requestId: input.carEvidenceMetadata.requestId ?? null,
        }
      : null;
  let carEvidenceImagePath: string | null = null;

  if (calculation.transportationType === "car") {
    if (!input.carEvidenceImageDataUrl) {
      throw new Error("Car transport requires the live camera evidence image before submitting the request.");
    }
    if (!storedCarEvidenceMetadata) {
      throw new Error("Car live camera evidence metadata is missing.");
    }

    carEvidenceImagePath = await uploadOutstationCarEvidenceImage({
      imageDataUrl: input.carEvidenceImageDataUrl,
      metadata: storedCarEvidenceMetadata,
    });
  }

  const workloadPayload = await resolveOutstationWorkloadPayload({
    employeeHrId: calculation.employeeHrId,
    tripEndDate: calculation.tripEndDate,
    tripStartDate: calculation.tripStartDate,
  });

  const insertPayload = {
    allowance_amount: calculation.allowanceAmount,
    allowance_breakdown_json: JSON.stringify(calculation.allowanceBreakdown),
    attachment_count: calculation.attachmentCount,
    approval_reason: calculation.approvalReason,
    approval_recommendation: calculation.approvalRecommendation,
    area: calculation.employeeArea,
    calculation_status: "submitted",
    captured_accuracy_meters: calculation.capturedAccuracyMeters,
    captured_at: calculation.capturedAt,
    captured_latitude: calculation.capturedLatitude,
    captured_location_source: calculation.capturedLocationSource,
    captured_longitude: calculation.capturedLongitude,
    car_evidence_image_path: carEvidenceImagePath,
    car_evidence_metadata: storedCarEvidenceMetadata,
    claimed_total_amount: input.claimedTotalAmount,
    distance_from_residence_km: calculation.distanceFromResidenceKm,
    distance_km: calculation.distanceFromResidenceKm,
    duration_minutes: calculation.durationMinutes,
    expense_type: calculation.expenseType,
    eligibility_reason: calculation.eligibilityReason,
    eligibility_status: calculation.eligibilityStatus,
    employee_hr_id: calculation.employeeHrId,
    employee_name: calculation.employeeName,
    employee_role: calculation.employeeRole,
    expected_total_amount: calculation.expectedTotalAmount,
    fraud_flags_json: JSON.stringify(calculation.fraudFlags),
    fuel_amount: calculation.fuelAmount,
    kilometer_reading: calculation.kilometerReading,
    line: calculation.employeeLine,
    medical_trip_hr_id: calculation.medicalTripHrId,
    medical_trip_name: calculation.medicalTripName,
    minimum_required_distance_km: calculation.minimumRequiredDistanceKm,
    notes: appendCarEvidenceNote(calculation.notes, storedCarEvidenceMetadata),
    offline_captured: calculation.offlineCaptured,
    overnight_days: calculation.overnightDays,
    report_am_workload: calculation.reportAmWorkload,
    report_hr_notes: calculation.reportHrNotes,
    report_hr_status: calculation.reportHrStatus,
    report_meeting_amount: calculation.reportMeetingAmount,
    report_other_amount: calculation.reportOtherAmount,
    report_pm_workload: calculation.reportPmWorkload,
    report_travel_cost: calculation.reportTravelCost,
    report_trip_type: calculation.reportTripType,
    residence_address: residence?.residenceAddress ?? null,
    residence_area: residence?.residenceArea ?? null,
    residence_city: residence?.residenceCity ?? null,
    residence_latitude: residence?.residenceLatitude ?? null,
    residence_longitude: residence?.residenceLongitude ?? null,
    route_polyline: calculation.routePolyline,
    same_day_trip: calculation.sameDayTrip,
    status: "submitted",
    submitted_at: calculation.submittedAt,
    suspicious_location_score: calculation.suspiciousLocationScore,
    territory_validation_status: calculation.territoryValidationStatus,
    territory_validation_reason: calculation.territoryValidationReason,
    ...workloadPayload,
    meeting_amount: input.meetingAmount ?? 0,
    other_amount: input.otherAmount ?? 0,
    ticket_amount: calculation.ticketAmount,
    to_area: calculation.toArea,
    to_city: calculation.toCity,
    to_label: calculation.toLabel,
    transportation_type: calculation.transportationType,
    trip_end_date: calculation.tripEndDate,
    trip_start_date: calculation.tripStartDate,
    variance_amount: calculation.varianceAmount,
    variance_percent: calculation.variancePercent,
  };

  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .insert(insertPayload)
    .select("*")
    .single();

  if (error) {
    await deleteOutstationCarEvidenceImage(carEvidenceImagePath);
    throw new Error(error.message);
  }

  const requestId = String(data.id);
  const metadataWithRequestId = storedCarEvidenceMetadata
    ? {
        ...storedCarEvidenceMetadata,
        requestId,
      }
    : null;
  let persistedCarEvidenceMetadata = storedCarEvidenceMetadata;

  if (metadataWithRequestId) {
    const { error: metadataUpdateError } = await supabase
      .from("outstation_expense_requests")
      .update({
        car_evidence_metadata: metadataWithRequestId,
        notes: appendCarEvidenceNote(calculation.notes, metadataWithRequestId),
      })
      .eq("id", data.id);

    if (!metadataUpdateError) {
      persistedCarEvidenceMetadata = metadataWithRequestId;
    }
  }

  const previousSignal = await getLatestValidationSignal(calculation.employeeHrId);
  await insertAuditLog({
    capturedAccuracyMeters: calculation.capturedAccuracyMeters,
    capturedLatitude: calculation.capturedLatitude,
    capturedLongitude: calculation.capturedLongitude,
    distanceKm: calculation.distanceFromResidenceKm,
    durationMinutes: calculation.durationMinutes,
    employeeHrId: calculation.employeeHrId,
    expenseRequestId: Number(data.id),
    fraudFlags: calculation.fraudFlags,
    previousCapturedAt: previousSignal?.capturedAt ?? null,
    previousLatitude: previousSignal?.capturedLatitude ?? null,
    previousLongitude: previousSignal?.capturedLongitude ?? null,
    residenceLatitude: residence?.residenceLatitude ?? null,
    residenceLongitude: residence?.residenceLongitude ?? null,
    speedCheckResult: calculation.fraudFlags.includes("impossible_speed")
      ? "impossible_speed"
      : "ok",
    suspiciousLocationScore: calculation.suspiciousLocationScore,
    territoryCheckResult: calculation.territoryValidationStatus,
    timestampCheckResult:
      calculation.fraudFlags.includes("offline_delay") ||
      calculation.fraudFlags.includes("timestamp_mismatch")
        ? "review_required"
        : "ok",
    validationReason: calculation.eligibilityReason,
    validationResult: calculation.eligibilityStatus,
  });

  const submitted = mapOutstationRequestRow({
    ...data,
    car_evidence_image_path: carEvidenceImagePath,
    car_evidence_metadata: persistedCarEvidenceMetadata,
    notes: persistedCarEvidenceMetadata
      ? appendCarEvidenceNote(calculation.notes, persistedCarEvidenceMetadata)
      : data.notes,
  });
  await approveOutstationRequestForPayroll(submitted.id, systemAccessContext);
  return submitted;
}

export async function syncOfflineOutstationRequest(
  access: AccessContext,
  input: OutstationCalculationInput,
) {
  return submitOutstationRequest(access, {
    ...input,
    offlineCaptured: true,
  });
}

export async function updateOutstationPolicies(
  rules: Array<Partial<OutstationPolicyRule> & { roleName: string }>,
) {
  const supabase = getSupabaseAdmin();
  const payload = rules.map((rule) => ({
    active: rule.active ?? true,
    fuel_rate_per_km: numberValue(rule.fuelRatePerKm),
    gps_accuracy_threshold_meters: numberValue(rule.gpsAccuracyThresholdMeters || 100),
    max_offline_sync_delay_hours: numberValue(rule.maxOfflineSyncDelayHours || 8),
    minimum_distance_km: numberValue(rule.minimumDistanceKm),
    overnight_allowance: numberValue(rule.overnightAllowance),
    requires_ticket_attachment: Boolean(rule.requiresTicketAttachment),
    return_day_allowance: numberValue(rule.returnDayAllowance),
    role_name: rule.roleName,
    same_day_allowance: numberValue(rule.sameDayAllowance),
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from("outstation_policy_rules")
    .upsert(payload, { onConflict: "role_name" });

  if (error) {
    throw new Error(error.message);
  }

  return getOutstationPolicies();
}

function mapOutstationRequestRow(row: Record<string, unknown>): OutstationExpenseRequest {
  const expenseTypeRaw = text(row.expense_type).toLowerCase();
  const transportationTypeRaw = text(row.transportation_type).toLowerCase();
  const expenseType: OutstationExpenseType =
    expenseTypeRaw === "meeting" || expenseTypeRaw === "other"
      ? expenseTypeRaw
      : "traveling";
  const transportationType: OutstationTransportationType =
    transportationTypeRaw === "bus" ||
    transportationTypeRaw === "other" ||
    transportationTypeRaw === "train"
      ? transportationTypeRaw
      : transportationTypeRaw === "train_bus"
        ? "train"
        : "car";

  return {
    allowanceAmount: numberValue(row.allowance_amount),
    allowanceBreakdown: safeJsonParse(row.allowance_breakdown_json, null),
    attachmentCount: numberValue(row.attachment_count),
    approvalReason: text(row.approval_reason),
    approvalRecommendation: normalizeApprovalRecommendation(text(row.approval_recommendation)),
    capturedAccuracyMeters: numberValue(row.captured_accuracy_meters),
    capturedAt: isoString(row.captured_at),
    capturedLatitude: numberValue(row.captured_latitude),
    capturedLongitude: numberValue(row.captured_longitude),
    carEvidenceImagePath: text(row.car_evidence_image_path) || null,
    carEvidenceImageUrl: null,
    carEvidenceMetadata: safeJsonParse<OutstationCarEvidenceMetadata | null>(
      row.car_evidence_metadata,
      null,
    ),
    claimedTotalAmount: numberValue(row.claimed_total_amount),
    createdAt: isoString(row.created_at),
    distanceFromResidenceKm:
      row.distance_km != null
        ? numberValue(row.distance_km)
        : row.distance_from_residence_km != null
          ? numberValue(row.distance_from_residence_km)
          : null,
    durationMinutes: nullableNumber(row.duration_minutes),
    expenseType,
    eligibilityReason: text(row.eligibility_reason),
    eligibilityStatus: text(row.eligibility_status) as OutstationEligibilityStatus,
    employeeArea: text(row.area) || null,
    employeeHrId: text(row.employee_hr_id),
    employeeLine: text(row.line) || null,
    employeeName: text(row.employee_name),
    employeeRole: text(row.employee_role),
    expectedTotalAmount: numberValue(row.expected_total_amount),
    fraudFlags: safeJsonParse<OutstationFraudFlag[]>(row.fraud_flags_json, []),
    fuelAmount: numberValue(row.fuel_amount),
    goTicketAmount: numberValue(row.go_ticket_amount),
    id: Number(row.id),
    kilometerReading: nullableNumber(row.kilometer_reading),
    medicalTripHrId: text(row.medical_trip_hr_id) || null,
    medicalTripName: text(row.medical_trip_name) || null,
    minimumRequiredDistanceKm: numberValue(row.minimum_required_distance_km),
    notes: text(row.notes) || null,
    offlineCaptured: Boolean(row.offline_captured),
    overnightDays: numberValue(row.overnight_days),
    reportAmWorkload: numberValue(row.report_am_workload),
    reportHrNotes: text(row.report_hr_notes) || null,
    reportHrStatus: text(row.report_hr_status) || null,
    reportMeetingAmount: numberValue(row.report_meeting_amount),
    reportOtherAmount: numberValue(row.report_other_amount),
    reportPmWorkload: numberValue(row.report_pm_workload),
    reportTravelCost:
      row.report_travel_cost == null ? null : numberValue(row.report_travel_cost),
    reportTripType: text(row.report_trip_type) || null,
    residenceAddress: text(row.residence_address) || null,
    residenceArea: text(row.residence_area) || null,
    residenceCity: text(row.residence_city) || null,
    residenceLatitude: nullableNumber(row.residence_latitude),
    residenceLongitude: nullableNumber(row.residence_longitude),
    routePolyline: text(row.route_polyline) || null,
    routeError: null,
    sameDayTrip: Boolean(row.same_day_trip),
    status: text(row.status),
    submittedAt: isoString(row.submitted_at) || null,
    suspiciousLocationScore: numberValue(row.suspicious_location_score),
    territoryValidationReason: text(row.territory_validation_reason),
    territoryValidationStatus:
      text(row.territory_validation_status) as OutstationTerritoryValidationStatus,
    returnTicketAmount: numberValue(row.return_ticket_amount),
    ticketAttachmentMetadata: safeJsonParse<OutstationTicketAttachmentMetadata[]>(
      row.ticket_attachment_metadata,
      [],
    ),
    ticketAttachmentPaths: safeJsonParse<string[]>(row.ticket_attachment_paths, []),
    amWorkload: numberValue(row.am_workload),
    meetingAmount: numberValue(row.meeting_amount),
    otherAmount: numberValue(row.other_amount),
    pmWorkload: numberValue(row.pm_workload),
    workloadEvidenceSnapshot: safeJsonParse<DoubleVisitExpenseWorkloadEvidence | Record<string, unknown>>(
      row.workload_evidence_snapshot,
      {},
    ),
    workloadMatchedAt: isoString(row.workload_matched_at) || null,
    workloadMatchStatus: text(row.workload_match_status) || "manual",
    workloadOverrideReason: text(row.workload_override_reason) || null,
    workloadSource: text(row.workload_source) || "manual",
    workloadSourceImportId: text(row.workload_source_import_id) || null,
    ticketAmount: numberValue(row.ticket_amount),
    toArea: text(row.to_area) || null,
    toCity: text(row.to_city) || null,
    toCountry: text(row.to_country) || null,
    toLabel: text(row.to_label) || null,
    transportationType,
    tripEndDate: isoString(row.trip_end_date),
    tripStartDate: isoString(row.trip_start_date),
    updatedAt: isoString(row.updated_at),
    varianceAmount: numberValue(row.variance_amount),
    variancePercent: numberValue(row.variance_percent),
  };
}

async function attachCarEvidenceSignedUrls(
  requests: OutstationExpenseRequest[],
): Promise<OutstationExpenseRequest[]> {
  return Promise.all(
    requests.map(async (request) => {
      const carEvidenceImageUrl = await createOutstationCarEvidenceSignedUrl(
        request.carEvidenceImagePath,
      );

      return {
        ...request,
        carEvidenceImageUrl,
      };
    }),
  );
}

export async function listOutstationRequests(options?: { includeCarEvidenceSignedUrls?: boolean }) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  const requests = ((data ?? []) as Array<Record<string, unknown>>).map(mapOutstationRequestRow);
  return options?.includeCarEvidenceSignedUrls
    ? attachCarEvidenceSignedUrls(requests)
    : requests;
}

export async function getOutstationRequestById(
  requestId: number,
  options?: { includeCarEvidenceSignedUrl?: boolean },
) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .select("*")
    .eq("id", requestId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) return null;

  const request = mapOutstationRequestRow(data as Record<string, unknown>);
  if (!options?.includeCarEvidenceSignedUrl) return request;

  return {
    ...request,
    carEvidenceImageUrl: await createOutstationCarEvidenceSignedUrl(request.carEvidenceImagePath),
  };
}

export async function listMedicalRepExpenseRequests(access: AccessContext) {
  const identity = await getMedicalRepExpenseIdentity(access);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .select("*")
    .ilike("employee_hr_id", identity.employeeHrId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return ((data ?? []) as Array<Record<string, unknown>>).map(mapOutstationRequestRow);
}

export async function submitMedicalRepSimpleExpenseRequest(
  access: AccessContext,
  input: MedicalRepSimpleExpenseInput,
) {
  const identity = await getMedicalRepExpenseIdentity(access);
  const normalized = validateMedicalRepSimpleExpenseInput(input);

  if (!identity.fromLocation) {
    throw new Error("Residence location is not configured for your employee profile. Please contact HR.");
  }

  await assertOutstationExpenseWorkflowTransition({
    access,
    actionKey: "submit",
    expectedNextStatus: "pending",
    status: "draft",
  });

  const now = new Date().toISOString();
  const requestDraftId = `medical-rep-${randomUUID()}`;
  let uploadedAttachments: OutstationTicketAttachmentMetadata[] = [];

  try {
    uploadedAttachments = await uploadOutstationTicketAttachments(
      normalized.attachments.map((attachment) => ({
        ...attachment,
        employeeHrId: identity.employeeHrId,
        requestDraftId,
      })),
    );

    const overnightDays = daysBetween(normalized.tripStartDate, normalized.tripEndDate);
    const sameDayTrip = overnightDays === 0;
    const residence = identity.residence;
    const capturedLatitude = residence?.residenceLatitude ?? 0;
    const capturedLongitude = residence?.residenceLongitude ?? 0;
    const attachmentPaths = uploadedAttachments.map((attachment) => attachment.path);
    const workloadPayload = await resolveOutstationWorkloadPayload({
      employeeHrId: identity.employeeHrId,
      tripEndDate: normalized.tripEndDate,
      tripStartDate: normalized.tripStartDate,
    });
    const { data, error } = await getSupabaseAdmin()
      .from("outstation_expense_requests")
      .insert({
        allowance_amount: 0,
        allowance_breakdown_json: JSON.stringify({
          overnightDays,
          returnDayApplied: false,
          rows: [],
          sameDayTrip,
        }),
        approval_reason:
          "Medical rep manual traveling expense submitted without manager outstation distance rules.",
        approval_recommendation: "hr_review",
        area: identity.employeeArea,
        attachment_count: uploadedAttachments.length,
        calculation_status: "submitted",
        captured_accuracy_meters: 0,
        captured_at: now,
        captured_latitude: capturedLatitude,
        captured_location_source: "medical_rep_manual",
        captured_longitude: capturedLongitude,
        claimed_total_amount: normalized.ticketAmount,
        distance_from_residence_km: null,
        distance_km: null,
        duration_minutes: null,
        eligibility_reason:
          "Medical rep manual expense submission; no manager outstation rule was applied.",
        eligibility_status: "needs_review",
        employee_hr_id: identity.employeeHrId,
        employee_name: identity.employeeName,
        employee_role: "Medical Rep",
        expected_total_amount: normalized.ticketAmount,
        expense_type: "traveling",
        fraud_flags_json: JSON.stringify([]),
        fuel_amount: 0,
        go_ticket_amount: normalized.goTicketAmount,
        line: identity.employeeLine,
        minimum_required_distance_km: 0,
        notes: normalized.notes,
        offline_captured: false,
        overnight_days: overnightDays,
        residence_address: residence?.residenceAddress ?? null,
        residence_area: residence?.residenceArea ?? null,
        residence_city: residence?.residenceCity ?? null,
        residence_latitude: residence?.residenceLatitude ?? null,
        residence_longitude: residence?.residenceLongitude ?? null,
        return_ticket_amount: normalized.returnTicketAmount,
        route_polyline: null,
        same_day_trip: sameDayTrip,
        status: "submitted",
        submitted_at: now,
        suspicious_location_score: 0,
        ticket_amount: normalized.ticketAmount,
        ticket_attachment_metadata: uploadedAttachments,
        ticket_attachment_paths: attachmentPaths,
        ...workloadPayload,
        meeting_amount: 0,
        other_amount: 0,
        to_area: null,
        to_city: null,
        to_label: normalized.toLocation,
        transportation_type: "other",
        trip_end_date: normalized.tripEndDate,
        trip_start_date: normalized.tripStartDate,
        updated_at: now,
        variance_amount: 0,
        variance_percent: 0,
      })
      .select("*")
      .single();

    if (error) {
      throw new Error(error.message);
    }

    const submitted = mapOutstationRequestRow(data as Record<string, unknown>);
    await approveOutstationRequestForPayroll(submitted.id, systemAccessContext);
    return submitted;
  } catch (error) {
    await deleteOutstationTicketAttachments(
      uploadedAttachments.map((attachment) => attachment.path),
    );
    throw error;
  }
}

type LinkedOutstationPayrollExpense = {
  id: string;
  importedPayrollBatchId: string | null;
  importedToPayrollAt: string | null;
  reportId: string | null;
  tripId: string;
};

async function getLinkedOutstationPayrollExpense(
  requestId: number,
): Promise<LinkedOutstationPayrollExpense | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("payroll_expenses")
    .select("id,imported_payroll_batch_id,imported_to_payroll_at,report_id,trip_id")
    .eq("trip_id", outstationPayrollTripId(requestId))
    .maybeSingle();

  if (error) {
    if (isPayrollExpensesSchemaMissing(error)) return null;
    throw new Error(error.message);
  }

  if (!data) return null;

  return {
    id: String(data.id),
    importedPayrollBatchId: data.imported_payroll_batch_id
      ? String(data.imported_payroll_batch_id)
      : null,
    importedToPayrollAt: data.imported_to_payroll_at
      ? String(data.imported_to_payroll_at)
      : null,
    reportId: data.report_id ? String(data.report_id) : null,
    tripId: String(data.trip_id),
  };
}

async function syncLinkedOutstationPayrollExpense(input: {
  access: AccessContext;
  linkedPayroll: LinkedOutstationPayrollExpense | null;
  request: OutstationExpenseRequest;
}) {
  if (!input.linkedPayroll) return 0;
  if (input.request.status !== "approved") return 0;
  if (input.linkedPayroll.importedPayrollBatchId || input.linkedPayroll.importedToPayrollAt) {
    throw new Error("This outstation expense has already been added to payroll and cannot be edited.");
  }

  const expenseRecord = mapOutstationRequestToPayrollExpenseRecord(input.request, {
    reportId: input.linkedPayroll?.reportId ?? null,
  });
  const saved = await savePayrollExpenseApprovals({
    fileName: `outstation-request-${input.request.id}.workflow`,
    records: [expenseRecord],
    reportId: input.linkedPayroll?.reportId ?? null,
  }, input.access);

  return saved.length;
}

export async function approveOutstationRequestForPayroll(
  requestId: number,
  access: AccessContext,
  options: { comment?: string | null } = {},
) {
  await assertOutstationAdminAccess(access, "approve");

  const existing = await getOutstationRequestById(requestId);
  if (!existing) throw new Error("Outstation request was not found.");
  if (existing.status === "rejected") {
    throw new Error("Rejected outstation requests cannot be approved for payroll.");
  }
  if (existing.eligibilityStatus === "not_eligible") {
    throw new Error("Not eligible outstation requests cannot be approved for payroll.");
  }
  const linkedPayroll = await getLinkedOutstationPayrollExpense(existing.id);
  if (linkedPayroll?.importedPayrollBatchId || linkedPayroll?.importedToPayrollAt) {
    throw new Error("This outstation expense has already been added to payroll and cannot be approved again.");
  }

  if (existing.status !== "approved") {
    await assertOutstationExpenseWorkflowTransition({
      access,
      actionKey: "approve",
      expectedNextStatus: "approved",
      status: existing.status,
    });
  }

  const now = new Date().toISOString();
  const approvedBy = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .update({
      approval_reason: cleanText(options.comment) ?? existing.approvalReason,
      calculation_status: "approved",
      status: "approved",
      updated_at: now,
    })
    .eq("id", requestId)
    .in("status", ["submitted", "approved"])
    .select("*")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) {
    throw new Error("Outstation request state changed. Refresh and retry.");
  }

  const request = mapOutstationRequestRow(data as Record<string, unknown>);
  const expenseRecord = mapOutstationRequestToPayrollExpenseRecord(request, {
    reportId: linkedPayroll?.reportId ?? null,
  });
  const savedExpenses = await savePayrollExpenseApprovals({
    fileName: `outstation-request-${request.id}.workflow`,
    records: [expenseRecord],
    reportId: linkedPayroll?.reportId ?? null,
  }, access);

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? approvedBy,
    entityId: String(request.id),
    entityType: "outstation_request",
    newValues: {
      expenseTripId: expenseRecord.tripId,
      payrollExpenseRows: savedExpenses.length,
      status: request.status,
    },
    oldValues: {
      status: existing.status,
    },
    summary: `Outstation request ${request.id} approved for payroll expense import.`,
  });

  return {
    expenseTripId: expenseRecord.tripId,
    payrollExpenseRows: savedExpenses.length,
    request,
  };
}

function uniqueValues(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => text(value)).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function sumBy<T>(rows: T[], selector: (row: T) => number) {
  return rows.reduce((sum, row) => sum + selector(row), 0);
}

function groupNumeric<T>(
  rows: T[],
  labelSelector: (row: T) => string,
  valueSelector: (row: T) => number,
  countSelector?: (row: T) => number,
) {
  const groups = new Map<string, { label: string; trips: number; value: number }>();
  rows.forEach((row) => {
    const label = labelSelector(row) || "Unassigned";
    const existing = groups.get(label) ?? { label, trips: 0, value: 0 };
    existing.trips += countSelector ? countSelector(row) : 1;
    existing.value += valueSelector(row);
    groups.set(label, existing);
  });
  return Array.from(groups.values()).sort((left, right) => right.value - left.value);
}

export async function getOutstationHeatmapData(): Promise<OutstationHeatmapData> {
  const requests = await listOutstationRequests();
  const markers: OutstationHeatmapMarker[] = requests
    .filter(
      (request) =>
        request.capturedLatitude != null &&
        request.capturedLongitude != null &&
        Number.isFinite(request.capturedLatitude) &&
        Number.isFinite(request.capturedLongitude),
    )
    .map((request) => ({
      area: request.toArea ?? request.employeeArea,
      city: request.toCity,
      employeeName: request.employeeName,
      id: request.id,
      latitude: request.capturedLatitude,
      line: request.employeeLine,
      longitude: request.capturedLongitude,
      recommendation: request.approvalRecommendation,
      status: request.eligibilityStatus,
      varianceAmount: request.varianceAmount,
    }));

  return {
    filterOptions: {
      areas: uniqueValues(requests.map((request) => request.toArea ?? request.employeeArea)),
      lines: uniqueValues(requests.map((request) => request.employeeLine)),
      statuses: ["eligible", "not_eligible", "needs_review"],
    },
    heatmapRows: {
      byArea: groupNumeric(
        requests,
        (request) => request.toArea ?? request.employeeArea ?? "Unassigned",
        (request) => request.varianceAmount,
      ).map((row) => ({
        label: row.label,
        totalVariance: roundMoney(row.value),
        trips: row.trips,
      })),
      byCity: groupNumeric(
        requests,
        (request) => request.toCity ?? "Unknown city",
        (request) => request.claimedTotalAmount,
      ).map((row) => ({
        label: row.label,
        totalExpenses: roundMoney(row.value),
        trips: row.trips,
      })),
      byLine: groupNumeric(
        requests,
        (request) => request.employeeLine ?? "Unassigned",
        (request) => request.claimedTotalAmount,
      ).map((row) => ({
        label: row.label,
        totalExpenses: roundMoney(row.value),
        trips: row.trips,
      })),
      highRiskByLocation: groupNumeric(
        // Canonical high-risk predicate (reject recommendation OR GPS-suspicion ≥ threshold
        // OR any fraud flag) — keeps this heatmap aligned with the command-center and the
        // daily-digest cron instead of undercounting on reject-recommendation alone.
        requests.filter(isHighRiskRequest),
        (request) => request.toCity ?? request.toArea ?? "Unknown",
        () => 1,
      ).map((row) => ({
        highRiskTrips: row.trips,
        label: row.label,
      })),
    },
    kpis: {
      highRiskRequests: requests.filter(isHighRiskRequest).length,
      totalClaimed: roundMoney(sumBy(requests, (request) => request.claimedTotalAmount)),
      totalExpected: roundMoney(sumBy(requests, (request) => request.expectedTotalAmount)),
      totalRequests: requests.length,
      totalVariance: roundMoney(sumBy(requests, (request) => request.varianceAmount)),
    },
    markers,
  };
}

export type ManagerExpenseCalculationPreview = {
  allowanceAmount: number;
  allowanceBreakdown: OutstationAllowanceBreakdown;
  claimedTotalAmount: number;
  eligibilityStatus: OutstationEligibilityStatus;
  expectedTotalAmount: number;
  fuelAmount: number;
  fuelRatePerKm: number;
  meetingAmount: number;
  otherAmount: number;
  overnightDays: number;
  travelCost: number;
  sameDayTrip: boolean;
  varianceAmount: number;
  variancePercent: number;
};

/**
 * Computes the fuel + allowance breakdown for a manual admin outstation expense
 * WITHOUT persisting anything. Used by the add-expense modal to show a live
 * calculation preview. The fuel + total math here is intentionally identical to
 * `createManagerExpenseAsAdmin`; keep the two in sync.
 */
export async function previewManagerExpenseCalculation(
  access: AccessContext,
  input: {
    claimedTotalAmount?: number;
    distanceKm: number;
    employeeHrId: string;
    meetingAmount?: number;
    otherAmount?: number;
    transportationType: OutstationTransportationType;
    travelCostAmount?: number | null;
    tripEndDate: string;
    tripStartDate: string;
  },
): Promise<ManagerExpenseCalculationPreview> {
  await assertOutstationAdminAccess(access, "approve");

  const directory = await getEmployeeDirectory();
  const employee = directory.employees.find(
    (row) => normalizeHrIdForAccess(row.hrId) === normalizeHrIdForAccess(input.employeeHrId),
  );
  if (!employee?.hrId) {
    throw new Error(`Employee ${input.employeeHrId} was not found in the employee directory.`);
  }

  const policy = await getActivePolicyForRole(resolveJobFunctionRole(employee.jobTitle ?? ""));
  const allowance = calculateAllowanceBreakdown(input.tripStartDate, input.tripEndDate, policy);

  let fuelAmount = 0;
  if (input.transportationType === "car") {
    fuelAmount = roundMoney(input.distanceKm * 2 * policy.fuelRatePerKm);
  }
  const travelCost = optionalPositiveMoney(input.travelCostAmount) ?? fuelAmount;
  const meetingAmount = positiveMoney(input.meetingAmount);
  const otherAmount = positiveMoney(input.otherAmount);

  const distanceEligibility = classifyOutstationExpenseEligibility({
    actualDistanceKm: input.distanceKm,
    policy: {
      officialMinimumDistanceKm: policy.minimumDistanceKm,
      toleranceMinimumDistanceKm: policy.toleranceMinimumDistanceKm,
    },
  });
  const eligibilityStatus: OutstationEligibilityStatus =
    distanceEligibility.classification === "not_eligible" ? "not_eligible" : "eligible";

  const expectedTotalAmount =
    reportExpectedTotal({
      allowanceAmount: allowance.allowanceAmount,
      eligibilityStatus,
      meetingAmount,
      otherAmount,
      travelCost,
    });
  const claimedInput = Number(input.claimedTotalAmount ?? 0);
  const claimedTotalAmount =
    Number.isFinite(claimedInput) && claimedInput > 0 ? claimedInput : expectedTotalAmount;
  const varianceAmount = roundMoney(claimedTotalAmount - expectedTotalAmount);
  const variancePercent =
    expectedTotalAmount > 0 ? roundMoney((varianceAmount / expectedTotalAmount) * 100) : 0;

  return {
    allowanceAmount: allowance.allowanceAmount,
    allowanceBreakdown: allowance.breakdown,
    claimedTotalAmount,
    eligibilityStatus,
    expectedTotalAmount,
    fuelAmount,
    fuelRatePerKm: policy.fuelRatePerKm,
    meetingAmount,
    otherAmount,
    overnightDays: allowance.overnightDays,
    travelCost,
    sameDayTrip: allowance.sameDayTrip,
    varianceAmount,
    variancePercent,
  };
}

export async function createManagerExpenseAsAdmin(
  access: AccessContext,
  input: ManagerExpenseAdminInput,
): Promise<OutstationExpenseRequest> {
  await assertOutstationAdminAccess(access, "approve");
  await assertOutstationExpenseWorkflowTransition({
    access,
    actionKey: "submit",
    expectedNextStatus: "pending",
    status: "draft",
  });

  const directory = await getEmployeeDirectory();
  const employee = directory.employees.find(
    (row) => normalizeHrIdForAccess(row.hrId) === normalizeHrIdForAccess(input.employeeHrId),
  );
  if (!employee?.hrId) {
    throw new Error(`Employee ${input.employeeHrId} was not found in the employee directory.`);
  }

  const residence = await getResidenceLocationForEmployee(employee.hrId);
  const policy = await getActivePolicyForRole(resolveJobFunctionRole(employee.jobTitle ?? ""));
  const allowance = calculateAllowanceBreakdown(input.tripStartDate, input.tripEndDate, policy);

  let fuelAmount = 0;
  if (input.transportationType === "car") {
    fuelAmount = roundMoney(input.distanceKm * 2 * policy.fuelRatePerKm);
  }
  const reportTravelCost = optionalPositiveMoney(input.travelCostAmount) ?? fuelAmount;
  const reportMeetingAmount = positiveMoney(input.meetingAmount);
  const reportOtherAmount = positiveMoney(input.otherAmount);

  const distanceEligibility = classifyOutstationExpenseEligibility({
    actualDistanceKm: input.distanceKm,
    policy: {
      officialMinimumDistanceKm: policy.minimumDistanceKm,
      toleranceMinimumDistanceKm: policy.toleranceMinimumDistanceKm,
    },
  });

  const eligibilityStatus: OutstationEligibilityStatus =
    distanceEligibility.classification === "not_eligible" ? "not_eligible" : "eligible";
  const eligibilityReason =
    `Admin-created manual outstation expense. ${distanceEligibility.reason}`;

  const expectedTotalAmount =
    reportExpectedTotal({
      allowanceAmount: allowance.allowanceAmount,
      eligibilityStatus,
      meetingAmount: reportMeetingAmount,
      otherAmount: reportOtherAmount,
      travelCost: reportTravelCost,
    });
  const claimedTotalAmount =
    input.claimedTotalAmount > 0 ? input.claimedTotalAmount : expectedTotalAmount;
  const varianceAmount = roundMoney(claimedTotalAmount - expectedTotalAmount);
  const variancePercent =
    expectedTotalAmount > 0
      ? roundMoney((varianceAmount / expectedTotalAmount) * 100)
      : 0;

  const now = new Date().toISOString();
  const actor = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
  const workloadPayload = await resolveOutstationWorkloadPayload({
    employeeHrId: employee.hrId,
    tripEndDate: input.tripEndDate,
    tripStartDate: input.tripStartDate,
  });

  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .insert({
      allowance_amount: allowance.allowanceAmount,
      allowance_breakdown_json: JSON.stringify(allowance.breakdown),
      approval_reason: "Manual outstation expense created by admin. Requires manual review.",
      approval_recommendation: "manager_review",
      area: employee.areaName ?? null,
      attachment_count: 0,
      calculation_status: "submitted",
      captured_accuracy_meters: 0,
      captured_at: now,
      captured_latitude: input.destination.latitude,
      captured_location_source: "browser_gps",
      captured_longitude: input.destination.longitude,
      claimed_total_amount: claimedTotalAmount,
      distance_from_residence_km: input.distanceKm,
      distance_km: input.distanceKm,
      duration_minutes: input.durationMinutes ?? null,
      eligibility_reason: eligibilityReason,
      eligibility_status: eligibilityStatus,
      employee_hr_id: employee.hrId,
      employee_name: employee.fullName ?? employee.hrId,
      employee_role: resolveJobFunctionRole(employee.jobTitle ?? ""),
      expected_total_amount: expectedTotalAmount,
      expense_type: input.expenseType,
      fraud_flags_json: JSON.stringify([]),
      fuel_amount: fuelAmount,
      go_ticket_amount: 0,
      line: employee.lineName ?? null,
      minimum_required_distance_km: policy.minimumDistanceKm,
      notes: input.notes ?? null,
      offline_captured: false,
      overnight_days: allowance.overnightDays,
      report_am_workload: positiveMoney(input.amWorkload),
      report_hr_notes: cleanText(input.hrNotes),
      report_hr_status: cleanText(input.hrStatus),
      report_meeting_amount: reportMeetingAmount,
      report_other_amount: reportOtherAmount,
      report_pm_workload: positiveMoney(input.pmWorkload),
      report_travel_cost: reportTravelCost,
      report_trip_type: reportTripTypeLabel({
        override: input.tripType,
        overnightDays: allowance.overnightDays,
        sameDayTrip: allowance.sameDayTrip,
      }),
      residence_address: residence?.residenceAddress ?? null,
      residence_area: residence?.residenceArea ?? null,
      residence_city: residence?.residenceCity ?? null,
      residence_latitude: residence?.residenceLatitude ?? null,
      residence_longitude: residence?.residenceLongitude ?? null,
      return_ticket_amount: 0,
      route_polyline: input.routePolyline ?? null,
      same_day_trip: allowance.sameDayTrip,
      status: "submitted",
      submitted_at: now,
      suspicious_location_score: 0,
      territory_validation_reason: "Admin-created expense; territory check not applicable.",
      territory_validation_status: "not_available",
      ...workloadPayload,
      meeting_amount: input.meetingAmount ?? 0,
      other_amount: input.otherAmount ?? 0,
      ticket_amount: 0,
      ticket_attachment_metadata: [],
      ticket_attachment_paths: [],
      to_area: input.destination.area ?? null,
      to_city: input.destination.city ?? null,
      to_country: input.destination.country ?? null,
      to_label: input.destination.label,
      transportation_type: input.transportationType,
      trip_end_date: input.tripEndDate,
      trip_start_date: input.tripStartDate,
      updated_at: now,
      variance_amount: varianceAmount,
      variance_percent: variancePercent,
    })
    .select("*")
    .single();

  if (error) throw new Error(error.message);

  const created = mapOutstationRequestRow(data as Record<string, unknown>);

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: String(created.id),
    entityType: "outstation_request",
    newValues: {
      destination: input.destination.label,
      distanceKm: input.distanceKm,
      employeeHrId: employee.hrId,
      expenseType: input.expenseType,
      meetingAmount: reportMeetingAmount,
      otherAmount: reportOtherAmount,
      source: "admin_manual_outstation_expense",
      status: "submitted",
      travelCost: reportTravelCost,
      tripEndDate: input.tripEndDate,
      tripStartDate: input.tripStartDate,
    },
    summary: `Admin created manual outstation expense for ${employee.hrId} to ${input.destination.label} (${input.distanceKm} km).`,
  });

  await approveOutstationRequestForPayroll(created.id, systemAccessContext);
  return created;
}

export async function updateManagerExpenseAsAdmin(
  requestId: number,
  access: AccessContext,
  input: Partial<ManagerExpenseAdminInput>,
): Promise<OutstationExpenseRequest> {
  await assertOutstationAdminAccess(access, "approve");

  const existing = await getOutstationRequestById(requestId);
  if (!existing) throw new Error("Outstation request was not found.");
  const linkedPayroll = await getLinkedOutstationPayrollExpense(existing.id);
  if (linkedPayroll?.importedPayrollBatchId || linkedPayroll?.importedToPayrollAt) {
    throw new Error("This outstation expense has already been added to payroll and cannot be edited.");
  }
  await assertOutstationExpenseWorkflowTransition({
    access,
    actionKey: "edit_before_payroll",
    status: existing.status,
  });

  const now = new Date().toISOString();
  const actor = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";

  const employeeHrId = existing.employeeHrId;
  const directory = await getEmployeeDirectory();
  const employee = directory.employees.find(
    (row) => normalizeHrIdForAccess(row.hrId) === normalizeHrIdForAccess(employeeHrId),
  );
  const policy = await getActivePolicyForRole(
    resolveJobFunctionRole(employee?.jobTitle ?? existing.employeeRole),
  );

  const tripStartDate = input.tripStartDate ?? existing.tripStartDate;
  const tripEndDate = input.tripEndDate ?? existing.tripEndDate;
  const transportationType = input.transportationType ?? existing.transportationType;
  const expenseType = input.expenseType ?? existing.expenseType;
  const notes = "notes" in input ? (input.notes ?? null) : existing.notes;

  const destination = input.destination;
  const distanceKm = input.distanceKm ?? existing.distanceFromResidenceKm ?? 0;
  const durationMinutes = "durationMinutes" in input
    ? (input.durationMinutes ?? null)
    : existing.durationMinutes;
  const routePolyline = "routePolyline" in input
    ? (input.routePolyline ?? null)
    : existing.routePolyline;

  const allowance = calculateAllowanceBreakdown(tripStartDate, tripEndDate, policy);
  let fuelAmount = 0;
  if (transportationType === "car") {
    fuelAmount = roundMoney(distanceKm * 2 * policy.fuelRatePerKm);
  }
  const existingTravelCost =
    existing.reportTravelCost ?? roundMoney(existing.fuelAmount + existing.ticketAmount);
  const computedTravelCost =
    transportationType === "car" ? fuelAmount : existingTravelCost;
  const reportTravelCost =
    "travelCostAmount" in input
      ? optionalPositiveMoney(input.travelCostAmount) ?? computedTravelCost
      : existingTravelCost;
  const reportMeetingAmount =
    "meetingAmount" in input
      ? positiveMoney(input.meetingAmount)
      : existing.reportMeetingAmount;
  const reportOtherAmount =
    "otherAmount" in input ? positiveMoney(input.otherAmount) : existing.reportOtherAmount;
  const reportAmWorkload =
    "amWorkload" in input ? positiveMoney(input.amWorkload) : existing.reportAmWorkload;
  const reportPmWorkload =
    "pmWorkload" in input ? positiveMoney(input.pmWorkload) : existing.reportPmWorkload;
  const reportHrStatus =
    "hrStatus" in input ? cleanText(input.hrStatus) : existing.reportHrStatus;
  const reportHrNotes =
    "hrNotes" in input ? cleanText(input.hrNotes) : existing.reportHrNotes;
  const reportTripType =
    "tripType" in input
      ? reportTripTypeLabel({
          override: input.tripType,
          overnightDays: allowance.overnightDays,
          sameDayTrip: allowance.sameDayTrip,
        })
      : existing.reportTripType ??
        reportTripTypeLabel({
          overnightDays: allowance.overnightDays,
          sameDayTrip: allowance.sameDayTrip,
        });

  const distanceEligibility = classifyOutstationExpenseEligibility({
    actualDistanceKm: distanceKm,
    policy: {
      officialMinimumDistanceKm: policy.minimumDistanceKm,
      toleranceMinimumDistanceKm: policy.toleranceMinimumDistanceKm,
    },
  });

  const eligibilityStatus: OutstationEligibilityStatus =
    distanceEligibility.classification === "not_eligible" ? "not_eligible" : "eligible";
  const expectedTotalAmount =
    reportExpectedTotal({
      allowanceAmount: allowance.allowanceAmount,
      eligibilityStatus,
      meetingAmount: reportMeetingAmount,
      otherAmount: reportOtherAmount,
      travelCost: reportTravelCost,
    });
  const claimedTotal = input.claimedTotalAmount;
  const claimedTotalAmount = claimedTotal != null && claimedTotal > 0
    ? claimedTotal
    : expectedTotalAmount;
  const varianceAmount = roundMoney(claimedTotalAmount - expectedTotalAmount);
  const variancePercent =
    expectedTotalAmount > 0
      ? roundMoney((varianceAmount / expectedTotalAmount) * 100)
      : 0;
  const workloadPayload = await resolveOutstationWorkloadPayload({
    employeeHrId,
    tripEndDate,
    tripStartDate,
  });

  const updatePayload: Record<string, unknown> = {
    allowance_amount: allowance.allowanceAmount,
    allowance_breakdown_json: JSON.stringify(allowance.breakdown),
    ...workloadPayload,
    claimed_total_amount: claimedTotalAmount,
    distance_from_residence_km: distanceKm,
    distance_km: distanceKm,
    duration_minutes: durationMinutes,
    eligibility_reason: `Admin-updated manual outstation expense. ${distanceEligibility.reason}`,
    eligibility_status: eligibilityStatus,
    expense_type: expenseType,
    expected_total_amount: expectedTotalAmount,
    fuel_amount: fuelAmount,
    meeting_amount: input.meetingAmount ?? existing.meetingAmount ?? 0,
    notes: notes,
    other_amount: input.otherAmount ?? existing.otherAmount ?? 0,
    overnight_days: allowance.overnightDays,
    report_am_workload: reportAmWorkload,
    report_hr_notes: reportHrNotes,
    report_hr_status: reportHrStatus,
    report_meeting_amount: reportMeetingAmount,
    report_other_amount: reportOtherAmount,
    report_pm_workload: reportPmWorkload,
    report_travel_cost: reportTravelCost,
    report_trip_type: reportTripType,
    route_polyline: routePolyline,
    same_day_trip: allowance.sameDayTrip,
    transportation_type: transportationType,
    trip_end_date: tripEndDate,
    trip_start_date: tripStartDate,
    updated_at: now,
    variance_amount: varianceAmount,
    variance_percent: variancePercent,
  };

  if (destination) {
    updatePayload.captured_latitude = destination.latitude;
    updatePayload.captured_longitude = destination.longitude;
    updatePayload.to_area = destination.area ?? null;
    updatePayload.to_city = destination.city ?? null;
    updatePayload.to_country = destination.country ?? null;
    updatePayload.to_label = destination.label;
  }

  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .update(updatePayload)
    .eq("id", requestId)
    .eq("status", existing.status)
    .select("*")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) {
    throw new Error("Outstation request state changed. Refresh and retry.");
  }

  const updated = mapOutstationRequestRow(data as Record<string, unknown>);
  const syncedPayrollRows = await syncLinkedOutstationPayrollExpense({
    access,
    linkedPayroll,
    request: updated,
  });

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: String(updated.id),
    entityType: "outstation_request",
    newValues: {
      destination: destination?.label ?? existing.toLabel,
      distanceKm,
      expenseType,
      meetingAmount: reportMeetingAmount,
      otherAmount: reportOtherAmount,
      payrollExpenseRows: syncedPayrollRows,
      source: "admin_manual_outstation_expense_edit",
      status: updated.status,
      travelCost: reportTravelCost,
      tripEndDate,
      tripStartDate,
    },
    oldValues: {
      destination: existing.toLabel,
      distanceKm: existing.distanceFromResidenceKm,
      expenseType: existing.expenseType,
      status: existing.status,
    },
    summary: `Admin updated manual outstation expense ${requestId} for ${employeeHrId}.`,
  });

  return updated;
}

export async function rejectOutstationRequestAsAdmin(
  requestId: number,
  access: AccessContext,
  options: { comment: string },
): Promise<OutstationExpenseRequest> {
  await assertOutstationAdminAccess(access, "approve");

  const existing = await getOutstationRequestById(requestId);
  if (!existing) throw new Error("Outstation request was not found.");

  const expenseTripId = outstationPayrollTripId(existing.id);
  const supabase = getSupabaseAdmin();
  const { data: linkedPayrollRows, error: linkedPayrollError } = await supabase
    .from("payroll_expenses")
    .select("id,imported_payroll_batch_id,imported_to_payroll_at,report_id,trip_id")
    .eq("trip_id", expenseTripId);

  if (linkedPayrollError && !isPayrollExpensesSchemaMissing(linkedPayrollError)) {
    throw new Error(linkedPayrollError.message);
  }

  const linkedRows = (linkedPayrollRows ?? []) as Array<Record<string, unknown>>;
  const addedToPayroll = linkedRows.some(
    (row) => row.imported_payroll_batch_id != null || row.imported_to_payroll_at != null,
  );
  if (addedToPayroll) {
    throw new Error("This outstation expense has already been added to payroll and cannot be rejected.");
  }

  const comment = cleanText(options.comment);
  if (!comment) {
    throw new Error("A rejection reason is required.");
  }

  if (existing.status !== "rejected") {
    await assertOutstationExpenseWorkflowTransition({
      access,
      actionKey: existing.status === "approved" ? "reject_before_payroll" : "reject",
      expectedNextStatus: "rejected",
      status: existing.status,
    });
  }

  const now = new Date().toISOString();
  const actor = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
  const linkedReportIds = Array.from(
    new Set(
      linkedRows
        .map((row) => row.report_id ? String(row.report_id) : null)
        .filter(Boolean),
    ),
  );

  if (existing.status === "approved" && linkedRows.length > 0) {
    const { error: deletePayrollError } = await supabase
      .from("payroll_expenses")
      .delete()
      .eq("trip_id", expenseTripId);

    if (deletePayrollError) throw new Error(deletePayrollError.message);

    for (const reportId of linkedReportIds) {
      const { count: remainingRows, error: remainingRowsError } = await supabase
        .from("payroll_expenses")
        .select("id", { count: "exact", head: true })
        .eq("report_id", reportId);

      if (remainingRowsError) throw new Error(remainingRowsError.message);
      if ((remainingRows ?? 0) > 0) continue;

      const { error: deleteReportError } = await supabase
        .from("payroll_expense_reports")
        .delete()
        .eq("id", reportId);

      if (deleteReportError) throw new Error(deleteReportError.message);
    }
  }

  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .update({
      approval_reason: comment,
      approval_recommendation: "reject",
      calculation_status: "rejected",
      status: "rejected",
      updated_at: now,
    })
    .eq("id", requestId)
    .in("status", ["submitted", "approved", "rejected"])
    .select("*")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) {
    throw new Error("Outstation request state changed. Refresh and retry.");
  }

  const rejected = mapOutstationRequestRow(data as Record<string, unknown>);

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: String(rejected.id),
    entityType: "outstation_request",
    newValues: {
      approvalReason: comment,
      removedPayrollExpenseRows: existing.status === "approved" ? linkedRows.length : 0,
      status: rejected.status,
    },
    oldValues: {
      status: existing.status,
    },
    summary: `Admin rejected outstation request ${rejected.id}.`,
  });

  await notifyOutstationDecision({ comment, decision: "reject", request: rejected });
  return rejected;
}

export async function deleteOutstationRequestAsAdmin(
  requestId: number,
  access: AccessContext,
) {
  await assertOutstationAdminAccess(access, "delete");

  const existing = await getOutstationRequestById(requestId);
  if (!existing) throw new Error("Outstation request was not found.");

  const actor = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
  const expenseTripId = outstationPayrollTripId(existing.id);
  const supabase = getSupabaseAdmin();

  const { data: linkedPayrollRows, error: linkedPayrollError } = await supabase
    .from("payroll_expenses")
    .select("id,imported_payroll_batch_id,imported_to_payroll_at,report_id,trip_id")
    .eq("trip_id", expenseTripId);

  if (linkedPayrollError && !isPayrollExpensesSchemaMissing(linkedPayrollError)) {
    throw new Error(linkedPayrollError.message);
  }

  const linkedRows = (linkedPayrollRows ?? []) as Array<Record<string, unknown>>;
  const addedToPayroll = linkedRows.some(
    (row) => row.imported_payroll_batch_id != null || row.imported_to_payroll_at != null,
  );
  if (addedToPayroll) {
    throw new Error("This outstation expense has already been added to payroll and cannot be deleted.");
  }

  await assertOutstationExpenseWorkflowTransition({
    access,
    actionKey: "delete_before_payroll",
    expectedNextStatus: "deleted",
    status: existing.status,
  });

  let deletedPayrollRows = 0;
  const linkedReportIds = Array.from(
    new Set(
      linkedRows
        .map((row) => row.report_id ? String(row.report_id) : null)
        .filter(Boolean),
    ),
  );

  if (linkedRows.length > 0) {
    const { count, error: deletePayrollError } = await supabase
      .from("payroll_expenses")
      .delete({ count: "exact" })
      .eq("trip_id", expenseTripId);

    if (deletePayrollError) throw new Error(deletePayrollError.message);
    deletedPayrollRows = count ?? linkedRows.length;

    for (const reportId of linkedReportIds) {
      const { count: remainingRows, error: remainingRowsError } = await supabase
        .from("payroll_expenses")
        .select("id", { count: "exact", head: true })
        .eq("report_id", reportId);

      if (remainingRowsError) throw new Error(remainingRowsError.message);
      if ((remainingRows ?? 0) > 0) continue;

      const { error: deleteReportError } = await supabase
        .from("payroll_expense_reports")
        .delete()
        .eq("id", reportId);

      if (deleteReportError) throw new Error(deleteReportError.message);
    }
  }

  await deleteOutstationCarEvidenceImage(existing.carEvidenceImagePath);
  await deleteOutstationTicketAttachments(existing.ticketAttachmentPaths);

  const { error } = await supabase
    .from("outstation_expense_requests")
    .delete()
    .eq("id", requestId);

  if (error) throw new Error(error.message);

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? actor,
    entityId: String(existing.id),
    entityType: "outstation_request",
    oldValues: {
      employeeHrId: existing.employeeHrId,
      expenseTripId,
      status: existing.status,
      toLabel: existing.toLabel,
      tripEndDate: existing.tripEndDate,
      tripStartDate: existing.tripStartDate,
    },
    summary: `Admin deleted outstation request ${existing.id}.`,
  });

  return {
    linkedPayroll: {
      deletedRows: deletedPayrollRows,
      expenseTripId,
    },
    request: existing,
  };
}


export async function runOutstationSlaDaily(): Promise<{ processed: number; errors: number }> {
  const today = new Date().toISOString().slice(0, 10);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .select("id, employee_name, employee_hr_id, trip_start_date, created_at")
    .eq("status", "submitted");
  if (error) return { processed: 0, errors: 1 };

  // Find HR-level approver HR IDs from app_auth_users
  const { data: approvers } = await supabase
    .from("app_auth_users")
    .select("hr_id")
    .in("role", ["Super Admin", "Finance Manager", "CEO"])
    .eq("is_active", true);
  const approverHrIds = (approvers ?? []).map((a) => String(a.hr_id)).filter(Boolean);
  if (approverHrIds.length === 0) return { processed: 0, errors: 0 };

  let processed = 0;
  let errors = 0;
  const now = Date.now();
  for (const row of data ?? []) {
    const ageDays = Math.max(0, Math.floor((now - new Date(row.created_at as string).getTime()) / 86400000));
    if (ageDays < 3) continue;
    for (const hrId of approverHrIds) {
      try {
        await createSystemNotification({
          channels: ["email"],
          eventType: "outstation_sla_reminder",
          message: `${String(row.employee_name)}'s outstation request (trip: ${String(row.trip_start_date)}) has been pending ${ageDays} day${ageDays === 1 ? "" : "s"}.`,
          metadata: { idempotencyKey: `outstation:${String(row.id)}:sla:${hrId}:${today}` },
          module: "outstation",
          priority: "normal",
          recipientHrId: hrId,
          title: "Outstation approval overdue",
          actionUrl: `/admin/approvals-hub?module=outstation&id=${String(row.id)}`,
          email: {
            ctaHref: `/admin/approvals-hub?module=outstation&id=${String(row.id)}`,
            ctaLabel: "Review now",
            tone: "warning" as const,
          },
        });
        processed++;
      } catch (error) {
        Sentry.captureException(error, { tags: { cron: "outstation-sla-reminder", recipientHrId: hrId } });
        errors++;
      }
    }
  }
  return { processed, errors };
}
