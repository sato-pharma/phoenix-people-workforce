import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import type { TeamVisitDay, TeamVisitDistrict, TeamVisitRep, TeamVisitsReport, TeamVisitTime } from "../src/lib/phoenix-crm/server/team-visits.ts";
import { foldTeamVisitDay } from "../src/lib/phoenix-crm/server/team-visits.ts";
import {
  cairoClockOf,
  doctorVisitsOf,
  filterTeamVisitReps,
  isVacantTeamVisitRep,
  parseTeamVisitDay,
  parseTeamVisitShow,
  savedVisitsOf,
  TEAM_VISIT_HOUR_BLOCKS,
  teamVisitAttention,
  teamVisitBarWidth,
  teamVisitDayHeading,
  teamVisitDistrictAnchor,
  teamVisitDistrictRollups,
  teamVisitFiguresLine,
  teamVisitFilterHref,
  teamVisitHourBlockOf,
  teamVisitHourSpread,
  teamVisitRepState,
  teamVisitShowCounts,
  teamVisitSpanLabel,
  teamVisitTeamRollup,
  teamVisitTimeline,
  teamVisitTimelineLine,
  teamVisitTimesByList,
  teamVisitVacantLine,
  teamVisitVacantSeats,
  teamVisitWaitingLine,
  teamVisitBusinessDayOf,
  teamVisitDayStrip,
  teamVisitManagersInField,
  teamVisitPace,
  teamVisitPaceLine,
  teamVisitRepPace,
  TEAM_VISIT_STRIP_TICKS,
  visitDayHour,
  visitDayMinutes,
  parseTeamVisitSort,
  sortTeamVisitReps,
  TEAM_VISIT_PHONE_FOLD,
  TEAM_VISIT_SORT_LABEL,
  teamVisitNonWorkingNotice,
  teamVisitWeekdayOf,
  teamVisitSignedDifference,
  teamVisitTeamPace,
  teamVisitListedSeatIds,
  teamVisitRepAnchor,
} from "../src/lib/phoenix-crm/server/team-visits-summary.ts";
import { buildTeamVisitsWorkbook, TEAM_VISITS_PACE_CLOSED, TEAM_VISITS_WORKBOOK_SHEETS, teamVisitsWorkbookFileName } from "../src/lib/phoenix-crm/server/team-visits-workbook.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * VISITS — YESTERDAY AND TODAY, THE PREMIUM PASS (owner, 9 Nov 2026: "eyeball every report in My Team's Reports,
 * premium polish big work, every single component", then "group reps by district manager").
 *
 * What would go wrong, each without an error anyone could see:
 *
 *   1. a saved time put in the wrong two-hour block, or in two, or a copied visit with no time counted as midnight —
 *      the hours panel would add up to a number the rows do not;
 *   2. a vacant seat counted as a rep who "saved no visits" — a manager reads an empty chair as an absent rep;
 *   3. the teams side by side not adding up to the tiles, or a pharmacy creeping into "doctor visits";
 *   4. the filter changing a figure instead of only the rows listed;
 *   5. the Excel file disagreeing with the screen, merging AM · PM · Pharmacies, or reading a location;
 *   6. the export reachable by someone the screen refuses.
 *
 * Each block below pins one of those.
 */

/** A Cairo wall-clock instant on the given calendar day (Cairo is UTC+2 in November). */
function at(hour: number, minute = 0, date = "2026-11-08"): string {
  const [year, month, dayOfMonth] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, dayOfMonth, hour - 2, minute)).toISOString();
}

function time(list: TeamVisitTime["list"], iso: string | null, over: Partial<TeamVisitTime> = {}): TeamVisitTime {
  const clock = cairoClockOf(iso);
  const savedAt = clock ? `${String(clock.hour % 12 === 0 ? 12 : clock.hour % 12).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")} ${clock.hour < 12 ? "AM" : "PM"}` : null;
  return { at: iso, customer: "Dr. Sample", distanceNote: null, list, metres: null, origin: "planned", savedAt, waiting: false, ...over };
}

function day(over: Partial<TeamVisitDay> = {}): TeamVisitDay {
  return { am: 0, pharmacies: 0, pm: 0, times: [], waiting: 0, ...over };
}

function rep(seatId: string, person: string, over: Partial<TeamVisitRep> = {}): TeamVisitRep {
  return { hireDates: [], person, seatId, territory: `${person} territory`, today: day(), vacant: false, yesterday: day(), ...over };
}

function vacantSeat(seatId: string, territory: string): TeamVisitRep {
  return { hireDates: [], person: "Seat is vacant", seatId, territory, today: day(), vacant: true, yesterday: day() };
}

function district(regionName: string, managerName: string, reps: TeamVisitRep[]): TeamVisitDistrict {
  const sum = (key: "today" | "yesterday") =>
    reps.reduce((total, entry) => ({ ...total, am: total.am + entry[key].am, pharmacies: total.pharmacies + entry[key].pharmacies, pm: total.pm + entry[key].pm, waiting: total.waiting + entry[key].waiting }), day());
  return {
    districtName: `${managerName} district`,
    managerDay: null,
    managerHireDate: null,
    managerHrId: `HR-${managerName}`,
    managerName,
    managerOwn: { today: day(), yesterday: day({ am: 1, times: [time("AM", at(9, 15), { customer: "Own hospital" })] }) },
    regionName,
    repsTotal: { today: sum("today"), yesterday: sum("yesterday") },
    reps,
    vacantSeats: reps.filter((entry) => entry.vacant).length,
  };
}

function sampleReport(): TeamVisitsReport {
  const momen = rep("R1", "Momen Fathy", {
    today: day({ pm: 1, times: [time("PM", at(10, 5, "2026-11-09"))] }),
    yesterday: day({
      am: 2,
      pm: 4,
      times: [
        time("AM", at(12, 44)),
        time("AM", at(12, 58)),
        time("PM", at(13, 36)),
        time("PM", at(14, 28)),
        time("PM", at(16, 19)),
        time("PM", at(16, 29)),
        time("PM", at(17, 5), { waiting: true }),
        time("PM", at(17, 10), { waiting: true }),
      ],
      waiting: 2,
    }),
  });
  const ghoneim = rep("R2", "Ghoneim Mohamed");
  const shahd = rep("R3", "Shahd Mohamed", {
    yesterday: day({ times: [time("PM", at(18, 20), { waiting: true })], waiting: 1 }),
  });
  const hassan = rep("R4", "Hassan Mohamed", {
    yesterday: day({
      am: 2,
      pharmacies: 2,
      pm: 3,
      times: [
        time("AM", at(10, 26)),
        time("AM", at(10, 35)),
        time("Pharmacy", at(10, 35)),
        time("PM", at(12, 39)),
        time("Pharmacy", at(12, 39)),
        time("PM", at(20, 39)),
        time("PM", null),
      ],
    }),
  });
  const first = district("Alex-BHR", "Mohamed Eleiwa", [momen, ghoneim, vacantSeat("V1", "Alex West"), shahd]);
  const second = district("Delta (1)", "Nermeen Salah", [hassan, vacantSeat("V2", "Sharkia 1"), vacantSeat("V3", "Sharkia 2")]);
  const totals = {
    today: day({ pm: 1 }),
    yesterday: day({ am: 4, pharmacies: 2, pm: 7, waiting: 3 }),
  };
  return { districts: [first, second], today: "2026-11-09", totals, yesterday: "2026-11-08" };
}

