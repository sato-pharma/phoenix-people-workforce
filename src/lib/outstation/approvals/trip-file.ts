/**
 * One trip, whole, in one read — what the reviewer opens.
 *
 * Rebuilt 2026-11-23 (owner: "REBUILD FROM SCRATCH"). The reviewer it replaces made four requests a
 * trip (the claim list, attachments, Phoenix CRM, the old position evidence). This composes three
 * reads that already exist and forks none of them:
 *
 *   - the claim with its checks, as the desk reads it (`loadDeskClaim`, scoped to the caller);
 *   - the photos, tickets, journey and road route (`loadTripAttachments`);
 *   - Phoenix CRM on the trip, day by day (`loadCrmTripEvidence`).
 *
 * 🔴 The photos and the Phoenix CRM reading are the approver's alone — the reading carries the open
 *    location warnings, which are his on the integrity board. The CALLER decides `includeEvidence`
 *    with the approver's own gate; a reader without it gets the claim and its checks, and
 *    `evidenceWithheld: true` so the page says so instead of drawing empty sections.
 *
 * A source that could not be read names itself in `unavailable`; the trip still opens.
 */

import type { AccessContext } from "@/lib/auth/permissions";
import { logError } from "@/lib/observability/log";
import { loadDeskClaim } from "@/lib/outstation/approvals/queue";
import type { DeskClaim } from "@/lib/outstation/approvals/types";
import { loadCrmTripEvidence, type CrmTripEvidenceResult } from "@/lib/outstation/crm-trip-evidence-reader";
import { loadTripAttachments, type TripAttachmentsPayload } from "@/lib/outstation/trip-attachments-data";

export type DeskTripFile = {
  attachments: TripAttachmentsPayload | null;
  claim: DeskClaim;
  crm: CrmTripEvidenceResult | null;
  evidenceWithheld: boolean;
  unavailable: string[];
};

export const TRIP_FILE_SOURCES = { attachments: "Photos and tickets", crm: "Phoenix CRM field work" } as const;

/** Pure: what the reviewer gets from the three reads, each of which may have failed. */
export function composeTripFile(input: {
  attachments: PromiseSettledResult<TripAttachmentsPayload> | null;
  claim: DeskClaim;
  crm: PromiseSettledResult<CrmTripEvidenceResult> | null;
}): DeskTripFile {
  const unavailable: string[] = [];
  const attachments = input.attachments?.status === "fulfilled" ? input.attachments.value : null;
  const crm = input.crm?.status === "fulfilled" ? input.crm.value : null;
  if (input.attachments?.status === "rejected") unavailable.push(TRIP_FILE_SOURCES.attachments);
  if (input.crm?.status === "rejected") unavailable.push(TRIP_FILE_SOURCES.crm);
  for (const source of crm?.unavailable ?? []) if (!unavailable.includes(source)) unavailable.push(source);
  return {
    attachments,
    claim: input.claim,
    crm,
    evidenceWithheld: input.attachments === null && input.crm === null,
    unavailable,
  };
}

export async function loadDeskTripFile(
  access: AccessContext,
  requestId: number,
  options: { includeEvidence: boolean; now?: Date },
): Promise<DeskTripFile | null> {
  const [claim, attachments, crm] = await Promise.all([
    loadDeskClaim(access, requestId, options.now ?? new Date()),
    options.includeEvidence ? Promise.allSettled([loadTripAttachments(requestId)]).then(([result]) => result) : null,
    options.includeEvidence ? Promise.allSettled([loadCrmTripEvidence(requestId)]).then(([result]) => result) : null,
  ]);
  // Not on the caller's list: nothing about the trip is returned, evidence included.
  if (!claim) return null;
  for (const [name, result] of [["attachments", attachments], ["crm", crm]] as const) {
    if (result?.status === "rejected") {
      logError("A source of the expense reviewer could not be read", {
        labels: { event: "expense_desk_trip_file_source_failed", requestId: String(requestId), source: name },
        error: result.reason instanceof Error ? result.reason : new Error(String(result.reason)),
      });
    }
  }
  return composeTripFile({ attachments, claim, crm });
}
