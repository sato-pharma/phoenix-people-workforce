
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
import { carTripFuelIsUnpriceable, UNPRICEABLE_CAR_TRIP_MESSAGE } from "@/lib/outstation/fuel-policy";
import { getRepTripVisitWorkload } from "@/lib/crm/visit-workload";
import { mergeWorkloadEvidence } from "@/lib/outstation/workload-evidence";
import { getDoubleVisitExpenseWorkloadEvidence } from "@/lib/double-visit-analytics/service";
import type { DoubleVisitExpenseWorkloadEvidence } from "@/lib/double-visit-analytics/types";
import { validateLiveArrivalEvidence } from "@/lib/outstation/car-evidence";
import {
  createOutstationCarEvidenceSignedUrl,
  createOutstationEvidenceSignedUrls,
  uploadOutstationDepartureEvidenceImage,
  deleteOutstationCarEvidenceImage,
  deleteOutstationTicketAttachments,
  uploadOutstationCarEvidenceImage,
  uploadOutstationTicketAttachments,
  type OutstationTicketAttachmentUploadInput,
} from "@/lib/outstation/car-evidence-storage";
import { classifyOutstationExpenseEligibility } from "@/lib/outstation/classification";
import { resolveGovernorate } from "@/lib/geo/egypt-locations";
import {
  CAMPAIGN_RULE_ROLES,
  MAX_CAMPAIGN_VISITS,
  outstationTicketEvidenceRejection,
} from "@/lib/outstation/decision";
import { getEmployeeDirectory, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { formatPhoenixDateTime, formatPhoenixLongDate } from "@/lib/i18n/format";
import {
  attachOutstationCapturedLocations,
  resolveOutstationCapturedLocation,
} from "@/lib/outstation/captured-location";
import { captureOutstationTripWorkload } from "@/lib/outstation/workload-capture";
import {
  reviewDepartureEvidence,
  type DepartureEvidenceReview,
} from "@/lib/outstation/departure-evidence";
import {
  nextEvidenceGateStatus,
  resolveOutstationGateState,
  validateManualWorkloadInput,
} from "@/lib/outstation/expense-gate";
import {
  resolveOutstationRecipientAddresses,
  resolveOutstationSubmitRouting,
} from "@/lib/outstation/submit-recipients";
import { createSystemNotification, createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { resolveNotificationRoleEnabled, resolveNotificationRoleRecipients } from "@/lib/notifications/role-recipients";
import { logError } from "@/lib/observability/log";
import {
  EXPENSE_DECISION_SELECT,
  isPayrollExpensesSchemaMissing,
  resyncPayrollExpenseStepForRemovedTrips,
  savePayrollExpenseApprovals,
} from "@/lib/outstation/expenses";
import {
  mapOutstationRequestToPayrollExpenseRecord,
  outstationPayrollTripId,
} from "@/lib/outstation/payroll-expense-mapping";
import { isAdjustedAmount } from "@/lib/outstation/approval-state";
import { planOutstationRequestDecision } from "@/lib/outstation/expense-approval-decisions";
import { assertOutstationExpenseWorkflowTransition } from "@/lib/outstation/workflow";
import {
  validateMedicalRepSimpleExpenseInput,
  type MedicalRepSimpleExpenseInput,
} from "@/lib/outstation/medical-rep-expenses";
import {
  googleDirectionsRoute,
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
  OutstationDepartureEvidenceMetadata,
  OutstationEvidenceGateStatus,
  OutstationWorkloadGateStatus,
  OutstationCalculationInput,
  OutstationCalculationResult,
  OutstationCaptureResult,
  OutstationTicketAttachmentMetadata,
  OutstationEligibilityStatus,
  OutstationExpenseType,
  OutstationExpenseRequest,
  OutstationHeatmapData,
  OutstationHeatmapMarker,
  OutstationPolicyRule,
  OutstationRouteAlternative,
  OutstationTerritoryValidationStatus,
  OutstationTransportationType,
} from "@/lib/outstation/types";

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
  // Every transportation type carries an arrival photo now, so the audit line must not
  // label a train's evidence "Car". The stored shape is unchanged — only the label moves.
  transportationType: OutstationTransportationType,
) {
  if (!metadata) return notes;

  const evidenceLine = [
    transportationType === "car" ? "Car live evidence:" : "Arrival photo evidence:",
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
    campaignVisits: 0,
    regularVisits: 0,
    source: "manual",
    sourceLabel: params.sourceLabel,
  };
}

async function resolveOutstationWorkloadPayload(params: {
  employeeHrId: string | null;
  tripEndDate: string;
  tripStartDate: string;
}) {
  // TWO sources on purpose — they answer different questions and must not be conflated.
  //
  // Workload / "did this rep actually work these days" comes from the CRM visits read, which
  // counts every field visit where the rep is the primary agent OR the double-visit partner.
  // The double-visit mirror cannot see a rep's SOLO field days, so it reported worked days as
  // "no activity" and the decision engine judged real trips against a workload of zero.
  //
  // The campaign-visit cap deliberately KEEPS the double-visit source. That rule (rule 3 in
  // decision.ts, and campaignRuleRejection here) rejects on "campaign DOUBLE-visits" and on
  // "no double-visit activity". Feeding it the CRM read would break it both ways: solo campaign
  // visits would inflate campaignVisits into spurious auto-rejections, and solo visits would
  // satisfy the totalDvVisits > 0 test, silently fail-opening a live rejection rule.
  const [doubleVisitEvidence, repWorkload] = await Promise.all([
    getDoubleVisitExpenseWorkloadEvidence(params).catch((error) =>
      fallbackWorkloadEvidence({
        sourceLabel: error instanceof Error
          ? `Double Visit evidence unavailable: ${error.message}`
          : "Double Visit evidence unavailable.",
        tripEndDate: params.tripEndDate,
        tripStartDate: params.tripStartDate,
      }),
    ),
    // Never let the corrected read take a write path down: on failure we keep the previous
    // (under-counting) behaviour rather than blocking an expense submission.
    getRepTripVisitWorkload({
      hrId: params.employeeHrId,
      tripEndDate: params.tripEndDate,
      tripStartDate: params.tripStartDate,
    }).catch(() => null),
  ]);

  const evidence = mergeWorkloadEvidence(doubleVisitEvidence, repWorkload);

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
  hasTicketAttachments: boolean;
  policy: OutstationPolicyRule;
  territoryValidationStatus: OutstationTerritoryValidationStatus;
  transportationType: OutstationTransportationType;
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

  if (
    params.eligibilityStatus === "needs_review" ||
    params.territoryValidationStatus === "outside_expected_territory"
  ) {
    return {
      approvalReason:
        "Location or timing checks require manager review before the request can move forward.",
      approvalRecommendation: "manager_review" as OutstationApprovalRecommendation,
    };
  }

  return {
    approvalReason:
      "Distance, location, and policy checks are clean enough for automatic approval recommendation.",
    approvalRecommendation: "auto_approve" as OutstationApprovalRecommendation,
  };
}

// Campaign-visit cap (#11): a TRAVELING expense for a District/Training Manager needs
// at least one double-visit and at most 2 campaign visits (the rest regular). Meeting /
// other expense types and all other roles are unaffected. Thresholds are shared with the
// pure decision engine (decision.ts) so there is a single source of truth.
function campaignRuleRejection(input: {
  role: string;
  expenseType: OutstationExpenseType;
  evidence: DoubleVisitExpenseWorkloadEvidence;
}): string | null {
  if (input.expenseType !== "traveling" || !CAMPAIGN_RULE_ROLES.has(input.role)) return null;
  const campaignVisits = input.evidence.campaignVisits ?? 0;
  const totalDvVisits = campaignVisits + (input.evidence.regularVisits ?? 0);
  if (totalDvVisits <= 0) {
    return "No double-visit activity was recorded for this trip; a traveling expense for this role requires field double-visits.";
  }
  if (campaignVisits > MAX_CAMPAIGN_VISITS) {
    return `A traveling expense allows at most ${MAX_CAMPAIGN_VISITS} campaign double-visits; this trip has ${campaignVisits}. The rest must be regular visits.`;
  }
  return null;
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
    employeeName: employee?.displayName ?? employee.hrId,
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

/**
 * Resolve a canonical Egyptian governorate from the first of several candidate
 * strings that yields a confident match. Used so a residence/destination whose
 * governorate lives in a secondary field (area / address) still resolves.
 */
function resolveFirstGovernorate(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    const governorate = resolveGovernorate(value ?? "");
    if (governorate) return governorate;
  }
  return null;
}

async function validateCapturedLocation(
  params: ValidationContext,
): Promise<ValidatedLocationBundle> {
  const identity = await getEmployeeIdentity(params.access);
  const policy = await getActivePolicyForRole(identity.employeeRole);
  const residence = await getResidenceLocationForEmployee(identity.employeeHrId);
  const submittedAt = new Date().toISOString();

  if (
    !residence ||
    residence.residenceLatitude == null ||
    residence.residenceLongitude == null
  ) {
    throw new Error(
      "Your registered residence location is missing or invalid. Please contact HR before submitting an outstation request.",
    );
  }

  let eligibilityStatus: OutstationEligibilityStatus = "eligible";
  let eligibilityReason = "Captured location is eligible for outstation calculation.";
  const capturedAt = isoString(params.capturedAt) || submittedAt;

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
    eligibilityStatus = "not_eligible";
    eligibilityReason = distanceReason;
  } else if (distanceEligibility.classification !== "eligible") {
    // tolerance / missing / invalid / manual-exception — accept but flag for review.
    eligibilityStatus = "needs_review";
    eligibilityReason = distanceReason;
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

  // Residence-vs-destination governorate rule: a trip must be OUTSIDE the
  // employee's residence governorate. Canonicalize both via resolveGovernorate so a
  // plain compare is valid. Each side is resolved from MULTIPLE fields (first hit
  // wins) so a town-only value in one field does not defeat the check when another
  // field carries the governorate.
  const residenceGovernorate = resolveFirstGovernorate(
    residence.residenceCity,
    residence.residenceArea,
    residence.residenceAddress,
  );
  const destinationGovernorate = resolveFirstGovernorate(
    reverse?.governorate,
    reverse?.formattedAddress,
    reverse?.city,
    reverse?.area,
  );
  if (
    eligibilityStatus !== "not_eligible" &&
    residenceGovernorate &&
    destinationGovernorate &&
    residenceGovernorate === destinationGovernorate
  ) {
    eligibilityStatus = "not_eligible";
    eligibilityReason = `Destination is within the same governorate as your residence (${residenceGovernorate}) and is not eligible for an outstation expense.`;
  }
  // Owner rule: when a governorate can NOT be confirmed (either side unresolved),
  // do not silently auto-pay — hold the request for Super Admin review instead.
  const governorateReviewRequired =
    eligibilityStatus !== "not_eligible" && (!residenceGovernorate || !destinationGovernorate);

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
    governorateReviewRequired,
    employeeArea: identity.employeeArea,
    employeeHrId: identity.employeeHrId,
    employeeLine: identity.employeeLine,
    employeeName: identity.employeeName,
    employeeRole: identity.employeeRole,
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
    territoryValidationReason: territory.reason,
    territoryValidationStatus: territory.status,
    toArea: reverse?.area ?? null,
    toCity: reverse?.city ?? null,
    toLabel: reverse?.formattedAddress ?? null,
  };

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
  const calculationStatus =
    result.eligibilityStatus === "not_eligible" ? "blocked" : "calculated";
  const recommendation = recommendationForResult({
    eligibilityStatus: result.eligibilityStatus,
    hasTicketAttachments: Boolean(input.hasTicketAttachments),
    policy,
    territoryValidationStatus: result.territoryValidationStatus,
    transportationType: input.transportationType,
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
    ticketAmount,
    carEvidenceImagePath: null,
    carEvidenceMetadata: input.carEvidenceMetadata,
    transportationType: input.transportationType,
    tripEndDate,
    tripStartDate,
  };

  return calculation;
}

// ── Approval notifications ────────────────────────────────────────────────────
// Submission auto-approves in the same request (no pending-approval step for a
// human to act on), so the submit mail is a CONFIRMATION to the employee rather
// than an action queue, with his reporting line copied for visibility. Every send
// is best-effort: a notification failure must never roll back or fail the
// underlying submit. See submit-recipients.ts for who lands in To/Cc/Bcc and why.
const OUTSTATION_EMPLOYEE_PORTAL_URL = "/employee-portals/expenses";
const OUTSTATION_ADMIN_QUEUE_URL = "/admin/outstation/expense-command?tab=queue";

function formatEgp(value: number) {
  return `${Number(value || 0).toLocaleString("en-EG", { maximumFractionDigits: 2 })} EGP`;
}

// Fires once per fresh submission: the employee wizard, offline sync, the
// Medical Rep simple-ticket flow, and admin-created manual entries all route
// through approveOutstationRequestForPayroll immediately after insert (that
// immediate auto-approve is what actually makes the request "submitted" in
// practice). Not fired on later edits to an already-approved request.
async function notifyOutstationSubmitted(
  request: OutstationExpenseRequest,
  options: { heldForReview?: boolean } = {},
) {
  try {
    // To = the employee, Cc = his manager (+ skip-level unless that is the CEO),
    // Bcc = active Super Admins. Nothing is sent when the employee cannot be
    // identified: a confirmation with no one to confirm TO is not worth mailing to
    // his managers alone.
    const routing = await resolveOutstationSubmitRouting(request.employeeHrId);
    if (!routing.toHrId) {
      logError("Outstation submit email skipped — submitting employee could not be resolved", {
        labels: { event: "outstation_submit_email_employee_unresolved", requestId: String(request.id) },
      });
      return;
    }
    const [ccAddresses, bccAddresses] = await Promise.all([
      resolveOutstationRecipientAddresses(routing.ccHrIds),
      resolveOutstationRecipientAddresses(routing.bccHrIds),
    ]);
    const heldForReview = Boolean(options.heldForReview);

    const claimedAmount = formatEgp(request.claimedTotalAmount || request.expectedTotalAmount);
    const destination = text(request.toLabel) || text(request.toCity) || text(request.toArea) || "—";
    const actionUrl = `${OUTSTATION_ADMIN_QUEUE_URL}&requestId=${encodeURIComponent(String(request.id))}`;
    const tripLength = request.sameDayTrip ? "Same-day" : `${request.overnightDays} night(s)`;

    const managerName = text(routing.managerName) || "—";
    // Brick / area / region for the captured GPS point, so the mail carries a place
    // name instead of a coordinate pair. Best-effort — never blocks the send.
    const capturedLocation = await resolveOutstationCapturedLocation({
      latitude: request.capturedLatitude,
      longitude: request.capturedLongitude,
    });

    const metrics = [
      ...(heldForReview
        ? [
            {
              label: "Action needed",
              value:
                "Held for Super Admin review — the residence/destination governorate could not be confirmed. NOT added to payroll until you approve or reject it.",
            },
          ]
        : []),
      { label: "Employee", value: `${request.employeeName} (${request.employeeHrId})` },
      { label: "Role", value: request.employeeRole },
      // Separate "Line"/"Area" labels (replacing the old combined "Line / Area" one) are what
      // the OUTSTATION email template's {{line}}/{{area}} tokens look up via metricValue() —
      // the combined label alone left those tokens rendering blank.
      { label: "Line", value: text(request.employeeLine) || "—" },
      { label: "Area", value: text(request.employeeArea) || "—" },
      { label: "Manager", value: managerName },
      { label: "Transportation", value: request.transportationType },
      { label: "Expense type", value: request.expenseType },
      // "Amount" and "Trip start"/"Trip end" (not a combined "Trip dates") are the exact
      // labels the OUTSTATION email template's amount/startDate/endDate tokens look up via
      // metricValue() — using different labels here left those tokens rendering blank.
      // Formatted (not raw ISO) since the template renders these directly into "{{startDate}}
      // to {{endDate}}" text.
      { label: "Amount", value: claimedAmount },
      // Owner format (2026-08-04): "Tuesday, 17 October 2026", Africa/Cairo, everywhere in
      // this mail. formatDateValue's short "17 Oct 2026" stays in the dense admin tables.
      { label: "Trip start", value: formatPhoenixLongDate(request.tripStartDate) },
      { label: "Trip end", value: formatPhoenixLongDate(request.tripEndDate) },
      // "Duration" (in addition to "Trip length") is what the OUTSTATION template's
      // {{duration}} token looks up.
      { label: "Trip length", value: tripLength },
      { label: "Duration", value: tripLength },
      { label: "Destination", value: destination },
      {
        label: "Distance from residence",
        value: request.distanceFromResidenceKm != null ? `${request.distanceFromResidenceKm.toFixed(1)} km` : "—",
      },
      { label: "Fuel amount", value: formatEgp(request.fuelAmount) },
      { label: "Ticket amount", value: formatEgp(request.ticketAmount) },
      { label: "Allowance amount", value: formatEgp(request.allowanceAmount) },
      { label: "Meeting amount", value: formatEgp(request.meetingAmount) },
      { label: "Other amount", value: formatEgp(request.otherAmount) },
      { label: "Expected total", value: formatEgp(request.expectedTotalAmount) },
      { label: "Claimed total", value: claimedAmount },
      { label: "Eligibility", value: `${request.eligibilityStatus} — ${text(request.eligibilityReason) || "—"}` },
      {
        label: "Approval recommendation",
        value: `${request.approvalRecommendation} — ${text(request.approvalReason) || "—"}`,
      },
      // This request auto-decides on submit (no human pre-approval gate); the OUTSTATION
      // template's {{approvalFlow}} token describes that process, not a per-request value.
      {
        label: "Approval Flow",
        value: "Automatic — no manager approval step; Super Admin can review and override afterward in the Expense Command Center.",
      },
      { label: "Status", value: "Submitted" },
      {
        label: "Territory validation",
        value: `${request.territoryValidationStatus} — ${text(request.territoryValidationReason) || "—"}`,
      },
      // Captured location, as a place rather than a coordinate pair. Labels are deliberately
      // prefixed "Captured …": the plain "Area" label above is the EMPLOYEE's area and is what
      // the OUTSTATION template's {{area}} token resolves through metricValue(), so a second
      // metric labelled "Area" would silently hijack that token.
      { label: "Captured location", value: capturedLocation.label },
      { label: "Captured brick", value: capturedLocation.brickLabel },
      { label: "Captured area / region", value: `${capturedLocation.areaLabel} · ${capturedLocation.regionLabel}` },
      {
        // Nearest-centroid match quality — shown so a far-from-any-brick capture can never
        // read as an exact one. See captured-location.ts.
        label: "Location match",
        value: capturedLocation.confidence
          ? `${capturedLocation.confidence} · captured ${formatPhoenixDateTime(request.capturedAt)} (±${request.capturedAccuracyMeters}m, ${request.offlineCaptured ? "offline sync" : "online"})`
          : `Not matched · captured ${formatPhoenixDateTime(request.capturedAt)} (±${request.capturedAccuracyMeters}m, ${request.offlineCaptured ? "offline sync" : "online"})`,
      },
      { label: "Notes", value: text(request.notes) || "—" },
    ];

    // Short human summary only — the structured fields above (rendered separately as the
    // template's metrics table) already carry every detail, so repeating them here as a
    // second wall of text made the email read as duplicated content.
    // Addressed to the employee — he is now the "To", so it reads as his confirmation.
    // The managers on Cc are reading over his shoulder, which is why the detail table
    // below it still carries the full request.
    const messageLines = [
      ...(heldForReview
        ? [
            `HELD FOR REVIEW: this request's residence/destination governorate could not be confirmed automatically, so it was NOT added to payroll yet. A Super Admin will approve or reject it.`,
          ]
        : []),
      `Your outstation expense request for ${claimedAmount} was submitted on ${formatPhoenixDateTime(request.createdAt)}.`,
      `Trip: ${formatPhoenixLongDate(request.tripStartDate)} to ${formatPhoenixLongDate(request.tripEndDate)} · Destination: ${destination} · Transportation: ${request.transportationType}`,
      `Captured location: ${capturedLocation.label}`,
      `Eligibility: ${request.eligibilityStatus} · Recommendation: ${request.approvalRecommendation}`,
      `Your manager${ccAddresses.length > 1 ? "s are" : " is"} copied on this message.`,
    ];

    await createSystemNotification({
      actionUrl: OUTSTATION_EMPLOYEE_PORTAL_URL,
      category: "general",
      channels: ["in_app", "email", "telegram", "push"],
      email: { bcc: bccAddresses, cc: ccAddresses, metrics },
      eventType: "request_submitted",
      message: messageLines.join("\n"),
      metadata: {
        actionUrl,
        claimedAmount,
        employeeHrId: request.employeeHrId,
        employeeName: request.employeeName,
        idempotencyKey: `outstation:${request.id}:request_submitted`,
        requestId: String(request.id),
        status: "Submitted",
        // Recorded so a "who was copied?" question is answerable from the audit row alone,
        // without re-deriving a reporting line that may have changed since.
        submitEnvelope: {
          bccHrIds: routing.bccHrIds,
          ccHrIds: routing.ccHrIds,
          routing: "employee_to_manager_cc_superadmin_bcc",
          toHrId: routing.toHrId,
        },
      },
      module: "outstation",
      priority: heldForReview ? "high" : "normal",
      recipientHrId: routing.toHrId,
      recordId: String(request.id),
      subjectHrId: request.employeeHrId,
      telegram: { buttons: [{ label: "Open my expenses", url: OUTSTATION_EMPLOYEE_PORTAL_URL }] },
      title: heldForReview
        ? `Your outstation expense request needs review — ${claimedAmount}`
        : `Your outstation expense request was submitted — ${claimedAmount}`,
    });
  } catch (error) {
    logError("Outstation submitted notification dispatch failed (non-blocking)", { labels: { event: "outstation_submitted_notification_dispatch_failed" }, error });
  }
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
        channels: ["in_app", "email", "telegram", "push"],
        email: {
          metrics: [
            { label: "Employee", value: r.employeeName },
            { label: "Amount", value: amount },
            { label: "Destination", value: text(r.toLabel) },
            // Were raw ISO ("2026-10-17"), which is what the owner's 2026-08-04 format
            // complaint was pointing at. Same Cairo long-date shape as the submit mail.
            { label: "Trip start", value: formatPhoenixLongDate(r.tripStartDate) },
            { label: "Trip end", value: formatPhoenixLongDate(r.tripEndDate) },
          ],
        },
        eventType: "request_rejected",
        message: `Your expense request for ${amount} (${formatPhoenixLongDate(r.tripStartDate)} to ${formatPhoenixLongDate(r.tripEndDate)}) was rejected. Reason: ${reason}`,
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
    logError("Outstation decision notification dispatch failed (non-blocking)", { labels: { event: "outstation_decision_notification_dispatch_failed" }, error });
  }
}

