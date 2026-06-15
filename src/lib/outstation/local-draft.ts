import type {
  OutstationCaptureResult,
  OutstationExpenseType,
  OutstationTransportationType,
} from "@/lib/outstation/types";

export type OutstationLocalDraft = {
  captured: OutstationCaptureResult | null;
  carEvidenceCapturedAt: string | null;
  carEvidenceImageDataUrl: string | null;
  carEvidenceLatitude: number | null;
  carEvidenceLocationLabel: string | null;
  carEvidenceLongitude: number | null;
  carEvidenceRequestId: string | null;
  expenseType: OutstationExpenseType;
  goTicketAmount: string;
  hasTicketAttachments: boolean;
  kilometerReading: string;
  meetingAmount?: string;
  medicalTripHrId: string;
  notes: string;
  otherAmount?: string;
  pmWorkload?: string;
  amWorkload?: string;
  returnTicketAmount: string;
  syncPending: boolean;
  transportationType: OutstationTransportationType;
  travelCostAmount?: string;
  tripType?: string;
  tripEndDate: string;
  tripStartDate: string;
};

export const outstationDraftStorageKey = "phoenix-outstation-draft";

export function parseOutstationLocalDraft(raw: string | null): OutstationLocalDraft | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OutstationLocalDraft;
  } catch {
    return null;
  }
}

export function isRestorableOutstationLocalDraft(
  draft: OutstationLocalDraft | null,
): draft is OutstationLocalDraft & {
  captured: OutstationCaptureResult;
  syncPending: true;
} {
  return Boolean(draft?.syncPending && draft.captured);
}
