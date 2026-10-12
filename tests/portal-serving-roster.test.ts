import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { pickServingRoster } from "../src/lib/employee-portal/serving-roster.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";

/**
 * 🔴 A MANAGER'S TEAM ROSTER COMES FROM THE ORG TREE, NEVER FROM PUBLISHED SALES.
 *
 * 2026-10-12: all nine (line × month) Monthly Closings were unpublished to unlock the months for a
 * brick move, and a Pedia Giza district manager reported that "everything is showing zero". The
 * sales keycards were right to withhold (owner, 2026-08-13). Three things that have nothing to do
 * with a closing went blank with them, because every one of their rosters was derived from the
 * membership-by-sales-history services:
 *
 *   • Team Size read 0 while his seat held four occupied rep seats (B-59, PD-0008, B-110, B-95);
 *   • the CRM First Visit board read "Reps submitted 0/0" and "No visits submitted yet today";
 *   • and nobody being on the roster meant nobody could be missing from it, so the same board
 *     ALSO printed its green "Every rep on your team has submitted their first visit."
 *
 * This pins the split and the three call sites that must use it.
 */

function row(over: Partial<EmployeeDirectoryRow> & { hrId: string }): EmployeeDirectoryRow {
  return {
    displayName: over.hrId,
    employmentStatus: "active",
    jobTitle: "Medical Representative",
    positionTitle: null,
    ...over,
  } as EmployeeDirectoryRow;
}

/** Line + block comments out, so a source assertion cannot be satisfied by a comment ABOUT a call. */
function stripComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, " ");
  return withoutBlocks.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

export function runPortalServingRosterTests() {
  const directory = [
    row({ hrId: "B-94", displayName: "Taha Mohamed", jobTitle: "Senior District Manager" }),
    row({ hrId: "B-59", displayName: "Giza Centers Rep" }),
    row({ hrId: "PD-0008", displayName: "Imbaba Rep" }),
    row({ hrId: "B-110", displayName: "Hana Abdelaziz" }),
    row({ hrId: "B-95", displayName: "Hadeer Abdelnaser" }),
    row({ hrId: "B-12", displayName: "Another District", jobTitle: "District Sales Manager" }),
    row({ hrId: "B-900", displayName: "Someone Else's Rep" }),
    row({ hrId: "HR-009", displayName: "Yasmeena Elsafory", jobTitle: "HR Specialist" }),
  ];

  // ── 1. the split ────────────────────────────────────────────────────────────
  const district = pickServingRoster({
    agentHrIds: ["B-59", "PD-0008", "B-110", "B-95"],
    directoryRows: directory,
    viewerHrId: "B-94",
  });
  assert.deepEqual(
    district.reps.map((r) => r.hrId),
    ["B-59", "PD-0008", "B-110", "B-95"],
    "THE DISTRICT'S FOUR OCCUPIED REP SEATS MUST ALL BE ON THE ROSTER. This is the count that read 0 on 2026-10-12 while the org tree held every one of them.",
  );
  assert.deepEqual(district.dsms, [], "a District Manager anchors medical reps only");
  assert.equal(district.reps[2]?.name, "Hana Abdelaziz", "the roster carries the directory's display name");

  // ── 2. nobody outside the resolved scope, and never the viewer herself ──────
  assert.ok(
    !district.reps.some((r) => r.hrId === "B-900"),
    "A REP OUTSIDE THE RESOLVED ALLOW-LIST MUST NEVER REACH THE ROSTER — this function labels people already in scope, it does not widen it.",
  );
  const acting = pickServingRoster({
    agentHrIds: ["B-94", "B-59"],
    directoryRows: [row({ hrId: "B-94", displayName: "Acting DM" }), row({ hrId: "B-59" })],
    viewerHrId: "b94",
  });
  assert.deepEqual(
    acting.reps.map((r) => r.hrId),
    ["B-59"],
    "an acting District Manager also holds a rep seat under herself, and she is not her own team member — matched hyphen- and case-insensitively",
  );

  // ── 3. a line roster carries both tiers, and non-field staff neither ────────
  const line = pickServingRoster({
    agentHrIds: ["B-59", "B-12", "B-94", "HR-009"],
    directoryRows: directory,
    viewerHrId: "B-200",
  });
  assert.deepEqual(line.reps.map((r) => r.hrId), ["B-59"], "reps stay reps");
  assert.deepEqual(
    line.dsms.map((r) => r.hrId),
    ["B-94", "B-12"].sort((a, b) => directory.findIndex((d) => d.hrId === a) - directory.findIndex((d) => d.hrId === b)),
    "both district managers land on the DSM list, in directory order",
  );
  assert.ok(
    !line.reps.some((r) => r.hrId === "HR-009") && !line.dsms.some((r) => r.hrId === "HR-009"),
    "somebody who is neither a medical rep nor a district manager is on no field roster",
  );

  // ── 4. an empty allow-list yields an empty roster, never the whole directory ──
  const none = pickServingRoster({ agentHrIds: [], directoryRows: directory, viewerHrId: "B-94" });
  assert.deepEqual(
    { reps: none.reps.length, dsms: none.dsms.length },
    { reps: 0, dsms: 0 },
    "an empty allow-list must not fall open to the whole directory",
  );

  // ── 5. the three landing dashboards take the org-tree roster ────────────────
  const snapshot = stripComments(
    readFileSync(new URL("../src/lib/employee-portal/home-snapshot.ts", import.meta.url), "utf8"),
  );
  const crmInputs = snapshot.split("const crmInput").slice(1);
  assert.equal(
    crmInputs.length,
    3,
    `the District, National and Regional dashboards each build one crmInput — found ${crmInputs.length}. If a dashboard was added or renamed, extend this assertion rather than deleting it.`,
  );
  for (const block of crmInputs) {
    const body = block.slice(0, block.indexOf("\n      };"));
    assert.ok(
      body.includes("servingRoster?.reps"),
      `A DAILY CRM BOARD IS STILL ROSTERED FROM SALES HISTORY.\n  crmInput${body}\nEvery one of them must read servingRoster?.reps (serving-roster.ts), or the board goes blank the moment a Monthly Closing is unpublished — src/lib/employee-portal/home-snapshot.ts`,
    );
  }
  assert.ok(
    snapshot.includes("memberCount: servingRoster?.reps.length"),
    "the District Manager's Team Size must be a head count from the org tree, not a count of rows with published sales",
  );
  assert.equal(
    (snapshot.match(/dsmCount: servingRoster\?\.dsms\.length/g) ?? []).length,
    2,
    "the National and Regional district counts must both come from the org tree",
  );

  // ── 6. an empty roster must not render as a compliant day ───────────────────
  const board = stripComments(
    readFileSync(
      new URL("../src/components/employee-portal/dashboards/crm-first-visit-board.tsx", import.meta.url),
      "utf8",
    ),
  );
  const rosterBranch = board.indexOf("rosterSize === 0");
  const allClear = board.indexOf("allClearMessage}");
  assert.ok(rosterBranch > 0, "the board must carry an explicit empty-roster state");
  assert.ok(
    rosterBranch < allClear,
    "AN EMPTY ROSTER MUST BE ANSWERED BEFORE THE ALL-CLEAR. Nobody can be missing from a roster of nobody, so the green 'everyone has submitted' line is what an empty roster renders as otherwise — it did, beside 'Reps submitted 0/0', on 2026-10-12.",
  );
}
