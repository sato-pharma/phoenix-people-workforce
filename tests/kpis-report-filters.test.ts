import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildKpiDoctorFacets,
  EMPTY_KPI_DOCTOR_FILTER,
  filterKpiDoctors,
  hasActiveKpiDoctorFilter,
  kpiDoctorFilterToParams,
  matchesKpiDoctorFilter,
  parseKpiDoctorFilter,
  type KpiDoctorFilter,
  type KpiDoctorFilterable,
} from "../src/lib/crm/kpis-doctor-filters.ts";
import {
  applyKpiFilters,
  buildKpisQuery,
  countActiveKpiFilters,
  EMPTY_KPI_FILTERS,
  hasActiveKpiFilters,
  kpiFiltersToParams,
  kpiRangeFromInputs,
  matchesKpiRanges,
  parseKpiFilters,
  type KpiFilterableRow,
  type KpiFilterState,
} from "../src/lib/crm/kpis-filters.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * "Make me able to filter by anything in any of the KPI reports" (owner, 2026-10-14).
 *
 * The Frequency, Coverage and Call Rate reports filter at two levels: the REPS on the board (a minimum and
 * a maximum on any number column, besides the facets, bands and flags that already existed) and the
 * DOCTORS inside the one rep whose list is open. Every block here fails as a plausible screen, not an error:
 *
 *   1. A RANGE NEVER SWALLOWS AN ABSENCE. A rep with no plan has no coverage; "coverage under 50%" must not
 *      list him as a 0% performer.
 *   2. BOUNDS ARE ON THE FIGURE AS PRINTED, so "90 and over" keeps the rep the table shows as 90%.
 *   3. THE URL carries every filter, drops the doctor ones where no doctor list exists, and an unreadable
 *      value is dropped rather than rendered as an empty board.
 *   4. THE DOCTOR FILTERS NARROW ROWS, NEVER THE ARITHMETIC. The tiles above the list add up to the rep's
 *      row; only the printed rows change.
 *   5. OPENING ANOTHER REP STARTS HIS LIST UNFILTERED.
 */

const read = (path: string) => readFileSync(path, "utf8");
const code = (path: string) => stripComments(read(path)).replace(/\r\n/g, "\n");

function repRow(overrides: Partial<KpiFilterableRow> = {}): KpiFilterableRow {
  return {
    repName: "Rep",
    lineName: "Pedia",
    regionName: "Cairo",
    areaName: "A1",
    managerName: "Manager",
    jobTitle: "Medical Rep",
    workingDays: 10,
    amRate: 2,
    pmRate: 10,
    amVerified: 20,
    pmVerified: 100,
    totalCalls: 120,
    campaignCalls: 0,
    campaignShare: 0,
    campaignOnlyDays: 0,
    hasCallRate: true,
    amAttainmentPct: 100,
    pmAttainmentPct: 100,
    pharmacyRate: null,
    pharmacyVerified: 0,
    pharmacyAttainmentPct: null,
    plannedDoctors: 100,
    visitedDoctors: 90,
    missedDoctors: 10,
    coveragePct: 90,
    meetsCoverageFloor: false,
    onPlanDoctors: 50,
    underDoctors: 30,
    overDoctors: 10,
    frequencyPct: 50,
    hasMeasurablePlan: true,
    ...overrides,
  };
}

function doctor(overrides: Partial<KpiDoctorFilterable> = {}): KpiDoctorFilterable {
  return {
    name: "Dr Hala",
    speciality: "Cardiology",
    grade: "A",
    visits: 2,
    lastVisitDate: "2026-09-10",
    due: true,
    frequency: { status: "exact" },
    ...overrides,
  };
}

const state = (overrides: Partial<KpiFilterState> = {}): KpiFilterState => ({ ...EMPTY_KPI_FILTERS, ...overrides });
const doctorFilter = (overrides: Partial<KpiDoctorFilter> = {}): KpiDoctorFilter => ({
  ...EMPTY_KPI_DOCTOR_FILTER,
  ...overrides,
});

// ── 1 + 2. Rep ranges ─────────────────────────────────────────────────────────────────────────────

