import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import { BRICK_STATUS_LABELS } from "../src/lib/phoenix-crm/brick-report.ts";
import { SECTION_TITLES, reportFileSlug } from "../src/lib/phoenix-crm/report-guide.ts";
import {
  buildPhoenixCrmReportsWorkbook,
  calendarSheetName,
  packSections,
  type ReportsPackInput,
} from "../src/lib/phoenix-crm/server/reports-workbook.ts";
import { accessRegistry } from "../src/lib/security/access-registry.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the reports pack as one workbook (C1 of the owner's plan).
 *
 * ## 🔴 WHICH SHEETS EXIST IS THE ACCESS CONTROL
 *
 * This is the one thing about the export that could be wrong without anybody noticing. A section the
 * viewer may not read writes **no sheet at all**. The tempting alternative — build every sheet and
 * leave the forbidden ones empty — tells a medical rep both that "Where the visit was saved" exists
 * and that he is not trusted with it, which is exactly the disclosure Golden Rule #1 forbids, only in
 * a file he keeps on his laptop. So the route never loads those sections, hands `null`, and the
 * builder skips them; the test below opens the emitted workbook and counts the tabs.
 *
 * ## Verified against the EMITTED ARTIFACT
 *
 * The sheets are read back out of the real `.xlsx` buffer with ExcelJS, not asserted against the
 * input object. A builder that silently wrote nothing would pass an input-shaped test and fail this
 * one.
 *
 * ## The other three things that would be wrong quietly
 *
 *   - **The house identity**, not Phoenix black-and-orange: this is a company document, and the two
 *     exemptions (payroll exports, the offer letter) are not this.
 *   - **AM and PM apart** in every sheet — a workbook is precisely where somebody would add one
 *     combined column "for convenience", and that is a call rate waiting to be averaged.
 *   - **The brick caveat travels WITH the figures.** A workbook leaves the building; the sentence
 *     cannot stay behind on a screen.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

const PERIOD = { from: "2026-09-01", to: "2026-09-25" };

function visitsView() {
  const counts = { visits: 4, doubleVisits: 1, chainVisits: 0, farVisits: 0, testVisits: 0, unplannedWaiting: 2 };
  return {
    period: PERIOD,
    includeTest: false,
    rows: [
      {
        key: "SEAT-1|HR-1",
        seatId: "SEAT-1",
        repHrId: "HR-1",
        repName: "Mahmoud Adel",
        territoryName: "Faisal",
        lineName: "Pedia",
        days: [],
        visitDays: 3,
        am: counts,
        pm: { ...counts, visits: 9 },
      },
    ],
    totals: { AM: counts, PM: { ...counts, visits: 9 } },
  } as unknown as NonNullable<ReportsPackInput["visits"]>;
}

function coverageView() {
  const cell = { customers: 12, covered: 9, withTarget: 10, onTarget: 6, under: 3, over: 1, visits: 30, coveragePct: 75, frequencyPct: 60 };
  return {
    month: { month: "2026-09", monthStart: "2026-09-01", monthEnd: "2026-09-30", inProgress: true },
    includeTest: false,
    rows: [{ seatId: "SEAT-1", territoryName: "Faisal", lineName: "Pedia", repName: "Mahmoud Adel", am: cell, pm: cell }],
    totals: { AM: cell, PM: cell },
  } as unknown as NonNullable<ReportsPackInput["coverage"]>;
}

/** The plan-against-actual section, empty but well formed — shared, so its two readers cannot drift. */
function planView() {
  const half = { planned: 0, visitedPlanned: 0, plannedWaiting: 0, missed: 0, onLeave: 0, unplanned: 0, unplannedWaiting: 0, unplannedRefused: 0, keptPct: null };
  return {
    period: PERIOD,
    includeTest: false,
    runningDay: null,
    leaveUnread: false,
    rows: [],
    totals: { AM: { ...half }, PM: { ...half } },
  } as unknown as NonNullable<ReportsPackInput["plan"]>;
}

function bricksView() {
  return {
    period: PERIOD,
    includeTest: false,
    salesMonths: ["2026-08"],
    caveat: "Bricks do not add up to the area's closing figure. A brick's sales are what distributors booked on it.",
    rows: [
      {
        seatId: "SEAT-1",
        territoryName: "Faisal",
        brickId: "B-2",
        brickName: "Haram",
        areaName: "Giza 3",
        status: "sales-no-list" as const,
        am: 0,
        pm: 0,
        customers: 0,
        amVisited: 0,
        pmVisited: 0,
        visited: 0,
        visits: 0,
        sales: 9000,
      },
    ],
    summary: { bricks: 1, withSales: 1, salesNoList: 1, listNoSales: 0, covered: 0, brickSales: 9000 },
  } as unknown as NonNullable<ReportsPackInput["bricks"]>;
}

