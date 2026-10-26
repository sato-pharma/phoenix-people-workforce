import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  describeIncompleteWindow,
  resolveIncentiveWindow,
  resolveSemesterKey,
  semesterPeriods,
} from "../src/lib/incentives/semester.ts";

/**
 * The incentive payout is a semester figure, and it has drifted twice.
 *
 * First it was whatever six rows of sales data happened to exist for a rep (`allTimeTrend.slice(-6)`).
 * Production on 2026-08-04: June was half-loaded, so 26 reps were scored over five months and one
 * over four while 56 colleagues got six.
 *
 * Then it was the semester containing the rep's LATEST period — which fixed the length but left the
 * WINDOW itself moving per rep: the day a July batch was approved, that rep silently jumped from H1
 * to H2 while the colleague beside him stayed on H1, with no deploy and nothing on screen changing.
 *
 * It is now the CALENDAR semester containing today (owner decision, 2026-08-13: the incentive moves
 * forward to Semester 2 from canonical July achievement onward, and H1 payouts are closed rather
 * than restated). These tests pin that: one window for everybody, holding still.
 */
export function runIncentiveSemesterWindowTests() {
  // ── The semester is a declared calendar fact ─────────────────────────────────────────────────
  assert.equal(resolveSemesterKey("2026-01"), "2026-S1");
  assert.equal(resolveSemesterKey("2026-06"), "2026-S1", "June is the LAST month of H1 — the boundary the old window straddled");
  assert.equal(resolveSemesterKey("2026-07"), "2026-S2", "July starts H2; it must never be averaged in with H1");
  assert.equal(resolveSemesterKey("2026-13"), null, "a malformed period resolves to nothing rather than defaulting into a payout window");
  assert.equal(resolveSemesterKey(null), null);
  assert.deepEqual(semesterPeriods("2026-S1"), ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]);
  assert.deepEqual(semesterPeriods("2026-S2"), ["2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12"]);

  // ── A fully-loaded semester, viewed while it is the current one, is settled ───────────────────
  const full = resolveIncentiveWindow({
    periods: ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"],
    todayPeriod: "2026-06",
  });
  assert.equal(full?.semester, "2026-S1");
  assert.equal(full?.complete, true, "all six months present and elapsed — the payout is a settled figure");
  assert.equal(describeIncompleteWindow(full), null, "a complete window carries no provisional notice");

  // ── H1 is CLOSED, not restated ───────────────────────────────────────────────────────────────
  // The same rep, same data, read in August. The old data anchor answered "H1, complete, 140%" and
  // put a closed semester's payout on the screen as if it were the live one.
  const closedH1 = resolveIncentiveWindow({
    periods: ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"],
    todayPeriod: "2026-08",
  });
  assert.equal(closedH1?.semester, "2026-S2", "August is H2 — six months of closed H1 data must not pull the window back to H1");
  assert.deepEqual(closedH1?.present, [], "not one H1 month counts toward an H2 payout");
  assert.deepEqual(closedH1?.missing, ["2026-07"], "July elapsed with nothing uploaded for this rep — that is a gap, and the notice has to name it");
  assert.deepEqual(closedH1?.remaining, ["2026-08", "2026-09", "2026-10", "2026-11", "2026-12"]);
  assert.equal(closedH1?.complete, false);
  assert.match(String(describeIncompleteWindow(closedH1)), /July/, "the missing month is named, never just 'incomplete'");

  // ── The landmine: two reps, different data, SAME window ──────────────────────────────────────
  // Under the data anchor this rep was on H2 and the one above was on H1 — different semesters,
  // same screen, same day, decided by whose batch happened to be approved.
  const julyLanded = resolveIncentiveWindow({
    periods: ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"],
    todayPeriod: "2026-08",
  });
  assert.equal(
    julyLanded?.semester,
    closedH1?.semester,
    "the rep whose July landed and the rep whose July has not are scored on the SAME semester",
  );
  assert.deepEqual(julyLanded?.present, ["2026-07"], "only H2 periods count toward an H2 payout");
  assert.deepEqual(julyLanded?.missing, [], "August is the current month, not a gap");
  assert.deepEqual(
    julyLanded?.remaining,
    ["2026-08", "2026-09", "2026-10", "2026-11", "2026-12"],
    "the rest of H2 has not happened yet — that is 'in progress', a different fact from 'data missing'",
  );
  assert.equal(julyLanded?.complete, false);
  assert.match(
    String(describeIncompleteWindow(julyLanded)),
    /5 months still to come/,
    "a semester in progress must say so, or a one-month figure reads as a full-semester payout",
  );

  // ── A rep with no data at all still has a semester ───────────────────────────────────────────
  // The data anchor returned null here, which left the incentive tab with no semester label and no
  // provisional notice — a blank figure with nothing explaining it.
  const noData = resolveIncentiveWindow({ periods: [], todayPeriod: "2026-08" });
  assert.equal(noData?.semester, "2026-S2", "'H2 has not started for you yet' is a fact; the absence of a window is not");
  assert.deepEqual(noData?.present, [], "nothing present, and nothing invented to fill it");
  assert.equal(noData?.complete, false, "an empty window is never 'complete' — that would read as a settled zero payout");
  assert.match(String(describeIncompleteWindow(noData)), /July/, "the elapsed month with no data is still named");

  // ── Both kinds of hole at once ───────────────────────────────────────────────────────────────
  const mixed = resolveIncentiveWindow({ periods: ["2026-07", "2026-09"], todayPeriod: "2026-10" });
  assert.deepEqual(mixed?.missing, ["2026-08"], "August elapsed with no data → a gap");
  assert.deepEqual(mixed?.remaining, ["2026-10", "2026-11", "2026-12"], "October onward is still to come");
  const notice = String(describeIncompleteWindow(mixed));
  assert.match(notice, /August/, "the gap month is named");
  assert.match(notice, /still to come/, "and the in-progress remainder is stated separately");

  // ── Degenerate inputs must not manufacture a window ──────────────────────────────────────────
  const malformedPeriods = resolveIncentiveWindow({
    periods: [null, undefined, "", "not-a-period"],
    todayPeriod: "2026-08",
  });
  assert.deepEqual(malformedPeriods?.present, [], "malformed periods are discarded rather than coerced into the semester");
  assert.equal(
    resolveIncentiveWindow({ periods: ["2026-07"], todayPeriod: "not-a-period" }),
    null,
    "a malformed today has no semester, and the window must NOT quietly fall back to the rep's data",
  );
  assert.equal(describeIncompleteWindow(null), null, "no window → no notice to render");

  // ── THE NUMERATOR: total sales, never the covered slice ──────────────────────────────────────
  //
  // The owner's own definition, given on 2026-09-05 when asked directly what the incentive is paid
  // on: "the incentive is total sales per semester over total target semester, twice yearly, the
  // first time from Jan to June and the second from July to Dec." The window half of that is pinned
  // above; this is the numerator half, and it is the half that decides money.
  //
  // It divided COVERED sales until that answer — only the money on a product carrying a target —
  // defended by a comment asserting that "/sales-vs-target and Monthly Closing both measure
  // achievement as covered ÷ target". Neither was true: vs-target moved onto the closing's rule
  // that same morning, and the Monthly Closing has NEVER used covered ÷ target — closingAchievement
  // divides all sales and always has. The justification was a mistaken belief about the closing.
  //
  // Pinned at SOURCE because the figure is computed inside an IO-bound portal loader that no unit
  // test can reach. Whitespace-insensitive, so a reformat cannot false-fail it.
  const service = readFileSync(
    fileURLToPath(new URL("../src/lib/employee-portal/service.ts", import.meta.url)),
    "utf8",
  ).replace(/\s+/g, " ");

  assert.ok(
    service.includes("? (semesterSales / semesterTarget) * 100 : 0;") &&
      service.includes("const overviewAchievementPercent = closingSemester ? closingSemester.totalAchievementPercent : semesterTarget > 0"),
    "the incentive achievement must divide TOTAL semester sales by the semester target — the owner's "
      + "stated basis, and the number the payout curve is fed",
  );
  assert.ok(
    !service.includes("(semesterCoveredSales / semesterTarget)"),
    "the covered-sales numerator must not return: it under-credits a rep against the closing, and on "
      + "this tab the 90% floor is worth 50 points of payout",
  );
  // The retired accumulator is gone entirely rather than left dangling, so nothing can quietly
  // reattach it. If a genuine need for coverage on this tab appears, add it as a DISPLAY field with
  // its own name — never as something the percentage could be pointed back at.
  assert.ok(
    !service.includes("semesterCoveredSales"),
    "the covered accumulator should be removed, not left unused beside the live numerator",
  );
}
