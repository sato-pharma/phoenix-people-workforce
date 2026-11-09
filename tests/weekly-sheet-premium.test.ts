import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import type { AccountDoctorDepth } from "../src/lib/crm/account-doctor-notes.ts";
import type { WeeklySheet, WeeklySheetAccount, WeeklySheetRep } from "../src/lib/crm/weekly-sheet.ts";
import {
  WEEKLY_SHEET_NO_DOCTORS,
  WEEKLY_SHEET_VERDICT_TONE,
  filterWeeklySheetDistricts,
  isWeeklySheetMeasured,
  parseWeeklySheetShow,
  weeklySheetAccountBar,
  weeklySheetAccountResult,
  weeklySheetAccountShort,
  weeklySheetAccountShortLine,
  weeklySheetAccountState,
  weeklySheetAccountsInOrder,
  weeklySheetAttention,
  weeklySheetAttentionCounts,
  weeklySheetAttentionEmptyLine,
  weeklySheetDepthLine,
  weeklySheetDepthMet,
  weeklySheetDistrictKey,
  weeklySheetDistrictLine,
  weeklySheetExportHref,
  weeklySheetGapWords,
  weeklySheetHref,
  weeklySheetListedSeats,
  weeklySheetMetCaption,
  weeklySheetNav,
  weeklySheetPosition,
  weeklySheetPositionLine,
  weeklySheetRepAnchor,
  weeklySheetRepDaysLine,
  weeklySheetRepVerdicts,
  weeklySheetShares,
  weeklySheetShowCounts,
  weeklySheetShowEmptyLine,
  weeklySheetSpecialityGapLine,
  weeklySheetSpecialityGaps,
  weeklySheetTargetLine,
  weeklySheetTeamLine,
  weeklySheetTeamTotals,
  weeklySheetTotals,
  weeklySheetUnmeasuredLine,
  weeklySheetVerdict,
  weeklySheetVerdictBar,
  weeklySheetWaitingLine,
} from "../src/lib/crm/weekly-sheet-summary.ts";
import { buildWeeklySheetWorkbook, weeklySheetWorkbookFileName } from "../src/lib/crm/weekly-sheet-workbook.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The Weekly Sheet premium pass (owner, 9 Nov 2026: "eyeball every report in My Team's Reports, premium polish").
 *
 * One week, worked by hand — Saturday 31 October to Wednesday 4 November 2026:
 *
 *   Delta (1) · Sahar El Gallad
 *     - Ahmed Ali, Shubra: 5 working days; PM 52 of 50, AM 10 of 10; 12 pharmacies. Three accounts:
 *       El Salam (3 · 3 · 3, met), Dar El Fouad (3 · 1 · 0, short), El Nour (no doctor written).
 *     - Mona Saleh, Banha: 4 working days, 1 on leave; PM 30 of 40, AM 9 of 8; 5 pharmacies, 2 visits waiting.
 *       One account: El Hayah (2 · 3 · 1, short).
 *     - A vacant seat, Tanta.
 *   Alex-BHR · Mostafa Kamel
 *     - Karim Fawzy, Smouha: a week of leave — 0 working days, nothing graded.
 *     - Sara Nabil, Miami: 5 working days; PM 50 of 50, AM 7 of 10; 8 pharmacies. One account: Alex Clinic (met).
 *
 * So, with the week over: 5 seats, 1 vacant, 1 with no working day, 3 measured. PM 132 of 140 (Ahmed and Sara met,
 * Mona below); AM 26 of 28 (Ahmed and Mona met, Sara below); only Ahmed met both. 25 pharmacies, 2 waiting. Five
 * accounts: 2 with 3 of each, 2 short, 1 with no doctor written; ENT short in 2, Pediatrics in 1, Internal in 1.
 */

function depth(pediatrics: number, internal: number, ent: number): AccountDoctorDepth {
  const named = pediatrics + internal + ent;
  return { ent, internal, met: pediatrics >= 3 && internal >= 3 && ent >= 3, named, noDoctorsWritten: named === 0, pediatrics };
}

function account(customerId: string, name: string, visits: number, value: AccountDoctorDepth): WeeklySheetAccount {
  return { customerId, depth: value, name, visits };
}

