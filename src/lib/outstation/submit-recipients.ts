/**
 * Who receives the "outstation expense submitted" email.
 *
 * Owner decision (2026-09-04) — REVERSES the 2026-08-13 email-reduction project below. Every
 * submission now confirms to the employee it belongs to; his manager stays in the loop as a
 * courtesy copy, and Super Admin keeps silent oversight:
 *
 *   To   the employee himself      — it is his own submission
 *   Cc   his direct manager        — unless that is the CEO, or missing
 *   Bcc  every active Super Admin  — silent oversight copy, unchanged
 *
 * If the direct manager cannot be Cc'd (missing, or the CEO), the skip-level manager takes the Cc
 * slot instead of leaving it empty — so a submission from one of the CEO's own direct reports
 * (every NSM, and 18 others) still keeps someone above the employee in the loop.
 *
 * Owner instruction 2026-08-08 still stands: THE CEO IS NEVER ON AN OUTSTATION SUBMISSION EMAIL,
 * in any slot — enforced exactly as before, just against the Cc/Bcc slots now that To is fixed.
 *
 * omar.anwar needs no special handling — he is an active Super Admin (B-10) so he is already in
 * the Bcc list above, and send-phoenix-email.ts additionally Bccs him on every automated email.
 *
 * History (2026-08-13 → 2026-09-04): the submitting employee was excluded from every slot on the
 * reasoning that he was just on the submission screen and a copy confirmed nothing he did not
 * already know. To was his direct manager, falling back to the skip-level manager and then to a
 * Super Admin promoted from Bcc so oversight was never silently dropped to zero recipients.
 * Reversed because the employee is the person the confirmation is actually for.
 *
 * The decision is split from the lookup on purpose: `buildOutstationSubmitRouting` is pure
 * so every edge (CEO as the direct manager, a Super Admin who is also the manager, an employee
 * who is his own manager, a missing chain) is unit-testable without a database.
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
 * To is always the employee — this is his own submission, so there is no fallback chain for it.
 *
 * Dedupe rules — a person appears in at most ONE slot, the most visible one they qualify for:
 *   1. To is the employee, unconditionally — including when he also holds another role (Super
 *      Admin, or even the CEO); the CEO-exclusion rule below is about not broadcasting OTHER
 *      people's submissions to him, not about hiding his own from him.
 *   2. Cc: the direct manager, unless he is the employee himself (self-managed), already the CEO
 *      (excluded, in any slot), or missing — in which case the skip-level manager is tried instead
 *      of leaving Cc empty.
 *   3. Cc wins over Bcc — whoever landed in Cc is skipped if the Bcc loop reaches them again (e.g.
 *      a Super Admin who is also the Cc'd manager), so the same mailbox never appears in two
 *      headers of one message.
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
  // Seeding `taken` with the employee keeps him from also riding Cc/Bcc alongside his own To (a
  // manager who lists himself as his own manager, or an employee who is also a Super Admin). The
  // CEO is seeded too so he can never appear in Cc or Bcc — owner instruction 2026-08-08, THE CEO
  // IS NEVER ON AN OUTSTATION SUBMISSION EMAIL, in any slot other than his own To when he is the
  // one submitting.
  const taken = new Set<string>([employeeKey, ...ceoKeys]);

  // To: always the employee — every submission confirms to the person it belongs to.
  const toHrId = String(input.employeeHrId ?? "").trim() || null;

  // Cc: the direct manager, unless he is unavailable (the CEO, already the employee, or missing)
  // — the skip-level manager is tried instead of leaving Cc empty.
  const ccHrIds: string[] = [];
  const claimCc = (hrId: string | null | undefined): boolean => {
    const original = String(hrId ?? "").trim();
    const candidate = key(original);
    if (!candidate || taken.has(candidate)) return false;
    taken.add(candidate);
    ccHrIds.push(original);
    return true;
  };
  if (!claimCc(input.managerHrId)) {
    claimCc(input.managerOfManagerHrId);
  }

  // Bcc: every active Super Admin — silent oversight copy, minus whoever already holds a louder
  // slot (the employee, the CEO, or the Cc'd manager).
  const bccHrIds: string[] = [];
  for (const superAdmin of input.superAdminHrIds) {
    const original = String(superAdmin ?? "").trim();
    const candidate = key(original);
    if (!candidate || taken.has(candidate)) continue;
    taken.add(candidate);
    bccHrIds.push(original);
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
 * Returns `toHrId: null` when the employee cannot be identified at all (a blank HR ID) — the
 * caller then skips the send rather than mailing a confirmation addressed to no one.
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
    // Fall back to the raw id so To is still resolvable even when the directory read is degraded
    // and the employee row itself could not be found.
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