export async function submitOutstationRequest(
  access: AccessContext,
  input: OutstationCalculationInput,
  options: { ticketAttachments?: OutstationTicketAttachmentUploadInput[] } = {},
) {
  const calculation = await calculateOutstationExpense(access, input);
  const evidenceValidation = validateLiveArrivalEvidence({
    carEvidenceMetadata: input.carEvidenceMetadata,
    transportationType: input.transportationType,
  });

  if (!evidenceValidation.isValid) {
    throw new Error(evidenceValidation.message);
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
  // Stored for EVERY transportation type, not car only. validateLiveArrivalEvidence() above
  // already refuses a train or bus request that carries no arrival photo, so gating the
  // persistence on `car` meant the only photo that could ever satisfy the gate was silently
  // dropped for the very types the gate had just been widened to cover.
  const storedCarEvidenceMetadata = input.carEvidenceMetadata
    ? {
        ...input.carEvidenceMetadata,
        employeeHrId: calculation.employeeHrId,
        requestId: input.carEvidenceMetadata.requestId ?? null,
      }
    : null;
  let carEvidenceImagePath: string | null = null;

  // A blocked draft is recoverable; an approved 0.00 EGP fuel line is not. Condition and message
  // live in fuel-policy.ts so they can be asserted -- see the notes there on why a measured 0
  // must still submit and why train/bus must not be blocked.
  if (carTripFuelIsUnpriceable(calculation.transportationType, calculation.distanceFromResidenceKm)) {
    throw new Error(UNPRICEABLE_CAR_TRIP_MESSAGE);
  }

  // The arrival image is uploaded for every transportation type. The refusal names the
  // employee's actual transport so a train passenger is never told to photograph a car.
  if (!input.carEvidenceImageDataUrl) {
    throw new Error(
      calculation.transportationType === "car"
        ? "Car transport requires the live camera evidence image before submitting the request."
        : `A ${calculation.transportationType} trip requires the live arrival photo before submitting the request.`,
    );
  }
  if (!storedCarEvidenceMetadata) {
    throw new Error("The live arrival photo metadata is missing.");
  }

  carEvidenceImagePath = await uploadOutstationCarEvidenceImage({
    imageDataUrl: input.carEvidenceImageDataUrl,
    metadata: storedCarEvidenceMetadata,
  });

  const workloadPayload = await resolveOutstationWorkloadPayload({
    employeeHrId: calculation.employeeHrId,
    tripEndDate: calculation.tripEndDate,
    tripStartDate: calculation.tripStartDate,
  });
  const campaignRejectionReason = campaignRuleRejection({
    role: calculation.employeeRole,
    expenseType: calculation.expenseType,
    evidence: workloadPayload.workload_evidence_snapshot,
  });
  // Ticket attachments: train/bus requests MUST carry ticket evidence, and the uploaded
  // files are persisted to the request (previously the manager flow discarded them
  // entirely — only a boolean count was sent). Car uses the live photo instead.
  // Evidence is counted from files the SERVER received, never a client-supplied boolean.
  const ticketAttachmentInputs = options.ticketAttachments ?? [];
  const submitPolicy = await getActivePolicyForRole(calculation.employeeRole);
  const ticketEvidenceRejection = outstationTicketEvidenceRejection({
    hasTicketAttachments: ticketAttachmentInputs.length > 0,
    requiresTicketAttachment: submitPolicy.requiresTicketAttachment,
    transportationType: calculation.transportationType,
  });
  // Online: block the submission outright so the employee attaches the ticket now.
  // Offline: the resilience path genuinely cannot carry files, so the claim is still
  // accepted into the system but HELD for Super Admin review below — it is never
  // auto-paid without evidence, which is what this exemption used to allow.
  if (ticketEvidenceRejection && !calculation.offlineCaptured) {
    throw new Error(
      "A ticket attachment is required for train and bus expense requests. Upload the ticket before submitting.",
    );
  }

  // Admin-editable policy limits. Both were previously stored and rendered in the
  // policy editor but enforced nowhere, so a kilometre-inaccurate GPS fix or an
  // offline capture synced days later auto-paid exactly like a clean one. Neither
  // rejects — a fuzzy or stale capture is a review signal, not proof of abuse.
  const capturedAccuracyMeters = numberValue(calculation.capturedAccuracyMeters);
  const gpsAccuracyLimit = numberValue(submitPolicy.gpsAccuracyThresholdMeters);
  const gpsAccuracyHoldReason =
    gpsAccuracyLimit > 0 && capturedAccuracyMeters > gpsAccuracyLimit
      ? `The captured GPS accuracy (${Math.round(capturedAccuracyMeters)} m) is outside the ${gpsAccuracyLimit} m policy limit, so this request is held for Super Admin review before it moves to payroll.`
      : null;

  const offlineSyncLimitHours = numberValue(submitPolicy.maxOfflineSyncDelayHours);
  const capturedAtMs = calculation.capturedAt ? Date.parse(calculation.capturedAt) : Number.NaN;
  const offlineSyncDelayHours =
    calculation.offlineCaptured && Number.isFinite(capturedAtMs)
      ? (Date.now() - capturedAtMs) / 3_600_000
      : null;
  const offlineSyncHoldReason =
    offlineSyncDelayHours !== null &&
    offlineSyncLimitHours > 0 &&
    offlineSyncDelayHours > offlineSyncLimitHours
      ? `This offline capture synced ${Math.round(offlineSyncDelayHours)} hours after it was taken, beyond the ${offlineSyncLimitHours}-hour policy window, so it is held for Super Admin review before it moves to payroll.`
      : null;

  // System decision: reject on failed eligibility (distance / governorate) or the DM/TM
  // campaign rule; HOLD for Super Admin review when a governorate could not be confirmed,
  // when an offline claim arrived without its mandated ticket, or when a policy limit was
  // exceeded; otherwise accept. Rejected AND held requests are PERSISTED (not thrown) so
  // the employee sees them in their expense list, and a Super Admin can decide/override.
  const systemRejectionReason =
    calculation.eligibilityStatus === "not_eligible"
      ? calculation.eligibilityReason
      : campaignRejectionReason;
  const governorateReviewReason =
    "Your residence or destination governorate could not be confirmed automatically, so this request is held for Super Admin review before it moves to payroll.";
  const offlineTicketHoldReason =
    "This train or bus claim was captured offline and could not carry its ticket attachment, so it is held for Super Admin review before it moves to payroll.";
  const reviewHoldReasons = systemRejectionReason
    ? []
    : [
        calculation.governorateReviewRequired ? governorateReviewReason : null,
        ticketEvidenceRejection ? offlineTicketHoldReason : null,
        gpsAccuracyHoldReason,
        offlineSyncHoldReason,
      ].filter((reason): reason is string => Boolean(reason));
  const decisionStatus = systemRejectionReason
    ? "rejected_by_system"
    : reviewHoldReasons.length > 0
      ? "submitted"
      : "accepted_by_system";
  const decisionReason = systemRejectionReason
    ? systemRejectionReason
    : reviewHoldReasons.length > 0
      ? reviewHoldReasons.join(" ")
      : calculation.approvalReason;

  let uploadedTicketAttachments: OutstationTicketAttachmentMetadata[] = [];
  if (ticketAttachmentInputs.length > 0) {
    const ticketRequestDraftId = `outstation-${randomUUID()}`;
    uploadedTicketAttachments = await uploadOutstationTicketAttachments(
      ticketAttachmentInputs.map((attachment) => ({
        ...attachment,
        employeeHrId: calculation.employeeHrId,
        requestDraftId: ticketRequestDraftId,
      })),
    );
  }

  const insertPayload = {
    allowance_amount: calculation.allowanceAmount,
    allowance_breakdown_json: JSON.stringify(calculation.allowanceBreakdown),
    attachment_count: uploadedTicketAttachments.length,
    approval_reason: decisionReason,
    approval_recommendation: calculation.approvalRecommendation,
    area: calculation.employeeArea,
    calculation_status: decisionStatus,
    captured_accuracy_meters: calculation.capturedAccuracyMeters,
    captured_at: calculation.capturedAt,
    captured_latitude: calculation.capturedLatitude,
    captured_location_source: calculation.capturedLocationSource,
    captured_longitude: calculation.capturedLongitude,
    car_evidence_image_path: carEvidenceImagePath,
    car_evidence_metadata: storedCarEvidenceMetadata,
    // Set explicitly, NOT left to the column default. The default is 'pending_arrival_photo',
    // but a submitted request already HAS its arrival photo, so inheriting the default records a
    // state the row's own evidence contradicts. The column default exists to make a row that
    // skips this path fail CLOSED; it is not the value a real submission should carry.
    evidence_gate_status: nextEvidenceGateStatus({
      hasArrivalPhoto: Boolean(carEvidenceImagePath),
      hasDeparturePhoto: false,
    }),
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
    fuel_amount: calculation.fuelAmount,
    kilometer_reading: calculation.kilometerReading,
    line: calculation.employeeLine,
    medical_trip_hr_id: calculation.medicalTripHrId,
    medical_trip_name: calculation.medicalTripName,
    minimum_required_distance_km: calculation.minimumRequiredDistanceKm,
    notes: appendCarEvidenceNote(
      calculation.notes,
      storedCarEvidenceMetadata,
      calculation.transportationType,
    ),
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
    status: decisionStatus,
    submitted_at: calculation.submittedAt,
    territory_validation_status: calculation.territoryValidationStatus,
    territory_validation_reason: calculation.territoryValidationReason,
    ...workloadPayload,
    meeting_amount: input.meetingAmount ?? 0,
    other_amount: input.otherAmount ?? 0,
    go_ticket_amount: input.goTicketAmount ?? 0,
    return_ticket_amount: input.returnTicketAmount ?? 0,
    ticket_amount: calculation.ticketAmount,
    ticket_attachment_metadata: uploadedTicketAttachments,
    ticket_attachment_paths: uploadedTicketAttachments.map((attachment) => attachment.path),
    to_area: calculation.toArea,
    to_city: calculation.toCity,
    to_label: calculation.toLabel,
    transportation_type: calculation.transportationType,
    trip_end_date: calculation.tripEndDate,
    trip_start_date: calculation.tripStartDate,
  };

  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .insert(insertPayload)
    .select("*")
    .single();

  if (error) {
    await deleteOutstationCarEvidenceImage(carEvidenceImagePath);
    await deleteOutstationTicketAttachments(
      uploadedTicketAttachments.map((attachment) => attachment.path),
    );
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
        notes: appendCarEvidenceNote(
          calculation.notes,
          metadataWithRequestId,
          calculation.transportationType,
        ),
      })
      .eq("id", data.id);

    if (!metadataUpdateError) {
      persistedCarEvidenceMetadata = metadataWithRequestId;
    }
  }

  const submitted = mapOutstationRequestRow({
    ...data,
    car_evidence_image_path: carEvidenceImagePath,
    car_evidence_metadata: persistedCarEvidenceMetadata,
    notes: persistedCarEvidenceMetadata
      ? appendCarEvidenceNote(
          calculation.notes,
          persistedCarEvidenceMetadata,
          calculation.transportationType,
        )
      : data.notes,
  });
  if (decisionStatus === "rejected_by_system") {
    // Persisted, employee notified, no payroll push. Super Admin can override later.
    await notifyOutstationDecision({ comment: decisionReason, decision: "reject", request: submitted });
    return submitted;
  }
  if (decisionStatus === "submitted") {
    // Held for Super Admin review (governorate unconfirmed): persisted as pending, NOT
    // pushed to payroll. Alert Super Admins so they can accept/override or reject it.
    await notifyOutstationSubmitted(submitted, { heldForReview: true });
    return submitted;
  }
  await pushAcceptedOutstationExpenseToPayroll(submitted, systemAccessContext);
  await notifyOutstationSubmitted(submitted);
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
    departureCapturedAt: isoString(row.departure_captured_at) || null,
    departureEvidenceImagePath: text(row.departure_evidence_image_path) || null,
    departureEvidenceMetadata: safeJsonParse<OutstationDepartureEvidenceMetadata | null>(
      row.departure_evidence_metadata,
      null,
    ),
    // Fall back to the pre-gate states, not to the strict ones: a row read before the 2026-08-04
    // migration has applied genuinely IS exempt, and defaulting it to "pending" would make the
    // gate withhold payroll from every historical request the moment this code deploys ahead of
    // the migration. The migration then stamps the real value.
    evidenceGateStatus:
      (text(row.evidence_gate_status) as OutstationEvidenceGateStatus) || "grandfathered",
    workloadCaptureAttempts: Math.max(0, Math.trunc(numberValue(row.workload_capture_attempts))),
    workloadLastAttemptAt: isoString(row.workload_last_attempt_at) || null,
    workloadLastAttemptError: text(row.workload_last_attempt_error) || null,
    workloadGateStatus:
      (text(row.workload_gate_status) as OutstationWorkloadGateStatus) || "grandfathered",
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
  };
}