function rep(seatId: string, person: string, territory: string, fields: Partial<WeeklySheetRep>): WeeklySheetRep {
  const accounts = fields.accounts ?? [];
  return {
    accounts,
    accountsMet: accounts.filter((entry) => entry.depth.met).length,
    am: 0,
    amTarget: 10,
    leaveDays: 0,
    person,
    pharmacies: 0,
    pm: 0,
    pmTarget: 50,
    seatId,
    territory,
    vacant: false,
    waiting: 0,
    workingDays: 5,
    ...fields,
  };
}

const EL_SALAM = account("C1", "El Salam Hospital", 2, depth(3, 3, 3));
const DAR_EL_FOUAD = account("C2", "Dar El Fouad", 1, depth(3, 1, 0));
const EL_NOUR = account("C3", "El Nour Center", 1, depth(0, 0, 0));
const EL_HAYAH = account("C4", "El Hayah Polyclinic", 3, depth(2, 3, 1));
const ALEX_CLINIC = account("C5", "Alex Clinic", 2, depth(4, 3, 3));

function sampleSheet(cairoToday = "2026-11-08"): WeeklySheet {
  return {
    cairoToday,
    districts: [
      {
        districtName: "Delta (1) District 2",
        managerName: "Sahar El Gallad",
        regionName: "Delta (1)",
        reps: [
          rep("R1", "Ahmed Ali", "Shubra", { accounts: [EL_SALAM, DAR_EL_FOUAD, EL_NOUR], am: 10, pharmacies: 12, pm: 52 }),
          rep("R2", "Mona Saleh", "Banha", { accounts: [EL_HAYAH], am: 9, amTarget: 8, leaveDays: 1, pharmacies: 5, pm: 30, pmTarget: 40, waiting: 2, workingDays: 4 }),
          rep("V1", "Seat is vacant", "Tanta", { amTarget: 0, pmTarget: 0, vacant: true }),
        ],
        vacantSeats: 1,
      },
      {
        districtName: "Alex District 1",
        managerName: "Mostafa Kamel",
        regionName: "Alex-BHR",
        reps: [
          rep("R3", "Karim Fawzy", "Smouha", { amTarget: 0, leaveDays: 5, pmTarget: 0, workingDays: 0 }),
          rep("R4", "Sara Nabil", "Miami", { accounts: [ALEX_CLINIC], am: 7, pharmacies: 8, pm: 50 }),
        ],
        vacantSeats: 0,
      },
    ],
    label: "Sat 31 Oct – Wed 4 Nov",
    targetsUncertain: false,
    weekEnd: "2026-11-04",
    weekStart: "2026-10-31",
  };
}

function theVerdicts() {
  // A finished week grades Met or Below; a week still running never says "Below"; a week not started grades nothing.
  assert.equal(weeklySheetVerdict(49, 50, false, "past"), "Below");
  assert.equal(weeklySheetVerdict(50, 50, false, "past"), "Met");
  assert.equal(weeklySheetVerdict(49, 50, false, "current"), "So far", "a running week is never Below");
  assert.equal(weeklySheetVerdict(50, 50, false, "current"), "Met", "a target reached early is met");
  assert.equal(weeklySheetVerdict(0, 50, false, "ahead"), "Not started");
  // A week of leave or of holidays has no target: never "0 of 0 · Met".
  assert.equal(weeklySheetVerdict(0, 0, false, "past"), "No working day");
  assert.equal(weeklySheetVerdict(0, 0, true, "past"), "Seat is vacant", "a vacant seat is a seat, never graded");
  // Every verdict has its tone, and only the two grades carry a colour of their own.
  assert.match(WEEKLY_SHEET_VERDICT_TONE.Met, /emerald/);
  assert.match(WEEKLY_SHEET_VERDICT_TONE.Below, /amber/);
  for (const verdict of ["So far", "Not started", "No working day", "Seat is vacant"] as const) {
    assert.match(WEEKLY_SHEET_VERDICT_TONE[verdict], /slate/, `${verdict} is graded on nothing, so it wears no grade's colour`);
  }
  assert.equal(weeklySheetGapWords(38, 50, "Below"), "12 short");
  assert.equal(weeklySheetGapWords(38, 50, "So far"), "12 to go");
  assert.equal(weeklySheetGapWords(52, 50, "Met"), null);
  assert.equal(weeklySheetGapWords(0, 50, "Not started"), null, "nothing is short of a week that has not begun");
}