export function runKpiRangeFilterTests() {
  const rows = [
    repRow({ repName: "High", coveragePct: 96, visitedDoctors: 96 }),
    repRow({ repName: "Mid", coveragePct: 60, visitedDoctors: 60 }),
    repRow({ repName: "Low", coveragePct: 20, visitedDoctors: 20 }),
    repRow({ repName: "NoPlan", coveragePct: 0, hasMeasurablePlan: false, plannedDoctors: 0, visitedDoctors: 0 }),
  ];
  const names = (filters: KpiFilterState) => applyKpiFilters(rows, filters).map((row) => row.repName);

  assert.deepEqual(names(state({ ranges: { coverage: { min: 50, max: 100 } } })).sort(), ["High", "Mid"]);
  assert.deepEqual(names(state({ ranges: { coverage: { min: null, max: 50 } } })), ["Low"]);
  // THE ABSENCE: a rep with no plan is not a 0% performer, so "under 50%" must not list him.
  assert.ok(!names(state({ ranges: { coverage: { min: null, max: 50 } } })).includes("NoPlan"));
  assert.ok(!names(state({ ranges: { coverage: { min: 0, max: null } } })).includes("NoPlan"));
  // Two ranges are AND-ed.
  assert.deepEqual(
    names(state({ ranges: { coverage: { min: 50, max: null }, visited: { min: 90, max: null } } })),
    ["High"],
  );

  // BOUNDS ARE ON THE PRINTED FIGURE: 89.96 prints as 90.0, so a "90 and over" bound keeps the rep.
  assert.equal(matchesKpiRanges(repRow({ coveragePct: 89.96 }), { coverage: { min: 90, max: null } }), true);
  assert.equal(matchesKpiRanges(repRow({ coveragePct: 89.94 }), { coverage: { min: 90, max: null } }), false);

  // The call columns. No call-rate row means no AM rate: absent, not zero.
  assert.equal(matchesKpiRanges(repRow({ amRate: null }), { am: { min: 0, max: 5 } }), false);
  assert.equal(matchesKpiRanges(repRow({ amRate: 1.5 }), { am: { min: 1, max: 2 } }), true);
  // Campaign share is a fraction on the row and a percentage on the bound.
  assert.equal(matchesKpiRanges(repRow({ campaignShare: 0.6, campaignCalls: 72 }), { campaign: { min: 50, max: null } }), true);
  assert.equal(matchesKpiRanges(repRow({ campaignShare: 0.2, campaignCalls: 24 }), { campaign: { min: 50, max: null } }), false);
  // Not reached is planned minus covered, whatever `missedDoctors` says.
  assert.equal(matchesKpiRanges(repRow({ plannedDoctors: 100, visitedDoctors: 70, missedDoctors: 0 }), { missed: { min: 30, max: 30 } }), true);

  // No bound, no filtering — and a range can only narrow.
  assert.equal(applyKpiFilters(rows, state({ ranges: {} })).length, rows.length);
  assert.ok(applyKpiFilters(rows, state({ ranges: { calls: { min: 0, max: 1000000 } } })).length <= rows.length);

  // The inputs a manager typed: blank is open, both blank is nothing, a minimum above the maximum swaps.
  assert.equal(kpiRangeFromInputs("", ""), null);
  assert.deepEqual(kpiRangeFromInputs("", "40"), { min: null, max: 40 });
  assert.deepEqual(kpiRangeFromInputs("80", "20"), { min: 20, max: 80 });
  assert.equal(kpiRangeFromInputs("abc", "-5"), null, "unreadable and negative bounds are dropped");

  // A range counts as ONE active filter and switches the filtered state on.
  const ranged = state({ ranges: { coverage: { min: 10, max: 20 }, calls: { min: null, max: 5 } } });
  assert.equal(countActiveKpiFilters(ranged), 2);
  assert.equal(hasActiveKpiFilters(ranged), true);
  assert.equal(hasActiveKpiFilters(EMPTY_KPI_FILTERS), false);
}

// ── 3. The URL ────────────────────────────────────────────────────────────────────────────────────

