/**
 * The single canonical rule for "which GPS check-in belongs to this visit", shared by every
 * surface that shows a visit's check-in (the Visits Report and the CRM master tab). Keeping one
 * matcher means a given visit resolves to the SAME check-in everywhere — no more three screens
 * disagreeing.
 *
 * A check-in belongs to a visit when it is the SAME agent, at the SAME real contact
 * (`contact_crm_id` present and ≠ 0), on the SAME Cairo calendar day. Only regular visits carry a
 * real contact; Campaign/Meeting/Vacation rows have none and genuinely have no check-in, so they
 * never match. When a contact has more than one check-in that day, the tie breaks to the one
 * nearest `crm_save_date` — the only real per-visit time signal. It is NEVER anchored on
 * `visit_date_time`, which is a fixed midnight placeholder on ~100% of rows (that bug made
 * "nearest in time" silently degrade to "earliest check-in of the day").
 */

/** Minimum shape the matcher needs from a check-in; callers pass richer rows and read extra fields
 * off the returned candidate. */
export type CheckinForMatch = {
  agent_crm_id: number | null;
  contact_crm_id: number | null;
  // Nullable so both caller row shapes satisfy the constraint; the index-builder's `!check_date`
  // guard drops null/empty timestamps, so every candidate that reaches pickCheckinForVisit has a real one.
  check_date: string | null;
};

/** Group check-ins by `agent | contact | Cairo-day` so a visit can look up its candidates in O(1).
 * Check-ins with no agent, no real contact, or no timestamp can never match a visit and are skipped. */
export function indexCheckinsByAgentContactDay<C extends CheckinForMatch>(checkins: readonly C[]): Map<string, C[]> {
  const index = new Map<string, C[]>();
  for (const checkin of checkins) {
    if (checkin.agent_crm_id == null || checkin.contact_crm_id == null || !checkin.check_date) continue;
    const key = `${checkin.agent_crm_id}|${checkin.contact_crm_id}|${String(checkin.check_date).slice(0, 10)}`;
    const list = index.get(key);
    if (list) list.push(checkin);
    else index.set(key, [checkin]);
  }
  return index;
}

/** The matched check-in for a visit, or null when the visit has no real contact / no same-contact
 * check-in that day. `crmSaveDate` is the tie-break anchor (never `visit_date_time`). */
export function pickCheckinForVisit<C extends CheckinForMatch>(
  visit: { agentCrmId: number | null; contactCrmId: number | null; visitDay: string | null; crmSaveDate: string | null },
  index: Map<string, C[]>,
): C | null {
  const contact = typeof visit.contactCrmId === "number" && visit.contactCrmId !== 0 ? visit.contactCrmId : null;
  if (visit.agentCrmId == null || contact == null || !visit.visitDay) return null;
  const candidates = index.get(`${visit.agentCrmId}|${contact}|${visit.visitDay}`);
  if (!candidates || candidates.length === 0) return null;

  const anchorMs = visit.crmSaveDate ? new Date(visit.crmSaveDate).getTime() : Number.NaN;
  if (!Number.isFinite(anchorMs)) return candidates[0];
  let best = candidates[0];
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const diff = Math.abs(new Date(String(candidate.check_date)).getTime() - anchorMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = candidate;
    }
  }
  return best;
}
