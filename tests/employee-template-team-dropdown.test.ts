import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  AREAS_LIST_NAME,
  AREA_TEAM_FALLBACK_RANGE,
  areaTeamRangeName,
  areaTeamRangeNameResolvedByExcel,
  areaTeamValidationFormula,
  buildAreaTeamRanges,
} from "../src/lib/employees/template-lookup-names.ts";

// The employee hiring template's Area -> Team cascade needs two independent pieces of code to agree
// on a defined name: the Node builder that CREATES it, and the Excel formula that ASKS for it when
// the user clicks the cell. They used to derive it separately from the area's label and disagreed on
// eleven of the fifty-eight live areas, so those Team dropdowns resolved to #REF! and were dead.
//
// This test is the lock on that. It asserts the two halves agree for every real area name, and it
// asserts an area with NO teams still gets a range — the second, independent half of the same
// defect, which killed the dropdown on 23 more areas including the newly opened Delta (3).
//
// The oracle is deliberately NOT the builder's own output: areaTeamRangeNameResolvedByExcel()
// re-implements what Excel's MATCH does, so agreement is demonstrated rather than assumed.

// Every active area name in production, read 2026-08-28 (58 rows, `select name from areas where
// is_active`). Kept verbatim — the punctuation IS the test. Eleven of these were broken.
const LIVE_AREA_NAMES = [
  "Alex Center", "Alex East", "Alex West", "Alex-BHR", "Assuit 1", "Assuit 2", "Aswan",
  "Behira 1", "Behira 2", "Beni Suef", "Cairo", "Cairo East 1", "Cairo East 2", "Cairo West",
  "Dakahlia 1", "Dakahlia 2", "Dakahlia 3", "Delta (1)", "Delta (2)", "Delta (3)",
  "Dokki - Mohandseen - Bolak", "Down town", "Egypt", "Fayoum", "Gharbia 1 (Tanta)",
  "Gharbia 2 (Mahalla)", "Giza", "Giza - Giza Centers", "Haram - Faisal", "Head office",
  "Heliopolis", "Helwan-Maadi", "Hurgada", "Imbaba - Imbaba Centers", "Ismailia",
  "Kafr El-Sheikh 1", "Kafr El-Sheikh 2", "Luxor", "Menoufia 1", "Menoufia 2", "Minia 1",
  "Minia 2", "Nasr City", "New Valley", "North Sinai", "October -Zayed", "Port said - Domiat",
  "Qalubeya", "Qena 1", "Qena 2", "Red Sea", "Sharkia 1", "Sharkia 2", "Sohag1", "Sohag2",
  "South Sinai", "Suez", "Upper Egypt",
];

// The eleven that the label-derived scheme got wrong. Named explicitly so a future reader sees the
// actual failures rather than a count, and so dropping one from LIVE_AREA_NAMES cannot quietly
// shrink the coverage this test claims.
const PREVIOUSLY_BROKEN = [
  "Delta (1)", "Delta (2)", "Delta (3)", "Dokki - Mohandseen - Bolak", "Gharbia 1 (Tanta)",
  "Gharbia 2 (Mahalla)", "Giza - Giza Centers", "Haram - Faisal", "Imbaba - Imbaba Centers",
  "October -Zayed", "Port said - Domiat",
];

// Names no SUBSTITUTE chain could ever have survived — the reason the label stopped being the key.
const ADVERSARIAL_AREA_NAMES = [
  "الدلتا (٣)",        // Arabic: the old builder stripped this to "" and fell back to a shared "NA"
  "Delta  (3)",         // a doubled space: builder collapsed the run, Excel did not
  "((()))",             // strips to nothing at all
  "Delta (3)",          // same label as a real one, to prove duplicates collapse onto one range
  "  Sharkia 1  ",      // padded: the same pick to a user, and to Excel's MATCH
];

const ROUTE_SOURCE = readFileSync(
  fileURLToPath(new URL("../app/api/employees/template/route.ts", import.meta.url)),
  "utf8",
);

function areasFrom(names: string[]) {
  return names.map((label, index) => ({ label, value: String(1000 + index) }));
}