function hoursAndClock() {
  // Every hour of the day falls in exactly one block, read on the VISIT day, and the blocks run edge to edge.
  for (let hour = 0; hour < 24; hour += 1) {
    const dayHour = visitDayHour(hour);
    const holding = TEAM_VISIT_HOUR_BLOCKS.filter((block) => dayHour >= block.fromHour && dayHour < block.toHour);
    assert.equal(holding.length, 1, `hour ${hour} sits in exactly one block`);
    assert.equal(teamVisitHourBlockOf(hour).key, holding[0].key);
  }
  assert.equal(TEAM_VISIT_HOUR_BLOCKS[0].fromHour, 2, "the visit day opens at 02:00 Cairo");
  assert.equal(TEAM_VISIT_HOUR_BLOCKS[TEAM_VISIT_HOUR_BLOCKS.length - 1].toHour, 26, "and closes at 02:00 the next morning");
  // The small hours belong to the evening before (the visit day runs to 02:00, owner, 2026-09-29).
  assert.equal(teamVisitHourBlockOf(1).label, "8 PM – 2 AM", "a visit saved at 01:30 is the evening's, never the morning's");
  assert.equal(teamVisitHourBlockOf(2).label, "Before 10 AM", "02:00 opens the next visit day");
  assert.equal(visitDayMinutes({ hour: 2, minute: 0 }), 0);
  assert.equal(visitDayMinutes({ hour: 1, minute: 59 }), 1439);
  assert.equal(teamVisitBusinessDayOf("2026-11-08T23:30:00Z"), "2026-11-08", "01:30 Cairo on 9 Nov is still the visit day of 8 Nov");
  assert.equal(teamVisitBusinessDayOf("2026-11-09T00:00:00Z"), "2026-11-09", "02:00 Cairo is the new visit day");
  assert.equal(teamVisitBusinessDayOf(null), null);
  for (let index = 1; index < TEAM_VISIT_HOUR_BLOCKS.length; index += 1) {
    assert.equal(TEAM_VISIT_HOUR_BLOCKS[index].fromHour, TEAM_VISIT_HOUR_BLOCKS[index - 1].toHour, "no gap and no overlap between blocks");
  }
  // Cairo, not UTC: 08:10 UTC in November is 10:10 in Cairo.
  assert.deepEqual(cairoClockOf("2026-11-08T08:10:00Z"), { hour: 10, minute: 10 });
  assert.equal(cairoClockOf(null), null);
  assert.equal(cairoClockOf("not a time"), null, "an unreadable instant is no time, never midnight");
  assert.equal(teamVisitHourBlockOf(cairoClockOf("2026-11-08T08:10:00Z")!.hour).label, "10 AM – 12 PM");
}

function timelineOfADay() {
  const report = sampleReport();
  const hassan = report.districts[1].reps[0];
  const timeline = teamVisitTimeline(hassan.yesterday);
  assert.equal(timeline.first, "10:26 AM");
  assert.equal(timeline.last, "08:39 PM");
  assert.equal(timeline.spanMinutes, 10 * 60 + 13);
  assert.equal(timeline.timed, 6);
  assert.equal(timeline.untimed, 1, "the copied visit is counted apart, never as the first of the day");
  assert.equal(teamVisitTimelineLine(timeline), "First 10:26 AM · last 08:39 PM · 10 h 13 min");
  // One timed visit says when; none says nothing; two at one minute say so without a "0 min" stretch.
  assert.equal(teamVisitTimelineLine(teamVisitTimeline(day({ times: [time("PM", at(9, 5))] }))), "Saved at 09:05 AM");
  assert.equal(teamVisitTimelineLine(teamVisitTimeline(day())), null);
  assert.equal(teamVisitTimelineLine(teamVisitTimeline(day({ times: [time("PM", at(9, 5)), time("AM", at(9, 5))] }))), "2 visits saved at 09:05 AM");
  assert.equal(teamVisitSpanLabel(45), "45 min");
  assert.equal(teamVisitSpanLabel(120), "2 h");
  assert.equal(teamVisitSpanLabel(220), "3 h 40 min");
  // A day that runs past midnight: 11 PM to 1 AM is two hours, not minus twenty-two.
  const lateDay = teamVisitTimeline(day({ times: [time("PM", at(23, 0)), time("PM", at(1, 0, "2026-11-09"))] }));
  assert.equal(lateDay.spanMinutes, 120);
  assert.equal(lateDay.first, "11:00 PM");
  assert.equal(lateDay.last, "01:00 AM");
  // The waiting visits were saved — real work — so their times count in the stretch of the day.
  const momen = report.districts[0].reps[0];
  assert.equal(teamVisitTimeline(momen.yesterday).last, "05:10 PM");
}

function hourSpread() {
  const report = sampleReport();
  const reps = report.districts.flatMap((entry) => entry.reps).filter((entry) => !isVacantTeamVisitRep(entry));
  const spread = teamVisitHourSpread(reps.map((entry) => entry.yesterday));
  const saved = reps.reduce((sum, entry) => sum + savedVisitsOf(entry.yesterday), 0);
  assert.equal(spread.blocks.reduce((sum, entry) => sum + entry.visits, 0), spread.timed, "the blocks add up to the timed visits");
  assert.equal(spread.timed + spread.untimed, saved, "timed and untimed add up to every visit saved");
  assert.equal(spread.untimed, 1);
  const byKey = new Map(spread.blocks.map((entry) => [entry.block.key, entry.visits]));
  assert.equal(byKey.get("10-12"), 3, "10:26, 10:35 and 10:35");
  assert.equal(byKey.get("12-14"), 5, "12:44, 12:58, 13:36, 12:39 and 12:39");
  assert.equal(byKey.get("after-20"), 1, "08:39 PM");
  assert.equal(spread.peak, 5);
  assert.equal(teamVisitBarWidth(0, 5), 0);
  assert.equal(teamVisitBarWidth(5, 5), 100);
  assert.equal(teamVisitBarWidth(1, 1000), 2, "a count above zero never vanishes from the bar");
  assert.equal(teamVisitBarWidth(3, 0), 0);
}

