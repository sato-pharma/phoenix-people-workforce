import assert from "node:assert/strict";
import ExcelJS from "exceljs";

import { HOUSE_DOCUMENT_STANDARD, HOUSE_XLSX_COLORS } from "../src/lib/export/house-xlsx-palette.ts";
import { buildNsmDsmWorkbook } from "../src/lib/sales/weekly/nsm-dsm-workbook.ts";
import type { WeeklyManagerIndex } from "../src/lib/sales/weekly/manager-attribution.ts";
import type { WeeklyFactExportRow } from "../src/lib/sales/weekly/types.ts";

// THE WEEKLY NSM/DSM EXPORT IS EXEMPT FROM THE HOUSE DOCUMENT IDENTITY. Owner instruction,
// 2026-09-08: "the weekly sales NSM/DSM template changed to blue, I want the beige one." PR #3242
// had moved four weekly workbooks onto SATO-DIS-2026-01 v1.0 and PR #3303 had painted a Brand Blue
// header band on this one; the book he actually reads went white-and-blue as a result. It is back on
// the look it had before those two: Calibri, warm-grey (beige) header, group and total washes, an
// orange accent, and the warm heat marks on the total column.
//
// This test exists because that exemption is INVISIBLE in the code, and the same sweep will come
// round again. `house-identity.ts` says every company document wears the standard, and its ink rule
// forbids filled areas — so a session sweeping for documents not yet on the standard finds this file,
// finds three warm washes in it, and "finishes the job", reversing an owner decision while believing
// it is enforcing one. That is precisely what happened here, and to the automated payroll exports
// before it (`payroll-phoenix-look.test.ts`, the same shape). A red test is the only thing in the
// repository that argues back.
//
// THE SPLIT IS PER-EXPORT, NOT PER-MODULE. The other weekly workbooks — the analyst BI book and the
// batches book — stay on the house identity; only this one is exempt, because this is the one the
// field managers print. Do not read this test as licence to convert its siblings back.

/** The four brand blues. None may appear anywhere in this book, as fill or as type. */
const HOUSE_ONLY = [
  HOUSE_XLSX_COLORS.deep,
  HOUSE_XLSX_COLORS.blue,
  HOUSE_XLSX_COLORS.light,
  HOUSE_XLSX_COLORS.tint,
] as const;

// The beige look's own colours, re-typed here on purpose. The workbook holds them as module-private
// constants, so a test that imported them could not fail when they changed — it would assert that
// the file equals itself. These literals are the owner's decision written down independently.
const BEIGE_HEAD = "FFF3F1EE";
const BEIGE_HEAD_SOFT = "FFFAF8F5";
const BEIGE_TOTAL = "FFEBE8E3";
const BEIGE_ZEBRA = "FFF4F1EC";
const PHOENIX_ORANGE = "FFF97316";

const MANAGER_INDEX: WeeklyManagerIndex = {
  ceoName: "The CEO",
  dmByLineRegion: new Map(),
  nameByHrId: new Map(),
  operationalRegionByLineArea: new Map(),
  regionNameByCode: new Map([["GC", "Greater Cairo"]]),
  seatsById: new Map(),
};

function factRow(overrides: Partial<WeeklyFactExportRow> = {}): WeeklyFactExportRow {
  return {
    areaCode: "C11",
    batchId: "batch-1",
    branchCode: "BR1",
    branchName: "Cairo Depot",
    cycleMonth: "2026-08",
    distributorCode: "IS",
    distributorName: "Ibn Sina-Sato",
    family: "Tebofortin",
    line: "CNS",
    productCode: "TEB80",
    productName: "Tebofortin 80mg",
    regionCode: "GC",
    regionName: "Greater Cairo",
    salesUnits: 120,
    salesValue: 48_000,
    stockUnits: 15,
    weekNumber: 1,
    weekStart: "2026-08-02",
    ...overrides,
  };
}

