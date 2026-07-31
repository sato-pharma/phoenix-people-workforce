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

import { hasRealVendorTime } from "@/lib/crm/dates";

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

  // The anchor must carry a REAL clock. `crm_save_date` is a midnight placeholder on ~3% of rows
  // (3,398 visits in production, 384 of them on an agent/contact/day that has more than one
  // check-in), and `new Date("…T00:00:00").getTime()` is perfectly finite — so a truthiness check
  // silently accepted midnight as "the visit was saved at 00:00" and collapsed "nearest in time"
  // to "earliest check-in of the day". That is exactly the degradation this module's header says
  // it exists to prevent for `visit_date_time`; hasRealVendorTime is the shared rule for both.
  const anchorMs = hasRealVendorTime(visit.crmSaveDate) ? new Date(visit.crmSaveDate).getTime() : Number.NaN;
  if (!Number.isFinite(anchorMs)) return earliestCheckin(candidates);
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

/**
 * Deterministic fallback when the visit has no usable time anchor: the day's EARLIEST check-in.
 * Chosen explicitly rather than taking `candidates[0]`, whose order is just however the rows
 * arrived from the database — so the same visit could resolve to a different check-in between two
 * renders. This is a day-level match, not a time-level one; it is the honest best available, and
 * callers that display it as a precise GPS time should say "same day" rather than imply precision.
 */
function earliestCheckin<C extends CheckinForMatch>(candidates: readonly C[]): C {
  let earliest = candidates[0];
  for (const candidate of candidates) {
    if (String(candidate.check_date) < String(earliest.check_date)) earliest = candidate;
  }
  return earliest;
}
