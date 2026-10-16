/**
 * Phoenix CRM — the live teams, read from the Super Admin's Start control (owner, 2026-10-08).
 * The rule is `live-team-rules.ts`; this is its one database read.
 *
 * 🔴 A FAILED READ IS `null`, NOT AN EMPTY SET, AND `null` FAILS OPEN. An empty set would silence every
 * team in the company on a database hiccup — a manager's approval notice lost for a team that IS live —
 * while the thing this gate prevents (a notice to a team that has not started) is the milder failure.
 * The read is logged, so a gate that cannot see the starts is never silent about it.
 */

import { bumpSharedReadGeneration, getOrLoadShared } from "@/lib/cache/shared-read";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { logError } from "@/lib/observability/log";
import { liveTeamSeatIds } from "@/lib/phoenix-crm/live-team-rules";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const TEAM_STARTS_TABLE = "phoenix_crm_team_starts";

type StartRow = { team_seat_id?: string | null; stops_on?: string | null };

async function readStartRows(): Promise<StartRow[]> {
  const { data, error } = await getSupabaseAdmin().from(TEAM_STARTS_TABLE).select("team_seat_id, stops_on");
  if (error) throw error;
  return (data ?? []) as StartRow[];
}

function liveFromRows(rows: readonly StartRow[], cairoToday: string): Set<string> {
  return liveTeamSeatIds(
    rows
      .filter((row) => typeof row.team_seat_id === "string" && row.team_seat_id.length > 0)
      .map((row) => ({
        teamSeatId: row.team_seat_id as string,
        stopsOn: typeof row.stops_on === "string" ? row.stops_on.slice(0, 10) : null,
      })),
    cairoToday,
  );
}

/** The gate every SENDER asks — read fresh on every call, because it decides whether anybody is told. */
export async function loadLiveTeamSeatIds(cairoToday: string = currentCairoDateOnlyIso()): Promise<Set<string> | null> {
  try {
    return liveFromRows(await readStartRows(), cairoToday);
  } catch (error) {
    logError("Phoenix CRM live teams could not be read", { error, labels: { event: "phoenix_crm_live_teams_unreadable" } });
    return null;
  }
}

const LIVE_TEAMS_FOR_DISPLAY = "phoenix_crm_team_starts";

/**
 * The same gate for a DISPLAY that only filters what is already written — the pulsing badges, which
 * every open Phoenix CRM screen asks for each minute. A handful of rows that change only when the Super
 * Admin presses Start or Stop, so they are served from memory for up to a minute and dropped at once by
 * that press (`forgetLiveTeamsForDisplay`, called by the one writer). Never for a sender: whether a
 * notice goes out is decided by `loadLiveTeamSeatIds` above, fresh every time.
 */
export async function loadLiveTeamSeatIdsForDisplay(cairoToday: string = currentCairoDateOnlyIso()): Promise<Set<string> | null> {
  try {
    const { rows } = await getOrLoadShared(LIVE_TEAMS_FOR_DISPLAY, "all", readStartRows, { maxEntries: 1, maxRowsTotal: 5_000 });
    return liveFromRows(rows ?? [], cairoToday);
  } catch (error) {
    logError("Phoenix CRM live teams could not be read", { error, labels: { event: "phoenix_crm_live_teams_unreadable" } });
    return null;
  }
}

/** A team was started or stopped: the next badge read sees it at once. */
export function forgetLiveTeamsForDisplay(): void {
  bumpSharedReadGeneration(LIVE_TEAMS_FOR_DISPLAY, "phoenix_crm_team_start_changed");
}
