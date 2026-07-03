// Recipient resolution for the weekly-digest settlement flow.
//
// Approvers, "cc manager", and "cc CEO" are all admin-configured on the
// attendance_digest_settings singleton (per the confirmed spec: "you configure
// approvers & CC list in the admin UI"). This module resolves those settings
// into concrete HR_IDs for a specific employee/dispute, applying the one
// business rule the config alone can't express: an approver can never review
// their own dispute (self-review exclusion) — if that leaves zero reviewers,
// the CEO is the hard fallback so a dispute is never unreviewable.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics";

export type DigestSettings = {
  approverHrIds: string[];
  ccManager: boolean;
  ccCeo: boolean;
  missingPunchVerifierHrId: string | null;
  autoConfirmHours: number;
  cycleAnchorDay: number;
  dryRun: boolean;
};

type SettingsRow = {
  approver_hr_ids: string[] | null;
  cc_manager: boolean;
  cc_ceo: boolean;
  missing_punch_verifier_hr_id: string | null;
  auto_confirm_hours: number;
  cycle_anchor_day: number;
  dry_run: boolean;
};

export async function getDigestSettings(): Promise<DigestSettings> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("attendance_digest_settings")
    .select("approver_hr_ids,cc_manager,cc_ceo,missing_punch_verifier_hr_id,auto_confirm_hours,cycle_anchor_day,dry_run")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw new Error(`Digest settings lookup failed: ${error.message}`);

  const row = (data ?? {
    approver_hr_ids: [],
    auto_confirm_hours: 48,
    cc_ceo: true,
    cc_manager: true,
    cycle_anchor_day: 24,
    dry_run: true,
    missing_punch_verifier_hr_id: null,
  }) as SettingsRow;

  return {
    approverHrIds: (row.approver_hr_ids ?? [])
      .map((id) => normalizeAttendanceHrId(id))
      .filter((id): id is string => Boolean(id)),
    autoConfirmHours: row.auto_confirm_hours,
    ccCeo: row.cc_ceo,
    ccManager: row.cc_manager,
    cycleAnchorDay: row.cycle_anchor_day,
    dryRun: row.dry_run,
    missingPunchVerifierHrId: normalizeAttendanceHrId(row.missing_punch_verifier_hr_id),
  };
}

function cleanHrIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.map((entry) => normalizeAttendanceHrId(typeof entry === "string" ? entry : null)).filter((id): id is string => Boolean(id))),
  );
}

/**
 * Persists the singleton digest settings row. Every field is optional in the
 * input — omitted fields keep their current value (a partial update), so the
 * admin UI only needs to send what actually changed.
 */
export async function saveDigestSettings(input: {
  approverHrIds?: unknown;
  ccManager?: unknown;
  ccCeo?: unknown;
  missingPunchVerifierHrId?: unknown;
  autoConfirmHours?: unknown;
  cycleAnchorDay?: unknown;
  dryRun?: unknown;
  updatedBy: string;
}): Promise<DigestSettings> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: input.updatedBy };

  if (input.approverHrIds !== undefined) patch.approver_hr_ids = cleanHrIdList(input.approverHrIds);
  if (input.ccManager !== undefined) {
    if (typeof input.ccManager !== "boolean") throw new Error("ccManager must be true or false.");
    patch.cc_manager = input.ccManager;
  }
  if (input.ccCeo !== undefined) {
    if (typeof input.ccCeo !== "boolean") throw new Error("ccCeo must be true or false.");
    patch.cc_ceo = input.ccCeo;
  }
  if (input.missingPunchVerifierHrId !== undefined) {
    patch.missing_punch_verifier_hr_id = normalizeAttendanceHrId(
      typeof input.missingPunchVerifierHrId === "string" ? input.missingPunchVerifierHrId : null,
    );
  }
  if (input.autoConfirmHours !== undefined) {
    const hours = Number(input.autoConfirmHours);
    if (!Number.isInteger(hours) || hours <= 0 || hours > 168) throw new Error("autoConfirmHours must be an integer between 1 and 168.");
    patch.auto_confirm_hours = hours;
  }
  if (input.cycleAnchorDay !== undefined) {
    const day = Number(input.cycleAnchorDay);
    if (!Number.isInteger(day) || day < 1 || day > 28) throw new Error("cycleAnchorDay must be an integer between 1 and 28.");
    patch.cycle_anchor_day = day;
  }
  if (input.dryRun !== undefined) {
    if (typeof input.dryRun !== "boolean") throw new Error("dryRun must be true or false.");
    patch.dry_run = input.dryRun;
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("attendance_digest_settings").update(patch).eq("id", 1);
  if (error) throw error;

  return getDigestSettings();
}

export async function ceoHrIds(): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("app_auth_users").select("hr_id").eq("role", "CEO");
  if (error) return [];
  return ((data ?? []) as Array<{ hr_id: string | null }>)
    .map((row) => normalizeAttendanceHrId(row.hr_id))
    .filter((id): id is string => Boolean(id));
}

async function managerHrId(employeeHrId: string): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("employees")
    .select("manager_hr_id")
    .eq("hr_id", employeeHrId)
    .maybeSingle();
  return normalizeAttendanceHrId((data as { manager_hr_id: string | null } | null)?.manager_hr_id);
}

function dedupe(ids: Array<string | null>): string[] {
  return Array.from(new Set(ids.filter((id): id is string => Boolean(id))));
}

/**
 * Who reviews a dispute for this employee: the configured approvers, minus the
 * employee themselves (self-review exclusion). If that empties the list (e.g.
 * a lone approver disputing their own record), the CEO is the fallback so the
 * dispute is never stuck with nobody able to review it.
 */
export async function resolveDisputeReviewers(
  employeeHrId: string,
  settings: DigestSettings,
): Promise<string[]> {
  const subject = normalizeAttendanceHrId(employeeHrId);
  const reviewers = settings.approverHrIds.filter((id) => id !== subject);
  if (reviewers.length > 0) return reviewers;
  return ceoHrIds();
}

/** Cc list for a dispute notification: the employee's manager and/or the CEO, per settings. */
export async function resolveDisputeCc(employeeHrId: string, settings: DigestSettings): Promise<string[]> {
  const subject = normalizeAttendanceHrId(employeeHrId);
  const cc: string[] = [];
  if (settings.ccManager) {
    const manager = await managerHrId(subject ?? employeeHrId);
    if (manager) cc.push(manager);
  }
  if (settings.ccCeo) cc.push(...(await ceoHrIds()));
  return dedupe(cc).filter((id) => id !== subject);
}

/** Recipient (manager) + cc (HR + CEO) for a Tier-2 plan/punch mismatch flag. */
export async function resolveFlagRecipients(
  employeeHrId: string,
  settings: DigestSettings,
): Promise<{ primary: string[]; cc: string[] }> {
  const subject = normalizeAttendanceHrId(employeeHrId);
  const manager = await managerHrId(subject ?? employeeHrId);
  const cc = dedupe([...settings.approverHrIds, ...(await ceoHrIds())]).filter((id) => id !== subject);
  return { cc, primary: dedupe([manager]).filter((id) => id !== subject) };
}
