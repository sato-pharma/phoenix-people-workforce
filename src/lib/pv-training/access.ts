/**
 * Who may open PV Training Evidence — the QPPV's own account, and no one else's.
 *
 * Its own file, with no data in it, because the portal sidebar (src/lib/employee-portal/navigation.ts)
 * is bundled for every employee: importing the gate from the sheet list would ship every attendee's
 * name to the whole company just to draw one link.
 */

import { hrIdsMatch } from "@/lib/hr-id";

/**
 * A-3 — Dr. Samaa Mosaad Khalil, the company's QPPV. The owner (2026-11-09): "only in Dr. Sama
 * account". Named by HR id because her app role (`Manager`) is shared with the R&D Manager, so a
 * role grant would open these signatures to someone he did not name.
 */
export const PV_TRAINING_EVIDENCE_HR_IDS: readonly string[] = ["A-3"];

/** True only for the QPPV's own account. Mixed-case safe — `===` matches nobody here. */
export function canOpenPvTrainingEvidence(hrId: string | null | undefined): boolean {
  return PV_TRAINING_EVIDENCE_HR_IDS.some((allowed) => hrIdsMatch(hrId, allowed));
}