/**
 * Signs both evidence kinds a request can carry: the car photo AND the ticket attachments.
 *
 * Tickets were previously left unsigned here, so the admin request detail received only
 * their metadata (name/type/size) and rendered each one as an inert row — it looked
 * clickable but had no href, which is the "the ticket attachment doesn't open" report of
 * 2026-08-04. The Expense Approvals page never hit this because it fetches its own signed
 * URLs from /api/admin/outstation/[id]/attachments.
 */
async function attachCarEvidenceSignedUrls(
  requests: OutstationExpenseRequest[],
): Promise<OutstationExpenseRequest[]> {
  return Promise.all(
    requests.map(async (request) => {
      const [carEvidenceImageUrl, ticketAttachmentUrls] = await Promise.all([
        createOutstationCarEvidenceSignedUrl(request.carEvidenceImagePath),
        createOutstationEvidenceSignedUrls(request.ticketAttachmentPaths ?? []),
      ]);

      return {
        ...request,
        carEvidenceImageUrl,
        ticketAttachmentUrls,
      };
    }),
  );
}

export type PendingOutstationReviewRequest = {
  id: number;
  tripStartDate: string;
  tripEndDate: string;
  destination: string;
  amount: number;
  transportationType: string;
  reason: string;
  submittedAt: string;
};

