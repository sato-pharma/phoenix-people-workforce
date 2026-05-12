export const OFFICIAL_OUTSTATION_MINIMUM_DISTANCE_KM = 60;
export const TOLERANCE_OUTSTATION_MINIMUM_DISTANCE_KM = 58;

export type OutstationDistanceClassification =
  | "eligible"
  | "tolerance_eligible"
  | "not_eligible"
  | "manual_exception"
  | "missing_distance"
  | "invalid_distance";

export type OutstationDistanceEligibilityPolicy = {
  officialMinimumDistanceKm: number;
  toleranceMinimumDistanceKm?: number | null;
};

export type OutstationDistanceEligibilityInput = {
  actualDistanceKm: number | null;
  policy: OutstationDistanceEligibilityPolicy;
};

export type OutstationDistanceEligibilityResult = {
  actual_distance_km: number | null;
  classification: OutstationDistanceClassification;
  eligible: boolean;
  official_minimum_km: number;
  requires_manual_exception: boolean;
  requires_warning: boolean;
  reason: string;
  tolerance_minimum_km: number;
};

function normalizeDistancePolicy(policy: OutstationDistanceEligibilityPolicy) {
  const officialRaw = Number(policy.officialMinimumDistanceKm);
  const toleranceRaw = Number(policy.toleranceMinimumDistanceKm);

  const official =
    Number.isFinite(officialRaw) && officialRaw > 0 ? officialRaw : OFFICIAL_OUTSTATION_MINIMUM_DISTANCE_KM;
  const tolerance =
    Number.isFinite(toleranceRaw) && toleranceRaw > 0
      ? toleranceRaw
      : TOLERANCE_OUTSTATION_MINIMUM_DISTANCE_KM;

  const clampedTolerance = Math.min(tolerance, official);

  return {
    official,
    tolerance: clampedTolerance,
  };
}

export function classifyOutstationExpenseEligibility(
  input: OutstationDistanceEligibilityInput,
): OutstationDistanceEligibilityResult {
  const distance = input.actualDistanceKm;
  const { official, tolerance } = normalizeDistancePolicy(input.policy);

  if (distance == null || !Number.isFinite(distance)) {
    return {
      actual_distance_km: distance == null ? null : distance,
      classification: distance == null ? "missing_distance" : "invalid_distance",
      eligible: false,
      official_minimum_km: official,
      requires_manual_exception: false,
      requires_warning: false,
      reason: "Distance could not be validated against the distance policy inputs.",
      tolerance_minimum_km: tolerance,
    };
  }

  const validDistance = distance;

  if (validDistance < 0) {
    return {
      actual_distance_km: validDistance,
      classification: "manual_exception",
      eligible: false,
      official_minimum_km: official,
      requires_manual_exception: true,
      requires_warning: false,
      reason: "Distance is invalid for policy validation and requires manual exception.",
      tolerance_minimum_km: tolerance,
    };
  }

  if (validDistance >= official) {
    return {
      actual_distance_km: validDistance,
      classification: "eligible",
      eligible: true,
      official_minimum_km: official,
      requires_manual_exception: false,
      requires_warning: false,
      reason: `Distance ${validDistance.toFixed(2)} KM meets official minimum policy threshold (${official} KM).`,
      tolerance_minimum_km: tolerance,
    };
  }

  if (validDistance >= tolerance) {
    return {
      actual_distance_km: validDistance,
      classification: "tolerance_eligible",
      eligible: false,
      official_minimum_km: official,
      requires_manual_exception: false,
      requires_warning: true,
      reason: `Distance ${validDistance.toFixed(2)} KM is below official minimum (${official} KM) but within tolerance (${tolerance} KM). This is accepted with warning.`,
      tolerance_minimum_km: tolerance,
    };
  }

  return {
    actual_distance_km: validDistance,
    classification: "not_eligible",
    eligible: false,
    official_minimum_km: official,
    requires_manual_exception: false,
    requires_warning: false,
    reason: `Distance ${validDistance.toFixed(2)} KM is below the policy tolerance minimum (${tolerance} KM).`,
    tolerance_minimum_km: tolerance,
  };
}