function teamsAddUpAndVacantSeatsAreNotReps() {
  const report = sampleReport();
  const rollups = teamVisitDistrictRollups(report);
  assert.equal(rollups.length, 2);
  const [alex, delta] = rollups;
  assert.equal(alex.yesterday.reps, 3, "the vacant seat is not a rep");
  assert.equal(alex.vacantSeats, 1);
  assert.equal(alex.yesterday.repsWithVisits, 2, "Momen and Shahd saved visits");
  assert.equal(alex.yesterday.repsWithNone, 1, "Ghoneim saved none — the empty chair is never counted here");
  assert.equal(delta.yesterday.reps, 1);
  assert.equal(delta.vacantSeats, 2);
  assert.equal(delta.yesterday.repsWithNone, 0);
  // Doctor visits are AM + PM; pharmacies and the waiting visits are apart.
  assert.equal(alex.yesterday.doctorVisits, 6);
  assert.equal(delta.yesterday.doctorVisits, 5);
  assert.equal(delta.yesterday.pharmacies, 2);
  assert.equal(doctorVisitsOf({ am: 2, pm: 3 }), 5);
  assert.equal(alex.yesterday.doctorVisitsPerActiveRep, 3, "6 doctor visits over the 2 reps who saved one");
  // The teams add up to the whole team, which equals the tiles.
  const team = teamVisitTeamRollup(report, "yesterday");
  for (const key of ["am", "pm", "pharmacies", "waiting", "doctorVisits", "saved", "reps", "repsWithVisits", "repsWithNone"] as const) {
    assert.equal(rollups.reduce((sum, rollup) => sum + rollup.yesterday[key], 0), team[key], `the teams add up to the team on ${key}`);
  }
  assert.equal(team.am, report.totals.yesterday.am);
  assert.equal(team.pm, report.totals.yesterday.pm);
  assert.equal(team.pharmacies, report.totals.yesterday.pharmacies);
  assert.equal(team.waiting, report.totals.yesterday.waiting);
  assert.equal(teamVisitTeamRollup(report, "today").repsWithVisits, 1);
  assert.equal(teamVisitTeamRollup({ districts: [] }, "today").doctorVisitsPerActiveRep, null, "no rep saved a visit is no average, never 0");
  // Each team has a stable anchor the roll-up links to.
  assert.equal(teamVisitDistrictAnchor(report.districts[1]), "team-delta-1-nermeen-salah-district-nermeen-salah");
  assert.match(teamVisitDistrictAnchor({ districtName: "", managerName: "", regionName: "" }), /^team-group$/);
}

function repsToLookAt() {
  const report = sampleReport();
  const attention = teamVisitAttention(report, "yesterday");
  assert.deepEqual(attention.none.map((entry) => entry.person), ["Ghoneim Mohamed"], "only a rep in a seat who saved nothing");
  assert.deepEqual(attention.waitingOnly.map((entry) => entry.person), ["Shahd Mohamed"], "every visit still waiting");
  assert.deepEqual(attention.waiting.map((entry) => `${entry.person}:${entry.waiting}`), ["Momen Fathy:2", "Shahd Mohamed:1"]);
  assert.ok(![...attention.none, ...attention.waitingOnly].some((entry) => entry.person === "Seat is vacant"), "a vacant seat is never a rep to look at");
  // A rep on approved leave, or on recorded admin work, with nothing saved is accounted for — never "saved nothing".
  const onLeave = { ...report, districts: [district("Alex-BHR", "Mohamed Eleiwa", [rep("R7", "Sara Leave", { yesterday: day({ away: ["On leave · Annual Vacation"] }) }), rep("R8", "Omar Idle")])] };
  assert.deepEqual(teamVisitAttention(onLeave, "yesterday").none.map((entry) => entry.person), ["Omar Idle"], "leave is not an empty day");
  assert.equal(attention.none[0].managerName, "Mohamed Eleiwa", "each rep carries the team it sits in");
  assert.equal(teamVisitRepState(report.districts[0].reps[2], day()), "vacant");
  assert.equal(teamVisitRepState(report.districts[0].reps[1], day()), "none");
  assert.equal(teamVisitRepState(report.districts[0].reps[3], report.districts[0].reps[3].yesterday), "waiting-only");
  assert.equal(teamVisitRepState(report.districts[0].reps[0], report.districts[0].reps[0].yesterday), "saved");
  // An older report with no `vacant` flag still reads the seat's own words.
  assert.equal(isVacantTeamVisitRep({ person: "Seat is vacant" }), true);
  assert.equal(isVacantTeamVisitRep({ person: "Momen Fathy", vacant: false }), false);
}

function theFilterNarrowsRowsOnly() {
  const report = sampleReport();
  const alex = report.districts[0].reps;
  assert.deepEqual(filterTeamVisitReps(alex, "all", "yesterday").map((entry) => entry.person), ["Momen Fathy", "Ghoneim Mohamed", "Shahd Mohamed"], "a vacant seat is never a row of zeros");
  assert.deepEqual(filterTeamVisitReps(alex, "saved", "yesterday").map((entry) => entry.person), ["Momen Fathy", "Shahd Mohamed"], "waiting-only visits are saved visits");
  assert.deepEqual(filterTeamVisitReps(alex, "none", "yesterday").map((entry) => entry.person), ["Ghoneim Mohamed"]);
  assert.deepEqual(filterTeamVisitReps(alex, "saved", "today").map((entry) => entry.person), ["Momen Fathy"], "the filter judges by the chosen day");
  assert.deepEqual(teamVisitShowCounts(report, "yesterday"), { all: 4, none: 1, saved: 3 });
  assert.deepEqual(teamVisitShowCounts(report, "today"), { all: 4, none: 3, saved: 1 });
  // Strict parsing: anything unknown is every rep, judged by yesterday.
  assert.equal(parseTeamVisitShow("none"), "none");
  assert.equal(parseTeamVisitShow(["saved", "none"]), "saved");
  assert.equal(parseTeamVisitShow("javascript:alert(1)"), "all");
  assert.equal(parseTeamVisitShow(undefined), "all");
  assert.equal(parseTeamVisitDay("today"), "today");
  assert.equal(parseTeamVisitDay("tomorrow"), "yesterday");
  // A fixed path with only the two known keys — never an address read from the request.
  assert.equal(teamVisitFilterHref("all", "yesterday"), "/employee-portals/team-visits");
  assert.equal(teamVisitFilterHref("none", "today"), "/employee-portals/team-visits?show=none&day=today");
  assert.equal(teamVisitFilterHref("saved", "yesterday"), "/employee-portals/team-visits?show=saved");
  assert.ok(readFileSync("src/components/crm/regional/team-visits-panels.tsx", "utf8").includes('export const TEAM_VISITS_EXPORT_HREF = "/api/crm/team-visits/export";'), "the file always holds every rep: no filter in its address");
  assert.equal(teamVisitDayHeading("today"), "Today so far", "today is never a finished day");
  assert.equal(teamVisitDayHeading("yesterday"), "Yesterday");
}

