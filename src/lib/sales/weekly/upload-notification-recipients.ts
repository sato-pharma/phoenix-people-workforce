// Who is told that a weekly sales file carrying THEIR line's products has been uploaded
// (owner request, 2026-09-09: "an email fires to the district managers and the national sales
// managers that their products are read from the uploaded sheet").
//
// TO  — every currently active District Manager (including an acting DM) seated on that line, from
//       the live organogram (au_v_org_tree). A vacant seat or an inactive employee is skipped
//       silently, never sent to and never rendered as a blank row.
// CC  — that line's own National Sales Manager and, since 2026-10-20, its Regional Sales Manager,
//       resolved the same way (owner, 2026-10-20, asked who receives it and answering "Add him in
//       cc": the Regional Sales Manager was the one field manager the upload told nothing).
//
// Nobody's address is baked in here. Everything resolves live against the organogram and the HR
// record, so a seat change or a leaver updates the audience with no code change. The one exception
// is the shared sales exclusion list (sales-notification-exclusions.ts): people the owner has asked
// not to be mailed about sales while they are away, whatever their seat and status say.
//
// WHY THIS STILL DOES NOT SHARE ITS RECIPIENT LOGIC WITH closing-publish-recipients.ts
// That module answers a DIFFERENT question: it also resolves a fixed Cc roster (CEO, Marketing
// Manager, SFE Manager), two owner-NAMED individuals and a Bcc — every one an owner decision
// attached to the monthly closing announcement, not to a weekly file landing. Folding the two
// together would mean either exporting those decisions into an audience the owner never asked for
// them in, or parameterising a live email path whose recipient list is itself an owner ruling.
//
// The EXCLUSION list is the one thing genuinely shared, and it is shared, because it is a decision
// about a PERSON rather than about an email: the owner made it for the closing on 2026-08-08 and
// extended it here on 2026-09-09. Two copies of that would drift, and the stale copy would keep
// mailing somebody he asked to leave alone.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { isSalesNotificationExcluded } from "@/lib/sales/sales-notification-exclusions";
import { resolveTargetLineCode } from "@/lib/sales/monthly-targets";

export type WeeklyUploadRecipient = { hrId: string; name: string; email: string };

export type WeeklyUploadLineRecipients = {
  to: WeeklyUploadRecipient[];
  cc: WeeklyUploadRecipient[];
  /** Human-readable notes on anything skipped (vacant seat, inactive employee, missing email). */
  warnings: string[];
};

/** Seat tiers that count as "District Manager" for this send — an acting DM is a DM here. */
const DM_SEAT_TIERS = new Set(["DM", "ACTING_DM"]);
const NSM_SEAT_TIER = "NSM";
const RSM_SEAT_TIER = "RSM";

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

function toRecipient(row: EmployeeRow): WeeklyUploadRecipient {
  return { hrId: row.hr_id, name: row.full_name, email: String(row.work_email).trim() };
}

/**
 * Resolve who is told that `officialLine` appeared in an uploaded weekly sheet, live against
 * today's organogram and HR data.
 *
 * Never throws. A recipient-resolution outage must not be able to fail an upload that already
 * persisted its rows, so every failure path returns empty lists plus a warning and lets the caller
 * decide that an empty `to` means "send nothing".
 */
export async function resolveWeeklyUploadLineRecipients(officialLine: string): Promise<WeeklyUploadLineRecipients> {
  const warnings: string[] = [];
  const line = String(officialLine ?? "").trim();
  if (!line) return { to: [], cc: [], warnings: ["No line given."] };

  const lineCode = resolveTargetLineCode(line);
  if (!lineCode) {
    return { to: [], cc: [], warnings: [`"${line}" has no organogram line code — no manager resolved for it.`] };
  }

  const supabase = getSupabaseAdmin();
  try {
    const seatResult = await supabase
      .from("au_v_org_tree")
      .select("seat_tier,line_code,occupant_hr_id")
      .eq("line_code", lineCode);
    if (seatResult.error) throw seatResult.error;

    const seatRows = (seatResult.data ?? []) as Array<{ seat_tier: string | null; occupant_hr_id: string | null }>;
    // Applied to the seat list rather than per bucket, so the shared sales exclusion covers the NSM
    // exactly as it covers a District Manager — one filter, no bucket that can be forgotten.
    const occupantsOfTier = (matches: (tier: string) => boolean) =>
      seatRows
        .filter((row) => matches(String(row.seat_tier ?? "").trim().toUpperCase()))
        .map((row) => String(row.occupant_hr_id ?? "").trim())
        .filter(Boolean)
        .filter((hrId) => !isSalesNotificationExcluded(hrId));

    const dmHrIds = occupantsOfTier((tier) => DM_SEAT_TIERS.has(tier));
    const nsmHrIds = occupantsOfTier((tier) => tier === NSM_SEAT_TIER);
    const rsmHrIds = occupantsOfTier((tier) => tier === RSM_SEAT_TIER);

    const allHrIds = [...new Set([...dmHrIds, ...nsmHrIds, ...rsmHrIds])];
    if (allHrIds.length === 0) {
      return { to: [], cc: [], warnings: [`No occupied District Manager or NSM seat on ${line} — check the organogram.`] };
    }

    // HR ids are stored in mixed case across tables, so a straight equality match silently
    // under-returns. Widen the lookup to every casing variant, then index the answers by their
    // canonical key so the two sides meet regardless of how either was written.
    const lookupKeys = [...new Set(allHrIds.flatMap((hrId) => hrIdLookupKeys(hrId)))];
    const employeeResult = await supabase
      .from("employees")
      .select("hr_id,full_name,work_email,employment_status")
      .in("hr_id", lookupKeys);
    if (employeeResult.error) throw employeeResult.error;

    const employeeByKey = new Map<string, EmployeeRow>();
    for (const row of (employeeResult.data ?? []) as EmployeeRow[]) {
      const key = canonicalHrIdKey(row.hr_id);
      if (key) employeeByKey.set(key, row);
    }

    const collect = (hrIds: string[], context: string, alreadySeen: Set<string>) => {
      const bucket: WeeklyUploadRecipient[] = [];
      for (const hrId of hrIds) {
        const key = canonicalHrIdKey(hrId);
        // One person can hold two seats on a line — send to them once, not twice.
        if (!key || alreadySeen.has(key)) continue;
        const employee = employeeByKey.get(key);
        if (!isActiveEmployee(employee, warnings, context)) continue;
        alreadySeen.add(key);
        bucket.push(toRecipient(employee));
      }
      return bucket;
    };

    const seen = new Set<string>();
    const to = collect(dmHrIds, `${line} District Manager`, seen);
    const cc = [
      ...collect(nsmHrIds, `${line} National Sales Manager`, seen),
      ...collect(rsmHrIds, `${line} Regional Sales Manager`, seen),
    ];

    if (to.length === 0 && cc.length === 0) {
      warnings.push(`No active District Manager or NSM resolved for ${line} — nothing sent.`);
    }

    return { to, cc, warnings };
  } catch (error) {
    warnings.push(
      `Weekly-upload recipient resolution failed for ${line}: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return { to: [], cc: [], warnings };
  }
}
