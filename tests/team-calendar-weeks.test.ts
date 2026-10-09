import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildTeamCalendarWeeks,
  clampWeekIndex,
  daysInMonth,
  weekIndexForDate,
} from "../src/lib/employee-portal/team-calendar-weeks.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE TEAM CALENDAR FITS THE SCREEN.
 *
 * It drew one column per day of the month with `minmax(2.5rem, 1fr)` — a **1,240px hard minimum**
 * for a 31-day month — inside an `overflow-x-auto`. No `min-w-` search finds that floor, because it
 * is written as a grid template rather than a class, and it overflowed a DESKTOP content box as well
 * as a phone. On a 375px screen a manager saw about three days at a time and dragged sideways
 * through the other twenty-eight, once per person, for every person on his team.
 *
 * The owner's ruling, asked directly on 2026-09-29: **one week at a time on the phone.**
 *
 * Weeks cut on SATURDAY, because that is where Egypt's working week starts (Saturday to Thursday,
 * Friday off). Cutting every seven days from the 1st would scatter the Friday rest day across a
 * different column each week and stop "this week" being the unit a district manager thinks in.
 */
const VIEW = "src/components/employee-portal/team-calendar-view.tsx";

export function runTeamCalendarWeeksTests() {
  // ── The month is cut on Saturday, and the edges are honestly partial ───────
  // September 2026 opens on a Tuesday, so its first week is Tue 1 – Fri 4 (four days), and the
  // weeks that follow are full Sat–Fri runs.
  const sep = buildTeamCalendarWeeks(2026, 9);
  assert.equal(sep[0]?.startDateIso, "2026-09-01");
  assert.equal(sep[0]?.endDateIso, "2026-09-04");
  assert.equal(sep[0]?.dayCount, 4, "September 2026 opens on a Tuesday, so its first week is four days");
  assert.equal(sep[0]?.label, "Tue 1 – Fri 4");
  assert.equal(sep[1]?.startDateIso, "2026-09-05", "the second week must start on a SATURDAY");
  assert.equal(sep[1]?.dayCount, 7);
  assert.equal(sep[1]?.label, "Sat 5 – Fri 11");

  // Every day of the month belongs to exactly one week, and no week reaches outside it. A gap here
  // would hide a day from a manager entirely, which is worse than the scroll this replaced.
  for (const [year, month] of [[2026, 9], [2026, 2], [2024, 2], [2026, 10], [2026, 1], [2026, 12]] as const) {
    const weeks = buildTeamCalendarWeeks(year, month);
    const covered = weeks.reduce((sum, week) => sum + week.dayCount, 0);
    assert.equal(
      covered,
      daysInMonth(year, month),
      `${year}-${month}: the weeks must cover every day of the month exactly once, with no gap and no overlap`,
    );
    assert.equal(weeks[0]?.startDateIso.slice(8), "01", `${year}-${month}: the first week starts on the 1st`);
    assert.equal(
      weeks[weeks.length - 1]?.endDateIso.slice(8),
      String(daysInMonth(year, month)).padStart(2, "0"),
      `${year}-${month}: the last week ends on the last day`,
    );
    // Every week after the first opens on a Saturday.
    for (const week of weeks.slice(1)) {
      assert.equal(
        new Date(`${week.startDateIso}T00:00:00Z`).getUTCDay(),
        6,
        `${week.startDateIso} must be a Saturday — Egypt's week starts there`,
      );
      assert.equal(week.startColumn, 1, "a full week starts in the first column");
    }
  }

  // February in a leap year, because `daysInMonth` is computed from the calendar rather than a
  // lookup table and a 28/29 mistake would drop a real working day.
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2026, 2), 28);

  // ── The opening week keeps its real weekday columns ────────────────────────
  // 1 September 2026 is a Tuesday: Saturday is column 1, so Tuesday is column 4. Without this the
  // 1st would render under "Sat", and a manager checking who worked Sunday would read the wrong
  // column — a silently wrong answer about a real person's day.
  assert.equal(sep[0]?.startColumn, 4, "Tuesday sits in the fourth column of a Saturday-first week");
  const oct = buildTeamCalendarWeeks(2026, 10);
  assert.equal(oct[0]?.startColumn, 6, "1 October 2026 is a Thursday — the sixth column");
  const aug = buildTeamCalendarWeeks(2026, 8);
  assert.equal(aug[0]?.startColumn, 1, "1 August 2026 IS a Saturday, so it needs no offset");

  // ── Opening on the right week, and never out of bounds ────────────────────
  assert.equal(weekIndexForDate(sep, "2026-09-29"), 4, "the 29th is in the fifth week of September 2026");
  assert.equal(weekIndexForDate(sep, "2026-09-01"), 0);
  assert.equal(
    weekIndexForDate(sep, "2026-10-14"),
    0,
    "a date outside the month falls back to the first week rather than rendering an empty grid",
  );
  assert.equal(clampWeekIndex(sep, 99), sep.length - 1);
  assert.equal(clampWeekIndex(sep, -3), 0);
  assert.equal(clampWeekIndex([], 2), 0);
  assert.equal(clampWeekIndex(sep, Number.NaN), 0);

  // A malformed month must not throw into a page render.
  assert.deepEqual(buildTeamCalendarWeeks(2026, 13), []);
  assert.deepEqual(buildTeamCalendarWeeks(2026, 0), []);

  // ── And the view no longer buys a sideways scroll ──────────────────────────
  const view = stripComments(readFileSync(VIEW, "utf8"));
  assert.doesNotMatch(
    view,
    /overflow-x-auto|phoenix-horizontal-scroll/,
    "the Team Calendar must not scroll sideways — it fits by dividing the width and, below lg, by " +
      "showing one week at a time",
  );
  assert.doesNotMatch(
    view,
    /minmax\(2\.5rem/,
    "a 2.5rem column floor is a 1,240px minimum for a 31-day month; columns divide the width instead",
  );
  assert.match(
    view,
    /repeat\(\$\{employee\.timeline\.length\}, minmax\(0, 1fr\)\)/,
    "the month grid's columns must divide the available width",
  );
  assert.match(
    view,
    /repeat\(7, minmax\(0, 1fr\)\)/,
    "and the small-screen grid is seven columns — one week",
  );
  // ONE stepper for the page, not one per row: per-row arrows would let two reps in a team sit on
  // different weeks, and comparing the same day down a column is the whole point of this board.
  assert.equal(
    (view.match(/<WeekStepper/g) ?? []).length,
    1,
    "there must be exactly ONE week stepper on the page — per-row arrows would desynchronise the team",
  );
  assert.match(
    view,
    // Not anchored on a closing quote: the stepper's ground took a depth token in the portal's
    // premium-depth pass (2026-10-09), so the attribute is a template now. Every class this
    // assertion cares about is still matched, in order, `lg:hidden` included.
    /className=(?:"|\{`)flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 lg:hidden/,
    "the stepper is hidden from lg up, where the whole month is shown instead",
  );
  // The stepper's own state must never reach the row grids as an index into someone's timeline.
  assert.match(
    view,
    /cell\.dateIso >= week\.startDateIso && cell\.dateIso <= week\.endDateIso/,
    "each row must slice its week by DATE — an index range from one person's timeline is wrong for " +
      "a mid-month joiner whose array is shorter",
  );

  // Cairo, from the server. A browser-derived "today" would answer in the viewer's zone and would
  // also differ between the server render and the client.
  assert.match(
    view,
    /todayIso \? weekIndexForDate\(weeks, todayIso\) : 0/,
    "the stepper opens on the week holding Cairo's today, passed in from the server",
  );
  assert.doesNotMatch(
    view,
    /new Date\(\)/,
    "the view must not read the browser's clock — todayIso comes from the server in Cairo time",
  );

  // ── The month header's weekday shortens where it must ─────────────────────
  // MEASURED in the browser against the real compiled stylesheet, not reasoned about: with
  // `minmax(0, 1fr)` the day CELLS fit at every width down to 560px, but the 31-column HEADER row
  // overflowed by 8px at 560, 3px at 700, 1px at 760 and only reached zero at **800px** — a real
  // floor living entirely in a three-letter weekday that cannot shrink. Two letters measure clean
  // from **600px**. So the abbreviation shortens between lg and xl and comes back in full above it.
  // Delete either half and the month grid regains a floor a content box may not clear.
  assert.match(
    view,
    /<span className="xl:hidden">\{weekday\(cell\.dateIso\)\.slice\(0, 2\)\}<\/span>/,
    "between lg and xl the month header's weekday must shorten to two letters — three letters put an " +
      "800px floor back into a 31-column grid",
  );
  assert.match(
    view,
    /<span className="hidden xl:inline">\{weekday\(cell\.dateIso\)\}<\/span>/,
    "and from xl up it returns in full, where there is room for it",
  );
}