function wordsAndVacantLine() {
  const report = sampleReport();
  assert.equal(teamVisitVacantLine(teamVisitVacantSeats(report.districts[0])), "Vacant seat: Alex West");
  assert.equal(teamVisitVacantLine(teamVisitVacantSeats(report.districts[1])), "2 vacant seats: Sharkia 1 · Sharkia 2");
  assert.equal(teamVisitVacantLine([]), null);
  assert.equal(teamVisitFiguresLine({ am: 3, pharmacies: 5, pm: 9 }), "3 AM · 9 PM · 5 Pharmacies", "three figures apart, never one total");
  assert.equal(teamVisitFiguresLine({ am: 0, pharmacies: 1, pm: 0 }), "0 AM · 0 PM · 1 Pharmacy");
  assert.equal(teamVisitWaitingLine(0), null);
  assert.equal(teamVisitWaitingLine(1), "1 visit waiting for validation");
  assert.equal(teamVisitWaitingLine(4), "4 visits waiting for validation");
  const grouped = teamVisitTimesByList(report.districts[1].reps[0].yesterday);
  assert.equal(grouped.AM.length, 2);
  assert.equal(grouped.Pharmacy.length, 2);
  assert.equal(grouped.PM[grouped.PM.length - 1].at, null, "a copied visit comes last in its group");
}

function foldMarksWaitingVisits() {
  const row = (over: Record<string, unknown>) => ({
    captured_at: "2026-11-08T08:00:00Z",
    customer_id: "C1",
    customer_validated: true,
    id: String(Math.random()),
    imported_from_ireports360_at: null,
    list_type: "PM",
    pharmacy_name: null,
    seat_id: "R1",
    visit_date: "2026-11-08",
    ...over,
  });
  const folded = foldTeamVisitDay([row({}), row({ customer_validated: false }), row({ customer_validated: null })] as never, new Map());
  assert.equal(folded.waiting, 2);
  assert.equal(folded.times.filter((entry) => entry.waiting).length, folded.waiting, "the tagged times are exactly the waiting figure");
  const source = readFileSync("src/lib/phoenix-crm/server/team-visits.ts", "utf8");
  assert.ok(source.includes("waiting: row.customer_validated !== true"), "a visit is tagged waiting on the same rule that counts it waiting");
  assert.ok(source.includes("vacant: people.length === 0,"), "the loader marks a vacant seat");
}

async function theWorkbook() {
  const report = sampleReport();
  const buffer = await buildTeamVisitsWorkbook(report, "2026-11-09T02:30:00Z");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [...TEAM_VISITS_WORKBOOK_SHEETS]);
  assert.equal(teamVisitsWorkbookFileName(report), "team-visits-2026-11-09.xlsx");

  const text = (name: string) => {
    const values: string[] = [];
    workbook.getWorksheet(name)!.eachRow((row) => row.eachCell((cell) => values.push(String(cell.value ?? ""))));
    return values;
  };
  const visits = text("Visits");
  assert.ok(visits.includes("Waiting for validation"), "a waiting visit is a row that says so");
  assert.ok(visits.includes("No time recorded"), "a copied visit says it has no time");
  assert.ok(visits.includes("Mohamed Eleiwa (own visit)"), "the district manager's own visits are in the file, apart");
  assert.ok(visits.includes("Own visit — in no rep's figure"));
  const reps = text("Reps");
  assert.ok(reps.includes("Seat is vacant"), "a vacant seat says so");
  for (const column of ["AM", "PM", "AM + PM", "Pharmacies", "Waiting"]) assert.ok(reps.includes(column), `the Reps sheet has its own ${column} column`);
  const teams = text("Teams");
  assert.ok(teams.includes("The whole team"));
  // Every visit row is on the Visits sheet: the reps' saved visits plus the managers' own.
  const repVisits = report.districts.flatMap((entry) => entry.reps).reduce((sum, entry) => sum + entry.yesterday.times.length + entry.today.times.length, 0);
  const ownVisits = report.districts.reduce((sum, entry) => sum + (entry.managerOwn?.yesterday.times.length ?? 0) + (entry.managerOwn?.today.times.length ?? 0), 0);
  const visitSheet = workbook.getWorksheet("Visits")!;
  let customerRows = 0;
  visitSheet.eachRow((row) => {
    // "In the figures" is the eleventh column, after "Planned or not" and "From the live photo" (owner, 2026-11-09).
    const counted = String(row.getCell(11).value ?? "");
    if (counted === "Counted" || counted === "Waiting for validation" || counted === "Own visit — in no rep's figure") customerRows += 1;
  });
  assert.equal(customerRows, repVisits + ownVisits, "one row per visit, none lost and none doubled");
  // The Hours sheet's total is every visit the reps saved, each day.
  const hours = workbook.getWorksheet("Hours")!;
  let totalRow: ExcelJS.Row | null = null;
  hours.eachRow((row) => {
    if (row.getCell(1).value === "Every visit saved") totalRow = row;
  });
  assert.ok(totalRow, "the Hours sheet has its total row");
  const yesterdaySaved = report.districts.flatMap((entry) => entry.reps).reduce((sum, entry) => sum + entry.yesterday.times.length, 0);
  assert.equal(Number((totalRow as unknown as ExcelJS.Row).getCell(2).value), yesterdaySaved);
  // No location in the file.
  const everything = workbook.worksheets.flatMap((sheet) => text(sheet.name)).join(" ").toLowerCase();
  for (const banned of ["latitude", "longitude", "distance", "far visit", "gps"]) assert.ok(!everything.includes(banned), `the file never carries ${banned}`);
  const source = stripComments(readFileSync("src/lib/phoenix-crm/server/team-visits-workbook.ts", "utf8"));
  assert.ok(source.includes("buildHouseCoverSheet") && source.includes("writeHouseMasthead"), "the file wears the house identity");
  assert.ok(!/\bhis\b|\bhim\b|\bhe\b/i.test(source), "neutral wording in the file");
}

function theExportGateAndRegistry() {
  const route = stripComments(readFileSync("app/api/crm/team-visits/export/route.ts", "utf8"));
  const gate = route.indexOf("readsAnyTeamReport(viewer)");
  const load = route.indexOf("loadTeamVisitsReport(viewer)");
  assert.ok(route.indexOf('canAccess(access, "phoenix_crm", "read")') > 0 && route.indexOf('canAccess(access, "phoenix_crm", "read")') < load, "phoenix_crm:read before any read");
  assert.ok(gate > 0 && gate < load, "the Regional Sales Manager's gate before any read");
  assert.ok(route.indexOf('scope: "export:crm:team-visits"') > 0 && route.indexOf('scope: "export:crm:team-visits"') < load, "rate-limited before the read");
  assert.ok(route.includes('entityType: "crm_team_visits_export"'), "every download is audited");
  assert.ok(route.includes('"cache-control": "no-store"'));
  assert.ok(!route.includes("searchParams"), "the file takes no filter: it always holds every rep");
  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.ok(
    registry.includes('sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/crm/team-visits/export", permission: { resource: "phoenix_crm", action: "read" }, guard: "domain-helper" }),'),
    "the export is in the access registry as an audited export",
  );
  assert.ok(readFileSync("src/lib/admin/audit-entity-types.ts", "utf8").includes("crm_team_visits_export: true,"), "the audit trail can be filtered to it");
}