/**
 * The caller's OWN outstation requests that are held for Super Admin review
 * (status "submitted"). These never enter the payroll ledger, so they are
 * invisible on the ledger-backed expense dashboard — this surfaces them to the
 * submitter so a governorate-held request is not silently lost.
 */
export async function getOwnPendingOutstationReviewRequests(
  access: AccessContext,
): Promise<PendingOutstationReviewRequest[]> {
  const callerHrId = normalizeHrIdForAccess(access.hrId);
  if (!callerHrId) return [];
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .select("*")
    .eq("status", "submitted")
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  return (data as Array<Record<string, unknown>>)
    .map(mapOutstationRequestRow)
    .filter((row) => normalizeHrIdForAccess(row.employeeHrId) === callerHrId)
    .map((row) => ({
      id: row.id,
      tripStartDate: row.tripStartDate,
      tripEndDate: row.tripEndDate,
      destination: text(row.toLabel) || text(row.toCity) || text(row.toArea) || "—",
      amount: row.claimedTotalAmount || row.expectedTotalAmount || 0,
      transportationType: row.transportationType,
      reason:
        text(row.approvalReason) ||
        text(row.eligibilityReason) ||
        "Held for Super Admin review.",
      submittedAt: row.submittedAt || row.createdAt,
    }));
}

/**
 * Extra-ticket count for each of the caller's OWN train/bus requests, keyed by
 * request id. Powers the "Extra Tickets" tracking column on the employee
 * portal's Expense Dashboard table — the ledger row data (ExpenseRow) has no
 * ticket count of its own, so the dashboard looks it up here.
 */
export async function getOwnOutstationTicketCounts(
  access: AccessContext,
): Promise<Record<number, number>> {
  const callerHrId = normalizeHrIdForAccess(access.hrId);
  if (!callerHrId) return {};
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .select("*")
    .in("transportation_type", ["train", "bus"]);
  if (error || !data) return {};
  const counts: Record<number, number> = {};
  for (const row of (data as Array<Record<string, unknown>>).map(mapOutstationRequestRow)) {
    if (normalizeHrIdForAccess(row.employeeHrId) !== callerHrId) continue;
    counts[row.id] = row.ticketAttachmentPaths.length;
  }
  return counts;
}

/**
 * Employee self-service: add ONE OR MORE extra tickets (each an attachment +
 * cost) plus a shared reason to their own already-submitted train/bus request —
 * e.g. an unplanned multi-leg trip needing several ticket legs. The summed extra
 * cost is ADDED to the ticket/travel total (allowance is never touched); when the
 * request is already accepted and linked to an unpaid payroll expense, the linked
 * payroll addition is re-synced to the new total. Blocked once the expense has
 * been paid, for car trips, and for other people's requests.
 */
