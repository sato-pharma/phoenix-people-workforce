import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { stripComments } from "./support/comment-strip.ts";

/**
 * 🔴 FOR AN OUTSTATION CLAIM, `matched` IS THE EXCEPTION AND `outside_expected_territory` IS THE
 * NORMAL CASE. Owner's decision, 2026-09-28. Everything in this file is that one sentence, applied
 * at each of the four places the status is read.
 *
 * `validateTerritory` returns `matched` when the captured destination's area EQUALS the employee's
 * assigned area. An outstation trip is by definition a trip OUTSIDE that area — that is what the
 * word means and what the allowance pays for. So a `matched` result means somebody claimed an
 * outstation allowance for travel inside their own territory, which is the case worth a look, and
 * `outside_expected_territory` is what a legitimate claim looks like.
 *
 * WHAT IT WAS BEFORE, MEASURED ON PRODUCTION: across all 153 outstation requests ever recorded the
 * status was `outside_expected_territory` (80.4%) or `not_available` (19.6%) and NEVER `matched`.
 * So the review branch fired on 100% of requests, `auto_approve` had never once been reached in the
 * system's history, and every request carried an amber territory badge. A flag that is on for every
 * row tells the approver nothing — and these 56 sit in front of a money decision.
 *
 * 🔴 AND THE EMPLOYEE 360 COMPARISON WAS AGAINST A STRING THAT IS NOT IN THE UNION. It read
 * `!== "valid"`, but the three values are `matched` / `outside_expected_territory` /
 * `not_available` and no row is null — so `flaggedCount` counted 153 of 153 trips, for every
 * employee, always. Correcting the string alone would not have helped: `!== "matched"` still flags
 * ~100%. The string was wrong AND the semantic was inverted; only the second one mattered.
 *
 * These rules live in unexported functions, so this drives the source. That is the weaker form and
 * it is used deliberately rather than exporting internals for a test to reach.
 */

const repoRoot = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => stripComments(readFileSync(path.join(repoRoot, rel), "utf8"));

const SERVICE = "src/lib/outstation/service.ts";
const DEEP = "src/lib/employee-360/deep-service.ts";
const PANEL = "src/components/outstation/territory-validation-panel.tsx";
const TYPES = "src/lib/outstation/types.ts";

export function runOutstationTerritoryFlagIsInvertedTests() {
  // 1 — the union still holds exactly three values, so a fourth cannot appear unnoticed and leave
  //     every branch below reading a case nobody considered.
  {
    const types = read(TYPES);
    const union = types.slice(types.indexOf("export type OutstationTerritoryValidationStatus"));
    const block = union.slice(0, union.indexOf(";") + 1);
    for (const value of ["matched", "outside_expected_territory", "not_available"]) {
      assert.ok(block.includes(`"${value}"`), `OutstationTerritoryValidationStatus lost "${value}"`);
    }
    assert.equal(
      (block.match(/"/g) ?? []).length / 2,
      3,
      "the union must hold exactly three values — a new one needs a decision at each of the four " +
        "read sites this file pins, not a default",
    );
  }

  // 2 — the approval recommendation branches on `matched`, never on `outside_expected_territory`.
  {
    const service = read(SERVICE);
    const start = service.indexOf('params.eligibilityStatus === "needs_review"');
    assert.ok(start > 0, `${SERVICE}: the recommendation branch could not be located.`);
    const branch = service.slice(start, start + 700);

    assert.match(
      branch,
      /params\.territoryValidationStatus === "matched"/,
      `${SERVICE}: the manager-review branch must fire on "matched". An outstation trip is BY ` +
        "DEFINITION outside the employee's area, so branching on outside_expected_territory fired " +
        "on all 153 requests ever filed and auto_approve was never once reached.",
    );
    assert.doesNotMatch(
      branch,
      /params\.territoryValidationStatus === "outside_expected_territory"/,
      `${SERVICE}: branching on outside_expected_territory is the tautology this change removed`,
    );
  }

  // 3 — Employee 360 flags `matched`, and never compares against a string outside the union.
  {
    const deep = read(DEEP);
    assert.match(
      deep,
      /territoryIssue = o\.territory_validation_status === "matched"/,
      `${DEEP}: the territory issue is a "matched" status — a claim for travel inside the ` +
        "employee's own area",
    );
    assert.doesNotMatch(
      deep,
      /territory_validation_status !== "valid"/,
      `${DEEP}: "valid" is not one of the three values this column can hold, so that comparison was ` +
        "true for every row and counted 153 of 153 trips as flagged",
    );
    assert.doesNotMatch(
      deep,
      /territory_validation_status\s*[!=]==\s*"(?!matched")/,
      `${DEEP}: this column may only ever be compared against a member of its own union`,
    );
  }

  // 4 — the badge colours follow the meaning, not the words.
  {
    const panel = read(PANEL);
    const outsideAt = panel.indexOf('status === "outside_expected_territory"');
    const matchedAt = panel.indexOf('status === "matched"');
    assert.ok(outsideAt > 0 && matchedAt > 0, `${PANEL}: both branches must be present.`);

    const outsideLine = panel.slice(outsideAt, panel.indexOf("\n", outsideAt));
    const matchedLine = panel.slice(matchedAt, panel.indexOf("\n", matchedAt));
    assert.match(
      outsideLine,
      /emerald/,
      `${PANEL}: outside_expected_territory is what a LEGITIMATE outstation trip looks like and must ` +
        "read green. Amber on every request ever filed is not a warning, it is wallpaper.",
    );
    assert.match(
      matchedLine,
      /amber/,
      `${PANEL}: matched means the destination was inside the employee's own area — no out-of-station ` +
        "travel to pay for — and that is the one worth a second look",
    );
  }
}
