import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import type {
  ManagerCvEngagementCandidate,
  ManagerCvEngagementReport,
  ManagerCvEngagementRow,
} from "../src/lib/recruitment/manager-cv-engagement.ts";
import {
  cairoEngagementDate,
  filterManagerEngagementRows,
  groupEngagementCandidatesByArea,
  managerStatusText,
} from "../src/lib/recruitment/manager-engagement-presentation.ts";
import {
  buildManagerEngagementWorkbook,
  cairoDateSerial,
  managerEngagementExportFilename,
} from "../src/lib/recruitment/manager-engagement-workbook.ts";

// The Manager CV Engagement XLSX export.
//
// EVERY ASSERTION HERE READS THE EMITTED WORKBOOK, not the builder's inputs — the buffer is written
// and then loaded back with ExcelJS. This module's whole failure mode is a file that looks right in
// source and says something else once Excel has it, so a test that checked the row arrays would
// certify nothing.

// `??` is deliberately NOT used for the nullable fields: an override of `null` is meaningful here
// (no area = a hand-push, no name = an unnamed CV), and `null ?? default` would quietly hand the
// default back and test the opposite case from the one the fixture asks for.
function candidate(over: Partial<ManagerCvEngagementCandidate> = {}): ManagerCvEngagementCandidate {
  return {
    candidateId: over.candidateId ?? "c-1",
    candidateName: over.candidateName === undefined ? "Nour Ahmed" : over.candidateName,
    area: over.area === undefined ? "Nasr City" : over.area,
    arrivedAt: over.arrivedAt === undefined ? "2026-09-01T08:00:00.000Z" : over.arrivedAt,
    opened: over.opened ?? false,
    answered: over.answered ?? false,
    status: over.status === undefined ? "sent_to_manager" : over.status,
  };
}

function managerRow(over: Partial<ManagerCvEngagementRow> & { managerHrId: string }): ManagerCvEngagementRow {
  const candidates = over.candidates ?? [candidate()];
  return {
    managerHrId: over.managerHrId,
    managerName: over.managerName ?? "Dina Kamal",
    managerJobTitle: over.managerJobTitle ?? "District Manager",
    managerArea: over.managerArea ?? "Giza",
    managerLine: over.managerLine ?? "CNS",
    inactive: over.inactive ?? false,
    employmentStatusLabel: over.employmentStatusLabel ?? null,
    lastWorkingDate: over.lastWorkingDate ?? null,
    received: over.received ?? candidates.length,
    opened: over.opened ?? candidates.filter((entry) => entry.opened).length,
    notOpened: over.notOpened ?? candidates.filter((entry) => !entry.opened).length,
    answered: over.answered ?? candidates.filter((entry) => entry.answered).length,
    candidates,
  };
}

const META = {
  exportedBy: "Omar Gawish",
  filterQuery: "",
  generatedAtIso: "2026-09-05T09:30:00.000Z",
  role: "Super Admin",
};

async function loadWorkbook(report: ManagerCvEngagementReport, meta = META): Promise<ExcelJS.Workbook> {
  const buffer = await buildManagerEngagementWorkbook({ report, meta });
  // A real xlsx is a zip — "PK" — so a builder that silently produced JSON or an empty buffer is
  // caught before any cell is read.
  assert.equal(buffer[0], 0x50, "the export must be a zip container (PK)");
  assert.equal(buffer[1], 0x4b, "the export must be a zip container (PK)");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook;
}

/** Every value in one sheet row, as text. */
function rowText(sheet: ExcelJS.Worksheet, rowNumber: number, width: number): string[] {
  const row = sheet.getRow(rowNumber);
  return Array.from({ length: width }, (_, index) => String(row.getCell(index + 1).value ?? ""));
}

function sheetOf(workbook: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const sheet = workbook.getWorksheet(name);
  if (!sheet) throw new Error(`the ${name} sheet is missing from the workbook`);
  return sheet;
}

/** The whole of a narrow sheet as one searchable string — used for the Cover's key/value rows. */
function sheetDump(sheet: ExcelJS.Worksheet, rows = 24, width = 3): string {
  return JSON.stringify(Array.from({ length: rows }, (_, index) => rowText(sheet, index + 1, width)));
}