function theScreen() {
  const view = stripComments(readFileSync("src/components/crm/regional/team-visits-view.tsx", "utf8"));
  const panels = stripComments(readFileSync("src/components/crm/regional/team-visits-panels.tsx", "utf8"));
  const page = stripComments(readFileSync("app/employee-portals/team-visits/page.tsx", "utf8"));
  // The tiles read the whole team, never the filtered rows.
  assert.ok(view.includes("value={String(report.totals.yesterday.am + report.totals.yesterday.pm)}"), "yesterday's tile is the whole team's");
  assert.ok(view.includes("const reps = sortTeamVisitReps(filterTeamVisitReps(district.reps, show, day), sort, day);"), "the filter narrows, and the order sorts, only the rows listed");
  assert.ok(view.includes("<RepsTotal day={district.repsTotal.yesterday} />"), "a district manager's total is the whole team's, filter or not");
  assert.ok(view.includes("<TeamVisitsRollupPanel report={report} />") && view.includes("<TeamVisitsHoursPanel report={report} />") && view.includes("<TeamVisitsAttentionPanel day={day} report={report} show={show} />"));
  assert.ok(view.includes("<TeamVisitsToolbar basePath={surface === \"admin\" ? TEAM_VISITS_ADMIN_PATH : TEAM_VISITS_PATH} day={day} report={report} show={show} sort={sort} />"));
  assert.ok(view.includes(">Waiting for validation</span>"), "a waiting visit is tagged in the square");
  // "the font is fucken small", then "not only in this page audit dr hany new reports" (owner, 2026-11-09): nothing
  // on the Regional Sales Manager's reports, the KPI chrome they are framed in, or the hub card on the home is set
  // below 11px (text-phx-xs).
  const reportFiles = [
    "src/components/crm/regional/team-visits-view.tsx",
    "src/components/crm/regional/team-visits-panels.tsx",
    "src/components/crm/regional/district-manager-plans-view.tsx",
    "src/components/crm/regional/district-manager-plans-panels.tsx",
    "src/components/crm/regional/weekly-sheet-view.tsx",
    "src/components/crm/regional/weekly-sheet-panels.tsx",
    "src/components/crm/kpis-chrome.tsx",
    "src/components/employee-portal/dashboards/rm-command-center.tsx",
    // "audit the KPIs pages font too" (owner, 2026-11-09): the KPIs board, its three reports and their rep pages.
    "src/components/crm/kpi-coverage-panels.tsx",
    "src/components/crm/kpi-coverage-rep-panels.tsx",
    "src/components/crm/kpi-frequency-panels.tsx",
    "src/components/crm/kpi-frequency-rep-panels.tsx",
    "src/components/crm/kpi-reports-tables.tsx",
    "src/components/crm/kpis-board-view.tsx",
    "src/components/crm/kpis-doctor-filter-bar.tsx",
    "src/components/crm/kpis-filter-bar.tsx",
    "src/components/crm/kpis-period-picker.tsx",
    "src/components/crm/kpis-trend-view.tsx",
    "src/components/crm/rep-visits-detail.tsx",
    "src/components/crm/rep-visits-page.tsx",
  ];
  for (const file of reportFiles) {
    assert.ok(!/text-phx-(?:2xs|3xs|4xs)\b/.test(stripComments(readFileSync(file, "utf8"))), `${file}: no text below 11px on the regional reports or the KPIs pages`);
  }
  // "raise the rest of the CRM screens' fonts too" (owner, 2026-11-09): every screen under src/components/crm is
  // read — the reps list, plan verification, brick coverage, the mapping panels — so a new one is held to it too.
  let crmScreens = 0;
  for (const entry of readdirSync("src/components/crm", { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith(".tsx")) continue;
    const file = `src/components/crm/${entry.replace(/\\/g, "/")}`;
    assert.ok(!/text-phx-(?:2xs|3xs|4xs)\b|text-\[(?:[1-9]|10)px\]/.test(stripComments(readFileSync(file, "utf8"))), `${file}: no text below 11px on any CRM screen`);
    crmScreens++;
  }
  assert.ok(crmScreens >= 40, `the floor read every CRM screen (${crmScreens})`);
  // An Arabic customer name beside "30 m" pulled the number into the Arabic run (owner, 2026-11-09, the polish
  // pass): the name is bidi-isolated and the metres sit in a column of their own.
  assert.ok(view.includes("<bdi>{time.customer ?? \"Customer not recorded\"}</bdi>"), "the customer name is bidi-isolated");
  assert.ok(!view.includes("{day.am} AM · {day.pm} PM"),"the counts never print as \"2 AM · 10 PM\", which reads as two clock times");
  assert.ok(view.includes("{ key: \"pharmacies\", label: \"Pharmacies\" },"), "AM · PM · Pharmacies stay three counted boxes apart");
  // A vacant seat keeps its row in the light colour (owner, 2026-11-09), after the reps, with no figures to read.
  assert.ok(view.includes("const vacantRows = filtered ? [] : teamVisitVacantRows(district.reps);"), "vacant seats are their own rows, and a filter lists reps only");
  assert.equal(view.split("{TEAM_VISIT_VACANT_CELL}").length - 1, 2, "the vacant row and card say the seat is vacant, never a row of zeros");
  assert.ok(!/vacantRows\.map\(\(rep\) => \([\s\S]{0,600}<DayCell/.test(view), "a vacant row never draws a day's figures");
  assert.ok(view.includes("id={teamVisitDistrictAnchor(district)}"), "each team's section carries the anchor the roll-up links to");
  assert.ok(page.includes("parseTeamVisitShow(params.show)") && page.includes("parseTeamVisitDay(params.day)"), "the page reads the filter strictly");
  assert.ok(panels.includes("href={TEAM_VISITS_EXPORT_HREF}"), "the download sits in the toolbar");
  // The house finish: no rounded corners, no shadow, no gradient, no ellipsis.
  for (const [name, source] of [["view", view], ["panels", panels]] as const) {
    assert.ok(!/\brounded(?:-|\b)/.test(source), `${name}: square corners`);
    assert.ok(!/\bshadow(?:-|\b)/.test(source), `${name}: no drop shadow`);
    assert.ok(!/bg-gradient|from-\w+-\d+ to-/.test(source), `${name}: no gradient`);
    assert.ok(!/\btruncate\b|text-ellipsis|line-clamp/.test(source), `${name}: no ellipsis`);
    assert.ok(!/\bhis\b|\bhim\b|\bhe\b/i.test(source.replace(/&apos;/g, "'")), `${name}: neutral wording`);
  }
  // Every table: fixed, a colgroup to 100%, and only from md up — the phone gets cards.
  for (const [name, source] of [["view", view], ["panels", panels]] as const) {
    const tables = source.match(/<table className="[^"]*"/g) ?? [];
    assert.ok(tables.length >= 1, `${name} draws a table`);
    for (const table of tables) {
      assert.ok(table.includes("table-fixed") && table.includes("hidden") && table.includes("md:table"), `${name}: ${table}`);
    }
    for (const group of source.match(/<colgroup>[\s\S]*?<\/colgroup>/g) ?? []) {
      const widths = [...group.matchAll(/w-\[(\d+)%\]/g)].map((match) => Number(match[1]));
      assert.equal(widths.reduce((sum, width) => sum + width, 0), 100, `${name}: a colgroup adds up to 100%`);
    }
    assert.ok(source.includes("md:hidden"), `${name}: the phone gets cards`);
  }
}

function paceAgainstYesterday() {
  const report = sampleReport();
  // 1 PM Cairo on 9 Nov: today has Momen's 10:05 visit; yesterday is cut at 1 PM of its own visit day.
  const pace = teamVisitPace(report, at(13, 0, "2026-11-09"));
  assert.ok(pace, "the pace reads while today's visit day is running");
  assert.equal(pace.cutoffLabel, "01:00 PM");
  assert.deepEqual(pace.today, { doctorVisits: 1, reps: 1, saved: 1 });
  assert.equal(pace.yesterdayBy.saved, 7, "Momen 12:44 and 12:58, Hassan 10:26, 10:35, 10:35, 12:39 and 12:39");
  assert.equal(pace.yesterdayBy.doctorVisits, 5, "the two pharmacy visits are never doctor visits");
  assert.equal(pace.yesterdayBy.reps, 2);
  assert.equal(pace.difference, -6);
  assert.equal(pace.repsInSeats, 4, "vacant seats are never in the denominator");
  assert.equal(teamVisitPaceLine(pace.difference), "6 fewer than yesterday by this time");
  assert.equal(teamVisitPaceLine(3), "3 more than yesterday by this time");
  assert.equal(teamVisitPaceLine(0), "Level with yesterday by this time");
  // Late in the evening, the whole timed day is in; the copied visit is never "by this time".
  const late = teamVisitPace(report, at(23, 59, "2026-11-09"));
  const timedYesterday = report.districts.flatMap((entry) => entry.reps).reduce((sum, entry) => sum + entry.yesterday.times.filter((item) => item.at).length, 0);
  assert.equal(late?.yesterdayBy.saved, timedYesterday);
  // After 02:00 the page reads a day that has closed — no pace at all, never a stale comparison.
  assert.equal(teamVisitPace(report, at(3, 0, "2026-11-10")), null);
  assert.equal(teamVisitPace(report, "not a time"), null);
  // A small-hours save of yesterday counts at the END of yesterday, never at its start.
  const owl = rep("R9", "Night Owl", { yesterday: day({ pm: 1, times: [time("PM", at(1, 15, "2026-11-09"))] }) });
  const owlReport = { ...report, districts: [district("Alex-BHR", "Mohamed Eleiwa", [owl])] };
  assert.equal(teamVisitPace(owlReport, at(13, 0, "2026-11-09"))?.yesterdayBy.saved, 0, "01:15 is after 1 PM on the visit day");
  assert.deepEqual(teamVisitRepPace(owl, owlReport, at(13, 0, "2026-11-09")), { today: 0, yesterdayBy: 0 });
  // A visit filed under yesterday but saved during today's visit day was not saved "by this time yesterday".
  const lateEntry = rep("R8", "Late Entry", { yesterday: day({ pm: 1, times: [time("PM", at(10, 0, "2026-11-09"))] }) });
  const lateReport = { ...report, districts: [district("Alex-BHR", "Mohamed Eleiwa", [lateEntry])] };
  assert.equal(teamVisitPace(lateReport, at(13, 0, "2026-11-09"))?.yesterdayBy.saved, 0, "only what yesterday's own visit day had saved");
  assert.deepEqual(teamVisitRepPace(report.districts[0].reps[0], report, at(13, 0, "2026-11-09")), { today: 1, yesterdayBy: 2 });
  assert.equal(teamVisitRepPace(report.districts[0].reps[2], report, at(13, 0, "2026-11-09")), null, "a vacant seat has no pace");
}

function dayStripAndManagers() {
  const report = sampleReport();
  const hassan = report.districts[1].reps[0];
  const strip = teamVisitDayStrip(hassan.yesterday);
  assert.equal(strip.marks.length, 6, "one mark per timed visit");
  assert.equal(strip.untimed, 1, "the copied visit has no mark");
  assert.ok(strip.marks.every((mark) => mark.left >= 0 && mark.left <= 100), "every mark sits on the strip");
  assert.deepEqual(strip.marks.map((mark) => mark.left), [...strip.marks.map((mark) => mark.left)].sort((left, right) => left - right), "left to right in time");
  assert.equal(teamVisitDayStrip(day({ times: [time("AM", at(6, 0))] })).marks[0].left, 0, "before 7 AM sits on the left edge");
  assert.equal(teamVisitDayStrip(day({ times: [time("PM", at(1, 0, "2026-11-09"))] })).marks[0].left, 100, "after midnight sits on the right edge");
  assert.deepEqual(TEAM_VISIT_STRIP_TICKS.map((tick) => tick.label), ["08 AM", "12 PM", "04 PM", "08 PM"]);
  const momen = teamVisitDayStrip(report.districts[0].reps[0].yesterday);
  assert.equal(momen.marks.filter((mark) => mark.waiting).length, 2, "the waiting visits are marked as waiting");

  const managers = teamVisitManagersInField(report);
  assert.equal(managers.length, 2);
  assert.equal(managers[0].yesterday?.am, 1);
  assert.equal(managers[0].yesterday?.timeline.first, "09:15 AM");
  assert.equal(managers[0].today?.saved, 0);
  const noManager = teamVisitManagersInField({ districts: [{ ...report.districts[0], managerOwn: null }] });
  assert.equal(noManager[0].noManager, true, "an empty district manager's seat says so");
  assert.equal(noManager[0].yesterday, null, "never a row of zeros for nobody");
  assert.equal(managers[0].anchor, teamVisitDistrictAnchor(report.districts[0]), "a manager's name jumps to the team");
}

async function theWorkbookCarriesThePace() {
  const report = sampleReport();
  const cover = async (generatedAt: string) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await buildTeamVisitsWorkbook(report, generatedAt)) as unknown as ArrayBuffer);
    const values: string[] = [];
    workbook.getWorksheet("Cover")!.eachRow((row) => row.eachCell((cell) => values.push(String(cell.value ?? ""))));
    return values;
  };
  const during = await cover(at(13, 0, "2026-11-09"));
  assert.ok(during.includes("Today against yesterday at 01:00 PM"), "a file made during the day says the pace");
  assert.ok(during.some((value) => value.includes("1 visits saved today against 7 yesterday by the same time")));
  const after = await cover(at(3, 0, "2026-11-10"));
  assert.ok(!after.some((value) => value.startsWith("Today against yesterday")), "a file made after the day closed carries no stale pace");
  const view = stripComments(readFileSync("src/components/crm/regional/team-visits-view.tsx", "utf8"));
  assert.ok(view.includes("<TeamVisitsPacePanel nowIso={nowIso} report={report} />"));
  assert.equal(view.split("pace={paceOf(rep)}").length - 1, 2, "the desktop row and the phone card both carry the rep's pace");
  assert.ok(view.includes("{href ? <DayStrip day={day} /> : null}"), "the day strip is drawn for a rep's day, never the manager's own");
  assert.ok(view.includes("const running = nowIso && teamVisitPace(report, nowIso) ? nowIso : null;"), "no rep pace once the day has closed");
  const page = stripComments(readFileSync("app/employee-portals/team-visits/page.tsx", "utf8"));
  assert.ok(page.includes("nowIso={new Date().toISOString()}"), "the page reads the time it was opened");
}

