/**
 * The four reads behind the readiness board beside the Start button.
 *
 * The rules, the wording and WHY "seats filled" is not the headline are in
 * `src/lib/crm/phoenix-team-readiness.ts`; this file only fetches and folds. It is called from
 * `loadPhoenixTeamStartsPanel` (`phoenix-team-starts-server.ts`) with the panel's OWN team rows, so
 * readiness and the Start button can never disagree about which teams exist or what each is called.
 *
 * SUPER ADMIN ONLY, by where it is rendered: the CRM hub redirects everyone else
 * (`canUseAdminCrmWorkspace`) and nothing here is exposed on a route of its own. A Medical Rep must
 * never reach a board that judges his list (Phoenix CRM golden rule #1 — the rep's app is blind).
 *
 * ## The reads, and why each is shaped as it is
 *
 *  1. **The organogram** — already loaded by the caller (`au_v_org_tree`). The team's rep seats are
 *     the REP seats whose `parentSeatId` is the team seat, exactly as the panel derives a team.
 *  2. **The customers** — `phoenix_crm_customers`, keyed by `seat_id`, `is_test = false`. 🔴 The
 *     test filter is not optional: on production 2026-10-03 every one of the 13 customers with
 *     `status = 'active'` was a test row, so without it the board would report validated lists that
 *     do not exist. Read with the keyset pager because the table is past PostgREST's 1,000-row
 *     ceiling (8,344 real rows that day) and a short read would UNDERSTATE readiness — the one
 *     direction that matters, since it would hide a team that is ready.
 *  3. **The hire dates** — `employees.hire_date` for the rep-seat occupants, through
 *     `hrIdLookupKeys` so a stored casing or alias still matches.
 *  4. **The field visits** — through the CRM read door (`queryVisits`), never a raw
 *     `ireports360_visits` query: `src/lib/crm/` has ONE door for the mirror
 *     (`tests/crm-single-source.test.ts`) and this is an ordinary consumer read, not machinery that
 *     needs the raw rows. What the door answers is the honest figure either way — for a team NOT
 *     started (every team readiness is actually about) they are its iReports360 visits; for a
 *     started team the door serves its Phoenix visits instead, which is what every other screen
 *     counts for it from its start (owner, 2026-10-02). The panel says so in words.
 */

