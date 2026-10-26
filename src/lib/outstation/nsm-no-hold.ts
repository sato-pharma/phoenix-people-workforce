/**
 * The National Sales Manager no-hold rule.
 *
 * Owner rule, 2026-08-28, in his own words: *"Don't hold the expenses of the national sales
 * manager for any reason. Once submitted, once accepted."* He gave it after finding Magdy El
 * Senosey's 26 August claim (request 101, EGP 935.87, Anti Infective) sitting held on
 * `workload_gate_status = 'pending_workload'`.
 *
 * That hold could never have cleared on its own, which is the point. The workload gate reads the
 * AM/PM visit count for every trip day out of the CRM — a record only a field rep generates. A
 * National Sales Manager does not run a doctor list, so the CRM has nothing to match, so the gate
 * stays `pending_workload` forever and the claim never reaches payroll unless a Super Admin
 * notices it and types a workload in by hand. Every NSM claim was therefore one un-asked-for
 * manual intervention away from being paid, silently, with no error anywhere.
 *
 * Four things are worth being explicit about, because each is a way this could go wrong:
 *
 *   1. **National Sales Manager and nothing else.** This is deliberately narrower than
 *      `evidence-waiver.ts`, which waives PHOTOS for four roles (Product Manager, Group Product
 *      Manager, National Sales Manager, Training Manager). The owner named one role here, twice,
 *      and a hold is a much bigger thing to remove than a photograph.
 *      The two rules are kept in separate modules
 *      on purpose: widening the photo waiver must not silently widen this, and vice versa.
 *
 *   2. **It removes the HOLD, not the CHECK.** Every automated check still runs and every flag it
 *      raises is still written to the request's approval reason, so a reviewer reads exactly what
 *      the system saw. What no longer happens is the claim being parked because of one. This is
 *      the same shape as the owner's 2026-08-09 "the system flags, it never rejects" rule, taken
 *      one step further for this one role.
 *
 *   3. **The role is read from the REQUEST's stored `employee_role`**, never from the caller's
 *      session — the same discipline as the evidence waiver. The column is written at submit time
 *      from the employee's job function, so a claim keeps the rule it was submitted under even if
 *      the person later moves, and a reviewer opening it sees what the submitter saw.
 *
 *   4. **This is a business rule about MONEY MOVING, not a permission.** It must never be used to
 *      decide who may read, approve or pay anything — `assertPermission` remains the security
 *      boundary.
 *
 * Nothing here is stored. The rule is derived on every read from a column the row already carries,
 * so it needs no new gate status and no migration.
 */

/**
 * The role the owner named. Canonical job-function role name, exactly as `resolveJobFunctionRole`
 * produces it (src/lib/employees/job-function.ts) and exactly as
 * `outstation_expense_requests.employee_role` stores it.
 *
 * A set of one, rather than a bare string comparison, so adding a role later is a one-line change
 * in one place — and so the test can assert the size and catch a silent widening.
 */
export const OUTSTATION_NO_HOLD_ROLES: ReadonlySet<string> = new Set(["National Sales Manager"]);

/**
 * True when this role's outstation expense request is never held — not by the photo gate, not by
 * the workload gate, not by any submit-time review flag.
 *
 * Compared case-insensitively on a trimmed value: the role reaches here from a database column on
 * every read path, and a stray "national sales manager" must not quietly re-arm a hold the owner
 * removed.
 */
export function isOutstationNoHoldRole(role: string | null | undefined): boolean {
  const normalized = String(role ?? "").trim().toLowerCase();
  if (!normalized) return false;
  for (const noHold of OUTSTATION_NO_HOLD_ROLES) {
    if (noHold.toLowerCase() === normalized) return true;
  }
  return false;
}

/** What the gate says about a request that is never held. Shown wherever a blocker would be. */
export const OUTSTATION_NO_HOLD_GATE_MESSAGE =
  "Complete — a National Sales Manager's outstation expense is never held, so neither the photo evidence nor the trip workload blocks this request from payroll.";

/** The approval reason stamped on a request accepted the moment it was submitted. */
/**
 * The same rule reached through the admin's manual-entry form.
 *
 * Kept as its own constant rather than reusing the one above: the reason column is what a person
 * reads in the queue months later, and "he submitted it" and "an admin typed it in for him" are
 * different facts about the same money. Both are accepted on the spot; only the wording differs.
 */
export const OUTSTATION_NO_HOLD_ADMIN_APPROVAL_REASON =
  "Accepted on creation — entered by an admin on behalf of a National Sales Manager, whose " +
  "outstation expense is accepted as soon as it is submitted and is never held.";

export const OUTSTATION_NO_HOLD_APPROVAL_REASON =
  "Accepted on submission — a National Sales Manager's outstation expense is accepted as soon as it is submitted and is never held.";
