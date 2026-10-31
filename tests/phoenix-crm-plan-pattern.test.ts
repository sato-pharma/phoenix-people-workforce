import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import { describePlanPattern, planWeekdays } from "../src/lib/phoenix-crm/plan-pattern.ts";

/**
 * Phoenix CRM — the List says when a doctor is USUALLY planned, and gathers the ones who stand
 * together.
 *
 * 🔴 THE OWNER, 2026-09-30, two instructions in one breath:
 *   "Sort the addresses to be near each other, give them colours, then sort by distance and colour."
 *   "Add another column and tell him that, based on the reference weekly plans from iReports360, you
 *    are visiting this doctor — Sunday and Tuesday, in the first and the fourth week."
 *
 * And the constraint that shapes both: "don't duplicate this work, it was already done in the module
 * before — check it." So the clustering IS the old board's `findNeighbours` + `clusterRows` + its
 * five hues, and the week model IS Phoenix's own `fieldWeekStart` + `weekNumberInMonth`. What is new
 * is the pattern rule below and nothing else.
 */
export function runPhoenixCrmPlanPatternTests() {
  // ── His own example, end to end ─────────────────────────────────────────────────────────────────
  //
  // September 2026: the 6th and 20th are Sundays, the 8th and 22nd Tuesdays. The field week starts on
  // SATURDAY, so the 5th opens week 1 and the 19th opens week 3.
  {
    const days = ["2026-09-06", "2026-09-08", "2026-09-20", "2026-09-22", "2026-10-04", "2026-10-06"];
    const pattern = planWeekdays(days);
    assert.deepEqual(
      pattern.map((entry) => ({ weekday: entry.weekday, weeks: entry.weeks })),
      [
        { weekday: 0, weeks: [1, 3] },
        { weekday: 2, weeks: [1, 3] },
      ],
      "Sundays and Tuesdays, in weeks 1 and 3",
    );
    assert.equal(describePlanPattern(pattern), "Sun & Tue weeks 1 and 3", "said the way a column has room for");
  }

  // ── 🔴 THE WEEK MODEL IS PHOENIX'S OWN, NOT ceil(day / 7) ───────────────────────────────────────
  //
  // The field week runs Saturday to Thursday and a week belongs to the month its Saturday falls in.
  // Numbering any other way would put a doctor in "week 1" here and "Week 2" on the Plan board for
  // the same date, which is worse than showing nothing. 2026-09-05 is the first Saturday, so the 4th
  // (a Friday) belongs to the week BEFORE it — the last week of August, not week 1 of September.
  {
    assert.deepEqual(planWeekdays(["2026-09-05"])[0]?.weeks, [1], "the first Saturday opens week 1");
    const friday = planWeekdays(["2026-09-04"])[0];
    assert.equal(friday?.weekday, 5, "a Friday is read as a Friday");
    assert.notDeepEqual(friday?.weeks, [1], "and it does NOT fall in September's week 1 — its week started in August");
  }

  // ── A weekday is a PATTERN only if it happened more than once ───────────────────────────────────
  //
  // One entry is a day somebody was squeezed in; printing it as "you visit him on Wednesdays" is a
  // claim the data does not make.
  {
    const mixed = planWeekdays(["2026-09-06", "2026-09-20", "2026-09-09"]);
    assert.deepEqual(mixed.map((entry) => entry.weekday), [0], "the one-off Wednesday is not a pattern");

    // …unless it is ALL that is known about him, in which case saying it beats saying nothing.
    const only = planWeekdays(["2026-09-09"]);
    assert.deepEqual(only.map((entry) => entry.weekday), [3]);
    assert.equal(describePlanPattern(only), "Wed week 1");
  }

  // ── The wording ─────────────────────────────────────────────────────────────────────────────────
  {
    // "every week" beats listing all four — the reader wants the shape, not the list.
    assert.equal(describePlanPattern(planWeekdays(["2026-09-06", "2026-09-13", "2026-09-20", "2026-09-27"])), "Sun every week");
    // Days in the FIELD week's order, Saturday first — the order he works it, not the calendar's.
    const satAndSun = planWeekdays(["2026-09-05", "2026-09-06", "2026-09-19", "2026-09-20"]);
    assert.equal(describePlanPattern(satAndSun), "Sat & Sun weeks 1 and 3");
    // Nothing recorded is null, never an invented pattern and never an empty string.
    assert.equal(describePlanPattern(planWeekdays([])), null);
    assert.equal(describePlanPattern(planWeekdays(["not-a-date", ""])), null, "a bad date is not a plan");
    assert.equal(describePlanPattern(planWeekdays(["2026-09-06"]), false), "Sunday week 1", "the long form names the day in full");
  }

  // ── It is wired in, and it is not a judgement ───────────────────────────────────────────────────
  {
    const board = stripComments(readFileSync(new URL("../src/components/phoenix-crm/customer-list-board.tsx", import.meta.url), "utf8"));
    assert.ok(board.includes("Usually planned"), "the column says what it is");
    assert.ok(!/\bFrequency\b/.test(board), "🔴 and never calls itself Frequency — it states what the plans say, it does not set a target");
    assert.ok(board.includes("<PlanPatternCell customer={customer} />"), "the table draws it");
    assert.equal((board.match(/<PlanPatternCell customer=\{customer\} \/>/g) ?? []).length, 2, "on the phone card too");
    assert.ok(board.includes("No plan recorded"), "nothing recorded says so, rather than leaving a blank");

    const rules = stripComments(readFileSync(new URL("../src/lib/phoenix-crm/plan-pattern.ts", import.meta.url), "utf8"));
    assert.doesNotMatch(rules, /visit(ed|s)?\b.*count|achiev|adher|missed|distance|accuracy/i, "the column never counts whether he went — nothing on his own List judges him");

    // 🔴 The week model is IMPORTED, never re-derived. A second copy is how this column and the Plan
    //    board come to disagree about which week a date is in.
    assert.ok(rules.includes('from "@/lib/phoenix-crm/calendar"'), "the week model comes from calendar.ts");
    assert.ok(!/Math\.ceil\([^)]*\/\s*7/.test(rules), "and is never re-derived as ceil(day / 7)");
  }

  // ── 🔴 THE CLUSTERING IS THE OLD BOARD'S, REUSED ────────────────────────────────────────────────
  //
  // "Don't duplicate this work, it was already done in the module before." So the board calls
  // `findNeighbours` and `clusterRows` rather than carrying its own, and paints the five hues the old
  // board reasoned out — none of which already means something else here.
  {
    const board = stripComments(readFileSync(new URL("../src/components/phoenix-crm/customer-list-board.tsx", import.meta.url), "utf8"));
    assert.ok(board.includes("findNeighbours(keyed)"), "neighbours come from the old module");
    assert.ok(board.includes("clusterRows(keyed, found)"), "and so does the gathering that puts a block's rows under each other");
    assert.ok(board.includes("const neighbourhoods = neighbourhoodsIn(rawEntry.rows);"), "run per GROUP, so a comparison never crosses a brick heading");
    // The five hues live in ONE copy, brick-tints.ts, shared with the Reps List and the plan day.
    const tints = stripComments(readFileSync(new URL("../src/components/phoenix-crm/brick-tints.ts", import.meta.url), "utf8"));
    assert.equal((tints.match(/border-sky-400|border-rose-400|border-teal-400|border-lime-400|border-indigo-400/g) ?? []).length, 5, "five hues, as the old board has");
    assert.ok(/import \{[^}]*\bneighbourTint\b[^}]*\} from "@\/components\/phoenix-crm\/brick-tints";/.test(board), "and the board reads them from there, never a copy of its own");
    assert.ok(!board.includes("const NEIGHBOUR_TINTS"), "no second copy on the board");
    assert.ok(board.includes("nearTint?.fill"), "the wash lands on the ADDRESS cell — the thing being compared");
    assert.ok(board.includes("Also here:"), "and the row names WHICH doctors, because the use of it is planning one stop instead of three");

    // Violet is the shared customer on both boards; a hue that answered two questions would be worse
    // than no hue at all.
    assert.ok(!/violet/.test(tints.slice(tints.indexOf("export const NEIGHBOUR_TINTS"), tints.indexOf("] as const;", tints.indexOf("export const NEIGHBOUR_TINTS")))), "violet is reserved for the shared customer");
  }

  console.log("phoenix-crm plan pattern: OK");
}
