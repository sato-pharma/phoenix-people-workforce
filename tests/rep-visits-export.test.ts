import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import {
  ageOn,
  checkExportRange,
  dayRecord,
  dayType,
  repeatColours,
  repeatCounts,
  REP_VISITS_EXPORT_MAX_DAYS,
  repVisitsExportFileName,
  standing,
  type ExportDayFacts,
  type ExportVisit,
  type RepVisitsExportData,
} from "../src/lib/rep-visits-export/rules.ts";
import { addDays, fileNameOf, probationMatches, retryWaitSeconds, reviewPeriodFor, visitsPeriodFor } from "../src/lib/rep-visits-export/desk.ts";
import { REVIEW_MAX_PERIOD_MONTHS, resolveReviewPeriod } from "../src/lib/sales/rep-effectiveness/model.ts";
import { buildRepVisitsWorkbook, EVERY_DAY_HEADERS, everyDayRows, REP_VISITS_WORKBOOK_SHEETS } from "../src/lib/rep-visits-export/workbook.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE REP VISITS EXPORT (owner, 24 Nov 2026: "i want 2 be able to extract from system exactly the same as this sheet
 * plus the doctor by brick and doctor list i filter rep duration", then "in everyday tab in must be formated as a table
 * bec i will pivot it .. in visits per day add all month days and mention vacation no records meeting etc", then "add a
 * cover sheet name area line salary hiring date birth of date and age").
 *
 * What would go wrong, each without an error anyone could see:
 *   - Every day stops being a real Excel table, or a day row counts as a visit, and his pivot's Sum of Visits lies.
 *   - A day with no visit drops out of Visits per day, and a refused leave or a day with nothing recorded disappears.
 *   - Two customers share a colour in one month, and the grid's "same colour = same customer" reading is false.
 *   - The Cover's age is a year out around the birthday, or a missing salary prints as 0.
 *   - The export, which carries salary, leave and deductions, opens to someone other than the Super Admin.
 */

const visit = (day: string, list: ExportVisit["list"], customerKey: string, time: string | null, extra: Partial<ExportVisit> = {}): ExportVisit => ({
  day,
  list,
  kind: "single",
  unplanned: false,
  customerKey,
  customerName: `Dr ${customerKey}`,
  speciality: "Pediatrics",
  time,
  distanceMeters: 40,
  grade: "A",
  locationFlag: "ok",
  copiedFromOldCrm: time === null,
  brickName: "Brick One",
  ...extra,
});

function facts(partial: Partial<ExportDayFacts> = {}): ExportDayFacts {
  return {
    starts: partial.starts ?? new Map(),
    activities: partial.activities ?? new Map(),
    holidays: partial.holidays ?? new Map(),
    leave: partial.leave ?? new Map(),
    charged: partial.charged ?? new Set(),
  };
}

// 2026-10-29 Thu, 10-30 Fri, 10-31 Sat, 11-01 Sun, 11-02 Mon, 11-03 Tue, 11-04 Wed.
const VISITS: ExportVisit[] = [
  visit("2026-10-29", "AM", "c1", null),
  visit("2026-10-29", "PM", "c2", null),
  visit("2026-10-31", "PM", "c1", "18:10"),
  visit("2026-10-31", "PM", "c3", "19:00", { locationFlag: "far", unplanned: true }),
  visit("2026-11-02", "PM", "c2", "17:30"),
  visit("2026-11-02", "PM", "c2", "18:45"),
  visit("2026-11-03", "AM", "c4", "10:15", { grade: "B" }),
];

const DAYS = facts({
  starts: new Map([
    ["2026-10-31", "09:05"],
    ["2026-11-02", "09:12"],
  ]),
  activities: new Map([["2026-11-01", ["Meeting: cycle meeting in Tanta"]]]),
  leave: new Map([["2026-11-04", "Sick leave asked · manager approved, HR refused"]]),
  charged: new Set(["2026-11-04"]),
});