function theWords() {
  // The targets are said once, from the rule's own constants.
  assert.equal(
    weeklySheetTargetLine(),
    "Target per working day: 10 PM and 2 AM — 50 PM and 10 AM in a full Saturday-to-Wednesday week. Approved leave and national holidays come out of the target.",
  );
  assert.equal(
    weeklySheetDepthLine(),
    "At least 3 doctors of each speciality — Pediatrics, Internal Medicine / GP, ENT — inside every AM account, read from the AM visit comments.",
  );
  const sheet = sampleSheet();
  const [ahmed, mona, vacant] = sheet.districts[0].reps;
  const karim = sheet.districts[1].reps[0];
  assert.equal(weeklySheetRepDaysLine(ahmed), "Shubra · 5 working days");
  assert.equal(weeklySheetRepDaysLine(mona), "Banha · 4 working days · 1 on leave");
  assert.equal(weeklySheetRepDaysLine(vacant), "Tanta", "a vacant seat has no days to speak of");
  assert.equal(weeklySheetRepDaysLine(karim), "Smouha · 0 working days · 5 on leave");
  assert.equal(weeklySheetRepDaysLine({ ...ahmed, workingDays: 1 }), "Shubra · 1 working day");
  assert.equal(weeklySheetWaitingLine(2), "2 waiting for validation");
  assert.equal(weeklySheetWaitingLine(0), null);
  assert.equal(isWeeklySheetMeasured(ahmed), true);
  assert.equal(isWeeklySheetMeasured(vacant), false);
  assert.equal(isWeeklySheetMeasured(karim), false, "no working day, nothing to measure");
}

function thePosition() {
  assert.equal(weeklySheetPosition(sampleSheet("2026-11-08")), "past", "Sunday after the Wednesday: over");
  assert.equal(weeklySheetPosition(sampleSheet("2026-11-05")), "past", "the Thursday after: over — a field week ends on Wednesday");
  assert.equal(weeklySheetPosition(sampleSheet("2026-11-04")), "current", "its own Wednesday still runs");
  assert.equal(weeklySheetPosition(sampleSheet("2026-10-31")), "current");
  assert.equal(weeklySheetPosition(sampleSheet("2026-10-30")), "ahead");
  assert.equal(weeklySheetPositionLine("past"), "The week is over, so every figure is final.");
  assert.equal(weeklySheetPositionLine("current"), "The week is still running: a target not reached yet reads “So far”, never “Below”.");
  assert.equal(weeklySheetPositionLine("ahead"), "This week has not started yet, so nothing is graded.");
  // The next week opens only once it has begun.
  assert.deepEqual(weeklySheetNav(sampleSheet("2026-11-08")), { next: "2026-11-07", previous: "2026-10-24" });
  assert.deepEqual(weeklySheetNav(sampleSheet("2026-11-07")), { next: "2026-11-07", previous: "2026-10-24" }, "its own Saturday opens it");
  assert.deepEqual(weeklySheetNav(sampleSheet("2026-11-02")), { next: null, previous: "2026-10-24" }, "never a week of zeros to come");
}

