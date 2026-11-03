// Recipients for the "Monthly Closing published" email (owner decision, 2026-08-08).
//
// Everything here resolves LIVE against the organogram/HR data — nobody's address is baked in as
// a literal string except the two owner-NAMED individuals below, which are deliberate: they are
// not tied to a role, so there is no seat/role lookup that could ever resolve them.
//
// TO   — EVERYONE seated on the published line below its National Sales Manager — District
//        Managers (acting included), regional managers and every rep — from the live organogram
//        (au_v_org_tree). Owner, 2026-10-10: "when I publish the closing the email and telegram and
//        in app goes to all in the published line". A vacant seat or an inactive employee is
//        silently skipped, never sent to and never a blank/broken row.
// TEAM — the same people plus the line's NSM and Product/Group Product Manager: the audience of the
//        in-app notice and the Telegram message, which are per person and need no email address.
// CC   — CEO, Marketing Manager, SFE Manager (each a company-wide singleton role — resolved by
//        role, so a personnel change updates the recipient automatically), the published line's
//        own National Sales Manager and Product/Group Product Manager, and Ahmed Sharaf (named
//        explicitly by the owner — not the line's own PM on every line, see
//        resolveClosingPublishRecipients).
// BCC  — Omar Anwar (Super Admin), named explicitly by the owner.

import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isSalesNotificationExcluded } from "@/lib/sales/sales-notification-exclusions";
import { resolveTargetLineCode } from "@/lib/sales/monthly-targets";
import type { PhoenixRole } from "@/lib/auth/permissions";

export type ClosingPublishRecipient = { hrId: string; name: string; email: string };

export type ClosingPublishRecipients = {
  /** Everyone seated on the line below its NSM, with an active work email. */
  to: ClosingPublishRecipient[];
  /** Everyone on the line (To + NSM + the line's own PM), active — by HR_ID, for in-app and Telegram. */
  team: Array<{ hrId: string; name: string }>;
  cc: ClosingPublishRecipient[];
  bcc: ClosingPublishRecipient[];
  /** Human-readable notes on anything skipped (vacant seat, inactive employee, missing email). */
  warnings: string[];
};

/** Named by the owner, not by role — CC'd on every line's publish regardless of seat. */
const NAMED_CC_HR_IDS = ["B-155"] as const; // Ahmed Sharaf
/** Named by the owner — BCC'd on every line's publish. */
const NAMED_BCC_HR_IDS = ["B-10"] as const; // Omar Anwar (Super Admin)

/**
 * The company-wide singleton roles Cc'd on every line's publish. Deliberately not a distribution
 * list: owner 2026-09-11, the lists belong to the Sato Email Composer and nothing else.
 */
const FIXED_CC_ROLES: readonly PhoenixRole[] = ["CEO", "Marketing Manager", "SFE Manager"];
const LINE_PRODUCT_MANAGER_ROLES = ["Product Manager", "Group Product Manager"] as const;

// Who is skipped regardless of employment_status now lives in sales-notification-exclusions.ts,
// shared with the weekly upload notification, because the owner extended the same decision about
// the same person to that email on 2026-09-09. Behaviour here is unchanged except that the match is
// now case-insensitive on the canonical HR_ID, which is strictly safer: the literal Set.has this
// replaced would have stopped excluding her the moment a seat row returned "b-156".

type EmployeeRow = {
  hr_id: string;
  full_name: string;
  nickname: string | null;
  work_email: string | null;
  employment_status: string | null;
};

/** The name only. Who receives the notice is decided by the seat and the role, never by this. */
function shownName(row: EmployeeRow): string {
  return resolveEmployeeDisplayName(row.full_name, row.nickname, row.hr_id);
}

function isActiveEmployee(row: EmployeeRow | undefined, warnings: string[], context: string): row is EmployeeRow {
  if (!row) return false;
  if (String(row.employment_status ?? "").trim().toLowerCase() !== "active") {
    warnings.push(`${context}: ${shownName(row)} (${row.hr_id}) is not active — skipped.`);
    return false;
  }
  if (!String(row.work_email ?? "").trim()) {
    warnings.push(`${context}: ${shownName(row)} (${row.hr_id}) has no work email on file — skipped.`);
    return false;
  }
  return true;
}

