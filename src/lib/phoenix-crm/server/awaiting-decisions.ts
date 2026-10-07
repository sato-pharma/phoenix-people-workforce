/**
 * Phoenix CRM — which off-plan visits, and which SENT WEEKS, are still waiting on THIS viewer's own
 * decision.
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
 *
 * 🔴 THE WEEKLY PLAN NOTICE NEEDED THIS MORE THAN THE VISIT DOES, AND NEVER HAD IT (owner,
 * 2026-10-07). "Weekly plan to review from <rep>" is the notice this module sends most — thirteen in
 * one evening — and nothing ever withdrew one, so a manager's bell kept every week he had already
 * decided. Measured on production that night: all four of one district manager's plan notices were
 * dead, two of them the SAME rep for the SAME week (the first send, and the re-send after his own
 * return), with identical titles and identical wording. He opens one, lands on a week that reads
 * "Returned for changes" or "Approved", and there is nothing on it to decide — which is what "it
 * comes back to the manager with no option to approve" actually was. The cycle itself was sound.
 */

import type { AccessContext } from "@/lib/auth/permissions";
import { canDecideUnplannedVisit, canReviewTerritory, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { chunk, throwIfError } from "@/lib/phoenix-crm/server/db";
import { unplannedVisitStageOf, type UnplannedVisitStatus } from "@/lib/phoenix-crm/unplanned-rules";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type WaitingRow = { visit_id?: unknown; seat_id?: unknown; status?: unknown; is_test?: unknown };

type WaitingPlanRow = { id?: unknown; seat_id?: unknown; is_test?: unknown };

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

/**
 * The SENT weeks this viewer could approve right now, by plan id.
 *
 * `submitted` is the whole test, exactly as `canApprove` reads it on every screen
 * (server/plans.ts, server/monthly-plans.ts) — never a second copy of the rule. A week he
 * approved, a week he returned, and a week the rep has taken back into draft all drop out of this
 * set, so his notice about that week is withdrawn; the NEXT send writes its own notice, with its own
 * version in the idempotency key, and that one stands until it is decided in turn.
 *
 * 🔴 IT IS "STILL HIS", NOT "STILL OPEN", like its sibling above. The SFE Manager can RETURN a sent
 * week but can never approve one, and `plan_waiting` is addressed to the territory's reviewer alone
 * — so the one authority that could clear it is the one this asks about. A week whose own week has
 * passed is deliberately still his: `canApprove` carries no open-week test, because a plan sent late
 * is still decided.
 *
 * PAGED, because this grows with the field: a seat per week per month (`fetchAllRowsKeyset`).
 */
export async function phoenixCrmPlanIdsAwaitingDecision(access: AccessContext): Promise<Set<string>> {
  const viewer = await resolvePhoenixCrmViewer(access);
  const seatIds = viewer.scopeTerritories.map((seat) => seat.seatId);
  const awaiting = new Set<string>();
  if (seatIds.length === 0) return awaiting;

  const rows: WaitingPlanRow[] = [];
  for (const batch of chunk([...seatIds])) {
    rows.push(
      ...(await fetchAllRowsKeyset<WaitingPlanRow>(
        () => getSupabaseAdmin().from("phoenix_crm_plans").select("id,seat_id,is_test").in("seat_id", batch).eq("status", "submitted"),
        { cursorColumn: "id", cursorOf: (row) => String(row.id ?? "") },
      )),
    );
  }

  for (const row of rows) {
    const seat = viewer.org.seats.get(String(row.seat_id ?? ""));
    if (!seat) continue;
    if (canReviewTerritory(viewer, seat, row.is_test === true)) awaiting.add(String(row.id ?? ""));
  }

  return awaiting;
}
