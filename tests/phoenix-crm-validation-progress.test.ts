import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import {
  buildValidationProgress,
  daysBetween,
  isNewStarter,
  VACANT_SEAT_NAME,
  validationRefusalLabel,
  type ValidationSeat,
} from "../src/lib/phoenix-crm/validation-progress-rules.ts";
import { buildValidationProgressWorkbook, excelDaySerial, VALIDATION_PROGRESS_SHEETS, validationProgressFileName } from "../src/lib/phoenix-crm/server/validation-progress-workbook.ts";

const seats = new Map<string, ValidationSeat>([
  ["SEAT-A", { seatId: "SEAT-A", people: [{ hrId: "B-1", name: "Rana Adel", hireDate: "2026-03-01" }], lineName: "CNS", areaName: "Assuit 2", managerName: "Weaam Mahmoud" }],
  ["SEAT-B", { seatId: "SEAT-B", people: [], lineName: "Pedia", areaName: "Cairo", managerName: "No district manager" }],
  ["SEAT-C", { seatId: "SEAT-C", people: [{ hrId: "B-2", name: "Nour Samy", hireDate: "2026-10-01" }], lineName: "CNS", areaName: "Assuit 1", managerName: "Weaam Mahmoud" }],
]);

function report(line: string | null = null) {
  return buildValidationProgress({
    asOfDay: "2026-11-26",
    line,
    customers: [
      { id: "c1", seatId: "SEAT-A", listType: "AM", name: "Dr. One", speciality: "Paediatrics", grade: "A", validated: true, validatedDay: "2026-11-10" },
      { id: "c2", seatId: "SEAT-A", listType: "PM", name: "Dr. Two", speciality: null, grade: "B", validated: false, validatedDay: null },
      { id: "c3", seatId: "SEAT-A", listType: "PM", name: "Dr. Three", speciality: null, grade: null, validated: false, validatedDay: null },
      { id: "c4", seatId: "SEAT-B", listType: "PM", name: "Dr. Four", speciality: null, grade: null, validated: false, validatedDay: null },
      { id: "c5", seatId: "SEAT-C", listType: "AM", name: "Dr. Five", speciality: null, grade: null, validated: true, validatedDay: "2026-11-25" },
      { id: "c6", seatId: "SEAT-C", listType: "AM", name: "Dr. Six", speciality: null, grade: null, validated: true, validatedDay: "2026-11-02" },
    ],
    refusals: [
      // Three tries on Dr. Two over two days: two days, three tries.
      { customerId: "c2", repHrId: "B-1", reason: "timetable_missing", visitDate: "2026-11-20" },
      { customerId: "c2", repHrId: "B-1", reason: "timetable_missing", visitDate: "2026-11-20" },
      { customerId: "c2", repHrId: "B-1", reason: "signboard_unreadable", visitDate: "2026-11-24" },
      // A try on a doctor already validated never makes him "tried and blocked".
      { customerId: "c1", repHrId: "B-1", reason: "rough", visitDate: "2026-11-01" },
      // A refusal with no doctor named is the rep's, counted apart, each day once.
      { customerId: null, repHrId: "b-1", reason: "blocked", visitDate: "2026-11-05" },
      { customerId: null, repHrId: "B-1", reason: "rough", visitDate: "2026-11-05" },
    ],
    seats,
    peopleNames: new Map([["B-1", "Rana Adel"]]),
  });
}

