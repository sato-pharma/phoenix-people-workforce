/**
 * Who receives the "outstation expense submitted" email.
 *
 * Owner decision (email-reduction project, 2026-08-13) — the submitting employee is not on this
 * email in any slot. He was just on the screen that created the request, so a copy of it confirms
 * nothing he does not already know, and his submission still shows in the Expenses portal. The
 * envelope is one email per submission, addressed to the people who can act on it or oversee it:
 *
 *   To   his direct manager            — unless that is the CEO, or missing
 *   Cc   his manager's manager         — unless that is the CEO, or missing
 *   Bcc  every active Super Admin      — silent oversight copy
 *
 * If the direct manager cannot be addressed (missing, or the CEO), the skip-level manager takes
 * the To slot instead of sitting in an empty Cc. If neither rung of the reporting line can be
 * addressed, the first active Super Admin is promoted from Bcc to To, so a submission from one of
 * the CEO's own direct reports — every NSM among them — still reaches someone instead of no one.
 *
 * Owner instruction 2026-08-08: THE CEO IS NEVER ON AN OUTSTATION SUBMISSION EMAIL, in any slot.
 *
 * The 2026-08-04 version excluded him from the skip-level slot only. That left the direct-manager
 * slot copying him on every submission by one of his 21 direct reports — all three NSMs (A-12,
 * AI-0008, B-122), plus District Managers, Medical Reps, Finance, Marketing and SFE — i.e. the same
 * company-wide broadcast the earlier change set out to stop, arriving through the other slot.
 *
 * omar.anwar needs no special handling — he is an active Super Admin (B-10) so he is already in
 * the Bcc list above (or promoted to To on the rare submission with no addressable manager), and
 * send-phoenix-email.ts additionally Bccs him on every automated email.
 *
 * The decision is split from the lookup on purpose: `buildOutstationSubmitRouting` is pure
 * so every edge (CEO as skip-level, a Super Admin who is also the manager, an employee who is
 * his own manager, a missing chain) is unit-testable without a database.
 */

import { normalizeHrIdForAccess } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getEmployeeDirectory, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { logError } from "@/lib/observability/log";

/** The resolved envelope, in HR IDs. Addresses are resolved separately (see resolveAddresses). */
export type OutstationSubmitRouting = {
  bccHrIds: string[];
  ccHrIds: string[];
  toHrId: string | null;
};

function key(hrId: string | null | undefined): string {
  return normalizeHrIdForAccess(hrId) ?? "";
}

/**
 * Pure envelope decision.
 *
 * Identity is COMPARED on the normalized key but EMITTED as the caller's original HR ID.
 * `normalizeHrIdForAccess` lowercases and strips punctuation ("HR-REP" -> "hrrep"), and the
 * returned ids are fed straight into `app_auth_users.hr_id` equality lookups downstream — so
 * returning the normalized form silently matches nobody and the mail goes to no one.
 * Compare normalized, return verbatim.
 *
 * The submitting employee is excluded up front — he never occupies To, Cc, or Bcc, however the
 * rest of the reporting chain resolves.
 *
 * Dedupe rules — a person appears in at most ONE slot, the most visible one they qualify for:
 *   1. To wins over Cc and Bcc. The direct manager is tried first; if he is unavailable (the CEO,
 *      already the employee, or missing) the skip-level manager is tried for To instead of landing
 *      in Cc with the To slot empty; if that is unavailable too, the first active Super Admin is
 *      promoted from Bcc to To, so a submission is never left with no one addressed.
 *   2. Cc wins over Bcc — whoever the reporting chain placed in Cc is skipped if the Bcc loop
 *      reaches them again (e.g. a Super Admin who is also the skip-level manager), so the same
 *      mailbox never appears in two headers of one message.
 */
