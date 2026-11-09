import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stampKpiDoctorBricks, type KpiCoverageDoctor, type KpiRepRow } from "../src/lib/crm/kpis-board.ts";
import { buildKpiBrickRows, kpiBrickFrequencyColumns, type KpiBrickRow } from "../src/lib/crm/kpis-brick-table.ts";
import { KPI_DOCTOR_BRICK_NONE, KPI_DOCTOR_NOT_VALIDATED } from "../src/lib/crm/kpis-doctor-filters.ts";
import type { DoctorFrequencyStatus } from "../src/lib/crm/phoenix-kpi-rules.ts";
import { frequencyStatusOf } from "../src/lib/crm/rep-doctor-lists.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The four brick follow-ups on the KPIs board (owner, 2026-10-29): a brick view for managers across
 * all their reps, Brick on the Excel export, frequency by brick beside the coverage table, and a "not
 * validated yet" count on each rep's row.
 *
 * Every block here fails as a plausible screen, never as an error:
 *
 *   1. a brick table that double-drops or double-counts a doctor still prints tidy numbers — so its
 *      Planned must add up to the lists it was built from, and its frequency columns to its judged;
 *   2. a failed brick read that stamped "not validated" on every doctor would be a statement about a
 *      rep's work that nobody made — so a null read must stamp nothing, count nothing, build nothing;
 *   3. a just-started rep in the team table would put doctors nobody is judged on into the totals.
 */

type Doctor = Omit<KpiCoverageDoctor, "due">;

function doctor(id: number, overrides: Partial<Doctor> & { status?: DoctorFrequencyStatus } = {}): Doctor {
  const { status = "exact", ...rest } = overrides;
  return {
    contactCrmId: id,
    name: `Dr ${id}`,
    speciality: null,
    grade: "A",
    visits: 1,
    lastVisitDate: "2026-09-10",
    planDates: ["2026-09-03"],
    frequency: { basis: "plan", required: 2, dueSoFar: 2, actual: 1, status },
    ...rest,
  };
}

const at = (brick: string | null) => ({ brick, placeValidated: true });
const notValidated = { brick: null, placeValidated: false };

function repRow(repName: string, overrides: Partial<KpiRepRow> = {}): KpiRepRow {
  // Only the fields the stamp reads and writes; the rest of a real row is the board's business.
  return { repName, coverageRepKey: repName, justStarted: null, ...overrides } as unknown as KpiRepRow;
}

const view = (rows: KpiBrickRow[]) =>
  rows.map((row) => [row.label, row.reps, row.planned, row.covered, row.judged, row.onPlan, row.below, row.above, row.notVisited, row.ungraded]);