function locationsView() {
  return {
    period: PERIOD,
    includeTest: false,
    total: 1,
    rows: [
      {
        visitId: "V-1",
        visitDate: "2026-09-10",
        capturedAt: "2026-09-10T09:00:00Z",
        territoryName: "Faisal",
        repName: "Mahmoud Adel",
        customerName: "Dr Sami",
        listType: "PM" as const,
        placeLabel: "Clinic",
        placeAddress: null,
        placeWhere: "Haram · Giza 3",
        placeLat: 30,
        placeLon: 31,
        visitLat: 30.01,
        visitLon: 31.01,
        accuracyMeters: 12,
        distanceMeters: 1400,
        distanceText: "1.4 km",
        locationFlag: "far",
        isUnplanned: false,
      },
    ],
    summary: { visits: 1, far: 1, weakGps: 0, noPlace: 0, measured: 1, farthestMeters: 1400 },
  } as unknown as NonNullable<ReportsPackInput["locations"]>;
}

function pack(patch: Partial<ReportsPackInput> = {}): ReportsPackInput {
  return {
    viewerName: "Omar Gawish",
    periodText: "2026-09-01 to 2026-09-25",
    scopeText: "3 territories in scope",
    includeTest: false,
    generatedAtIso: "2026-09-27T06:00:00.000Z",
    visits: visitsView(),
    plan: null,
    // The daily plan's sheet, added 2026-09-30 — required like the rest, and null unless ONE
    // territory was read.
    dailyPlan: null,
    coverage: coverageView(),
    managers: null,
    locations: null,
    exceptions: null,
    bricks: null,
    // F3's sheet, added 2026-09-27. A REQUIRED field, not optional: a section the pack type lets you
    // leave out is a section nobody notices is missing from the workbook.
    adoption: null,
    // Wave 2's three, added 2026-09-30, required for the same reason. 🔴 A GREEN RUN OF THIS FILE
    // CARRIES NO TYPE SIGNAL — the runner strips types — so a field missing here is caught by the
    // PR's typecheck and by nothing in this suite. Adding them by hand is the whole guard.
    frequency: null,
    tracking: null,
    calendar: null,
    // The four insight boards of 2026-10-02 — required for the same reason; their sheets are pinned in
    // tests/phoenix-crm-insight-reports.test.ts.
    capacity: null,
    heard: null,
    stock: null,
    samples: null,
    // Objections by doctor (owner, 2026-11-03), required for the same reason; its sheet is pinned in
    // tests/phoenix-crm-objections-by-doctor.test.ts.
    objections: null,
    ...patch,
  };
}

function adoptionView() {
  return {
    isTest: false,
    cairoToday: "2026-09-27",
    graceDays: 14,
    rows: [
      {
        seatId: "SEAT-1",
        territoryName: "Faisal",
        lineName: "Pedia",
        repName: "Mahmoud Adel",
        hasRep: true,
        stage: "never_touched" as const,
        label: "Never opened the module",
        why: "The line is open and nothing at all has been entered from this territory.",
        daysOpen: 26,
        overdue: true,
        readyAt: null,
        firstVisitOn: null,
        detail: "26 days since the line opened",
      },
    ],
    summary: { territories: 1, open: 1, neverTouched: 1, overdue: 1, ready: 0, working: 0, byStage: [] },
  } as unknown as NonNullable<ReportsPackInput["adoption"]>;
}

function dailyPlanView(patch: Partial<NonNullable<ReportsPackInput["dailyPlan"]>> = {}): NonNullable<ReportsPackInput["dailyPlan"]> {
  const customer = {
    customerId: "C-1",
    name: "Dr Sami Adel",
    grade: "A" as const,
    speciality: "Paediatrics",
    pending: false,
    stale: false,
    phone: "01012345678" as string | null,
    placeLabel: "Al Shifa Clinic",
    brick: "Shebin 3",
    area: "Menoufia 2",
    address: "12 Gamal Abdel Nasser St",
    hoursText: "6:00 PM – 8:00 PM",
    exceptionLabel: null,
    exceptionNote: null,
    status: "visited" as const,
    visitedMinute: 615,
    offPlan: null,
  };
  const day = {
    isTest: false,
    state: "approved" as const,
    submittedLate: false,
    starts: { startAmMinute: 660, startPmMinute: 1020 },
    startsText: "Start AM 11:00 AM · Start PM 5:00 PM",
    activities: [],
    listTypes: ["AM" as const, "PM" as const],
    running: false,
    onLeave: false,
  };
  return {
    period: { from: "2026-09-26", to: "2026-09-29" },
    cairoToday: "2026-09-30",
    visitDay: "2026-09-30",
    lastPlannableDay: "2026-11-05",
    includeTest: false,
    territory: { seatId: "SEAT-1", name: "Menoufia 2 · Anti Infective", lineName: "Anti Infective", repName: "Aya Ibrahim" },
    days: [
      { ...day, date: "2026-09-28", am: [{ ...customer, customerId: "C-2", name: "El Shifa Hospital", phone: null, status: "not_visited" as const, visitedMinute: null }], pm: [customer] },
      { ...day, date: "2026-09-29", state: "none" as const, startsText: null, am: [], pm: [] },
    ],
    leaveUnread: false,
    ...patch,
  };
}

async function sheetsOf(input: ReportsPackInput): Promise<string[]> {
  const buffer = await buildPhoenixCrmReportsWorkbook(input);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook.worksheets.map((sheet) => sheet.name);
}

