import type { OutstationCarEvidenceMetadata } from "@/lib/outstation/types";

const CAR_EVIDENCE_IMAGE_DATA_URL_PATTERN =
  /^data:image\/jpeg;base64,[a-zA-Z0-9+/=]+$/i;
const CAR_EVIDENCE_IMAGE_PATH_PATTERN = /^car\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\.jpg$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseCarEvidenceMetadata(body: Record<string, unknown>) {
  const raw = body.carEvidenceMetadata;
  if (!isRecord(raw)) return undefined;

  const source = raw.source === "live_camera" ? raw.source : null;
  const capturedAt = typeof raw.capturedAt === "string" ? raw.capturedAt : null;
  const capturedLatitude = Number(raw.capturedLatitude);
  const capturedLocationLabel =
    typeof raw.capturedLocationLabel === "string" ? raw.capturedLocationLabel : null;
  const capturedLongitude = Number(raw.capturedLongitude);
  const employeeHrId = typeof raw.employeeHrId === "string" ? raw.employeeHrId : "";
  const requestDraftId =
    typeof raw.requestDraftId === "string" ? raw.requestDraftId : null;
  const requestId = typeof raw.requestId === "string" ? raw.requestId : null;

  if (!source || !capturedAt) return undefined;

  return {
    capturedAt,
    capturedLatitude,
    capturedLocationLabel,
    capturedLongitude,
    employeeHrId,
    requestDraftId,
    requestId,
    source,
  } satisfies OutstationCarEvidenceMetadata;
}

export function parseCarEvidenceImageDataUrl(body: Record<string, unknown>) {
  const raw = body.carEvidenceImageDataUrl;
  if (typeof raw !== "string") return undefined;

  const trimmed = raw.trim();
  if (!CAR_EVIDENCE_IMAGE_DATA_URL_PATTERN.test(trimmed)) {
    return undefined;
  }

  return trimmed ? trimmed : undefined;
}

export function parseCarEvidenceImagePath(body: Record<string, unknown>) {
  const raw = body.carEvidenceImagePath;
  if (typeof raw !== "string") return undefined;

  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!CAR_EVIDENCE_IMAGE_PATH_PATTERN.test(trimmed)) {
    return undefined;
  }

  return trimmed;
}
