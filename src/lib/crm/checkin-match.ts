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
import { canonicalHrIdKey } from "@/lib/hr-id";

/** Minimum shape the matcher needs from a check-in; callers pass richer rows and read extra fields
 * off the returned candidate. */
export type CheckinForMatch = {
  agent_crm_id: number | null;
  /** The fallback identity for a rep with no CRM id — see {@link checkinAgentKey}. Optional so a
   * caller that has not selected it keeps compiling; such a caller matches CRM-id reps only. */
  agent_hr_id?: string | null;
  contact_crm_id: number | null;
  // Nullable so both caller row shapes satisfy the constraint; the index-builder's `!check_date`
  // guard drops null/empty timestamps, so every candidate that reaches pickCheckinForVisit has a real one.
  check_date: string | null;
};

/**
 * The agent half of the match key: the CRM id when the rep has one, else `hr:<canonical hr id>`.
 *
 * After the CRM cutover a rep hired without a CRM account logs native visits whose `agent_crm_id`
 * is NULL on BOTH the visit and its check-in. Keyed on the CRM id alone, every such visit returned
 * early and its verified call rate read zero — a new hire who checked in at every doctor, scored as
 * never having checked in once. The CRM id stays first, so every rep who has one keeps exactly the
 * key he always had; the hr id only ever speaks for a rep with no CRM id.
 */
export function checkinAgentKey(agentCrmId: number | null | undefined, agentHrId: string | null | undefined): string | null {
  if (agentCrmId != null) return String(agentCrmId);
  const hrKey = canonicalHrIdKey(agentHrId);
  return hrKey ? `hr:${hrKey}` : null;
}

/** Group check-ins by `agent | contact | Cairo-day` so a visit can look up its candidates in O(1).
 * Check-ins with no agent, no real contact, or no timestamp can never match a visit and are skipped. */
export function indexCheckinsByAgentContactDay<C extends CheckinForMatch>(checkins: readonly C[]): Map<string, C[]> {
  const index = new Map<string, C[]>();
  for (const checkin of checkins) {
    const agentKey = checkinAgentKey(checkin.agent_crm_id, checkin.agent_hr_id);
    // `0` is the vendor's "no contact" placeholder and is rejected here exactly as pickCheckinForVisit
    // rejects it on the visit side. The two sides were asymmetric: the visit side normalised 0 to
    // null (so it returns early and never looks up), but the index still stored those check-ins under
    // an `agent|0|day` key. Harmless only because of that one-sided guard — the moment anything
    // queried this index with a raw contact id, every contact-less visit would "match" every
    // contact-less check-in of the same rep and day, and the match would read as a verified
    // same-contact GPS hit. Rejecting it on both sides makes the rule true rather than load-bearing
    // in one place, and matches this function's own docstring ("no real contact").
    if (agentKey == null || checkin.contact_crm_id == null || checkin.contact_crm_id === 0 || !checkin.check_date) continue;
    const key = `${agentKey}|${checkin.contact_crm_id}|${String(checkin.check_date).slice(0, 10)}`;
    const list = index.get(key);
    if (list) list.push(checkin);
    else index.set(key, [checkin]);
  }
  return index;
}

/** The matched check-in for a visit, or null when the visit has no real contact / no same-contact
 * check-in that day. `crmSaveDate` is the tie-break anchor (never `visit_date_time`). */
export function pickCheckinForVisit<C extends CheckinForMatch>(
  visit: {
    agentCrmId: number | null;
    /** Pass it: without it a visit by a rep with no CRM id can never find its check-in. */
    agentHrId?: string | null;
    contactCrmId: number | null;
    visitDay: string | null;
    crmSaveDate: string | null;
  },
  index: Map<string, C[]>,
): C | null {
  const contact = typeof visit.contactCrmId === "number" && visit.contactCrmId !== 0 ? visit.contactCrmId : null;
  const agentKey = checkinAgentKey(visit.agentCrmId, visit.agentHrId);
  if (agentKey == null || contact == null || !visit.visitDay) return null;
  const candidates = index.get(`${agentKey}|${contact}|${visit.visitDay}`);
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
