import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  lineIdAfterAreaPick,
  operatingAreaOptions,
} from "../src/lib/employees/area-line-options.ts";

// The Employee Master "Operating Area" picker narrowed `lookups.areas` by the chosen business line.
// #4977 admitted the 49 live areas carrying `line_id` NULL, which unblocked the owner's Pedia hire
// into Beni Suef. This is the other half: the 11 surviving line-tagged rows are shared across lines
// too, in live production data, so the column can correctly hide NOTHING.
//
// Measured 2026-09-30: 16 active managers sit on a line-tagged area whose `line_id` names a
// DIFFERENT line. The picker hid each of those rows from the very line whose manager is on it, and
// the area's own `line_id` then overwrote the chosen line on select — so a Pedia district manager
// picked "Upper Egypt 1" and the form silently became Anti Infective.

// The real production rows, with `line_id` exactly as production carries it.
const PRODUCTION_AREAS = [
  { label: "Beni Suef", lineId: null, value: "1145" },
  { label: "Minia 1", lineId: null, value: "1123" },
  { label: "Sohag1", lineId: null, value: "1127" },
  { label: "Cairo", lineId: 2, value: "1" },
  { label: "Egypt", lineId: 2, value: "42" },
  { label: "Upper Egypt 1", lineId: 1, value: "1149" },
  { label: "Head office", lineId: 4, value: "80" },
];

const PEDIA = "2";
const ANTI_INFECTIVE = "1";

export async function runEmployeeAreaLineOptionsTests() {
  // The headline assertion: whatever line is chosen, every area is still offered.
  for (const line of [PEDIA, ANTI_INFECTIVE, "3", "4", "", null, undefined]) {
    assert.deepEqual(
      operatingAreaOptions(PRODUCTION_AREAS).map((option) => option.label),
      ["Beni Suef", "Minia 1", "Sohag1", "Cairo", "Egypt", "Upper Egypt 1", "Head office"],
      `every operating area must stay on offer — line ${JSON.stringify(line)} may hide none of them`,
    );
  }

  // The two rows that each half of this fix was about.
  const offered = operatingAreaOptions(PRODUCTION_AREAS).map((option) => option.label);
  assert.ok(
    offered.includes("Beni Suef"),
    "a line-agnostic area stays offered — the row the owner could not pick (#4977)",
  );
  assert.ok(
    offered.includes("Upper Egypt 1"),
    "a line-TAGGED district row stays offered too — PD-0014 (Pedia) sits on Anti Infective's Upper Egypt 1",
  );

  // It returns a copy, so a caller cannot reorder or empty the lookup itself.
  const source = [{ lineId: null }, { lineId: 2 }];
  const returned = operatingAreaOptions(source);
  returned.length = 0;
  assert.equal(source.length, 2, "the options list must be a copy, never the lookup array itself");

  // An area's own line FILLS an empty line and never overwrites a chosen one.
  assert.equal(
    lineIdAfterAreaPick({ lineId: 1 }, PEDIA),
    PEDIA,
    "the headline assertion: picking Anti Infective's Upper Egypt 1 must NOT flip a Pedia hire to Anti Infective",
  );
  assert.equal(
    lineIdAfterAreaPick({ lineId: 1 }, ""),
    "1",
    "with no line chosen yet, the area's own line fills it",
  );
  assert.equal(
    lineIdAfterAreaPick({ lineId: null }, ""),
    "",
    "a line-agnostic area fills nothing, and must not write the string 'null'",
  );
  assert.equal(
    lineIdAfterAreaPick({ lineId: undefined }, ""),
    "",
    "nor the string 'undefined' — that was the shape of the original bug",
  );
  assert.equal(
    lineIdAfterAreaPick(undefined, PEDIA),
    PEDIA,
    "an unknown area leaves the chosen line alone",
  );
  assert.equal(
    lineIdAfterAreaPick({ lineId: " 1 " }, ""),
    "1",
    "padding around the area's line is trimmed before it is stored",
  );

  // The picker must read the helpers, and must not grow a line filter again.
  const componentSource = fs.readFileSync(
    path.join(process.cwd(), "src/components/employees/employee-management.tsx"),
    "utf8",
  );
  assert.ok(
    componentSource.includes("operatingAreaOptions(lookups.areas)"),
    "the Operating Area picker must build its options through operatingAreaOptions",
  );
  assert.ok(
    componentSource.includes("lineIdAfterAreaPick(selectedArea, prev.lineId)"),
    "selecting an area must resolve the line through lineIdAfterAreaPick",
  );
  assert.ok(
    !/lookups\.areas\.filter\(/.test(componentSource),
    "a hand-rolled lookups.areas.filter is the bug — `areas.line_id` can correctly hide nothing",
  );
  assert.ok(
    !/lineId\s*:\s*String\(\s*selectedArea\.lineId/.test(componentSource),
    "the area's own lineId must never be written straight over the chosen line",
  );
}
