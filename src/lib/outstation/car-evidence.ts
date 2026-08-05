import type {
  OutstationCarEvidenceMetadata,
  OutstationTransportationType,
} from "@/lib/outstation/types";

const CAR_EVIDENCE_SOURCE = "live_camera";
const UPLOADED_EVIDENCE_SOURCE = "upload";

/**
 * The ARRIVAL photo — the first of the two captures every outstation request must carry.
 *
 * Widened on 2026-08-04 (owner request): this used to exempt every transportation type except
 * `car`, so a train or bus claim reached payroll with no photograph at all. It is now required
 * for ALL transportation types. The stored metadata shape and the storage path are unchanged, so
 * the 7 existing car photos remain valid arrival photos and need no backfill.
 *
 * Relaxed on 2026-08-05 (owner request), for NON-CAR trips only: a train, bus or other trip may
 * satisfy the requirement with an UPLOADED photo instead of a live in-app capture. A car trip
 * still accepts nothing but `live_camera`.
 *
 * Be clear-eyed about what that costs. A live capture is taken inside the app, at a time the app
 * stamped, at GPS the browser reported; an upload is a file of unknown age and origin whose GPS
 * is copied from the trip's own destination capture. An upload therefore evidences that the
 * employee HAD a photo, not that they were there when it was taken. That is a deliberate trade
 * for train and bus, where the ticket is already decision-bearing evidence and the destination
 * GPS is captured separately — it is NOT a judgement that the two are equivalent, and `source`
 * is persisted precisely so an approver can tell them apart.
 *
 * `transportationType` shapes both the refusal MESSAGE and, now, which sources are accepted.
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
          : `A ${params.transportationType} trip requires one arrival photo before submitting the request — take a live photo or upload one.`,
    };
  }

  const acceptedSources =
    params.transportationType === "car"
      ? [CAR_EVIDENCE_SOURCE]
      : [CAR_EVIDENCE_SOURCE, UPLOADED_EVIDENCE_SOURCE];

  if (!acceptedSources.includes(params.carEvidenceMetadata.source)) {
    return {
      isValid: false,
      message:
        params.transportationType === "car"
          ? "Only a live in-app camera capture satisfies the arrival-photo requirement on a car trip. A picture chosen from the gallery is not accepted."
          : "The arrival photo must be either a live in-app capture or an uploaded image.",
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
        "The arrival photo is incomplete — it must carry your HR ID, its capture time and its GPS. Add it again inside the app.",
    };
  }

  return { isValid: true, message: "" };
}
