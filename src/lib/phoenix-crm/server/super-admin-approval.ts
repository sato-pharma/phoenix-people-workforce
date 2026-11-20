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
import { canonicalHrIdKey } from "@/lib/hr-id";
import { forbiddenError } from "@/lib/http/api-errors";
import {
  LIST_STANDING_EVENTS,
  PLACE_STANDING_EVENTS,
  SUPER_ADMIN_APPROVAL_IS_FINAL_TEXT,
  actedBySuperAdmin,
  approvalLockedFor,
} from "@/lib/phoenix-crm/super-admin-approval-rules";
import type { PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";

export async function loadSuperAdminHrIds(): Promise<Set<string>> {
  const { data, error } = await getSupabaseAdmin().rpc("phoenix_crm_super_admin_hr_ids");
  if (error) throw error;
  const ids = new Set<string>();
  for (const value of (Array.isArray(data) ? data : []) as unknown[]) {
    const key = canonicalHrIdKey(typeof value === "string" ? value : null);
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

// ── Nothing the Super Admin did is undone or contradicted below him (owner, 2026-11-20) ─────────────

/** The refusal every lock below throws: a 403 with the one plain sentence. */
export function superAdminDecisionStands(): Error {
  return forbiddenError(SUPER_ADMIN_APPROVAL_IS_FINAL_TEXT);
}

/**
 * Refuses the act when any of these people is a Super Admin and the viewer is not. The Super Admin himself
 * is never blocked, and his viewer never reads the table. A failed read of the Super Admins THROWS — the
 * act is refused as an error rather than let through on an empty set.
 */
export async function assertSuperAdminDecisionStands(viewerIsSuperAdmin: boolean, actors: ReadonlyArray<unknown>): Promise<void> {
  if (viewerIsSuperAdmin) return;
  if (!actors.some((actor) => typeof actor === "string" && actor.trim() !== "")) return;
  if (actedBySuperAdmin(actors, await loadSuperAdminHrIds())) throw superAdminDecisionStands();
}

/**
 * A place the Super Admin created (a trusted point, a seat he placed), photographed, or whose point he
 * last decided — added, moved, restored, seated, its validation approved — is his: nobody else moves it
 * or removes it. The newest standing event is read, so a place he decided long ago and somebody else
 * rightly moved since is judged on that later move.
 */
export async function assertPlaceIsNotSuperAdmins(viewer: PhoenixCrmViewer, placeId: string, isTest: boolean): Promise<void> {
  if (viewer.isSuperAdmin) return;
  const client = getSupabaseAdmin();
  const [place, latest] = await Promise.all([
    client.from("phoenix_crm_places").select("created_by_hr_id, admin_photo_by_hr_id").eq("id", placeId).eq("is_test", isTest).maybeSingle(),
    client
      .from("phoenix_crm_list_events")
      .select("actor_hr_id")
      .eq("place_id", placeId)
      .eq("is_test", isTest)
      .in("event_type", [...PLACE_STANDING_EVENTS])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (place.error) throw place.error;
  if (latest.error) throw latest.error;
  const row = (place.data ?? {}) as Record<string, unknown>;
  const last = (latest.data ?? {}) as Record<string, unknown>;
  await assertSuperAdminDecisionStands(false, [row.created_by_hr_id, row.admin_photo_by_hr_id, last.actor_hr_id]);
}

/**
 * Where a customer stands on a list — validated, kept, brought back, moved, dropped — is the Super Admin's
 * when the newest standing event about him is the Super Admin's: nobody else drops him, moves him to
 * another rep or brings him back from the Archive.
 */
export async function assertListStandingIsNotSuperAdmins(viewer: PhoenixCrmViewer, customerId: string, isTest: boolean): Promise<void> {
  if (viewer.isSuperAdmin) return;
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_list_events")
    .select("actor_hr_id")
    .eq("customer_id", customerId)
    .eq("is_test", isTest)
    .in("event_type", [...LIST_STANDING_EVENTS])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  await assertSuperAdminDecisionStands(false, [(data as Record<string, unknown> | null)?.actor_hr_id]);
}

/**
 * A week or a month the Super Admin approved — as the Administrator in the reviewer's place, or as himself —
 * is never returned by anybody else. A plan that is not approved, or that somebody else approved, is unchanged.
 */
export async function assertApprovedPlanStands(viewer: PhoenixCrmViewer, row: Record<string, unknown>): Promise<void> {
  if (viewer.isSuperAdmin || String(row.status ?? "") !== "approved") return;
  if (row.decided_by_role === "administrator") throw superAdminDecisionStands();
  await assertSuperAdminDecisionStands(false, [row.decided_by_hr_id]);
}
