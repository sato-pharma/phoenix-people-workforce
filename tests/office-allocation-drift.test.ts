import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  diffOfficeAllocation,
  type OfficeAllocationCell,
} from "../src/lib/sales/office-allocation-drift.ts";

// The detector's whole reason to exist is that the EXISTING check cannot see this class of change:
// the Office spread is unit-preserving per line, so the publication drift check — one total per
// line — reads clean while thousands of units sit in the wrong area. Every assertion below is built
// around that one fact. Measured on production 2026-10-09: August 2026 CNS moves 3,698 of 109,719
// Office units (3.37%) between SIBLING areas, because seven distributor batches were re-mapped on
// 13–14 Sep after the Office commit of 10 Sep.

function cell(lineCode: string, areaCode: string, units: number): OfficeAllocationCell {
  return { areaCode, lineCode, units };
}

export function runOfficeAllocationDriftTests() {
  // ── 1. THE REGRESSION: a drift a units-only check is structurally blind to ───────────────────
  // Both sides total 10,000 CNS units, so `monthly_closing_locks.snapshot_units` is identical and
  // the publication drift check reports nothing. 1,000 units have still moved Sohag1 → Sohag2.
  const stored = [cell("CNS", "UE5", 6000), cell("CNS", "UE6", 1000), cell("CNS", "D15", 3000)];
  const todays = [cell("CNS", "UE5", 5000), cell("CNS", "UE6", 2000), cell("CNS", "D15", 3000)];
  const report = diffOfficeAllocation({ period: "2026-08", stored, todays });

  assert.equal(report.drifted, true, "a geographic drift must be reported as drift");
  assert.equal(
    report.lineUnitTotalsAgree,
    true,
    "the line total is identical on both sides — this is exactly why the units-based publication check cannot see it",
  );
  assert.equal(
    report.unitsThatWouldMove,
    1000,
    "1,000 units change area, counted ONCE: a Σ|delta| of 2,000 would double-count every mover against its counterpart",
  );
  assert.equal(report.lines.length, 1, "one line drifted");
  assert.equal(report.lines[0]?.lineCode, "CNS");
  assert.equal(report.lines[0]?.officeUnits, 10000, "the line's Office units are the stored total");
  assert.equal(
    Math.round((report.lines[0]?.percentOfOfficeUnits ?? 0) * 100) / 100,
    10,
    "1,000 of 10,000 units is 10% of the line's Office units",
  );

  // Only the areas that disagree, biggest movement first — an unchanged area is not a finding.
  assert.deepEqual(
    report.lines[0]?.areas.map((a) => [a.areaCode, a.unitsDelta]),
    [
      ["UE5", -1000],
      ["UE6", 1000],
    ],
    "the two movers, biggest absolute movement first, and NOT the area that did not move",
  );

  // ── 2. AN AREA THAT LOST ALL OF ITS OFFICE UNITS IS THE BIGGEST MOVEMENT, NOT A MISSING KEY ──
  // A side may simply not have the area. Reading that as "skip" would hide the largest drift there
  // is, which is the one shape a cell-by-cell join loses.
  const vanished = diffOfficeAllocation({
    period: "2026-08",
    stored: [cell("CNS", "UE5", 500), cell("CNS", "UE6", 500)],
    todays: [cell("CNS", "UE6", 1000)],
  });
  assert.equal(vanished.unitsThatWouldMove, 500, "500 units leave UE5 entirely");
  assert.deepEqual(
    vanished.lines[0]?.areas.map((a) => [a.areaCode, a.storedUnits, a.todaysUnits]),
    [
      ["UE5", 500, 0],
      ["UE6", 500, 1000],
    ],
    "an area present on only one side is compared against zero, never dropped",
  );

  // ── 3. EACH LINE IS ITS OWN SUBJECT ─────────────────────────────────────────────────────────
  // One Office file carries every line at once and the rule builds one share set PER LINE, so a
  // clean line must not be dragged into a dirty line's figure, and the lines sort by movement.
  const twoLines = diffOfficeAllocation({
    period: "2026-08",
    stored: [cell("CNS", "UE5", 1000), cell("CNS", "UE6", 0), cell("Pedia", "CA5", 400)],
    todays: [cell("CNS", "UE5", 900), cell("CNS", "UE6", 100), cell("Pedia", "CA5", 400)],
  });
  assert.deepEqual(
    twoLines.lines.map((l) => l.lineCode),
    ["CNS"],
    "Pedia agrees to the unit, so it is not a drifted line at all",
  );
  assert.equal(twoLines.unitsThatWouldMove, 100);

  // ── 4. FLOAT NOISE FROM THE SHARE ARITHMETIC IS NOT A MOVEMENT ──────────────────────────────
  // Today's side is a product of shares, so it lands on fractions. A detector that fired on 0.2 of
  // a unit would be non-empty for every month on record and would be read as wallpaper.
  const noise = diffOfficeAllocation({
    period: "2026-08",
    stored: [cell("CNS", "UE5", 1000), cell("CNS", "UE6", 1000)],
    todays: [cell("CNS", "UE5", 1000.2), cell("CNS", "UE6", 999.8)],
  });
  assert.equal(noise.drifted, false, "0.2 of a unit is the share arithmetic, not a drift");
  assert.deepEqual(noise.lines, [], "and it names no area");

  // ── 5. A MONTH WHOSE BASE NEVER MOVED REPORTS NOTHING, AND SAYS SO POSITIVELY ────────────────
  const clean = diffOfficeAllocation({
    period: "2026-09",
    stored: [cell("CNS", "UE5", 1000)],
    todays: [cell("CNS", "UE5", 1000)],
    officeCommittedAt: "2026-10-05T17:15:00.000Z",
    baseTouchedAfterCommit: [],
  });
  assert.equal(clean.drifted, false);
  assert.equal(clean.unitsThatWouldMove, 0);
  assert.equal(clean.officeCommittedAt, "2026-10-05T17:15:00.000Z", "the commit instant is carried for the report");

  // ── 6. THE CAUSE TRAVELS WITH THE SYMPTOM ───────────────────────────────────────────────────
  // The magnitude says how bad it is; the batch list says WHY, and it is the half an operator can
  // act on for the next month. It must survive into the report unchanged.
  const withCause = diffOfficeAllocation({
    period: "2026-08",
    stored,
    todays,
    officeCommittedAt: "2026-09-10T17:15:00.000Z",
    baseTouchedAfterCommit: [
      { distributorCode: "PS", distributorName: "overseas", updatedAt: "2026-09-13T20:47:00.000Z" },
      { distributorCode: "IS", distributorName: "Ibn sina", updatedAt: "2026-09-13T20:47:00.000Z" },
    ],
  });
  assert.deepEqual(
    withCause.baseTouchedAfterCommit.map((b) => b.distributorCode),
    ["PS", "IS"],
    "the batches re-touched after the commit are named in the report",
  );

  // ── 7. AND THE CLI PRINTS THOSE NAMES, NEVER THE CODES ──────────────────────────────────────
  // The owner's standing rule is names in chat and in UI, and a CLI a session reads from is both.
  // `baseTouchedAfterCommit` already substitutes the code where a distributor has no name, so the
  // script has nothing to decide — yet it printed `IS-T, RM-T, SF, IS, RM, EG, EG-BR, PS` on
  // 2026-10-09 and eight codes had to be translated by hand before September could be reported.
  // Source-read deliberately: running that script needs production credentials.
  {
    const cli = readFileSync("scripts/check-office-allocation-drift.ts", "utf8");
    assert.ok(
      cli.includes("batch.distributorName"),
      "the drift CLI must print the distributor NAME in its base-moved line",
    );
    assert.ok(
      !cli.includes("batch.distributorCode"),
      "and must not fall back to a raw distributor code anywhere — names, never codes",
    );
  }

  console.log(
    `  office allocation drift: ${report.unitsThatWouldMove} units move on a line total that is identical on both sides`,
  );
}
