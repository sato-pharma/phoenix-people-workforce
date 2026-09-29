import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  SEAT_HIRE_STAGES,
  buildSeatHireCandidates,
  isSeatHireStage,
} from "../src/lib/recruitment/seat-hire-candidates.ts";

/**
 * Add Employee has two doors and they used to be strictly separate: a SEAT filled the placement
 * and left the person blank, an APPLICATION filled the person and their CV and left the
 * placement blank — so a real hire into a real vacancy meant typing one half by hand whichever
 * way you came in. The seat form can now pick the candidate, and this pins the two rules that
 * decide who is offered, plus the one rule that decides what the pick is allowed to overwrite.
 */
export async function runSeatHireCandidatePickerTests() {
  const seat = { areaId: 1096, lineId: 3, positionId: 11 };

  const applications = [
    {
      applicationCode: "APP-001",
      candidate: { fullName: "Mona Adel" },
      id: "app-1",
      requisition: { areaId: 1096, jobTitle: "Medical Representative", lineId: 3, positionId: 11 },
      stage: "offer_accepted",
    },
    {
      applicationCode: "APP-002",
      candidate: { fullName: "Adel Srour" },
      id: "app-2",
      // A different area on the same line — still offered, just not marked.
      requisition: { areaId: 1097, jobTitle: "Medical Representative", lineId: 3, positionId: 11 },
      stage: "pre_boarding",
    },
    {
      applicationCode: "APP-003",
      candidate: { fullName: "Too Early" },
      id: "app-3",
      requisition: { areaId: 1096, jobTitle: "Medical Representative", lineId: 3, positionId: 11 },
      stage: "cv_screening",
    },
    {
      applicationCode: "APP-004",
      candidate: { fullName: "Already Hired" },
      convertedEmployeeHrId: "CN-0006",
      id: "app-4",
      requisition: { areaId: 1096, jobTitle: "Medical Representative", lineId: 3, positionId: 11 },
      stage: "pre_boarding",
    },
    {
      applicationCode: "APP-005",
      candidate: null,
      id: "app-5",
      requisition: { areaId: 1096, jobTitle: "Medical Representative", lineId: 3, positionId: 11 },
      stage: "offer_accepted",
    },
  ];

  const offered = buildSeatHireCandidates(applications, seat);

  // The headline assertion: who is offered, and in what order.
  assert.deepEqual(
    offered.map((row) => row.applicationId),
    ["app-1", "app-2"],
    "only hireable, unconverted applications with a candidate are offered — seat match first",
  );
  assert.equal(offered[0]?.matchesSeat, true, "the requisition pointing at this seat is marked");
  assert.equal(
    offered[1]?.matchesSeat,
    false,
    "a neighbouring area is NOT marked — and must still be offered, or the pick is useless there",
  );
  assert.equal(offered[0]?.candidateName, "Mona Adel");
  assert.equal(offered[0]?.jobTitle, "Medical Representative");

  // Each exclusion on its own, so a future change cannot quietly drop one of the three.
  assert.equal(
    buildSeatHireCandidates([applications[2]], seat).length,
    0,
    "a candidate before the offer stage is not hireable — the same gate the recruitment hub uses",
  );
  assert.equal(
    buildSeatHireCandidates([applications[3]], seat).length,
    0,
    "an application already converted to an employee must never be offered again",
  );
  assert.equal(
    buildSeatHireCandidates([applications[4]], seat).length,
    0,
    "an application with no candidate record has nothing to pre-fill — the draft endpoint 404s",
  );

  // The stage set is the hub's, not a new one.
  assert.deepEqual(
    [...SEAT_HIRE_STAGES],
    ["offer_initiated", "offer_accepted", "pre_boarding"],
    "the hireable stages must stay exactly the three the recruitment hub gates its own card on",
  );
  assert.equal(isSeatHireStage("hired"), false, "'hired' is not a stage a seat can be filled from");

  // A Head Office seat carries no line and no area. Matching on nothing is not matching.
  const headOfficeSeat = { areaId: null, lineId: null, positionId: null };
  const headOfficeOffered = buildSeatHireCandidates([applications[0]], headOfficeSeat);
  assert.equal(
    headOfficeOffered.length,
    1,
    "a seat with no ids still gets the full list — it just cannot rank it",
  );
  assert.equal(
    headOfficeOffered[0]?.matchesSeat,
    false,
    "with nothing to compare, nothing may claim to match — otherwise every row reads as this seat",
  );

  // One disagreeing id vetoes, even while the others agree.
  assert.equal(
    buildSeatHireCandidates([applications[0]], { areaId: 1096, lineId: 99, positionId: 11 })[0]
      ?.matchesSeat,
    false,
    "a different line must not be reported as this seat, however well the rest lines up",
  );

  // THE RULE THAT PROTECTS THE SEAT: picking a candidate brings identity and offer terms only.
  // The hire draft also carries the requisition's line, area, department, position, team and
  // manager, and applying those would silently move the hire to wherever a months-old
  // requisition pointed. The picker must not touch them.
  const source = fs.readFileSync(
    path.join(process.cwd(), "src", "components", "employees", "employee-management.tsx"),
    "utf8",
  );
  const pickBody = source.slice(
    source.indexOf("async function pickSeatCandidate("),
    source.indexOf("function startEdit("),
  );
  assert.ok(
    pickBody.length > 0,
    "pickSeatCandidate must exist ahead of startEdit — the slice below depends on it",
  );
  for (const placementField of [
    "lineId",
    "areaId",
    "departmentId",
    "positionId",
    "teamId",
    "managerHrId",
  ]) {
    assert.ok(
      !new RegExp(`\\b${placementField}:\\s*draft\\.`).test(pickBody),
      `picking a candidate must NOT overwrite ${placementField} — the seat decides where they sit`,
    );
  }
  for (const identityField of ["fullName", "nationalId", "mobileNumber", "birthDate"]) {
    assert.ok(
      new RegExp(`\\b${identityField}:\\s*draft\\.`).test(pickBody),
      `picking a candidate must fill ${identityField} — that is the half the seat cannot know`,
    );
  }

  // The save has to carry the application, or the candidate's own CV is never copied across.
  assert.ok(
    source.includes("activeApplicationId ? { fromApplicationId: activeApplicationId }"),
    "the save must send whichever application this hire belongs to, from either door",
  );
  assert.ok(
    source.includes("const activeApplicationId = hireApplicationId ?? pickedApplicationId;"),
    "the recruitment door must keep precedence — arriving from an application is explicit",
  );

  // 🔒 SEAT-ONLY, the owner's ruling of 2026-09-29 — asked in writing and answered. The picker
  // renders only on a form opened from a seat. Widening it to every Add Employee form is the
  // obvious-looking improvement and is REFUSED: the list is useful because the seat RANKS it,
  // and on a blank form it degrades to an unordered list of everyone at offer stage while
  // adding a field to skip on every head-office hire, re-hire and correction. Dropping
  // `vacancySeatLabel` from the render condition is exactly what this catches.
  assert.ok(
    source.includes("{!editingHrId && vacancySeatLabel && seatHireCandidates.length > 0 ? ("),
    "the candidate picker must stay SEAT-ONLY (owner, 2026-09-29) — it renders only when the form was opened from a seat, never on a blank Add Employee form",
  );

  // THE NARROW READ. The picker's endpoint asks the database for the three hireable stages
  // instead of every application ever filed. The danger in a narrowing like this is not
  // performance, it is that the rewrite quietly drops a visibility check and starts showing a
  // viewer applications the wide read would have hidden — so pin the two halves that scope it.
  const applicationsService = fs.readFileSync(
    path.join(process.cwd(), "src", "lib", "recruitment", "applications.ts"),
    "utf8",
  );
  const narrowRead = applicationsService.slice(
    applicationsService.indexOf("export async function listSeatHireApplications("),
    applicationsService.indexOf("export async function listApplications("),
  );
  assert.ok(
    narrowRead.length > 0,
    "listSeatHireApplications must exist ahead of listApplications — the slice depends on it",
  );
  assert.ok(
    narrowRead.includes("listRequisitions(access)"),
    "the narrow read must resolve requisitions through the SAME scoped call as the wide one",
  );
  assert.ok(
    narrowRead.includes("canSeeApplication(access, application, requisitionsById)"),
    "the narrow read must apply the same per-application visibility check — never skip it",
  );
  assert.ok(
    narrowRead.includes('.in("stage", [...SEAT_HIRE_STAGES])'),
    "the stage filter must reuse SEAT_HIRE_STAGES, so the query and the picker cannot disagree",
  );
  assert.ok(
    narrowRead.includes('.is("converted_employee_hr_id", null)'),
    "an application already converted to an employee must be excluded by the QUERY too",
  );
  for (const stage of SEAT_HIRE_STAGES) {
    assert.ok(
      !narrowRead.includes(`"${stage}"`),
      `the narrow read must not hard-code "${stage}" — one list, imported, or the two drift apart`,
    );
  }

  const hireableRoute = fs.readFileSync(
    path.join(
      process.cwd(),
      "app",
      "api",
      "recruitment",
      "applications",
      "hireable",
      "route.ts",
    ),
    "utf8",
  );
  assert.ok(
    hireableRoute.includes("listSeatHireApplications(access)"),
    "the picker endpoint must use the narrow read",
  );
  assert.ok(
    !/\blistApplications\(/.test(hireableRoute),
    "the picker endpoint must NOT fall back to loading every application to fill one dropdown",
  );
}
