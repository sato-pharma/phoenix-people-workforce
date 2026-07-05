import { strict as assert } from "node:assert";

import { buildFieldWorkforceCompliancePreview } from "../src/lib/field-workforce-compliance/classifier.ts";
import { parseFieldWorkforceComplianceMatrix } from "../src/lib/field-workforce-compliance/parser.ts";
import { buildDsmGroups } from "../src/lib/employee-portal/team-calendar.ts";

/**
 * Regression coverage for a bug shipped and caught in production: the NSM Team Calendar
 * rendered as one flat, ungrouped list of names instead of "DSM, then his team, then the
 * next DSM, ...". Root cause was in ireports360-source.ts's toEmployeeReference(), which
 * built the FieldWorkforceEmployeeReference passed into the classifier WITHOUT managerHrId
 * — every employee summary's managerHrId came out null, so nothing could ever match a rep
 * to their DSM. This test exercises the real classifier pipeline (the same one production
 * uses) end to end, so a future regression of managerHrId being dropped from the reference
 * fails loudly here instead of silently reaching production again.
 */
export async function runNsmTeamCalendarTests() {
  const parsed = parseFieldWorkforceComplianceMatrix({
    fileName: "Jan 2026 team calendar.xlsx",
    matrix: [
      ["TM", "HR ID", "Hiring Date", "Month", "Year", "1-Jan-2026", "2-Jan-2026"],
      ["Mostafa Mamdouh", "B-1", "1-Jan-2020", "Jan", 2026, "CP", "N"],
      ["Ahmed Mohamed Abdallah", "B-2", "1-Jan-2020", "Jan", 2026, 5, "N"],
      ["Mohamed Ibrahim Kasem", "B-3", "1-Jan-2020", "Jan", 2026, 3, "N"],
      ["Walid Fathy Abdelfattah", "B-4", "1-Jan-2020", "Jan", 2026, "CP", "N"],
      ["Shafek Mohamed Momen", "B-5", "1-Jan-2020", "Jan", 2026, 2, "N"],
    ],
    sheetName: "iReport",
  });
  assert.equal(parsed.errors.length, 0);

  // Two DSMs (B-1, B-4), each with two reps reporting to them via managerHrId — exactly the
  // shape toEmployeeReference must preserve for grouping to work at all.
  const preview = buildFieldWorkforceCompliancePreview({
    employeeReferences: [
      { fullName: "Mostafa Mamdouh", hrId: "B-1", managerHrId: "A-9", roleName: "District Sales Manager" },
      { fullName: "Ahmed Mohamed Abdallah", hrId: "B-2", managerHrId: "B-1", regionName: "Delta", roleName: "Medical Rep" },
      { fullName: "Mohamed Ibrahim Kasem", hrId: "B-3", managerHrId: "B-1", roleName: "Medical Rep" },
      { fullName: "Walid Fathy Abdelfattah", hrId: "B-4", managerHrId: "A-9", roleName: "District Sales Manager" },
      { fullName: "Shafek Mohamed Momen", hrId: "B-5", managerHrId: "B-4", roleName: "Medical Rep" },
    ],
    holidayConnected: true,
    holidaySourceLabel: "Egypt public holidays",
    parsed,
  });

  const mostafa = preview.employees.find((employee) => employee.hrId === "B-1");
  assert.ok(mostafa);
  // Guards the exact regression: managerHrId must survive employeeReference -> summary.
  assert.equal(mostafa.managerHrId, "A-9");
  const ahmed = preview.employees.find((employee) => employee.hrId === "B-2");
  assert.ok(ahmed);
  assert.equal(ahmed.managerHrId, "B-1");
  // Region must also survive employeeReference -> summary (the Team Calendar's region filter reads this).
  assert.equal(ahmed.regionName, "Delta");

  // A-9 (the NSM) is not in this employee set at all, matching production: getNsmTeamCalendar
  // filters the NSM's own row out before grouping, so every DSM here has no manager present
  // in the set and becomes a group root — exactly like a real NSM's calendar.
  const groups = buildDsmGroups(preview.employees);

  assert.equal(groups.length, 2, "expected one group per DSM, not one flat bucket");

  const mostafaGroup = groups.find((group) => group.managerHrId === "B-1");
  assert.ok(mostafaGroup);
  assert.deepEqual(
    mostafaGroup.members.map((member) => member.hrId),
    ["B-1", "B-2", "B-3"],
    "DSM must come first, followed by their own reps only",
  );

  const walidGroup = groups.find((group) => group.managerHrId === "B-4");
  assert.ok(walidGroup);
  assert.deepEqual(
    walidGroup.members.map((member) => member.hrId),
    ["B-4", "B-5"],
  );

  // A rep whose manager isn't in the scoped set, and for whom no seat override was resolved
  // (a genuinely unresolvable reference, not a known vacant seat), must still be shown — as
  // their own standalone group — never silently dropped.
  const orphanPreview = buildFieldWorkforceCompliancePreview({
    employeeReferences: [
      { fullName: "Omnia Nader", hrId: "B-6", managerHrId: "B-999-MISSING", roleName: "Medical Rep" },
    ],
    holidayConnected: true,
    holidaySourceLabel: "Egypt public holidays",
    parsed: parseFieldWorkforceComplianceMatrix({
      fileName: "Jan 2026 team calendar.xlsx",
      matrix: [
        ["TM", "HR ID", "Hiring Date", "Month", "Year", "1-Jan-2026"],
        ["Omnia Nader", "B-6", "1-Jan-2020", "Jan", 2026, "N"],
      ],
      sheetName: "iReport",
    }),
  });
  const orphanGroups = buildDsmGroups(orphanPreview.employees);
  assert.equal(orphanGroups.length, 1);
  assert.deepEqual(orphanGroups[0].members.map((member) => member.hrId), ["B-6"]);

  // Regression for a real production case: a rep (Essam-like) whose real DSM resigned and
  // whose seat is still vacant has their raw managerHrId rolled up to the NSM. Once the NSM's
  // own row is dropped (as getNsmTeamCalendar does), that manager reference points at nobody
  // in the set — WITHOUT a seat override this rep would incorrectly become their own
  // standalone "manager" block with no team, which is exactly the bug the user caught in
  // production. With the override (as resolveNsmScope now supplies via resolveSeatGrouping),
  // they must instead land in a clearly-labeled vacant-seat group.
  const vacantSeatPreview = buildFieldWorkforceCompliancePreview({
    employeeReferences: [
      { fullName: "Essam Mohamed Youssef Elsayed", hrId: "B-164", managerHrId: "A-12", roleName: "Medical Representative" },
    ],
    holidayConnected: true,
    holidaySourceLabel: "Egypt public holidays",
    parsed: parseFieldWorkforceComplianceMatrix({
      fileName: "Jan 2026 team calendar.xlsx",
      matrix: [
        ["TM", "HR ID", "Hiring Date", "Month", "Year", "1-Jan-2026"],
        ["Essam Mohamed Youssef Elsayed", "B-164", "1-Jan-2020", "Jan", 2026, "N"],
      ],
      sheetName: "iReport",
    }),
  });
  const vacantSeatGroups = buildDsmGroups(
    vacantSeatPreview.employees,
    new Map([["b-164", { seatKey: "vacant-seat:226", seatName: "Cairo — Vacant DSM seat" }]]),
  );
  assert.equal(vacantSeatGroups.length, 1);
  assert.equal(vacantSeatGroups[0].managerHrId, null, "a vacant seat has no real employee as its header");
  assert.equal(vacantSeatGroups[0].managerName, "Cairo — Vacant DSM seat");
  assert.deepEqual(vacantSeatGroups[0].members.map((member) => member.hrId), ["B-164"]);
}
