import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import {
  nextFreePlanDay,
  placeSourcedPlanRow,
  planDayMode,
  planDayRowsForMode,
  planSlotsOverlap,
  type DayModeRow,
  type DayModeTarget,
} from "../src/lib/weekly-planning/plan-slot-merge.ts";

/**
 * Regression cover for the AM / PM switch on the monthly plan (owner, 2026-09-13: "it clicked but
 * nothing changed").
 *
 * A day the submitted weekly plan had split into AM + PM reached the monthly plan as two locked
 * rows. The merge matched on the slot alone, so the seeded empty "Full day" row for that date was
 * never replaced: the day carried three rows, one locked, and a locked day's Full day / AM / PM
 * buttons are disabled. Reopening a saved plan brought the stray full-day row back from the
 * database, where it had been saved (four such days on one District Manager's September plan).
 */

type Row = {
  activityDate: string;
  filled?: boolean;
  key: string;
  label: string;
  locked?: boolean;
  slot: "am" | "full" | "pm";
};

const DAY = "2026-09-01";
const OTHER_DAY = "2026-09-02";
const isFilled = (row: Row) => Boolean(row.filled);
const shape = (rows: readonly Row[]) => rows.map((row) => `${row.activityDate} ${row.slot} ${row.label}`).sort();

function place(rows: Row[], ...incoming: Row[]) {
  return incoming.reduce((current, row) => placeSourcedPlanRow(current, row, isFilled), rows);
}

