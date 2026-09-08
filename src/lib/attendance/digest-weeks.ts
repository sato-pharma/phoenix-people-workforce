// Settlement-week tiling for the weekly attendance digest.
//
// The cycle arithmetic itself is NOT here. When the 2026-07 digest module was torn
// out (PR #1253), the day-24 -> day-24 window maths was deliberately split into
// src/lib/payroll/copilot/cycle-window.ts so Payroll Copilot kept working, and it
// has been the single definition ever since. This module adds only the part that
// left with the digest: cutting one cycle into the four weeks a digest is sent for.
// Re-deriving the window here instead of importing it is how the report and the
// digest would come to disagree about which month a day belongs to.
//
// Owner-confirmed model (2026-07-03, unchanged on the 2026-09-08 rebuild):
//   • The payroll/fingerprint month runs day-24 -> day-24.
//   • Each cycle is tiled into EXACTLY four settlement weeks. Weeks 1-3 are seven
//     days; week 4 absorbs the remaining days up to the cycle end, so all four
//     digests land and settle before the cut-off.
//
// Pure calendar arithmetic — no timezone, no clock, no database — so it is
// deterministic and testable.

import { addDays, type CycleWindow } from "@/lib/payroll/copilot/cycle-window.ts";

export type SettlementWeek = {
  /** 1..4 */
  index: number;
  startIso: string;
  endIso: string;
};

/**
 * Tile a cycle into exactly four settlement weeks. Weeks 1-3 are seven days each;
 * week 4 runs from day 22 of the cycle to the cycle end, absorbing the extra one or
 * two days a 29-31 day cycle carries.
 */
export function tileSettlementWeeks(cycle: CycleWindow): SettlementWeek[] {
  const weeks: SettlementWeek[] = [];
  let weekStart = cycle.startIso;

  for (let index = 1; index <= 3; index += 1) {
    const weekEnd = addDays(weekStart, 6);
    // Never run a fixed week past the cycle end (defensive; real 24->24 cycles are
    // ~30 days so this clamp does not trigger in practice).
    const clampedEnd = weekEnd > cycle.endIso ? cycle.endIso : weekEnd;
    weeks.push({ index, startIso: weekStart, endIso: clampedEnd });
    weekStart = addDays(clampedEnd, 1);
    if (weekStart > cycle.endIso) break;
  }

  if (weeks.length < 4 && weekStart <= cycle.endIso) {
    weeks.push({ index: 4, startIso: weekStart, endIso: cycle.endIso });
  }

  return weeks;
}

/** The 1..4 settlement-week index containing `dateIso`, or null if outside the cycle. */
export function settlementWeekForDate(dateIso: string, cycle: CycleWindow): number | null {
  if (dateIso < cycle.startIso || dateIso > cycle.endIso) return null;
  const week = tileSettlementWeeks(cycle).find(
    (candidate) => dateIso >= candidate.startIso && dateIso <= candidate.endIso,
  );
  return week ? week.index : null;
}

/**
 * The week that has just ENDED as of `todayIso`, i.e. the one a digest is due for.
 * Returns null until the first week of a cycle has closed — a digest is never sent
 * for days that have not happened yet, which is the same reasoning that makes the
 * deductions collector refuse an in-progress month.
 */
export function completedSettlementWeek(
  todayIso: string,
  cycle: CycleWindow,
): SettlementWeek | null {
  const closed = tileSettlementWeeks(cycle).filter((week) => week.endIso < todayIso);
  return closed.length ? closed[closed.length - 1]! : null;
}
