import { averageCheckinPoint, type ObservedPoint } from "@/lib/crm/checkin-location";
import { getDoctorListRepSummaries } from "@/lib/crm/contact-lists";
import { findSharedCustomers, type SharedWith } from "@/lib/crm/location-confidence";
import { repDoctorListRepKey } from "@/lib/crm/rep-doctor-lists";
import { loadCheckins, loadContactRoster, loadPinsFor } from "@/lib/crm/reps-list";

/**
 * 🔴 WHERE A DOCTOR ACTUALLY IS, from the check-ins already in the mirror (owner, 2026-09-30: "you
 * will get the location of the doctor from the check-ins taken for this doctor and put it in the
 * location here", and "make an average"). The READ is `loadCheckins`, reused exactly as the old
 * board uses it — he asked in the same breath that this not be built twice. The averaging rule is
 * `averageCheckinPoint`, and the reasoning for it lives there.
 *
 * Returns nothing rather than throwing: a customer with no check-ins, a missing mirror or an
 * unreadable view all mean "nobody has stood there", which is an answer, not a failure.
 */
export async function loadObservedPointsFor(contactCrmIds: readonly number[]): Promise<Map<number, ObservedPoint>> {
  if (contactCrmIds.length === 0) return new Map();
  const checkins = await loadCheckins(contactCrmIds);
  const observed = new Map<number, ObservedPoint>();
  for (const [contactCrmId, found] of checkins) {
    const point = averageCheckinPoint(found.points);
    if (point) observed.set(contactCrmId, { ...point, address: found.seenAt.address });
  }
  return observed;
}

/**
 * Which of a rep's customers ANOTHER rep also carries — the old Reps List's violet highlight, made
 * reusable so Phoenix CRM's List can show the same thing.
 *
 * 🔴 THE OWNER, 2026-09-30, listing what the old board did that the new one did not: "if a doctor is
 * shared between this rep and another rep, it was highlighted." The matcher itself is not new — it
 * is `findSharedCustomers`, unchanged — but it lived inside `getRepsListForAgent`, which reads the
 * whole iReports360 board for one rep. Phoenix CRM's List needs the answer and none of the rest, so
 * the narrow half is lifted here and both boards now call the same code.
 *
 * WHY IT IS AN INFERENCE, AND WHY THAT IS SAID ON SCREEN. iReports360 gives every rep their own row
 * for one doctor, so nothing in the data states that two rows are one person: it is worked out from
 * the name and the pin, or from a shared phone. `describeSharing` prints the basis beside the
 * highlight precisely so a reader who disagrees can overrule it. This module never merges anything
 * and never reassigns anyone — the owner's standing rule is that a two-line customer is a treasure,
 * not a duplicate to be tidied away.
 *
 * COST. One roster read (the open assignments, a few narrow columns), then pins for ONLY the
 * contacts that could possibly be the same customer — the candidate set is filtered on the name and
 * phone keys of the rep's own rows before a single pin is fetched. That is the same shape the board
 * has always paid, and a rep's own List is a page one person opens.
 */

/**
 * A partner we cannot name is never shown — the board's own rule, kept.
 *
 * Takes the rep's HR ID rather than a rep key, because the caller is Phoenix CRM's own territory
 * loader and it knows the seat's occupant, not his iReports360 account. The key is resolved here from
 * the same summaries the names come from: the CRM id when the rep has one, `hr:<id>` when he does
 * not — keyed on the CRM id alone, a rep hired without an account is a stranger to his own rows.
 */
export async function loadSharedCustomersFor(
  contactCrmIds: readonly number[],
  repHrId: string,
): Promise<Map<number, SharedWith[]>> {
  if (contactCrmIds.length === 0) return new Map();

  const [roster, summaries] = await Promise.all([loadContactRoster(), getDoctorListRepSummaries()]);
  if (roster.length === 0) return new Map();

  // 🔴 THE REP NAMES ARE REQUIRED, NOT OPTIONAL. `findSharedCustomers` never names — and so never
  // matches — a partner whose key it cannot resolve. Handing it an empty map finds nothing at all,
  // which reads exactly like a company with no shared customers rather than like a caller that
  // forgot.
  const repNames = new Map<string, string>();
  let repKey: string | null = null;
  for (const summary of summaries) {
    const key = repDoctorListRepKey(summary.agentCrmId, summary.hrId);
    if (!key) continue;
    const name = summary.name?.trim();
    if (name) repNames.set(key, name);
    if (summary.hrId === repHrId) repKey = key;
  }
  // A rep with no iReports360 account at all still has a key of his own.
  repKey ??= repDoctorListRepKey(null, repHrId);
  if (!repKey) return new Map();

  // Narrow the roster to the contacts that could possibly be the same customer BEFORE asking for any
  // pins. The matching keys come from the roster on BOTH sides, so the two halves of a pair are
  // normalized identically — reading one side off a display row would compare a real name against
  // the "Contact 12345" placeholder a nameless row falls back to.
  const rosterById = new Map(roster.map((entry) => [entry.contactCrmId, entry]));
  const mineNameKeys = new Set<string>();
  const minePhoneKeys = new Set<string>();
  for (const id of contactCrmIds) {
    const entry = rosterById.get(id);
    if (!entry) continue;
    if (entry.nameKey) mineNameKeys.add(entry.nameKey);
    if (entry.phoneKey) minePhoneKeys.add(entry.phoneKey);
  }
  if (mineNameKeys.size === 0 && minePhoneKeys.size === 0) return new Map();

  const mineIds = new Set(contactCrmIds);
  const candidateIds = roster
    .filter(
      (entry) =>
        entry.repKey !== repKey &&
        !mineIds.has(entry.contactCrmId) &&
        ((entry.nameKey !== "" && mineNameKeys.has(entry.nameKey)) || (entry.phoneKey != null && minePhoneKeys.has(entry.phoneKey))),
    )
    .map((entry) => entry.contactCrmId);
  if (candidateIds.length === 0) return new Map();

  const pins = await loadPinsFor([...mineIds, ...candidateIds]);

  return findSharedCustomers(
    contactCrmIds.map((contactCrmId) => ({ contactCrmId, repKey })),
    roster,
    pins,
    repNames,
  );
}
