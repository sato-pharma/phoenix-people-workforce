import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { recommendAdditions, type PopulationMember } from "../src/lib/automated-payroll/recommend.ts";
import {
  isStandingAdditionDue,
  standingAdditionsByCompact,
  type StandingAddition,
} from "../src/lib/automated-payroll/standing-additions.ts";
import type { DraftRow } from "../src/lib/automated-payroll/types.ts";

/**
 * A QUARTERLY INCENTIVE IS NOT LEFT TO MEMORY.
 *
 * Owner request 2026-09-13. An employee owed 60,000 EGP every three months was paid it in February
 * and May 2026 because somebody typed it into Part 2's Additions step, and not in August, because
 * nobody did: the August run published with his incentive at 0. Additions was the one money step
 * with no feeder behind it.
 *
 * The owner's ruling on the miss: August's instalment is paid ONCE with September as an exception,
 * and the cadence then returns to normal — November, February, May, August.
 *
 * What is pinned here is the RECOMMENDATION, not a payment: HR still confirms the step, and a value
 * HR saved on the draft row always wins.
 */

const QUARTERLY: StandingAddition = {
  employeeHrIdCompact: "A12",
  field: "incentive",
  amount: 60_000,
  everyMonths: 3,
  firstMonthKey: "2026-11",
  lastMonthKey: null,
  reason: "Quarterly incentive, 60,000 EGP every 3 months (Nov, Feb, May, Aug)",
  active: true,
};

const AUGUST_EXCEPTION: StandingAddition = {
  employeeHrIdCompact: "A12",
  field: "incentive",
  amount: 60_000,
  everyMonths: null,
  firstMonthKey: "2026-09",
  lastMonthKey: "2026-09",
  reason: "August 2026 quarterly incentive, missed in August and paid with September as a one-time exception",
  active: true,
};

const p = (year: number, month: number) => ({ year, month });

function member(hrId: string, compact: string): PopulationMember {
  return {
    employee: { hrId, fullName: "Test Person", jobTitle: "National Sales Manager", lineName: null, hireDate: "2025-09-01" },
    compact,
    lifecycle: "continuing",
    lastWorkingDate: null,
    noticeLastWorkingDate: null,
  } as unknown as PopulationMember;
}

export async function runAutomatedPayrollStandingAdditionsTests() {
  const entries = [QUARTERLY, AUGUST_EXCEPTION];
  const dueIn = (year: number, month: number) => standingAdditionsByCompact(entries, p(year, month)).get("A12");

  // ---- HEADLINE: the owner's calendar, month by month ----------------------------------------------
  assert.equal(dueIn(2026, 9)?.incentive, 60_000, "September carries August's missed instalment — the one exception");
  assert.equal(dueIn(2026, 10), undefined, "October owes nothing: the exception does not shift the cadence");
  assert.equal(dueIn(2026, 11)?.incentive, 60_000, "November is the regular quarterly instalment");
  assert.equal(dueIn(2026, 12), undefined);
  assert.equal(dueIn(2027, 1), undefined);
  assert.equal(dueIn(2027, 2)?.incentive, 60_000, "February");
  assert.equal(dueIn(2027, 5)?.incentive, 60_000, "May");
  assert.equal(dueIn(2027, 8)?.incentive, 60_000, "August");
  assert.equal(dueIn(2027, 9), undefined, "and the exception never repeats — next September owes nothing");
  assert.equal(dueIn(2026, 8), undefined, "a published month can never read as owing it");

  // Never doubled: September is not a quarterly month, so only the exception is due there.
  assert.equal(dueIn(2026, 9)?.incentive, 60_000);
  assert.match(dueIn(2026, 9)?.reason ?? "", /August 2026/, "and it says which instalment it is");

  // ---- The rule's edges ----------------------------------------------------------------------------
  assert.equal(isStandingAdditionDue({ ...QUARTERLY, active: false }, p(2026, 11)), false, "an inactive entry is never due");
  assert.equal(isStandingAdditionDue({ ...QUARTERLY, lastMonthKey: "2027-02" }, p(2027, 5)), false, "nothing after its last month");
  assert.equal(isStandingAdditionDue({ ...QUARTERLY, firstMonthKey: "bad" }, p(2026, 11)), false, "a malformed month is never due");
  const twoEntries = standingAdditionsByCompact(
    [AUGUST_EXCEPTION, { ...AUGUST_EXCEPTION, field: "bonus", amount: 1_000, reason: "Other" }],
    p(2026, 9),
  ).get("A12");
  assert.deepEqual(twoEntries, { incentive: 60_000, bonus: 1_000, reason: `${AUGUST_EXCEPTION.reason}; Other` });

  // ---- The Additions step pre-fills it, with its reason ---------------------------------------------
  const standing = standingAdditionsByCompact(entries, p(2026, 9));
  const [prefilled, untouched] = recommendAdditions(
    [member("A-12", "A12"), member("B-1", "B1")],
    new Map(),
    standing,
  );
  assert.equal(prefilled?.values.incentive, 60_000, "the grid shows the amount due, not zero");
  assert.equal(prefilled?.recommended.incentive, 60_000);
  assert.match(prefilled?.reason ?? "", /August 2026/, "with the reason, so the confirm rule is satisfied honestly");
  assert.equal(untouched?.values.incentive, 0, "everyone else still starts at zero");
  assert.equal(untouched?.reason, null);

  // ---- HR's saved value wins ------------------------------------------------------------------------
  const saved = new Map<string, DraftRow>([
    ["A12", { employeeHrIdCompact: "A12", incentive: 0, bonus: 0, overtime: 0, additionsReason: null } as DraftRow],
  ]);
  const [overridden] = recommendAdditions([member("A-12", "A12")], saved, standing);
  assert.equal(overridden?.values.incentive, 0, "a figure HR saved is never overwritten by the register");
  assert.equal(overridden?.recommended.incentive, 60_000, "but the recommendation still shows what was due");
  assert.equal(overridden?.reason, null, "and a reason written for 60,000 is not attached to HR's different figure");

  // ---- Wiring: the step actually reads the register --------------------------------------------------
  const recommend = readFileSync("src/lib/automated-payroll/recommend.ts", "utf8");
  assert.match(
    recommend,
    /case "p2_additions":\s*return recommendAdditions\(input\.members, drafts, await loadStandingAdditions\(input\.period\), await loadDisputeRefunds\(input\.period\)\);/,
    "without this the register exists and nothing ever reads it",
  );

  // ---- The owner's two entries ship with the table ----------------------------------------------------
  const migration = readFileSync(
    "supabase/migrations/20260913010000_automated_payroll_standing_additions.sql",
    "utf8",
  );
  assert.match(migration, /'A12', 'incentive', 60000, 3, '2026-11'/, "the quarterly entry, anchored on November");
  assert.match(migration, /'A12', 'incentive', 60000, null, '2026-09', '2026-09'/, "the one-off September exception");
}
