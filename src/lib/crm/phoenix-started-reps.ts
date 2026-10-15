/**
 * WHO IS COUNTED FROM PHOENIX CRM TODAY — the one read of `phoenix_crm_started_team_reps()`.
 *
 * The rules live in src/lib/crm/phoenix-team-starts.ts, and the four unified views apply them in SQL, so
 * every reader that goes through the read door needs nothing from here. This file is for the readers that
 * CANNOT ask the views: one that calls the live iReports360 API (`rep-day.ts`), or one whose question is
 * about rows the views deliberately anti-join out (Early Birds' clock).
 *
 * It exists because that read was written three times over — in `early-birds/collect.ts`, in
 * `phoenix-vendor-leftovers.ts`, and nowhere at all in `rep-day.ts`, which is why `rep-day.ts` decided
 * live-vs-mirror on the global `crm_cutover` alone. A per-team start never sets that date, so a started
 * rep's recent day was fetched LIVE from the vendor, and a successful live call returning nothing was
 * served as the truth: measured on production 2026-10-04, 14 of Delta (1)'s 17 people had logged Phoenix
 * visits since their 3 October start and `crm_visits_unified` returns NO vendor row for any of the 17, so
 * B-158's 22 Phoenix calls read as an empty day on HR's field-workforce-compliance drill-down — the screen
 * whose recommendation feeds a payroll deduction. B-120 is the shape worth holding on to: 3 of his rows are
 * still in the raw mirror and the view hides them correctly, so a reader that goes AROUND the view answers
 * with the vendor's 3 instead of his 2 Phoenix visits — the wrong rows, not merely missing ones.
 *
 * AN UNREADABLE ANSWER IS NO STARTED TEAM. It fails OPEN, like `resolveVendorSyncStandDown` and unlike
 * `readCrmCutoverSetting` (cutover.ts): nothing here charges anybody, and the worst a missing start does
 * is leave a reader on the behaviour it had before starts existed. The view layer is the enforcement and
 * is unaffected either way, so a caller of this never becomes the only thing standing between a rep's
 * work and his figures.
 */

import { startedWindowCovers, type StartedRepWindow } from "@/lib/crm/phoenix-team-starts";
import { normalizeHrIdForAccess } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** The RPC the views and this read share — every person on a started team, with his own window. */
export const PHOENIX_CRM_STARTED_TEAM_REPS_RPC = "phoenix_crm_started_team_reps";

/**
 * The DOCTOR-LIST door, and only that: every started team's people PLUS every rep who holds a Phoenix
 * CRM list and has no iReports360 account at all, whose list nothing would otherwise write
 * (20261015215500, the owner's ruling of 2026-10-15). It is deliberately a SECOND function rather than
 * a widening of the one above: everything that counts WORK — the four unified views, field-work
 * compliance and its deduction recommendation, the KPI boards, Early Birds, `rep-day.ts` — keeps asking
 * `phoenix_crm_started_team_reps`, so a team's counting source still moves only on the owner's own
 * Start click. The two database readers of the list rule (`crm_contact_master_refresh`'s fifth pass and
 * `crm_contact_list_change_apply`) ask this same door in SQL.
 */
export const PHOENIX_CRM_DOCTOR_LIST_REPS_RPC = "phoenix_crm_doctor_list_reps";

/**
 * Every person's days within a started Phoenix CRM team's start. An unreadable answer — or the function
 * not there yet — reads as NO started team: the caller keeps the behaviour it had before starts existed.
 */
export async function loadStartedRepWindows(): Promise<StartedRepWindow[]> {
  return loadRepWindows(PHOENIX_CRM_STARTED_TEAM_REPS_RPC);
}

/**
 * Whose DOCTOR LIST is Phoenix's today — the started windows plus the vendor-less reps'. Only the
 * doctor-list surfaces may read this; a reader about visits, plans, attendance or money wants
 * {@link loadStartedRepWindows}. Fails the same way: an unreadable answer is no window at all.
 */
export async function loadDoctorListRepWindows(): Promise<StartedRepWindow[]> {
  return loadRepWindows(PHOENIX_CRM_DOCTOR_LIST_REPS_RPC);
}

async function loadRepWindows(rpc: string): Promise<StartedRepWindow[]> {
  try {
    const { data, error } = await getSupabaseAdmin().rpc(rpc);
    if (error) throw error;
    return ((data ?? []) as Array<Record<string, unknown>>).flatMap((row) => {
      const from = typeof row.counted_from === "string" ? row.counted_from.slice(0, 10) : null;
      if (!from) return [];
      const crmId = row.agent_crm_id === null || row.agent_crm_id === undefined ? null : Number(row.agent_crm_id);
      return [
        {
          hrIdKey: normalizeHrIdForAccess(typeof row.hr_id === "string" ? row.hr_id : null),
          agentCrmId: crmId !== null && Number.isFinite(crmId) ? crmId : null,
          from,
          until: typeof row.counted_until === "string" ? row.counted_until.slice(0, 10) : null,
        },
      ];
    });
  } catch (error) {
    logError("Could not read the started Phoenix CRM teams", {
      labels: { event: "phoenix_crm_started_teams_unreadable" },
      error,
    });
    return [];
  }
}

/**
 * Whether ONE person's ONE day is counted from Phoenix CRM — for a reader that needs the answer for a
 * single rep-day and would otherwise ask the vendor. Reads the windows, then applies the shared rule.
 */
export async function isStartedPhoenixRepDay(
  rep: { hrId: string | null | undefined; crmId: number | null | undefined },
  dateIso: string,
): Promise<boolean> {
  if (!dateIso) return false;
  return startedWindowCovers(await loadStartedRepWindows(), rep, dateIso);
}
