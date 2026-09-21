import assert from "node:assert/strict";

import { filterCrmMappingEmployeeOptions, type CrmMappingEmployeeOption } from "../src/lib/crm/mapping-picker.ts";

/**
 * UNMAPPED AGENTS "MAP TO" PICKER — the owner asked (2026-09-21) to map a CRM account by typing a
 * name OR an HR ID. The screen used to take a bare HR ID in a text box, so mapping a handed-over
 * account meant looking the leaver's id up somewhere else first. This pins the filter the picker runs.
 */
export function runCrmMappingPickerTests() {
  const person = (hrId: string, fullName: string): CrmMappingEmployeeOption => ({
    employmentStatus: "active",
    fullName,
    hireDate: "2026-01-01",
    hrId,
    jobTitle: "Medical Representative",
    lastWorkingDate: null,
  });
  const roster = [
    person("AI-0020", "Ahmed Farag Soliman Elakraa"),
    person("B-97", "Nada Mohamed Abdelmoaty Mohamed Elsharkawy"),
    person("B-9", "Someone Else"),
    person("B-970", "Another Person"),
    person("AI-0006", "Mohamed Yasser"),
  ];
  const ids = (query: string) => filterCrmMappingEmployeeOptions(roster, query).map((option) => option.hrId);

  // ── (A) By NAME — any words, any order, any case ────────────────────────────────────────────
  assert.deepEqual(ids("nada"), ["B-97"], "a first name finds the person");
  assert.deepEqual(ids("farag ahmed"), ["AI-0020"], "words match in any order");
  assert.deepEqual(ids("ELSHARKAWY"), ["B-97"], "case does not matter");
  assert.deepEqual(ids("mohamed"), ["B-97", "AI-0006"], "a shared word lists everyone who has it");

  // ── (B) By HR ID — dashes and case do not matter, the exact id comes first ──────────────────
  assert.deepEqual(ids("B-97")[0], "B-97", "the exact HR ID is listed first");
  assert.deepEqual(ids("b97")[0], "B-97", "no dash, lower case still finds it");
  assert.ok(ids("B-97").includes("B-970"), "a longer id sharing the prefix is still offered, after the exact one");
  assert.ok(!ids("B-97").includes("B-9"), "a SHORTER id is never offered for a longer query");
  assert.deepEqual(ids("ai-0006"), ["AI-0006"], "a lower-case AI id finds its person");

  // ── (C) A bare letter must not list the whole company ───────────────────────────────────────
  // "ai" appears in no name on this roster, so any hit would be an id-prefix match on AI-0020/AI-0006.
  assert.deepEqual(ids("ai"), [], "an id prefix with no digit matches nothing by id");
  assert.deepEqual(ids("ai-0"), ["AI-0020", "AI-0006"], "once a digit is typed the id prefix counts");

  // ── (D) Nothing typed, nothing shown; the list is capped ────────────────────────────────────
  assert.deepEqual(ids("   "), [], "blank input shows nothing");
  const many = Array.from({ length: 20 }, (_unused, index) => person(`X-${index}`, `Mohamed ${index}`));
  assert.equal(filterCrmMappingEmployeeOptions(many, "mohamed").length, 8, "at most eight suggestions");
}