export async function runPhoenixCrmValidationProgressTests(): Promise<void> {
  const built = report();
  const rana = built.reps.find((rep) => rep.seatId === "SEAT-A");
  assert.ok(rana);
  assert.equal(rana.total, 3, "the list is every AM and PM doctor on the seat");
  assert.equal(rana.validated, 1);
  assert.equal(rana.notValidated, 2);
  assert.equal(rana.triedBlocked, 1, "only a not-validated doctor with a refused try is tried and blocked");
  assert.equal(rana.neverTried, 1);
  assert.equal(rana.triedBlocked + rana.neverTried, rana.notValidated, "the two halves add up to the not validated");
  assert.equal(rana.unlinkedBlockedDays, 1, "refusals with no doctor named count each day once, whatever the HR id's case");
  assert.equal(rana.hireDate, "2026-03-01");
  assert.equal(rana.daysSinceHire, 270, "1 March to 26 November is 270 days");
  assert.equal(rana.newStarter, false);
  assert.equal(rana.lastValidatedDay, "2026-11-10", "the last validation is the latest validated doctor's day");
  const nour = built.reps.find((rep) => rep.seatId === "SEAT-C");
  assert.ok(nour);
  assert.equal(nour.daysSinceHire, 56);
  assert.equal(nour.newStarter, true, "under 90 days since the hiring date is a new starter");
  assert.equal(nour.lastValidatedDay, "2026-11-25", "the LATEST validated day, not the first one read");
  assert.equal(isNewStarter(89), true);
  assert.equal(isNewStarter(90), false, "the 90th day is no longer a new starter");
  assert.equal(isNewStarter(null), false, "no hiring date is never a new starter");
  assert.equal(daysBetween("2026-11-25", "2026-11-26"), 1);

  const two = built.waiting.find((row) => row.customer === "Dr. Two");
  assert.ok(two);
  assert.equal(two.blockedDays, 2, "a day with two refused tries is one day");
  assert.equal(two.refusedTries, 3);
  assert.equal(two.firstBlockedDay, "2026-11-20");
  assert.equal(two.lastBlockedDay, "2026-11-24");
  assert.equal(two.reasons, `${validationRefusalLabel("timetable_missing")} (2); ${validationRefusalLabel("signboard_unreadable")} (1)`);
  assert.equal(two.triedBy, "Rana Adel");
  assert.equal(built.waiting.length, 3, "the second sheet lists every doctor not validated, tried or not, and no validated one");
  assert.ok(!built.waiting.some((row) => row.customer === "Dr. One"));

  const vacant = built.reps.find((rep) => rep.seatId === "SEAT-B");
  assert.ok(vacant);
  assert.equal(vacant.repName, VACANT_SEAT_NAME, "a vacant seat is named so, never a rep");
  assert.equal(vacant.vacant, true);
  assert.equal(vacant.hireDate, null);
  assert.equal(vacant.newStarter, false);
  assert.equal(vacant.lastValidatedDay, null);

  assert.deepEqual(built.totals, { total: 6, validated: 3, notValidated: 3, triedBlocked: 1, neverTried: 2, reps: 2, vacantSeats: 1 });

  // The district manager summary: each manager's seats together, the same counts as the reps' rows.
  const weaam = built.managers.find((manager) => manager.managerName === "Weaam Mahmoud");
  assert.ok(weaam);
  assert.deepEqual(
    { reps: weaam.reps, newStarters: weaam.newStarters, total: weaam.total, validated: weaam.validated, triedBlocked: weaam.triedBlocked, last: weaam.lastValidatedDay },
    { reps: 2, newStarters: 1, total: 5, validated: 3, triedBlocked: 1, last: "2026-11-25" },
  );
  assert.equal(built.managers.reduce((all, manager) => all + manager.total, 0), built.totals.total, "the managers add up to the company");

  // The line filter: one line's seats only; the line list stays whole; an unknown line is ignored, never empty.
  const pedia = report("Pedia");
  assert.equal(pedia.line, "Pedia");
  assert.deepEqual(pedia.reps.map((rep) => rep.seatId), ["SEAT-B"]);
  assert.deepEqual(pedia.lines, ["CNS", "Pedia"], "the line choices never shrink to the chosen line");
  assert.equal(pedia.totals.total, 1);
  assert.ok(pedia.waiting.every((row) => row.lineName === "Pedia"));
  const unknown = report("Nonsense");
  assert.equal(unknown.line, null, "a line that has no list is ignored");
  assert.equal(unknown.totals.total, built.totals.total);
  assert.equal(validationRefusalLabel("something_new"), "Refused for another reason", "an unknown reason is never printed raw");

  // The workbook: three sheets, the hiring date beside the rep, every not-validated doctor once.
  const buffer = await buildValidationProgressWorkbook(built, "2026-11-25T22:30:00.000Z");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [...VALIDATION_PROGRESS_SHEETS]);
  const repsSheet = workbook.getWorksheet("Reps")!;
  const cells = (sheet: ExcelJS.Worksheet) => {
    const values: string[] = [];
    sheet.eachRow((row) => row.eachCell((cell) => values.push(typeof cell.value === "object" && cell.value && "result" in cell.value ? String(cell.value.result) : String(cell.value ?? ""))));
    return values;
  };
  const repCells = cells(repsSheet);
  assert.ok(repCells.includes("Hiring date"), "the Reps sheet carries the hiring date");
  assert.ok(repCells.includes("Rana Adel"));
  let hiredCell: ExcelJS.Cell | null = null;
  repsSheet.eachRow((row) => row.eachCell((cell) => {
    // Excel stores a date as its day number; ExcelJS hands a date-formatted day number back as a Date.
    if (cell.value instanceof Date && cell.value.toISOString().startsWith("2026-03-01")) hiredCell = cell;
  }));
  assert.ok(hiredCell, "the hiring date is a real date cell, so it sorts and filters as a date");
  assert.equal((hiredCell as unknown as ExcelJS.Cell).numFmt, "dd mmm yyyy", "and it reads as a date");
  assert.equal(excelDaySerial("2026-03-01"), 46082, "1 March 2026 is Excel day 46082");
  const doctorCells = cells(workbook.getWorksheet("Not validated")!);
  for (const name of ["Dr. Two", "Dr. Three", "Dr. Four"]) assert.equal(doctorCells.filter((value) => value === name).length, 1, `${name} is listed once`);
  assert.ok(!doctorCells.includes("Dr. One"), "a validated doctor is not on the Not validated sheet");
  assert.equal(validationProgressFileName("2026-11-25T22:30:00.000Z"), "list-validation-2026-11-26.xlsx", "the file is named by the Cairo day");
  assert.equal(validationProgressFileName("2026-11-25T22:30:00.000Z", "Anti Infective"), "list-validation-anti-infective-2026-11-26.xlsx", "and by the line when narrowed");
  const managerCells = cells(workbook.getWorksheet("District managers")!);
  assert.ok(managerCells.includes("Weaam Mahmoud"), "the District managers sheet names each manager");
  assert.ok(repCells.includes("Days since hire") && repCells.includes("New starter") && repCells.includes("Last validation"));

  // The gates: the page and the route ask phoenix_crm:read, then the reader predicate; the loader asks it again.
  const page = readFileSync("app/(admin)/admin/phoenix-crm/validation-progress/page.tsx", "utf8");
  const route = readFileSync("app/api/admin/phoenix-crm/validation-progress/export/route.ts", "utf8");
  const loader = readFileSync("src/lib/phoenix-crm/server/validation-progress.ts", "utf8");
  for (const [file, text] of [["page", page], ["route", route]] as const) {
    const gate = text.indexOf('canAccess(access, "phoenix_crm", "read")');
    assert.ok(gate !== -1 && gate < text.indexOf("canReadValidationProgress(viewer)"), `the ${file} asks phoenix_crm:read first`);
  }
  assert.ok(route.indexOf("canReadValidationProgress(viewer)") < route.indexOf("loadValidationProgress(viewer"), "the route asks the reader before any read");
  assert.ok(route.includes("assertExportRateLimit") && route.includes("writeAuditLog"), "the export is rate-limited and audited");
  assert.ok(/canReadValidationProgress\(viewer\)\) throw notFoundError/.test(loader), "the loader refuses anyone else itself");
  assert.ok(/return viewer\.isSuperAdmin \|\| viewer\.isSfeManager;/.test(loader), "the readers are the Super Admin and the SFE Manager");
  assert.ok(!/unstable_cache|getOrLoadShared/.test(loader), "the report is read live on every call, never from a stored copy");
}
