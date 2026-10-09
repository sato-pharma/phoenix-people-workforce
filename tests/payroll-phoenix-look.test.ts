import assert from "node:assert/strict";
import ExcelJS from "exceljs";

import {
  buildFullSheetWorkbook,
  buildPart1SheetWorkbook,
  sheetStateLabel,
} from "../src/lib/automated-payroll/exports/sheet.ts";
import type { AssembledRow } from "../src/lib/automated-payroll/assemble.ts";
import type { MonthlySalaryRun } from "../src/lib/automated-payroll/types.ts";
import { HOUSE_XLSX_COLORS } from "../src/lib/export/house-xlsx-palette.ts";
import { BLACK, ZEBRA } from "../src/lib/sales/sales-workbook-kit.ts";

// THE AUTOMATED PAYROLL EXPORTS ARE EXEMPT FROM THE HOUSE DOCUMENT IDENTITY. Owner instruction,
// 2026-09-08: he exported the July full sheet, got the white-and-blue SATO sheet that PR #3177 had
// shipped three days earlier, attached his own 8 August export and said he wants that one. So these
// sheets went back to the Phoenix look — Calibri, black header bands, orange accents, and the
// coloured held / execution / up / down fills — the same way the offer letter is exempt.
//
// This test exists because that exemption is invisible in the code. `house-identity.ts` says every
// company document wears SATO-DIS-2026-01, and its ink rule forbids filled areas; a session sweeping
// for documents that have not been brought onto the standard will find these files, find filled
// black bands in them, and "finish the job" — reversing an owner decision while believing it is
// enforcing one. A red test is the only thing in the repository that argues back.
//
// The one thing the house rebuild added that is NOT a colour is kept: the held row's note. A held
// row is dropped at publish with no salary_record written, and the Phoenix look carries "held" as a
// red fill — which greyscale, a copied range and a colour-blind reader all lose. The note costs the
// sheet nothing visually and says in words what the fill only implies.

const run: MonthlySalaryRun = {
  createdAt: "", createdBy: null, id: "run-1", month: 7, monthKey: "2026-07",
  part1ConfirmedAt: null, part1ConfirmedBy: null, part2ConfirmedAt: null, part2ConfirmedBy: null,
  phase: "part1", publishedAt: null, publishedBatchId: null, publishedBy: null,
  updatedAt: "", year: 2026,
};

const HELD_HR_ID = "B-7";

/** Every house-identity colour, which must appear nowhere in these workbooks. */
const HOUSE_ONLY = [
  HOUSE_XLSX_COLORS.deep,
  HOUSE_XLSX_COLORS.blue,
  HOUSE_XLSX_COLORS.light,
  HOUSE_XLSX_COLORS.tint,
] as const;

function assembled(hrId: string, fullName: string, onHold = false): AssembledRow {
  return {
    bankAccount: "EG1", bankName: "CIB", carriedForwardApplied: 0, compact: hrId.toLowerCase(),
    lifecycle: "regular", onHold, overpaidResidual: 0,
    row: {
      area: "Cairo", baseSalary: 12000, bonus: 0, calendarDays: 31, crm: 0, employmentIncomeTax: 640,
      expenses: 0, extraCostOfLiving: 500, fingerPrint: 0, firstPart: 6000, fuelAllowance: 800,
      fullName, governmentalDeductions: 1140, grossSalary: 13140, hireDate: "2022-06-01", hrId,
      incentive: 0, jobTitle: "Medical Rep", line: "CNS", loans: 0, medicalInsurance: 0,
      monthSalary: 12000, nameAr: null, netSalary: 13300, otherAdditions: 0, otherDeductions: 0,
      overtime: 0, paymentMode: "two_parts", payrollComment: null, row: 1, secondPart: 6000,
      socialInsurance: 500, totalAdditions: 1300, totalDeductions: 1140, unpaidVacations: 0,
      workingDays: 26,
    },
  } as AssembledRow;
}

async function load(buffer: ArrayBuffer | Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  return workbook;
}

/** Every colour and typeface the workbook actually paints, read back off the emitted file. */
function inkUsed(workbook: ExcelJS.Workbook) {
  const fills = new Set<string>();
  const fontColours = new Set<string>();
  const faces = new Set<string>();
  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const fill = (cell.fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb;
        if (fill) fills.add(fill);
        if (cell.font?.color?.argb) fontColours.add(cell.font.color.argb);
        if (cell.font?.name) faces.add(cell.font.name);
      });
    });
  }
  return { faces, fills, fontColours };
}

