import assert from "node:assert/strict";

import { placeSourcedPlanRow, planSlotsOverlap } from "../src/lib/weekly-planning/plan-slot-merge.ts";

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
}
