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

import { addDays, resolveCycleWindow, type CycleWindow } from "@/lib/payroll/copilot/cycle-window.ts";

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
 * The month key before `monthKey` ("2026-01" -> "2025-12").
 *
 * Here rather than inline in the cron route because the January boundary is the whole
 * reason it exists: `month - 1` in January is 0, and a key built from that without
 * rolling the year reads "2026-00" — a month the deductions collector has never heard
 * of. Every answer given about December would then be silently stranded, on the one
 * day of the year nobody is watching for it.
 */
export function previousMonthKey(monthKey: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) throw new Error(`Validation: monthKey must be YYYY-MM, received "${monthKey}".`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error(`Validation: month out of range in "${monthKey}".`);
  const previous = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  return `${previous.year}-${String(previous.month).padStart(2, "0")}`;
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

/**
 * The most recently CLOSED settlement week as of `todayIso`, and the cycle it belongs to — which is
 * not always today's cycle.
 *
 * Week 4 ends on the cycle's last day (the 23rd). The first day it has closed is the 24th, and on
 * the 24th today's cycle is already the NEXT one, whose first week has not closed yet. Asking only
 * today's cycle therefore never built a week 4 at all: every cycle lost its last 9-10 days. Until
 * the new cycle has a closed week of its own, the week due is the previous cycle's last one.
 */
export function latestClosedSettlementWeek(
  todayIso: string,
  anchorDay?: number,
): { cycle: CycleWindow; week: SettlementWeek } | null {
  const cycle = resolveCycleWindow(todayIso, anchorDay);
  const current = completedSettlementWeek(todayIso, cycle);
  if (current) return { cycle, week: current };
  const previousCycle = resolveCycleWindow(addDays(cycle.startIso, -1), anchorDay);
  const previous = completedSettlementWeek(todayIso, previousCycle);
  return previous ? { cycle: previousCycle, week: previous } : null;
}

/**
 * The weeks the Super Admin can pick on the review page: every CLOSED week of the current payroll
 * month (owner, 2026-09-15 — "current payroll month"; a paid month stays closed). The current month
 * is the one the latest closed week belongs to, so on the 24th, before the new month has a closed
 * week of its own, it is still the month that just ended.
 */
export function closedWeeksOfCurrentCycle(
  todayIso: string,
  anchorDay?: number,
): { cycle: CycleWindow; weeks: SettlementWeek[] } | null {
  const due = latestClosedSettlementWeek(todayIso, anchorDay);
  if (!due) return null;
  return { cycle: due.cycle, weeks: tileSettlementWeeks(due.cycle).filter((week) => week.index <= due.week.index) };
}
