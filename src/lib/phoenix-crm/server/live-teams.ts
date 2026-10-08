/**
 * Phoenix CRM — the live teams, read from the Super Admin's Start control (owner, 2026-10-08).
 * The rule is `live-team-rules.ts`; this is its one database read.
 *
 * 🔴 A FAILED READ IS `null`, NOT AN EMPTY SET, AND `null` FAILS OPEN. An empty set would silence every
 * team in the company on a database hiccup — a manager's approval notice lost for a team that IS live —
 * while the thing this gate prevents (a notice to a team that has not started) is the milder failure.
 * The read is logged, so a gate that cannot see the starts is never silent about it.
 */

import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { logError } from "@/lib/observability/log";
import { liveTeamSeatIds } from "@/lib/phoenix-crm/live-team-rules";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const TEAM_STARTS_TABLE = "phoenix_crm_team_starts";

export async function loadLiveTeamSeatIds(cairoToday: string = currentCairoDateOnlyIso()): Promise<Set<string> | null> {
  try {
    const { data, error } = await getSupabaseAdmin().from(TEAM_STARTS_TABLE).select("team_seat_id, stops_on");
    if (error) throw error;
    return liveTeamSeatIds(
      ((data ?? []) as Array<{ team_seat_id?: string | null; stops_on?: string | null }>)
        .filter((row) => typeof row.team_seat_id === "string" && row.team_seat_id.length > 0)
        .map((row) => ({
          teamSeatId: row.team_seat_id as string,
          stopsOn: typeof row.stops_on === "string" ? row.stops_on.slice(0, 10) : null,
        })),
      cairoToday,
    );
  } catch (error) {
    logError("Phoenix CRM live teams could not be read", { error, labels: { event: "phoenix_crm_live_teams_unreadable" } });
    return null;
  }
}
