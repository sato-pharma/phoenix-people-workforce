import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildAuditWeeks,
  buildCombinedAuditWorkbook,
  buildDoubleVisitAuditWorkbook,
  filterRowsByPeriod,
  splitRangeByMonth,
  weekIndexOf,
  type DoubleVisitAuditData,
} from "../src/lib/double-visit-analytics/audit-export.ts";
import type { DoubleVisitDbRow } from "../src/lib/double-visit-analytics/service.ts";

function dbRow(input: Partial<DoubleVisitDbRow> & Pick<DoubleVisitDbRow, "activity_date">): DoubleVisitDbRow {
  return {
    activity_date: input.activity_date,
    area_name: input.area_name ?? null,
    double_visitor_hr_id: input.double_visitor_hr_id ?? "B-100",
    double_visitor_name: input.double_visitor_name ?? "Coach",
    id: input.id ?? Math.random().toString(36).slice(2),
    line_name: input.line_name ?? null,
    period: input.period ?? "PM",
    visit_type: input.visit_type ?? 0,
    visit_type_description: input.visit_type_description ?? "Regular",
    source_record_id: input.source_record_id ?? null,
    source_type: input.source_type ?? "ireports360",
    speciality: input.speciality ?? null,
    visit_count: input.visit_count ?? 1,
    visited_employee_hr_id: input.visited_employee_hr_id ?? "B-200",
    visited_employee_name: input.visited_employee_name ?? "Rep",
    visited_employee_status: input.visited_employee_status ?? "active_mapped",
  };
}

