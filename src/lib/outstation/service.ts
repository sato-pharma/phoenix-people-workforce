import {
  normalizeHrId,
  normalizeHrIdForAccess,
  normalizeLineName,
  normalizeRole,
  resolveEmployeeIdentityId,
  type AccessContext,
} from "@/lib/auth/permissions";
import { listBrickReferenceRows, normalizeBrickText } from "@/lib/bricks/service";
import { getEmployeeDirectory, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import {
  googleDirectionsRoute,
  googleDistanceMatrix,
  googleGeocodeAddress,
  googleReverseGeocode,
} from "@/lib/geo-intelligence/google";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type {
  EmployeeResidenceLocation,
  OutstationAllowanceBreakdown,
  OutstationApprovalRecommendation,
  OutstationCalculationInput,
  OutstationCalculationResult,
  OutstationCaptureResult,
  OutstationEligibilityStatus,
  OutstationExpenseType,
  OutstationExpenseRequest,
  OutstationFraudFlag,
  OutstationHeatmapData,
  OutstationHeatmapMarker,
  OutstationPolicyRule,
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

function normalizeArea(value: string | null | undefined) {
  return normalizeBrickText(value ?? "");
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
    params.transportationType !== "car" &&
    params.policy.requiresTicketAttachment &&
    !params.hasTicketAttachments
  ) {
    return {
      approvalReason:
        "Train or bus requests require ticket evidence before finance can approve the claim.",
      approvalRecommendation: "finance_review" as OutstationApprovalRecommendation,
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
        "Claimed amount materially exceeds the expected amount and should be reviewed by finance.",
      approvalRecommendation: "finance_review" as OutstationApprovalRecommendation,
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
  const hrId = resolveEmployeeIdentityId(access);
  if (!hrId) {
    throw new Error("Your employee profile is not linked yet. Please contact HR.");
  }

  const directory = await getEmployeeDirectory();
  const employee =
    directory.employees.find(
      (row) => normalizeHrIdForAccess(row.hrId) === normalizeHrIdForAccess(hrId),
    ) ?? null;

  return {
    employee,
    employeeArea: employee?.areaName ?? null,
    employeeHrId: hrId,
    employeeLine: employee?.lineName ?? null,
    employeeName: employee?.fullName ?? hrId,
    employeeRole: normalizeRole(access.role),
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
  const { data, error } = await supabase
    .from("outstation_policy_rules")
    .select("*")
    .order("role_name", { ascending: true });

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
  employee: EmployeeDirectoryRow | null;
  employeeArea: string | null;
  employeeHrId: string;
  employeeLine: string | null;
}) {
  const normalizedCapturedArea = normalizeArea(input.capturedArea);
  const normalizedCapturedCity = normalizeArea(input.capturedCity);
  const employeeAreaKey = normalizeArea(input.employeeArea);
  const brickRows = await listBrickReferenceRows(input.employeeLine);
  const directRows = brickRows.filter(
    (row) => normalizeHrIdForAccess(row.dsmHrId) === normalizeHrIdForAccess(input.employeeHrId),
  );

  if (directRows.length > 0) {
    const matched = directRows.some((row) => {
      const brickAreaKey = normalizeArea(row.area);
      return Boolean(
        normalizedCapturedArea &&
          (brickAreaKey === normalizedCapturedArea || brickAreaKey === normalizedCapturedCity),
      );
    });

    if (matched) {
      return {
        reason: "Captured destination matches the employee's assigned reference territory.",
        status: "matched" as OutstationTerritoryValidationStatus,
      };
    }

    return {
      reason:
        "Captured destination does not match the employee's assigned territory reference and needs manager review.",
      status: "outside_expected_territory" as OutstationTerritoryValidationStatus,
    };
  }

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
    reason: "Territory reference data is not available for this employee.",
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

  let route = await getCachedRoute({
    capturedLatitude: params.capturedLatitude,
    capturedLongitude: params.capturedLongitude,
    employeeHrId: identity.employeeHrId,
    residenceLatitude: residence.residenceLatitude,
    residenceLongitude: residence.residenceLongitude,
  });

  let polyline: string | null = route?.routePolyline ?? null;
  let durationMinutes: number | null = route?.durationMinutes ?? null;
  let distanceKm: number | null = route?.distanceKm ?? null;
  let routeError: string | null = null;

  if (distanceKm == null || durationMinutes == null || polyline == null) {
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
      if (directions.durationSeconds != null) {
        durationMinutes = Number((directions.durationSeconds / 60).toFixed(1));
      }
      polyline = directions.polyline;
    } catch (error) {
      routeError =
        error instanceof Error
          ? error.message
          : "Google Routes API failed to calculate the driving route.";
    }

    if ((distanceKm == null || durationMinutes == null) && !routeError) {
      try {
        const distance = await googleDistanceMatrix(
          {
            lat: residence.residenceLatitude,
            lng: residence.residenceLongitude,
          },
          {
            lat: params.capturedLatitude,
            lng: params.capturedLongitude,
          },
        );
        if (distanceKm == null && distance.distanceMeters != null) {
          distanceKm = Number((distance.distanceMeters / 1000).toFixed(2));
        }
        if (durationMinutes == null && distance.durationSeconds != null) {
          durationMinutes = Number((distance.durationSeconds / 60).toFixed(1));
        }
      } catch (error) {
        routeError =
          error instanceof Error
            ? error.message
            : "Google Routes API failed to calculate route distance.";
      }
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

  if (distanceKm == null) {
    eligibilityStatus = "needs_review";
    eligibilityReason =
      "Distance could not be validated against Google Maps. Please retry later or contact HR.";
    if (routeError) {
      eligibilityReason = `Distance could not be validated against Google Maps. ${routeError}`;
    }
  } else if (distanceKm < policy.minimumDistanceKm) {
    fraudFlags.push("distance_below_policy");
    eligibilityStatus = "not_eligible";
    eligibilityReason =
      "This trip is not eligible for outstation expense because the captured distance from your registered residence is less than 60 KM.";
  }

  const reverse = await googleReverseGeocode({
    lat: params.capturedLatitude,
    lng: params.capturedLongitude,
  }).catch(() => null);

  const territory = await validateTerritory({
    capturedArea: reverse?.area ?? null,
    capturedCity: reverse?.city ?? null,
    employee: identity.employee,
    employeeArea: identity.employeeArea,
    employeeHrId: identity.employeeHrId,
    employeeLine: identity.employeeLine,
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
    routePolyline: polyline,
    routeProvider: "google_maps",
    routeError,
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
  const { identity, policy, result } = validated;

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
  } else {
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

  const expectedTotalAmount =
    result.eligibilityStatus === "not_eligible"
      ? 0
      : roundMoney(fuelAmount + allowance.allowanceAmount + ticketAmount);
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
    sameDayTrip: allowance.sameDayTrip,
    suspiciousLocationScore: buildSuspiciousScore(result.fraudFlags),
    ticketAmount,
    transportationType: input.transportationType,
    tripEndDate,
    tripStartDate,
    varianceAmount,
    variancePercent,
  };

  return calculation;
}

export async function submitOutstationRequest(
  access: AccessContext,
  input: OutstationCalculationInput,
) {
  const calculation = await calculateOutstationExpense(access, input);
  if (calculation.eligibilityStatus === "not_eligible") {
    throw new Error(calculation.eligibilityReason);
  }

  const identity = await getEmployeeIdentity(access);
  const residence = await getResidenceLocationForEmployee(identity.employeeHrId);
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .insert({
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
      notes: calculation.notes,
      offline_captured: calculation.offlineCaptured,
      overnight_days: calculation.overnightDays,
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
      ticket_amount: calculation.ticketAmount,
      to_area: calculation.toArea,
      to_city: calculation.toCity,
      to_label: calculation.toLabel,
      transportation_type: calculation.transportationType,
      trip_end_date: calculation.tripEndDate,
      trip_start_date: calculation.tripStartDate,
      variance_amount: calculation.varianceAmount,
      variance_percent: calculation.variancePercent,
    })
    .select("*")
    .single();

  if (error) {
    throw new Error(error.message);
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

  return mapOutstationRequestRow(data);
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
    approvalRecommendation: text(row.approval_recommendation) as OutstationApprovalRecommendation,
    capturedAccuracyMeters: numberValue(row.captured_accuracy_meters),
    capturedAt: isoString(row.captured_at),
    capturedLatitude: numberValue(row.captured_latitude),
    capturedLongitude: numberValue(row.captured_longitude),
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
    id: Number(row.id),
    kilometerReading: nullableNumber(row.kilometer_reading),
    medicalTripHrId: text(row.medical_trip_hr_id) || null,
    medicalTripName: text(row.medical_trip_name) || null,
    minimumRequiredDistanceKm: numberValue(row.minimum_required_distance_km),
    notes: text(row.notes) || null,
    offlineCaptured: Boolean(row.offline_captured),
    overnightDays: numberValue(row.overnight_days),
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
    ticketAmount: numberValue(row.ticket_amount),
    toArea: text(row.to_area) || null,
    toCity: text(row.to_city) || null,
    toLabel: text(row.to_label) || null,
    transportationType,
    tripEndDate: isoString(row.trip_end_date),
    tripStartDate: isoString(row.trip_start_date),
    updatedAt: isoString(row.updated_at),
    varianceAmount: numberValue(row.variance_amount),
    variancePercent: numberValue(row.variance_percent),
  };
}

export async function listOutstationRequests() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return ((data ?? []) as Array<Record<string, unknown>>).map(mapOutstationRequestRow);
}

export async function getOutstationRequestById(requestId: number) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("outstation_expense_requests")
    .select("*")
    .eq("id", requestId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data ? mapOutstationRequestRow(data as Record<string, unknown>) : null;
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
        requests.filter((request) => request.approvalRecommendation === "reject"),
        (request) => request.toCity ?? request.toArea ?? "Unknown",
        () => 1,
      ).map((row) => ({
        highRiskTrips: row.trips,
        label: row.label,
      })),
    },
    kpis: {
      highRiskRequests: requests.filter((request) => request.approvalRecommendation === "reject").length,
      totalClaimed: roundMoney(sumBy(requests, (request) => request.claimedTotalAmount)),
      totalExpected: roundMoney(sumBy(requests, (request) => request.expectedTotalAmount)),
      totalRequests: requests.length,
      totalVariance: roundMoney(sumBy(requests, (request) => request.varianceAmount)),
    },
    markers,
  };
}