export function runPlanSlotMergeTests() {
  assert.equal(planSlotsOverlap("am", "pm"), false, "AM and PM never claim each other");
  assert.equal(planSlotsOverlap("full", "am"), true, "a full day claims the morning");
  assert.equal(planSlotsOverlap("pm", "full"), true, "a full day claims the afternoon");
  assert.equal(planSlotsOverlap("am", "am"), true, "a slot claims itself");

  // Headline: a weekly day split into AM + PM, placed into a fresh monthly plan, leaves no seeded
  // "Full day" row behind — so the day holds only its two locked halves.
  const fresh = place(
    [
      { activityDate: DAY, key: "seed-1", label: "seeded office", slot: "full" },
      { activityDate: OTHER_DAY, key: "seed-2", label: "seeded office", slot: "full" },
    ],
    { activityDate: DAY, key: "w-am", label: "weekly double visit", locked: true, slot: "am" },
    { activityDate: DAY, key: "w-pm", label: "weekly double visit", locked: true, slot: "pm" },
  );
  assert.deepEqual(
    shape(fresh),
    [`${DAY} am weekly double visit`, `${DAY} pm weekly double visit`, `${OTHER_DAY} full seeded office`],
    "a split weekly day must displace the seeded full-day row it overlaps, and touch no other day",
  );

  // A plan reopened from the database: the stray full-day row and the earlier copies of both halves
  // were all saved. The locked weekly halves clear all three.
  const reopened = place(
    [
      { activityDate: DAY, key: "saved-full", label: "saved empty office", slot: "full" },
      { activityDate: DAY, filled: true, key: "saved-am", label: "saved am copy", slot: "am" },
      { activityDate: DAY, filled: true, key: "saved-pm", label: "saved pm copy", slot: "pm" },
    ],
    { activityDate: DAY, key: "w-am", label: "weekly am", locked: true, slot: "am" },
    { activityDate: DAY, key: "w-pm", label: "weekly pm", locked: true, slot: "pm" },
  );
  assert.deepEqual(shape(reopened), [`${DAY} am weekly am`, `${DAY} pm weekly pm`]);
  assert.deepEqual(
    reopened.map((row) => row.key).sort(),
    ["saved-am", "saved-pm"],
    "a replaced row keeps the key of the same-slot row it took over, so an open input keeps focus",
  );

  // A locked full day (approved vacation) wins over a split the employee had filled in.
  const vacation = place(
    [
      { activityDate: DAY, filled: true, key: "am", label: "own field am", slot: "am" },
      { activityDate: DAY, filled: true, key: "pm", label: "own field pm", slot: "pm" },
    ],
    { activityDate: DAY, key: "vac", label: "approved vacation", locked: true, slot: "full" },
  );
  assert.deepEqual(shape(vacation), [`${DAY} full approved vacation`]);

  // A locked row never displaces a locked row of the other slot.
  const twoLocks = place(
    [{ activityDate: DAY, key: "exc", label: "approved excuse", locked: true, slot: "am" }],
    { activityDate: DAY, key: "w-pm", label: "weekly pm", locked: true, slot: "pm" },
    { activityDate: DAY, key: "hol", label: "holiday", locked: true, slot: "full" },
  );
  assert.ok(
    shape(twoLocks).includes(`${DAY} am approved excuse`) && shape(twoLocks).includes(`${DAY} pm weekly pm`),
    "a locked full day must not silently delete another locked half",
  );

  // An UNLOCKED sourced split (the monthly plan inside a weekly one) fills an untouched day, and
  // clears its seeded full-day row the same way.
  const sourcedSplit = place(
    [{ activityDate: DAY, key: "seed", label: "seeded office", slot: "full" }],
    { activityDate: DAY, key: "m-am", label: "monthly am", slot: "am" },
    { activityDate: DAY, key: "m-pm", label: "monthly pm", slot: "pm" },
  );
  assert.deepEqual(shape(sourcedSplit), [`${DAY} am monthly am`, `${DAY} pm monthly pm`]);

  // An UNLOCKED sourced row never overwrites what the employee filled in, nor a locked row.
  const ownWork = place(
    [{ activityDate: DAY, filled: true, key: "own", label: "own full day", slot: "full" }],
    { activityDate: DAY, key: "m-am", label: "monthly am", slot: "am" },
  );
  assert.deepEqual(shape(ownWork), [`${DAY} full own full day`]);
  const lockedDay = place(
    [{ activityDate: DAY, key: "vac", label: "approved vacation", locked: true, slot: "full" }],
    { activityDate: DAY, key: "m-pm", label: "monthly pm", slot: "pm" },
  );
  assert.deepEqual(shape(lockedDay), [`${DAY} full approved vacation`]);

  // The day's switch (owner's video, 2026-09-13): a Field Force Thursday is seeded as ONE AM row,
  // and counting rows alone lit "Full day" over a row whose own pill said AM.
  assert.equal(
    planDayMode([{ slot: "am" }]),
    "split",
    "a day holding a lone AM row must not light the Full day button",
  );
  assert.equal(planDayMode([{ slot: "pm" }]), "split", "nor a lone PM row");
  assert.equal(planDayMode([{ slot: "full" }]), "full", "a single full-day row is a full day");
  assert.equal(planDayMode([{ slot: "am" }, { slot: "pm" }]), "split", "a day split into AM + PM");

  runDayModeTransitionTests();
  runNextFreePlanDayTests();
  runDayModeSwitchMarkupTests();
}

// ---------------------------------------------------------------------------------------------
// The mobile sheet's "Day Mode" caption was a <label> wrapping the whole button group. A tap on a
// label is forwarded as a click to its first labelable descendant - the "Full day" button - so
// tapping the caption ran setDayMode("full") and kept only the first row of a split day. The
// markup is the defect, so it is read from the source (comments stripped), sliced to RowEditSheet.
// ---------------------------------------------------------------------------------------------
function runDayModeSwitchMarkupTests() {
  const workspace = stripComments(readFileSync("src/components/employee-portal/plans-workspace.tsx", "utf8"));
  const sheetStart = workspace.indexOf("function RowEditSheet(");
  assert.ok(sheetStart >= 0, "RowEditSheet must exist - this test slices it by marker");
  const sheet = workspace.slice(sheetStart, workspace.indexOf("\nfunction ", sheetStart + 1));
  const captionAt = sheet.indexOf("Day Mode");
  const groupAt = sheet.indexOf('aria-label="Day mode"');
  assert.ok(captionAt >= 0 && groupAt > captionAt, "the sheet must still show the Day Mode caption above its button group");
  assert.doesNotMatch(
    sheet,
    /<Field label="Day Mode">/,
    "Day Mode must not be a <Field>: Field is a <label>, and a caption tap would press its first button (Full day)",
  );
  const beforeGroup = sheet.slice(0, groupAt);
  assert.equal(
    (beforeGroup.match(/<label\b/g) ?? []).length - (beforeGroup.match(/<\/label>/g) ?? []).length,
    0,
    "no <label> may still be open where the Day Mode button group starts - a tap on its caption would press the first button",
  );

  // The desktop table's switch names itself and reports which mode is pressed.
  const tableAt = workspace.indexOf('role="group"');
  assert.ok(tableAt >= 0, "the desktop day-mode switch must be a role=group");
  const desktopSwitch = workspace.slice(workspace.lastIndexOf("<div", tableAt), workspace.indexOf("dayModeButtonLabels[mode]", tableAt));
  assert.match(desktopSwitch, /aria-label="Day mode"/, "and carry the accessible name Day mode");
  assert.match(
    desktopSwitch,
    /aria-pressed=\{shownDayMode\(group, allowHalfDays\) === mode\}/,
    "each of its buttons reports whether its mode is the one in force",
  );
}