export function runKpiBrickTableTests() {
  // ── 1. The brick rows count every rep's list on its own ───────────────────────────────────────
  const repA: Doctor[] = [
    doctor(1, { ...at("Heliopolis"), visits: 2, status: "exact" }),
    doctor(2, { ...at("Heliopolis"), visits: 0, lastVisitDate: null, status: "not-visited" }),
    doctor(3, { ...at("Nasr City"), visits: 1, status: "below" }),
    doctor(4, { ...at(null), visits: 0, lastVisitDate: null, status: "not-visited" }),
    doctor(5, { ...notValidated, visits: 3, status: "above" }),
    doctor(6, { ...at("Heliopolis"), visits: 1, status: "not-due" }),
    doctor(7, { ...at("Heliopolis"), visits: 0, lastVisitDate: null, grade: null, status: "ungraded" }),
    // The read never landed for him: in NO brick, and never "not validated".
    doctor(8, { visits: 0, lastVisitDate: null, status: "not-visited" }),
  ];
  const repB: Doctor[] = [
    // The same doctor on a second rep's plan is a second planned doctor, as the team tiles count him.
    doctor(1, { ...at("Heliopolis"), visits: 0, lastVisitDate: null, status: "not-visited" }),
    doctor(9, { ...at("  HELIOPOLIS "), visits: 1, status: "exact" }),
    doctor(10, { ...at("Maadi"), visits: 1, status: "at-norm" }),
  ];
  const rows = buildKpiBrickRows([repA, repB]);
  assert.deepEqual(
    view(rows),
    [
      // label, reps, planned, covered, judged, onPlan, below, above, notVisited, ungraded
      ["Heliopolis", 2, 6, 3, 4, 2, 0, 0, 2, 1],
      ["Maadi", 1, 1, 1, 1, 1, 0, 0, 0, 0],
      ["Nasr City", 1, 1, 1, 1, 0, 1, 0, 0, 0],
      ["Validated · no brick on record", 1, 1, 0, 1, 0, 0, 0, 1, 0],
      ["Not validated yet", 1, 1, 1, 1, 0, 0, 1, 0, 0],
    ],
    "biggest brick first, then A to Z, a brick matching whatever its case and spacing, the validated-with-no-brick line second to last and Not validated yet last",
  );
  assert.deepEqual(
    rows.map((row) => row.brick),
    ["Heliopolis", "Maadi", "Nasr City", KPI_DOCTOR_BRICK_NONE, KPI_DOCTOR_NOT_VALIDATED],
    "each row carries the Brick filter's own value, so it can link to its doctors",
  );
  for (const row of rows) {
    assert.equal(row.onPlan + row.below + row.above + row.notVisited, row.judged, `${row.label}: the frequency verdicts add up to the doctors judged`);
    assert.ok(row.covered <= row.planned, `${row.label}: never more covered than planned`);
  }
  const stamped = [...repA, ...repB].filter((entry) => entry.placeValidated !== undefined).length;
  assert.equal(
    rows.reduce((sum, row) => sum + row.planned, 0),
    stamped,
    "Planned over every brick is every stamped doctor on every list — nobody dropped, nobody twice",
  );
  assert.deepEqual(buildKpiBrickRows([[doctor(8)], []]), [], "a list whose bricks were never read builds no table at all");

  // ── 2. The frequency columns are the board's own words, and add up to the rep row's ─────────────
  const legacy = kpiBrickFrequencyColumns(false);
  assert.deepEqual(legacy.map((column) => column.label), ["Exact", "Below", "Above"], "the owner's own vocabulary, never On plan or Over plan");
  const phoenix = kpiBrickFrequencyColumns(true);
  assert.deepEqual(phoenix.map((column) => column.label), ["At norm", "Below norm", "No grade"]);
  const heliopolis = rows[0];
  assert.deepEqual(legacy.map((column) => column.count(heliopolis)), [2, 0, 0], "Heliopolis's two never-seen doctors are in no legacy column");
  assert.equal(
    legacy.reduce((sum, column) => sum + column.count(heliopolis), 0) + heliopolis.notVisited,
    heliopolis.judged,
    "the three legacy columns and the never seen add up to the doctors judged",
  );
  // The Frequency tile's Below on the plan rules is `underDoctors`: seen, but fewer times than due. A
  // doctor never seen is "missed" there, never "under" — owner, 2026-10-29: "make the brick table's
  // Below match the Frequency tile".
  assert.equal(frequencyStatusOf({ actual: 1, plannedCalls: 2, plannedToDate: 2 }), "under");
  assert.equal(frequencyStatusOf({ actual: 0, plannedCalls: 2, plannedToDate: 2 }), "missed");
  assert.equal(
    rows.reduce((sum, row) => sum + legacy[1].count(row), 0),
    [...repA, ...repB].filter((entry) => entry.placeValidated !== undefined && entry.frequency?.status === "below").length,
    "the legacy Below over every brick is the tile's Below — the doctors seen too few times, never the never seen",
  );
  assert.equal(
    rows.reduce((sum, row) => sum + phoenix[1].count(row), 0),
    rows.reduce((sum, row) => sum + row.below + row.notVisited, 0),
    "the Phoenix Below norm keeps the never seen, as the Phoenix tile's frequency.below does",
  );
  assert.deepEqual(phoenix.map((column) => column.count(heliopolis)), [2, 2, 1]);
  assert.deepEqual(legacy[1].statuses, ["below"], "a Below count links to the one verdict it counts");
  assert.deepEqual(phoenix[1].statuses, ["below", "not-visited"], "a Below norm count links to the same two verdicts it counts");
  assert.deepEqual(phoenix[0].statuses, ["exact", "at-norm"]);

  // ── 3. One read stamps every list; a failed read stamps nothing ────────────────────────────────
  const one = repRow("Rep One");
  const fresh = repRow("Rep New", { justStarted: { workingDaysIn: 2 } });
  const bricks = new Map<number, string | null>([
    [1, "Heliopolis"],
    [2, null],
    [4, "Maadi"],
  ]);
  const landed = stampKpiDoctorBricks(
    [
      { row: one, doctors: [doctor(1), doctor(2), doctor(3)] },
      { row: fresh, doctors: [doctor(4), doctor(5)] },
    ],
    bricks,
  );
  assert.deepEqual(
    landed.doctorsOf.get(one)?.map((entry) => [entry.contactCrmId, entry.brick, entry.placeValidated]),
    [
      [1, "Heliopolis", true],
      [2, null, true],
      [3, null, false],
    ],
    "a doctor in the read is validated (with or without a brick); a doctor missing from it is not",
  );
  assert.equal(one.notValidatedDoctors, 1, "the rep's row counts the doctors missing from the read");
  assert.equal(fresh.notValidatedDoctors, undefined, "a rep who has just started is judged on nothing, so he gets no count");
  assert.deepEqual(
    landed.doctorsOf.get(fresh)?.map((entry) => entry.brick),
    ["Maadi", null],
    "his own list still carries its bricks, so it still filters by brick",
  );
  assert.deepEqual(
    landed.teamBricks?.map((row) => [row.label, row.planned]),
    [
      ["Heliopolis", 1],
      ["Validated · no brick on record", 1],
      ["Not validated yet", 1],
    ],
    "the team table leaves the just-started rep out — no Maadi — as the team tiles leave him out",
  );

  const failedRow = repRow("Rep One");
  const list = [doctor(1), doctor(2)];
  const failed = stampKpiDoctorBricks([{ row: failedRow, doctors: list }], null);
  assert.equal(failed.doctorsOf.get(failedRow), list, "a failed read hands the list back unstamped");
  assert.ok(list.every((entry) => entry.placeValidated === undefined && entry.brick === undefined), "and no doctor is called not validated");
  assert.equal(failedRow.notValidatedDoctors, undefined, "no count is printed on a read that never landed — never a 0");
  assert.equal(failed.teamBricks, null, "and there is no team table");

  const noneRow = repRow("Rep One");
  const none = stampKpiDoctorBricks([{ row: noneRow, doctors: [doctor(1), doctor(2)] }], new Map());
  assert.equal(noneRow.notValidatedDoctors, 2, "a read that landed with no validated doctor on the list is a real count of 2");
  assert.deepEqual(none.teamBricks?.map((row) => [row.label, row.planned]), [["Not validated yet", 2]]);
}