function theTeam() {
  const sheet = sampleSheet();
  const totals = weeklySheetTeamTotals(sheet);
  assert.equal(totals.seats, 5);
  assert.equal(totals.vacant, 1);
  assert.equal(totals.noWorkingDay, 1, "Karim, a week of leave");
  assert.equal(totals.measured, 3, "Ahmed, Mona and Sara");
  assert.deepEqual([totals.pm, totals.pmTarget, totals.am, totals.amTarget], [132, 140, 26, 28]);
  assert.equal(totals.pmByVerdict.Met, 2);
  assert.equal(totals.pmByVerdict.Below, 1, "Mona");
  assert.equal(totals.amByVerdict.Met, 2, "Ahmed, and Mona at 9 of her 8");
  assert.equal(totals.amByVerdict.Below, 1, "Sara");
  assert.equal(totals.bothMet, 1, "Ahmed alone");
  assert.equal(totals.pmByVerdict.Met + totals.pmByVerdict.Below, totals.measured, "every measured rep has one PM grade");
  assert.equal(totals.pharmacies, 25);
  assert.equal(totals.waiting, 2);
  assert.equal(totals.leaveDays, 6);
  assert.equal(totals.accounts, 5);
  assert.deepEqual(totals.byAccountState, { met: 2, no_doctors: 1, short: 2 });
  assert.deepEqual(totals.shortBy, { ent: 2, internal: 1, pediatrics: 1 });
  assert.equal(weeklySheetMetCaption(totals.pmByVerdict, totals.measured, "past"), "2 of 3 reps met · 1 below");
  assert.equal(weeklySheetUnmeasuredLine(totals), "1 vacant seat · 1 rep with no working day, counted in no grade");
  assert.equal(weeklySheetUnmeasuredLine({ noWorkingDay: 0, vacant: 0 }), null);
  assert.equal(weeklySheetTeamLine(totals, "past"), "3 reps measured · PM 132 of 140 · AM 26 of 28 · 1 met both");

  // Each district is the same arithmetic over its own reps.
  const delta = weeklySheetTotals(sheet.districts[0].reps, "past");
  const alex = weeklySheetTotals(sheet.districts[1].reps, "past");
  assert.equal(weeklySheetDistrictLine(delta, "past"), "PM 82 of 90 · AM 19 of 18 · 1 of 2 reps met both");
  assert.equal(weeklySheetDistrictLine(alex, "past"), "PM 50 of 50 · AM 7 of 10 · 0 of 1 rep met both");
  assert.equal(delta.pm + alex.pm, totals.pm, "the districts add up to the team");
  assert.equal(delta.measured + alex.measured, totals.measured);
  assert.equal(weeklySheetDistrictLine(weeklySheetTotals([sheet.districts[0].reps[2]], "past"), "past"), "PM 0 of 0 · AM 0 of 0 · no rep to measure");
}

function theBars() {
  const totals = weeklySheetTeamTotals(sampleSheet());
  const pm = weeklySheetVerdictBar(totals.pmByVerdict);
  assert.deepEqual(pm.map((part) => [part.key, part.count, part.percent]), [["Met", 2, 67], ["Below", 1, 33]], "the larger remainder takes the leftover point");
  assert.deepEqual(weeklySheetAccountBar(totals).map((part) => [part.key, part.percent]), [["met", 40], ["short", 40], ["no_doctors", 20]]);
  // Every bar adds up to exactly 100, whatever the counts.
  for (const counts of [[1, 1, 1], [2, 2, 3], [7, 0, 1], [1, 0, 0]]) {
    const parts = weeklySheetShares(counts.map((count, index) => ({ count, key: String(index), label: String(index), swatch: "bg-slate-300" })));
    assert.equal(parts.reduce((sum, part) => sum + part.percent, 0), 100, `${counts.join(",")} add up to 100`);
    assert.ok(parts.every((part) => part.count > 0), "an empty part is left out, never a zero-width slice");
  }
  assert.deepEqual(weeklySheetShares([{ count: 0, key: "a", label: "a", swatch: "" }]), [], "nothing to share is no bar");
}