function orderNoticeAndFold() {
  const report = sampleReport();
  const team = report.districts[0].reps;
  const names = (reps: readonly TeamVisitRep[]) => reps.map((entry) => entry.person);
  // The order reads strictly; anything else is the territory order the loader already gives.
  assert.equal(parseTeamVisitSort("visits"), "visits");
  assert.equal(parseTeamVisitSort(["first"]), "first");
  assert.equal(parseTeamVisitSort("DROP TABLE"), "territory");
  assert.equal(parseTeamVisitSort(undefined), "territory");
  assert.deepEqual(Object.keys(TEAM_VISIT_SORT_LABEL).sort(), ["first", "territory", "visits"]);
  // Most doctor visits: Momen's six first; the three with none fall back to territory then name.
  const byVisits = sortTeamVisitReps(team, "visits", "yesterday");
  assert.equal(byVisits[0].person, "Momen Fathy");
  assert.equal(byVisits.length, team.length, "a sort never drops or adds a seat");
  // Shahd saved one visit (waiting) and Ghoneim none: the saved count breaks the tie at zero doctor visits.
  assert.ok(names(byVisits).indexOf("Shahd Mohamed") < names(byVisits).indexOf("Ghoneim Mohamed"), "a saved visit outranks none at equal doctor visits");
  // Earliest first visit: Momen 12:44, Shahd 18:20; the reps with no timed visit come last, never first.
  const byFirst = sortTeamVisitReps(team, "first", "yesterday");
  assert.deepEqual(names(byFirst).slice(0, 2), ["Momen Fathy", "Shahd Mohamed"]);
  assert.ok(byFirst.slice(2).every((entry) => entry.yesterday.times.every((item) => !item.at)), "no time is never 'earliest'");
  // Judged on the chosen day: today only Momen has a visit.
  assert.equal(sortTeamVisitReps(team, "first", "today")[0].person, "Momen Fathy");
  // The territory order is stable and does not move the input.
  const before = names(team);
  assert.deepEqual(names(sortTeamVisitReps(team, "territory", "yesterday")), names(sortTeamVisitReps([...team].reverse(), "territory", "yesterday")));
  assert.deepEqual(names(team), before, "the loader's list is never sorted in place");
  // The address keeps all three keys, and only the ones that differ from the default.
  assert.equal(teamVisitFilterHref("all", "yesterday", "territory"), "/employee-portals/team-visits");
  assert.equal(teamVisitFilterHref("none", "today", "first"), "/employee-portals/team-visits?show=none&day=today&sort=first");
  assert.equal(teamVisitFilterHref("all", "yesterday", "visits"), "/employee-portals/team-visits?sort=visits");

  // The field week is Saturday to Wednesday (the call rate's own weekday rule).
  assert.equal(teamVisitWeekdayOf("2026-11-06"), "Friday");
  assert.equal(teamVisitWeekdayOf("not a day"), null);
  assert.equal(teamVisitNonWorkingNotice(report), null, "Sunday and Monday are field days: no notice");
  const saturdayMorning = teamVisitNonWorkingNotice({ today: "2026-11-07", yesterday: "2026-11-06" });
  assert.equal(saturdayMorning, "Yesterday (Friday) is not a field working day: the field week is Saturday to Wednesday, so few or no visits are expected.");
  const friday = teamVisitNonWorkingNotice({ today: "2026-11-06", yesterday: "2026-11-05" });
  assert.ok(friday?.startsWith("Both days — yesterday (Thursday) and today (Friday) — are not field working days"), friday ?? "no notice");
  assert.ok(teamVisitNonWorkingNotice({ today: "2026-11-05", yesterday: "2026-11-04" })?.startsWith("Today (Thursday) is not"));

  // A long day on a phone folds behind one line; a short one stays open.
  assert.equal(TEAM_VISIT_PHONE_FOLD, 4);
  const view = stripComments(readFileSync("src/components/crm/regional/team-visits-view.tsx", "utf8"));
  assert.ok(view.includes("if (day.times.length <= TEAM_VISIT_PHONE_FOLD) return <Times day={day} />;"), "a short list is never folded");
  assert.ok(view.includes("<details ") && view.includes("Show the {day.times.length} visits"), "a long list folds behind a native details");
  assert.equal(view.split("<DayCell day={rep.yesterday} fold ").length - 1, 1, "the phone card folds yesterday");
  assert.equal(view.split("<DayCell day={rep.today} fold ").length - 1, 1, "the phone card folds today");
  assert.ok(view.includes("{notWorking ? <p "), "the notice prints only on a day that is not a field day");
  const panels = stripComments(readFileSync("src/components/crm/regional/team-visits-panels.tsx", "utf8"));
  assert.ok(panels.includes("href={teamVisitFilterHref(show, day, key, basePath)}"), "the order links keep the filter");
  assert.ok(panels.includes("href={teamVisitFilterHref(key, day, sort, basePath)}") && panels.includes("href={teamVisitFilterHref(show, key, sort, basePath)}"), "the filter links keep the order");
  const page = stripComments(readFileSync("app/employee-portals/team-visits/page.tsx", "utf8"));
  assert.ok(page.includes("sort={parseTeamVisitSort(params.sort)}"), "the page reads the order strictly");
}