export function runEmployeeTemplateTeamDropdownTests() {
  // ── 1. THE HEADLINE. Every area's built range is the one Excel will ask for ────────────────
  //
  // If this fires, some area's Team dropdown is dead in the delivered workbook.
  const areas = areasFrom(LIVE_AREA_NAMES);
  const ranges = buildAreaTeamRanges({ areas, teams: [] });
  const builtNames = new Set(ranges.map((range) => range.name));

  for (const label of LIVE_AREA_NAMES) {
    const asked = areaTeamRangeNameResolvedByExcel(label, areas);
    assert.ok(
      builtNames.has(asked),
      `DEAD DROPDOWN: area "${label}" — Excel resolves ${asked}, which the builder never created. ` +
        `Built: ${[...builtNames].slice(0, 4).join(", ")}…`,
    );
    assert.notEqual(
      asked,
      AREA_TEAM_FALLBACK_RANGE,
      `area "${label}" resolves to the no-match fallback, so its own teams are unreachable`,
    );
  }

  // The eleven historical failures are still in the fixture and still pass.
  for (const label of PREVIOUSLY_BROKEN) {
    assert.ok(LIVE_AREA_NAMES.includes(label), `fixture lost a known-broken area: "${label}"`);
    assert.ok(builtNames.has(areaTeamRangeNameResolvedByExcel(label, areas)));
  }

  // ── 2. A range exists for EVERY area, teams or not ─────────────────────────────────────────
  //
  // 23 live areas had no team at all. The old builder skipped the defined name entirely for those,
  // so INDIRECT hit #REF! — a different cause, the same dead dropdown.
  assert.equal(
    ranges.length,
    LIVE_AREA_NAMES.length + 1,
    "expected one range per area plus the fallback",
  );
  for (const range of ranges) {
    assert.ok(range.name.length > 0, "every range carries a name");
    if (range.areaLabel != null) assert.deepEqual(range.teamLabels, [], "no teams were supplied");
  }

  // ── 3. The fallback range is always present and always empty ───────────────────────────────
  const fallback = ranges.find((range) => range.name === AREA_TEAM_FALLBACK_RANGE);
  assert.ok(fallback, "the no-match fallback range must always be emitted");
  assert.equal(fallback.areaLabel, null);
  assert.deepEqual(fallback.teamLabels, []);
  assert.equal(
    areaTeamRangeNameResolvedByExcel("not an area at all", areas),
    AREA_TEAM_FALLBACK_RANGE,
    "an unrecognised Area must land on the fallback, matching IFERROR(MATCH(...),0)",
  );

  // ── 4. Teams land on their own area, and duplicates collapse the way MATCH does ────────────
  const dupAreas = areasFrom(["Cairo", "Delta (3)", "Giza", "Delta (3)"]);
  const dupRanges = buildAreaTeamRanges({
    areas: dupAreas,
    teams: [
      { areaId: 1001, label: "D3 North" }, // the first "Delta (3)"
      { areaId: 1003, label: "D3 South" }, // the duplicate label, later in the list
      { areaId: 1000, label: "Cairo Central" },
    ],
  });
  const d3 = dupRanges.find((r) => r.name === areaTeamRangeNameResolvedByExcel("Delta (3)", dupAreas));
  assert.ok(d3, "the duplicated label still resolves to a real range");
  assert.deepEqual(
    [...d3.teamLabels].sort(),
    ["D3 North", "D3 South"],
    "teams from BOTH rows carrying a duplicated label merge onto the one range MATCH finds",
  );
  assert.equal(
    dupRanges.filter((r) => r.areaLabel === "Delta (3)").length,
    1,
    "a duplicated label gets exactly one range, not two",
  );
  const cairo = dupRanges.find((r) => r.areaLabel === "Cairo");
  assert.deepEqual(cairo?.teamLabels, ["Cairo Central"], "a team never leaks into a sibling area");

  // ── 5. Adversarial names the old label-derived scheme could not represent ───────────────────
  const advAreas = areasFrom(ADVERSARIAL_AREA_NAMES);
  const advNames = new Set(buildAreaTeamRanges({ areas: advAreas, teams: [] }).map((r) => r.name));
  for (const label of ADVERSARIAL_AREA_NAMES) {
    assert.ok(
      advNames.has(areaTeamRangeNameResolvedByExcel(label, advAreas)),
      `adversarial area "${label}" has no reachable range`,
    );
  }
  // Every emitted name must be a LEGAL Excel defined name: letter/underscore first, then word
  // characters only. "TEAMS_DELTA_(3)" — what Excel used to ask for — is not one.
  for (const name of [...builtNames, ...advNames]) {
    assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/, `"${name}" is not a legal Excel defined name`);
  }

  // ── 6. The live formula points at the same two things the builder does ─────────────────────
  const formula = areaTeamValidationFormula("H5");
  assert.ok(formula.includes(AREAS_LIST_NAME), "the cascade must MATCH against the areas list");
  assert.ok(formula.includes("MATCH(H5"), "the formula must match on the row's own Area cell");
  assert.ok(formula.includes("IFERROR"), "a blank Area must not poison INDIRECT with #N/A");
  assert.ok(
    formula.includes(`"${areaTeamRangeName(0).replace(/0$/, "")}"`),
    "the formula must build the same prefix the builder emits",
  );
  assert.ok(!formula.includes("SUBSTITUTE"), "no string surgery on the Excel side — that was the bug");
  assert.ok(!formula.includes("UPPER("), "no case surgery on the Excel side either");

  // ── 7. The route cannot quietly go back to deriving a name from the label ──────────────────
  assert.ok(
    ROUTE_SOURCE.includes("areaTeamValidationFormula("),
    "the template route must use the shared formula builder",
  );
  assert.ok(
    ROUTE_SOURCE.includes("buildAreaTeamRanges("),
    "the template route must use the shared range builder",
  );
  assert.ok(
    !ROUTE_SOURCE.includes("definedNameToken"),
    "the label-derived token helper is what produced eleven dead dropdowns — do not reintroduce it",
  );
  assert.ok(
    !ROUTE_SOURCE.includes("indirectTokenFormula"),
    "the SUBSTITUTE-chain formula is the other half of that defect — do not reintroduce it",
  );
  // The empty-list guard that skipped the defined name for 23 team-less areas.
  assert.ok(
    !ROUTE_SOURCE.includes("if (values.length > 0) {"),
    "writeList must register the defined name even when the list is empty",
  );
}