/** Every colour and typeface the workbook actually paints, read back off the EMITTED file. */
function inkUsed(workbook: ExcelJS.Workbook) {
  const faces = new Set<string>();
  const fills = new Set<string>();
  const fontColours = new Set<string>();
  const text: string[] = [];
  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const fill = (cell.fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb;
        if (fill) fills.add(fill);
        if (cell.font?.color?.argb) fontColours.add(cell.font.color.argb);
        if (cell.font?.name) faces.add(cell.font.name);
        if (typeof cell.value === "string") text.push(cell.value);
      });
    });
  }
  return { faces, fills, fontColours, text };
}

export async function runWeeklyNsmDsmBeigeLookTests() {
  const rows: WeeklyFactExportRow[] = [
    factRow(),
    factRow({ productCode: "TEB120", productName: "Tebofortin 120mg", salesUnits: 80, salesValue: 36_000 }),
    factRow({ areaCode: "C12", branchName: "Giza Depot", salesUnits: 40, salesValue: 19_000, weekNumber: 2 }),
    factRow({ areaCode: null, branchName: "Chain Account", salesUnits: 25, salesValue: 11_500, weekNumber: 2 }),
  ];

  const buffer = await buildNsmDsmWorkbook({
    areaNames: new Map([["C11", "Cairo 1"], ["C12", "Giza 2"]]),
    areaSplit: null,
    generatedAt: "2026-09-08T09:00:00.000Z",
    lineFilter: ["CNS"],
    managerIndex: MANAGER_INDEX,
    periodLabel: "August 2026",
    productAxis: ["TEB80", "TEB120"],
    regionFilter: [],
    regionNames: new Map([["GC", "Greater Cairo"]]),
    rows,
  });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  // A positive control FIRST. Every assertion below is about what the book contains, and an empty
  // book satisfies "no house blue" perfectly — so prove there is a book to judge before judging it.
  assert.ok(
    workbook.worksheets.length > 1,
    "the fixture must produce a real tab set — an empty workbook would pass every colour check below",
  );

  const { faces, fills, fontColours, text } = inkUsed(workbook);

  // ── the beige look, not the house one ────────────────────────────────────────
  assert.deepEqual(
    [...faces],
    ["Calibri"],
    "the NSM/DSM book is set in Calibri, not the house typeface — it is exempt from the standard",
  );

  // The three warm washes the ink rule removed, and which the owner asked for back. These ARE filled
  // areas, deliberately: the ink rule does not reach this book.
  assert.ok(fills.has(BEIGE_HEAD), `the column header wash must be the warm grey ${BEIGE_HEAD}`);
  assert.ok(fills.has(BEIGE_HEAD_SOFT), `the group header wash must be the soft warm grey ${BEIGE_HEAD_SOFT}`);
  assert.ok(fills.has(BEIGE_TOTAL), `the total row wash must be the warm grey ${BEIGE_TOTAL}`);
  assert.ok(fills.has(BEIGE_ZEBRA), `the zebra row must be the warm ${BEIGE_ZEBRA}, not Brand Blue at 6%`);
  assert.ok(
    fontColours.has(PHOENIX_ORANGE),
    `the one accent is Phoenix orange ${PHOENIX_ORANGE} — the big date and the region values carry it`,
  );

  // ── and no house identity colour anywhere ────────────────────────────────────
  for (const colour of HOUSE_ONLY) {
    assert.ok(
      !fills.has(colour),
      `${colour} is a house identity colour and must not be filled anywhere in this book — a house ` +
        "colour creeping in is how the sweep starts converting it back",
    );
    assert.ok(
      !fontColours.has(colour),
      `${colour} is a house identity colour and must not be used as type in this book`,
    );
  }

  // The standard's reference is printed on every document that wears it, so its ABSENCE is the
  // cheapest single proof that this one does not. The masthead strip carries the app name instead.
  const joined = text.join(" | ");
  assert.ok(
    !joined.includes(HOUSE_DOCUMENT_STANDARD),
    `the masthead must not print ${HOUSE_DOCUMENT_STANDARD} — this book does not wear the standard`,
  );
  assert.match(
    joined,
    /PHOENIX/,
    "the masthead strip names the app, which is what stood there before the standard replaced it",
  );
}