function paceTeamByTeam() {
  const report = sampleReport();
  const now = at(13, 0, "2026-11-09");
  const whole = teamVisitPace(report, now)!;
  const byTeam = teamVisitTeamPace(report, now)!;
  assert.equal(byTeam.cutoffLabel, whole.cutoffLabel, "one cutoff for the whole team and every team");
  assert.equal(byTeam.teams.length, report.districts.length);
  // The rows add up to the whole team's pace — the same seats, the same cutoff.
  const sum = (pick: (row: (typeof byTeam.teams)[number]) => number) => byTeam.teams.reduce((total, row) => total + pick(row), 0);
  assert.equal(sum((row) => row.today.saved), whole.today.saved);
  assert.equal(sum((row) => row.yesterdayBy.saved), whole.yesterdayBy.saved);
  assert.equal(sum((row) => row.yesterdayBy.doctorVisits), whole.yesterdayBy.doctorVisits);
  assert.equal(sum((row) => row.repsInSeats), whole.repsInSeats, "vacant seats are in no team's count");
  assert.equal(sum((row) => row.difference), whole.difference);
  assert.deepEqual(
    byTeam.teams.map((row) => [row.managerName, row.repsInSeats, row.yesterdayBy.saved, row.today.saved]),
    [
      ["Mohamed Eleiwa", 3, 2, 1],
      ["Nermeen Salah", 1, 5, 0],
    ],
  );
  assert.equal(byTeam.teams[0].anchor, teamVisitDistrictAnchor(report.districts[0]), "a team's name jumps to its section");
  // A team of only vacant seats has no reps and no figures — never a row of zeros read as a team that did nothing.
  const empty = teamVisitTeamPace({ ...report, districts: [district("Upper", "Nobody Yet", [vacantSeat("V9", "Aswan")])] }, now)!;
  assert.equal(empty.teams[0].repsInSeats, 0);
  assert.equal(empty.teams[0].today.saved + empty.teams[0].yesterdayBy.saved, 0);
  // After 02:00 the day has closed: no team pace either.
  assert.equal(teamVisitTeamPace(report, at(3, 0, "2026-11-10")), null);
  assert.equal(teamVisitSignedDifference(3), "+3");
  assert.equal(teamVisitSignedDifference(-6), "\u22126", "a true minus sign, never a hyphen");
  assert.equal(teamVisitSignedDifference(0), "0");
  const panels = stripComments(readFileSync("src/components/crm/regional/team-visits-panels.tsx", "utf8"));
  assert.ok(panels.includes("<TeamPaceTable nowIso={nowIso} report={report} />"), "the pace panel carries the team-by-team table");
  assert.ok(panels.includes("if (!pace || pace.teams.length < 2) return null;"), "one team needs no team-by-team table");
  assert.ok(panels.includes('team.repsInSeats === 0 ? "Every seat is vacant"'), "an all-vacant team says so");
}

