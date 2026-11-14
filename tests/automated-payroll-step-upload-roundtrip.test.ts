import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ExcelJS from "exceljs";

import { buildStepTemplateWorkbook, stepTemplateColumns } from "../src/lib/automated-payroll/exports/step-template.ts";
import { applyDayDrivenMoney } from "../src/lib/automated-payroll/imports/day-driven-money.ts";
import {
  readStepFileRevision,
  STEP_FILE_NEVER_SAVED,
  STEP_FILE_REVISION_PREFIX,
} from "../src/lib/automated-payroll/imports/step-file-revision.ts";
import { diffStepUpload, parseStepWorkbook } from "../src/lib/automated-payroll/imports/step-parser.ts";
import { sameStepRevision } from "../src/lib/automated-payroll/run-service.ts";
import { dayDrivenMoney, STEP_DEFINITIONS } from "../src/lib/automated-payroll/step-definitions.ts";
import type { MonthlySalaryRun, StepKey, StepRow } from "../src/lib/automated-payroll/types.ts";

/**
 * THE STEP SPREADSHEET ROUND TRIP SAYS WHAT IT WILL DO, AND DOES IT.
 *
 * Nothing called `diffStepUpload` before this file, and three findings lived in that gap:
 *
 *   31 — five day columns shipped EDITABLE with nowhere to be saved. A sheet changing one from 2 to 6
 *        previewed "2 to 6 (changed)" and the commit then saved nothing.
 *   32 — a corrected day count moved the days but not the money it drives, because the template
 *        pre-fills the money columns with the old figures and a saved figure always wins. A leaver
 *        corrected from 12 days to 4.5 was settled for 12.
 *   48 — the step Reason was written even when the column was absent, so re-uploading a sheet
 *        rebuilt without it blanked every justification while the preview said nothing changed.
 */

async function sheetFile(headers: string[], rows: Array<Array<string | number>>): Promise<File> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Step");
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  const buffer = await workbook.xlsx.writeBuffer();
  return new File([buffer as unknown as BlobPart], "step.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function stepRow(overrides: Partial<StepRow> & { hrId: string }): StepRow {
  return {
    fullName: "Test Person", jobTitle: null, line: null, context: {}, values: {}, recommended: {},
    reason: null, onHold: false, ...overrides,
  };
}

function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature);
  const end = source.indexOf("\nexport ", start + 10);
  assert.ok(start > 0 && end > start, `${signature} and its end must be found`);
  const body = source.slice(start, end);
  assert.ok(body.length < 14000, `the slice for ${signature} must stay bounded (got ${body.length})`);
  return body;
}