function theAccounts() {
  assert.equal(weeklySheetDepthMet(3), true);
  assert.equal(weeklySheetDepthMet(2), false);
  assert.equal(weeklySheetAccountState(EL_SALAM.depth), "met");
  assert.equal(weeklySheetAccountState(DAR_EL_FOUAD.depth), "short");
  assert.equal(weeklySheetAccountState(EL_NOUR.depth), "no_doctors");
  assert.deepEqual(weeklySheetAccountShort(DAR_EL_FOUAD.depth).map((entry) => [entry.family, entry.missing]), [["internal", 2], ["ent", 3]]);
  assert.equal(weeklySheetAccountShortLine(DAR_EL_FOUAD.depth), "Needs 2 more Internal Medicine / GP · 3 more ENT");
  assert.equal(weeklySheetAccountShortLine(EL_HAYAH.depth), "Needs 1 more Pediatrics · 2 more ENT");
  assert.equal(weeklySheetAccountShortLine(EL_SALAM.depth), null, "a met account needs nothing");
  assert.equal(weeklySheetAccountShortLine(EL_NOUR.depth), null, "an account naming no doctor is short of nothing — nothing was read");
  assert.equal(weeklySheetAccountResult(EL_SALAM.depth), "Met");
  assert.equal(weeklySheetAccountResult(DAR_EL_FOUAD.depth), "Below");
  assert.equal(weeklySheetAccountResult(EL_NOUR.depth), "No doctors written");
  assert.equal(WEEKLY_SHEET_NO_DOCTORS, "No doctors written in the comment");
  // Short accounts first, then the ones naming nobody, then the met ones; by name inside each.
  assert.deepEqual(weeklySheetAccountsInOrder([EL_SALAM, EL_NOUR, DAR_EL_FOUAD]).map((entry) => entry.customerId), ["C2", "C3", "C1"]);
  const totals = weeklySheetTeamTotals(sampleSheet());
  assert.deepEqual(weeklySheetSpecialityGaps(totals).map((entry) => [entry.family, entry.accounts]), [["ent", 2], ["pediatrics", 1], ["internal", 1]]);
  assert.equal(weeklySheetSpecialityGapLine(totals), "ENT short in 2 accounts · Pediatrics in 1 · Internal Medicine / GP in 1");
  assert.equal(weeklySheetSpecialityGapLine({ shortBy: { ent: 0, internal: 0, pediatrics: 0 } }), null);
}

function theRepsToLookAt() {
  const sheet = sampleSheet();
  const items = weeklySheetAttention(sheet);
  assert.deepEqual(
    items.map((item) => [item.rep.person, item.reasons.map((entry) => entry.words)]),
    [
      ["Mona Saleh", ["PM 30 of 40 · 10 short", "2 visits waiting for validation"]],
      ["Ahmed Ali", ["1 account with no doctors written"]],
      ["Sara Nabil", ["AM 7 of 10 · 3 short"]],
    ],
    "most reasons first, then the larger PM gap, then the name",
  );
  assert.ok(!items.some((item) => item.rep.vacant), "a vacant seat is never a rep to look at");
  assert.ok(!items.some((item) => item.rep.person === "Karim Fawzy"), "a week of leave is never below a target");
  assert.deepEqual(weeklySheetAttentionCounts(items), { am_below: 1, no_doctors: 1, pm_below: 1, waiting: 1 });
  assert.equal(items[0].district.managerName, "Sahar El Gallad", "each rep keeps the district it sits in");

  // While the week runs nobody is below a target: only the waiting visits and the unnamed doctors list a rep.
  const running = weeklySheetAttention(sampleSheet("2026-11-02"));
  assert.deepEqual(running.map((item) => item.rep.person), ["Ahmed Ali", "Mona Saleh"]);
  assert.ok(running.every((item) => item.reasons.every((entry) => entry.reason !== "pm_below" && entry.reason !== "am_below")));
  assert.equal(weeklySheetAttentionEmptyLine("past"), "Every rep met both targets, with no visit waiting for validation and no account without its doctors.");
  assert.equal(weeklySheetAttentionEmptyLine("ahead"), "The week has not started.");
}