export function runKpiReportFilterUrlTests() {
  const full = state({
    lines: ["Pedia"],
    ranges: { coverage: { min: 50, max: 90 }, am: { min: 1.5, max: null }, calls: { min: null, max: 300 } },
    doctor: doctorFilter({
      query: "hala",
      specialities: ["Cardiology", "Internal Medicine, Diabetes"],
      grades: ["Grade A"],
      statuses: ["below", "not-visited"],
      seen: ["not-covered"],
      timing: ["late"],
      visitsMin: 1,
      visitsMax: 3,
      lastFrom: "2026-09-01",
      lastTo: "2026-09-20",
      sort: "last",
      direction: "desc",
    }),
  });

  // Round trip, including a speciality whose own name carries a comma.
  assert.deepEqual(parseKpiFilters(kpiFiltersToParams(full)), full, "every filter survives a serialise and parse");
  assert.deepEqual(kpiFiltersToParams(EMPTY_KPI_FILTERS), {}, "no filter, no parameters");
  assert.deepEqual(parseKpiFilters({}), EMPTY_KPI_FILTERS, "an empty address parses to the empty state");

  assert.equal(kpiFiltersToParams(full).r_coverage, "50..90");
  assert.equal(kpiFiltersToParams(full).r_am, "1.5..");
  assert.equal(kpiFiltersToParams(full).r_calls, "..300");

  // Unreadable values are DROPPED, never rendered as an empty board.
  const hostile = parseKpiFilters({
    r_coverage: "abc..def",
    r_am: "nonsense",
    r_zzz: "1..2",
    dstat: "not-a-status,below",
    dvmin: "-4",
    dfrom: "yesterday",
    dsort: "drop table",
  });
  assert.deepEqual(hostile.ranges, {});
  assert.deepEqual(hostile.doctor.statuses, ["below"]);
  assert.equal(hostile.doctor.visitsMin, null);
  assert.equal(hostile.doctor.lastFrom, "");
  assert.equal(hostile.doctor.sort, "default");
  // A reversed pair swaps rather than matching nobody.
  assert.deepEqual(parseKpiFilters({ r_coverage: "90..50" }).ranges.coverage, { min: 50, max: 90 });
  assert.deepEqual(
    [parseKpiDoctorFilter({ dvmin: "5", dvmax: "2" }).visitsMin, parseKpiDoctorFilter({ dvmin: "5", dvmax: "2" }).visitsMax],
    [2, 5],
  );

  // The doctor filters ride only where a doctor list is printed.
  const base = { month: "2026-09", period: "month", filters: full, rep: "hr:phx-900" } as const;
  for (const tab of ["coverage", "frequency"]) {
    const params = new URLSearchParams(buildKpisQuery({ ...base, tab }));
    assert.equal(params.get("dq"), "hala", `${tab} keeps the doctor search`);
    assert.equal(params.get("dstat"), "below,not-visited", `${tab} keeps the verdict filter`);
    assert.equal(params.get("r_coverage"), "50..90", `${tab} keeps the rep ranges`);
  }
  for (const tab of ["summary", "call-rate", "am-pm", "pharmacies", "weekly"]) {
    const params = new URLSearchParams(buildKpisQuery({ ...base, tab }));
    assert.equal(params.get("dq"), null, `${tab} has no doctor list, so no doctor search`);
    assert.equal(params.get("dsort"), null, `${tab} drops the doctor sort`);
    assert.equal(params.get("r_coverage"), "50..90", `${tab} still keeps the rep ranges`);
  }
  // A one-rep board opens his list with no `rep` in the address; his filters must still ride.
  const solo = new URLSearchParams(buildKpisQuery({ ...base, tab: "coverage", rep: null }));
  assert.equal(solo.get("dq"), "hala");
  assert.equal(solo.get("rep"), null);
}

// ── 4. The doctor filters ─────────────────────────────────────────────────────────────────────────

