import assert from "node:assert/strict";

import {
  describeIncompleteWindow,
  resolveIncentiveWindow,
  resolveSemesterKey,
  semesterPeriods,
} from "../src/lib/incentives/semester.ts";

/**
 * The incentive payout is a semester figure, and before this module the semester was whatever six
 * rows of sales data happened to exist for a rep (`allTimeTrend.slice(-6)`). Production on
 * 2026-08-04: June was half-loaded, so 26 reps were scored over five months and one over four while
 * 56 colleagues got six — and the day a July sheet landed, the window would have silently become
 * February-July, half of one semester and half of the next.
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

  // ── A fully-loaded semester is settled ───────────────────────────────────────────────────────
  const full = resolveIncentiveWindow({
    periods: ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"],
    todayPeriod: "2026-08",
  });
  assert.equal(full?.semester, "2026-S1");
  assert.equal(full?.complete, true, "all six months present and elapsed — the payout is a settled figure");
  assert.equal(describeIncompleteWindow(full), null, "a complete window carries no provisional notice");

  // ── The real production shape: June missing for a rep ────────────────────────────────────────
  const juneMissing = resolveIncentiveWindow({
    periods: ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"],
    todayPeriod: "2026-08",
  });
  assert.equal(juneMissing?.semester, "2026-S1", "the semester is anchored on the data, so a rep missing June still sits in H1");
  assert.deepEqual(juneMissing?.missing, ["2026-06"], "an ELAPSED month with no data is a gap, not an absence of obligation");
  assert.deepEqual(juneMissing?.remaining, [], "nothing is still to come — H1 is over");
  assert.equal(juneMissing?.complete, false);
  assert.match(
    String(describeIncompleteWindow(juneMissing)),
    /June/,
    "the notice must NAME the month — 'incomplete' alone tells a rep nothing they can act on",
  );

  // ── The boundary that would have silently blended two semesters ──────────────────────────────
  // Old behaviour: with Feb..Jul loaded, slice(-6) returns Feb,Mar,Apr,May,Jun,Jul — three months of
  // H1 and one of H2 summed into one achievement. The declared window must instead move to H2.
  const julyLanded = resolveIncentiveWindow({
    periods: ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"],
    todayPeriod: "2026-08",
  });
  assert.equal(julyLanded?.semester, "2026-S2", "once July exists the rep is in H2 — H1 months must not be summed into it");
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

  // ── Both kinds of hole at once ───────────────────────────────────────────────────────────────
  const mixed = resolveIncentiveWindow({ periods: ["2026-07", "2026-09"], todayPeriod: "2026-10" });
  assert.deepEqual(mixed?.missing, ["2026-08"], "August elapsed with no data → a gap");
  assert.deepEqual(mixed?.remaining, ["2026-10", "2026-11", "2026-12"], "October onward is still to come");
  const notice = String(describeIncompleteWindow(mixed));
  assert.match(notice, /August/, "the gap month is named");
  assert.match(notice, /still to come/, "and the in-progress remainder is stated separately");

  // ── Degenerate inputs must not manufacture a window ──────────────────────────────────────────
  assert.equal(resolveIncentiveWindow({ periods: [], todayPeriod: "2026-08" }), null, "no data → no window, never an empty-but-'complete' one");
  assert.equal(
    resolveIncentiveWindow({ periods: [null, undefined, "", "not-a-period"], todayPeriod: "2026-08" }),
    null,
    "malformed periods are discarded rather than coerced into a semester",
  );
  assert.equal(describeIncompleteWindow(null), null, "no window → no notice to render");
}
