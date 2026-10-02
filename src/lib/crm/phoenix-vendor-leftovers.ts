/**
 * The ONE read of the vendor mirror behind "who is still recording in iReports360".
 *
 * The rule, the wording and the measurement are in `src/lib/phoenix-crm/vendor-leftovers.ts`; this
 * file is only the query, and it lives here because `src/lib/crm` is the single door to the
 * `ireports360_*` tables (`src/lib/crm/phoenix-team-starts.ts`).
 *
 * 🔴 IT READS THE RAW MIRROR ON PURPOSE, AND IT IS THE ONLY WAY TO SEE THESE ROWS. From a team's
 * start `crm_visits_unified` anti-joins exactly these visits out — that is the owner's rule of
 * 2026-10-02 and must never be weakened — so the view cannot answer this question, by construction.
 * Asking it there would read a clean zero for a rep who is logging every day.
 *
 * Two screens share it, keyed by the rep's TERRITORY seat so neither has to key it twice: the Super
 * Admin's team-starts panel folds it up to the team, and the district manager's and SFE Manager's
 * Team tab prints it on the territory's own row. **Never the rep's own screen** (Phoenix CRM golden
 * rule #1) — the Team tab clears it with `isLocationBlind` before the answer leaves the server.
 */

import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import type { VendorLeftoverRep } from "@/lib/phoenix-crm/vendor-leftovers";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type RepRow = {
  seat_id?: unknown;
  hr_key?: unknown;
  agent_crm_id?: unknown;
  counted_from?: unknown;
  counted_until?: unknown;
};

type VisitRow = { agent_crm_id?: unknown; agent_hr_id?: unknown; visit_date?: unknown };

/**
 * Every started rep's iReports360 visits since his own team's start, keyed by his TERRITORY seat.
 *
 * Scoped by `phoenix_crm_started_team_reps`, which carries each rep's own `counted_from` and
 * `counted_until`: a team started later is never judged by visits that still belonged in iReports360
 * when they were made, and a rep who left a started seat stops counting on the day he left.
 *
 * An empty map on any read failure, deliberately: this is an informational line on two boards, and a
 * board that refuses to render because an old mirror table is missing in a fresh environment would
 * cost more than the line is worth.
 */
export async function loadVendorLeftoversBySeat(): Promise<Map<string, VendorLeftoverRep[]>> {
  const supabase = getSupabaseAdmin();
  const repsRead = await supabase.rpc("phoenix_crm_started_team_reps");
  if (repsRead.error) return new Map();

  const reps = ((repsRead.data ?? []) as RepRow[])
    .map((row) => ({
      seatId: typeof row.seat_id === "string" ? row.seat_id : null,
      hrKey: typeof row.hr_key === "string" ? row.hr_key.toLowerCase() : null,
      agentCrmId: typeof row.agent_crm_id === "number" ? row.agent_crm_id : null,
      countedFrom: typeof row.counted_from === "string" ? row.counted_from.slice(0, 10) : null,
      countedUntil: typeof row.counted_until === "string" ? row.counted_until.slice(0, 10) : null,
    }))
    .filter((rep): rep is { seatId: string; hrKey: string | null; agentCrmId: number | null; countedFrom: string; countedUntil: string | null } =>
      rep.seatId !== null && rep.countedFrom !== null,
    );
  if (reps.length === 0) return new Map();

  // The vendor mirror is keyed by the vendor's own agent id; a rep with none never logged there.
  const crmIds = [...new Set(reps.map((rep) => rep.agentCrmId).filter((id): id is number => id !== null))];
  if (crmIds.length === 0) return new Map();
  const earliest = reps.reduce((lowest, rep) => (rep.countedFrom < lowest ? rep.countedFrom : lowest), reps[0].countedFrom);

  const visitsRead = await supabase
    .from("ireports360_visits")
    .select("agent_crm_id, agent_hr_id, visit_date")
    .gte("visit_date", earliest)
    .in("agent_crm_id", crmIds);
  if (visitsRead.error) return new Map();

  const byRep = new Map<string, { seatId: string; visits: number; lastDay: string; hrId: string | null }>();
  for (const row of (visitsRead.data ?? []) as VisitRow[]) {
    const day = typeof row.visit_date === "string" ? row.visit_date.slice(0, 10) : null;
    const crmId = typeof row.agent_crm_id === "number" ? row.agent_crm_id : null;
    const hrId = typeof row.agent_hr_id === "string" ? row.agent_hr_id : null;
    if (!day || crmId === null) continue;
    // The rep whose start window holds this day — not merely the rep with this vendor id, so a day
    // before his team moved stays where it belongs.
    const rep = reps.find(
      (candidate) =>
        candidate.agentCrmId === crmId &&
        candidate.countedFrom <= day &&
        (candidate.countedUntil === null || day < candidate.countedUntil),
    );
    if (!rep) continue;
    const key = `${rep.seatId}|${crmId}`;
    const found = byRep.get(key) ?? { seatId: rep.seatId, visits: 0, lastDay: day, hrId: hrId ?? rep.hrKey };
    found.visits += 1;
    if (day > found.lastDay) found.lastDay = day;
    byRep.set(key, found);
  }

  const names = await loadPeopleNames([...new Set([...byRep.values()].map((rep) => rep.hrId))]);
  const bySeat = new Map<string, VendorLeftoverRep[]>();
  for (const rep of byRep.values()) {
    const list = bySeat.get(rep.seatId) ?? [];
    // Names, never ids, on every screen — and a rep the people read cannot place still reads as a
    // person rather than as a blank.
    list.push({ repName: (rep.hrId ? nameOf(names, rep.hrId, "") : "") || "A rep", visits: rep.visits, lastDay: rep.lastDay });
    bySeat.set(rep.seatId, list);
  }
  return bySeat;
}