export async function runPayrollPhoenixLookTests() {
  const rows = [
    assembled("A-1", "Paid Person"),
    assembled(HELD_HR_ID, "Held Person Example", true),
    assembled("C-3", "Another Paid Person"),
  ];

  for (const [variant, buffer] of [
    ["full", await buildFullSheetWorkbook({ run, rows })],
    ["part1", await buildPart1SheetWorkbook({ run, rows })],
  ] as const) {
    const workbook = await load(buffer as Buffer);
    const { faces, fills, fontColours } = inkUsed(workbook);

    // ── the Phoenix look, not the house one ─────────────────────────────────────
    assert.deepEqual(
      [...faces],
      ["Calibri"],
      `${variant}: the Phoenix payroll sheet is set in Calibri, not the house typeface`,
    );
    assert.ok(
      fills.has(BLACK),
      `${variant}: the header band is a filled black bar — the ink rule does not reach these sheets`,
    );
    assert.ok(fills.has(ZEBRA), `${variant}: the Phoenix zebra is used`);

    for (const colour of HOUSE_ONLY) {
      assert.ok(
        !fills.has(colour) && !fontColours.has(colour),
        `${variant}: ${colour} is a house identity colour and must not appear — these exports are ` +
          "exempt, and a house colour creeping in is how a sweep starts converting them back",
      );
    }

    // ── held is still carried by WORDS, not by the red fill alone ───────────────
    const sheet = workbook.getWorksheet(variant === "full" ? "Payroll" : "Part 1");
    assert.ok(sheet, `${variant}: the data sheet must exist`);
    const headerRow = sheet.getRow(5);
    let hrIdColumn = -1;
    headerRow.eachCell((cell, column) => {
      if (String(cell.value ?? "").trim() === "HR_ID") hrIdColumn = column;
    });
    assert.ok(hrIdColumn > 0, `${variant}: the sheet has an HR_ID column`);

    let heldSeen = false;
    sheet.eachRow((row) => {
      if (String(row.getCell(hrIdColumn).value ?? "") !== HELD_HR_ID) return;
      heldSeen = true;
      const note = row.getCell(hrIdColumn).note;
      assert.ok(note, `${variant}: the held row must carry a note saying what a hold costs`);
      assert.match(
        JSON.stringify(note),
        /dropped at publish/i,
        `${variant}: the note must say the row is dropped at publish, which is what makes it matter`,
      );
    });
    assert.ok(heldSeen, `${variant}: the held row must be on the sheet`);
  }

  // ── and the cover still names each held person, with the reason ──────────────
  const full = await load(await buildFullSheetWorkbook({ run, rows }));
  const cover = full.getWorksheet("Cover");
  assert.ok(cover, "a cover sheet must exist");
  const coverText: string[] = [];
  cover.eachRow((row) => {
    row.eachCell((cell) => coverText.push(String(cell.value ?? "")));
  });
  const joined = coverText.join(" | ");
  assert.match(joined, /Held · B-7/, "the cover must NAME each held person — a count does not say who is unpaid");
  assert.match(
    joined,
    /SECOND part/,
    "and must say what is owed: the second part only, since paying full net would pay part one twice",
  );
  assert.match(
    joined,
    /Reason:/,
    "the reason must travel with the name — the draft row it was read from is not something a " +
      "reviewer opens, so a cover naming who was held without saying why reproduces the gap on paper",
  );

  // ── THE COVER'S HEADLINE MUST NOT CLAIM A CONFIRM THE RUN HAS NOT HAD ───────
  // Owner, 2026-10-09: the September full sheet he opened said "September 2026 · HR-confirmed"
  // while Part 2 was not confirmed at all, and the cover's own rows said "Part 2 confirmed: No"
  // three lines below. The headline is what a reader quotes, so it was the one line that had to be
  // true. `run` here is the live shape of that complaint — nothing confirmed, nothing published.
  const headerCell = String(cover!.getRow(1).getCell(1).value ?? "") + " | " + joined;
  assert.ok(
    !/HR-confirmed/.test(headerCell),
    "an unconfirmed run's sheet must not say HR-confirmed anywhere on its cover — that is the " +
      "defect: a pre-confirm preview wearing a confirmed label",
  );
  assert.match(
    headerCell,
    /PREVIEW/,
    "it must say PREVIEW instead — withholding the download is not the fix, since reviewing the " +
      "figures before anyone confirms them is exactly what it is for",
  );
  assert.match(joined, /Part 2 confirmed | No/, "and the cover rows must still carry the detail");

  // The four states, in their strict order. Published is later than Part 2, which is later than
  // Part 1 — a run reads as the furthest state it has actually reached.
  assert.equal(sheetStateLabel(run), "PREVIEW — nothing confirmed yet");
  assert.equal(
    sheetStateLabel({ ...run, part1ConfirmedAt: "2026-07-24T10:00:00Z" }),
    "PREVIEW — Part 1 confirmed, Part 2 still open",
  );
  assert.equal(
    sheetStateLabel({ ...run, part1ConfirmedAt: "2026-07-24T10:00:00Z", part2ConfirmedAt: "2026-08-02T10:00:00Z" }),
    "HR-confirmed",
    "only a Part-2 confirm earns the label the fixed string used to hand out unconditionally",
  );
  assert.equal(
    sheetStateLabel({
      ...run,
      part1ConfirmedAt: "2026-07-24T10:00:00Z",
      part2ConfirmedAt: "2026-08-02T10:00:00Z",
      publishedAt: "2026-08-03T10:00:00Z",
    }),
    "published",
  );

  // And a confirmed run still says so — the fix must not turn every sheet into a preview.
  const confirmedCover = (
    await load(
      await buildFullSheetWorkbook({
        run: { ...run, part1ConfirmedAt: "2026-07-24T10:00:00Z", part2ConfirmedAt: "2026-08-02T10:00:00Z" },
        rows,
      }),
    )
  ).getWorksheet("Cover");
  const confirmedText: string[] = [];
  confirmedCover!.eachRow((row) => {
    row.eachCell((cell) => confirmedText.push(String(cell.value ?? "")));
  });
  assert.match(
    confirmedText.join(" | "),
    /HR-confirmed/,
    "a run whose Part 2 IS confirmed must still carry the confirmed label on its cover",
  );
}
