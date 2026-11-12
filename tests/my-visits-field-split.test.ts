import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classifyCallProof, type VisitForCallRate } from "../src/lib/crm/call-rate.ts";
import { indexCheckinsByAgentContactDay, type CheckinForMatch } from "../src/lib/crm/checkin-match.ts";
import { isFieldWorkVisit } from "../src/lib/crm/visit-types.ts";
import { myOffDutyReason, partitionMyVisitRows } from "../src/lib/employee-portal/my-visits-partition.ts";

/**
 * My Visits and the KPI drill-down must agree on what a visit is.
 *
 * OWNER, 2026-09-25 (confirming his 2026-08-28 ruling for the portal): My Visits and Team Visits
 * split into field visits and "Days not in the field", like the KPI call-rate drill-down. Before
 * this, "My Visits (N)" counted leave, holidays, meetings and training, so a rep saw a bigger
 * number there than on KPIs.
 *
 * Three layers: the shared predicate agrees with classifyCallProof for every visit-type code; the
 * partition splits rows by it; the loader and the workspace are wired to both.
 */

function visit(visitType: number | null, comment: string | null = null, description: string | null = null): VisitForCallRate {
  return {
    agent_crm_id: 100,
    agent_hr_id: "hr-1",
    agent_name: "Test Rep",
    ampm: "AM",
    comment,
    contact_crm_id: 555,
    crm_save_date: "2026-08-02T10:00:00",
    speciality: null,
    visit_date: "2026-08-02",
    visit_type: visitType,
    visit_type_description: description,
  };
}

export function runMyVisitsFieldSplitTests() {
  // ── 1. One predicate: isFieldWorkVisit === "the KPI scores it" for every code ─────────────────
  const noCheckins = indexCheckinsByAgentContactDay([] as CheckinForMatch[]);
  const cases: Array<[number | null, string | null, string | null]> = [
    [0, null, "Regular Visit"],
    [-8, null, "Campaign (Prospection)"],
    [-30, "ص السلامه", null],
    [-30, "د. احمد", null],
    [-4, "اجازة", "Unknown"],
    [-5, "اجازة بمناسبة المولد النبوي الشريف", "Public Holiday"],
    [-6, null, "Casual Leave"],
    [-7, "sales day", null],
    [-7, "اجازه", null],
    [-7, "meeting", null],
    [-7, null, null],
    [-9, null, "Training"],
    [-11, null, "Meeting"],
    [-16, null, "Unknown"],
    [-19, null, "Meeting"],
    [-20, null, "Admin Work"],
    [-21, null, "BRM"],
    [99, null, "Something new"],
    [null, null, null],
  ];
  for (const [type, comment, description] of cases) {
    const kpiScoresIt = classifyCallProof(visit(type, comment, description), noCheckins) !== null;
    assert.equal(
      isFieldWorkVisit(type, comment, description),
      kpiScoresIt,
      `visit type ${type} (${comment ?? "no comment"}): My Visits must count it exactly when the KPI does`,
    );
  }
  // The headline: leave, holidays, meetings and training are NOT visits; regular and campaign ARE.
  assert.equal(isFieldWorkVisit(0, null, null), true);
  assert.equal(isFieldWorkVisit(-8, null, null), true);
  assert.equal(isFieldWorkVisit(-30, null, null), true);
  for (const type of [-4, -5, -6, -9, -11, -16, -19, -20, -21]) {
    assert.equal(isFieldWorkVisit(type, null, null), false, `visit type ${type} is a day not in the field, never a visit`);
  }

  // ── 2. The partition: the tab count is the field rows only; nothing is dropped ────────────────
  const rows = [
    { comment: null, fieldWork: true, id: "a" },
    { comment: "اجازة بمناسبة\nالمولد النبوي", fieldWork: false, id: "b" },
    { comment: null, fieldWork: true, id: "c" },
    { comment: "  ", fieldWork: false, id: "d" },
  ];
  const { fieldRows, offDutyRows } = partitionMyVisitRows(rows);
  assert.deepEqual(fieldRows.map((row) => row.id), ["a", "c"], "field rows keep their order");
  assert.deepEqual(offDutyRows.map((row) => row.id), ["b", "d"], "days not in the field are listed, not dropped");
  assert.equal(fieldRows.length + offDutyRows.length, rows.length);
  assert.equal(myOffDutyReason(rows[1]), "اجازة بمناسبة · المولد النبوي", "the reason is one line");
  assert.equal(myOffDutyReason(rows[3]), null, "a blank comment is no reason");

  // ── 3. The wiring: loader flags both self and team rows; the workspace counts the field rows ──
  const loader = readFileSync("src/lib/employee-portal/my-crm-visits.ts", "utf8");
  const flags = loader.match(/fieldWork: isFieldWorkVisit\(row\.visit_type, row\.comment, row\.visit_type_description\)/g) ?? [];
  assert.equal(flags.length, 2, "fetchMyVisits AND fetchTeamVisits must both set fieldWork from isFieldWorkVisit");

  // Since 12 Nov 2026 ("slim My Visits") the split runs on the SERVER, in the view the page sends
  // (my-visits-view.ts): the counts and the one page of rows come from it, never from the browser.
  const view = readFileSync("src/lib/employee-portal/my-visits-view.ts", "utf8");
  assert.match(view, /partitionMyVisitRows\(input\.visits\)/, "My Visits must be split by the shared partition");
  assert.match(view, /partitionMyVisitRows\(input\.teamVisits\)/, "Team Visits must be split by the shared partition");
  assert.match(view, /visits: visitSplit\.fieldRows\.length/, "the My Visits tab counts field visits only");
  assert.match(view, /team: teamSplit\.fieldRows\.length/, "the Team Visits tab counts field visits only");
  assert.match(view, /pageOf\(visitSplit\.fieldRows, page\), offDutyRows: visitSplit\.offDutyRows/, "the My Visits list shows field visits only, and carries its days not in the field");
  assert.match(view, /pageOf\(teamSplit\.fieldRows, page\), offDutyRows: teamSplit\.offDutyRows/, "the Team Visits list shows field visits only, and carries its days not in the field");

  const workspace = readFileSync("src/components/employee-portal/my-visits-workspace.tsx", "utf8");
  assert.match(workspace, /const count = counts\[item\.id\];/, "each tab shows the count the server made");
  assert.match(workspace, /<DaysNotInFieldGroup rows=\{view\.offDutyRows\} showRep=\{false\}/, "My Visits lists the days not in the field");
  assert.match(workspace, /<DaysNotInFieldGroup rows=\{view\.offDutyRows\} showRep \/>/, "Team Visits lists the days not in the field");
  assert.match(workspace, />Days not in the field</, "same heading as the KPI drill-down");
}
