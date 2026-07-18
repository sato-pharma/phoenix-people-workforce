import { strict as assert } from "node:assert";

import {
  buildDvDigestSummaryEmail,
  dvDigestWeekWindow,
  isDvDigestDay,
} from "../src/lib/double-visit-analytics/weekly-digest.ts";

export function runDvPlannerWeeklyDigestTests() {
  // --- isDvDigestDay (Cairo Sunday gate) ---
  assert.equal(isDvDigestDay("2026-07-19T06:30:00.000Z"), true, "a Cairo Sunday triggers the digest");
  // Cairo observes DST (UTC+3 in July) — 20:59 UTC is still 23:59 Cairo-local Sunday.
  assert.equal(isDvDigestDay("2026-07-19T20:59:00.000Z"), true, "late-UTC time that is still Sunday in Cairo (DST) triggers");
  assert.equal(isDvDigestDay("2026-07-18T06:30:00.000Z"), false, "Saturday does not trigger");
  assert.equal(isDvDigestDay("2026-07-20T06:30:00.000Z"), false, "Monday does not trigger");
  // 2026-01-04T21:30:00Z is Sunday 23:30 Cairo-local (UTC+2) — still the same Cairo day.
  assert.equal(isDvDigestDay("2026-01-04T21:30:00.000Z"), true, "late-UTC time that is still Sunday in Cairo triggers");
  // 2026-01-04T22:30:00Z is Monday 00:30 Cairo-local — already the next Cairo day.
  assert.equal(isDvDigestDay("2026-01-04T22:30:00.000Z"), false, "UTC time that has rolled into Cairo Monday does not trigger");

  // --- dvDigestWeekWindow ---
  const midJuly = dvDigestWeekWindow("2026-07-19T06:30:00.000Z");
  assert.equal(midJuly.today, "2026-07-19", "today is the Cairo-local date");
  assert.equal(midJuly.weekStart, "2026-07-13", "weekStart is 6 days before today (inclusive 7-day window)");
  assert.equal(midJuly.weekLabel, "2026-07-13 to 2026-07-19", "weekLabel joins weekStart and today");

  const yearWrap = dvDigestWeekWindow("2026-01-04T06:30:00.000Z");
  assert.equal(yearWrap.today, "2026-01-04", "today handles the start of a new year");
  assert.equal(yearWrap.weekStart, "2025-12-29", "weekStart correctly wraps back into the prior year");
  assert.equal(yearWrap.weekLabel, "2025-12-29 to 2026-01-04", "weekLabel wraps correctly across the year boundary");

  // --- buildDvDigestSummaryEmail ---
  const clean = buildDvDigestSummaryEmail({
    summary: { covered: 15, coveragePct: 100, neverVisited: 0, onProbation: 0, overdue: 0, probationDvPending: 0, total: 15 },
    topOverdue: [],
  });
  assert.ok(clean.html.includes("100% (15/15)"), "an all-covered week still renders a positive summary, not an escalation");
  assert.ok(!clean.html.includes("Needs attention"), "no shortlist section when nothing is overdue");
  assert.ok(!clean.text.includes("Needs attention"), "text part also omits the shortlist section when empty");

  const gappy = buildDvDigestSummaryEmail({
    summary: { covered: 11, coveragePct: 73, neverVisited: 4, onProbation: 2, overdue: 3, probationDvPending: 1, total: 15 },
    topOverdue: [
      { daysSinceLastVisit: 78, name: "Overdue Rep" },
      { daysSinceLastVisit: null, name: "Never Visited Rep" },
    ],
  });
  assert.ok(gappy.html.includes("73% (11/15)"), "coverage stat renders in the html table");
  assert.ok(gappy.html.includes("Needs attention"), "shortlist section renders when there are overdue reps");
  assert.ok(gappy.html.includes("Overdue Rep") && gappy.html.includes("78d ago"), "overdue rep + day count render");
  assert.ok(gappy.html.includes("Never Visited Rep") && gappy.html.includes("Never visited"), "null cadence renders as Never visited, not a stray null/NaN");
  assert.ok(gappy.text.includes("Never visited: 4") && gappy.text.includes("On probation, DV pending: 1"), "text part carries every stat line");
}