import { cairoTodayIso } from "@/lib/crm/dates";
import {
  buildPhoenixTeamReadinessRows,
  PHOENIX_TEAM_READINESS_WINDOW_DAYS,
  readinessWindowFrom,
  type PhoenixTeamReadinessPanelData,
  type TeamReadinessFacts,
  type TeamReadinessRepSeat,
} from "@/lib/crm/phoenix-team-readiness";
import type { PhoenixTeamRow } from "@/lib/crm/phoenix-team-starts";
import { queryVisits } from "@/lib/crm/reads";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { personKey, seatPeople, type OrgIndex, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { chunk, throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/** What one rep seat carries: real customers, and how many of them are validated. */
type SeatList = { customers: number; validated: number };

/**
 * Real (non-test) Phoenix CRM customers per rep seat, and the validated half of each.
 *
 * `status = 'active'` IS validated — the module's own word for a customer admitted to the list.
 */
async function loadSeatLists(seatIds: ReadonlyArray<string>): Promise<Map<string, SeatList>> {
  const lists = new Map<string, SeatList>();
  if (seatIds.length === 0) return lists;
  for (const part of chunk([...new Set(seatIds)], 150)) {
    const rows = await fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_customers")
          .select("id, seat_id, status")
          // 🔴 Real rows only — see the header. All 13 'active' customers on production were test rows.
          .eq("is_test", false)
          // A customer the iReports360 history import made (an Archive doctor or a campaign holder,
          // 20261029212200) is not part of the list the rep built; a restored one is (the mark clears).
          .is("imported_from_ireports360_at", null)
          .in("seat_id", part),
      { cursorColumn: "id", cursorOf: (row) => (typeof row.id === "string" ? row.id : null) },
    );
    for (const row of rows) {
      const seatId = typeof row.seat_id === "string" ? row.seat_id : null;
      if (!seatId) continue;
      const held = lists.get(seatId) ?? { customers: 0, validated: 0 };
      held.customers += 1;
      if (row.status === "active") held.validated += 1;
      lists.set(seatId, held);
    }
  }
  return lists;
}

/** `employees.hire_date` for the people on the rep seats, keyed by upper-case hr id. */
async function loadHireDates(hrIds: ReadonlyArray<string>): Promise<Map<string, string>> {
  const dates = new Map<string, string>();
  const wanted = new Set<string>();
  for (const hrId of hrIds) {
    const key = personKey(hrId);
    if (key) wanted.add(key);
  }
  if (wanted.size === 0) return dates;
  const lookup = [...new Set([...wanted].flatMap((key) => hrIdLookupKeys(key)))];
  const supabase = getSupabaseAdmin();
  for (const part of chunk(lookup, 200)) {
    const { data, error } = await supabase.from("employees").select("hr_id, hire_date").in("hr_id", part);
    throwIfError(error);
    for (const row of (data ?? []) as Row[]) {
      const key = personKey(typeof row.hr_id === "string" ? row.hr_id : null);
      const hireDate = typeof row.hire_date === "string" ? row.hire_date.slice(0, 10) : null;
      if (!key || !hireDate || !wanted.has(key) || dates.has(key)) continue;
      dates.set(key, hireDate);
    }
  }
  return dates;
}

/**
 * Field visits in the window per PERSON, through the read door. Keyed by upper-case hr id, so a
 * person on two seats is one entry and his visits are never added to themselves.
 */
async function loadVisitCounts(hrIds: ReadonlyArray<string>, window: { from: string; to: string }): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const wanted = [...new Set(hrIds.map((hrId) => personKey(hrId)).filter((key): key is string => key !== null))];
  if (wanted.length === 0) return counts;
  // The door sprays every casing and alias itself — pass the ids as they are.
  const rows = await queryVisits<{ agent_hr_id?: unknown }>({
    agentHrIds: wanted,
    columns: "agent_hr_id",
    dateFrom: window.from,
    dateTo: window.to,
    requireAgentHrId: true,
  });
  for (const row of rows) {
    const key = personKey(typeof row.agent_hr_id === "string" ? row.agent_hr_id : null);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** The teams the caller already built, narrowed to what readiness needs. */
export type ReadinessTeam = Pick<PhoenixTeamRow, "teamSeatId" | "team" | "state" | "runningStartsOn">;

/**
 * Readiness for the panel's own teams. Never throws for the caller's sake: a figure that could not
 * be read comes back as `readable: false`, so the Start button above it keeps working and the
 * board says it cannot answer rather than printing zeros that read as "nobody has a list".
 */
export async function loadPhoenixTeamReadiness(input: {
  org: OrgIndex;
  teams: ReadonlyArray<ReadinessTeam>;
  /** The caller's own name resolver — the district managers' names are already loaded there. */
  names?: (hrId: string) => string | null;
  cairoToday?: string;
}): Promise<PhoenixTeamReadinessPanelData> {
  const cairoToday = input.cairoToday ?? cairoTodayIso();
  const windowDays = PHOENIX_TEAM_READINESS_WINDOW_DAYS;
  const { org } = input;

  const teamSeatIds = new Set(input.teams.map((team) => team.teamSeatId));
  const repSeatsByTeam = new Map<string, OrgSeat[]>();
  for (const territory of org.territories) {
    const parent = territory.parentSeatId;
    if (!parent || !teamSeatIds.has(parent)) continue;
    // One row per PERSON: a handover seat lists the rep serving notice and the new hire, not one of them.
    repSeatsByTeam.set(parent, [...(repSeatsByTeam.get(parent) ?? []), ...seatPeople(territory)]);
  }

  const seatIds = [...new Set([...repSeatsByTeam.values()].flat().map((seat) => seat.seatId))];
  const occupantIds = [...repSeatsByTeam.values()]
    .flat()
    .map((seat) => seat.occupantHrId)
    .filter((hrId): hrId is string => Boolean(hrId));

  const [lists, hireDates, visits, names] = await Promise.all([
    loadSeatLists(seatIds),
    loadHireDates(occupantIds),
    loadVisitCounts(occupantIds, { from: readinessWindowFrom(cairoToday), to: cairoToday }),
    loadPeopleNames(occupantIds),
  ]);

  const facts: TeamReadinessFacts[] = input.teams.map((team) => {
    const seat = org.seats.get(team.teamSeatId) ?? null;
    const repSeats: TeamReadinessRepSeat[] = (repSeatsByTeam.get(team.teamSeatId) ?? []).map((repSeat) => {
      const key = repSeat.occupantHrId;
      const list = lists.get(repSeat.seatId) ?? { customers: 0, validated: 0 };
      return {
        seatId: repSeat.seatId,
        occupantHrId: key,
        occupantName: key ? nameOf(names, key, "") || null : null,
        customers: list.customers,
        validated: list.validated,
        hireDate: key ? (hireDates.get(key) ?? null) : null,
        visits: key ? (visits.get(key) ?? 0) : 0,
      };
    });
    const managerHrId = seat?.occupantHrId ?? null;
    // The manager's name comes from the caller's resolver when it has one: `names` above holds the
    // REP occupants, and a district manager who sits on no rep seat is not among them.
    const managerName = managerHrId ? (input.names?.(managerHrId) ?? (nameOf(names, managerHrId, "") || null)) : null;
    return {
      teamSeatId: team.teamSeatId,
      team: team.team,
      lineName: seat?.lineName ?? null,
      managerHrId,
      managerName,
      // "starts" is a start on a Saturday still to come; "running" is one in force today. Both are
      // already his decision, so neither is a team he still has to choose.
      startedOn: team.state === "running" || team.state === "starts" ? team.runningStartsOn : null,
      startsLater: team.state === "starts",
      isOtherPseudoDm: seat?.isOtherPseudoDm === true,
      repSeats,
    };
  });

  return {
    readable: true,
    cairoToday,
    windowDays,
    rows: buildPhoenixTeamReadinessRows({ teams: facts, cairoToday }),
  };
}
