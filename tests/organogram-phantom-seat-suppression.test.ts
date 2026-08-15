import { strict as assert } from "node:assert";

import {
  applyOrganogramMirrorSafety,
  calculateOrganogramStructureKpis,
} from "../src/lib/reports/organogram-safety.ts";
import { buildOrganogramLanes } from "../src/lib/reports/organogram-view-model.ts";
import type { OrganogramReportRow } from "../src/lib/reports/vacancies.ts";

// Regression coverage for the 2026-08 organogram phantom-seat audit.
//
// Root cause: seatOccupancyKey identifies a seat as level|line|area|MANAGER. When
// the manager one level up changes (e.g. the Anti Infective NSM went B-157 ->
// AI-0008), the occupant's manager component shifts while a stale FILLED vacancy
// record keeps the OLD manager — so the two keys never match, suppression fails,
// and the filled seat renders as a phantom "Open Seat" AND inflates the vacant KPI.
// Fix: suppression also matches occupancy on a manager-agnostic identity
// (level|line|area). A second defect — one physical area carrying both a real
// vacancy record and a leftover manager-less "Vacant … Manager" placeholder —
// rendered the area twice; the placeholder is now dropped when a real record
// exists. Fix 2: a rep reporting straight to the NSM with no seat marker used to
// fall through every lane bucket and vanish; it now lands in Unassigned.

function row(overrides: Partial<OrganogramReportRow>): OrganogramReportRow {
  return {
    areaId: 10,
    areaName: "Cairo",
    departmentId: 1,
    departmentName: "Sales",
    displayName: "Employee",
    fullName: "Employee",
    hireDate: "2026-01-01",
    hrId: "E-1",
    jobTitle: "Medical Representative",
    lineId: 1,
    lineName: "Anti Infective",
    managerHrId: "DSM-1",
    managerName: "DSM One",
    positionId: 100,
    positionTitle: "Medical Representative",
    regionName: "Cairo",
    sourceRowNumber: null,
    status: "active",
    teamId: null,
    teamName: null,
    type: "employee",
    vacancyCode: null,
    ...overrides,
  };
}

function vacancy(overrides: Partial<OrganogramReportRow>): OrganogramReportRow {
  return row({
    fullName: "Vacant",
    hireDate: null,
    hrId: "vacancy_1",
    status: "open",
    type: "vacancy",
    vacancyCode: "vacancy_1",
    ...overrides,
  });
}