export function runKpiDoctorFilterTests() {
  const doctors: KpiDoctorFilterable[] = [
    doctor({ name: "Dr Hala", speciality: "Cardiology", grade: "A", visits: 3, lastVisitDate: "2026-09-20", frequency: { status: "exact" } }),
    doctor({ name: "Dr Omar", speciality: "Pediatrics", grade: "B", visits: 1, lastVisitDate: "2026-09-02", frequency: { status: "below" } }),
    doctor({ name: "Dr Sara", speciality: null, grade: null, visits: 0, lastVisitDate: null, due: true, frequency: { status: "not-visited" } }),
    doctor({ name: "Dr Nour", speciality: "Cardiology", grade: "C", visits: 0, lastVisitDate: null, due: false, frequency: { status: "not-due" } }),
    doctor({ name: null, speciality: "Pediatrics", grade: "A", visits: 2, lastVisitDate: "2026-09-11", frequency: { status: "above" } }),
  ];
  const names = (filter: KpiDoctorFilter) => filterKpiDoctors(doctors, filter).map((entry) => entry.name ?? "(unnamed)");

  assert.equal(hasActiveKpiDoctorFilter(EMPTY_KPI_DOCTOR_FILTER), false);
  assert.equal(filterKpiDoctors(doctors, EMPTY_KPI_DOCTOR_FILTER).length, doctors.length, "no filter keeps every doctor, in the report's order");
  assert.deepEqual(names(doctorFilter({ query: "hala" })), ["Dr Hala"]);
  assert.deepEqual(names(doctorFilter({ query: "CARDIO" })), ["Dr Hala", "Dr Nour"], "search reads speciality, case-insensitively");
  assert.deepEqual(names(doctorFilter({ specialities: ["Cardiology"] })), ["Dr Hala", "Dr Nour"]);
  assert.deepEqual(names(doctorFilter({ specialities: ["(none)"] })), ["Dr Sara"], "no speciality on the plan is a choice of its own");
  assert.deepEqual(names(doctorFilter({ grades: ["Grade A"] })), ["Dr Hala", "(unnamed)"]);
  assert.deepEqual(names(doctorFilter({ grades: ["No grade"] })), ["Dr Sara"]);
  assert.deepEqual(names(doctorFilter({ statuses: ["below", "above"] })), ["Dr Omar", "(unnamed)"], "choices inside one filter are OR-ed");
  assert.deepEqual(names(doctorFilter({ statuses: ["below"], grades: ["Grade A"] })), [], "different filters are AND-ed");
  assert.deepEqual(names(doctorFilter({ seen: ["covered"] })), ["Dr Hala", "Dr Omar", "(unnamed)"]);
  assert.deepEqual(names(doctorFilter({ seen: ["not-covered"] })), ["Dr Sara", "Dr Nour"]);
  assert.deepEqual(names(doctorFilter({ timing: ["late"] })), ["Dr Sara"], "late is an uncovered doctor whose day has passed");
  assert.deepEqual(names(doctorFilter({ timing: ["not-due"] })), ["Dr Nour"]);
  assert.deepEqual(names(doctorFilter({ visitsMin: 2 })), ["Dr Hala", "(unnamed)"]);
  assert.deepEqual(names(doctorFilter({ visitsMin: 1, visitsMax: 1 })), ["Dr Omar"]);
  // The last-visit window never lists a doctor who was not visited at all.
  assert.deepEqual(names(doctorFilter({ lastFrom: "2026-09-10" })), ["Dr Hala", "(unnamed)"]);
  assert.deepEqual(names(doctorFilter({ lastFrom: "2026-09-01", lastTo: "2026-09-05" })), ["Dr Omar"]);
  assert.equal(matchesKpiDoctorFilter(doctor({ frequency: undefined }), doctorFilter({ statuses: ["exact"] })), false, "no verdict, no match on a verdict");

  // Sorting parks the doctor with nothing to sort on LAST in both directions.
  assert.deepEqual(names(doctorFilter({ sort: "last", direction: "asc" })).slice(0, 3), ["Dr Omar", "(unnamed)", "Dr Hala"]);
  assert.deepEqual(names(doctorFilter({ sort: "last", direction: "desc" })).slice(0, 3), ["Dr Hala", "(unnamed)", "Dr Omar"]);
  assert.deepEqual(names(doctorFilter({ sort: "last", direction: "desc" })).slice(3).sort(), ["Dr Nour", "Dr Sara"]);
  assert.equal(names(doctorFilter({ sort: "name", direction: "asc" })).at(-1), "(unnamed)");
  assert.deepEqual(names(doctorFilter({ sort: "visits", direction: "desc" })).slice(0, 2), ["Dr Hala", "(unnamed)"]);

  // The options come from the WHOLE list and count it.
  const facets = buildKpiDoctorFacets(doctors);
  assert.deepEqual(
    facets.specialities.map((option) => [option.label, option.count]),
    [
      ["Cardiology", 2],
      ["Pediatrics", 2],
      ["No speciality on the plan", 1],
    ],
  );
  assert.deepEqual(facets.grades.map((option) => [option.value, option.count]), [["Grade A", 2], ["Grade B", 1], ["Grade C", 1], ["No grade", 1]]);
  assert.deepEqual(facets.seen.map((option) => option.count), [3, 2]);
  assert.deepEqual(facets.timing.map((option) => option.value), ["late", "not-due"]);
  assert.deepEqual(facets.statuses.map((option) => option.value), ["not-visited", "below", "above", "not-due", "exact"]);
  assert.deepEqual(parseKpiDoctorFilter(kpiDoctorFilterToParams(doctorFilter({ query: "x", sort: "visits", direction: "desc" }))), doctorFilter({ query: "x", sort: "visits", direction: "desc" }));
}