export function buildOutstationSubmitRouting(input: {
  ceoHrIds: readonly string[];
  employeeHrId: string | null | undefined;
  managerHrId: string | null | undefined;
  managerOfManagerHrId: string | null | undefined;
  superAdminHrIds: readonly string[];
}): OutstationSubmitRouting {
  const employeeKey = key(input.employeeHrId);
  if (!employeeKey) return { bccHrIds: [], ccHrIds: [], toHrId: null };

  const ceoKeys = new Set(input.ceoHrIds.map(key).filter(Boolean));
  // Seeding `taken` with the employee and the CEO keeps both of them from appearing in any slot,
  // including a later Bcc/To promotion — "removed from To" must never silently become "Bcc'd
  // instead" the day either of them is also granted Super Admin.
  const taken = new Set<string>([employeeKey, ...ceoKeys]);

  // To: try the direct manager, then the skip-level manager. Owner instruction 2026-08-08: the CEO
  // is never on an outstation submission, in ANY slot — so a direct report of his (every NSM, and
  // 18 others) skips straight past him to the skip-level slot, or beyond it if that is empty too.
  let toHrId: string | null = null;
  const claimTo = (hrId: string | null | undefined): boolean => {
    const original = String(hrId ?? "").trim();
    const candidate = key(original);
    if (!candidate || taken.has(candidate)) return false;
    taken.add(candidate);
    toHrId = original;
    return true;
  };

  const ccHrIds: string[] = [];
  const addCc = (hrId: string | null | undefined) => {
    const original = String(hrId ?? "").trim();
    const candidate = key(original);
    if (!candidate || taken.has(candidate)) return;
    taken.add(candidate);
    ccHrIds.push(original);
  };

  if (claimTo(input.managerHrId)) {
    addCc(input.managerOfManagerHrId);
  } else {
    claimTo(input.managerOfManagerHrId);
  }

  const bccHrIds: string[] = [];
  for (const superAdmin of input.superAdminHrIds) {
    const original = String(superAdmin ?? "").trim();
    const candidate = key(original);
    if (!candidate || taken.has(candidate)) continue;
    taken.add(candidate);
    // Neither rung of the reporting line was addressable — promote the first active Super Admin
    // into To so oversight is never silently dropped to zero recipients.
    if (toHrId === null) {
      toHrId = original;
    } else {
      bccHrIds.push(original);
    }
  }

  return { bccHrIds, ccHrIds, toHrId };
}

/** Active HR IDs holding a given set of auth roles. Empty on any failure — never throws. */
async function activeHrIdsForRoles(roles: string[]): Promise<string[]> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("app_auth_users")
      .select("hr_id,role,is_active")
      .eq("is_active", true)
      .in("role", roles);
    if (error) throw error;
    const hrIds = new Set<string>();
    for (const row of (data ?? []) as Array<{ hr_id?: string | null }>) {
      const hrId = String(row.hr_id ?? "").trim();
      if (hrId) hrIds.add(hrId);
    }
    return Array.from(hrIds);
  } catch (error) {
    logError("Outstation submit-email role lookup failed", {
      error,
      labels: { event: "outstation_submit_routing_role_lookup_failed", roles: roles.join(",") },
    });
    return [];
  }
}

function findByHrId(rows: readonly EmployeeDirectoryRow[], hrId: string | null | undefined) {
  const wanted = key(hrId);
  if (!wanted) return null;
  return rows.find((row) => key(row.hrId) === wanted) ?? null;
}

/**
 * Resolve the full envelope for one submission: walks the employee's reporting chain in
 * the employee directory, then applies `buildOutstationSubmitRouting`.
 *
 * Returns `toHrId: null` when the employee cannot be located — the caller then skips the
 * send rather than mailing a partial envelope to managers about an employee it cannot name.
 */
export async function resolveOutstationSubmitRouting(
  employeeHrId: string,
): Promise<OutstationSubmitRouting & { managerName: string | null }> {
  const [directory, ceoHrIds, superAdminHrIds] = await Promise.all([
    getEmployeeDirectory(),
    activeHrIdsForRoles(["CEO"]),
    activeHrIdsForRoles(["Super Admin"]),
  ]);

  const employee = findByHrId(directory.employees, employeeHrId);
  const manager = findByHrId(directory.employees, employee?.managerHrId);
  const managerOfManager = findByHrId(directory.employees, manager?.managerHrId);

  const routing = buildOutstationSubmitRouting({
    ceoHrIds,
    // Fall back to the raw id so the exclusion still applies (and the envelope is still built)
    // even when the directory read is degraded.
    employeeHrId: employee?.hrId ?? employeeHrId,
    managerHrId: manager?.hrId ?? null,
    managerOfManagerHrId: managerOfManager?.hrId ?? null,
    superAdminHrIds,
  });

  return { ...routing, managerName: manager?.displayName ?? employee?.managerName ?? null };
}

/**
 * Deliverable work-email addresses for a list of HR IDs, in the order given. HR IDs with no
 * usable mailbox are dropped: a Cc slot with no address is simply absent, never an empty
 * header entry.
 */
export async function resolveOutstationRecipientAddresses(hrIds: readonly string[]): Promise<string[]> {
  if (hrIds.length === 0) return [];
  const directory = await getEmployeeDirectory();
  const seen = new Set<string>();
  const addresses: string[] = [];
  for (const hrId of hrIds) {
    const email = String(findByHrId(directory.employees, hrId)?.workEmail ?? "").trim().toLowerCase();
    if (!email || !email.includes("@") || seen.has(email)) continue;
    seen.add(email);
    addresses.push(email);
  }
  return addresses;
}
