import { isOwnedByViewer, ownerScopedStorageKey } from "@/lib/browser-storage/owner-scoped";
import type {
  OutstationCaptureResult,
  OutstationCarEvidenceSource,
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
  // Optional because drafts written before 2026-08-05 predate the upload route and carry no
  // source. A draft with no source is a live capture — that was the only kind that existed —
  // so readers must default to "live_camera" rather than treating the absence as unknown.
  carEvidenceSource?: OutstationCarEvidenceSource;
  expenseType: OutstationExpenseType;
  goTicketAmount: string;
  hasTicketAttachments: boolean;
  kilometerReading: string;
  meetingAmount?: string;
  medicalTripHrId: string;
  notes: string;
  otherAmount?: string;
  /**
   * The HR id of the person who saved this draft. Optional only because drafts written before
   * 2026-10-26 carry none — and such a draft is never restored or sent, because there is no way to
   * tell whose claim it is (src/lib/browser-storage/owner-scoped.ts).
   */
  ownerHrId?: string;
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

/**
 * One draft per person on a shared phone. The key was `phoenix-outstation-draft` for the whole
 * browser until 2026-10-26, and the wizard restored and replayed it for whoever was signed in — so
 * rep A's offline claim was filed as rep B's. Null when there is no viewer: then nothing is stored.
 */
export const outstationDraftStorageKeyBase = "phoenix-outstation-draft";

export function outstationDraftStorageKeyFor(viewerHrId: string): string | null {
  return ownerScopedStorageKey(outstationDraftStorageKeyBase, viewerHrId);
}

export function parseOutstationLocalDraft(raw: string | null): OutstationLocalDraft | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OutstationLocalDraft;
  } catch {
    return null;
  }
}

/** Restored and replayed only for the person who saved it — never for the next person to sign in. */
export function isRestorableOutstationLocalDraft(
  draft: OutstationLocalDraft | null,
  viewerHrId: string,
): draft is OutstationLocalDraft & {
  captured: OutstationCaptureResult;
  syncPending: true;
} {
  return Boolean(draft?.syncPending && draft.captured && isOwnedByViewer(draft.ownerHrId, viewerHrId));
}