async function theWorkbookLooksAndPaces() {
  const report = sampleReport();
  const sheetText = async (generatedAt: string, name: string) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await buildTeamVisitsWorkbook(report, generatedAt)) as unknown as ArrayBuffer);
    const rows: string[][] = [];
    workbook.getWorksheet(name)!.eachRow((row) => {
      const values: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => values.push(String(cell.value ?? "")));
      rows.push(values);
    });
    return rows;
  };
  const look = await sheetText(at(13, 0, "2026-11-09"), "To look at");
  const flat = look.flat();
  // Ghoneim saved nothing either day; Shahd's one visit yesterday is still waiting.
  assert.ok(flat.includes("Saved no visit · 4"), "the title counts its rows: Ghoneim yesterday; Ghoneim, Shahd and Hassan today");
  assert.ok(flat.includes("Every visit still waiting for validation · 1"));
  assert.ok(flat.includes("A visit waiting for validation · 2"));
  const shahdWaiting = look.find((row) => row.includes("Shahd Mohamed") && row.includes("Yesterday"));
  assert.ok(shahdWaiting, "Shahd is listed for yesterday");
  assert.ok(!flat.includes("Seat is vacant"), "a vacant seat is never on a list to look at");
  assert.ok(!flat.includes("Alex West") && !flat.includes("Sharkia 1"), "nor its territory");

  const during = await sheetText(at(13, 0, "2026-11-09"), "Pace");
  const duringFlat = during.flat();
  assert.ok(duringFlat.includes("Team by team, at 01:00 PM") && duringFlat.includes("Rep by rep, at 01:00 PM"));
  const wholeRow = during.find((row) => row[0] === "The whole team");
  assert.ok(wholeRow, "the team table closes on the whole team");
  assert.deepEqual(wholeRow!.slice(2, 6), ["4", "7", "1", "\u22126"], "4 reps · 7 yesterday by 1 PM · 1 today · six fewer");
  const repRows = during.filter((row) => ["Momen Fathy", "Ghoneim Mohamed", "Shahd Mohamed", "Hassan Mohamed"].includes(row[2]));
  assert.equal(repRows.length, 4, "one row per rep in a seat, none for a vacant seat");
  assert.ok(!duringFlat.includes("Seat is vacant"));
  const after = await sheetText(at(3, 0, "2026-11-10"), "Pace");
  assert.ok(after.flat().includes(TEAM_VISITS_PACE_CLOSED), "a file made after the day closed says so, never a stale pace");
  assert.ok(!after.flat().some((value) => value.startsWith("Team by team")));
}

function namesJumpToTheirRep() {
  const report = sampleReport();
  assert.equal(teamVisitRepAnchor("R1", "row"), "rep-r1");
  assert.equal(teamVisitRepAnchor("R1", "card"), "rep-r1-card", "the card has its own anchor: the row is hidden on a phone");
  assert.equal(teamVisitRepAnchor("Seat #7 / Alex", "row"), "rep-seat-7-alex", "letters, digits and dashes only");
  assert.equal(teamVisitRepAnchor("///", "row"), "rep-seat");
  // Under "No visits saved, judged by yesterday" only Ghoneim's row is on the page — Momen's name must not link.
  const listed = teamVisitListedSeatIds(report, "none", "yesterday");
  assert.deepEqual([...listed], ["R2"]);
  assert.deepEqual([...teamVisitListedSeatIds(report, "all", "yesterday")].sort(), ["R1", "R2", "R3", "R4"], "unfiltered, every rep in a seat has a row; a vacant seat is a line, never a row to jump to");
  const view = stripComments(readFileSync("src/components/crm/regional/team-visits-view.tsx", "utf8"));
  assert.ok(view.includes('id={teamVisitRepAnchor(rep.seatId, "row")}') && view.includes('id={teamVisitRepAnchor(rep.seatId, "card")}'), "the row and the card carry their anchors");
  const panels = stripComments(readFileSync("src/components/crm/regional/team-visits-panels.tsx", "utf8"));
  assert.ok(panels.includes("{listed.has(rep.seatId) ? ("), "a name links only when its row is on the page");
  assert.ok(panels.includes('href={`#${teamVisitRepAnchor(rep.seatId, "row")}`}') && panels.includes('href={`#${teamVisitRepAnchor(rep.seatId, "card")}`}'));
}

export async function runTeamVisitsPremiumTests() {
  hoursAndClock();
  timelineOfADay();
  hourSpread();
  teamsAddUpAndVacantSeatsAreNotReps();
  repsToLookAt();
  theFilterNarrowsRowsOnly();
  wordsAndVacantLine();
  foldMarksWaitingVisits();
  paceAgainstYesterday();
  dayStripAndManagers();
  orderNoticeAndFold();
  paceTeamByTeam();
  namesJumpToTheirRep();
  await theWorkbook();
  await theWorkbookCarriesThePace();
  await theWorkbookLooksAndPaces();
  theExportGateAndRegistry();
  theScreen();
}
