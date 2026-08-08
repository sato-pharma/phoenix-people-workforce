// Recipients for the "Monthly Closing published" email (owner decision, 2026-08-08).
//
// Everything here resolves LIVE against the organogram/HR data — nobody's address is baked in as
// a literal string except the two owner-NAMED individuals below, which are deliberate: they are
// not tied to a role, so there is no seat/role lookup that could ever resolve them.
//
// TO   — every currently active District Manager (including an acting DM) seated on the
//        published line, from the live organogram (au_v_org_tree). A vacant seat or an inactive
//        employee is silently skipped, never sent to and never a blank/broken row.
// CC   — CEO, Marketing Manager, SFE Manager (each a company-wide singleton role — resolved by
//        role, so a personnel change updates the recipient automatically), the published line's
//        own National Sales Manager and Product/Group Product Manager, and Ahmed Sharaf (named
//        explicitly by the owner — not the line's own PM on every line, see resolveClosingPublishRecipients).
// BCC  — Omar Anwar (Super Admin), named explicitly by the owner.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { resolveTargetLineCode } from "@/lib/sales/monthly-targets";

export type ClosingPublishRecipient = { hrId: string; name: string; email: string };

export type ClosingPublishRecipients = {
  to: ClosingPublishRecipient[];
  cc: ClosingPublishRecipient[];
  bcc: ClosingPublishRecipient[];
  /** Human-readable notes on anything skipped (vacant seat, inactive employee, missing email). */
  warnings: string[];
};

/** Named by the owner, not by role — CC'd on every line's publish regardless of seat. */
const NAMED_CC_HR_IDS = ["B-155"] as const; // Ahmed Sharaf
/** Named by the owner — BCC'd on every line's publish. */
const NAMED_BCC_HR_IDS = ["B-10"] as const; // Omar Anwar (Super Admin)

const FIXED_CC_ROLES = ["CEO", "Marketing Manager", "SFE Manager"] as const;
const LINE_PRODUCT_MANAGER_ROLES = ["Product Manager", "Group Product Manager"] as const;
const DM_SEAT_TIERS = new Set(["DM", "ACTING_DM"]);

/**
 * Skip this recipient regardless of employment_status — owner decision, 2026-08-08. NOT an
 * employment-status change: her seat, HR record and vacancy stay untouched, she's simply on long
 * vacation and expected back. Remove her HR_ID here once she returns.
 */
const MANUALLY_EXCLUDED_HR_IDS = new Set(["B-156"]); // Sara Samir Jacoub Yohana — long vacation, expected back

type EmployeeRow = { hr_id: string; full_name: string; work_email: string | null; employment_status: string | null };

function isActiveEmployee(row: EmployeeRow | undefined, warnings: string[], context: string): row is EmployeeRow {
  if (!row) return false;
  if (String(row.employment_status ?? "").trim().toLowerCase() !== "active") {
    warnings.push(`${context}: ${row.full_name} (${row.hr_id}) is not active — skipped.`);
    return false;
  }
  if (!String(row.work_email ?? "").trim()) {
    warnings.push(`${context}: ${row.full_name} (${row.hr_id}) has no work email on file — skipped.`);
    return false;
  }
  return true;
}

function toRecipient(row: EmployeeRow): ClosingPublishRecipient {
  return { hrId: row.hr_id, name: row.full_name, email: String(row.work_email).trim() };
}

/**
 * Resolve who gets notified when `officialLine` (e.g. "Anti Infective") is published, live against
 * today's organogram and HR data. Returns empty arrays (never throws) when a lookup fails, so a
 * publish action can never be blocked by a notification-recipient outage — the caller decides
 * whether an empty `to` means "skip the send".
 */