function aRunningWeek() {
  const sheet = sampleSheet("2026-11-02");
  const position = weeklySheetPosition(sheet);
  const mona = sheet.districts[0].reps[1];
  assert.deepEqual(weeklySheetRepVerdicts(mona, position), { am: "Met", pm: "So far" });
  assert.equal(weeklySheetGapWords(mona.pm, mona.pmTarget, "So far"), "10 to go");
  const totals = weeklySheetTeamTotals(sheet);
  assert.equal(totals.pmByVerdict.Below, 0, "never Below while the week runs");
  assert.equal(totals.pmByVerdict["So far"], 1);
  assert.equal(weeklySheetMetCaption(totals.pmByVerdict, totals.measured, position), "2 of 3 reps met · 1 still going");
  assert.equal(weeklySheetDistrictLine(weeklySheetTotals(sheet.districts[0].reps, position), position), "PM 82 of 90 · AM 19 of 18 · 1 of 2 reps met both so far");
  assert.equal(weeklySheetShowCounts(sheet).below, 0);
  assert.equal(weeklySheetShowEmptyLine("below", position), "Nobody is graded below a target until the week is over.");

  // A week not started grades nobody.
  const ahead = sampleSheet("2026-10-29");
  const aheadTotals = weeklySheetTeamTotals(ahead);
  assert.equal(aheadTotals.pmByVerdict["Not started"], 3);
  assert.equal(aheadTotals.bothMet, 0);
  assert.equal(weeklySheetMetCaption(aheadTotals.pmByVerdict, aheadTotals.measured, "ahead"), "3 reps to measure once the week starts");
  assert.equal(weeklySheetDistrictLine(weeklySheetTotals(ahead.districts[1].reps, "ahead"), "ahead"), "PM 50 of 50 · AM 7 of 10 · not started");
  assert.equal(weeklySheetTeamLine(aheadTotals, "ahead"), "3 reps measured · PM 132 of 140 · AM 26 of 28");
  assert.equal(weeklySheetMetCaption(aheadTotals.pmByVerdict, 0, "past"), "No rep to measure this week");
}

function theFilter() {
  const sheet = sampleSheet();
  assert.deepEqual(weeklySheetShowCounts(sheet), { all: 5, below: 2, met: 1 });
  const below = filterWeeklySheetDistricts(sheet, "below");
  assert.deepEqual(below.map((district) => [district.managerName, district.reps.map((entry) => entry.person), district.vacantSeats]), [
    ["Sahar El Gallad", ["Mona Saleh"], 0],
    ["Mostafa Kamel", ["Sara Nabil"], 0],
  ]);
  assert.deepEqual(filterWeeklySheetDistricts(sheet, "met").map((district) => district.reps.map((entry) => entry.person)), [["Ahmed Ali"]], "a district left empty goes");
  assert.equal(filterWeeklySheetDistricts(sheet, "all"), sheet.districts, "every seat is the sheet as it is");
  // The filter narrows the rows, never a figure: the team is the same whatever is listed.
  assert.deepEqual(weeklySheetTeamTotals({ ...sheet, districts: sheet.districts }), weeklySheetTeamTotals(sheet));
  // The heading is read off the whole district by its key, never off the filtered reps.
  assert.equal(weeklySheetDistrictKey(below[0]), weeklySheetDistrictKey(sheet.districts[0]));
  assert.deepEqual([...weeklySheetListedSeats(sheet, "below")].sort(), ["R2", "R4"]);
  assert.equal(parseWeeklySheetShow("below"), "below");
  assert.equal(parseWeeklySheetShow(["met", "below"]), "met");
  assert.equal(parseWeeklySheetShow("everything"), "all", "read strictly");
  assert.equal(parseWeeklySheetShow(undefined), "all");
  assert.equal(weeklySheetShowEmptyLine("met", "past"), "No rep has met both targets yet.");
  assert.equal(weeklySheetHref(null), "/employee-portals/weekly-sheet");
  assert.equal(weeklySheetHref("2026-10-31", "below"), "/employee-portals/weekly-sheet?week=2026-10-31&show=below");
  assert.equal(weeklySheetHref("2026-10-31", "all"), "/employee-portals/weekly-sheet?week=2026-10-31", "every seat is left out of the address");
  assert.equal(weeklySheetExportHref("2026-10-31"), "/api/crm/weekly-sheet/export?week=2026-10-31");
  assert.equal(weeklySheetRepAnchor({ seatId: "pedia:delta 1/R2" }), "rep-pedia-delta-1-R2", "an anchor holds no character a URL would mangle");
}

