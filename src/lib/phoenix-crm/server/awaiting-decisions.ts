/**
 * Phoenix CRM — which off-plan visits are still waiting on THIS viewer's own decision.
 *
 * Read by the bell (`archiveStaleApprovalNotifications` in src/lib/notifications/in-app.ts) to clear
 * an "Off-plan visit to approve" notice once it is no longer his to act on — he approved it, he
 * refused it, it moved on to SFE, or the visit was removed. Vacation, excuse and weekly plans have
 * had that for a while; this is Phoenix CRM's answer to the same question (owner, 2026-10-02:
 * "clear the manager's off-plan notice when he approves it too").
 *
 * 🔴 IT LIVES HERE, NOT IN `unplanned.ts`, TO KEEP THE IMPORTS ACYCLIC. `unplanned.ts` imports
 * `server/notifications.ts`, which imports the bell — so a loader placed there would close the ring
 * in-app.ts → unplanned.ts → notifications.ts → in-app.ts, and a cycle makes whichever module
 * initialises second see the other's exports as undefined. This file imports only `access`, `db` and
 * the pure rules, so nothing points back at the bell.
 *
 * 🔴 IT ANSWERS "STILL HIS", NEVER "STILL OPEN". Those differ at the SFE stage: the visit is still
 * waiting, but not on him, and his notice has done its job. `canDecideUnplannedVisit` is the one
 * rule that decides it, so the bell and the Team tab can never disagree about whose turn it is.
 *
 * BOTH TEST WORLDS are read and unioned on purpose. A notice that is still actionable in either one
 * is kept — the safe direction for a mechanism whose failure mode is hiding a real to-do.
 */

import type { AccessContext } from "@/lib/auth/permissions";
import { canDecideUnplannedVisit, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { chunk, throwIfError } from "@/lib/phoenix-crm/server/db";
import { unplannedVisitStageOf, type UnplannedVisitStatus } from "@/lib/phoenix-crm/unplanned-rules";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type WaitingRow = { visit_id?: unknown; seat_id?: unknown; status?: unknown; is_test?: unknown };

/** The off-plan visits this viewer could decide right now, by visit id. */
export async function phoenixCrmVisitIdsAwaitingDecision(access: AccessContext): Promise<Set<string>> {
  const viewer = await resolvePhoenixCrmViewer(access);
  const seatIds = viewer.scopeTerritories.map((seat) => seat.seatId);
  const awaiting = new Set<string>();
  if (seatIds.length === 0) return awaiting;

  const rows: WaitingRow[] = [];
  for (const batch of chunk([...seatIds])) {
    const { data, error } = await getSupabaseAdmin()
      .from("phoenix_crm_unplanned_visits")
      .select("visit_id,seat_id,status,is_test")
      .in("seat_id", batch)
      .in("status", ["manager_pending", "sfe_pending"]);
    throwIfError(error);
    rows.push(...((data ?? []) as WaitingRow[]));
  }

  for (const row of rows) {
    const seat = viewer.org.seats.get(String(row.seat_id ?? ""));
    const stage = unplannedVisitStageOf(String(row.status ?? "") as UnplannedVisitStatus);
    if (!seat || stage === null) continue;
    if (canDecideUnplannedVisit(viewer, seat, row.is_test === true, stage)) awaiting.add(String(row.visit_id ?? ""));
  }

  return awaiting;
}
