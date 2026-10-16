/**
 * The Super Admin's control of `phoenix_crm_team_starts` — which teams every other screen counts from
 * Phoenix CRM, from which Saturday, and the Start and Stop that change it (owner, 2026-10-02: "Only when I
 * start it"). The rules, the why and the wording are in src/lib/crm/phoenix-team-starts.ts; this file
 * reads the tables, the organogram and the names, and calls the ONE writer, `phoenix_crm_set_team_start`.
 */

import type { AccessContext } from "@/lib/auth/permissions";
import { bumpSharedReadGeneration } from "@/lib/cache/shared-read";
import { cairoTodayIso } from "@/lib/crm/dates";
import {
  buildPhoenixTeamRows,
  isSaturday,
  parsePhoenixTeamStart,
  PHOENIX_CRM_SET_TEAM_START_RPC,
  PHOENIX_CRM_TEAM_START_NOTICES_TABLE,
  PHOENIX_CRM_TEAM_STARTS_TABLE,
  teamStartRefusal,
  type PhoenixTeamFirstPlan,
  type PhoenixTeamStart,
  type PhoenixTeamStartsPanelData,
} from "@/lib/crm/phoenix-team-starts";
import { unreadableTeamReadiness } from "@/lib/crm/phoenix-team-readiness";
import { loadPhoenixTeamReadiness } from "@/lib/crm/phoenix-team-readiness-server";
import { loadVendorLeftoversBySeat, VENDOR_LEFTOVERS_CACHE } from "@/lib/crm/phoenix-vendor-leftovers";
import { logError } from "@/lib/observability/log";
import { forgetLiveTeamsForDisplay } from "@/lib/phoenix-crm/server/live-teams";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import type { VendorLeftoverRep } from "@/lib/phoenix-crm/vendor-leftovers";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** A missing relation, not a broken read: the migration has not been applied to this database yet. */
function isTableMissing(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "PGRST205" || error.code === "42P01") return true;
  const message = error.message ?? "";
  return /phoenix_crm_team_start/.test(message) && /does not exist|schema cache/i.test(message);
}

/**
 * SUPER ADMIN ONLY. The CRM hub is his alone, and a start or a stop changes what every screen counts
 * for a whole team, money-adjacent ones included. The route asks this AND `crm_visits:update` before it
 * writes; the matrix is the boundary, this the narrowing (the same two gates as Rep Doctor Lists).
 */
export function canSetPhoenixTeamStarts(access: Pick<AccessContext, "role" | "scope">): boolean {
  return access.role === "Super Admin" || access.scope === "system";
}

export function assertPhoenixTeamStartsAdmin(access: Pick<AccessContext, "role" | "scope">): void {
  if (!canSetPhoenixTeamStarts(access)) {
    throw new Error(`Forbidden: ${access.role} cannot start or stop a team.`);
  }
}

