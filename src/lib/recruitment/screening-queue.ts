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
import { listHiringManagerOptions, type HiringManagerOption } from "@/lib/recruitment/hiring-manager-notify";
import { parseScreeningFilters, type ScreeningQueueFilters } from "@/lib/recruitment/screening-link";
import {
  listOpenVacancyOptions,
  listUsedPositionText,
  type VacancyOption,
} from "@/lib/recruitment/vacancy-options";
import type { Candidate } from "@/lib/recruitment/types";

export type ScreeningQueue = {
  candidates: Candidate[];
  views: CandidateViewMap;
  /**
   * The managers this screener may push a CV to, from inside the queue. EMPTY when the caller has
   * no `recruitment: update` grant — the send route requires it, so offering a picker that can only
   * ever answer 403 would be a worse screen than offering none.
   */
  hiringManagers: HiringManagerOption[];
  /**
   * The open seats a CV can be sent FOR — the folder the manager will find it in. Loaded on the
   * same gate as the managers, for the same reason: without `recruitment: update` there is nothing
   * to send, so there is nothing to choose a position for either.
   */
  openVacancies: VacancyOption[];
  /**
   * Job titles and areas already used on a send, offered beside the free-typed fields. The owner
   * chose free typing alongside the vacancy list, and this is what keeps a second "Marketing Exec."
   * from opening a folder that reads almost exactly like the first one.
   */
  positionSuggestions: { jobTitles: string[]; areas: string[] };
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
 *
 * The manager list is loaded HERE rather than in the two page files, and that is deliberate: the
 * admin page and its portal twin are kept in sync by hand, so every gate that lives in both is a
 * gate that can drift in one. `canSendToManagers` is the one thing the pages must still decide,
 * because only they hold the AccessContext.
 */
export async function loadScreeningQueue(
  viewerHrId: string | null | undefined,
  filters: ScreeningQueueFilters = {},
  options: { canSendToManagers?: boolean } = {},
): Promise<ScreeningQueue> {
  const [allCandidates, views, hiringManagers, openVacancies, positionSuggestions] = await Promise.all([
    listCandidates(),
    listCandidateViews(viewerHrId),
    options.canSendToManagers ? listHiringManagerOptions() : Promise.resolve<HiringManagerOption[]>([]),
    options.canSendToManagers ? listOpenVacancyOptions() : Promise.resolve<VacancyOption[]>([]),
    options.canSendToManagers
      ? listUsedPositionText()
      : Promise.resolve<{ jobTitles: string[]; areas: string[] }>({ areas: [], jobTitles: [] }),
  ]);

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
    hiringManagers,
    openVacancies,
    positionSuggestions,
    status,
    unseenOnly,
    views,
  };
}
