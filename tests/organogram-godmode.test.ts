import { strict as assert } from "node:assert";

import type { AccessContext } from "../src/lib/auth/permissions.ts";
import {
  calculateOrganogramStructureKpis,
  classifyOrganogramStructureLevel,
} from "../src/lib/reports/organogram-safety.ts";
import {
  buildMemberTree,
  buildOrganogramLanes,
  isChiefExecutive,
  isDistrictSalesManager,
  isMedicalRep,
  normalizeHrIdKey,
  type MemberNode,
} from "../src/lib/reports/organogram-view-model.ts";
import { canAccessHeadOffice, isHeadOfficeRow } from "../src/lib/reports/organogram.ts";
import type { OrganogramReportRow } from "../src/lib/reports/vacancies.ts";

function findNode(nodes: MemberNode[], hrId: string): MemberNode | undefined {
  for (const node of nodes) {
    if (node.row.hrId === hrId) return node;
    const found = findNode(node.children, hrId);
    if (found) return found;
  }
  return undefined;
}

// Behavioral regression coverage for the organogram "god-mode" fixes. Unlike the
// source-string assertions in organogram-hardening.test.ts, these exercise the real
// functions so they survive file moves and prove the actual behavior.
function row(overrides: Partial<OrganogramReportRow>): OrganogramReportRow {
  return {
    areaId: null,
    areaName: null,
    departmentId: 1,
    departmentName: "Sales",
    displayName: "Employee",
    fullName: "Employee",
    hireDate: null,
    hrId: "E-1",
    jobTitle: null,
    lineId: 1,
    lineName: "Pedia",
    managerHrId: null,
    managerName: null,
    positionId: null,
    positionTitle: null,
    regionName: null,
    sourceRowNumber: null,
    status: "active",
    teamId: null,
    teamName: null,
    type: "employee",
    vacancyCode: null,
    ...overrides,
  };
}

function ctx(role: string, scope = "company"): AccessContext {
  return { hrId: "X", loginId: "X", role, scope, source: "session" } as unknown as AccessContext;
}

