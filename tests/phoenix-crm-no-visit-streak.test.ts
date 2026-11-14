import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { planPhoenixCrmDigest } from "../src/lib/phoenix-crm/digest-rules.ts";
import {
  buildExceptions,
  judgeTerritory,
  NO_VISIT_STREAK_LOOKBACK_DAYS,
  NO_VISIT_STREAK_MAX_DAYS,
  NO_VISIT_STREAK_WHY,
  noVisitStreak,
  noVisitStreakLabel,
  type ExceptionRules,
  type TerritoryFacts,
} from "../src/lib/phoenix-crm/exceptions.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The no-visit exception says how many working days in a row (owner, 14 Nov 2026, "Add days in a row").
 *
 * "No visit on the last working day" read the same for a rep who missed yesterday and for one who had
 * visited nobody in two weeks. The existing row and the 06:55 message now say the run. Leave and
 * holidays are skipped as before; nothing else about the row, its rung or who is told changes.
 */

const ROOT = new URL("../", import.meta.url);

function code(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

const RULES: ExceptionRules = { callRateAmTarget: 2, callRatePmTarget: 10, cairoToday: "2026-11-14" };

function facts(overrides: Partial<TerritoryFacts> = {}): TerritoryFacts {
  return {
    seatId: "SEAT-1",
    territoryName: "Cairo 1",
    lineName: "Pedia",
    repName: "Ahmed Samir",
    hasRep: true,
    lineOpenedOn: "2026-01-01",
    readiness: { total: 12, validated: 12, dropped: 0, dropPending: 0, ready: true },
    planStatus: "submitted",
    planReturnedDay: null,
    planItems: 20,
    windowWorkingDays: 6,
    windowAmVisits: 18,
    windowPmVisits: 72,
    lastWorkingDayVisits: 0,
    leaveFullDaysInWindow: 0,
    leaveOnLastWorkingDay: false,
    leaveCoversWholeWeek: false,
    ...overrides,
  };
}

// Working days, newest first: Wed 11, Tue 10, Mon 9, Sun 8, Sat 7, Wed 4, Tue 3, Mon 2 November 2026.
const DAYS = ["2026-11-11", "2026-11-10", "2026-11-09", "2026-11-08", "2026-11-07", "2026-11-04", "2026-11-03", "2026-11-02"];

export function runPhoenixCrmNoVisitStreakTests(): void {
  assert.equal(NO_VISIT_STREAK_MAX_DAYS, 15);
  assert.ok(NO_VISIT_STREAK_LOOKBACK_DAYS > NO_VISIT_STREAK_MAX_DAYS, "the lookback leaves room for leave days inside a full run");

  // ── Counting the run ──────────────────────────────────────────────────────────────────────────
  const none = new Set<string>();
  assert.deepEqual(
    noVisitStreak({ workingDaysNewestFirst: DAYS, visitDays: new Set(["2026-11-08"]), leaveDays: none, completeHistory: false }),
    { days: 3, orMore: false },
    "the run ends at the first working day that has a visit",
  );
  assert.deepEqual(
    noVisitStreak({ workingDaysNewestFirst: DAYS, visitDays: new Set(["2026-11-11"]), leaveDays: none, completeHistory: false }),
    { days: 0, orMore: false },
    "a visit on the last working day is no run at all",
  );
  assert.deepEqual(
    noVisitStreak({ workingDaysNewestFirst: DAYS, visitDays: new Set(["2026-11-04"]), leaveDays: new Set(["2026-11-09", "2026-11-08"]), completeHistory: false }),
    { days: 3, orMore: false },
    "🔴 a full day of approved leave is skipped: not counted, and it does not end the run",
  );
  assert.deepEqual(
    noVisitStreak({ workingDaysNewestFirst: DAYS, visitDays: new Set(["2026-11-09"]), leaveDays: new Set(["2026-11-09"]), completeHistory: false }),
    { days: 2, orMore: false },
    "🔴 a visit ends the run on any day, a leave day included — he was at a door",
  );
  assert.deepEqual(
    noVisitStreak({ workingDaysNewestFirst: DAYS, visitDays: none, leaveDays: none, completeHistory: false }),
    { days: 8, orMore: true },
    "🔴 a run that reaches the end of the lookback without meeting a visit reads 'or more'",
  );
  assert.deepEqual(
    noVisitStreak({ workingDaysNewestFirst: DAYS, visitDays: none, leaveDays: none, completeHistory: true }),
    { days: 8, orMore: false },
    "unless the list already reaches the day the line opened: then the number is exact",
  );
  const long = Array.from({ length: 22 }, (_, index) => `day-${index}`);
  assert.deepEqual(
    noVisitStreak({ workingDaysNewestFirst: long, visitDays: none, leaveDays: none, completeHistory: true }),
    { days: NO_VISIT_STREAK_MAX_DAYS, orMore: true },
    "the count stops at its ceiling and says 'or more'",
  );
  assert.deepEqual(noVisitStreak({ workingDaysNewestFirst: [], visitDays: none, leaveDays: none, completeHistory: false }), { days: 0, orMore: false });

  // ── The words ─────────────────────────────────────────────────────────────────────────────────
  assert.equal(noVisitStreakLabel({ days: 8, orMore: false }), "No visit for 8 working days in a row");
  assert.equal(noVisitStreakLabel({ days: 15, orMore: true }), "No visit for 15 or more working days in a row");
  assert.equal(noVisitStreakLabel({ days: 2, orMore: false }), "No visit for 2 working days in a row");
  assert.equal(noVisitStreakLabel({ days: 1, orMore: false }), null, "one day keeps the row's own words");
  assert.equal(noVisitStreakLabel(null), null);
  assert.equal(noVisitStreakLabel(undefined), null);

  // ── The row ───────────────────────────────────────────────────────────────────────────────────
  const eight = judgeTerritory(facts({ noVisitStreak: { days: 8, orMore: false } }), RULES);
  assert.equal(eight?.kind, "no_visit", "🔴 the same kind, on the same rung of the ladder");
  assert.equal(eight?.label, "No visit for 8 working days in a row");
  assert.equal(eight?.why, NO_VISIT_STREAK_WHY);
  assert.equal(eight?.detail, null);

  const one = judgeTerritory(facts({ noVisitStreak: { days: 1, orMore: false } }), RULES);
  assert.equal(one?.label, "No visit on the last working day", "one day reads exactly as it did");
  assert.equal(one?.why, "The last working day has no visit on it.");
  const unmeasured = judgeTerritory(facts(), RULES);
  assert.equal(unmeasured?.label, "No visit on the last working day", "🔴 a run nobody counted is never a number: the row keeps its one-day words");
  assert.equal(judgeTerritory(facts({ noVisitStreak: null }), RULES)?.label, "No visit on the last working day");

  assert.equal(
    judgeTerritory(facts({ leaveOnLastWorkingDay: true, noVisitStreak: { days: 8, orMore: false } }), RULES),
    null,
    "🔴 a full day of leave on the last working day still answers it — the run never makes a row of its own",
  );
  assert.equal(
    judgeTerritory(facts({ lastWorkingDayVisits: 4, noVisitStreak: { days: 8, orMore: false } }), RULES),
    null,
    "and a day with visits is never a no-visit row, whatever run was handed in",
  );
  assert.equal(
    judgeTerritory(facts({ planStatus: null, planItems: 0, noVisitStreak: { days: 8, orMore: false } }), RULES)?.kind,
    "plan_missing",
    "the ladder is unchanged: a missing plan is still the row above it",
  );

  // The chips count the KIND, by the kind's own label, so a run does not split one chip into many.
  const board = buildExceptions(
    [facts({ noVisitStreak: { days: 8, orMore: false } }), facts({ seatId: "SEAT-2", territoryName: "Cairo 2", noVisitStreak: { days: 1, orMore: false } })],
    RULES,
  );
  assert.deepEqual(board.summary.byKind, [{ kind: "no_visit", label: "No visit on the last working day", count: 2 }]);

  // ── The 06:55 message says the same words ─────────────────────────────────────────────────────
  const digests = planPhoenixCrmDigest(board.rows, [{ hrId: "B-200", name: "Amgad Ibrahim", seatIds: ["SEAT-1", "SEAT-2"] }], "2026-11-11", "Wednesday 11 November 2026");
  assert.equal(digests.length, 1);
  assert.ok(digests[0].message.includes("• Cairo 1 · Ahmed Samir: No visit for 8 working days in a row"), "🔴 the morning message carries the run");
  assert.ok(digests[0].message.includes("• Cairo 2 · Ahmed Samir: No visit on the last working day"), "and a single day reads as before");

  // ── The gathering ─────────────────────────────────────────────────────────────────────────────
  const server = code("src/lib/phoenix-crm/server/exceptions.ts");
  assert.ok(
    server.includes("const leaveSpan = [...window, ...streakLookback, ...weekWorkingDays, input.cairoToday].sort();"),
    "🔴 the leave read covers every day the run may reach, so a day off inside it is skipped",
  );
  assert.match(server, /lastDay && !leaveUnread && holidays\.complete\s*\?\s*seats\.filter\(/, "🔴 no run is counted when the leave or the holiday calendar could not be read");
  assert.ok(
    server.includes("windowDays(lastDay, NO_VISIT_STREAK_LOOKBACK_DAYS, holidays.dates).filter((day) => day >= holidaysFrom)"),
    "🔴 the run never reaches past the holiday read, where a public holiday would be counted as a day he owed",
  );
  const holidayLookback = Number(/const HOLIDAY_LOOKBACK_DAYS = (\d+);/.exec(server)?.[1]);
  assert.ok(holidayLookback >= NO_VISIT_STREAK_LOOKBACK_DAYS * 2, "the holiday read is wide enough for the run's working days plus weekends and a long holiday");
  assert.ok(
    server.includes("completeHistory: Boolean(opened && streakLookback.length > 0 && opened >= (streakLookback[0] as string)),"),
    "the number is exact only when the days asked about go back to the day the line opened",
  );
  assert.ok(
    server.includes("(visits.get(seat.seatId)?.lastDay ?? 0) === 0 && !awayOf(seat).has(lastDay)"),
    "the run is read only for a territory whose last working day is empty and whose rep was not on leave",
  );
  const visitDays = server.slice(server.indexOf("async function loadVisitDays("), server.indexOf("export function sharedReadiness("));
  for (const test of ['.from("phoenix_crm_countable_visits")', '.eq("is_test", isTest)', '.eq("customer_validated", true)', '.is("imported_from_ireports360_at", null)']) {
    assert.ok(visitDays.includes(test), `the run asks the same visits the board counts: ${test}`);
  }
  assert.ok(
    server.includes("workingDaysNewestFirst: [...streakLookback].reverse().filter((day) => !opened || day >= opened),"),
    "🔴 never a day before the line opened in Phoenix CRM",
  );
}