async function theWorkbook() {
  const sheet = sampleSheet();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await buildWeeklySheetWorkbook(sheet, "2026-11-09T06:00:00Z")) as unknown as ArrayBuffer);
  assert.deepEqual(workbook.worksheets.map((entry) => entry.name), ["Cover", "Districts", "Reps", "Accounts", "To look at"]);
  const values = (name: string) => {
    const out: string[] = [];
    workbook.getWorksheet(name)!.eachRow((row) => row.eachCell((cell) => out.push(String(cell.value ?? ""))));
    return out;
  };
  const rows = (name: string) => {
    const out: string[][] = [];
    workbook.getWorksheet(name)!.eachRow((row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => cells.push(String(cell.value ?? "")));
      out.push(cells);
    });
    return out;
  };
  const cover = values("Cover");
  assert.ok(cover.includes(weeklySheetTargetLine()), "the cover states the targets in the screen's own sentence");
  assert.ok(cover.includes("The week is over, so every figure is final."));
  assert.ok(cover.includes("132 of 140 · 2 of 3 reps met · 1 below"));
  assert.ok(cover.includes("ENT short in 2 accounts · Pediatrics in 1 · Internal Medicine / GP in 1"));
  assert.ok(cover.includes("5 · 3 measured · 1 vacant seat · 1 rep with no working day, counted in no grade"));

  const districts = rows("Districts");
  assert.ok(districts.some((row) => row.includes("Sahar El Gallad") && row.includes("82") && row.includes("90") && row.includes("1 of 2")), "the district's own figures");
  assert.ok(districts.some((row) => row.includes("Team") && row.includes("132") && row.includes("140")), "a team row adding the districts up");

  const reps = rows("Reps");
  const mona = reps.find((row) => row.includes("Mona Saleh"));
  assert.ok(mona && mona.includes("Below") && mona.includes("10 short") && mona.includes("1"), "Mona's PM grade, its gap and her day of leave");
  const vacant = reps.find((row) => row.includes("Tanta"));
  assert.ok(vacant && vacant.includes("Seat is vacant") && !vacant.includes("Below"), "a vacant seat is never Below");
  const karim = reps.find((row) => row.includes("Karim Fawzy"));
  assert.ok(karim && karim.includes("No working day") && !karim.includes("Met"), "a week of leave is never 0 of 0 Met");

  const accounts = rows("Accounts");
  const ahmedAccounts = accounts.filter((row) => row.includes("Ahmed Ali")).map((row) => row.find((cell) => /El Salam|Dar El Fouad|El Nour/.test(cell)));
  assert.deepEqual(ahmedAccounts, ["Dar El Fouad", "El Nour Center", "El Salam Hospital"], "short first, as on the screen");
  assert.ok(accounts.some((row) => row.includes("Needs 2 more Internal Medicine / GP · 3 more ENT")));
  const nour = accounts.find((row) => row.includes("El Nour Center"));
  assert.ok(nour && nour.includes(WEEKLY_SHEET_NO_DOCTORS) && nour.includes("No doctors written") && !nour.includes("0"), "never a zero for a comment naming nobody");

  const look = rows("To look at");
  assert.ok(look.some((row) => row.includes("Mona Saleh") && row.includes("PM 30 of 40 · 10 short · 2 visits waiting for validation")));
  assert.equal(look.filter((row) => row.includes("Sahar El Gallad") || row.includes("Mostafa Kamel")).length, 3, "the three reps to look at, once each");

  // The file holds every seat once, whatever the screen's filter.
  assert.equal(reps.filter((row) => ["Ahmed Ali", "Mona Saleh", "Tanta", "Karim Fawzy", "Sara Nabil"].some((name) => row.includes(name))).length, 5);
  assert.equal(weeklySheetWorkbookFileName(sheet), "weekly-sheet-2026-10-31.xlsx");

  // A running week's file says "So far", never "Below".
  const running = new ExcelJS.Workbook();
  await running.xlsx.load((await buildWeeklySheetWorkbook(sampleSheet("2026-11-02"), "2026-11-02T06:00:00Z")) as unknown as ArrayBuffer);
  const runningReps: string[] = [];
  running.getWorksheet("Reps")!.eachRow((row, index) => {
    if (index > 1) row.eachCell((cell) => runningReps.push(String(cell.value ?? "")));
  });
  assert.ok(runningReps.includes("So far") && runningReps.includes("10 to go"));
  assert.ok(!runningReps.includes("Below"), "never Below in a running week's file");
}