export function runOrganogramGodmodeTests() {
  // CR-1 — the engine's grouping key is alias-aware (legacy AAA collapses to AA),
  // preserves casing/hyphens, and returns "" for empty so callers can treat it as
  // "no key".
  assert.equal(normalizeHrIdKey("AAA"), normalizeHrIdKey("AA"));
  assert.equal(normalizeHrIdKey("aaa"), "AA");
  assert.equal(normalizeHrIdKey("  b-141 "), "B-141");
  assert.equal(normalizeHrIdKey(""), "");
  assert.equal(normalizeHrIdKey(null), "");

  // MD-3 — CEO detection is alias-aware, not a raw "AA" string compare.
  assert.equal(isChiefExecutive(row({ hrId: "AAA", positionTitle: "Anything" })), true);
  assert.equal(isChiefExecutive(row({ hrId: "AA" })), true);
  assert.equal(isChiefExecutive(row({ hrId: "B-1", positionTitle: "District Manager" })), false);

  // MD-5 / LO-7 — one classifier drives BOTH the lane predicates and the KPI
  // counter, so a bare "MR" title (and an empty-string positionTitle that falls
  // back to jobTitle) classify identically in both.
  const bareMr = row({ hrId: "R-1", positionTitle: "MR" });
  assert.equal(isMedicalRep(bareMr), true);
  assert.equal(classifyOrganogramStructureLevel(bareMr), "medicalRep");
  const emptyTitleDsm = row({ hrId: "D-1", positionTitle: "", jobTitle: "District Sales Manager" });
  assert.equal(isDistrictSalesManager(emptyTitleDsm), true);
  assert.equal(classifyOrganogramStructureLevel(emptyTitleDsm), "dsm");

  // MD-2 — genuinely duplicated rows collapse to a single KPI count (the dedupe
  // guard used to be dead because the key embedded the array index).
  const dsm = row({ hrId: "B-10", positionTitle: "District Sales Manager" });
  const dsmDuplicate = row({ hrId: "B-10", positionTitle: "District Sales Manager" });
  const kpis = calculateOrganogramStructureKpis([dsm, dsmDuplicate]);
  assert.equal(kpis.dsm.actual, 1);
  assert.equal(kpis.dsm.total, 1);

  // H-1 — a report held for a resigned manager seat (marker set, manager reassigned
  // up to the NSM, and NO open vacancy row present for the seat) must still render
  // under a vacant seat instead of being silently dropped.
  const ceo = row({ hrId: "AA", displayName: "Chief", fullName: "Chief", positionTitle: "CEO" });
  const nsm = row({
    displayName: "Nat",
    fullName: "Nat",
    hrId: "N-1",
    managerHrId: "AA",
    positionTitle: "National Sales Manager",
  });
  const heldRep = row({
    areaName: "Tanta",
    displayName: "Held Rep",
    fullName: "Held Rep",
    hrId: "R-9",
    managerHrId: "N-1",
    managerReplacementForHrId: "B-DEP",
    positionTitle: "Medical Representative",
  });
  const lanes = buildOrganogramLanes([ceo, nsm, heldRep]);
  const rendered = new Set<string>();
  for (const group of lanes.groups) {
    for (const member of group.members) rendered.add(member.hrId);
    for (const child of group.childLanes ?? []) {
      for (const member of child.members) rendered.add(member.hrId);
    }
  }
  assert.equal(rendered.has("R-9"), true);

  // H-3 — Head Office is detected by the canonical line_id=4 first, with the
  // line-name variants as a fallback; a null-line row is NOT treated as Head
  // Office (so it cannot masquerade as one).
  assert.equal(isHeadOfficeRow({ lineId: 4, lineName: null }), true);
  assert.equal(isHeadOfficeRow({ lineId: null, lineName: "Head Office" }), true);
  assert.equal(isHeadOfficeRow({ lineId: null, lineName: "office" }), true);
  assert.equal(isHeadOfficeRow({ lineId: 1, lineName: "Pedia" }), false);
  assert.equal(isHeadOfficeRow({ lineId: null, lineName: null }), false);

  // H-5 — only CEO / Super Admin / system scope may see Head Office. Company-org
  // roles (Marketing / Training Manager) and Talent Acquisition may not, so the
  // vacancies route strips Head Office for them exactly like the organogram.
  assert.equal(canAccessHeadOffice(ctx("CEO")), true);
  assert.equal(canAccessHeadOffice(ctx("Super Admin")), true);
  assert.equal(canAccessHeadOffice(ctx("Marketing Manager", "system")), true);
  assert.equal(canAccessHeadOffice(ctx("Marketing Manager")), false);
  assert.equal(canAccessHeadOffice(ctx("Training Manager")), false);
  assert.equal(canAccessHeadOffice(ctx("Talent Acquisition")), false);
  assert.equal(canAccessHeadOffice(ctx("National Sales Manager")), false);

  // MD-9 — a member's node key must depend only on their identity, never on
  // their position in the input array, or a re-sorted/re-filtered render
  // (e.g. after a search) can cross-bind a collapsed node onto a different
  // person. Reproduce with the SAME three people fed in two different orders.
  const manager = row({ hrId: "M-1", positionTitle: "District Sales Manager" });
  const alice = row({ displayName: "Alice", fullName: "Alice", hrId: "P-1", managerHrId: "M-1" });
  const bob = row({ displayName: "Bob", fullName: "Bob", hrId: "P-2", managerHrId: "M-1" });
  const treeOrderA = buildMemberTree([manager, alice, bob]);
  const treeOrderB = buildMemberTree([manager, bob, alice]);
  const bobKeyOrderA = findNode(treeOrderA, "P-2")?.key;
  const bobKeyOrderB = findNode(treeOrderB, "P-2")?.key;
  assert.ok(bobKeyOrderA && bobKeyOrderB);
  assert.equal(bobKeyOrderA, bobKeyOrderB);
}