function fixture(): RepVisitsExportData {
  return {
    rep: {
      hrId: "S-1",
      name: "Sara Fathy",
      role: "Medical Representative",
      line: "Pedia",
      areaName: "Tanta 1",
      areaCode: "D10",
      hireDate: "2025-09-12",
      birthDate: "2000-11-04",
      salary: { base: 12000, basic: 8400, gross: 13500, net: 11800 },
    },
    from: "2026-10-29",
    to: "2026-11-04",
    today: "2026-11-04",
    visits: VISITS,
    doctors: [
      { customerKey: "c1", status: "active", list: "AM", grade: "A", name: "Dr c1", speciality: null, brickId: "B1", brickName: "Brick One", areaCode: "D10", areaName: "Tanta 1" },
      { customerKey: "c2", status: "active", list: "PM", grade: "A", name: "Dr c2", speciality: null, brickId: "B1", brickName: "Brick One", areaCode: "D10", areaName: "Tanta 1" },
      { customerKey: "c3", status: "active", list: "PM", grade: "B", name: "Dr c3", speciality: null, brickId: "B9", brickName: "Brick Nine", areaCode: "D11", areaName: "Tanta 2" },
      { customerKey: "c5", status: "pending", list: "PM", grade: "A", name: "Dr c5", speciality: null, brickId: null, brickName: null, areaCode: null, areaName: null },
    ],
    gradeTargets: { PM: { A: 3, B: 2, C: 1 }, AM: { A: 1 } },
    days: DAYS,
    brickSales: {
      months: ["2026-09", "2026-10"],
      bricks: [
        { brickId: "B1", brickName: "Brick One", areaCode: "D10", current: true, byMonth: { "2026-09": 1200, "2026-10": 900 } },
        { brickId: "B2", brickName: "Brick Two", areaCode: "D10", current: true, byMonth: { "2026-10": 5000 } },
      ],
    },
  };
}

function rangeAndFileName(): void {
  assert.deepEqual(checkExportRange("2026-10-01", "2026-12-31", "2026-11-24"), { ok: true, from: "2026-10-01", to: "2026-11-24" }, "a range past today stops at today");
  assert.equal(checkExportRange("2026-11-10", "2026-11-01", "2026-11-24").ok, false, "from after to is refused");
  assert.equal(checkExportRange("2026-12-01", "2026-12-02", "2026-11-24").ok, false, "a range that starts in the future is refused");
  assert.equal(checkExportRange("2026-01-01", "2026-11-24", "2026-11-24").ok, false, "more than 186 days is refused");
  assert.equal(checkExportRange("2026-02-30", "2026-03-01", "2026-11-24").ok, false, "a day that does not exist is refused");
  assert.equal(repVisitsExportFileName("Sara Fathy", "2026-09-12", "2026-11-24"), "Sara Fathy - Visits, Bricks and Doctors - 12 Sep 2026 to 24 Nov 2026.xlsx");
}

function ageAroundTheBirthday(): void {
  assert.equal(ageOn("2000-11-04", "2026-11-03"), 25, "the day before the birthday");
  assert.equal(ageOn("2000-11-04", "2026-11-04"), 26, "on the birthday");
  assert.equal(ageOn(null, "2026-11-04"), null);
  assert.equal(ageOn("2030-01-01", "2026-11-04"), null, "a birth date after the day is no age");
}

function theDaysRecord(): void {
  const byDay = (day: string) => VISITS.filter((v) => v.day === day);
  assert.equal(dayType("2026-10-30", [], DAYS, "2026-11-04"), "Friday · weekly off");
  assert.equal(dayType("2026-11-01", [], DAYS, "2026-11-04"), "Meeting");
  assert.equal(dayType("2026-11-04", [], DAYS, "2026-11-04"), "Leave refused · charged", "a refused leave that was charged says both, even today");
  assert.equal(dayType("2026-10-30", [], facts(), "2026-11-04"), "Friday · weekly off");
  assert.equal(dayType("2026-11-03", [], facts(), "2026-11-04"), "No record");
  assert.equal(dayType("2026-10-29", byDay("2026-10-29"), DAYS, "2026-11-04"), "Visits");
  assert.deepEqual(dayRecord("2026-10-29", byDay("2026-10-29"), DAYS, "2026-11-04"), ["Visits brought from the old CRM, no time"]);
  assert.deepEqual(dayRecord("2026-11-03", [], facts(), "2026-11-04"), ["No visit · nothing recorded"]);
  assert.deepEqual(dayRecord("2026-11-03", byDay("2026-11-03"), DAYS, "2026-11-04"), ["Visits · no day start recorded"], "a visit day with nothing else still says so");
  assert.deepEqual(dayRecord("2026-11-04", [], DAYS, "2026-11-04"), ["Today", "Sick leave asked · manager approved, HR refused", "No activity · charged"]);
}

