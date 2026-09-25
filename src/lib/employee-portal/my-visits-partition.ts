// Client-safe split of the portal's My Visits / Team Visits rows into calls and days off.
//
// Lives apart from my-crm-visits.ts for the same reason my-crm-visits-constants.ts does: that
// module is server-only, and the "use client" workspace may import VALUES only from here.
//
// OWNER'S RULE, 2026-08-28 (chosen again for this portal, 2026-09-25): vacations and visits are
// separated. The KPI drill-down (src/components/crm/rep-visits-detail.tsx) already keeps leave,
// public holidays, meetings and training under "Days not in the field"; My Visits counted them as
// visits, so a rep saw a bigger number here than on KPIs. Each row's `fieldWork` flag is set on
// the server by isFieldWorkVisit (crm/visit-types.ts), the same bucket test classifyCallProof uses.

/**
 * Split rows into calls and days not in the field, in one pass.
 *
 * Returned as two arrays rather than a filter at each call site, so the tab count and the list
 * under it cannot be built from different predicates.
 */
export function partitionMyVisitRows<T extends { fieldWork: boolean }>(
  rows: readonly T[],
): { fieldRows: T[]; offDutyRows: T[] } {
  const fieldRows: T[] = [];
  const offDutyRows: T[] = [];
  for (const row of rows) (row.fieldWork ? fieldRows : offDutyRows).push(row);
  return { fieldRows, offDutyRows };
}

/** What a day not in the field was, in the rep's own words — the comment, one line. */
export function myOffDutyReason(row: { comment: string | null }): string | null {
  const reason = row.comment?.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean).join(" · ");
  return reason ? reason : null;
}