// ── 4 + 5. The view keeps its arithmetic on the whole list ────────────────────────────────────────

export function runKpiReportFilterWiringTests() {
  const view = code("src/components/crm/kpis-board-view.tsx");

  // The coverage summary and the frequency tiles describe the WHOLE list; only printed rows narrow.
  assert.match(view, /<CoverageSummary context=\{context\} detail=\{full\} \/>/, "the coverage summary reads the whole list");
  assert.match(view, /const detail = narrowDetail\(full, board\.filters\);/, "the coverage rows are the narrowed ones");
  assert.match(view, /const rows = frequencyRows\(detail\);/, "the frequency tiles are counted over every row");
  assert.match(view, /visible\.map\(\(\{ doctor, frequency \}\) =>/, "the frequency table prints the narrowed rows");
  assert.ok(!/\brows\.map\(\(\{ doctor, frequency \}\)/.test(view), "no frequency table prints the unfiltered rows");

  // Another rep's list opens unfiltered.
  assert.match(
    view,
    /rep !== context\.openRep\s*\?\s*\{ \.\.\.board\.filters, doctor: EMPTY_KPI_DOCTOR_FILTER \}/,
    "opening a different rep resets the doctor filters",
  );

  // The rep filter bar leads each report with its own columns and keeps every other one reachable.
  const bar = code("src/components/crm/kpis-filter-bar.tsx");
  assert.match(bar, /coverage: \["coverage", "planned", "visited", "missed"\]/);
  assert.match(bar, /"call-rate": \["am", "pm", "calls", "campaign", "workingdays"\]/);
  assert.match(bar, /More columns/, "the other range columns stay one click away");

  // The client bars take plain data only, keep their fields at 16px through cn(), and import nothing
  // server-side.
  const doctorBar = code("src/components/crm/kpis-doctor-filter-bar.tsx");
  assert.match(doctorBar, /^"use client";/);
  assert.ok(!/@\/lib\/crm\/kpis-board"/.test(doctorBar), "the doctor bar must not pull in the board module");
  assert.ok(!/\bsupabase\b/i.test(doctorBar));
  assert.match(doctorBar, /cn\(phxFieldClassName, "[^"]*\btext-base\b/, "fields stay at 16px");
  for (const file of ["src/lib/crm/kpis-doctor-filters.ts", "src/lib/crm/kpis-filters.ts"]) {
    const imports = [...code(file).matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((match) => match[1]);
    assert.ok(
      imports.every((path) => path === "@/lib/crm/kpis-doctor-filters"),
      `${file} must import nothing but its dependency-free sibling (found ${imports.join(", ") || "none"})`,
    );
  }
}
