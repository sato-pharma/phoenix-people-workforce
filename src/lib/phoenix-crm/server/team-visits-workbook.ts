/**
 * Visits — Yesterday and Today as a workbook (owner, 9 Nov 2026: the premium pass on My Team's Reports), in the house
 * identity (SATO-DIS-2026-01: the masthead, the blue header band, the hairline grid and the 6% zebra), as the Weekly
 * Sheet's export is.
 *
 * It re-derives nothing: every figure is read off the report `loadTeamVisitsReport` built and the roll-ups in
 * `team-visits-summary.ts`, the same ones the screen prints, so the file and the screen cannot disagree.
 *
 *   - AM · PM · Pharmacies are three columns, never one total; "Doctor visits" is AM + PM.
 *   - A visit waiting for validation is a row on the Visits sheet with "Waiting for validation" beside it, and is in
 *     none of the three figures.
 *   - A copied old-CRM visit prints "No time recorded", never a blank or midnight.
 *   - A vacant seat is a row that says so, with no figures — never a rep with zero visits.
 *   - No location, distance or far-visit flag is in the file: the report reads none (see the loader's header).
 *   - The file always holds every rep. The screen's filter narrows what is listed there, never what is exported.
 */

import ExcelJS from "exceljs";

import { cairoDate } from "@/lib/format/cairo-datetime";
import { buildHouseCoverSheet, writeHouseTable, type CellValue } from "@/lib/export/house-table-workbook";
import { houseGeneratedAt, writeHouseMasthead } from "@/lib/export/house-xlsx-identity";
import type { TeamVisitDay, TeamVisitsReport, TeamVisitTime } from "@/lib/phoenix-crm/server/team-visits";
import {
  isVacantTeamVisitRep,
  TEAM_VISIT_DAYS,
  TEAM_VISIT_HOUR_BLOCKS,
  TEAM_VISITS_NO_TIME,
  teamVisitDistrictRollups,
  teamVisitHourSpread,
  teamVisitPace,
  teamVisitAttention,
  teamVisitPaceLine,
  teamVisitRepPace,
  teamVisitSignedDifference,
  teamVisitSpanLabel,
  teamVisitTeamPace,
  teamVisitTeamRollup,
  teamVisitTimeline,
  type TeamVisitDayKey,
  type TeamVisitDayRollup,
} from "@/lib/phoenix-crm/server/team-visits-summary";

export const TEAM_VISITS_WORKBOOK_SHEETS = ["Cover", "Teams", "Reps", "Visits", "Hours", "To look at", "Pace"] as const;

/** What the Pace sheet says when the file was made after today's visit day closed — never a stale comparison. */
export const TEAM_VISITS_PACE_CLOSED = "Today's visit day had closed when this file was made, so there is no comparison with yesterday at the same time.";

const LIST_LABEL: Record<TeamVisitTime["list"], string> = { AM: "AM", PM: "PM", Pharmacy: "Pharmacy" };

function dayLabel(iso: string): string {
  return cairoDate(`${iso}T12:00:00Z`);
}

function dayName(key: TeamVisitDayKey): string {
  return key === "today" ? "Today" : "Yesterday";
}

function perActiveRep(rollup: TeamVisitDayRollup): CellValue {
  return rollup.doctorVisitsPerActiveRep ?? "No rep saved a visit";
}

function spanCell(minutes: number | null): CellValue {
  return minutes == null ? "" : teamVisitSpanLabel(minutes);
}

function figures(day: TeamVisitDay): CellValue[] {
  return [day.am, day.pm, day.am + day.pm, day.pharmacies, day.waiting];
}

/** The workbook's file name: one per visit day, so yesterday's download never overwrites today's. */
export function teamVisitsWorkbookFileName(report: Pick<TeamVisitsReport, "today">): string {
  return `team-visits-${report.today}.xlsx`;
}

