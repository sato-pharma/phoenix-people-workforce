import { strict as assert } from "node:assert";

import { buildFieldWorkforceCompliancePreview } from "../src/lib/field-workforce-compliance/classifier.ts";
import { parseFieldWorkforceComplianceMatrix } from "../src/lib/field-workforce-compliance/parser.ts";
import { buildDsmGroups } from "../src/lib/employee-portal/team-calendar.ts";
import {
  attachManagerOwnVisitSplits,
  isManagerOwnVisitsOnlyDay,
  isPortalRideAlongCoachingDay,
  portalDaySplit,
  portalOwnVisitCount,
} from "../src/lib/employee-portal/team-calendar-cell.ts";
import { splitBucketOf } from "../src/lib/field-workforce-compliance/ireports360-source.ts";

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

  // Regression for a real production case (Pedia line): when a Regional Sales Manager sits
  // between the NSM and several DSMs, the RSM's own row stays in the scoped set (only the
  // NSM's row is dropped), so every DSM's managerHrId resolves to the in-scope RSM. Before
  // the fix, that made the RSM the sole "root" and flattened ALL of their DSMs (and every
  // DSM's own reps) into one giant merged block. Each DSM must remain its own group boundary
  // regardless of the RSM layer above them.
  const rsmPreview = buildFieldWorkforceCompliancePreview({
    employeeReferences: [
      { fullName: "Hany Saad Mohamed Omar", hrId: "PD-0001", managerHrId: "A-12", roleName: "Regional Sales Manager" },
      { fullName: "Ahmed Mohamed Ahmed Mohamed Abdallah", hrId: "B-74", managerHrId: "PD-0001", roleName: "District Sales Manager" },
      { fullName: "Ahmed Mohamed Ahmed Mohamed Heikal", hrId: "B-5", managerHrId: "PD-0001", roleName: "District Sales Manager" },
      { fullName: "Ahmed Hemdan Ahmed Elsayed Abdallah", hrId: "B-58", managerHrId: "B-5", roleName: "Medical Representative" },
      { fullName: "Nermeen Salah Abdelaty Abohussien", hrId: "B-154", managerHrId: "PD-0001", roleName: "District Sales Manager" },
    ],
    holidayConnected: true,
    holidaySourceLabel: "Egypt public holidays",
    parsed: parseFieldWorkforceComplianceMatrix({
      fileName: "Jan 2026 team calendar.xlsx",
      matrix: [
        ["TM", "HR ID", "Hiring Date", "Month", "Year", "1-Jan-2026"],
        ["Hany Saad Mohamed Omar", "PD-0001", "1-Jan-2020", "Jan", 2026, "N"],
        ["Ahmed Mohamed Ahmed Mohamed Abdallah", "B-74", "1-Jan-2020", "Jan", 2026, "N"],
        ["Ahmed Mohamed Ahmed Mohamed Heikal", "B-5", "1-Jan-2020", "Jan", 2026, "N"],
        ["Ahmed Hemdan Ahmed Elsayed Abdallah", "B-58", "1-Jan-2020", "Jan", 2026, "N"],
        ["Nermeen Salah Abdelaty Abohussien", "B-154", "1-Jan-2020", "Jan", 2026, "N"],
      ],
      sheetName: "iReport",
    }),
  });
  const rsmGroups = buildDsmGroups(rsmPreview.employees);

  assert.equal(rsmGroups.length, 4, "RSM + 3 DSM blocks, not one merged block");

  const rsmGroup = rsmGroups.find((group) => group.managerHrId === "PD-0001");
  assert.ok(rsmGroup);
  assert.deepEqual(
    rsmGroup.members.map((member) => member.hrId),
    ["PD-0001"],
    "the RSM's own block must not swallow their DSMs' subtrees",
  );

  const abdallahGroup = rsmGroups.find((group) => group.managerHrId === "B-74");
  assert.ok(abdallahGroup);
  assert.deepEqual(abdallahGroup.members.map((member) => member.hrId), ["B-74"]);

  const heikalGroup = rsmGroups.find((group) => group.managerHrId === "B-5");
  assert.ok(heikalGroup);
  assert.deepEqual(
    heikalGroup.members.map((member) => member.hrId),
    ["B-5", "B-58"],
    "Heikal's own rep must stay in Heikal's block, not the RSM's",
  );

  const nermeenGroup = rsmGroups.find((group) => group.managerHrId === "B-154");
  assert.ok(nermeenGroup);
  assert.deepEqual(nermeenGroup.members.map((member) => member.hrId), ["B-154"]);

  // --- Portal cell interpretation: a manager's ride-along (double-visit) day is a "DV" coaching
  // day, NOT a duplicated rep-visit count. Regression for the production report "visit numbers
  // look doubled": every DSM's calendar was a numeric echo of their reps' visits because the
  // shared engine double-credits a ride-along to both the rep and the manager. A day classified
  // VISITS with ownVisitCount === 0 (all credit was ride-along) now renders as "DV" and adds 0 to
  // the person's own visit total, so a manager's row never repeats the reps' numbers. ---
  const rideAlongDay = { status: "VISITS", ownVisitCount: 0, visitCount: 7 } as const;
  const ownVisitsDay = { status: "VISITS", ownVisitCount: 3, visitCount: 3 } as const;
  const excelVisitsDay = { status: "VISITS", visitCount: 4 } as const; // Excel-upload path: no own-count signal
  const noActivityDay = { status: "N", ownVisitCount: 0 } as const;

  assert.equal(isPortalRideAlongCoachingDay(rideAlongDay), true, "a VISITS day with 0 own visits is a DV coaching day");
  assert.equal(portalOwnVisitCount(rideAlongDay), 0, "a ride-along day adds 0 to the person's own visit total (no doubling)");
  assert.equal(isPortalRideAlongCoachingDay(ownVisitsDay), false, "a rep's own visits are never a DV day");
  assert.equal(portalOwnVisitCount(ownVisitsDay), 3, "a rep's own visit count is shown as-is");
  assert.equal(isPortalRideAlongCoachingDay(excelVisitsDay), false, "with no own-count signal (Excel path) it is not a DV day — behaviour unchanged");
  assert.equal(portalOwnVisitCount(excelVisitsDay), 4, "with no own-count signal the raw classified count is used, preserving prior behaviour");
  assert.equal(isPortalRideAlongCoachingDay(noActivityDay), false, "a non-VISITS day is never a DV day");

  // --- The square's three figures (owner, 2026-10-23: "make the square … 2 for AM, 9 for PM, and 5 for pharmacies …
  // same for district managers, and same in everywhere"). AM · PM · Pharmacies apart, never added. ---
  const split = (am: number, pm: number, pharmacies: number) => ({ am, pharmacies, pm });
  assert.deepEqual(portalDaySplit({ ...ownVisitsDay, ownVisitSplit: split(2, 9, 5) }), split(2, 9, 5), "a rep's day prints its own three figures");
  assert.deepEqual(
    portalDaySplit({ ...rideAlongDay, ownVisitSplit: split(0, 0, 0), rideAlongSplit: split(3, 4, 0) }),
    split(3, 4, 0),
    "a district manager's ride-along day prints the split of the visits he joined, not a bare DV",
  );
  assert.deepEqual(
    portalDaySplit({ ...ownVisitsDay, ownVisitSplit: split(1, 0, 0), rideAlongSplit: split(5, 5, 0) }),
    split(1, 0, 0),
    "a day with his own calls prints HIS — the reps' visits are on the reps' rows, never added on top",
  );
  assert.deepEqual(
    portalDaySplit({ ...noActivityDay, managerOwnSplit: split(1, 2, 1) }),
    split(1, 2, 1),
    "his own Phoenix CRM single visits print on a day the mirror reads as nothing",
  );
  assert.equal(isManagerOwnVisitsOnlyDay({ ...noActivityDay, managerOwnSplit: split(1, 0, 0) }), true, "and that day is worked, never No activity");
  assert.equal(isManagerOwnVisitsOnlyDay({ ...ownVisitsDay, managerOwnSplit: split(1, 0, 0) }), false);
  assert.equal(portalDaySplit(excelVisitsDay), null, "the Excel path keeps its one-word label");
  assert.equal(portalDaySplit({ ...noActivityDay }), null);

  // The engine's bucket: through the golden rule's helper, a pharmacy whatever its half, and a non-call in no figure.
  const row = { ampm: "AM", comment: null, speciality: null, visitType: 0, visitTypeDescription: null };
  assert.equal(splitBucketOf(row), "AM");
  assert.equal(splitBucketOf({ ...row, ampm: "PM" }), "PM");
  assert.equal(splitBucketOf({ ...row, ampm: "Pharmacy" }), "Pharmacies", "a Phoenix pharmacy call carries its list in the period column");
  assert.equal(splitBucketOf({ ...row, speciality: "Pharmacy" }), "Pharmacies");
  assert.equal(splitBucketOf({ ...row, visitType: 7 }), null, "a campaign, meeting or leave row counts in no figure");
  assert.equal(splitBucketOf({ ...row, comment: "ص النور", visitType: -30 }), "Pharmacies", "the vendor's unlabelled pharmacy call is a pharmacy");
  assert.equal(splitBucketOf({ ...row, ampm: "PM", visitType: -30 }), "PM", "and its unlabelled customer call a field visit");

  // The manager's own visits hang on his cells by HR id and date, and a day off the timeline is never invented.
  const employee = { hrId: "B-120", timeline: [{ dateIso: "2026-10-19", status: "N" }, { dateIso: "2026-10-20", status: "N" }] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [attached] = attachManagerOwnVisitSplits([employee as any], [
    { date: "2026-10-19", hrId: "b-120", split: split(1, 0, 1) },
    { date: "2026-10-19", hrId: "B-120", split: split(0, 1, 0) },
    { date: "2026-11-02", hrId: "B-120", split: split(4, 0, 0) },
  ]);
  assert.deepEqual(attached.timeline[0].managerOwnSplit, split(1, 1, 1), "two reads of one day merge, matched case-blind");
  assert.equal(attached.timeline[1].managerOwnSplit, undefined, "a day with nothing carries nothing");
  assert.equal(attached.timeline.length, 2, "a day off the month is dropped");
}