export async function runPhoenixCrmReportsExportTests(): Promise<void> {
  // ── 0. The guide's names are legal WORKSHEET TAB NAMES ────────────────────────────────────────
  //
  // 🔴 FIRST, BEFORE ANYTHING IS BUILT, because ExcelJS reaches an illegal name before any
  //    assertion does: an over-long title made this suite report "… is really in the built
  //    workbook", which names the symptom and not the cause, and a forbidden character threw with
  //    no message at all. Both were measured. A report's title became a tab name when the workbook
  //    started reading SECTION_TITLES (section 9), so the screen can now hand Excel a name it
  //    refuses, and that failure would otherwise land on somebody's download.
  {
    // 🔴 THE TITLE IS NOW A WORKSHEET TAB NAME, AND EXCEL REFUSES SOME OF THOSE. Before the
    //    rewiring the tab was a literal here and a long screen title could not reach it; now it
    //    can, and the failure would land on somebody's download rather than on this suite. Excel
    //    allows 31 characters, forbids : \ / ? * [ ], and has no such thing as a blank tab.
    for (const [section, title] of Object.entries(SECTION_TITLES)) {
      assert.ok(title.trim().length > 0, `SECTION_TITLES.${section} is blank — a worksheet tab cannot be`);
      assert.ok(title.length <= 31, `SECTION_TITLES.${section} is ${title.length} characters — Excel refuses a worksheet tab over 31`);
      assert.doesNotMatch(title, /[:\\/?*\[\]]/, `SECTION_TITLES.${section} holds a character Excel forbids in a worksheet tab`);

      // 🔴 AND THE TITLE IS A FILENAME TOO, for a download holding ONE report. Only [a-z0-9-]
      //    survives reportFileSlug, so none of the characters a filename cannot hold can reach
      //    somebody's disk whatever a report is renamed to — asserted, not trusted, because the
      //    slug is the only thing standing between a screen title and a saved file.
      const slug = reportFileSlug(section as keyof typeof SECTION_TITLES);
      assert.ok(slug.length > 0, `reportFileSlug("${section}") is empty — the download would have no name`);
      //    One regex, both halves: the character set, and the leading/trailing dash the trim in
      //    reportFileSlug exists to remove. A separate "holds no forbidden character" assertion
      //    was dropped rather than shipped — this one implies it, so that one could never fail.
      assert.match(
        slug,
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
        `reportFileSlug("${section}") is "${slug}" — a filename slug is lower-case letters, digits and dashes, and never opens or closes with a dash`,
      );
    }
  }

  // ── 1. A section the viewer may not read writes NO SHEET ───────────────────────────────────────
  //
  // Read back out of the real workbook, not asserted against the input: a builder that quietly wrote
  // nothing at all would pass an input-shaped test and fail this one.
  {
    const repSheets = await sheetsOf(pack());
    assert.deepEqual(
      repSheets,
      ["Cover", SECTION_TITLES.visits, SECTION_TITLES.coverage],
      "a rep's pack holds only the sections he may read — no empty tab announcing the ones he may not",
    );
    for (const withheld of [SECTION_TITLES.locations, SECTION_TITLES.exceptions, SECTION_TITLES.bricks, SECTION_TITLES.adoption]) {
      assert.equal(repSheets.includes(withheld), false, `${withheld} must be ABSENT, not present and empty`);
    }

    const managerSheets = await sheetsOf(pack({ adoption: adoptionView(), bricks: bricksView(), locations: locationsView() }));
    assert.ok(managerSheets.includes(SECTION_TITLES.locations), "a manager's pack holds the locations sheet");
    assert.ok(managerSheets.includes(SECTION_TITLES.bricks), "and the bricks sheet");
    assert.ok(managerSheets.includes(SECTION_TITLES.adoption), "and the adoption sheet (F3)");
    assert.ok(managerSheets.length > repSheets.length, "a manager's pack is strictly larger than a rep's");
  }

  // ── 2. An empty pack is still a valid workbook with its cover ──────────────────────────────────
  //
  // A viewer with nothing in scope gets a file that says so, not a corrupt download or a crash.
  {
    const sheets = await sheetsOf(pack({ coverage: null, visits: null }));
    assert.deepEqual(sheets, ["Cover"], "with no readable section the pack is the cover alone");
    assert.deepEqual(packSections(pack({ coverage: null, visits: null })), [], "and the cover names no sheets");
  }

  // ── 3. `packSections` is the order the cover promises, and the builder follows it ──────────────
  {
    const full = pack({
      adoption: adoptionView(),
      bricks: bricksView(),
      exceptions: { rows: [], onLeave: [], summary: { territories: 0, needingAttention: 0, onLeave: 0, byKind: [] }, holidaysUnread: false, leaveUnread: false, isTest: false, lastWorkingDay: "2026-09-23", weekStart: "2026-09-19", windowWorkingDays: 6 } as unknown as NonNullable<ReportsPackInput["exceptions"]>,
      locations: locationsView(),
      managers: { period: PERIOD, includeTest: false, rows: [] } as unknown as NonNullable<ReportsPackInput["managers"]>,
      plan: planView(),
      dailyPlan: dailyPlanView(),
    });
    assert.deepEqual(await sheetsOf(full), ["Cover", ...packSections(full)], "the sheets are exactly what the cover promised, in that order");
    const order = packSections(full);
    assert.equal(order.indexOf(SECTION_TITLES.daily), order.indexOf(SECTION_TITLES.plan) + 1, "the daily plan follows plan against actual, as on the screen");
  }

  // ── 3b. The daily plan: ONE territory's sheet, a row a planned customer, and never a total ──────
  {
    // Read with several territories in reach and none chosen, it names no territory — and writes no sheet.
    const unchosenPack = pack({ dailyPlan: dailyPlanView({ territory: null, days: [] }) });
    const unchosen = await sheetsOf(unchosenPack);
    assert.equal(unchosen.includes(SECTION_TITLES.daily), false, "no territory, no sheet — never an empty tab");
    assert.equal(packSections(unchosenPack).includes(SECTION_TITLES.daily), false, "and the cover does not promise one");

    const buffer = await buildPhoenixCrmReportsWorkbook(pack({ dailyPlan: dailyPlanView() }));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet(SECTION_TITLES.daily);
    assert.ok(sheet, "a rep's own territory gets its daily plan sheet");
    const rows: string[][] = [];
    sheet.eachRow((row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => cells.push(String(cell.value ?? "")));
      rows.push(cells);
    });
    const headers = rows[1] ?? [];
    assert.deepEqual(
      headers.slice(0, 7),
      ["Day", "Weekday", "Plan", "Starts", "Other activities", "List", "Customer"],
      "the day's own facts first, then the list the customer is on, then the customer",
    );
    const visited = rows.find((cells) => cells.includes("Dr Sami Adel"));
    assert.ok(visited, "the planned customer has his row");
    assert.ok(visited.includes("PM") && visited.includes("Visited 10:15 AM"), "on his own list, with when he was seen");
    assert.ok(visited.includes("Monday") && visited.includes("Start AM 11:00 AM · Start PM 5:00 PM"), "carrying his day's weekday and start times");
    const missed = rows.find((cells) => cells.includes("El Shifa Hospital"));
    assert.ok(missed && missed.includes("AM") && missed.includes("Not visited"));
    // The old report's phone column (owner, 2026-09-30): the rep's typed phone, "—" until he gives one.
    const phoneAt = headers.indexOf("Phone");
    assert.ok(phoneAt > headers.indexOf("Customer"), "the sheet has a Phone column, after the customer");
    assert.equal(visited[phoneAt], "01012345678", "carrying the phone the rep gave him");
    assert.equal(missed[phoneAt], "—", "and a dash for one who has none yet, never a blank that reads as a lost cell");
    assert.ok(rows.some((cells) => cells.includes("2026-09-29") && cells.includes("No plan for this week")), "a day with nobody on it keeps a row, so the gap shows");
    assert.equal(
      rows.some((cells) => cells.some((cell) => /^(All|Total)\b/i.test(cell))),
      false,
      "a listing carries no total row — plan against actual is the measure",
    );
  }

  // ── 3c. A day with nothing on it reads as the screen reads it: no plan state beside it ──────────
  //
  // The screen stopped putting "Not sent before the day" beside an empty day, which read as a failure
  // about a day nobody planned anything for; the download kept printing it (owner, 2026-10-01: "fix the
  // daily plan Excel's empty days to match the screen"). Read back out of the real workbook.
  {
    const base = dailyPlanView();
    const approvedDay = base.days[0];
    const emptyDay = { ...approvedDay, startsText: null, activities: [], am: [], pm: [] };
    const buffer = await buildPhoenixCrmReportsWorkbook(
      pack({
        dailyPlan: dailyPlanView({
          days: [
            { ...emptyDay, date: "2026-09-24", state: "approved" as const, submittedLate: true, isTest: true },
            { ...emptyDay, date: "2026-09-26", state: "not_sent" as const },
            {
              ...emptyDay,
              date: "2026-09-27",
              state: "approved" as const,
              submittedLate: true,
              activities: [{ activityType: "meeting" as const, label: "Meeting", halfDay: true, note: null }],
            },
            ...base.days,
          ],
        }),
      }),
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet(SECTION_TITLES.daily);
    assert.ok(sheet, "the daily plan sheet is written");
    const rows: string[][] = [];
    sheet.eachRow((row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => cells.push(String(cell.value ?? "")));
      rows.push(cells);
    });
    const headers = rows[1] ?? [];
    const planAt = headers.indexOf("Plan");
    const customerAt = headers.indexOf("Customer");
    const rowOf = (date: string) => {
      const found = rows.find((cells) => cells[0] === date);
      assert.ok(found, `${date} keeps a row of its own`);
      return found;
    };

    const notSent = rowOf("2026-09-26");
    assert.equal(notSent[planAt], "—", "a past empty day never reads \"Not sent before the day\" — nothing was there to send");
    assert.equal(notSent[customerAt], "Nothing planned this day", "it says so in the screen's words instead");

    const testDay = rowOf("2026-09-24");
    assert.equal(testDay[planAt], "test entries", "an empty test day keeps only its test marker — no \"Approved · sent late\" beside nothing");
    assert.equal(testDay[customerAt], "Nothing planned this day");

    const meetingDay = rowOf("2026-09-27");
    assert.equal(meetingDay[planAt], "Approved · sent late", "a day holding an activity is a planned day, so its state stays, as on the screen");
    assert.equal(meetingDay[customerAt], "No customer planned this day", "and it names what is missing: the customers, not the day");

    const noPlan = rowOf("2026-09-29");
    assert.equal(noPlan[planAt], "—", "a week with no plan puts no state beside its days either");
    assert.equal(noPlan[customerAt], "No plan for this week");

    const plannedRow = rows.find((cells) => cells.includes("Dr Sami Adel"));
    assert.equal(plannedRow?.[planAt], "Approved", "a day with customers on it keeps its plan state");
  }

  // ── 4. AM and PM stay apart in every sheet ─────────────────────────────────────────────────────
  //
  // A workbook is precisely where a combined column gets added "for convenience", and a combined
  // column is a call rate waiting to be averaged (the call-rate golden rule).
  {
    const buffer = await buildPhoenixCrmReportsWorkbook(pack({ bricks: bricksView() }));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    let checked = 0;
    for (const sheet of workbook.worksheets) {
      if (sheet.name === "Cover") continue;
      const headers: string[] = [];
      sheet.getRow(2).eachCell((cell) => headers.push(String(cell.value ?? "")));
      const am = headers.filter((header) => /\bAM\b/.test(header)).length;
      const pm = headers.filter((header) => /\bPM\b/.test(header)).length;
      if (am === 0 && pm === 0) continue;
      checked += 1;
      assert.equal(am, pm, `${sheet.name}: AM and PM must have the same number of columns, or one of them is being merged away`);
      for (const header of headers) {
        assert.equal(/AM\s*[/+]\s*PM|AM and PM/i.test(header), false, `${sheet.name}: "${header}" joins AM and PM into one column`);
      }
    }
    assert.ok(checked >= 2, `at least two sheets carry AM/PM columns — only ${checked} did, so this check swept almost nothing`);

    // 🔴 AND OFF-PLAN WAS THE ONE PLACE TWO SHEETS ADDED THEM. "Visits per day" printed
    //    `row.am.unplannedWaiting + row.pm.unplannedWaiting` under one heading, and "Plan against
    //    actual" printed `row.am.unplanned + row.pm.unplanned` under another. A sum is exactly the
    //    shape the golden rule bans, and the headings read as if they were a single measure.
    //
    //    🔴 ITS OWN WORKBOOK, carrying the PLAN section. The default `pack()` is a REP's pack —
    //    visits and coverage only — so `getWorksheet("Plan against actual")` on the workbook above
    //    is `undefined`, and `assert.ok(sheet)` then fails for the one reason that says nothing
    //    about the columns. A sheet has to be in the pack before its headers can be read.
    const withPlan = new ExcelJS.Workbook();
    await withPlan.xlsx.load((await buildPhoenixCrmReportsWorkbook(pack({ plan: planView() }))) as unknown as ArrayBuffer);
    for (const [sheetName, amHeader, pmHeader, combined] of [
      [SECTION_TITLES.visits, "AM off-plan waiting", "PM off-plan waiting", "Off-plan waiting"],
      [SECTION_TITLES.plan, "AM off-plan", "PM off-plan", "Off-plan"],
    ] as const) {
      const sheet = withPlan.getWorksheet(sheetName);
      assert.ok(sheet, `${sheetName} is in the pack`);
      const headers: string[] = [];
      sheet.getRow(2).eachCell((cell) => headers.push(String(cell.value ?? "")));
      assert.ok(headers.includes(amHeader), `${sheetName}: off-plan has its own AM column`);
      assert.ok(headers.includes(pmHeader), `${sheetName}: and its own PM column`);
      assert.equal(headers.includes(combined), false, `${sheetName}: the combined "${combined}" column is gone`);
    }
  }

  // ── 4b. The brick standing is the SCREEN's words, never the raw key ────────────────────────────
  //
  // 🔴 It printed `row.status` — so a manager opening the pack read `sales-no-list` in the column
  // the screen reads "Sells here, nobody on the list". A workbook leaves the building without the
  // screen that could explain a key, which is the one place a reader cannot look it up.
  {
    const buffer = await buildPhoenixCrmReportsWorkbook(pack({ bricks: bricksView() }));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet(SECTION_TITLES.bricks);
    assert.ok(sheet, "the bricks sheet is there");
    const cells: string[] = [];
    sheet.eachRow((row) => row.eachCell((cell) => cells.push(String(cell.value ?? ""))));
    assert.ok(cells.includes(BRICK_STATUS_LABELS["sales-no-list"]), "the standing is written out in the screen's own words");
    assert.equal(cells.includes("sales-no-list"), false, "and the raw key never reaches a reader");
  }

  // ── 5. The brick caveat travels WITH the figures ───────────────────────────────────────────────
  //
  // A screen can hold a note beside a table; a saved file cannot. The sentence must be inside the
  // workbook or the figures leave the building without it.
  {
    const view = bricksView();
    const buffer = await buildPhoenixCrmReportsWorkbook(pack({ bricks: view }));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet(SECTION_TITLES.bricks);
    assert.ok(sheet, "the bricks sheet is there");
    let found = false;
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        if (typeof cell.value === "string" && cell.value.includes("do not add up to the area")) found = true;
      });
    });
    assert.ok(found, "the server's own caveat is written into the sheet, not left behind on the screen");
  }

  // ── 6. The house identity, and the sections' access, are enforced where they are decided ───────
  {
    const workbookSource = source("src/lib/phoenix-crm/server/reports-workbook.ts");
    assert.ok(workbookSource.includes("buildHouseCoverSheet"), "the cover is the house cover");
    assert.ok(workbookSource.includes("writeHouseTable"), "and every sheet is a house table");
    assert.equal(
      /buildCoverSheet\b|(?<!House)writeTable\b|sales-workbook-kit/.test(workbookSource),
      false,
      "it must not fall back to the Phoenix kit — Phoenix CRM's reports are a company document, and the kit's exemptions are payroll and the offer letter",
    );

    const route = source("app/api/phoenix-crm/reports/export/route.ts");
    assert.ok(route.includes("readsTeamReports(viewer)"), "the route decides the manager sections with the same predicate the services use");
    for (const gated of ["loadExceptionsBoard", "loadBrickCoverageReport"]) {
      assert.match(
        route,
        new RegExp(`managerSections \\? ${gated}\\([^)]*\\) : Promise\\.resolve\\(null\\)`),
        `${gated} is never even CALLED for a viewer who may not read it — the section is absent, not empty`,
      );
    }
    // The place-vs-actual sheet has its OWN audience since 2026-10-02 (owner: the DM, the NSM, SFE and
    // the Super Admin — not the CEO or a regional manager). Behind `managerSections` its service would
    // refuse the CEO and fail his whole pack, so it is gated by the report's own predicate.
    assert.ok(route.includes("const locationSection = readsPlaceVsActual(viewer);"), "the location sheet is decided by the report's own predicate");
    assert.match(
      route,
      /locationSection \? loadVisitLocationReport\([^)]*\) : Promise\.resolve\(null\)/,
      "loadVisitLocationReport is never even CALLED for a viewer who may not read it — the section is absent, not empty",
    );
    // The limiter before the work, not after it: seven sections is a heavy read and a limiter that
    // fires once the work is done has protected nothing.
    const limited = route.indexOf("assertExportRateLimit");
    const loaded = route.indexOf("loadReportScope");
    assert.ok(limited !== -1 && loaded !== -1 && limited < loaded, "the rate limit runs BEFORE any section is loaded");
    assert.ok(route.includes("writeAuditLog"), "taking the workbook is audited — it names individual employees and leaves the building");
  }

  // ── 7. The route is in the access registry, audited as an export ───────────────────────────────
  {
    const entry = accessRegistry.find((row) => row.pattern === "/api/phoenix-crm/reports/export");
    assert.ok(entry, "the export route is declared in the access registry");
    assert.equal(entry.audit?.required, true, "an export route must be audit-required");
    assert.equal(entry.audit?.classification, "export", "and classified as an export");
    assert.deepEqual(entry.permission, { resource: "phoenix_crm", action: "read" }, "same gate as the screen it exports");
  }

  // ── 8. One copy of the blob download ───────────────────────────────────────────────────────────
  //
  // The GET-a-workbook shape and the POST-a-table shape differ only in how the response is obtained;
  // a second hand-rolled copy is how one caller loses the server's filename or leaks the object URL.
  {
    const client = source("src/lib/export/download-xlsx-client.ts");
    assert.ok(client.includes("export async function saveXlsxResponse"), "the save half is its own function");
    assert.ok(client.includes("export async function downloadXlsxFrom"), "and the GET shape is built on it");
    assert.equal(
      (client.match(/createObjectURL/g) ?? []).length,
      1,
      "there is exactly ONE blob download in this file — a second copy is the drift this extraction removes",
    );
    assert.ok(
      source("src/components/phoenix-crm/reports-tab.tsx").includes("downloadXlsxFrom("),
      "the Reports tab uses the shared helper rather than its own fetch-and-anchor",
    );
  }

  // ── Wave 2's three sheets ───────────────────────────────────────────────────────
  {
    // Absent by default, exactly like every other section: null writes NO sheet and the cover
    // promises none. A tab headed with a report that is not in it is worse than a tab that is absent.
    const bare = packSections(pack({}));
    for (const name of [SECTION_TITLES.frequency, SECTION_TITLES.tracking, calendarSheetName({ scope: "team" })]) {
      assert.equal(bare.includes(name), false, `${name} is not promised when it was not loaded`);
    }

    const threeViews = {
        // `scope` since 2026-10-01: whose month the sheet holds. Required, not optional — a
        // calendar that cannot say whose it is would print a rep's own month under a team heading.
        // `missedRecords` since 2026-10-01: null for everyone but the Super Admin, and the workbook
        // never reads it — it only says which calendar cells open for him to enter a missed record.
        // `leaveUnread` since 2026-10-02: HR's leave could not be read, so an approved vacation draws
        // as blank days — said, never swallowed. Required, like `scope`: a calendar that cannot say
        // it lost the annotation shows a rep's week off as a week he did nothing.
        calendar: { days: ["2026-09-01"], isTest: false, leaveUnread: false, missedRecords: null, month: "2026-09", rows: [], scope: "team", totals: { am: 0, pharmacies: 0, pm: 0 } },
        frequency: { awaitingValidation: 0, includeTest: false, leaveUnread: false, month: { inProgress: false, month: "2026-09", monthEnd: "2026-09-30", monthStart: "2026-09-01" }, needsOneTerritory: false, rows: [], seat: null, totals: { customers: 0, noTarget: 0, onTarget: 0, over: 0, under: 0 } },
        tracking: { days: ["2026-09-01"], includeTest: false, month: { inProgress: false, month: "2026-09", monthEnd: "2026-09-30", monthStart: "2026-09-01" }, needsOneTerritory: false, rows: [], seat: null, showsSpacing: true },
    } as Partial<ReportsPackInput>;

    // In the cover's own order, straight after coverage.
    const promised = packSections(pack(threeViews));
    const wanted = [SECTION_TITLES.coverage, SECTION_TITLES.frequency, SECTION_TITLES.tracking, calendarSheetName({ scope: "team" })];
    assert.deepEqual(
      promised.filter((name) => wanted.includes(name)),
      wanted,
      "the three sit after coverage, in the order the workbook writes them",
    );
    // 🔴 READ BACK OUT OF THE REAL WORKBOOK, never asserted against the input — the rule this file
    //    already follows above: a builder that promised a sheet on the cover and wrote none would
    //    pass every check made on `packSections` alone.
    const built = await sheetsOf(pack(threeViews));
    for (const name of wanted) assert.ok(built.includes(name), `${name} is really in the built workbook`);
    assert.deepEqual(built.filter((name) => wanted.includes(name)), wanted, "and in that order");

    // 🔴 THE CALENDAR'S TAB IS NAMED FOR WHOSE MONTH IT HOLDS. A rep has read this report since
    //    2026-10-01, scoped to himself, so "Team calendar" on his own download names a thing he
    //    does not have. Read back out of the REAL workbook, because the cover and the sheet are
    //    written by two different calls and the failure this guards is them disagreeing — a cover
    //    promising a tab the file does not contain reads as a corrupt download.
    const ownViews = { ...threeViews, calendar: { ...(threeViews as { calendar: object }).calendar, scope: "own" } } as Partial<ReportsPackInput>;
    const ownSheets = await sheetsOf(pack(ownViews));
    assert.ok(ownSheets.includes("Your month"), "a rep's workbook carries Your month");
    assert.equal(ownSheets.includes("Team calendar"), false, "and never Team calendar as well");
    assert.ok(packSections(pack(ownViews)).includes("Your month"), "the cover promises the same name the tab carries");
    assert.equal(
      packSections(pack(ownViews)).filter((name) => ownSheets.includes(name)).length,
      packSections(pack(ownViews)).length,
      "every name the cover promises is really a tab in the file",
    );
    // And the manager's name is untouched: this renames one reader's tab, not the report.
    assert.equal(calendarSheetName({ scope: "team" }), "Team calendar");
    assert.equal(calendarSheetName({ scope: "own" }), "Your month");
    assert.equal(calendarSheetName(null), "Team calendar", "and an absent view falls back to the name the file has always used");

    const route = stripComments(readFileSync("app/api/phoenix-crm/reports/export/route.ts", "utf8"));
    // 🔴 NO TERRITORY MEANS NO SHEET. Both per-customer reports answer `needsOneTerritory` for a
    //    whole scope, and a sheet of thousands of rows for a district is not what that means.
    assert.match(route, /frequencyRaw\.needsOneTerritory \? null : frequencyRaw/, "frequency is dropped unless one territory was chosen");
    assert.match(route, /trackingRaw\.needsOneTerritory \? null : trackingRaw/, "and so is the tracking sheet");
    // 🔴 THE CALENDAR STOPPED BEING A MANAGER SECTION ON 2026-10-01, at the owner's instruction:
    //    "I want the medical rep to have also his team calendar seeing only himself". This line
    //    read `managerSections ? loadTeamCalendar(` until then, and it is CHANGED rather than
    //    deleted — the rule it protects is the same one, that the workbook and the screen agree
    //    about who may read a section, and it is still gated by the service's own predicate. What
    //    moved is which predicate that is. A rep's sheet holds his own month; leaving it behind
    //    `managerSections` would have handed him a download missing the one month view he can open.
    assert.match(route, /readsCalendar\(viewer\) \? loadTeamCalendar\(/, "the calendar is gated by its own predicate, so the file matches the screen");
    assert.doesNotMatch(route, /managerSections \? loadTeamCalendar\(/, "and is no longer a manager-only section");
    // 🔴 A REP'S FILE CARRIES NO "PER MANAGER" SHEET (2026-10-29). The managers report is asked for
    //    whatever the scope, and the service answers a rep with an empty list; the screen offers the
    //    report only behind `scope.hasManagers`, and the file now follows the same gate — the builder
    //    writes no tab for null, where an empty list printed a header and no rows into a rep's download.
    assert.match(route, /managers: scope\.hasManagers \? managers : null/, "the managers sheet is written only when the scope has a manager to show");

    const workbook = stripComments(readFileSync("src/lib/phoenix-crm/server/reports-workbook.ts", "utf8"));
    // 🔴 THE CALENDAR CELL IS A WORD, NEVER A FIGURE — on a both-halves day a single number is
    //    AM + PM added, and every count of visits is reported apart.
    assert.doesNotMatch(workbook, /totals\.am \+ [A-Za-z.]*totals\.pm/, "the workbook never adds the two halves");
    assert.match(workbook, /both: "AM\+PM"/, "a both-halves day says so in words");
    // 🔴 THE SPACING COLUMN IS ABSENT, NOT EMPTY, WHEN THE SERVICE WITHHELD IT. A blank column
    //    headed "The shape of the month" tells a rep a judgement exists and is being kept from him.
    assert.match(workbook, /view\.showsSpacing \? \[column\("The shape of the month"/, "the note's column is only there when there are notes");
  }

  // ── 9. A report's NAME is written ONCE, in the guide ───────────────────────────────────────────
  //
  // 🔴 IT USED TO BE WRITTEN THREE TIMES PER REPORT — the worksheet tab, the heading inside it, and
  //    `packSections`, which is what the COVER promises — so renaming a report on the screen renamed
  //    it in none of them. That was not a theoretical drift: `exceptions` had ALREADY come apart,
  //    reading "Needs you today" on the screen and in its own heading against a tab called "Needs
  //    you". `calendarSheetName` has carried the one-name rule for the calendar since it was
  //    written, for exactly this reason; this is the same rule for the other fifteen.
  {
    const names = source("src/lib/phoenix-crm/server/reports-workbook.ts");
    assert.doesNotMatch(names, /addWorksheet\("/, "every tab is named from SECTION_TITLES or calendarSheetName, never a literal");
    const cover = names.slice(names.indexOf("export function packSections"), names.indexOf("export async function buildPhoenixCrmReportsWorkbook"));
    assert.ok(cover.length > 200, "the packSections body was found");
    assert.doesNotMatch(cover, /\? "/, "and the cover's list names no report by hand — a cover and a tab that disagree is a file that reads as broken");
    for (const [section, title] of Object.entries(SECTION_TITLES)) {
      assert.equal(
        names.includes(title),
        false,
        `"${title}" is still written out in reports-workbook.ts — read it from SECTION_TITLES.${section}, or a rename reaches the screen and not the workbook. A backtick heading counts: this is a bare substring check, because a quoted-only one missed exactly that`,
      );
    }

    // The ONE heading that is deliberately not the report's name, kept here so a sweep like the one
    // above cannot quietly take it: the sheet is a row per REP, and relabelling it would relabel the
    // rows. See the comment on it in reports-workbook.ts.
    assert.match(names, /title: `Visits per rep · /, "the visits sheet still heads its rows per rep");

    // Every report the guide names has a sheet, the cover promises exactly those, and the calendar
    // sits where it always has — it is a month view, not a report, so it is not in the guide.
    const everything = {
      adoption: {},
      bricks: {},
      calendar: { scope: "team" },
      capacity: {},
      coverage: {},
      dailyPlan: { territory: {} },
      exceptions: {},
      frequency: {},
      heard: {},
      locations: {},
      managers: {},
      objections: {},
      plan: {},
      samples: {},
      stock: {},
      tracking: {},
      visits: {},
    } as unknown as ReportsPackInput;
    const promised = packSections(everything);
    assert.deepEqual(
      promised,
      [
        SECTION_TITLES.exceptions,
        SECTION_TITLES.visits,
        SECTION_TITLES.plan,
        SECTION_TITLES.daily,
        SECTION_TITLES.coverage,
        SECTION_TITLES.frequency,
        SECTION_TITLES.tracking,
        calendarSheetName({ scope: "team" }),
        SECTION_TITLES.bricks,
        SECTION_TITLES.managers,
        SECTION_TITLES.locations,
        SECTION_TITLES.adoption,
        SECTION_TITLES.capacity,
        SECTION_TITLES.heard,
        SECTION_TITLES.stock,
        SECTION_TITLES.samples,
        SECTION_TITLES.objections,
      ],
      "the cover promises every report in the guide, in the screen's order, plus the calendar",
    );
    assert.deepEqual(
      [...promised].filter((name) => name !== calendarSheetName({ scope: "team" })).sort(),
      [...Object.values(SECTION_TITLES)].sort(),
      "a report in the guide with no sheet would be offered on the screen and missing from the download",
    );

    // 🔴 THE FOURTH PLACE, AND THE ONE A RENAME COULD STILL MISS: the FILENAME of a download
    //    that holds ONE report. The route spelled `phoenix-crm-what-the-field-heard-…` out by
    //    hand, so renaming that report reached the screen, the tab, the heading and the cover —
    //    and the file a product manager actually saves kept the old name. It IS the saved name:
    //    saveXlsxResponse prefers the server's Content-Disposition over the caller's fallback.
    const route = source("app/api/phoenix-crm/reports/export/route.ts");
    assert.match(route, /reportFileSlug\("heard"\)/, "the single-report download names its report from the guide");
    for (const [section, title] of Object.entries(SECTION_TITLES)) {
      assert.equal(
        route.includes(`phoenix-crm-${reportFileSlug(section as keyof typeof SECTION_TITLES)}`),
        false,
        `the export route spells "${title}" into a filename by hand — read it from reportFileSlug("${section}")`,
      );
    }
  }

  console.log("phoenix-crm reports export: OK");
}