function toRecipient(row: EmployeeRow): ClosingPublishRecipient {
  return { hrId: row.hr_id, name: shownName(row), email: String(row.work_email).trim() };
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
  if (!line) return { to: [], team: [], cc: [], bcc: [], warnings: ["No line given."] };

  const supabase = getSupabaseAdmin();
  const lineCode = resolveTargetLineCode(line);

  try {
    const [seatResult, fixedRoleResult, namedResult, pmResult] = await Promise.all([
      lineCode
        ? supabase.from("au_v_org_tree").select("seat_tier,line_code,occupant_hr_id").eq("line_code", lineCode)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
      supabase.from("app_auth_users").select("hr_id,role").eq("is_active", true).in("role", [...FIXED_CC_ROLES]),
      supabase
        .from("employees")
        .select("hr_id,full_name,nickname,work_email,employment_status")
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

    // Every HR_ID this send could possibly need, fetched once. The shared sales exclusion list is
    // filtered out right here so it applies uniformly to every bucket, not just District Managers.
    const notManuallyExcluded = (hrId: string) => !isSalesNotificationExcluded(hrId);
    const seatRows = (seatResult.data ?? []) as Array<{ seat_tier: string | null; occupant_hr_id: string | null }>;
    // Every seat on the line except the NSM (who is Cc'd, as before). A seat tier is never
    // whitelisted here: a new tier on the organogram (RSM, an acting seat) must reach the line
    // without anyone remembering to add it to a list.
    const lineMemberHrIds = seatRows
      .filter((row) => String(row.seat_tier ?? "").trim().toUpperCase() !== "NSM")
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

    const allHrIds = [...new Set([...lineMemberHrIds, ...nsmHrIds, ...fixedRoleHrIds, ...pmHrIds])];
    const employeeResult = allHrIds.length > 0
      ? await supabase.from("employees").select("hr_id,full_name,nickname,work_email,employment_status").in("hr_id", allHrIds)
      : { data: [] as EmployeeRow[], error: null };
    if (employeeResult.error) throw employeeResult.error;

    const employeeByHrId = new Map<string, EmployeeRow>();
    for (const row of (employeeResult.data ?? []) as EmployeeRow[]) employeeByHrId.set(row.hr_id, row);
    for (const row of (namedResult.data ?? []) as EmployeeRow[]) employeeByHrId.set(row.hr_id, row);

    const to: ClosingPublishRecipient[] = [];
    const seenTo = new Set<string>();
    // Active employees on the line whether or not they have an email: the in-app notice and the
    // Telegram message are addressed by HR_ID, so a rep with no work email is still told there.
    const team: Array<{ hrId: string; name: string }> = [];
    const seenTeam = new Set<string>();
    const addTeam = (hrId: string) => {
      if (seenTeam.has(hrId)) return;
      const employee = employeeByHrId.get(hrId);
      if (!employee || String(employee.employment_status ?? "").trim().toLowerCase() !== "active") return;
      seenTeam.add(hrId);
      team.push({ hrId: employee.hr_id, name: shownName(employee) });
    };
    for (const hrId of lineMemberHrIds) {
      addTeam(hrId);
      if (seenTo.has(hrId)) continue; // two seats occupied by the same person (rare) — one row
      const employee = employeeByHrId.get(hrId);
      if (!isActiveEmployee(employee, warnings, `${line} team member`)) continue;
      seenTo.add(hrId);
      to.push(toRecipient(employee));
    }
    for (const hrId of nsmHrIds) addTeam(hrId);
    for (const hrId of pmHrIds) addTeam(hrId);
    if (to.length === 0) warnings.push(`No active team member resolved for ${line} — check the organogram.`);

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

    return { to, team, cc, bcc, warnings };
  } catch (error) {
    warnings.push(
      `Closing-publish recipient resolution failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return { to: [], team: [], cc: [], bcc: [], warnings };
  }
}
