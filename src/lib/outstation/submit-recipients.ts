/**
 * Who receives the "your outstation expense was submitted" email.
 *
 * Owner decision (2026-08-04) — this REPLACES the previous routing, which fired the
 * submit alert at every active Super Admin AND the CEO and told the employee nothing.
 * The new envelope is one email per submission:
 *
 *   To   the submitting employee                — it is his confirmation, so he is the audience
 *   Cc   his direct manager                     — unless that is the CEO
 *   Cc   his manager's manager                  — unless that is the CEO
 *   Bcc  every active Super Admin               — silent oversight copy
 *
 * Owner instruction 2026-08-08: THE CEO IS NEVER ON AN OUTSTATION SUBMISSION EMAIL, in any slot.
 *
 * The 2026-08-04 version excluded him from the skip-level slot only. That left the direct-manager
 * slot copying him on every submission by one of his 21 direct reports — all three NSMs (A-12,
 * AI-0008, B-122), plus District Managers, Medical Reps, Finance, Marketing and SFE — i.e. the same
 * company-wide broadcast the earlier change set out to stop, arriving through the other slot.
 *
 * omar.anwar needs no special handling — he is an active Super Admin (B-10) so he is already in
 * the Bcc list above, and send-phoenix-email.ts additionally Bccs him on every automated email.
 *
 * The decision is split from the lookup on purpose: `buildOutstationSubmitRouting` is pure
 * so every edge (CEO as skip-level, a Super Admin who is also the manager, a self-managing
 * employee, a missing chain) is unit-testable without a database.
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
 * Dedupe rules, in priority order — a person appears in at most ONE slot, the most
 * visible one they qualify for:
 *   1. To wins over Cc and Bcc (an employee who manages himself is not also Cc'd).
 *   2. Cc wins over Bcc (a Super Admin who is the employee's manager is Cc'd openly
 *      rather than silently Bcc'd — the alternative puts the same mailbox in two
 *      headers of one message, which some clients render as a duplicate recipient).
 */
export function buildOutstationSubmitRouting(input: {
  ceoHrIds: readonly string[];
  employeeHrId: string | null | undefined;
  managerHrId: string | null | undefined;
  managerOfManagerHrId: string | null | undefined;
  superAdminHrIds: readonly string[];
}): OutstationSubmitRouting {
  const employeeHrId = String(input.employeeHrId ?? "").trim();
  const toKey = key(employeeHrId);
  if (!toKey) return { bccHrIds: [], ccHrIds: [], toHrId: null };

  const ceoKeys = new Set(input.ceoHrIds.map(key).filter(Boolean));
  // Seeding `taken` with the CEO keeps "removed from Cc" from silently becoming "Bcc'd on every
  // submission" the day someone grants him Super Admin — the Bcc loop below skips anyone already
  // taken. He is off the email entirely, not moved to a quieter header.
  const taken = new Set<string>([toKey, ...ceoKeys]);

  const ccHrIds: string[] = [];
  // Owner instruction 2026-08-08: the CEO is never Cc'd on an outstation submission, in ANY slot.
  //
  // The 2026-08-04 rule excluded him from the skip-level slot only, which still copied him on every
  // submission by one of his 21 direct reports — all three NSMs (A-12, AI-0008, B-122), plus
  // District Managers, Medical Reps, Finance, Marketing and SFE. That is the same company-wide
  // broadcast the earlier change set out to stop, arriving through the other slot.
  //
  // Enforced HERE, inside addCc, rather than at each call site: a future slot (area manager, an
  // approver chain) then inherits the exclusion automatically instead of quietly reintroducing him.
  const addCc = (hrId: string | null | undefined) => {
    const original = String(hrId ?? "").trim();
    const candidate = key(original);
    if (!candidate || taken.has(candidate)) return;
    taken.add(candidate);
    ccHrIds.push(original);
  };

  addCc(input.managerHrId);
  addCc(input.managerOfManagerHrId);

  const bccHrIds: string[] = [];
  for (const superAdmin of input.superAdminHrIds) {
    const original = String(superAdmin ?? "").trim();
    const candidate = key(original);
    if (!candidate || taken.has(candidate)) continue;
    taken.add(candidate);
    bccHrIds.push(original);
  }

  return { bccHrIds, ccHrIds, toHrId: employeeHrId };
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
    // Fall back to the raw id so a submission still confirms to the employee even when the
    // directory read is degraded — only the Cc chain is lost, not his own copy.
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
