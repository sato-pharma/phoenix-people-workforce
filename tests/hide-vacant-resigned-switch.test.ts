import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isHiddenOrganogramRow, isLaneHidden, visibleLaneMembers } from "../src/lib/reports/organogram-hide-vacant.ts";
import { buildMemberTree, type ManagerLane, type OrganogramRow } from "../src/lib/reports/organogram-view-model.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * One "Hide vacant and resigned" switch (owner, 2026-10-29) on the Org chart and Double visits
 * (the Business Review's own switches are pinned in business-review-resigned-vacancy.test.ts).
 * It hides boxes and rows only: every count, KPI and export keeps reading every row.
 */

const ORG_CHART = "src/components/organogram/org-chart.tsx";
const DOUBLE_VISITS = "src/components/double-visit-analytics/double-visit-analytics-workspace.tsx";

function row(overrides: Partial<OrganogramRow> & Pick<OrganogramRow, "hrId">): OrganogramRow {
  return {
    areaId: null,
    areaName: null,
    departmentId: null,
    departmentName: null,
    displayName: overrides.hrId,
    employmentStatus: "active",
    fullName: overrides.fullName ?? overrides.hrId,
    hireDate: null,
    jobTitle: "Medical Representative",
    lineId: 1,
    lineName: "Anti infective",
    managerHrId: null,
    managerName: null,
    positionId: null,
    positionTitle: "Medical Representative",
    regionName: null,
    sourceRowNumber: null,
    status: "active",
    teamId: null,
    teamName: null,
    type: "employee",
    vacancyCode: null,
    ...overrides,
  } as OrganogramRow;
}

function lane(dsm: OrganogramRow | null, members: OrganogramRow[]): ManagerLane {
  return { dsm, members, name: "Lane", title: "DSM" };
}

export function runHideVacantResignedSwitchTests() {
  // ── 1. Which boxes the switch hides ──────────────────────────────────────────────────────────
  const active = row({ hrId: "A-1" });
  const onLeave = row({ hrId: "A-2", employmentStatus: "on_leave", status: "on_leave" });
  const vacant = row({ hrId: "", type: "vacancy", status: "open", fullName: "Vacant" });
  const resigned = row({ hrId: "A-3", employmentStatus: "resigned", status: "resigned" });
  assert.equal(isHiddenOrganogramRow(active), false, "an active person stays on the chart");
  assert.equal(isHiddenOrganogramRow(onLeave), false, "a person on leave is not departed and stays");
  assert.equal(isHiddenOrganogramRow(vacant), true, "a vacant seat hides");
  assert.equal(isHiddenOrganogramRow(resigned), true, "a resigned person hides");

  // Off means nothing is filtered — the same array, untouched.
  const members = [active, vacant, resigned];
  assert.equal(visibleLaneMembers(members, false), members);
  assert.deepEqual(visibleLaneMembers(members, true), [active]);

  // ── 2. A hidden box's reports move up to the lane root, never vanish with it ────────────────
  const vacantLead = row({ hrId: "L-1", employmentStatus: "resigned", status: "resigned", fullName: "Lead" });
  const report = row({ hrId: "R-1", managerHrId: "L-1", fullName: "Report" });
  const fullTree = buildMemberTree([vacantLead, report]);
  assert.equal(fullTree.length, 1, "with the switch off, the report sits under its lead");
  const hiddenTree = buildMemberTree(visibleLaneMembers([vacantLead, report], true));
  assert.deepEqual(hiddenTree.map((node) => node.row.hrId), ["R-1"], "the report is promoted to the root");

  // ── 3. A lane hides only when its header AND every member are hidden ─────────────────────────
  assert.equal(isLaneHidden(lane(vacant, [vacant]), false), false, "the switch off hides no lane");
  assert.equal(isLaneHidden(lane(vacant, [vacant, resigned]), true), true, "an all-vacant lane hides");
  assert.equal(isLaneHidden(lane(null, []), true), true, "a lane with no header and no one hides");
  assert.equal(isLaneHidden(lane(vacant, [active]), true), false, "a vacant manager seat with a live team stays");
  assert.equal(isLaneHidden(lane(active, [vacant]), true), false, "a filled manager seat stays");

  // ── 4. The org chart wires the switch into every lane and leaves the counts alone ───────────
  {
    const src = stripComments(readFileSync(ORG_CHART, "utf8"));
    assert.ok(src.includes(`label="Hide vacant and resigned"`), `${ORG_CHART}: the switch must be labelled.`);
    const lanes = src.match(/<ManagerLane\b[\s\S]*?\/>/g) ?? [];
    assert.equal(lanes.length, 3, `${ORG_CHART}: expected the three lane render sites.`);
    for (const site of lanes) {
      assert.ok(site.includes("hideVacantResigned={hideVacantResigned}"), `${ORG_CHART}: every lane must receive the switch.`);
    }
    assert.equal((src.match(/if \(isLaneHidden\([a-z]+, hideVacantResigned\)\) return null;/g) ?? []).length, 3,
      `${ORG_CHART}: each of the three lane maps must skip a fully hidden lane.`);
    assert.match(src, /buildMemberTree\(visibleLaneMembers\(group\.members, hideVacantResigned\)\)/,
      `${ORG_CHART}: the member tree must be built from the visible members.`);
    assert.ok(!/calculateOrganogramStructureKpis\([^)]*hideVacantResigned/.test(src),
      `${ORG_CHART}: the KPI cards must keep counting every seat.`);
  }

  // ── 5. Double visits: rows hide, every figure keeps reading the whole profile ───────────────
  {
    const src = stripComments(readFileSync(DOUBLE_VISITS, "utf8"));
    assert.ok(src.includes(`label="Hide vacant and resigned"`), `${DOUBLE_VISITS}: the switch must be labelled.`);
    assert.match(src, /row\.visitedStatus === "resigned" \|\| row\.visitedStatus === "vacant"\) existing\.departed = true/,
      `${DOUBLE_VISITS}: a visit to a resigned rep or a vacant seat must mark the row departed.`);
    assert.match(src, /managerProfile\.mrBreakdown\.filter\(\(row\) => !row\.departed\)/,
      `${DOUBLE_VISITS}: the switch must drop departed rows.`);
    assert.ok(src.includes("items={visibleMrBreakdown}") && src.includes("{visibleMrBreakdown.map((row) => ("),
      `${DOUBLE_VISITS}: both the mobile cards and the desktop table must read the switched rows.`);
    assert.ok(!src.includes("items={managerProfile.mrBreakdown}") && !src.includes("{managerProfile.mrBreakdown.map("),
      `${DOUBLE_VISITS}: no list may still read the unswitched rows.`);
    assert.ok(src.includes("!hideVacantResigned && managerProfile.vacantTerritories.length > 0"),
      `${DOUBLE_VISITS}: the vacant-territory card must hide while the switch is on.`);
  }
}
