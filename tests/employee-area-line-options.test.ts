import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  areaBelongsToLine,
  filterAreaOptionsForLine,
} from "../src/lib/employees/area-line-options.ts";

// The Employee Master "Operating Area" picker filtered `lookups.areas` on
// `String(a.lineId) === String(form.lineId)`, and 49 of production's 60 live `public.areas` rows
// carry `line_id` NULL -- one area id per territory, shared by every line's field force. Picking a
// business line therefore emptied the list down to the 11 legacy line-tagged rows, and the owner
// could not hire a Pedia rep into Beni Suef (UE9, Upper Egypt 1) because the area was not offered
// at all, even though the seat, the open vacancy and the au region mapping were all in place.

const PRODUCTION_AREAS = [
  // The live shape: an area id held by every line, no line of its own.
  { label: "Beni Suef", lineId: null, value: "1145" },
  { label: "Minia 1", lineId: null, value: "1123" },
  { label: "Sohag1", lineId: null, value: "1127" },
  // The 11 surviving line-tagged rows, which ARE per-line and must stay per-line.
  { label: "Cairo", lineId: 2, value: "1" },
  { label: "Egypt", lineId: 2, value: "42" },
  { label: "Upper Egypt 1", lineId: 1, value: "1149" },
  { label: "Head office", lineId: 4, value: "80" },
];

const PEDIA_LINE_ID = "2";

export async function runEmployeeAreaLineOptionsTests() {
  const pediaOptions = filterAreaOptionsForLine(PRODUCTION_AREAS, PEDIA_LINE_ID);
  const pediaLabels = pediaOptions.map((option) => option.label);

  // The headline assertion: the area the owner could not find must be offered to Pedia.
  assert.ok(
    pediaLabels.includes("Beni Suef"),
    "a line-agnostic area (line_id NULL) must be offered to Pedia -- Beni Suef is the row the owner could not pick",
  );

  assert.deepEqual(
    pediaLabels,
    ["Beni Suef", "Minia 1", "Sohag1", "Cairo", "Egypt"],
    "every line-agnostic area plus Pedia's own line-tagged rows, in the order given",
  );

  assert.ok(
    !pediaLabels.includes("Upper Egypt 1"),
    "an area that names ANOTHER line stays hidden -- Anti Infective's Upper Egypt 1 is not Pedia's",
  );
  assert.ok(
    !pediaLabels.includes("Head office"),
    "Head Office's own area stays on Head Office",
  );

  // No line picked yet: the picker offers everything, exactly as before.
  assert.equal(
    filterAreaOptionsForLine(PRODUCTION_AREAS, "").length,
    PRODUCTION_AREAS.length,
    "with no line chosen the picker offers every area",
  );
  assert.equal(
    filterAreaOptionsForLine(PRODUCTION_AREAS, null).length,
    PRODUCTION_AREAS.length,
    "a null line is 'not chosen yet', not 'matches nothing'",
  );

  // The id may arrive as a number from a seat pre-fill and as a string from the select.
  assert.equal(
    areaBelongsToLine({ lineId: 2 }, "2"),
    true,
    "a numeric area line and a string form value are the same line",
  );
  assert.equal(
    areaBelongsToLine({ lineId: " 2 " }, 2),
    true,
    "padding around either id does not split a line from itself",
  );
  assert.equal(
    areaBelongsToLine({ lineId: 1 }, PEDIA_LINE_ID),
    false,
    "a different line is still excluded",
  );
  assert.equal(
    areaBelongsToLine({}, PEDIA_LINE_ID),
    true,
    "an option with no lineId field at all is line-agnostic",
  );

  // The picker must not grow a second copy of this rule inline: the component reads the helper.
  const componentSource = fs.readFileSync(
    path.join(process.cwd(), "src/components/employees/employee-management.tsx"),
    "utf8",
  );
  assert.ok(
    componentSource.includes("filterAreaOptionsForLine(lookups.areas, form.lineId)"),
    "the Operating Area picker must build its options through filterAreaOptionsForLine",
  );
  assert.ok(
    !/lookups\.areas\.filter\(/.test(componentSource),
    "a hand-rolled lookups.areas.filter is what dropped every line-agnostic area -- it must not come back",
  );
}