export async function buildTeamVisitsWorkbook(report: TeamVisitsReport, generatedAtIso: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(generatedAtIso);
  const label = `${dayLabel(report.yesterday)} and ${dayLabel(report.today)}`;
  const subtitle = `Visits — Yesterday and Today · ${label}`;
  const provenance = [houseGeneratedAt(generatedAtIso), label];
  const reps = report.districts.flatMap((district) => district.reps);
  const occupied = reps.filter((rep) => !isVacantTeamVisitRep(rep));
  const team = { today: teamVisitTeamRollup(report, "today"), yesterday: teamVisitTeamRollup(report, "yesterday") };
  // Read at the moment the file was made, as the screen's pace panel is: only while today's visit day is running.
  const pace = teamVisitPace(report, generatedAtIso);

  buildHouseCoverSheet(workbook, {
    confidentialNote: "Internal — for the Regional Sales Manager and the district managers.",
    rows: [
      ["Yesterday", dayLabel(report.yesterday)],
      ["Today", `${dayLabel(report.today)} — the visit day is still running, so today is a position, not a finished day`],
      ["Reps", String(occupied.length)],
      ["Vacant seats", String(reps.length - occupied.length)],
      ["District managers", String(report.districts.length)],
      ["Yesterday's visits", `${team.yesterday.doctorVisits} AM + PM visits · ${team.yesterday.am} AM · ${team.yesterday.pm} PM · ${team.yesterday.pharmacies} Pharmacies`],
      ["Today's visits", `${team.today.doctorVisits} AM + PM visits · ${team.today.am} AM · ${team.today.pm} PM · ${team.today.pharmacies} Pharmacies`],
      ...(pace
        ? ([
            [
              `Today against yesterday at ${pace.cutoffLabel}`,
              `${pace.today.saved} visits saved today against ${pace.yesterdayBy.saved} yesterday by the same time — ${teamVisitPaceLine(pace.difference).toLowerCase()}`,
            ],
          ] as Array<[string, string]>)
        : []),
      ["Counting", "AM and PM are validated visits, counted apart; pharmacies are distinct pharmacies; a visit to a customer not validated yet is counted only as waiting"],
      ["Times", "The moment each visit was saved, Cairo time. A visit copied from the old CRM recorded no time"],
    ],
    subtitle,
    title: "Visits — Yesterday and Today",
  });

  // Teams — one line per region and district manager, each day, then the whole team.
  const teamSheet = workbook.addWorksheet("Teams", { properties: { defaultRowHeight: 18 } });
  teamSheet.views = [{ showGridLines: false }];
  const teamStart = writeHouseMasthead(workbook, teamSheet, { columns: 13, provenance, subtitle, title: "Teams" });
  const rollups = teamVisitDistrictRollups(report);
  const teamRows: CellValue[][] = rollups.flatMap((rollup) =>
    TEAM_VISIT_DAYS.map((key) => {
      const day = rollup[key];
      return [
        rollup.regionName,
        rollup.managerName,
        dayName(key),
        day.reps,
        day.repsWithVisits,
        day.repsWithNone,
        day.am,
        day.pm,
        day.doctorVisits,
        day.pharmacies,
        day.waiting,
        perActiveRep(day),
        rollup.vacantSeats,
      ];
    }),
  );
  const teamNext = writeHouseTable(teamSheet, teamStart, {
    columns: [
      { label: "Region", width: 14 },
      { label: "District manager", width: 24 },
      { label: "Day", width: 11 },
      { label: "Reps", right: true, width: 7 },
      { label: "Saved a visit", right: true, width: 12 },
      { label: "Saved none", right: true, width: 11 },
      { label: "AM", right: true, width: 7 },
      { label: "PM", right: true, width: 7 },
      { label: "AM + PM", right: true, width: 12 },
      { label: "Pharmacies", right: true, width: 11 },
      { label: "Waiting", right: true, width: 9 },
      { label: "AM + PM per rep who saved one", right: true, width: 18 },
      { label: "Vacant seats", right: true, width: 11 },
    ],
    note: "AM + PM are the validated visits, pharmacies apart. The district managers' own visits are counted in no rep's figure and are on the Visits sheet.",
    rows: teamRows,
    title: "The reps' visits, by region and district manager",
  });
  writeHouseTable(teamSheet, teamNext + 1, {
    columns: [
      { label: "Day", width: 14 },
      { label: "Reps", right: true, width: 24 },
      { label: "Saved a visit", right: true, width: 11 },
      { label: "Saved none", right: true, width: 7 },
      { label: "AM", right: true, width: 12 },
      { label: "PM", right: true, width: 11 },
      { label: "AM + PM", right: true, width: 7 },
      { label: "Pharmacies", right: true, width: 7 },
      { label: "Waiting", right: true, width: 12 },
    ],
    rows: TEAM_VISIT_DAYS.map((key) => [dayName(key), team[key].reps, team[key].repsWithVisits, team[key].repsWithNone, team[key].am, team[key].pm, team[key].doctorVisits, team[key].pharmacies, team[key].waiting]),
    title: "The whole team",
  });

  // Reps — one row per rep seat per day.
  const repSheet = workbook.addWorksheet("Reps", { properties: { defaultRowHeight: 18 } });
  repSheet.views = [{ showGridLines: false }];
  const repStart = writeHouseMasthead(workbook, repSheet, { columns: 14, provenance, subtitle, title: "Reps" });
  const repRows: CellValue[][] = report.districts.flatMap((district) =>
    district.reps.flatMap((rep) =>
      TEAM_VISIT_DAYS.map((key) => {
        if (isVacantTeamVisitRep(rep)) {
          return [district.regionName, district.managerName, "Seat is vacant", rep.territory, dayName(key), "", "", "", "", "", "", "", "", ""];
        }
        const day = rep[key];
        const timeline = teamVisitTimeline(day);
        return [
          district.regionName,
          district.managerName,
          rep.person,
          rep.territory,
          dayName(key),
          ...figures(day),
          day.times.length,
          timeline.first ?? (day.times.length ? TEAM_VISITS_NO_TIME : ""),
          timeline.last ?? "",
          spanCell(timeline.spanMinutes),
        ];
      }),
    ),
  );
  writeHouseTable(repSheet, repStart, {
    columns: [
      { label: "Region", width: 14 },
      { label: "District manager", width: 24 },
      { label: "Rep", width: 26 },
      { label: "Territory", width: 22 },
      { label: "Day", width: 11 },
      { label: "AM", right: true, width: 7 },
      { label: "PM", right: true, width: 7 },
      { label: "AM + PM", right: true, width: 12 },
      { label: "Pharmacies", right: true, width: 11 },
      { label: "Waiting", right: true, width: 9 },
      { label: "Visits saved", right: true, width: 11 },
      { label: "First saved", width: 12 },
      { label: "Last saved", width: 12 },
      { label: "First to last", width: 13 },
    ],
    note: "Visits saved counts every visit, waiting ones included. First and last are the saved times, Cairo.",
    rows: repRows,
    title: "Every rep, each day",
  });

  // Visits — every visit with its saved time and customer, the reps' and the managers' own.
  const visitSheet = workbook.addWorksheet("Visits", { properties: { defaultRowHeight: 18 } });
  visitSheet.views = [{ showGridLines: false }];
  const visitStart = writeHouseMasthead(workbook, visitSheet, { columns: 9, provenance, subtitle, title: "Visits" });
  const visitRows: CellValue[][] = [];
  for (const district of report.districts) {
    for (const key of TEAM_VISIT_DAYS) {
      const own = district.managerOwn?.[key];
      for (const time of own?.times ?? []) {
        visitRows.push([district.regionName, district.managerName, `${district.managerName} (own visit)`, "District manager", dayName(key), LIST_LABEL[time.list], time.savedAt ?? TEAM_VISITS_NO_TIME, time.customer ?? "Customer not recorded", "Own visit — in no rep's figure"]);
      }
    }
    for (const rep of district.reps) {
      if (isVacantTeamVisitRep(rep)) continue;
      for (const key of TEAM_VISIT_DAYS) {
        for (const time of rep[key].times) {
          visitRows.push([
            district.regionName,
            district.managerName,
            rep.person,
            rep.territory,
            dayName(key),
            LIST_LABEL[time.list],
            time.savedAt ?? TEAM_VISITS_NO_TIME,
            time.customer ?? "Customer not recorded",
            time.waiting ? "Waiting for validation" : "Counted",
          ]);
        }
      }
    }
  }
  writeHouseTable(visitSheet, visitStart, {
    columns: [
      { label: "Region", width: 14 },
      { label: "District manager", width: 24 },
      { label: "Rep", width: 26 },
      { label: "Territory", width: 20 },
      { label: "Day", width: 11 },
      { label: "List", width: 10 },
      { label: "Saved at", width: 14 },
      { label: "Customer", width: 36 },
      { label: "In the figures", width: 26 },
    ],
    note: "Pharmacies are counted as distinct pharmacies in a day, so two visits to one pharmacy are two rows and one pharmacy.",
    rows: visitRows,
    title: "Every visit, with the time it was saved",
  });

  // Hours — when the visits were saved, two hours at a time, each day.
  const hourSheet = workbook.addWorksheet("Hours", { properties: { defaultRowHeight: 18 } });
  hourSheet.views = [{ showGridLines: false }];
  const hourStart = writeHouseMasthead(workbook, hourSheet, { columns: 3, provenance, subtitle, title: "Hours" });
  const spreads = {
    today: teamVisitHourSpread(occupied.map((rep) => rep.today)),
    yesterday: teamVisitHourSpread(occupied.map((rep) => rep.yesterday)),
  };
  const hourRows: CellValue[][] = TEAM_VISIT_HOUR_BLOCKS.map((block, index) => [block.label, spreads.yesterday.blocks[index].visits, spreads.today.blocks[index].visits]);
  hourRows.push([TEAM_VISITS_NO_TIME, spreads.yesterday.untimed, spreads.today.untimed]);
  writeHouseTable(hourSheet, hourStart, {
    columns: [
      { label: "Saved between", width: 18 },
      { label: `Yesterday · ${dayLabel(report.yesterday)}`, right: true, width: 20 },
      { label: `Today · ${dayLabel(report.today)}`, right: true, width: 20 },
    ],
    note: "Every visit the reps saved, waiting ones included, by the Cairo time it was saved. The district managers' own visits are not in these counts.",
    rows: hourRows,
    title: "When the reps saved their visits",
    totals: ["Every visit saved", spreads.yesterday.timed + spreads.yesterday.untimed, spreads.today.timed + spreads.today.untimed],
  });

  // To look at — the screen's three lists, for both days. Facts, no rank and no verdict; a vacant seat is never here.
  const lookSheet = workbook.addWorksheet("To look at", { properties: { defaultRowHeight: 18 } });
  lookSheet.views = [{ showGridLines: false }];
  let lookRow = writeHouseMasthead(workbook, lookSheet, { columns: 6, provenance, subtitle, title: "To look at" });
  const lookColumns = [
    { label: "Region", width: 18 },
    { label: "District manager", width: 22 },
    { label: "Rep", width: 24 },
    { label: "Territory", width: 22 },
    { label: "Day", width: 12 },
    { label: "Waiting", right: true, width: 10 },
  ];
  const lists: Array<{ title: string; note: string; rows: (key: TeamVisitDayKey) => CellValue[][] }> = [
    {
      note: "A rep in a seat who saved no visit that day. A vacant seat is not a rep and is never on this list.",
      rows: (key) => teamVisitAttention(report, key).none.map((ref) => [ref.regionName, ref.managerName, ref.person, ref.territory, dayName(key), 0]),
      title: "Saved no visit",
    },
    {
      note: "Every visit the rep saved that day is still waiting for its customer to be validated, so none is in the figures yet.",
      rows: (key) => {
        const attention = teamVisitAttention(report, key);
        return attention.waitingOnly.map((ref) => [ref.regionName, ref.managerName, ref.person, ref.territory, dayName(key), attention.waiting.find((entry) => entry.seatId === ref.seatId)?.waiting ?? 0]);
      },
      title: "Every visit still waiting for validation",
    },
    {
      note: "Every rep with at least one visit waiting for validation, and how many.",
      rows: (key) => teamVisitAttention(report, key).waiting.map((ref) => [ref.regionName, ref.managerName, ref.person, ref.territory, dayName(key), ref.waiting]),
      title: "A visit waiting for validation",
    },
  ];
  for (const list of lists) {
    const rows = TEAM_VISIT_DAYS.flatMap((key) => list.rows(key));
    lookRow = writeHouseTable(lookSheet, lookRow, {
      columns: lookColumns,
      note: list.note,
      rows: rows.length > 0 ? rows : [["Nobody", "", "", "", "", ""]],
      title: `${list.title} · ${rows.length}`,
    }) + 1;
  }

  // Pace — today against yesterday at the same visit-day minute, by team and by rep, read when the file was made.
  const paceSheet = workbook.addWorksheet("Pace", { properties: { defaultRowHeight: 18 } });
  paceSheet.views = [{ showGridLines: false }];
  let paceRow = writeHouseMasthead(workbook, paceSheet, { columns: 7, provenance, subtitle, title: "Pace" });
  const teamPace = teamVisitTeamPace(report, generatedAtIso);
  if (!pace || !teamPace) {
    writeHouseTable(paceSheet, paceRow, {
      columns: [{ label: "Today against yesterday", width: 90 }],
      rows: [[TEAM_VISITS_PACE_CLOSED]],
      title: "Today against yesterday at this time",
    });
  } else {
    paceRow = writeHouseTable(paceSheet, paceRow, {
      columns: [
        { label: "Region", width: 18 },
        { label: "District manager", width: 22 },
        { label: "Reps", right: true, width: 8 },
        { label: `Yesterday by ${teamPace.cutoffLabel}`, right: true, width: 18 },
        { label: `Today by ${teamPace.cutoffLabel}`, right: true, width: 16 },
        { label: "Difference", right: true, width: 12 },
        { label: "Reading", width: 34 },
      ],
      note: `Visits saved, waiting ones included. Yesterday is counted only up to ${teamPace.cutoffLabel} of its own visit day; a copied visit with no time is in neither side.`,
      rows: teamPace.teams.map((team) =>
        team.repsInSeats === 0
          ? [team.regionName, team.managerName, 0, "", "", "", "Every seat is vacant"]
          : [team.regionName, team.managerName, team.repsInSeats, team.yesterdayBy.saved, team.today.saved, teamVisitSignedDifference(team.difference), teamVisitPaceLine(team.difference)],
      ),
      title: `Team by team, at ${teamPace.cutoffLabel}`,
      totals: ["The whole team", "", pace.repsInSeats, pace.yesterdayBy.saved, pace.today.saved, teamVisitSignedDifference(pace.difference), teamVisitPaceLine(pace.difference)],
    }) + 1;
    const repPaceRows: CellValue[][] = report.districts.flatMap((district) =>
      district.reps.flatMap((rep) => {
        const repPace = teamVisitRepPace(rep, report, generatedAtIso);
        if (!repPace) return [];
        const difference = repPace.today - repPace.yesterdayBy;
        return [[district.regionName, district.managerName, rep.person, repPace.yesterdayBy, repPace.today, teamVisitSignedDifference(difference), rep.territory]];
      }),
    );
    writeHouseTable(paceSheet, paceRow, {
      columns: [
        { label: "Region", width: 18 },
        { label: "District manager", width: 22 },
        { label: "Rep", width: 24 },
        { label: `Yesterday by ${teamPace.cutoffLabel}`, right: true, width: 18 },
        { label: `Today by ${teamPace.cutoffLabel}`, right: true, width: 16 },
        { label: "Difference", right: true, width: 12 },
        { label: "Territory", width: 24 },
      ],
      note: "Each rep in a seat, the same cutoff. A vacant seat has no pace and no row.",
      rows: repPaceRows.length > 0 ? repPaceRows : [["Nobody in a seat", "", "", "", "", "", ""]],
      title: `Rep by rep, at ${teamPace.cutoffLabel}`,
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}
