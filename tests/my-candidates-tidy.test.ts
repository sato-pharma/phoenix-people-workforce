import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  chipsForCandidateStatus,
  requisitionRoleLabel,
  tidyTeamManagers,
  type RequisitionPlaces,
} from "../src/lib/recruitment/my-candidates-tidy.ts";
import type { WorkspaceAnswerChip } from "../src/lib/recruitment/workspace/types.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The manager's "My Candidates" page, tidied (owner, 2026-10-26, seen as the Pedia National Sales
 * Manager):
 *
 *   • a HIRED candidate showed the amber "Applying for · Missing" chip — the role is the seat they
 *     were hired into, so there is nothing left to fill in;
 *   • a position card printed the request code ("District Sales Manager · REQ-2026-PDUE2A") — the
 *     owner's rule is names, not codes;
 *   • "Your team's candidates" listed five managers who had left the company and held no CV.
 */

function chip(key: string, value: string | null): WorkspaceAnswerChip {
  return { key, label: key, value, rawValue: value, addedByHr: null, lead: false };
}

function source(path: string): string {
  // Comments are stripped so a sentence explaining a call can never satisfy an assertion about it.
  return stripComments(readFileSync(new URL(path, import.meta.url), "utf8"));
}

export function runMyCandidatesTidyTests() {
  // ── Hired candidates lose the unanswered role chip, and only that ──────────────────────────────
  const chips = [chip("role", null), chip("area", null), chip("salary", "12,000")];
  assert.deepEqual(
    chipsForCandidateStatus("hired", chips).map((c) => c.key),
    ["area", "salary"],
    "a hired candidate is not shown an unanswered 'Applying for'; every other chip stays",
  );
  assert.deepEqual(
    chipsForCandidateStatus("Hired", chips).map((c) => c.key),
    ["area", "salary"],
    "the status is normalised, so a legacy spelling of hired is treated as hired",
  );
  assert.deepEqual(
    chipsForCandidateStatus("hired", [chip("role", "Medical Rep")]).map((c) => c.key),
    ["role"],
    "an ANSWERED role chip stays on a hired candidate",
  );
  for (const status of ["new", "shortlisted", "backup", "sent_to_manager", "rejected", null, "something odd"]) {
    assert.deepEqual(
      chipsForCandidateStatus(status, chips).map((c) => c.key),
      ["role", "area", "salary"],
      `a candidate still in the pipeline (${String(status)}) keeps the missing-role chip`,
    );
  }

  // ── A position is named by its role and its area, never its code ───────────────────────────────
  const places: RequisitionPlaces = { areas: { "7": "Minia 1" }, lines: { "3": "Pedia" } };
  assert.equal(
    requisitionRoleLabel({ jobTitle: "Medical Representative", areaId: 7, lineId: 3 }, places),
    "Medical Representative · Minia 1",
    "role then area",
  );
  assert.equal(
    requisitionRoleLabel({ jobTitle: "District Sales Manager", areaId: null, lineId: 3 }, places),
    "District Sales Manager · Pedia",
    "a district seat has no area, so its line stands in",
  );
  assert.equal(requisitionRoleLabel({ jobTitle: "District Sales Manager", areaId: 99, lineId: null }, places), "District Sales Manager", "an unknown area falls back to the role alone");
  assert.equal(requisitionRoleLabel({ jobTitle: "District Sales Manager", areaId: 7, lineId: 3 }), "District Sales Manager", "no names loaded: the role alone, never a number");
  assert.equal(requisitionRoleLabel({ jobTitle: "", areaId: null, lineId: null }, places), "Position not named");
  assert.ok(!/REQ-|\d{4}-/.test(requisitionRoleLabel({ jobTitle: "District Sales Manager", areaId: 7, lineId: 3 }, places)), "no request code in the label");

  // ── The team list hides a leaver with no CV, and lists CV holders first ────────────────────────
  const team = [
    { hrId: "a", active: true, cvCount: 0 },
    { hrId: "b", active: false, cvCount: 0 },
    { hrId: "c", active: false, cvCount: 2 },
    { hrId: "d", active: true, cvCount: 5 },
    { hrId: "e", active: true, cvCount: 0 },
    { hrId: "f", active: false, cvCount: 0 },
    { hrId: "g", active: true, cvCount: 1 },
  ];
  assert.deepEqual(
    tidyTeamManagers(team).map((m) => m.hrId),
    ["c", "d", "g", "a", "e"],
    "leavers with no CV are hidden; a leaver who still holds CVs stays; CV holders come first; the given order is otherwise kept",
  );
  assert.deepEqual(tidyTeamManagers([{ hrId: "b", active: false, cvCount: 0 }]), [], "a team of leavers with no CV lists nobody");
  assert.equal(team.length, 7, "the input is not mutated");

  // ── The three screens actually use them ────────────────────────────────────────────────────────
  const portal = source("../src/components/employee-portal/recruitment-candidates-portal.tsx");
  assert.ok(!portal.includes("requisition.requisitionCode"), "the candidate card no longer prints the request code");
  assert.ok(portal.includes("requisitionRoleLabel(requisition, places)"), "the candidate card prints the role and area label");
  assert.ok(
    source("../src/components/recruitment/workspace/manager-answer-chips.ts").includes("chipsForCandidateStatus("),
    "the manager chips pass through the hired filter",
  );
  assert.ok(
    source("../src/components/employee-portal/team-candidates-section.tsx").includes("tidyTeamManagers(allManagers)"),
    "the team picker lists the tidied managers",
  );
  for (const page of ["../app/employee-portals/recruitment-candidates/page.tsx", "../app/(admin)/recruitment/candidates/page.tsx"]) {
    const text = source(page);
    assert.ok(text.includes("loadRequisitionPlaces("), `${page} loads the area and line names`);
    assert.ok(text.includes("requisitionPlaces={requisitionPlaces}"), `${page} hands them to the portal`);
  }
}