// ── 4. The wiring: one read, the open rep reuses it, both tabs get it, and so does the file ─────────

const code = (path: string) => stripComments(readFileSync(path, "utf8"));

export function runKpiBrickWiringTests() {
  const board = code("src/lib/crm/kpis-board.ts");
  assert.equal(board.match(/\bloadKpiDoctorBricks\(/g)?.length, 1, "the board reads the bricks once, over every rep's list");
  assert.match(
    board,
    /loadKpiDoctorBricks\(repLists\.flatMap\(\(\{ doctors \}\) => doctors\.map\(\(doctor\) => doctor\.contactCrmId\)\)\)/,
    "and that one read covers every list on screen",
  );
  assert.match(board, /const \{ doctorsOf, teamBricks \} = stampKpiDoctorBricks\(repLists, doctorBricks\);/);
  assert.match(
    board,
    /const coverageDoctors = coverageRep \? \(doctorsOf\.get\(coverageRep\) \?\? null\) : null;/,
    "the open rep's list is the one already stamped, never read a second time",
  );
  assert.match(board, /^\s+teamBricks,$/m, "the team table rides on the board");

  const bricks = code("src/lib/crm/kpis-doctor-bricks.ts");
  assert.match(
    bricks,
    /if \(ids\.length > WHOLE_READ_FROM\) \{[\s\S]*?return chooseWantedKpiDoctorBricks\(ids, customers, places\);/,
    "the whole read goes through the narrowing pinned by behaviour in tests/kpis-doctor-bricks.test.ts",
  );

  assert.match(
    code("app/(admin)/admin/kpis/page.tsx"),
    /coverageDoctors: tab === "coverage" \|\| tab === "frequency" \? \{ rep: one\(params\?\.rep\) \?\? null \} : null/,
    "the admin Frequency tab carries the lists too, or frequency by brick and the count never reach it",
  );

  const route = code("app/api/crm/kpis-export/route.ts");
  assert.match(route, /const doctorsTab = tab === "coverage" \|\| tab === "frequency";/);
  assert.match(
    route,
    /coverageDoctors: doctorsTab \? \{ rep: searchParams\.get\("rep"\) \|\| null \} : null/,
    "the export asks for the doctor lists only from the Coverage and Frequency tabs",
  );
  assert.match(route, /buildKpisBoardWorkbook\(board, new Date\(\)\.toISOString\(\), \{\s*doctorLists: doctorsTab,/);
  assert.match(
    route,
    /report: tab === "frequency" \? "frequency" : tab === "coverage" \? "coverage" : undefined,/,
    "the export names its report, so the Frequency file's Teams and Doctors sheets speak frequency",
  );
  assert.match(route, /await getKpisBoard\(\{[\s\S]*?access,/, "through the same getKpisBoard and its scope gate");

  const screen = code("src/components/crm/kpis-board-view.tsx");
  assert.match(
    screen,
    /function kpisExportHref\([\s\S]*?tab: doctorsTab \? tab : "summary",[\s\S]*?rep: doctorsTab \? context\.openRep : null,/,
    "the export link carries the tab and the open rep, so the file holds what the screen holds",
  );
  assert.match(screen, /<BrickBreakdown context=\{context\} rows=\{buildKpiBrickRows\(\[all\]\)\}/, "the coverage By brick counts the whole list");
  assert.match(
    screen,
    /<BrickBreakdown[\s\S]{0,80}rows=\{buildKpiBrickRows\(\[\[\.\.\.detail\.covered, \.\.\.detail\.notCovered\]\]\)\}/,
    "the frequency By brick counts the whole list too, never the filtered rows",
  );
  assert.match(screen, /<TeamBricksSection context=\{context\} rows=\{board\.teamBricks\} \/>/, "the team table is on the board");
  assert.match(
    screen,
    /bricks: \[KPI_DOCTOR_NOT_VALIDATED\]/,
    "the not-validated count opens the rep's list narrowed to exactly those doctors",
  );

  // The brick table is shared by the screen and the file, so it must stay importable by both.
  const imports = [...code("src/lib/crm/kpis-brick-table.ts").matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((match) => match[1]);
  assert.deepEqual(
    imports.sort(),
    ["@/lib/crm/kpis-doctor-filters", "@/lib/crm/phoenix-kpi-rules", "@/lib/crm/reps-list-activity"],
    "the brick table imports only the dependency-free filters, a type and the board's own words",
  );
  assert.match(code("src/lib/crm/kpis-brick-table.ts"), /^import type \{ DoctorFrequencyStatus \} from "@\/lib\/crm\/phoenix-kpi-rules";$/m);
}
