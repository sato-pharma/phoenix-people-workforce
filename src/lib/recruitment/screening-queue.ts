// Recruitment / ATS — what the standalone screening page loads.
//
// The queue used to be "whatever the pool was filtered to, in the order it was displayed" — which
// only ever existed inside one React component, so it could not be linked to. Moving screening onto
// a route means the filter has to live somewhere addressable, and that somewhere is the URL.
//
// SERVER ONLY. This module reaches the database. The pure half — the link builder and the query
// parser, which the client-side candidate pool also needs — lives in screening-link.ts and must
// stay there: importing this file from a "use client" component drags listCandidates, the employee
// directory and `node:crypto` into the browser bundle, which webpack refuses outright and which no
// bundler should be trusted to keep tree-shaking away.

import { listCandidates } from "@/lib/recruitment/candidates";
import { listCandidateViews, type CandidateViewMap } from "@/lib/recruitment/candidate-views";
import { normalizeCandidateStatus, type CandidateStatus } from "@/lib/recruitment/candidate-status";
import { parseScreeningFilters, type ScreeningQueueFilters } from "@/lib/recruitment/screening-link";
import type { Candidate } from "@/lib/recruitment/types";

export type ScreeningQueue = {
  candidates: Candidate[];
  views: CandidateViewMap;
  /** How many were dropped by the filters, so the page can say so instead of silently shrinking. */
  filteredOut: number;
  unseenOnly: boolean;
  status: CandidateStatus | null;
};

/**
 * Load the queue for one screener, narrowed by the link they followed.
 *
 * The view map is loaded for the CALLER, never for an HR_ID in the URL — "have I seen this" is a
 * question about the person asking, and a viewer id in a query string would let one person open a
 * link that reports somebody else's reading as their own.
 */
export async function loadScreeningQueue(
  viewerHrId: string | null | undefined,
  filters: ScreeningQueueFilters = {},
): Promise<ScreeningQueue> {
  const [allCandidates, views] = await Promise.all([listCandidates(), listCandidateViews(viewerHrId)]);

  const { status, unseenOnly } = parseScreeningFilters(filters);

  let candidates = allCandidates;
  if (status) {
    candidates = candidates.filter((candidate) => normalizeCandidateStatus(candidate.status) === status);
  }
  if (unseenOnly) {
    candidates = candidates.filter((candidate) => !views[candidate.id]);
  }

  return {
    candidates,
    filteredOut: allCandidates.length - candidates.length,
    status,
    unseenOnly,
    views,
  };
}