// ---------------------------------------------------------------------------------------------
// The Full day / AM / PM / AM-PM-split switch (setDayMode in the plans workspace).
//
// PR #6087 let a Group Product Manager plan a day as "PM only". Switching that day back to
// "AM / PM" then used the lone PM row for BOTH halves: two rows shared one key, the AM side was a
// clone of the PM row's content, and updateRow / deleteRow (which match by key) edited and deleted
// both at once.
// ---------------------------------------------------------------------------------------------

type EditorRow = DayModeRow & { label: string };

let freshRows = 0;
function makeFreshRow(slot: "am" | "pm"): EditorRow {
  freshRows += 1;
  return {
    activityDate: DAY,
    key: `fresh-${slot}-${freshRows}`,
    label: `fresh ${slot}`,
    notes: "",
    slot,
  };
}

function switchDay(rows: readonly EditorRow[], mode: DayModeTarget): EditorRow[] {
  return planDayRowsForMode(rows, mode, makeFreshRow);
}

function assertUniqueKeys(rows: readonly EditorRow[], message: string) {
  assert.equal(
    new Set(rows.map((row) => row.key)).size,
    rows.length,
    `${message}: row keys must be unique (${rows.map((row) => row.key).join(", ")})`,
  );
}

function slotsOf(rows: readonly EditorRow[]) {
  return rows.map((row) => row.slot).sort();
}

