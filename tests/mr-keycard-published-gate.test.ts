import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  groupAchievementByEmployee,
  publishedPointsOnly,
  uploadedPointsOnly,
} from "../src/lib/sales/employee-achievement.ts";
import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE MR OVERVIEW ACHIEVEMENT KEYCARD SHOWS THE LATEST PUBLISHED CLOSING — NEVER AN UNFINISHED MONTH.
//
// Owner ruling, 2026-08-13, restated 2026-09-29 (on B-158 Hassan Elsherbiny, a Pedia rep whose card
// read "No sales uploaded" while his August closing was long published): the keycard changes ONLY
// when the next month's Monthly Closing is PUBLISHED. Until then the current month is not considered.
//
// The bug this pins: the card used to gate on `uploaded` — a distributor import batch existed for the
// period. But an approved Direct Order writes into Source of Sales under the `DirectReq`
// pseudo-distributor one order at a time, all month long, so a single September direct order made
// September look "uploaded" and pulled the unfinished, unpublished month onto the card. On 2026-09-28
// production had exactly that: September's only import batch was `DirectReq`, no distributor files,
// and August's Pedia closing was published on 2026-09-10.
//
// The fix routes the card through `published` (per the row's own line, via isRowPublished) instead of
// `uploaded`. This test proves the two gates DISAGREE on exactly the month that matters, so the fix
// cannot silently regress back to the uploaded gate — both are Set<string>-shaped and a swap is
// invisible to the type checker.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One Pedia achievement row for a rep, with only the fields the grouping/totalling read set. */
function pediaRow(period: string, overrides: Partial<AchievementRow> = {}): AchievementRow {
  return {
    period,
    lineCode: "pedia",
    regionCode: "delta_1",
    areaCode: "D14",
    areaState: "occupied",
    isOther: false,
    repSeatId: "SEAT-PED-REP-D14",
    repHrId: "B-158",
    dmSeatId: "SEAT-PED-DM-DELTA1",
    dmHrId: "B-200",
    productCode: "LA001",
    actualUnits: 100,
    actualValue: 250_000,
    targetUnits: 120,
    targetValue: 200_000,
    achievementValue: 1.25,
    achievementUnits: 100 / 120,
    hasTarget: true,
    hasActual: true,
    ...overrides,
  };
}

export async function runMrKeycardPublishedGateTests() {
  // July + August published for Pedia; September is NOT published — it exists only because a single
  // DirectReq order landed (uploaded ledger has it, publication ledger does not).
  const rows: AchievementRow[] = [
    pediaRow("2026-07"),
    pediaRow("2026-08"),
    // September: a lone direct order, no target loaded yet — the unfinished current month.
    pediaRow("2026-09", { actualValue: 115_632, actualUnits: 40, targetValue: null, targetUnits: null, achievementValue: null, hasTarget: false }),
  ];

  const uploadedPeriods = new Set(["2026-07", "2026-08", "2026-09"]); // DirectReq makes Sep "uploaded"
  const publishedKeys = new Set(["pedia|2026-07", "pedia|2026-08"]); // …but Sep is NOT published

  const points = groupAchievementByEmployee(rows, ["B-158"], uploadedPeriods, publishedKeys, "rep").get("B-158");
  assert.ok(points, "the rep has grouped points");

  const byPeriod = new Map(points!.map((point) => [point.period, point]));

  // The heart of it: September is uploaded but NOT published. July and August are both.
  assert.equal(byPeriod.get("2026-09")!.uploaded, true, "September's DirectReq order makes it 'uploaded'");
  assert.equal(byPeriod.get("2026-09")!.published, false, "September has no published closing, so it is NOT 'published'");
  assert.equal(byPeriod.get("2026-08")!.published, true, "August's closing is published");
  assert.equal(byPeriod.get("2026-07")!.published, true, "July's closing is published");

  // The card gates on publishedPointsOnly → the unfinished September is excluded; August survives.
  const published = publishedPointsOnly(points!).map((point) => point.period).sort();
  assert.deepEqual(published, ["2026-07", "2026-08"], "the card sees only the published months");

  // The current Cairo month (September) is not among them, so the card's `current` resolves to null
  // and it falls back to the latest published month — August — exactly the owner's rule.
  assert.equal(
    publishedPointsOnly(points!).some((point) => point.period === "2026-09"),
    false,
    "the current month never surfaces on the card until its closing is published",
  );

  // The OLD gate is the regression: uploadedPointsOnly WOULD have surfaced the unfinished September.
  const uploaded = uploadedPointsOnly(points!).map((point) => point.period).sort();
  assert.deepEqual(
    uploaded,
    ["2026-07", "2026-08", "2026-09"],
    "the retired 'uploaded' gate let the unfinished month through — this is what the fix removed",
  );

  // The publication gate is per LINE: a closing published on a DIFFERENT line must not publish a
  // Pedia row. Otherwise a CNS September publication would light up every Pedia rep's September.
  const wrongLineKeys = new Set(["cns|2026-08", "cns|2026-07"]);
  const wrongLine = groupAchievementByEmployee(rows, ["B-158"], uploadedPeriods, wrongLineKeys, "rep").get("B-158");
  assert.equal(
    publishedPointsOnly(wrongLine!).length,
    0,
    "a closing published on another line never marks this line's months as published",
  );

  // A row with no resolved line can never be published — fail safe, never fail open.
  const noLine = groupAchievementByEmployee(
    [pediaRow("2026-08", { lineCode: null })],
    ["B-158"],
    uploadedPeriods,
    publishedKeys,
    "rep",
  ).get("B-158");
  assert.equal(noLine!.every((point) => point.published === false), true, "a line-less row is never 'published'");

  // Pin the WIRING, not only the mechanism: the MR home snapshot is the sole caller and must gate on
  // the published set. A silent revert to `uploadedPointsOnly` would re-open the exact bug, and the
  // pure assertions above cannot see the caller — so guard it at the import.
  const snapshotSource = readFileSync(
    fileURLToPath(new URL("../src/lib/employee-portal/home-snapshot.ts", import.meta.url)),
    "utf8",
  );
  assert.match(
    snapshotSource,
    /publishedPointsOnly/,
    "home-snapshot's MR keycard loader must use publishedPointsOnly",
  );
  assert.doesNotMatch(
    snapshotSource,
    /uploadedPointsOnly/,
    "home-snapshot must NOT gate the MR keycard on the retired 'uploaded' signal",
  );
}
