import type {
  OutstationCarEvidenceMetadata,
  OutstationTransportationType,
} from "@/lib/outstation/types";

const CAR_EVIDENCE_SOURCE = "live_camera";

/**
 * The ARRIVAL photo — the first of the two live captures every outstation request must carry.
 *
 * Widened on 2026-08-04 (owner request): this used to exempt every transportation type except
 * `car`, so a train or bus claim reached payroll with no photograph at all. It is now required
 * for ALL transportation types. The stored metadata shape and the storage path are unchanged, so
 * the 7 existing car photos remain valid arrival photos and need no backfill.
 *
 * `transportationType` is still taken, and is still used — it only shapes the refusal MESSAGE
 * now, so an employee on a train is not told to photograph a car.
 */
export function validateLiveArrivalEvidence(params: {
  carEvidenceMetadata?: OutstationCarEvidenceMetadata | null;
  transportationType: OutstationTransportationType;
}) {
  if (!params.carEvidenceMetadata) {
    return {
      isValid: false,
      message:
        params.transportationType === "car"
          ? "Car transport requires one live in-app camera capture before submitting the request."
          : `A ${params.transportationType} trip requires one live in-app arrival photo before submitting the request.`,
    };
  }

  if (params.carEvidenceMetadata.source !== CAR_EVIDENCE_SOURCE) {
    return {
      isValid: false,
      message:
        "Only a live in-app camera capture satisfies the arrival-photo requirement. A picture chosen from the gallery is not accepted.",
    };
  }

  if (
    !params.carEvidenceMetadata.employeeHrId ||
    !params.carEvidenceMetadata.requestDraftId ||
    !params.carEvidenceMetadata.capturedAt ||
    !params.carEvidenceMetadata.capturedLocationLabel ||
    !Number.isFinite(params.carEvidenceMetadata.capturedLatitude) ||
    !Number.isFinite(params.carEvidenceMetadata.capturedLongitude)
  ) {
    return {
      isValid: false,
      message:
        "The arrival photo is incomplete — it must carry your HR ID, its capture time and its GPS. Capture it again inside the app.",
    };
  }

  return { isValid: true, message: "" };
}