export async function runRecruitmentManagerEngagementExportTests() {
  // ── The Cairo calendar day is what a date cell carries ──────────────────────────────────────────
  //
  // 22:30 UTC on the 4th is 01:30 Cairo on the 5th. The screen says "05 Sep 2026", so the sheet must
  // sort into the 5th too — the one failure this helper exists to prevent is a CV drifting a day
  // between the page and the file.
  const lateNight = "2026-09-04T22:30:00.000Z";
  // The DAY is what is pinned, not the month's abbreviation: en-GB renders September as "Sept" on
  // Node 24's ICU and "Sep" on some browsers, and this formatter is the one the screen has always
  // used — pinning its spelling would fail on a runtime upgrade over something that is not a defect.
  assert.match(cairoEngagementDate(lateNight), /^05 \w+ 2026$/, "the screen reads the CAIRO day — the 5th, not the 4th");
  const serial = cairoDateSerial(lateNight);
  assert.ok(typeof serial === "number", "an arrival must be a NUMBER so the column sorts, not text");
  assert.equal(
    new Date((serial - 25_569) * 86_400_000).toISOString().slice(0, 10),
    "2026-09-05",
    "the Excel serial must carry the same Cairo day the screen shows",
  );
  assert.equal(cairoDateSerial(null), null, "a missing arrival stays empty rather than becoming 1899");
  assert.equal(
    managerEngagementExportFilename("2026-09-04T22:30:00.000Z"),
    "manager-cv-engagement-2026-09-05.xlsx",
    "the filename is stamped with the Cairo day, never the UTC one",
  );

  // ── The shared reading: filter and grouping ─────────────────────────────────────────────────────
  const filterRows = [
    managerRow({ managerHrId: "A-12", managerName: "Dina Kamal", managerArea: "Giza", managerLine: "CNS" }),
    managerRow({ managerHrId: "B-155", managerName: "Sara Fouad", managerArea: "Nasr City", managerLine: "Pedia", managerJobTitle: "Regional Manager" }),
  ];
  assert.equal(filterManagerEngagementRows(filterRows, "").length, 2, "a blank filter keeps everyone");
  assert.deepEqual(
    filterManagerEngagementRows(filterRows, "pedia").map((row) => row.managerHrId),
    ["B-155"],
    "the filter reads the LINE, as the search box promises",
  );
  assert.deepEqual(
    filterManagerEngagementRows(filterRows, "regional").map((row) => row.managerHrId),
    ["B-155"],
    "the filter reads the JOB TITLE",
  );
  assert.deepEqual(
    filterManagerEngagementRows(filterRows, "DINA").map((row) => row.managerHrId),
    ["A-12"],
    "the filter is case-insensitive",
  );

  assert.deepEqual(
    groupEngagementCandidatesByArea([
      candidate({ candidateId: "c-1", area: null }),
      candidate({ candidateId: "c-2", area: "Zamalek" }),
      candidate({ candidateId: "c-3", area: "No area named" }),
      candidate({ candidateId: "c-4", area: "Agouza" }),
    ]).map((group) => group.area),
    ["Agouza", "Zamalek", "No area named", "Sent directly"],
    "named areas sort A→Z first, then the district catch-all, then the hand-pushes",
  );

  assert.equal(managerStatusText(managerRow({ managerHrId: "A-12" })), "Active");
  assert.equal(
    managerStatusText(
      managerRow({ managerHrId: "A-12", inactive: true, employmentStatusLabel: "Resigned", lastWorkingDate: "2026-08-31" }),
    ),
    "Resigned · left 31 Aug 2026",
    "an inactive manager carries the directory's own word and his last working day",
  );

  // ── The workbook itself ────────────────────────────────────────────────────────────────────────
  const dina = managerRow({
    managerHrId: "A-12",
    managerName: "Dina Kamal",
    candidates: [
      candidate({ candidateId: "c-1", candidateName: "Nour Ahmed", area: "Nasr City", arrivedAt: lateNight, opened: true, answered: true, status: "shortlisted" }),
      candidate({ candidateId: "c-2", candidateName: "Mostafa Ali", area: null, arrivedAt: "2026-08-20T06:00:00.000Z" }),
      candidate({ candidateId: "c-3", candidateName: null, area: "Agouza", arrivedAt: "2026-08-10T06:00:00.000Z" }),
    ],
  });
  const sara = managerRow({
    managerHrId: "B-155",
    managerName: "Sara Fouad",
    managerLine: "Pedia",
    inactive: true,
    employmentStatusLabel: "Resigned",
    lastWorkingDate: "2026-08-31",
    candidates: [candidate({ candidateId: "c-9", candidateName: "Hala Sayed", area: "Tanta" })],
  });
  const report: ManagerCvEngagementReport = {
    rows: [dina, sara],
    // DELIBERATELY WRONG, and nothing may read it. These are the unfiltered report's totals; a
    // filtered export that copied them onto its cover would state numbers its own sheets do not add
    // up to, which is the exact drift this workbook recomputes to avoid.
    totals: { managers: 99, received: 999, opened: 999, notOpened: 999, answered: 999 },
    scoped: false,
  };

  const workbook = await loadWorkbook(report);
  assert.deepEqual(
    workbook.worksheets.map((sheet) => sheet.name),
    ["Cover", "Managers", "CVs"],
    "three sheets, in this order",
  );

  // Cover — provenance, and the totals recomputed from the rows actually written.
  const coverText = sheetDump(sheetOf(workbook, "Cover"));
  assert.match(
    coverText,
    /\["","Generated","05 \w+ 2026, 12:30 \(Cairo\)"\]/,
    "generated-at is the CAIRO wall clock (09:30Z + 3), labelled as such — never a raw UTC string",
  );
  assert.match(coverText, /Omar Gawish · Super Admin/, "the exporter is named, not reduced to an HR_ID");
  assert.match(coverText, /"","Scope","All lines"/, "the scope the numbers were produced under is stated");
  assert.match(coverText, /None — every manager in scope/, "an unfiltered export says so rather than staying silent");
  assert.match(
    coverText,
    /\["","Not opened","3"\]/,
    "the cover's totals come from the rows written (2 + 1 unopened), not the report's stale figures",
  );
  assert.doesNotMatch(coverText, /999/, "the report's own totals must never be copied onto the cover");
  assert.match(coverText, /Nothing recorded an open before tracking began, so a CV that arrived before then shows as not opened even if it was read/, "the reading caveat travels with the file, without assuming how many CVs it touches");

  // Managers — the table on screen.
  const managers = sheetOf(workbook, "Managers");
  assert.deepEqual(rowText(managers, 5, 9), [
    "Manager",
    "Job title",
    "Area",
    "Line",
    "Status",
    "Received",
    "Opened",
    "Not opened",
    "Answered",
  ]);
  assert.deepEqual(
    rowText(managers, 6, 9),
    ["Dina Kamal", "District Manager", "Giza", "CNS", "Active", "3", "1", "2", "1"],
    "the busiest manager sorts first, with his four counts",
  );
  assert.deepEqual(
    rowText(managers, 7, 9),
    ["Sara Fouad", "District Manager", "Giza", "Pedia", "Resigned · left 31 Aug 2026", "1", "0", "1", "0"],
    "a manager who has left carries the badge text the screen shows",
  );
  assert.deepEqual(
    rowText(managers, 8, 9),
    ["Total CVs, each counted once", "", "", "", "", "4", "1", "3", "1"],
    "with no CV shared between managers, the totals row adds up the sheet above it",
  );

  // CVs — one line per (manager, CV), in the screen's own order.
  const cvs = sheetOf(workbook, "CVs");
  assert.deepEqual(rowText(cvs, 5, 7), ["Manager", "Area", "Candidate", "Arrived", "Opened", "Answered", "Decision"]);
  assert.deepEqual(
    [6, 7, 8, 9].map((rowNumber) => rowText(cvs, rowNumber, 3)),
    [
      ["Dina Kamal", "Agouza", "Unnamed candidate"],
      ["Dina Kamal", "Nasr City", "Nour Ahmed"],
      ["Dina Kamal", "Sent directly", "Mostafa Ali"],
      ["Sara Fouad", "Tanta", "Hala Sayed"],
    ],
    "manager order, then the screen's area order, and an unnamed CV still gets a line",
  );
  // Written as a serial, so Excel reads it back as a real DATE rather than as text — the CVs sheet is
  // the one somebody sorts by arrival to find the oldest thing nobody opened, and "05 Sept 2026" as
  // text sorts alphabetically. The day is the CAIRO one (22:30Z on the 4th is 01:30 Cairo on the 5th).
  const arrived = cvs.getRow(7).getCell(4).value;
  assert.ok(arrived instanceof Date, "Arrived must be a real date cell, not display text");
  assert.equal(arrived.toISOString(), "2026-09-05T00:00:00.000Z", "and it carries the Cairo day");
  assert.equal(cvs.getRow(7).getCell(4).numFmt, "dd mmm yyyy", "shown the way the screen shows it");
  assert.deepEqual(
    rowText(cvs, 7, 7).slice(4),
    ["Opened", "Answered", "Shortlisted"],
    "the two signals read in words, with the recorded decision beside them",
  );
  assert.deepEqual(
    rowText(cvs, 9, 7).slice(4),
    ["Not opened", "Awaiting", "Sent to manager"],
    "a CV nobody has touched reads as not opened and awaiting",
  );
  assert.ok(cvs.autoFilter, "the CV sheet is the one somebody sorts — it must ship with an autofilter");

  // A FILTERED export: only the rows handed in, and a cover that says which filter produced them.
  const filtered = await loadWorkbook(
    { ...report, rows: filterManagerEngagementRows(report.rows, "pedia") },
    { ...META, filterQuery: "pedia" },
  );
  const filteredManagers = sheetOf(filtered, "Managers");
  assert.deepEqual(rowText(filteredManagers, 6, 1), ["Sara Fouad"], "the filtered sheet holds only the filtered manager");
  assert.deepEqual(rowText(filteredManagers, 7, 9), ["Total CVs, each counted once", "", "", "", "", "1", "0", "1", "0"], "and its total is that manager alone");
  assert.match(sheetDump(sheetOf(filtered, "Cover")), /“pedia”/, "a filtered export names the filter on its cover");

  // An empty report still produces a readable file rather than throwing.
  const empty = await loadWorkbook({
    rows: [],
    totals: { managers: 0, received: 0, opened: 0, notOpened: 0, answered: 0 },
    scoped: true,
  });
  assert.deepEqual(empty.worksheets.map((sheet) => sheet.name), ["Cover", "Managers", "CVs"]);
  assert.match(
    sheetDump(sheetOf(empty, "Cover")),
    /Your line only/,
    "a scoped viewer's cover says the file covers his line only",
  );

  // ── The export must stay SILENT ────────────────────────────────────────────────────────────────
  //
  // The whole module rests on the managers being measured not being able to tell. An export that
  // reached for a CV file would write an ats_candidate_views row and inflate the very "opened"
  // number it is reporting. Pinned on the route source because there is no runtime signal for
  // "did not do something".
  const routeSource = readFileSync("app/api/recruitment/manager-engagement/export/route.ts", "utf8");
  assert.match(routeSource, /canViewManagerCvEngagement\(access\)/, "the export is gated by the report's own audience");
  assert.doesNotMatch(
    routeSource,
    /recordManagerCvOpen|markCandidateSeen|getManagerEngagementCandidateFile|listManagerEngagementCandidateFiles/,
    "the export must never touch a CV file — it would pollute the signal it measures",
  );
  // Matched in CODE shape, never as bare words: the builder's own header explains both traps by
  // name, so a raw-text scan would fail on the documentation of the very rule it is checking.
  const workbookSource = readFileSync("src/lib/recruitment/manager-engagement-workbook.ts", "utf8");
  assert.doesNotMatch(
    workbookSource,
    /outlineProperties\s*[:=]|\.addImage\(/,
    "neither ExcelJS fragment Excel silently repairs may be used here — the file must need no zip post-processing",
  );

  // The screen and the sheet must keep reading from ONE module — a re-inlined copy of the filter or
  // the grouping in the view is how the export starts disagreeing with the page above it.
  const viewSource = readFileSync("src/components/recruitment/manager-engagement-view.tsx", "utf8");
  assert.match(
    viewSource,
    /from "@\/lib\/recruitment\/manager-engagement-presentation"/,
    "the view must read its filter, grouping and dates from the shared presentation module",
  );
  assert.doesNotMatch(
    viewSource,
    /function cairoDate\(|const NO_AREA_LABEL|const SENT_DIRECTLY_LABEL/,
    "the view must not grow its own second copy of the date formatter or the area labels",
  );
}