export function runOrganogramPhantomSeatSuppressionTests() {
  // ── Defect 1: phantom vacant DSM after an NSM change ─────────────────────────
  // Real production case: Anti Infective / Cairo DSM is filled by AI-0001 (now
  // under NSM AI-0008), but the stale filled vacancy still names the previous NSM
  // B-157. The manager-agnostic occupancy check must recognize the seat as filled
  // and hide the stale record — no phantom "Open Seat" beside the real hire.
  const cairoDsmOccupant = row({
    areaName: "Cairo",
    hrId: "AI-0001",
    jobTitle: "District Sales Manager",
    lineName: "Anti Infective",
    managerHrId: "AI-0008", // the NEW NSM
    positionId: 200,
    positionTitle: "District Sales Manager",
  });
  const staleCairoDsmVacancy = vacancy({
    areaName: "Cairo",
    hrId: "vacancy_cairo_dsm",
    jobTitle: "District Sales Manager",
    lineName: "Anti Infective",
    managerHrId: "B-157", // the OLD NSM — stale
    positionId: 200,
    positionTitle: "District Sales Manager",
    status: "filled",
    vacancyCode: "vacancy_cairo_dsm",
  });
  const cairoResult = applyOrganogramMirrorSafety([cairoDsmOccupant, staleCairoDsmVacancy]);
  assert.deepEqual(
    cairoResult.map((item) => item.type),
    ["employee"],
    "a filled DSM area must hide its stale vacancy even when the record names the previous NSM",
  );

  // Same seat viewed through the KPI: the phantom must NOT count as a vacant DSM.
  const cairoKpi = calculateOrganogramStructureKpis(cairoResult);
  assert.deepEqual(
    cairoKpi.dsm,
    { actual: 1, total: 1, vacant: 0 },
    "the DSM vacant KPI must not be inflated by a stale-manager phantom seat",
  );

  // A genuinely vacant area in the same line (no occupant) still renders — the fix
  // must not over-suppress. Upper Egypt has no active DSM, so its seat stays vacant.
  const upperEgyptVacant = vacancy({
    areaName: "Upper Egypt",
    hrId: "vacancy_ue_dsm",
    jobTitle: "District Sales Manager",
    lineName: "Anti Infective",
    managerHrId: "AI-0008",
    positionId: 200,
    positionTitle: "District Sales Manager",
    status: "open",
    vacancyCode: "vacancy_ue_dsm",
  });
  const mixed = applyOrganogramMirrorSafety([cairoDsmOccupant, staleCairoDsmVacancy, upperEgyptVacant]);
  assert.deepEqual(
    mixed.filter((item) => item.type === "vacancy").map((item) => item.areaName),
    ["Upper Egypt"],
    "a genuinely vacant area must still render while the phantom is suppressed",
  );

  // ── Defect 2: same-area real record + manager-less placeholder → one box ──────
  // Heliopolis / Pedia carried both a real open rep record (manager PD-0006) and a
  // leftover "Vacant Cairo District Manager" stub with no manager_hr_id. Both
  // survived, rendering the area twice. The placeholder must lose to the real one.
  const heliopolisReal = vacancy({
    areaName: "Heliopolis",
    hrId: "vacancy_helio_real",
    lineName: "Pedia",
    managerHrId: "PD-0006",
    managerName: "Ahmed Mohamed Nagy",
    positionTitle: "Medical Representative",
    status: "open",
    vacancyCode: "vacancy_helio_real",
  });
  const heliopolisPlaceholder = vacancy({
    areaName: "Heliopolis",
    hrId: "vacancy_helio_placeholder",
    lineName: "Pedia",
    managerHrId: null,
    managerName: "Vacant Cairo District Manager",
    positionTitle: "Medical Representative",
    status: "filled",
    vacancyCode: "vacancy_helio_placeholder",
  });
  const heliopolis = applyOrganogramMirrorSafety([heliopolisReal, heliopolisPlaceholder]);
  assert.equal(
    heliopolis.filter((item) => item.type === "vacancy").length,
    1,
    "one physical area must render one box, not two, when a real record and a manager-less placeholder coexist",
  );
  assert.equal(
    heliopolis.find((item) => item.type === "vacancy")?.managerName,
    "Ahmed Mohamed Nagy",
    "the surviving box must be the real-manager record, not the placeholder",
  );

  // ── Guard: two DISTINCT real managers for one area are NOT collapsed ──────────
  // This is the intended behavior the placeholder fix must preserve — only the
  // id-less placeholder loses, never a genuine split between two real managers.
  const twoRealManagers = applyOrganogramMirrorSafety([
    vacancy({ areaName: "Cairo", hrId: "v_r1", managerHrId: "DSM-1", vacancyCode: "v_r1" }),
    vacancy({ areaName: "Cairo", hrId: "v_r2", managerHrId: "DSM-2", vacancyCode: "v_r2" }),
  ]);
  assert.equal(
    twoRealManagers.filter((item) => item.type === "vacancy").length,
    2,
    "two vacancy records with distinct REAL managers for the same area must both render",
  );

  // ── Fix 2: a rep reporting straight to the NSM (no seat marker) must not vanish ─
  const nsm = row({
    fullName: "Line NSM",
    hrId: "AI-0008",
    jobTitle: "National Sales Manager",
    managerHrId: "AA",
    positionId: 300,
    positionTitle: "National Sales Manager",
  });
  const repUnderNsm = row({
    areaName: "Minia 1",
    fullName: "Rep Direct To NSM",
    hrId: "MR-DIRECT",
    managerHrId: "AI-0008", // straight to the line leader, no vacant-seat marker
    managerReplacementForHrId: null,
    positionTitle: "Medical Representative",
  });
  const vanishLanes = buildOrganogramLanes([nsm, repUnderNsm]);
  const placedHrIds = new Set<string>();
  for (const group of vanishLanes.groups) {
    for (const member of group.members) placedHrIds.add(member.hrId);
    for (const child of group.childLanes ?? []) {
      for (const member of child.members) placedHrIds.add(member.hrId);
    }
  }
  assert.equal(
    placedHrIds.has("MR-DIRECT"),
    true,
    "a rep whose manager is the NSM directly must land in a visible lane (Unassigned), never fall through and vanish",
  );
  const unassignedLane = vanishLanes.groups.find((group) => group.name === "Unassigned Manager");
  assert.ok(unassignedLane, "the NSM-direct report should surface under the Unassigned Manager lane");
  assert.equal(
    unassignedLane?.members.some((member) => member.hrId === "MR-DIRECT"),
    true,
    "the NSM-direct report is routed specifically to Unassigned Manager",
  );
}
