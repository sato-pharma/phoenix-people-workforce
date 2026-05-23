import type {
  OutstationCaptureResult,
  OutstationExpenseType,
  OutstationTransportationType,
} from "@/lib/outstation/types";

export type OutstationLocalDraft = {
  captured: OutstationCaptureResult | null;
  carEvidenceCapturedAt: string | null;
  carEvidenceImageDataUrl: string | null;
  carEvidenceImagePath: string | null;
  carEvidenceLatitude: number | null;
  carEvidenceLocationLabel: string | null;
  carEvidenceLongitude: number | null;
  carEvidenceRequestId: string | null;
  expenseType: OutstationExpenseType;
  goTicketAmount: string;
  hasTicketAttachments: boolean;
  kilometerReading: string;
  employeeHrId: string;
  medicalTripHrId: string;
  notes: string;
  returnTicketAmount: string;
  updatedAt: string;
  syncPending: boolean;
  transportationType: OutstationTransportationType;
  tripEndDate: string;
  tripStartDate: string;
};

export const outstationDraftStorageKey = "phoenix-outstation-draft";
export const outstationDraftStorageFullWarning =
  "Could not save draft — your device storage is full. Do not close this page.";
const MAX_OUTSTATION_DRAFT_AGE_MS = 1000 * 60 * 60 * 12;
const QUOTA_EXCEEDED_ERROR_CODES = new Set([22, 1014]);

export function parseOutstationLocalDraft(raw: string | null): OutstationLocalDraft | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OutstationLocalDraft;
  } catch {
    return null;
  }
}

function isStorageQuotaExceededError(error: unknown): boolean {
  if (!(error instanceof DOMException)) {
    return false;
  }

  if (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED") {
    return true;
  }

  return typeof error.code === "number" && QUOTA_EXCEEDED_ERROR_CODES.has(error.code);
}

function isStaleOutstationDraft(rawDraft: OutstationLocalDraft | null, now: number): boolean {
  if (!rawDraft) {
    return true;
  }

  const parsedUpdatedAt = isIsoDate(rawDraft.updatedAt) ? Date.parse(rawDraft.updatedAt) : Number.NaN;
  if (Number.isNaN(parsedUpdatedAt)) {
    return true;
  }

  return now - parsedUpdatedAt > MAX_OUTSTATION_DRAFT_AGE_MS;
}

export function clearStaleOutstationDrafts(now?: number): number {
  if (typeof window === "undefined") {
    return 0;
  }

  const storage = window.localStorage;
  const threshold = now ?? Date.now();
  let removedDraftCount = 0;

  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (!key || key !== outstationDraftStorageKey) {
      continue;
    }

    const draft = parseOutstationLocalDraft(storage.getItem(key));
    if (isStaleOutstationDraft(draft, threshold)) {
      storage.removeItem(key);
      removedDraftCount += 1;
    }
  }

  return removedDraftCount;
}

export function saveOutstationLocalDraft(
  draftKey: string,
  draft: OutstationLocalDraft,
): { success: boolean; quotaExceeded: boolean } {
  if (typeof window === "undefined") {
    return { success: false, quotaExceeded: false };
  }

  try {
    window.localStorage.setItem(draftKey, JSON.stringify(draft));
    return { success: true, quotaExceeded: false };
  } catch (error) {
    if (!isStorageQuotaExceededError(error)) {
      return { success: false, quotaExceeded: false };
    }

    clearStaleOutstationDrafts();

    try {
      window.localStorage.setItem(draftKey, JSON.stringify(draft));
      return { success: true, quotaExceeded: false };
    } catch (retryError) {
      return { success: false, quotaExceeded: isStorageQuotaExceededError(retryError) };
    }
  }
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }

  return !Number.isNaN(Date.parse(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isRestorableOutstationLocalDraft(
  draft: OutstationLocalDraft | null,
  expectedEmployeeHrId?: string,
): draft is OutstationLocalDraft & {
  captured: OutstationCaptureResult;
  syncPending: true;
} {
  if (!draft?.syncPending || !draft.captured) {
    return false;
  }

  const expectedHrId = expectedEmployeeHrId?.trim() ?? "";
  const storedHrId = (draft.employeeHrId ?? "").trim();
  if (expectedHrId && storedHrId && storedHrId !== expectedHrId) {
    return false;
  }

  const draftUpdatedAt = isIsoDate(draft.updatedAt)
    ? Date.parse(draft.updatedAt)
    : isIsoDate(draft.captured.capturedAt)
      ? Date.parse(draft.captured.capturedAt)
      : null;
  if (draftUpdatedAt == null || Date.now() - draftUpdatedAt > MAX_OUTSTATION_DRAFT_AGE_MS) {
    return false;
  }

  if (!isFiniteNumber(draft.captured.capturedLatitude) || !isFiniteNumber(draft.captured.capturedLongitude)) {
    return false;
  }
  if (!isNonEmptyString(draft.captured.capturedAt)) {
    return false;
  }
  if (!isNonEmptyString(draft.tripStartDate) || !isNonEmptyString(draft.tripEndDate)) {
    return false;
  }

  return true;
}