export async function addExtraTicketsToOwnOutstationRequest(
  requestId: number,
  access: AccessContext,
  input: {
    destination: string;
    tickets: Array<{ ticket: OutstationTicketAttachmentUploadInput; amount: number }>;
    reason: string;
  },
): Promise<OutstationExpenseRequest> {
  const callerHrId = normalizeHrIdForAccess(access.hrId);
  if (!callerHrId) {
    throw new Error("Your session is not linked to an employee. Please sign in again.");
  }

  const existing = await getOutstationRequestById(requestId);
  if (!existing) throw new Error("Outstation request was not found.");
  if (normalizeHrIdForAccess(existing.employeeHrId) !== callerHrId) {
    throw new Error("Forbidden: you can only add tickets to your own expense request.");
  }
  if (existing.transportationType !== "train" && existing.transportationType !== "bus") {
    throw new Error("Extra tickets can only be added to train or bus expense requests.");
  }
  if (existing.status.startsWith("rejected")) {
    throw new Error("This request was rejected and cannot accept extra tickets.");
  }

  const linkedPayroll = await getLinkedOutstationPayrollExpense(existing.id);
  if (linkedPayroll?.importedPayrollBatchId || linkedPayroll?.importedToPayrollAt) {
    throw new Error("This outstation expense has already been added to payroll and cannot be edited.");
  }

  const tickets = input.tickets ?? [];
  if (tickets.length === 0) {
    throw new Error("Upload at least one ticket to add.");
  }
  const amounts = tickets.map((entry) => roundMoney(Math.max(0, Number(entry.amount))));
  if (amounts.some((amount) => !(amount > 0))) {
    throw new Error("Enter a valid cost greater than zero for every ticket.");
  }
  const extraTotal = roundMoney(amounts.reduce((sum, amount) => sum + amount, 0));
  const destination = cleanText(input.destination);
  if (!destination) {
    throw new Error("A destination for the extra ticket(s) is required.");
  }
  const reason = cleanText(input.reason);
  if (!reason) {
    throw new Error("A reason for the extra tickets is required.");
  }

  const requestDraftId = `outstation-extra-${randomUUID()}`;
  const uploaded = await uploadOutstationTicketAttachments(
    tickets.map((entry) => ({
      ...entry.ticket,
      employeeHrId: existing.employeeHrId,
      requestDraftId,
    })),
  );

  try {
    const newTicketAmount = roundMoney(existing.ticketAmount + extraTotal);
    const existingTravelCost =
      existing.reportTravelCost ?? roundMoney(existing.fuelAmount + existing.ticketAmount);
    const newTravelCost = roundMoney(existingTravelCost + extraTotal);
    const newExpectedTotal = reportExpectedTotal({
      allowanceAmount: existing.allowanceAmount,
      eligibilityStatus: existing.eligibilityStatus,
      meetingAmount: existing.reportMeetingAmount,
      otherAmount: existing.reportOtherAmount,
      travelCost: newTravelCost,
    });
    const newClaimedTotal =
      existing.claimedTotalAmount > 0
        ? roundMoney(existing.claimedTotalAmount + extraTotal)
        : newExpectedTotal;

    const mergedPaths = [...existing.ticketAttachmentPaths, ...uploaded.map((a) => a.path)];
    const mergedMetadata = [...existing.ticketAttachmentMetadata, ...uploaded];
    const noteLine = `${uploaded.length} extra ticket(s) added to ${destination} (${formatEgp(extraTotal)}): ${reason}`;
    const newNotes = existing.notes ? `${existing.notes}\n${noteLine}` : noteLine;
    const now = new Date().toISOString();

    const { data, error } = await getSupabaseAdmin()
      .from("outstation_expense_requests")
      .update({
        attachment_count: mergedMetadata.length,
        claimed_total_amount: newClaimedTotal,
        expected_total_amount: newExpectedTotal,
        notes: newNotes,
        report_travel_cost: newTravelCost,
        ticket_amount: newTicketAmount,
        ticket_attachment_metadata: mergedMetadata,
        ticket_attachment_paths: mergedPaths,
        updated_at: now,
      })
      .eq("id", requestId)
      .eq("status", existing.status)
      .select("*")
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data) throw new Error("This request just changed status. Refresh and try again.");

    const updated = mapOutstationRequestRow(data as Record<string, unknown>);
    const syncedPayrollRows = await syncLinkedOutstationPayrollExpense({
      access,
      linkedPayroll,
      request: updated,
    });

    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? resolveEmployeeIdentityId(access) ?? "system",
      entityId: String(updated.id),
      entityType: "outstation_request",
      newValues: {
        destination,
        extraTicketCount: uploaded.length,
        extraTicketTotal: extraTotal,
        newExpectedTotal: updated.expectedTotalAmount,
        payrollExpenseRows: syncedPayrollRows,
        reason,
        source: "employee_extra_ticket",
        status: updated.status,
      },
      summary: `Employee added ${uploaded.length} extra ticket(s) to ${destination} (${formatEgp(extraTotal)}) on outstation request ${updated.id}.`,
    });

    return updated;
  } catch (error) {
    await deleteOutstationTicketAttachments(uploaded.map((a) => a.path));
    throw error;
  }
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

  const mapped = ((data ?? []) as Array<Record<string, unknown>>).map(mapOutstationRequestRow);
  // Brick / area / region per row, so the admin detail can show a place name instead of the
  // raw coordinate pair. One cached centroid load for the whole page — see captured-location.ts.
  const requests = await attachOutstationCapturedLocations(mapped);
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

  const mapped = mapOutstationRequestRow(data as Record<string, unknown>);
  const request = {
    ...mapped,
    capturedLocation: await resolveOutstationCapturedLocation({
      latitude: mapped.capturedLatitude,
      longitude: mapped.capturedLongitude,
    }),
  };
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
  approvedAmount: number | null;
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
    .from("outstation_expenses")
    .select(
      `id,imported_payroll_batch_id,imported_to_payroll_at,report_id,${EXPENSE_DECISION_SELECT}`,
    )
    .eq("trip_id", outstationPayrollTripId(requestId))
    .maybeSingle();

  if (error) {
    if (isPayrollExpensesSchemaMissing(error)) return null;
    throw new Error(error.message);
  }

  if (!data) return null;

  const approvedAmount = Number(data.approved_amount);

  return {
    // Already in the select (EXPENSE_DECISION_SELECT carries it) — surfaced so the approvals queue
    // can tell "HR trimmed this trip" from "nobody has touched the claim".
    approvedAmount: data.approved_amount == null || !Number.isFinite(approvedAmount) ? null : approvedAmount,
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
  if (!input.request.status.startsWith("accepted")) return 0;
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

// Pushes an already-accepted outstation request into payroll (idempotent — skips if the
// linked expense row was already imported into a paid batch). Used by the auto-accept at
// submit and by a Super Admin's accept override.
async function pushAcceptedOutstationExpenseToPayroll(
  request: OutstationExpenseRequest,
  access: AccessContext,
): Promise<number> {
  const linkedPayroll = await getLinkedOutstationPayrollExpense(request.id);
  if (linkedPayroll?.importedPayrollBatchId || linkedPayroll?.importedToPayrollAt) {
    return 0;
  }
  const expenseRecord = mapOutstationRequestToPayrollExpenseRecord(request, {
    reportId: linkedPayroll?.reportId ?? null,
  });
  const savedExpenses = await savePayrollExpenseApprovals({
    fileName: `outstation-request-${request.id}.workflow`,
    records: [expenseRecord],
    reportId: linkedPayroll?.reportId ?? null,
  }, access);
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? resolveEmployeeIdentityId(access) ?? "system",
    entityId: String(request.id),
    entityType: "outstation_request",
    newValues: {
      expenseTripId: expenseRecord.tripId,
      payrollExpenseRows: savedExpenses.length,
      status: request.status,
    },
    summary: `Outstation request ${request.id} accepted; expense pushed to payroll.`,
  });
  return savedExpenses.length;
}

// Accept an outstation request and push it to payroll. At submit this runs as the system
// (accepted_by_system); a Super Admin may also call it to OVERRIDE a system rejection
// (accepted_by_admin). It intentionally does not block on the prior status — accepting a
// rejected request is the whole point of the override.
export async function approveOutstationRequestForPayroll(
  requestId: number,
  access: AccessContext,
  options: { comment?: string | null } = {},
) {
  await assertOutstationAdminAccess(access, "approve");

  const existing = await getOutstationRequestById(requestId);
  if (!existing) throw new Error("Outstation request was not found.");
  const linkedPayroll = await getLinkedOutstationPayrollExpense(existing.id);
  if (linkedPayroll?.importedPayrollBatchId || linkedPayroll?.importedToPayrollAt) {
    throw new Error("This outstation expense has already been added to payroll and cannot be changed.");
  }

  // Validate the accept transition through the workflow registry for the normal path (a
  // freshly submitted / needs-review request). A Super Admin OVERRIDE of an already-decided
  // request skips it — accepting a rejected request is not a registry transition, and the
  // Super-Admin code gate above is the control.
  if (!existing.status.startsWith("rejected") && !existing.status.startsWith("accepted")) {
    await assertOutstationExpenseWorkflowTransition({
      access,
      actionKey: "approve",
      expectedNextStatus: "approved",
      status: existing.status,
    });
  }

  const acceptedStatus = access.scope === "system" ? "accepted_by_system" : "accepted_by_admin";
  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .update({
      approval_reason: cleanText(options.comment) ?? existing.approvalReason,
      calculation_status: acceptedStatus,
      status: acceptedStatus,
      updated_at: now,
    })
    .eq("id", requestId)
    .select("*")
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) {
    throw new Error("Outstation request state changed. Refresh and retry.");
  }

  const request = mapOutstationRequestRow(data as Record<string, unknown>);

  // ── The two-photo + workload gate (owner rule, 2026-08-04) ──────────────────
  // Acceptance and PAYMENT are separated here. The request is still accepted and recorded
  // above — what the gate withholds is the push into payroll, until both photos and the trip
  // workload exist. Throwing instead would leave the employee unable to submit at all, which
  // is not what was asked for.
  //
  // A request that pre-dates the rule reads 'grandfathered' and passes untouched. That is also
  // what a row read BEFORE the migration applies returns (see mapOutstationRequestRow), so this
  // code deploying ahead of the migration cannot strand a single payment.
  //
  // Requests held here are released by releaseOutstationRequestToPayrollIfReady, which runs as
  // soon as the missing evidence lands.
  const gate = resolveOutstationGateState({
    evidenceGateStatus: request.evidenceGateStatus,
    hasArrivalPhoto: Boolean(request.carEvidenceImagePath),
    hasDeparturePhoto: Boolean(request.departureEvidenceImagePath),
    workloadGateStatus: request.workloadGateStatus,
  });

  const payrollExpenseRows = gate.isPayrollEligible
    ? await pushAcceptedOutstationExpenseToPayroll(request, access)
    : [];

  if (!gate.isPayrollEligible) {
    logError("Outstation request accepted but held out of payroll by the evidence gate", {
      labels: {
        blocker: gate.blocker ?? "unknown",
        event: "outstation_request_held_by_gate",
        requestId: String(request.id),
      },
    });
  }

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? resolveEmployeeIdentityId(access) ?? "system",
    entityId: String(request.id),
    entityType: "outstation_request",
    newValues: { gateBlocker: gate.blocker, inPayroll: gate.isPayrollEligible, status: request.status },
    oldValues: { status: existing.status },
    summary: gate.isPayrollEligible
      ? `Outstation request ${request.id} accepted (${acceptedStatus}) and added to payroll.`
      : `Outstation request ${request.id} accepted (${acceptedStatus}) but HELD out of payroll: ${gate.message}`,
  });

  if (!existing.status.startsWith("accepted")) {
    await notifyOutstationSubmitted(request);
  }

  return {
    expenseTripId: outstationPayrollTripId(request.id),
    gate,
    payrollExpenseRows,
    request,
  };
}

