/**
 * The ONE read of the vendor mirror behind "who is still recording in iReports360".
 *
 * The rule, the wording and the measurement are in `src/lib/phoenix-crm/vendor-leftovers.ts`; this
 * file is only the query, and it lives here because `src/lib/crm` is the single door to the
 * `ireports360_*` tables (`src/lib/crm/phoenix-team-starts.ts`).
 *
 * 🔴 IT READS THE RAW MIRROR, AND THE MODULE'S OWN READ DOOR CANNOT ANSWER THIS. `queryVisits` in
 * `src/lib/crm/reads.ts` selects from `crm_visits_unified`, and for a started team's rep that view
 * ANTI-JOINS exactly these visits out on every day he also has a Phoenix entry (the owner's rule of
 * 2026-10-02, narrowed to "Phoenix wins the day" on 2026-10-16), so the door would answer a clean zero
 * for a rep double-entering every day. Which days those are comes from `phoenix_crm_rep_entry_days()`,
 * the very function the view anti-joins, so this flag and the figures cannot disagree.
 *
 * `tests/crm-single-source.test.ts` caught the first draft of this file and was right to: the escape it
 * offers is the justified allow-list entry, which is what this file carries, NOT a read routed through
 * a door that structurally cannot see the rows.
 *
 * Two screens share it, keyed by the rep's TERRITORY seat so neither has to key it twice: the Super
 * Admin's team-starts panel folds it up to the team, and the district manager's and SFE Manager's
 * Team tab prints it on the territory's own row. **Never the rep's own screen** (Phoenix CRM golden
 * rule #1) — the Team tab clears it with `isLocationBlind` before the answer leaves the server.
 *
 * 🔴 ONE COMPANY-WIDE READ A MINUTE, SHARED (2026-10-16 performance audit). Every manager who opened
 * the Team tab paid the started-reps function and the mirror read for the WHOLE company, then kept his
 * own few rows. The tallies are now kept for up to a minute (`getOrLoadShared`, the platform's
 * dashboard cache) and every Team tab in that minute takes its rows from them. The mirror is written
 * by the vendor sync on the worker, minutes apart, so a minute's reuse changes no figure a manager
 * could tell apart from the sync's own rhythm. A failed read is never kept: the next open asks again.
 */

import { getOrLoadShared } from "@/lib/cache/shared-read";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import type { VendorLeftoverRep } from "@/lib/phoenix-crm/vendor-leftovers";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";

type RepRow = {
  seat_id?: unknown;
  hr_key?: unknown;
  agent_crm_id?: unknown;
  counted_from?: unknown;
  counted_until?: unknown;
};

type VisitRow = { agent_crm_id?: unknown; agent_hr_id?: unknown; visit_date?: unknown };

type EntryDayRow = { hr_key?: unknown; agent_crm_id?: unknown; entry_day?: unknown };

/** One started rep's tally on one territory — a flat row, so the shared cache can hold and copy it. */
type LeftoverTally = { seatId: string; visits: number; lastDay: string; hrId: string | null };

/** The shared cache's namespace. A path that changes a team's start may bump it (`bumpSharedReadGeneration`). */
export const VENDOR_LEFTOVERS_CACHE = "phoenix-crm:vendor-leftovers";

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
 *
 * `seatIds` narrows the ANSWER to the territories a caller will print — the Team tab's own scope — and
 * never the read: the tallies are the company's, computed once, so every territory's figure is the
 * same whoever asks.
 */
export async function loadVendorLeftoversBySeat(options: { seatIds?: ReadonlyArray<string> } = {}): Promise<Map<string, VendorLeftoverRep[]>> {
  const { rows } = await getOrLoadShared<LeftoverTally>(VENDOR_LEFTOVERS_CACHE, "company", loadLeftoverTallies, {
    maxEntries: 1,
    maxRowsTotal: 20_000,
  });
  if (!rows) return new Map();
  const wanted = options.seatIds ? new Set(options.seatIds) : null;
  const kept = wanted ? rows.filter((rep) => wanted.has(rep.seatId)) : rows;

  const names = await loadPeopleNames([...new Set(kept.map((rep) => rep.hrId))]);
  const bySeat = new Map<string, VendorLeftoverRep[]>();
  for (const rep of kept) {
    const list = bySeat.get(rep.seatId) ?? [];
    // Names, never ids, on every screen — and a rep the people read cannot place still reads as a
    // person rather than as a blank.
    list.push({ repName: (rep.hrId ? nameOf(names, rep.hrId, "") : "") || "A rep", visits: rep.visits, lastDay: rep.lastDay });
    bySeat.set(rep.seatId, list);
  }
  return bySeat;
}

