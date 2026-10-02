// Early Birds — a started Phoenix CRM team's clock (owner, 2026-10-02: "First Phoenix visit").
//
// For a rep of a team counted from Phoenix CRM (src/lib/crm/phoenix-team-starts.ts), within the team's
// start, his start of the day is the time of his FIRST COUNTABLE Phoenix visit that day — `captured_at`,
// the moment it was saved at the customer's door, read as Cairo wall clock exactly as the read door
// carries it in `crm_save_date`. It replaces his iReports360 GPS check-in in BOTH components that read a
// clock — the start (`gpsStartByRepDay`) and the "#1 days" daily board — so the module stays on one
// clock: his iReports360 check-ins within the start are left out of both, exactly as the read door
// leaves out his iReports360 visits.
//
// The day's start itself is `phoenixFirstVisitStarts` (src/lib/crm/sfe-field-analytics.ts), the ONE
// helper the SFE start-time table reads too. This file holds what only Early Birds needs: which of its
// rep-days a start covers. Pure, so the rule is tested against fixed rows; collect.ts reads the rows.

import { normalizeHrIdForAccess } from "@/lib/hr-id";

/** One person's days within a team's start: [from, until), until null while it runs. */
export type StartedRepWindow = {
  /** The roster key (`normalizeHrIdForAccess`), or null. */
  hrIdKey: string | null;
  agentCrmId: number | null;
  from: string;
  until: string | null;
};

/**
 * Whether a row (a check-in, a visit) of this person on this day falls within a start. Matched as the
 * read door matches: on the hr id, or — on a row that carries no hr id — on the CRM id.
 */
export function startedWindowCovers(
  windows: readonly StartedRepWindow[],
  row: { hrId: string | null | undefined; crmId: number | null | undefined },
  dateIso: string,
): boolean {
  if (!dateIso) return false;
  const key = normalizeHrIdForAccess(row.hrId ?? null);
  return windows.some(
    (window) =>
      dateIso >= window.from &&
      (window.until === null || dateIso < window.until) &&
      (key ? window.hrIdKey === key : row.crmId != null && window.agentCrmId === row.crmId),
  );
}