/**
 * Push a previously-held request into payroll once its evidence is complete.
 *
 * The counterpart to the gate in approveOutstationRequestForPayroll: that function withholds the
 * payroll row, this one delivers it when the missing piece finally arrives. Without this, gating
 * a request would strand it forever, which is strictly worse than not gating it at all.
 *
 * Safe to call repeatedly and from several triggers — it re-reads the request, re-resolves the
 * gate, and refuses to act unless the request is accepted, eligible, and not already in payroll.
 * Never throws: it runs as a follow-on to a photo or workload capture, and a payroll hiccup must
 * not fail the capture the employee just made.
 */
export async function releaseOutstationRequestToPayrollIfReady(
  requestId: number,
  access: AccessContext,
): Promise<{ released: boolean; reason: string }> {
  try {
    const request = await getOutstationRequestById(requestId);
    if (!request) return { reason: "The request is no longer available.", released: false };

    // Only an ACCEPTED request belongs in payroll. A rejected or still-pending one is not held
    // by the evidence gate — it is held by a decision, and this must never override that.
    if (!request.status.startsWith("accepted")) {
      return { reason: `The request is ${request.status}, so it is not waiting on evidence.`, released: false };
    }

    const linked = await getLinkedOutstationPayrollExpense(request.id);
    if (linked) {
      return { reason: "The request is already in payroll.", released: false };
    }

    const gate = resolveOutstationGateState({
      evidenceGateStatus: request.evidenceGateStatus,
      hasArrivalPhoto: Boolean(request.carEvidenceImagePath),
      hasDeparturePhoto: Boolean(request.departureEvidenceImagePath),
      workloadGateStatus: request.workloadGateStatus,
    });
    if (!gate.isPayrollEligible) return { reason: gate.message, released: false };

    await pushAcceptedOutstationExpenseToPayroll(request, access);
    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? resolveEmployeeIdentityId(access) ?? "system",
      entityId: String(request.id),
      entityType: "outstation_request",
      newValues: { inPayroll: true },
      oldValues: { inPayroll: false },
      summary: `Outstation request ${request.id} released into payroll — evidence complete.`,
    });
    return { reason: gate.message, released: true };
  } catch (error) {
    logError("Outstation payroll release failed (non-blocking)", {
      error,
      labels: { event: "outstation_payroll_release_failed", requestId: String(requestId) },
    });
    return {
      reason: error instanceof Error ? error.message : "The payroll release failed.",
      released: false,
    };
  }
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
        (request) => request.claimedTotalAmount,
      ).map((row) => ({
        label: row.label,
        totalExpenses: roundMoney(row.value),
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
    },
    kpis: {
      totalClaimed: roundMoney(sumBy(requests, (request) => request.claimedTotalAmount)),
      totalExpected: roundMoney(sumBy(requests, (request) => request.expectedTotalAmount)),
      totalRequests: requests.length,
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
  ticketAmount: number;
  travelCost: number;
  sameDayTrip: boolean;
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
  const ticketAmount =
    input.transportationType === "car" ? 0 : roundMoney(Math.max(0, travelCost - fuelAmount));
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
    ticketAmount,
    travelCost,
    sameDayTrip: allowance.sameDayTrip,
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
  // Keep fuelAmount + ticketAmount === reportTravelCost: the payroll mapper rebuilds
  // travel cost from those two columns, so a ticket trip that leaves ticket_amount at 0
  // reaches payroll with the ticket price missing.
  const ticketAmount =
    input.transportationType === "car" ? 0 : roundMoney(Math.max(0, reportTravelCost - fuelAmount));
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
      territory_validation_reason: "Admin-created expense; territory check not applicable.",
      territory_validation_status: "not_available",
      ...workloadPayload,
      meeting_amount: input.meetingAmount ?? 0,
      other_amount: input.otherAmount ?? 0,
      ticket_amount: ticketAmount,
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
  const ticketAmount =
    transportationType === "car" ? 0 : roundMoney(Math.max(0, reportTravelCost - fuelAmount));
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
    ticket_amount: ticketAmount,
    transportation_type: transportationType,
    trip_end_date: tripEndDate,
    trip_start_date: tripStartDate,
    updated_at: now,
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
    .from("outstation_expenses")
    .select(
      `id,imported_payroll_batch_id,imported_to_payroll_at,report_id,${EXPENSE_DECISION_SELECT}`,
    )
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

  if (!existing.status.startsWith("rejected")) {
    await assertOutstationExpenseWorkflowTransition({
      access,
      actionKey: existing.status.startsWith("accepted") ? "reject_before_payroll" : "reject",
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

  if (existing.status.startsWith("accepted") && linkedRows.length > 0) {
    const { error: deletePayrollError } = await supabase
      .from("outstation_expenses")
      .delete()
      .eq("trip_id", expenseTripId);

    if (deletePayrollError) throw new Error(deletePayrollError.message);

    // The trip is gone from the expense table, but an already-confirmed payroll Expenses step
    // still holds the figure it was confirmed with and would keep reimbursing the rejected trip.
    await resyncPayrollExpenseStepForRemovedTrips(linkedRows);

    for (const reportId of linkedReportIds) {
      const { count: remainingRows, error: remainingRowsError } = await supabase
        .from("outstation_expenses")
        .select("id", { count: "exact", head: true })
        .eq("report_id", reportId);

      if (remainingRowsError) throw new Error(remainingRowsError.message);
      if ((remainingRows ?? 0) > 0) continue;

      const { error: deleteReportError } = await supabase
        .from("outstation_expense_reports")
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
      calculation_status: "rejected_by_admin",
      status: "rejected_by_admin",
      updated_at: now,
    })
    .eq("id", requestId)
    .in("status", ["submitted", "approved", "rejected", "needs_review", "accepted_by_system", "accepted_by_admin", "rejected_by_system", "rejected_by_admin"])
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
      removedPayrollExpenseRows: existing.status.startsWith("accepted") ? linkedRows.length : 0,
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

/** One queue row's decision, narrowed to the fields the outstation workflow actually needs. */
export type OutstationRequestExpenseDecisionInput = {
  approvedAmount?: number | null;
  hrApproved?: boolean;
  hrComment?: string;
  status?: string | null;
  total: number;
  tripId: string;
};

export type OutstationRequestExpenseDecisionResult = {
  applied: number;
  /** Rows deliberately not written, each with a reason the reviewer can act on. */
  skipped: Array<{ reason: string; tripId: string }>;
};

/**
 * Writes HR's adjusted payable figure onto the request's linked payroll row.
 *
 * Goes through `savePayrollExpenseApprovals` rather than a bare UPDATE for one reason: that is
 * what re-syncs an already-confirmed payroll Expenses step. A direct write would leave a confirmed
 * step still reimbursing the figure it was confirmed with — the exact failure the July 2026 resync
 * was built for.
 *
 * Returns false when the request has no linked payroll row at all, which happens when the evidence
 * gate is holding an accepted trip out of payroll. There is nothing to carry the figure, so the
 * caller reports that instead of pretending the amount was stored.
 */
async function writeOutstationRequestPayableAmount(input: {
  access: AccessContext;
  approvedAmount: number | null;
  hrComment: string;
  request: OutstationExpenseRequest;
}): Promise<boolean> {
  const linked = await getLinkedOutstationPayrollExpense(input.request.id);
  if (!linked) return false;

  const record = mapOutstationRequestToPayrollExpenseRecord(input.request, {
    hrComment: input.hrComment.trim() || null,
    reportId: linked.reportId,
  });

  await savePayrollExpenseApprovals(
    {
      fileName: `outstation-request-${input.request.id}.workflow`,
      records: [{ ...record, approvedAmount: input.approvedAmount }],
      reportId: linked.reportId,
    },
    input.access,
  );

  return true;
}

/**
 * Applies Expense Approvals decisions to Phoenix-submitted outstation requests.
 *
 * The screen submits its whole visible record set on every Save, so most rows arriving here are
 * unchanged — `planOutstationRequestDecision` filters those to "skip" and they never reach the
 * workflow, never re-push payroll and never write an audit row. Only a genuine state change or a
 * moved payable figure does anything.
 *
 * Each row is decided independently: one refusal does not abandon the rest of the batch, and every
 * refusal comes back named so the queue can say which trip was not written and why. Approve and
 * reject delegate wholesale to the same two functions the Queue tab calls, so the evidence gate,
 * the in-payroll lock, audit logging and the employee notification are inherited, not re-created.
 */
export async function applyOutstationRequestExpenseDecisions(input: {
  access: AccessContext;
  entries: ReadonlyArray<{ record: OutstationRequestExpenseDecisionInput; requestId: number }>;
}): Promise<OutstationRequestExpenseDecisionResult> {
  let applied = 0;
  const skipped: Array<{ reason: string; tripId: string }> = [];

  for (const { record, requestId } of input.entries) {
    const hrComment = String(record.hrComment ?? "");
    const requestedAmount = Number(record.approvedAmount ?? record.total);

    // The figure that belongs in `approved_amount`: null unless HR moved it off the claim, so an
    // untouched trip is never rewritten with a redundant copy of its own total.
    const payableAmount = isAdjustedAmount(requestedAmount, record.total) ? requestedAmount : null;

    // Everything for one row sits inside the try, lookups included: a single unreadable request
    // must cost that row and nothing else. The imported expense rows in the same Save are written
    // after this returns, and one bad request row must not take them down with it.
    try {
      const existing = await getOutstationRequestById(requestId);
      if (!existing) {
        skipped.push({ reason: "the request no longer exists", tripId: record.tripId });
        continue;
      }

      const linked = await getLinkedOutstationPayrollExpense(requestId);
      const plan = planOutstationRequestDecision({
        claimedTotal: record.total,
        currentStatus: existing.status,
        decision: {
          approvedAmount: requestedAmount,
          hrApproved: Boolean(record.hrApproved),
          hrComment,
          status: record.status,
        },
        storedApprovedAmount: linked?.approvedAmount ?? null,
      });

      if (plan.action === "skip") continue;
      if (plan.action === "blocked") {
        skipped.push({ reason: plan.reason ?? "this decision is not supported here", tripId: record.tripId });
        continue;
      }

      if (plan.action === "reject") {
        await rejectOutstationRequestAsAdmin(requestId, input.access, { comment: hrComment });
        applied += 1;
        continue;
      }

      const request =
        plan.action === "approve"
          ? (await approveOutstationRequestForPayroll(requestId, input.access, { comment: hrComment || null }))
              .request
          : existing;

      applied += 1;

      // A plain approve needs no second write: accepting the request already pushed its payroll
      // row, and the reason is stored on the request itself. Only a payable figure that moved off
      // the claim (or one being cleared back onto it) has anything left to write.
      if (plan.action !== "amount" && payableAmount === null) continue;

      const stored = await writeOutstationRequestPayableAmount({
        access: input.access,
        approvedAmount: payableAmount,
        hrComment,
        request,
      });

      if (!stored) {
        skipped.push({
          reason:
            "the decision was saved, but the adjusted amount was not — this trip is held out of payroll until its photos and workload land",
          tripId: record.tripId,
        });
      }
    } catch (error) {
      skipped.push({
        reason: error instanceof Error ? error.message : "the decision could not be applied",
        tripId: record.tripId,
      });
    }
  }

  return { applied, skipped };
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
    .from("outstation_expenses")
    .select(
      `id,imported_payroll_batch_id,imported_to_payroll_at,report_id,${EXPENSE_DECISION_SELECT}`,
    )
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
      .from("outstation_expenses")
      .delete({ count: "exact" })
      .eq("trip_id", expenseTripId);

    if (deletePayrollError) throw new Error(deletePayrollError.message);
    deletedPayrollRows = count ?? linkedRows.length;

    // Same reason as the rejection path: a confirmed Expenses step keeps paying a deleted trip.
    await resyncPayrollExpenseStepForRemovedTrips(linkedRows);

    for (const reportId of linkedReportIds) {
      const { count: remainingRows, error: remainingRowsError } = await supabase
        .from("outstation_expenses")
        .select("id", { count: "exact", head: true })
        .eq("report_id", reportId);

      if (remainingRowsError) throw new Error(remainingRowsError.message);
      if ((remainingRows ?? 0) > 0) continue;

      const { error: deleteReportError } = await supabase
        .from("outstation_expense_reports")
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
  if (!(await resolveNotificationRoleEnabled("outstation_sla_reminder"))) return { processed: 0, errors: 0 };

  const today = new Date().toISOString().slice(0, 10);
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .select("id, employee_name, employee_hr_id, trip_start_date, created_at")
    .eq("status", "submitted");
  if (error) return { processed: 0, errors: 1 };

  // Find HR-level approver HR IDs from app_auth_users
  const notifyRoles = await resolveNotificationRoleRecipients("outstation_sla_reminder");
  const { data: approvers } = await supabase
    .from("app_auth_users")
    .select("hr_id")
    .in("role", notifyRoles)
    .eq("is_active", true);
  const approverHrIds = (approvers ?? []).map((a) => String(a.hr_id)).filter(Boolean);
  if (approverHrIds.length === 0) return { processed: 0, errors: 0 };

  let processed = 0;
  let errors = 0;
  const now = Date.now();
  for (const row of data ?? []) {
    const ageDays = Math.max(0, Math.floor((now - new Date(row.created_at as string).getTime()) / 86400000));
    if (ageDays < 3) continue;
    try {
      await createSystemNotificationForRecipients(
        {
          channels: ["email", "push"],
          eventType: "outstation_sla_reminder",
          message: `${String(row.employee_name)}'s outstation request (trip: ${String(row.trip_start_date)}) has been pending ${ageDays} day${ageDays === 1 ? "" : "s"}.`,
          metadata: { idempotencyKey: `outstation:${String(row.id)}:sla:${today}` },
          module: "outstation",
          priority: "normal",
          title: "Outstation approval overdue",
          actionUrl: `/admin/approvals-hub?module=outstation&id=${String(row.id)}`,
          email: {
            ctaHref: `/admin/approvals-hub?module=outstation&id=${String(row.id)}`,
            ctaLabel: "Review now",
            tone: "warning" as const,
          },
        },
        approverHrIds,
      );
      processed += approverHrIds.length;
    } catch (error) {
      logError("Outstation SLA reminder failed for recipients", { labels: { event: "outstation_sla_reminder_failed", cron: "outstation-sla-reminder", requestId: String(row.id) }, error });
      errors += approverHrIds.length;
    }
  }
  return { processed, errors };
}

// ── Departure photo capture ───────────────────────────────────────────────────
// The second of the two photos every request must carry (owner request 2026-08-04). Records the
// photo, reviews it against the arrival capture, and advances the evidence gate.
//
// The review NEVER refuses the photo — the owner chose to flag a suspicious pair rather than
// block it, so an employee with a poor GPS fix is never stranded. What it does is make the
// distance, the gap and a late capture visible to whoever approves the request.
export async function captureOutstationDeparturePhoto(
  access: AccessContext,
  input: { imageDataUrl: string; latitude?: number | null; locationLabel?: string | null; longitude?: number | null; requestId: number },
): Promise<{ gateStatus: OutstationEvidenceGateStatus; review: DepartureEvidenceReview }> {
  const request = await getOutstationRequestById(input.requestId);
  if (!request) throw new Error("That outstation request is not available.");

  // Own request only, unless the caller is an outstation admin. Checked here rather than in the
  // route because this is the security boundary — a second caller must not be able to skip it.
  const callerHrId = normalizeHrIdForAccess(access.hrId);
  const ownsRequest =
    Boolean(callerHrId) && callerHrId === normalizeHrIdForAccess(request.employeeHrId);
  if (!ownsRequest) {
    await assertOutstationAdminAccess(access, "approve");
  }

  if (request.departureEvidenceImagePath) {
    // Not an overwrite: the departure photo is the evidence that he was still there when he said
    // he was, so a later replacement would defeat the point.
    throw new Error("A departure photo has already been captured for this request.");
  }
  if (!request.carEvidenceImagePath) {
    throw new Error(
      "The arrival photo is missing, so a departure photo cannot be accepted yet — capture the arrival photo first.",
    );
  }

  const capturedAt = new Date().toISOString();
  const review = reviewDepartureEvidence({
    arrivalCapturedAt: request.carEvidenceMetadata?.capturedAt ?? request.capturedAt,
    arrivalLatitude: request.carEvidenceMetadata?.capturedLatitude ?? request.capturedLatitude,
    arrivalLongitude: request.carEvidenceMetadata?.capturedLongitude ?? request.capturedLongitude,
    departureCapturedAt: capturedAt,
    departureLatitude: input.latitude ?? null,
    departureLongitude: input.longitude ?? null,
    tripEndDate: request.tripEndDate,
  });

  const path = await uploadOutstationDepartureEvidenceImage({
    employeeHrId: request.employeeHrId,
    imageDataUrl: input.imageDataUrl,
    requestId: request.id,
  });

  const metadata: OutstationDepartureEvidenceMetadata = {
    capturedAt,
    capturedLatitude: typeof input.latitude === "number" ? input.latitude : null,
    capturedLocationLabel: text(input.locationLabel) || null,
    capturedLongitude: typeof input.longitude === "number" ? input.longitude : null,
    distanceFromArrivalKm: review.distanceFromArrivalKm,
    flags: review.flags,
    minutesAfterArrival: review.minutesAfterArrival,
    source: "live_camera",
    summary: review.summary,
  };

  const gateStatus = nextEvidenceGateStatus({
    hasArrivalPhoto: Boolean(request.carEvidenceImagePath),
    hasDeparturePhoto: true,
  });

  const { error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .update({
      departure_captured_at: capturedAt,
      departure_evidence_image_path: path,
      departure_evidence_metadata: metadata,
      evidence_gate_status: gateStatus,
      updated_at: capturedAt,
    })
    .eq("id", request.id);

  if (error) {
    // The photo is already in storage. Leave it: an orphaned object is cheap, whereas deleting it
    // here would discard the employee's only capture if the retry then succeeds against a row
    // that did save. The upload is keyed on the request id, so a retry overwrites nothing.
    throw new Error(`The departure photo was uploaded but the request could not be updated: ${error.message}`);
  }

  // With both photos in hand the trip is over, so this is the natural moment to grab the
  // workload — and then to release the request into payroll if that succeeded. Both steps are
  // best-effort follow-ons: the photo is already saved, and neither a dead CRM nor a payroll
  // hiccup may turn the employee's successful capture into an error he has to retry.
  await captureWorkloadAndReleaseIfReady(request, access);

  return { gateStatus, review };
}

/**
 * Attempt the CRM workload grab for a request whose photos are complete, then release it into
 * payroll if that closed the last gate.
 *
 * A FAILED grab is recorded, not swallowed: workload_capture_attempts, the timestamp and the
 * error text are what the Super Admin repair screen reads to decide between retrying and typing
 * the numbers in. Deliberately never writes zeros on failure — a zero workload reads as "he did
 * no work", which is a reason to reject a claim, not a missing measurement.
 */
async function captureWorkloadAndReleaseIfReady(
  request: OutstationExpenseRequest,
  access: AccessContext,
) {
  try {
    if (request.workloadGateStatus !== "pending_workload") {
      await releaseOutstationRequestToPayrollIfReady(request.id, access);
      return;
    }

    const capture = await captureOutstationTripWorkload({
      employeeHrId: request.employeeHrId,
      employeeRole: request.employeeRole,
      tripEndDate: request.tripEndDate,
      tripStartDate: request.tripStartDate,
    });

    const now = new Date().toISOString();
    if (!capture.captured) {
      await getSupabaseAdmin()
        .from("outstation_expense_requests")
        .update({
          workload_capture_attempts: (request.workloadCaptureAttempts ?? 0) + 1,
          workload_last_attempt_at: now,
          workload_last_attempt_error: capture.reason,
        })
        .eq("id", request.id);
      return;
    }

    await getSupabaseAdmin()
      .from("outstation_expense_requests")
      .update({
        am_workload: capture.amWorkload,
        pm_workload: capture.pmWorkload,
        workload_capture_attempts: (request.workloadCaptureAttempts ?? 0) + 1,
        workload_gate_status: "complete",
        workload_last_attempt_at: now,
        workload_last_attempt_error: null,
        workload_matched_at: now,
        workload_source: "ireports360",
        // The per-day breakdown and who was counted, so an approver can see WHY the number is
        // what it is — a rolled-up manager figure is otherwise unexplainable.
        workload_evidence_snapshot: {
          contributingHrIds: capture.contributingHrIds,
          days: capture.days,
          hops: capture.hops,
          sourceLabel: capture.sourceLabel,
        },
      })
      .eq("id", request.id);

    await releaseOutstationRequestToPayrollIfReady(request.id, access);
  } catch (error) {
    logError("Outstation workload capture failed after the departure photo (non-blocking)", {
      error,
      labels: { event: "outstation_workload_capture_failed", requestId: String(request.id) },
    });
  }
}

/** One of the caller's own requests still owing its departure photo. */
export type OutstationDeparturePhotoDue = {
  destination: string;
  id: number;
  tripEndDate: string;
  tripStartDate: string;
};

/**
 * The caller's own requests waiting on a departure photo — what the portal card offers to
 * capture. Scoped to the caller by HR ID, never by a client-supplied id.
 *
 * Membership is decided by resolveOutstationGateState — the SAME resolver the payroll gate uses —
 * rather than by matching evidence_gate_status to a string. Two reasons, both learned the hard
 * way:
 *   - the resolver deliberately does not trust that column (a row can claim a state its photos
 *     contradict), so a status-equality query would disagree with the thing that actually
 *     withholds the money;
 *   - a status-equality query silently returns nothing when a row carries an unexpected value.
 *     An earlier version selected `= 'pending_departure_photo'` while nothing set that on insert,
 *     which would have held every new request out of payroll while never showing its owner the
 *     card to fix it.
 * A pre-rule ('grandfathered') request resolves to no blocker, so it can never be dragged back
 * and asked to photograph a trip that finished weeks ago.
 */
export async function getOwnOutstationRequestsAwaitingDeparturePhoto(
  access: AccessContext,
): Promise<OutstationDeparturePhotoDue[]> {
  const callerHrId = normalizeHrIdForAccess(access.hrId);
  if (!callerHrId) return [];

  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .select("*")
    .neq("evidence_gate_status", "grandfathered")
    .order("created_at", { ascending: false });

  // Best-effort: the portal must still render its other cards if this read fails, and before the
  // gate migration has applied the column does not exist at all.
  if (error || !data) return [];

  return (data as Array<Record<string, unknown>>)
    .map(mapOutstationRequestRow)
    .filter((row) => normalizeHrIdForAccess(row.employeeHrId) === callerHrId)
    .filter(
      (row) =>
        resolveOutstationGateState({
          evidenceGateStatus: row.evidenceGateStatus,
          hasArrivalPhoto: Boolean(row.carEvidenceImagePath),
          hasDeparturePhoto: Boolean(row.departureEvidenceImagePath),
          workloadGateStatus: row.workloadGateStatus,
        }).blocker === "departure_photo",
    )
    .map((row) => ({
      destination: text(row.toLabel) || text(row.toCity) || text(row.toArea) || "—",
      id: row.id,
      tripEndDate: row.tripEndDate,
      tripStartDate: row.tripStartDate,
    }));
}

// ── Held-request repair (Phase 5) ─────────────────────────────────────────────
// A request held by the evidence gate is invisible without this: the employee sees only that
// his money has not arrived, and nobody is told the CRM grab failed. These three functions are
// the Super Admin's view of, and way out of, that state.

/** One request held by the gate, with everything needed to decide what to do about it. */
export type HeldOutstationRequest = {
  blocker: string;
  destination: string;
  employeeHrId: string;
  employeeName: string;
  employeeRole: string;
  id: number;
  lastAttemptAt: string | null;
  lastAttemptError: string | null;
  message: string;
  tripEndDate: string;
  tripStartDate: string;
  workloadCaptureAttempts: number;
};

/**
 * Every request currently held out of payroll by the evidence/workload gate.
 *
 * Read access deliberately, so the execution-only finance roles can SEE what is stuck without
 * being able to change it. The two repair actions below require approve (Super Admin).
 *
 * Grandfathered requests can never appear here — resolveOutstationGateState clears them — so
 * this queue is only ever the genuinely-stuck, never the historical.
 */
export async function listHeldOutstationRequests(
  access: AccessContext,
): Promise<HeldOutstationRequest[]> {
  await assertOutstationAdminAccess(access, "read");

  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .select("*")
    .order("created_at", { ascending: false });
  if (error || !data) return [];

  return (data as Array<Record<string, unknown>>)
    .map(mapOutstationRequestRow)
    .filter((request) => request.status.startsWith("accepted"))
    .map((request) => ({
      request,
      gate: resolveOutstationGateState({
        evidenceGateStatus: request.evidenceGateStatus,
        hasArrivalPhoto: Boolean(request.carEvidenceImagePath),
        hasDeparturePhoto: Boolean(request.departureEvidenceImagePath),
        workloadGateStatus: request.workloadGateStatus,
      }),
    }))
    .filter((row) => !row.gate.isPayrollEligible)
    .map(({ gate, request }) => ({
      blocker: gate.blocker ?? "unknown",
      destination: text(request.toLabel) || text(request.toCity) || text(request.toArea) || "—",
      employeeHrId: request.employeeHrId,
      employeeName: request.employeeName,
      employeeRole: request.employeeRole,
      id: request.id,
      lastAttemptAt: request.workloadLastAttemptAt,
      lastAttemptError: request.workloadLastAttemptError,
      message: gate.message,
      tripEndDate: request.tripEndDate,
      tripStartDate: request.tripStartDate,
      workloadCaptureAttempts: request.workloadCaptureAttempts,
    }));
}

/**
 * Re-run the CRM workload grab for a held request — the "refresh" the owner asked for, and the
 * thing to try before typing numbers in by hand. Releases the request into payroll if it works.
 */
export async function retryOutstationWorkloadCapture(
  requestId: number,
  access: AccessContext,
): Promise<{ message: string; released: boolean }> {
  await assertOutstationAdminAccess(access, "approve");

  const request = await getOutstationRequestById(requestId);
  if (!request) throw new Error("That outstation request is not available.");
  if (request.workloadGateStatus !== "pending_workload") {
    throw new Error("This request is not waiting on its workload.");
  }

  await captureWorkloadAndReleaseIfReady(request, access);

  // Re-read rather than infer: captureWorkloadAndReleaseIfReady is best-effort and swallows its
  // own failures, so the only honest answer about what happened is the row itself.
  const after = await getOutstationRequestById(requestId);
  const released = Boolean(after && after.workloadGateStatus !== "pending_workload");
  return {
    message: released
      ? "Workload captured from the CRM and the request was released into payroll."
      : after?.workloadLastAttemptError ||
        "The CRM still has no workload for these dates. Enter it by hand if the trip is genuine.",
    released,
  };
}

/**
 * Last resort: a Super Admin types the AM/PM workload in.
 *
 * Stored as `manual`/`override`, never as if it came from the CRM. That distinction is the whole
 * point — an approver looking at this request later must be able to tell a measured number from
 * a typed one, and the payroll figure is derived from it either way.
 *
 * A reason is REQUIRED. This is a hand-entered number that releases money; an unexplained one is
 * indistinguishable from a mistake six months later.
 */
export async function setOutstationWorkloadManually(
  requestId: number,
  access: AccessContext,
  input: { amWorkload: number; pmWorkload: number; reason: string },
): Promise<{ message: string; released: boolean }> {
  await assertOutstationAdminAccess(access, "approve");

  // Validated through the pure checker so the rules are assertable without a database — and so
  // a bad value is REFUSED rather than coerced. The previous inline version clamped-and-truncated
  // instead, which silently turned a negative into a measured-looking zero, and let NaN slip past
  // its own finiteness check. See validateManualWorkloadInput for the full reasoning.
  const validated = validateManualWorkloadInput(input);
  if (!validated.ok) throw new Error(validated.message);
  const { amWorkload, pmWorkload, reason } = validated;

  const request = await getOutstationRequestById(requestId);
  if (!request) throw new Error("That outstation request is not available.");

  const now = new Date().toISOString();
  const { error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .update({
      am_workload: amWorkload,
      pm_workload: pmWorkload,
      updated_at: now,
      workload_gate_status: "manual",
      workload_match_status: "manual_override",
      workload_matched_at: now,
      workload_override_reason: reason,
      workload_source: "override",
    })
    .eq("id", requestId);
  if (error) throw new Error(error.message);

  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? resolveEmployeeIdentityId(access) ?? "system",
    entityId: String(requestId),
    entityType: "outstation_request",
    newValues: { amWorkload, pmWorkload, reason, workloadSource: "override" },
    oldValues: { amWorkload: request.amWorkload, pmWorkload: request.pmWorkload, workloadSource: request.workloadSource },
    summary: `Outstation request ${requestId} workload entered by hand (AM ${amWorkload} / PM ${pmWorkload}): ${reason}`,
  });

  const release = await releaseOutstationRequestToPayrollIfReady(requestId, access);
  return {
    message: release.released
      ? "Workload saved and the request was released into payroll."
      : `Workload saved. The request is still held: ${release.reason}`,
    released: release.released,
  };
}