export async function resolveClosingPublishRecipients(officialLine: string): Promise<ClosingPublishRecipients> {
  const warnings: string[] = [];
  const line = String(officialLine ?? "").trim();
  if (!line) return { to: [], cc: [], bcc: [], warnings: ["No line given."] };

  const supabase = getSupabaseAdmin();
  const lineCode = resolveTargetLineCode(line);

  try {
    const [seatResult, fixedRoleResult, namedResult, pmResult] = await Promise.all([
      lineCode
        ? supabase.from("au_v_org_tree").select("seat_tier,line_code,occupant_hr_id").eq("line_code", lineCode)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
      supabase
        .from("app_auth_users")
        .select("hr_id,role")
        .eq("is_active", true)
        .in("role", [...FIXED_CC_ROLES]),
      supabase
        .from("employees")
        .select("hr_id,full_name,work_email,employment_status")
        .in("hr_id", [...NAMED_CC_HR_IDS, ...NAMED_BCC_HR_IDS]),
      supabase
        .from("app_auth_users")
        .select("hr_id,role")
        .eq("is_active", true)
        .in("role", [...LINE_PRODUCT_MANAGER_ROLES])
        .ilike("line", line),
    ]);
    if (seatResult.error) throw seatResult.error;
    if (fixedRoleResult.error) throw fixedRoleResult.error;
    if (namedResult.error) throw namedResult.error;
    if (pmResult.error) throw pmResult.error;

    if (!lineCode) {
      warnings.push(`"${line}" has no organogram line code — no District Managers or NSM resolved for it.`);
    }

    // Every HR_ID this send could possibly need, fetched once. MANUALLY_EXCLUDED_HR_IDS is filtered
    // out right here so it applies uniformly to every bucket, not just District Managers.
    const notManuallyExcluded = (hrId: string) => !MANUALLY_EXCLUDED_HR_IDS.has(hrId);
    const seatRows = (seatResult.data ?? []) as Array<{ seat_tier: string | null; occupant_hr_id: string | null }>;
    const dmHrIds = seatRows
      .filter((row) => DM_SEAT_TIERS.has(String(row.seat_tier ?? "").trim().toUpperCase()))
      .map((row) => String(row.occupant_hr_id ?? "").trim())
      .filter(Boolean)
      .filter(notManuallyExcluded);
    const nsmHrIds = seatRows
      .filter((row) => String(row.seat_tier ?? "").trim().toUpperCase() === "NSM")
      .map((row) => String(row.occupant_hr_id ?? "").trim())
      .filter(Boolean)
      .filter(notManuallyExcluded);
    const fixedRoleHrIds = ((fixedRoleResult.data ?? []) as Array<{ hr_id: string | null }>)
      .map((row) => String(row.hr_id ?? "").trim())
      .filter(Boolean)
      .filter(notManuallyExcluded);
    const pmHrIds = ((pmResult.data ?? []) as Array<{ hr_id: string | null }>)
      .map((row) => String(row.hr_id ?? "").trim())
      .filter(Boolean)
      .filter(notManuallyExcluded);

    const allHrIds = [...new Set([...dmHrIds, ...nsmHrIds, ...fixedRoleHrIds, ...pmHrIds])];
    const employeeResult = allHrIds.length > 0
      ? await supabase.from("employees").select("hr_id,full_name,work_email,employment_status").in("hr_id", allHrIds)
      : { data: [] as EmployeeRow[], error: null };
    if (employeeResult.error) throw employeeResult.error;

    const employeeByHrId = new Map<string, EmployeeRow>();
    for (const row of (employeeResult.data ?? []) as EmployeeRow[]) employeeByHrId.set(row.hr_id, row);
    for (const row of (namedResult.data ?? []) as EmployeeRow[]) employeeByHrId.set(row.hr_id, row);

    const to: ClosingPublishRecipient[] = [];
    const seenTo = new Set<string>();
    for (const hrId of dmHrIds) {
      if (seenTo.has(hrId)) continue; // two seats occupied by the same person (rare) — one row
      const employee = employeeByHrId.get(hrId);
      if (!isActiveEmployee(employee, warnings, `${line} District Manager`)) continue;
      seenTo.add(hrId);
      to.push(toRecipient(employee));
    }
    if (to.length === 0) warnings.push(`No active District Manager resolved for ${line} — check the organogram.`);

    const cc: ClosingPublishRecipient[] = [];
    const seenCc = new Set<string>(seenTo);
    const addCc = (hrId: string, context: string) => {
      if (seenCc.has(hrId)) return;
      const employee = employeeByHrId.get(hrId);
      if (!isActiveEmployee(employee, warnings, context)) return;
      seenCc.add(hrId);
      cc.push(toRecipient(employee));
    };
    for (const hrId of fixedRoleHrIds) addCc(hrId, "Fixed Cc role");
    for (const hrId of nsmHrIds) addCc(hrId, `${line} NSM`);
    for (const hrId of pmHrIds) addCc(hrId, `${line} Product Manager`);
    for (const hrId of NAMED_CC_HR_IDS) addCc(hrId, "Named Cc");

    const bcc: ClosingPublishRecipient[] = [];
    for (const hrId of NAMED_BCC_HR_IDS) {
      if (seenCc.has(hrId) || seenTo.has(hrId)) continue;
      const employee = employeeByHrId.get(hrId);
      if (!isActiveEmployee(employee, warnings, "Named Bcc")) continue;
      bcc.push(toRecipient(employee));
    }

    return { to, cc, bcc, warnings };
  } catch (error) {
    warnings.push(
      `Closing-publish recipient resolution failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return { to: [], cc: [], bcc: [], warnings };
  }
}
