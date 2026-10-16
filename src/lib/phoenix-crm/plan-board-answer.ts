/**
 * Phoenix CRM — putting a save's answer on the month board, in place of reading the month again.
 *
 * WHY (2026-10-16 Phoenix CRM performance audit). The rep's own board saves itself after every pause in
 * his ticking (owner, 2026-10-02), and after every save it read the WHOLE month again — 16 to 22 reads,
 * eight deep, 2.3 s at the median — only to redraw the one week it had saved and the month's meters that
 * week moved. A save that names the month on screen is now answered with exactly those, built by the
 * code the month itself is read with (server/monthly-plans.ts `loadMonthlyWeekAfterSave`), and this puts
 * them in place. Nothing else on the board moves on a save: a save never changes a week's status, the
 * month's header, the list, the readiness count or another week.
 *
 * Pure, so the board and the tests share it.
 */

import type { MonthlyPlannerView, SavedPlan } from "@/lib/phoenix-crm/view-types";

/** The week a save landed on and, when it is one of the month's own, the month's meters after it. */
export type SavedWeekBoard = NonNullable<SavedPlan["board"]>;

/**
 * The board with each saved week put in place, in the order the saves landed, and the meters of each
 * save that moved them — the last save's are the latest. Null when an answer is not this board's (another
 * month, a week the board does not hold, or one it files differently) or is older than what the board
 * already holds (a read that landed after the save): the board then reads itself again, exactly as it
 * always did.
 */
export function withSavedBoards(view: MonthlyPlannerView, boards: ReadonlyArray<SavedWeekBoard>): MonthlyPlannerView | null {
  let next = view;
  for (const board of boards) {
    if (board.monthStart !== next.monthStart) return null;
    const at = next.weeks.findIndex((week) => week.weekStart === board.week.weekStart);
    if (at < 0 || next.weeks[at].leading !== board.week.leading) return null;
    const held = next.weeks[at].plan;
    const answered = board.week.plan;
    if (held && (!answered || held.planId !== answered.planId || held.version > answered.version)) return null;
    const weeks = next.weeks.map((week, index) => (index === at ? board.week : week));
    next = board.meters
      ? { ...next, weeks, tallies: board.meters.tallies, amMeter: board.meters.amMeter, pmMeter: board.meters.pmMeter, callRate: board.meters.callRate }
      : { ...next, weeks };
  }
  return next;
}
