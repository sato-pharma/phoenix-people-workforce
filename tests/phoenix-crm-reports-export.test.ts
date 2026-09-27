import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import { buildPhoenixCrmReportsWorkbook, packSections, type ReportsPackInput } from "../src/lib/phoenix-crm/server/reports-workbook.ts";
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
    coverage: coverageView(),
    managers: null,
    locations: null,
    exceptions: null,
    bricks: null,
    // F3's sheet, added 2026-09-27. A REQUIRED field, not optional: a section the pack type lets you
    // leave out is a section nobody notices is missing from the workbook.
    adoption: null,
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

async function sheetsOf(input: ReportsPackInput): Promise<string[]> {
  const buffer = await buildPhoenixCrmReportsWorkbook(input);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook.worksheets.map((sheet) => sheet.name);
}

export async function runPhoenixCrmReportsExportTests(): Promise<void> {
  // ── 1. A section the viewer may not read writes NO SHEET ───────────────────────────────────────
  //
  // Read back out of the real workbook, not asserted against the input: a builder that quietly wrote
  // nothing at all would pass an input-shaped test and fail this one.
  {
    const repSheets = await sheetsOf(pack());
    assert.deepEqual(
      repSheets,
      ["Cover", "Visits per day", "Coverage and frequency"],
      "a rep's pack holds only the sections he may read — no empty tab announcing the ones he may not",
    );
    for (const withheld of ["Where the visit was saved", "Needs you", "Coverage against sales", "Who has started"]) {
      assert.equal(repSheets.includes(withheld), false, `${withheld} must be ABSENT, not present and empty`);
    }

    const managerSheets = await sheetsOf(pack({ adoption: adoptionView(), bricks: bricksView(), locations: locationsView() }));
    assert.ok(managerSheets.includes("Where the visit was saved"), "a manager's pack holds the locations sheet");
    assert.ok(managerSheets.includes("Coverage against sales"), "and the bricks sheet");
    assert.ok(managerSheets.includes("Who has started"), "and the adoption sheet (F3)");
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
      exceptions: { rows: [], summary: { territories: 0, needingAttention: 0, byKind: [] }, isTest: false, lastFieldDay: "2026-09-24", weekStart: "2026-09-19", windowFieldDays: 6 } as unknown as NonNullable<ReportsPackInput["exceptions"]>,
      locations: locationsView(),
      managers: { period: PERIOD, includeTest: false, rows: [] } as unknown as NonNullable<ReportsPackInput["managers"]>,
      plan: { period: PERIOD, includeTest: false, runningDay: null, rows: [], totals: { AM: { planned: 0, visitedPlanned: 0, plannedWaiting: 0, missed: 0, unplanned: 0, unplannedWaiting: 0, unplannedRefused: 0, keptPct: null }, PM: { planned: 0, visitedPlanned: 0, plannedWaiting: 0, missed: 0, unplanned: 0, unplannedWaiting: 0, unplannedRefused: 0, keptPct: null } } } as unknown as NonNullable<ReportsPackInput["plan"]>,
    });
    assert.deepEqual(await sheetsOf(full), ["Cover", ...packSections(full)], "the sheets are exactly what the cover promised, in that order");
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
    const sheet = workbook.getWorksheet("Coverage against sales");
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
    for (const gated of ["loadVisitLocationReport", "loadExceptionsBoard", "loadBrickCoverageReport"]) {
      assert.match(
        route,
        new RegExp(`managerSections \\? ${gated}\\([^)]*\\) : Promise\\.resolve\\(null\\)`),
        `${gated} is never even CALLED for a viewer who may not read it — the section is absent, not empty`,
      );
    }
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

  console.log("phoenix-crm reports export: OK");
}