function runDayModeTransitionTests() {
  const fullRow: EditorRow = { activityDate: DAY, key: "k-full", label: "full content", notes: "", slot: "full" };
  const amRow: EditorRow = { activityDate: DAY, key: "k-am", label: "am content", notes: "", slot: "am" };
  const pmRow: EditorRow = { activityDate: DAY, key: "k-pm", label: "pm content", notes: "", slot: "pm" };

  // Headline: PM only -> AM / PM. The PM row stays the PM row; the morning is a NEW row.
  const pmToSplit = switchDay([pmRow], "split");
  assert.deepEqual(slotsOf(pmToSplit), ["am", "pm"], "PM only -> AM / PM must hold a morning and an afternoon");
  assertUniqueKeys(pmToSplit, "PM only -> AM / PM");
  const keptPm = pmToSplit.find((row) => row.slot === "pm");
  assert.equal(keptPm?.key, "k-pm", "the afternoon keeps the PM row the planner filled in");
  assert.equal(keptPm?.label, "pm content");
  const newAm = pmToSplit.find((row) => row.slot === "am");
  assert.notEqual(newAm?.key, "k-pm", "the morning must not reuse the PM row's key");
  assert.notEqual(newAm?.label, "pm content", "the morning must not be a clone of the PM row's content");

  // The intended full day -> split path: the full day's content moves into the morning.
  const fullToSplit = switchDay([fullRow], "split");
  assert.deepEqual(slotsOf(fullToSplit), ["am", "pm"]);
  assertUniqueKeys(fullToSplit, "Full day -> AM / PM");
  assert.equal(fullToSplit.find((row) => row.slot === "am")?.key, "k-full", "the full day's row becomes the morning");
  assert.equal(fullToSplit.find((row) => row.slot === "am")?.label, "full content");
  assert.equal(fullToSplit.find((row) => row.slot === "pm")?.label, "fresh pm");

  // AM only -> split keeps the morning and adds a fresh afternoon.
  const amToSplit = switchDay([amRow], "split");
  assert.deepEqual(slotsOf(amToSplit), ["am", "pm"]);
  assertUniqueKeys(amToSplit, "AM only -> AM / PM");
  assert.equal(amToSplit.find((row) => row.slot === "am")?.key, "k-am");

  // A split day switched to split again is left as it is.
  const splitAgain = switchDay([amRow, pmRow], "split");
  assert.deepEqual(splitAgain.map((row) => row.key), ["k-am", "k-pm"]);

  // split -> AM only / PM only keep THAT half's row and drop the other.
  assert.deepEqual(switchDay([amRow, pmRow], "am").map((row) => `${row.slot}:${row.key}`), ["am:k-am"]);
  assert.deepEqual(switchDay([amRow, pmRow], "pm").map((row) => `${row.slot}:${row.key}`), ["pm:k-pm"]);

  // split -> full keeps the first (morning) row as the one full-day row, with no clock times.
  const splitToFull = switchDay([{ ...amRow, endTime: "13:00", startTime: "09:00" }, pmRow], "full");
  assert.deepEqual(splitToFull.map((row) => `${row.slot}:${row.key}`), ["full:k-am"]);
  assert.equal(splitToFull[0]?.startTime, "", "a full day carries no AM start time");
  assert.equal(splitToFull[0]?.endTime, "", "a full day carries no AM end time");

  // AM only <-> PM only re-slots the one row in place.
  assert.deepEqual(switchDay([amRow], "pm").map((row) => `${row.slot}:${row.key}`), ["pm:k-am"]);
  assert.deepEqual(switchDay([pmRow], "am").map((row) => `${row.slot}:${row.key}`), ["am:k-pm"]);

  // The day's note rides on the first row only, whatever the switch.
  const noted = switchDay([{ ...amRow }, { ...pmRow, notes: "see the pharmacy first" }], "split");
  assert.equal(noted.find((row) => row.slot === "am")?.notes, "see the pharmacy first", "the note moves to the morning row");
  assert.equal(noted.find((row) => row.slot === "pm")?.notes, "", "and is not repeated on the afternoon row");
  assert.equal(switchDay([{ ...amRow }, { ...pmRow, notes: "keep me" }], "pm")[0]?.notes, "keep me");

  // An empty day yields nothing to write.
  assert.deepEqual(switchDay([], "split"), []);

  // Every path, one after another, as a planner clicking through the buttons would take them:
  // keys stay unique and the slots always match the mode.
  const modes: DayModeTarget[] = ["pm", "split", "pm", "full", "split", "am", "split", "pm", "am", "full", "split"];
  for (const start of [fullRow, amRow, pmRow]) {
    let rows: EditorRow[] = [start];
    for (const mode of modes) {
      rows = switchDay(rows, mode);
      assertUniqueKeys(rows, `${start.slot} then ${mode}`);
      assert.deepEqual(
        slotsOf(rows),
        mode === "split" ? ["am", "pm"] : [mode],
        `${start.slot} then ${mode}: wrong slots (${slotsOf(rows).join(",")})`,
      );
    }
  }
}

function runNextFreePlanDayTests() {
  // "Add day" on a fresh plan: the Field Force week Saturday to Thursday holds six period days.
  const week = ["2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"];
  assert.equal(nextFreePlanDay(week, []), "2026-10-17", "the first unused period day comes first");
  assert.equal(nextFreePlanDay(week, ["2026-10-17", "2026-10-19"]), "2026-10-18", "gaps are filled in order");
  assert.equal(
    nextFreePlanDay(week, week),
    null,
    "every period day used: there is no day to add - the old fallback (the day after the last row) was outside the period and the server rejects it",
  );
  assert.equal(
    nextFreePlanDay(week, new Set([...week, "2026-10-23"])),
    null,
    "a row beyond the period never frees a day",
  );
  assert.equal(
    nextFreePlanDay(week, ["2026-10-23", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21"]),
    "2026-10-22",
    "a row OUTSIDE the period does not use up one inside it",
  );
}