function repeatColoursNeverShareAMonth(): void {
  const visits = [
    ...["a", "b", "c", "d", "e"].flatMap((key) => [visit("2026-10-01", "PM", key, "10:00"), visit("2026-10-02", "PM", key, "11:00")]),
    visit("2026-11-01", "PM", "a", "10:00"),
    visit("2026-11-02", "PM", "a", "10:00"),
    visit("2026-11-03", "PM", "z", "10:00"),
  ];
  const colours = repeatColours(visits);
  const october = ["a", "b", "c", "d", "e"].map((key) => colours.get(key));
  assert.equal(new Set(october).size, 5, "five customers repeated in one month wear five colours");
  assert.equal(colours.has("z"), false, "a customer seen once in the month has no colour");
  assert.equal(repeatCounts(visits).get("2026-11|a"), 2);
  assert.equal(standing(0, 3), "Not visited");
  assert.equal(standing(2, 3), "Behind");
  assert.equal(standing(1, null), "Visited", "a grade with no number counts as covered after one visit");
}

async function theWorkbook(): Promise<void> {
  const data = fixture();
  const book = new ExcelJS.Workbook();
  await book.xlsx.load((await buildRepVisitsWorkbook(data)) as unknown as ArrayBuffer);
  assert.deepEqual(book.worksheets.map((sheet) => sheet.name), [...REP_VISITS_WORKBOOK_SHEETS]);
  assert.equal(REP_VISITS_WORKBOOK_SHEETS[0], "Cover", "the Cover comes first");

  // The Cover.
  const cover = new Map<string, unknown>();
  book.getWorksheet("Cover")!.eachRow((row) => cover.set(String(row.getCell(1).value ?? ""), row.getCell(2).value));
  assert.equal(cover.get("Name"), "Sara Fathy");
  assert.equal(cover.get("Area"), "Tanta 1");
  assert.equal(cover.get("Line"), "Pedia");
  assert.equal(cover.get("Age"), "26 years");
  assert.equal(cover.get("Gross salary"), 13500);
  assert.equal(cover.get("Net salary"), 11800);
  assert.equal((cover.get("Hiring date") as Date).toISOString().slice(0, 10), "2025-09-12");
  assert.equal((cover.get("Date of birth") as Date).toISOString().slice(0, 10), "2000-11-04");
  const missing = fixture();
  missing.rep.salary = { base: null, basic: null, gross: null, net: null };
  missing.rep.birthDate = null;
  const book2 = new ExcelJS.Workbook();
  await book2.xlsx.load((await buildRepVisitsWorkbook(missing)) as unknown as ArrayBuffer);
  const cover2 = new Map<string, unknown>();
  book2.getWorksheet("Cover")!.eachRow((row) => cover2.set(String(row.getCell(1).value ?? ""), row.getCell(2).value));
  assert.equal(cover2.get("Gross salary"), "Not on the record", "a missing salary never prints as 0");
  assert.equal(cover2.get("Age"), "Not on the record");

  // Every day: a real Excel table, one day row per day, Visits sums to the visits.
  const every = book.getWorksheet("Every day")!;
  const tables = (every as unknown as { tables: Record<string, unknown> }).tables;
  assert.ok(tables && "EveryDay" in tables, "Every day is an Excel table named EveryDay");
  assert.deepEqual(EVERY_DAY_HEADERS.map((_, j) => every.getCell(1, j + 1).value), [...EVERY_DAY_HEADERS]);
  assert.equal(every.model.merges?.length ?? 0, 0, "no merged cell in the table");
  const rows = everyDayRows(data);
  assert.equal(rows.filter((row) => row[3] === "Day record").length, 7, "one day row for each of the seven days");
  assert.equal(rows.filter((row) => row[3] === "Visit").length, VISITS.length);
  assert.equal(rows.reduce((sum, row) => sum + Number(row[4]), 0), VISITS.length, "Sum of Visits counts visits only");
  assert.ok(rows.every((row) => row[17] && row[18]), "every row carries its day type and day record");
  assert.equal(rows[0][3], "Day record", "each day starts with its record row");

  // Visits per day: every day of the range, the quiet ones included.
  const perDay: string[] = [];
  book.getWorksheet("Visits per day")!.eachRow((row, n) => {
    if (n > 3) perDay.push(String(row.getCell(6).value ?? ""));
  });
  for (const type of ["Friday · weekly off", "Meeting", "Leave refused · charged"]) assert.ok(perDay.includes(type), `Visits per day lists a ${type} day`);
  assert.equal(perDay.filter((type) => type === "Visits").length, 4);

  // Doctors by brick: another area's doctor is said in words, and the top-selling brick with no doctor is named.
  const shows: string[] = [];
  book.getWorksheet("Doctors by brick")!.eachRow((row) => row.eachCell((cell) => shows.push(String(cell.value ?? ""))));
  assert.ok(shows.some((text) => text.includes("1 of the 3 approved doctors")), "the share on another area's bricks is said");
  assert.ok(shows.some((text) => text.includes("Brick Two, the brick that sold most")), "the top brick with no doctor is named");
  assert.ok(shows.some((text) => text.includes("1 more doctors are still waiting")), "the doctors not validated yet are counted");
}

