import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { summarizeFieldBenchmarks, type SalesRow } from "../src/lib/employee-360/deep-service.ts";

// Employee 360, 2026-09-25 (owner chose "compute live" over removing or relabelling them).
//
// The screen printed three company figures as literals measured once on 2026-07-12: "~2/3 of reps
// have linked sales", "61% co." beside a rep's achievement, and "~33 of 127 reps have ever been
// coached". Nothing recomputed them, so as the field force changed they went wrong without anyone
// noticing. Each is now summarizeFieldBenchmarks over rows the profile already loads, and carries the
// month it describes. The visit averages in benchmarks.ts were deliberately left out of this change.

function sale(overrides: Partial<SalesRow>): SalesRow {
  return {
    employee_hr_id: "B-1",
    line: "Pedia",
    family: "Saginko",
    product: "Saginko",
    month: 7,
    year: 2026,
    sales_value: 0,
    target_value: 0,
    ...overrides,
  };
}

export async function runEmployee360LiveFieldBenchmarksTests() {
  // ── The live figures ──
  const live = summarizeFieldBenchmarks({
    // B-1 twice in two spellings is one rep; B-9 is a field rep with no sales and no coaching.
    fieldRepHrIds: ["B-1", "b-1", "B-2", "B-3", "B-9"],
    salesRows: [
      sale({ employee_hr_id: "B-1", month: 7, sales_value: 100, target_value: 200 }),
      sale({ employee_hr_id: "b-2", month: 7, sales_value: 50, target_value: 0 }),
      sale({ employee_hr_id: "B-2", month: 4, sales_value: 999, target_value: 0 }),
      // A row for someone who is not an active Medical Rep today (a leaver, a DM on a rep seat):
      // company money, so it is in the achievement, but it is not a field rep "with linked sales".
      sale({ employee_hr_id: "B-77", month: 8, sales_value: 300, target_value: 400 }),
    ],
    coachedRepHrIds: ["b-1", "B-1", "B-3", "B-77"],
    asOfMonth: "2026-09",
  });
  assert.equal(live.fieldReps, 4, "active field reps are counted once each, whatever the HR id's case");
  assert.equal(live.repsWithSales, 2, "B-1 and B-2 have sales rows; B-3 and B-9 do not; B-77 is not a field rep");
  assert.equal(
    live.companyAchievementPct,
    (450 / 600) * 100,
    "the closing's rule with the company as the subject: April has no target, so its 999 stays out — 450 / 600",
  );
  assert.equal(live.salesThroughLabel, "Aug 2026", "the sales figures run through the latest month holding sales");
  assert.equal(live.repsEverCoached, 2, "B-1 once however often coached, plus B-3; B-77 is not on today's field roster");
  assert.equal(live.asOfLabel, "Sep 2026");

  // A failed coaching read is no figure, never zero.
  const unread = summarizeFieldBenchmarks({ fieldRepHrIds: ["B-1"], salesRows: [], coachedRepHrIds: null, asOfMonth: "2026-09" });
  assert.equal(unread.repsEverCoached, null, "a coaching read that failed shows nothing, not '0 of 1 reps coached'");
  assert.equal(unread.companyAchievementPct, null, "no sales and no target is no company achievement, never 0%");
  assert.equal(unread.salesThroughLabel, null);
  assert.equal(unread.repsWithSales, 0);

  // ── The literals are gone, and the screen prints the live figures ──
  const view = readFileSync(new URL("../src/components/employee-360/employee-360-view.tsx", import.meta.url), "utf8");
  const service = readFileSync(new URL("../src/lib/employee-360/deep-service.ts", import.meta.url), "utf8");
  for (const [name, source] of [
    ["employee-360-view.tsx", view],
    ["deep-service.ts", service],
  ] as const) {
    assert.ok(!source.includes("2/3 of reps"), `${name} must not print "~2/3 of reps" — the share is computed live`);
    assert.ok(!source.includes("61% co."), `${name} must not print "61% co." — the company achievement is computed live`);
    assert.ok(!/\b33 of 127\b/.test(source), `${name} must not print "33 of 127" — the coached count is computed live`);
  }
  assert.ok(
    !/benchmark="[^"]*\d/.test(view),
    "no KpiTile takes a benchmark as a string literal carrying a number — a company figure written into the markup is a frozen one",
  );
  assert.ok(view.includes("benchmark={companyAchievement}"), "the achievement tile's company figure is the live one");
  assert.ok(view.includes("field={summary.fieldBenchmarks}"), "the sales and coaching sections are handed the live figures");
  assert.ok(service.includes("getFieldBenchmarks(viewerRole)"), "the profile computes the company figures for this viewer's product mask");
  assert.ok(service.includes("fieldBenchmarks,"), "and returns them on the profile");
}