export async function runAutomatedPayrollStepUploadRoundTripTests() {
  // ==== 48: an absent Reason column is "not supplied", a blanked one is shown =====================
  const manual: StepKey = "p2_manual_deductions";
  const reasoned = [stepRow({ hrId: "B-1", fullName: "Mona Adel", values: { manualOtherDeductions: 400 }, reason: "Loan instalment 3 of 6" })];

  const withoutColumn = await parseStepWorkbook({ file: await sheetFile(["HR_ID", "Value"], [["B-1", 400]]), stepKey: manual });
  assert.equal(
    withoutColumn.edits[0].reason,
    undefined,
    "HEADLINE: a sheet with no Reason column must not supply a blank reason: that blanked every justification",
  );
  assert.equal(
    diffStepUpload({ stepKey: manual, edits: withoutColumn.edits, current: reasoned, invalidHrIds: 0 }).changed,
    0,
    "and it changes nothing, so the preview is right to say so",
  );

  const blanked = await parseStepWorkbook({ file: await sheetFile(["HR_ID", "Value", "Reason"], [["B-1", 400, ""]]), stepKey: manual });
  assert.equal(blanked.edits[0].reason, null, "a Reason column that is present but empty is a deliberate blank");
  const blankedPreview = diffStepUpload({ stepKey: manual, edits: blanked.edits, current: reasoned, invalidHrIds: 0 });
  assert.equal(
    blankedPreview.diffs.find((diff) => diff.field === "Reason")?.status,
    "changed",
    "and the preview must show the reason being emptied, not report 0 changed",
  );
  assert.equal(blankedPreview.changed, 1);

  // ==== Payroll audit 2026-11-14, finding 5: an absent "Hold?" column keeps every hold ============
  // Owner: "Keep current holds". A sheet rebuilt without the column used to read "No" for everyone
  // and lift every hold of the month.
  const holdStep: StepKey = "p1_holds";
  const held = [stepRow({ hrId: "B-1", fullName: "Mona Adel", onHold: true, reason: "Exit papers not signed" })];
  const noHoldColumn = await parseStepWorkbook({ file: await sheetFile(["HR_ID", "Name"], [["B-1", "Mona Adel"]]), stepKey: holdStep });
  assert.equal(
    noHoldColumn.edits[0].onHold,
    undefined,
    "HEADLINE: a sheet with no Hold? column must not supply 'No' — it lifted every hold of the month",
  );
  assert.equal(noHoldColumn.edits[0].reason, undefined, "and with no Hold Reason column it supplies no reason either");
  assert.equal(
    diffStepUpload({ stepKey: holdStep, edits: noHoldColumn.edits, current: held, invalidHrIds: 0 }).changed,
    0,
    "so the preview says nothing changes, and nothing does",
  );
  const lifted = await parseStepWorkbook({
    file: await sheetFile(["HR_ID", "Hold?", "Hold Reason"], [["B-1", "No", "Exit papers not signed"]]),
    stepKey: holdStep,
  });
  assert.equal(lifted.edits[0].onHold, false, "a Hold? column that says No still lifts the hold, deliberately");
  const liftedPreview = diffStepUpload({ stepKey: holdStep, edits: lifted.edits, current: held, invalidHrIds: 0 });
  assert.equal(liftedPreview.diffs.find((diff) => diff.field === "Hold?")?.status, "changed", "and the preview shows it");

  // ==== Payroll audit 2026-11-14, finding 1: a stale screen or older step file is refused ==========
  // Owner: "Refuse and reload". The file carries the revision it was built from, as a document
  // property; the screen sends the one it loaded; saveStep compares under the run hold.
  const run = { id: "run-1", month: 10, year: 2026, phase: "part1" } as unknown as MonthlySalaryRun;
  const revision = "2026-11-14T13:05:28.358+00:00";
  const built = await buildStepTemplateWorkbook({ run, stepKey: manual, rows: reasoned, revision });
  const builtFile = new File([built as unknown as BlobPart], "step.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  assert.equal(
    (await parseStepWorkbook({ file: builtFile, stepKey: manual })).revision,
    revision,
    "HEADLINE: a downloaded step file carries the revision it was built from, and the upload reads it back",
  );
  const neverSaved = await buildStepTemplateWorkbook({ run, stepKey: manual, rows: reasoned, revision: null });
  assert.equal(
    (await parseStepWorkbook({ file: new File([neverSaved as unknown as BlobPart], "s.xlsx"), stepKey: manual })).revision,
    null,
    "a step never saved when the file was built reads back as null, not as 'no revision'",
  );
  assert.equal(withoutColumn.revision, undefined, "a sheet made by hand carries no revision, and is let through");
  assert.equal(readStepFileRevision(`${STEP_FILE_REVISION_PREFIX}${STEP_FILE_NEVER_SAVED}`), null);
  assert.equal(readStepFileRevision("budget, payroll"), undefined);
  assert.ok(sameStepRevision(revision, "2026-11-14T13:05:28.358Z"), "the same moment written two ways is the same revision");
  assert.ok(!sameStepRevision(revision, "2026-11-14T13:05:29.000Z"), "a later save is a different revision");
  assert.ok(!sameStepRevision(null, revision), "a step saved since it was opened unsaved is a different revision");
  assert.ok(sameStepRevision(null, null));

  const service = readFileSync("src/lib/automated-payroll/run-service.ts", "utf8");
  const save = bodyOf(service, "export async function saveStep(");
  const hold = save.indexOf("holdRun(");
  assert.ok(
    hold > 0 && save.indexOf("await assertStepUnchangedSince(", hold) > hold &&
      save.indexOf("await assertStepUnchangedSince(", hold) < save.indexOf("await upsertDraftRows(runId, patches)", hold),
    "HEADLINE: saveStep checks the revision under the run hold, before it writes, so two saves cannot both pass",
  );
  assert.ok(
    save.indexOf("await assertStepUnchangedSince(") < save.indexOf("savePart1NotPaid("),
    "and once before Part 1 Not Paid can record anything",
  );
  assert.match(save, /return \{ revision: saved\.updatedAt \|\| null \};/, "a save hands the screen its new revision");
  const importer = bodyOf(service, "export async function importStepUpload(");
  assert.ok(
    importer.indexOf("await assertStepUnchangedSince(") < importer.indexOf("if (!commit)"),
    "a stale file is refused at the preview, before anyone reviews a diff that would never apply",
  );
  assert.match(importer, /fileRevision !== undefined/, "the file's own revision wins over the screen's");
  assert.match(importer, /recalculateMoney: recalculated, \.\.\.revisionCheck/, "and the commit is checked again under the hold");
  const route = readFileSync("app/api/automated-payroll/runs/[runId]/steps/[stepKey]/route.ts", "utf8");
  assert.match(route, /expectedRevision,\s*revisionSource: "screen"/, "the save route passes the screen's revision");
  const screen = readFileSync("src/components/automated-payroll/recommendation-step.tsx", "utf8");
  assert.match(screen, /inputMode: "inline", revision: revisionRef\.current/, "the screen sends the revision it loaded");
  assert.match(screen, /form\.set\("revision", revisionRef\.current \?\? ""\)/, "and with an upload");
  assert.match(screen, /error\.includes\(STALE_STEP_OPENING\)/, "and offers Reload the step on that refusal");

  // ==== 31: a field with nowhere to be saved ships read-only and is never read back ===============
  const notStored: Array<[StepKey, string]> = [
    ["p1_crm", "p1odCrmWorkingDays"],
    ["p1_resignation_crm", "resigCrmWorkingDays"],
    ["p2_vacation", "p2VacationDays"],
    ["p2_crm", "p2CrmDays"],
    ["p2_manual_deductions", "p2ManualDeductionDays"],
  ];
  for (const [stepKey, fieldKey] of notStored) {
    const field = STEP_DEFINITIONS[stepKey].fields.find((candidate) => candidate.key === fieldKey);
    assert.ok(field, `${stepKey} must still declare ${fieldKey}`);
    assert.equal(field!.notPersisted, true, `${stepKey}.${fieldKey} has no draft column, so it must say so`);
    assert.equal(
      stepTemplateColumns(stepKey).find((column) => column.label === field!.label)?.editable,
      false,
      `${stepKey}'s "${field!.label}" column must ship read-only: the commit has nowhere to put it`,
    );
  }

  const vacationRows = [stepRow({ hrId: "B-2", values: { p2VacationDays: 2, unpaidVacations: 600 } })];
  const vacationUpload = await parseStepWorkbook({
    file: await sheetFile(["HR_ID", "Deduction Days", "Deduction Value"], [["B-2", 6, 600]]),
    stepKey: "p2_vacation",
  });
  assert.equal(vacationUpload.edits[0].values?.p2VacationDays, undefined, "the parser must not read a not-stored day count back");
  assert.equal(
    diffStepUpload({ stepKey: "p2_vacation", edits: vacationUpload.edits, current: vacationRows, invalidHrIds: 0 }).changed,
    0,
    "so the preview can no longer promise a change the commit silently drops",
  );

  // Kept in step with what run-service.ts can actually store, both ways round.
  const runService = readFileSync("src/lib/automated-payroll/run-service.ts", "utf8");
  const listStart = runService.indexOf("const NUMERIC_FIELDS");
  const listEnd = runService.indexOf("];", listStart);
  assert.ok(listStart > 0 && listEnd > listStart, "NUMERIC_FIELDS must be found");
  const stored = new Set([...runService.slice(listStart, listEnd).matchAll(/"([A-Za-z0-9]+)"/g)].map((match) => match[1]));
  assert.ok(stored.size > 20, `NUMERIC_FIELDS must parse to its real list (got ${stored.size})`);
  for (const definition of Object.values(STEP_DEFINITIONS)) {
    for (const field of definition.fields) {
      if (field.kind !== "money" && field.kind !== "days") continue;
      if (field.notPersisted) {
        assert.ok(!stored.has(field.key), `${definition.key}.${field.key} is marked not stored but IS stored: drop the flag`);
      } else {
        assert.ok(
          stored.has(field.key),
          `${definition.key}.${field.key} is editable in the template but has no draft column: store it or mark it notPersisted`,
        );
      }
    }
  }

  // ==== 32: a corrected day count moves the money it drives ======================================
  const noRecordRows = [stepRow({ hrId: "B-3", context: { "Base Salary": 9000 }, values: { p1odNoRecordDays: 2, p1odNoRecordValue: 600 } })];
  const moved = applyDayDrivenMoney({
    stepKey: "p1_no_record",
    edits: [{ hrId: "B-3", values: { p1odNoRecordDays: 5, p1odNoRecordValue: 600 } }],
    current: noRecordRows,
    monthDays: 31,
  });
  assert.equal(
    moved.edits[0].values?.p1odNoRecordValue,
    1451.61,
    "HEADLINE: 5 days at 9,000 ÷ 31 is 1,451.61 — not the 1,500 a flat 30 gave; the sheet's untouched 600 belonged to the old 2 days",
  );
  const noRecordDays = STEP_DEFINITIONS.p1_no_record.fields.find((field) => field.key === "p1odNoRecordDays");
  assert.equal(
    moved.edits[0].values?.p1odNoRecordValue,
    dayDrivenMoney(noRecordDays, { "Base Salary": 9000 }, 5, 31).p1odNoRecordValue,
    "and it is the same figure the grid computes, from the same function",
  );
  assert.equal(
    diffStepUpload({ stepKey: "p1_no_record", edits: moved.edits, current: noRecordRows, invalidHrIds: 0 })
      .diffs.find((diff) => diff.field === "Day Without Record Value")?.status,
    "changed",
    "the preview shows the money moving with the days",
  );

  assert.equal(
    applyDayDrivenMoney({
      stepKey: "p1_no_record",
      edits: [{ hrId: "B-3", values: { p1odNoRecordDays: 5, p1odNoRecordValue: 999 } }],
      current: noRecordRows,
      monthDays: 31,
    }).edits[0].values?.p1odNoRecordValue,
    999,
    "an amount HR changed alongside the days is their decision and stands",
  );
  assert.equal(
    applyDayDrivenMoney({
      stepKey: "p1_no_record",
      edits: [{ hrId: "B-3", values: { p1odNoRecordDays: 2, p1odNoRecordValue: 600 } }],
      current: noRecordRows,
      monthDays: 31,
    }).edits[0].values?.p1odNoRecordValue,
    600,
    "no day change, no money change",
  );

  // Resignations: the settlement rule recalculates, never a flat day-rate.
  const leaverRows = [
    stepRow({
      hrId: "B-4",
      lifecycle: "leaver",
      context: { "Base Salary": 14000, "Extra Cost Of Living": 1000, "Fuel Allowance": 500, "Days In Month": 31 },
      values: { daysWorked: 12, baseForMonth: 5419.35, ecolPaid: 387.1, fuelPaid: 193.55 },
    }),
  ];
  const corrected = applyDayDrivenMoney({
    stepKey: "p1_resignations",
    edits: [{ hrId: "B-4", values: { daysWorked: 4.5, baseForMonth: 5419.35, ecolPaid: 387.1, fuelPaid: 193.55 } }],
    current: leaverRows,
    monthDays: 31,
  });
  assert.equal(corrected.edits[0].values?.daysWorked, 4.5, "the corrected day count is kept");
  assert.deepEqual(
    corrected.recalculated.get("b-4"),
    ["baseForMonth", "ecolPaid", "fuelPaid"],
    "a leaver's three amounts are handed to the settlement rule, which knows the after-the-25th and dismissal rules",
  );
  assert.equal(corrected.edits[0].values?.baseForMonth, undefined, "and the stale 12-day figure is not sent");
  assert.equal(
    diffStepUpload({ stepKey: "p1_resignations", edits: corrected.edits, current: leaverRows, invalidHrIds: 0, recalculated: corrected.recalculated })
      .diffs.filter((diff) => diff.to === "recalculated").length,
    3,
    "the preview says all three will be recalculated",
  );

  // Unpaid Vacation for a leaver: a balance-aware settlement, never driven by a day count.
  assert.equal(
    applyDayDrivenMoney({
      stepKey: "p1_unpaid_vacation",
      edits: [{ hrId: "B-5", values: { p1odVacationDays: 3, p1odVacationValue: 2750 } }],
      current: [stepRow({ hrId: "B-5", lifecycle: "leaver", context: { "Base Salary": 9000 }, values: { p1odVacationDays: 1, p1odVacationValue: 2750 } })],
      monthDays: 31,
    }).edits[0].values?.p1odVacationValue,
    2750,
    "a leaver's unpaid-vacation value must not be re-priced from days",
  );

  // ---- The wiring: both import paths derive, and the save clears what the rule recalculates -------
  const importBody = bodyOf(runService, "export async function importStepUpload(");
  const deriveAt = importBody.indexOf("applyDayDrivenMoney(");
  assert.ok(deriveAt > 0 && deriveAt < importBody.indexOf("if (!commit)"), "the preview and the commit must both derive the money");
  assert.match(importBody, /saveStep\([^)]*recalculateMoney: recalculated/, "the commit must hand the recalculated keys to saveStep");

  const saveBody = bodyOf(runService, "export async function saveStep(");
  assert.match(saveBody, /options\?\.recalculateMoney\?\.get\(/, "saveStep must read the keys to recalculate");
  assert.match(saveBody, /\] = null;/, "and clear them, so the settlement rule re-derives the money from the saved days");

  const grid = readFileSync("src/components/automated-payroll/recommendation-step.tsx", "utf8");
  assert.match(
    grid,
    /dayDrivenMoney\(spec, row\.context, days, period \? calendarDaysInMonth\(period\) : 0\)/,
    "the grid must price days with the same shared function, and hand it the run's own month length",
  );
}
