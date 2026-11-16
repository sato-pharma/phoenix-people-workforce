/**
 * Phoenix CRM — who the Super Admins are, for the rule that what they approved only they reject
 * (owner, 2026-11-16; `super-admin-approval-rules.ts`).
 *
 * Asked of the database itself (`phoenix_crm_super_admin_hr_ids`, built on the guard's own
 * `phoenix_crm_is_super_admin`), so the screen and the guard can never disagree about who counts: an active,
 * non-test login whose role is Super Admin. A test account never counts, so a test approval never locks anything.
 *
 * 🔴 A FAILED READ THROWS, IT NEVER ANSWERS AN EMPTY SET. An empty set would draw the SFE Manager a Reject
 * button on every one of the administrator's approvals; the database would still refuse the press, but the
 * screen would be offering something that cannot work.
 */

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { approvalLockedFor, hrIdKey } from "@/lib/phoenix-crm/super-admin-approval-rules";
import type { PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";

export async function loadSuperAdminHrIds(): Promise<Set<string>> {
  const { data, error } = await getSupabaseAdmin().rpc("phoenix_crm_super_admin_hr_ids");
  if (error) throw error;
  const ids = new Set<string>();
  for (const value of (Array.isArray(data) ? data : []) as unknown[]) {
    const key = hrIdKey(typeof value === "string" ? value : null);
    if (key) ids.add(key);
  }
  return ids;
}

/**
 * A lock check bound to one viewer and one read of the Super Admins. A Super Admin viewer never reads the
 * table at all — nothing is ever locked for him.
 */
export async function approvalLockFor(viewer: PhoenixCrmViewer): Promise<(approvedBy: unknown, placeCreatedBy?: unknown) => boolean> {
  if (viewer.isSuperAdmin) return () => false;
  const superAdmins = await loadSuperAdminHrIds();
  return (approvedBy, placeCreatedBy) =>
    approvalLockedFor({
      viewerIsSuperAdmin: false,
      approvedBy: typeof approvedBy === "string" ? approvedBy : null,
      placeCreatedBy: typeof placeCreatedBy === "string" ? placeCreatedBy : null,
      superAdmins,
    });
}
