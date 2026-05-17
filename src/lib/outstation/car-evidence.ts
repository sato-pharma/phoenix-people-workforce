import type {
  OutstationCarEvidenceMetadata,
  OutstationTransportationType,
} from "@/lib/outstation/types";

const CAR_EVIDENCE_SOURCE = "live_camera";

export function validateLiveCarEvidence(params: {
  carEvidenceMetadata?: OutstationCarEvidenceMetadata | null;
  transportationType: OutstationTransportationType;
}) {
  if (params.transportationType !== "car") {
    return { isValid: true, message: "" };
  }

  if (!params.carEvidenceMetadata) {
    return {
      isValid: false,
      message:
        "Car transport requires one live in-app camera capture before submitting the request.",
    };
  }

  if (params.carEvidenceMetadata.source !== CAR_EVIDENCE_SOURCE) {
    return {
      isValid: false,
      message:
        "Only live in-app camera capture satisfies car evidence requirements for car transport requests.",
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
        "Car live camera evidence is incomplete. Capture the photo again and keep it inside the app only.",
    };
  }

  return { isValid: true, message: "" };
}