export async function runDoubleVisitAuditExportTests() {
  // ── buildAuditWeeks: real calendar ranges, never a bare "W1" ──────────────────────
  const weeks = buildAuditWeeks("2026-09-01", "2026-09-30");
  assert.equal(weeks.length, 5, "a 30-day window splits into five 7-day weeks");
  assert.equal(weeks[0].start, "2026-09-01");
  assert.equal(weeks[0].end, "2026-09-07");
  assert.equal(weeks[0].rangeLabel, "Sep 1–7", "the first week carries its real date range");
  assert.equal(weeks[0].label, "W1 (Sep 1–7)", "the label shows both the index and the real range");
  assert.equal(weeks[4].start, "2026-09-29");
  assert.equal(weeks[4].end, "2026-09-30", "the last week is clamped to the window end");
  assert.equal(buildAuditWeeks("2026-09-30", "2026-09-01").length, 0, "an inverted window yields no weeks");

  // A window that crosses a month shows the month on both sides of the dash.
  const crossMonth = buildAuditWeeks("2026-09-29", "2026-10-05");
  assert.equal(crossMonth[0].rangeLabel, "Sep 29–Oct 5", "a cross-month week names both months");

  // ── weekIndexOf ──────────────────────────────────────────────────────────────────
  assert.equal(weekIndexOf(weeks, "2026-09-01"), 0);
  assert.equal(weekIndexOf(weeks, "2026-09-08"), 1);
  assert.equal(weekIndexOf(weeks, "2026-09-30"), 4);
  assert.equal(weekIndexOf(weeks, "2026-08-31"), -1, "a date outside every week is -1");

  // ── filterRowsByPeriod: honours the board's AM · PM · Pharmacies toggle ────────────
  const rows: DoubleVisitDbRow[] = [
    dbRow({ activity_date: "2026-09-02", period: "AM" }),
    dbRow({ activity_date: "2026-09-02", period: "PM" }),
    dbRow({ activity_date: "2026-09-03", period: "PM", speciality: "pharmacy" }),
  ];
  assert.equal(filterRowsByPeriod(rows, "ALL").length, 3, "ALL keeps every row");
  assert.equal(filterRowsByPeriod(rows, "AM").length, 1, "AM keeps only the AM doctor visit");
  assert.equal(filterRowsByPeriod(rows, "PM").length, 1, "PM excludes the pharmacy row");
  assert.equal(filterRowsByPeriod(rows, "Pharmacies").length, 1, "Pharmacies keeps only the pharmacy row");

  // ── buildDoubleVisitAuditWorkbook: Summary + one tab per coach, with the trail ─────
  const data: DoubleVisitAuditData = {
    dateFrom: "2026-09-01",
    dateTo: "2026-09-30",
    period: "ALL",
    role: "ALL",
    scopeLabel: "All lines and areas (company-wide)",
    generatedAt: "2026-10-05",
    weeks,
    coaches: [
      {
        hrId: "B-100",
        name: "Nosiba Sample",
        roleCode: "DSM",
        roleLabel: "District Manager",
        area: "North Cairo",
        line: "Anti Infective",
        status: "",
        totalDvs: 3,
        activeDays: 2,
        am: 1,
        pm: 2,
        pharmacies: 0,
        distinctMrs: 2,
        daysWithGps: 1,
        reps: [
          { name: "Ahmed Nabil", hrId: "B-200", status: "", totalDvs: 2, days: 2, weekly: [1, 1, 0, 0, 0] },
          { name: "Aml Mohamed", hrId: "B-15", status: "resigned", totalDvs: 1, days: 1, weekly: [0, 1, 0, 0, 0] },
        ],
        perDay: [
          {
            date: "2026-09-02",
            weekday: "Wed",
            weekLabel: "Sep 1–7",
            reps: 1,
            dvs: 2,
            am: 1,
            pm: 1,
            pharmacies: 0,
            firstCheckIn: "09:10",
            lastCheckIn: "15:40",
            fieldHours: 6.5,
          },
          {
            date: "2026-09-09",
            weekday: "Wed",
            weekLabel: "Sep 8–14",
            reps: 1,
            dvs: 1,
            am: 0,
            pm: 1,
            pharmacies: 0,
            firstCheckIn: null,
            lastCheckIn: null,
            fieldHours: null,
          },
        ],
        detail: [
          {
            date: "2026-09-02",
            weekday: "Wed",
            weekLabel: "Sep 1–7",
            repName: "Ahmed Nabil",
            repStatus: "",
            customer: "Dr. Sample Clinic",
            speciality: "GP",
            period: "AM",
            visitType: "Regular",
            // A Phoenix CRM chain visit: a second coach and the field set, shaped as a `full` reader
            // gets it. The vendor had neither, so these two fields prove the sheet gains them without
            // the figures above moving — this coach's totals are unchanged by their presence.
            partner2: "Mona Fathy",
            phoenixColumns: { "Visit kind": "Chain visit", Products: "Satoprazol", "Distance (m)": 42 },
          },
        ],
      },
    ],
    phoenixHeaders: ["Visit kind", "Products", "Distance (m)"],
  };

  const workbook = await buildDoubleVisitAuditWorkbook(data);
  const names = workbook.worksheets.map((sheet) => sheet.name);
  assert.ok(names.includes("Summary"), "there is a Summary tab");
  assert.equal(names.length, 2, "one coach yields Summary + one coach tab");

  const coachSheet = workbook.getWorksheet("Nosiba Sample");
  assert.ok(coachSheet, "the coach gets their own tab named after them");

  // The per-day section carries the field-hours span, and a GPS-less day reads blank, never 0.
  const cellValues = new Set<unknown>();
  coachSheet?.eachRow((row) => {
    row.eachCell((cell) => cellValues.add(cell.value));
  });
  assert.ok(cellValues.has(6.5), "a matched day shows its field-hours span");
  assert.ok(cellValues.has("—"), "a day with no GPS shows a blank marker, not 0");
  assert.ok(cellValues.has("resigned"), "a resigned rep is flagged in the per-rep table");

  // A specific-role filter is reflected in the Summary header.
  const roleFiltered = await buildDoubleVisitAuditWorkbook({ ...data, role: "DSM" });
  const summary = roleFiltered.getWorksheet("Summary");
  const summaryText: string[] = [];
  summary?.eachRow((row) => {
    const value = row.getCell(1).value;
    if (typeof value === "string") summaryText.push(value);
  });
  assert.ok(summaryText.some((line) => line.includes("Role filter: DSM")), "the Summary states the active role filter");

  // ── splitRangeByMonth: one section per calendar month, clamped to the range ─────────
  const q3 = splitRangeByMonth("2026-07-01", "2026-09-30");
  assert.deepEqual(
    q3.map((s) => `${s.label}|${s.from}|${s.to}`),
    ["Jul 2026|2026-07-01|2026-07-31", "Aug 2026|2026-08-01|2026-08-31", "Sep 2026|2026-09-01|2026-09-30"],
    "a quarter splits into three month sections",
  );
  const clamped = splitRangeByMonth("2026-07-15", "2026-08-10");
  assert.deepEqual(
    clamped.map((s) => `${s.from}|${s.to}`),
    ["2026-07-15|2026-07-31", "2026-08-01|2026-08-10"],
    "the first and last sections are clamped to the range",
  );
  assert.equal(splitRangeByMonth("2026-09-01", "2026-09-30").length, 1, "a single-month range is one section");
  assert.equal(splitRangeByMonth("2026-09-30", "2026-09-01").length, 0, "an inverted range is empty");

  // ── buildCombinedAuditWorkbook: one Summary + ONE tab per coach, months stacked inside ──
  const combined = await buildCombinedAuditWorkbook([
    { label: "Jul 2026", data: { ...data, dateFrom: "2026-07-01", dateTo: "2026-07-31" } },
    { label: "Sep 2026", data },
  ]);
  const combinedNames = combined.worksheets.map((sheet) => sheet.name);
  assert.ok(combinedNames.includes("Summary"), "the combined workbook has one Summary tab");
  assert.equal(combinedNames.length, 2, "the same coach across two months collapses to ONE coach tab");
  assert.ok(combinedNames.includes("Nosiba Sample"), "the coach tab is named after the coach, not the month");

  // The one coach tab stacks both months' sections, in calendar order.
  const coachTab = combined.getWorksheet("Nosiba Sample");
  const bandCells: string[] = [];
  coachTab?.eachRow((row) => {
    const value = row.getCell(1).value;
    if (typeof value === "string" && /^(Jul|Sep) 2026/.test(value)) bandCells.push(value.slice(0, 8));
  });
  assert.deepEqual(bandCells, ["Jul 2026", "Sep 2026"], "both months appear as stacked bands in the one coach tab, in order");

  // ── The check-in times read Phoenix CRM visits too (owner, 2026-10-31) ─────────────────────────────
  // A started team's rep records his visits in Phoenix CRM, so an iReports360-only read printed no
  // check-in time beside any of his double visits. The workbook is behind double_visit_analytics
  // export, which no rep holds, so it may ask (phoenix-team-starts.ts).
  const auditSource = readFileSync("src/lib/double-visit-analytics/audit-export.ts", "utf8");
  assert.match(
    auditSource,
    /queryCheckins<[^>]*>\(\{[^}]*includePhoenixVisits: true,[^}]*\}\)/,
    "the audit workbook's check-in read asks for the Phoenix CRM visits as well",
  );
}
