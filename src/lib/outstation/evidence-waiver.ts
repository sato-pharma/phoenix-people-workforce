/**
 * Who is exempt from the outstation photo-evidence rules, and what the exemption covers.
 *
 * Owner request (2026-08-19): Product Manager, Group Product Manager and National Sales Manager
 * submit outstation requests without any evidence photo. On a car trip there is no photo at all;
 * on a train or bus trip the ticket may be attached — as a PDF or an image — but is optional.
 *
 * Extended to the Training Manager on 2026-10-26, on the owner's instruction: "MAKE SURE THE
 * OUTSTATION EXPENSES REQUESTS FROM THE TRAINING MANAGER DOESN'T ASK FOR EVIDENCE PHOTO LIKE THE
 * NSM AND GPM" — asked and answered as the full waiver the other three hold, photos and ticket
 * alike, so her bus trips are not left owing the one piece of evidence the others may skip.
 *
 * Three things are worth being explicit about, because each one is a way this could go wrong:
 *
 *   1. The waiver covers BOTH photos, not just the one on the submission form. The two-photo
 *      rule is a pair: arrival at submit time, departure before leaving. Waiving only the
 *      arrival photo would leave every one of these requests parked at `pending_arrival_photo`
 *      forever — the gate demands the arrival photo before it will even look at anything else —
 *      so the money would simply stop moving for these roles. A half-waiver is worse than
 *      no waiver.
 *
 *   2. The role is read from the REQUEST's stored `employee_role`, never from the caller's
 *      session. The column is written at submit time from the employee's job function, so a
 *      request keeps the waiver it was submitted under even if the person is later promoted or
 *      moved. That also means a reviewer opening someone else's claim sees the same answer the
 *      submitter did.
 *
 *   3. This is a business rule about EVIDENCE, not a permission. It must never be used to decide
 *      who may read, approve or pay anything — `assertPermission` remains the security boundary.
 *
 * Nothing here is stored. The waiver is derived on every read from a column the row already
 * carries, which is why it needs no new gate status and no migration: `evidence_gate_status`
 * goes on recording, truthfully, which photos a row actually holds, and the gate resolver
 * decides separately whether that matters for this role.
 */

/**
 * The four roles the owner named. Canonical job-function role names, exactly as
 * `resolveJobFunctionRole` produces them (src/lib/employees/job-function.ts) and exactly as
 * `outstation_expense_requests.employee_role` stores them.
 *
 * Deliberately an allowlist, not a tier or a seniority test. "Everyone above a District Manager"
 * would silently swallow the CEO, Marketing Manager and every future senior title into an
 * evidence exemption nobody asked for — and it is why the Training Manager had to be NAMED here
 * on 2026-10-26 rather than arriving on her own as a senior title.
 */
export const OUTSTATION_EVIDENCE_WAIVED_ROLES: ReadonlySet<string> = new Set([
  "Group Product Manager",
  "National Sales Manager",
  "Product Manager",
  "Training Manager",
]);

/**
 * True when this role submits outstation requests with no photo evidence required.
 *
 * Compared case-insensitively on a trimmed value: the role reaches here from a database column
 * on the read paths, and a stray "product manager" must not quietly re-arm a requirement the
 * owner removed.
 */
export function isOutstationEvidenceWaivedRole(role: string | null | undefined): boolean {
  const normalized = String(role ?? "").trim().toLowerCase();
  if (!normalized) return false;
  for (const waived of OUTSTATION_EVIDENCE_WAIVED_ROLES) {
    if (waived.toLowerCase() === normalized) return true;
  }
  return false;
}

/**
 * True when a train or bus ticket is optional for this role rather than mandatory.
 *
 * Same roles, but a separate function on purpose: the ticket and the photos are two
 * different pieces of evidence, and one of them could be reinstated later without the other.
 * Delegating keeps them in step until somebody deliberately separates them.
 */
export function isOutstationTicketWaivedRole(role: string | null | undefined): boolean {
  return isOutstationEvidenceWaivedRole(role);
}

/** The line shown wherever a waived request would otherwise be asked for a photo. */
export const OUTSTATION_EVIDENCE_WAIVED_MESSAGE =
  "Photo evidence is not required for this role, so this request is not held for one.";
