import { strict as assert } from "node:assert";

import type { AccessContext } from "../src/lib/auth/permissions.ts";
import {
  calculateOrganogramStructureKpis,
  classifyOrganogramStructureLevel,
  suppressFilledVacancyRows,
} from "../src/lib/reports/organogram-safety.ts";
import {
  buildMemberTree,
  buildOrganogramLanes,
  isChiefExecutive,
  isDistrictSalesManager,
  isMedicalRep,
  normalizeHrIdKey,
  reportsUpTo,
  type MemberNode,
} from "../src/lib/reports/organogram-view-model.ts";
import { canAccessHeadOffice, isHeadOfficeRow } from "../src/lib/reports/organogram.ts";
import type { OrganogramReportRow } from "../src/lib/reports/vacancies.ts";
import { canonicalHrIdKey } from "../src/lib/hr-id.ts";
import type { SeatContinuitySubject } from "../src/lib/workforce/hierarchy-resolver.ts";

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

function toIndex(rows: OrganogramReportRow[]): Map<string, SeatContinuitySubject> {
  const index = new Map<string, SeatContinuitySubject>();
  for (const r of rows) {
    const key = canonicalHrIdKey(r.hrId);
    if (key) {
      index.set(key, { managerHrId: r.managerHrId, pendingManagerReplacementForHrId: r.managerReplacementForHrId });
    }
  }
  return index;
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

  // H-5 — only CEO / Super Admin / Finance Manager / Talent Acquisition / system scope
  // may see Head Office. The other company-org roles (Marketing / Training Manager) may
  // not, so the vacancies route strips Head Office for them exactly like the organogram.
  // Talent Acquisition was added 2026-08-25 on the owner's instruction — she recruits for
  // Head Office and already browses the whole employee directory.
  assert.equal(canAccessHeadOffice(ctx("CEO")), true);
  assert.equal(canAccessHeadOffice(ctx("Super Admin")), true);
  assert.equal(canAccessHeadOffice(ctx("Marketing Manager", "system")), true);
  assert.equal(canAccessHeadOffice(ctx("Talent Acquisition")), true);
  assert.equal(canAccessHeadOffice(ctx("Marketing Manager")), false);
  assert.equal(canAccessHeadOffice(ctx("Training Manager")), false);
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

  // H-2 — reportsUpTo now delegates to hierarchy-resolver's isWithinManagerHierarchy
  // over a canonical-HR_ID map instead of an O(rows) linear scan per climb step.
  // Prove a 3-level climb (rep -> DSM -> RSM -> NSM) still resolves correctly
  // through the new Map-based API, and that a report held for a vacant seat
  // (marker only, no manager_hr_id yet) is recognized at the FIRST node checked,
  // not just via the separate single-level reportsToVacantReplacementOwner path.
  const chainNsm = row({ hrId: "N-2", managerHrId: "AA", positionTitle: "National Sales Manager" });
  const chainRsm = row({ hrId: "S-1", managerHrId: "N-2", positionTitle: "Regional Sales Manager" });
  const chainDsm = row({ hrId: "D-1", managerHrId: "S-1", positionTitle: "District Sales Manager" });
  const chainRep = row({ hrId: "R-2", managerHrId: "D-1", positionTitle: "Medical Representative" });
  const chainIndex = toIndex([chainNsm, chainRsm, chainDsm, chainRep]);
  assert.equal(reportsUpTo(chainRep, chainDsm, chainIndex), true);
  assert.equal(reportsUpTo(chainRep, chainRsm, chainIndex), true);
  assert.equal(reportsUpTo(chainRep, chainNsm, chainIndex), true);
  assert.equal(reportsUpTo(chainRep, row({ hrId: "UNRELATED" }), chainIndex), false);

  const heldOnlyByMarker = row({
    hrId: "R-3",
    managerHrId: null,
    managerReplacementForHrId: "D-DEPARTED",
  });
  const heldIndex = toIndex([heldOnlyByMarker]);
  assert.equal(
    reportsUpTo(heldOnlyByMarker, row({ hrId: "D-DEPARTED" }), heldIndex),
    true,
  );

  // H-2 cycle safety — a circular manager_hr_id chain (DSM A reports to DSM B,
  // B reports back to A) must not hang a climb FROM a report under that cycle;
  // the resolver's own visited-set guard must stop it deterministically.
  const cycleDsmA = row({ hrId: "CYC-A", managerHrId: "CYC-B", positionTitle: "District Sales Manager" });
  const cycleDsmB = row({ hrId: "CYC-B", managerHrId: "CYC-A", positionTitle: "District Sales Manager" });
  const cycleRep = row({ hrId: "CYC-R", managerHrId: "CYC-A", positionTitle: "Medical Representative" });
  const cycleIndex = toIndex([cycleDsmA, cycleDsmB, cycleRep]);
  assert.equal(reportsUpTo(cycleRep, row({ hrId: "UNRELATED-2" }), cycleIndex), false);
  // End-to-end through the public API too, in case the lane builder's own
  // grouping loops (not just the resolver climb) could re-introduce a hang.
  const cycleLanes = buildOrganogramLanes([cycleDsmA, cycleDsmB, cycleRep]);
  assert.ok(Array.isArray(cycleLanes.groups));

  // MD-6 — two vacant broad-Cairo DSM slots in the same line must NOT
  // auto-assign an ambiguous Cairo rep to either one via the geographic
  // fallback (that decision was previously deterministic-but-arbitrary: the
  // slot whose position_id string happened to sort first via localeCompare
  // always won, e.g. "position:id:201" sorts before "position:id:99"). The
  // rep must fall through to the unassigned/fallback bucket instead of
  // landing in ONE specific lane every time for no principled reason.
  const cairoNsm = row({ hrId: "NSM-CAIRO", positionTitle: "National Sales Manager", managerHrId: "AA" });
  const vacDsmHighId = row({
    areaId: null,
    areaName: "Cairo",
    hrId: "vacancy_dsm_A",
    managerHrId: "NSM-CAIRO",
    positionId: 201,
    positionTitle: "District Sales Manager",
    regionName: "Cairo",
    status: "open",
    teamId: null,
    teamName: null,
    type: "vacancy",
    vacancyCode: "vacancy_dsm_A",
  });
  const vacDsmLowId = row({
    areaId: null,
    areaName: "Cairo",
    hrId: "vacancy_dsm_B",
    managerHrId: "NSM-CAIRO",
    positionId: 99,
    positionTitle: "District Sales Manager",
    regionName: "Cairo",
    status: "open",
    teamId: null,
    teamName: null,
    type: "vacancy",
    vacancyCode: "vacancy_dsm_B",
  });
  const ambiguousCairoRep = row({
    areaName: "Nasr City",
    hrId: "MR-AMBIG",
    lineName: "Pedia",
    managerHrId: "NSM-CAIRO",
    positionTitle: "Medical Representative",
    regionName: "Cairo",
    teamName: "Nasr City",
  });
  const ambiguousLanes = buildOrganogramLanes([cairoNsm, vacDsmHighId, vacDsmLowId, ambiguousCairoRep]);
  const repLandedInADsmLane = ambiguousLanes.groups.some(
    (group) => group.dsm && group.members.some((member) => member.hrId === "MR-AMBIG"),
  );
  assert.equal(repLandedInADsmLane, false);

  // MD-8 (occupancy-truth model) — an area under a manager is ONE fixed seat.
  // Filled-vs-vacant is decided by live occupancy, not by the mutable vacancy
  // status, and multiple vacancy records for the same seat collapse to a single
  // vacant box. So: an occupied seat hides ALL of its stale vacancy records, and
  // an unoccupied seat shows exactly one box no matter how many stale records it
  // has. This is what stops a re-hired area from also showing a phantom vacancy.
  const dsmSlot = {
    areaId: 30,
    areaName: "Nasr City",
    departmentId: 1,
    departmentName: "Sales",
    lineId: 1,
    managerHrId: "RSM-1",
    positionId: 500,
    positionTitle: "District Sales Manager",
    teamId: 40,
    teamName: "Nasr City Team",
  };
  const coLocatedActiveDsm = row({ ...dsmSlot, hrId: "DSM-ACTIVE-1" });
  const coLocatedVacancyA = row({
    ...dsmSlot,
    hrId: "vacancy_dsm_seat_a",
    status: "open",
    type: "vacancy",
    vacancyCode: "vacancy_dsm_seat_a",
  });
  const coLocatedVacancyB = row({
    ...dsmSlot,
    hrId: "vacancy_dsm_seat_b",
    status: "open",
    type: "vacancy",
    vacancyCode: "vacancy_dsm_seat_b",
  });
  // 1 active employee + 2 same-seat vacancies: the seat is FILLED, so both stale
  // vacancy records are hidden (no phantom vacant box next to the active hire).
  const twoVacanciesOneEmployee = suppressFilledVacancyRows([
    coLocatedActiveDsm,
    coLocatedVacancyA,
    coLocatedVacancyB,
  ]);
  assert.equal(twoVacanciesOneEmployee.filter((r) => r.type === "vacancy").length, 0);

  // 1 active employee + 1 same-seat vacancy: filled → the vacancy is hidden.
  const oneVacancyOneEmployee = suppressFilledVacancyRows([coLocatedActiveDsm, coLocatedVacancyA]);
  assert.equal(oneVacancyOneEmployee.some((r) => r.type === "vacancy"), false);

  // 0 employees + 2 same-seat vacancies: the seat is VACANT and its duplicate
  // records collapse to exactly one vacant box.
  const noEmployeesTwoVacancies = suppressFilledVacancyRows([coLocatedVacancyA, coLocatedVacancyB]);
  assert.equal(noEmployeesTwoVacancies.filter((r) => r.type === "vacancy").length, 1);

  // Region-owner attachment — a rep vacancy can be missing BOTH managerHrId and
  // a seat-continuity marker purely from an import gap (confirmed real case: a
  // CNS Delta 2 rep vacancy with a typo'd, unlinked managerName "Sally Saeed"
  // while its sibling vacancies for the same real DSM "Sally Saied" correctly
  // link by ID). Recognize it by REGION instead: when the row's region exactly
  // matches exactly ONE known DSM's own area, it belongs to that DSM's lane —
  // not a fabricated fallback lane from the unverified name, and not dumped in
  // Unassigned.
  const dsmDelta2 = row({
    areaName: "Delta (2)",
    hrId: "DSM-DELTA2",
    jobTitle: "District Sales Manager",
    lineId: 3,
    lineName: "CNS",
    managerHrId: "NSM-1",
    positionId: 200,
    positionTitle: "District Sales Manager",
  });
  const unlinkedRepVacancyInDsmRegion = row({
    areaName: "Port said - Domiat",
    hrId: "VAC-UNLINKED",
    jobTitle: "Medical Representative",
    lineId: 3,
    lineName: "CNS",
    managerHrId: null,
    managerName: "Sally Saeed", // typo/unlinked text — must not be trusted
    positionTitle: "Medical Representative",
    regionName: "Delta (2)", // matches dsmDelta2's OWN area, uniquely
    status: "filled",
    type: "vacancy",
    vacancyCode: "VAC-UNLINKED",
  });
  const regionOwnerLanes = buildOrganogramLanes([dsmDelta2, unlinkedRepVacancyInDsmRegion]);
  const delta2Lane = regionOwnerLanes.groups.find((g) => g.dsm?.hrId === "DSM-DELTA2");
  assert.equal(delta2Lane?.members.some((m) => m.hrId === "VAC-UNLINKED"), true);
  assert.equal(
    regionOwnerLanes.groups.some((g) => g.name === "Sally Saeed"),
    false,
  );

  // Ambiguity guard: when TWO DSMs share the same own-area, an unlinked rep
  // vacancy in that region must NOT guess which one it belongs to.
  const dsmDelta2Twin = row({
    areaName: "Delta (2)",
    hrId: "DSM-DELTA2-TWIN",
    jobTitle: "District Sales Manager",
    lineId: 3,
    lineName: "CNS",
    managerHrId: "NSM-1",
    positionId: 200,
    positionTitle: "District Sales Manager",
  });
  const ambiguousRegionLanes = buildOrganogramLanes([
    dsmDelta2,
    dsmDelta2Twin,
    unlinkedRepVacancyInDsmRegion,
  ]);
  const ambiguousDsmMembers = ambiguousRegionLanes.groups
    .filter((g) => g.dsm?.hrId === "DSM-DELTA2" || g.dsm?.hrId === "DSM-DELTA2-TWIN")
    .flatMap((g) => g.members);
  assert.equal(ambiguousDsmMembers.some((m) => m.hrId === "VAC-UNLINKED"), false);

  // LO-9 — a dangling manager reference (managerHrId set, but no row with
  // that hrId exists in scope) is counted, not silently absorbed into the
  // Unassigned/fallback buckets with no signal that something is wrong. A
  // normal report to a real-but-non-sales-structure manager (e.g. a Finance
  // Manager) must NOT be counted — that's expected, fine data.
  const validNonSalesManager = row({
    hrId: "FIN-1",
    positionTitle: "Finance Manager",
  });
  const reportsToRealManager = row({
    hrId: "FIN-RPT-1",
    managerHrId: "FIN-1",
    positionTitle: "Financial Advisor",
  });
  const reportsToDanglingManager = row({
    hrId: "ORPHAN-1",
    managerHrId: "GHOST-MANAGER-DOES-NOT-EXIST",
    positionTitle: "Medical Representative",
  });
  const diagnosticLanes = buildOrganogramLanes([
    validNonSalesManager,
    reportsToRealManager,
    reportsToDanglingManager,
  ]);
  assert.equal(diagnosticLanes.unresolvedManagerCount, 1);
}
