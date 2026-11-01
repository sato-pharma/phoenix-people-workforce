// ─────────────────────────────────────────────────────────────────────────────
// How many MEDICAL REP SEATS the company has — the establishment, not the head count.
//
// 🔒 OWNER RULE, 2026-10-03: *"do not show the current medical reps, only show total structure of
// medical reps count vacants."* So the "out of N" on an honour badge and on the performance card is
// the ORGANOGRAM'S rep seats — every one of them, a vacant seat included — and never the number of
// reps who happened to carry sales in the window.
//
// WHY IT MATTERS, in his own numbers (production, 2026-10-03): the structure holds **111 rep seats,
// 35 of them vacant**; 76 are filled; 70 could actually be scored in Jul–Aug. Ranking 8th "of 70"
// silently shrinks the company to the people who sold something, and it MOVES every month as
// vacancies open and close — so the same performance reads as a better rank in a month when fewer
// reps scored. The establishment is the stable, honest denominator: it is what the company IS.
//
// THE SEAT MODEL IS THE SOURCE OF TRUTH for structure and vacancy (`au_v_org_tree`) — never the
// employees table, which counts people and cannot see a seat nobody is in.
//
// `seat_tier = 'REP'` only. An `ACTING_DM` seat is a district manager's, however its occupant also
// sells; counting it would put a manager's chair in a rep's denominator.
// ─────────────────────────────────────────────────────────────────────────────

import { isRepSeatHeldOffOrganogram } from "@/lib/org/sales-only-seats";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type SeatCount = {
  /** Every rep seat in the structure, vacant ones included. The badge's "out of N". */
  seats: number;
  /** How many of those are empty today. Shown on the card, not on the badge. */
  vacant: number;
};

export type RepEstablishment = {
  company: SeatCount;
  /** Keyed by the engine's own `line_code` — `cns`, `pedia`, `anti_infective`. */
  byLine: Map<string, SeatCount>;
};

const EMPTY: RepEstablishment = { company: { seats: 0, vacant: 0 }, byLine: new Map() };

/** Fold raw seat rows into the company and per-line counts. PURE, so the rule is testable dry. */
export function foldRepEstablishment(
  rows: readonly { seat_id?: unknown; seat_tier?: unknown; line_code?: unknown; is_vacant?: unknown }[],
): RepEstablishment {
  const byLine = new Map<string, SeatCount>();
  let seats = 0;
  let vacant = 0;
  for (const row of rows) {
    if (String(row.seat_tier ?? "").trim().toUpperCase() !== "REP") continue;
    // The establishment is the organogram's rep seats, so a seat held off the chart is not one of them.
    if (isRepSeatHeldOffOrganogram(String(row.seat_id ?? ""))) continue;
    const isVacant = row.is_vacant === true;
    seats += 1;
    if (isVacant) vacant += 1;
    const lineCode = String(row.line_code ?? "").trim();
    if (!lineCode) continue;
    const line = byLine.get(lineCode) ?? { seats: 0, vacant: 0 };
    line.seats += 1;
    if (isVacant) line.vacant += 1;
    byLine.set(lineCode, line);
  }
  return { company: { seats, vacant }, byLine };
}

/**
 * The rep establishment, loaded.
 *
 * Returns zeros rather than throwing when the seat model cannot be read. Every caller treats a zero
 * as "no structure figure" and falls back to the number of reps actually ranked — a badge that
 * printed "of 0 medical reps" would be worse than one that printed the smaller true count.
 */
export async function loadRepEstablishment(): Promise<RepEstablishment> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.from("au_v_org_tree").select("seat_id,seat_tier,line_code,is_vacant");
    if (error) return EMPTY;
    return foldRepEstablishment((data ?? []) as Record<string, unknown>[]);
  } catch {
    return EMPTY;
  }
}