/** The company's tallies, or null when either read failed — null is passed through and never kept. */
async function loadLeftoverTallies(): Promise<LeftoverTally[] | null> {
  const supabase = getSupabaseAdmin();
  const repsRead = await supabase.rpc("phoenix_crm_started_team_reps");
  if (repsRead.error) return null;

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
  if (reps.length === 0) return [];

  // 🔴 PHOENIX WINS THE DAY (2026-10-16): a mirror row is dropped from the figures only on a day its rep
  // also has a Phoenix entry, and that is the only row this flag may count. `phoenix_crm_rep_entry_days()`
  // is the SAME function the two doors anti-join, so the flag and the figures cannot disagree. A district
  // manager has no entry day by design (he keeps both apps), so he is never named here.
  let entryDays: EntryDayRow[];
  try {
    entryDays = await rpcAll<EntryDayRow>(supabase, "phoenix_crm_rep_entry_days", {}, ["hr_key", "entry_day"]);
  } catch {
    return null;
  }
  const entryByHr = new Set<string>();
  const entryByCrmId = new Set<string>();
  for (const entry of entryDays) {
    const day = typeof entry.entry_day === "string" ? entry.entry_day.slice(0, 10) : null;
    if (!day) continue;
    if (typeof entry.hr_key === "string") entryByHr.add(`${entry.hr_key.toLowerCase()}|${day}`);
    if (typeof entry.agent_crm_id === "number") entryByCrmId.add(`${entry.agent_crm_id}|${day}`);
  }

  // The vendor mirror is keyed by the vendor's own agent id; a rep with none never logged there.
  const crmIds = [...new Set(reps.map((rep) => rep.agentCrmId).filter((id): id is number => id !== null))];
  if (crmIds.length === 0) return [];
  const earliest = reps.reduce((lowest, rep) => (rep.countedFrom < lowest ? rep.countedFrom : lowest), reps[0].countedFrom);

  // 🔴 A KEYSET WALK, NOT ONE READ (2026-10-16 performance audit). PostgREST stops at 1,000 rows with
  // no error, and this read grows every day a started rep keeps logging in iReports360 — 765 rows on
  // 16 October, past 1,000 within the week — after which the Team tab would have UNDERCOUNTED with
  // nothing to say so. Below 1,000 the walk returns exactly the rows the single read did.
  let visitRows: VisitRow[];
  try {
    visitRows = await fetchAllRowsKeyset<VisitRow & { id?: unknown }>(
      () =>
        supabase
          .from("ireports360_visits")
          .select("id, agent_crm_id, agent_hr_id, visit_date")
          .gte("visit_date", earliest)
          .in("agent_crm_id", crmIds),
      { cursorColumn: "id", cursorOf: (row) => (typeof row.id === "string" ? row.id : null) },
    );
  } catch {
    return null;
  }

  // Each vendor id's started reps, in the function's own order — so the search below walks only the
  // reps carrying THIS id (rather than every started rep, for every visit row) and still finds the
  // same first match the whole-list search did.
  const repsByCrmId = new Map<number, typeof reps>();
  for (const rep of reps) {
    if (rep.agentCrmId === null) continue;
    const held = repsByCrmId.get(rep.agentCrmId) ?? [];
    held.push(rep);
    repsByCrmId.set(rep.agentCrmId, held);
  }

  const byRep = new Map<string, LeftoverTally>();
  for (const row of visitRows) {
    const day = typeof row.visit_date === "string" ? row.visit_date.slice(0, 10) : null;
    const crmId = typeof row.agent_crm_id === "number" ? row.agent_crm_id : null;
    const hrId = typeof row.agent_hr_id === "string" ? row.agent_hr_id : null;
    if (!day || crmId === null) continue;
    // The rep whose start window holds this day — not merely the rep with this vendor id, so a day
    // before his team moved stays where it belongs.
    const rep = (repsByCrmId.get(crmId) ?? []).find(
      (candidate) =>
        candidate.agentCrmId === crmId &&
        candidate.countedFrom <= day &&
        (candidate.countedUntil === null || day < candidate.countedUntil),
    );
    if (!rep) continue;
    // The view's own test: by the row's HR id when it has one, by the vendor id when it has none.
    const droppedForPhoenix = hrId ? entryByHr.has(`${hrId.toLowerCase()}|${day}`) : entryByCrmId.has(`${crmId}|${day}`);
    if (!droppedForPhoenix) continue;
    const key = `${rep.seatId}|${crmId}`;
    const found = byRep.get(key) ?? { seatId: rep.seatId, visits: 0, lastDay: day, hrId: hrId ?? rep.hrKey };
    found.visits += 1;
    if (day > found.lastDay) found.lastDay = day;
    byRep.set(key, found);
  }
  return [...byRep.values()];
}
