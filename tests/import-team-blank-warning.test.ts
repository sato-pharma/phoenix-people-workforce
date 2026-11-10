import assert from "node:assert/strict";

import { classifyOrganizationRow } from "../src/lib/imports/org-rule-engine.ts";

// An Area with a blank Team is how four people reached production carrying no team at all
// (2026-08-17 to 2026-09-01) with nothing complaining. Team is not a required column, and making
// it one would be wrong: `requiredEmployeeImportFields` only asserts a COLUMN exists, never that a
// row carries a value, and Head Office staff (the CEO, the Toll Manufacturing Manager) legitimately sit in no
// sales team. So the import warns instead of blocking. These tests pin both halves of that.
function classify(area: unknown, team: unknown, rowNumber = 7) {
  return classifyOrganizationRow({
    rowNumber,
    department: "Sales",
    line: "CNS",
    area,
    team,
    position: "Medical Rep",
  });
}

export function runImportTeamBlankWarningTests() {
  // 1) HEADLINE — an area with no team raises exactly one reviewable warning, on the team field,
  //    carrying the row number the reviewer has to open.
  {
    const result = classify("Qalyubia", null, 12);
    assert.equal(result.warnings.length, 1, "one warning for an area with no team");
    const [warning] = result.warnings;
    assert.equal(warning.field, "team", "the warning points at the Team column");
    assert.equal(warning.code, "org_mapping_needs_review", "reviewable, not a hard failure");
    assert.equal(warning.rowNumber, 12, "the warning names the row the reviewer must open");
    assert.match(warning.message, /Qalyubia/, "the message names the area the reviewer will recognise");
    assert.match(warning.message, /no team/i, "the message says what is missing");
  }

  // 2) The blank spellings a human actually types are all treated as blank — a sheet saying "-"
  //    or "N/A" must not read as a team named "-".
  for (const blank of [null, undefined, "", "   ", "-", "N/A"]) {
    const result = classify("Mansoura", blank);
    assert.equal(
      result.warnings.length,
      1,
      `a team of ${JSON.stringify(blank)} counts as blank and warns`,
    );
    assert.equal(result.team.code, null, `a team of ${JSON.stringify(blank)} resolves to no team`);
  }

  // 3) A filled team is silent.
  {
    const result = classify("Mansoura", "Delta (1)");
    assert.equal(result.warnings.length, 0, "a filled team raises nothing");
    assert.ok(result.team.code, "the team still resolves");
  }

  // 4) A row with neither area nor team is a Head Office row, not a mistake — staying silent here
  //    is what keeps the CEO and the Toll Manufacturing Manager importable.
  {
    assert.equal(classify(null, null).warnings.length, 0, "no area and no team is silent");
    assert.equal(classify("", "").warnings.length, 0, "both blank is silent");
  }

  // 5) A team with no area is somebody else's problem (the area validator's) — not this warning's.
  {
    assert.equal(classify(null, "Delta (1)").warnings.length, 0, "a team with no area is silent here");
  }
}