function theScreenAndTheRoute() {
  const read = (path: string) => stripComments(readFileSync(path, "utf8"));
  const view = read("src/components/crm/regional/weekly-sheet-view.tsx");
  const panels = read("src/components/crm/regional/weekly-sheet-panels.tsx");
  const page = read("app/employee-portals/weekly-sheet/page.tsx");
  const route = read("app/api/crm/weekly-sheet/export/route.ts");
  const workbook = read("src/lib/crm/weekly-sheet-workbook.ts");
  for (const [name, source] of [["view", view], ["panels", panels], ["page", page], ["workbook", workbook]] as const) {
    assert.ok(!/\b10 PM and 2 AM\b|\b50 PM\b|against 50|against 10/.test(source), `${name}: the targets are never typed as numbers`);
  }
  for (const [name, source] of [["view", view], ["panels", panels]] as const) {
    assert.ok(!/\brounded(?!-none)/.test(source), `${name}: square corners`);
    assert.ok(!/shadow-|gradient|blur|glow/.test(source), `${name}: flat colour`);
    assert.ok(!/\btruncate\b|line-clamp|text-ellipsis|…/.test(source), `${name}: no ellipsis`);
    assert.ok(!/overflow-x-auto|min-w-\[/.test(source), `${name}: never a sideways scroll`);
    assert.ok(!/text-phx-(?:2xs|3xs|4xs)\b/.test(source), `${name}: no text below 11px`);
    assert.ok(!/\bhrId\b/.test(source), `${name}: never a raw HR id`);
  }
  // The view grades through the lib and never re-decides a grade or a word of its own.
  assert.ok(view.includes("weeklySheetVerdict(value, target, vacant, position)"), "every figure's grade is the lib's");
  assert.ok(!view.includes("weeklySheetResult("), "never the finished-week rule alone, which grades a running week Below");
  assert.ok(!view.includes(">=") && !view.includes("DOCTORS_PER_SPECIALITY"), "the depth is judged by weeklySheetDepthMet, not inline");
  assert.ok(!view.includes('"No doctors written in the comment"'), "the words are the lib's constant");
  assert.ok(view.includes("if (rep.accounts.length === 0) {"), "a rep with no AM account offers nothing to open");
  assert.ok(view.includes("id={anchor}"), "every rep row carries its anchor for Reps to look at");
  assert.ok(view.includes("wholeDistrict.get(weeklySheetDistrictKey(district))"), "a heading is the whole district's, whatever the filter");
  assert.ok(panels.includes("{nav.next ? ("), "Next week only once it has begun");
  assert.ok(panels.includes("weeklySheetTargetLine()") && panels.includes("weeklySheetDepthLine()"), "the targets stated once, from the lib");
  assert.ok(page.includes("parseWeeklySheetShow(params.show)"), "the page reads the filter strictly");
  assert.ok(page.includes("readsRegionOrDistrictReports(viewer)"), "the page keeps the team-report gate (an RSM or a DM seat)");
  // The export keeps its gate, its rate limit and its audit, and names the file by the lib.
  assert.ok(route.indexOf("readsRegionOrDistrictReports(viewer)") < route.indexOf("loadWeeklySheet("), "the gate before any read");
  assert.ok(route.includes('scope: "export:crm:weekly-sheet"'), "rate-limited");
  assert.ok(route.includes('entityType: "crm_weekly_sheet_export"'), "audited");
  assert.ok(route.includes("weeklySheetWorkbookFileName(sheet)") && route.includes("weeklySheetTeamTotals(sheet)"), "the file name and the count are the lib's");
  assert.ok(!route.includes(".reduce("), "no arithmetic of its own");
  // No on-screen word speaks of a person as he or she.
  for (const [name, source] of [["view", view], ["panels", panels], ["page", page], ["workbook", workbook]] as const) {
    const literals = source.match(/(["'`])(?:\\.|(?!\1)[\s\S])*\1/g) ?? [];
    const text = [...literals, ...[...source.matchAll(/>([^<>{}]+)</g)].map((match) => match[1] ?? "")];
    assert.ok(!text.some((value) => /\b(?:he|his|him|she|her)\b/i.test(value)), `${name}: no gendered word on screen or in the file`);
  }
}

export async function runWeeklySheetPremiumTests(): Promise<void> {
  theVerdicts();
  theWords();
  thePosition();
  theTeam();
  theBars();
  theAccounts();
  theRepsToLookAt();
  aRunningWeek();
  theFilter();
  await theWorkbook();
  theScreenAndTheRoute();
}
