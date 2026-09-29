import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildHeadOfficeOrganogramRows,
  HEAD_OFFICE_LINE_ID,
  type HeadOfficeEmployeeRow,
} from "../src/lib/reports/organogram-head-office.ts";

/**
 * The organogram's team label comes from the team LINK, never from the twin beside it.
 *
 * `employees.team_name` was a denormalized copy that nothing in this codebase wrote. Measured on
 * production 2026-09-09: 0 of 107 active employees carried it, while 105 carried a real `team_id`.
 * Every organogram surface that shows a team read the twin, so all 150 chart rows carried an empty
 * team and a correctly assigned team was unreadable in the one module you would look for it.
 *
 * THE FAILURE HAD NO TELL. A blank Team row reads as "this person has no team", which is a sentence
 * about the data rather than about the read — so the fix is only safe if something keeps asserting
 * that a linked employee resolves a NAME, not merely that the field exists.
 *
 * 🔴 THE TWIN IS GONE: the column was dropped on 2026-09-29, still 0 of 198 populated against 152
 * links. So there is no fallback left to test — what is left is that the LINK resolves a name, that
 * nothing is invented when it cannot, and that no select names the column again.
 */

function employee(overrides: Partial<HeadOfficeEmployeeRow>): HeadOfficeEmployeeRow {
  return {
    employment_status: "active",
    full_name: "Employee",
    hr_id: "E-1",
    job_title: "Coordinator",
    line_id: HEAD_OFFICE_LINE_ID,
    manager_hr_id: null,
    organogram_visible: true,
    ...overrides,
  };
}

const rowFor = (
  employees: HeadOfficeEmployeeRow[],
  teamNameFor?: (e: HeadOfficeEmployeeRow) => string | null,
) =>
  buildHeadOfficeOrganogramRows(employees, {
    ceoNodeKey: null,
    occupiedHrIds: new Set<string>(),
    ...(teamNameFor ? { teamNameFor } : {}),
  });

export function runOrganogramTeamLabelTests() {
  const teams = new Map<number, string>([[123, "ALEX-BHR"], [121, "Delta (3)"]]);
  const resolve = (e: HeadOfficeEmployeeRow) =>
    (typeof e.team_id === "number" ? teams.get(e.team_id) : null) ?? null;

  // 1. THE LINK IS THE SOURCE. A row carrying `team_id` must emit a NAME — this is the whole
  // defect: the record was linked correctly and the chart showed nothing.
  const linked = rowFor([employee({ hr_id: "OF-1", team_id: 123 })], resolve);
  assert.equal(linked.length, 1, "the fixture must produce exactly one Head Office row");
  assert.equal(
    linked[0]?.employeeTeamName,
    "ALEX-BHR",
    "an employee with a team_id must show their team, or the link is unreadable",
  );

  // 2. AND IT IS THE ONLY SOURCE. The twin it used to fall back to was dropped on 2026-09-29, so a
  // row cannot carry one; what matters now is that the resolver is what decides, every time.
  const second = rowFor([employee({ hr_id: "OF-3", team_id: 121 })], resolve);
  assert.equal(second[0]?.employeeTeamName, "Delta (3)", "each link resolves its own team");

  // 3. NO LINK, NO INVENTION. An employee genuinely without a team must emit null rather than a
  // placeholder, so an empty Team row still means "no team" and not "we could not read it".
  const none = rowFor([employee({ hr_id: "OF-4", team_id: null })], resolve);
  assert.equal(none[0]?.employeeTeamName, null, "no team link must stay null");

  // An id pointing at a team that does not exist is the same case — never the raw id as a label.
  const dangling = rowFor([employee({ hr_id: "OF-5", team_id: 999 })], resolve);
  assert.equal(dangling[0]?.employeeTeamName, null, "a team_id resolving to nothing must not print the id");

  // 4. NO RESOLVER, NO TEAM — AND THAT IS UNCHANGED BEHAVIOUR. The default used to read the twin,
  // which was blank on every row in production, so a caller that passes nothing emits exactly what
  // it always emitted. It must not fall back to a column that no longer exists.
  const defaulted = rowFor([employee({ hr_id: "OF-6", team_id: 123 })]);
  assert.equal(
    defaulted[0]?.employeeTeamName,
    null,
    "with no resolver the branch emits no team, which is what the dead twin gave it on every row",
  );

  // 5. THE SEAT PATH MUST BE WIRED THE SAME WAY. The pure branch above covers Head Office only,
  // which is ~12 of 150 rows; the sales side is the other 93% and needs a database, so its wiring is
  // pinned by source. Without this the tests above pass forever while the chart stays blank for
  // everyone the seat model draws.
  const source = readFileSync("src/lib/reports/organogram-au-source.ts", "utf8");
  // The SELECT ITSELF, not the file: the comments around it discuss the dropped column by name, and
  // an assertion that counted those would be asserting on prose.
  const employeeSelect = /from\("employees"\)[\s\S]{0,400}?\.select\(\s*"([^"]*)"/.exec(source)?.[1] ?? "";
  assert.ok(employeeSelect.includes("team_id"), "the employee select must fetch the team link");
  // 🔴 AND IT MUST NOT NAME THE DROPPED COLUMN. This is the very select that took the whole
  // organogram down on 2026-09-29 by naming `department_name` after it was dropped: PostgREST fails
  // the WHOLE read on a missing column, so every seat lost its occupant's name at once.
  assert.ok(
    !/\bteam_name\b/.test(employeeSelect),
    `the employee select must not name employees.team_name — the column was dropped, and one dead ` +
      `name in a select is a 42703 that fails the entire read: ${employeeSelect}`,
  );
  assert.match(
    source,
    /employeeTeamName: teamNameFor\(employee\)/,
    "the seat path must resolve the team through the link rather than reading employees.team_name",
  );
  assert.match(
    source,
    /from\("teams"\)/,
    "and it must actually read the teams table — the resolver is nothing without the names",
  );
  assert.match(
    source,
    /teamNameFor,/,
    "the Head Office branch must be handed the SAME resolver, or one chart disagrees with itself",
  );

  // 6. THE POPUP IS THE SURFACE A PERSON ACTUALLY LOOKS AT. It read the SEAT's team, which the seat
  // path leaves null on purpose because that field feeds chart classification. Filling that field
  // instead would change what the chart DRAWS, so the popup has to read the employee's.
  const modal = readFileSync("src/components/organogram/organogram-node-detail-modal.tsx", "utf8");
  const teamRows = modal.match(/\{ label: "Team", value: [^}]+\}/g) ?? [];
  assert.equal(teamRows.length, 2, "both the vacancy body and the row summary carry a Team row");
  for (const row of teamRows) {
    assert.match(
      row,
      /row\.employeeTeamName/,
      "every Team row must prefer the employee's resolved team over the seat's own null field",
    );
  }
}