/** Every start, every notice and every team, for the panel. A missing table reads as "not set up"; any other failure throws. */
export async function loadPhoenixTeamStartsPanel(): Promise<PhoenixTeamStartsPanelData> {
  const cairoToday = cairoTodayIso();
  const supabase = getSupabaseAdmin();
  const [startsRead, noticesRead] = await Promise.all([
    supabase
      .from(PHOENIX_CRM_TEAM_STARTS_TABLE)
      .select("id, team_seat_id, starts_on, stops_on, started_by, started_by_hr_id, note")
      .order("starts_on", { ascending: true }),
    supabase.from(PHOENIX_CRM_TEAM_START_NOTICES_TABLE).select("team_seat_id, rep_hr_id, week_start"),
  ]);
  if (startsRead.error) {
    if (isTableMissing(startsRead.error)) {
      return { provisioned: false, cairoToday, teams: [], readiness: unreadableTeamReadiness(cairoToday) };
    }
    throw new Error(`The Phoenix CRM team starts could not be read: ${startsRead.error.message}`);
  }
  if (noticesRead.error && !isTableMissing(noticesRead.error)) {
    throw new Error(`The Phoenix CRM team notices could not be read: ${noticesRead.error.message}`);
  }
  const starts = ((startsRead.data ?? []) as Array<Record<string, unknown>>)
    .map((row) => parsePhoenixTeamStart(row))
    .filter((row): row is PhoenixTeamStart => row !== null);
  const notices = noticesRead.error ? [] : ((noticesRead.data ?? []) as Array<Record<string, unknown>>);

  const org = await loadPhoenixCrmOrg();
  const managerIds = [...new Set(org.territories.map((territory) => territory.parentSeatId).filter((id): id is string => Boolean(id)))]
    .map((seatId) => org.seats.get(seatId)?.occupantHrId ?? null);
  const names = await loadPeopleNames([
    ...managerIds,
    ...starts.map((start) => start.startedByHrId),
    ...notices.map((notice) => (typeof notice.rep_hr_id === "string" ? notice.rep_hr_id : null)),
  ]);
  const nameFor = (hrId: string) => nameOf(names, hrId, "") || null;

  const firstPlans = new Map<string, PhoenixTeamFirstPlan>();
  for (const notice of notices) {
    const teamSeatId = typeof notice.team_seat_id === "string" ? notice.team_seat_id : null;
    const weekStart = typeof notice.week_start === "string" ? notice.week_start.slice(0, 10) : null;
    if (!teamSeatId || !weekStart) continue;
    const repHrId = typeof notice.rep_hr_id === "string" ? notice.rep_hr_id : null;
    firstPlans.set(teamSeatId, { repName: repHrId ? nameFor(repHrId) : null, weekStart });
  }

  // One read of the vendor mirror, keyed by TERRITORY seat; this panel is a row per TEAM, so it is
  // folded through the same organogram the rows were built from rather than by guessing at the id.
  const leftoversBySeat = await loadVendorLeftoversBySeat();
  const stillOnVendor = new Map<string, VendorLeftoverRep[]>();
  for (const [territorySeatId, reps] of leftoversBySeat) {
    const teamSeatId = org.seats.get(territorySeatId)?.parentSeatId;
    if (!teamSeatId) continue;
    stillOnVendor.set(teamSeatId, [...(stillOnVendor.get(teamSeatId) ?? []), ...reps]);
  }
  const teams = buildPhoenixTeamRows({ org, starts, firstPlans, names: nameFor, cairoToday, stillOnVendor });
  // Readiness is read from the SAME rows, so the board beside the Start button can never disagree
  // with it about which teams exist or what each is called. A failed read is reported as unreadable
  // rather than thrown: the Start button must keep working, and zeros would read as "nobody has a
  // list", which is the one wrong answer that looks like data.
  const readiness = await loadPhoenixTeamReadiness({ org, teams, names: nameFor, cairoToday }).catch((error: unknown) => {
    logError("Phoenix CRM team readiness unreadable on the CRM hub", {
      error,
      labels: { event: "phoenix_crm_team_readiness_unreadable" },
    });
    return unreadableTeamReadiness(cairoToday);
  });

  return { provisioned: true, cairoToday, teams, readiness };
}

/** A refusal the Super Admin can act on (409), in words. */
export class PhoenixTeamStartRefusal extends Error {}

export type PhoenixTeamStartChange = {
  done: "started" | "stopped" | "cancelled";
  teamSeatId: string;
  startsOn: string;
  stopsOn: string | null;
};

/**
 * Start a team from a Saturday, stop it from a Saturday, or take back a start not reached yet — through
 * the one writer, which records the audit row in the same transaction. The caller has already asserted
 * the Super Admin and the permission. Every rule the panel offers is enforced again by the database; a
 * refusal comes back as `PhoenixTeamStartRefusal`.
 */
export async function setPhoenixTeamStart(input: {
  action: "start" | "stop";
  teamSeatId: string;
  day: string | null;
  actorHrId: string;
  /** Who pressed it, for the audit row the writer records in the same transaction. */
  actorLoginId: string | null;
}): Promise<PhoenixTeamStartChange> {
  if (input.day !== null && !isSaturday(input.day)) throw new PhoenixTeamStartRefusal("A team starts and stops on a Saturday.");
  const { data, error } = await getSupabaseAdmin().rpc(PHOENIX_CRM_SET_TEAM_START_RPC, {
    p: { action: input.action, team_seat_id: input.teamSeatId, day: input.day, actor_hr_id: input.actorHrId, actor_login_id: input.actorLoginId },
  });
  if (error) {
    const refusal = teamStartRefusal(error.message);
    if (refusal) throw new PhoenixTeamStartRefusal(refusal);
    throw new Error(`The team start could not be saved: ${error.message}`);
  }
  // The badges' copy of the live teams is a minute-long memory; a start or a stop must reach it now. So
  // is the leftover tally, which counts from each rep's team start — this panel reads it straight back.
  forgetLiveTeamsForDisplay();
  bumpSharedReadGeneration(VENDOR_LEFTOVERS_CACHE, "team start changed");
  const row = (data ?? {}) as Record<string, unknown>;
  const done = row.done === "started" || row.done === "stopped" || row.done === "cancelled" ? row.done : null;
  if (!done) throw new Error("The team start was saved but its answer could not be read. Reload the page.");
  return {
    done,
    teamSeatId: String(row.team_seat_id ?? input.teamSeatId),
    startsOn: String(row.starts_on ?? "").slice(0, 10),
    stopsOn: typeof row.stops_on === "string" ? row.stops_on.slice(0, 10) : null,
  };
}