function theSuperAdminsAlone(): void {
  const route = stripComments(readFileSync("app/api/admin/rep-visits-export/route.ts", "utf8"));
  const gate = route.indexOf("canExportRepVisits(access)");
  assert.ok(gate > 0 && gate < route.indexOf("loadRepVisitsExport("), "the route asks the gate before any read");
  assert.match(route, /assertExportRateLimit\(/, "the export is rate-limited");
  assert.match(route, /writeAuditLog\(/, "the export is audited");
  const server = stripComments(readFileSync("src/lib/rep-visits-export/server.ts", "utf8"));
  assert.match(server, /export function canExportRepVisits\(access: Pick<AccessContext, "role">\): boolean \{\s*return access\.role === "Super Admin";/);
  assert.ok(server.indexOf("if (!canExportRepVisits(access)) throw forbiddenError") < server.indexOf("getSupabaseAdmin()"), "the loader asks again before its first read");
  const page = stripComments(readFileSync("app/(admin)/admin/rep-visits-export/page.tsx", "utf8"));
  assert.match(page, /if \(!canExportRepVisits\(access\)\) redirect\(/, "anybody else is redirected from the page");
  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.match(registry, /pattern: "\/api\/admin\/rep-visits-export"/);
  const nav = readFileSync("src/config/system-navigation.ts", "utf8");
  const entry = nav.slice(nav.indexOf('href: "/admin/rep-visits-export"'));
  assert.match(entry.slice(0, 600), /roles: \["Super Admin"\]/, "the menu card is the Super Admin's alone");
}

/**
 * The rep desk (owner, 26 Nov 2026: "make me able to for example filter line pedia probation status critical
 * and filter from their hire date to utd"; of the download, "one or multiple as i want").
 */
function theRepDesk(): void {
  // Probation, in the tracker's own zones.
  assert.equal(probationMatches("critical", "critical"), true);
  assert.equal(probationMatches("warning", "critical"), false, "Critical is the critical zone alone");
  assert.equal(probationMatches("overdue", "on"), true, "a probation that ended with no decision is still on probation");
  assert.equal(probationMatches("none", "on"), false);
  assert.equal(probationMatches("none", "none"), true);
  assert.equal(probationMatches("unread", "critical"), true, "an unread tracker hides nobody; the page says the filter is off");

  // From each rep's hire date to today.
  const today = "2026-11-26";
  type DeskRep = { name: string; hireDate: string | null };
  const visits = (rep: DeskRep, fromHire = true) =>
    visitsPeriodFor(rep, { from: "2026-11-01", to: today, fromHire, today, maxDays: REP_VISITS_EXPORT_MAX_DAYS });
  const ebtissam: DeskRep = { name: "Ebtissam Alaa", hireDate: "2026-09-12" };
  assert.deepEqual(visits(ebtissam), { from: "2026-09-12", to: today }, "hire date to today");
  assert.deepEqual(visits(ebtissam, false), { from: "2026-11-01", to: today }, "unticked, the chosen range");
  const longServing = visits({ name: "A long-serving rep", hireDate: "2019-03-01" });
  assert.ok(!("error" in longServing));
  assert.deepEqual(checkExportRange(longServing.from, longServing.to, today), { ok: true, ...longServing }, "a rep hired long ago starts at the day limit, which the route accepts");
  assert.equal(checkExportRange(addDays(longServing.from, -1), longServing.to, today).ok, false, "one day earlier is refused: the limit is used to the day");
  const undated = visits({ name: "Nour Samir", hireDate: null });
  assert.ok("error" in undated && /Nour Samir has no hire date/.test(undated.error), "a rep with no hire date is named, never given a made-up period");

  const review = (rep: DeskRep) =>
    reviewPeriodFor(rep, { from: "2025-12", to: "2026-11", fromHire: true, today, maxMonths: REVIEW_MAX_PERIOD_MONTHS });
  assert.deepEqual(review(ebtissam), { from: "2026-09", to: "2026-11" }, "hire month to this month");
  const reviewLong = review({ name: "A long-serving rep", hireDate: "2019-03-01" });
  assert.deepEqual(reviewLong, { from: "2025-12", to: "2026-11" }, "at most twelve months back");
  assert.deepEqual(resolveReviewPeriod(reviewLong, today), reviewLong, "which the review route accepts");

  // One file, or many in one zip; the ten-a-minute limit is waited out, never raised.
  assert.equal(fileNameOf('attachment; filename="Ebtissam-Alaa-Visits.xlsx"'), "Ebtissam-Alaa-Visits.xlsx");
  assert.equal(retryWaitSeconds("42"), 42);
  assert.equal(retryWaitSeconds(null), 30);
  assert.equal(retryWaitSeconds("900"), 90);
  const desk = stripComments(readFileSync("src/components/rep-visits-export/rep-export-desk.tsx", "utf8"));
  assert.match(desk, /probationMatches\(option\.probation, probation\)/, "the probation filter is the shared rule");
  assert.match(desk, /option\.line === line/, "the line filter");
  assert.match(desk, /visitsPeriodFor\(rep, \{ from: visitsFrom, to: visitsTo, fromHire: visitsFromHire,/, "each rep's range is the chosen one, or the rep's own from the hire date");
  assert.match(desk, /response\.status === 429/, "a run that meets the export limit waits and carries on");
  assert.match(desk, /await import\("jszip"\)/, "several reps are saved as one zip");
  const limit = readFileSync("src/lib/http/assert-export-rate-limit.ts", "utf8");
  assert.match(limit, /limit: 10,/, "the export limit is not raised for the desk");
  const page = stripComments(readFileSync("app/(admin)/admin/rep-visits-export/page.tsx", "utf8"));
  assert.match(page, /<RepExportDesk\s/);
  assert.match(page, /visitsRoute=\{EXPORT_ROUTE\}/);
  const server = stripComments(readFileSync("src/lib/rep-visits-export/server.ts", "utf8"));
  assert.match(server, /getProbationTrackerRows\(access\)/, "probation is the tracker's own reading");
  assert.match(server, /classifyProbationRowZone\(row\)/);
  assert.match(server, /probation \? \(probation\.get\(personKey\(hrId\)\) \?\? "none"\) : "unread"/, "a tracker that could not be read is said, never shown as not on probation");
}

export async function runRepVisitsExportTests() {
  rangeAndFileName();
  ageAroundTheBirthday();
  theDaysRecord();
  repeatColoursNeverShareAMonth();
  await theWorkbook();
  theSuperAdminsAlone();
  theRepDesk();
}
