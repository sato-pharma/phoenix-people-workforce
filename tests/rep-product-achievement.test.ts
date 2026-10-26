import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { isRolePermissionWithinHardBoundary, permissionMatrix, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import type { AchievementRow } from "../src/lib/sales/monthly-targets.ts";
import { rankingHrKey } from "../src/lib/sales/rankings.ts";
import {
  DEFAULT_REP_ACHIEVEMENT_FILTERS,
  REP_ACHIEVEMENT_ALL,
  describeAchievementCell,
  filterRepAchievement,
  parseRepAchievementFilters,
  repAchievementQuery,
  semesterColumns,
  sortRepAchievement,
  type RepAchievementData,
} from "../src/lib/sales/rep-product-achievement.ts";
import { buildRepAchievementRecords, type RepAchievementPerson } from "../src/lib/sales/rep-product-achievement-build.ts";
import { buildRepAchievementWorkbook } from "../src/lib/sales/rep-product-achievement-workbook.ts";

// Rep Achievement by Product (owner, 2026-10-26): the Training Manager filters by line and reads each
// rep's achievement % per product — Jul, Aug, Sep, Q3, Oct, Nov, Dec, Q4, S2 — and exports it.

function row(partial: Partial<AchievementRow> & Pick<AchievementRow, "period" | "productCode">): AchievementRow {
  return {
    achievementUnits: null,
    achievementValue: null,
    actualUnits: 0,
    actualValue: 0,
    areaCode: "A1",
    areaState: null,
    dmHrId: null,
    dmSeatId: null,
    hasActual: true,
    hasTarget: partial.targetValue != null,
    isOther: false,
    lineCode: "cns",
    regionCode: "R1",
    repHrId: "REP-1",
    repSeatId: "S1",
    targetUnits: null,
    targetValue: null,
    ...partial,
  };
}

// Keyed as the server keys them — `rankingHrKey`, the leaderboards' own normaliser.
const people = new Map<string, RepAchievementPerson>([
  [rankingHrKey("REP-1"), { areaName: "Nasr City", jobTitle: "Medical Rep", left: false, managerName: "Mona Adel", name: "Ahmed Samir", regionName: "Cairo" }],
  [rankingHrKey("REP-2"), { areaName: "Smouha", jobTitle: "Medical Rep", left: true, managerName: "Karim Fawzy", name: "Basma Nabil", regionName: "Alexandria" }],
  [rankingHrKey("REP-3"), { areaName: "Mansoura", jobTitle: "Medical Rep", left: false, managerName: "Mona Adel", name: "Cherif Hany", regionName: "Delta" }],
]);
const productNames = new Map([
  ["GAU", "Gaumycin"],
  ["NEU", "Neurovit"],
]);
const lineNames = new Map([
  ["cns", "CNS"],
  ["pedia", "Pedia"],
]);

export async function runRepProductAchievementTests() {
  // ── Her column order, word for word ────────────────────────────────────────
  const columns = semesterColumns("2026-S2");
  assert.deepEqual(
    columns.map((column) => column.label),
    ["Jul", "Aug", "Sep", "Q3", "Oct", "Nov", "Dec", "Q4", "S2"],
    "each quarter straight after its three months, the semester last",
  );
  assert.deepEqual(columns[3].months, ["2026-07", "2026-08", "2026-09"]);
  assert.equal(columns[8].months.length, 6);
  assert.deepEqual(semesterColumns("2026-S1").map((column) => column.label).slice(0, 4), ["Jan", "Feb", "Mar", "Q1"]);

  // ── The arithmetic ─────────────────────────────────────────────────────────
  // CNS published July to September; October has started but is not published; November not started.
  const publishedKeys = new Set(["cns|2026-07", "cns|2026-08", "cns|2026-09", "pedia|2026-07"]);
  const rows: AchievementRow[] = [
    // Gaumycin: 70% in July on a big target, 80% in August, 150% in September on a small one.
    row({ actualUnits: 70, actualValue: 7_000, period: "2026-07", productCode: "GAU", targetUnits: 100, targetValue: 10_000 }),
    row({ actualUnits: 80, actualValue: 8_000, period: "2026-08", productCode: "GAU", targetUnits: 100, targetValue: 10_000 }),
    row({ actualUnits: 15, actualValue: 1_500, period: "2026-09", productCode: "GAU", targetUnits: 10, targetValue: 1_000 }),
    // Neurovit: sold in July, no target — never a 0%.
    row({ actualUnits: 900, actualValue: 2_000, period: "2026-07", productCode: "NEU" }),
    // October is unpublished: its sales must not reach any column.
    row({ actualUnits: 999, actualValue: 99_999, period: "2026-10", productCode: "GAU", targetValue: 1 }),
    // A left rep on the same line.
    row({ actualValue: 500, period: "2026-07", productCode: "GAU", repHrId: "REP-2", targetValue: 1_000 }),
    // A rep with no target at all, and an area row with no rep (never a rep's).
    row({ actualValue: 300, period: "2026-07", productCode: "GAU", repHrId: "REP-3" }),
    row({ actualValue: 50_000, period: "2026-07", productCode: "GAU", repHrId: null, targetValue: 50_000 }),
  ];
  const records = buildRepAchievementRecords({
    columns,
    currentPeriod: "2026-10",
    lineNames,
    people,
    productNames,
    publishedKeys,
    rows,
  });
  assert.equal(records.length, 3, "one record per rep per line; a row with no rep is the area's");

  const ahmed = records.find((record) => record.name === "Ahmed Samir")!;
  const gau = ahmed.products.find((product) => product.productCode === "GAU")!;
  assert.equal(gau.productName, "Gaumycin");
  assert.equal(gau.cells[0].value, 0.7, "July: 7,000 ÷ 10,000");
  assert.equal(gau.cells[1].value, 0.8, "August");
  assert.equal(gau.cells[2].value, 1.5, "September");
  assert.equal(
    gau.cells[3].value,
    16_500 / 21_000,
    "Q3 is the quarter's sales over its target, divided ONCE — never the mean of 70, 80 and 150",
  );
  assert.notEqual(gau.cells[3].value, (0.7 + 0.8 + 1.5) / 3);
  assert.equal(gau.cells[3].partial, false, "Q3's three months are all published");
  assert.equal(gau.cells[4].state, "unpublished", "October has started and is not published");
  assert.equal(gau.cells[4].value, null, "an unpublished month is never 0%");
  assert.equal(describeAchievementCell(gau.cells[4]).short, "Not published");
  assert.equal(gau.cells[5].state, "upcoming", "November has not started");
  assert.equal(gau.cells[7].state, "unpublished", "Q4 has one started month and it is unpublished");
  assert.equal(gau.cells[8].value, 16_500 / 21_000, "S2 to date reads the published months only — October's 99,999 never lands");
  assert.equal(gau.cells[8].partial, true, "S2 is graded to date");
  assert.equal(describeAchievementCell(gau.cells[8]).long, "79% to date");

  const neu = ahmed.products.find((product) => product.productCode === "NEU")!;
  assert.equal(neu.cells[0].state, "no-target", "sold with no target reads No target");
  assert.equal(neu.cells[0].value, null);
  assert.equal(neu.cells[1].state, "none", "no sale and no target that month");

  // All products together are added by VALUE — the units (70 + 900) are never added anywhere.
  assert.equal(ahmed.overall[0].value, (7_000 + 2_000) / 10_000, "July overall: every pound counts, by value");
  assert.equal(ahmed.overall[3].value, (16_500 + 2_000) / 21_000);
  const builder = readFileSync("src/lib/sales/rep-product-achievement-build.ts", "utf8");
  assert.equal(/actualUnits|targetUnits/.test(builder), false, "the arithmetic never reads a unit");

  const basma = records.find((record) => record.name === "Basma Nabil")!;
  assert.equal(basma.left, true);
  assert.equal(basma.overall[0].value, 0.5);
  const cherif = records.find((record) => record.name === "Cherif Hany")!;
  assert.equal(cherif.overall[0].state, "no-target");

  // ── Filters ────────────────────────────────────────────────────────────────
  const all = { ...DEFAULT_REP_ACHIEVEMENT_FILTERS };
  assert.equal(filterRepAchievement(records, { ...all, line: "pedia" }).length, 0, "the line filter");
  assert.equal(filterRepAchievement(records, { ...all, line: "cns" }).length, 3);
  assert.deepEqual(
    filterRepAchievement(records, { ...all, status: "active" }).map((record) => record.name),
    ["Ahmed Samir", "Cherif Hany"],
  );
  assert.deepEqual(filterRepAchievement(records, { ...all, manager: "Mona Adel" }).map((record) => record.name), ["Ahmed Samir", "Cherif Hany"]);
  const onlyNeu = filterRepAchievement(records, { ...all, product: "NEU" });
  assert.deepEqual(onlyNeu.map((record) => record.name), ["Ahmed Samir"], "a rep who never carried the product drops out");
  assert.deepEqual(onlyNeu[0].products.map((product) => product.productCode), ["NEU"]);
  assert.equal(filterRepAchievement(records, { ...all, search: "smouha" })[0].name, "Basma Nabil");

  const filters = { ...all, line: "cns", product: "GAU", search: "ahmed", status: "active" as const };
  assert.deepEqual(
    parseRepAchievementFilters(new URLSearchParams(repAchievementQuery("2026-S2", filters))),
    filters,
    "the export link carries exactly what the page shows",
  );

  // ── Sort: a cell with no percentage sinks, both ways ───────────────────────
  for (const direction of ["asc", "desc"] as const) {
    const sorted = sortRepAchievement(records, REP_ACHIEVEMENT_ALL, { column: 0, direction });
    assert.equal(sorted[sorted.length - 1].name, "Cherif Hany", `No target is never ranked as the worst (${direction})`);
  }
  assert.deepEqual(
    sortRepAchievement(records, REP_ACHIEVEMENT_ALL, { column: 0, direction: "desc" }).map((record) => record.name),
    ["Ahmed Samir", "Basma Nabil", "Cherif Hany"],
  );

  // ── The workbook she downloads (the emitted file, not the source) ──────────
  const data: RepAchievementData = {
    columns,
    currentPeriod: "2026-10",
    generatedAt: "2026-10-26T10:00:00.000Z",
    lines: [{ label: "CNS", value: "cns" }, { label: "Pedia", value: "pedia" }],
    publishedMonths: { cns: ["2026-07", "2026-08", "2026-09"], pedia: ["2026-07"] },
    records,
    semester: "2026-S2",
    semesters: [{ label: "S2 2026", value: "2026-S2" }],
  };
  const workbook = await buildRepAchievementWorkbook({ activeFilters: { Line: "CNS" }, data, records });
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["By rep and product", "Rep overall", "How to read"]);
  const detail = workbook.getWorksheet("By rep and product")!;
  let headerRow = 0;
  detail.eachRow((sheetRow, number) => {
    if (!headerRow && sheetRow.getCell(1).value === "Rep" && sheetRow.getCell(6).value === "Product") headerRow = number;
  });
  assert.ok(headerRow > 0, "the detail sheet has its header row");
  const heads = Array.from({ length: 9 }, (_, index) => detail.getRow(headerRow).getCell(7 + index).value);
  assert.deepEqual(heads, [
    "July 2026", "August 2026", "September 2026", "Q3 2026",
    "October 2026", "November 2026", "December 2026", "Q4 2026 to date", "S2 2026 to date",
  ]);
  let gaumycinRow = 0;
  detail.eachRow((sheetRow, number) => {
    if (sheetRow.getCell(1).value === "Ahmed Samir" && sheetRow.getCell(6).value === "Gaumycin") gaumycinRow = number;
  });
  const july = detail.getRow(gaumycinRow).getCell(7);
  assert.equal(july.value, 0.7, "a percentage is stored as its ratio");
  assert.equal(july.numFmt, "0.0%");
  assert.equal(detail.getRow(gaumycinRow).getCell(11).value, "Not published", "never a 0 in the file either");
  assert.equal(detail.getRow(gaumycinRow - 1).getCell(6).value, "All products", "the rep's overall row leads his products");

  // ── Who reaches it ─────────────────────────────────────────────────────────
  const allowed: PhoenixRole[] = ["Super Admin", "Training Manager"];
  for (const role of Object.keys(permissionMatrix) as PhoenixRole[]) {
    const granted = permissionMatrix[role].rep_product_achievement ?? [];
    if (allowed.includes(role)) {
      assert.deepEqual([...granted].sort(), ["export", "read"], `${role} reads and exports`);
      assert.equal(isRolePermissionWithinHardBoundary(role, "rep_product_achievement", "read"), true);
      assert.equal(isRolePermissionWithinHardBoundary(role, "rep_product_achievement", "update"), false, "nothing to write");
    } else {
      assert.equal(granted.length, 0, `${role} holds nothing on Rep Achievement`);
      assert.equal(
        isRolePermissionWithinHardBoundary(role, "rep_product_achievement", "read"),
        false,
        `${role} is capped out at the hard boundary, whatever an override says`,
      );
    }
  }

  const route = readFileSync("app/api/employee-portals/rep-achievement/export/route.ts", "utf8");
  assert.match(route, /assertPermission\(access, "rep_product_achievement", "export"\)/, "the export route enforces the gate");
  assert.ok(
    route.indexOf("assertPermission") < route.indexOf("loadRepProductAchievement("),
    "the gate runs before any read",
  );
  const page = readFileSync("app/employee-portals/training-manager/rep-achievement/page.tsx", "utf8");
  assert.match(page, /"rep_product_achievement", "read"/, "the page checks read on the server");
}
